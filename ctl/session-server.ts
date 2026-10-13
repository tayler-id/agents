// The browser session: one long-lived process per instance that holds Playwright
// browsers, the Electron app and their pages, so each `agentsctl browser` or
// `agentsctl desktop` call is quick and finds the page as the last call left
// it. It listens on a Unix socket in the instance's scratch folder, does one
// request at a time, and closes everything when told to shut down, when it has
// been idle for IDLE_MS, or when its instance is gone.
//   node ctl/session-server.ts <state file>

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { _electron as electron, chromium, firefox, webkit, type Browser, type BrowserContext, type ElectronApplication, type Page, type Request } from '@playwright/test'
import { childEnv, ROOT } from './config.ts'
import { axe, failsAxe, loaded, locate, overflowOf, perform, screenshot } from './drive.ts'
import { nextPath } from './evidence.ts'
import { childrenOf } from './procs.ts'
import { ENGINES, SessionRequest, VIEWPORTS, type Capture, type Engine, type Found, type Op, type SessionReply, type Viewport } from './protocol.ts'
import { InstanceState, type ProcessRecord, type ReadyState } from './state.ts'
import { capturePath, steadyShot } from './visual.ts'

// A session nobody has used for this long closes, so a run that forgot `down`
// does not leave browsers open for good.
const IDLE_MS = 30 * 60_000
// Electron takes longer than a browser page to open its first window.
const DESKTOP_START_MS = 30_000
const SIZES: Record<Viewport, { width: number; height: number }> = { desktop: { width: 1280, height: 820 }, phone: { width: 390, height: 844 } }
// Over the tailnet the app is plain HTTP on a name that is not localhost, so
// browsers withhold secure-page APIs such as crypto.randomUUID. Chromium and
// Firefox reach the instance by a made-up name to match. WebKit cannot map a
// name, so it uses the loopback address.
const INSECURE_HOST = 'agents.test'
const LAUNCH: Record<Engine, Parameters<typeof chromium.launch>[0]> = {
  chromium: { args: [`--host-resolver-rules=MAP ${INSECURE_HOST} 127.0.0.1`] },
  firefox: { firefoxUserPrefs: { 'network.dns.localDomains': INSECURE_HOST } },
  webkit: {},
}
const TYPES = { chromium, firefox, webkit }

const file = process.argv[2]
if (!file) throw new Error('usage: node ctl/session-server.ts <state file>')
const parsed = InstanceState.parse(JSON.parse(readFileSync(file, 'utf8')))
if (parsed.phase !== 'ready') throw new Error(`instance ${parsed.name} is ${parsed.phase}, not ready`)
const state: ReadyState = parsed
const socket = join(state.scratch, 'session.sock')
const childrenFile = join(state.scratch, 'session-children.json')

const origin = (engine: Engine) => `http://${engine === 'webkit' ? '127.0.0.1' : INSECURE_HOST}:${String(state.ports.people)}`

type Recording = { label: string; dir: string }
type Holder = {
  context: BrowserContext | null; page: Page; errors: string[]; app: ElectronApplication | null; reads: Set<Request>
  recording: Recording | null
}
const browsers = new Map<Engine, Browser>()
const holders = new Map<string, Holder>()
// How often a capture looks for reads still in flight.
const QUIET_POLL_MS = 100

// A read of a shape that answers at once. Live reads (live=true) wait for changes, so they never count.
const isRead = (url: string) => url.includes('/v1/shape/') && !url.includes('live=true')

function listen(page: Page, errors: string[], reads: Set<Request>) {
  page.on('pageerror', (error) => { errors.push(`page error: ${error.message}`) })
  page.on('console', (message) => {
    // A failed request's message names no address. Its location does.
    const where = message.location().url
    if (message.type() === 'error') errors.push(`console: ${message.text()}${where ? ` (${where})` : ''}`)
  })
  page.on('request', (r) => { if (isRead(r.url())) reads.add(r) })
  page.on('requestfinished', (r) => { reads.delete(r) })
  page.on('requestfailed', (r) => { reads.delete(r) })
}

// Waits until the page has no shape read in flight.
async function quiet(holder: Holder, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (holder.reads.size) {
    if (Date.now() > deadline) throw new Error(`the page still had ${String(holder.reads.size)} reads in flight after ${String(timeoutMs / 1000)}s`)
    await sleep(QUIET_POLL_MS)
  }
}

// The processes this session started, so `down` finds them even if this process dies first.
async function recordChildren() {
  const records: ProcessRecord[] = (await childrenOf(process.pid))
    .map((child) => ({ role: 'session', pid: child.pid, started: child.started, argv: [child.command], log: join(state.evidence, 'session.log') }))
  writeFileSync(childrenFile, JSON.stringify(records))
}

const browserKey = (engine: Engine, viewport: Viewport, login: string) => `browser|${engine}|${viewport}|${login}`
const desktopKey = (viewport: Viewport, login: string) => `desktop|${viewport}|${login}`

async function browserPage(engine: Engine, viewport: Viewport, login: string, recording: Recording | null = null): Promise<Holder> {
  const key = browserKey(engine, viewport, login)
  const found = holders.get(key)
  if (found && !found.page.isClosed()) return found
  let browser = browsers.get(engine)
  if (!browser) {
    browser = await TYPES[engine].launch(LAUNCH[engine])
    browsers.set(engine, browser)
    await recordChildren()
  }
  // Firefox has no mobile mode, so its phone view is only the narrow window.
  const mobile = viewport === 'phone' && engine !== 'firefox'
  const context = await browser.newContext({
    baseURL: origin(engine), extraHTTPHeaders: { 'tailscale-user-login': login }, viewport: SIZES[viewport],
    isMobile: mobile, hasTouch: mobile, locale: 'en-US', timezoneId: 'UTC',
    ...(recording ? { recordVideo: { dir: recording.dir, size: SIZES[viewport] } } : {}),
  })
  const page = await context.newPage()
  const holder: Holder = { context, page, errors: [], app: null, reads: new Set(), recording }
  listen(page, holder.errors, holder.reads)
  holders.set(key, holder)
  await page.goto('/')
  return holder
}

// The desktop app, one per login, each with a home folder of its own so it reads
// no app.json and shares no browser profile with the desktop app a person runs.
async function desktopPage(viewport: Viewport, login: string, recording: Recording | null = null): Promise<Holder> {
  const key = desktopKey(viewport, login)
  const found = holders.get(key)
  if (found && !found.page.isClosed()) return found
  const home = join(state.scratch, 'desktop', login.replace(/[^a-z0-9]+/gi, '-'))
  mkdirSync(home, { recursive: true })
  const app = await electron.launch({
    args: [`--host-resolver-rules=MAP ${INSECURE_HOST} 127.0.0.1`, `--user-data-dir=${join(home, 'profile')}`, join(ROOT, 'desktop', 'main.cjs')],
    cwd: ROOT,
    env: childEnv({ HOME: home, AGENTS_SERVER: origin('chromium'), AGENTS_DEV_LOGIN: login, AGENTS_PROXY: '' }),
    ...(recording ? { recordVideo: { dir: recording.dir, size: SIZES[viewport] } } : {}),
  })
  await recordChildren()
  const page = await app.firstWindow()
  const size = SIZES[viewport]
  await app.evaluate(({ BrowserWindow }, s) => { BrowserWindow.getAllWindows()[0]?.setContentSize(s.width, s.height) }, size)
  const holder: Holder = { context: null, page, errors: [], app, reads: new Set(), recording }
  listen(page, holder.errors, holder.reads)
  holders.set(key, holder)
  await loaded(page, DESKTOP_START_MS)
  return holder
}

async function closeHolder(holder: Holder) {
  if (holder.app) await holder.app.close()
  else await holder.context?.close()
  for (const [key, value] of holders) if (value === holder) holders.delete(key)
}

// Recording starts a fresh page at the address the page was on, since a video
// is set up when a page opens, and ends by closing it, which writes the video.
async function record(holder: Holder, request: SessionRequest, op: Extract<Op, { op: 'record' }>): Promise<Found> {
  const url = holder.page.url()
  const open = (recording: Recording | null) => (request.target === 'desktop'
    ? desktopPage(request.viewport, request.login, recording)
    : browserPage(request.engine, request.viewport, request.login, recording))
  if (op.action === 'start') {
    if (holder.recording) throw new Error(`already recording "${holder.recording.label}". Stop it first with: bin/agentsctl ${request.target} record stop`)
    await closeHolder(holder)
    const fresh = await open({ label: op.label, dir: join(state.scratch, 'video', String(Date.now())) })
    await fresh.page.goto(url, { timeout: request.timeoutMs })
    await loaded(fresh.page, request.timeoutMs)
    return { url, summary: `recording "${op.label}" from ${url}. Drive the steps, then: bin/agentsctl ${request.target} record stop`, pass: true, files: [] }
  }
  if (!holder.recording) throw new Error(`nothing is recording. Start with: bin/agentsctl ${request.target} record start --label "<what it shows>"`)
  const file = await saveRecording(holder)
  const back = await open(null)
  await back.page.goto(url, { timeout: request.timeoutMs })
  return { url, summary: `saved the recording "${holder.recording.label}" to ${file}`, pass: true, files: [file] }
}

// Closes a recording page, which finishes its video, and keeps the video with the evidence.
async function saveRecording(holder: Holder): Promise<string> {
  const video = holder.page.video()
  if (!holder.recording || !video) throw new Error('this page is not recording')
  await closeHolder(holder)
  const file = nextPath(state.evidence, 'videos', holder.recording.label, 'webm')
  await video.saveAs(file)
  return file
}

async function captureAll(from: Page, request: SessionRequest, stateName: string, ready: Extract<Op, { op: 'visual' }>): Promise<Found> {
  const route = new URL(from.url()).hash || '#/'
  const captures: Capture[] = []
  for (const engine of ENGINES) {
    for (const viewport of VIEWPORTS) {
      const holder = await browserPage(engine, viewport, request.login)
      const before = holder.errors.length
      // A full load, so every list reads the record as it is now. Moving between
      // routes only changes the hash, and lists the app polls would show what
      // they read seconds ago.
      await holder.page.goto('about:blank')
      await holder.page.goto(`/${route}`, { timeout: request.timeoutMs })
      await loaded(holder.page, request.timeoutMs)
      if (ready.ready) await locate(holder.page, ready.ready).first().waitFor({ state: 'visible', timeout: request.timeoutMs })
      const path = capturePath(state.evidence, engine, viewport, stateName)
      await steadyShot({ ...holder, quiet: () => quiet(holder, request.timeoutMs) }, path)
      const violations = failsAxe(await axe(holder.page))
      const overflow = viewport === 'phone' && (await overflowOf(holder.page)).scrollWidth > SIZES.phone.width
      captures.push({ engine, viewport, file: path, violations, overflow, errors: holder.errors.slice(before) })
    }
  }
  const problems = captures.filter((c) => c.violations.length || c.overflow || c.errors.length)
  const summary = `captured ${stateName} at ${route} in ${String(captures.length)} engine and width pairs`
    + (problems.length ? `. Problems: ${problems.map((c) => `${c.engine}-${c.viewport}: ${[
      ...c.violations.map((v) => `${v.impact} ${v.id}`), ...(c.overflow ? ['sideways scrolling'] : []), ...c.errors].join(', ')}`).join('; ')}` : ', each with no accessibility violation, no console error, and no sideways scrolling at phone width')
  return { url: from.url(), summary, pass: !problems.length, files: captures.map((c) => c.file), captures }
}

async function shutdown(code: number) {
  for (const holder of [...holders.values()]) {
    // A recording nobody stopped is still evidence, so it is kept, not dropped with the scratch folder.
    if (holder.recording) await saveRecording(holder)
    else await closeHolder(holder)
  }
  for (const browser of browsers.values()) await browser.close()
  rmSync(socket, { force: true })
  process.exit(code)
}

let idle = setTimeout(() => { void shutdown(0) }, IDLE_MS)

async function handle(request: SessionRequest): Promise<SessionReply> {
  clearTimeout(idle)
  idle = setTimeout(() => { void shutdown(0) }, IDLE_MS)
  const { op } = request
  if (op.op === 'ping') return { ok: true, found: { url: '', summary: 'the session is up', pass: true, files: [] } }
  if (op.op === 'shutdown') {
    setTimeout(() => { void shutdown(0) }, 0)
    return { ok: true, found: { url: '', summary: 'the session is closing its browsers', pass: true, files: [] } }
  }
  const holder = request.target === 'desktop' ? await desktopPage(request.viewport, request.login) : await browserPage(request.engine, request.viewport, request.login)
  try {
    if (op.op === 'close') {
      await closeHolder(holder)
      return { ok: true, found: { url: '', summary: 'closed the page', pass: true, files: [] } }
    }
    if (op.op === 'record') return { ok: true, found: await record(holder, request, op) }
    if (op.op === 'visual') {
      if (request.target === 'desktop') throw new Error('visual captures are of the web app; the desktop app shows the same pages')
      return { ok: true, found: await captureAll(holder.page, request, op.state, op) }
    }
    return { ok: true, found: await perform({ page: holder.page, errors: holder.errors, timeoutMs: request.timeoutMs }, op) }
  } catch (error) {
    // What the page looked like when it failed, kept as evidence.
    const files: string[] = []
    if (!holder.page.isClosed()) {
      const shot = nextPath(state.evidence, 'failures', `${request.target}-${op.op}`, 'png')
      await screenshot(holder, { path: shot }).then(() => { files.push(shot) }, (shotError: unknown) => {
        console.error(`no failure screenshot: ${shotError instanceof Error ? shotError.message : String(shotError)}`)
      })
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error), url: holder.page.isClosed() ? '' : holder.page.url(), files }
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
setInterval(() => { if (!existsSync(file)) void shutdown(0) }, 5_000).unref()
