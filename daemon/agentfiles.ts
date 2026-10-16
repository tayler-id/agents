// What an agent brings to a session besides its instructions. Its skills become
// Claude Code skill files in the session's folder. Its plugins become MCP
// servers in the session's MCP config, with secrets filled in from this machine:
// its environment first, then $AGENTS_HOME/secrets.json. Secret values never leave
// the machine.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { NAME, type AgentHook, type AgentPlugin, type AgentSkill, type SecretRef } from '../shared/types.ts'

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

// One group of hook commands, as Claude Code's settings hold it. A matcher names the
// tools a PreToolUse or PostToolUse group applies to, and the other events take none.
type HookGroup = { matcher?: string; hooks: { type: 'command'; command: string; timeout?: number }[] }

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
    group.hooks.push({ type: 'command', command: hook.command, ...(hook.timeoutSec === null ? {} : { timeout: hook.timeoutSec }) })
  }
  return byEvent
}

// Claude Code reads hooks from <cwd>/.claude/settings.local.json, and the daemon starts it
// with that source. The file is the daemon's alone and written whole for every session,
// so a hook taken off the agent in the app is gone from the next session, and an agent with
// no hooks has no file.
export function writeHooks(cwd: string, hooks: AgentHook[]) {
  const file = join(cwd, '.claude', 'settings.local.json')
  if (!hooks.length) {
    rmSync(file, { force: true })
    return
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ hooks: claudeHooks(hooks) }, null, 2)}\n`)
}

export function machineSecrets(home: string): Record<string, string> {
  let file: unknown
  try {
    file = JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8'))
  } catch {
    return {}
  }
  if (typeof file !== 'object' || file === null) return {}
  return Object.fromEntries(Object.entries(file).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
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
