// An agent's setup, edited from the app: who it is, its skills, its plugins
// (MCP servers), its routines, its hooks, and what it remembers. Templates save
// an agent's setup so the team can make another like it, and a copy does the
// same in one step. Every function runs inside the caller's transaction and
// checks the agent is on the person's team.

import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { many, maybe, one } from './db.ts'
import { InstanceId, PersonId } from '../shared/onboarding.ts'
import { parseCron } from '../shared/cron.ts'
import { SECRET_NAME } from '../shared/secrets.ts'
import { AgentId, ConversationId } from '../shared/ids.ts'
import { carriedBy, mayChangeHooks, mayRunOn, Recipe, type CopyAsk, type CopyDone, type RecipeMemory } from '../shared/recipe.ts'
import { AgentHook, NAME, type AgentPlugin, type AgentSkill } from '../shared/types.ts'
import { TEAM_AGENTS_SERVER, type AcceptsAgents } from '../shared/team-agents.ts'
import { HttpError, openDm, scrub, type Person } from './record.ts'

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
  const agent = await maybe<{ id: string; name: string; team_id: string; home_instance_id: string | null; owner_id: string | null }>(client,
    `select id, name, team_id, home_instance_id, owner_id from agents where id = $1 and team_id = $2 and archived_at is null${lock ? ' for update' : ''}`,
    [agentId, person.team_id])
  if (!agent) throw new HttpError(404, 'no such agent')
  return agent
}

const Home = z.object({ id: InstanceId, personal: z.boolean(), owner_id: PersonId.nullable() })

// The longest name an agent or a hook may have, as NAME in shared/types.ts allows.
const NAME_LENGTH = 40

// One agent is named at a time on a team, so a name found free is still free when its agent is inserted.
const lockNames = (client: pg.PoolClient, teamId: string) => client.query('select pg_advisory_xact_lock(hashtext($1))', [`agent-names:${teamId}`])

// `base` and `suffix` as a name that fits, with the base cut and the suffix kept.
const fit = (base: string, suffix: string) => `${base.slice(0, NAME_LENGTH - suffix.length)}${suffix}`

// The first name of `base` + `suffix`, then `suffix-2`, `suffix-3` and on, that no agent of the team has.
export async function freeName(client: pg.PoolClient, teamId: string, base: string, suffix: string): Promise<string> {
  await lockNames(client, teamId)
  for (let n = 1; ; n++) {
    const name = fit(base, n === 1 ? suffix : `${suffix}-${String(n)}`)
    if (!(await maybe(client, 'select 1 from agents where team_id = $1 and name = $2 and archived_at is null', [teamId, name]))) return name
  }
}

// The machine a new agent goes on when its person names none: their own box, else a Mac of theirs. An agent
// runs commands on its machine, so one never lands on a teammate's machine without a word.
export async function defaultMachine(client: pg.PoolClient, person: Person): Promise<string> {
  const own = await maybe<{ id: string }>(client,
    `select id from instances where team_id = $1 and owner_id = $2 and (personal or kind = 'mac') order by personal desc, name limit 1`,
    [person.team_id, person.id])
  if (!own) throw new HttpError(409, 'You have no machine of your own to put it on. Name a machine.')
  return own.id
}

// A new agent, owned by `ownerId`, on its home machine. A person makes one from
// the app, and an agent makes one once its owner said yes, which `madeBy` names.
type NewAgent = {
  teamId: string; ownerId: string; homeInstanceId: string; name: string
  title: string | null; role: string | null; instructions: string; model: string | null
  madeBy: { sessionId: string; askId: string } | null
}

export async function insertAgent(client: pg.PoolClient, agent: NewAgent): Promise<string> {
  if (!NAME.test(agent.name)) throw new HttpError(400, 'name must be lowercase letters, digits and dashes, starting with a letter')
  const found = await maybe(client, 'select id, personal, owner_id from instances where id = $1 and team_id = $2', [agent.homeInstanceId, agent.teamId])
  if (!found) throw new HttpError(404, 'no such machine')
  const home = Home.parse(found)
  // Agents on a person's own box run on that person's Claude sign-in, so only they put agents there.
  if (home.personal && home.owner_id !== agent.ownerId) throw new HttpError(403, "That box is a teammate's own. Only they can make agents on it.")
  const taken = await maybe(client, 'select 1 from agents where team_id = $1 and name = $2 and archived_at is null', [agent.teamId, agent.name])
  if (taken) throw new HttpError(409, `there is already an agent named ${agent.name}`)
  const made = await one<{ id: string }>(client, 'the new agent',
    `insert into agents (team_id, name, title, role, instructions, model, home_instance_id, owner_id, visibility, made_by_session, made_by_ask)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'team', $9, $10) returning id`,
    [agent.teamId, agent.name, agent.title, agent.role, agent.instructions, agent.model, home.id, agent.ownerId,
      agent.madeBy?.sessionId ?? null, agent.madeBy?.askId ?? null])
  return made.id
}

export async function createAgent(client: pg.PoolClient, person: Person, body: Record<string, unknown>): Promise<string> {
  const agentId = await insertAgent(client, {
    name: text(body.name, 'name', 40), teamId: person.team_id, ownerId: person.id, homeInstanceId: text(body.homeInstanceId, 'homeInstanceId'),
    title: optional(body.title, 'title', 80), role: optional(body.role, 'role', 200), instructions: optional(body.instructions, 'instructions') ?? '',
    model: optional(body.model, 'model', 80), madeBy: null,
  })
  if (typeof body.templateSlug === 'string') await install(client, person, agentId, body.templateSlug)
  return agentId
}

// Whether agents with another owner may message the agent and hand it tasks. A
// message runs a turn on the owner's Claude account, so only the owner says, or an
// admin for an agent nobody owns.
export async function setAcceptsAgents(client: pg.PoolClient, person: Person, agentId: string, accepts: AcceptsAgents): Promise<{ already: boolean }> {
  const agent = await maybe<{ owner_id: string | null; accepts_agents: AcceptsAgents; login: string | null }>(client,
    `select a.owner_id, a.accepts_agents, p.login from agents a left join people p on p.id = a.owner_id
     where a.id = $1 and a.team_id = $2 and a.archived_at is null for update of a`, [agentId, person.team_id])
  if (!agent) throw new HttpError(404, 'no such agent')
  const decides = agent.owner_id === null ? person.role === 'admin' : agent.owner_id === person.id
  if (!decides) {
    throw new HttpError(403, agent.owner_id === null
      ? 'This agent has no owner, so only an admin decides which agents may message it.'
      : `Only ${agent.login ?? 'its owner'} decides which agents may message this agent.`)
  }
  if (agent.accepts_agents === accepts) return { already: true }
  await client.query('update agents set accepts_agents = $2 where id = $1', [agentId, accepts])
  return { already: false }
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
  if (name === 'team-record' || name === 'stage' || name === TEAM_AGENTS_SERVER) throw new HttpError(400, `${name} is taken by the tools every session has`)
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

// The hooks an agent's setup names, for a session's message and for a recipe.
export async function hooksOf(client: pg.PoolClient | pg.Pool, agentId: string): Promise<AgentHook[]> {
  const { rows } = await client.query<AgentHook>(
    'select name, event, matcher, command, timeout_sec as "timeoutSec" from agent_hooks where agent_id = $1 order by name', [agentId])
  return rows
}

// A hook is a command the agent's machine runs, so who may change one is narrower than for a skill.
// The machine an agent runs on, and whose it is.
const MachineOf = z.object({ name: z.string(), owner_id: PersonId.nullable(), login: z.string().nullable() })
async function machineOf(client: pg.PoolClient, agentId: string) {
  return MachineOf.parse(await one(client, "the agent's machine",
    `select i.name, i.owner_id, p.login from agents a join instances i on i.id = a.home_instance_id
     left join people p on p.id = i.owner_id where a.id = $1`, [agentId]))
}

// Refuses hooks or plugins for an agent whose machine is a teammate's, unless the person is a team admin.
async function mustRunOn(client: pg.PoolClient, person: Person, agentId: string) {
  const machine = await machineOf(client, agentId)
  if (!mayRunOn(person, machine.owner_id)) {
    throw new HttpError(403, `Hooks and plugins run commands on ${machine.name} as ${machine.login ?? 'its owner'}, so only they or a team admin can put them there.`)
  }
}

async function agentWithHooksAccess(client: pg.PoolClient, person: Person, agentId: string) {
  const agent = await agentOf(client, person, agentId)
  if (!mayChangeHooks(person, agent, null)) {
    throw new HttpError(403, "Hooks run commands on the agent's machine, so only the agent's owner or a team admin changes them.")
  }
  await mustRunOn(client, person, agent.id)
  return agent
}

// A name for a hook that came with none: its event in dashes, then with 2, 3 and on until it is free on the agent.
async function freeHookName(client: pg.PoolClient, agentId: string, event: unknown): Promise<string> {
  const base = typeof event === 'string' ? event.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase() : 'hook'
  for (let n = 1; ; n++) {
    const name = fit(base, n === 1 ? '' : `-${String(n)}`)
    if (!(await maybe(client, 'select 1 from agent_hooks where agent_id = $1 and name = $2', [agentId, name]))) return name
  }
}

// Saves a hook under the name it came with, or under one made from its event. Answers with the name.
export async function saveHook(client: pg.PoolClient, person: Person, agentId: string, body: Record<string, unknown>): Promise<string> {
  const agent = await agentWithHooksAccess(client, person, agentId)
  // Hooks of one agent are saved one at a time, so a name found free is still free when its hook is written, and two
  // hooks sent with no name at once get two names. The lock does not wait on rows that only refer to the agent.
  await client.query('select 1 from agents where id = $1 for no key update', [agent.id])
  const parsed = AgentHook.safeParse(body.name === undefined ? { ...body, name: await freeHookName(client, agent.id, body.event) } : body)
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error))
  const hook = parsed.data
  // A command is where a pasted key is likeliest to end up, and the record keeps it.
  if (scrub(hook.command) !== hook.command) {
    throw new HttpError(400, 'The command holds what looks like a secret value, and the record keeps commands. Keep the value on the machine and have the command read it from the environment.')
  }
  await client.query(
    `insert into agent_hooks (agent_id, name, event, matcher, command, timeout_sec) values ($1, $2, $3, $4, $5, $6)
     on conflict (agent_id, name) do update set event = excluded.event, matcher = excluded.matcher, command = excluded.command, timeout_sec = excluded.timeout_sec`,
    [agent.id, hook.name, hook.event, hook.matcher, hook.command, hook.timeoutSec])
  return hook.name
}

export async function removeHook(client: pg.PoolClient, person: Person, agentId: string, name: string) {
  await agentWithHooksAccess(client, person, agentId)
  const { rowCount } = await client.query('delete from agent_hooks where agent_id = $1 and name = $2', [agentId, name])
  if (!rowCount) throw new HttpError(404, 'no such hook')
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
  const { rows } = await client.query<Remembered>(
    `select m.scope, p.login, m.kind, m.log_date::text, m.content from memories m left join people p on p.id = m.person_id
     where m.agent_id = $1 and (m.scope = 'team' or m.person_id = any($2))
       and (m.kind = 'profile' or m.log_date > current_date - 4) and m.content <> ''
     order by m.scope, p.login, m.kind desc, m.log_date`, [agentId, personIds])
  return memoryText(rows)
}

export type Remembered = { scope: string; login: string | null; kind: string; log_date: string | null; content: string }

// Memories as the block a session starts with.
export function memoryText(rows: Remembered[]): string {
  if (!rows.length) return ''
  const lines = rows.map((m) => `${m.kind === 'profile' ? 'About' : `Notes from ${m.log_date} on`} ${m.scope === 'team' ? 'the team' : m.login}:\n${m.content}`)
  return `What you remember (keep it current with the update_memory tool):\n\n${lines.join('\n\n')}`
}

// An agent's setup as a recipe. The team's memories come along only when asked
// for, and what the agent remembers about a person never does. Plugin secrets
// are names, so no secret value is in it. A row that holds something a recipe can't
// carry stops the recipe, rather than leaving that part out.
export async function recipeOf(client: pg.PoolClient, agentId: string, withMemories: boolean): Promise<Recipe> {
  const agent = await one<{ title: string | null; role: string | null; instructions: string; model: string | null }>(client, 'the agent',
    'select title, role, instructions, model from agents where id = $1', [agentId])
  const skills = await many<AgentSkill>(client, 'select name, description, content from skills where agent_id = $1 order by name', [agentId])
  const plugins = await many<AgentPlugin>(client, 'select name, kind, config from plugins where agent_id = $1 order by name', [agentId])
  const routines = await many<{ name: string; prompt: string; schedule: string }>(client,
    `select name, prompt, trigger_config->>'schedule' as schedule from routines where agent_id = $1 order by name`, [agentId])
  const memories = withMemories ? await teamMemories(client, agentId) : []
  const recipe = Recipe.safeParse({ ...agent, skills, plugins, routines, hooks: await hooksOf(client, agentId), memories })
  if (!recipe.success) throw new HttpError(409, `This agent's setup can't be made into a recipe. ${z.prettifyError(recipe.error)}`)
  return recipe.data
}

// What an agent remembers about the team, never about a person.
async function teamMemories(client: pg.PoolClient, agentId: string): Promise<RecipeMemory[]> {
  const rows = await many<{ kind: 'profile' | 'log'; date: string | null; content: string }>(client,
    `select kind, log_date::text as date, content from memories where agent_id = $1 and scope = 'team' and content <> '' order by kind desc, log_date`,
    [agentId])
  return rows.map((row): RecipeMemory => {
    if (row.kind === 'profile') return { kind: 'profile', content: row.content }
    if (row.date === null) throw new Error(`a log of agent ${agentId} has no date`)
    return { kind: 'log', date: row.date, content: row.content }
  })
}

// Saves the agent's setup as a template of the team, named after the agent unless a name is given.
export async function saveTemplate(client: pg.PoolClient, person: Person, agentId: string, given: string | null): Promise<{ slug: string; version: number }> {
  const agent = await agentOf(client, person, agentId)
  const name = given ?? agent.name
  const recipe = await recipeOf(client, agent.id, false)
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

// Gives an agent a recipe's setup: who it is, its skills, plugins, routines, hooks
// and the team's memories. Each part goes through the call a person's edit does, so
// a recipe can't carry anything the agent's page would refuse.
export async function installRecipe(client: pg.PoolClient, person: Person, agentId: string, recipe: Recipe) {
  if (recipe.hooks.length > 0 || recipe.plugins.length > 0) await mustRunOn(client, person, agentId)
  await updateAgent(client, person, agentId, { title: recipe.title, role: recipe.role, instructions: recipe.instructions, model: recipe.model })
  for (const skill of recipe.skills) await saveSkill(client, person, agentId, skill)
  for (const plugin of recipe.plugins) await savePlugin(client, person, agentId, plugin)
  for (const routine of recipe.routines) await saveRoutine(client, person, agentId, routine)
  for (const hook of recipe.hooks) await saveHook(client, person, agentId, hook)
  for (const memory of recipe.memories) {
    await client.query(
      `insert into memories (team_id, agent_id, scope, kind, log_date, content) values ($1, $2, 'team', $3, $4, $5)`,
      [person.team_id, agentId, memory.kind, memory.kind === 'log' ? memory.date : null, memory.content])
  }
}

// Gives a new agent a template's setup.
async function install(client: pg.PoolClient, person: Person, agentId: string, slug: string) {
  const template = await maybe<{ recipe: unknown }>(client,
    'select recipe from templates where share_slug = $1 and team_id = $2', [slug, person.team_id])
  if (!template) throw new HttpError(404, 'no such template')
  const recipe = Recipe.safeParse(template.recipe)
  if (!recipe.success) throw new HttpError(409, `The template can't be read. ${z.prettifyError(recipe.error)}`)
  await installRecipe(client, person, agentId, recipe.data)
}

// Makes a new agent owned by the person, on a machine they may use, with a recipe's
// setup, and opens their conversation with it. A copy and a file import both come through here.
// A new agent is made the way the app makes one, so every rule for who may put an agent where holds.
// A copy records the agent it came from and wears its face, and the person can change that after.
export async function agentFromRecipe(
  client: pg.PoolClient, person: Person, where: { name: string; homeInstanceId: string }, recipe: Recipe, copiedFrom: string | null,
): Promise<CopyDone> {
  await lockNames(client, person.team_id)
  const agentId = await createAgent(client, person, { name: where.name, homeInstanceId: where.homeInstanceId })
  if (copiedFrom !== null) {
    await client.query('update agents set copied_from_agent_id = $2, avatar = (select avatar from agents where id = $2) where id = $1', [agentId, copiedFrom])
  }
  await installRecipe(client, person, agentId, recipe)
  const conversationId = await openDm(client, person, where.name)
  return { agentId: AgentId.parse(agentId), name: where.name, conversationId: ConversationId.parse(conversationId), carried: carriedBy(recipe) }
}

// A new agent with the source agent's setup. It saves no template, so a copy never
// changes the setups the team keeps as templates.
export async function copyAgent(client: pg.PoolClient, person: Person, sourceId: string, ask: CopyAsk): Promise<CopyDone> {
  const source = await agentOf(client, person, sourceId)
  const recipe = await recipeOf(client, source.id, ask.memories)
  return agentFromRecipe(client, person, {
    name: ask.name ?? await freeName(client, person.team_id, source.name, '-copy'),
    homeInstanceId: ask.homeInstanceId ?? await defaultMachine(client, person),
  }, recipe, source.id)
}
