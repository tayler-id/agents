// A person's message to a task's session. The tasks, drafts and launch code all
// send one, so it lives apart from them, outside their imports of each other.

import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import { maybe, one } from './db.ts'
import { agentKit, appendEvents, HttpError, scrub, type Person } from './record.ts'
import { CONVERSATION_PERMISSIONS, WORKSPACE_PERMISSIONS } from './permissions.ts'
import type { MessagePayload } from '../shared/types.ts'

// It runs once the workspace is set up, since the machine handles a session's commands in order.
// `said` is the person's own words when the app wrapped them in text of its own.
// The event keeps it, since coach counts only a person's words as their correction.
export async function sendToSession(client: pg.PoolClient, person: Person, sessionId: string, text: string, said = text) {
  const session = await maybe<{ id: string; team_id: string; task_id: string | null; instance_id: string; workspace_id: string | null; harness_session_id: string | null; agent_id: string }>(client,
    'select id, team_id, task_id, instance_id, workspace_id, harness_session_id, agent_id from sessions where id = $1 and team_id = $2 for update',
    [sessionId, person.team_id])
  if (!session?.task_id) throw new HttpError(404, 'no such task session')
  const agent = await one<{ id: string; harness: 'claude' | 'codex'; model: string | null; instructions: string }>(client, "the session's agent",
    'select id, harness, model, instructions from agents where id = $1', [session.agent_id])
  const [seq] = await appendEvents(client, session.id, {
    events: [{ clientId: `person:${randomBytes(8).toString('hex')}`, kind: 'user', text, body: said === text ? { text } : { text, said } }],
  }, person.id)
  const payload: MessagePayload = {
    permissions: session.workspace_id ? WORKSPACE_PERMISSIONS : CONVERSATION_PERMISSIONS,
    text: scrub(text), agentId: agent.id, harness: agent.harness, model: agent.model, instructions: agent.instructions,
    harnessSessionId: session.harness_session_id, workspaceId: session.workspace_id ?? undefined, ...(await agentKit(client, agent.id, [person.id])),
  }
  await client.query(
    `insert into commands (team_id, instance_id, session_id, kind, payload, event_id)
     select $1, $2, $3, 'message', $4, id from events where session_id = $3 and seq = $5`,
    [session.team_id, session.instance_id, session.id, JSON.stringify(payload), seq])
}
