// Who is calling. A person is known by the Tailscale login that tailscale serve
// sets. A machine is known by its instance token.

import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { pool } from './db.ts'
import { HttpError, type Person } from './record.ts'

export type Instance = { id: string; team_id: string }

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export async function instanceFrom(req: IncomingMessage): Promise<Instance> {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
  if (!token) throw new HttpError(401, 'missing instance token')
  const { rows } = await pool.query<Instance>(
    'select id, team_id from instances where token_sha256 = $1', [sha256(token)])
  if (!rows[0]) throw new HttpError(401, 'unknown instance token')
  return rows[0]
}

export async function personFrom(req: IncomingMessage): Promise<Person> {
  const login = req.headers['tailscale-user-login']
  if (typeof login !== 'string' || !login) throw new HttpError(401, 'missing Tailscale-User-Login')
  const { rows } = await pool.query<Person>('select id, team_id, login from people where login = $1', [login])
  if (!rows[0]) throw new HttpError(403, `${login} is not on a team`)
  return rows[0]
}
