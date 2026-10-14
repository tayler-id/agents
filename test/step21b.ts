// Terminal sessions, fast. This check writes Claude Code's transcript lines
// itself, into a temp folder the daemon reads as CLAUDE_CONFIG_DIR, so it needs
// no Claude and runs in seconds. The transcript file is where Claude Code hands
// its sessions over, and everything past it is real: the daemon, the folders
// command, the API and Electric. step21 runs the real CLI.
//   node --env-file=.env --env-file=.env.test test/step21b.ts

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { z } from 'zod'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
// Ports 8110 to 8113 are this check's, inside step21's 8100 to 8119: machines, people, streams and a stand-in for the API.
const PORT = 8110
const API = `http://127.0.0.1:${PORT}`
const STREAMS_PORT = PORT + 2
const id = randomBytes(4).toString('hex')
const team = `local-b-${id}`
const owner = `local-b-owner-${id}@local`
// Values that must never reach the record, each in one place on the Mac.
const secret = () => randomBytes(18).toString('base64url')
const nested = secret()
const [redisPassword, mongoPassword, smtpPassword] = [secret(), secret(), secret()]
const folderWord = secret()
const sessionWord = secret()
const phrase = secret()
// What a file outside the connected folder holds, which must stay on the Mac.
const outsideWord = secret()
const pdf = randomBytes(600).toString('base64')
const githubToken = `ghp_${randomBytes(27).toString('hex').slice(0, 36)}`
// How long a line may take to reach the record. The daemon reads every second.
const LANDS_SEC = 15
// A query to the shared test database that takes longer than this fails the check, rather than holding it forever.
const QUERY_TIMEOUT_MS = 20_000
// How long the API and daemon get to stop before they are killed.
const STOP_SEC = 15
const started = Date.now()

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, query_timeout: QUERY_TIMEOUT_MS })
const children: ChildProcess[] = []
// Servers the check holds open, such as one that keeps a socket's file in a folder.
const servers: Server[] = []
const failures: string[] = []
const logs: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

function run(name: string, script: string, env: Record<string, string>, execArgv: string[] = []) {
  const child = spawn(process.execPath, [...execArgv, script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
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
// Whether one line of the daemon's own log holds every one of these.
const daemonSaid = (...parts: string[]) => logs.filter((l) => l.startsWith('daemon: ')).map((l) => l.slice('daemon: '.length)).join('')
  .split('\n').some((line) => parts.every((part) => line.includes(part)))

// The folders command, as the person runs it on their Mac.
// An env value of undefined takes the variable out.
function folders(token: string, cwd: string, args: string[], env: Record<string, string | undefined> = {}): { code: number; out: string } {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'CLAUDE_CONFIG_DIR'))
  const merged: Record<string, string | undefined> = { ...base, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: join(tmpdir(), `agents-step21b-${id}-none`), ...env }
  const result = spawnSync(process.execPath, [join(ROOT, 'daemon', 'folders.ts'), ...args], {
    cwd, encoding: 'utf8', env: Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  })
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` }
}

async function machine(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(API + path, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) as unknown }
}

// Claude Code names a session's transcript folder after the path it started in,
// with every character other than a letter or a digit made a dash.
const projectDir = (claudeDir: string, cwd: string) => join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))

type Call = { name: string; input: Record<string, unknown>; result: unknown }
// promptFields go on the prompt's line, as a Claude Code update might write them.
type Turn = { prompt: string; calls?: Call[]; reply: string; promptFields?: Record<string, unknown> }

// One Claude Code session's transcript, written line by line as Claude Code writes it.
function transcript(claudeDir: string, cwd: string, startedAt: Date, session: string = randomUUID()) {
  const dir = projectDir(claudeDir, cwd)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${session}.jsonl`)
  const stamp = () => startedAt.toISOString()
  const line = (fields: Record<string, unknown>) => ({ parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId: session, version: '2.1.299', uuid: randomUUID(), timestamp: stamp(), ...fields })
  const write = (lines: unknown[]) => { appendFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join('')) }
  const head = { type: 'queue-operation', operation: 'enqueue', timestamp: stamp(), sessionId: session }
  write([head])
  const model = 'claude-haiku-4-5'
  const messageId = () => `msg_${randomBytes(8).toString('hex')}`
  // A tool call, the result that answers it, and the reply that ends a turn, each as the line Claude Code writes.
  const callLine = (toolUseId: string, name: string, input: Record<string, unknown>) =>
    line({ type: 'assistant', message: { id: messageId(), type: 'message', role: 'assistant', model, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: toolUseId, name, input }] } })
  const resultLine = (toolUseId: string, result: unknown) =>
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: result }] }, toolUseResult: { copy: result } })
  const replyLine = (reply: string) =>
    line({ type: 'assistant', message: { id: messageId(), type: 'message', role: 'assistant', model, stop_reason: 'end_turn', content: [{ type: 'text', text: reply }], usage: { input_tokens: 10, output_tokens: 2 } } })
  const newToolUseId = () => `toolu_${randomBytes(12).toString('hex')}`
  return {
    session, path, line, write, head,
    // A turn: the person's prompt, Claude's tool calls each with its result, and the reply that ends the turn.
    turn({ prompt, calls = [], reply, promptFields = {} }: Turn) {
      const lines: unknown[] = [line({ type: 'user', message: { role: 'user', content: prompt }, turnOrigin: 'human', ...promptFields })]
      for (const call of calls) {
        const toolUseId = newToolUseId()
        lines.push(callLine(toolUseId, call.name, call.input), resultLine(toolUseId, call.result))
      }
      lines.push(replyLine(reply))
      write(lines)
      return lines
    },
    // A tool call on its own, for a result that comes later. It returns the call's id.
    call(name: string, input: Record<string, unknown>) {
      const toolUseId = newToolUseId()
      write([callLine(toolUseId, name, input)])
      return toolUseId
    },
    // The result of a call made earlier, and the reply that ends the turn.
    finish(toolUseId: string, result: unknown, reply: string) {
      write([resultLine(toolUseId, result), replyLine(reply)])
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
  node('server/admin.ts', 'add-instance', team, `box-${id}`, 'box', owner)
  const { rows: [ownerRow] } = await db.query('select id, team_id from people where login = $1', [owner])

  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agents-step21b-')))
  made.push(root)
  const claudeDir = join(root, 'claude')
  const home = join(root, 'agents-home')
  // Long enough that the project name a .env file gives it counts as a secret's length.
  const shop = join(root, `shop-${id}`)
  const zdot = join(root, 'zdot')
  const diary = join(root, 'diary')
  const journal = join(root, 'journal')
  // The shortest connected path, so the daemon reads this folder last in each read.
  const last = join(root, 'z')
  // The longest connected path, so the daemon reads this folder first in each read.
  const deep = join(root, 'the-folder-with-the-longest-path-so-the-daemon-reads-it-first')
  const cased = join(root, 'cased-folder')
  const skewed = join(root, 'skewed')
  // A folder beside the connected one, with a file in it that must stay on the Mac, and a link to it from inside.
  const elsewhere = join(root, 'elsewhere')
  for (const dir of [claudeDir, home, zdot, diary, journal, last, deep, cased, skewed, elsewhere, join(shop, 'apps', 'api'), join(shop, 'data'), join(shop, folderWord)]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(elsewhere, 'notes.txt'), `The word is ${outsideWord}.\n`)
  symlinkSync(elsewhere, join(shop, 'linked'))
  // The person's login shell exports a value the daemon's own environment lacks, as ~/.zshrc does.
  writeFileSync(join(zdot, '.zshrc'), `export DEPLOY_PHRASE=${phrase}\necho this line is what a .zshrc prints\n`)
  // Secrets under names no name filter catches, beside values that are not secrets: the folder's own name and a path.
  const shopEnv = [
    `COMPOSE_PROJECT_NAME=shop-${id}`, `REDIS_URL=redis://:${redisPassword}@localhost:6379/0`,
    `MONGODB_URI=mongodb://app:${mongoPassword}@db.internal:27017/app`, `SMTP_PASS=${smtpPassword}`,
    `FOLDER_TOKEN=${folderWord}`, `SESSION_TOKEN=${sessionWord}`, `DATA_DIR=${join(shop, 'data')}`,
  ].join('\n')
  writeFileSync(join(shop, '.env'), `${shopEnv}\n`)
  // A .env file deeper than any session's start, as a repo's apps/api/.env is.
  writeFileSync(join(shop, 'apps', 'api', '.env'), `NESTED_KEY=${nested}\n`)

  const api = run('api', 'server/api.ts', {
    AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'),
    AGENTS_STREAMS_PORT: String(STREAMS_PORT), AGENTS_STREAMS_DIR: join(home, 'streams'),
  })
  // Another run's API still on the port would answer too, so this one must also be alive.
  if (!await until('the API', 30, async () => api.exitCode === null && await fetch(API).then(() => true, () => false))) throw new Error('the API did not start')
  const daemonEnv = { AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home, CLAUDE_CONFIG_DIR: claudeDir, SHELL: '/bin/zsh', ZDOTDIR: zdot }
  // The daemon runs with test/read-meter.ts loaded, which writes how much it read, so the check can say how much that was.
  const meter = join(root, 'read-meter.json')
  const startDaemon = (env: Record<string, string> = daemonEnv) =>
    run('daemon', 'daemon/agentsd.ts', { ...env, AGENTS_READ_METER: meter }, ['--import', join(ROOT, 'test', 'read-meter.ts')])
  let daemon = startDaemon()
  const stopDaemon = async () => {
    daemon.kill('SIGTERM')
    if (!await until('the daemon to stop', STOP_SEC, async () => daemon.exitCode !== null || daemon.signalCode !== null)) throw new Error('the daemon did not stop')
  }
  const restart = async (env: Record<string, string> = daemonEnv) => {
    await stopDaemon()
    daemon = startDaemon(env)
  }
  // What the daemon has read, from a write of the meter that follows this call. It writes five times a second.
  const Meter = z.object({ reads: z.record(z.string(), z.number()), largest: z.number(), cpuMs: z.number() })
  const meterAfter = async () => {
    const after = Date.now()
    await until('the meter to write', 5, async () => existsSync(meter) && statSync(meter).mtimeMs > after)
    return Meter.parse(JSON.parse(readFileSync(meter, 'utf8')))
  }

  const connected = folders(token, root, ['connect', shop])
  check(connected.code === 0 && connected.out.startsWith(`ok: connected ${shop}.`), `connect says ok: ${connected.out.split('\n')[0] ?? ''}`)
  const { rows: [shopFolder] } = await db.query('select id, connected_at from connected_folders where path = $1', [shop])
  // Sessions start as their folder is connected, so a folder connected again a moment later is newer than every one of them.
  const afterShop = new Date(must(shopFolder, 'the shop folder').connected_at)

  const sessionOf = async (harness: string) => (await db.query('select * from sessions where harness_session_id = $1', [harness])).rows[0]
  const eventsOf = async (sessionId: string) => (await db.query(
    'select seq::int, kind, author, tool_name, tool_use_id, client_id, text, body, body::text as raw from events where session_id = $1 order by seq', [sessionId])).rows
  const turnsEnded = async (harness: string) => {
    const s = await sessionOf(harness)
    return s ? count(`select count(*) from events where session_id = $1 and kind = 'usage'`, [s.id]) : 0
  }
  // The events of a Claude Code session, none until the record has the session.
  const eventsOfHarness = async (harness: string) => {
    const s = await sessionOf(harness)
    return s ? eventsOf(s.id) : []
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

  // Esc ends a turn with no reply. The record keeps a notice the terminal page draws as Interrupted, and the session is idle.
  const escaped = transcript(claudeDir, shop, afterShop)
  escaped.write([
    escaped.line({ type: 'user', message: { role: 'user', content: 'Count to a million.' }, turnOrigin: 'human' }),
    escaped.line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
  ])
  await until('the interrupted session', LANDS_SEC, async () => (await eventsOfHarness(escaped.session)).length >= 2)
  const stop = (await eventsOfHarness(escaped.session)).find((e) => e.kind === 'notice')
  check(stop?.body.subtype === 'interrupted' && stop.text === '[Request interrupted by user]' && (await sessionOf(escaped.session))?.status === 'idle',
    `a turn stopped with Esc is a notice with the subtype the terminal page draws as Interrupted, and the session is idle: ${JSON.stringify(stop?.body)}`)

  // What a machine may write into a terminal session: the person's prompts, as theirs, and what Claude did, but never an ask
  // or an answer, since the person gives those in their terminal.
  const ruled = transcript(claudeDir, shop, afterShop)
  ruled.turn({ prompt: 'A session to post into.', reply: 'Ready.' })
  await until('the session to post into', LANDS_SEC, async () => (await turnsEnded(ruled.session)) === 1)
  const ruledId = String((await sessionOf(ruled.session))?.id)
  const postKind = (kind: string) => machine(token, 'POST', `/v1/sessions/${ruledId}/events`, { events: [{ clientId: `${kind}-${id}`, kind, text: kind, body: {} }] })
  const refusedKinds = [(await postKind('ask')).status, (await postKind('answer')).status]
  const takenKinds = [(await postKind('user')).status, (await postKind('notice')).status]
  const writers = (await eventsOf(ruledId)).filter((e) => e.client_id === `user-${id}` || e.client_id === `notice-${id}`)
  check(refusedKinds.join() === '400,400' && takenKinds.join() === '200,200'
    && writers.find((e) => e.kind === 'user')?.author === ownerRow.id && writers.find((e) => e.kind === 'notice')?.author === null,
  `a machine's ask and answer for a terminal session are refused (${refusedKinds.join()}), and its user event is authored as the person where its notice is not (${takenKinds.join()})`)

  // A block with a field of the wrong type, as a Claude Code update might write one, is a notice that keeps the block as written.
  // The turns around it land, where a tool call with a number for its id would have had the whole post refused.
  const wrongBlocks = [
    { type: 'text', text: 5 },
    { type: 'tool_use', id: 7, name: 'Read', input: {} },
    { type: 'tool_result', tool_use_id: 7, content: 'a result for a call with a number for its id' },
  ]
  const wrongRun = transcript(claudeDir, shop, afterShop)
  wrongRun.write([
    wrongRun.line({ type: 'user', message: { role: 'user', content: 'Call a tool whose id is a number.' }, turnOrigin: 'human' }),
    wrongRun.line({ type: 'assistant', message: { id: 'msg_wrong', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'tool_use', content: wrongBlocks.slice(0, 2) } }),
    wrongRun.line({ type: 'user', message: { role: 'user', content: wrongBlocks.slice(2) } }),
  ])
  wrongRun.turn({ prompt: 'And a normal one.', reply: 'Done.' })
  const wrongLanded = await until('the session with blocks of the wrong type', LANDS_SEC, async () => (await turnsEnded(wrongRun.session)) === 1)
  const wrongNotices = (await eventsOfHarness(wrongRun.session)).filter((e) => e.kind === 'notice')
  check(wrongLanded && isDeepStrictEqual(wrongNotices.map((e) => e.body.block), wrongBlocks),
    `a text block, a tool call and a tool result with a field of the wrong type are notices holding the block as written, and the turns around them land (${wrongNotices.length} notices)`)

  // A tool result for a path outside the connected folder stays on the Mac, as a note. The path may be absolute, climb
  // out with .., start with ~, be relative to the session's folder, or run through a link inside the connected folder.
  const NOTE = 'A result for a path outside the connected folder stays on the Mac.'
  const resultTexts = async (harness: string) => (await eventsOfHarness(harness)).filter((e) => e.kind === 'tool_result').map((e) => String(e.text))
  // How many events and raw lines of a Claude Code session hold the word.
  const recordHolds = async (harness: string, word: string) => {
    const s = await sessionOf(harness)
    return s ? count(
      `select (select count(*) from events where session_id = $1 and (body::text like $2 or coalesce(text, '') like $2))
            + (select count(*) from raw_events where session_id = $1 and line::text like $2) as count`,
      [s.id, `%${word}%`]) : 0
  }
  const notes = `The word is ${outsideWord}.`
  const outside = transcript(claudeDir, shop, afterShop)
  outside.turn({ prompt: 'Read the notes beside this folder, and one inside it.', calls: [
    { name: 'Read', input: { file_path: join(elsewhere, 'notes.txt') }, result: notes },
    { name: 'Read', input: { file_path: `${shop}/../elsewhere/notes.txt` }, result: notes },
    { name: 'Grep', input: { pattern: 'word', path: '../elsewhere' }, result: notes },
    { name: 'Read', input: { file_path: `~/agents-step21b-${id}-nothing-here.txt` }, result: notes },
    { name: 'Read', input: { file_path: join(shop, 'notes.txt') }, result: 'The word is pelican.' },
  ], reply: 'Done.' })
  await until('the session that read outside the folder', LANDS_SEC, async () => (await turnsEnded(outside.session)) === 1)
  check((await resultTexts(outside.session)).join('|') === [NOTE, NOTE, NOTE, NOTE, 'The word is pelican.'].join('|') && await recordHolds(outside.session, outsideWord) === 0,
    `results for paths outside the folder stay on the Mac whether the path is absolute, climbs out with .., is relative to the cwd or starts with ~, and a result inside lands: ${(await resultTexts(outside.session)).length} results`)

  // A relative path starts at the session's own folder, here one inside the connected folder, so it can stay in or leave.
  const inner = transcript(claudeDir, join(shop, 'apps', 'api'), afterShop)
  inner.turn({ prompt: 'Read relative to this folder.', calls: [
    { name: 'Read', input: { file_path: '../../notes.txt' }, result: 'The word is pelican.' },
    { name: 'Grep', input: { pattern: 'word', path: '../../../elsewhere' }, result: notes },
  ], reply: 'Done.' })
  await until('the session in a folder inside the connected one', LANDS_SEC, async () => (await turnsEnded(inner.session)) === 1)
  check((await resultTexts(inner.session)).join('|') === ['The word is pelican.', NOTE].join('|') && await recordHolds(inner.session, outsideWord) === 0,
    'a relative path starts at the session\'s own folder, so one that stays inside the connected folder lands and one that leaves it does not')

  const linked = transcript(claudeDir, shop, afterShop)
  linked.turn({ prompt: 'Read the notes through the link.', calls: [{ name: 'Read', input: { file_path: join(shop, 'linked', 'notes.txt') }, result: notes }], reply: 'Done.' })
  await until('the session that read through a link', LANDS_SEC, async () => (await turnsEnded(linked.session)) === 1)
  check((await resultTexts(linked.session)).join('|') === NOTE && await recordHolds(linked.session, outsideWord) === 0,
    'a result for a path that runs through a link inside the folder to a file outside stays on the Mac')

  // The result can come after the daemon restarted, so what it withholds is kept with the offset.
  const slow = transcript(claudeDir, shop, afterShop)
  slow.write([slow.line({ type: 'user', message: { role: 'user', content: 'Read the notes, slowly.' }, turnOrigin: 'human' })])
  const slowCall = slow.call('Read', { file_path: join(elsewhere, 'notes.txt') })
  await until('the call made before the restart', LANDS_SEC, async () => (await eventsOfHarness(slow.session)).some((e) => e.kind === 'tool_call'))
  await restart()
  slow.finish(slowCall, notes, 'Done.')
  await until('the turn that finished after the restart', LANDS_SEC, async () => (await turnsEnded(slow.session)) === 1)
  check((await resultTexts(slow.session)).join('|') === NOTE && await recordHolds(slow.session, outsideWord) === 0,
    'a result for a path outside the folder that arrives after the daemon restarted stays on the Mac')

  // Secrets: a nested .env, values under any name, a PDF, a folder and a session named with a secret, and the login shell's.
  const secrets = transcript(claudeDir, shop, afterShop)
  secrets.turn({ prompt: 'Read the config files and the report.', calls: [
    { name: 'Read', input: { file_path: join(shop, 'apps', 'api', '.env') }, result: `NESTED_KEY=${nested}\n` },
    { name: 'Read', input: { file_path: join(shop, '.env') }, result: shopEnv },
    { name: 'Read', input: { file_path: join(shop, 'report.pdf') }, result: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } }] },
    { name: 'Bash', input: { command: 'echo $DEPLOY_PHRASE' }, result: `${phrase}\n` },
    { name: 'Read', input: { file_path: join(shop, 'data', 'rows.csv') }, result: 'a,b\n1,2\n' },
  ], reply: 'Done.' })
  const inSecretFolder = transcript(claudeDir, join(shop, folderWord), afterShop)
  inSecretFolder.turn({ prompt: 'Say hi.', reply: 'hi' })
  const secretId = transcript(claudeDir, shop, afterShop, sessionWord)
  secretId.turn({ prompt: 'Say hello.', reply: 'hello' })
  const bySecretId = async () => (await db.query('select * from sessions where folder_id = $1 and harness_session_id = any($2)',
    [shopFolder.id, [sessionWord, '[secret:SESSION_TOKEN]']])).rows[0]
  await until('the sessions with secrets in the record', LANDS_SEC, async () =>
    (await turnsEnded(secrets.session)) === 1 && (await turnsEnded(inSecretFolder.session)) === 1 && Boolean(await bySecretId()))
  const secretsRow = await sessionOf(secrets.session)
  const secretsEvents = secretsRow ? await eventsOf(secretsRow.id) : []
  const results = secretsEvents.filter((e) => e.kind === 'tool_result')
  const leaks = await count(
    `select (select count(*) from events where team_id = $1 and (body::text like any($2) or coalesce(text, '') like any($2)))
          + (select count(*) from raw_events r join sessions s on s.id = r.session_id where s.team_id = $1 and r.line::text like any($2))
          + (select count(*) from sessions where team_id = $1 and (cwd like any($2) or harness_session_id like any($2))) as count`,
    [ownerRow.team_id, [nested, redisPassword, mongoPassword, smtpPassword, folderWord, sessionWord, phrase, pdf.slice(100, 140)].map((v) => `%${v}%`)])
  check(leaks === 0, 'no event, raw line or session row holds any of the secrets')
  check(results[0]?.text === 'NESTED_KEY=[secret:NESTED_KEY]\n', `a value only apps/api/.env holds, read from a session at the folder's root, shows as its name: ${String(results[0]?.text)}`)
  check(['[secret:REDIS_URL]', '[secret:MONGODB_URI]', '[secret:SMTP_PASS]'].every((name) => String(results[1]?.text).includes(name)),
    'REDIS_URL with a password, MONGODB_URI and SMTP_PASS from the .env are scrubbed, whatever their names')
  check(results[2]?.raw.includes('Files stay on the Mac.'), 'a PDF Claude read reaches the record as a note that it stayed on the Mac')
  check(results[3]?.text === '[secret:DEPLOY_PHRASE]\n', `a value only the login shell exports shows as its name: ${String(results[3]?.text)}`)
  check(secretsEvents.some((e) => e.kind === 'tool_call' && e.text === `Read ${join(shop, 'data', 'rows.csv')}`) && secretsRow?.cwd === shop,
    "a .env value that is a path on the Mac, or part of the folder's own path, is left alone, so the session's cwd is the folder")
  const secretFolderRow = await sessionOf(inSecretFolder.session)
  check(secretFolderRow?.cwd === join(shop, '[secret:FOLDER_TOKEN]'), `a folder named with a .env value shows in the cwd as its name: ${String(secretFolderRow?.cwd)}`)
  check((await bySecretId())?.harness_session_id === '[secret:SESSION_TOKEN]', 'a session id holding a .env value shows as its name')
  const direct = await machine(token, 'POST', '/v1/instance/terminal-sessions',
    { folderId: shopFolder.id, harnessSessionId: githubToken, cwd: join(shop, githubToken) })
  const directRow = (await db.query('select cwd, harness_session_id from sessions where id = $1', [String((direct.body as { sessionId?: string } | null)?.sessionId)])).rows[0]
  check(direct.status === 200 && directRow?.cwd === join(shop, '[secret:github]') && directRow?.harness_session_id === '[secret:github]',
    `the API scrubs a key-shaped token from the cwd and the session id it is given (${direct.status})`)

  // A daemon that can't read the login shell can't scrub its secrets, so it sends no terminal session.
  await restart({ ...daemonEnv, SHELL: join(root, 'no-such-shell') })
  const unshelled = transcript(claudeDir, shop, afterShop)
  unshelled.turn({ prompt: 'Say yes.', reply: 'yes' })
  const said = await until('the daemon to say the shell failed', LANDS_SEC, async () => logs.join('').includes('Terminal sessions are not sent'))
  // A bounded wait for what must not happen: sessions land within about two seconds when the daemon sends.
  const sentAnyway = await until('a session it should not send', 5, async () => Boolean(await sessionOf(unshelled.session)))
  check(said && !sentAnyway, 'a daemon that cannot read the login shell says so and sends no terminal session')
  await restart()
  check(await until('the held session after a restart', LANDS_SEC, async () => (await turnsEnded(unshelled.session)) === 1),
    'the daemon started again with a working shell sends the session it held')

  // Who sees a folder's sessions: connecting again keeps it, and only --team widens it, saying how many sessions that shows.
  check(folders(token, root, ['connect', diary, '--private']).code === 0, 'a second folder connects as private')
  const { rows: [diaryFolder] } = await db.query('select id, connected_at from connected_folders where path = $1', [diary])
  const diaryRun = transcript(claudeDir, diary, new Date(must(diaryFolder, 'the diary folder').connected_at))
  diaryRun.turn({ prompt: 'Write in the diary.', reply: 'Written.' })
  await until('the private session', LANDS_SEC, async () => (await turnsEnded(diaryRun.session)) === 1)
  const visibilityOf = async (path: string) => String((await db.query('select visibility from connected_folders where path = $1', [path])).rows[0]?.visibility)
  folders(token, root, ['disconnect', diary])
  const bare = folders(token, root, ['connect', diary])
  check(bare.code === 0 && bare.out.includes('only you see its sessions') && await visibilityOf(diary) === 'private',
    `a private folder connected again with no flag stays private: ${bare.out.split('\n')[0] ?? ''}`)
  check(folders(token, root, ['connect', diary, '--team', '--private']).code === 2, '--team and --private together are a usage error, exit 2')
  const widened = folders(token, root, ['connect', diary, '--team'])
  check(widened.code === 0 && widened.out.includes('The team now sees the 1 session already in the record from it.') && await visibilityOf(diary) === 'team',
    `--team makes the folder the team's, and says how many sessions in the record that shows: ${widened.out.split('\n')[0] ?? ''}`)

  // What a session writes while its folder is disconnected stays on the Mac, even when the daemon misses the disconnect.
  check(folders(token, root, ['connect', journal]).code === 0 && folders(token, root, ['connect', last]).code === 0, 'two more folders connect')
  // pg gives a timestamptz as a Date, which keeps its milliseconds only as a number, not through String().
  const connectedAt = async (path: string) => new Date(must((await db.query('select connected_at from connected_folders where path = $1', [path])).rows[0], path).connected_at).getTime()
  const sentinel = transcript(claudeDir, last, new Date(await connectedAt(last)))
  let settled = 0
  // A line in the folder the daemon reads last lands only after a read went past
  // every other folder. The second line's read began after the first's ended, so
  // it read everything written before this was called.
  const settle = async () => {
    for (let i = 0; i < 2; i++) {
      settled += 1
      const want = settled
      sentinel.turn({ prompt: `Settle ${want}.`, reply: 'Settled.' })
      if (!await until(`settle ${want}`, LANDS_SEC, async () => (await turnsEnded(sentinel.session)) >= want)) return false
    }
    return true
  }
  const journalRun = transcript(claudeDir, journal, new Date(await connectedAt(journal)))
  journalRun.turn({ prompt: 'First entry.', reply: 'Noted.' })
  await until('the journal session', LANDS_SEC, async () => (await turnsEnded(journalRun.session)) === 1)
  const journalId = String((await sessionOf(journalRun.session))?.id)
  await stopDaemon()
  const loggedBefore = logs.length
  folders(token, root, ['disconnect', journal])
  journalRun.turn({ prompt: 'Written while the folder was disconnected.', reply: 'Noted again.' })
  folders(token, root, ['connect', journal])
  daemon = startDaemon()
  check(await settle() && await turnsEnded(journalRun.session) === 1,
    'what a session wrote while its folder was disconnected stays on the Mac after the folder is connected again, though the daemon missed the disconnect')
  const late = await machine(token, 'POST', `/v1/sessions/${String((await sessionOf(journalRun.session))?.id)}/events`,
    { events: [{ clientId: `late-${id}`, kind: 'notice', body: {} }] })
  check(late.status === 409, `the API refuses events for a session that started before its folder was connected again (${late.status})`)
  // The API would refuse the post, so only the daemon's log shows whether it tried.
  check(!logs.slice(loggedBefore).filter((l) => l.startsWith('daemon: ')).join('').includes(journalId), "and the daemon doesn't try to send it")

  // One bad session, line or file stops nothing else.
  check(folders(token, root, ['connect', deep]).code === 0, 'a folder the daemon reads first connects')
  const deepAt = new Date(await connectedAt(deep))
  const failing = transcript(claudeDir, deep, deepAt)
  failing.turn({ prompt: 'First.', reply: 'One.' })
  await until('the session the API will fail', LANDS_SEC, async () => (await turnsEnded(failing.session)) === 1)
  const failingId = String((await sessionOf(failing.session))?.id)
  // An event already at the session's next number, so the API's next insert breaks a unique key and it answers 500.
  await db.query(`insert into events (team_id, session_id, seq, updated_seq, kind, body, client_id)
    select team_id, id, last_seq + 1, last_seq + 1, 'notice', '{}', $2 from sessions where id = $1`, [failingId, `squatter-${id}`])
  failing.turn({ prompt: 'Second.', reply: 'Two.' })
  check(await settle() && await turnsEnded(failing.session) === 1, "a session whose posts the API fails with 500 holds up no other folder's session")
  await db.query('delete from events where client_id = $1', [`squatter-${id}`])
  check(await until('the failed turn', 30, async () => (await turnsEnded(failing.session)) === 2), 'once the API takes its posts again, the rest of that session lands')

  const odd = transcript(claudeDir, deep, deepAt)
  odd.turn({ prompt: 'A NUL here:\u0000, half a pair here:\ud800.', calls: [{ name: 'Grep', input: { 'pat\u0000tern': 'x' }, result: 'none' }], reply: 'Odd.' })
  await until('the session with a NUL', LANDS_SEC, async () => (await turnsEnded(odd.session)) === 1)
  const oddRow = await sessionOf(odd.session)
  const oddEvents = oddRow ? await eventsOf(oddRow.id) : []
  const oddPrompt: unknown = oddEvents.find((e) => e.kind === 'user')?.text
  const oddInput: unknown = oddEvents.find((e) => e.kind === 'tool_call')?.body.input
  check(oddPrompt === 'A NUL here:, half a pair here:\ufffd.' && JSON.stringify(oddInput) === '{"pattern":"x"}',
    `a line with NULs, in a value and in a key, and a lone surrogate lands, the NULs taken out and the surrogate made U+FFFD: ${JSON.stringify(oddPrompt)}`)

  const locked = transcript(claudeDir, deep, deepAt)
  locked.turn({ prompt: 'Locked.', reply: 'Locked.' })
  chmodSync(locked.path, 0o000)
  const lockedParked = await until('the daemon to park the transcript it cannot read', LANDS_SEC, async () =>
    logs.join('').includes(`${locked.path}: EACCES`) && logs.join('').includes('It is parked until the daemon starts again'))
  check(lockedParked && await settle(), "a transcript the daemon can't read is reported and parked, and the other folders' sessions land")

  // A read that fails with something other than the API's answer is a failed read like any other, parked after 3.
  // Here the folder holds a socket named like a .env file, whose values the daemon can't read.
  const jam = join(root, 'jam')
  mkdirSync(jam)
  const socket = createServer()
  servers.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.listen(join(jam, '.env.s'), () => { resolve() })
  })
  check(folders(token, root, ['connect', jam]).code === 0, 'a folder that holds a socket named like a .env file connects')
  const jammed = transcript(claudeDir, jam, new Date(await connectedAt(jam)))
  jammed.turn({ prompt: 'In the jammed folder.', reply: 'Jammed.' })
  check(await until('the daemon to park the transcript whose read fails', LANDS_SEC, async () =>
    daemonSaid(jammed.path, 'It failed 3 reads in a row', 'It is parked until the daemon starts again')) && await settle(),
  "a transcript whose read fails with something other than the API's answer is parked after 3 reads, and the other folders' sessions land")

  // A transcript whose lines name another session can't write into it.
  const firstEventsBefore = await count('select count(*) from events where session_id = $1', [String(firstRow?.id)])
  const impostor = transcript(claudeDir, journal, new Date(await connectedAt(journal)), randomUUID())
  impostor.write([impostor.line({ type: 'user', sessionId: first.session, message: { role: 'user', content: 'Written into another session.' }, turnOrigin: 'human' })])
  const impostorSaid = await until('the daemon to say the file names another session', LANDS_SEC, async () =>
    logs.join('').includes(`${impostor.path}: its lines name session ${first.session}`))
  check(impostorSaid && await settle() && await count('select count(*) from events where session_id = $1', [String(firstRow?.id)]) === firstEventsBefore
    && !await sessionOf(impostor.session),
  "a transcript whose lines name another folder's session writes nothing into it, and the daemon says why")
  const { rows: [journalFolder] } = await db.query('select id from connected_folders where path = $1', [journal])
  const stolen = await machine(token, 'POST', '/v1/instance/terminal-sessions', { folderId: journalFolder?.id, harnessSessionId: first.session, cwd: journal })
  check(stolen.status === 409, `the API refuses another folder's session for the same Claude Code session id (${stolen.status})`)

  // Lines are never lost: a refused post keeps them, posts fit the API's limit in bytes, and lines that don't parse are counted.
  const refusedRun = transcript(claudeDir, deep, deepAt)
  refusedRun.turn({ prompt: 'Before the refusal.', reply: 'One.' })
  await until('the session the API will refuse', LANDS_SEC, async () => (await turnsEnded(refusedRun.session)) === 1)
  const refusedId = String((await sessionOf(refusedRun.session))?.id)
  // The session moves to another machine, so the API answers this Mac's posts for it with 404.
  await db.query('update sessions set instance_id = (select id from instances where name = $2) where id = $1', [refusedId, `box-${id}`])
  refusedRun.turn({ prompt: 'Refused at first.', reply: 'Two.' })
  const refusedParked = await until('the daemon to park the refused session', LANDS_SEC, async () => daemonSaid(refusedId, '404', 'parked until the daemon starts again'))
  await db.query('update sessions set instance_id = (select id from instances where name = $2) where id = $1', [refusedId, `mac-${id}`])
  await restart()
  check(refusedParked && await until('the refused turn after a restart', LANDS_SEC, async () => (await turnsEnded(refusedRun.session)) === 2),
    'a post the API refuses parks its session with a message and keeps its lines, which the daemon sends once started again')

  const wide = transcript(claudeDir, deep, deepAt)
  // 1.4 million three-byte characters: 4.2 MB in UTF-8, but only 1.4 million units in UTF-16.
  const big = '\u20ac'.repeat(1_400_000)
  // A short first turn, as a real session starts with, since the reader looks for a session's start in its first 1 MB.
  wide.turn({ prompt: 'Start small.', reply: 'Small.' })
  for (let i = 0; i < 3; i++) wide.turn({ prompt: `${String(i)}${big}`, reply: `Wide ${String(i)}.` })
  check(await until('three wide turns', 60, async () => (await turnsEnded(wide.session)) === 4),
    'a session of three 4.2 MB prompts in three-byte characters lands whole, in posts under the 20 MiB limit')

  const messy = transcript(claudeDir, deep, deepAt)
  messy.turn({ prompt: 'Before the mess.', reply: 'Fine.' })
  appendFileSync(messy.path, '{"type": "user", "message": \n{"type": 42}\n')
  messy.turn({ prompt: 'After the mess.', reply: 'Fine again.', promptFields: { isMeta: 'no', origin: 'human' } })
  const messyLanded = await until('the turns around the mess', LANDS_SEC, async () => (await turnsEnded(messy.session)) === 2)
  const messyRow = await sessionOf(messy.session)
  const messyPrompts = messyRow ? (await eventsOf(messyRow.id)).filter((e) => e.kind === 'user').map((e) => String(e.text)) : []
  check(messyLanded && daemonSaid(messy.path, '2 lines did not parse'), "lines that don't parse are counted in the daemon's log, and the lines around them land")
  check(messyPrompts.includes('After the mess.') && await count(
    `select count(*) from raw_events where session_id = $1 and line->>'isMeta' = 'no'`, [String(messyRow?.id)]) === 1,
  'a prompt whose fields changed type in a Claude Code update still lands, and its raw line keeps them as written')

  // A transcript cut short, or rewritten, is read again from its start, and the record skips the lines it has.
  const replaced = transcript(claudeDir, deep, deepAt)
  const kept = replaced.turn({ prompt: 'Turn one of three.', reply: 'One.' })
  replaced.turn({ prompt: `Turn two of three, a long one: ${'x'.repeat(5000)}`, reply: 'Two.' })
  replaced.turn({ prompt: 'Turn three of three.', reply: 'Three.' })
  await until('the transcript to be replaced', LANDS_SEC, async () => (await turnsEnded(replaced.session)) === 3)
  const replacedId = String((await sessionOf(replaced.session))?.id)
  const eventsBefore = await count('select count(*) from events where session_id = $1', [replacedId])
  // A new file in its place, with the same first line and longer than what the daemon read, so only its inode tells.
  rmSync(replaced.path)
  replaced.write([replaced.head, ...kept])
  replaced.turn({ prompt: `Turn four, in the new file: ${'z'.repeat(12000)}`, reply: 'Four.' })
  const replacedLanded = await until('the turn in the new file', LANDS_SEC, async () => (await turnsEnded(replaced.session)) === 4)
  check(replacedLanded && await count('select count(*) from events where session_id = $1', [replacedId]) === eventsBefore + 3,
    "a transcript replaced by a new file is read again from its start, and the record takes only the lines it didn't have")

  const shortened = transcript(claudeDir, deep, deepAt)
  const shortenedKept = shortened.turn({ prompt: 'Kept when cut short.', reply: 'Kept.' })
  shortened.turn({ prompt: `Cut away: ${'w'.repeat(5000)}`, reply: 'Cut.' })
  await until('the transcript to be cut short', LANDS_SEC, async () => (await turnsEnded(shortened.session)) === 2)
  // The same file cut back to its first turn, then a short new one, so only its size tells.
  writeFileSync(shortened.path, '')
  shortened.write([shortened.head, ...shortenedKept])
  shortened.turn({ prompt: 'After the cut.', reply: 'After.' })
  check(await until('the turn after the cut', LANDS_SEC, async () => (await turnsEnded(shortened.session)) === 3),
    'a transcript cut short in place is read again from its start')

  const rewritten = transcript(claudeDir, deep, deepAt)
  rewritten.turn({ prompt: 'Before the rewrite.', reply: 'Before.' })
  await until('the transcript to be rewritten', LANDS_SEC, async () => (await turnsEnded(rewritten.session)) === 1)
  // The same file, cut to nothing and written again, longer than what the daemon read and different from its first line.
  writeFileSync(rewritten.path, '')
  rewritten.write([rewritten.head])
  rewritten.turn({ prompt: `A new start, written in place: ${'y'.repeat(3000)}`, reply: 'New.' })
  rewritten.turn({ prompt: 'And more after it.', reply: 'More.' })
  const rewrittenLanded = await until('the rewritten turns', LANDS_SEC, async () => (await turnsEnded(rewritten.session)) === 3)
  const rewrittenRow = await sessionOf(rewritten.session)
  const rewrittenPrompts = rewrittenRow ? (await eventsOf(rewrittenRow.id)).filter((e) => e.kind === 'user').map((e) => String(e.text).slice(0, 30)) : []
  check(rewrittenLanded && rewrittenPrompts.join('|') === 'Before the rewrite.|A new start, written in place:|And more after it.',
    `a transcript rewritten in place with a different first line is read again from its start: ${rewrittenPrompts.join('|')}`)

  // connect takes each name's case from the disk, and says where the daemon reads the transcripts.
  // This means something only on a case-insensitive volume, as macOS's default one is.
  if (!existsSync(cased.toUpperCase())) throw new Error(`${root} is on a case-sensitive volume, so this check can't show the case taken from the disk`)
  const casedConnect = folders(token, root, ['connect', join(root, 'CASED-folder')])
  const { rows: [casedRow] } = await db.query('select path, connected_at from connected_folders where lower(path) = lower($1)', [cased])
  const casedRun = transcript(claudeDir, cased, new Date(must(casedRow, 'the cased folder').connected_at))
  casedRun.turn({ prompt: 'In a folder connected in the wrong case.', reply: 'Found.' })
  check(casedConnect.code === 0 && casedRow?.path === cased && await until('the session in the folder typed in the wrong case', LANDS_SEC, async () => (await turnsEnded(casedRun.session)) === 1),
    `connect takes each name's case from the disk, so a folder typed in the wrong case still gets its sessions: ${String(casedRow?.path)}`)
  check(casedConnect.out.includes(`transcripts: the daemon reads ${join(homedir(), '.claude', 'projects', cased.replace(/[^a-zA-Z0-9]/g, '-'))}`),
    'connect prints the transcript folder the daemon reads')
  const configured = folders(token, root, ['connect', cased], { CLAUDE_CONFIG_DIR: join(root, 'elsewhere') })
  check(configured.code === 0 && configured.out.includes('warning: this shell sets CLAUDE_CONFIG_DIR'),
    'connect warns when the shell sets CLAUDE_CONFIG_DIR, which the daemon under launchd does not see')

  // daemon.json is read as a config. One that is damaged is an error naming the file, where it was once taken for no file at all.
  const damagedHome = join(root, 'damaged-home')
  const goodHome = join(root, 'good-home')
  mkdirSync(damagedHome)
  mkdirSync(goodHome)
  writeFileSync(join(damagedHome, 'daemon.json'), '{ "token": ')
  writeFileSync(join(goodHome, 'daemon.json'), JSON.stringify({ api: API, token }))
  const damaged = folders(token, root, [], { AGENTS_HOME: damagedHome })
  check(damaged.code === 2 && damaged.out.includes(join(damagedHome, 'daemon.json')), `a damaged daemon.json is an error that names the file: ${damaged.out.split('\n')[0] ?? ''}`)
  const fromFile = folders(token, root, [], { AGENTS_HOME: goodHome, AGENTS_API: undefined, AGENTS_TOKEN: undefined })
  check(fromFile.code === 0, `the API's address and the token come from daemon.json when the environment has none: ${fromFile.out.split('\n')[0] ?? ''}`)

  // The home folder, and any folder above it, can't be connected, and the daemon reads none even when something holding
  // the machine token connected it through the API. The check's home is a folder of its own inside the temp folder.
  const fakeHome = join(root, 'fake-home')
  const homeProject = join(fakeHome, 'project')
  mkdirSync(homeProject, { recursive: true })
  const refusedHome = folders(token, root, ['connect', fakeHome], { HOME: fakeHome })
  const refusedAbove = folders(token, root, ['connect', root], { HOME: fakeHome })
  const takenInside = folders(token, root, ['connect', homeProject], { HOME: fakeHome })
  check(refusedHome.code === 3 && refusedAbove.code === 3 && refusedHome.out.includes('home folder') && takenInside.code === 0,
    `connect refuses the home folder and a folder above it, and takes a project inside it (${refusedHome.code}, ${refusedAbove.code}, ${takenInside.code})`)
  await restart({ ...daemonEnv, HOME: fakeHome })
  const rogue = await machine(token, 'POST', '/v1/instance/folders', { path: fakeHome })
  const homeRun = transcript(claudeDir, fakeHome, new Date(await connectedAt(fakeHome)))
  homeRun.turn({ prompt: 'From the home folder.', reply: 'Home.' })
  const projectRun = transcript(claudeDir, homeProject, new Date(await connectedAt(homeProject)))
  projectRun.turn({ prompt: 'From a project in it.', reply: 'Project.' })
  const projectLanded = await until('the project inside the home folder', LANDS_SEC, async () => (await turnsEnded(projectRun.session)) === 1)
  check(rogue.status === 200 && projectLanded && await settle() && daemonSaid(fakeHome, 'the home folder or holds it') && !await sessionOf(homeRun.session),
    'the daemon reads no session in a home folder that something holding its token connected, and still reads a project inside it')
  folders(token, root, ['disconnect', fakeHome])
  await restart()

  // A transcript is read a chunk at a time. A backlog of 24 MB is never held whole, and an old transcript is read only as
  // far as the line that says where it started, which is in its first chunk, where a read of 1 MiB would take far more.
  const padding = `${JSON.stringify({ type: 'attachment', uuid: randomUUID(), padding: 'x'.repeat(100_000) })}\n`
  const heavy = transcript(claudeDir, shop, afterShop)
  heavy.turn({ prompt: 'A short start.', reply: 'Short.' })
  await until('the session before its backlog', LANDS_SEC, async () => (await turnsEnded(heavy.session)) === 1)
  // 24 MB of lines that make no event, in one write, and a turn behind them that must land.
  appendFileSync(heavy.path, padding.repeat(240))
  heavy.turn({ prompt: 'After the backlog.', reply: 'Long.' })
  const heavyLanded = await until('the turn behind the backlog', LANDS_SEC, async () => (await turnsEnded(heavy.session)) === 2)
  const biggest = (await meterAfter()).largest
  check(heavyLanded && biggest <= 1024 * 1024, `a backlog of 24 MB is read in chunks, the biggest buffer a read was given being ${biggest} bytes`)

  const old = transcript(claudeDir, shop, new Date(await connectedAt(shop) - 3_600_000))
  old.turn({ prompt: 'From before the folder was connected.', reply: 'Before.' })
  appendFileSync(old.path, padding.repeat(30))
  await restart()
  await settle()
  const oldRead = (await meterAfter()).reads[old.path] ?? 0
  check(oldRead > 0 && oldRead <= 128 * 1024, `an old transcript is read only as far as the line that says where it started: ${oldRead} of its ${statSync(old.path).size} bytes`)

  // A transcript whose start line is not written yet is searched on from where the last read ended, not from its first byte.
  const unstarted = transcript(claudeDir, shop, afterShop)
  appendFileSync(unstarted.path, padding.repeat(3))
  const unstartedSize = statSync(unstarted.path).size
  await settle()
  await settle()
  const unstartedRead = (await meterAfter()).reads[unstarted.path] ?? 0
  unstarted.turn({ prompt: 'The start, at last.', reply: 'Late.' })
  const unstartedLanded = await until('the turn behind the missing start', LANDS_SEC, async () => (await turnsEnded(unstarted.session)) === 1)
  check(unstartedLanded && unstartedRead > 0 && unstartedRead <= unstartedSize * 1.5,
    `a transcript with no start line yet is searched on from where the last read ended: ${unstartedRead} bytes read of ${unstartedSize} over at least four reads`)

  // A Mac clock ahead of the server's can make a session look newer than its folder's reconnect, while the API knows it is older.
  check(folders(token, root, ['connect', skewed]).code === 0, 'a folder for a clock running ahead connects')
  const skewedRun = transcript(claudeDir, skewed, new Date(await connectedAt(skewed) + 60_000))
  skewedRun.turn({ prompt: 'From a clock a minute ahead.', reply: 'Ahead.' })
  await until('the session from a clock running ahead', LANDS_SEC, async () => (await turnsEnded(skewedRun.session)) === 1)
  const skewedId = String((await sessionOf(skewedRun.session))?.id)
  folders(token, root, ['disconnect', skewed])
  folders(token, root, ['connect', skewed])
  skewedRun.turn({ prompt: 'After the reconnect.', reply: 'After.' })
  const skewedSettled = await settle() && await settle()
  const refusals = logs.filter((l) => l.startsWith('daemon: ')).join('').split('\n')
    .filter((line) => line.includes(skewedId) && line.includes('disconnected since it started')).length
  check(skewedSettled && refusals === 1 && await turnsEnded(skewedRun.session) === 1,
    `a session the API closes is passed over after its first refusal, not taken again on every read (${String(refusals)} refusals)`)
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  const stopped = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null
  for (const child of children) child.kill('SIGTERM')
  for (const server of servers) server.close()
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
