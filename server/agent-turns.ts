// Turns that one agent's words cause in another agent's session: a message, the
// answer that comes back, a handed-over task's first message, and the task's
// result. Each goes into the session as a user event naming the agent whose words
// it carries, and through the scheduler as a turn with source agent or
// delegation, so it waits, is placed and ends like any other. When a turn that
// another turn waits on ends, the runner sends its answer back, once.

import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { many, maybe, one, pool, tx } from './db.ts'
import { agentKit, appendEvents, scrub } from './record.ts'
import { CONVERSATION_PERMISSIONS, WORKSPACE_PERMISSIONS } from './permissions.ts'
import { requestTurn, type AgentCause } from './scheduler.ts'
import { AgentId, ConversationId, SessionId, TaskId, TeamId, TurnId, WorkspaceId } from '../shared/ids.ts'
import { messageOf } from '../shared/errors.ts'
import type { MessagePayload } from '../shared/types.ts'

// An agent's session, which serves a conversation or a task.
const AgentSession = z.object({
  id: SessionId, team_id: TeamId, agent_id: AgentId, conversation_id: ConversationId.nullable(), task_id: TaskId.nullable(),
  workspace_id: WorkspaceId.nullable(), harness_session_id: z.string().nullable(),
})

// What one agent says to another, as the user event that carries it. The event's
// body keeps `text` beside whatever links the caller gives it.
type Words = { text: string; clientId: string; links: Record<string, string> }

// Records another agent's words as a user event in a session, and asks the
// scheduler for the session's turn. `from` is the agent whose words they are.
// Returns the turn, or null when the event's client id was already recorded, so
// nothing is sent twice.
export async function sendAgentTurn(client: pg.PoolClient, sessionId: SessionId, words: Words, from: AgentId, cause: AgentCause): Promise<TurnId | null> {
  const session = AgentSession.parse(await one(client, `the agent session ${sessionId}`,
    'select id, team_id, agent_id, conversation_id, task_id, workspace_id, harness_session_id from sessions where id = $1', [sessionId]))
  const [seq] = await appendEvents(client, session.id, {
    events: [{ clientId: words.clientId, kind: 'user', text: words.text, body: { ...words.links, text: words.text } }],
  }, { agent: from })
  if (seq === undefined) return null
  const agent = await one<{ id: string; harness: 'claude' | 'codex'; model: string | null; instructions: string }>(client, "the session's agent",
    'select id, harness, model, instructions from agents where id = $1', [session.agent_id])
  const payload: MessagePayload = {
    permissions: session.workspace_id ? WORKSPACE_PERMISSIONS : CONVERSATION_PERMISSIONS, text: scrub(words.text), agentId: agent.id,
    harness: agent.harness, model: agent.model, instructions: agent.instructions, harnessSessionId: session.harness_session_id,
    workspaceId: session.workspace_id ?? undefined, ...(await agentKit(client, agent.id, [])),
  }
  const asker = { teamId: session.team_id, agentId: session.agent_id, ...cause }
  const prompt = { sessionId: session.id, seq, payload }
  if (session.conversation_id !== null) return requestTurn(client, { ...asker, conversationId: session.conversation_id }, prompt)
  if (session.task_id !== null) return requestTurn(client, { ...asker, taskId: session.task_id }, prompt)
  throw new Error(`session ${session.id} serves neither a conversation nor a task`)
}

// The turn that handed a task over: where its result goes, and what that turn answers.
const HandingOver = z.object({ session_id: SessionId, answer_to_turn: TurnId.nullable(), hops: z.number().int() })

// A handed-over task's result goes to the turn of the agent that handed it over,
// as a delegation turn in that agent's session, which then answers what that
// turn answered. `fromSession` is the task's session.
export async function deliverTaskResult(client: pg.PoolClient, task: { id: TaskId; agentId: AgentId; askedByTurn: TurnId }, text: string, fromSession: SessionId): Promise<TurnId> {
  const asked = HandingOver.parse(await one(client, `the turn that handed over task ${task.id}`,
    'select session_id, answer_to_turn, hops from turns where id = $1', [task.askedByTurn]))
  const turnId = await sendAgentTurn(client, asked.session_id, { text, clientId: `result:${task.id}:${randomUUID()}`, links: { taskId: task.id } }, task.agentId,
    { source: 'delegation', askedBySession: fromSession, answerTo: asked.answer_to_turn, hops: asked.hops + 1 })
  if (turnId === null) throw new Error(`the result of task ${task.id} was recorded already, with a client id made just now`)
  return turnId
}

// A person marked a task done. When an agent handed it over, its result goes back
// as its agent's last words on it, since the agent did not report back.
export async function deliverMarkedDone(client: pg.PoolClient, taskId: TaskId, by: string) {
  const found = await maybe(client,
    `select t.id, t.title, t.agent_id, a.name as agent, t.asked_by_turn,
       (select s.id from sessions s where s.task_id = t.id order by s.created_at desc, s.id desc limit 1) as session_id,
       (select e.body->>'text' from events e join sessions s on s.id = e.session_id
        where s.task_id = t.id and e.kind = 'assistant' and e.parent_tool_use_id is null and coalesce(e.body->>'text', '') <> ''
        order by e.created_at desc, e.id desc limit 1) as last_words
     from tasks t join agents a on a.id = t.agent_id where t.id = $1 and t.asked_by_turn is not null`, [taskId])
  if (!found) return
  const task = z.object({
    id: TaskId, title: z.string(), agent_id: AgentId, agent: z.string(), asked_by_turn: TurnId, session_id: SessionId, last_words: z.string().nullable(),
  }).parse(found)
  const text = task.last_words === null
    ? `${by} marked the task you handed ${task.agent}, "${task.title}", done, before ${task.agent} said anything on it.`
    : `${by} marked the task you handed ${task.agent}, "${task.title}", done. ${task.agent}'s last words on it:\n\n${task.last_words}`
  await deliverTaskResult(client, { id: task.id, agentId: task.agent_id, askedByTurn: task.asked_by_turn }, text, task.session_id)
}

// A finished turn that another turn waits on, with that turn's session and what it answers.
const Answering = z.object({
  id: TurnId, session_id: SessionId, agent_id: AgentId, agent: z.string(), status: z.enum(['done', 'failed', 'cancelled']), hops: z.number().int(),
  prompt_seq: z.coerce.number().int().nullable(), finished_at: z.date(), waiting_session: SessionId, waiting_answer_to: TurnId.nullable(),
})
type Answering = z.infer<typeof Answering>

// What an answer says: the turn's last words, or why it has none. Words and an
// error count only up to the turn's end, so a later turn's never answer for it.
async function answerOf(client: pg.PoolClient, turn: Answering): Promise<string> {
  if (turn.status === 'cancelled') return `${turn.agent}'s turn was cancelled before it ran, so ${turn.agent} did not answer you.`
  const since = [turn.session_id, turn.prompt_seq ?? 0, turn.finished_at]
  if (turn.status === 'failed') {
    const error = await maybe<{ text: string }>(client,
      `select text from events where session_id = $1 and kind = 'error' and seq > $2 and created_at <= $3 and text is not null
       order by seq desc limit 1`, since)
    return `${turn.agent} could not answer you. ${error?.text ?? 'Its turn failed.'}`
  }
  const reply = await maybe<{ text: string }>(client,
    `select body->>'text' as text from events where session_id = $1 and kind = 'assistant' and parent_tool_use_id is null
       and coalesce(body->>'text', '') <> '' and seq > $2 and created_at <= $3 order by seq desc limit 1`, since)
  return reply ? `${turn.agent} answered you, in your thread with ${turn.agent}:\n\n${reply.text}` : `${turn.agent} ended its turn without a word for you.`
}

// Sends one finished turn's answer to the turn that waits for it, unless another
// runner holds it or sent it already.
async function answerTurn(client: pg.PoolClient, turnId: TurnId) {
  const found = await maybe(client,
    `select t.id, t.session_id, t.agent_id, a.name as agent, t.status, t.hops, p.seq as prompt_seq, t.finished_at,
       w.session_id as waiting_session, w.answer_to_turn as waiting_answer_to
     from turns t join turns w on w.id = t.answer_to_turn join agents a on a.id = t.agent_id left join events p on p.id = t.event_id
     where t.id = $1 and t.answer_sent_at is null for update of t skip locked`, [turnId])
  if (!found) return
  const turn = Answering.parse(found)
  await sendAgentTurn(client, turn.waiting_session, { text: await answerOf(client, turn), clientId: `answer:${turn.id}`, links: { answers: turn.id } }, turn.agent_id,
    { source: 'agent', askedBySession: turn.session_id, answerTo: turn.waiting_answer_to, hops: turn.hops })
  await client.query('update turns set answer_sent_at = now() where id = $1', [turn.id])
}

// The runner sends each finished turn's answer back to the turn waiting for it.
// One that cannot be sent, for a reason of its own, is logged and tried again on
// the next tick, and does not hold up the answers behind it.
export async function answerAgentTurns(teamIds: TeamId[] | null) {
  const due = await many<{ id: string }>(pool,
    `select id from turns where answer_to_turn is not null and answer_sent_at is null and status in ('done', 'failed', 'cancelled')
       and ($1::uuid[] is null or team_id = any($1)) order by finished_at, id`, [teamIds])
  for (const { id } of due) {
    try {
      await tx((client) => answerTurn(client, TurnId.parse(id)))
    } catch (error) {
      console.error(`the answer of turn ${id}: ${messageOf(error)}`)
    }
  }
}
