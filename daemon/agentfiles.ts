// What an agent brings to a session besides its instructions. Its skills become
// Claude Code skill files in the session's folder. Its plugins become MCP
// servers in the session's MCP config, with secrets filled in from this machine:
// its environment first, then $AGENTS_HOME/secrets.json. Secret values never leave
// the machine.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NAME, type AgentPlugin, type AgentSkill, type SecretRef } from '../shared/types.ts'

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
