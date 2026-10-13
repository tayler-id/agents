// What keeps a turn alive through its machine dying. The server finishes each
// message when the turn that answers it ends, and a machine that restarts gets
// back every session it cut off, with the text that resumes it.
// docs/design/durability.md has the whole design.

import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { many } from './db.ts'
import { messageState, moveMessage, type CommandStatus } from '../shared/lifecycle.ts'
import type { EventBatch, MessagePayload, Recovery, ResumeTurn, SessionStatus } from '../shared/types.ts'
import { appendEvents, scrub } from './record.ts'

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

const RESTARTED = 'The machine restarted in the middle of this turn.'
const STOPPED_FIRST = 'The machine restarted in the middle of this turn, and a person had asked to stop it, so it was not resumed.'

// A tool call the record shows with no result. `text` is the call's readable
// part, such as the tool's name and its command.
type OpenCall = { toolUseId: string; text: string }

// What a resumed session is told: that it was cut off, which calls may or may
// not have run, and every message it had not finished answering.
export function continuation(messages: string[], calls: OpenCall[]): string {
  const parts = ['This session was resumed after its machine stopped in the middle of your turn. What you did before the stop is in this conversation, but the last part of it may be missing.']
  if (calls.length) {
    parts.push(`These tool calls were still running when the machine stopped. Their results were never recorded, so each may or may not have taken effect. Check before you run any of them again.\n${
      calls.map((call) => `- ${call.text} (call ${call.toolUseId})`).join('\n')}`)
  }
  parts.push(messages.length === 1
    ? `Finish the turn. The message you were answering:\n\n${messages.join('')}`
    : `Finish the turn. The messages you were answering, in the order they were sent:\n\n${messages.join('\n\n---\n\n')}`)
  return parts.join('\n\n')
}

// Called by a machine that has just started. Commands it held that are not
// messages go back in the queue. Each session it was answering messages in is
// interrupted: ended when a person asked to stop it meanwhile, and otherwise
// returned to be resumed, with every unfinished message and every tool call
// left without a result.
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
      ended += ids.length
      continue
    }
    const seqs = messages.map((message) => message.seq)
    if (seqs.some((seq) => seq === null)) throw new Error(`a message in session ${session.id} has no user event in the record`)
    const from = Math.min(...seqs.map(Number))
    // A call's text is how a person reads it. The tool's name stands in, for display, when a harness wrote none.
    const calls = await many<OpenCall>(client,
      `select c.tool_use_id as "toolUseId", coalesce(c.text, c.tool_name) as text from events c
       where c.session_id = $1 and c.seq > $2 and c.kind = 'tool_call' and c.tool_use_id is not null
         and not exists (select 1 from events r where r.session_id = c.session_id and r.kind = 'tool_result' and r.tool_use_id = c.tool_use_id)
       order by c.seq`, [session.id, from])
    const text = continuation(messages.map((message) => message.payload.text), calls)
    await appendEvents(client, session.id, {
      events: [
        { clientId: `interrupted:${randomUUID()}`, kind: 'notice', text: RESTARTED,
          body: { subtype: 'interrupted', reason: RESTARTED, messages: ids, toolUseIds: calls.map((call) => call.toolUseId) } },
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
  const { rowCount } = await client.query(
    `update commands set status = 'queued', claimed_at = null where instance_id = $1 and status = 'claimed' and kind <> 'message'`, [instanceId])
  return { requeued: rowCount ?? 0, resumed, ended }
}
