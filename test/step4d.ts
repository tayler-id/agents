// Phase 1 step 4, resilience. A daemon started before the API waits for it, comes
// online when the API starts, comes back after the API restarts, and still takes
// work afterwards.
//   npm run check:step4d

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = 7805
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 100}`
const id = randomBytes(4).toString('hex')
const team = `step4d-${id}`
const login = `res-${id}@local`

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

function node(...args: string[]) {
  return execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
}

async function within(seconds: number, test: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(300)
  }
  return false
}

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, login)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  const { agentId } = JSON.parse(node('server/admin.ts', 'add-agent', team, `res-agent-${id}`, `mac-${id}`, 'haiku', 'Reply in one word.'))
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step4d-')))
  mkdirSync(join(home, 'agents', agentId), { recursive: true })
  const env = { ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'), AGENTS_STREAMS_PORT: '7806', AGENTS_STREAMS_DIR: join(home, 'streams') }
  await servePeople(PORT + 100, join(home, 'people.sock'))
  const startApi = () => {
    const api = spawn(process.execPath, ['server/api.ts'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] })
    children.push(api)
    return api
  }
  const online = () => within(40, async () =>
    (await db.query(`select 1 from instances where name = $1 and status = 'online' and last_seen_at > now() - interval '20 seconds'`, [`mac-${id}`])).rows.length > 0)

  const daemon = spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home }, stdio: ['ignore', 'ignore', 'ignore'],
  })
  children.push(daemon)
  await sleep(3000)
  check(daemon.exitCode === null, 'a daemon started before the API keeps running')

  let api = startApi()
  check(await online(), 'it comes online once the API starts')

  api.kill('SIGTERM')
  await within(10, async () => api.exitCode !== null)
  await db.query(`update instances set status = 'offline', last_seen_at = now() - interval '1 hour' where name = $1`, [`mac-${id}`])
  await sleep(2000)
  api = startApi()
  check(await online() && daemon.exitCode === null, 'it comes back after the API restarts')

  const res = await fetch(`${PEOPLE}/v1/conversations`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login },
    body: JSON.stringify({ kind: 'dm', agent: `res-agent-${id}` }),
  })
  const { conversationId } = await res.json()
  await fetch(`${PEOPLE}/v1/conversations/${conversationId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login },
    body: JSON.stringify({ text: 'Say ready.' }),
  })
  check(await within(120, async () => (await db.query(
    `select 1 from messages where conversation_id = $1 and speaker = 'agent'`, [conversationId])).rows.length > 0),
  'after the restart it still takes work and the agent answers')
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) await db.query('delete from teams where name = $1', [team]).catch(() => {})
  await db.end().catch(() => {})
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test team removed)'}`)
process.exit(failures.length ? 1 : 0)
