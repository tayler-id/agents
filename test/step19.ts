// The people port is a Unix socket that only tailscale serve reaches. In
// userspace mode tailscaled hands a tailnet peer's connection to whatever
// listens on the same TCP port on 127.0.0.1, so no TCP port of the API may take
// a person's identity, and only this user may reach the socket. Runs this
// branch's API on ports 8060 to 8077.
//   node --env-file=.env --env-file=.env.test test/step19.ts

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { request, type RequestOptions } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { z } from 'zod'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = 8060
const id = randomBytes(4).toString('hex')
const team = `sec-${id}`
const login = `sec-${id}@local`
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-sec-')))
// In a folder the API has to make, so the check sees the mode it gives it.
const socket = join(home, 'people', 'people.sock')

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

async function until(seconds: number, test: () => Promise<boolean>) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(250)
  }
  return false
}

// GET /v1/me naming the test person, as serve names the caller. Resolves to
// the status and body, or to the connection error's code.
function me(to: { socketPath: string } | { port: number }): Promise<{ status: number; body: string }> {
  const options: RequestOptions = { ...to, host: '127.0.0.1', path: '/v1/me', headers: { 'tailscale-user-login': login } }
  return new Promise((resolve) => {
    const req = request(options, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }) })
    })
    req.on('error', (error: NodeJS.ErrnoException) => { resolve({ status: 0, body: error.code ?? error.message }) })
    req.end()
  })
}

// An API on three ports in a row: machines, then the people port main reads,
// then the stream server. `people` becomes AGENTS_PEOPLE_SOCKET, and null
// leaves the setting out. Its stderr is kept for the check to read.
function startApi(first: number, people: string | null) {
  const { AGENTS_PEOPLE_SOCKET: _fromEnvFiles, ...env } = process.env
  const child = spawn(process.execPath, ['server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(first),
      // Main serves people on this TCP port. An API that still does opens it
      // here, where this check looks, instead of colliding with the live 7710.
      AGENTS_PEOPLE_PORT: String(first + 1),
      ...(people === null ? {} : { AGENTS_PEOPLE_SOCKET: people }),
      AGENTS_STREAMS_PORT: String(first + 2), AGENTS_STREAMS_DIR: join(home, `streams-${first}`),
    },
  })
  children.push(child)
  let log = ''
  child.stderr.on('data', (chunk: Buffer) => { log += chunk.toString() })
  return { child, log: () => log }
}

// The TCP ports a process listens on.
function tcpPorts(pid: number): number[] {
  const lsof = spawnSync('lsof', ['-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-nP', '-Fn'], { encoding: 'utf8' })
  return lsof.stdout.split('\n').filter((line) => line.startsWith('n')).map((line) => Number(line.slice(line.lastIndexOf(':') + 1)))
}

const exited = (child: ChildProcess) => async () => child.exitCode !== null || child.signalCode !== null
const answers = async () => (await me({ socketPath: socket })).status === 200
const modeOf = (path: string) => (existsSync(path) ? (statSync(path).mode & 0o777).toString(8) : 'missing')

// Whether an API started this way stops within 15 seconds, saying `why` on
// stderr. It is stopped either way.
async function refuses(first: number, people: string | null, why: string) {
  const api = startApi(first, people)
  const stopped = await until(15, exited(api.child))
  api.child.kill('SIGTERM')
  return stopped && api.log().includes(why)
}

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, login)

  const first = startApi(PORT, socket)
  await until(20, async () => fetch(`http://127.0.0.1:${PORT}`).then(() => true, () => false))
  await until(10, answers)

  const viaServe = await me({ socketPath: socket })
  const person = z.object({ person: z.object({ login: z.string() }) }).safeParse(viaServe.status === 200 ? JSON.parse(viaServe.body) : null)
  check(person.success && person.data.person.login === login,
    `a request on the people socket, as serve sends it, is the person serve names (${viaServe.status} ${viaServe.body.slice(0, 80)})`)
  check(modeOf(dirname(socket)) === '700' && modeOf(socket) === '600',
    `the API makes the socket's folder 700 and the socket 600 (${modeOf(dirname(socket))}, ${modeOf(socket)})`)

  const ports = tcpPorts(must(first.child.pid, "the API's process id"))
  const replies = await Promise.all(ports.map(async (port) => [port, (await me({ port })).status] as const))
  console.log(`      the API listens on TCP ${replies.map(([port, status]) => `${port} (${status})`).join(', ')}`)
  check(ports.includes(PORT) && replies.every(([, status]) => status !== 200),
    'a direct TCP connection to any port of the API, as a tailnet peer gets, is never taken as the person it names')

  const second = startApi(PORT + 3, socket)
  const refused = await until(20, exited(second.child))
  check(refused && second.log().includes(socket) && await answers(),
    'a second API on the same socket refuses to start, and the first keeps serving people')

  first.child.kill('SIGKILL')
  await until(10, exited(first.child))
  const stale = existsSync(socket)
  startApi(PORT, socket)
  check(stale && await until(20, answers), 'an API that stopped without closing its socket leaves it, and the next API serves people on it')

  check(await refuses(PORT + 6, null, 'AGENTS_PEOPLE_SOCKET') && await refuses(PORT + 9, '', 'AGENTS_PEOPLE_SOCKET'),
    'without AGENTS_PEOPLE_SOCKET, or with it empty, the API stops at once and names it')

  const plain = join(home, 'plain', 'people.sock')
  mkdirSync(dirname(plain))
  writeFileSync(plain, 'not a socket')
  check(await refuses(PORT + 12, plain, plain) && readFileSync(plain, 'utf8') === 'not a socket',
    'a file at the socket path that is not a socket stops the API, which leaves the file alone')

  const open = join(home, 'open')
  mkdirSync(open)
  chmodSync(open, 0o777)
  check(await refuses(PORT + 15, join(open, 'people.sock'), open), 'a socket folder that other users can write to stops the API')
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  if (!failures.length) await db.query('delete from teams where name = $1', [team])
  await db.end()
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test team removed)'}`)
process.exit(failures.length ? 1 : 0)
