// Phase 1 step 4, the app. Drives the real UI in Chromium, WebKit and Firefox
// against a real API, daemon and Claude session. Two teammates use it at once.
// Takes screenshots (light, dark, phone) to look at, scans for accessibility
// problems, and fails on any page error.
//   npm run check:step4b                      all three engines
//   AGENTS_UI_ENGINES=chromium npm run check:step4b

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, firefox, webkit, type BrowserType, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import pg from 'pg'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
const SHOTS = join(ROOT, 'test', 'ui-shots')
const PORT = 7801
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 100}`
// Over the tailnet the app runs on plain HTTP, which browsers treat as insecure
// (no crypto.randomUUID, for one). Chromium and Firefox reach the test server by a
// non-local name to match. WebKit has no way to map a name, so it uses localhost.
const INSECURE = `http://agents.test:${PORT + 100}`
const ORIGINS: Record<string, string> = { chromium: INSECURE, firefox: INSECURE, webkit: PEOPLE }
const LAUNCH: Record<string, Record<string, unknown>> = {
  chromium: { args: ['--host-resolver-rules=MAP agents.test 127.0.0.1'] },
  firefox: { firefoxUserPrefs: { 'network.dns.localDomains': 'agents.test' } },
  webkit: {},
}
const id = randomBytes(4).toString('hex')
const team = `step4b-${id}`
const agentName = `helper-${id}`
const ENGINES: Record<string, BrowserType> = { chromium, webkit, firefox }
const engines = (process.env.AGENTS_UI_ENGINES ?? 'chromium,webkit,firefox').split(',')

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

function node(...args: string[]) {
  return execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
}

async function visible(page: Page, selector: string, seconds: number, text?: RegExp): Promise<boolean> {
  const locator = text ? page.locator(selector, { hasText: text }) : page.locator(selector)
  return locator.first().waitFor({ state: 'visible', timeout: seconds * 1000 }).then(() => true, () => false)
}

async function gone(page: Page, selector: string, seconds: number): Promise<boolean> {
  return page.locator(selector).first().waitFor({ state: 'detached', timeout: seconds * 1000 }).then(() => true, () => false)
}

async function run(engine: string, folder: string) {
  const alice = `alice-${engine}-${id}@local`
  const amir = `amir-${engine}-${id}@local`
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const errors: string[] = []
  const open = async (login: string, options: Record<string, unknown> = {}) => {
    const context = await browser.newContext({ baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': login }, viewport: { width: 1280, height: 820 }, ...options })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(`${login}: ${error.message}`))
    await page.goto('/')
    return page
  }
  try {
    const page = await open(alice)
    check(await visible(page, '.team strong', 15, new RegExp(team)), `${engine}: the app opens on your team`)
    const secure = await page.evaluate(() => window.isSecureContext)
    check(engine === 'webkit' || !secure, `${engine}: runs as an insecure page, as it does over the tailnet`)
    check(await visible(page, '.list li', 15, new RegExp(`mac-${id}.*online`)), `${engine}: the machine shows as online`)

    await page.getByRole('list', { name: 'Agents' }).getByRole('button', { name: agentName, exact: true }).click()
    check(await visible(page, '.conversation-head h1', 15, new RegExp(agentName)), `${engine}: clicking an agent opens a DM with it`)

    const file = `ui-${engine}.txt`
    await page.getByRole('textbox', { name: 'Message' }).fill(`Run: echo ui > ${file}`)
    await page.getByRole('textbox', { name: 'Message' }).press('Enter')
    const asked = await visible(page, 'section.ask-card', 120)
    check(asked && await visible(page, 'section.ask-card pre', 5, new RegExp(file)), `${engine}: the agent's request shows as an ask card with the command`)
    await page.screenshot({ path: join(SHOTS, `${engine}-ask-light.png`) })
    await page.getByRole('button', { name: 'Allow once' }).click()
    const replied = await visible(page, 'li.message.agent:not(.typing)', 120)
    check(replied && await gone(page, 'section.ask-card', 10) && existsSync(join(folder, file)),
      `${engine}: allowing it from the card runs the command, and the reply appears`)

    // A teammate watches the same conversation live.
    const teammate = await open(amir)
    const shared = teammate.locator('.list button', { hasText: new RegExp(`${agentName} · ${alice.replace(/[.@]/g, '\\$&')}`) })
    check(await shared.first().waitFor({ timeout: 15000 }).then(() => true, () => false), `${engine}: a teammate sees the conversation in their list`)
    await shared.first().click()
    const readable = await visible(teammate, 'li.message', 15, /echo ui/)
    if (!readable) {
      await teammate.screenshot({ path: join(SHOTS, `${engine}-teammate-failed.png`) })
      console.log(`      teammate sees: ${JSON.stringify((await teammate.locator('main').innerText()).slice(0, 400))}`)
    }
    check(readable, `${engine}: the teammate can open it and read it`)
    await page.getByRole('textbox', { name: 'Message' }).fill('Thanks, that worked.')
    await page.getByRole('textbox', { name: 'Message' }).press('Enter')
    check(await visible(teammate, 'li.message', 30, /Thanks, that worked/), `${engine}: the teammate sees a new message arrive without reloading`)
    await visible(page, 'li.message.agent:not(.typing)', 120)
    await gone(page, 'li.message.typing', 120)

    // Live typing, then interrupt.
    await page.getByRole('textbox', { name: 'Message' }).fill('Write a 2000-word story about a lighthouse keeper. Do not use any tools.')
    await page.getByRole('textbox', { name: 'Message' }).press('Enter')
    const typing = await visible(page, '[data-testid="live-text"]', 120)
    const lengths: number[] = []
    for (let i = 0; typing && i < 20; i++) {
      lengths.push((await page.locator('[data-testid="live-text"]').textContent().catch(() => ''))?.length ?? 0)
      if (lengths.length > 1 && (lengths.at(-1) ?? 0) > (lengths[0] ?? 0)) break
      await sleep(250)
    }
    if (!((lengths.at(-1) ?? 0) > (lengths[0] ?? 0))) console.log(`      live text lengths: ${lengths.join(', ')}`)
    check(typing && (lengths.at(-1) ?? 0) > (lengths[0] ?? 0), `${engine}: the reply streams in as the agent types it`)
    await page.screenshot({ path: join(SHOTS, `${engine}-typing-light.png`) })
    await page.getByRole('button', { name: 'Interrupt' }).click()
    const stopped = await gone(page, 'li.message.typing', 20)
    // The turn must have been cut short, not merely finished on its own.
    const { rows: [lastTurn] } = await db.query(
      `select e.body->>'terminal_reason' as reason from events e join sessions s on s.id = e.session_id
       join conversation_members m on m.conversation_id = s.conversation_id
       join people p on p.id = m.person_id and p.login = $1
       where e.kind = 'usage' order by e.created_at desc limit 1`, [alice])
    check(stopped && lastTurn?.reason === 'aborted_streaming', `${engine}: interrupt stops the agent within seconds`)

    await page.getByRole('button', { name: 'Session details' }).click()
    check(await visible(page, 'aside.panel .event', 15, /Tool · Bash/), `${engine}: the session panel shows what the agent did`)
    await page.screenshot({ path: join(SHOTS, `${engine}-session-light.png`) })

    const axe = await new AxeBuilder({ page }).analyze()
    const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    for (const v of serious) console.log(`      ${v.id}: ${v.help} (${v.nodes.length})`)
    check(serious.length === 0, `${engine}: no serious accessibility problems`)

    // The conversation itself, without the session panel, for the dark and phone views.
    const conversationUrl = page.url().replace(/\/s\/[^/]+$/, '')
    const dark = await open(alice, { colorScheme: 'dark' })
    await dark.goto(conversationUrl)
    await visible(dark, 'li.message', 15)
    await dark.screenshot({ path: join(SHOTS, `${engine}-conversation-dark.png`) })
    const phone = await open(alice, { viewport: { width: 390, height: 844 }, isMobile: engine !== 'firefox', hasTouch: engine !== 'firefox' })
    await phone.goto(conversationUrl)
    await visible(phone, 'li.message', 15)
    // Nothing scrolls sideways, and nothing is cut off at the right edge either.
    const fits = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth
      && ['.messages', '.composer', '.conversation-head', '.panel'].every((selector) => {
        const el = document.querySelector(selector)
        return !el || (el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= window.innerWidth + 1)
      }))
    await phone.screenshot({ path: join(SHOTS, `${engine}-phone.png`) })
    await phone.getByRole('button', { name: 'Menu' }).click()
    const menu = await visible(phone, 'nav.sidebar', 5)
    await phone.screenshot({ path: join(SHOTS, `${engine}-phone-menu.png`) })
    check(fits && menu, `${engine}: at phone width nothing scrolls sideways and the menu opens`)

    check(errors.length === 0, `${engine}: no page errors${errors.length ? ` (${errors.join('; ')})` : ''}`)
  } finally {
    await browser.close()
  }
}

try {
  mkdirSync(SHOTS, { recursive: true })
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, `owner-${id}@local`)
  for (const engine of engines) {
    node('server/admin.ts', 'add-person', team, `alice-${engine}-${id}@local`)
    node('server/admin.ts', 'add-person', team, `amir-${engine}-${id}@local`)
  }
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', `owner-${id}@local`))
  const { agentId } = JSON.parse(node('server/admin.ts', 'add-agent', team, agentName, `mac-${id}`, 'haiku',
    'When asked to run a command, run exactly that command with the Bash tool, once. Keep replies short unless asked to write.'))
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step4b-')))
  const folder = join(home, 'agents', agentId)
  mkdirSync(folder, { recursive: true })

  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  const env = { ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_PORT: String(PORT + 100), AGENTS_STREAMS_PORT: '7802', AGENTS_STREAMS_DIR: join(home, 'streams') }
  children.push(spawn(process.execPath, ['server/api.ts'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] }))
  for (let i = 0; i < 80 && !(await fetch(API).then(() => true, () => false)); i++) await sleep(250)
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home }, stdio: ['ignore', 'ignore', 'inherit'],
  }))
  for (let i = 0; i < 80; i++) {
    if ((await db.query(`select 1 from instances where name = $1 and status = 'online'`, [`mac-${id}`])).rows.length) break
    await sleep(250)
  }

  for (const engine of engines) await run(engine, folder)
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) await db.query('delete from teams where name = $1', [team]).catch(() => {})
  await db.end().catch(() => {})
}

console.log(`\nscreenshots in test/ui-shots\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test team removed)'}`)
process.exit(failures.length ? 1 : 0)
