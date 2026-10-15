// Seats, step 15c. A person's computer, a real box built from box/Dockerfile
// under a tag of the run's own, holds 4 seats in 4 CPUs and 8 GiB, and runs
// seat 1 from the start. Two agents each take a seat, as the scheduler will
// give them one once it lands, and the box starts seat 2 and reports both
// ready. Their sessions run at once, each on its own display and browser: both
// browsers are driven at the same time, each screenshot shows its own page,
// and a long action on seat 1 doesn't hold up seat 2. Taking over seat 1 stops
// only seat 1's agent, and seat 2 keeps working. A login made in seat 1's
// browser works in seat 2's, a logout in seat 2 logs seat 1 out, and a seat
// that starts later begins with the login. One agent's private work hides only
// its own seat's screen. Prints each seat's memory while it works its screen,
// from docker stats and from the processes of each seat.
// The box reaches this check's API only on 7701, the machine port the box
// firewall opens for checks, so run it holding ~/.agents-app/checks/run.lock.
//   node --env-file=.env --env-file=.env.test test/step15c.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { inflateSync } from 'node:zlib'
import pg from 'pg'
import WebSocket from 'ws'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { must } from './must.ts'
import {
  ROOT, IMAGE, MACHINE_PORT, SCREEN, within, docker, tryDocker, boxCheckEnv, peopleSocket, computerTools, textOf, imageOf, stopAll,
} from './computers.ts'
import { servePeople } from './people.ts'
import { AgentId } from '../shared/ids.ts'
import { InstanceId } from '../shared/onboarding.ts'
import { messageOf } from '../shared/errors.ts'

const PEOPLE_PORT = 7984
const STREAMS_PORT = 7985
const API = `http://127.0.0.1:${MACHINE_PORT}`
const PEOPLE = `http://127.0.0.1:${PEOPLE_PORT}`
const ORIGIN = PEOPLE
const id = randomBytes(4).toString('hex')
const team = `seats-${id}`
const alice = `alice-seats-${id}@local`
const bob = `bob-seats-${id}@local`
// Box mounts come from the colima VM, which sees only the home folder.
const work = join(homedir(), '.agents-app', 'checks', `seats-${id}`)
// The size of a person's computer, as Tayler decided on 2026-10-15, and the
// threads Docker allows it, 4,096 for each seat.
const COMPUTER = { seats: 4, memory: 8 * 1024 ** 3, nanoCpus: 4e9, pids: 4 * 4096 }
// A port on the box's own loopback for a site that keeps a login in an HttpOnly
// cookie, so only the browser itself can carry it from seat to seat.
const SITE_PORT = 8401
const SITE = `http://127.0.0.1:${SITE_PORT}`
// One action that holds seat 1's screen long enough to see seat 2 go on meanwhile.
const LONG_WAIT_S = 3
// A screenshot on a seat nobody else holds up comes back well within this.
const QUICK_MS = 2000
// How long a login may take to reach another seat. The box copies every 1.5 s.
const SHARED_WITHIN_S = 10
// docker stats samples about once a second, so this gives five or six samples.
const SAMPLE_MS = 6000

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []
const closers: (() => Promise<void> | void)[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
const checkEnv = boxCheckEnv(team, work, STREAMS_PORT, [ORIGIN])
const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', '--env-file=.env.test', ...args],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...checkEnv } })

async function post(login: string, path: string, body: unknown = {}) {
  const res = await fetch(PEOPLE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

// A person's Screen view of one seat, as the app opens it: a WebSocket on the
// people port carrying the screen as binary frames and who holds it as text.
type View = { ws: WebSocket; stream: Duplex; controls: any[]; closed: { code: number; reason: string } | null }
function openView(login: string, path: string): Promise<View | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PEOPLE_PORT}${path}`, { headers: { 'tailscale-user-login': login, origin: ORIGIN } })
    const view: View = {
      ws, controls: [], closed: null,
      stream: new Duplex({ read() { /* frames are pushed as they arrive */ }, write(chunk, _encoding, done) { ws.send(chunk, done) } }),
    }
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0) })
    ws.on('open', () => { resolve(view) })
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
// A view that must open.
async function viewOf(login: string, path: string): Promise<View> {
  const view = await openView(login, path)
  if (typeof view === 'number') throw new Error(`${login}'s view of ${path} was refused with ${view}`)
  return view
}

// How opening a screen goes: watching once the API says who holds it, or closed with the API's code and reason.
async function outcome(login: string, path: string): Promise<string> {
  const view = await openView(login, path)
  if (typeof view === 'number') return `http ${view}`
  await within(10, async () => view.closed !== null || view.controls.length > 0)
  const result = view.closed ? `closed ${view.closed.code} ${view.closed.reason}` : view.controls.length ? 'watching' : 'silent'
  view.ws.close()
  return result
}

// The screen service encodes RGB at 8 bits, with PNG's five row filters.
function pixelOf(base64: string, x: number, y: number): [number, number, number] {
  const png = Buffer.from(base64, 'base64')
  let width = 0
  let height = 0
  const data: Buffer[] = []
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    const body = png.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body.readUInt8(8) !== 8 || body.readUInt8(9) !== 2) throw new Error('the screenshot is not 8-bit RGB')
    }
    if (type === 'IDAT') data.push(body)
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * 3
  const rows = Buffer.alloc(stride * height)
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let row = 0; row <= y; row++) {
    const filter = raw.readUInt8(row * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? rows.readUInt8(row * stride + i - 3) : 0
      const b = row > 0 ? rows.readUInt8((row - 1) * stride + i) : 0
      const c = i >= 3 && row > 0 ? rows.readUInt8((row - 1) * stride + i - 3) : 0
      const predicted = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0
      rows.writeUInt8((raw.readUInt8(row * (stride + 1) + 1 + i) + predicted) & 0xff, row * stride + i)
    }
  }
  return [rows.readUInt8(y * stride + x * 3), rows.readUInt8(y * stride + x * 3 + 1), rows.readUInt8(y * stride + x * 3 + 2)]
}

// A page that fills the browser with one color, named for its seat.
const seatPage = (title: string, color: string) => `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><title>${title}</title><style>html,body{margin:0;height:100%;background:${color}}</style><h1>${title}</h1>`)}`
// A point well inside the page, below the browser's toolbar.
const IN_PAGE = { x: SCREEN.width / 2, y: SCREEN.height - 100 }
const isRed = ([r, g, b]: number[]) => (r ?? 0) > 200 && (g ?? 255) < 60 && (b ?? 255) < 60
const isBlue = ([r, g, b]: number[]) => (r ?? 255) < 60 && (g ?? 255) < 60 && (b ?? 0) > 200

// A site on the box's loopback that signs in with an HttpOnly cookie and says who is signed in.
const LOGIN_SITE = `require('node:http').createServer((req, res) => {
  const signed = /(?:^|; )seats_check=([^;]+)/.exec(req.headers.cookie || '')
  const as = /^\\/login\\?as=([a-z0-9-]+)$/.exec(req.url)
  if (as) { res.setHeader('set-cookie', 'seats_check=' + as[1] + '; Path=/; HttpOnly'); res.end('signed in as ' + as[1]); return }
  if (req.url === '/logout') { res.setHeader('set-cookie', 'seats_check=; Path=/; Max-Age=0'); res.end('signed out now'); return }
  res.end(signed ? 'signed in as ' + signed[1] : 'nobody signed in')
}).listen(${SITE_PORT}, '127.0.0.1')`

// What a seat's browser shows of the site after going to `path`.
async function siteSays(tools: Client, path: string): Promise<string> {
  await tools.callTool({ name: 'browser_navigate', arguments: { url: `${SITE}${path}` } })
  return /signed in as [a-z0-9-]+|nobody signed in|signed out now/.exec(textOf(await tools.callTool({ name: 'browser_snapshot', arguments: {} })))?.[0] ?? '(nothing)'
}

// The memory each seat's processes hold, from inside the box: its Xvnc, its
// window manager and its browser with every process the browser started, as
// the proportional share of what they hold, so shared pages count once.
const SEAT_MEMORY = `const fs = require('node:fs')
const procs = new Map()
for (const pid of fs.readdirSync('/proc').filter((p) => /^[0-9]+$/.test(p))) {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8')
    const parent = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]
    const args = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\0')
    const env = fs.readFileSync('/proc/' + pid + '/environ', 'utf8').split('\\0')
    const pss = Number((/Pss:\\s+([0-9]+) kB/.exec(fs.readFileSync('/proc/' + pid + '/smaps_rollup', 'utf8')) || [])[1] || 0)
    procs.set(pid, { parent, args, env, pss })
  } catch { /* a process that ended while this read */ }
}
const seatOf = (pid) => {
  for (let at = pid, hops = 0; procs.has(at) && hops < 64; at = procs.get(at).parent, hops++) {
    const { args, env } = procs.get(at)
    const port = args.find((arg) => arg.startsWith('--remote-debugging-port='))
    if (port) return Number(port.split('=')[1]) - 9221
    if (args[0] === 'Xvnc') return Number(args[1].slice(1))
    if (args[0] === 'matchbox-window-manager') return Number((env.find((e) => e.startsWith('DISPLAY=:')) || 'DISPLAY=:0').slice(9))
  }
  return 0
}
const seats = {}
for (const [pid, { pss }] of procs) { const n = seatOf(pid); if (n) seats[n] = (seats[n] || 0) + pss }
console.log(JSON.stringify(Object.fromEntries(Object.entries(seats).map(([n, kb]) => [n, Math.round(kb / 1024)]))))`

// Samples the container's memory and CPU from docker stats while `during` runs.
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
  await within(10, async () => samples.length > 0)
  const seats = await during()
  const after = samples.length
  await within(5, async () => samples.length > after)
  stats.kill()
  return { peak: Math.round(Math.max(...samples.map((s) => s.mib))), cpu: Math.round(Math.max(...samples.map((s) => s.cpu))), seats }
}

// Works a seat's screen the way an agent checking its page does, for SAMPLE_MS.
async function workScreen(tools: Client) {
  const until = Date.now() + SAMPLE_MS
  while (Date.now() < until) {
    await tools.callTool({ name: 'computer', arguments: { action: 'scroll', coordinate: [640, 400], scroll_direction: 'down', scroll_amount: 3 } })
    await tools.callTool({ name: 'computer', arguments: { action: 'scroll', coordinate: [640, 400], scroll_direction: 'up', scroll_amount: 3 } })
  }
}
const seatMemory = (container: string): Record<string, number> => JSON.parse(docker('exec', container, 'node', '-e', SEAT_MEMORY))

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

let container = ''
try {
  await db.connect()
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'scenario.json'), JSON.stringify({ turns: [] }))
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, alice)
  node('server/admin.ts', 'add-person', team, bob)
  const { takeSeat } = await import('../server/seats.ts')
  const { tx, pool } = await import('../server/db.ts')
  closers.push(() => pool.end())

  node('server/boxes.ts', 'build')
  const api = spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, ...checkEnv },
  })
  children.push(api)
  // Stands in for tailscale serve, which sends people to the API's socket.
  await servePeople(PEOPLE_PORT, peopleSocket(work))
  await within(20, () => fetch(API).then(() => true, () => false))

  // Alice's own computer. The runner starts its container.
  const made = await post(alice, '/v1/me/box')
  const instanceId: string = must(made.json?.instanceId, "alice's computer")
  container = `agents-box-${instanceId}`
  const { id: teamId } = must(await one('select id from teams where name = $1', [team]), 'team')
  const box = must(await one('select name, seat_cap, cpus, memory_gib from instances where id = $1', [instanceId]), 'the computer')
  const seatRows = (await db.query('select n, status from seats where instance_id = $1 order by n', [instanceId])).rows
  check(box.seat_cap === COMPUTER.seats && box.cpus === 4 && box.memory_gib === 8 && seatRows.map((r) => `${r.n}:${r.status}`).join() === '1:free,2:free,3:free,4:free',
    `a person's computer holds ${COMPUTER.seats} seats in 4 CPUs and 8 GiB, all free at first (${seatRows.map((r) => `${r.n}:${r.status}`).join()})`)
  const screenUp = await within(180, async () => {
    const row = await one('select status, screen_width from instances where id = $1', [instanceId])
    return row?.status === 'online' && row.screen_width === SCREEN.width
  })
  check(screenUp, 'the computer comes online with seat 1 up and reports its screen')
  if (!screenUp) throw new Error('the computer never reported a screen, so nothing after this can run')
  const limits = JSON.parse(docker('inspect', '-f', '{{json .HostConfig}}', container))
  check(limits.Memory === COMPUTER.memory && limits.MemorySwap === COMPUTER.memory && limits.NanoCpus === COMPUTER.nanoCpus && limits.PidsLimit === COMPUTER.pids,
    `the computer's container runs within 8 GiB and no swap, 4 CPUs and ${COMPUTER.pids} threads `
    + `(memory ${String(limits.Memory)}, swap ${String(limits.MemorySwap)}, CPUs ${String(limits.NanoCpus)}, threads ${String(limits.PidsLimit)})`)
  const displays = () => (tryDocker('exec', container, 'pgrep', '-a', 'Xvnc') ?? '').split('\n').map((line) => / :([0-9]+) /.exec(line)?.[1]).filter(Boolean).sort().join()
  check(displays() === '1', `only seat 1's display runs while no agent holds a seat (displays ${displays() || 'none'})`)
  const idle = await measure(container, async () => { await sleep(SAMPLE_MS); return seatMemory(container) })

  // Two agents on her computer, each given a seat as the scheduler will give one.
  node('server/admin.ts', 'add-agent', team, 'scout', box.name)
  node('server/admin.ts', 'add-agent', team, 'writer', box.name)
  node('server/admin.ts', 'add-agent', team, 'reader', box.name)
  const agentIds = new Map((await db.query('select name, id from agents where team_id = $1', [teamId])).rows.map((r) => [String(r.name), String(r.id)]))
  const seatFor = (name: string) => tx((client) => takeSeat(client, InstanceId.parse(instanceId), AgentId.parse(agentIds.get(name))))
  const scoutSeat = await seatFor('scout')
  const writerSeat = await seatFor('writer')
  const scoutAgain = await seatFor('scout')
  const n = (seated: Awaited<ReturnType<typeof seatFor>>) => (seated.kind === 'seated' ? `${seated.seat.n} ${seated.how}` : 'busy')
  check(n(scoutSeat) === '1 free' && n(writerSeat) === '2 free' && n(scoutAgain) === '1 kept',
    `the first agent takes seat 1, the next seat 2, and an agent that holds a seat keeps it (${n(scoutSeat)}, ${n(writerSeat)}, ${n(scoutAgain)})`)
  const bothReady = await within(90, async () => (await db.query(
    `select n, status from seats where instance_id = $1 and status <> 'free' order by n`, [instanceId])).rows.map((r) => `${r.n}:${r.status}`).join() === '1:ready,2:ready')
  check(bothReady && displays() === '1,2', `the computer starts seat 2's display and reports both seats ready (displays ${displays()})`)

  // A task for each agent. Each session runs on its agent's seat.
  const startTask = async (name: string) => {
    const task = await post(alice, '/v1/tasks', { title: `Check with ${name}`, instructions: 'Look at it.', agentId: agentIds.get(name) })
    const sessionId: string = must(task.json?.sessionId, `${name}'s session`)
    await within(120, async () => (await one('select status from sessions where id = $1', [sessionId]))?.status === 'idle')
    const workspace = String(must(await one('select w.path from workspaces w join sessions s on s.workspace_id = w.id where s.id = $1', [sessionId]), 'workspace').path)
    const { client, server } = await computerTools(container, sessionId, workspace)
    closers.push(() => client.close())
    const seat = await one('select n from seats where id = (select seat_id from sessions where id = $1)', [sessionId])
    return { sessionId, tools: client, cdp: String(server.env.AGENTS_BROWSER_CDP), socket: String(server.env.AGENTS_SCREEN_SOCKET), seat: Number(seat?.n) }
  }
  const [scout, writer] = await Promise.all([startTask('scout'), startTask('writer')])
  check(scout.seat === 1 && writer.seat === 2 && scout.cdp.endsWith(':9222') && writer.cdp.endsWith(':9223') && scout.socket !== writer.socket,
    `each session runs on its agent's seat, with that seat's browser and screen (${scout.cdp}, ${writer.cdp})`)

  // Both browsers are driven at once, and each screenshot shows its own page.
  await Promise.all([
    scout.tools.callTool({ name: 'browser_navigate', arguments: { url: seatPage('Seat one page', '#ff0000') } }),
    writer.tools.callTool({ name: 'browser_navigate', arguments: { url: seatPage('Seat two page', '#0000ff') } }),
  ])
  const [scoutShot, writerShot] = await Promise.all([scout, writer].map((s) => s.tools.callTool({ name: 'computer', arguments: { action: 'screenshot' } })))
  const scoutPixel = pixelOf(must(imageOf(scoutShot), "scout's screenshot"), IN_PAGE.x, IN_PAGE.y)
  const writerPixel = pixelOf(must(imageOf(writerShot), "writer's screenshot"), IN_PAGE.x, IN_PAGE.y)
  check(isRed(scoutPixel) && isBlue(writerPixel),
    `two seats' browsers driven at once each show their own page in their own screenshot (seat 1 ${scoutPixel.join(',')}, seat 2 ${writerPixel.join(',')})`)
  const titles = await Promise.all([scout, writer].map(async (s) => textOf(await s.tools.callTool({ name: 'browser_snapshot', arguments: {} }))))
  check(titles[0]?.includes('Seat one page') && !titles[0].includes('Seat two page') && titles[1]?.includes('Seat two page') && !titles[1].includes('Seat one page'),
    "each agent's browser tools read its own seat's page")
  // A long action on seat 1 holds only seat 1's screen.
  const long = scout.tools.callTool({ name: 'computer', arguments: { action: 'wait', duration: LONG_WAIT_S } })
  await sleep(300)
  const quickStarted = Date.now()
  const quick = await writer.tools.callTool({ name: 'computer', arguments: { action: 'screenshot' } })
  const quickMs = Date.now() - quickStarted
  await long
  check(!quick.isError && quickMs < QUICK_MS, `seat 2's screenshot comes back while seat 1 waits ${LONG_WAIT_S} s (${quickMs} ms)`)

  // Each seat's memory while both agents work their screens.
  const working = await measure(container, async () => {
    const both = Promise.all([workScreen(scout.tools), workScreen(writer.tools)])
    await sleep(SAMPLE_MS / 2)
    const seats = seatMemory(container)
    await both
    return seats
  })

  // Alice watches both seats and takes over seat 1. Only seat 1's agent stops.
  const seatPath = (seat: number) => `/v1/screens/${instanceId}/seats/${seat}`
  const one1 = await viewOf(alice, seatPath(1))
  const two1 = await viewOf(alice, seatPath(2))
  closers.push(() => { one1.ws.close() }, () => { two1.ws.close() })
  const { RfbClient } = await import('../daemon/rfb.ts')
  const [screen1, screen2] = await Promise.all([RfbClient.connect(one1.stream), RfbClient.connect(two1.stream)])
  await Promise.all([screen1.refresh(false), screen2.refresh(false)])
  const viewPixel = (screen: typeof screen1) => { const p = screen.pixel(IN_PAGE.x, IN_PAGE.y); return [p.r, p.g, p.b] }
  check(isRed(viewPixel(screen1)) && isBlue(viewPixel(screen2)), `a person watching each seat sees that seat's own screen (${viewPixel(screen1).join(',')}; ${viewPixel(screen2).join(',')})`)
  const took = await post(alice, `${seatPath(1)}/take`, { sessionId: scout.sessionId })
  check(took.status === 200 && took.json?.control?.holder === 'person', `alice takes over seat 1 (${took.status})`)
  check(await within(10, async () => holderOf(one1)?.login === alice && holderOf(two1)?.holder === 'agent'),
    "seat 1's view says alice has it, and seat 2's view says its agent has it")
  const refused = await scout.tools.callTool({ name: 'computer', arguments: { action: 'screenshot' } })
  const refusedBrowser = await scout.tools.callTool({ name: 'browser_snapshot', arguments: {} })
  check(refused.isError && textOf(refused).includes(`${alice} has taken over the screen`) && refusedBrowser.isError,
    "seat 1's agent is refused its screen and browser while alice holds seat 1")
  const stillWorks = await writer.tools.callTool({ name: 'computer', arguments: { action: 'screenshot' } })
  const stillBrowses = await writer.tools.callTool({ name: 'browser_navigate', arguments: { url: seatPage('Seat two again', '#0000ff') } })
  check(!stillWorks.isError && !stillBrowses.isError && textOf(stillBrowses).includes('Seat two again'),
    'seat 2 keeps working, screen and browser alike, while alice holds seat 1')
  const takeover = await one('select s.n from screen_takeovers t join seats s on s.id = t.seat_id where t.instance_id = $1 and t.ended_at is null', [instanceId])
  const noticed = async (sessionId: string) => Boolean(await one(`select 1 from events where session_id = $1 and kind = 'notice' and body->>'subtype' = 'screen'`, [sessionId]))
  check(takeover?.n === 1 && await noticed(scout.sessionId) && !await noticed(writer.sessionId),
    "the record keeps the takeover on seat 1, and only seat 1's session has the notice")
  const handed = await post(alice, `${seatPath(1)}/hand-back`, { sessionId: scout.sessionId })
  const back = await scout.tools.callTool({ name: 'computer', arguments: { action: 'screenshot' } })
  check(handed.status === 200 && !back.isError, 'after alice hands seat 1 back, its agent works again')

  // A login made in seat 1 works in seat 2, and a logout in seat 2 reaches seat 1.
  execFileSync('docker', ['exec', '-d', container, 'node', '-e', LOGIN_SITE])
  await within(10, async () => (tryDocker('exec', container, 'curl', '-s', `${SITE}/whoami`) ?? '').includes('nobody signed in'))
  const first = `first-${id}`
  const signedIn = await siteSays(scout.tools, `/login?as=${first}`)
  const shared = await within(SHARED_WITHIN_S, async () => await siteSays(writer.tools, '/whoami') === `signed in as ${first}`)
  check(signedIn === `signed in as ${first}` && shared, `a login made in seat 1's browser works in seat 2's (${signedIn}; seat 2 ${await siteSays(writer.tools, '/whoami')})`)
  const signedOut = await siteSays(writer.tools, '/logout')
  const gone = await within(SHARED_WITHIN_S, async () => await siteSays(scout.tools, '/whoami') === 'nobody signed in')
  check(signedOut === 'signed out now' && gone, `a logout in seat 2 signs seat 1 out too (seat 1 ${await siteSays(scout.tools, '/whoami')})`)
  // A seat that starts later begins with the logins the others share.
  const second = `second-${id}`
  await siteSays(scout.tools, `/login?as=${second}`)
  await within(SHARED_WITHIN_S, async () => await siteSays(writer.tools, '/whoami') === `signed in as ${second}`)
  const readerSeat = await seatFor('reader')
  const reader = await startTask('reader')
  const readerSays = await siteSays(reader.tools, '/whoami')
  check(n(readerSeat) === '3 free' && reader.seat === 3 && readerSays === `signed in as ${second}`,
    `a third agent takes seat 3, whose new browser starts with the shared login (${n(readerSeat)}, ${readerSays})`)

  // Private work on seat 2 hides seat 2's screen from bob, and only seat 2's.
  const { id: privateTask } = must(await one(
    `insert into tasks (team_id, slug, title, owner_id, agent_id, visibility) select $1, $2, 'Private work', p.id, $4, 'private'
     from people p where p.login = $3 returning id`, [teamId, `private-${id}`, alice, agentIds.get('writer')]), 'private task')
  await db.query(
    `insert into sessions (team_id, task_id, instance_id, agent_id, seat_id, status)
     select $1, $2, $3, $4, id, 'running' from seats where instance_id = $3 and n = 2`, [teamId, privateTask, instanceId, agentIds.get('writer')])
  const bobOnTwo = await outcome(bob, seatPath(2))
  const bobOnOne = await outcome(bob, seatPath(1))
  check(bobOnTwo === "closed 4403 This screen has shown work you can't see." && bobOnOne === 'watching',
    `private work on seat 2 hides seat 2's screen from a teammate who can't see it, and not seat 1's (${bobOnTwo}; ${bobOnOne})`)
  const freeSeat = await outcome(alice, seatPath(4))
  check(freeSeat === 'closed 4403 Seat 4 is free, so its screen is off.', `a free seat's screen says it is off (${freeSeat})`)

  console.log(`      computer idle, seat 1 only: ${idle.peak} MiB at most, CPU up to ${idle.cpu}%; seat 1's processes ${JSON.stringify(idle.seats)} MiB`)
  console.log(`      seats 1 and 2 working their screens at once: ${working.peak} MiB at most, CPU up to ${working.cpu}%; `
    + `by seat ${JSON.stringify(working.seats)} MiB`)
  console.log(`      three seats up after the logins: by seat ${JSON.stringify(seatMemory(container))} MiB`)
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  for (const close of closers) await Promise.resolve(close()).catch(() => undefined)
  await stopAll(children)
  // Boxes are removed whatever happened, or they would keep calling a closed port.
  const boxes = await db.query(`select i.id from instances i join teams t on t.id = i.team_id where t.name = $1 and i.kind = 'box'`, [team]).catch(() => ({ rows: [] }))
  for (const { id: boxId } of boxes.rows) {
    tryDocker('rm', '-f', `agents-box-${boxId}`)
    tryDocker('volume', 'rm', `agents-box-${boxId}-home`)
  }
  // The run's own image goes too, and the disk keeps no copy of it.
  tryDocker('rmi', IMAGE)
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
    rmSync(work, { recursive: true, force: true })
  }
  await db.end().catch(() => undefined)
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test team and box removed)'}`)
process.exit(failures.length ? 1 : 0)
