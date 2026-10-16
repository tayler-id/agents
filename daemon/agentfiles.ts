// What an agent brings to a session besides its instructions. Its skills become
// Claude Code skill files in the session's folder. Its plugins become MCP
// servers in the session's MCP config, with secrets filled in from this machine:
// its environment first, then $AGENTS_HOME/secrets.json. Secret values never leave
// the machine. A person sets or removes one from the app, and the API sends it
// over the control connection to the functions below, which keep the file.

import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hasCode } from '../shared/errors.ts'
import { SecretName } from '../shared/secrets.ts'
import { NAME, type AgentHook, type AgentPlugin, type AgentSkill, type HookEvent, type SecretRef } from '../shared/types.ts'

// Replaces <cwd>/.claude/skills with the agent's skills, so Claude finds them as project skills.
export function writeSkills(cwd: string, skills: AgentSkill[]) {
  // Each name becomes a folder, so a name from the server must not reach outside this one.
  const bad = skills.find((s) => !NAME.test(s.name))
  if (bad) throw new Error(`the agent's skill "${bad.name}" has a name that is not lowercase letters, digits and dashes`)
  const dir = join(cwd, '.claude', 'skills')
  rmSync(dir, { recursive: true, force: true })
  for (const skill of skills) {
    mkdirSync(join(dir, skill.name), { recursive: true })
    const description = skill.description.replace(/\s+/g, ' ').trim()
    writeFileSync(join(dir, skill.name, 'SKILL.md'), `---\nname: ${skill.name}\ndescription: ${description}\n---\n\n${skill.content.trim()}\n`)
  }
}

const SECRETS_FILE = 'secrets.json'

// One group of hook commands, as Claude Code's settings hold it. A matcher names the
// tools a PreToolUse or PostToolUse group applies to, and the other events take none.
type HookGroup = { matcher?: string; hooks: { type: 'command'; command: string; timeout?: number }[] }

// Claude Code takes what a PreToolUse hook prints as the person's answer to an ask, such as allow, and what a
// Stop or SubagentStop hook prints, or its exit code 2, as an order to keep the turn running. A hook must not
// answer for the person or run a turn on, so for those events the command runs in a subshell whose output goes
// to stderr, where the record still keeps it, and a stop hook's 2 counts as a failure. A PreToolUse hook that
// exits 2 still blocks its tool, which asks less of the person, not more.
const ANSWERS_FOR_THE_PERSON: readonly HookEvent[] = ['PreToolUse', 'Stop', 'SubagentStop']
export function guardedCommand(event: HookEvent, command: string): string {
  if (!ANSWERS_FOR_THE_PERSON.includes(event)) return command
  const run = `(\n${command}\n) 1>&2`
  return event === 'PreToolUse' ? run : `${run}; code=$?; if [ "$code" -eq 2 ]; then exit 1; fi; exit "$code"`
}

// The hooks as Claude Code reads them, grouped by event and then by matcher.
export function claudeHooks(hooks: AgentHook[]): Record<string, HookGroup[]> {
  const byEvent: Record<string, HookGroup[]> = {}
  for (const hook of hooks) {
    const groups = (byEvent[hook.event] ??= [])
    const matcher = hook.matcher ?? undefined
    let group = groups.find((g) => g.matcher === matcher)
    if (!group) {
      group = matcher === undefined ? { hooks: [] } : { matcher, hooks: [] }
      groups.push(group)
    }
    group.hooks.push({ type: 'command', command: guardedCommand(hook.event, hook.command), ...(hook.timeoutSec === null ? {} : { timeout: hook.timeoutSec }) })
  }
  return byEvent
}

// A session's hooks, as a Claude Code settings file of the session's own that the daemon
// passes with --settings. Sessions of different agents can share a task's folder, so the
// hooks never go in the folder, where one session's start would write them for another.
// The file is written whole each time the session starts, so a hook taken off the agent is
// gone from its next start, and a session with no hooks has no file. Gives the file to pass,
// or null.
export function writeHooks(file: string, hooks: AgentHook[]): string | null {
  if (!hooks.length) {
    rmSync(file, { force: true })
    return null
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify({ hooks: claudeHooks(hooks) }, null, 2)}\n`, { mode: 0o600 })
  return file
}

export function machineSecrets(home: string): Record<string, string> {
  let file: unknown
  try {
    file = JSON.parse(readFileSync(join(home, SECRETS_FILE), 'utf8'))
  } catch {
    return {}
  }
  if (typeof file !== 'object' || file === null) return {}
  return Object.fromEntries(Object.entries(file).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

// Why the file cannot be changed. Its words are written here and never quote
// the file, which holds other secrets.
export class SecretsFileError extends Error {}

// Every entry of the file as it is, including any that is not a string. A file
// that is not there holds nothing, and so does an empty one. One that is there
// and cannot be read as an object is an error, and is never rewritten, since
// rewriting it would lose whatever a person put in it.
function readSecretsFile(home: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(join(home, SECRETS_FILE), 'utf8')
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return {}
    throw error
  }
  if (!text.trim()) return {}
  let file: unknown
  try {
    file = JSON.parse(text)
  } catch {
    throw new SecretsFileError(`${SECRETS_FILE} is not valid JSON, so the daemon left it alone.`)
  }
  if (typeof file !== 'object' || file === null || Array.isArray(file)) {
    throw new SecretsFileError(`${SECRETS_FILE} does not hold names and values, so the daemon left it alone.`)
  }
  return Object.fromEntries(Object.entries(file))
}

// Replaces the file whole, readable by its owner alone. The new content is
// written and flushed beside it first, so a crash leaves the old file or the new
// one and never half of either.
function writeSecretsFile(home: string, entries: Record<string, unknown>) {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const file = join(home, SECRETS_FILE)
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(entries, null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

// The names of the values the file holds, for the API to compare with what it
// believes it set. A name the app could not have set, such as one in lowercase,
// is left out. A file that cannot be read as an object is an error.
export function heldSecretNames(home: string): string[] {
  return Object.entries(readSecretsFile(home)).flatMap(([name, value]) => (typeof value === 'string' && SecretName.safeParse(name).success ? [name] : []))
}

// Sets the value of one name, or removes the name when `value` is null, and says
// whether the file held the name. `forget` is given the value being replaced or
// removed, if there is one, before anything is written. If it throws, the file
// is as it was, so the same request can be made again.
export function changeMachineSecret(home: string, name: string, value: string | null, forget: (gone: string) => void): { had: boolean } {
  const entries = readSecretsFile(home)
  const had = Object.hasOwn(entries, name)
  const before = entries[name]
  if (typeof before === 'string' && before !== value) forget(before)
  if (value === null) {
    if (!had) return { had }
    delete entries[name]
  } else {
    entries[name] = value
  }
  writeSecretsFile(home, entries)
  return { had }
}

// Deletes each session's MCP config in `dir` that holds `value`. A config holds
// the values its plugins were started with, so a value set again or removed is
// gone from the computer only when the configs that held it are. The next message
// to a session writes its config again. A value sits in the file as JSON writes
// it, with quotes, backslashes and control characters escaped.
export function forgetValueIn(dir: string, value: string) {
  const needle = JSON.stringify(value).slice(1, -1)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    // No session has started on this computer yet, so there are no configs.
    if (hasCode(error, 'ENOENT')) return
    throw error
  }
  for (const name of names.filter((entry) => entry.endsWith('.mcp.json'))) {
    const file = join(dir, name)
    if (readFileSync(file, 'utf8').includes(needle)) rmSync(file)
  }
}

// The names of the secrets the plugins take.
export function pluginSecretNames(plugins: AgentPlugin[]): string[] {
  return [...new Set(plugins.flatMap((plugin) => Object.values(plugin.kind === 'stdio' ? plugin.config.env ?? {} : plugin.config.headers ?? {}).map((ref) => ref.secret)))]
}

// The plugins as MCP server entries, and any secret names this machine lacks.
export function pluginServers(plugins: AgentPlugin[], secrets: Record<string, string>) {
  const missing: string[] = []
  const fill = (refs: Record<string, SecretRef> | undefined) => Object.fromEntries(Object.entries(refs ?? {}).map(([key, ref]) => {
    const value = process.env[ref.secret] ?? secrets[ref.secret]
    if (value === undefined) missing.push(ref.secret)
    return [key, value ?? '']
  }))
  const servers: Record<string, unknown> = {}
  for (const plugin of plugins) {
    servers[plugin.name] = plugin.kind === 'stdio'
      ? { command: plugin.config.command, args: plugin.config.args ?? [], env: fill(plugin.config.env) }
      : { type: 'http', url: plugin.config.url, headers: fill(plugin.config.headers) }
  }
  return { servers, missing }
}
