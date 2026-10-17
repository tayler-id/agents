// Fit design step 16, the app. A person sets a secret's value in place, from a masked field, sees
// where it is set and when, replaces it, and removes it after being asked. A computer that is stopped is
// started by the request, and the page says so while it waits. A teammate is told whose computer it is and is offered nothing, and a computer
// that refuses a value says why in the row and keeps what was typed. Nothing in the app mounts the
// secrets yet, since the agent panel's card will, so this builds them as a page of their own, under the
// app's own policy and styles, and drives that page in Chromium, Firefox and WebKit at desktop and phone
// width against a real API and daemon. A pass-through in front of the people port keeps every request the
// page makes, so the check can say the value left the page in one request and was kept nowhere in it. It
// also says the page has no form, no style element and no inline style. Scans for accessibility problems
// and takes screenshots to look at.
//   node --env-file=.env --env-file=.env.test test/step25b.ts
//   AGENTS_UI_ENGINES=chromium node --env-file=.env --env-file=.env.test test/step25b.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, firefox, webkit, type BrowserType, type Locator, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import pg from 'pg'
import { z } from 'zod'
import { messageOf } from '../shared/errors.ts'
import { asPerson, results, ROOT, shapeRows, startApi, within } from './onboarding-kit.ts'
import { must } from './must.ts'
import { buildHost, HOST } from './secrets-host.ts'
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
// Seconds the API waits for a computer that is not running, where it waits 90 for a person.
const WAKE_SEC = 8

const id = randomBytes(4).toString('hex')
const team = `secrets25b-${id}`
const [alice, bob] = [`alice25b-${id}@local`, `bob25b-${id}@local`]
const computer = { a: `mac-a-${id}`, b: `mac-b-${id}`, box: `box-b-${id}` }
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

// Whether the element has the cursor, waiting a moment for the page to give it.
const hasCursor = (target: Locator) => within(5, async () => await target.count() === 1 && await target.evaluate((el) => el === document.activeElement))

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

// What a page did against the app's policy, which refuses a style element, an inline style and an eval, or
// nothing when it kept to it. A violation the browser reported is named by the rule it broke.
async function againstPolicy(page: Page): Promise<string> {
  const [violated, styleElements, inlineStyles, formElements] = await page.evaluate(() => [
    document.documentElement.dataset.csp ?? '', document.querySelectorAll('style').length,
    // A screenshot leaves an empty style attribute on a field, which says nothing, so only one that says something counts.
    [...document.querySelectorAll('[style]')].filter((el) => el.getAttribute('style') !== '').map((el) => `${el.tagName.toLowerCase()} style="${el.getAttribute('style') ?? ''}"`), document.querySelectorAll('form').length,
  ] as const)
  return [
    violated ? `the browser reported ${violated}` : '',
    styleElements ? `${String(styleElements)} style elements` : '',
    inlineStyles.length ? `inline styles on ${inlineStyles.join(' and ')}` : '',
    formElements ? `${String(formElements)} forms` : '',
  ].filter((problem) => problem !== '').join(', ')
}

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
  // Bob's own box, asleep, with nothing to start it, since the runner is off here.
  const bobId = stringOf(must(await one('select id from people where login = $1', [bob]), 'bob').id)
  const teamId = stringOf(must(await one('select id from teams where name = $1', [team]), 'the team').id)
  await db.query(`insert into instances (team_id, name, kind, owner_id, token_sha256, claimed_by, claimed_at, personal, idle_since, stopped_at, status)
    values ($1, $2, 'box', $3, $4, $3, now(), true, now(), now(), 'offline')`, [teamId, computer.box, bobId, randomBytes(32).toString('hex')])
  const boxy = agentOn('boxy', computer.box)
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  buildHost()
  const api = await startApi(PORTS, { AGENTS_RUNNER: 'off', AGENTS_RUNNER_TEAMS: team, AGENTS_SECRET_WAKE_SEC: String(WAKE_SEC) }, join(home, 'streams'))
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
    for (const [who, agent, secret] of [[alice, scout, 'SENTRY_TOKEN'], [bob, bobby, 'JIRA_TOKEN'], [bob, boxy, 'BOXY_TOKEN']] as const) {
      const saved = await asPerson(PEOPLE, who, 'POST', `/v1/agents/${agent}/plugins`, plugin(secret))
      if (saved.status !== 200) throw new Error(`could not add the plugin: ${String(saved.status)} ${saved.text}`)
    }
    for (const who of [alice, bob]) await within(20, async () => (await shapeRows(PEOPLE, who, 'secrets')).rows.length >= 1)
    for (const engine of engines) await run(engine, scout, bobby, boxy, people)
  } finally {
    await people.close()
    await api.stop()
  }
}

async function run(engine: string, scout: string, bobby: string, boxy: string, people: Tap) {
  const unique = (word: string) => `ui-${word}-${engine}-${randomBytes(10).toString('hex')}`
  const first = unique('first')
  const second = unique('second')
  const bounced = unique('bounced-by-the-computer')
  const unsent = unique('typed-never-sent')
  const slept = unique('sent-while-starting')
  const boxed = unique('sent-while-the-box-starts')
  const left = unique('typed-then-left')
  const canceled = unique('typed-then-canceled')
  const heardBefore = people.heard.length
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const errors: string[] = []
  // What each page did against the app's policy, looked at while its field was open and again at the end.
  const against: string[] = []
  const watched = async (page: Page, which: string) => {
    const problem = await againstPolicy(page)
    against.push(problem && `${which}, ${problem}`)
  }
  // A screenshot in WebKit puts a style of its own on the page, which the app's policy refuses and the page reports.
  // What the page did is looked at before the screenshot, and its report starts again after it.
  const snap = async (page: Page, name: string) => {
    await watched(page, `before the ${name} screenshot`)
    await shot(page, `${engine}-${name}`)
    await page.evaluate(() => { document.documentElement.dataset.csp = '' })
  }
  const open = async (who: string, agent: string, options: Record<string, unknown> = {}) => {
    const context = await browser.newContext({ baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': who }, viewport: WIDTHS.desktop, ...options })
    // A page that breaks the app's policy leaves the rule it broke on the page, for the check at the end.
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => { document.documentElement.dataset.csp = `${document.documentElement.dataset.csp ?? ''}${event.violatedDirective};` })
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/secrets-host/index.html#agent=${agent}`)
    return page
  }
  const row = (page: Page, name: string) => page.locator('.secrets > li', { hasText: name })
  const button = (page: Page, name: string) => page.getByRole('button', { name })
  try {
    // The page lists the secret the agent's plugin names, not set anywhere yet.
    const page = await open(alice, scout)
    const line = row(page, 'SENTRY_TOKEN')
    const listed = await visible(page, '.secrets > li', LISTS_SEC, /SENTRY_TOKEN/)
    if (!listed) console.log(`      the page showed:\n${(await page.locator('body').innerText().catch(() => '(no body)')).split('\n').slice(-12).join('\n')}`)
    check(listed && /Not set from the app on mac-a/.test(await line.innerText()), `${engine}: the secrets page lists the secret its plugin names, and says it is not set on the agent's computer`)
    check(await page.getByRole('heading', { name: 'Secrets' }).isVisible() && /goes to mac-a.* and nowhere else/.test(await page.locator('body').innerText()), `${engine}: and says where a value goes`)
    await snap(page, 'secrets-not-set-desktop')
    check(await serious(page) === 0, `${engine}: the page has no serious accessibility problems`)

    // Setting a value in place. A button opens a masked field, and nothing on the page is a form.
    const setButton = button(page, 'Set value of SENTRY_TOKEN')
    const replaceButton = button(page, 'Replace value of SENTRY_TOKEN')
    const field = page.getByLabel('Value of SENTRY_TOKEN', { exact: true })
    check(await page.locator('form').count() === 0 && await page.getByRole('form').count() === 0, `${engine}: nothing on the page is a form`)
    check(await setButton.isVisible() && await field.count() === 0, `${engine}: the row offers Set value, and shows no field until it is chosen`)
    await setButton.click()
    check(await field.isVisible() && await hasCursor(field), `${engine}: choosing Set value opens a field with the cursor in it`)
    await watched(page, 'the first page, while its field is open')
    check(await field.getAttribute('type') === 'password' && await field.getAttribute('autocomplete') === 'off', `${engine}: the value is typed in a masked field`)
    // Enter with nothing typed asks for nothing. The posts counted at the end say so.
    await field.press('Enter')

    // A computer that refuses the value, here because its folder cannot be written, says why in the row. What was
    // typed stays in the field, and nothing is written on the computer.
    const fileBefore = existsSync(secretsFile) ? readFileSync(secretsFile, 'utf8') : null
    await field.fill(bounced)
    chmodSync(homeA, 0o500)
    try {
      await field.press('Enter')
      check(await visible(page, '.secrets > li [role="alert"]', 15, /could not change what this computer holds/), `${engine}: a computer that refuses the value says why in the row`)
    } finally {
      chmodSync(homeA, 0o700)
    }
    check(await field.inputValue() === bounced && (existsSync(secretsFile) ? readFileSync(secretsFile, 'utf8') : null) === fileBefore,
      `${engine}: what was typed stays in the field, and the computer is as it was`)

    // Leaving the field keeps what was typed and sends nothing. Esc and Cancel put it away and clear it.
    await field.fill(left)
    await page.getByRole('heading', { name: 'Secrets' }).click()
    check(await field.isVisible() && await field.inputValue() === left, `${engine}: leaving the field keeps what was typed`)
    // A request would come within a moment of leaving, so the check looks for one for a few seconds and finds none.
    check(!await within(3, async () => people.heard.slice(heardBefore).some((heard) => heard.kind === 'request' && holds(`${heard.url}\n${heard.body}`, left))),
      `${engine}: and leaving it sends nothing`)
    await field.press('Escape')
    const escaped = await field.count() === 0 && await hasCursor(setButton)
    await setButton.click()
    check(escaped && await field.inputValue() === '', `${engine}: Esc puts the field away, gives the cursor back to its button and clears what was typed`)
    await field.fill(canceled)
    await button(page, 'Cancel').click()
    const cancelled = await field.count() === 0 && await hasCursor(setButton)
    await setButton.click()
    check(cancelled && await field.inputValue() === '', `${engine}: Cancel does the same`)

    await field.fill(first)
    check(!holds(await page.locator('body').innerText(), first), `${engine}: what is typed is not on the page as text`)
    await field.press('Enter')
    check(await visible(page, '.secrets > li', LISTS_SEC, /Set on mac-a.*by you/), `${engine}: after Enter the row says where it is set, when, and by you`)
    check(await field.count() === 0 && !holds(await page.locator('body').innerText(), first) && !holds(await page.content(), first), `${engine}: the field is gone and the page holds nothing of the value`)
    check(await replaceButton.isVisible() && await hasCursor(replaceButton), `${engine}: the row now offers to replace the value, with the cursor on it`)
    // Opened again at once, with no new page between, the field holds nothing of what was sent.
    await replaceButton.click()
    check(await field.isVisible() && await field.inputValue() === '', `${engine}: opened again to replace the value, the field is empty`)
    await field.press('Escape')
    const kept = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage, document.cookie, location.href]))
    check(!holds(kept, first), `${engine}: the value is in no storage, cookie or address of the page`)
    check(JSON.parse(readFileSync(secretsFile, 'utf8')).SENTRY_TOKEN === first, `${engine}: the computer's secrets file has the value`)
    await snap(page, 'secrets-set-desktop')

    // Read again from the list, it names who set it.
    await page.reload()
    check(await visible(page, '.secrets > li', LISTS_SEC, new RegExp(`Set on mac-a.*by ${alice}`)), `${engine}: opened again, the row names the person who set it`)

    // A teammate sees it, and is offered no way to change it on someone else's computer.
    const bobsPage = await open(bob, scout)
    check(await visible(bobsPage, '.secrets > li', LISTS_SEC, new RegExp(`Set on mac-a.*by ${alice}`)), `${engine}: a teammate sees where it is set and by whom, and not the value`)
    check(await visible(bobsPage, '.secrets > li p', 15, new RegExp(`is ${alice}'s own computer, so only they can set a value on it`)), `${engine}: and is told whose computer it is`)
    check(await bobsPage.getByLabel('Value of SENTRY_TOKEN', { exact: true }).count() === 0 && await bobsPage.getByRole('button', { name: /value of SENTRY_TOKEN/ }).count() === 0,
      `${engine}: with no field or button to change it`)
    await snap(bobsPage, 'secrets-teammate-desktop')

    // Replacing, and removing after being asked.
    await replaceButton.click()
    await field.fill(second)
    await field.press('Enter')
    check(await within(15, async () => JSON.parse(readFileSync(secretsFile, 'utf8')).SENTRY_TOKEN === second), `${engine}: Enter in the field replaces the value`)
    const removeButton = button(page, 'Remove value of SENTRY_TOKEN')
    await removeButton.click()
    check(await visible(page, '.secrets .confirm', 5, /Remove it from mac-a/), `${engine}: Remove asks first, in place`)
    await snap(page, 'secrets-remove-desktop')
    await button(page, 'Keep').click()
    check(JSON.parse(readFileSync(secretsFile, 'utf8')).SENTRY_TOKEN === second && /Set on mac-a/.test(await row(page, 'SENTRY_TOKEN').innerText()), `${engine}: Keep leaves the value where it is`)
    await removeButton.click()
    await button(page, 'Yes, remove').click()
    check(await visible(page, '.secrets > li', 15, /Not set from the app on mac-a/) && !('SENTRY_TOKEN' in JSON.parse(readFileSync(secretsFile, 'utf8'))), `${engine}: removed, the row says it is not set and the computer no longer holds it`)
    await watched(page, 'the first page, at its end')

    // A Mac that is not connected is not a reason to hide the control. Nothing starts a Mac, so the request is refused at
    // once, and the page never says the Mac is starting. Nothing runs on the Mac to report its status, so the check sets it.
    await db.query(`update instances set status = 'offline' where name = $1`, [computer.b])
    const stoppedPage = await open(bob, bobby)
    const jiraSet = button(stoppedPage, 'Set value of JIRA_TOKEN')
    const jiraField = stoppedPage.getByLabel('Value of JIRA_TOKEN', { exact: true })
    await visible(stoppedPage, '.secrets > li', LISTS_SEC, /JIRA_TOKEN/)
    check(await jiraSet.count() === 1 && await jiraSet.isEnabled() && await stoppedPage.locator('.secrets > li p').filter({ hasText: /is stopped/ }).count() === 0, `${engine}: a stopped computer offers the control as usual, with no words about it stopped`)
    await jiraSet.click()
    await jiraField.fill(unsent)
    await jiraField.press('Escape')
    check(await jiraField.count() === 0, `${engine}: Esc puts the field away`)
    await jiraSet.click()
    await jiraField.fill(slept)
    await jiraField.press('Enter')
    check(await visible(stoppedPage, '.secrets > li .error', 5, new RegExp(`${computer.b} is not connected`)) && await jiraField.inputValue() === slept
      && await stoppedPage.locator('.secrets > li [role=status]').filter({ hasText: /Starting/ }).count() === 0,
    `${engine}: a Mac that is not connected is refused at once with a reason that names it, the page never says it is starting, and the field keeps what was typed`)
    await jiraField.press('Escape')
    await watched(stoppedPage, 'the stopped computer page, at its end')

    // Bob's own box is asleep. The request asks for it to start and waits, and the page says so meanwhile. Nothing here
    // starts it, so the wait ends in a refusal that names it.
    const boxPage = await open(bob, boxy)
    const boxySet = button(boxPage, 'Set value of BOXY_TOKEN')
    const boxyField = boxPage.getByLabel('Value of BOXY_TOKEN', { exact: true })
    await visible(boxPage, '.secrets > li', LISTS_SEC, /BOXY_TOKEN/)
    await boxySet.click()
    await boxyField.fill(boxed)
    await boxyField.press('Enter')
    check(await visible(boxPage, '.secrets > li [role=status]', 5, new RegExp(`Starting ${computer.box}'s computer to save the key`)), `${engine}: while the box starts, the page says it is starting ${computer.box}'s computer to save the key`)
    await snap(boxPage, 'secrets-starting-desktop')
    check(await visible(boxPage, '.secrets > li .error', WAKE_SEC + 15, new RegExp(`${computer.box} did not start within ${String(WAKE_SEC)} seconds`)) && await boxyField.inputValue() === boxed,
      `${engine}: when it does not start in time the page shows the reason that names it, and the field keeps what was typed`)
    await boxyField.press('Escape')
    await watched(boxPage, 'the sleeping box page, at its end')

    // The page sent the value in one request, to the route that sets a value, and made no other request to the secrets routes.
    const requests = people.heard.flatMap((heard) => (heard.kind === 'request' && holds(`${heard.url}\n${JSON.stringify(heard.headers)}\n${heard.body}`, first) ? [heard] : []))
    const sentFirst = requests[0]
    check(requests.length === 1 && sentFirst?.method === 'POST' && /^\/v1\/secrets\/[0-9a-f-]{36}\/value$/.test(sentFirst.url) && holds(sentFirst.body, first) && !holds(sentFirst.url, first) && !holds(JSON.stringify(sentFirst.headers), first),
      `${engine}: the value left the page in one request, in the body of the post that sets it`)
    const echoed = people.heard.filter((heard) => heard.kind === 'response' && [first, second, bounced].some((text) => holds(heard.body, text)))
    check(echoed.length === 0, `${engine}: no answer the API sent holds a value`)
    const bouncedPosts = people.heard.filter((heard) => heard.kind === 'request' && holds(`${heard.url}\n${JSON.stringify(heard.headers)}\n${heard.body}`, bounced))
    check(bouncedPosts.length === 1 && bouncedPosts[0]?.kind === 'request' && /^\/v1\/secrets\/[0-9a-f-]{36}\/value$/.test(bouncedPosts[0].url) && holds(bouncedPosts[0].body, bounced),
      `${engine}: the value the computer refused left the page once, in the body of the post that asked`)
    const typedOnly = people.heard.filter((heard) => heard.kind === 'request' && [unsent, left, canceled].some((text) => holds(`${heard.url}\n${JSON.stringify(heard.headers)}\n${heard.body}`, text)))
    check(typedOnly.length === 0, `${engine}: what was typed and never set left the page in no request, so nothing is sent as it is typed or when the field is left`)
    const posts = people.heard.slice(heardBefore).flatMap((heard) => (heard.kind === 'request' && heard.method === 'POST' && heard.url.startsWith('/v1/secrets/') ? [heard] : []))
    check(posts.map((post) => post.url.split('/').pop()).join(' ') === 'value value value remove value value' && holds(posts[0]?.body ?? '', bounced) && holds(posts[1]?.body ?? '', first) && holds(posts[2]?.body ?? '', second)
      && holds(posts[4]?.body ?? '', slept) && holds(posts[5]?.body ?? '', boxed),
    `${engine}: the page asked to set a value five times and to remove it once, and made no other request to the secrets routes`)

    // Phone width: the same page fits the screen, with the field in reach.
    const phone = await open(alice, scout, { viewport: WIDTHS.phone, isMobile: engine !== 'firefox', hasTouch: engine !== 'firefox' })
    await visible(phone, '.secrets > li', LISTS_SEC, /SENTRY_TOKEN/)
    await button(phone, 'Set value of SENTRY_TOKEN').click()
    const phoneField = phone.getByLabel('Value of SENTRY_TOKEN', { exact: true })
    await phoneField.fill(first)
    const fits = await noSideScroll(phone, ['.secrets > li', '.secret-edit', '.secret-edit input'])
    await snap(phone, 'secrets-phone')
    check(fits && await button(phone, 'Cancel').isVisible(), `${engine}: at phone width the secrets fit without sideways scrolling`)
    await phoneField.fill('')
    check(await serious(phone) === 0, `${engine}: the phone page has no serious accessibility problems`)

    // The dark page.
    const dark = await open(alice, scout, { colorScheme: 'dark' })
    await visible(dark, '.secrets > li', LISTS_SEC, /SENTRY_TOKEN/)
    await snap(dark, 'secrets-dark')

    // Every page kept to the app's policy while its field was open and after, with no style element, no inline style and no form.
    check(against.every((text) => text === ''), `${engine}: no page had a form, a style element, an inline style or a policy violation${against.some(Boolean) ? ` (${against.filter(Boolean).join('; ')})` : ''}`)
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
    rmSync(HOST, { recursive: true, force: true })
  }
  await db.end().catch(() => undefined)
}

console.log(`\nscreenshots:\n${shots.join('\n')}\n${failures.length ? `${String(failures.length)} failed (team ${team} and ${home} kept)` : 'all passed (test team and folder removed)'}`)
process.exit(failures.length ? 1 : 0)
