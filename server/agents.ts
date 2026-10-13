// An agent's setup, edited from the app: who it is, its skills, its plugins
// (MCP servers), its routines, and what it remembers. Templates save an agent's
// setup so the team can make another like it. Every function runs inside the
// caller's transaction and checks the agent is on the person's team.

import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import { many, maybe, one } from './db.ts'
import { parseCron } from '../shared/cron.ts'
import { NAME } from '../shared/types.ts'
import { HttpError, type Person } from './record.ts'

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/

export type Recipe = {
  title: string | null; role: string | null; instructions: string; model: string | null
  skills: { name: string; description: string; content: string }[]
  plugins: { name: string; kind: 'stdio' | 'http'; config: PluginConfig }[]
  routines: { name: string; prompt: string; schedule: string }[]
}

// A plugin is an MCP server. Secret values never enter Postgres: env and header
// values name a secret, which the daemon on the machine fills in.
export type PluginConfig =
  | { command: string; args?: string[]; env?: Record<string, { secret: string }> }
  | { url: string; headers?: Record<string, { secret: string }> }

function text(value: unknown, field: string, max = 20_000): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} must be non-empty text`)
  if (value.length > max) throw new HttpError(400, `${field} is too long`)
  return value
}

const optional = (value: unknown, field: string, max = 20_000) =>
  value === undefined || value === null || value === '' ? null : text(value, field, max)

export async function agentOf(client: pg.PoolClient, person: Person, agentId: string, lock = false) {
  const agent = await maybe<{ id: string; name: string; team_id: string; home_instance_id: string | null }>(client,
    `select id, name, team_id, home_instance_id from agents where id = $1 and team_id = $2 and archived_at is null${lock ? ' for update' : ''}`,
    [agentId, person.team_id])
  if (!agent) throw new HttpError(404, 'no such agent')
  return agent
}

export async function createAgent(client: pg.PoolClient, person: Person, body: Record<string, unknown>): Promise<string> {
  const name = text(body.name, 'name', 40)
  if (!NAME.test(name)) throw new HttpError(400, 'name must be lowercase letters, digits and dashes, starting with a letter')
  const home = await maybe<{ id: string }>(client,
    'select id from instances where id = $1 and team_id = $2', [text(body.homeInstanceId, 'homeInstanceId'), person.team_id])
  if (!home) throw new HttpError(404, 'no such machine')
  const taken = await maybe(client, 'select 1 from agents where team_id = $1 and name = $2 and archived_at is null', [person.team_id, name])
  if (taken) throw new HttpError(409, `there is already an agent named ${name}`)
  const agent = await one<{ id: string }>(client, 'the new agent',
    `insert into agents (team_id, name, title, role, instructions, model, home_instance_id, owner_id, visibility)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'team') returning id`,
    [person.team_id, name, optional(body.title, 'title', 80), optional(body.role, 'role', 200),
      optional(body.instructions, 'instructions') ?? '', optional(body.model, 'model', 80), home.id, person.id])
  if (typeof body.templateSlug === 'string') await install(client, person, agent.id, body.templateSlug)
  return agent.id
}

export async function updateAgent(client: pg.PoolClient, person: Person, agentId: string, body: Record<string, unknown>) {
  await agentOf(client, person, agentId, true)
  const fields: [string, unknown][] = []
  if ('title' in body) fields.push(['title', optional(body.title, 'title', 80)])
  if ('role' in body) fields.push(['role', optional(body.role, 'role', 200)])
  if ('instructions' in body) fields.push(['instructions', optional(body.instructions, 'instructions') ?? ''])
  if ('model' in body) fields.push(['model', optional(body.model, 'model', 80)])
  if (!fields.length) return
  await client.query(`update agents set ${fields.map(([k], i) => `${k} = $${i + 2}`).join(', ')} where id = $1`,
    [agentId, ...fields.map(([, v]) => v)])
}

export async function saveSkill(client: pg.PoolClient, person: Person, agentId: string, body: Record<string, unknown>) {
  await agentOf(client, person, agentId)
  const name = text(body.name, 'name', 64)
  if (!NAME.test(name)) throw new HttpError(400, 'a skill name is lowercase letters, digits and dashes')
  const description = text(body.description, 'description', 1024)
  const content = text(body.content, 'content', 100_000)
  const { rowCount } = await client.query(
    'update skills set description = $4, content = $5, updated_at = now() where team_id = $1 and agent_id = $2 and name = $3',
    [person.team_id, agentId, name, description, content])
  if (!rowCount) {
    await client.query('insert into skills (team_id, agent_id, name, description, content) values ($1, $2, $3, $4, $5)',
      [person.team_id, agentId, name, description, content])
  }
}

function pluginConfig(kind: unknown, raw: unknown): { kind: 'stdio' | 'http'; config: PluginConfig } {
  const config = (raw ?? {}) as Record<string, unknown>
  const secrets = (value: unknown, field: string) => {
    const out: Record<string, { secret: string }> = {}
    for (const [key, ref] of Object.entries((value ?? {}) as Record<string, unknown>)) {
      const secret = typeof ref === 'object' && ref !== null && 'secret' in ref ? ref.secret : undefined
      if (typeof secret !== 'string' || !SECRET_NAME.test(secret)) {
        throw new HttpError(400, `${field}.${key} must name a secret, such as {"secret": "GITHUB_TOKEN"}, never hold a value`)
      }
      out[key] = { secret }
    }
    return out
  }
  if (kind === 'stdio') {
    const args = Array.isArray(config.args) ? config.args.map((a, i) => text(a, `config.args.${i}`, 2000)) : []
    return { kind, config: { command: text(config.command, 'config.command', 500), args, env: secrets(config.env, 'config.env') } }
  }
  if (kind === 'http') {
    const url = text(config.url, 'config.url', 2000)
    if (!/^https?:\/\//.test(url)) throw new HttpError(400, 'config.url must be an http or https URL')
    return { kind, config: { url, headers: secrets(config.headers, 'config.headers') } }
  }
  throw new HttpError(400, 'kind must be stdio or http')
}

export async function savePlugin(client: pg.PoolClient, person: Person, agentId: string, body: Record<string, unknown>) {
  await agentOf(client, person, agentId)
  const name = text(body.name, 'name', 40)
  if (!NAME.test(name)) throw new HttpError(400, 'a plugin name is lowercase letters, digits and dashes')
  if (name === 'team-record' || name === 'stage') throw new HttpError(400, `${name} is taken by the tools every session has`)
  const { kind, config } = pluginConfig(body.kind, body.config)
  await client.query(
    `insert into plugins (agent_id, name, kind, config) values ($1, $2, $3, $4)
     on conflict (agent_id, name) do update set kind = excluded.kind, config = excluded.config`,
    [agentId, name, kind, JSON.stringify(config)])
  // The names a plugin needs, so people know what to set on each machine.
  for (const ref of Object.values({ ...('env' in config ? config.env : {}), ...('headers' in config ? config.headers : {}) })) {
    await client.query(
      `insert into secrets (team_id, scope, agent_id, name, description, stored_in)
       select $1, 'agent', $2, $3, $4, 'machine' where not exists (select 1 from secrets where agent_id = $2 and name = $3)`,
      [person.team_id, agentId, ref.secret, `For the ${name} plugin`])
  }
}

export async function saveRoutine(client: pg.PoolClient, person: Person, agentId: string, body: Record<string, unknown>) {
  await agentOf(client, person, agentId)
  const name = text(body.name, 'name', 80)
  const schedule = text(body.schedule, 'schedule', 100)
  try {
    parseCron(schedule)
  } catch (error) {
    throw new HttpError(400, `schedule: ${(error as Error).message}`)
  }
  const prompt = text(body.prompt, 'prompt')
  const enabled = body.enabled !== false
  const { rowCount } = await client.query(
    `update routines set prompt = $3, trigger_config = $4, enabled = $5 where agent_id = $1 and name = $2`,
    [agentId, name, prompt, JSON.stringify({ schedule, checkedAt: new Date().toISOString() }), enabled])
  if (!rowCount) {
    await client.query(
      `insert into routines (agent_id, name, prompt, trigger, trigger_config, enabled) values ($1, $2, $3, 'cron', $4, $5)`,
      [agentId, name, prompt, JSON.stringify({ schedule, checkedAt: new Date().toISOString() }), enabled])
  }
}

export async function removeItem(client: pg.PoolClient, person: Person, agentId: string, kind: 'skills' | 'plugins' | 'routines', name: string) {
  await agentOf(client, person, agentId)
  const { rowCount } = await client.query(`delete from ${kind} where agent_id = $1 and name = $2`, [agentId, name])
  if (!rowCount) throw new HttpError(404, `no such ${kind.slice(0, -1)}`)
}

// What an agent keeps about a person or the team: one profile each, and a log a day.
export async function writeMemory(client: pg.PoolClient, agentId: string, teamId: string, about: { personId: string | null },
  kind: 'profile' | 'log', content: string) {
  const scope = about.personId ? 'person' : 'team'
  if (kind === 'profile') {
    const { rowCount } = await client.query(
      `update memories set content = $4, updated_at = now() where agent_id = $1 and scope = $2 and person_id is not distinct from $3 and kind = 'profile'`,
      [agentId, scope, about.personId, content])
    if (!rowCount) {
      await client.query(`insert into memories (team_id, agent_id, scope, person_id, kind, content) values ($1, $2, $3, $4, 'profile', $5)`,
        [teamId, agentId, scope, about.personId, content])
    }
    return
  }
  const { rowCount } = await client.query(
    `update memories set content = content || E'\\n' || $4, updated_at = now()
     where agent_id = $1 and scope = $2 and person_id is not distinct from $3 and kind = 'log' and log_date = current_date`,
    [agentId, scope, about.personId, content])
  if (!rowCount) {
    await client.query(`insert into memories (team_id, agent_id, scope, person_id, kind, log_date, content) values ($1, $2, $3, $4, 'log', current_date, $5)`,
      [teamId, agentId, scope, about.personId, content])
  }
}

// The memory block an agent starts a session with: the team's profile, each
// person's profile, and the last few days of logs.
export async function memoryBlock(client: pg.PoolClient | pg.Pool, agentId: string, personIds: string[]): Promise<string> {
  const { rows } = await client.query<{ scope: string; login: string | null; kind: string; log_date: string | null; content: string }>(
    `select m.scope, p.login, m.kind, m.log_date::text, m.content from memories m left join people p on p.id = m.person_id
     where m.agent_id = $1 and (m.scope = 'team' or m.person_id = any($2))
       and (m.kind = 'profile' or m.log_date > current_date - 4) and m.content <> ''
     order by m.scope, p.login, m.kind desc, m.log_date`, [agentId, personIds])
  if (!rows.length) return ''
  const lines = rows.map((m) => `${m.kind === 'profile' ? 'About' : `Notes from ${m.log_date} on`} ${m.scope === 'team' ? 'the team' : m.login}:\n${m.content}`)
  return `What you remember (keep it current with the update_memory tool):\n\n${lines.join('\n\n')}`
}

export async function saveTemplate(client: pg.PoolClient, person: Person, agentId: string, name: string): Promise<{ slug: string; version: number }> {
  const agent = await agentOf(client, person, agentId)
  const full = await one<{ title: string | null; role: string | null; instructions: string; model: string | null }>(client, 'the agent',
    'select title, role, instructions, model from agents where id = $1', [agent.id])
  const skills = await many<Recipe['skills'][number]>(client, 'select name, description, content from skills where agent_id = $1 order by name', [agent.id])
  const plugins = await many<Recipe['plugins'][number]>(client, 'select name, kind, config from plugins where agent_id = $1 order by name', [agent.id])
  const routines = await many<Recipe['routines'][number]>(client,
    `select name, prompt, trigger_config->>'schedule' as schedule from routines where agent_id = $1 order by name`, [agent.id])
  const recipe: Recipe = { ...full, skills, plugins, routines }
  const existing = await maybe<{ id: string; version: number; share_slug: string }>(client,
    'select id, version, share_slug from templates where team_id = $1 and name = $2 for update', [person.team_id, name])
  if (existing) {
    await client.query('update templates set version = version + 1, recipe = $2 where id = $1', [existing.id, JSON.stringify(recipe)])
    return { slug: existing.share_slug, version: existing.version + 1 }
  }
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${randomBytes(3).toString('hex')}`
  await client.query(`insert into templates (team_id, name, recipe, share_slug) values ($1, $2, $3, $4)`,
    [person.team_id, text(name, 'name', 80), JSON.stringify(recipe), slug])
  return { slug, version: 1 }
}

// Gives a new agent a template's setup: who it is, its skills, plugins and routines.
async function install(client: pg.PoolClient, person: Person, agentId: string, slug: string) {
  const template = await maybe<{ recipe: Recipe }>(client,
    'select recipe from templates where share_slug = $1 and team_id = $2', [slug, person.team_id])
  if (!template) throw new HttpError(404, 'no such template')
  const r = template.recipe
  await client.query('update agents set title = $2, role = $3, instructions = $4, model = $5 where id = $1',
    [agentId, r.title, r.role, r.instructions, r.model])
  for (const skill of r.skills) await saveSkill(client, person, agentId, skill)
  for (const plugin of r.plugins) await savePlugin(client, person, agentId, plugin)
  for (const routine of r.routines) await saveRoutine(client, person, agentId, routine)
}
