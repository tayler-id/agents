// WebMCP in agents' browsers, build step 21, the team's list of sites, over the
// API alone, with no box. An admin lists a site for the team, and a member can read
// the list and cannot change it. A site that is not a scheme and a host is refused
// with the reason, a site written in capitals or with a slash after the host is
// kept in one form, and a person on another team sees none of it and cannot remove
// a site. A team lists 50 sites at most, even when twelve admins list one each at
// the same moment, and an admin takes a site off the list.
// It uses its own ports, so it holds no run lock.
//   node --env-file=.env --env-file=.env.test test/step21wa.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { z } from 'zod'
import { messageOf } from '../shared/errors.ts'
import { must } from './must.ts'
import { ROOT, within, peopleSocket, stopAll } from './computers.ts'
import { servePeople } from './people.ts'

const API_PORT = 8178
const PEOPLE_PORT = 8179
const STREAMS_PORT = 8180
const API = `http://127.0.0.1:${API_PORT}`
const PEOPLE = `http://127.0.0.1:${PEOPLE_PORT}`
const id = randomBytes(4).toString('hex')
const team = `webmcp-api-${id}`
const otherTeam = `webmcp-api-other-${id}`
const alice = `alice-webmcp-api-${id}@local`
const bob = `bob-webmcp-api-${id}@local`
const carol = `carol-webmcp-api-${id}@local`
const work = join(homedir(), '.agents-app', 'checks', `webmcp-api-${id}`)
const SITE = 'http://127.0.0.1:8731'
const OTHER_SITE = 'http://127.0.0.1:8732'

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', '--env-file=.env.test', ...args], { cwd: ROOT, encoding: 'utf8' })

async function people(login: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(PEOPLE + path, {
    method, headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const OriginList = z.object({ origins: z.array(z.object({ id: z.string(), origin: z.string(), addedBy: z.string().nullable() })) })
const origins = async (login: string) => OriginList.safeParse((await people(login, 'GET', '/v1/team/webmcp-origins')).json).data?.origins ?? []

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  await db.connect()
  mkdirSync(work, { recursive: true })
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, alice)
  node('server/admin.ts', 'add-person', team, bob)
  node('server/admin.ts', 'add-team', otherTeam, carol)
  const { id: teamId } = must((await db.query('select id from teams where name = $1', [team])).rows[0], 'team')
  children.push(spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env, AGENTS_RUNNER_TEAMS: `${team},${otherTeam}`, AGENTS_API_PORT: String(API_PORT), AGENTS_PEOPLE_SOCKET: peopleSocket(work),
      AGENTS_STREAMS_PORT: String(STREAMS_PORT), AGENTS_STREAMS_DIR: join(work, 'streams'),
    },
  }))
  await servePeople(PEOPLE_PORT, peopleSocket(work))
  await within(20, () => fetch(API).then(() => true, () => false))

  check((await origins(alice)).length === 0, 'a team that has listed nothing has an empty list')
  const listed = await people(alice, 'POST', '/v1/team/webmcp-origins', { origin: SITE })
  check(listed.status === 200 && listed.json?.origins?.length === 1 && listed.json.origins[0].origin === SITE && listed.json.origins[0].addedBy === alice,
    `an admin lists a site for the team, and the list says who did (${listed.status})`)
  const memberAdd = await people(bob, 'POST', '/v1/team/webmcp-origins', { origin: OTHER_SITE })
  check(memberAdd.status === 403 && (await origins(bob)).length === 1, `a member cannot list a site (${memberAdd.status}), and can read the list`)
  const refused: string[] = []
  for (const bad of ['javascript:alert(1)', 'http://example.com/path', 'http://*.example.com', 'ftp://example.com', 'http://127.0.0.1:99999', 'https://', 'example.com', 'http://127.1', 'http://user@example.com']) {
    const answer = await people(alice, 'POST', '/v1/team/webmcp-origins', { origin: bad })
    if (answer.status !== 400) refused.push(`${bad} (${answer.status})`)
  }
  check(refused.length === 0 && (await origins(alice)).length === 1, `a site that is not a scheme and a host is refused (not refused: ${refused.join(', ') || 'none'})`)
  const again = await people(alice, 'POST', '/v1/team/webmcp-origins', { origin: SITE.replace('http://', 'HTTP://') })
  check(again.status === 200 && again.json?.origins?.length === 1, 'listing a site again, in capitals, keeps one row')
  const slash = await people(alice, 'POST', '/v1/team/webmcp-origins', { origin: 'https://slash.test/' })
  const slashRow = (await origins(alice)).find((site) => site.origin === 'https://slash.test')
  check(slash.status === 200 && slashRow !== undefined, 'a site pasted with one slash after the host is listed without it')
  if (slashRow) await people(alice, 'POST', `/v1/team/webmcp-origins/${slashRow.id}/delete`, {})
  const strangerRead = await origins(carol)
  const strangerRemove = await people(carol, 'POST', `/v1/team/webmcp-origins/${(await origins(alice))[0]?.id ?? ''}/delete`, {})
  check(strangerRead.length === 0 && strangerRemove.status === 404 && (await origins(alice)).length === 1,
    "a person on another team sees no sites, and cannot remove this team's")
  // The limit. Forty more sites make 41, and twelve admins listing one each at once fill the list to 50 and no further.
  for (let n = 0; n < 40; n++) await people(alice, 'POST', '/v1/team/webmcp-origins', { origin: `https://site-${n}.test` })
  const together = await Promise.all(Array.from({ length: 12 }, (_, n) => people(alice, 'POST', '/v1/team/webmcp-origins', { origin: `https://at-once-${n}.test` })))
  const listedAtOnce = together.filter((answer) => answer.status === 200).length
  const refusedAtOnce = together.filter((answer) => answer.status === 409).length
  check(listedAtOnce === 9 && refusedAtOnce === 3 && (await origins(alice)).length === 50,
    `twelve sites listed at once on a list of 41 stop at 50 (${listedAtOnce} listed, ${refusedAtOnce} refused)`)
  const full = await people(alice, 'POST', '/v1/team/webmcp-origins', { origin: 'https://one-too-many.test' })
  check(full.status === 409 && (await origins(alice)).length === 50, `a team lists 50 sites at most (the next got ${full.status})`)
  await db.query(`delete from webmcp_origins where team_id = $1 and (origin like 'https://site-%' or origin like 'https://at-once-%')`, [teamId])
  await people(alice, 'POST', `/v1/team/webmcp-origins/${(await origins(alice))[0]?.id ?? 'none'}/delete`, {})
  check(listed.status === 200 && (await origins(alice)).length === 0, 'an admin takes a site off the list')
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack : messageOf(error)}`)
} finally {
  await stopAll(children)
  if (!failures.length) {
    await db.query('delete from teams where name = any($1)', [[team, otherTeam]]).catch(() => undefined)
    rmSync(work, { recursive: true, force: true })
  }
  await db.end().catch(() => undefined)
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test teams removed)'}`)
process.exit(failures.length ? 1 : 0)
