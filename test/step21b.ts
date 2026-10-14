// Terminal sessions, fast. This check writes Claude Code's transcript lines
// itself, into a temp folder the daemon reads as CLAUDE_CONFIG_DIR, so it needs
// no Claude and runs in seconds. The transcript file is where Claude Code hands
// its sessions over, and everything past it is real: the daemon, the folders
// command, the API and Electric. step21 runs the real CLI.
//   node --env-file=.env --env-file=.env.test test/step21b.ts

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
// Values that must never reach the record, each in one place on the Mac.
const secret = () => randomBytes(18).toString('base64url')
const nested = secret()
const [redisPassword, mongoPassword, smtpPassword] = [secret(), secret(), secret()]
const folderWord = secret()
const sessionWord = secret()
const phrase = secret()
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
type Turn = { prompt: string; calls?: Call[]; reply: string }

// One Claude Code session's transcript, written line by line as Claude Code writes it.
function transcript(claudeDir: string, cwd: string, startedAt: Date, session: string = randomUUID()) {
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
  // Long enough that the project name a .env file gives it counts as a secret's length.
  const shop = join(root, `shop-${id}`)
  const zdot = join(root, 'zdot')
  const diary = join(root, 'diary')
  const journal = join(root, 'journal')
  // The shortest connected path, so the daemon reads this folder last in each read.
  const last = join(root, 'z')
  // The longest connected path, so the daemon reads this folder first in each read.
  const deep = join(root, 'the-folder-with-the-longest-path-so-the-daemon-reads-it-first')
  for (const dir of [claudeDir, home, zdot, diary, journal, last, deep, join(shop, 'apps', 'api'), join(shop, 'data'), join(shop, folderWord)]) mkdirSync(dir, { recursive: true })
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
  let daemon = run('daemon', 'daemon/agentsd.ts', daemonEnv)
  const stopDaemon = async () => {
    daemon.kill('SIGTERM')
    if (!await until('the daemon to stop', STOP_SEC, async () => daemon.exitCode !== null || daemon.signalCode !== null)) throw new Error('the daemon did not stop')
  }
  const restart = async (env: Record<string, string> = daemonEnv) => {
    await stopDaemon()
    daemon = run('daemon', 'daemon/agentsd.ts', env)
  }

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
  const diaryRun = transcript(claudeDir, diary, new Date(Date.parse(must(diaryFolder, 'the diary folder').connected_at) + 1000))
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
  const connectedAt = async (path: string) => Date.parse(String((await db.query('select connected_at from connected_folders where path = $1', [path])).rows[0]?.connected_at))
  const sentinel = transcript(claudeDir, last, new Date(await connectedAt(last) + 1000))
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
  const journalRun = transcript(claudeDir, journal, new Date(await connectedAt(journal) + 1000))
  journalRun.turn({ prompt: 'First entry.', reply: 'Noted.' })
  await until('the journal session', LANDS_SEC, async () => (await turnsEnded(journalRun.session)) === 1)
  const journalId = String((await sessionOf(journalRun.session))?.id)
  await stopDaemon()
  const loggedBefore = logs.length
  folders(token, root, ['disconnect', journal])
  journalRun.turn({ prompt: 'Written while the folder was disconnected.', reply: 'Noted again.' })
  folders(token, root, ['connect', journal])
  daemon = run('daemon', 'daemon/agentsd.ts', daemonEnv)
  check(await settle() && await turnsEnded(journalRun.session) === 1,
    'what a session wrote while its folder was disconnected stays on the Mac after the folder is connected again, though the daemon missed the disconnect')
  const late = await machine(token, 'POST', `/v1/sessions/${String((await sessionOf(journalRun.session))?.id)}/events`,
    { events: [{ clientId: `late-${id}`, kind: 'notice', body: {} }] })
  check(late.status === 409, `the API refuses events for a session that started before its folder was connected again (${late.status})`)
  // The API would refuse the post, so only the daemon's log shows whether it tried.
  check(!logs.slice(loggedBefore).filter((l) => l.startsWith('daemon: ')).join('').includes(journalId), "and the daemon doesn't try to send it")

  // One bad session, line or file stops nothing else.
  check(folders(token, root, ['connect', deep]).code === 0, 'a folder the daemon reads first connects')
  const deepAt = new Date(await connectedAt(deep) + 1000)
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
