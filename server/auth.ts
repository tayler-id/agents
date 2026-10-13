// Who is calling. A person is known by the Tailscale login that tailscale serve
// sets. A machine is known by its instance token.

import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { maybe, pool } from './db.ts'
import { HttpError, Person } from './record.ts'

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

// The login tailscale serve vouches for, whether or not it is on a team yet.
export function loginFrom(req: IncomingMessage): string {
  const login = req.headers['tailscale-user-login']
  if (typeof login !== 'string' || !login) throw new HttpError(401, 'missing Tailscale-User-Login')
  return login
}

// The display name tailscale serve passes beside the login. Some identity
// providers give none.
export function nameFrom(req: IncomingMessage): string | null {
  const name = req.headers['tailscale-user-name']
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

export async function personFrom(req: IncomingMessage): Promise<Person> {
  const login = loginFrom(req)
  const row = await maybe(pool, 'select id, team_id, login, role from people where login = $1', [login])
  if (!row) throw new HttpError(403, `${login} is not on a team`)
  return Person.parse(row)
}

export async function adminFrom(req: IncomingMessage): Promise<Person> {
  const person = await personFrom(req)
  if (person.role !== 'admin') throw new HttpError(403, 'Only team admins can do that.')
  return person
}
