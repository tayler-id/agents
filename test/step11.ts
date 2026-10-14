// AWS step 11: the API and boxes, ready for the cloud. An API whose machine port
// listens on a non-loopback address answers machines there, refuses Tailscale
// identity headers there, and keeps its people port on loopback. Unset, the
// machine port listens only on loopback, and an address that is not an IP stops
// the API. A box whose Docker host cannot be reached keeps its token, a box whose
// `docker run` fails never writes a token to the log, and an API whose boxes run
// on a remote Docker host refuses to start without AGENTS_BOX_API.
//   node --env-file=.env --env-file=.env.test test/step11.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { z } from 'zod'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
// This check owns ports 7900 to 7902 and 7908. Its APIs run one at a time, so they share three.
const MACHINES = 7900
const PEOPLE = 7901
const STREAMS = 7902
// Nothing listens here, so an ssh:// Docker host on it fails at once.
const CLOSED = 7908
// How long an API may take to start listening, or to stop after a bad setting.
const START_MS = 20_000
// How long a TCP connection attempt may take before it counts as unanswered.
const CONNECT_MS = 3000
// The runner ticks every two seconds, so three box errors take about six.
const BOX_ERRORS = 3
const BOX_ERRORS_MS = 30_000
// An image that does not exist, pulled never, so no box container can start.
const NO_IMAGE = 'agents-box:aws-step11-absent'

const id = randomBytes(4).toString('hex')
const team = `aws-${id}`
const login = `aws-${id}@local`
const work = mkdtempSync(join(tmpdir(), 'agents-step11-'))
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const failures: string[] = []
const children: ChildProcess[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })

// A non-loopback address of this machine, standing in for the server's VPC address.
const lan = must(Object.values(networkInterfaces()).flat().find((a) => a?.family === 'IPv4' && !a.internal)?.address,
  'a non-loopback IPv4 address on this machine')

// 'open' when something accepts a TCP connection there, else the error's code.
function tcp(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: CONNECT_MS })
    socket.once('connect', () => { socket.destroy(); resolve('open') })
    socket.once('timeout', () => { socket.destroy(); resolve('ETIMEDOUT') })
    socket.once('error', (error: Error) => { resolve('code' in error && typeof error.code === 'string' ? error.code : error.message) })
  })
}

// The HTTP status, or 0 when nothing answered.
async function status(url: string, headers: Record<string, string>, body?: unknown): Promise<number> {
  const res = await fetch(url, body === undefined ? { headers } : {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => null)
  await res?.body?.cancel()
  return res?.status ?? 0
}

type Api = { child: ChildProcess; output: () => string; exited: Promise<number | null> }

// Starts an API with only the settings a case names, on top of the check's
// database. Docker and box settings from the shell never leak in.
function startApi(settings: Record<string, string>): Api {
  const env: NodeJS.ProcessEnv = {
    ...process.env, AGENTS_RUNNER: 'off', AGENTS_API_PORT: String(MACHINES), AGENTS_PEOPLE_PORT: String(PEOPLE),
    AGENTS_STREAMS_PORT: String(STREAMS), AGENTS_STREAMS_DIR: mkdtempSync(join(work, 'streams-')),
  }
  for (const name of ['AGENTS_MACHINE_HOST', 'DOCKER_HOST', 'AGENTS_BOX_DOCKER_HOST', 'AGENTS_BOX_API', 'AGENTS_BOX_IMAGE',
    'AGENTS_BOX_DOCKER_ARGS', 'AGENTS_BOX_TOKEN_FILE', 'AGENTS_RUNNER_TEAMS']) delete env[name]
  const child = spawn(process.execPath, ['server/api.ts'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ...settings } })
  children.push(child)
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const exited = new Promise<number | null>((resolve) => { child.once('exit', (code) => { resolve(code) }) })
  return { child, output: () => output, exited }
}

// Resolves true once the API listens on loopback, false if it exits first or never does.
async function listening(api: Api): Promise<boolean> {
  const deadline = Date.now() + START_MS
  while (Date.now() < deadline && api.child.exitCode === null) {
    if (await tcp('127.0.0.1', MACHINES) === 'open') return true
    await sleep(250)
  }
  return false
}

// The exit code once the API stops, or null if it is still running at the deadline.
async function exitWithin(api: Api, ms: number): Promise<number | null> {
  return Promise.race([api.exited, sleep(ms).then(() => null)])
}

async function stop(api: Api) {
  if (api.child.exitCode === null) api.child.kill('SIGTERM')
  await api.exited
}

async function within(ms: number, test: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(500)
  }
  return false
}

const count = (text: string, pattern: RegExp) => text.match(new RegExp(pattern.source, 'g'))?.length ?? 0
const tokenOf = async (boxId: string) =>
  must((await db.query<{ token_sha256: string }>('select token_sha256 from instances where id = $1', [boxId])).rows[0], 'the box').token_sha256

// A box a person holds, with a token whose hash the check knows.
async function heldBox(name: string): Promise<{ boxId: string; tokenHash: string }> {
  const tokenHash = sha256(`machine_${randomBytes(24).toString('base64url')}`)
  const row = must((await db.query<{ id: string }>(
    `insert into instances (team_id, name, kind, token_sha256, claimed_by, claimed_at)
     select t.id, $2, 'box', $3, p.id, now() from teams t join people p on p.team_id = t.id and p.login = $4
     where t.name = $1 returning id`, [team, name, tokenHash, login])).rows[0], 'the new box')
  return { boxId: row.id, tokenHash }
}

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, login)
  const { token } = z.object({ token: z.string() }).parse(JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login)))
  const bearer = { authorization: `Bearer ${token}` }
  const heartbeat = (host: string, headers: Record<string, string> = {}) =>
    status(`http://${host}:${MACHINES}/v1/instance/heartbeat`, { ...bearer, ...headers }, { status: 'online' })

  // The machine port on a non-loopback address, as on the server in the VPC.
  const wide = startApi({ AGENTS_MACHINE_HOST: `127.0.0.1,${lan}` })
  check(await listening(wide), 'an API with AGENTS_MACHINE_HOST set starts')
  await db.query(`update instances set status = 'offline', last_seen_at = null where name = $1`, [`mac-${id}`])
  const answered = await heartbeat(lan)
  const seen = (await db.query<{ status: string }>('select status from instances where name = $1 and last_seen_at is not null', [`mac-${id}`])).rows[0]
  check(answered === 200 && seen?.status === 'online', `a machine's heartbeat to ${lan}:${MACHINES} is answered and marks it online (status ${answered})`)
  check(await heartbeat('127.0.0.1') === 200, 'the machine port still answers on loopback, the other address in the list')
  check(await heartbeat(lan, { 'tailscale-user-login': login }) === 400,
    'the machine port on the non-loopback address refuses a request carrying Tailscale-User-Login')
  check(await heartbeat(lan, { 'tailscale-user-name': 'Someone Else' }) === 400,
    'it refuses any Tailscale identity header, such as Tailscale-User-Name, not only the login')
  const peopleThere = await tcp(lan, PEOPLE)
  const me = z.object({ person: z.object({ login: z.string() }) })
    .safeParse(await fetch(`http://127.0.0.1:${PEOPLE}/v1/me`, { headers: { 'tailscale-user-login': login } }).then((r) => r.json(), () => null))
  check(peopleThere === 'ECONNREFUSED' && me.data?.person.login === login,
    `the people port stays on loopback: ${lan}:${PEOPLE} refuses connections (${peopleThere}) and 127.0.0.1:${PEOPLE} knows the person`)
  await stop(wide)

  // Unset, the machine port listens only on loopback, as on the Mac today.
  const narrow = startApi({})
  check(await listening(narrow), 'an API without AGENTS_MACHINE_HOST starts')
  const lanByDefault = await tcp(lan, MACHINES)
  check(lanByDefault === 'ECONNREFUSED' && await heartbeat('127.0.0.1') === 200,
    `without AGENTS_MACHINE_HOST the machine port answers on loopback and not on ${lan} (${lanByDefault})`)
  await stop(narrow)

  // A setting that is not an IP address stops the API and names the setting.
  const typo = startApi({ AGENTS_MACHINE_HOST: '127.0.0.1,agents-server' })
  const typoExit = await exitWithin(typo, START_MS)
  check(typoExit !== null && typoExit !== 0 && typo.output().includes('AGENTS_MACHINE_HOST'),
    `an AGENTS_MACHINE_HOST entry that is not an IP address stops the API with a message naming it (exit ${typoExit})`)
  await stop(typo)

  // A box host the server cannot reach, as when SSH to it drops. The box keeps
  // its token, since its container may still be running there.
  const unreachable = await heldBox(`box-${id}-a`)
  const cut = startApi({
    AGENTS_RUNNER: 'on', AGENTS_RUNNER_TEAMS: team, DOCKER_HOST: `ssh://agents@127.0.0.1:${CLOSED}`,
    AGENTS_BOX_API: `http://${lan}:${MACHINES}`, AGENTS_BOX_IMAGE: NO_IMAGE, AGENTS_BOX_DOCKER_ARGS: JSON.stringify(['--pull', 'never']),
  })
  check(await listening(cut), 'an API whose box host cannot be reached starts')
  const boxErrors = /boxes:|starting box/
  check(await within(BOX_ERRORS_MS, () => count(cut.output(), boxErrors) >= BOX_ERRORS), 'the runner reports that it cannot reach the box host')
  check(await tokenOf(unreachable.boxId) === unreachable.tokenHash,
    `after ${BOX_ERRORS} runner passes against an unreachable box host the box keeps its token, so its running container still works`)
  await stop(cut)

  // A box whose container cannot start. The error is logged, but never the box's
  // token or the Claude token, both of which `docker run` is given.
  const failing = await heldBox(`box-${id}-b`)
  const claudeToken = `sk-ant-oat01-${randomBytes(24).toString('base64url')}`
  const tokenFile = join(work, 'box-claude-token')
  writeFileSync(tokenFile, `${claudeToken}\n`, { mode: 0o600 })
  const broken = startApi({
    AGENTS_RUNNER: 'on', AGENTS_RUNNER_TEAMS: team, AGENTS_BOX_TOKEN_FILE: tokenFile,
    AGENTS_BOX_IMAGE: NO_IMAGE, AGENTS_BOX_DOCKER_ARGS: JSON.stringify(['--pull', 'never']),
  })
  check(await listening(broken), 'an API whose box image is missing starts')
  check(await within(BOX_ERRORS_MS, () => count(broken.output(), /starting box/) >= BOX_ERRORS), 'the runner logs that the box container could not start')
  const log = broken.output()
  check(!log.includes(claudeToken) && !/machine_[A-Za-z0-9_-]{8}/.test(log),
    'the log of a failed docker run holds neither the Claude token nor the box token')
  await stop(broken)
  check(execFileSync('docker', ['ps', '--all', '--quiet', '--filter', `name=agents-box-${failing.boxId}`], { encoding: 'utf8' }).trim() === '',
    'no container was left behind')

  // Boxes on a remote Docker host need to be told where the server is.
  const blind = startApi({ AGENTS_BOX_DOCKER_HOST: `ssh://agents@127.0.0.1:${CLOSED}` })
  const blindExit = await exitWithin(blind, START_MS)
  check(blindExit !== null && blindExit !== 0 && blind.output().includes('AGENTS_BOX_API'),
    `an API whose boxes run on a remote Docker host refuses to start without AGENTS_BOX_API, and names it (exit ${blindExit})`)
  await stop(blind)
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team])
    rmSync(work, { recursive: true, force: true })
  }
  await db.end()
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} and ${work} kept)` : 'all passed (test team removed)'}`)
process.exit(failures.length ? 1 : 0)
