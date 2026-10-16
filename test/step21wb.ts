// WebMCP in agents' browsers, build step 21, the app. Drives the Team page's list
// of sites and the approval card for web_act in Chromium, Firefox and WebKit, at
// desktop and phone width, against a real API. An admin lists a site and sees it
// listed, a site that is not a scheme and a host is refused with the reason, and
// removing a site takes it off the list. A member sees no such section. The card
// for web_act offers Allow once and Deny, says it asks every time, shows the whole
// call, and has no Always or Never, while the card for Bash keeps all four.
// Takes screenshots (light, dark, phone) to look at, scans for accessibility
// problems, and fails on any page error.
// The asks are raised as the box's daemon raises them from Claude's request, with
// the machine's token, so no box is needed and this check does not use port 7701.
//   node --env-file=.env --env-file=.env.test test/step21wb.ts
//   AGENTS_UI_ENGINES=chromium node --env-file=.env --env-file=.env.test test/step21wb.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import pg from 'pg'
import { messageOf } from '../shared/errors.ts'
import { must } from './must.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
const SHOTS = join(ROOT, 'test', 'ui-shots')
const PORT = 8170
const STREAMS_PORT = 8171
const PEOPLE_PORT = 8172
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PEOPLE_PORT}`
// Over the tailnet the app runs on plain HTTP. Chromium and Firefox reach the test
// server by a non-local name to match, and WebKit, which cannot map a name, by localhost.
const INSECURE = `http://agents.test:${PEOPLE_PORT}`
const ORIGINS: Record<string, string> = { chromium: INSECURE, firefox: INSECURE, webkit: PEOPLE }
const LAUNCH: Record<string, Record<string, unknown>> = {
  chromium: { args: ['--host-resolver-rules=MAP agents.test 127.0.0.1'] },
  firefox: { firefoxUserPrefs: { 'network.dns.localDomains': 'agents.test' } },
  webkit: {},
}
const ENGINES: Record<string, BrowserType> = { chromium, webkit, firefox }
const engines = (process.env.AGENTS_UI_ENGINES ?? 'chromium,webkit,firefox').split(',')
const id = randomBytes(4).toString('hex')
const team = `webmcp-ui-${id}`
const owner = `owner-${id}@local`
const agentName = `helper-${id}`
const WEB_ACT = 'mcp__computer__web_act'
// How long a control gets to appear before a section gives up, so a missing view fails in seconds.
const CONTROL_WAIT_MS = 10_000
// How long the result of an action gets to show on the page. The API answers at once, but the sync service's test
// instance is shared with every check running on this Mac, and with the machine busy it has taken more than 10 seconds.
const RESULT_WAIT_S = 30

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const pattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', '--env-file=.env.test', ...args], { cwd: ROOT, encoding: 'utf8' })

async function visible(page: Page, selector: string, seconds: number, text?: RegExp): Promise<boolean> {
  const locator = text ? page.locator(selector, { hasText: text }) : page.locator(selector)
  return locator.first().waitFor({ state: 'visible', timeout: seconds * 1000 }).then(() => true, () => false)
}

async function gone(page: Page, selector: string, seconds: number, text?: RegExp): Promise<boolean> {
  const locator = text ? page.locator(selector, { hasText: text }) : page.locator(selector)
  return locator.first().waitFor({ state: 'detached', timeout: seconds * 1000 }).then(() => true, () => false)
}

async function serious(page: Page) {
  const axe = await new AxeBuilder({ page }).analyze()
  const found = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  for (const v of found) console.log(`      ${v.id}: ${v.help} (${v.nodes.length}) ${JSON.stringify(v.nodes[0]?.target)}`)
  return found.length
}

// Measured against the page's own width, since phone emulation widens the window to fit overflow.
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

async function openPage(browser: Browser, engine: string, errors: string[], login: string, path: string, options: Record<string, unknown> = {}) {
  const context = await browser.newContext({ baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': login }, viewport: { width: 1280, height: 820 }, ...options })
  context.setDefaultTimeout(CONTROL_WAIT_MS)
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(`${login}: ${error.message}`))
  await page.goto(path)
  return page
}

async function post(login: string, path: string, body: unknown) {
  const res = await fetch(PEOPLE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

// A section that fails reports a line and lets the next one run, so a view that is missing
// still shows what else is wrong beside it.
async function section(engine: string, name: string, work: () => Promise<void>) {
  try {
    await work()
  } catch (error) {
    check(false, `${engine}: ${name} stopped (${messageOf(error).split('\n')[0] ?? ''})`)
  }
}

async function runEngine(engine: string, token: string) {
  const admin = `alice-${engine}-${id}@local`
  const member = `bob-${engine}-${id}@local`
  node('server/admin.ts', 'add-person', team, admin)
  node('server/admin.ts', 'set-role', team, admin, 'admin')
  node('server/admin.ts', 'add-person', team, member)
  const site = `https://${engine}.example.test`
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const errors: string[] = []
  const open = (login: string, path: string, options: Record<string, unknown> = {}) => openPage(browser, engine, errors, login, path, options)
  const phoneOptions = { viewport: { width: 390, height: 844 }, isMobile: engine !== 'firefox', hasTouch: engine !== 'firefox' }
  try {
    // The Team page. An admin lists a site and takes it off again.
    await section(engine, "the admin's Team page", async () => {
      const page = await open(admin, '/#/team')
      const heading = page.getByRole('heading', { name: 'Sites whose tools agents may use' })
      check(await visible(page, 'section[aria-label="Team"]', RESULT_WAIT_S) && await heading.isVisible(), `${engine}: an admin sees the list of sites on the Team page`)
      await page.getByRole('textbox', { name: 'Site' }).fill('javascript:alert(1)')
      await page.getByRole('button', { name: 'List site' }).click()
      check(await visible(page, '[role="alert"]', RESULT_WAIT_S, /scheme and a host/), `${engine}: a site that is not a scheme and a host is refused, and the page says what a site looks like`)
      await page.getByRole('textbox', { name: 'Site' }).fill(site)
      await page.getByRole('button', { name: 'List site' }).click()
      check(await visible(page, 'ul[aria-label="Sites whose tools agents may use"] li', RESULT_WAIT_S, new RegExp(`${pattern(site)}.*listed by ${pattern(admin)}`))
        && await visible(page, '[role="status"]', RESULT_WAIT_S, /Listed .* Agents use it from their next message/), `${engine}: listing a site shows it on the list with who listed it`)
      check(await page.getByRole('textbox', { name: 'Site' }).inputValue() === '', `${engine}: the field empties once the site is listed`)
      await page.screenshot({ path: join(SHOTS, `${engine}-webmcp-sites-light.png`) })
      check(await serious(page) === 0, `${engine}: the Team page has no serious accessibility problems`)

      const dark = await open(admin, '/#/team', { colorScheme: 'dark' })
      await visible(dark, 'ul[aria-label="Sites whose tools agents may use"]', RESULT_WAIT_S)
      await dark.screenshot({ path: join(SHOTS, `${engine}-webmcp-sites-dark.png`) })
      const phone = await open(admin, '/#/team', phoneOptions)
      const phoneListed = await visible(phone, 'ul[aria-label="Sites whose tools agents may use"] li', RESULT_WAIT_S, new RegExp(pattern(site)))
      const phoneFits = await noSideScroll(phone, ['.page', '.page-body', 'ul[aria-label="Sites whose tools agents may use"]', 'form[aria-label="List a site"]'])
      await phone.screenshot({ path: join(SHOTS, `${engine}-webmcp-sites-phone.png`) })
      check(phoneListed && phoneFits, `${engine}: at phone width the list and its form fit without sideways scrolling (listed ${phoneListed}, fits ${phoneFits})`)

      await page.getByRole('button', { name: `Remove ${site}` }).click()
      check(await gone(page, 'ul[aria-label="Sites whose tools agents may use"] li', RESULT_WAIT_S, new RegExp(pattern(site))), `${engine}: removing a site takes it off the list`)
    })

    // A member sees no such section, and the API refuses their change.
    await section(engine, "the member's Team page", async () => {
      const memberPage = await open(member, '/#/team')
      await visible(memberPage, 'section[aria-label="Team"]', RESULT_WAIT_S)
      check(await memberPage.getByRole('heading', { name: 'Sites whose tools agents may use' }).count() === 0
        && (await post(member, '/v1/team/webmcp-origins', { origin: 'https://member.example.test' })).status === 403,
      `${engine}: a member sees no list of sites, and the API refuses their change`)
    })

    // The approval card. Alice asks the agent something, and the agent's box
    // raises two asks: Bash, which keeps all four buttons, and web_act, which has two.
    await section(engine, 'the approval cards', async () => {
      const dm = await post(admin, '/v1/conversations', { kind: 'dm', agent: agentName })
      const conversationId: string = must(dm.json?.conversationId, 'the conversation')
      await post(admin, `/v1/conversations/${conversationId}/messages`, { text: 'Use the page.', clientId: `ui-${engine}-${id}` })
      const sessionId: string = must((await db.query('select id from sessions where conversation_id = $1', [conversationId])).rows[0]?.id, 'the session')
      const raise = (tag: string, toolName: string, input: Record<string, unknown>) => fetch(`${API}/v1/sessions/${sessionId}/events`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ events: [{
          clientId: `ask:${tag}-${engine}-${id}`, kind: 'ask', toolName, toolUseId: `toolu_${tag}_${engine}_${id}`, text: `${toolName} ${JSON.stringify(input)}`,
          body: { requestId: `req-${tag}-${engine}-${id}`, toolName, input },
        }] }),
      })
      await raise('bash', 'Bash', { command: 'echo hello' })
      await raise('act', WEB_ACT, { origin: 'http://127.0.0.1:8080', name: 'add_item', input: { item: 'pear' } })

      const chat = await open(admin, `/#/c/${conversationId}`)
      const actCard = chat.locator('section.ask-card', { hasText: WEB_ACT })
      const bashCard = chat.locator('section.ask-card', { hasText: 'echo hello' })
      check(await visible(chat, 'section.ask-card', RESULT_WAIT_S, new RegExp(WEB_ACT)) && await bashCard.count() === 1, `${engine}: both asks show as cards in the conversation`)
      const buttons = async (card: typeof actCard) => (await card.getByRole('button').allInnerTexts()).map((text) => text.trim())
      const actButtons = await buttons(actCard)
      const bashButtons = await buttons(bashCard)
      check(actButtons.join('|') === 'Allow once|Deny' && await actCard.getByText('asks every time').isVisible(),
        `${engine}: the card for web_act offers Allow once and Deny, and says it asks every time (${actButtons.join(', ')})`)
      check(bashButtons.join('|') === 'Allow once|Always allow|Deny|Never', `${engine}: the card for Bash keeps Allow once, Always allow, Deny and Never (${bashButtons.join(', ')})`)
      const shown = await actCard.locator('pre.subject').innerText()
      check(shown.includes('"origin": "http://127.0.0.1:8080"') && shown.includes('"name": "add_item"') && shown.includes('"item": "pear"'),
        `${engine}: the card shows the whole call, the site, the tool and its input`)
      await chat.screenshot({ path: join(SHOTS, `${engine}-webmcp-ask-light.png`) })
      check(await serious(chat) === 0, `${engine}: the conversation with the cards has no serious accessibility problems`)

      const darkChat = await open(admin, `/#/c/${conversationId}`, { colorScheme: 'dark' })
      await visible(darkChat, 'section.ask-card', RESULT_WAIT_S, new RegExp(WEB_ACT))
      await darkChat.screenshot({ path: join(SHOTS, `${engine}-webmcp-ask-dark.png`) })
      const phoneChat = await open(admin, `/#/c/${conversationId}`, phoneOptions)
      const phoneCard = await visible(phoneChat, 'section.ask-card', RESULT_WAIT_S, new RegExp(WEB_ACT))
      const phoneChatFits = await noSideScroll(phoneChat, ['.messages', '.composer', '.conversation-head', 'section.ask-card', 'section.ask-card pre.subject'])
      await phoneChat.screenshot({ path: join(SHOTS, `${engine}-webmcp-ask-phone.png`) })
      check(phoneCard && phoneChatFits, `${engine}: at phone width the cards fit without sideways scrolling (shown ${phoneCard}, fits ${phoneChatFits})`)

      await actCard.getByRole('button', { name: 'Allow once' }).click()
      check(await gone(chat, 'section.ask-card', RESULT_WAIT_S, new RegExp(WEB_ACT)), `${engine}: allowing the card closes it`)
      const answered = (await db.query(`select status, answer->>'decision' as decision from asks where session_id = $1 and tool_use_id = $2`, [sessionId, `toolu_act_${engine}_${id}`])).rows[0]
      check(answered?.status === 'answered' && answered.decision === 'allow', `${engine}: the answer is Allow, recorded for that call (${answered?.decision ?? 'none'})`)
    })
    check(errors.length === 0, `${engine}: no page errors${errors.length ? ` (${errors.join('; ')})` : ''}`)
  } finally {
    await browser.close()
  }
}

try {
  mkdirSync(SHOTS, { recursive: true })
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, owner)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', owner))
  node('server/admin.ts', 'add-agent', team, agentName, `mac-${id}`, 'haiku', 'Answer briefly.')
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step21wb-')))
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  const env = {
    ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'),
    AGENTS_STREAMS_PORT: String(STREAMS_PORT), AGENTS_STREAMS_DIR: join(home, 'streams'),
  }
  children.push(spawn(process.execPath, ['server/api.ts'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] }))
  await servePeople(PEOPLE_PORT, join(home, 'people.sock'))
  for (let i = 0; i < 80 && !(await fetch(API).then(() => true, () => false)); i++) await sleep(250)
  for (const engine of engines) await runEngine(engine, token)
  rmSync(home, { recursive: true, force: true })
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack : messageOf(error)}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
  await db.end().catch(() => undefined)
}

console.log(`\nscreenshots in test/ui-shots\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test team removed)'}`)
process.exit(failures.length ? 1 : 0)
