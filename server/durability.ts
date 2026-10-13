// What keeps a turn alive through its machine dying. The server finishes each
// message when the turn that answers it ends, a machine that restarts gets back
// every session it cut off with the text that resumes it, and an approval
// outlives the harness request that raised it. docs/design/durability.md has the
// whole design.

import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { many } from './db.ts'
import {
  MACHINE_LOST_AFTER_MIN_SEC, MACHINE_LOST_AFTER_SEC, messageState, moveMessage, WORKING, type CommandStatus,
} from '../shared/lifecycle.ts'
import type { EventBatch, MessagePayload, Recovery, ResumeTurn, SessionStatus } from '../shared/types.ts'
import { appendEvents, recordAnswer, scrub, type AskBody, type AskTarget, type Decision } from './record.ts'

// Finishes the messages a batch names: done when the batch ends the turn that
// took them in, failed when their harness exited first. A retried batch finds
// them finished already and changes nothing.
export async function endMessages(client: pg.PoolClient, sessionId: string, batch: EventBatch) {
  const ended = batch.ended ?? []
  if (!ended.length) return
  const turnEnded = batch.events.some((event) => event.kind === 'usage')
  const to = turnEnded ? 'done' : 'failed'
  const rows = await many<{ id: string; command: CommandStatus; session: SessionStatus }>(client,
    `select c.id, c.status as command, s.status as session from commands c join sessions s on s.id = c.session_id
     where c.id = any($1) and c.session_id = $2 and c.kind = 'message' for update of c`, [ended, sessionId])
  const unknown = ended.filter((id) => !rows.some((row) => row.id === id))
  if (unknown.length) console.error(`a batch for session ${sessionId} finished messages it does not have: ${unknown.join(', ')}`)
  const open = rows.filter((row) => row.command === 'claimed')
  for (const row of open) moveMessage(messageState(row.command, row.session), to)
  if (!open.length) return
  const reason = turnEnded ? null : scrub(batch.events.find((event) => event.kind === 'error')?.text ?? 'Its harness exited without saying why.')
  await client.query(`update commands set status = $2, error = $3, done_at = now() where id = any($1)`,
    [open.map((row) => row.id), to, reason])
}

// When a turn ends, an ask still open has no request waiting on it, so it
// expires. A decision kept for a resumed session that never asked again is let
// go, so a later turn can't pick it up.
export async function closeTurnAsks(client: pg.PoolClient, sessionId: string) {
  await client.query(`update asks set status = 'expired' where session_id = $1 and status = 'open'`, [sessionId])
  await client.query(`update asks set request_ended_at = null where session_id = $1 and status = 'answered' and request_ended_at is not null`, [sessionId])
}

// Keys in a stable order, so two inputs compare equal however they were stored.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, inner]) => [key, canonical(inner)]))
}

// Two requests ask for the same thing when their inputs match, apart from the
// description Claude writes for a person, which it words afresh each time.
function sameInput(a: unknown, b: unknown): boolean {
  const plain = (input: unknown): unknown => (typeof input === 'object' && input !== null && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'description'))
    : input)
  return JSON.stringify(canonical(plain(a))) === JSON.stringify(canonical(plain(b)))
}

type Answer = { decision: Decision; message: string | null }

// A resumed session asked again for a tool whose ask ended with its machine. The
// same ask takes the new request, so no second card opens, and a decision a
// person already made reaches the session at once. False when nothing matches.
export async function takeOverEndedAsk(
  client: pg.PoolClient, session: { id: string; team_id: string; instance_id: string }, toolUseId: string | null, body: AskBody,
): Promise<boolean> {
  const ended = await many<AskTarget & { status: string; answer: Answer | null; answered_by: string | null }>(client,
    `select a.id, a.session_id, a.payload, a.status, a.answer, a.answered_by, s.team_id, s.instance_id
     from asks a join sessions s on s.id = a.session_id
     where a.session_id = $1 and a.request_ended_at is not null and a.status in ('open', 'answered')
     order by a.created_at for update of a`, [session.id])
  const input = scrub(body.input)
  const match = ended.find((ask) => ask.payload.toolName === body.toolName && sameInput(ask.payload.input, input))
  if (!match) return false
  await client.query(
    `update asks set payload = payload || jsonb_build_object('requestId', $2::text), tool_use_id = $3, request_ended_at = null where id = $1`,
    [match.id, body.requestId, toolUseId])
  if (match.status === 'answered' && match.answer) {
    await recordAnswer(client, { ...match, payload: { ...match.payload, requestId: body.requestId } }, {
      decision: match.answer.decision, message: match.answer.message, authorId: match.answered_by,
      clientId: `answer:${match.id}:${body.requestId}`, requestId: body.requestId,
    })
  }
  return true
}

// How long a machine may be silent before its working sessions show as lost.
// AGENTS_MACHINE_LOST_SEC sets it, never under two heartbeats, and a bad value
// stops the API when it starts.
function lostAfterSec(raw: string | undefined): number {
  if (raw === undefined) return MACHINE_LOST_AFTER_SEC
  const parsed = z.coerce.number().int().min(MACHINE_LOST_AFTER_MIN_SEC).safeParse(raw)
  if (!parsed.success) throw new Error(`AGENTS_MACHINE_LOST_SEC must be a whole number of seconds, at least ${MACHINE_LOST_AFTER_MIN_SEC}`)
  return parsed.data
}
const LOST_AFTER_SEC = lostAfterSec(process.env.AGENTS_MACHINE_LOST_SEC)
// The API may itself have been down, so every machine gets the same span to call
// in after it starts before its silence counts.
const WATCHING_FROM = Date.now() + LOST_AFTER_SEC * 1000
const STOPPED_ANSWERING = 'The machine running this session stopped answering.'

// Marks a machine that has stopped answering stale, and each working session on
// it lost, when the session has been quiet as long too. The second condition
// keeps a box that is still starting from losing the session it is about to run.
export async function markLostMachines(client: pg.PoolClient, teamIds: string[] | null) {
  if (Date.now() < WATCHING_FROM) return
  await client.query(
    `update instances set status = 'stale' where status = 'online' and last_seen_at < now() - make_interval(secs => $1)
       and ($2::uuid[] is null or team_id = any($2))`, [LOST_AFTER_SEC, teamIds])
  const sessions = await many<{ id: string; status: SessionStatus; claimed: boolean }>(client,
    `select s.id, s.status,
       exists (select 1 from commands c where c.session_id = s.id and c.kind = 'message' and c.status = 'claimed') as claimed
     from sessions s join instances i on i.id = s.instance_id
     where s.status = any($1) and ($3::uuid[] is null or s.team_id = any($3))
       and (i.last_seen_at is null or i.last_seen_at < now() - make_interval(secs => $2))
       and coalesce(s.last_active_at, s.created_at) < now() - make_interval(secs => $2)
     order by s.id for update of s skip locked`, [WORKING, LOST_AFTER_SEC, teamIds])
  for (const session of sessions) {
    if (session.claimed) moveMessage(messageState('claimed', session.status), 'interrupted')
    await appendEvents(client, session.id, {
      events: [{ clientId: `interrupted:${randomUUID()}`, kind: 'notice', text: STOPPED_ANSWERING, body: { subtype: 'interrupted', reason: STOPPED_ANSWERING } }],
      status: 'lost',
    })
  }
}

const RESTARTED = 'The machine restarted in the middle of this turn.'
const STOPPED_FIRST = 'The machine restarted in the middle of this turn, and a person had asked to stop it, so it was not resumed.'
const ANSWER_LOST = 'The machine restarted before this answer reached the request it was for. The decision is kept on the ask, and reaches the session when it asks again.'

// A tool call the record shows with no result. `text` is the call's readable
// part, such as the tool's name and its command.
type OpenCall = { toolUseId: string; text: string }
// An approval the resumed session has to ask for again, with the decision a
// person made, or null while it waits for one.
type AskAgain = { toolName: string; input: unknown; decision: Decision | null }
type Denied = { toolName: string; input: unknown; message: string | null }

const requestLine = (ask: { toolName: string; input: unknown }) => `- ${ask.toolName} with input ${JSON.stringify(ask.input)}.`

// What a resumed session is told: that it was cut off, which calls may or may
// not have run, which approvals to ask for again, what a person denied, and every
// message it had not finished answering.
export function continuation(messages: string[], open: { calls: OpenCall[]; askAgain: AskAgain[]; denied: Denied[] }): string {
  const parts = ['This session was resumed after its machine stopped in the middle of your turn. What you did before the stop is in this conversation, but the last part of it may be missing.']
  if (open.calls.length) {
    parts.push(`These tool calls were still running when the machine stopped. Their results were never recorded, so each may or may not have taken effect. Check before you run any of them again.\n${
      open.calls.map((call) => `- ${call.text} (call ${call.toolUseId})`).join('\n')}`)
  }
  if (open.askAgain.length) {
    parts.push(`These requests for approval ended when the machine stopped, before they ran. Call the tool again with exactly the same input, and the answer reaches you then.\n${
      open.askAgain.map((ask) => `${requestLine(ask)} ${ask.decision === null ? 'It is still waiting for a person.' : 'A person allowed it.'}`).join('\n')}`)
  }
  if (open.denied.length) {
    parts.push(`A person denied these while the machine was stopped. Do not run them.\n${
      open.denied.map((ask) => `${requestLine(ask)}${ask.message ? ` They said: ${ask.message}` : ''}`).join('\n')}`)
  }
  parts.push(messages.length === 1
    ? `Finish the turn. The message you were answering:\n\n${messages.join('')}`
    : `Finish the turn. The messages you were answering, in the order they were sent:\n\n${messages.join('\n\n---\n\n')}`)
  return parts.join('\n\n')
}

// Sorts what a session's cut-off turn left open, from the record since `from`,
// the user event of its first unfinished message. An approval whose decision may
// have reached the harness is not asked for again, since its call may have run.
async function openThreads(client: pg.PoolClient, sessionId: string, from: number) {
  const asks = await many<{
    id: string; status: 'open' | 'answered'; tool_use_id: string | null; payload: AskBody; answer: Answer | null
    request_ended_at: string | null; reached: boolean
  }>(client,
    `select a.id, a.status, a.tool_use_id, a.payload, a.answer, a.request_ended_at,
       exists (select 1 from commands c where c.session_id = a.session_id and c.kind = 'answer'
               and c.payload->>'requestId' = a.payload->>'requestId' and c.status in ('claimed', 'done')) as reached
     from asks a
     where a.session_id = $1 and a.kind = 'tool_approval' and a.status in ('open', 'answered')
       and not exists (select 1 from events r where r.session_id = a.session_id and r.kind = 'tool_result' and r.tool_use_id = a.tool_use_id)
     order by a.created_at for update of a`, [sessionId])
  const carried = asks.filter((ask) => ask.status === 'open' || ask.request_ended_at !== null
    || (!ask.reached && ask.answer !== null && ['allow', 'always'].includes(ask.answer.decision)))
  const denied = asks.filter((ask) => !carried.includes(ask) && ask.request_ended_at === null && !ask.reached && ask.answer !== null)
  await client.query(`update asks set request_ended_at = coalesce(request_ended_at, now()) where id = any($1)`, [carried.map((ask) => ask.id)])
  // A call's text is how a person reads it. The tool's name stands in, for display, when a harness wrote none.
  const calls = await many<OpenCall>(client,
    `select c.tool_use_id as "toolUseId", coalesce(c.text, c.tool_name) as text from events c
     where c.session_id = $1 and c.seq > $2 and c.kind = 'tool_call' and c.tool_use_id is not null
       and not exists (select 1 from events r where r.session_id = c.session_id and r.kind = 'tool_result' and r.tool_use_id = c.tool_use_id)
     order by c.seq`, [sessionId, from])
  const asked = new Set([...carried, ...denied].map((ask) => ask.tool_use_id))
  return {
    calls: calls.filter((call) => !asked.has(call.toolUseId)),
    askAgain: carried.map((ask): AskAgain => ({ toolName: ask.payload.toolName ?? 'a tool', input: ask.payload.input ?? {}, decision: ask.answer?.decision ?? null })),
    denied: denied.map((ask): Denied => ({ toolName: ask.payload.toolName ?? 'a tool', input: ask.payload.input ?? {}, message: ask.answer?.message ?? null })),
    askIds: [...carried, ...denied].map((ask) => ask.id),
  }
}

// Called by a machine that has just started. Each session it was answering
// messages in is interrupted: ended when a person asked to stop it meanwhile,
// and otherwise returned to be resumed, with every unfinished message and
// everything the turn left open. Answers on their way to its dead processes
// fail, keeping their decisions on the asks, and its other commands go back in
// the queue.
export async function recoverMachine(client: pg.PoolClient, instanceId: string): Promise<Recovery> {
  const sessions = await many<{ id: string; status: SessionStatus; harness_session_id: string | null }>(client,
    `select s.id, s.status, s.harness_session_id from sessions s
     where s.instance_id = $1
       and exists (select 1 from commands c where c.session_id = s.id and c.kind = 'message' and c.status = 'claimed')
     order by s.id for update of s`, [instanceId])
  const resumed: ResumeTurn[] = []
  let ended = 0
  for (const session of sessions) {
    const messages = await many<{ id: string; payload: MessagePayload; seq: string | null }>(client,
      `select c.id, c.payload, e.seq from commands c left join events e on e.id = c.event_id
       where c.session_id = $1 and c.kind = 'message' and c.status = 'claimed' order by c.created_at, c.id`, [session.id])
    const state = messageState('claimed', session.status)
    if (state !== 'interrupted') moveMessage(state, 'interrupted')
    const ids = messages.map((message) => message.id)
    // A person's interrupt, or a run's stop, sent after these messages and never carried out.
    const stops = await many<{ id: string }>(client,
      `select id from commands where session_id = $1 and kind in ('interrupt', 'stop') and status in ('queued', 'claimed')
         and created_at >= (select min(created_at) from commands where id = any($2))`, [session.id, ids])
    if (stops.length) {
      moveMessage('interrupted', 'done')
      await client.query(`update commands set status = 'done', done_at = now() where id = any($1)`, [[...ids, ...stops.map((stop) => stop.id)]])
      await appendEvents(client, session.id, {
        events: [{ clientId: `interrupted:${randomUUID()}`, kind: 'notice', text: STOPPED_FIRST, body: { subtype: 'interrupted', reason: STOPPED_FIRST, messages: ids } }],
        status: 'idle',
      })
      await closeTurnAsks(client, session.id)
      ended += ids.length
      continue
    }
    const seqs = messages.map((message) => message.seq)
    if (seqs.some((seq) => seq === null)) throw new Error(`a message in session ${session.id} has no user event in the record`)
    const open = await openThreads(client, session.id, Math.min(...seqs.map(Number)))
    const text = continuation(messages.map((message) => message.payload.text), open)
    await appendEvents(client, session.id, {
      events: [
        { clientId: `interrupted:${randomUUID()}`, kind: 'notice', text: RESTARTED,
          body: { subtype: 'interrupted', reason: RESTARTED, messages: ids, toolUseIds: open.calls.map((call) => call.toolUseId), askIds: open.askIds } },
        { clientId: `resume:${randomUUID()}`, kind: 'user', text, body: { text, resumes: ids } },
      ],
      status: 'lost',
    })
    const [first] = messages
    if (!first) throw new Error(`session ${session.id} has no claimed message`)
    resumed.push({
      command: { id: first.id, kind: 'message', sessionId: session.id, payload: { ...first.payload, text, harnessSessionId: session.harness_session_id } },
      covers: ids,
    })
  }
  await client.query(
    `update commands set status = 'failed', error = $2, done_at = now() where instance_id = $1 and kind = 'answer' and status in ('queued', 'claimed')`,
    [instanceId, ANSWER_LOST])
  const { rowCount } = await client.query(
    `update commands set status = 'queued', claimed_at = null where instance_id = $1 and status = 'claimed' and kind <> 'message'`, [instanceId])
  return { requeued: rowCount ?? 0, resumed, ended }
}
