// The people port is a Unix socket that only tailscale serve reaches. In
// userspace mode tailscaled hands a tailnet peer's connection to whatever
// listens on the same TCP port on 127.0.0.1, so no TCP port of the API may take
// a person's identity. Runs this branch's API on ports 8060 to 8065.
//   node --env-file=.env --env-file=.env.test test/step19.ts

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { request, type RequestOptions } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const socket = join(home, 'people.sock')

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
// then the stream server. Its stderr is kept for the check to read.
function startApi(first: number) {
  const child = spawn(process.execPath, ['server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(first),
      // Main serves people on this TCP port. An API that still does opens it
      // here, where this check looks, instead of colliding with the live 7710.
      AGENTS_PEOPLE_PORT: String(first + 1),
      AGENTS_PEOPLE_SOCKET: socket,
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

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, login)

  const first = startApi(PORT)
  await until(20, async () => fetch(`http://127.0.0.1:${PORT}`).then(() => true, () => false))
  await until(10, answers)

  const viaServe = await me({ socketPath: socket })
  const person = z.object({ person: z.object({ login: z.string() }) }).safeParse(viaServe.status === 200 ? JSON.parse(viaServe.body) : null)
  check(person.success && person.data.person.login === login,
    `a request on the people socket, as serve sends it, is the person serve names (${viaServe.status} ${viaServe.body.slice(0, 80)})`)

  const ports = tcpPorts(must(first.child.pid, "the API's process id"))
  const replies = await Promise.all(ports.map(async (port) => [port, (await me({ port })).status] as const))
  console.log(`      the API listens on TCP ${replies.map(([port, status]) => `${port} (${status})`).join(', ')}`)
  check(ports.includes(PORT) && replies.every(([, status]) => status !== 200),
    'a direct TCP connection to any port of the API, as a tailnet peer gets, is never taken as the person it names')

  const second = startApi(PORT + 3)
  const refused = await until(20, exited(second.child))
  check(refused && second.log().includes(socket) && await answers(),
    'a second API on the same socket refuses to start, and the first keeps serving people')

  first.child.kill('SIGKILL')
  await until(10, exited(first.child))
  const stale = existsSync(socket)
  startApi(PORT)
  check(stale && await until(20, answers), 'an API that stopped without closing its socket leaves it, and the next API serves people on it')
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
