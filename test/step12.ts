// Onboarding, through the API. An admin connects Tailscale with a key that only
// a file on this machine keeps, invites someone, and the invited person joins on
// their first request, with their own box. A login with no invite waits until
// an admin adds it with one click. Members cannot do what only admins may.
// Someone in a room, or an admin, adds a teammate to it, and the room's agent
// is told who is there. Tailscale is the stand-in in test/fake-tailscale.ts.
//   node --env-file=.env --env-file=.env.test test/step12.ts

import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { z } from 'zod'
import { fakeTailscale } from './fake-tailscale.ts'
import { asPerson, foundInDatabase, results, ROOT, shapeRows, startApi, within } from './onboarding-kit.ts'
import { must } from './must.ts'
import { messageOf } from '../shared/errors.ts'

// 7921 is the people port of main's step6, so this one takes 7936 from the end of the range.
const PORTS = { machines: 7920, people: 7936, streams: 7922 }
const TAILSCALE_PORT = 7923
const OFF_PORTS = { machines: 7924, people: 7925, streams: 7926 }
const PEOPLE = `http://127.0.0.1:${PORTS.people}`
const OFF_MACHINES = `http://127.0.0.1:${OFF_PORTS.machines}`
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
const api = await startApi(PORTS, apiEnv, join(home, 'streams'))
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
  check((await asPerson(PEOPLE, member, 'POST', '/v1/invites', { email: `friend12-${id}@mail.test`, role: 'member' })).status === 403, 'a member cannot invite')
  // A page on another site can make a person's browser post a form, which goes as
  // text/plain or a form encoding, never as JSON.
  const crossSite = `xsite12-${id}@mail.test`
  const formPost = await fetch(`${PEOPLE}/v1/invites`, {
    method: 'POST', headers: { 'tailscale-user-login': owner, 'content-type': 'text/plain' }, body: JSON.stringify({ email: crossSite, role: 'admin' }),
  })
  await formPost.body?.cancel()
  check(!formPost.ok && !(await row('select 1 from invites where email = $1', [crossSite])),
    `a person's change sent as text/plain, as a form on another site sends it, is refused and makes no invite (${formPost.status})`)
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
  const cancel = await asPerson(PEOPLE, owner, 'POST', `/v1/invites/${cancelled.json?.invite?.id}/cancel`)
  check(cancel.status === 200 && (await row('select status from invites where email = $1', [later]))?.status === 'cancelled'
    && laterInvite && !tailscale.state.invites.has(laterInvite.id),
  'cancelling an invite cancels it in Tailscale too')

  // Reading who you are changes nothing, so a page on another site that makes a
  // browser load it cannot make someone join.
  tailscale.accept(invitee, 'Dev Twelve')
  const peek = await asPerson(PEOPLE, invitee, 'GET', '/v1/me', undefined, 'Dev Twelve')
  check(peek.status === 200 && peek.json?.kind === 'invited' && !(await row('select 1 from people where login = $1', [invitee]))
    && (await row('select status from invites where email = $1', [invitee]))?.status === 'open',
  `reading /v1/me with an open invite says so, and joins nothing until the app asks to join (${peek.text})`)

  // Joining with an invite. Three first requests at once must make one person.
  // The check holds the invite's row lock until all three are waiting in
  // Postgres, so they truly race instead of finishing one after another.
  const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await holder.connect()
  await holder.query('begin')
  await holder.query('select 1 from invites where email = $1 for update', [invitee])
  const racing = Promise.all([1, 2, 3].map(() => asPerson(PEOPLE, invitee, 'POST', '/v1/me/join', {}, 'Dev Twelve')))
  const waitingInPostgres = await within(10, async () => (await row(
    `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'
     and (query like '%hashtext(''join:''%' or query like '%from invites where status = ''open'' and email = lower%')`, [])).n === 3)
  await holder.query('commit')
  await holder.end()
  const firsts = await racing
  const people = (await db.query('select id, team_id, role, name from people where login = $1', [invitee])).rows
  const person = people[0]
  check(waitingInPostgres && firsts.every((f) => f.json?.kind === 'member' && f.json.team.name === team) && people.length === 1
    && person?.team_id === teamId && person.role === 'member' && person.name === 'Dev Twelve',
  `the invited person joins on their first request, once even when three arrive together, with the role and the name Tailscale gave (${firsts.map((f) => f.json?.kind).join(', ')})`)
  const invite = await row('select status, person_id, closed_at from invites where email = $1', [invitee])
  check(invite?.status === 'joined' && invite.person_id === person?.id && invite.closed_at, 'the invite is closed as joined, by that person')
  const boxes = (await db.query(`select id, name, kind, personal, owner_id, claimed_by from instances where team_id = $1 and personal`, [teamId])).rows
  check(boxes.length === 1 && boxes[0]?.kind === 'box' && boxes[0].owner_id === person?.id && boxes[0].claimed_by === person?.id
    && boxes[0].name === `box-dev12-${id}`, `they get their own box, named after their login, held by them (${boxes.map((b) => b.name).join(', ')})`)
  await asPerson(PEOPLE, owner, 'POST', '/v1/invites', { email: boss, role: 'admin' })
  const bossMe = await asPerson(PEOPLE, `Boss12-${id}@Mail.Test`, 'POST', '/v1/me/join', {})
  check(bossMe.json?.kind === 'member' && bossMe.json.person.role === 'admin', 'an invite for an admin makes an admin, matching the login whatever its case')

  // Boxes. This API's box image is never built, so the runner's tries to start them fail.
  const ownBoxId: string = must(boxes[0], 'their box').id
  const stuck = await within(30, async () => /No such image|Unable to find image/.test((await row('select start_error from instances where id = $1', [ownBoxId]))?.start_error ?? ''))
  const startError: string = (await row('select start_error from instances where id = $1', [ownBoxId]))?.start_error ?? ''
  check(stuck && !/machine_|AGENTS_TOKEN|CLAUDE_CODE_OAUTH_TOKEN/.test(startError) && !/AGENTS_TOKEN=|machine_[A-Za-z0-9_-]{20}/.test(api.text()),
    `a box that cannot start keeps Docker's reason for its owner, with no token in it or in the log (${startError})`)
  const boxMade = await asPerson(PEOPLE, member, 'POST', '/v1/me/box')
  const memberBox = await row('select id, personal, owner_id, claimed_by from instances where owner_id = (select id from people where login = $1) and personal', [member])
  check(boxMade.status === 200 && memberBox?.id === boxMade.json?.instanceId && memberBox?.claimed_by === memberBox?.owner_id
    && (await asPerson(PEOPLE, member, 'POST', '/v1/me/box')).status === 409,
  'someone on the team from before makes their own box, and only one')
  const theirs = await asPerson(PEOPLE, member, 'POST', '/v1/agents', { name: `notmine-${id}`, homeInstanceId: ownBoxId })
  const mine = await asPerson(PEOPLE, invitee, 'POST', '/v1/agents', { name: `mine-${id}`, homeInstanceId: ownBoxId })
  check(theirs.status === 403 && /teammate's own/.test(theirs.json?.error) && mine.status === 200,
    "only a box's owner makes agents whose home it is")

  // Waiting, and one click to add. Reading /v1/me records nothing, and asking to join does.
  const looked = await asPerson(PEOPLE, github, 'GET', '/v1/me', undefined, 'GH Twelve')
  check(looked.status === 200 && looked.json?.kind === 'waiting' && !(await row('select 1 from join_requests where login = $1', [github])),
    `reading /v1/me with no invite records no request to join (${looked.text})`)
  const waiting = await asPerson(PEOPLE, github, 'POST', '/v1/me/join', {}, 'GH Twelve')
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

  // The tailnet, from the Tailscale page's routes.
  const otherTeam = `onboard-12x-${id}`
  const outsider = `other12-${id}@mail.test`
  node('server/admin.ts', 'add-team', otherTeam, outsider)
  tailscale.user(owner, 'Owner Twelve', 'owner')
  const memberUser = tailscale.user(member, 'Member Twelve')
  const pending = tailscale.user(`pend12-${id}@mail.test`, 'Pending Twelve', 'member', 'needs-approval')
  tailscale.user(outsider, 'Outsider Twelve')
  const laptop = tailscale.device(owner, `laptop-${id}`, 'macOS', true, true)
  const phone = tailscale.device(`pend12-${id}@mail.test`, `phone-${id}`, 'iOS', false, false)
  check((await asPerson(PEOPLE, member, 'GET', '/v1/tailscale/users')).status === 403 && (await asPerson(PEOPLE, member, 'GET', '/v1/tailscale/devices')).status === 403
    && (await asPerson(PEOPLE, member, 'POST', `/v1/tailscale/users/${pending.id}/approve`)).status === 403,
  'a member can neither see nor change the tailnet')
  const users = (await asPerson(PEOPLE, owner, 'GET', '/v1/tailscale/users')).json?.users ?? []
  const standing = (login: string) => JSON.stringify(users.find((u: any) => u.login === login)?.team)
  check(standing(owner) === JSON.stringify({ on: 'this_team', role: 'admin' }) && standing(member) === JSON.stringify({ on: 'this_team', role: 'member' })
    && standing(`pend12-${id}@mail.test`) === JSON.stringify({ on: 'no_team' }) && standing(outsider) === JSON.stringify({ on: 'other_team' })
    && users.find((u: any) => u.login === `pend12-${id}@mail.test`)?.status === 'needs-approval',
  "an admin sees the tailnet's users with their status, and which are on this team, another team, or none")
  const acted = [
    await asPerson(PEOPLE, owner, 'POST', `/v1/tailscale/users/${pending.id}/approve`),
    await asPerson(PEOPLE, owner, 'POST', `/v1/tailscale/users/${memberUser.id}/suspend`),
  ]
  const suspended = tailscale.state.users.get(memberUser.id)?.status
  acted.push(await asPerson(PEOPLE, owner, 'POST', `/v1/tailscale/users/${memberUser.id}/restore`))
  acted.push(await asPerson(PEOPLE, owner, 'POST', `/v1/tailscale/users/${memberUser.id}/role`, { role: 'it-admin' }))
  check(acted.every((a) => a.status === 200) && tailscale.state.users.get(pending.id)?.status === 'active' && suspended === 'suspended'
    && tailscale.state.users.get(memberUser.id)?.status === 'active' && tailscale.state.users.get(memberUser.id)?.role === 'it-admin',
  'an admin approves, suspends, restores and changes the role of tailnet users through Tailscale')
  check((await asPerson(PEOPLE, owner, 'POST', `/v1/tailscale/users/${memberUser.id}/role`, { role: 'owner' })).status === 400,
    'nobody is made the tailnet owner from the app')
  const removedUser = await asPerson(PEOPLE, owner, 'POST', `/v1/tailscale/users/${pending.id}/delete`)
  check(removedUser.status === 200 && !tailscale.state.users.has(pending.id), 'an admin removes a user from the tailnet')
  const devices = (await asPerson(PEOPLE, owner, 'GET', '/v1/tailscale/devices')).json?.devices ?? []
  const laptopView = devices.find((d: any) => d.id === laptop.nodeId)
  const phoneView = devices.find((d: any) => d.id === phone.nodeId)
  check(laptopView?.online === true && laptopView.lastSeen === null && laptopView.owner === owner && laptopView.name === `laptop-${id}`
    && phoneView?.online === false && phoneView.authorized === false && phoneView.lastSeen === phone.lastSeen,
  "an admin sees the tailnet's devices, whether each is online, when it was last seen and whether it is authorized")
  const authorized = await asPerson(PEOPLE, owner, 'POST', `/v1/tailscale/devices/${phone.nodeId}/authorize`)
  const deletedDevice = await asPerson(PEOPLE, owner, 'POST', `/v1/tailscale/devices/${laptop.nodeId}/delete`)
  check(authorized.status === 200 && tailscale.state.devices.get(phone.nodeId)?.authorized === true
    && tailscale.state.calls.some((c) => c.path === `/device/${phone.nodeId}/authorized` && JSON.stringify(c.body) === '{"authorized":true}')
    && deletedDevice.status === 200 && !tailscale.state.devices.has(laptop.nodeId),
  'an admin authorizes a device and removes one through Tailscale')
  const fromConsole = { id: '77001', role: 'member', tailnetId: 12345, inviterId: 1, email: `console12-${id}@mail.test`, lastEmailSentAt: new Date(0).toISOString(), inviteUrl: 'https://login.tailscale.com/admin/invite/console' }
  tailscale.state.invites.set(fromConsole.id, fromConsole)
  const listedInvites = (await asPerson(PEOPLE, owner, 'GET', '/v1/tailscale/invites')).json?.invites ?? []
  check(listedInvites.some((i: any) => i.id === fromConsole.id && i.link === fromConsole.inviteUrl && i.lastSentAt === fromConsole.lastEmailSentAt),
    "an admin sees the tailnet's open invites, including ones made in Tailscale's console, with their links")
  const consoleResend = await asPerson(PEOPLE, owner, 'POST', `/v1/tailscale/invites/${fromConsole.id}/resend`)
  const consoleCancel = await asPerson(PEOPLE, owner, 'POST', `/v1/tailscale/invites/${fromConsole.id}/cancel`)
  check(consoleResend.status === 200 && tailscale.state.calls.some((c) => c.method === 'POST' && c.path === `/user-invites/${fromConsole.id}/resend`)
    && consoleCancel.status === 200 && !tailscale.state.invites.has(fromConsole.id),
  'an admin resends and cancels a tailnet invite')
  const ownInvite = await asPerson(PEOPLE, owner, 'POST', '/v1/invites', { email: `tsown12-${id}@mail.test`, role: 'member' })
  const ownTailscaleId: string = ownInvite.json?.invite?.tailscale_invite_id
  const cancelledThere = await asPerson(PEOPLE, owner, 'POST', `/v1/tailscale/invites/${ownTailscaleId}/cancel`)
  check(cancelledThere.status === 200 && (await row('select status from invites where email = $1', [`tsown12-${id}@mail.test`]))?.status === 'cancelled'
    && !tailscale.state.invites.has(ownTailscaleId),
  "cancelling one of the app's invites from the Tailscale page cancels it in the app too")

  // Adding a teammate to a room. The member makes a room with an agent in it.
  const personIdOf = async (login: string): Promise<string> => must(await row('select id from people where login = $1', [login]), login).id
  node('server/admin.ts', 'add-instance', team, `roombox-${id}`, 'mac', owner)
  const roomie = `roomie-${id}`
  node('server/admin.ts', 'add-agent', team, roomie, `roombox-${id}`)
  const madeRoom = await asPerson(PEOPLE, member, 'POST', '/v1/conversations', { kind: 'room', name: `room12-${id}`, people: [], agents: [roomie] })
  const roomId: string = must(madeRoom.json?.conversationId, `the room (${madeRoom.status} ${madeRoom.text})`)
  const addTo = (by: string, room: string, login: string) => asPerson(PEOPLE, by, 'POST', `/v1/conversations/${room}/members`, { login })
  const inRoom = async (room: string, personId: string) => Boolean(await row('select 1 from conversation_members where conversation_id = $1 and person_id = $2', [room, personId]))
  const [inviteeId, githubId, ownerId] = [await personIdOf(invitee), await personIdOf(github), await personIdOf(owner)]
  const byMember = await addTo(member, roomId, invitee)
  const seen = await within(10, async () => (await shapeRows(PEOPLE, invitee, 'conversation_members')).rows.some((r) => r.conversation_id === roomId && r.person_id === inviteeId))
  check(byMember.status === 200 && byMember.json?.personId === inviteeId && await inRoom(roomId, inviteeId) && seen,
    `someone in a room adds a teammate to it, and the teammate's app sees them there (${byMember.status} ${byMember.text})`)
  const twice = await addTo(member, roomId, invitee)
  check(twice.status === 409 && /already in the room/.test(twice.json?.error), `adding someone already in the room is refused (${twice.status} ${twice.text})`)
  const quiet: string = must((await asPerson(PEOPLE, member, 'POST', '/v1/conversations', { kind: 'room', name: `quiet12-${id}`, people: [], agents: [] })).json?.conversationId, 'a second room')
  await db.query(`update conversations set visibility = 'private' where id = $1`, [quiet])
  const notIn = await addTo(github, roomId, owner)
  const hidden = await addTo(github, quiet, github)
  check(notIn.status === 403 && hidden.status === 404 && !(await inRoom(roomId, ownerId)) && !(await inRoom(quiet, githubId)),
    `a member outside a room cannot add anyone to it, and a private room they are not in does not exist for them (${notIn.status}, ${hidden.status})`)
  const byAdmin = await addTo(owner, roomId, github)
  check(byAdmin.status === 200 && await inRoom(roomId, githubId) && !(await inRoom(roomId, ownerId)),
    `an admin adds a teammate to a room the admin is not in, without joining it (${byAdmin.status} ${byAdmin.text})`)
  const stranger = await addTo(member, roomId, outsider)
  const fromOutside = await addTo(outsider, roomId, outsider)
  const dm: string = must((await asPerson(PEOPLE, member, 'POST', '/v1/conversations', { kind: 'dm', agent: roomie })).json?.conversationId, 'a DM')
  const intoDm = await addTo(member, dm, invitee)
  check(stranger.status === 404 && /not on your team/.test(stranger.json?.error) && fromOutside.status === 404 && intoDm.status === 404 && !(await inRoom(dm, inviteeId)),
    `only teammates can be added, only by their team, and only to rooms (${stranger.status}, ${fromOutside.status}, ${intoDm.status})`)
  await db.query('update conversations set archived_at = now() where id = $1', [quiet])
  const intoArchived = await addTo(member, quiet, invitee)
  check(intoArchived.status === 404 && !(await inRoom(quiet, inviteeId)), `an archived room takes no one, even from someone in it (${intoArchived.status})`)
  const posted = await asPerson(PEOPLE, member, 'POST', `/v1/conversations/${roomId}/messages`, { text: 'Who is here?', clientId: `room12-${id}` })
  const prompt = await row(`select c.payload->>'text' as text from commands c join sessions s on s.id = c.session_id
    where s.conversation_id = $1 and c.kind = 'message' order by c.created_at desc limit 1`, [roomId])
  check(posted.status === 200 && [member, invitee, github].every((login) => String(prompt?.text).includes(login)) && !String(prompt?.text).includes(owner),
    `the room's agent is told who is in the room, the added teammates among them (${posted.status})`)

  // A key that expires after it was saved stops the Tailscale page without calling Tailscale.
  const briefKey = `tskey-api-k${id}BRIEF-${randomBytes(12).toString('hex')}`
  tailscale.useKey(briefKey, 3 / 86_400)
  const savedBrief = await asPerson(PEOPLE, owner, 'POST', '/v1/tailscale/key', { key: briefKey, expires: null })
  const briefEnds = Date.parse(tailscale.state.keyExpires)
  await within(10, async () => Date.now() > briefEnds)
  const callsBefore = tailscale.state.calls.length
  const lapsed = await asPerson(PEOPLE, owner, 'GET', '/v1/tailscale/users')
  check(savedBrief.status === 200 && lapsed.status === 409 && /expired on/.test(lapsed.json?.error) && /Settings, then Keys/.test(lapsed.json?.error)
    && tailscale.state.calls.length === callsBefore,
  `a key that expires after it was saved stops the tailnet routes, which say how to make a new one, without calling Tailscale (${lapsed.status} ${lapsed.text})`)
  tailscale.useKey(key, 30)
  const keyBack = await asPerson(PEOPLE, owner, 'POST', '/v1/tailscale/key', { key, expires: null })
  if (keyBack.status !== 200) throw new Error(`could not put the long-lived key back: ${keyBack.text}`)

  // Tailscale off, and set by halves.
  const off = await startApi(OFF_PORTS, { AGENTS_RUNNER: 'off', AGENTS_TAILSCALE_API: undefined, AGENTS_TAILSCALE_KEY_FILE: undefined }, join(home, 'streams-off'))
  apis.push(off)
  await within(20, () => fetch(OFF_PEOPLE).then(() => true, () => false))
  const offStatus = await asPerson(OFF_PEOPLE, owner, 'GET', '/v1/tailscale')
  const offInvite = await asPerson(OFF_PEOPLE, owner, 'POST', '/v1/invites', { email: `plain12-${id}@mail.test`, role: 'member' })
  const offResend = await asPerson(OFF_PEOPLE, owner, 'POST', `/v1/invites/${offInvite.json?.invite?.id}/resend`)
  check(offStatus.json?.state === 'off' && offInvite.status === 200 && offInvite.json.link === null && offInvite.json.invite.tailscale_invite_id === null
    && offResend.status === 409 && /not connected/.test(offResend.json?.error),
  `without Tailscale settings, Tailscale is off and invites are made in the app only (${offStatus.text} ${offInvite.status})`)

  // The Claude sign-in relay, with the check as the box's daemon. It runs against
  // the API whose runner is off, once the main API has stopped, since a runner
  // gives a box it tries to start a new token.
  await api.stop()
  const boxToken = `machine_${randomBytes(24).toString('base64url')}`
  await db.query('update instances set token_sha256 = $2 where id = $1', [ownBoxId, createHash('sha256').update(boxToken).digest('hex')])
  const { token: otherToken } = z.object({ token: z.string() }).parse(JSON.parse(node('server/admin.ts', 'add-instance', team, `other-${id}`, 'mac', owner)))
  const asBox = async (token: string, path: string, body: unknown = {}) => {
    const res = await fetch(`${OFF_MACHINES}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await res.text()
    return { status: res.status, text, json: text ? JSON.parse(text) : null }
  }
  const boxShape = async (token: string) => (await fetch(`${OFF_MACHINES}/v1/shape/claude_logins?offset=-1`, { headers: { authorization: `Bearer ${token}` } })).text()
  const signInRow = async (loginId: string) => row('select status, url, note, valid_until::text as valid_until from claude_logins where id = $1', [loginId])
  const started = await asPerson(OFF_PEOPLE, invitee, 'POST', '/v1/me/claude-login')
  const loginId: string = must(started.json?.loginId, 'the new sign-in')
  check((await signInRow(loginId))?.status === 'starting' && await within(10, async () => (await boxShape(boxToken)).includes(loginId))
    && !(await boxShape(otherToken)).includes(loginId), 'a sign-in starts on the person\'s own box, and only that box is asked to run it')
  const state = randomBytes(12).toString('hex')
  const signInLink = `https://claude.com/cai/oauth/authorize?code=true&scope=user%3Ainference&state=${state}`
  const fromOther = await asBox(otherToken, `/v1/instance/claude-logins/${loginId}/link`, { url: signInLink })
  const plain = await asBox(boxToken, `/v1/instance/claude-logins/${loginId}/link`, { url: 'http://claude.com/plain' })
  check(fromOther.status === 404 && plain.status === 400,
    `another machine cannot post the link, and a link must be https (${fromOther.status} ${fromOther.text}, ${plain.status} ${plain.text})`)
  const linked = await asBox(boxToken, `/v1/instance/claude-logins/${loginId}/link`, { url: signInLink })
  const ownView = await within(10, async () => (await shapeRows(OFF_PEOPLE, invitee, 'claude_logins')).rows.some((r) => r.id === loginId && r.url === signInLink))
  check(linked.status === 200 && (await signInRow(loginId))?.status === 'waiting_for_code' && ownView
    && !(await shapeRows(OFF_PEOPLE, member, 'claude_logins')).rows.some((r) => r.id === loginId),
  'the link the box posts reaches its owner, and nobody else')
  const code = `code${randomBytes(9).toString('hex')}#${state}`
  const stateless = await asPerson(OFF_PEOPLE, invitee, 'POST', `/v1/claude-logins/${loginId}/code`, { code: 'codewithoutstate' })
  check(stateless.status === 400 && /including the part after #/.test(stateless.json?.error)
    && (await asPerson(OFF_PEOPLE, member, 'POST', `/v1/claude-logins/${loginId}/code`, { code })).status === 404,
  'a code needs its part after #, and nobody but the owner can send one')
  const sentCode = await asPerson(OFF_PEOPLE, invitee, 'POST', `/v1/claude-logins/${loginId}/code`, { code })
  check(sentCode.status === 200 && !sentCode.text.includes(code) && (await signInRow(loginId))?.status === 'checking'
    && (await asBox(otherToken, `/v1/instance/claude-logins/${loginId}/code`)).status === 404,
  'the person sends their code, the sign-in is checking, and no other machine can take the code')
  const taken = await asBox(boxToken, `/v1/instance/claude-logins/${loginId}/code`)
  const again = await asBox(boxToken, `/v1/instance/claude-logins/${loginId}/code`)
  const back = await signInRow(loginId)
  check(taken.status === 200 && taken.json?.code === code && again.status === 410 && back?.status === 'waiting_for_code'
    && back.note === 'The server restarted before your box got your code. Paste it again.',
  'the box takes the code once; asked again, the code is gone and the person is asked to paste it again')
  await asPerson(OFF_PEOPLE, invitee, 'POST', `/v1/claude-logins/${loginId}/code`, { code })
  await asBox(boxToken, `/v1/instance/claude-logins/${loginId}/code`)
  const finished = await asBox(boxToken, `/v1/instance/claude-logins/${loginId}/done`, { validDays: 365 })
  const signedIn = await signInRow(loginId)
  const until = Date.parse(String(signedIn?.valid_until).replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'))
  check(finished.status === 200 && signedIn?.status === 'signed_in' && signedIn.note === null && Math.abs(until - (Date.now() + 365 * 86_400_000)) < 600_000,
    'the box reports it signed in, and the sign-in lasts as long as the CLI said')
  const first = must((await asPerson(OFF_PEOPLE, invitee, 'POST', '/v1/me/claude-login')).json?.loginId, 'a second sign-in')
  const second = must((await asPerson(OFF_PEOPLE, invitee, 'POST', '/v1/me/claude-login')).json?.loginId, 'a third sign-in')
  const failed = await asBox(boxToken, `/v1/instance/claude-logins/${second}/failed`, { reason: 'OAuth error: Failed to exchange authorization code for access token.' })
  check((await signInRow(first))?.status === 'cancelled' && failed.status === 200 && (await signInRow(second))?.note === 'OAuth error: Failed to exchange authorization code for access token.'
    && (await signInRow(loginId))?.status === 'signed_in', 'starting again cancels the open sign-in, a failure keeps the CLI\'s reason, and an earlier sign-in stays signed in')
  const third = must((await asPerson(OFF_PEOPLE, invitee, 'POST', '/v1/me/claude-login')).json?.loginId, 'a fourth sign-in')
  check((await asPerson(OFF_PEOPLE, invitee, 'POST', `/v1/claude-logins/${third}/cancel`)).status === 200 && (await signInRow(third))?.status === 'cancelled',
    'the person can cancel a sign-in')
  const codeInDb = await foundInDatabase(db, code)
  check(codeInDb.length === 0 && !off.text().includes(code), `the code is in no table and no log${codeInDb.length ? ` (found in ${codeInDb.join(', ')})` : ''}`)

  await off.stop()
  const half = await startApi(OFF_PORTS, { AGENTS_RUNNER: 'off', AGENTS_TAILSCALE_API: tailscale.url(TAILSCALE_PORT), AGENTS_TAILSCALE_KEY_FILE: undefined }, join(home, 'streams-half'))
  apis.push(half)
  const halfCode = await Promise.race([half.exited, new Promise<'running'>((resolve) => setTimeout(() => { resolve('running') }, 15_000))])
  check(halfCode !== 'running' && halfCode !== 0 && /AGENTS_TAILSCALE_API and AGENTS_TAILSCALE_KEY_FILE together/.test(half.text()),
    'setting only one of the two Tailscale settings stops the API when it starts, naming both')

  // The key never left its file.
  const inDb = await foundInDatabase(db, key)
  check(inDb.length === 0 && !api.text().includes(key) && !off.text().includes(key),
    `the Tailscale key is in no table and no log${inDb.length ? ` (found in ${inDb.join(', ')})` : ''}`)
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : messageOf(error)}`)
} finally {
  for (const started of apis) await started.stop()
  await tailscale.close()
  if (!failures.length) {
    await db.query('delete from teams where name = any($1)', [[team, `onboard-12x-${id}`]]).catch(() => undefined)
    await db.query('delete from join_requests where login = $1', [github]).catch(() => undefined)
    rmSync(home, { recursive: true, force: true })
  }
  await db.end().catch(() => undefined)
}

console.log(failures.length ? `\n${failures.length} failed (team ${team} kept)` : '\nall passed (test team removed)')
process.exit(failures.length ? 1 : 0)
