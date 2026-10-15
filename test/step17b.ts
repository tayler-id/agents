// Step 17b, agentsctl preview. Runs `bin/agentsctl preview` the way a person does and opens what it
// serves in Chromium, Firefox and WebKit. Those browsers send no login of their own, so a page that
// shows the owner's team got its identity from the preview. The check holds it to what a person who works
// on the screens needs: the page loads, /v1 answers as the owner and a WebSocket reaches the API, and a saved
// file shows in the open page with no reload or build. It also holds it to what keeps it private: it listens
// on the loopback address alone, names the person itself, and gives no other page the API or its files.
// It makes two instances of its own on ports 8020 to 8039, and removes both and their teams when it ends.
//   node test/step17b.ts

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { chromium, firefox, webkit, type BrowserType } from '@playwright/test'
import WebSocket from 'ws'
import { z } from 'zod'
import { OUTPUT, type Output } from '../shared/cli/output.ts'
import { messageOf } from '../shared/errors.ts'
import { MeView } from '../shared/onboarding.ts'
import { ScreenClose } from '../shared/screen.ts'
import { withClient } from '../ctl/db.ts'
import { removeForge } from '../ctl/seed.ts'
import { InstanceName, readState, stateFile, type ReadyState } from '../ctl/state.ts'

const ROOT = new URL('..', import.meta.url).pathname
const exec = promisify(execFile)
const name = InstanceName.parse(`preview-${randomBytes(3).toString('hex')}`)
const bare = InstanceName.parse(`${name}-b`)
const failures: string[] = []
// How often a wait in this check looks again.
const LOOK_MS = 100
// A command that ends on its own, such as down or a seed, takes seconds. A minute is a hang.
const CTL_MS = 60_000
// A preview on an instance that runs prints its first line within a second or two. One that makes the
// instance first waits for the API to apply its migrations, which `up` allows a minute for.
const READY_S = 30
const START_S = 90
// A saved file reaches the open page in well under a second here. The person asked for a couple of seconds.
const HOT_UPDATE_MS = 3000
// How long a page may take to show its workspace, and its agents and tasks once it does.
const PAGE_MS = 30_000
// The only things a browser's console says that mean the preview broke the page: the policy refusing
// what the dev server needs, and the update socket failing.
const BROKEN = /content[- ]security[- ]policy|refused to (apply|execute|load|connect)|violates|failed to connect to websocket|WebSocket connection .* failed/i
const SAMPLE_TASK = 'Fix the checkout discount'
const ENGINES: Record<string, BrowserType> = { chromium, firefox, webkit }
// What the check writes under app/src to watch a saved file reach the page, and removes again. None of it is
// the app's, and nothing in the app imports it.
const PROBE = {
  component: join(ROOT, 'app', 'src', 'preview-probe.tsx'),
  style: join(ROOT, 'app', 'src', 'preview-probe.css'),
  mount: join(ROOT, 'app', 'src', 'preview-probe-mount.tsx'),
}

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

type Ran = { code: number; stdout: string; stderr: string }

// A command to its end, with its exit code and both streams. A command that runs past CTL_MS is stopped as Ctrl+C would.
async function ctl(args: string[]): Promise<Ran> {
  return exec(process.execPath, [join(ROOT, 'ctl', 'main.ts'), ...args], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, timeout: CTL_MS, killSignal: 'SIGINT' }).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (error: unknown) => ({
      code: error instanceof Error && 'code' in error && typeof error.code === 'number' ? error.code : -1,
      stdout: error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '',
      stderr: error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '',
    }))
}

// A preview that keeps running: what it printed on each stream, and how it ended.
type Running = { child: ChildProcess; lines: string[]; errors: string[]; ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }
const previews: Running[] = []

// Starts a preview on the instance named, or on the one this checkout has when none is.
function runPreview(instance: string | null, ...flags: string[]): Running {
  const child = spawn(process.execPath, [join(ROOT, 'ctl', 'main.ts'), 'preview', ...(instance === null ? [] : ['--instance', instance]), ...flags, '--json'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  const lines: string[] = []
  const errors: string[] = []
  createInterface({ input: child.stdout }).on('line', (line) => lines.push(line))
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk.toString('utf8')))
  // The close event comes after the last of its output has been read.
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { child.once('close', (code, signal) => { resolve({ code, signal }) }) })
  const running = { child, lines, errors, ended }
  previews.push(running)
  return running
}

// The nth line a preview printed, read as an envelope. It stops waiting when the preview ends or the time is up.
async function envelope(running: Running, index: number, seconds: number): Promise<Output> {
  const deadline = Date.now() + seconds * 1000
  while (running.lines.length <= index && running.child.exitCode === null && Date.now() < deadline) await sleep(LOOK_MS)
  if (running.lines.length <= index) await sleep(LOOK_MS)
  const line = running.lines[index]
  if (line === undefined) throw new Error(`the preview printed no line ${String(index + 1)}, and ${running.child.exitCode === null ? 'was still running' : `ended with ${String(running.child.exitCode)}`}`)
  return OUTPUT.parse(JSON.parse(line))
}

const Serving = z.object({ url: z.url(), instance: z.string(), started: z.boolean(), login: z.string(), log: z.string(), added: z.array(z.string()).nullable() })

// A preview's first line, once it is up. It says so, with the preview's own account of where it serves, or
// the check cannot go on.
async function comesUp(running: Running, seconds: number): Promise<z.infer<typeof Serving>> {
  const first = await envelope(running, 0, seconds)
  if (!first.ok) throw new Error(`preview did not come up: ${first.head}`)
  return Serving.parse(first.data)
}

// Stops a preview as its caller does, with a signal, and reads how it ended.
async function stopWith(running: Running, signal: 'SIGINT' | 'SIGTERM'): Promise<{ code: number | null; last: Output }> {
  running.child.kill(signal)
  const ended = await Promise.race([running.ended, sleep(10_000).then(() => null)])
  if (ended === null) throw new Error(`the preview was still running 10 seconds after ${signal}`)
  return { code: ended.code, last: await envelope(running, running.lines.length - 1, 1) }
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string }

// One request with the headers named, as a caller that is not a browser sends it.
function send(url: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method ?? 'GET', headers: options.headers ?? {} }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }) })
    })
    req.on('error', reject)
    req.end()
  })
}

// Who /v1/me says is asking, as the login and team it names, or what it answered instead.
async function whoAnswers(base: string, headers: Record<string, string> = {}): Promise<string> {
  const reply = await send(`${base}v1/me`, { headers })
  const me = MeView.safeParse(JSON.parse(reply.body))
  return me.success && me.data.kind === 'member' ? `${me.data.person.login} on ${me.data.team.name}` : `${String(reply.status)} ${reply.body}`
}
const asked = (state: ReadyState, login: string) => `${login} on ${state.team}`

// What opening a screen's WebSocket came to: refused with a status before it opened, or opened and then closed by the API.
type Opened = { refused: number } | { code: number; reason: string }
function openScreen(base: string, origin: string | undefined): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}v1/screens/${randomUUID()}`, origin === undefined ? {} : { origin })
    ws.on('unexpected-response', (_req, res) => { resolve({ refused: res.statusCode ?? 0 }) })
    ws.on('close', (code, reason) => { resolve({ code, reason: reason.toString('utf8') }) })
    ws.on('error', reject)
  })
}

const listening = (pid: number) => exec('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn']).then(
  (r) => r.stdout.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1)))
const accepts = (port: number) => new Promise<boolean>((resolve) => {
  const socket = createConnection(port, '127.0.0.1')
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('error', () => { resolve(false) })
})

const held = (teamId: string) => withClient(async (client) => z.object({ repos: z.number(), tasks: z.number() }).parse((await client.query(
  'select (select count(*)::int from repos where team_id = $1) as repos, (select count(*)::int from tasks where team_id = $1) as tasks', [teamId])).rows[0]))

// What one browser makes of the preview's page: whether it loads signed in as the owner, with the team's agents
// and its sample task, and what in its console says the preview broke it.
async function opens(engine: string, base: string, state: ReadyState): Promise<string[]> {
  const type = ENGINES[engine]
  if (!type) throw new Error(`no engine ${engine}`)
  const browser = await type.launch()
  const problems: string[] = []
  try {
    const page = await browser.newPage()
    const socket = { connected: false }
    page.on('pageerror', (error) => { problems.push(`page error: ${error.message}`) })
    page.on('console', (message) => {
      if (message.text().includes('[vite] connected')) socket.connected = true
      if (BROKEN.test(message.text())) problems.push(`console ${message.type()}: ${message.text()}`)
    })
    await page.goto(base)
    const workspace = page.getByRole('navigation', { name: 'Workspace' })
    await workspace.getByText(state.seed.owner.login).waitFor({ timeout: PAGE_MS })
    await workspace.getByText(state.team).waitFor({ timeout: PAGE_MS })
    for (const agent of Object.keys(state.seed.agents)) await page.getByRole('list', { name: 'Agents' }).getByText(agent, { exact: true }).waitFor({ timeout: PAGE_MS })
    await page.getByRole('list', { name: 'Tasks' }).getByText(SAMPLE_TASK).waitFor({ timeout: PAGE_MS })
    const deadline = Date.now() + PAGE_MS
    while (!socket.connected && Date.now() < deadline) await sleep(LOOK_MS)
    if (!socket.connected) problems.push('the page never connected to the update socket')
  } catch (error) {
    problems.push((messageOf(error)).split('\n')[0] ?? 'failed')
  } finally {
    await browser.close()
  }
  return problems
}

// Saves a component and a stylesheet under app/src while a page is open on the preview, and times each
// reaching the page. The page keeps a marker of its own and counts its navigations, which a reload would
// reset. Returns what went wrong, and how long each took.
async function savedFilesReach(base: string): Promise<{ problems: string[]; component: number; style: number; builtBefore: number; builtAfter: number }> {
  const built = join(ROOT, 'app', 'dist', 'index.html')
  const problems: string[] = []
  const write = (version: string, color: string) => {
    writeFileSync(PROBE.component, `import './preview-probe.css'\n\nexport function Probe() {\n  return <p id="preview-probe">probe ${version}</p>\n}\n`)
    writeFileSync(PROBE.style, `#preview-probe { color: ${color}; }\n`)
  }
  const builtBefore = statSync(built).mtimeMs
  const browser = await chromium.launch()
  let component = -1
  let style = -1
  try {
    // The module that mounts the probe is loaded once, by the page. The probe is what a person saves.
    writeFileSync(PROBE.mount, "import { createRoot } from 'react-dom/client'\nimport { Probe } from './preview-probe.tsx'\n\ncreateRoot(document.body.appendChild(document.createElement('div'))).render(<Probe />)\n")
    write('one', 'rgb(10, 20, 30)')
    const page = await browser.newPage()
    let navigations = 0
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations++ })
    await page.goto(base)
    await page.getByRole('navigation', { name: 'Workspace' }).waitFor({ timeout: PAGE_MS })
    await page.evaluate(async (path) => { await import(path) }, '/src/preview-probe-mount.tsx')
    const shows = (text: string, color: string) => page.waitForFunction(([wanted, wantedColor]) => {
      const probe = document.querySelector('#preview-probe')
      return probe?.textContent === wanted && getComputedStyle(probe).color === wantedColor
    }, [text, color] as const, { timeout: HOT_UPDATE_MS * 3 })
    await shows('probe one', 'rgb(10, 20, 30)')
    const marker = randomBytes(4).toString('hex')
    await page.evaluate((value) => { Reflect.set(window, 'previewMarker', value) }, marker)
    const before = navigations

    let saved = Date.now()
    write('two', 'rgb(10, 20, 30)')
    await shows('probe two', 'rgb(10, 20, 30)')
    component = Date.now() - saved
    saved = Date.now()
    write('two', 'rgb(1, 2, 3)')
    await shows('probe two', 'rgb(1, 2, 3)')
    style = Date.now() - saved
    if (await page.evaluate(() => Reflect.get(window, 'previewMarker')) !== marker || navigations !== before) problems.push('the page reloaded, and kept nothing of what it held')
  } catch (error) {
    problems.push((messageOf(error)).split('\n')[0] ?? 'failed')
  } finally {
    await browser.close()
    for (const file of Object.values(PROBE)) rmSync(file, { force: true })
  }
  return { problems, component, style, builtBefore, builtAfter: statSync(built).mtimeMs }
}

// Whatever happened, leaves nothing running, nothing under app/src and nothing in the database.
async function teardown() {
  for (const running of previews) if (running.child.exitCode === null) running.child.kill('SIGKILL')
  for (const file of Object.values(PROBE)) rmSync(file, { force: true })
  for (const instance of [name, bare]) if (existsSync(stateFile(instance))) await ctl(['down', '--instance', instance])
  // Their teams too, should a broken down have left them, and their forge orgs.
  await withClient(async (client) => { await client.query('delete from teams where name = any($1)', [[`verify-${name}`, `verify-${bare}`]]) })
  for (const instance of [name, bare]) await removeForge(instance)
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void teardown().finally(() => { process.exit(1) }) })
}

try {
  // The command line, before any instance.
  const help = await ctl(['preview', '--help'])
  check(help.code === 0 && help.stdout.includes('--as') && help.stdout.includes('--no-seed') && help.stdout.includes('Ctrl+C'), 'preview --help lists its flags and says how it ends, and exits 0')
  const typo = await ctl(['preview', '--bogus'])
  check(typo.code === 2 && typo.stdout.startsWith('error:') && typo.stdout.includes('--as') && typo.stderr === '', 'an unknown flag exits 2, lists the flags preview takes, and prints on stdout')
  const stray = await ctl(['preview', 'ben', '--instance', name])
  const badWho = await ctl(['preview', '--as', 'Bad Name', '--instance', name])
  const dry = await ctl(['preview', '--dry-run', '--instance', name])
  check(stray.code === 2 && stray.stdout.includes('--as') && badWho.code === 2 && dry.code === 0 && dry.stdout.includes('Nothing ran') && !existsSync(stateFile(name)),
    'a word where a flag belongs and a name that is not a person exit 2, and --dry-run runs nothing, all before any instance is made')

  // The first preview in a checkout with no instance starts one.
  const first = runPreview(name)
  const serving = await comesUp(first, START_S)
  const state = readState(name)
  if (state?.phase !== 'ready') throw new Error(`preview left the instance ${name} ${state?.phase ?? 'missing'}`)
  const base = serving.url
  const origin = new URL(base).origin
  check(serving.instance === name && serving.started && serving.login === state.seed.owner.login && base.startsWith('http://127.0.0.1:'),
    'with no instance here, preview starts one, signs in as its owner, and says where to open the app')
  const sample = await held(state.seed.teamId)
  check(serving.added?.length === 2 && sample.repos === 1 && sample.tasks === 1, `an empty team gets a sample repo and a task (it holds ${String(sample.repos)} repo and ${String(sample.tasks)} task)`)
  const pid = first.child.pid
  const addresses = pid === undefined ? [] : await listening(pid)
  check(addresses.length > 0 && addresses.every((address) => address.startsWith('127.0.0.1:')), `the preview listens on 127.0.0.1 only (${addresses.join(', ')})`)

  // The page, as the dev server's.
  const page = await send(base)
  check(page.status === 200 && page.body.includes('/@vite/client') && page.body.includes('/src/main.tsx') && /default-src 'self'/.test(page.body) && /script-src 'self' 'nonce-/.test(page.body),
    "the page is the app from source on Vite's dev server, with the app's policy kept and only a nonce added for what Vite makes")
  for (const engine of Object.keys(ENGINES)) {
    const problems = await opens(engine, base, state)
    check(problems.length === 0, `${engine} opens the preview signed in as ${state.seed.owner.login}, with the team's agents and task, connected for updates${problems.length ? `, and ${problems.join('; ')}` : ''}`)
  }

  // The API through it.
  check(await whoAnswers(base) === asked(state, state.seed.owner.login), "/v1/me through the preview answers as the instance's owner")
  check(await whoAnswers(base, { 'tailscale-user-login': state.seed.teammate.login }) === asked(state, state.seed.owner.login),
    "a caller can't choose who it is, since a Tailscale-User-Login it sends is dropped and the preview's own is used")
  const viaPreview = await openScreen(base, origin)
  check('code' in viaPreview && viaPreview.code === ScreenClose.notAllowed && viaPreview.reason === 'no such screen',
    `a WebSocket through the preview reaches the API, which knows who is asking and answers for itself (${JSON.stringify(viaPreview)})`)
  const straight = await openScreen(`http://127.0.0.1:${String(state.ports.people)}/`, origin)
  check('refused' in straight && straight.refused === 403, `the same WebSocket sent to the people door with the preview's origin is refused (${JSON.stringify(straight)}), so the origin the preview gives it is what lets it in`)

  // Other pages on this Mac.
  const foreign = 'http://127.0.0.1:9'
  const aimed = [
    await send(`${base}v1/me`, { headers: { origin: foreign } }),
    await send(`${base}v1/me`, { method: 'OPTIONS', headers: { origin: foreign, 'access-control-request-method': 'POST' } }),
  ]
  const sockets = [await openScreen(base, foreign), await openScreen(base, undefined)]
  check(aimed.every((reply) => reply.status === 404 && !reply.body.includes(state.seed.owner.login)) && sockets.every((s) => 'refused' in s && s.refused === 404),
    'a page of another origin, or none, gets nothing of the API through the preview, over HTTP or a WebSocket')
  const source = await send(`${base}src/main.tsx`, { headers: { origin: foreign } })
  check(source.status === 200 && source.headers['access-control-allow-origin'] === undefined, "a page of another origin on this Mac is given no CORS permission to read the preview's files")
  const rebinding = await send(`${base}v1/me`, { headers: { host: 'agents.example:80' } })
  check(rebinding.status === 403, 'a request that names another host, as a rebound DNS name does, is refused')

  // A saved file.
  const saved = await savedFilesReach(base)
  check(!saved.problems.length && saved.component <= HOT_UPDATE_MS && saved.builtAfter === saved.builtBefore,
    `a saved component reaches the open page in ${String(saved.component)} ms, with no reload and no build${saved.problems.length ? `, and ${saved.problems.join('; ')}` : ''}`)
  check(!saved.problems.length && saved.style <= HOT_UPDATE_MS, `a saved stylesheet reaches it in ${String(saved.style)} ms, in a style the page's policy allows`)
  check(readFileSync(serving.log, 'utf8').includes('hmr update') && first.errors.length === 0, "Vite's messages go to preview.log in the instance's evidence folder, and none to the terminal")

  // A second preview, for another instance, while the first runs.
  const second = runPreview(bare, '--no-seed')
  const secondServing = await comesUp(second, START_S)
  const bareState = readState(bare)
  if (bareState?.phase !== 'ready') throw new Error(`preview left the instance ${bare} ${bareState?.phase ?? 'missing'}`)
  const empty = await held(bareState.seed.teamId)
  check(secondServing.url !== base && secondServing.added === null && empty.repos === 0 && empty.tasks === 0,
    `a second preview takes a port of its own, and --no-seed leaves its team empty (${secondServing.url}, ${String(empty.repos)} repos, ${String(empty.tasks)} tasks)`)
  check(await whoAnswers(secondServing.url) === asked(bareState, bareState.seed.owner.login), 'each preview signs in to its own instance')
  const several = await ctl(['preview'])
  const here = z.object({ data: z.array(z.unknown()) }).parse(JSON.parse((await ctl(['list', '--json'])).stdout)).data
  check(several.code === 2 && several.stdout.includes('several instances') && several.stdout.includes('--instance') && here.length === 2,
    'with two instances here and none named, preview exits 2 and starts no third')
  const secondStopped = await stopWith(second, 'SIGTERM')
  check(secondStopped.code === 0 && secondStopped.last.code === 0 && secondStopped.last.head.includes('stopped by SIGTERM'), 'SIGTERM stops a preview with exit 0 and a last result that says so')

  // A team a run left with a repo and no task gets the task, and no second repo.
  const seededRepo = await ctl(['seed', 'repo', 'shop', '--instance', bare])
  const third = runPreview(bare)
  const thirdServing = await comesUp(third, READY_S)
  const converged = await held(bareState.seed.teamId)
  check(seededRepo.code === 0 && thirdServing.added?.length === 1 && converged.repos === 1 && converged.tasks === 1,
    `a team with a repo and no task gets only the task (${String(converged.repos)} repo and ${String(converged.tasks)} task after)`)
  await stopWith(third, 'SIGINT')
  const goneSecond = await ctl(['down', '--instance', bare])
  check(goneSecond.code === 0 && !existsSync(stateFile(bare)), "down stops the second preview's instance, and removes its team")

  // The first one ends, and the instance stays.
  const stopped = await stopWith(first, 'SIGINT')
  check(stopped.code === 0 && stopped.last.code === 0 && stopped.last.head.includes(`ok: preview ${name} -> stopped by Ctrl+C`), 'Ctrl+C stops the preview with exit 0 and a last result that says so')
  check(!await accepts(Number(new URL(base).port)) && first.lines.every((line) => OUTPUT.safeParse(JSON.parse(line)).success), 'its port is free again, and everything it printed was an envelope')
  check(await whoAnswers(`http://127.0.0.1:${String(state.ports.people)}/`, { 'tailscale-user-login': state.seed.owner.login }) === asked(state, state.seed.owner.login), 'the instance keeps running after the preview stops')

  // Again with no instance named, as someone else.
  const again = runPreview(null, '--as', 'ben')
  const againServing = await comesUp(again, READY_S)
  const after = await held(state.seed.teamId)
  check(againServing.instance === name && !againServing.started && againServing.added?.length === 0 && after.tasks === 1 && after.repos === 1 && againServing.login === state.seed.teammate.login,
    'with one instance here and none named, preview uses it, adds no second sample, and signs in as the person --as names')
  check(await whoAnswers(againServing.url) === asked(state, state.seed.teammate.login), '/v1/me answers as ben through it')
  await stopWith(again, 'SIGINT')

  // Down removes what preview started with the instance.
  const down = await ctl(['down', '--instance', name])
  check(down.code === 0 && !existsSync(stateFile(name)) && !await accepts(state.ports.people), 'down stops the instance preview started, and nothing answers on its ports')
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  await teardown()
}

console.log(`\n${failures.length ? `${String(failures.length)} failed` : 'all passed (both instances are down and their teams removed)'}`)
process.exit(failures.length ? 1 : 0)
