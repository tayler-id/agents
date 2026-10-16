// Rooms: group conversations with people and agents. A person's post gives each
// agent in the room a turn, one after another, or only the agents it mentions by
// @name. An agent's turn ends with its reply, with PASS when it has nothing to
// add, or at its deadline. Each agent sees what the agents before it said.

import type pg from 'pg'
import { z } from 'zod'
import { many, maybe, one } from './db.ts'
import { withFiles } from './attachments.ts'
import { reactionsNote } from './reactions.ts'
import { agentKit, appendEvents, conversationSession, HttpError, type Person } from './record.ts'
import { CONVERSATION_PERMISSIONS } from './permissions.ts'
import { cancelTurn, queueRoomTurn, requestTurn, signalSession } from './scheduler.ts'
import type { MessagePayload } from '../shared/types.ts'
import { AgentId, SessionId, TurnId } from '../shared/ids.ts'
import { ConversationId, PersonId, type Login } from '../shared/onboarding.ts'
import type { ProjectId } from '../shared/projects.ts'

const TURN_SECONDS = Number(process.env.AGENTS_TURN_SECONDS ?? 180)
export const PASS = 'PASS'

export async function createRoom(
  client: pg.PoolClient, person: Person, name: string, logins: string[], agentNames: string[], projectId?: ProjectId,
): Promise<string> {
  if (!name.trim() || name.length > 80) throw new HttpError(400, 'a room needs a name')
  if (projectId && !(await maybe(client, 'select 1 from projects where id = $1 and team_id = $2 and archived_at is null', [projectId, person.team_id]))) {
    throw new HttpError(404, 'no such project')
  }
  const { rows: people } = await client.query<{ id: string }>(
    'select id from people where team_id = $1 and (id = $2 or login = any($3))', [person.team_id, person.id, logins])
  const { rows: found } = await client.query<{ id: string; name: string }>(
    'select id, name from agents where team_id = $1 and name = any($2) and archived_at is null', [person.team_id, agentNames])
  if (found.length !== new Set(agentNames).size) throw new HttpError(404, 'every agent must be on your team')
  // Agents take turns in the order they were named.
  const agents = [...new Set(agentNames)].flatMap((name) => found.filter((a) => a.name === name))
  // A room outside any project has a null project_id.
  const room = await one<{ id: string }>(client, 'the new room',
    `insert into conversations (team_id, kind, name, project_id) values ($1, 'room', $2, $3) returning id`, [person.team_id, name.trim(), projectId ?? null])
  for (const p of people) {
    await client.query('insert into conversation_members (team_id, conversation_id, person_id) values ($1, $2, $3)', [person.team_id, room.id, p.id])
  }
  for (const a of agents) {
    await client.query('insert into conversation_members (team_id, conversation_id, agent_id) values ($1, $2, $3)', [person.team_id, room.id, a.id])
  }
  return room.id
}

const RoomAccess = z.object({ visibility: z.enum(['team', 'private']), member: z.boolean() })
const Teammate = z.object({ id: PersonId })

// Adds a teammate to a room. Its agents then name them among the room's people on
// their turns, with what they remember about them. Someone in the room may add to
// it, and an admin may add to any of the team's rooms but a private one they are not in.
export async function addRoomMember(client: pg.PoolClient, person: Person, roomId: ConversationId, login: Login): Promise<PersonId> {
  const found = await maybe(client,
    `select c.visibility, exists (select 1 from conversation_members m where m.conversation_id = c.id and m.person_id = $3) as member
     from conversations c where c.id = $1 and c.team_id = $2 and c.kind = 'room' and c.archived_at is null`,
    [roomId, person.team_id, person.id])
  const room = found ? RoomAccess.parse(found) : undefined
  // A private room is not shown to people outside it, admins included, so they are told it does not exist.
  if (!room || (room.visibility === 'private' && !room.member)) throw new HttpError(404, 'no such room')
  const allowed = room.member || person.role === 'admin'
  if (!allowed) throw new HttpError(403, 'Only people in the room, or an admin, can add someone to it.')
  const teammate = await maybe(client, 'select id from people where team_id = $1 and login = $2', [person.team_id, login])
  if (!teammate) throw new HttpError(404, `${login} is not on your team.`)
  const { id } = Teammate.parse(teammate)
  const added = await maybe(client,
    `insert into conversation_members (team_id, conversation_id, person_id) values ($1, $2, $3)
     on conflict do nothing returning id`, [person.team_id, roomId, id])
  if (!added) throw new HttpError(409, `${login} is already in the room.`)
  return id
}

// A person posted. Each agent the post mentions takes a turn, or every agent in
// the room when it mentions none. The turns wait in the room's line, in order.
export async function queueTurns(client: pg.PoolClient, person: Person, roomId: string, text: string) {
  const { rows: agents } = await client.query<{ id: string; name: string }>(
    `select a.id, a.name from conversation_members m join agents a on a.id = m.agent_id
     where m.conversation_id = $1 and a.archived_at is null order by m.id`, [roomId])
  const mentioned = agents.filter((a) => new RegExp(`@${a.name}\\b`).test(text))
  for (const agent of mentioned.length ? mentioned : agents) {
    await queueRoomTurn(client, {
      teamId: person.team_id, agentId: AgentId.parse(agent.id), conversationId: ConversationId.parse(roomId), askedBy: person.id, deadlineSec: TURN_SECONDS,
    })
  }
  await nextTurn(client, roomId)
}

// Gives the room's next turn in line its go, unless one is under way. A turn is
// under way from its go until the room has its outcome, waiting for its
// machine included.
export async function nextTurn(client: pg.PoolClient, roomId: string) {
  await client.query('select id from conversations where id = $1 for update', [roomId])
  const active = await maybe(client,
    `select 1 from turns where conversation_id = $1 and status <> 'queued' and outcome is null`, [roomId])
  if (active) return
  const queued = await maybe<{ id: string; agent_id: string; team_id: string }>(client,
    `select id, agent_id, team_id from turns where conversation_id = $1 and status = 'queued' and outcome is null
     order by requested_at, id limit 1`, [roomId])
  if (!queued) return
  const turn = { ...queued, id: TurnId.parse(queued.id) }
  const agent = await one<{ id: string; name: string; home_instance_id: string | null; harness: 'claude' | 'codex'; model: string | null; instructions: string }>(client, "the turn's agent",
    'select id, name, home_instance_id, harness, model, instructions from agents where id = $1', [turn.agent_id])
  if (!agent.home_instance_id) {
    await client.query(`update turns set outcome = 'skipped' where id = $1`, [turn.id])
    await cancelTurn(client, turn.id)
    return nextTurn(client, roomId)
  }
  const session = await conversationSession(client, turn.team_id, null, roomId, agent)
  const room = await one<{ name: string }>(client, 'the room', 'select name from conversations where id = $1', [roomId])
  // What was said since this agent last spoke or passed, so a resumed session
  // catches up. A turn cancelled before its machine took it said nothing.
  const last = await maybe<{ seq: string | null }>(client,
    `select max(m.seq) as seq from messages m join turns t on t.conversation_id = m.conversation_id
     where m.conversation_id = $1 and t.agent_id = $2 and t.finished_at is not null and t.status <> 'cancelled'
       and m.created_at <= t.finished_at`, [roomId, agent.id])
  const { rows: said } = await client.query<{ id: string; who: string; body: string }>(
    `select m.id, coalesce(p.login, a.name, 'someone') as who, m.body from messages m
     left join people p on p.id = m.person_id left join agents a on a.id = m.agent_id
     where m.conversation_id = $1 and m.seq > $2 and m.deleted_at is null order by m.seq desc limit 20`, [roomId, Number(last?.seq ?? 0)])
  const files = await many<{ message_id: string; id: string; name: string; media_type: string; size: number }>(client,
    'select message_id, id, name, media_type, size::int as size from attachments where message_id = any($1) order by created_at, id', [said.map((m) => m.id)])
  const reactions = await reactionsNote(client, agent.id, { conversationId: roomId })
  const { rows: members } = await client.query<{ who: string }>(
    `select coalesce(p.login, a.name) as who from conversation_members m left join people p on p.id = m.person_id
     left join agents a on a.id = m.agent_id where m.conversation_id = $1`, [roomId])
  const text = `You are ${agent.name} in the room #${room.name}, with ${members.map((m) => m.who).filter((w) => w !== agent.name).join(', ')}.\n\n`
    + `New in the room:\n${said.reverse().map((m) => `${m.who}: ${withFiles(m.body, files.filter((f) => f.message_id === m.id))}`).join('\n\n')}\n\n`
    + (reactions ? `${reactions}\n\n` : '')
    + `It is your turn. Reply to the room if you have something useful to add. If you have nothing to add, reply with exactly ${PASS}.`
  const [seq] = await appendEvents(client, session.id, { events: [{ clientId: `turn:${turn.id}`, kind: 'user', text, body: { text, turnId: turn.id } }] })
  if (seq === undefined) throw new Error(`room turn ${turn.id}'s prompt did not reach its session`)
  const people = (await client.query<{ person_id: string }>(
    'select person_id from conversation_members where conversation_id = $1 and person_id is not null', [roomId])).rows.map((r) => r.person_id)
  const payload: MessagePayload = {
    permissions: CONVERSATION_PERMISSIONS, text, agentId: agent.id, harness: agent.harness, model: agent.model, instructions: agent.instructions,
    harnessSessionId: session.harness_session_id, ...(await agentKit(client, agent.id, people)),
  }
  await requestTurn(client, { queued: turn.id }, { sessionId: SessionId.parse(session.id), seq, payload })
  await client.query('update turns set deadline = now() + make_interval(secs => $2) where id = $1', [turn.id, TURN_SECONDS])
}

// An agent's turn in a room ended: it replied, passed, or its session failed.
export async function finishTurn(client: pg.PoolClient, roomId: string, agentId: string, outcome: 'sent' | 'pass' | 'error') {
  const { rowCount } = await client.query(
    `update turns set outcome = $3
     where conversation_id = $1 and agent_id = $2 and status <> 'queued' and outcome is null`,
    [roomId, agentId, outcome])
  if (rowCount) await nextTurn(client, roomId)
}

// Turns past their deadline end as timeouts, and the next agent goes. A turn
// still waiting for its machine is cancelled, and one its machine has is interrupted.
export async function expireTurns(client: pg.PoolClient, teamIds: string[] | null) {
  const { rows } = await client.query<{ id: string; conversation_id: string; session_id: string; status: string }>(
    `update turns set outcome = 'timeout'
     where status <> 'queued' and outcome is null and deadline < now() and ($1::uuid[] is null or team_id = any($1))
     returning id, conversation_id, session_id, status`, [teamIds])
  for (const turn of rows) {
    if (turn.status === 'waiting') await cancelTurn(client, TurnId.parse(turn.id))
    if (turn.status === 'placed' || turn.status === 'running') await signalSession(client, SessionId.parse(turn.session_id), 'interrupt')
    await nextTurn(client, turn.conversation_id)
  }
  return rows.length
}
