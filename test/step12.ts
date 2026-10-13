// Onboarding, through the API. An admin connects Tailscale with a key that only
// a file on this machine keeps, invites someone, and the invited person joins on
// their first request, with their own box. A login with no invite waits until
// an admin adds it with one click. Members cannot do what only admins may.
// Tailscale is the stand-in in test/fake-tailscale.ts.
//   npm run check:step12

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { fakeTailscale } from './fake-tailscale.ts'
import { asPerson, foundInDatabase, results, ROOT, shapeRows, startApi, within } from './onboarding-kit.ts'
import { must } from './must.ts'

const PORTS = { machines: 7920, people: 7921, streams: 7922 }
const TAILSCALE_PORT = 7923
const OFF_PORTS = { machines: 7924, people: 7925, streams: 7926 }
const PEOPLE = `http://127.0.0.1:${PORTS.people}`
const OFF_PEOPLE = `http://127.0.0.1:${OFF_PORTS.people}`

const id = randomBytes(4).toString('hex')
const team = `onboard-12-${id}`
const owner = `owner12-${id}@example.com`
const member = `member12-${id}@example.com`
const invitee = `dev12-${id}@mail.test`
const boss = `boss12-${id}@mail.test`
const later = `later12-${id}@mail.test`
const github = `gh12-${id}@github`
const key = `tskey-api-k${id}CNTRL-${randomBytes(16).toString('hex')}`
const home = mkdtempSync(join(tmpdir(), 'agents-step12-'))
const keyFile = join(home, 'tailscale', 'tailscale-api.json')

const { failures, check } = results()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const tailscale = fakeTailscale({ key, keyExpiresInDays: 30, domain: 'example.com' })
const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
const row = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0]
const apiEnv = {
  AGENTS_RUNNER_TEAMS: team,
  AGENTS_TAILSCALE_API: tailscale.url(TAILSCALE_PORT),
  AGENTS_TAILSCALE_KEY_FILE: keyFile,
  // An image that is never built, so the runner cannot start real containers for the boxes people get here.
  AGENTS_BOX_IMAGE: `agents-box:onboard-absent-${id}`,
  AGENTS_BOX_DOCKER_ARGS: JSON.stringify(['--pull', 'never']),
}
const api = startApi(PORTS, apiEnv, join(home, 'streams'))
const apis = [api]

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, owner)
  node('server/admin.ts', 'add-person', team, member)
  const { id: teamId } = must(await row('select id from teams where name = $1', [team]), 'the team')
  await tailscale.listen(TAILSCALE_PORT)
  check(await within(20, () => fetch(PEOPLE).then(() => true, () => false)), 'the API starts with Tailscale settings')

  // Admins.
  const roles = (await db.query('select login, role from people where team_id = $1 order by login', [teamId])).rows
  check(roles.find((r) => r.login === owner)?.role === 'admin' && roles.find((r) => r.login === member)?.role === 'member',
    "a team's first login is its admin, and people added later are members")
  const me = await asPerson(PEOPLE, owner, 'GET', '/v1/me')
  check(me.json?.kind === 'member' && me.json.person.role === 'admin' && me.json.team.name === team, '/v1/me tells a person their role and team')

  // The Tailscale key.
  check((await asPerson(PEOPLE, owner, 'GET', '/v1/tailscale')).json?.state === 'no_key', 'with no key saved, the Tailscale status says so')
  const memberKey = await asPerson(PEOPLE, member, 'POST', '/v1/tailscale/key', { key, expires: null })
  check((await asPerson(PEOPLE, member, 'GET', '/v1/tailscale')).status === 403 && memberKey.status === 403 && !existsSync(keyFile),
    'a member can neither see nor set the Tailscale key')
  const wrong = await asPerson(PEOPLE, owner, 'POST', '/v1/tailscale/key', { key: `tskey-api-k${id}CNTRL-wrong${id}`, expires: null })
  check(wrong.status === 502 && /Tailscale refused the key/.test(wrong.json?.error) && /Settings, then Keys/.test(wrong.json?.error) && !existsSync(keyFile),
    `a key Tailscale refuses is not saved, and the admin reads how to make one (${wrong.status} ${wrong.json?.error})`)
  const saved = await asPerson(PEOPLE, owner, 'POST', '/v1/tailscale/key', { key, expires: null })
  const mode = existsSync(keyFile) ? statSync(keyFile).mode & 0o777 : -1
  check(saved.status === 200 && mode === 0o600 && readFileSync(keyFile, 'utf8').includes(key),
    `a saved key goes to a file on this machine with mode 600 (mode ${mode.toString(8)})`)
  check(saved.json?.state === 'connected' && saved.json.lastFour === key.slice(-4) && saved.json.expires === tailscale.state.keyExpires
    && saved.json.daysLeft >= 29 && saved.json.savedBy === owner && !saved.text.includes(key.slice(0, -4)),
  "the browser gets the key's last four characters and Tailscale's expiry, never the key")

  // Invites.
  const made = await asPerson(PEOPLE, owner, 'POST', '/v1/invites', { email: invitee.toUpperCase(), role: 'member' })
  const tailscaleInvite = [...tailscale.state.invites.values()].find((i) => i.email === invitee)
  const stored = await row('select status, email, tailscale_invite_id from invites where email = $1', [invitee])
  check(made.status === 200 && made.json.link === tailscaleInvite?.inviteUrl && made.json.invite.status === 'open'
    && stored?.tailscale_invite_id === tailscaleInvite?.id
    && tailscale.state.calls.some((c) => c.method === 'POST' && c.path === '/tailnet/-/user-invites' && JSON.stringify(c.body) === JSON.stringify([{ role: 'member', email: invitee }])),
  `an admin's invite goes to Tailscale with the email lowercased, and the link comes back once (${made.status} ${made.json?.error ?? ''})`)
  check((await asPerson(PEOPLE, owner, 'POST', '/v1/invites', { email: invitee, role: 'member' })).status === 409, 'an email with an open invite cannot be invited again')
  check((await asPerson(PEOPLE, owner, 'POST', '/v1/invites', { email: member, role: 'member' })).status === 409, 'someone already on a team cannot be invited')
  check((await asPerson(PEOPLE, member, 'POST', '/v1/invites', { email: later, role: 'member' })).status === 403, 'a member cannot invite')
  const inviteId: string = made.json?.invite.id
  check((await asPerson(PEOPLE, owner, 'GET', `/v1/invites/${inviteId}/link`)).json?.link === tailscaleInvite?.inviteUrl, "an admin can fetch the invite's link again")
  tailscale.state.lastSent.set(must(tailscaleInvite, 'the Tailscale invite').id, 0)
  const resent = await asPerson(PEOPLE, owner, 'POST', `/v1/invites/${inviteId}/resend`)
  const tooSoon = await asPerson(PEOPLE, owner, 'POST', `/v1/invites/${inviteId}/resend`)
  check(resent.status === 200 && tailscale.state.calls.some((c) => c.path === `/user-invites/${tailscaleInvite?.id}/resend`)
    && tooSoon.status === 429 && /one per minute/.test(tooSoon.json?.error),
  `resending asks Tailscale to email it again, and its once-a-minute limit reaches the admin in its words (${tooSoon.json?.error})`)
  tailscale.state.refuseNextInvite = 'that email address is not valid'
  const refused = await asPerson(PEOPLE, owner, 'POST', '/v1/invites', { email: later, role: 'member' })
  check(refused.status === 400 && /not valid/.test(refused.json?.error) && !(await row('select 1 from invites where email = $1', [later])),
    'an invite Tailscale refuses leaves no invite behind, and the admin reads why')
  const cancelled = await asPerson(PEOPLE, owner, 'POST', '/v1/invites', { email: later, role: 'member' })
  const laterInvite = [...tailscale.state.invites.values()].find((i) => i.email === later)
  const cancel = await asPerson(PEOPLE, owner, 'POST', `/v1/invites/${cancelled.json?.invite.id}/cancel`)
  check(cancel.status === 200 && (await row('select status from invites where email = $1', [later]))?.status === 'cancelled'
    && laterInvite && !tailscale.state.invites.has(laterInvite.id),
  'cancelling an invite cancels it in Tailscale too')

  // Joining with an invite.
  tailscale.accept(invitee, 'Dev Twelve')
  const firsts = await Promise.all([1, 2, 3].map(() => asPerson(PEOPLE, invitee, 'GET', '/v1/me', undefined, 'Dev Twelve')))
  const people = (await db.query('select id, team_id, role, name from people where login = $1', [invitee])).rows
  const person = people[0]
  check(firsts.every((f) => f.json?.kind === 'member' && f.json.team.name === team) && people.length === 1
    && person?.team_id === teamId && person.role === 'member' && person.name === 'Dev Twelve',
  'the invited person joins on their first request, once, with the role and the name Tailscale gave')
  const invite = await row('select status, person_id, closed_at from invites where email = $1', [invitee])
  check(invite?.status === 'joined' && invite.person_id === person?.id && invite.closed_at, 'the invite is closed as joined, by that person')
  const boxes = (await db.query(`select id, name, kind, personal, owner_id, claimed_by from instances where team_id = $1 and personal`, [teamId])).rows
  check(boxes.length === 1 && boxes[0]?.kind === 'box' && boxes[0].owner_id === person?.id && boxes[0].claimed_by === person?.id
    && boxes[0].name === `box-dev12-${id}`, `they get their own box, named after their login, held by them (${boxes.map((b) => b.name).join(', ')})`)
  await asPerson(PEOPLE, owner, 'POST', '/v1/invites', { email: boss, role: 'admin' })
  const bossMe = await asPerson(PEOPLE, `Boss12-${id}@Mail.Test`, 'GET', '/v1/me')
  check(bossMe.json?.kind === 'member' && bossMe.json.person.role === 'admin', 'an invite for an admin makes an admin, matching the login whatever its case')

  // Waiting, and one click to add.
  const waiting = await asPerson(PEOPLE, github, 'GET', '/v1/me', undefined, 'GH Twelve')
  // Electric follows Postgres's log, so a row reaches a shape a moment after it is written.
  const listed = await within(10, async () => (await shapeRows(PEOPLE, owner, 'join_requests')).rows
    .some((r) => r.login === github && r.name === 'GH Twelve' && r.status === 'waiting'))
  check(waiting.status === 200 && waiting.json?.kind === 'waiting' && waiting.json.login === github && listed,
    'a login with no invite waits, and admins see it under wants to join')
  check((await shapeRows(PEOPLE, member, 'join_requests')).status === 403 && (await shapeRows(PEOPLE, member, 'invites')).status === 403
    && await within(10, async () => (await shapeRows(PEOPLE, owner, 'invites')).rows.some((r) => r.email === invitee)),
  'only admins see who wants to join and who is invited')
  check((await shapeRows(PEOPLE, github, 'agents')).status === 403 && (await asPerson(PEOPLE, github, 'POST', '/v1/invites', { email: later, role: 'member' })).status === 403,
    'a waiting login can use nothing else')
  check((await asPerson(PEOPLE, member, 'POST', '/v1/team/people', { login: github, name: null })).status === 403, 'a member cannot add people')
  const added = await asPerson(PEOPLE, owner, 'POST', '/v1/team/people', { login: github, name: null })
  const ghMe = await asPerson(PEOPLE, github, 'GET', '/v1/me')
  const request = await row('select status, added_by, person_id from join_requests where login = $1', [github])
  check(added.status === 200 && ghMe.json?.kind === 'member' && ghMe.json.person.name === 'GH Twelve' && request?.status === 'added'
    && request.person_id === ghMe.json.person.id && (await row('select 1 from instances where owner_id = $1 and personal', [ghMe.json.person.id])),
  'one click adds them with their own box, and their next request lets them in')
  check((await asPerson(PEOPLE, owner, 'POST', '/v1/team/people', { login: github, name: null })).status === 409, 'adding a login already on a team is refused')

  // People's own boxes stay out of the pool that runs take boxes from, even one
  // whose owner has gone and no longer holds it.
  await db.query(`update instances set claimed_by = null where owner_id = (select id from people where login = $1)`, [`Boss12-${id}@Mail.Test`])
  process.env.AGENTS_MAX_BOXES = '1'
  const { claimBox } = await import('../server/boxes.ts')
  const { tx, pool } = await import('../server/db.ts')
  const pipeline = await row(`insert into pipelines (team_id, name, path) values ($1, 'boxed', 'pipelines/boxed.ts') returning id`, [teamId])
  const version = await row(`insert into pipeline_versions (pipeline_id, git_sha) values ($1, $2) returning id`, [pipeline.id, id])
  const task = await row(`insert into tasks (team_id, slug, title) values ($1, $2, 'boxed run') returning id`, [teamId, `boxed-${id}`])
  const runRow = await row(`insert into runs (team_id, pipeline_version_id, task_id, trigger, status) values ($1, $2, $3, 'manual', 'done') returning id`, [teamId, version.id, task.id])
  const claimed = await tx((client) => claimBox(client, teamId, runRow.id))
  const claimedBox = claimed ? await row('select personal from instances where id = $1', [claimed]) : null
  check(claimed && claimedBox?.personal === false, "a run never takes a person's own box, held or not, and own boxes leave room under the box limit")
  await pool.end()
  const ownBox = must(boxes[0], 'the box').id
  check((await asPerson(PEOPLE, invitee, 'POST', `/v1/instances/${ownBox}/release`)).status === 409, 'a person cannot release their own box into the pool')

  // Tailscale off, and set by halves.
  const off = startApi(OFF_PORTS, { AGENTS_RUNNER: 'off', AGENTS_TAILSCALE_API: undefined, AGENTS_TAILSCALE_KEY_FILE: undefined }, join(home, 'streams-off'))
  apis.push(off)
  await within(20, () => fetch(OFF_PEOPLE).then(() => true, () => false))
  const offStatus = await asPerson(OFF_PEOPLE, owner, 'GET', '/v1/tailscale')
  const offInvite = await asPerson(OFF_PEOPLE, owner, 'POST', '/v1/invites', { email: `plain12-${id}@mail.test`, role: 'member' })
  const offResend = await asPerson(OFF_PEOPLE, owner, 'POST', `/v1/invites/${offInvite.json?.invite?.id}/resend`)
  check(offStatus.json?.state === 'off' && offInvite.status === 200 && offInvite.json.link === null && offInvite.json.invite.tailscale_invite_id === null
    && offResend.status === 409 && /not connected/.test(offResend.json?.error),
  `without Tailscale settings, Tailscale is off and invites are made in the app only (${offStatus.text} ${offInvite.status})`)
  off.child.kill('SIGTERM')
  const half = startApi(OFF_PORTS, { AGENTS_RUNNER: 'off', AGENTS_TAILSCALE_API: tailscale.url(TAILSCALE_PORT), AGENTS_TAILSCALE_KEY_FILE: undefined }, join(home, 'streams-half'))
  apis.push(half)
  const halfCode = await Promise.race([half.exited, new Promise<'running'>((resolve) => setTimeout(() => { resolve('running') }, 15_000))])
  check(halfCode !== 'running' && halfCode !== 0 && /AGENTS_TAILSCALE_API and AGENTS_TAILSCALE_KEY_FILE together/.test(half.text()),
    'setting only one of the two Tailscale settings stops the API when it starts, naming both')

  // The key never left its file.
  const inDb = await foundInDatabase(db, key)
  check(inDb.length === 0 && !api.text().includes(key) && !off.text().includes(key),
    `the Tailscale key is in no table and no log${inDb.length ? ` (found in ${inDb.join(', ')})` : ''}`)
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack ?? ''}`)
} finally {
  for (const { child } of apis) child.kill('SIGTERM')
  await tailscale.close()
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
    await db.query('delete from join_requests where login = $1', [github]).catch(() => undefined)
    rmSync(home, { recursive: true, force: true })
  }
  await db.end().catch(() => undefined)
}

console.log(failures.length ? `\n${failures.length} failed (team ${team} kept)` : '\nall passed (test team removed)')
process.exit(failures.length ? 1 : 0)
