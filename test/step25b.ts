// Fit design step 16, the app. An agent's page lists the secrets its plugins name.
// A person sets one in a masked field, sees where it is set and when, replaces it,
// and removes it after being asked. A computer that is stopped says so, and a
// teammate is told whose computer it is and is offered no field. A computer that refuses a
// value says why in the row, and keeps what was typed. This
// drives the page in Chromium, Firefox and WebKit at desktop and phone width
// against a real API and daemon, with a pass-through in front of the people port
// that keeps every request the page makes, so the check can say the value left
// the page in one request and was kept nowhere in it. Scans for accessibility
// problems and takes screenshots to look at.
//   node --env-file=.env --env-file=.env.test test/step25b.ts
//   AGENTS_UI_ENGINES=chromium node --env-file=.env --env-file=.env.test test/step25b.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, firefox, webkit, type BrowserType, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import pg from 'pg'
import { z } from 'zod'
import { messageOf } from '../shared/errors.ts'
import { asPerson, results, ROOT, shapeRows, startApi, within } from './onboarding-kit.ts'
import { must } from './must.ts'
import { tap, type Tap } from './wiretap.ts'

const SHOTS = join(ROOT, 'test', 'ui-shots')
// Ports 8166 to 8169 are this check's: machines, people and streams, and a
// pass-through in front of the people port that the pages use.
const PORTS = { machines: 8166, people: 8167, streams: 8168 }
const TAP_PORT = 8169
const PEOPLE = `http://127.0.0.1:${String(TAP_PORT)}`
const INSECURE = `http://agents.test:${String(TAP_PORT)}`
const ORIGINS: Record<string, string> = { chromium: INSECURE, firefox: INSECURE, webkit: PEOPLE }
const LAUNCH: Record<string, Record<string, unknown>> = {
  chromium: { args: ['--host-resolver-rules=MAP agents.test 127.0.0.1'] },
  firefox: { firefoxUserPrefs: { 'network.dns.localDomains': 'agents.test' } },
  webkit: {},
}
const ENGINES: Record<string, BrowserType> = { chromium, webkit, firefox }
const engines = (process.env.AGENTS_UI_ENGINES ?? 'chromium,webkit,firefox').split(',')
const WIDTHS = { desktop: { width: 1280, height: 820 }, phone: { width: 390, height: 844 } }
// How long a page's lists may take to show when it opens. Each reads a shape that Electric makes on the first
// request, which takes longer while other checks use the same Electric.
const LISTS_SEC = 45

const id = randomBytes(4).toString('hex')
const team = `secrets25b-${id}`
const [alice, bob] = [`alice25b-${id}@local`, `bob25b-${id}@local`]
const computer = { a: `mac-a-${id}`, b: `mac-b-${id}` }
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step25b-')))
const homeA = join(home, 'computer-a')
const secretsFile = join(homeA, 'secrets.json')

const { failures, check } = results()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const shots: string[] = []
const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
// A value read from a row, as the text it must be.
const stringOf = (value: unknown): string => z.string().parse(value)

// The node running this check comes first on the PATH, so the stand-in for Claude runs on it.
const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ ...process.env, PATH: `${dirname(process.execPath)}:${must(process.env.PATH, 'a PATH')}`, ...extra })
const admin = (...args: string[]) => execFileSync(process.execPath, ['server/admin.ts', ...args], { cwd: ROOT, env: env({}), encoding: 'utf8' })
const forms = (text: string) => [...new Set([text, JSON.stringify(text).slice(1, -1)])]
const holds = (text: string, wanted: string) => forms(wanted).some((form) => text.includes(form))

async function visible(page: Page, selector: string, seconds: number, text?: RegExp): Promise<boolean> {
  const locator = text ? page.locator(selector, { hasText: text }) : page.locator(selector)
  return locator.first().waitFor({ state: 'visible', timeout: seconds * 1000 }).then(() => true, () => false)
}

async function serious(page: Page) {
  const axe = await new AxeBuilder({ page }).analyze()
  const found = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  for (const v of found) console.log(`      ${v.id}: ${v.help} (${String(v.nodes.length)}) ${JSON.stringify(v.nodes[0]?.target)}`)
  return found.length
}

// Whether the page and each named part stay inside the screen's width. When one does not, the one that
// does not is printed, since a width that fails now and then is hard to see in a pass or a fail alone.
async function noSideScroll(page: Page, selectors: string[]) {
  const over = await page.evaluate((list) => [
    ...(document.documentElement.scrollWidth > window.innerWidth ? [`the page is ${String(document.documentElement.scrollWidth)} wide in ${String(window.innerWidth)}`] : []),
    ...list.flatMap((selector) => [...document.querySelectorAll(selector)].flatMap((el) => {
      const right = el.getBoundingClientRect().right
      return right > window.innerWidth + 1 ? [`${selector} ends at ${String(right)} in ${String(window.innerWidth)}`] : []
    })),
  ], selectors)
  for (const line of over) console.log(`      ${line}`)
  return over.length === 0
}

// The page scrolls inside its body, so the secrets are scrolled to the bottom of the screen before the shot.
async function shot(page: Page, name: string) {
  const path = join(SHOTS, `${name}.png`)
  await page.locator('.secrets').evaluate((list) => { list.scrollIntoView({ block: 'end' }) })
  await page.screenshot({ path })
  shots.push(`test/ui-shots/${name}.png`)
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  mkdirSync(homeA, { recursive: true })
  await db.connect()
  execFileSync(process.execPath, ['server/migrate.ts'], { cwd: ROOT, env: env({}) })
  admin('add-team', team, alice)
  admin('add-person', team, bob)
  const macA = z.object({ token: z.string() }).parse(JSON.parse(admin('add-instance', team, computer.a, 'mac', alice)))
  admin('add-instance', team, computer.b, 'mac', bob)
  const agentOn = (name: string, on: string) => z.object({ agentId: z.string() }).parse(JSON.parse(admin('add-agent', team, name, on, '', 'You help.'))).agentId
  const scout = agentOn('scout', computer.a)
  const bobby = agentOn('bobby', computer.b)
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  const api = await startApi(PORTS, { AGENTS_RUNNER: 'off', AGENTS_RUNNER_TEAMS: team }, join(home, 'streams'))
  const people = await tap(TAP_PORT, { port: PORTS.people })
  try {
    const up = (url: string) => within(30, () => fetch(url).then(() => true, () => false))
    if (!await up(PEOPLE) || !await up(`http://127.0.0.1:${String(PORTS.machines)}`)) throw new Error('the API did not start')
    writeFileSync(join(home, 'scenario.json'), JSON.stringify({}))
    children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
      env: env({ AGENTS_API: `http://127.0.0.1:${String(PORTS.machines)}`, AGENTS_TOKEN: macA.token, AGENTS_HOME: homeA, AGENTS_CLAUDE_BIN: join(ROOT, 'test', 'fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json') }),
    }))
    const instanceA = stringOf(must(await one('select id from instances where name = $1', [computer.a]), 'the first computer').id)
    // The control connection is up a moment after the machine reports in.
    const ready = await within(30, async () => (await one('select status from instances where id = $1', [instanceA]))?.status === 'online')
    if (!ready) throw new Error('the daemon never reported in')
    const plugin = (secret: string) => ({ name: 'sentry', kind: 'stdio', config: { command: process.execPath, args: ['sentry.js'], env: { TOKEN: { secret } } } })
    for (const [who, agent, secret] of [[alice, scout, 'SENTRY_TOKEN'], [bob, bobby, 'JIRA_TOKEN']] as const) {
      const saved = await asPerson(PEOPLE, who, 'POST', `/v1/agents/${agent}/plugins`, plugin(secret))
      if (saved.status !== 200) throw new Error(`could not add the plugin: ${String(saved.status)} ${saved.text}`)
    }
    for (const who of [alice, bob]) await within(20, async () => (await shapeRows(PEOPLE, who, 'secrets')).rows.length >= 1)
    for (const engine of engines) await run(engine, scout, bobby, people)
  } finally {
    await people.close()
    await api.stop()
  }
}

async function run(engine: string, scout: string, bobby: string, people: Tap) {
  const first = `ui-first-${engine}-${randomBytes(10).toString('hex')}`
  const second = `ui-second-${engine}-${randomBytes(10).toString('hex')}`
  const bounced = `bounced-by-the-computer-${engine}-${randomBytes(10).toString('hex')}`
  const unsent = `typed-never-sent-${engine}-${randomBytes(10).toString('hex')}`
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const errors: string[] = []
  const open = async (who: string, agent: string, options: Record<string, unknown> = {}) => {
    const context = await browser.newContext({ baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': who }, viewport: WIDTHS.desktop, ...options })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/#/a/${agent}`)
    return page
  }
  const row = (page: Page, name: string) => page.locator('.secrets > li', { hasText: name })
  try {
    // The page lists the secret the agent's plugin names, not set anywhere yet.
    const page = await open(alice, scout)
    const line = row(page, 'SENTRY_TOKEN')
    const listed = await visible(page, '.secrets > li', LISTS_SEC, /SENTRY_TOKEN/)
    if (!listed) console.log(`      the page showed:\n${(await page.locator('.page-body').innerText().catch(() => '(no page body)')).split('\n').slice(-12).join('\n')}`)
    check(listed && /Not set from the app on mac-a/.test(await line.innerText()), `${engine}: an agent's page lists the secret its plugin names, and says it is not set on the agent's computer`)
    check(await page.getByRole('heading', { name: 'Secrets' }).isVisible() && /goes to mac-a.* and nowhere else/.test(await page.locator('.page-body').innerText()), `${engine}: and says where a value goes`)
    await shot(page, `${engine}-secrets-not-set-desktop`)
    check(await serious(page) === 0, `${engine}: the page has no serious accessibility problems`)

    // Setting a value: a masked field, one request, and the page keeps nothing.
    const field = page.getByLabel('Value of SENTRY_TOKEN')
    check(await page.getByRole('form', { name: 'Set SENTRY_TOKEN' }).isVisible(), `${engine}: the row offers to set the value`)
    check(await field.getAttribute('type') === 'password' && await field.getAttribute('autocomplete') === 'off', `${engine}: the value is typed in a masked field`)
    check(await page.getByRole('button', { name: 'Set value' }).isDisabled(), `${engine}: Set value waits for a value to be typed`)

    // A computer that refuses the value, here because its folder cannot be written, says why in the row. What was
    // typed stays in the field, and nothing is written on the computer.
    const fileBefore = existsSync(secretsFile) ? readFileSync(secretsFile, 'utf8') : null
    await field.fill(bounced)
    chmodSync(homeA, 0o500)
    try {
      await page.getByRole('button', { name: 'Set value' }).click()
      check(await visible(page, '.secrets > li [role="alert"]', 15, /could not change what this computer holds/), `${engine}: a computer that refuses the value says why in the row`)
    } finally {
      chmodSync(homeA, 0o700)
    }
    check(await field.inputValue() === bounced && (existsSync(secretsFile) ? readFileSync(secretsFile, 'utf8') : null) === fileBefore,
      `${engine}: what was typed stays in the field, and the computer is as it was`)

    await field.fill(first)
    check(!holds(await page.locator('body').innerText(), first), `${engine}: what is typed is not on the page as text`)
    await page.getByRole('button', { name: 'Set value' }).click()
    check(await visible(page, '.secrets > li', LISTS_SEC, /Set on mac-a.*by you/), `${engine}: after Set value the row says where it is set, when, and by you`)
    check(await field.inputValue() === '' && !holds(await page.locator('body').innerText(), first) && !holds(await page.content(), first), `${engine}: the field is empty again and the page holds nothing of the value`)
    check(await page.getByRole('form', { name: 'Replace SENTRY_TOKEN' }).isVisible(), `${engine}: the row now offers to replace the value`)
    const kept = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage, document.cookie, location.href]))
    check(!holds(kept, first), `${engine}: the value is in no storage, cookie or address of the page`)
    check(JSON.parse(readFileSync(secretsFile, 'utf8')).SENTRY_TOKEN === first, `${engine}: the computer's secrets file has the value`)
    await shot(page, `${engine}-secrets-set-desktop`)

    // Read again from the list, it names who set it.
    await page.reload()
    check(await visible(page, '.secrets > li', LISTS_SEC, new RegExp(`Set on mac-a.*by ${alice}`)), `${engine}: opened again, the row names the person who set it`)

    // A teammate sees it, and is offered no way to change it on someone else's computer.
    const bobsPage = await open(bob, scout)
    check(await visible(bobsPage, '.secrets > li', LISTS_SEC, new RegExp(`Set on mac-a.*by ${alice}`)), `${engine}: a teammate sees where it is set and by whom, and not the value`)
    check(await visible(bobsPage, '.secrets > li p', 15, new RegExp(`is ${alice}'s own computer, so only they can set a value on it`)), `${engine}: and is told whose computer it is`)
    check(await bobsPage.getByLabel('Value of SENTRY_TOKEN').count() === 0 && await bobsPage.getByRole('button', { name: /^(Set|Replace) value$/ }).count() === 0,
      `${engine}: with no field or button to change it`)
    await shot(bobsPage, `${engine}-secrets-teammate-desktop`)

    // Replacing, and removing after being asked.
    await field.fill(second)
    await page.keyboard.press('Enter')
    check(await within(15, async () => JSON.parse(readFileSync(secretsFile, 'utf8')).SENTRY_TOKEN === second), `${engine}: Enter in the field replaces the value`)
    await line.getByRole('button', { name: 'Remove', exact: true }).click()
    check(await visible(page, '.secrets .confirm', 5, /Remove it from mac-a/), `${engine}: Remove asks first, in place`)
    await shot(page, `${engine}-secrets-remove-desktop`)
    await line.getByRole('button', { name: 'Keep' }).click()
    check(JSON.parse(readFileSync(secretsFile, 'utf8')).SENTRY_TOKEN === second && /Set on mac-a/.test(await row(page, 'SENTRY_TOKEN').innerText()), `${engine}: Keep leaves the value where it is`)
    await line.getByRole('button', { name: 'Remove', exact: true }).click()
    await line.getByRole('button', { name: 'Yes, remove' }).click()
    check(await visible(page, '.secrets > li', 15, /Not set from the app on mac-a/) && !('SENTRY_TOKEN' in JSON.parse(readFileSync(secretsFile, 'utf8'))), `${engine}: removed, the row says it is not set and the computer no longer holds it`)

    // A computer that is stopped says so, and takes no value. Nothing runs on it to report its status, so the check
    // sets it by hand: running while a value is typed, and stopped after.
    await db.query(`update instances set status = 'online' where name = $1`, [computer.b])
    const stoppedPage = await open(bob, bobby)
    const jiraField = stoppedPage.getByLabel('Value of JIRA_TOKEN')
    await visible(stoppedPage, '.secrets > li', LISTS_SEC, /JIRA_TOKEN/)
    await jiraField.fill(unsent)
    await db.query(`update instances set status = 'offline' where name = $1`, [computer.b])
    check(await visible(stoppedPage, '.secrets > li p', LISTS_SEC, new RegExp(`${computer.b} is stopped`)), `${engine}: a stopped computer is named as stopped on the page`)
    check(await stoppedPage.getByRole('button', { name: 'Set value' }).isDisabled() && await jiraField.inputValue() === unsent,
      `${engine}: a value typed before its computer stopped stays in the field, and Set value waits for the computer`)
    check(await jiraField.isDisabled(), `${engine}: and the field takes nothing more while the computer is stopped`)
    await shot(stoppedPage, `${engine}-secrets-stopped-desktop`)

    // The page sent the value in one request, to the route that sets a value.
    const requests = people.heard.flatMap((heard) => (heard.kind === 'request' && holds(`${heard.url}\n${JSON.stringify(heard.headers)}\n${heard.body}`, first) ? [heard] : []))
    const sentFirst = requests[0]
    check(requests.length === 1 && sentFirst?.method === 'POST' && /^\/v1\/secrets\/[0-9a-f-]{36}\/value$/.test(sentFirst.url) && holds(sentFirst.body, first) && !holds(sentFirst.url, first) && !holds(JSON.stringify(sentFirst.headers), first),
      `${engine}: the value left the page in one request, in the body of the post that sets it`)
    const echoed = people.heard.filter((heard) => heard.kind === 'response' && [first, second, bounced].some((text) => holds(heard.body, text)))
    check(echoed.length === 0, `${engine}: no answer the API sent holds a value`)
    const bouncedPosts = people.heard.filter((heard) => heard.kind === 'request' && holds(`${heard.url}\n${JSON.stringify(heard.headers)}\n${heard.body}`, bounced))
    check(bouncedPosts.length === 1 && bouncedPosts[0]?.kind === 'request' && /^\/v1\/secrets\/[0-9a-f-]{36}\/value$/.test(bouncedPosts[0].url) && holds(bouncedPosts[0].body, bounced),
      `${engine}: the value the computer refused left the page once, in the body of the post that asked`)
    const typedOnly = people.heard.filter((heard) => heard.kind === 'request' && holds(`${heard.url}\n${JSON.stringify(heard.headers)}\n${heard.body}`, unsent))
    check(typedOnly.length === 0, `${engine}: what was typed and never set left the page in no request, so nothing is saved as it is typed`)

    // Phone width: the same page fits the screen, with the field and its buttons in reach.
    const phone = await open(alice, scout, { viewport: WIDTHS.phone, isMobile: engine !== 'firefox', hasTouch: engine !== 'firefox' })
    await visible(phone, '.secrets > li', LISTS_SEC, /SENTRY_TOKEN/)
    const phoneField = phone.getByLabel('Value of SENTRY_TOKEN')
    await phoneField.fill(first)
    const fits = await noSideScroll(phone, ['.page-head', '.page-body', '.secrets > li', '.secret-form', '.secret-form input'])
    await shot(phone, `${engine}-secrets-phone`)
    check(fits && await phone.getByRole('button', { name: 'Set value' }).isVisible(), `${engine}: at phone width the secrets fit without sideways scrolling`)
    await phoneField.fill('')
    check(await serious(phone) === 0, `${engine}: the phone page has no serious accessibility problems`)

    // The dark page.
    const dark = await open(alice, scout, { colorScheme: 'dark' })
    await visible(dark, '.secrets > li', LISTS_SEC, /SENTRY_TOKEN/)
    await shot(dark, `${engine}-secrets-dark`)
  } finally {
    // Checked even when a step above failed, since a page error is often why.
    check(errors.length === 0, `${engine}: no page errors${errors.length ? ` (${errors.join('; ')})` : ''}`)
    await browser.close()
  }
}

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  await main()
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? messageOf(error) : messageOf(error)}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch((error: unknown) => { console.error('removing the team:', messageOf(error)) })
    rmSync(home, { recursive: true, force: true })
  }
  await db.end().catch(() => undefined)
}

console.log(`\nscreenshots:\n${shots.join('\n')}\n${failures.length ? `${String(failures.length)} failed (team ${team} and ${home} kept)` : 'all passed (test team and folder removed)'}`)
process.exit(failures.length ? 1 : 0)
