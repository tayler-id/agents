// Who may see what. The whole team sees everything by default. A private
// conversation or task is seen only by the people in it.

import { maybe, pool } from './db.ts'
import type { Person } from './record.ts'

// Conversations a person may see: the team's, minus private ones they are not in.
export const VISIBLE_CONVERSATION = `(visibility = 'team' or id in
  (select conversation_id from conversation_members where person_id = $2))`
export const VISIBLE_TASK = `(visibility = 'team' or owner_id = $2 or id in
  (select task_id from task_members where person_id = $2))`

export async function canSeeConversation(person: Person, conversationId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `select 1 from conversations where id = $3 and team_id = $1 and ${VISIBLE_CONVERSATION}`,
    [person.team_id, person.id, conversationId])
  return rows.length > 0
}

export async function canSeeTask(person: Person, taskId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `select 1 from tasks where id = $3 and team_id = $1 and ${VISIBLE_TASK}`, [person.team_id, person.id, taskId])
  return rows.length > 0
}

// Admins may change what the whole team relies on, such as the GitHub connection.
export async function isAdmin(person: Person): Promise<boolean> {
  return Boolean(await maybe(pool, `select 1 from people where id = $1 and role = 'admin'`, [person.id]))
}

export async function canSeeSession(person: Person, sessionId: string): Promise<boolean> {
  const session = await maybe<{ conversation_id: string | null; task_id: string | null }>(pool,
    'select conversation_id, task_id from sessions where id = $1 and team_id = $2', [sessionId, person.team_id])
  if (!session) return false
  // A session serves a conversation or a task. The schema allows nothing else.
  if (session.conversation_id) return canSeeConversation(person, session.conversation_id)
  return session.task_id ? canSeeTask(person, session.task_id) : false
}
