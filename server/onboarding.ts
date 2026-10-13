// Inviting people and letting them in. An admin's invite names an email, and
// the person joins on their first request when their Tailscale login equals it.
// A login with no invite waits in a list until an admin adds it. Everyone who
// joins gets their own box. The design is in docs/design/onboarding.md.

import type pg from 'pg'
import { z } from 'zod'
import { many, maybe, one, pool, tx } from './db.ts'
import { addPersonalBox } from './boxes.ts'
import { HttpError, Person } from './record.ts'
import { wakeRunner } from './runner.ts'
import { lastSeenOf, sentAtOf, tailscale, tailscaleConnected } from './tailscale.ts'
import {
  INVITE_MOVES, InviteRow, JOIN_REQUEST_MOVES, JoinRequestRow, movesInto, PersonId, TeamId, TeamRole,
  type InviteId, type InviteLink, type InviteMade, type InviteResent, type InviteStatus, type MeView,
  type TailnetDevice, type TailnetInvite, type TailnetUser,
} from '../shared/onboarding.ts'

const INVITE = `id, team_id, email, role, tailscale_invite_id, invited_by, status, person_id,
  created_at::text as created_at, closed_at::text as closed_at`
const JOIN_REQUEST = 'id, login, name, status, person_id, added_by, first_seen_at::text as first_seen_at, last_seen_at::text as last_seen_at'

// What a login is when it opens the app.
export type Arrival =
  | { kind: 'member'; person: Person }
  // Joined on this request, through an open invite for its email.
  | { kind: 'joined'; person: Person; invite: InviteId }
  | { kind: 'waiting'; request: JoinRequestRow }

type Joining = { teamId: TeamId; login: string; name: string | null; role: TeamRole; addedBy: PersonId | null }

const isUniqueViolation = (error: unknown) => error instanceof Error && 'code' in error && error.code === '23505'

async function personByLogin(db: pg.Pool | pg.PoolClient, login: string): Promise<Person | null> {
  const row = await maybe(db, 'select id, team_id, login, role from people where login = $1', [login])
  return row ? Person.parse(row) : null
}

// One arrival or addition per login at a time, so two first requests make one person.
async function lockLogin(client: pg.PoolClient, login: string) {
  await client.query(`select pg_advisory_xact_lock(hashtext('join:' || $1))`, [login])
}

// Moves an invite on, only from a status its transition table allows.
async function moveInvite(client: pg.PoolClient, inviteId: InviteId, teamId: TeamId, to: Exclude<InviteStatus, 'open'>, personId: PersonId | null): Promise<InviteRow> {
  const row = await maybe(client,
    `update invites set status = $3, person_id = $4, closed_at = now()
     where id = $1 and team_id = $2 and status = any($5) returning ${INVITE}`,
    [inviteId, teamId, to, to === 'joined' ? personId : null, movesInto(INVITE_MOVES, to)])
  if (!row) throw new HttpError(409, 'That invite is no longer open.')
  return InviteRow.parse(row)
}

// Adds a login to a team with its own box, and closes any request it made to join.
async function join(client: pg.PoolClient, joining: Joining): Promise<Person> {
  const person = Person.parse(await one(client, 'the new person',
    'insert into people (team_id, login, name, role) values ($1, $2, $3, $4) returning id, team_id, login, role',
    [joining.teamId, joining.login, joining.name, joining.role]))
  await addPersonalBox(client, person.team_id, person.id, person.login)
  await client.query(
    `update join_requests set status = 'added', person_id = $2, added_by = $3 where login = $1 and status = any($4)`,
    [person.login, person.id, joining.addedBy, movesInto(JOIN_REQUEST_MOVES, 'added')])
  return person
}

// Records that a login on no team wants in, or that it is still waiting. A login
// that was added once and is on no team now asks again.
async function askToJoin(client: pg.PoolClient, login: string, name: string | null): Promise<JoinRequestRow> {
  return JoinRequestRow.parse(await one(client, 'the join request',
    `insert into join_requests (login, name) values ($1, $2)
     on conflict (login) do update set last_seen_at = now(), name = coalesce(excluded.name, join_requests.name),
       status = 'waiting', person_id = null, added_by = null
     returning ${JOIN_REQUEST}`, [login, name]))
}

export async function arrive(login: string, name: string | null): Promise<Arrival> {
  const known = await personByLogin(pool, login)
  if (known) return { kind: 'member', person: known }
  const arrival = await tx(async (client): Promise<Arrival> => {
    await lockLogin(client, login)
    const person = await personByLogin(client, login)
    if (person) return { kind: 'member', person }
    const found = await maybe(client, `select ${INVITE} from invites where status = 'open' and email = lower($1) for update`, [login])
    if (!found) return { kind: 'waiting', request: await askToJoin(client, login, name) }
    const invite = InviteRow.parse(found)
    const joined = await join(client, { teamId: invite.team_id, login, name, role: invite.role, addedBy: invite.invited_by })
    await moveInvite(client, invite.id, invite.team_id, 'joined', joined.id)
    return { kind: 'joined', person: joined, invite: invite.id }
  })
  // The runner starts the new person's box.
  if (arrival.kind === 'joined') void wakeRunner()
  return arrival
}

const MemberRow = z.object({ id: PersonId, login: z.string(), name: z.string().nullable(), role: TeamRole, team_id: TeamId, team_name: z.string() })

export async function meOf(arrival: Arrival): Promise<MeView> {
  if (arrival.kind === 'waiting') return { kind: 'waiting', login: arrival.request.login, name: arrival.request.name }
  const row = MemberRow.parse(await one(pool, 'the person and their team',
    `select p.id, p.login, p.name, p.role, t.id as team_id, t.name as team_name
     from people p join teams t on t.id = p.team_id where p.id = $1`, [arrival.person.id]))
  return {
    kind: 'member',
    person: { id: row.id, login: row.login, name: row.name, role: row.role },
    team: { id: row.team_id, name: row.team_name },
  }
}

// An admin adds a login to their team, from the wants-to-join list or the tailnet's users.
export async function addToTeam(admin: Person, login: string, name: string | null): Promise<Person> {
  const person = await tx(async (client) => {
    await lockLogin(client, login)
    if (await personByLogin(client, login)) throw new HttpError(409, `${login} is already on a team.`)
    const asked = await maybe(client, `select ${JOIN_REQUEST} from join_requests where login = $1`, [login])
    // The name Tailscale gave when they asked, unless the admin's list had one.
    const named = name ?? (asked ? JoinRequestRow.parse(asked).name : null)
    const joined = await join(client, { teamId: admin.team_id, login, name: named, role: 'member', addedBy: admin.id })
    // An open invite for this login on this team is used up by joining.
    const invite = await maybe(client, `select ${INVITE} from invites where team_id = $1 and email = lower($2) and status = 'open' for update`, [admin.team_id, login])
    if (invite) await moveInvite(client, InviteRow.parse(invite).id, admin.team_id, 'joined', joined.id)
    return joined
  })
  void wakeRunner()
  return person
}

async function openInvite(admin: Person, inviteId: InviteId): Promise<Extract<InviteRow, { status: 'open' }>> {
  const row = await maybe(pool, `select ${INVITE} from invites where id = $1 and team_id = $2`, [inviteId, admin.team_id])
  if (!row) throw new HttpError(404, 'no such invite')
  const invite = InviteRow.parse(row)
  if (invite.status !== 'open') throw new HttpError(409, 'That invite is no longer open.')
  return invite
}

// The invite row is written before Tailscale is asked, so a Tailscale invite
// never exists without one here. If Tailscale refuses, the row goes.
export async function makeInvite(admin: Person, email: string, role: TeamRole): Promise<InviteMade> {
  if (await maybe(pool, 'select 1 from people where lower(login) = $1', [email])) throw new HttpError(409, `${email} is already on a team.`)
  const connected = await tailscaleConnected()
  const invite = InviteRow.parse(await one(pool, 'the new invite',
    `insert into invites (team_id, email, role, invited_by) values ($1, $2, $3, $4) returning ${INVITE}`,
    [admin.team_id, email, role, admin.id]).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new HttpError(409, `${email} already has an open invite. Resend it from the list.`)
    throw error
  }))
  if (!connected) return { invite, link: null }
  const made = await tailscale.createInvite(email).catch(async (error: unknown) => {
    await pool.query('delete from invites where id = $1 and tailscale_invite_id is null', [invite.id])
    throw error
  })
  const sent = InviteRow.parse(await one(pool, 'the invite',
    `update invites set tailscale_invite_id = $2 where id = $1 returning ${INVITE}`, [invite.id, made.id]))
  return { invite: sent, link: made.inviteUrl ?? null }
}

// Emails the invite again. An invite made while Tailscale was not connected gets
// its Tailscale invite now.
export async function resendInvite(admin: Person, inviteId: InviteId): Promise<InviteResent> {
  const invite = await openInvite(admin, inviteId)
  if (!(await tailscaleConnected())) throw new HttpError(409, 'Tailscale is not connected, so the app cannot email invites. Connect it on the Tailscale page.')
  if (invite.tailscale_invite_id !== null) {
    await tailscale.resendInvite(invite.tailscale_invite_id)
    return { link: null }
  }
  const made = await tailscale.createInvite(invite.email)
  await pool.query('update invites set tailscale_invite_id = $2 where id = $1', [invite.id, made.id])
  return { link: made.inviteUrl ?? null }
}

export async function cancelInvite(admin: Person, inviteId: InviteId) {
  const invite = await openInvite(admin, inviteId)
  if (invite.tailscale_invite_id !== null && await tailscaleConnected()) {
    try {
      await tailscale.deleteInvite(invite.tailscale_invite_id)
    } catch (error) {
      // Tailscale has no such invite once the person accepted it or someone deleted it in its console.
      if (!(error instanceof HttpError && error.status === 404)) throw error
    }
  }
  await tx((client) => moveInvite(client, invite.id, admin.team_id, 'cancelled', null))
}

const Standing = z.object({ login: z.string(), team_id: TeamId, role: TeamRole })

// The tailnet's users, each with whether their login is on the asking admin's team.
export async function tailnetUsers(admin: Person): Promise<TailnetUser[]> {
  const users = await tailscale.users()
  const rows = await many(pool, 'select lower(login) as login, team_id, role from people where lower(login) = any($1)',
    [users.map((u) => u.loginName.toLowerCase())])
  const people = new Map(rows.map((row) => Standing.parse(row)).map((p) => [p.login, p]))
  return users.map((u) => {
    const person = people.get(u.loginName.toLowerCase())
    const team: TailnetUser['team'] = !person ? { on: 'no_team' }
      : person.team_id === admin.team_id ? { on: 'this_team', role: person.role } : { on: 'other_team' }
    return { id: u.id, name: u.displayName, login: u.loginName, role: u.role, status: u.status, team }
  })
}

export async function tailnetDevices(): Promise<TailnetDevice[]> {
  return (await tailscale.devices()).map((d) => ({
    id: d.nodeId, name: d.hostname, owner: d.user, os: d.os, authorized: d.authorized, online: d.connectedToControl, lastSeen: lastSeenOf(d),
  }))
}

export async function tailnetInvites(): Promise<TailnetInvite[]> {
  return (await tailscale.invites()).map((i) => ({
    // Tailscale gives no link for an email in the tailnet's own domain.
    id: i.id, email: i.email, role: i.role, lastSentAt: sentAtOf(i), link: i.inviteUrl ?? null,
  }))
}

// Cancels a tailnet invite. One the app made is cancelled in the app too.
export async function cancelTailnetInvite(admin: Person, tailscaleInviteId: string) {
  const ours = await maybe(pool, `select ${INVITE} from invites where tailscale_invite_id = $1 and team_id = $2 and status = 'open'`,
    [tailscaleInviteId, admin.team_id])
  if (ours) return cancelInvite(admin, InviteRow.parse(ours).id)
  await tailscale.deleteInvite(tailscaleInviteId)
}

export async function inviteLink(admin: Person, inviteId: InviteId): Promise<InviteLink> {
  const invite = await openInvite(admin, inviteId)
  if (invite.tailscale_invite_id === null) throw new HttpError(404, 'This invite was made without Tailscale, so it has no link.')
  const made = await tailscale.invite(invite.tailscale_invite_id)
  if (made.inviteUrl === undefined) {
    throw new HttpError(404, `Tailscale gives no link for ${invite.email}, which is in the tailnet's own domain. They join by signing in to Tailscale.`)
  }
  return { link: made.inviteUrl }
}
