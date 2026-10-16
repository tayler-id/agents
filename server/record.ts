// Every write to the shared record goes through here, inside the caller's
// transaction, so numbering, scrubbing and the links between messages, events
// and commands stay consistent.

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type pg from 'pg'
import { z } from 'zod'
import { BlobRow, MAX_IMAGE_BYTES, sniffImage, type DocumentUpload, type ImageMediaType } from '../shared/documents.ts'
import { AgentId, ConversationId, SessionId, type BlobId } from '../shared/ids.ts'
import { maybe, one, type Db } from './db.ts'
import { PersonId, TeamId, TeamRole } from '../shared/onboarding.ts'
import { envSecrets, makeScrub } from '../shared/scrub.ts'
import { PERSON_KINDS, type AgentPlugin, type AgentSkill, type AnswerPayload, type Command, type EventBatch, type MessagePayload, type NewEvent } from '../shared/types.ts'
import { memoryBlock } from './agents.ts'
import { finishTurn, nextTurn, PASS, queueTurns } from './rooms.ts'
import { reportToConversation } from './tasks.ts'
import { CONVERSATION_PERMISSIONS } from './permissions.ts'
import { closeTurnAsks, endMessages, MessageMoveRefused, moveMessages, takeOverEndedAsk } from './durability.ts'
import { requestTurn, signalSession } from './scheduler.ts'
import { pendingUploads, placeUploads, withFiles } from './attachments.ts'
import { reactionsNote } from './reactions.ts'
import { CREATE_AGENT_TOOL, newAgentQuestion } from '../shared/team-agents.ts'

export const scrub = makeScrub(envSecrets(process.env))

// The running cost a usage event reports, or 0. The body is Claude's own line.
function totalCost(body: unknown): number {
  const value = typeof body === 'object' && body !== null && 'total_cost_usd' in body ? Number(body.total_cost_usd) : 0
  return Number.isFinite(value) ? value : 0
}
const TEXT_LIMIT = 8000

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// A person on a team, as the people port knows them.
export const Person = z.object({ id: PersonId, team_id: TeamId, login: z.string(), role: TeamRole })
export type Person = z.infer<typeof Person>
// A session as the schema's check allows it. An agent's session has an agent, and
// serves a conversation or a task. A terminal session serves a folder, and has
// neither an agent nor a conversation.
type Session = { id: string; team_id: string; instance_id: string; last_seq: string } & (
  | { folder_id: null; conversation_id: string | null; agent_id: string }
  | { folder_id: string; conversation_id: null; agent_id: null }
)
type AgentSession = Extract<Session, { folder_id: null }>
type Agent = { id: string; home_instance_id: string | null; harness: 'claude' | 'codex'; model: string | null; instructions: string }

// Who wrote the events a caller appends: a person, by id, or another agent whose
// message a user event carries, or nobody when the session's machine wrote them.
export type EventAuthor = string | { agent: AgentId } | null

// Gives new events the next numbers in their session, skipping any client id
// already recorded, so a retried post leaves no gap and no duplicate.
export async function appendEvents(
  client: pg.PoolClient, sessionId: string, batch: EventBatch, author: EventAuthor = null,
): Promise<number[]> {
  // A batch that ends a turn in a conversation posts there, which locks the
  // conversation. A person's post locks the conversation before the session, so
  // this takes the two in the same order, or the two writes deadlock.
  if (batch.status === 'failed' || batch.events.some((e) => e.kind === 'usage')) {
    await client.query('select 1 from conversations where id = (select conversation_id from sessions where id = $1) for update', [sessionId])
  }
  const session = await maybe<Session>(client,
    'select id, team_id, instance_id, conversation_id, agent_id, folder_id, last_seq from sessions where id = $1 for update', [sessionId])
  if (!session) throw new HttpError(404, 'no such session')

  const ids = batch.events.map((e) => e.clientId)
  const { rows: seen } = await client.query<{ client_id: string }>(
    'select client_id from events where session_id = $1 and client_id = any($2)', [sessionId, ids])
  const seenIds = new Set(seen.map((r) => r.client_id))
  const fresh = batch.events.filter((e, i) => !seenIds.has(e.clientId) && ids.indexOf(e.clientId) === i)

  let seq = Number(session.last_seq)
  const seqs: number[] = []
  for (const event of fresh) {
    seq += 1
    seqs.push(seq)
    await insertEvent(client, session, seq, event, author)
  }
  for (const raw of batch.raw ?? []) {
    await client.query(
      'insert into raw_events (session_id, client_id, line) values ($1, $2, $3) on conflict do nothing',
      [sessionId, raw.clientId, JSON.stringify(scrub(raw.line))])
  }

  const turnsEnded = fresh.filter((e) => e.kind === 'usage')
  // Claude reports the session's running total, kept across resumes.
  const cost = Math.max(0, ...turnsEnded.map((e) => totalCost(e.body)))
  await client.query(
    `update sessions set last_seq = $2, turns = turns + $3, last_active_at = now(),
       status = coalesce($4, status), harness_session_id = coalesce($5, harness_session_id),
       cost_usd = case when $6::numeric > 0 then greatest(coalesce(cost_usd, 0), $6::numeric) else cost_usd end
     where id = $1`,
    [sessionId, seq, turnsEnded.length, batch.status ?? null, batch.harnessSessionId ?? null, cost])
  // A turn ends with its result, or with its harness exiting before one. Its asks
  // close only when this batch finished its messages, so a batch sent again can't
  // expire a card a newer process has raised since.
  if (batch.ended && await endMessages(client, sessionId, batch.ended)) await closeTurnAsks(client, sessionId)
  if (session.conversation_id && (turnsEnded.length || batch.status === 'failed')) {
    const conversationId = session.conversation_id
    const room = await maybe(client, `select 1 from conversations where id = $1 and kind = 'room'`, [conversationId])
    if (turnsEnded.length) {
      const reply = await postAgentReply(client, session, conversationId)
      if (room) await finishTurn(client, conversationId, session.agent_id, reply === null || reply.trim() === PASS ? 'pass' : 'sent')
    } else if (room) {
      // A failed session gives up its turn at once, rather than the room waiting out the deadline.
      await finishTurn(client, conversationId, session.agent_id, 'error')
    }
  }
  if (turnsEnded.length && !session.conversation_id) await reportToConversation(client, session.id)
  // Asks are opened after the session row is settled, since a standing rule may
  // answer one at once and add to this session again.
  for (const event of fresh.filter((e) => e.kind === 'ask')) await openAsk(client, session, event)
  return seqs
}

export type AskBody = { requestId: string; toolName?: string; input?: Record<string, unknown>; description?: string }

// What a standing rule matches against: the command for Bash, the path for file tools.
function askSubject(toolName: string | undefined, input: Record<string, unknown> | undefined): string {
  const value = toolName === 'Bash' ? input?.command : input?.file_path ?? input?.path
  return typeof value === 'string' ? value : ''
}

// An "always" or "never" for Bash covers commands that start with the same word.
// For other tools it covers the tool.
function rulePattern(toolName: string | undefined, input: Record<string, unknown> | undefined): string | null {
  if (toolName !== 'Bash') return null
  const first = askSubject(toolName, input).trim().split(/\s+/)[0]
  return first ? `${first} ` : null
}

// An agent asked before running a gated tool. A standing rule answers at once;
// otherwise the ask waits for a person.
async function openAsk(client: pg.PoolClient, session: Session, event: NewEvent) {
  const body = event.body as AskBody
  if (await takeOverEndedAsk(client, session, event.toolUseId ?? null, body)) return
  const ask = await one<{ id: string }>(client, 'the new ask',
    `insert into asks (team_id, kind, session_id, conversation_id, tool_use_id, payload)
     values ($1, 'tool_approval', $2, $3, $4, $5) returning id`,
    [session.team_id, session.id, session.conversation_id, event.toolUseId ?? null, JSON.stringify(scrub(body))])
  // A replay of a coach change never waits on a person, so any tool it asks for is denied.
  if (await maybe(client, 'select 1 from session_replays where session_id = $1', [session.id])) {
    await answerAsk(client, ask.id, null, 'deny', 'A replay never waits on a person.')
    return
  }
  // Each new agent waits for its maker's owner, and no standing rule answers for
  // them. The ask carries the question and the choices the app shows them. A maker
  // with no owner has nobody to ask, and one with no machine has nowhere to put an
  // agent, so either is told no at once.
  if (body.toolName === CREATE_AGENT_TOOL && session.folder_id === null) {
    const maker = await one<{ name: string; owner_id: string | null; login: string | null; machine: string | null }>(client, 'the asking agent',
      `select a.name, a.owner_id, p.login, i.name as machine from agents a left join people p on p.id = a.owner_id
       left join instances i on i.id = a.home_instance_id where a.id = $1`, [session.agent_id])
    if (maker.owner_id === null || maker.login === null) {
      await answerAsk(client, ask.id, null, 'deny', 'This agent has no owner to say yes to a new agent.')
    } else if (maker.machine === null) {
      await answerAsk(client, ask.id, null, 'deny', 'This agent has no machine to put a new agent on.')
    } else {
      const asked = newAgentQuestion(maker.name, body.input, { id: PersonId.parse(maker.owner_id), login: maker.login }, maker.machine)
      await client.query('update asks set payload = payload || $2 where id = $1', [ask.id, JSON.stringify(asked)])
    }
    return
  }
  const rule = await maybe<{ decision: 'allow' | 'deny' }>(client,
    `select decision from approval_rules
     where team_id = $1 and tool_name = $2 and (instance_id is null or instance_id = $3)
       and (agent_id is null or agent_id = $4) and (pattern is null or left($5, length(pattern)) = pattern)
     order by length(coalesce(pattern, '')) desc limit 1`,
    [session.team_id, body.toolName ?? '', session.instance_id, session.agent_id, askSubject(body.toolName, body.input)])
  if (rule) await answerAsk(client, ask.id, null, rule.decision, 'answered by a standing rule')
}

export type Decision = 'allow' | 'deny' | 'always' | 'never'

const behaviorOf = (decision: Decision): AnswerPayload['behavior'] => (decision === 'allow' || decision === 'always' ? 'allow' : 'deny')

// An ask and where its session runs.
export type AskTarget = { id: string; session_id: string; team_id: string; instance_id: string; payload: AskBody }

// Records a decision as an answer event in the ask's session. Given the harness
// request it answers, it also sends the decision to the session's machine; with
// none, the request ended with its machine and the decision waits on the ask.
export async function recordAnswer(client: pg.PoolClient, ask: AskTarget, answer: {
  decision: Decision; message: string | null; authorId: string | null; clientId: string; requestId: string | null
}) {
  const { decision, message, authorId, clientId, requestId } = answer
  const [seq] = await appendEvents(client, ask.session_id, {
    events: [{
      clientId, kind: 'answer', text: `${decision} ${ask.payload.toolName ?? ''}`.trim(),
      body: { askId: ask.id, requestId: requestId ?? ask.payload.requestId, decision, message, delivered: requestId !== null },
    }],
    status: requestId === null ? undefined : 'running',
  }, authorId)
  if (requestId === null) return
  const event = await one<{ id: string }>(client, 'the answer event',
    'select id from events where session_id = $1 and seq = $2', [ask.session_id, seq])
  const payload: AnswerPayload = { requestId, behavior: behaviorOf(decision), updatedInput: ask.payload.input, message: message ?? undefined }
  await client.query(
    `insert into commands (team_id, instance_id, session_id, kind, payload, event_id) values ($1, $2, $3, 'answer', $4, $5)`,
    [ask.team_id, ask.instance_id, ask.session_id, JSON.stringify(payload), event.id])
}

// An agent asking to make an agent waits for its own owner, who says yes or no to
// each one, so no standing rule ever answers for them. Nobody but a person says
// yes. The API makes the agent only with that yes behind it.
async function checkNewAgentAnswer(client: pg.PoolClient, agentId: string, person: Person | null, decision: Decision) {
  if (decision !== 'allow' && decision !== 'deny') throw new HttpError(400, 'A new agent is approved or denied one at a time, so Always and Never are not offered.')
  if (person === null && decision === 'deny') return
  const maker = await one<{ owner_id: string | null; login: string | null }>(client, 'the asking agent',
    'select a.owner_id, p.login from agents a left join people p on p.id = a.owner_id where a.id = $1', [agentId])
  if (person?.id !== maker.owner_id) {
    throw new HttpError(403, `Only ${maker.login ?? "the agent's owner"} can say yes or no to a new agent this one asks for.`)
  }
}

// Records a person's answer (or a standing rule's), makes "always" and "never"
// into rules, and sends the answer to the machine running the session.
export async function answerAsk(
  client: pg.PoolClient, askId: string, person: Person | null, decision: Decision, message?: string,
) {
  // The session's lock comes before the ask's, the order a machine's recovery and
  // a harness's batches take them in, so neither can wait on the other forever.
  const owner = await maybe<{ session_id: string }>(client, 'select session_id from asks where id = $1', [askId])
  if (owner) await client.query('select 1 from sessions where id = $1 for update', [owner.session_id])
  const ask = await maybe<AskTarget & { status: string; agent_id: string; request_ended_at: string | null }>(client,
    `select a.id, a.status, a.session_id, a.payload, a.request_ended_at, s.instance_id, s.agent_id, s.team_id
     from asks a join sessions s on s.id = a.session_id where a.id = $1 for update of a`, [askId])
  if (!ask) throw new HttpError(404, 'no such ask')
  if (ask.status === 'answered') throw new HttpError(409, 'this ask is already answered')
  if (ask.status !== 'open') throw new HttpError(409, 'this ask is no longer open, since the turn that raised it ended')
  if (ask.payload.toolName === CREATE_AGENT_TOOL) await checkNewAgentAnswer(client, ask.agent_id, person, decision)
  await client.query(
    `update asks set status = 'answered', answer = $2, answered_by = $3, answered_at = now() where id = $1`,
    [askId, JSON.stringify({ decision, message: message ?? null }), person?.id ?? null])
  if (decision === 'always' || decision === 'never') {
    await client.query(
      `insert into approval_rules (team_id, instance_id, agent_id, tool_name, pattern, decision, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [ask.team_id, ask.instance_id, ask.agent_id, ask.payload.toolName ?? '',
        rulePattern(ask.payload.toolName, ask.payload.input), behaviorOf(decision), person?.id ?? null])
  }
  await recordAnswer(client, ask, {
    decision, message: message ?? null, authorId: person?.id ?? null, clientId: `answer:${askId}`,
    requestId: ask.request_ended_at ? null : ask.payload.requestId,
  })
}

// Asks the session's machine to stop the current turn, and cancels any turn of the
// session that is still waiting for its machine. A room goes on to its next turn.
export async function interruptSession(client: pg.PoolClient, sessionId: string) {
  const session = await maybe<{ conversation_id: string | null; folder_id: string | null }>(client,
    'select conversation_id, folder_id from sessions where id = $1', [sessionId])
  if (!session) throw new HttpError(404, 'no such session')
  // The daemon reads a terminal session. It doesn't run it, so it can't stop it.
  if (session.folder_id !== null) throw new HttpError(409, 'A terminal session is stopped from its terminal, not from the app.')
  await signalSession(client, SessionId.parse(sessionId), 'interrupt')
  if (session.conversation_id && await maybe(client, `select 1 from conversations where id = $1 and kind = 'room'`, [session.conversation_id])) {
    await nextTurn(client, session.conversation_id)
  }
}

// Tells a person their message was not sent, when the turn that carried it can
// never be placed. The session fails with the reason, as it does when its machine
// cannot hand it a message, and a room's line moves on to the next agent.
export async function reportUnplaceableTurn(client: pg.PoolClient, turn: { turnId: string; sessionId: string; reason: string }) {
  await appendEvents(client, turn.sessionId, {
    events: [{ clientId: `turn:${turn.turnId}:unplaceable`, kind: 'error', text: turn.reason, body: { turnId: turn.turnId, reason: turn.reason } }],
    status: 'failed',
  })
}

// In a terminal session only what the person writes carries their author, so its
// batch names them on their prompts and on nothing Claude wrote. Any other
// session takes the author its caller gives, such as the person a screen notice
// says took over, or the agent whose message a user event carries.
async function insertEvent(client: pg.PoolClient, session: Session, seq: number, event: NewEvent, author: EventAuthor) {
  const text = event.text === undefined ? null : scrub(event.text).slice(0, TEXT_LIMIT)
  const authored = session.folder_id === null || PERSON_KINDS.includes(event.kind)
  const person = authored && typeof author === 'string' ? author : null
  const agent = author !== null && typeof author === 'object' ? author.agent : null
  await client.query(
    `insert into events (team_id, session_id, seq, updated_seq, kind, author, author_agent, parent_tool_use_id,
       tool_use_id, tool_name, text, body, client_id)
     values ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [session.team_id, session.id, seq, event.kind, person, agent, event.parentToolUseId ?? null,
      event.toolUseId ?? null, event.toolName ?? null, text, JSON.stringify(scrub(event.body)), event.clientId])
}

type NewMessage = {
  speaker: 'person' | 'agent'
  personId?: string
  agentId?: string
  body: string
  clientId: string
  sessionId?: string
  eventId?: string
  // The post this one answers, in the same conversation.
  quotedMessageId?: string
  // A post, unless it carries an agent's result back or says a chain stopped.
  kind?: 'post' | 'answer' | 'chain_stopped'
  askedAgentId?: string
}

export async function appendMessage(
  client: pg.PoolClient, conversationId: string, message: NewMessage,
): Promise<{ id: string; seq: number; fresh: boolean }> {
  const conversation = await maybe<{ team_id: string; last_seq: string }>(client,
    'select team_id, last_seq from conversations where id = $1 for update', [conversationId])
  if (!conversation) throw new HttpError(404, 'no such conversation')
  const existing = await maybe<{ id: string; seq: string }>(client,
    'select id, seq from messages where conversation_id = $1 and client_id = $2', [conversationId, message.clientId])
  if (existing) return { id: existing.id, seq: Number(existing.seq), fresh: false }

  const seq = Number(conversation.last_seq) + 1
  const row = await one<{ id: string }>(client, 'the new message',
    `insert into messages (team_id, conversation_id, seq, speaker, person_id, agent_id, body, session_id, event_id, client_id, quoted_message_id, kind, asked_agent_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
    [conversation.team_id, conversationId, seq, message.speaker, message.personId ?? null, message.agentId ?? null,
      scrub(message.body), message.sessionId ?? null, message.eventId ?? null, message.clientId, message.quotedMessageId ?? null,
      message.kind ?? 'post', message.askedAgentId ?? null])
  await client.query('update conversations set last_seq = $2 where id = $1', [conversationId, seq])
  return { id: row.id, seq, fresh: true }
}

// When an agent's turn ends in a conversation, its last words in that turn
// become its post there, unless it passed its turn in a room. Subagents' words
// stay in the record only. Returns the words, or null when there were none.
async function postAgentReply(client: pg.PoolClient, session: AgentSession, conversationId: string): Promise<string | null> {
  const reply = await maybe<{ id: string; text: string }>(client,
    `select id, body->>'text' as text from events
     where session_id = $1 and kind = 'assistant' and parent_tool_use_id is null
       and coalesce(body->>'text', '') <> ''
       and seq > coalesce((select max(seq) from events where session_id = $1 and kind = 'user'), 0)
     order by seq desc limit 1`, [session.id])
  if (!reply) return null
  if (reply.text.trim() === PASS) return reply.text
  await appendMessage(client, conversationId, {
    speaker: 'agent', agentId: session.agent_id, body: reply.text,
    clientId: `event:${reply.id}`, sessionId: session.id, eventId: reply.id,
  })
  return reply.text
}

// What an agent brings to every session: its skills, its plugins and what it
// remembers about the people involved and the team.
export async function agentKit(client: pg.PoolClient | pg.Pool, agentId: string, personIds: string[]): Promise<Pick<MessagePayload, 'skills' | 'plugins' | 'memory'>> {
  const { rows: plugins } = await client.query<AgentPlugin>('select name, kind, config from plugins where agent_id = $1 order by name', [agentId])
  const memory = await memoryBlock(client, agentId, personIds)
  return { skills: await skillsOf(client, agentId), plugins, memory: memory || undefined }
}

// An agent's skills: its own and the team's.
export async function skillsOf(client: pg.PoolClient | pg.Pool, agentId: string): Promise<AgentSkill[]> {
  const { rows } = await client.query<AgentSkill>(
    `select s.name, s.description, s.content from skills s join agents a on a.team_id = s.team_id
     where a.id = $1 and (s.agent_id = a.id or s.agent_id is null) order by s.name`, [agentId])
  return rows
}

// Finds the person's DM with an agent, or opens one.
export async function openDm(client: pg.PoolClient, person: Person, agentName: string): Promise<string> {
  const agent = await maybe<{ id: string }>(client,
    'select id from agents where team_id = $1 and name = $2 and archived_at is null for update',
    [person.team_id, agentName])
  if (!agent) throw new HttpError(404, `no agent named ${agentName}`)
  const existing = await maybe<{ id: string }>(client,
    `select c.id from conversations c
     join conversation_members m on m.conversation_id = c.id and m.person_id = $1
     where c.kind = 'dm' and c.agent_id = $2 and c.archived_at is null limit 1`, [person.id, agent.id])
  if (existing) return existing.id
  const created = await one<{ id: string }>(client, 'the new conversation',
    `insert into conversations (team_id, kind, agent_id) values ($1, 'dm', $2) returning id`,
    [person.team_id, agent.id])
  await client.query(
    `insert into conversation_members (team_id, conversation_id, person_id, agent_id)
     values ($1, $2, $3, null), ($1, $2, null, $4)`, [person.team_id, created.id, person.id, agent.id])
  return created.id
}

type PostableConversation = { id: string; kind: string; agent_id: string | null; member: boolean; visibility: string; source: string | null }

// A conversation the person may post in, or the refusal. They post in the ones they are a member of,
// and in a team room they can see, which posting makes them a member of.
export async function postableConversation(client: Db, person: Person, conversationId: string): Promise<PostableConversation> {
  const conversation = await maybe<PostableConversation>(client,
    `select c.id, c.kind, c.agent_id, c.visibility, c.source,
       exists (select 1 from conversation_members m where m.conversation_id = c.id and m.person_id = $2) as member
     from conversations c where c.id = $1 and c.team_id = $3 and c.archived_at is null`, [conversationId, person.id, person.team_id])
  if (!conversation || (!conversation.member && !(conversation.kind === 'room' && conversation.visibility === 'team'))) {
    throw new HttpError(404, 'no such conversation of yours')
  }
  if (conversation.kind !== 'main' && conversation.kind !== 'dm' && conversation.kind !== 'room') {
    throw new HttpError(400, `${conversation.kind} conversations take no posts`)
  }
  if (conversation.source === 'pipeline') throw new HttpError(400, "a pipeline's room is for its runs' posts")
  return conversation
}

// What the agent reads of the post this one answers.
async function replyContext(client: pg.PoolClient, conversationId: string, replyToMessageId: string): Promise<string> {
  const quoted = await maybe<{ who: string; body: string | null }>(client,
    `select coalesce(p.login, a.name, 'someone') as who, m.body from messages m
     left join people p on p.id = m.person_id left join agents a on a.id = m.agent_id
     where m.id = $1 and m.conversation_id = $2`, [replyToMessageId, conversationId])
  if (!quoted || quoted.body === null) throw new HttpError(400, 'replyToMessageId: that post is not in this chat, or was deleted')
  return `(In reply to ${quoted.who}: "${quoted.body.slice(0, 200)}")`
}

// A person's post, with its text, the files it carries and the post it answers. In a main or DM
// conversation its agent answers: the post goes into that agent's session for the conversation, and
// asks the scheduler for the agent's turn.
export async function sendPersonMessage(
  client: pg.PoolClient, person: Person, conversationId: string, text: string, clientId: string,
  extras: { attachmentIds?: readonly string[]; replyToMessageId?: string } = {},
): Promise<{ messageId: string; seq: number }> {
  const conversation = await postableConversation(client, person, conversationId)
  // Posting in a team room you can see makes you a member of it.
  if (!conversation.member) {
    await client.query('insert into conversation_members (team_id, conversation_id, person_id) values ($1, $2, $3) on conflict do nothing',
      [person.team_id, conversationId, person.id])
  }

  const message = await appendMessage(client, conversationId, {
    speaker: 'person', personId: person.id, body: text, clientId: `person:${clientId}`, quotedMessageId: extras.replyToMessageId,
  })
  if (!message.fresh) return { messageId: message.id, seq: message.seq }
  const files = extras.attachmentIds?.length ? await pendingUploads(client, person, extras.attachmentIds, { conversationId }) : []
  if (files.length) await placeUploads(client, files.map((f) => f.id), { conversationId, messageId: message.id })
  const reply = extras.replyToMessageId ? await replyContext(client, conversationId, extras.replyToMessageId) : ''
  // What the agent reads is the words, the post they answer, and the files.
  const prompt = withFiles([reply, text].filter(Boolean).join(' '), files)
  if (conversation.kind === 'room') {
    await queueTurns(client, person, conversationId, text)
    return { messageId: message.id, seq: message.seq }
  }

  const agent = await one<Agent>(client, 'the agent of the conversation',
    'select id, home_instance_id, harness, model, instructions from agents where id = $1', [conversation.agent_id])
  if (!agent.home_instance_id) throw new HttpError(409, 'this agent has no home machine')
  const session = await conversationSession(client, person.team_id, person.id, conversationId, agent)
  const [seq] = await appendEvents(client, session.id, {
    events: [{ clientId: `message:${message.id}`, kind: 'user', body: { text: prompt, messageId: message.id }, text: prompt }],
  }, person.id)
  if (seq === undefined) throw new Error(`the post ${message.id} did not reach its session`)

  // Reactions to the agent's earlier posts reach it with this turn, and not in the record of the person's post.
  const reactions = await reactionsNote(client, agent.id, { conversationId })
  const payload: MessagePayload = {
    permissions: CONVERSATION_PERMISSIONS, text: scrub([reactions, prompt].filter(Boolean).join('\n\n')), agentId: agent.id, harness: agent.harness, model: agent.model,
    instructions: agent.instructions, harnessSessionId: session.harness_session_id, ...(await agentKit(client, agent.id, [person.id])),
  }
  await requestTurn(client, {
    source: 'person', teamId: person.team_id, agentId: AgentId.parse(agent.id), askedBy: person.id, conversationId: ConversationId.parse(conversationId),
  }, { sessionId: SessionId.parse(session.id), seq, payload })
  return { messageId: message.id, seq: message.seq }
}

type ConversationSession = { id: string; instance_id: string; harness_session_id: string | null }

// The agent's open session for this conversation, or a new one on its home machine.
export async function conversationSession(
  client: pg.PoolClient, teamId: string, startedBy: string | null, conversationId: string, agent: Pick<Agent, 'id' | 'home_instance_id' | 'harness' | 'model'>,
): Promise<ConversationSession> {
  const found = await maybe<ConversationSession>(client,
    `select id, instance_id, harness_session_id from sessions
     where conversation_id = $1 and agent_id = $2 and archived_at is null
     order by created_at desc limit 1`, [conversationId, agent.id])
  if (found) return found
  const created = await one<ConversationSession>(client, 'the new session',
    `insert into sessions (team_id, conversation_id, instance_id, agent_id, started_by, harness, model)
     values ($1, $2, $3, $4, $5, $6, $7) returning id, instance_id, harness_session_id`,
    [teamId, conversationId, agent.home_instance_id, agent.id, startedBy, agent.harness, agent.model])
  return created
}

// Claims one queued command for its machine. Only one claim can win. A message
// is handed over through moveMessages, like every other change to its status.
export async function claimCommand(client: pg.Pool | pg.PoolClient, instanceId: string, commandId: string): Promise<Command | null> {
  const found = await maybe<{ kind: Command['kind'] }>(client, 'select kind from commands where id = $1 and instance_id = $2', [commandId, instanceId])
  if (!found) return null
  const row = found.kind === 'message'
    ? (await moveMessages(client, [commandId], 'handed_over', { instanceId }).catch((error: unknown) => {
        if (error instanceof MessageMoveRefused) return []
        throw error
      }))[0]
    : await maybe<{ id: string; kind: Command['kind']; session_id: string; payload: never }>(client,
      `update commands set status = 'claimed', claimed_at = now()
       where id = $1 and instance_id = $2 and status = 'queued' and kind <> 'message'
       returning id, kind, session_id, payload`, [commandId, instanceId])
  return row ? ({ id: row.id, kind: row.kind, sessionId: row.session_id, payload: row.payload } as Command) : null
}

// An image document's bytes, kept once per team and content. Its id goes on the
// version. The bytes must be the image type the machine says they are.
async function saveImage(client: pg.PoolClient, teamId: string, path: string, image: { mediaType: ImageMediaType; base64: string }): Promise<BlobId> {
  const bytes = Buffer.from(image.base64, 'base64')
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, `${path} is ${bytes.length} bytes, and an image can be ${MAX_IMAGE_BYTES} at most`)
  if (sniffImage(bytes) !== image.mediaType) throw new HttpError(400, `${path} is not the ${image.mediaType} it says it is`)
  // A no-op update on a conflict, so the existing row's id comes back too.
  const row = await one(client, 'the image',
    `insert into blobs (team_id, sha256, media_type, size_bytes, data) values ($1, $2, $3, $4, $5)
     on conflict (team_id, sha256) do update set sha256 = excluded.sha256 returning id`,
    [teamId, createHash('sha256').update(bytes).digest('hex'), image.mediaType, bytes.length, bytes])
  return BlobRow.pick({ id: true }).parse(row).id
}

// Files an agent wrote in its task's folder. Each file is one document on the
// task, and each change to it is the document's next version. A version holds
// text, or points at an image's bytes and holds no text.
export async function saveDocuments(
  client: pg.PoolClient, instanceId: string, sessionId: string, documents: DocumentUpload[],
): Promise<{ path: string; version: number }[]> {
  const session = await maybe<{ team_id: string; task_id: string | null }>(client,
    'select team_id, task_id from sessions where id = $1 and instance_id = $2', [sessionId, instanceId])
  if (!session) throw new HttpError(404, 'no such session on this instance')
  if (!session.task_id) throw new HttpError(400, 'only a task session has a task folder')
  const saved: { path: string; version: number }[] = []
  for (const document of documents) {
    const path = document.path.replace(/^\/+/, '')
    const artifact = await one<{ id: string; current_version: number | null }>(client, 'the document',
      `insert into artifacts (team_id, task_id, kind, path, title, made_by_session) values ($1, $2, 'document', $3, $4, $5)
       on conflict (task_id, path) where kind = 'document' do update set updated_at = artifacts.updated_at
       returning id, current_version`, [session.team_id, session.task_id, path, basename(path), sessionId])
    const next = 'content' in document
      ? { content: scrub(document.content), blobId: null }
      : { content: '', blobId: await saveImage(client, session.team_id, path, document.image) }
    const latest = await maybe<{ content: string; blob_id: string | null }>(client,
      'select content, blob_id from artifact_versions where artifact_id = $1 and version = $2', [artifact.id, artifact.current_version])
    if (latest?.content === next.content && latest.blob_id === next.blobId) continue
    const version = (artifact.current_version ?? 0) + 1
    await client.query(
      'insert into artifact_versions (artifact_id, version, content, blob_id, author_session) values ($1, $2, $3, $4, $5)',
      [artifact.id, version, next.content, next.blobId, sessionId])
    await client.query('update artifacts set current_version = $2, updated_at = now() where id = $1', [artifact.id, version])
    saved.push({ path, version })
  }
  return saved
}
