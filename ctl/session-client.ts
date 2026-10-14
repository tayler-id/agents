// Talks to the instance's browser session, starting it on first use. The
// session's process is recorded in the instance's state, so `down` stops it and
// everything it opened.

import { request } from 'node:http'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { childEnv, ROOT } from './config.ts'
import { z } from 'zod'
import { claimFile, readLock } from './lock.ts'
import { describe, isOurs, spawnRecorded } from './procs.ts'
import { SessionReply, type SessionRequest } from './protocol.ts'
import { readState, saveState, stateFile, type InstanceState, type ReadyState } from './state.ts'

// How long a new session may take to listen: it loads Playwright first.
const START_MS = 30_000
// The longest one request may take. A visual capture opens six pages and scans each.
const REQUEST_MS = 10 * 60_000
const LOOK_MS = 200

const socketOf = (state: InstanceState) => join(state.scratch, 'session.sock')

function post(socket: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: '/', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
      res.on('error', reject)
    })
    req.setTimeout(REQUEST_MS, () => { req.destroy(new Error(`the browser session did not answer within ${String(REQUEST_MS / 60_000)} minutes`)) })
    req.on('error', reject)
    req.end(body)
  })
}

async function send(state: InstanceState, message: SessionRequest): Promise<SessionReply> {
  return SessionReply.parse(JSON.parse(await post(socketOf(state), JSON.stringify(message))))
}

const PING: SessionRequest = { target: 'browser', engine: 'chromium', width: 'desktop', login: '', timeoutMs: 1000, op: { op: 'ping' } }

async function answers(state: InstanceState): Promise<boolean> {
  if (!existsSync(socketOf(state))) return false
  return send(state, PING).then(() => true, () => false)
}

// Who holds the lock that starts the session: a process, by its pid and start time.
const Holder = z.object({ pid: z.number().int().positive(), started: z.string() })

// Whether the lock's holder is gone, so the lock is left over from a command that died.
async function abandoned(lock: string): Promise<boolean> {
  const holder = Holder.safeParse(readLock(lock))
  if (!holder.success) return true
  const seen = await describe(holder.data.pid)
  return seen?.started !== holder.data.started
}

// Starts the session if none answers. A lock file keeps two calls from starting
// two; one left by a command that died is taken over.
async function ensure(state: ReadyState): Promise<void> {
  if (await answers(state)) return
  const lock = join(state.scratch, 'session.lock')
  const me = await describe(process.pid)
  if (!me) throw new Error('ps does not show this process, so it cannot take the browser session lock')
  const content = JSON.stringify({ pid: process.pid, started: me.started })
  let mine = claimFile(lock, content)
  if (!mine && await abandoned(lock)) {
    rmSync(lock, { force: true })
    mine = claimFile(lock, content)
  }
  try {
    const record = mine ? await spawnRecorded('session', [process.execPath, join(ROOT, 'ctl', 'session-server.ts'), stateFile(state.name)], {
      cwd: ROOT, env: childEnv('session', {}), log: join(state.evidence, 'session.log'),
    }) : null
    if (record) {
      const latest = readState(state.name)
      if (latest?.phase !== 'ready') throw new Error(`instance ${state.name} stopped while its browser session started`)
      saveState({ ...latest, processes: [...latest.processes, record] })
    }
    const deadline = Date.now() + START_MS
    while (!(await answers(state))) {
      if (record && !(await isOurs(record))) throw new Error(`the browser session exited as it started. Its log is ${record.log}`)
      if (Date.now() > deadline) throw new Error(`the browser session did not start within ${String(START_MS / 1000)}s. Its log is ${join(state.evidence, 'session.log')}`)
      await sleep(LOOK_MS)
    }
  } finally {
    if (mine) rmSync(lock, { force: true })
  }
}

export async function sessionCall(state: ReadyState, message: SessionRequest): Promise<SessionReply> {
  await ensure(state)
  return send(state, message)
}

// Asks a running session to close its browsers and exit. Starts nothing.
export async function stopSessionServer(state: InstanceState): Promise<boolean> {
  const running = state.processes.filter((p) => p.role === 'session')
  let alive = false
  for (const record of running) if (await isOurs(record)) alive = true
  if (!alive || !(await answers(state))) return false
  await send(state, { ...PING, op: { op: 'shutdown' } })
  const deadline = Date.now() + START_MS
  while (Date.now() < deadline) {
    let still = false
    for (const record of running) if (await isOurs(record)) still = true
    if (!still) return true
    await sleep(LOOK_MS)
  }
  return false
}
