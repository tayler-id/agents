// Each person's own Claude sign-in, run inside their box. Their box runs
// `claude setup-token` and posts its link here, and the person's code goes back
// to the box through this process's memory, never Postgres, a command or a log.
// The token stays in the box. The design is in docs/design/onboarding.md.

import type pg from 'pg'
import { z } from 'zod'
import { many, maybe, one, pool, tx } from './db.ts'
import type { Instance } from './auth.ts'
import { HttpError, scrub, type Person } from './record.ts'
import {
  CLAUDE_LOGIN_MOVES, ClaudeLoginRow, InstanceId, movesInto, OPEN_CLAUDE_LOGIN, TeamId, type ClaudeLoginId, type ClaudeLoginStatus,
} from '../shared/onboarding.ts'

const LOGIN = `id, team_id, instance_id, person_id, status, url, note, valid_until::text as valid_until,
  created_at::text as created_at, updated_at::text as updated_at`

// How long a person's code waits here for their box to take it. Claude's codes
// are short-lived, and the person can paste it again.
const CODE_TTL_MS = 10 * 60_000
const DAY_MS = 24 * 60 * 60 * 1000

// Codes people sent, waiting for their boxes. Only in this process's memory.
const codes = new Map<ClaudeLoginId, { code: string; timer: NodeJS.Timeout }>()

function forgetCode(loginId: ClaudeLoginId) {
  const held = codes.get(loginId)
  if (!held) return
  clearTimeout(held.timer)
  codes.delete(loginId)
}

// Holds a code for CODE_TTL_MS. Its timer forgets only this code, never one held after it.
function holdCode(loginId: ClaudeLoginId, code: string): { code: string; timer: NodeJS.Timeout } {
  const held = { code, timer: setTimeout(() => { if (codes.get(loginId) === held) codes.delete(loginId) }, CODE_TTL_MS) }
  held.timer.unref()
  codes.set(loginId, held)
  return held
}

// Each move a sign-in can make, with what that state holds.
type Move =
  | { to: 'waiting_for_code'; url: string; note: string | null }
  | { to: 'checking' }
  | { to: 'signed_in'; validDays: number }
  | { to: 'failed'; reason: string }
  | { to: 'cancelled' }

// Moves a sign-in on, only from a status its transition table allows, and only
// for the box or the person named.
async function move(db: pg.Pool | pg.PoolClient, loginId: ClaudeLoginId, by: { instance: InstanceId } | { person: Person }, next: Move): Promise<ClaudeLoginRow> {
  const from: ClaudeLoginStatus[] = movesInto(CLAUDE_LOGIN_MOVES, next.to)
  const url = next.to === 'waiting_for_code' ? next.url : null
  const note = next.to === 'waiting_for_code' ? next.note : next.to === 'failed' ? scrub(next.reason) : null
  const validUntil = next.to === 'signed_in' ? new Date(Date.now() + next.validDays * DAY_MS) : null
  const owner = 'instance' in by ? 'instance_id' : 'person_id'
  const ownerId = 'instance' in by ? by.instance : by.person.id
  const row = await maybe(db,
    `update claude_logins set status = $2, url = coalesce($3, url), note = $4, valid_until = $5, updated_at = now()
     where id = $1 and status = any($6) and ${owner} = $7 returning ${LOGIN}`,
    [loginId, next.to, url, note, validUntil, from, ownerId])
  if (!row) {
    // Someone else's sign-in is no business of this caller's; their own only cannot move from where it is.
    const theirs = await maybe(db, `select 1 from claude_logins where id = $1 and ${owner} = $2`, [loginId, ownerId])
    throw theirs ? new HttpError(409, `That sign-in cannot be ${next.to.replace(/_/g, ' ')} now.`) : new HttpError(404, 'no such sign-in')
  }
  if (next.to !== 'checking') forgetCode(loginId)
  return ClaudeLoginRow.parse(row)
}

const OwnBox = z.object({ id: InstanceId, team_id: TeamId })

// Starts a sign-in on the person's own box. Starting again cancels the one under way.
export async function startLogin(person: Person): Promise<ClaudeLoginId> {
  return tx(async (client) => {
    const found = await maybe(client, 'select id, team_id from instances where owner_id = $1 and personal for update', [person.id])
    if (!found) throw new HttpError(409, 'You have no box yet. Make one on the Your box page first.')
    const box = OwnBox.parse(found)
    const open = await many(client, `select ${LOGIN} from claude_logins where instance_id = $1 and status = any($2)`, [box.id, OPEN_CLAUDE_LOGIN])
    for (const row of open) await move(client, ClaudeLoginRow.parse(row).id, { person }, { to: 'cancelled' })
    return ClaudeLoginRow.parse(await one(client, 'the new sign-in',
      `insert into claude_logins (team_id, instance_id, person_id) values ($1, $2, $3) returning ${LOGIN}`, [box.team_id, box.id, person.id])).id
  })
}

// The person's code, held for their box. It is held before the sign-in shows as
// checking, so the box never sees checking without a code waiting. A code that
// can't move the sign-in on puts back whatever code was held before it.
export async function sendCode(person: Person, loginId: ClaudeLoginId, code: string) {
  const earlier = codes.get(loginId)
  const held = holdCode(loginId, code)
  try {
    await move(pool, loginId, { person }, { to: 'checking' })
  } catch (error) {
    clearTimeout(held.timer)
    if (earlier) codes.set(loginId, earlier)
    else codes.delete(loginId)
    throw error
  }
  if (earlier) clearTimeout(earlier.timer)
}

export async function cancelLogin(person: Person, loginId: ClaudeLoginId) {
  await move(pool, loginId, { person }, { to: 'cancelled' })
}

const boxOf = (instance: Instance) => ({ instance: InstanceId.parse(instance.id) })

// The box's CLI printed its sign-in link.
export async function loginLink(instance: Instance, loginId: ClaudeLoginId, url: string) {
  await move(pool, loginId, boxOf(instance), { to: 'waiting_for_code', url, note: null })
}

// Hands the box the person's code, once. When this process restarted and lost
// it, the person is asked to paste it again.
export async function codeForBox(instance: Instance, loginId: ClaudeLoginId): Promise<string> {
  const row = await maybe(pool, `select ${LOGIN} from claude_logins where id = $1 and instance_id = $2`, [loginId, instance.id])
  const login = row ? ClaudeLoginRow.parse(row) : null
  if (login?.status !== 'checking') throw new HttpError(404, 'no sign-in of this box is checking a code')
  const held = codes.get(loginId)
  if (held) {
    forgetCode(loginId)
    return held.code
  }
  await move(pool, loginId, boxOf(instance), {
    to: 'waiting_for_code', url: login.url, note: 'The server restarted before your box got your code. Paste it again.',
  })
  throw new HttpError(410, 'the code is gone, and the person was asked for it again')
}

export async function loginDone(instance: Instance, loginId: ClaudeLoginId, validDays: number) {
  await move(pool, loginId, boxOf(instance), { to: 'signed_in', validDays })
}

export async function loginFailed(instance: Instance, loginId: ClaudeLoginId, reason: string) {
  await move(pool, loginId, boxOf(instance), { to: 'failed', reason })
}
