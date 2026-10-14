// Terminal sessions, fast. This check writes Claude Code's transcript lines
// itself, into a temp folder the daemon reads as CLAUDE_CONFIG_DIR, so it needs
// no Claude and runs in seconds. The transcript file is where Claude Code hands
// its sessions over, and everything past it is real: the daemon, the folders
// command, the API and Electric. step21 runs the real CLI.
//   node --env-file=.env --env-file=.env.test test/step21b.ts

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
// Ports 8110 to 8113 are this check's, inside step21's 8100 to 8119: machines, people, streams and a stand-in for the API.
const PORT = 8110
const API = `http://127.0.0.1:${PORT}`
const STREAMS_PORT = PORT + 2
const id = randomBytes(4).toString('hex')
const team = `local-b-${id}`
const owner = `local-b-owner-${id}@local`
// How long a line may take to reach the record. The daemon reads every second.
const LANDS_SEC = 15
// A query to the shared test database that takes longer than this fails the check, rather than holding it forever.
const QUERY_TIMEOUT_MS = 20_000
// How long the API and daemon get to stop before they are killed.
const STOP_SEC = 15
const started = Date.now()

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, query_timeout: QUERY_TIMEOUT_MS })
const children: ChildProcess[] = []
const failures: string[] = []
const logs: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

function run(name: string, script: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', (text: string) => { logs.push(`${name}: ${text}`) })
  children.push(child)
  return child
}

async function until(label: string, seconds: number, test: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(250)
  }
  console.log(`      (timed out waiting for ${label})`)
  return false
}

const count = async (sql: string, params: unknown[]) => Number((await db.query(sql, params)).rows[0].count)

// The folders command, as the person runs it on their Mac.
function folders(token: string, cwd: string, args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'CLAUDE_CONFIG_DIR'))
  const result = spawnSync(process.execPath, [join(ROOT, 'daemon', 'folders.ts'), ...args], {
    cwd, encoding: 'utf8', env: { ...base, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: join(tmpdir(), `agents-step21b-${id}-none`), ...env },
  })
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` }
}

// Claude Code names a session's transcript folder after the path it started in,
// with every character other than a letter or a digit made a dash.
const projectDir = (claudeDir: string, cwd: string) => join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))

type Call = { name: string; input: Record<string, unknown>; result: unknown }
type Turn = { prompt: string; calls?: Call[]; reply: string }

// One Claude Code session's transcript, written line by line as Claude Code writes it.
function transcript(claudeDir: string, cwd: string, startedAt: Date, session = randomUUID()) {
  const dir = projectDir(claudeDir, cwd)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${session}.jsonl`)
  const stamp = () => startedAt.toISOString()
  const line = (fields: Record<string, unknown>) => ({ parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId: session, version: '2.1.299', uuid: randomUUID(), timestamp: stamp(), ...fields })
  const write = (lines: unknown[]) => { appendFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join('')) }
  write([{ type: 'queue-operation', operation: 'enqueue', timestamp: stamp(), sessionId: session }])
  return {
    session, path, line, write,
    // A turn: the person's prompt, Claude's tool calls each with its result, and the reply that ends the turn.
    turn({ prompt, calls = [], reply }: Turn) {
      const model = 'claude-haiku-4-5'
      const lines: unknown[] = [line({ type: 'user', message: { role: 'user', content: prompt }, turnOrigin: 'human' })]
      for (const call of calls) {
        const toolUseId = `toolu_${randomBytes(12).toString('hex')}`
        lines.push(line({ type: 'assistant', message: { id: `msg_${randomBytes(8).toString('hex')}`, type: 'message', role: 'assistant', model, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: toolUseId, name: call.name, input: call.input }] } }))
        lines.push(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: call.result }] }, toolUseResult: { copy: call.result } }))
      }
      lines.push(line({ type: 'assistant', message: { id: `msg_${randomBytes(8).toString('hex')}`, type: 'message', role: 'assistant', model, stop_reason: 'end_turn', content: [{ type: 'text', text: reply }], usage: { input_tokens: 10, output_tokens: 2 } } }))
      write(lines)
    },
  }
}

const made: string[] = []
try {
  await db.connect()
  const node = (...args: string[]) => {
    const result = spawnSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`)
    return result.stdout
  }
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, owner)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', owner)) as { token: string }
  const { rows: [ownerRow] } = await db.query('select id, team_id from people where login = $1', [owner])

  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agents-step21b-')))
  made.push(root)
  const claudeDir = join(root, 'claude')
  const home = join(root, 'agents-home')
  const shop = join(root, 'shop')
  for (const dir of [claudeDir, home, shop]) mkdirSync(dir, { recursive: true })

  const api = run('api', 'server/api.ts', {
    AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'),
    AGENTS_STREAMS_PORT: String(STREAMS_PORT), AGENTS_STREAMS_DIR: join(home, 'streams'),
  })
  // Another run's API still on the port would answer too, so this one must also be alive.
  if (!await until('the API', 30, async () => api.exitCode === null && await fetch(API).then(() => true, () => false))) throw new Error('the API did not start')
  const daemonEnv = { AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home, CLAUDE_CONFIG_DIR: claudeDir }
  run('daemon', 'daemon/agentsd.ts', daemonEnv)

  const connected = folders(token, root, ['connect', shop])
  check(connected.code === 0 && connected.out.startsWith(`ok: connected ${shop}.`), `connect says ok: ${connected.out.split('\n')[0] ?? ''}`)
  const { rows: [shopFolder] } = await db.query('select id, connected_at from connected_folders where path = $1', [shop])
  const afterShop = new Date(Date.parse(must(shopFolder, 'the shop folder').connected_at) + 1000)

  const sessionOf = async (harness: string) => (await db.query('select * from sessions where harness_session_id = $1', [harness])).rows[0]
  const eventsOf = async (sessionId: string) => (await db.query(
    'select seq::int, kind, author, tool_name, tool_use_id, text, body, body::text as raw from events where session_id = $1 order by seq', [sessionId])).rows
  const turnsEnded = async (harness: string) => {
    const s = await sessionOf(harness)
    return s ? count(`select count(*) from events where session_id = $1 and kind = 'usage'`, [s.id]) : 0
  }

  // A session in the connected folder lands: the prompt as the person's, the tool call and its result, and the reply.
  const first = transcript(claudeDir, shop, afterShop)
  first.turn({ prompt: 'Read notes.txt and say the word.', calls: [{ name: 'Read', input: { file_path: join(shop, 'notes.txt') }, result: 'The word is pelican.' }], reply: 'pelican' })
  await until('the first session in the record', LANDS_SEC, async () => (await turnsEnded(first.session)) === 1)
  const firstRow = await sessionOf(first.session)
  const firstEvents = firstRow ? await eventsOf(firstRow.id) : []
  check(firstRow?.folder_id === shopFolder.id && firstRow?.status === 'idle' && firstRow?.cwd === shop,
    `a session written in the connected folder lands, idle after its turn (${String(firstRow?.status)})`)
  check(firstEvents.map((e) => e.kind).join(',') === 'user,tool_call,tool_result,assistant,usage'
    && firstEvents[0]?.author === ownerRow.id && firstEvents[2]?.text === 'The word is pelican.',
  `its prompt is the person's, then the call, its result, the reply and the turn's end: ${firstEvents.map((e) => e.kind).join(',')}`)
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  const stopped = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null
  for (const child of children) child.kill('SIGTERM')
  if (!await until('the API and daemon to stop', STOP_SEC, async () => children.every(stopped))) for (const child of children) child.kill('SIGKILL')
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team])
      .catch((error: unknown) => { console.error(`removing the test team: ${(error as Error).message}`) })
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  } else {
    console.log(`\nthe daemon and API said:\n${logs.join('').split('\n').slice(-60).join('\n')}`)
  }
  await db.end()
}

console.log(`\n${failures.length ? `${failures.length} failed (test team ${team} kept for inspection)` : 'all passed (test team removed)'} in ${Math.round((Date.now() - started) / 1000)} s`)
process.exit(failures.length ? 1 : 0)
