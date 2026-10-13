// Routines: an agent's standing jobs. When one comes due, or someone runs it
// from the app, its prompt goes to the agent's main conversation, where the team
// sees it and the agent's reply.

import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import { maybe, one } from './db.ts'
import { agentKit, appendEvents, appendMessage, conversationSession, HttpError } from './record.ts'
import type { MessagePayload } from '../shared/types.ts'

export async function sendRoutine(client: pg.PoolClient, routineId: string) {
  const routine = await maybe<{
    id: string; name: string; prompt: string; agent_id: string; team_id: string; home_instance_id: string | null
    harness: 'claude' | 'codex'; model: string | null; instructions: string
  }>(client,
    `select r.id, r.name, r.prompt, a.id as agent_id, a.team_id, a.home_instance_id, a.harness, a.model, a.instructions
     from routines r join agents a on a.id = r.agent_id where r.id = $1 and a.archived_at is null`, [routineId])
  if (!routine) throw new HttpError(404, 'no such routine')
  if (!routine.home_instance_id) throw new HttpError(409, 'the agent has no home machine')
  // The agent's main conversation, shared with the team, made on first use.
  let main = await maybe<{ id: string }>(client,
    `select id from conversations where kind = 'main' and agent_id = $1 and archived_at is null order by created_at limit 1`, [routine.agent_id])
  if (!main) {
    main = await one<{ id: string }>(client, "the agent's main conversation",
      `insert into conversations (team_id, kind, agent_id, name) values ($1, 'main', $2, null) returning id`, [routine.team_id, routine.agent_id])
    await client.query('insert into conversation_members (team_id, conversation_id, agent_id) values ($1, $2, $3)', [routine.team_id, main.id, routine.agent_id])
  }
  const text = `Routine "${routine.name}": ${routine.prompt}`
  const message = await appendMessage(client, main.id, { speaker: 'person', body: text, clientId: `routine:${routine.id}:${randomBytes(6).toString('hex')}` })
  const session = await conversationSession(client, routine.team_id, null, main.id, { ...routine, id: routine.agent_id })
  const [seq] = await appendEvents(client, session.id, {
    events: [{ clientId: `message:${message.id}`, kind: 'user', text, body: { text, messageId: message.id, routineId: routine.id } }],
  })
  const payload: MessagePayload = {
    text, agentId: routine.agent_id, harness: routine.harness, model: routine.model, instructions: routine.instructions,
    harnessSessionId: session.harness_session_id, ...(await agentKit(client, routine.agent_id, [])),
  }
  await client.query(
    `insert into commands (team_id, instance_id, session_id, kind, payload, event_id)
     select $1, $2, $3, 'message', $4, id from events where session_id = $3 and seq = $5`,
    [routine.team_id, session.instance_id, session.id, JSON.stringify(payload), seq])
  await client.query('update routines set last_fired_at = now() where id = $1', [routine.id])
  return main.id
}
