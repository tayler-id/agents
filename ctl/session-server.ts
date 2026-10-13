// The browser session: one long-lived process per instance that holds the
// browsers, the desktop app and their pages, so each `agentsctl browser` or
// `agentsctl desktop` call is quick and finds the page as the last call left
// it. It listens on a Unix socket in the instance's scratch folder, does one
// request at a time through the Driver in driver.ts, and closes everything when
// told to shut down, when it has been idle for IDLE_MS, or when its instance is gone.
//   node ctl/session-server.ts <state file>

import { createServer } from 'node:http'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { perform, type PageKey } from './driver.ts'
import { nextPath } from './evidence.ts'
import { playwrightDriver } from './playwright.ts'
import { childrenOf } from './procs.ts'
import { SessionRequest, type Found, type SessionReply } from './protocol.ts'
import { InstanceState, type ProcessRecord, type ReadyState } from './state.ts'
import { captureViews } from './visual.ts'

// A session nobody has used for this long closes, so a run that forgot `down`
// does not leave browsers open for good.
const IDLE_MS = 30 * 60_000
// How often the session checks its instance is still there.
const INSTANCE_LOOK_MS = 5_000

const file = process.argv[2]
if (!file) throw new Error('usage: node ctl/session-server.ts <state file>')
const parsed = InstanceState.parse(JSON.parse(readFileSync(file, 'utf8')))
if (parsed.phase !== 'ready') throw new Error(`instance ${parsed.name} is ${parsed.phase}, not ready`)
const state: ReadyState = parsed
const socket = join(state.scratch, 'session.sock')
const childrenFile = join(state.scratch, 'session-children.json')

// The processes this session started, so `down` finds them even if this process dies first.
async function recordChildren() {
  const records: ProcessRecord[] = (await childrenOf(process.pid))
    .map((child) => ({ role: 'session', pid: child.pid, started: child.started, argv: [child.command], log: join(state.evidence, 'session.log') }))
  writeFileSync(childrenFile, JSON.stringify(records))
}

const driver = playwrightDriver(state, recordChildren)

async function shutdown(code: number) {
  await driver.shutdown()
  rmSync(socket, { force: true })
  process.exit(code)
}

let idle = setTimeout(() => { void shutdown(0) }, IDLE_MS)
const said = (summary: string): SessionReply => ({ ok: true, found: { url: '', summary, pass: true, files: [] } })

async function handle(request: SessionRequest): Promise<SessionReply> {
  clearTimeout(idle)
  idle = setTimeout(() => { void shutdown(0) }, IDLE_MS)
  const { op } = request
  if (op.op === 'ping') return said('the session is up')
  if (op.op === 'shutdown') {
    setTimeout(() => { void shutdown(0) }, 0)
    return said('the session is closing its browsers')
  }
  const key: PageKey = { target: request.target, engine: request.engine, width: request.width, login: request.login }
  try {
    if (op.op === 'close') {
      await driver.close(key)
      return said('closed the page')
    }
    await driver.open(key)
    if (op.op === 'record') {
      const path = nextPath(state.evidence, 'videos', op.label, 'webm')
      const { already, file: video } = await driver.record(key, op.action, op.label, path, request.timeoutMs)
      const summary = op.action === 'start'
        ? (already ? 'a recording was already running' : `recording "${op.label}" from ${driver.url(key)}. Drive the steps, then: record stop`)
        : (already ? 'nothing was recording' : `saved the recording "${op.label}" to ${path}`)
      return { ok: true, found: { url: driver.url(key), summary, pass: true, already, files: video ? [video] : [] } }
    }
    if (op.op === 'visual') {
      if (request.target === 'desktop') throw new Error('visual captures are of the web app; the desktop app shows the same pages')
      const captures = await captureViews(driver, key, op.state, op.ready, state.evidence, request.timeoutMs)
      const problems = captures.filter((c) => c.violations.length || c.overflow || c.errors.length)
      const found: Found = {
        url: driver.url(key), pass: !problems.length, files: captures.map((c) => c.file), captures,
        summary: `captured ${op.state} at ${new URL(driver.url(key)).hash || '#/'} in ${String(captures.length)} engine and width pairs`
          + (problems.length ? `. Problems: ${problems.map((c) => `${c.engine}-${c.width}: ${[
            ...c.violations.map((v) => `${v.impact} ${v.id}`), ...(c.overflow ? ['sideways scrolling'] : []), ...c.errors].join(', ')}`).join('; ')}`
            : ', each with no accessibility violation, no console error, and no sideways scrolling at phone width'),
      }
      return { ok: true, found }
    }
    return { ok: true, found: await perform(driver, key, op, request.timeoutMs) }
  } catch (error) {
    // What the page looked like when it failed, kept as evidence.
    const files: string[] = []
    const shot = nextPath(state.evidence, 'failures', `${request.target}-${op.op}`, 'png')
    await driver.screenshot(key, { path: shot, timeoutMs: request.timeoutMs }).then(() => { files.push(shot) }, (shotError: unknown) => {
      console.error(`no failure screenshot: ${shotError instanceof Error ? shotError.message : String(shotError)}`)
    })
    return { ok: false, error: error instanceof Error ? error.message : String(error), url: driver.url(key), files }
  }
}

rmSync(socket, { force: true })
let queue: Promise<unknown> = Promise.resolve()
const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
  req.on('end', () => {
    const work = queue.then(async () => {
      const request = SessionRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      return handle(request)
    }).catch((error: unknown): SessionReply => ({ ok: false, error: error instanceof Error ? error.message : String(error), url: '', files: [] }))
    queue = work
    void work.then((reply) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply)) })
  })
})
server.listen(socket, () => { console.log(`session for ${state.name} on ${socket}`) })
process.on('SIGTERM', () => { void shutdown(0) })
// The instance stopped or was removed: nothing left to drive.
setInterval(() => { if (!existsSync(file)) void shutdown(0) }, INSTANCE_LOOK_MS).unref()
