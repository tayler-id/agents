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
import { LINK_WAIT_MS } from '../shared/link.ts'
import { AgentId } from '../shared/ids.ts'
import { InstanceId, PersonId } from '../shared/onboarding.ts'
import { SecretId, SetSecretBody, SettableName, type SecretRemoved, type SecretStored } from '../shared/secrets.ts'

const UUID = '([0-9a-f-]{36})'

// A secret, the agent that needs it and the computer that agent runs on. Each
// part of the agent and the computer is null when the secret has none.
const Found = z.object({
  name: z.string(),
  scope: z.enum(['person', 'team', 'agent']),
  stored_in: z.string(),
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
    `select s.name, s.scope, s.stored_in, a.id as agent_id, i.id as instance_id, i.name as computer, i.owner_id, i.status
     from secrets s
     left join agents a on a.id = s.agent_id and a.archived_at is null
     left join instances i on i.id = a.home_instance_id
     where s.id = $1 and s.team_id = $2`, [secretId, person.team_id])
  if (!row) throw new HttpError(404, 'no such secret')
  const found = Found.parse(row)
  // A secret of a person or the team has no agent, and so no computer to go to.
  if (found.scope !== 'agent') throw new HttpError(400, "Only a secret an agent's plugin needs can be set from the app so far.")
  if (found.stored_in !== 'machine') throw new HttpError(400, 'This secret is kept where the app cannot set it.')
  if (!found.agent_id) throw new HttpError(404, 'no such agent')
  if (!found.instance_id || !found.computer || !found.status) throw new HttpError(409, 'This agent has no computer to put a secret on.')
  const named = SettableName.safeParse(found.name)
  if (!named.success) throw new HttpError(400, `This secret's name can't be set from the app (${problems(named.error)}). Name it something else in the plugin.`)
  // A computer with an owner is the owner's. A value put there is readable by every agent on it.
  if (found.owner_id !== null && found.owner_id !== person.id) {
    throw new HttpError(403, `${found.computer} is a teammate's own computer. Only its owner can set a secret on it.`)
  }
  return { secretId, name: found.name, teamId: person.team_id, instanceId: found.instance_id, computer: found.computer, status: found.status }
}

// The computer's control connection. A computer that is stopped, or has stopped
// answering, has none and gets none: nothing here starts it, and nothing holds
// the value until it is back. One that reports in but has no connection yet may
// be reconnecting after the API restarted, so it gets a short wait.
async function linkTo(target: Target): Promise<Link> {
  const present = linkOf(target.instanceId)
  if (present) return present
  if (target.status === 'offline') {
    throw new HttpError(409, `${target.computer} is stopped, so it can't take a secret now. Start it, then set the value again.`)
  }
  if (target.status === 'stale') {
    throw new HttpError(409, `${target.computer} has stopped answering the server, so it can't take a secret now. Try again once it is back.`)
  }
  const arrived = await waitForLink(target.instanceId, LINK_WAIT_MS)
  if (!arrived) {
    throw new HttpError(409, `${target.computer} is running, but its connection for secrets is not up. Try again in a moment. A daemon from before this version has to be updated first.`)
  }
  return arrived
}

// Puts the value on the agent's computer, and records where and when. The value
// is read from the request and sent on, and is in no other place.
export async function setSecret(person: Person, secretId: SecretId, value: string): Promise<SecretStored> {
  const target = await targetOf(person, secretId)
  const answer = await putOnComputer(await linkTo(target), target.name, value)
  if (answer.type === 'secret_refused') throw new HttpError(409, `${target.computer} would not take it. ${scrub(answer.reason)}`)
  if (answer.type !== 'secret_stored') throw new HttpError(502, `${target.computer} answered a request to set a value with something else.`)
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
  const answer = await removeFromComputer(await linkTo(target), target.name)
  if (answer.type === 'secret_refused') throw new HttpError(409, `${target.computer} would not remove it. ${scrub(answer.reason)}`)
  if (answer.type !== 'secret_removed') throw new HttpError(502, `${target.computer} answered a request to remove a value with something else.`)
  await pool.query('delete from secret_sets where instance_id = $1 and name = $2', [target.instanceId, target.name])
  return { name: target.name, computer: target.computer, had: answer.had }
}

export const secretRoutes: Route[] = [
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
