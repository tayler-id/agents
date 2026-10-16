// How an agent reaches the record from inside one of its sessions.

import type { IncomingMessage } from 'node:http'
import { instanceFrom } from './auth.ts'
import { maybe, pool } from './db.ts'
import { HttpError } from './record.ts'

// The session must be running on the calling machine. That session decides what the agent may see.
export async function agentScope(req: IncomingMessage, url: URL) {
  const instance = await instanceFrom(req)
  const sessionId = url.searchParams.get('session') ?? ''
  const { rows } = /^[0-9a-f-]{36}$/.test(sessionId)
    ? await pool.query('select 1 from sessions where id = $1 and instance_id = $2', [sessionId, instance.id])
    : { rows: [] }
  if (!rows[0]) throw new HttpError(403, 'record reads need a session running on this machine')
  // A replay must do without the correction it is scored on, and the record holds it.
  if (await maybe(pool, 'select 1 from session_replays where session_id = $1', [sessionId])) {
    throw new HttpError(403, 'a replay reads nothing from the team record')
  }
  return { teamId: instance.team_id, sessionId }
}
