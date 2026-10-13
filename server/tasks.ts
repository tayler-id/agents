// Work a person asks for, outside any pipeline: a task with its own workspace and
// an agent's session in it, started from the app or from a post in a
// conversation. People talk to the task's session directly, and comment on the
// documents it writes. A task started from a post reports back to that
// conversation when each turn ends.

import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import { maybe, one } from './db.ts'
import { canSeeSession, canSeeTask } from './access.ts'
import { agentKit, appendEvents, appendMessage, HttpError, scrub, type Person } from './record.ts'
import { setTaskRepos } from './checkout.ts'
import { draftSession } from './drafts.ts'
import { launchTask } from './launch.ts'
import { CONVERSATION_PERMISSIONS, workspacePermissions } from './permissions.ts'
import { TaskId } from '../shared/ids.ts'
import type { NewTask } from '../shared/work.ts'
import type { MessagePayload } from '../shared/types.ts'

const slugOf = (title: string) =>
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
  if (body.draft) return { taskId, sessionId: await draftSession(client, person, taskId, body.agentId) }
  return launchTask(client, person, taskId)
}

// A person's message to a task's session. It runs once the workspace is set up,
// since the machine handles its commands in order.
export async function sendToSession(client: pg.PoolClient, person: Person, sessionId: string, text: string) {
  const session = await maybe<{ id: string; team_id: string; task_id: string | null; instance_id: string; workspace_id: string | null; harness_session_id: string | null; agent_id: string }>(client,
    'select id, team_id, task_id, instance_id, workspace_id, harness_session_id, agent_id from sessions where id = $1 and team_id = $2 for update',
    [sessionId, person.team_id])
  if (!session?.task_id) throw new HttpError(404, 'no such task session')
  const agent = await one<{ id: string; harness: 'claude' | 'codex'; model: string | null; instructions: string }>(client, "the session's agent",
    'select id, harness, model, instructions from agents where id = $1', [session.agent_id])
  const [seq] = await appendEvents(client, session.id, {
    events: [{ clientId: `person:${randomBytes(8).toString('hex')}`, kind: 'user', text, body: { text } }],
  }, person.id)
  const payload: MessagePayload = {
    permissions: session.workspace_id ? await workspacePermissions(client, session.instance_id) : CONVERSATION_PERMISSIONS,
    text: scrub(text), agentId: agent.id, harness: agent.harness, model: agent.model, instructions: agent.instructions,
    harnessSessionId: session.harness_session_id, workspaceId: session.workspace_id ?? undefined, ...(await agentKit(client, agent.id, [person.id])),
  }
  await client.query(
    `insert into commands (team_id, instance_id, session_id, kind, payload, event_id)
     select $1, $2, $3, 'message', $4, id from events where session_id = $3 and seq = $5`,
    [session.team_id, session.instance_id, session.id, JSON.stringify(payload), seq])
}

export async function messageTaskSession(client: pg.PoolClient, person: Person, sessionId: string, text: string) {
  if (!(await canSeeSession(person, sessionId))) throw new HttpError(404, 'no such session')
  await sendToSession(client, person, sessionId, text)
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
export async function addComment(client: pg.PoolClient, person: Person, artifactId: string, body: { version: number; text: string; quote?: string | null; send?: boolean }) {
  const artifact = await maybe<{ id: string; team_id: string; task_id: string; path: string; made_by_session: string | null }>(client,
    `select id, team_id, task_id, path, made_by_session from artifacts where id = $1 and team_id = $2 and kind = 'document'`, [artifactId, person.team_id])
  if (!artifact || !(await canSeeTask(person, artifact.task_id))) throw new HttpError(404, 'no such document')
  const version = await maybe(client, 'select 1 from artifact_versions where artifact_id = $1 and version = $2', [artifactId, body.version])
  if (!version) throw new HttpError(404, 'no such version')
  const sendTo = body.send ? artifact.made_by_session : null
  const comment = await one<{ id: string }>(client, 'the new comment',
    `insert into comments (team_id, artifact_id, version, anchor, author_person, body, sent_to_session)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [person.team_id, artifactId, body.version, body.quote ? JSON.stringify({ quote: body.quote }) : null, person.id, body.text, sendTo])
  if (sendTo) {
    const quote = body.quote ? `On "${body.quote}":\n` : ''
    await sendToSession(client, person, sendTo,
      `${person.login} commented on ./task/${artifact.path}, version ${body.version}:\n\n${quote}${body.text}\n\nRevise the document in ./task/${artifact.path} if the comment calls for it, then say what you changed.`)
  }
  return comment.id
}

export async function resolveComment(client: pg.PoolClient, person: Person, commentId: string) {
  const { rowCount } = await client.query(`update comments set status = 'resolved' where id = $1 and team_id = $2 and status = 'open'`, [commentId, person.team_id])
  if (!rowCount) throw new HttpError(404, 'no such open comment')
}
