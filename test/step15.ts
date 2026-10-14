// Agent computers, step 15. A real box built from box/Dockerfile, under the tag
// agents-box:computers, runs the stand-in for Claude within its limits. Its
// desktop comes up, sees none of the daemon's tokens, and reports a screen. A
// task's session in it gets the computer tools, the standing instructions and
// the verify-work skill, and those tools drive the box's screen and browser.
// People watch the screen through the API's people socket, from the app's own
// origin only, and take it over. Only the one who holds it can type, the
// agent's calls stop and are refused until they hand it back, the record shows
// it, a view closed without handing back gives the screen back on its own, and
// private work that starts on the box cuts off whoever can't see it. Dead viewers
// and tunnels are dropped. A screenshot the agent saves becomes an image
// document. When the box stops, its viewers are told. When it starts again,
// is killed or is recreated, its screen and browser come back, and work that
// was waiting for it gets its computer. A box whose desktop can't come up starts
// again, and a connection reset mid-upgrade leaves the API up.
// Prints the image's size, the time from a key press in a viewer to its pixels,
// and the box's memory and CPU.
// The box reaches this check's API only on 7701, the machine port the box
// firewall opens for checks, so run it holding ~/.agents-app/checks/run.lock.
//   node --env-file=.env --env-file=.env.test test/step15.ts

import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import WebSocket from 'ws'
import { must } from './must.ts'
import {
  ROOT, IMAGE, MACHINE_PORT, SCREEN, SQUARE, INPUT, PAGE_URL, F2, within, docker, tryDocker, boxCheckEnv, peopleSocket, computerTools, textOf, imageOf, pngSize,
  pageSays, stopAll, listensHere,
} from './computers.ts'
import { servePeople } from './people.ts'
import { SCREEN_DEAD_MS, SCREEN_PING_MS } from '../shared/screen.ts'

const PEOPLE_PORT = 7980
const STREAMS_PORT = 7981
const API = `http://127.0.0.1:${MACHINE_PORT}`
const PEOPLE = `http://127.0.0.1:${PEOPLE_PORT}`
const id = randomBytes(4).toString('hex')
const team = `comp-${id}`
const otherTeam = `comp-other-${id}`
const alice = `alice-comp-${id}@local`
const bob = `bob-comp-${id}@local`
const carol = `carol-comp-${id}@local`
const boxName = `box-${id}`
// Box mounts come from the colima VM, which sees only the home folder.
const work = join(homedir(), '.agents-app', 'checks', `comp-${id}`)
const LATENCY_TRIALS = 20
// The longest a key press may take to show before the check calls the path broken.
const LATENCY_LIMIT_MS = 1000
// How long one F2 press may take to change the square before its trial gives up.
const KEY_SHOWS_MS = 3000
// docker stats samples about once a second, so this gives five or six samples.
const IDLE_SAMPLE_MS = 6000
// Where the daemon keeps the box browser's profile, AGENTS_HOME/browser.
const BOX_PROFILE = '/home/agent/.agents-app/browser'
// Xvnc's lock for display :1, which holds its process id in ten columns.
const X_LOCK = '/tmp/.X1-lock'
// The origin of the app's pages in this check. A browser sends its page's origin
// when it opens a WebSocket, and these viewers send it as the app's pages would.
const ORIGIN = `http://127.0.0.1:${PEOPLE_PORT}`
// A browser call long enough to be under way when a person takes over.
const LONG_CALL_MS = 10_000
// The daemon's limit for its desktop to come up, the desktop's own start limit,
// with time for Docker to start the box again after it gives up.
const DESKTOP_GIVES_UP_S = 30 + 30
// How long a viewer or tunnel that stopped answering pings may stay open.
const DEAD_SOCKET_S = (SCREEN_DEAD_MS + 2 * SCREEN_PING_MS) / 1000
// The limits a box runs under, as server/boxes.ts sets them.
const BOX_LIMITS = { memory: 4 * 1024 ** 3, nanoCpus: 2e9, pids: 4096 }

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []
const closers: (() => Promise<void> | void)[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
// A command that runs while the check keeps sampling the box's stats.
const run = promisify(execFile)
const checkEnv = boxCheckEnv(team, work, STREAMS_PORT, [ORIGIN])
const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', '--env-file=.env.test', ...args],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...checkEnv } })

async function post(login: string, path: string, body: unknown = {}) {
  const res = await fetch(PEOPLE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

// A person's Screen view, as the app opens it. It is a WebSocket on the people
// port carrying the screen as binary frames and who holds it as text frames.
type View = { ws: WebSocket; stream: Duplex; controls: any[]; closed: { code: number; reason: string } | null }
function openView(login: string, instanceId: string, base = `ws://127.0.0.1:${PEOPLE_PORT}`, headers: Record<string, string> = {}): Promise<View | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base}/v1/screens/${instanceId}`, { headers: { 'tailscale-user-login': login, origin: ORIGIN, ...headers } })
    const view: View = {
      ws, controls: [], closed: null,
      stream: new Duplex({ read() { /* frames are pushed as they arrive */ }, write(chunk, _encoding, done) { ws.send(chunk, done) } }),
    }
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0) })
    ws.on('open', () => { resolve(view) })
    // Messages arrive as single Buffers with ws's default settings.
    ws.on('message', (data, isBinary) => {
      if (!Buffer.isBuffer(data)) throw new Error('a screen message arrived as something other than one Buffer')
      if (isBinary) view.stream.push(data)
      else view.controls.push(JSON.parse(data.toString('utf8')))
    })
    ws.on('close', (code, reason) => {
      view.closed = { code, reason: String(reason) }
      view.stream.destroy()
    })
    ws.on('error', () => { /* an unexpected response or a close reports it */ })
  })
}

const holderOf = (view: View) => view.controls.at(-1)?.control

// How opening a screen goes for a person: watching once the API says who holds
// it, closed with the code and reason the API gave, or an HTTP refusal.
async function outcome(login: string, instanceId: string): Promise<string> {
  const view = await openView(login, instanceId)
  if (typeof view === 'number') return `http ${view}`
  await within(10, async () => view.closed !== null || view.controls.length > 0)
  const result = view.closed ? `closed ${view.closed.code} ${view.closed.reason}` : view.controls.length ? 'watching' : 'silent'
  view.ws.close()
  return result
}

// Samples the container's memory and CPU while `during` runs, from docker stats.
async function measure(container: string, during: () => Promise<unknown>) {
  const stats = spawn('docker', ['stats', '--format', '{{.MemUsage}}|{{.CPUPerc}}', container])
  const samples: { mib: number; cpu: number }[] = []
  stats.stdout.setEncoding('utf8').on('data', (text: string) => {
    for (const line of text.split('\n')) {
      // Each refresh starts with terminal escape codes before the values.
      const match = /([\d.]+)(MiB|GiB)\s*\/[^|]*\|([\d.]+)%/.exec(line)
      if (match) samples.push({ mib: Number(match[1]) * (match[2] === 'GiB' ? 1024 : 1), cpu: Number(match[3]) })
    }
  })
  // docker stats takes a second or two to print its first sample, and samples
  // about once a second after that, so wait for one before and one after.
  await within(10, async () => samples.length > 0)
  await during()
  const after = samples.length
  await within(5, async () => samples.length > after)
  stats.kill()
  const peak = Math.max(...samples.map((s) => s.mib))
  const cpu = Math.max(...samples.map((s) => s.cpu))
  const settled = samples.at(-1)?.mib ?? 0
  return { peak: Math.round(peak), last: Math.round(settled), cpu: Math.round(cpu), samples: samples.length }
}

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

let container = ''
try {
  // The API's input filter on its own, fed the bytes a viewer sends. A viewer
  // that doesn't hold the screen gets its handshake through and its clicks and
  // keys dropped. Once it holds the screen they pass.
  const { RfbInputFilter } = await import('../server/rfb-filter.ts')
  const rfb = await import('../shared/rfb.ts')
  const filter = new RfbInputFilter(false)
  const handshake = [Buffer.from(rfb.RFB_VERSION, 'latin1'), Uint8Array.of(rfb.SECURITY_NONE), Uint8Array.of(0)].map((bytes) => filter.push(bytes).length)
  const press = rfb.pointerEvent(10, 10, 1)
  const key = rfb.keyEvent(0x61, true)
  const dropped = [press, key].map((bytes) => filter.push(bytes).length)
  filter.setAllowInput(true)
  const passed = [press, key].map((bytes) => filter.push(bytes).length)
  check(handshake.join() === '1,1,1' && dropped.join() === '0,0' && passed.join() === '1,1',
    `the API's input filter drops a click and a key from a viewer without the screen, and passes them once it holds it (dropped ${dropped.join()}, passed ${passed.join()})`)

  await db.connect()
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'scenario.json'), JSON.stringify({ turns: [{ match: 'Show me the page you checked', screenshot: true, reply: 'Here it is.' }] }))
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, alice)
  node('server/admin.ts', 'add-person', team, bob)
  node('server/admin.ts', 'add-team', otherTeam, carol)

  const built = Date.now()
  node('server/boxes.ts', 'build')
  const imageBytes = Number(docker('image', 'inspect', IMAGE, '--format', '{{.Size}}'))
  console.log(`      built ${IMAGE} in ${Math.round((Date.now() - built) / 1000)} s, ${(imageBytes / 1e9).toFixed(2)} GB compressed`)

  const api = spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, ...checkEnv },
  })
  children.push(api)
  // Stands in for tailscale serve, which sends people to the API's socket.
  await servePeople(PEOPLE_PORT, peopleSocket(work))
  await within(20, () => fetch(API).then(() => true, () => false))

  const { instanceId } = JSON.parse(node('server/boxes.ts', 'create', team, boxName))
  container = `agents-box-${instanceId}`
  node('server/admin.ts', 'add-agent', team, 'tester', boxName)
  const { id: teamId } = must(await one('select id from teams where name = $1', [team]), 'teamId')

  // The desktop comes up and the box says it has a screen.
  const screenUp = await within(120, async () => {
    const row = await one('select status, screen_width, screen_height from instances where id = $1', [instanceId])
    return row?.status === 'online' && row.screen_width === SCREEN.width && row.screen_height === SCREEN.height
  })
  check(screenUp, `the box comes online and reports a ${SCREEN.width}x${SCREEN.height} screen`)
  if (!screenUp) throw new Error('the box never reported a screen, so nothing after this can run')

  // The box runs within limits, so a runaway browser or agent can't take the
  // host's memory, CPU or process table. Memory and swap are equal, so no swap.
  const limits = JSON.parse(docker('inspect', '-f', '{{json .HostConfig}}', container))
  check(limits.Memory === BOX_LIMITS.memory && limits.MemorySwap === BOX_LIMITS.memory && limits.NanoCpus === BOX_LIMITS.nanoCpus && limits.PidsLimit === BOX_LIMITS.pids,
    `the box runs with ${BOX_LIMITS.memory / 1024 ** 3} GiB of memory and no swap, ${BOX_LIMITS.nanoCpus / 1e9} CPUs and ${BOX_LIMITS.pids} processes `
    + `(memory ${String(limits.Memory)}, swap ${String(limits.MemorySwap)}, CPUs ${String(limits.NanoCpus)}, processes ${String(limits.PidsLimit)})`)

  // The desktop's programs, the browser among them, see none of the daemon's
  // tokens. A page the browser opens, such as file:///proc/self/environ, can put
  // whatever they hold on screen, and screenshots aren't scrubbed.
  const environs = [['-x', 'Xvnc'], ['-f', 'matchbox-window-manager'], ['-f', 'remote-debugging-port']].map((match) => {
    const pid = (tryDocker('exec', container, 'pgrep', '-o', ...match) ?? '').split('\n')[0] ?? ''
    return pid ? tryDocker('exec', container, 'cat', `/proc/${pid}/environ`) : null
  })
  const tokens = environs.flatMap((environ) => (environ ?? '').split('\0').map((entry) => entry.split('=')[0] ?? '').filter((name) => name.endsWith('TOKEN')))
  check(environs.every((environ) => environ !== null) && tokens.length === 0,
    `Xvnc, matchbox and the browser see none of the daemon's tokens (${tokens.join(', ') || 'none seen'})`)

  const idle = await measure(container, () => sleep(IDLE_SAMPLE_MS))
  console.log(`      idle box with its desktop and an open browser: ${idle.last} MiB, CPU up to ${idle.cpu}%`)

  // A person watches. The API asks the box for a tunnel and joins the two.
  const { RfbClient } = await import('../daemon/rfb.ts')
  const { keyEvent, pointerEvent } = await import('../shared/rfb.ts')
  const connectStarted = Date.now()
  const aliceView = must(await openView(alice, instanceId) as View, "alice's view")
  closers.push(() => { aliceView.ws.close() })
  const aliceScreen = await RfbClient.connect(aliceView.stream)
  await aliceScreen.refresh(false)
  const firstFrameMs = Date.now() - connectStarted
  check(aliceScreen.width === SCREEN.width && aliceScreen.height === SCREEN.height && aliceScreen.name === 'Agents box',
    `alice, watching through the people socket, gets the box's screen (${aliceScreen.width}x${aliceScreen.height}, first frame in ${firstFrameMs} ms)`)
  check(holderOf(aliceView)?.holder === 'agent', 'the view says the agent has the screen')
  // Only the app's own pages may open a screen. A page on another site, open in
  // a teammate's browser, would otherwise watch and take over as them.
  const foreign = await openView(alice, instanceId, undefined, { origin: 'http://elsewhere.example' })
  if (typeof foreign !== 'number') foreign.ws.close()
  check(foreign === 403 && aliceScreen.width === SCREEN.width,
    `a page from another origin is refused the screen with 403, and the app's own origin opens it (${typeof foreign === 'number' ? foreign : 'opened'})`)

  // A task in the box. Its session gets the computer, the instructions and the skill.
  const task = await post(alice, '/v1/tasks', { title: 'Check the page', instructions: 'Look at it.', agentId: must(await one('select id from agents where team_id = $1 and name = $2', [teamId, 'tester']), 'agent').id })
  const sessionId: string = must(task.json?.sessionId, 'the task session')
  const taskId: string = must(task.json?.taskId, 'the task')
  await within(120, async () => (await one('select status from sessions where id = $1', [sessionId]))?.status === 'idle')
  const workspace = must(await one('select w.path from workspaces w join sessions s on s.workspace_id = w.id where s.id = $1', [sessionId]), 'workspace').path as string
  const starts = tryDocker('exec', container, 'cat', `${workspace}/.fake/starts.jsonl`) ?? ''
  const claudeArgs = tryDocker('exec', container, 'ps', '-ww', '-eo', 'args') ?? ''
  const allowed = /--allowedTools (\S+)/.exec(claudeArgs.split('\n').find((line) => line.includes('fake-claude')) ?? '')?.[1]?.split(',') ?? []
  check(starts.includes('You have your own computer') && starts.includes('verify-work'),
    "the session's standing instructions describe its computer and checking its work")
  check(tryDocker('exec', container, 'test', '-f', `${workspace}/.claude/skills/verify-work/SKILL.md`) !== null, 'the session has the verify-work skill')
  check(allowed.includes('mcp__computer__computer') && allowed.includes('mcp__computer__browser_navigate') && !allowed.includes('mcp__computer__browser_evaluate'),
    'the computer and browser tools run without asking, and running page scripts asks a person')

  const { client: tools, server } = await computerTools(container, sessionId, workspace)
  closers.push(() => tools.close())
  const toolNames = (await tools.listTools()).tools.map((t) => t.name)
  const guide = await import('../daemon/computer-guide.ts')
  const allowedNames = new Set(guide.COMPUTER_TOOLS_ALLOWED.map((name) => name.replace('mcp__computer__', '')))
  const browserTools = toolNames.filter((name) => name.startsWith('browser_'))
  check(server.env.AGENTS_TASK_FOLDER === `${workspace}/task` && ['computer', 'save_screenshot', 'screen_status'].every((name) => toolNames.includes(name))
    && browserTools.length > 10 && browserTools.every((name) => allowedNames.has(name) !== guide.BROWSER_TOOLS_THAT_ASK.includes(name)),
  `the computer server offers its own tools and ${browserTools.length} browser tools, each either allowed or asking a person`)


  // The agent drives the box's browser and screen.
  await tools.callTool({ name: 'browser_navigate', arguments: { url: PAGE_URL } })
  const snapshot = textOf(await tools.callTool({ name: 'browser_snapshot', arguments: {} }))
  check(snapshot.includes('Agents check page'), "browser_navigate opens a page in the box's browser, and browser_snapshot reads it")
  await aliceScreen.refresh(false)
  // The page starts below the browser's toolbar. The black square says where.
  let squareTop = -1
  for (let y = 0; y < SCREEN.height && squareTop < 0; y++) {
    const { r, g, b } = aliceScreen.pixel(SQUARE.left + SQUARE.size / 2, y)
    if (r + g + b === 0) squareTop = y
  }
  const toolbar = squareTop - SQUARE.top
  const shot = await tools.callTool({ name: 'computer', arguments: { action: 'screenshot' } })
  const size = pngSize(imageOf(shot) ?? '')
  check(squareTop > 0 && size?.width === SCREEN.width && size.height === SCREEN.height, `the computer tool's screenshot is a ${SCREEN.width}x${SCREEN.height} PNG`)
  const clicked = await tools.callTool({ name: 'computer', arguments: { action: 'left_click', coordinate: [INPUT.left + INPUT.width / 2, toolbar + INPUT.top + INPUT.height / 2] } })
  await tools.callTool({ name: 'computer', arguments: { action: 'type', text: 'héllo from the agent ✓' } })
  const typed = await pageSays(tools)
  check(!clicked.isError && typed === 'typed:héllo from the agent ✓', `the agent's clicks and typing reach the page, accents and symbols included (${typed})`)
  const badKey = await tools.callTool({ name: 'computer', arguments: { action: 'key', text: 'NoSuchKey' } })
  check(badKey.isError && textOf(badKey).includes('not a key name'), 'a key name the screen does not know is refused with a reason')

  // A screenshot the agent saves becomes an image document on the task when its
  // turn ends. That turn also takes a screenshot through the computer tool.
  const saved = await tools.callTool({ name: 'save_screenshot', arguments: { name: 'agents-check-page' } })
  const savedSha = (tryDocker('exec', container, 'sha256sum', `${workspace}/task/checks/agents-check-page.png`) ?? '').split(' ')[0]
  await post(alice, `/v1/sessions/${sessionId}/messages`, { text: 'Show me the page you checked.' })
  const findImage = () => one(
    `select a.id, v.version, v.content, b.media_type, b.sha256 from artifacts a join artifact_versions v on v.artifact_id = a.id
     join blobs b on b.id = v.blob_id where a.task_id = $1 and a.path = 'checks/agents-check-page.png'`, [taskId])
  await within(60, findImage)
  const imageDoc = await findImage()
  check(!saved.isError && savedSha && imageDoc?.media_type === 'image/png' && imageDoc.sha256 === savedSha && imageDoc.content === '',
    "a screenshot the agent saves with save_screenshot becomes an image document on the task, byte for byte")
  const imageUrl = imageDoc ? `${PEOPLE}/v1/artifacts/${imageDoc.id}/versions/${imageDoc.version}/image` : `${PEOPLE}/none`
  const fetched = await fetch(imageUrl, { headers: { 'tailscale-user-login': alice } })
  const fetchedSha = createHash('sha256').update(Buffer.from(await fetched.arrayBuffer())).digest('hex')
  const outsider = await fetch(imageUrl, { headers: { 'tailscale-user-login': carol } })
  check(fetched.status === 200 && fetched.headers.get('content-type') === 'image/png' && fetchedSha === savedSha && outsider.status === 404,
    "the task's people fetch the image through the people socket, and a person on another team can't")
  const toolResults = (await db.query(`select body::text as body from events where session_id = $1 and kind = 'tool_result'`, [sessionId])).rows.map((r) => r.body as string)
  const rawLines = (await db.query('select line::text as line from raw_events where session_id = $1', [sessionId])).rows.map((r) => r.line as string)
  check(toolResults.some((body) => /"omitted": ?true/.test(body)) && ![...toolResults, ...rawLines].some((text) => text.includes('iVBORw0KGgo')),
    "a screenshot in a tool's result reaches the record as its size and hash, never its bytes")

  // Alice takes over. The agent is refused, by name, in both kinds of tool.
  const bobView = must(await openView(bob, instanceId) as View, "bob's view")
  closers.push(() => { bobView.ws.close() })
  const bobScreen = await RfbClient.connect(bobView.stream)
  // A browser call the agent started stops when alice takes over, instead of
  // carrying on with the screen she now holds. The page's title shows the call
  // is under way before she takes it.
  const pages = `${String(server.env.AGENTS_BROWSER_CDP)}/json/list`
  const longCall = tools.callTool({ name: 'browser_evaluate', arguments: {
    function: `async () => { document.title = 'in flight'; await new Promise((done) => setTimeout(done, ${LONG_CALL_MS})); return 'finished' }`,
  } })
  const underWay = await within(10, async () => (tryDocker('exec', container, 'curl', '-s', pages) ?? '').includes('"in flight"'))
  const took = await post(alice, `/v1/screens/${instanceId}/take`, { sessionId })
  const tookAt = Date.now()
  const cut = await longCall
  const cutAfter = Date.now() - tookAt
  check(took.status === 200 && took.json?.control?.holder === 'person' && took.json.control.login === alice, 'alice takes over the screen')
  check(underWay && cut.isError === true && textOf(cut).includes(alice) && cutAfter < LONG_CALL_MS / 2,
    `a browser call under way when alice takes over stops then and names her (${cutAfter} ms after she took the screen)`)
  check(await within(10, async () => holderOf(aliceView)?.login === alice && holderOf(bobView)?.login === alice), 'both views are told alice has the screen')
  const refused = await tools.callTool({ name: 'computer', arguments: { action: 'screenshot' } })
  const refusedBrowser = await tools.callTool({ name: 'browser_snapshot', arguments: {} })
  check(refused.isError && textOf(refused).includes(`${alice} has taken over the screen`) && refusedBrowser.isError && textOf(refusedBrowser).includes(alice),
    "while alice holds the screen, the agent's screen and browser actions are refused, naming her")
  const status = await tools.callTool({ name: 'screen_status', arguments: {} })
  check((status.structuredContent as any)?.control?.login === alice, 'screen_status tells the agent who has the screen')

  // Only the holder's keys and clicks reach the box. Alice types, then bob types
  // and clicks. Xvnc reads each connection's messages in order and answers a
  // request for the screen only after reading what came before it, so once it
  // answers bob's, whatever of his got through is queued ahead of alice's F2
  // presses below, which wait until the page has taken them.
  const typeKeys = (screen: Awaited<ReturnType<typeof RfbClient.connect>>, text: string) => {
    for (const char of text) {
      screen.send(keyEvent(char.charCodeAt(0), true))
      screen.send(keyEvent(char.charCodeAt(0), false))
    }
  }
  typeKeys(aliceScreen, '!!')
  typeKeys(bobScreen, '??')
  bobScreen.send(pointerEvent(10, 10, 1))
  bobScreen.send(pointerEvent(10, 10, 0))
  // Bob's view has no request outstanding, since connecting asked once and was answered.
  await bobScreen.refresh(false)

  // Latency. Alice presses F2 and waits for the square's pixels to change.
  const squareX = SQUARE.left + SQUARE.size / 2
  const squareY = toolbar + SQUARE.top + SQUARE.size / 2
  const latencies: number[] = []
  for (let i = 0; i < LATENCY_TRIALS; i++) {
    await aliceScreen.refresh(false)
    const before = aliceScreen.pixel(squareX, squareY).r
    const started = performance.now()
    aliceScreen.send(keyEvent(F2, true))
    aliceScreen.send(keyEvent(F2, false))
    const deadline = started + KEY_SHOWS_MS
    while (aliceScreen.pixel(squareX, squareY).r === before && performance.now() < deadline) {
      await Promise.race([aliceScreen.refresh(true), sleep(KEY_SHOWS_MS)])
    }
    latencies.push(performance.now() - started)
  }
  latencies.sort((a, b) => a - b)
  const median = must(latencies[Math.floor(latencies.length / 2)], 'median')
  const p95 = must(latencies[Math.floor(latencies.length * 0.95)], 'p95')
  console.log(`      key press to pixels through the API: median ${median.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms over ${LATENCY_TRIALS} presses`)
  check(median < LATENCY_LIMIT_MS, `a key press in alice's view shows on her screen within ${LATENCY_LIMIT_MS} ms (median ${median.toFixed(0)} ms)`)

  // Alice hands back. The agent acts again and hears that she used the screen.
  const handed = await post(alice, `/v1/screens/${instanceId}/hand-back`, { sessionId })
  const after = await tools.callTool({ name: 'computer', arguments: { action: 'screenshot' } })
  check(handed.status === 200 && handed.json?.control?.holder === 'agent' && !after.isError
    && (after.structuredContent as any)?.personUsedScreen === alice && textOf(after).includes(`${alice} used the screen since your last action`),
  'after alice hands back, the agent acts again and is told she used the screen')
  // Alice types after handing back. Once Xvnc answers her request for the
  // screen, the agent types, so any of her keys that got through reach the page
  // before the agent's. Her view has no request outstanding, since each F2 press
  // above ended with an answer.
  typeKeys(aliceScreen, '##')
  await aliceScreen.refresh(false)
  await tools.callTool({ name: 'computer', arguments: { action: 'type', text: ' ok' } })
  check(await within(10, async () => (await pageSays(tools)).endsWith(' ok')), "the agent's typing reaches the page again after the hand-back")
  const final = await pageSays(tools)
  check(final.startsWith('typed:héllo from the agent ✓!!'), `alice's typing reached the page while she held the screen (${final})`)
  check(!final.includes('?'), "bob's typing never reached the page while alice held the screen")
  check(!final.includes('#'), "alice's typing stops reaching the page once she hands it back")

  // The record shows the takeover.
  const takeover = await one('select ended_by, session_id from screen_takeovers where instance_id = $1 order by started_at limit 1', [instanceId])
  const notices = (await db.query(`select text from events where session_id = $1 and kind = 'notice' and body->>'subtype' = 'screen' order by seq`, [sessionId])).rows.map((r) => r.text)
  check(takeover?.ended_by === 'handed_back' && takeover.session_id === sessionId
    && notices.includes(`${alice} took over the screen`) && notices.includes(`${alice} handed the screen back`),
  "the takeover is recorded, and the session's record has a notice when it starts and ends")

  // Who may watch and take over.
  check(await outcome(carol, instanceId) === 'closed 4403 no such screen' && (await post(carol, `/v1/screens/${instanceId}/take`, { sessionId: null })).status === 404,
    "a person on another team can't watch the screen or take it over")
  check(await openView(alice, instanceId, `ws://127.0.0.1:${MACHINE_PORT}`) === 400 && await openView('', instanceId, `ws://127.0.0.1:${MACHINE_PORT}`) === 404,
    'the machine port refuses a person, and has no screen view to open')
  // Bob is watching, and holds the screen, when private work of alice's starts
  // on the box. His view closes as if he had opened it then, and the screen goes
  // back to the agent. He can still try to hand it back, and hand-back runs no
  // watch rule, so he hears the agent has it rather than that he may not watch.
  const bobTook = await post(bob, `/v1/screens/${instanceId}/take`, { sessionId })
  const aliceSawBob = await within(10, async () => holderOf(aliceView)?.login === bob)
  const { id: privateTask } = must(await one(
    `insert into tasks (team_id, slug, title, owner_id, agent_id, visibility) select $1, $2, 'Private work', p.id, a.id, 'private'
     from people p, agents a where p.login = $3 and a.team_id = $1 returning id`, [teamId, `private-${id}`, alice]), 'private task')
  const { id: privateSession } = must(await one(
    `insert into sessions (team_id, task_id, instance_id, agent_id, status) select $1, $2, $3, id, 'running' from agents where team_id = $1 returning id`,
    [teamId, privateTask, instanceId]), 'private session')
  const cutOff = await within(15, async () => bobView.closed !== null)
  const agentAgain = await within(15, async () => holderOf(aliceView)?.holder === 'agent')
  check(bobTook.status === 200 && aliceSawBob && cutOff && bobView.closed?.code === 4403 && agentAgain,
    `a person watching when private work they can't see starts on the box is cut off, and the screen they held goes back to the agent (${bobView.closed?.code ?? 'still open'})`)
  const bobHandsBack = await post(bob, `/v1/screens/${instanceId}/hand-back`, { sessionId })
  check(bobHandsBack.status === 409 && String(bobHandsBack.json?.error).includes('already has the screen'),
    `handing back runs no watch rule, so a person cut off hears the agent already has the screen (${bobHandsBack.status})`)
  const bobOutcome = await outcome(bob, instanceId)
  const aliceOutcome = await outcome(alice, instanceId)
  check(bobOutcome === "closed 4403 This screen has shown work you can't see." && aliceOutcome === 'watching',
    `someone who can't see private work running on the box can't open it, and its owner can (${bobOutcome}; ${aliceOutcome})`)
  await db.query('delete from sessions where id = $1', [privateSession])
  // On the old rule bob still holds the screen here, so this lets the rest run.
  await post(bob, `/v1/screens/${instanceId}/hand-back`, { sessionId })
  const watcher = must(await openView(bob, instanceId) as View, "bob's view again")
  closers.push(() => { watcher.ws.close() })

  // A viewer that stops answering pings, as a laptop that sleeps does, is closed
  // by the API, so a holder's dead view can't keep the screen from the agent.
  const silent = new WebSocket(`ws://127.0.0.1:${PEOPLE_PORT}/v1/screens/${instanceId}`, { headers: { 'tailscale-user-login': bob, origin: ORIGIN }, autoPong: false })
  silent.on('error', () => { /* the close reports it */ })
  const silentClosed = new Promise<number>((resolve) => { silent.on('close', (code) => { resolve(code) }) })
  const silentOpened = Date.now()
  closers.push(() => { silent.terminate() })

  // Alice takes over again and closes her view without handing back.
  await post(alice, `/v1/screens/${instanceId}/take`, { sessionId })
  aliceView.ws.close()
  const gone = await within(60, async () => (await one(`select ended_by from screen_takeovers where instance_id = $1 order by started_at desc limit 1`, [instanceId]))?.ended_by === 'left')
  const back = await tools.callTool({ name: 'computer', arguments: { action: 'screenshot' } })
  check(gone && !back.isError && await within(10, async () => holderOf(watcher)?.holder === 'agent'),
    'a person who closes the view without handing back loses the screen, and the agent has it again')

  // From inside the new image, only the machine port answers. curl prints 000
  // when it can't connect at all.
  const reach = (port: number) => spawnSync('docker', ['exec', container, 'curl', '-s', '-m', '3', '-o', '/dev/null', '-w', '%{http_code}',
    '-H', `tailscale-user-login: ${alice}`, `http://host.docker.internal:${port}/v1/me`], { encoding: 'utf8' }).stdout.trim()
  check(reach(MACHINE_PORT) === '400' && await listensHere(PEOPLE_PORT) && reach(PEOPLE_PORT) === '000',
    "from inside the box the machine port answers, and the people side's port, which listens on this Mac, cannot be reached")

  // Sizing, first with the agent's browser on the page, then all three engines at once.
  const busy = await measure(container, async () => {
    for (let i = 0; i < 5; i++) await tools.callTool({ name: 'computer', arguments: { action: 'scroll', coordinate: [640, 400], scroll_direction: 'down', scroll_amount: 3 } })
  })
  const browsers = await measure(container, async () => {
    const { stdout } = await run('docker', ['exec', container, 'node', '/opt/check/box-browsers.ts', '/usr/local/lib/node_modules/playwright', PAGE_URL])
    console.log(stdout.trim().replace(/^/gm, '      '))
  })
  console.log(`      agent driving the screen: ${busy.peak} MiB at most, CPU up to ${busy.cpu}%`)
  console.log(`      Chromium, Firefox and WebKit at once beside it: ${browsers.peak} MiB at most, CPU up to ${browsers.cpu}%`)

  // Whether a person opening the screen now gets the box's screen itself.
  const seesScreen = async () => {
    const view = await openView(alice, instanceId)
    if (typeof view === 'number') return false
    try {
      const client = await RfbClient.connect(view.stream)
      return client.width === SCREEN.width && client.height === SCREEN.height
    } catch {
      // Not back yet. The API closed the view, which ends the handshake.
      return false
    } finally {
      view.ws.close()
    }
  }
  // The DevTools address the daemon gave the session's browser tools.
  const devtools = `${String(server.env.AGENTS_BROWSER_CDP)}/json/version`
  const browserUp = () => within(60, async () => (tryDocker('exec', container, 'curl', '-s', devtools) ?? '').includes('"Browser"'))
  const comesBack = async () => ({ screen: await within(120, seesScreen), browser: await browserUp() })

  // The viewer that stopped answering pings has had its time.
  const silentCode = await Promise.race([silentClosed, sleep(Math.max(0, silentOpened + DEAD_SOCKET_S * 1000 - Date.now())).then(() => null)])
  check(silentCode === 1006, `a viewer that stops answering pings is closed by the API (${silentCode ?? 'still open'})`)

  // The box hangs. Its tunnel stops answering pings and the API closes it, so a
  // viewer is told instead of watching a frozen screen for good.
  const hungView = must(await openView(alice, instanceId) as View, "alice's view of the box before it hangs")
  await RfbClient.connect(hungView.stream)
  docker('pause', container)
  const hungTold = await within(DEAD_SOCKET_S + 5, async () => hungView.closed !== null)
  docker('unpause', container)
  check(hungTold && hungView.closed?.code === 4502, `a viewer of a box that hangs is told the box closed the screen (${hungView.closed?.code ?? 'still open'})`)
  const backFromHang = await within(120, seesScreen)

  // The box stops. A viewer watching is told, and from then on the screen says
  // the box is not connected, to anyone opening it or taking it over. The API
  // drops a silent box within SCREEN_DEAD_MS plus one SCREEN_PING_MS.
  const stopView = must(await openView(bob, instanceId) as View, "bob's view of the box before it stops")
  await RfbClient.connect(stopView.stream)
  docker('stop', container)
  const notConnected = 'closed 4404 The box is not connected. It may be stopped.'
  const toldOfStop = await within(30, async () => stopView.closed !== null)
  const saysStopped = await within(90, async () => await outcome(alice, instanceId) === notConnected)
  const takeStopped = await post(alice, `/v1/screens/${instanceId}/take`, { sessionId })
  check(backFromHang && toldOfStop && stopView.closed?.code === 4502 && saysStopped && takeStopped.status === 409,
    `when the box stops, a viewer is told it closed the screen, and the screen then says it is not connected (${stopView.closed?.code ?? 'still open'}, take ${takeStopped.status})`)

  // The box comes back each way a box comes back, and each time its screen and
  // its browser must return:
  //  - started again after the server stopped it for being idle
  //  - started again after it was killed, as a crash or a dying machine leaves
  //    it, with Xvnc's lock still in the container naming a live process
  //  - recreated from the image on a home volume whose browser profile is still
  //    locked by a browser on another machine, as a volume moved between hosts is
  // Xvnc refuses to start while the process its lock names is alive. In a probe
  // the new Xvnc got the killed one's process id, so its own lock stopped it.
  // Here the lock names process 1, which is always alive.
  docker('start', container)
  const started = await comesBack()
  docker('exec', container, 'rm', '-f', X_LOCK)
  execFileSync('docker', ['exec', '-i', container, 'tee', X_LOCK], { input: `${'1'.padStart(10)}\n`, stdio: ['pipe', 'ignore', 'inherit'] })
  docker('kill', container)
  docker('start', container)
  const killed = await comesBack()
  docker('rm', '-f', container)
  // Chromium names the lock's holder as host and process id.
  docker('run', '--rm', '-v', `${container}-home:/home/agent`, '--entrypoint', 'ln', IMAGE, '-sfn', 'another-machine-4242', `${BOX_PROFILE}/SingletonLock`)
  // A task given while the box is gone waits in the queue, and the new box sees
  // it as soon as it starts, before its desktop is up. Its session must still get
  // the computer, so a box takes no work until its desktop is up.
  const agentId = must(await one('select id from agents where team_id = $1 and name = $2', [teamId, 'tester']), 'agent').id
  const queued = await post(alice, '/v1/tasks', { title: 'Check it again', instructions: 'Look again.', agentId })
  const queuedSession: string = must(queued.json?.sessionId, 'the queued task session')
  node('server/boxes.ts', 'recreate', team, boxName)
  const recreated = await comesBack()
  const said = (back: { screen: boolean; browser: boolean }) => `screen ${back.screen}, browser ${back.browser}`
  check(started.screen && started.browser && killed.screen && killed.browser && recreated.screen && recreated.browser,
    `the box's screen and browser come back when it starts again (${said(started)}), after it was killed (${said(killed)}), `
    + `and when it is recreated on a volume locked elsewhere (${said(recreated)})`)
  await within(120, async () => (await one('select status from sessions where id = $1', [queuedSession]))?.status === 'idle')
  const queuedWorkspace = (await one('select w.path from workspaces w join sessions s on s.workspace_id = w.id where s.id = $1', [queuedSession]))?.path
  const queuedStarts = typeof queuedWorkspace === 'string' ? tryDocker('exec', container, 'cat', `${queuedWorkspace}/.fake/starts.jsonl`) ?? '' : ''
  check(queuedStarts.includes('You have your own computer'), 'a session that reaches a box before its desktop is up still gets its computer')

  // A desktop that can't come up stops the daemon, and Docker starts the box
  // again, rather than the box taking work without its computer. The browser
  // can't start while its profile folder is read-only.
  docker('exec', container, 'chmod', '500', BOX_PROFILE)
  docker('restart', container)
  const restartsBefore = Number(docker('inspect', '-f', '{{.RestartCount}}', container))
  const gaveUp = await within(DESKTOP_GIVES_UP_S, async () => Number(tryDocker('inspect', '-f', '{{.RestartCount}}', container)) > restartsBefore)
  const mended = await within(60, async () => tryDocker('exec', container, 'chmod', '700', BOX_PROFILE) !== null)
  const healed = await within(120, seesScreen)
  check(gaveUp && mended && healed, `a box whose desktop can't come up starts again, and comes back once its desktop can (restarted ${gaveUp}, back ${healed})`)

  // A connection reset during a box's upgrade, while the API looks up its token,
  // leaves the API serving. It took the API down before.
  const reset = connect(MACHINE_PORT, '127.0.0.1')
  reset.on('error', () => { /* the reset is the point */ })
  await once(reset, 'connect')
  reset.write('GET /v1/instance/screen HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n'
    + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nAuthorization: Bearer not-a-token\r\n\r\n`)
  reset.resetAndDestroy()
  const answers = await within(10, async () => (await fetch(`${PEOPLE}/v1/me`, { headers: { 'tailscale-user-login': alice } }).then((res) => res.status, () => 0)) === 200)
  check(answers && api.exitCode === null, 'a connection reset during an upgrade leaves the API answering')
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack}`)
} finally {
  for (const close of closers) await Promise.resolve(close()).catch(() => undefined)
  await stopAll(children)
  // Boxes are removed whatever happened, or they would keep calling a closed port.
  const boxes = await db.query(`select i.id from instances i join teams t on t.id = i.team_id where t.name = $1 and i.kind = 'box'`, [team]).catch(() => ({ rows: [] }))
  for (const { id: boxId } of boxes.rows) {
    tryDocker('rm', '-f', `agents-box-${boxId}`)
    tryDocker('volume', 'rm', `agents-box-${boxId}-home`)
  }
  if (!failures.length) {
    await db.query('delete from teams where name = any($1)', [[team, otherTeam]]).catch(() => undefined)
    rmSync(work, { recursive: true, force: true })
  }
  await db.end().catch(() => undefined)
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test teams and box removed)'}`)
process.exit(failures.length ? 1 : 0)
