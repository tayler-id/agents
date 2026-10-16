// Work a person asks for, outside any pipeline: a task with its own workspace and
// an agent's session in it, started from the app or from a post in a
// conversation. People talk to the task's session directly, and comment on the
// documents it writes. A task started from a post reports back to that
// conversation when each turn ends.

import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import { maybe, one } from './db.ts'
import { canSeeSession, canSeeTask } from './access.ts'
import { appendMessage, HttpError, type Person } from './record.ts'
import { setTaskRepos } from './checkout.ts'
import { draftSession } from './drafts.ts'
import { launchTask } from './launch.ts'
import { placeTask } from './projects.ts'
import { sendToSession } from './session-messages.ts'
import { TaskId } from '../shared/ids.ts'
import { CommentAnchor, type NewComment, type NewTask } from '../shared/work.ts'

export const slugOf = (title: string) =>
  `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task'}-${randomBytes(2).toString('hex')}`

export async function startTask(client: pg.PoolClient, person: Person, body: Omit<NewTask, 'repoId'>): Promise<{ taskId: string; sessionId: string }> {
  const agent = await maybe<{ id: string; name: string; home_instance_id: string | null; harness: 'claude' | 'codex'; model: string | null; instructions: string }>(client,
    'select id, name, home_instance_id, harness, model, instructions from agents where id = $1 and team_id = $2 and archived_at is null',
    [body.agentId, person.team_id])
  if (!agent) throw new HttpError(404, 'no such agent')
  if (!agent.home_instance_id) throw new HttpError(409, 'this agent has no home machine')
  if (body.conversationId) {
    const { rows } = await client.query('select 1 from conversation_members where conversation_id = $1 and person_id = $2', [body.conversationId, person.id])
    if (!rows[0]) throw new HttpError(404, 'no such conversation of yours')
  }
  const slug = slugOf(body.title)
  const task = await one<{ id: string }>(client, 'the new task',
    `insert into tasks (team_id, slug, title, instructions, owner_id, agent_id, conversation_id, source_message_id, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [person.team_id, slug, body.title, body.instructions, person.id, agent.id, body.conversationId ?? null, body.messageId ?? null,
      body.messageId ? 'message' : 'app'])
  if (body.messageId) await client.query('update messages set task_id = $2 where id = $1 and conversation_id = $3', [body.messageId, task.id, body.conversationId])

  const taskId = TaskId.parse(task.id)
  await setTaskRepos(client, person, taskId, body.repoIds)
  await placeTask(client, taskId, body.projectId)
  if (body.draft) return { taskId, sessionId: await draftSession(client, person, taskId, body.agentId) }
  return launchTask(client, person, taskId)
}

export async function messageTaskSession(client: pg.PoolClient, person: Person, sessionId: string, text: string, attachmentIds: readonly string[] = []) {
  if (!(await canSeeSession(person, sessionId))) throw new HttpError(404, 'no such session')
  // A replay's task is visible to the team, so canSeeSession lets any teammate in.
  if (await maybe(client, 'select 1 from session_replays where session_id = $1', [sessionId])) {
    throw new HttpError(409, "a replay scores a proposed change and takes no messages, since a message would restart it with workspace permissions, the agent's plugins and memory, and no budget")
  }
  await sendToSession(client, person, sessionId, text, text, attachmentIds)
}

// When a task started from a post finishes a turn, its last words go back to
// that conversation, so the people there see how it went.
export async function reportToConversation(client: pg.PoolClient, sessionId: string) {
  const task = await maybe<{ id: string; title: string; conversation_id: string | null; source_message_id: string | null; agent_id: string }>(client,
    `select t.id, t.title, t.conversation_id, t.source_message_id, s.agent_id from sessions s join tasks t on t.id = s.task_id
     where s.id = $1 and t.source = 'message'`, [sessionId])
  if (!task?.conversation_id) return
  const reply = await maybe<{ id: string; text: string }>(client,
    `select id, body->>'text' as text from events where session_id = $1 and kind = 'assistant' and parent_tool_use_id is null
       and coalesce(body->>'text', '') <> '' order by seq desc limit 1`, [sessionId])
  if (!reply) return
  await appendMessage(client, task.conversation_id, {
    speaker: 'agent', agentId: task.agent_id, body: `Task "${task.title}": ${reply.text}`, clientId: `task:${reply.id}`, sessionId, eventId: reply.id,
  })
}

// A comment on a version of a document. Sent to the agent, it reaches the
// session that wrote the document, which can revise it.
export async function addComment(client: pg.PoolClient, person: Person, artifactId: string, body: NewComment) {
  const artifact = await maybe<{ id: string; team_id: string; task_id: string; path: string; made_by_session: string | null }>(client,
    `select id, team_id, task_id, path, made_by_session from artifacts where id = $1 and team_id = $2 and kind = 'document'`, [artifactId, person.team_id])
  if (!artifact || !(await canSeeTask(person, artifact.task_id))) throw new HttpError(404, 'no such document')
  const version = await maybe(client, 'select 1 from artifact_versions where artifact_id = $1 and version = $2', [artifactId, body.version])
  if (!version) throw new HttpError(404, 'no such version')
  const sendTo = body.send ? artifact.made_by_session : null
  const comment = await one<{ id: string }>(client, 'the new comment',
    `insert into comments (team_id, artifact_id, version, anchor, author_person, body, sent_to_session)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [person.team_id, artifactId, body.version, body.quote ? JSON.stringify(CommentAnchor.parse({ quote: body.quote, occurrence: body.occurrence })) : null, person.id, body.text, sendTo])
  if (sendTo) {
    const quote = body.quote ? `On "${body.quote}":\n` : ''
    await sendToSession(client, person, sendTo,
      `${person.login} commented on ./task/${artifact.path}, version ${body.version}:\n\n${quote}${body.text}\n\nRevise the document in ./task/${artifact.path} if the comment calls for it, then say what you changed.`,
      body.text)
  }
  return comment.id
}

export async function resolveComment(client: pg.PoolClient, person: Person, commentId: string) {
  const { rowCount } = await client.query(`update comments set status = 'resolved' where id = $1 and team_id = $2 and status = 'open'`, [commentId, person.team_id])
  if (!rowCount) throw new HttpError(404, 'no such open comment')
}
