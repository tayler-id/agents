// Agent computers, step 15b, the app. Drives the Screen view, the session
// panel's Screen button and an image document in Chromium, Firefox and WebKit,
// against a real API and a real box built from box/Dockerfile with the stand-in
// for Claude. A person opens a task running in the box and watches its screen
// live, takes over, types into the box's page, and hands it back, while a
// teammate watching sees who has it. Measures the time from a key press in the
// browser to the changed pixels on its screen. Opens a screenshot the agent
// saved. Scans for accessibility problems and takes screenshots (light, dark,
// phone) to look at.
// The box reaches this check's API only on 7701, the machine port the box
// firewall opens for checks, so run it holding ~/.agents-app/checks/run.lock.
//   node --env-file=.env --env-file=.env.test test/step15b.ts
//   AGENTS_UI_ENGINES=chromium node --env-file=.env --env-file=.env.test test/step15b.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium, firefox, webkit, type BrowserType, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import pg from 'pg'
import { must } from './must.ts'
import { ROOT, MACHINE_PORT, SCREEN, SQUARE, INPUT, PAGE_URL, within, tryDocker, boxCheckEnv, computerTools, pageSays, stopAll } from './computers.ts'

const SHOTS = join(ROOT, 'test', 'ui-shots')
const PEOPLE_PORT = 7982
const STREAMS_PORT = 7983
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
const team = `comp-ui-${id}`
const alice = `alice-compui-${id}@local`
const bob = `bob-compui-${id}@local`
const boxName = `box-${id}`
const work = join(homedir(), '.agents-app', 'checks', `comp-ui-${id}`)
const LATENCY_TRIALS = 10
// The longest a key press may take to show before the check calls the path broken.
const LATENCY_LIMIT_MS = 1000
// How long one F2 press may take to change the square before its trial gives up.
const KEY_SHOWS_MS = 3000

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []
const closers: (() => Promise<void>)[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
const checkEnv = boxCheckEnv(team, work, PEOPLE_PORT, STREAMS_PORT)
const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', '--env-file=.env.test', ...args],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...checkEnv } })

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

// The color of one of the box's pixels as the Screen view's canvas shows it,
// in the box's own coordinates.
const screenPixel = (page: Page, x: number, y: number) => page.evaluate(([px, py]) => {
  const canvas = document.querySelector('.screen canvas')
  if (!(canvas instanceof HTMLCanvasElement)) return null
  const data = canvas.getContext('2d')?.getImageData(px, py, 1, 1).data
  return data ? [data[0], data[1], data[2]] : null
}, [x, y] as const)

// Where on the page a point of the box's screen is drawn, scaled to fit.
async function onPage(page: Page, x: number, y: number) {
  const box = must(await page.locator('.screen canvas').boundingBox(), 'the screen canvas')
  return { x: box.x + (x * box.width) / SCREEN.width, y: box.y + (y * box.height) / SCREEN.height }
}

async function runEngine(engine: string, taskId: string, sessionId: string, instanceId: string, imageId: string, tools: Awaited<ReturnType<typeof computerTools>>['client']) {
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const errors: string[] = []
  const open = async (login: string, path: string, options: Record<string, unknown> = {}) => {
    const context = await browser.newContext({ baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': login }, viewport: { width: 1440, height: 900 }, ...options })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(`${login}: ${error.message}`))
    await page.goto(path)
    return page
  }
  try {
    // Alice opens the task, and its screen beside it.
    const page = await open(alice, `/#/t/${taskId}`)
    check(await visible(page, '.page-head h1', 20, /Check the page/), `${engine}: the task opens`)
    await page.getByRole('button', { name: 'Screen', exact: true }).click()
    check(await visible(page, '.screen-status', 30, /The agent has the screen/) && await visible(page, '.screen canvas', 5),
      `${engine}: the task's Screen view connects and says the agent has the screen`)
    // The page starts below the box browser's toolbar. The black square says where.
    const toolbar = await (async () => {
      for (let y = 0; y < SCREEN.height; y++) {
        const pixel = await screenPixel(page, SQUARE.left + SQUARE.size / 2, y)
        if (pixel && pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0) return y - SQUARE.top
      }
      return -1
    })()
    check(toolbar > 0, `${engine}: the Screen view draws the box's screen, its page and all (toolbar ${toolbar} px)`)
    await page.screenshot({ path: join(SHOTS, `${engine}-screen-light.png`) })
    check(await serious(page) === 0, `${engine}: the Screen view has no serious accessibility problems`)

    // Bob watches too.
    const bobPage = await open(bob, `/#/t/${taskId}/screen/${instanceId}/${sessionId}`)
    check(await visible(bobPage, '.screen-status', 30, /The agent has the screen/), `${engine}: a teammate opening the screen's link watches it too`)

    // Alice takes over and types into the box's page through her view.
    await page.getByRole('button', { name: 'Take over' }).click()
    check(await visible(page, '.screen-status', 15, /You have the screen/) && await visible(page, 'button', 5, /^Hand back$/),
      `${engine}: taking over says she has the screen and offers to hand it back`)
    check(await visible(bobPage, '.screen-status', 15, new RegExp(`${alice.replace(/[.@]/g, '\\$&')} has the screen`)),
      `${engine}: the teammate sees who has the screen`)
    const field = await onPage(page, INPUT.left + INPUT.width / 2, toolbar + INPUT.top + INPUT.height / 2)
    await page.mouse.click(field.x, field.y)
    // Control, not the Mac's Command: the box runs Linux.
    await page.keyboard.press('Control+a')
    await page.keyboard.type(`from ${engine}`)
    await page.screenshot({ path: join(SHOTS, `${engine}-screen-holding-light.png`) })

    // Key press to pixels, measured in the page: F2 toggles the box's square.
    const square = { x: SQUARE.left + SQUARE.size / 2, y: toolbar + SQUARE.top + SQUARE.size / 2 }
    const latencies: number[] = []
    for (let i = 0; i < LATENCY_TRIALS; i++) {
      // The page starts watching the square before the key goes out, and writes
      // on the body how long the change took to show, or -1 if it never did.
      await page.evaluate(([x, y, limit]) => {
        delete document.body.dataset.latency
        const canvas = document.querySelector('.screen canvas')
        const context = canvas instanceof HTMLCanvasElement ? canvas.getContext('2d') : null
        if (!context) throw new Error('the Screen view has no canvas to read')
        const red = () => context.getImageData(x, y, 1, 1).data[0]
        const before = red()
        let pressed = 0
        window.addEventListener('keydown', () => { pressed = performance.now() }, { once: true, capture: true })
        const deadline = performance.now() + limit
        const look = () => {
          if (pressed && red() !== before) document.body.dataset.latency = String(performance.now() - pressed)
          else if (performance.now() > deadline) document.body.dataset.latency = '-1'
          else requestAnimationFrame(look)
        }
        look()
      }, [square.x, square.y, KEY_SHOWS_MS] as const)
      await page.keyboard.press('F2')
      const shownIn = await page.waitForFunction(() => document.body.dataset.latency)
      latencies.push(Number(await shownIn.jsonValue()))
    }
    const shown = latencies.filter((ms) => ms >= 0).sort((a, b) => a - b)
    const median = shown[Math.floor(shown.length / 2)] ?? Infinity
    console.log(`      ${engine}: key press to pixels on the page: median ${median.toFixed(0)} ms, slowest ${(shown.at(-1) ?? Infinity).toFixed(0)} ms, ${shown.length} of ${LATENCY_TRIALS} shown`)
    check(shown.length === LATENCY_TRIALS && median < LATENCY_LIMIT_MS, `${engine}: each key press shows on her screen, the median within ${LATENCY_LIMIT_MS} ms`)

    // Alice hands back. Both views say the agent has it.
    await page.getByRole('button', { name: 'Hand back' }).click()
    check(await visible(page, '.screen-status', 15, /The agent has the screen/) && await visible(bobPage, '.screen-status', 15, /The agent has the screen/),
      `${engine}: handing back gives the screen to the agent in both views`)
    // The agent's browser tools read the page again now that it has the screen back.
    const typed = await pageSays(tools)
    check(typed.endsWith(`from ${engine}`), `${engine}: her clicks and keys reached the box's page while she held it (${typed})`)

    // The session panel opens the same screen.
    await page.getByRole('button', { name: 'Hide screen' }).click()
    await page.getByRole('button', { name: 'Session details' }).click()
    check(await visible(page, 'aside.panel .event', 15, /took over the screen/), `${engine}: the session panel shows the takeover in the record`)
    await page.locator('aside.panel').getByRole('button', { name: 'Screen', exact: true }).click()
    check(await visible(page, '.screen-status', 30, /The agent has the screen/), `${engine}: the session panel's Screen button opens the screen`)

    // The screenshot the agent saved, as an image document.
    await page.goto(`/#/t/${taskId}`)
    await page.locator('.artifacts').getByRole('button', { name: 'agents-check-page.png' }).click()
    check(await visible(page, 'aside.panel img.document-image', 15) && await page.locator('aside.panel img.document-image')
      .evaluate((img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth === 1280), `${engine}: the saved screenshot opens as an image document`)
    await page.screenshot({ path: join(SHOTS, `${engine}-image-document-light.png`) })
    check(await serious(page) === 0, `${engine}: the image document has no serious accessibility problems`)

    // Dark, and a phone.
    const dark = await open(alice, `/#/t/${taskId}/screen/${instanceId}/${sessionId}`, { colorScheme: 'dark' })
    await visible(dark, '.screen-status', 30, /The agent has the screen/)
    await dark.screenshot({ path: join(SHOTS, `${engine}-screen-dark.png`) })
    const phone = await open(alice, `/#/t/${taskId}/screen/${instanceId}/${sessionId}`, { viewport: { width: 390, height: 844 }, isMobile: engine !== 'firefox', hasTouch: engine !== 'firefox' })
    const phoneLive = await visible(phone, '.screen-status', 30, /The agent has the screen/)
    const phoneFits = await noSideScroll(phone, ['.screen-panel', '.screen', '.panel-head'])
    await phone.screenshot({ path: join(SHOTS, `${engine}-screen-phone.png`) })
    await phone.goto(`/#/t/${taskId}/d/${imageId}`)
    const phoneImage = await visible(phone, 'aside.panel img.document-image', 15)
    const imageFits = await noSideScroll(phone, ['aside.panel', 'img.document-image'])
    await phone.screenshot({ path: join(SHOTS, `${engine}-image-document-phone.png`) })
    check(phoneLive && phoneFits && phoneImage && imageFits, `${engine}: at phone width the screen and the image fit without sideways scrolling`)

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
  node('server/admin.ts', 'add-person', team, bob)
  node('server/boxes.ts', 'build')
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  children.push(spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, ...checkEnv },
  }))
  await within(20, () => fetch(API).then(() => true, () => false))
  const { instanceId } = JSON.parse(node('server/boxes.ts', 'create', team, boxName))
  const container = `agents-box-${instanceId}`
  node('server/admin.ts', 'add-agent', team, 'tester', boxName)
  const { id: teamId } = must(await one('select id from teams where name = $1', [team]), 'team')
  const screenUp = await within(120, async () => (await one('select screen_width from instances where id = $1 and status = $2', [instanceId, 'online']))?.screen_width === SCREEN.width)
  if (!screenUp) throw new Error('the box never reported a screen, so the Screen view has nothing to show')

  // A task in the box. Its agent puts the check page on screen and saves a screenshot of it.
  const agentId = must(await one('select id from agents where team_id = $1 and name = $2', [teamId, 'tester']), 'agent').id
  const res = await fetch(`${PEOPLE}/v1/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': alice },
    body: JSON.stringify({ title: 'Check the page', instructions: 'Look at it.', agentId }),
  })
  const created = await res.json()
  const taskId: string = must(created?.taskId, 'the task')
  const sessionId: string = must(created?.sessionId, 'the task session')
  await within(120, async () => (await one('select status from sessions where id = $1', [sessionId]))?.status === 'idle')
  const workspace = must(await one('select w.path from workspaces w join sessions s on s.workspace_id = w.id where s.id = $1', [sessionId]), 'workspace').path as string
  const { client: tools } = await computerTools(container, sessionId, workspace)
  closers.push(() => tools.close())
  await tools.callTool({ name: 'browser_navigate', arguments: { url: PAGE_URL } })
  await tools.callTool({ name: 'save_screenshot', arguments: { name: 'agents-check-page' } })
  await fetch(`${PEOPLE}/v1/sessions/${sessionId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': alice }, body: JSON.stringify({ text: 'Done looking?' }),
  })
  await within(60, () => one(`select 1 from artifacts where task_id = $1 and path = 'checks/agents-check-page.png'`, [taskId]))
  const imageId = must(await one(`select id from artifacts where task_id = $1 and path = 'checks/agents-check-page.png'`, [taskId]), 'image document').id as string

  for (const engine of engines) await runEngine(engine, taskId, sessionId, instanceId, imageId, tools)
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack ?? ''}`)
} finally {
  for (const close of closers) await close().catch(() => undefined)
  await stopAll(children)
  // Boxes are removed whatever happened, or they would keep calling a closed port.
  const boxes = await db.query(`select i.id from instances i join teams t on t.id = i.team_id where t.name = $1 and i.kind = 'box'`, [team]).catch(() => ({ rows: [] }))
  for (const { id: boxId } of boxes.rows) {
    tryDocker('rm', '-f', `agents-box-${boxId}`)
    tryDocker('volume', 'rm', `agents-box-${boxId}-home`)
  }
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
    rmSync(work, { recursive: true, force: true })
  }
  await db.end().catch(() => undefined)
}

console.log(`\nscreenshots in test/ui-shots\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test team and box removed)'}`)
process.exit(failures.length ? 1 : 0)
