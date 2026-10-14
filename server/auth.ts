// Who is calling. A person is known by the Tailscale login that tailscale serve
// sets. A machine is known by its instance token.

import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { maybe, pool } from './db.ts'
import { HttpError, Person } from './record.ts'
import { Login, NAME_MAX } from '../shared/onboarding.ts'

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
export function loginFrom(req: IncomingMessage): Login {
  const header = req.headers['tailscale-user-login']
  if (typeof header !== 'string' || !header) throw new HttpError(401, 'missing Tailscale-User-Login')
  const login = Login.safeParse(header)
  if (!login.success) throw new HttpError(400, 'Tailscale-User-Login is not a Tailscale login')
  return login.data
}

// The display name tailscale serve passes beside the login, cut to NAME_MAX
// characters. Some identity providers give none.
export function nameFrom(req: IncomingMessage): string | null {
  const name = req.headers['tailscale-user-name']
  const trimmed = typeof name === 'string' ? name.trim() : ''
  return trimmed ? Array.from(trimmed).slice(0, NAME_MAX).join('') : null
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
