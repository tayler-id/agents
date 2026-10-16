// Secrets set from the app. A plugin names the secrets it needs, and the
// computer holds their values. A person sets one here, and the value goes to the
// agent's computer over its control connection (server/control.ts) and nowhere
// else: not Postgres, not a command, not a log. The record keeps the name, where
// it is set and when. The design is "Secrets set from the app" in
// docs/design/target-architecture.md.

import { z } from 'zod'
import { personFrom } from './auth.ts'
import { maybe, one, pool } from './db.ts'
import { linkOf, putOnComputer, removeFromComputer, waitForLink, type Link } from './control.ts'
import { parseBody, pathId, problems, type Route } from './http.ts'
import { HttpError, scrub, type Person } from './record.ts'
import { wakeRunner } from './runner.ts'
import { LINK_WAIT_MS, LINK_WAKE_MS } from '../shared/link.ts'
import { AgentId } from '../shared/ids.ts'
import { InstanceId, PersonId } from '../shared/onboarding.ts'
import { mayPutOn, SecretId, AgentKey, type AgentKeys, type KeySummaries, type SecretRemoved, type SecretStored } from '../shared/secrets.ts'
import { SetSecretBody, SettableName } from '../shared/secret-rules.ts'

const UUID = '([0-9a-f-]{36})'

// Seconds a request waits for a computer that is not running to come up. A check shortens it.
const WakeSeconds = z.coerce.number().positive().default(LINK_WAKE_MS / 1000)
const wakeSeconds = WakeSeconds.safeParse(process.env.AGENTS_SECRET_WAKE_SEC)
if (!wakeSeconds.success) throw new Error('AGENTS_SECRET_WAKE_SEC must be a number of seconds above 0')
const WAKE_MS = wakeSeconds.data * 1000

// A secret, the agent that needs it and the computer that agent runs on. Each
// part of the agent and the computer is null when the secret has none.
const Found = z.object({
  name: z.string(),
  agent_id: AgentId.nullable(),
  instance_id: InstanceId.nullable(),
  computer: z.string().nullable(),
  owner_id: PersonId.nullable(),
  status: z.enum(['online', 'stale', 'offline']).nullable(),
})

// The computer a secret's value goes to.
type Target = { secretId: SecretId; name: string; teamId: Person['team_id']; instanceId: InstanceId; computer: string; status: 'online' | 'stale' | 'offline' }

// Where a person's request for a secret leads, or why it cannot. Each refusal
// says what the person can do.
async function targetOf(person: Person, secretId: SecretId): Promise<Target> {
  const row = await maybe(pool,
    `select s.name, a.id as agent_id, i.id as instance_id, i.name as computer, i.owner_id, i.status
     from secrets s
     left join agents a on a.id = s.agent_id and a.archived_at is null
     left join instances i on i.id = a.home_instance_id
     where s.id = $1 and s.team_id = $2`, [secretId, person.team_id])
  if (!row) throw new HttpError(404, 'no such secret')
  const found = Found.parse(row)
  // A secret of a person or the team has no agent, and so no computer to go to. Nor has one whose agent is archived.
  if (!found.agent_id) throw new HttpError(400, "Only a secret an active agent's plugin needs can be set from the app so far.")
  if (!found.instance_id || !found.computer || !found.status) throw new HttpError(409, 'This agent has no computer to put a secret on.')
  const named = SettableName.safeParse(found.name)
  if (!named.success) throw new HttpError(400, `This secret's name can't be set from the app (${problems(named.error)}). Name it something else in the plugin.`)
  // A computer with an owner is the owner's. A value put there is readable by every agent on it.
  if (!mayPutOn(found.owner_id, person.id)) {
    throw new HttpError(403, `${found.computer} is a teammate's own computer. Only its owner can set a secret on it.`)
  }
  return { secretId, name: found.name, teamId: person.team_id, instanceId: found.instance_id, computer: found.computer, status: found.status }
}

// Asks for a computer that is not running to be started. Here the runner's loop starts a box a person or a run
// holds, on its next tick, and this makes that tick now. Nothing starts a Mac, so a request for one waits out
// its time for its daemon to come. Step 1 lets a person's idle box sleep, and starts a sleeping box only while
// something wants it (WANTED in server/boxes.ts), so a request for a key has to say that it does, here.
const wakeComputer = async (target: Target): Promise<void> => {
  console.log(`asking for ${target.computer} to start, since a key waits for it`)
  await wakeRunner()
}

// The computer's control connection, and the wait for it when it is not up. A computer that reports it is
// running may be reconnecting after the API restarted, so it is waited for a moment. One that is not running
// is asked to start and waited for until it has had time to, since a person should not have to set a computer
// up or try again. The value is held in this request while it waits, and nowhere else.
async function linkTo(target: Target, did: 'saved' | 'removed'): Promise<Link> {
  const present = linkOf(target.instanceId)
  if (present) return present
  const running = target.status === 'online'
  if (!running) await wakeComputer(target)
  const waitMs = running ? LINK_WAIT_MS : WAKE_MS
  const arrived = await waitForLink(target.instanceId, waitMs)
  if (arrived) return arrived
  if (running) {
    throw new HttpError(504, `${target.computer} is running, but its connection for keys is not up. Try again in a moment. A daemon from before this version has to be updated first.`)
  }
  throw new HttpError(504, `${target.computer} did not start within ${String(Math.round(waitMs / 1000))} seconds, so the key was not ${did}. Try again once it is running.`)
}

// Puts the value on the agent's computer, and records where and when. The value
// is read from the request and sent on, and is in no other place.
export async function setSecret(person: Person, secretId: SecretId, value: string): Promise<SecretStored> {
  const target = await targetOf(person, secretId)
  const link = await linkTo(target, 'saved')
  const answer = await putOnComputer(link, target.name, value)
  if (answer.type === 'secret_refused') throw new HttpError(409, `${target.computer} would not take it. ${scrub(answer.reason)}`)
  if (answer.type !== 'secret_stored') throw new HttpError(502, `${target.computer} answered a request to set a value with something else.`)
  // A computer lists what it holds when it connects, and the API drops each row it does not list. This
  // value was stored after that list was made, so the row is written once the comparison has finished,
  // and the comparison cannot drop it.
  await link.reported
  // The value is on the computer now. If this write fails, the person sets it again.
  const row = await one(pool, 'the row for the value just set',
    `insert into secret_sets (team_id, instance_id, name, set_by) values ($1, $2, $3, $4)
     on conflict (instance_id, name) do update set set_by = excluded.set_by, set_at = now()
     returning set_at`, [target.teamId, target.instanceId, target.name, person.id])
  const { set_at: setAt } = z.object({ set_at: z.date() }).parse(row)
  return { name: target.name, computer: target.computer, setAt: setAt.toISOString() }
}

// Removes the value from the agent's computer, and the record of it. The name
// stays, since the plugin still needs it.
export async function removeSecret(person: Person, secretId: SecretId): Promise<SecretRemoved> {
  const target = await targetOf(person, secretId)
  const answer = await removeFromComputer(await linkTo(target, 'removed'), target.name)
  if (answer.type === 'secret_refused') throw new HttpError(409, `${target.computer} would not remove it. ${scrub(answer.reason)}`)
  if (answer.type !== 'secret_removed') throw new HttpError(502, `${target.computer} answered a request to remove a value with something else.`)
  await pool.query('delete from secret_sets where instance_id = $1 and name = $2', [target.instanceId, target.name])
  return { name: target.name, computer: target.computer, had: answer.had }
}

const PluginRow = z.object({
  agent_id: AgentId,
  plugin: z.string(),
  env: z.record(z.string(), z.object({ secret: z.string() })).nullish(),
  headers: z.record(z.string(), z.object({ secret: z.string() })).nullish(),
})
const AgentRow = z.object({ id: AgentId, computer: z.string().nullable(), instance_id: InstanceId.nullable() })
const SecretIdRow = z.object({ id: SecretId, agent_id: AgentId, name: z.string() })
const SetRow = z.object({ instance_id: InstanceId, name: z.string(), set_at: z.date(), login: z.string().nullable() })

// The keys of one agent, or of every agent on the team when `only` is null. One list serves the agent's Keys
// row and each app's page, so the two never disagree. Names and times only, never a value.
async function keysFor(person: Person, only: string | null): Promise<AgentKeys[]> {
  const agents = (await pool.query(
    `select a.id, i.name as computer, i.id as instance_id from agents a left join instances i on i.id = a.home_instance_id
     where a.team_id = $1 and a.archived_at is null and ($2::uuid is null or a.id = $2) order by a.name`, [person.team_id, only])).rows.map((r) => AgentRow.parse(r))
  if (only !== null && agents.length === 0) throw new HttpError(404, 'no such agent')
  const plugins = (await pool.query(
    `select p.agent_id, p.name as plugin, p.config->'env' as env, p.config->'headers' as headers from plugins p
     join agents a on a.id = p.agent_id where a.team_id = $1 and ($2::uuid is null or a.id = $2) order by p.name`, [person.team_id, only])).rows.map((r) => PluginRow.parse(r))
  const ids = (await pool.query('select id, agent_id, name from secrets where team_id = $1 and agent_id is not null', [person.team_id])).rows.map((r) => SecretIdRow.parse(r))
  const sets = (await pool.query(
    `select s.instance_id, s.name, s.set_at, p.login from secret_sets s left join people p on p.id = s.set_by where s.team_id = $1`, [person.team_id])).rows.map((r) => SetRow.parse(r))
  return agents.map((agent) => {
    const byName = new Map<string, AgentKey>()
    for (const plugin of plugins.filter((p) => p.agent_id === agent.id)) {
      for (const { secret } of [...Object.values(plugin.env ?? {}), ...Object.values(plugin.headers ?? {})]) {
        const held = sets.find((s) => s.instance_id === agent.instance_id && s.name === secret)
        const key = byName.get(secret) ?? {
          secretId: ids.find((i) => i.agent_id === agent.id && i.name === secret)?.id ?? null, name: secret, plugins: [],
          state: held ? 'set' : 'missing', setAt: held?.set_at.toISOString() ?? null, setBy: held?.login ?? null,
        }
        if (!key.plugins.includes(plugin.plugin)) key.plugins.push(plugin.plugin)
        byName.set(secret, AgentKey.parse(key))
      }
    }
    const keys = [...byName.values()]
    return { agentId: agent.id, computer: agent.computer, keys, missing: keys.filter((k) => k.state === 'missing').length }
  })
}

export async function keysOfAgent(person: Person, agentId: string): Promise<AgentKeys> {
  const [found] = await keysFor(person, agentId)
  if (!found) throw new HttpError(404, 'no such agent')
  return found
}

export async function keySummaries(person: Person): Promise<KeySummaries> {
  return { agents: (await keysFor(person, null)).map((a) => ({ agentId: a.agentId, total: a.keys.length, missing: a.missing })) }
}

export const secretRoutes: Route[] = [
  // Every key one agent needs, each set or missing, with the plugins that use it.
  ['people', 'GET', new RegExp(`^/v1/agents/${UUID}/keys$`), async (req, [id]) => keysOfAgent(await personFrom(req), pathId(AgentId, id))],

  // Each agent's count of keys and of keys missing, for a dot on a list.
  ['people', 'GET', /^\/v1\/keys$/, async (req) => keySummaries(await personFrom(req))],

  // A person sets a secret's value. The body holds it, and nothing else of the request does.
  ['people', 'POST', new RegExp(`^/v1/secrets/${UUID}/value$`), async (req, [id]) => {
    const person = await personFrom(req)
    const secretId = pathId(SecretId, id)
    const body = await parseBody(req, SetSecretBody)
    return setSecret(person, secretId, body.value)
  }],

  ['people', 'POST', new RegExp(`^/v1/secrets/${UUID}/remove$`), async (req, [id]) => {
    const person = await personFrom(req)
    return removeSecret(person, pathId(SecretId, id))
  }],
]
