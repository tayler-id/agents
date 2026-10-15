// Seats in the app, step 15d. Drives a person's box page and the Screen view in
// Chromium, Firefox and WebKit, at desktop and phone width, against a real API
// and a real box built from box/Dockerfile with the stand-in for Claude. Two
// agents hold seats 1 and 2, as the scheduler will give them once it lands, and
// each shows a page of its own color. The box page lists the box's seats, who
// holds each, and which are ready. Each seat's Screen opens beside the page,
// names its seat and shows that seat's own screen, and a task's Screen button
// opens the seat its session runs on. Scans for accessibility problems and
// takes screenshots (light, dark, phone) to look at. The box image is built
// under a tag of the run's own and removed at the end.
// The box reaches this check's API only on 7701, the machine port the box
// firewall opens for checks, so run it holding ~/.agents-app/checks/run.lock.
//   node --env-file=.env --env-file=.env.test test/step15d.ts
//   AGENTS_UI_ENGINES=chromium node --env-file=.env --env-file=.env.test test/step15d.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import pg from 'pg'
import { must } from './must.ts'
import { ROOT, IMAGE, MACHINE_PORT, SCREEN, within, tryDocker, boxCheckEnv, peopleSocket, stopAll } from './computers.ts'
import { servePeople } from './people.ts'
import { IN_PAGE, isBlue, isRed, seatPage, seatTools } from './seats.ts'
import { AgentId } from '../shared/ids.ts'
import { InstanceId } from '../shared/onboarding.ts'
import { messageOf } from '../shared/errors.ts'

const SHOTS = join(ROOT, 'test', 'ui-shots')
const PEOPLE_PORT = 7986
const STREAMS_PORT = 7987
const API = `http://127.0.0.1:${MACHINE_PORT}`
const PEOPLE = `http://127.0.0.1:${PEOPLE_PORT}`
const INSECURE = `http://agents.test:${PEOPLE_PORT}`
// Chromium and Firefox load the app from a plain-HTTP name, as the tailnet serves it.
const ORIGINS: Record<string, string> = { chromium: INSECURE, firefox: INSECURE, webkit: PEOPLE }
const LAUNCH: Record<string, Record<string, unknown>> = {
  chromium: { args: ['--host-resolver-rules=MAP agents.test 127.0.0.1'] },
  firefox: { firefoxUserPrefs: { 'network.dns.localDomains': 'agents.test' } },
  webkit: {},
}
const ENGINES: Record<string, BrowserType> = { chromium, webkit, firefox }
const engines = (process.env.AGENTS_UI_ENGINES ?? 'chromium,webkit,firefox').split(',')
const id = randomBytes(4).toString('hex')
const team = `seats-ui-${id}`
const alice = `alice-seatsui-${id}@local`
const work = join(homedir(), '.agents-app', 'checks', `seats-ui-${id}`)
const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []
const closers: (() => Promise<void>)[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
const checkEnv = boxCheckEnv(team, work, STREAMS_PORT, [INSECURE, PEOPLE])
const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', '--env-file=.env.test', ...args],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...checkEnv } })

async function post(path: string, body: unknown = {}) {
  const res = await fetch(PEOPLE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': alice }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
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

// Measured against the page's own width. Under phone emulation Chromium widens
// window.innerWidth to fit content that overflows, so it can't show overflow.
async function noSideScroll(page: Page, selectors: string[]) {
  return page.evaluate((list) => {
    const width = document.documentElement.clientWidth
    return document.documentElement.scrollWidth <= width
      && list.every((selector) => {
        const el = document.querySelector(selector)
        return !el || el.getBoundingClientRect().right <= width + 1
      })
  }, selectors)
}

// The color the Screen view's canvas shows at a point of the box's screen, once
// it shows `wanted` there, or the last color it showed.
async function screenShows(page: Page, wanted: (rgb: number[]) => boolean): Promise<number[]> {
  let last: number[] = []
  await within(20, async () => {
    last = await page.evaluate(([x, y]) => {
      const canvas = document.querySelector('.screen canvas')
      if (!(canvas instanceof HTMLCanvasElement)) return []
      const data = canvas.getContext('2d')?.getImageData(x, y, 1, 1).data
      return data ? [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0] : []
    }, [IN_PAGE.x, IN_PAGE.y] as const)
    return wanted(last)
  })
  return last
}

async function openPage(browser: Browser, engine: string, errors: string[], path: string, options: Record<string, unknown> = {}) {
  const context = await browser.newContext({ baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': alice }, viewport: DESKTOP, ...options })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(path)
  return page
}

async function runEngine(engine: string, instanceId: string, writerTask: string) {
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const errors: string[] = []
  const phoneOptions = { viewport: PHONE, isMobile: engine !== 'firefox', hasTouch: engine !== 'firefox' }
  try {
    // The box page lists its seats and who holds each.
    const page = await openPage(browser, engine, errors, '/#/box')
    const rows = page.locator('ul.seats li')
    const listed = await within(20, async () => await rows.count() === 4)
    const texts = (await rows.allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim())
    check(listed && /^Seat 1 scout Ready Screen$/.test(texts[0] ?? '') && /^Seat 2 writer Ready Screen$/.test(texts[1] ?? '')
      && texts[2] === 'Seat 3 Free' && texts[3] === 'Seat 4 Free',
    `${engine}: the box page lists its 4 seats, who holds each and which are ready, with a Screen for each running one (${texts.join(' | ')})`)
    await page.screenshot({ path: join(SHOTS, `${engine}-seats-light.png`) })
    check(await serious(page) === 0, `${engine}: the seat list has no serious accessibility problems`)

    // Seat 2's Screen opens beside the page, names its seat and shows its own screen.
    await page.getByRole('button', { name: 'Screen of seat 2' }).click()
    const named = await visible(page, '.screen-panel .panel-head p', 20, /, seat 2 ·/)
    const live = await visible(page, '.screen-status', 30, /The agent has the screen/)
    const shows = await screenShows(page, isBlue)
    check(named && live && isBlue(shows), `${engine}: seat 2's Screen names seat 2 and shows seat 2's own page (${shows.join(',')})`)
    await page.screenshot({ path: join(SHOTS, `${engine}-seat-screen-light.png`) })
    check(await serious(page) === 0, `${engine}: a seat's Screen view on the box page has no serious accessibility problems`)
    // A view that never opened has no Close, which fails this line and lets the rest run.
    const closed = await page.getByRole('button', { name: 'Close' }).click({ timeout: 10_000 }).then(() => true, () => false)
    check(closed && await within(10, async () => new URL(page.url()).hash === '#/box'), `${engine}: closing the Screen goes back to the box page`)

    // A task's Screen opens the seat its session runs on.
    await page.goto(`/#/t/${writerTask}`)
    await page.getByRole('button', { name: 'Screen', exact: true }).click()
    const taskNamed = await visible(page, '.screen-panel .panel-head p', 30, /, seat 2 ·/)
    const taskShows = await screenShows(page, isBlue)
    check(taskNamed && isBlue(taskShows), `${engine}: a task's Screen opens the seat its session runs on (${taskShows.join(',')})`)

    // Dark, and seat 1's screen.
    const dark = await openPage(browser, engine, errors, `/#/box/screen/${instanceId}/1`, { colorScheme: 'dark' })
    const darkNamed = await visible(dark, '.screen-panel .panel-head p', 20, /, seat 1 ·/)
    const darkShows = await screenShows(dark, isRed)
    await dark.screenshot({ path: join(SHOTS, `${engine}-seat-screen-dark.png`) })
    check(darkNamed && isRed(darkShows), `${engine}: seat 1's Screen opened from its link names seat 1 and shows its own page (${darkShows.join(',')})`)

    // A phone, at the seat list and at a seat's Screen.
    const phone = await openPage(browser, engine, errors, '/#/box', phoneOptions)
    const phoneListed = await within(20, async () => await phone.locator('ul.seats li').count() === 4)
    const phoneFits = await noSideScroll(phone, ['.seats', '.page-body'])
    await phone.screenshot({ path: join(SHOTS, `${engine}-seats-phone.png`), fullPage: true })
    await phone.goto(`/#/box/screen/${instanceId}/2`)
    const phoneLive = await visible(phone, '.screen-status', 30, /The agent has the screen/)
    const screenFits = await noSideScroll(phone, ['.screen-panel', '.screen', '.panel-head'])
    await phone.screenshot({ path: join(SHOTS, `${engine}-seat-screen-phone.png`) })
    check(phoneListed && phoneFits && phoneLive && screenFits, `${engine}: at phone width the seat list and a seat's Screen fit without sideways scrolling `
      + `(list ${phoneListed}, fits ${phoneFits}; screen live ${phoneLive}, fits ${screenFits})`)

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
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'scenario.json'), JSON.stringify({ turns: [] }))
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, alice)
  const { takeSeat } = await import('../server/seats.ts')
  const { tx, pool } = await import('../server/db.ts')
  closers.push(() => pool.end())
  node('server/boxes.ts', 'build')
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  children.push(spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, ...checkEnv },
  }))
  // Stands in for tailscale serve, which sends people to the API's socket.
  await servePeople(PEOPLE_PORT, peopleSocket(work))
  await within(20, () => fetch(API).then(() => true, () => false))

  // Alice's own computer, and an agent in each of its first two seats.
  const instanceId: string = must((await post('/v1/me/box')).json?.instanceId, "alice's computer")
  const container = `agents-box-${instanceId}`
  const box = must(await one('select name, team_id from instances where id = $1', [instanceId]), 'the computer')
  const screenUp = await within(180, async () => (await one('select screen_width from instances where id = $1 and status = $2', [instanceId, 'online']))?.screen_width === SCREEN.width)
  if (!screenUp) throw new Error('the computer never reported a screen, so the Screen view has nothing to show')
  node('server/admin.ts', 'add-agent', team, 'scout', box.name)
  node('server/admin.ts', 'add-agent', team, 'writer', box.name)
  const agentIds = new Map((await db.query('select name, id from agents where team_id = $1', [box.team_id])).rows.map((r) => [String(r.name), String(r.id)]))
  for (const name of ['scout', 'writer']) await tx((client) => takeSeat(client, InstanceId.parse(instanceId), AgentId.parse(agentIds.get(name))))
  const ready = await within(90, async () => (await db.query(`select count(*)::int as n from seats where instance_id = $1 and status = 'ready'`, [instanceId])).rows[0]?.n === 2)
  if (!ready) throw new Error('the two seats never came up')

  // Each agent's task puts a page of its own color on its seat's screen.
  const startTask = async (name: string, color: string) => {
    const created = await post('/v1/tasks', { title: `Look with ${name}`, instructions: 'Look at it.', agentId: agentIds.get(name) })
    const sessionId: string = must(created.json?.sessionId, `${name}'s session`)
    await within(120, async () => (await one('select status from sessions where id = $1', [sessionId]))?.status === 'idle')
    const workspace = String(must(await one('select w.path from workspaces w join sessions s on s.workspace_id = w.id where s.id = $1', [sessionId]), 'workspace').path)
    const { client } = await seatTools(container, sessionId, workspace)
    closers.push(() => client.close())
    await client.callTool({ name: 'browser_navigate', arguments: { url: seatPage(`${name}'s page`, color) } })
    return String(must(created.json?.taskId, `${name}'s task`))
  }
  await startTask('scout', '#ff0000')
  const writerTask = await startTask('writer', '#0000ff')

  for (const engine of engines) await runEngine(engine, instanceId, writerTask)
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  for (const close of closers) await close().catch(() => undefined)
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

console.log(`\nscreenshots in test/ui-shots\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test team and box removed)'}`)
process.exit(failures.length ? 1 : 0)
