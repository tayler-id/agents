// What keeps a turn alive through its machine dying: the server finishes each
// message when the turn that answers it ends. docs/design/durability.md has the
// whole design.

import type pg from 'pg'
import { many } from './db.ts'
import { messageState, moveMessage, type CommandStatus } from '../shared/lifecycle.ts'
import type { EventBatch, SessionStatus } from '../shared/types.ts'
import { scrub } from './record.ts'

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
