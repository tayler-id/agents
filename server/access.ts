// Who may see what. The whole team sees everything by default. A private
// conversation or task is seen only by the people in it.

import { pool } from './db.ts'
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

// Connected folders a person may see: the team's, and their own private ones.
// Connecting a folder is its person's choice to share its terminal sessions.
export const VISIBLE_FOLDER = `(visibility = 'team' or connected_by = $2)`

// Sessions a person may see: those of a conversation, a task or a connected
// folder they may see. It reads a sessions row named s and the person's id as $2.
// Each part looks its parent up by key, so a list tests its rows one at a time
// and a single session costs three lookups.
export const VISIBLE_SESSION = `(
  exists (select 1 from conversations where id = s.conversation_id and ${VISIBLE_CONVERSATION})
  or exists (select 1 from tasks where id = s.task_id and ${VISIBLE_TASK})
  or exists (select 1 from connected_folders where id = s.folder_id and ${VISIBLE_FOLDER}))`

// A session serves a conversation, a task, or a person's terminal in a connected folder.
export async function canSeeSession(person: Person, sessionId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `select 1 from sessions s where s.id = $3 and s.team_id = $1 and ${VISIBLE_SESSION}`, [person.team_id, person.id, sessionId])
  return rows.length > 0
}
