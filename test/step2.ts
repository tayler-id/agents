// Phase 1 step 2. Reads go through the access proxy to Electric. A viewer gets
// new rows live, sees only their team, loses a conversation the moment it turns
// private, resumes after a disconnect without losing or repeating rows, and a
// machine sees only its own queue. Token hashes never leave the server.
//   npm run check:step2

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isChangeMessage, isControlMessage, ShapeStream, type Message, type Offset, type Row } from '@electric-sql/client'
import pg from 'pg'
import { must } from './must.ts'
import { workspaces } from '../daemon/workspace.ts'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = 7791
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 100}`
// A machine's token goes to the machine port; a person's identity to the people port.
const base = (headers: Record<string, string>) => (headers.authorization ? API : PEOPLE)
const id = randomBytes(4).toString('hex')
const [teamA, teamB] = [`step2a-${id}`, `step2b-${id}`]
const [alice, amir, bea] = [`alice-${id}@local`, `amir-${id}@local`, `bea-${id}@local`]

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const streams: AbortController[] = []
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

function node(...args: string[]) {
  return execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
}

async function post(path: string, login: string, body: unknown) {
  const res = await fetch(PEOPLE + path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

async function shapeStatus(name: string, headers: Record<string, string>, params = '') {
  const res = await fetch(`${base(headers)}/v1/shape/${name}?offset=-1${params}`, { headers })
  await res.body?.cancel()
  return res.status
}

// Follows a shape and keeps its current rows, keyed the way Electric keys them.
function follow(name: string, headers: Record<string, string>, params: Record<string, string> = {}, resume?: { offset: Offset; handle: string }) {
  const abort = new AbortController()
  streams.push(abort)
  const rows = new Map<string, Row>()
  const inserts: Row[] = []
  let upToDate = false
  const stream = new ShapeStream<Row>({
    url: `${base(headers)}/v1/shape/${name}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`,
    headers, signal: abort.signal,
    offset: resume?.offset, handle: resume?.handle,
  })
  stream.subscribe((messages: Message<Row>[]) => {
    for (const m of messages) {
      if (isChangeMessage(m)) {
        if (m.headers.operation === 'delete') rows.delete(m.key)
        else rows.set(m.key, { ...(rows.get(m.key) ?? {}), ...m.value })
        if (m.headers.operation === 'insert') inserts.push(m.value)
      } else if (isControlMessage(m) && m.headers.control === 'up-to-date') {
        upToDate = true
      }
    }
  }, () => {})
  return {
    rows, inserts, stream,
    stop: () => abort.abort(),
    async until(label: string, test: () => boolean, seconds = 15) {
      const deadline = Date.now() + seconds * 1000
      while (Date.now() < deadline) {
        if (upToDate && test()) return true
        await sleep(100)
      }
      console.log(`      (gave up waiting for ${label})`)
      return false
    },
  }
}

const bodies = (rows: Iterable<Row>) => [...rows].map((r) => r.body as string)

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', teamA, alice)
  node('server/admin.ts', 'add-person', teamA, amir)
  node('server/admin.ts', 'add-team', teamB, bea)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', teamA, `mac-${id}`, 'mac', alice))
  node('server/admin.ts', 'add-agent', teamA, `helper-${id}`, `mac-${id}`)

  const apiDb = new URL(must(process.env.DATABASE_URL, 'DATABASE_URL'))
  apiDb.searchParams.set('application_name', `step2-api-${id}`)
  const api = spawn(process.execPath, ['server/api.ts'], {
    cwd: ROOT, env: { ...process.env, DATABASE_URL: apiDb.toString(), AGENTS_RUNNER_TEAMS: `${teamA},${teamB}`, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_PORT: String(PORT + 100), AGENTS_STREAMS_PORT: '7798', AGENTS_STREAMS_DIR: mkdtempSync(join(tmpdir(), 'agents-step2-')) },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  children.push(api)
  for (let i = 0; i < 40 && !(await fetch(API).then(() => true, () => false)); i++) await sleep(250)

  const as = (login: string) => ({ 'tailscale-user-login': login })
  const { conversationId } = await post('/v1/conversations', alice, { kind: 'dm', agent: `helper-${id}` })
  await post(`/v1/conversations/${conversationId}/messages`, alice, { text: 'first, before anyone watched' })

  // Live delivery.
  const watcher = follow('messages', as(alice), { conversation: conversationId })
  await watcher.until('first message', () => watcher.rows.size === 1)
  await post(`/v1/conversations/${conversationId}/messages`, alice, { text: 'second, while watched' })
  check(await watcher.until('live message', () => bodies(watcher.rows.values()).includes('second, while watched')),
    'a watcher gets the existing message, then a new one live')

  // Team isolation.
  check(await shapeStatus('messages', as(bea), `&conversation=${conversationId}`) === 404,
    "a person from another team is refused the conversation's messages")
  const beaView = follow('conversations', as(bea))
  const aliceView = follow('conversations', as(alice))
  const amirView = follow('conversations', as(amir))
  await beaView.until('bea up to date', () => true)
  await aliceView.until('alice sees the DM', () => aliceView.rows.size === 1)
  await amirView.until('amir sees the DM', () => amirView.rows.size === 1)
  check(beaView.rows.size === 0 && aliceView.rows.size === 1, 'the conversation list shows only your own team')
  check(amirView.rows.size === 1, "a teammate sees another person's DM while it is shared with the team")

  // A conversation that turns private leaves the view of anyone not in it, live.
  await db.query(`update conversations set visibility = 'private' where id = $1`, [conversationId])
  check(await amirView.until('private move-out', () => amirView.rows.size === 0),
    'when it turns private, it leaves the teammate\'s list without a reload')
  check(aliceView.rows.size === 1, 'the person in the conversation still sees it')
  check(await shapeStatus('messages', as(amir), `&conversation=${conversationId}`) === 404,
    'the teammate is now refused its messages')

  // Resume after a disconnect, from the last offset, with nothing lost or repeated.
  const before = follow('messages', as(alice), { conversation: conversationId })
  await before.until('two messages', () => before.rows.size === 2)
  const resume = { offset: before.stream.lastOffset, handle: must(before.stream.shapeHandle, 'resume') }
  before.stop()
  await post(`/v1/conversations/${conversationId}/messages`, alice, { text: 'third, while away' })
  await post(`/v1/conversations/${conversationId}/messages`, alice, { text: 'fourth, while away' })
  const after = follow('messages', as(alice), { conversation: conversationId }, resume)
  await after.until('missed messages', () => after.inserts.length >= 2)
  check(JSON.stringify(bodies(after.inserts)) === JSON.stringify(['third, while away', 'fourth, while away']),
    'a reconnecting viewer gets exactly the two messages it missed, in order')

  // A machine sees its own queue, and a claimed command leaves it.
  const queue = follow('commands', { authorization: `Bearer ${token}` })
  await queue.until('four queued commands', () => queue.rows.size === 4)
  check(queue.rows.size === 4, `the machine sees the 4 commands queued for it`)
  // The commands shape's rows, as the API defines them.
  const first = must([...queue.rows.values()][0] as { id: string } | undefined, 'a queued command')
  const claimed = await fetch(`${API}/v1/instance/commands/${first.id}/claim`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
  })
  check(claimed.ok && await queue.until('claimed command leaves', () => queue.rows.size === 3),
    'a claimed command leaves the queue')
  check(await shapeStatus('commands', as(alice)) === 404, 'a person cannot read a machine queue')
  const impostor = await fetch(`${API}/v1/shape/conversations?offset=-1`, { headers: as(alice) })
  await impostor.body?.cancel()
  check(impostor.status === 400, "the machine port refuses a person's identity, so a box cannot pose as someone")

  const snapshot = await fetch(`${PEOPLE}/v1/shape/conversations?offset=-1`, { headers: as(alice) })
  await snapshot.body?.cancel()
  const followUp = await fetch(`${PEOPLE}/v1/shape/conversations?offset=${snapshot.headers.get('electric-offset')}`
    + `&handle=${snapshot.headers.get('electric-handle')}`, { headers: as(alice) })
  await followUp.body?.cancel()
  check(snapshot.headers.get('cache-control') === 'no-store' && followUp.headers.get('cache-control') === 'no-store',
    'a snapshot and its follow-up are never kept in a browser cache')

  const instances = follow('instances', as(alice))
  await instances.until('instances', () => instances.rows.size === 1)
  const instanceRow = [...instances.rows.values()][0] ?? {}
  check(instances.rows.size === 1 && !('token_sha256' in instanceRow), 'instance rows reach people without the token hash')

  const sessions = follow('sessions', as(alice), { of: 'conversations' })
  await sessions.until('session', () => sessions.rows.size === 1)
  check(sessions.rows.size === 1, "the person in the conversation sees its agent's session")

  // A session that starts after the view opened arrives whole, for a new room and a new task alike.
  const taskSessions = follow('sessions', as(alice), { of: 'tasks' })
  await taskSessions.until('task sessions', () => true)
  const helper = must((await db.query<{ id: string }>('select id from agents where name = $1', [`helper-${id}`])).rows[0], 'the helper agent')
  const { conversationId: room } = await post('/v1/conversations', alice, { kind: 'room', name: `later-${id}`, agents: [`helper-${id}`] }) as { conversationId: string }
  await post(`/v1/conversations/${room}/messages`, alice, { text: 'Anyone here?' })
  const { taskId } = await post('/v1/tasks', alice, { title: 'Later task', instructions: 'Nothing yet.', agentId: helper.id }) as { taskId: string }
  check(await sessions.until('the new room session', () => sessions.inserts.some((r) => r.conversation_id === room && r.agent_id === helper.id))
    && await taskSessions.until('the new task session', () => taskSessions.inserts.some((r) => r.task_id === taskId && r.agent_id === helper.id)),
  'a session that starts after the view opened arrives whole, for a new room and for a new task')

  // A command's error goes into the record, so it must never carry the machine's token.
  const failedClone = await workspaces(mkdtempSync(join(tmpdir(), 'agents-step2-git-')), 'http://127.0.0.1:9', token)
    .setup({ workspaceId: randomUUID(), repos: [{ repoId: randomUUID(), name: 'shop', branch: 'task', base: 'main', setup: null }] })
    .then(() => '', (error: unknown) => (error instanceof Error ? error.message : String(error)))
  check(failedClone !== '' && !failedClone.includes(token), "a failed git command's error never carries the machine's token")
  const queued = [...queue.rows.values()][0]?.id
  const secondId = must(typeof queued === 'string' ? queued : undefined, 'a second queued command')
  const machine = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const claimedSecond = await fetch(`${API}/v1/instance/commands/${secondId}/claim`, { method: 'POST', headers: machine, body: '{}' })
  const failedCommand = await fetch(`${API}/v1/instance/commands/${secondId}`, {
    method: 'POST', headers: machine, body: JSON.stringify({ status: 'failed', error: `the forge refused Authorization: Bearer ${token}` }),
  })
  const savedError = (await db.query<{ error: string | null }>('select error from commands where id = $1', [secondId])).rows[0]?.error ?? ''
  const eventsWithToken = (await db.query<{ n: number }>(`select count(*)::int as n from events where position($1 in coalesce(text, '')) > 0`, [token])).rows[0]?.n
  check(claimedSecond.ok && failedCommand.ok && savedError !== '' && !savedError.includes(token) && eventsWithToken === 0,
    "a failed command's error reaches the record without the machine's token")

  // Postgres drops every connection when it restarts. The API keeps serving, and its runner listens again.
  const ours = `select count(*)::int as n from pg_stat_activity where application_name = $1 and query ilike 'listen%'`
  await db.query('select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1', [`step2-api-${id}`])
  await sleep(4000)
  const me = await fetch(`${PEOPLE}/v1/me`, { headers: as(alice) }).catch(() => null)
  await me?.body?.cancel()
  const relistened = (await db.query<{ n: number }>(ours, [`step2-api-${id}`])).rows[0]?.n === 1
  check(api.exitCode === null && me?.ok && relistened, 'when Postgres drops the API\'s connections, the API keeps serving and its runner listens again')

  // Started before Postgres accepts connections, as after a reboot, the API waits for it instead of exiting.
  const early = spawn(process.execPath, ['server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, DATABASE_URL: 'postgres://agents:none@127.0.0.1:1/agents_test', AGENTS_RUNNER: 'off', AGENTS_API_PORT: '7792', AGENTS_PEOPLE_PORT: '7892', AGENTS_STREAMS_PORT: '7793', AGENTS_STREAMS_DIR: mkdtempSync(join(tmpdir(), 'agents-step2-early-')) },
  })
  children.push(early)
  let earlyLog = ''
  early.stderr.on('data', (chunk: Buffer) => { earlyLog += chunk.toString() })
  await sleep(3000)
  check(early.exitCode === null && earlyLog.includes('waiting for Postgres'), 'started before Postgres accepts connections, the API waits for it instead of exiting')
  early.kill('SIGTERM')

  // A stopped API closes its stream store. Killed without that, the store's database
  // left its System V semaphores behind on macOS, until none were left for new APIs.
  api.kill('SIGTERM')
  const exited = await new Promise<boolean>((resolve) => { api.once('exit', () => { resolve(true) }); setTimeout(() => { resolve(false) }, 8000) })
  check(exited && api.exitCode === 0, 'an API asked to stop closes its stream store and exits cleanly')
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  for (const stream of streams) stream.abort()
  for (const child of children) child.kill('SIGTERM')
  if (!failures.length) await db.query('delete from teams where name = any($1)', [[teamA, teamB]]).catch(() => {})
  await db.end()
}

console.log(`\n${failures.length ? `${failures.length} failed (teams ${teamA}, ${teamB} kept)` : 'all passed (test teams removed)'}`)
process.exit(failures.length ? 1 : 0)
