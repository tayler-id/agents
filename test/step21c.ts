// Terminal folders, connected from the app. The desktop app on a Mac lists the
// folders Claude Code ran in there and connects, changes or disconnects one
// through the Mac's daemon, over a socket only that macOS user can open. A
// browser lists the person's connected folders. The check writes Claude Code's
// transcripts itself, into a stand-in home folder the daemon reads, and drives
// the real API, daemon and Electric, the Electron app, and Chromium, Firefox and
// WebKit at desktop and phone width.
//   node --env-file=.env --env-file=.env.test test/step21c.ts

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { AxeBuilder } from '@axe-core/playwright'
import { _electron as electron, chromium, firefox, webkit, type ElectronApplication, type Page } from '@playwright/test'
import pg from 'pg'
import { messageOf } from '../shared/errors.ts'
import { must } from './must.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
const SHOTS = join(ROOT, 'test', 'ui-shots')
// Ports 8120 to 8123 are this check's: machines, people, streams, and a page on another site.
const PORT = 8120
const API = `http://127.0.0.1:${PORT}`
const PEOPLE_PORT = PORT + 1
const PEOPLE = `http://127.0.0.1:${PEOPLE_PORT}`
const STREAMS_PORT = PORT + 2
const ELSEWHERE_PORT = PORT + 3
// Over the tailnet the app is plain HTTP on a name that is not localhost. WebKit can't map a name, so it uses the address.
const INSECURE_HOST = 'agents.test'
const INSECURE = `http://${INSECURE_HOST}:${PEOPLE_PORT}`
const id = randomBytes(4).toString('hex')
const team = `mac-connect-${id}`
const owner = `mac-connect-owner-${id}@local`
const mate = `mac-connect-mate-${id}@local`
// How long a line may take to reach the record. The daemon reads every second.
const LANDS_SEC = 15
// How long the page may take to show a change.
const SHOWS_MS = 15_000
// A query to the shared test database that takes longer than this fails the check, rather than holding it forever.
const QUERY_TIMEOUT_MS = 60_000
// How long the API and daemon get to stop before they are killed.
const STOP_SEC = 15
const started = Date.now()

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, query_timeout: QUERY_TIMEOUT_MS })
const children: ChildProcess[] = []
// The people port's stand-in and the other site's page, both closed at the end.
const servers: { close: () => unknown }[] = []
const failures: string[] = []
const logs: string[] = []
const made: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

function run(name: string, script: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', (text: string) => { logs.push(`${name}: ${text}`) })
  children.push(child)
  return child
}

async function until(label: string, seconds: number, test: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(250)
  }
  console.log(`      (timed out waiting for ${label})`)
  return false
}

const count = async (sql: string, params: unknown[]) => Number((await db.query(sql, params)).rows[0].count)

// Asks the daemon over its socket, as the desktop app's main process does, each time on a new connection, so the
// kernel checks the permissions every time. A connect that fails gives its code.
function askSocket(socket: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any; code: string | null }> {
  return new Promise((resolve) => {
    const req = request({ socketPath: socket, method, path, agent: false, headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')), code: null }) })
    })
    req.on('error', (error: NodeJS.ErrnoException) => { resolve({ status: 0, body: null, code: error.code ?? error.message }) })
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

// Claude Code names a session's transcript folder after the path it started in,
// with every character other than a letter or a digit made a dash.
const projectDir = (claudeDir: string, cwd: string) => join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))

// One Claude Code session's transcript, written as Claude Code writes it: where and
// when it started, a prompt and the reply that ends the turn. `changed` sets when the
// file last changed, which orders the page's list.
function transcript(claudeDir: string, cwd: string, startedAt: Date, prompt: string, changed?: Date) {
  const session = randomUUID()
  const dir = projectDir(claudeDir, cwd)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${session}.jsonl`)
  const timestamp = startedAt.toISOString()
  const line = (fields: Record<string, unknown>) => ({ parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId: session, version: '2.1.299', uuid: randomUUID(), timestamp, ...fields })
  const lines = [
    { type: 'queue-operation', operation: 'enqueue', timestamp, sessionId: session },
    line({ type: 'user', message: { role: 'user', content: prompt }, turnOrigin: 'human' }),
    line({ type: 'assistant', message: {
      id: `msg_${randomBytes(8).toString('hex')}`, type: 'message', role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 10, output_tokens: 2 },
    } }),
  ]
  writeFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(''))
  if (changed) utimesSync(path, changed, changed)
  return { session, path }
}

let desktop: ElectronApplication | null = null
try {
  mkdirSync(SHOTS, { recursive: true })
  await db.connect()
  const node = (...args: string[]) => {
    const result = spawnSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`)
    return result.stdout
  }
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, owner)
  node('server/admin.ts', 'add-person', team, mate)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', owner))
  const { token: otherToken } = JSON.parse(node('server/admin.ts', 'add-instance', team, `other-mac-${id}`, 'mac', owner))

  // The page sets apart folders in the system's temporary folders, so the stand-in home is in the checkout's ignored
  // scratch folder. The daemon's own home is in the temporary folder, so the socket's path stays short.
  const scratch = join(ROOT, '.scratch', `step21c-${id}`)
  mkdirSync(scratch, { recursive: true })
  made.push(scratch)
  const home = join(realpathSync.native(scratch), 'home')
  const agentsHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'agents-21c-')))
  made.push(agentsHome)
  const claudeDir = join(home, '.claude')
  const projects = join(home, 'Projects')
  const shop = join(projects, 'shop')
  const inner = join(shop, 'apps', 'api')
  const diary = join(projects, 'diary')
  // Folders that are never connected. Their names must never leave the Mac.
  const hiddenName = `hidden-${randomBytes(6).toString('hex')}`
  const hidden = join(projects, hiddenName)
  const goneName = `gone-${randomBytes(6).toString('hex')}`
  const gone = join(projects, goneName)
  const temp = realpathSync.native(mkdtempSync(join(tmpdir(), 'agents-21c-scratch-')))
  made.push(temp)
  const tempName = must(temp.split('/').pop(), 'the temporary folder name')
  const ownSessions = join(agentsHome, 'agents', 'agent-one')
  for (const dir of [shop, inner, diary, hidden, ownSessions]) mkdirSync(dir, { recursive: true })

  // Claude Code ran in each of these, newest first: the temporary folder, the unconnected folder, a folder that is gone
  // since, shop, a folder inside shop, diary and the home folder. The daemon's own session is newer than all of them.
  const ago = (ms: number) => new Date(Date.now() - ms)
  const MINUTE = 60_000
  transcript(claudeDir, temp, ago(MINUTE), 'In a temporary folder.', ago(MINUTE))
  transcript(claudeDir, hidden, ago(2 * MINUTE), 'In a folder never connected.', ago(2 * MINUTE))
  transcript(claudeDir, gone, ago(3 * MINUTE), 'In a folder removed since.', ago(3 * MINUTE))
  const early = transcript(claudeDir, shop, ago(60 * MINUTE), 'Before shop was connected.', ago(60 * MINUTE))
  transcript(claudeDir, inner, ago(120 * MINUTE), 'In a folder inside shop.', ago(120 * MINUTE))
  transcript(claudeDir, diary, ago(1440 * MINUTE), 'In the diary.', ago(1440 * MINUTE))
  transcript(claudeDir, home, ago(2880 * MINUTE), 'In the home folder.', ago(2880 * MINUTE))
  transcript(claudeDir, ownSessions, ago(0), 'An agent of the daemon.', ago(0))

  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  const peopleSocket = join(agentsHome, 'people.sock')
  const api = run('api', 'server/api.ts', {
    AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: peopleSocket,
    AGENTS_STREAMS_PORT: String(STREAMS_PORT), AGENTS_STREAMS_DIR: join(agentsHome, 'streams'),
  })
  // Another run's API still on the port would answer too, so this one must also be alive.
  if (!await until('the API', 30, async () => api.exitCode === null && await fetch(API).then(() => true, () => false))) throw new Error('the API did not start')
  servers.push(await servePeople(PEOPLE_PORT, peopleSocket))
  const daemonEnv = { AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: agentsHome, HOME: home, CLAUDE_CONFIG_DIR: claudeDir, SHELL: '/bin/zsh', ZDOTDIR: home }
  let daemon = run('daemon', 'daemon/agentsd.ts', daemonEnv)
  const socket = join(agentsHome, 'run', 'app.sock')

  // A folder the person connected on their other Mac, which only that Mac changes.
  const remoteName = `remote-${id}`
  const remote = await fetch(`${API}/v1/instance/folders`, {
    method: 'POST', headers: { authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: `/Users/elsewhere/Projects/${remoteName}` }),
  })
  if (remote.status !== 200) throw new Error(`connecting a folder on the other Mac: ${remote.status}`)

  // The socket: only this macOS user can open it.
  await until('the socket', 30, async () => existsSync(socket) && statSync(socket).isSocket() && (statSync(socket).mode & 0o777) === 0o600)
  const mode = (path: string) => (existsSync(path) ? (statSync(path).mode & 0o777).toString(8) : 'none')
  const uid = process.getuid?.()
  check(existsSync(socket) && statSync(socket).isSocket() && mode(socket) === '600' && mode(dirname(socket)) === '700'
    && statSync(socket).uid === uid && statSync(dirname(socket)).uid === uid,
  `the daemon serves the app on a socket of mode ${mode(socket)} in a folder of mode ${mode(dirname(socket))}, both this user's`)
  const reached = await askSocket(socket, 'GET', '/folders')
  check(reached.status === 200 && Array.isArray(reached.body?.folders), `another process of this macOS user reaches the socket (${reached.status} ${String(reached.code)})`)
  // No other user can be played without root, so this shows the modes are what decide: taking the owner's own
  // permission away from the folder, then from the socket, refuses the owner too.
  const shutOut = async (path: string, shut: number, open: number) => {
    if (!existsSync(path)) return 'nothing there'
    chmodSync(path, shut)
    const answer = await askSocket(socket, 'GET', '/folders')
    chmodSync(path, open)
    return answer.code
  }
  const folderShut = await shutOut(dirname(socket), 0o600, 0o700)
  const socketShut = await shutOut(socket, 0o400, 0o600)
  const reopened = await askSocket(socket, 'GET', '/folders')
  check(folderShut === 'EACCES' && socketShut === 'EACCES' && reopened.status === 200,
    `another macOS user can't open it: group and others have no permission on the socket or its folder, and this Mac refuses a connect without either (${String(folderShut)}, ${String(socketShut)})`)

  // The desktop app on this Mac, as the person whose Mac it is.
  const electronHome = join(agentsHome, 'electron')
  mkdirSync(electronHome)
  desktop = await electron.launch({
    args: [`--host-resolver-rules=MAP ${INSECURE_HOST} 127.0.0.1`, `--user-data-dir=${join(electronHome, 'profile')}`, join(ROOT, 'desktop', 'main.cjs')],
    env: { ...process.env, HOME: electronHome, AGENTS_HOME: agentsHome, AGENTS_SERVER: INSECURE, AGENTS_DEV_LOGIN: owner, AGENTS_PROXY: '' },
  })
  const app = desktop
  const desk = await app.firstWindow()
  await desk.locator('.team strong', { hasText: team }).waitFor({ timeout: 30_000 })
  await desk.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Terminal folders', exact: true }).click()
  const list = desk.getByRole('list', { name: 'Folders on this Mac' })
  const opened = await list.waitFor({ timeout: SHOWS_MS }).then(() => true, () => false)
  check(opened && desk.url().endsWith('#/folders'), `the sidebar's Terminal folders link opens the page: ${desk.url()}`)
  const names = await list.locator(':scope > li > .folder-place > strong').allTextContents()
  check(names.join(', ') === [hiddenName, 'shop', 'api', 'diary', 'home'].join(', '),
    `it lists the folders Claude Code ran in on this Mac, newest first: ${names.join(', ')}`)
  // The group shows only when it holds a folder, and opens with a click.
  const groupSummary = desk.locator('main details.temporary > summary')
  const groupLabel = await groupSummary.count() ? await groupSummary.innerText() : 'no group'
  if (await groupSummary.count()) await groupSummary.click()
  const tempNames = await desk.getByRole('list', { name: 'Temporary folders on this Mac' }).locator(':scope > li > .folder-place > strong').allTextContents()
  const pageText = await desk.locator('main').textContent() ?? ''
  check(groupLabel === 'Temporary folders, 1' && tempNames.join(', ') === tempName && !pageText.includes(goneName) && !pageText.includes('agent-one'),
    `a folder in the system's temporary folders is set apart, and a folder that is gone and the daemon's own are left out: ${groupLabel}, ${tempNames.join(', ')}`)
  // Electron's pages can't open the blank page axe uses to finish, so it runs in its older mode here.
  const deskAxe = await new AxeBuilder({ page: desk }).setLegacyMode(true).analyze()
  const deskSerious = deskAxe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)
  check(!deskSerious.length, `the desktop app's page has no serious accessibility problem (${deskSerious.join(' ') || 'clean'})`)

  const group = (name: string) => desk.getByRole('group', { name: `Who sees sessions from ${name}`, exact: true })
  const item = (name: string) => list.locator(':scope > li', { has: group(name) })
  const pressed = async (name: string) => {
    const buttons = group(name).getByRole('button')
    const labels = await buttons.allTextContents()
    const states = await Promise.all((await buttons.all()).map((b) => b.getAttribute('aria-pressed')))
    return labels.map((label, i) => `${label}${states[i] === 'true' ? '*' : ''}`).join(' ')
  }
  const showsPressed = (name: string, want: string) => until(`${name} to show ${want}`, SHOWS_MS / 1000, async () => (await pressed(name)) === want)
  check(await pressed('shop') === 'Off* Team Just me', `each folder has one control with three choices, and an unconnected one is Off: ${await pressed('shop')}`)
  const homeButtons = group('home').getByRole('button')
  check(await homeButtons.nth(0).isEnabled() && await homeButtons.nth(1).isDisabled() && await homeButtons.nth(2).isDisabled()
    && (await item('home').innerText()).includes("so it can't be connected"),
  "the home folder says why it can't be connected, and its Team and Just me can't be chosen")

  // Team connects the folder as the team's.
  const folderRow = async (path: string) => (await db.query('select id, visibility, disconnected_at, connected_at from connected_folders where path = $1', [path])).rows[0]
  const said = (name: string) => item(name).locator('.folder-note[role]').innerText({ timeout: SHOWS_MS }).catch(() => '')
  await group('shop').getByRole('button', { name: 'Team', exact: true }).click()
  const toTeam = await said('shop')
  const shopTeam = await folderRow(shop)
  check(toTeam.startsWith('Connected shop.') && toTeam.includes('the team sees them') && shopTeam?.visibility === 'team' && shopTeam.disconnected_at === null
    && await showsPressed('shop', 'Off Team* Just me'),
  `Team connects the folder as the team's, and the page says so: ${toTeam}`)
  check(await until('the note on the folder inside shop', SHOWS_MS / 1000, async () => (await item('api').innerText()).includes('Its sessions land through shop, which the team sees.')),
    'a folder inside it says its sessions land through it')

  // A session started there afterwards lands. The one from before stays on the Mac.
  const sessionOf = async (harness: string) => (await db.query('select * from sessions where harness_session_id = $1', [harness])).rows[0]
  const turnsEnded = async (harness: string) => {
    const s = await sessionOf(harness)
    return s ? count(`select count(*) from events where session_id = $1 and kind = 'usage'`, [s.id]) : 0
  }
  const fresh = transcript(claudeDir, shop, new Date(must(shopTeam, 'the shop folder').connected_at), 'After connecting from the app.')
  const landed = await until('the session after connecting', LANDS_SEC, async () => (await turnsEnded(fresh.session)) === 1)
  // A bounded wait for what must not happen: the daemon reads the folder's transcripts every second.
  const earlyLanded = await until('the session from before connecting, which must not land', 3, async () => Boolean(await sessionOf(early.session)))
  check(landed && !earlyLanded, 'a session started in it afterwards lands in the record, and the one from before stays on the Mac')

  // Just me keeps its sessions to the person, the ones in the record too.
  // Whether a person may open a session's events, which the API decides on each read.
  const canSee = async (login: string, sessionId: string) =>
    (await fetch(`${PEOPLE}/v1/shape/events?session=${sessionId}&offset=-1`, { headers: { 'tailscale-user-login': login } })).status === 200
  const freshId = String((await sessionOf(fresh.session))?.id)
  const mateSaw = await canSee(mate, freshId)
  await group('shop').getByRole('button', { name: 'Just me', exact: true }).click()
  const toPrivate = await said('shop')
  check(toPrivate.startsWith("Only you see shop's sessions now") && (await folderRow(shop))?.visibility === 'private' && await showsPressed('shop', 'Off Team Just me*')
    && mateSaw && !await canSee(mate, freshId) && await canSee(owner, freshId),
  `Just me makes it private, the page says so, and the teammate who saw its session no longer does: ${toPrivate}`)
  await group('diary').getByRole('button', { name: 'Just me', exact: true }).click()
  const diaryPrivate = await said('diary')
  check(diaryPrivate.startsWith('Connected diary.') && diaryPrivate.includes('only you see them') && (await folderRow(diary))?.visibility === 'private',
    `Just me on a folder that was off connects it as private: ${diaryPrivate}`)

  // Off disconnects it, and what is started there afterwards stays on the Mac.
  await group('shop').getByRole('button', { name: 'Off', exact: true }).click()
  const toOff = await said('shop')
  check(toOff.startsWith('Disconnected shop.') && (await folderRow(shop))?.disconnected_at !== null && await showsPressed('shop', 'Off* Team Just me'),
    `Off disconnects it, and the page says so: ${toOff}`)
  const afterOff = transcript(claudeDir, shop, new Date(), 'After Off.')
  const sentinel = transcript(claudeDir, diary, new Date(must(await folderRow(diary), 'the diary folder').connected_at), 'The sentinel.')
  const sentinelLanded = await until('the sentinel in diary', LANDS_SEC, async () => (await turnsEnded(sentinel.session)) === 1)
  const afterOffLanded = await until('the session after Off, which must not land', 3, async () => Boolean(await sessionOf(afterOff.session)))
  check(sentinelLanded && !afterOffLanded, 'a session started after Off stays on the Mac, while a connected folder\'s lands')

  // The folders the person connected on their other machines, which this Mac doesn't change.
  const others = desk.getByRole('list', { name: 'Connected on your other machines' })
  const othersText = await others.innerText({ timeout: SHOWS_MS }).catch(() => '')
  check(othersText.includes(remoteName) && othersText.includes(`Team · other-mac-${id}`) && !othersText.includes('diary'),
    `the folders connected on the person's other Mac are listed apart, read only: ${othersText.replace(/\s+/g, ' ')}`)

  await desk.screenshot({ path: join(SHOTS, 'step21c-desktop-app.png') })
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(390, 844) })
  const narrow = await until('the narrow window', 5, async () => desk.evaluate(() => window.innerWidth === 390))
  await desk.getByRole('button', { name: 'Menu' }).waitFor({ timeout: SHOWS_MS })
  const fits = await desk.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth
    && [...document.querySelectorAll('.page-head, .page-body, .folder-list > li')].every((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= window.innerWidth + 1))
  await desk.screenshot({ path: join(SHOTS, 'step21c-desktop-app-narrow.png') })
  check(narrow && fits, 'in a window as narrow as a phone the page fits without scrolling sideways')
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 820) })

  // What the daemon refuses, and the page can't do.
  const homeAsk = await askSocket(socket, 'POST', '/folders/connect', { path: home, visibility: 'team' })
  const aboveAsk = await askSocket(socket, 'POST', '/folders/connect', { path: scratch, visibility: 'team' })
  const homeStored = await count('select count(*) from connected_folders where path = any($1)', [[home, realpathSync.native(scratch)]])
  check(homeAsk.status === 409 && String(homeAsk.body?.error).includes('your home folder or holds it') && aboveAsk.status === 409 && homeStored === 0,
    `the daemon refuses the home folder and a folder above it, and the API never hears of them (${homeAsk.status}, ${aboveAsk.status})`)
  const huge = await askSocket(socket, 'POST', '/folders/connect', { path: hidden, visibility: 'team', padding: 'x'.repeat(100_000) })
  check(huge.status === 413 && await count('select count(*) from connected_folders where path = $1', [hidden]) === 0,
    `an ask of the daemon larger than 64 KB is refused (${huge.status})`)
  await desk.reload()
  await list.waitFor({ timeout: SHOWS_MS })
  // Page code with no click behind it. Every query Playwright makes of a page counts as a click for 5 seconds, so this
  // asks from Electron's main process, which grants none, once the page shows no recent click.
  const inPage = (code: string) => app.evaluate(async ({ BrowserWindow }, js) => BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript(js, false), code)
  const noClick = await until('the page to show no recent click', 15, async () => await inPage('navigator.userActivation.isActive') === false)
  const unasked: unknown = await inPage(`window.agentsMac.connect(${JSON.stringify(hidden)}, 'team')`)
  check(noClick && JSON.stringify(unasked).includes('"status":403') && await count('select count(*) from connected_folders where path = $1', [hidden]) === 0,
    `the page's code can't connect a folder without the person's click: ${JSON.stringify(unasked)}`)
  const asPerson = async (login: string) => (await fetch(`${PEOPLE}/v1/instance/folders`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify({ path: hidden }),
  })).status
  const personStatuses = [await asPerson(owner), await asPerson(mate)]
  check(personStatuses.every((status) => status === 404) && await count('select count(*) from connected_folders where path = $1', [hidden]) === 0,
    `no API route lets a person connect a folder, its owner included (${personStatuses.join(', ')})`)
  const elsewhere = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Elsewhere</title><p>Another site.</p>') })
  servers.push(elsewhere)
  await new Promise<void>((resolve, reject) => { elsewhere.once('error', reject).listen(ELSEWHERE_PORT, '127.0.0.1', () => { resolve() }) })
  await desk.goto(`http://127.0.0.1:${ELSEWHERE_PORT}/`)
  const foreign: unknown = await desk.evaluate(async () => {
    const bridge = Reflect.get(window, 'agentsMac')
    return bridge ? [await bridge.list(), await bridge.connect('/', 'team')] : 'no bridge'
  })
  check(Array.isArray(foreign) && foreign.every((answer) => JSON.stringify(answer).includes('"status":403')) && !JSON.stringify(foreign).includes(hiddenName),
    `a page the window was sent to on another site gets only refusals from the bridge: ${JSON.stringify(foreign).slice(0, 200)}`)
  await desk.goto(`${INSECURE}/#/folders`)
  await list.waitFor({ timeout: SHOWS_MS })

  // A browser lists the person's connected folders, read only, and says where to change them.
  const engines = { chromium, firefox, webkit }
  for (const [engine, type] of Object.entries(engines)) {
    const browser = await type.launch(engine === 'chromium' ? { args: [`--host-resolver-rules=MAP ${INSECURE_HOST} 127.0.0.1`] }
      : engine === 'firefox' ? { firefoxUserPrefs: { 'network.dns.localDomains': INSECURE_HOST } } : {})
    try {
      for (const [width, viewport] of Object.entries({ desktop: { width: 1280, height: 820 }, phone: { width: 390, height: 844 } })) {
        const context = await browser.newContext({ baseURL: engine === 'webkit' ? PEOPLE : INSECURE, extraHTTPHeaders: { 'tailscale-user-login': owner }, viewport })
        const page: Page = await context.newPage()
        await page.goto('/#/folders')
        const connected = page.getByRole('list', { name: 'Your connected folders' })
        let text = ''
        const shows = () => text.includes('diary') && text.includes(`Just me · mac-${id}`) && text.includes(remoteName) && text.includes(`Team · other-mac-${id}`)
        await until(`the connected folders in ${engine}`, 30, async () => {
          text = await connected.innerText({ timeout: 1000 }).catch(() => '')
          return shows()
        })
        const listed = shows() && !text.includes('shop')
        const told = await page.getByText('open the Agents app on the Mac it is on').isVisible()
        const controls = await page.getByRole('group', { name: /^Who sees sessions from/ }).count()
        const content = await page.content()
        const fitsPhone = width !== 'phone' || await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth
          && [...document.querySelectorAll('.page-head, .page-body, .folder-list > li')].every((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= window.innerWidth + 1))
        const axe = await new AxeBuilder({ page }).analyze()
        const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)
        await page.screenshot({ path: join(SHOTS, `step21c-${engine}-${width}.png`) })
        check(listed && told && controls === 0 && !content.includes(hiddenName) && fitsPhone && !serious.length,
          `in ${engine} at ${width} width the page lists your connected folders read only and says to open the app on your Mac `
          + `(listed ${listed ? 'yes' : JSON.stringify(text.replace(/\s+/g, ' '))}, told ${String(told)}, ${controls} controls, fits ${String(fitsPhone)}, axe ${serious.join(' ') || 'clean'})`)
        await context.close()
      }
    } finally {
      await browser.close()
    }
  }

  // A daemon that crashes leaves its socket's file behind. The page says it can't reach the daemon, and a daemon
  // started again replaces the file and answers.
  daemon.kill('SIGKILL')
  await until('the daemon to stop', STOP_SEC, async () => daemon.exitCode !== null || daemon.signalCode !== null)
  const leftBehind = existsSync(socket)
  await desk.reload()
  const alert = await desk.locator('main').getByRole('alert').innerText({ timeout: SHOWS_MS }).catch(() => '')
  check(leftBehind && alert.includes("This Mac's folders can't be listed") && alert.includes("can't reach this Mac's daemon"),
    `with the daemon gone the page says it can't reach it: ${alert}`)
  daemon = run('daemon', 'daemon/agentsd.ts', daemonEnv)
  const answers = await until('the socket to answer again', 30, async () => (await askSocket(socket, 'GET', '/folders')).status === 200)
  await desk.reload()
  check(answers && await list.waitFor({ timeout: SHOWS_MS }).then(() => true, () => false),
    'a daemon started again after a crash replaces the socket the crash left, and the page lists the folders again')

  // A socket path macOS would cut short is reported, not served where the app would never look. This daemon's API is a
  // port nothing listens on, so it does nothing else.
  const longHome = join(agentsHome, 'h'.repeat(90))
  mkdirSync(longHome)
  const longDaemon = run('long-daemon', 'daemon/agentsd.ts', { ...daemonEnv, AGENTS_HOME: longHome, AGENTS_API: 'http://127.0.0.1:9' })
  const longSaid = await until('the daemon with a long home to say why', 15, async () =>
    logs.filter((l) => l.startsWith('long-daemon: ')).map((l) => l.slice('long-daemon: '.length)).join('').includes('longer than the 103 bytes macOS allows'))
  longDaemon.kill('SIGTERM')
  check(longSaid && !existsSync(join(longHome, 'run')), 'a daemon whose socket path would pass the 103 bytes macOS keeps says so, and serves no socket')

  // With the team's server down, the page keeps its list and says why it may be out of date. The page reads again every 10 seconds.
  api.kill('SIGTERM')
  await until('the API to stop', STOP_SEC, async () => api.exitCode !== null || api.signalCode !== null)
  const stale = await until('the page to say the server is down', 30, async () =>
    (await desk.locator('main').getByRole('alert').innerText({ timeout: 1000 }).catch(() => '')).includes("The team's server did not answer"))
  check(stale && await list.isVisible(), "with the team's server down the page keeps its list and says the server did not answer")

  // Nothing about a folder that was never connected left the Mac: no table in Postgres holds its name, and neither does the API's log.
  const unconnected = [hiddenName, goneName, tempName]
  const tables: string[] = (await db.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)).rows.map((r) => r.table_name)
  const holding: string[] = []
  for (const table of tables) {
    const n = await count(`select count(*) from "${table.replaceAll('"', '""')}" t where t::text like any($1)`, [unconnected.map((name) => `%${name}%`)])
    if (n) holding.push(`${table} ${n}`)
  }
  const apiLog = logs.filter((l) => l.startsWith('api: ')).join('')
  check(tables.length > 20 && !holding.length && !unconnected.some((name) => apiLog.includes(name)),
    `the names of folders never connected are in none of Postgres's ${tables.length} tables and not in the API's log${holding.length ? `: ${holding.join(', ')}` : ''}`)
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${messageOf(error)}`)
} finally {
  await desktop?.close().catch((error: unknown) => { console.error(`closing the desktop app: ${messageOf(error)}`) })
  const stopped = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null
  for (const child of children) child.kill('SIGTERM')
  for (const server of servers) server.close()
  if (!await until('the API and daemon to stop', STOP_SEC, async () => children.every(stopped))) for (const child of children) child.kill('SIGKILL')
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team])
      .catch((error: unknown) => { console.error(`removing the test team: ${messageOf(error)}`) })
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  } else {
    console.log(`\nthe daemon and API said:\n${logs.join('').split('\n').slice(-60).join('\n')}`)
  }
  await db.end()
}

console.log(`\n${failures.length ? `${failures.length} failed (test team ${team} kept for inspection)` : 'all passed (test team removed)'} in ${Math.round((Date.now() - started) / 1000)} s`)
process.exit(failures.length ? 1 : 0)
