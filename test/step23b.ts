// Step 23b, the app, for the door. Drives the conversation and task views in
// Chromium, Firefox and WebKit, at desktop and phone width, against a real API
// and runner with no machine that can answer. A person's own box cannot start,
// since its image does not exist, so a turn for its agent waits, and the
// conversation says "Starting your computer" with Docker's words and a Cancel
// button. A teammate reads whose computer it is, a box nobody holds reads as
// offline, a task's page says why its session waits, and a turn gone quiet says
// since when. Cancelling a waiting turn takes its line away and cancels the turn.
// Scans for accessibility problems and takes screenshots to look at.
//   node --env-file=.env --env-file=.env.test test/step23b.ts
//   AGENTS_UI_ENGINES=chromium node --env-file=.env --env-file=.env.test test/step23b.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, firefox, webkit, type BrowserType, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import pg from 'pg'
import { must } from './must.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
const SHOTS = join(ROOT, 'test', 'ui-shots')
// No other check uses these ports, since a check that needs no run lock runs beside the one that holds it.
const PORT = 8150
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 100}`
const INSECURE = `http://agents.test:${PORT + 100}`
const ORIGINS: Record<string, string> = { chromium: INSECURE, firefox: INSECURE, webkit: PEOPLE }
const LAUNCH: Record<string, Record<string, unknown>> = {
  chromium: { args: ['--host-resolver-rules=MAP agents.test 127.0.0.1'] },
  firefox: { firefoxUserPrefs: { 'network.dns.localDomains': 'agents.test' } },
  webkit: {},
}
const ENGINES: Record<string, BrowserType> = { chromium, webkit, firefox }
const engines = (process.env.AGENTS_UI_ENGINES ?? 'chromium,webkit,firefox').split(',')
const WIDTHS = { desktop: { width: 1280, height: 820 }, phone: { width: 390, height: 844 } } as const
const id = randomBytes(4).toString('hex')
const team = `door-23b-${id}`
const admin = `admin23b-${id}@local`
// A box image that does not exist, and Docker told not to look for it elsewhere, so every
// start fails at once with Docker's own words, and a person's box never comes up.
const MISSING_IMAGE = `agents-box:door-23b-${id}`

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T | undefined

async function within(seconds: number, test: () => Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(300)
  }
  return false
}

async function visible(page: Page, selector: string, seconds: number, text?: RegExp): Promise<boolean> {
  const locator = text ? page.locator(selector, { hasText: text }) : page.locator(selector)
  return locator.first().waitFor({ state: 'visible', timeout: seconds * 1000 }).then(() => true, () => false)
}

async function serious(page: Page) {
  const axe = await new AxeBuilder({ page }).analyze()
  const found = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  for (const v of found) console.log(`      ${v.id}: ${v.help} (${v.nodes.length}) ${JSON.stringify(v.nodes[0]?.target)}`)
  return found.length
}

async function noSideScroll(page: Page, selectors: string[]) {
  return page.evaluate((list) => document.documentElement.scrollWidth <= window.innerWidth
    && list.every((selector) => {
      const el = document.querySelector(selector)
      return !el || el.getBoundingClientRect().right <= window.innerWidth + 1
    }), selectors)
}

// A change a person makes, through the people port, as the app does.
async function post(login: string, path: string, body: unknown = {}) {
  const res = await fetch(PEOPLE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify(body) })
  const json: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${path} as ${login}: ${res.status} ${JSON.stringify(json)}`)
  return json as Record<string, string>
}

type Scene = {
  alice: string; bob: string; boxName: string; parkedName: string; aliceDm: string; idlerDm: string; bobDm: string; taskId: string; courierDm: string
}

// What each engine's people have to look at: Alice's own box that cannot start with an
// agent on it, a DM and a task waiting for it, a teammate's DM with the same agent, a
// box nobody holds with an agent on it, and a Mac whose turn has gone quiet.
async function scene(engine: string): Promise<Scene> {
  const [alice, bob] = [`alice23b-${engine}-${id}@local`, `bob23b-${engine}-${id}@local`]
  const { instanceId } = await post(alice, '/v1/me/box')
  const boxName = must(await one<{ name: string }>('select name from instances where id = $1', [instanceId]), 'the box').name
  const parkedName = `parked-${engine}-${id}`
  node('server/admin.ts', 'add-instance', team, parkedName, 'box', alice)
  const macName = `mac-${engine}-${id}`
  node('server/admin.ts', 'add-instance', team, macName, 'mac', alice)
  node('server/admin.ts', 'add-agent', team, `scout-${engine}`, boxName)
  node('server/admin.ts', 'add-agent', team, `idler-${engine}`, parkedName)
  node('server/admin.ts', 'add-agent', team, `courier-${engine}`, macName)
  const dm = async (login: string, agent: string, text: string) => {
    const { conversationId } = await post(login, '/v1/conversations', { kind: 'dm', agent })
    await post(login, `/v1/conversations/${conversationId}/messages`, { text })
    return String(conversationId)
  }
  const aliceDm = await dm(alice, `scout-${engine}`, 'Are you there?')
  const idlerDm = await dm(alice, `idler-${engine}`, 'Anyone home?')
  const bobDm = await dm(bob, `scout-${engine}`, 'Hello from Bob.')
  const courierDm = await dm(alice, `courier-${engine}`, 'Where are you?')
  const agentId = must(await one<{ id: string }>(`select id from agents where team_id = (select id from teams where name = $1) and name = $2`, [team, `scout-${engine}`]), 'scout').id
  const { taskId } = await post(alice, '/v1/tasks', { title: `Check the build ${engine}`, instructions: 'Look at it.', agentId })
  // The Mac's turn went to its queue at once. Here it has been running, and quiet since long ago.
  await db.query(`update turns set status = 'running', started_at = now() - interval '25 minutes', stuck_since = now() - interval '12 minutes' where conversation_id = $1`, [courierDm])
  await db.query(`update events set created_at = now() - interval '15 minutes' where session_id in (select session_id from turns where conversation_id = $1)`, [courierDm])
  return { alice, bob, boxName, parkedName, aliceDm, idlerDm, bobDm, taskId: String(taskId), courierDm }
}

async function run(engine: string, s: Scene) {
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const errors: string[] = []
  const open = async (login: string, width: keyof typeof WIDTHS, hash: string) => {
    const phone = width === 'phone'
    const context = await browser.newContext({
      baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': login }, viewport: WIDTHS[width],
      ...(phone ? { isMobile: engine !== 'firefox', hasTouch: engine !== 'firefox' } : {}),
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/#/${hash}`)
    return page
  }
  const shot = (page: Page, name: string, width: string) => page.screenshot({ path: join(SHOTS, `${engine}-${width}-${name}.png`) })
  try {
    for (const width of ['desktop', 'phone'] as const) {
      // Alice's own box cannot start. The line says so, with Docker's words and a way to cancel.
      const page = await open(s.alice, width, `c/${s.aliceDm}`)
      const line = page.getByTestId('turn-wait')
      check(await visible(page, '[data-testid="turn-wait"]', 30, /Starting your computer/), `${engine} ${width}: a DM to an agent on a box that cannot start says "Starting your computer"`)
      check(await visible(page, '[data-testid="turn-wait"]', 60, /Docker said: .*No such image/), `${engine} ${width}: the line gives Docker's words when the box could not start`)
      check(await line.getByRole('button', { name: 'Cancel' }).isVisible(), `${engine} ${width}: the line has a Cancel button`)
      await shot(page, 'dm-starting', width)
      if (width === 'phone') check(await noSideScroll(page, ['.page-head', '.page-body', '.composer', '[data-testid="turn-wait"]']), `${engine} phone: the waiting line fits without sideways scrolling`)
      if (width === 'desktop') check(await serious(page) === 0, `${engine} desktop: the conversation has no serious accessibility problems`)

      // A box nobody holds is offline, and the line says which.
      const parked = await open(s.alice, width, `c/${s.idlerDm}`)
      check(await visible(parked, '[data-testid="turn-wait"]', 30, new RegExp(`Waiting for ${s.parkedName}, which is offline`)), `${engine} ${width}: a DM to an agent on a box nobody holds says which box is offline`)
      await shot(parked, 'dm-offline', width)

      // A teammate sees whose computer it is.
      const teammate = await open(s.bob, width, `c/${s.bobDm}`)
      check(await visible(teammate, '[data-testid="turn-wait"]', 30, new RegExp(`Starting ${s.alice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'s computer`)), `${engine} ${width}: a teammate's DM names whose computer is starting`)
      await shot(teammate, 'dm-teammate', width)

      // A task's page says why its session waits, as a conversation does.
      const task = await open(s.alice, width, `t/${s.taskId}`)
      check(await visible(task, '.task-messages [data-testid="turn-wait"]', 30, /Starting your computer/), `${engine} ${width}: a task whose session waits for its computer says so on the task page`)
      await shot(task, 'task-starting', width)
      if (width === 'phone') check(await noSideScroll(task, ['.page-head', '.page-body', '.composer']), `${engine} phone: the task page fits without sideways scrolling`)
      if (width === 'desktop') check(await serious(task) === 0, `${engine} desktop: the task page has no serious accessibility problems`)

      // A turn that has gone quiet says since when it was last heard from.
      const quiet = await open(s.alice, width, `c/${s.courierDm}`)
      check(await visible(quiet, '[data-testid="turn-wait"]', 30, /No new step since .+\. It may be stuck\./), `${engine} ${width}: a turn gone quiet says since when it was last heard from`)
      await shot(quiet, 'dm-quiet', width)
    }

    // Cancelling takes the line away and cancels the turn, and nothing is sent after it.
    const page = await open(s.alice, 'desktop', `c/${s.aliceDm}`)
    await page.getByTestId('turn-wait').getByRole('button', { name: 'Cancel' }).click()
    check(await page.locator('[data-testid="turn-wait"]').first().waitFor({ state: 'detached', timeout: 20_000 }).then(() => true, () => false), `${engine}: cancelling a waiting turn takes its line away`)
    const cancelled = await within(10, async () => (await one<{ status: string }>('select status from turns where conversation_id = $1', [s.aliceDm]))?.status === 'cancelled')
    const commands = Number((await one<{ n: number }>(`select count(*)::int as n from commands c join sessions x on x.id = c.session_id where x.conversation_id = $1 and c.kind = 'message'`, [s.aliceDm]))?.n)
    check(cancelled && commands === 0, `${engine}: the cancelled turn is cancelled in the record, with no message command (${commands})`)
    check(errors.length === 0, `${engine}: no page errors${errors.length ? ` (${errors.join('; ')})` : ''}`)
  } finally {
    await browser.close()
  }
}

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  mkdirSync(SHOTS, { recursive: true })
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, admin)
  for (const engine of engines) {
    node('server/admin.ts', 'add-person', team, `alice23b-${engine}-${id}@local`)
    node('server/admin.ts', 'add-person', team, `bob23b-${engine}-${id}@local`)
  }
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step23b-')))
  writeFileSync(join(home, 'scenario.json'), JSON.stringify({ turns: [] }))
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  children.push(spawn(process.execPath, ['--env-file=.env', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'),
      AGENTS_STREAMS_PORT: String(PORT + 1), AGENTS_STREAMS_DIR: join(home, 'streams'),
      AGENTS_BOX_IMAGE: MISSING_IMAGE, AGENTS_BOX_DOCKER_ARGS: JSON.stringify(['--pull', 'never']),
      // No machine reports in here, so the watchdog would soon mark every session lost and write a notice, which ends a quiet turn's quiet.
      AGENTS_MACHINE_LOST_SEC: '3600',
    },
  }))
  await servePeople(PORT + 100, join(home, 'people.sock'))
  await within(20, () => fetch(API).then(() => true, () => false))
  const scenes = new Map<string, Scene>()
  for (const engine of engines) scenes.set(engine, await scene(engine))
  for (const engine of engines) await run(engine, must(scenes.get(engine), engine))
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack ?? ''}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
  await db.end().catch(() => undefined)
}

console.log(`\nscreenshots in test/ui-shots\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test team removed)'}`)
process.exit(failures.length ? 1 : 0)
