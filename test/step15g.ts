// A person's computer with no setup, step 15g. Alice adds Bob to her team in
// the app, and his computer, a real box built from box/Dockerfile under a tag
// of the run's own, is made and started with no step from him. Until Bob signs
// in to Claude it runs Claude on the team's token, which this check keeps in a
// file of its own and finds in no table and no log, and once he has, on his.
// Every seat has a real desktop: JWM with title bars and a dock along the
// bottom. With the computer tool, the agent opens a terminal from the dock and
// types into it, switches windows with alt+Tab, opens the whiteboard from the
// dock, draws a rectangle in it and saves a screenshot. A seat that another
// agent takes loses the last agent's windows, and a second seat has its own
// dock. Prints the computer's memory, and each seat's, with the new desktop.
// The box reaches this check's API only on 7701, the machine port the box
// firewall opens for checks, so run it holding ~/.agents-app/checks/run.lock.
//   node --env-file=.env --env-file=.env.test test/step15g.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { z } from 'zod'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { must } from './must.ts'
import { ROOT, IMAGE, MACHINE_PORT, SCREEN, within, docker, tryDocker, boxCheckEnv, peopleSocket, textOf, imageOf, stopAll } from './computers.ts'
import { servePeople } from './people.ts'
import { dockButton, measure, pixelsOf, seatMemory, seatTools, type Pixels } from './seats.ts'
import { DOCK_HEIGHT, TERMINAL_BACKGROUND } from '../daemon/dock.ts'
import { DRAWING_KEY, WHITEBOARD_URL } from '../daemon/whiteboard.ts'
import { AgentId } from '../shared/ids.ts'
import { InstanceId } from '../shared/onboarding.ts'
import { messageOf } from '../shared/errors.ts'

const PEOPLE_PORT = 7988
const STREAMS_PORT = 7989
const API = `http://127.0.0.1:${MACHINE_PORT}`
const PEOPLE = `http://127.0.0.1:${PEOPLE_PORT}`
const id = randomBytes(4).toString('hex')
const team = `seats-desk-${id}`
const alice = `alice-desk-${id}@local`
const bob = `bob-desk-${id}@local`
// Box mounts come from the colima VM, which sees only the home folder.
const work = join(homedir(), '.agents-app', 'checks', `seats-desk-${id}`)
const SHOTS = join(ROOT, 'test', 'ui-shots')
// The team's Claude token and Bob's own, both made up for this run.
const teamToken = `sk-ant-oat01-seatsteam${randomBytes(24).toString('hex')}`
const bobToken = `sk-ant-oat01-seatsbob${randomBytes(24).toString('hex')}`
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
// docker stats samples about once a second, so this gives five or six samples.
const SAMPLE_MS = 6000
// The rectangle the agent drags out on the whiteboard, in screen pixels.
const DRAG = { from: [500, 350], to: [800, 550] } as const

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []
const closers: (() => Promise<void> | void)[] = []
let apiLog = ''

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
const checkEnv = { ...boxCheckEnv(team, work, STREAMS_PORT, [PEOPLE]), AGENTS_BOX_TOKEN_FILE: join(work, 'team-token') }
const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', '--env-file=.env.test', ...args],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...checkEnv } })

async function post(login: string, path: string, body: unknown = {}) {
  const res = await fetch(PEOPLE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

// A task for the agent, run on its home computer by the stand-in for Claude,
// and the token that Claude was started with, as its fingerprint.
async function runTask(container: string, agentId: string, title: string) {
  const created = await post(bob, '/v1/tasks', { title, instructions: 'Look at it.', agentId })
  const sessionId: string = must(created.json?.sessionId, `the session of "${title}"`)
  await within(120, async () => (await one('select status from sessions where id = $1', [sessionId]))?.status === 'idle')
  const workspace = String(must(await one('select w.path from workspaces w join sessions s on s.workspace_id = w.id where s.id = $1', [sessionId]), 'workspace').path)
  const starts = (tryDocker('exec', container, 'cat', `${workspace}/.fake/starts.jsonl`) ?? '').split('\n').filter(Boolean)
  const tokenSha: unknown = starts.length ? JSON.parse(starts.at(-1) ?? '{}').tokenSha : null
  return { sessionId, workspace, tokenSha }
}

// The session's computer tools, closed when the check ends.
async function toolsOf(container: string, sessionId: string, workspace: string): Promise<Client> {
  const { client } = await seatTools(container, sessionId, workspace)
  closers.push(() => client.close())
  return client
}

const act = (tools: Client, action: Record<string, unknown>) => tools.callTool({ name: 'computer', arguments: action })
async function screen(tools: Client): Promise<Pixels> {
  return pixelsOf(must(imageOf(await act(tools, { action: 'screenshot' })), 'a screenshot'))
}
const hexOf = (pixel: number[]) => `#${pixel.map((value) => value.toString(16).padStart(2, '0')).join('')}`

// Where the screen shows the terminal's background, above the dock: how many
// pixels, and the middle of the area they cover.
function terminalOn(pixels: Pixels) {
  let count = 0
  let [left, top, right, bottom] = [SCREEN.width, SCREEN.height, 0, 0]
  for (let y = 0; y < SCREEN.height - DOCK_HEIGHT; y += 2) {
    for (let x = 0; x < SCREEN.width; x += 2) {
      if (hexOf(pixels.at(x, y)) !== TERMINAL_BACKGROUND) continue
      count += 1
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  }
  return { count, middle: [Math.round((left + right) / 2), Math.round((top + bottom) / 2)] as const }
}

// The processes on a seat's display, by name, read from inside the box.
const onDisplay = (container: string, display: number, name: string) => (tryDocker('exec', container, 'sh', '-c',
  `for p in $(pgrep -x ${name}); do tr '\\0' '\\n' < /proc/$p/environ | grep -qx 'DISPLAY=:${display}' && echo $p; done`) ?? '')
  .split('\n').filter(Boolean)
// The names of a process's environment, never their values.
const envNames = (container: string, pid: string) => (tryDocker('exec', container, 'sh', '-c', `tr '\\0' '\\n' < /proc/${pid}/environ | cut -d= -f1`) ?? '')
  .split('\n').filter(Boolean)
// The pages a seat's browser has open, from its DevTools port.
const Pages = z.array(z.object({ type: z.string(), url: z.string() }))
const pagesOf = (container: string, display: number) => Pages.parse(JSON.parse(tryDocker('exec', container, 'curl', '-s', `http://127.0.0.1:${9221 + display}/json/list`) ?? '[]'))

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

let container = ''
try {
  await db.connect()
  mkdirSync(work, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(work, 'scenario.json'), JSON.stringify({ turns: [] }))
  // As `claude setup-token` leaves it, with a line end, which the server trims.
  writeFileSync(join(work, 'team-token'), `${teamToken}\n`, { mode: 0o600 })
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, alice)
  const { takeSeat } = await import('../server/seats.ts')
  const { tx, pool } = await import('../server/db.ts')
  closers.push(() => pool.end())

  node('server/boxes.ts', 'build')
  const api = spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...checkEnv },
  })
  for (const out of [api.stdout, api.stderr]) out.setEncoding('utf8').on('data', (text: string) => { apiLog += text })
  children.push(api)
  // Stands in for tailscale serve, which sends people to the API's socket.
  await servePeople(PEOPLE_PORT, peopleSocket(work))
  await within(20, () => fetch(API).then(() => true, () => false))

  // Alice adds Bob, and his computer is made and started by itself.
  const added = await post(alice, '/v1/team/people', { login: bob, name: 'Bob' })
  const bobId: string = must(added.json?.personId, 'Bob, added to the team')
  const box = must(await one('select id, name, claimed_by, seat_cap from instances where owner_id = $1 and personal', [bobId]), "Bob's computer")
  const instanceId = String(box.id)
  container = `agents-box-${instanceId}`
  check(box.claimed_by === bobId && box.seat_cap === 4, `Bob has his own computer as soon as he is on the team (${String(box.name)})`)
  const online = await within(180, async () => {
    const row = await one('select status, screen_width from instances where id = $1', [instanceId])
    return row?.status === 'online' && row.screen_width === SCREEN.width
  })
  check(online, 'it starts and comes online with its screen, with nothing pressed')
  if (!online) throw new Error('the computer never came online, so nothing after this can run')

  // It runs Claude on the team's token until Bob signs in.
  const env = z.array(z.string()).parse(JSON.parse(docker('inspect', '-f', '{{json .Config.Env}}', container)))
  check(env.includes(`CLAUDE_CODE_OAUTH_TOKEN=${teamToken}`), "the computer's container holds the team's Claude token")
  const painter = await post(bob, '/v1/agents', { name: 'painter', homeInstanceId: instanceId })
  const painterId: string = must(painter.json?.agentId, `Bob's agent (${JSON.stringify(painter.json)})`)
  const first = await runTask(container, painterId, 'Look before signing in')
  check(first.tokenSha === sha256(teamToken), "before Bob signs in, his agent's Claude runs on the team's token")

  // The desktop on seat 1, through the session's own computer tools.
  const tools = await toolsOf(container, first.sessionId, first.workspace)
  const wm = onDisplay(container, 1, 'jwm')
  check(wm.length === 1 && !envNames(container, must(wm[0], 'JWM')).some((name) => name.endsWith('TOKEN')),
    "seat 1 runs JWM as its window manager, which sees none of the daemon's tokens")
  const start = await screen(tools)
  const dockRow = [10, 400, 1270].map((x) => start.at(x, SCREEN.height - 3))
  check(dockRow.every(([r, g, b]) => r === g && g === b && r < 0x40),
    `the screen has a dark grey dock along its bottom (${dockRow.map(hexOf).join(' ')})`)

  // The dock opens a terminal, and the agent types into it.
  await act(tools, { action: 'left_click', coordinate: dockButton('Terminal') })
  const opened = await within(15, async () => onDisplay(container, 1, 'xterm').length === 1)
  let terminal = terminalOn(await screen(tools))
  await within(10, async () => {
    terminal = terminalOn(await screen(tools))
    return terminal.count > 10_000
  })
  const xterm = onDisplay(container, 1, 'xterm')[0]
  check(opened && terminal.count > 10_000 && xterm !== undefined && !envNames(container, xterm).some((name) => name.endsWith('TOKEN')),
    `the dock's terminal button opens a terminal window, which sees none of the daemon's tokens (${terminal.count} terminal pixels sampled)`)
  const word = `dock-${id}`
  await act(tools, { action: 'left_click', coordinate: terminal.middle })
  await act(tools, { action: 'type', text: `echo ${word} > ~/terminal-check\n` })
  const typed = await within(10, async () => tryDocker('exec', container, 'cat', '/home/agent/terminal-check') === word)
  check(typed, 'what the agent types into the terminal runs there')

  // Alt+Tab switches between the terminal and the browser.
  const terminalShows = async () => hexOf((await screen(tools)).at(...terminal.middle)) === TERMINAL_BACKGROUND
  await act(tools, { action: 'key', text: 'alt+Tab' })
  const behind = await within(5, async () => !(await terminalShows()))
  await act(tools, { action: 'key', text: 'alt+Tab' })
  const front = await within(5, terminalShows)
  check(behind && front, 'alt+Tab brings the browser in front of the terminal, and again brings the terminal back')

  // The dock opens the whiteboard from the box, and the agent draws on it.
  await act(tools, { action: 'left_click', coordinate: dockButton('Whiteboard') })
  const boardOpen = await within(15, async () => pagesOf(container, 1).some((page) => page.type === 'page' && page.url === WHITEBOARD_URL))
  const tabs = textOf(await tools.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }))
  const boardTab = /(\d+)[^\n]*127\.0\.0\.1:8400/.exec(tabs)?.[1]
  if (boardTab !== undefined) await tools.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: Number(boardTab) } })
  const drawn = async () => {
    const result = textOf(await tools.callTool({ name: 'browser_evaluate', arguments: { function: `() => localStorage.getItem('${DRAWING_KEY}')` } }))
    return /"type\\?":\\?"rectangle\\?"/.test(result) ? result : null
  }
  const ready = await within(20, async () => /Rectangle/.test(textOf(await tools.callTool({ name: 'browser_snapshot', arguments: {} }))))
  check(boardOpen && ready, `the dock's whiteboard button opens Excalidraw, served from the box at ${WHITEBOARD_URL}`)
  const middle = [SCREEN.width / 2, (SCREEN.height - DOCK_HEIGHT) / 2 + 60]
  await act(tools, { action: 'left_click', coordinate: middle })
  await act(tools, { action: 'key', text: 'r' })
  await act(tools, { action: 'left_click_drag', start_coordinate: DRAG.from, coordinate: DRAG.to })
  let saved = await drawn()
  for (const until = Date.now() + 10_000; saved === null && Date.now() < until;) {
    await sleep(300)
    saved = await drawn()
  }
  const size = /\\?"width\\?":(\d+(?:\.\d+)?),\\?"height\\?":(\d+(?:\.\d+)?)/.exec(saved ?? '')
  const [width, height] = [Number(size?.[1]), Number(size?.[2])]
  check(Math.abs(width - (DRAG.to[0] - DRAG.from[0])) <= 2 && Math.abs(height - (DRAG.to[1] - DRAG.from[1])) <= 2,
    `the agent's drag with the computer tool draws a rectangle that size on the whiteboard (${width}x${height})`)
  // The rectangle's top edge shows on screen, with white inside it.
  const edgeShown = await within(10, async () => {
    const pixels = await screen(tools)
    const x = (DRAG.from[0] + DRAG.to[0]) / 2
    const edge = Array.from({ length: 13 }, (_, i) => pixels.at(x, DRAG.from[1] - 6 + i)).some(([r, g, b]) => r + g + b < 200)
    const inside = pixels.at(x, (DRAG.from[1] + DRAG.to[1]) / 2)
    return edge && inside.every((value) => value > 240)
  })
  check(edgeShown, 'the screen shows the rectangle the agent drew')
  const shot = await tools.callTool({ name: 'save_screenshot', arguments: { name: 'whiteboard-drawing' } })
  const shotFile = `${first.workspace}/task/checks/whiteboard-drawing.png`
  const kept = tryDocker('cp', `${container}:${shotFile}`, join(SHOTS, 'whiteboard-drawing.png')) !== null
  check(!shot.isError && kept, 'the agent saves a screenshot of the drawing (test/ui-shots/whiteboard-drawing.png)')

  const idle = await measure(container, async () => { await sleep(SAMPLE_MS); return seatMemory(container) })

  // Another agent taking seat 1 gets it without the last agent's windows.
  const sketcher = await post(bob, '/v1/agents', { name: 'sketcher', homeInstanceId: instanceId })
  const sketcherId: string = must(sketcher.json?.agentId, "Bob's second agent")
  const seatFor = (agentId: string) => tx((client) => takeSeat(client, InstanceId.parse(instanceId), AgentId.parse(agentId)))
  const painterSeat = await seatFor(painterId)
  const cleared = await within(30, async () => onDisplay(container, 1, 'xterm').length === 0
    && !pagesOf(container, 1).some((page) => page.url === WHITEBOARD_URL))
  const painterReady = await within(60, async () => (await one('select status from seats where instance_id = $1 and n = 1', [instanceId]))?.status === 'ready')
  check(painterSeat.kind === 'seated' && painterSeat.seat.n === 1 && cleared && painterReady && onDisplay(container, 1, 'jwm').length === 1,
    'an agent given seat 1 gets it without the terminal and whiteboard left there, and the dock stays')

  // A second seat has a dock of its own.
  const sketcherSeat = await seatFor(sketcherId)
  const seat2Ready = await within(90, async () => (await one('select status from seats where instance_id = $1 and n = 2', [instanceId]))?.status === 'ready')
  const second = await runTask(container, sketcherId, 'Sketch on seat 2')
  const tools2 = await toolsOf(container, second.sessionId, second.workspace)
  await act(tools2, { action: 'left_click', coordinate: dockButton('Terminal') })
  await act(tools2, { action: 'left_click', coordinate: dockButton('Whiteboard') })
  const seat2Windows = await within(20, async () => onDisplay(container, 2, 'xterm').length === 1
    && pagesOf(container, 2).some((page) => page.url === WHITEBOARD_URL))
  check(sketcherSeat.kind === 'seated' && sketcherSeat.seat.n === 2 && seat2Ready && onDisplay(container, 2, 'jwm').length === 1 && seat2Windows
    && onDisplay(container, 1, 'xterm').length === 0,
  "seat 2 has its own dock, whose terminal and whiteboard open on seat 2's screen only")

  // Seat 1 gets a terminal and the whiteboard again, and both seats are measured with them open.
  const painterAgain = await runTask(container, painterId, 'Look again on seat 1')
  const tools1 = await toolsOf(container, painterAgain.sessionId, painterAgain.workspace)
  await act(tools1, { action: 'left_click', coordinate: dockButton('Terminal') })
  await act(tools1, { action: 'left_click', coordinate: dockButton('Whiteboard') })
  await within(20, async () => onDisplay(container, 1, 'xterm').length === 1 && pagesOf(container, 1).some((page) => page.url === WHITEBOARD_URL))
  const working = await measure(container, async () => {
    const until = Date.now() + SAMPLE_MS
    while (Date.now() < until) {
      await Promise.all([tools1, tools2].map(async (seatTools) => {
        await act(seatTools, { action: 'left_click_drag', start_coordinate: [400, 300], coordinate: [600, 450] })
        await act(seatTools, { action: 'key', text: 'ctrl+z' })
      }))
    }
    return seatMemory(container)
  })

  // Once Bob signs in, his agents run on his own token.
  execFileSync('docker', ['exec', '-i', container, 'sh', '-c', 'umask 077 && cat > /home/agent/.agents-app/claude-token'], { input: `${bobToken}\n` })
  const signedIn = await runTask(container, painterId, 'Look after signing in')
  check(signedIn.tokenSha === sha256(bobToken), "once Bob has signed in, his agent's Claude runs on his own token")

  // The team's token is in no table and in no log.
  const tables = (await db.query(`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'team_id'`)).rows.map((row) => String(row.table_name))
  const teamId = String(must(await one('select id from teams where name = $1', [team]), 'the team').id)
  const holding: string[] = []
  for (const table of tables) {
    const found = await one(`select count(*)::int as n from "${table}" t where t.team_id = $1 and t::text like $2`, [teamId, `%${teamToken}%`])
    if (found?.n) holding.push(table)
  }
  const boxLog = execFileSync('docker', ['logs', container], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  check(holding.length === 0 && !apiLog.includes(teamToken) && !boxLog.includes(teamToken),
    `the team's token is in no table, in no line the API logged and in no line the computer logged${holding.length ? ` (found in ${holding.join(', ')})` : ''}`)

  console.log(`      computer with seat 1's terminal and whiteboard open: ${idle.peak} MiB at most, CPU up to ${idle.cpu}%; by seat ${JSON.stringify(idle.seats)} MiB`)
  console.log(`      seats 1 and 2 each with a terminal and the whiteboard, drawing at once: ${working.peak} MiB at most, CPU up to ${working.cpu}%; `
    + `by seat ${JSON.stringify(working.seats)} MiB`)
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  for (const close of closers) await Promise.resolve(close()).catch(() => undefined)
  await stopAll(children)
  // Boxes are removed whatever happened, or they would keep calling a closed port.
  const boxes = await db.query(`select i.id from instances i join teams t on t.id = i.team_id where t.name = $1 and i.kind = 'box'`, [team]).catch(() => ({ rows: [] }))
  for (const { id: boxId } of boxes.rows) {
    tryDocker('rm', '-f', `agents-box-${String(boxId)}`)
    tryDocker('volume', 'rm', `agents-box-${String(boxId)}-home`)
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
