// History, the app. In Chromium, Firefox and WebKit, at desktop and phone width,
// people open the History page, filter it, search the text of steps, open a
// result at the step that matched and replay a long session: play it, pause it,
// step through it, jump to the steps that went wrong, and read a result in full.
// The page reads a page of steps at a time and keeps few at once. A person who
// may not see a session finds it in no list, no result and no replay. No page
// breaks the policy that forbids inline styles and scripts, none adds a style
// element, and none has an accessibility problem that is serious. Screenshots go
// to test/ui-shots.
//   node --env-file=.env --env-file=.env.test test/step26b.ts
//   AGENTS_UI_ENGINES=chromium node --env-file=.env --env-file=.env.test test/step26b.ts

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, firefox, webkit, type BrowserType, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import { BIG_END, buildWorld, said, typed, WORDS, type World } from './history-kit.ts'
import { MAX_LOADED, PAGE, OPEN_BEFORE } from '../shared/replay.ts'
import { STEPS_SPAN_MAX } from '../shared/history.ts'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
const SHOTS = join(ROOT, 'test', 'ui-shots')
// Ports 8184 to 8186 are this check's: machines, people, streams.
const PORTS = { machines: 8184, people: 8185, streams: 8186 }
// Over the tailnet the app runs on plain HTTP, which browsers treat as insecure. Chromium and Firefox reach the test server by a
// non-local name to match. WebKit has no way to map a name, so it uses 127.0.0.1.
const INSECURE = `http://agents.test:${String(PORTS.people)}`
const SECURE = `http://127.0.0.1:${String(PORTS.people)}`
const ORIGINS: Record<string, string> = { chromium: INSECURE, firefox: INSECURE, webkit: SECURE }
const LAUNCH: Record<string, Record<string, unknown>> = {
  chromium: { args: ['--host-resolver-rules=MAP agents.test 127.0.0.1'] },
  firefox: { firefoxUserPrefs: { 'network.dns.localDomains': 'agents.test' } },
  webkit: {},
}
const ENGINES: Record<string, BrowserType> = { chromium, webkit, firefox }
const engines = (process.env.AGENTS_UI_ENGINES ?? 'chromium,webkit,firefox').split(',')
const failures: string[] = []
const started = Date.now()

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const within = (seconds: number) => ({ timeout: seconds * 1000 })
const shown = (page: Page, selector: string, seconds = 15, text?: RegExp | string) =>
  (text === undefined ? page.locator(selector) : page.locator(selector, { hasText: text })).first().waitFor({ state: 'visible', ...within(seconds) }).then(() => true, () => false)
// Waits for a condition the page reaches, and says whether it did.
async function until(seconds: number, test: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test().catch(() => false)) return true
    await sleep(100)
  }
  return false
}

const world: World = await buildWorld('histui', PORTS, { buildApp: true })
const { sessions, logins, long } = world

// The step number the replay is on, from the row marked current.
const currentStep = async (page: Page): Promise<number> => {
  const id = await page.locator('li.replay-step[aria-current="step"]').first().getAttribute('id', within(5))
  return Number((id ?? '').replace('step-', ''))
}
const stepIds = (page: Page) => page.locator('ol.replay-steps > li').evaluateAll((items) => items.map((item) => Number(item.id.replace('step-', ''))))

async function run(engine: string) {
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const errors: string[] = []
  const violations: string[] = []
  const stepRequests: { from: number; to: number }[] = []
  let refusals = 0
  const open = async (login: string, phone = false) => {
    const context = await browser.newContext({
      baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': login },
      viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 820 },
      ...(phone && engine !== 'firefox' ? { isMobile: true, hasTouch: true } : {}),
    })
    // The page says when the browser's policy refuses something it did, and a style element is something it would add.
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        const target = event.target instanceof Element ? event.target.nodeName : event.target instanceof Document ? 'the document' : 'something else'
        console.error(`policy violation: ${event.violatedDirective} ${event.blockedURI} on ${target}`)
      })
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(`${login}: ${error.message}`))
    // A person who may not see a session is told so with a 404, which Chromium also logs. Those are counted by the answers, not hidden.
    // WebKit reports an inline style on every select element, the Team page's too, and Playwright's screenshots add a stylesheet that
    // WebKit reports on the document. Those are the browser's and the tool's, and any other refusal fails the check.
    const known = /status of 404|^Refused to apply a stylesheet|^policy violation: style-src-attr inline on SELECT|^policy violation: style-src-elem inline on the document/
    page.on('response', (response) => { if (login === logins.ben && response.status() === 404 && /\/v1\/history\/sessions\//.test(response.url())) refusals++ })
    page.on('console', (message) => {
      if (message.type() === 'error' && !known.test(message.text())) violations.push(`${login}: ${message.text()}`)
    })
    page.on('request', (request) => {
      const match = /\/steps\?from=(\d+)&to=(\d+)/.exec(request.url())
      if (match) stepRequests.push({ from: Number(match[1]), to: Number(match[2]) })
    })
    await page.goto('/')
    return page
  }
  const tag = (name: string) => name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  const shoot = (page: Page, name: string, width: string) => page.screenshot({ path: join(SHOTS, `history-${engine}-${width}-${tag(name)}.png`) })
  const row = (page: Page, text: string | RegExp) => page.locator('ul.history-list > li', { hasText: text }).first()
  const rows = (page: Page) => page.locator('ul.history-list > li')
  const choose = (page: Page, label: string, value: string) => page.locator('label', { hasText: new RegExp(`^${label}`) }).locator('select').selectOption(value)

  try {
    // ---- Ava, at a desktop window
    const ava = await open(logins.ava)
    await ava.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'History' }).click()
    check(await shown(ava, 'ul[aria-label="Sessions"] li', 20), `${engine}: History opens from the sidebar`)
    check(await until(10, async () => (await rows(ava).count()) === 10), `${engine}: it lists Ava's ten sessions`)
    const first = (await rows(ava).first().innerText()).replace(/\s+/g, ' ')
    check(/terminal/i.test(first) && /shop\/tools/.test(first) && /Your terminal/.test(first) && /\d+ steps/.test(first) && /ava-mac-/.test(first),
      `${engine}: the newest session comes first, with its place, its person, its machine and its steps (${first.slice(0, 90)})`)
    const text = (await rows(ava).allInnerTexts()).join('\n')
    check(/# launch/.test(text) && /Fix the checkout total/.test(text) && /bug-fix run: bug-fix: crash on save/.test(text) && /Direct message with/.test(text),
      `${engine}: rows say what each session was for`)
    check(/private/i.test(await row(ava, 'Plan the surprise').innerText()) && !/private/i.test(await row(ava, 'Fix the checkout total').innerText()),
      `${engine}: a private session says so to Ava, and a shared one does not`)
    check((await row(ava, 'Find the flaky').innerText()).includes('2 errors') && (await row(ava, 'bug-fix run').innerText()).includes('fix fixed'),
      `${engine}: a row says how many steps went wrong and what a pipeline stage reported`)
    check(/current/.test(await ava.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'History' }).getAttribute('class') ?? ''), `${engine}: the sidebar marks History as the page`)
    await shoot(ava, 'list', 'desktop')

    // Filters are choices, and they are in the address.
    await choose(ava, 'Kind', 'terminal')
    check(await until(10, async () => (await rows(ava).count()) === 4) && /kind=terminal/.test(ava.url()), `${engine}: choosing a kind keeps its sessions and puts the choice in the address`)
    await choose(ava, 'Kind', '')
    await choose(ava, 'Agent', world.ids.scout)
    check(await until(10, async () => (await rows(ava).count()) === 4), `${engine}: choosing an agent keeps its sessions`)
    await choose(ava, 'Agent', '')
    await choose(ava, 'Project', world.ids.project)
    check(await until(10, async () => (await rows(ava).count()) === 2), `${engine}: choosing a project keeps its task and room`)
    await choose(ava, 'Project', '')
    await choose(ava, 'Repo', world.ids.repo)
    check(await until(10, async () => (await rows(ava).count()) === 1) && (await rows(ava).first().innerText()).includes('Fix the checkout total'), `${engine}: choosing a repo keeps its tasks`)
    await choose(ava, 'Repo', '')
    await choose(ava, 'Person', world.ids.ava)
    check(await until(10, async () => (await rows(ava).count()) === 9), `${engine}: choosing a person keeps the sessions they started`)
    await choose(ava, 'Person', '')
    const ago = new Date()
    ago.setDate(ago.getDate() - 3)
    const oldDay = `${String(ago.getFullYear())}-${String(ago.getMonth() + 1).padStart(2, '0')}-${String(ago.getDate()).padStart(2, '0')}`
    await choose(ava, 'Day', oldDay)
    check(await until(10, async () => (await rows(ava).count()) === 1) && (await rows(ava).first().innerText()).includes('shop'), `${engine}: choosing a day keeps the sessions active on it`)
    await ava.getByRole('button', { name: 'Clear filters' }).click()
    check(await until(10, async () => (await rows(ava).count()) === 10) && !/day=/.test(ava.url()), `${engine}: Clear filters brings every session back`)

    // Search, with a scope.
    const box = ava.getByRole('searchbox', { name: 'Search the text of steps' })
    await box.fill(WORDS.terminal)
    await box.press('Enter')
    check(await until(10, async () => (await rows(ava).count()) === 4) && /q=zanzibar/.test(ava.url()), `${engine}: searching a word from a terminal session lists its steps, in Ava's team folder and her private one`)
    const marks = await ava.locator('ul[aria-label="Search results"] mark').allInnerTexts()
    check(marks.length >= 4 && marks.every((m) => m.toLowerCase() === WORDS.terminal), `${engine}: the words that matched are marked`)
    await shoot(ava, 'search', 'desktop')
    await choose(ava, 'Search in', 'messages')
    check(await until(10, async () => (await rows(ava).count()) === 3), `${engine}: choosing to search messages leaves out the tool result`)
    await choose(ava, 'Search in', '')
    await until(10, async () => (await rows(ava).count()) === 4)

    // A result opens its session at the step that matched.
    await row(ava, 'is set twice').getByRole('link').click()
    check(await shown(ava, 'li.replay-step[aria-current="step"]', 15, 'zanzibar is set twice') && /#\/history\/[0-9a-f-]{36}\/\d+/.test(ava.url()),
      `${engine}: a result opens the replay at the step that matched, and the address names the step`)
    const around = await stepIds(ava)
    check(around.length === 6 && around.every((id, i) => i === 0 || id > (around[i - 1] ?? 0)), `${engine}: the session's six steps are in the order they happened (${around.join(', ')})`)
    check((await ava.locator('.page-head h1').innerText()) === 'shop/server' && /replay · terminal/i.test(await ava.locator('.page-head .kicker').innerText()), `${engine}: the replay names the session`)
    await ava.getByRole('button', { name: 'Open the terminal session' }).click()
    check(await shown(ava, 'section[aria-label="Terminal session"]', 15) && /#\/l\//.test(ava.url()), `${engine}: a link goes back to the session's own page`)

    // A direct message links to its conversation.
    await ava.goto(`/#/history/${sessions.dm}`)
    check(await shown(ava, 'li.replay-step[aria-current="step"]', 15), `${engine}: a direct message opens in a replay`)
    await ava.getByRole('button', { name: 'Open the conversation' }).click()
    check(await shown(ava, 'section.conversation, .conversation', 15) && /#\/c\//.test(ava.url()), `${engine}: and links to its conversation`)

    // ---- The long session
    stepRequests.length = 0
    await ava.goto(`/#/history/${sessions.long}`)
    check(await shown(ava, 'li.replay-step[aria-current="step"]', 20) && (await currentStep(ava)) === 1, `${engine}: a replay opens on the first step`)
    const opening = await stepIds(ava)
    check(opening.length > 40 && opening.length <= OPEN_BEFORE + PAGE && stepRequests.length === 1 && stepRequests[0]?.to === OPEN_BEFORE + PAGE
      && !opening.some((id) => long.hidden.includes(id)), `${engine}: it loads ${String(OPEN_BEFORE + PAGE)} step numbers and not the whole session (${String(opening.length)} steps, ${JSON.stringify(stepRequests)})`)
    check(/Step 1 of \d+/.test(await ava.getByRole('status').first().innerText()), `${engine}: it says where it is in the session`)
    await ava.getByRole('button', { name: 'Next step' }).click()
    check(await until(5, async () => (await currentStep(ava)) === 2), `${engine}: Next step moves to the step after`)
    await ava.getByRole('button', { name: 'Previous step' }).click()
    check(await until(5, async () => (await currentStep(ava)) === 1), `${engine}: Previous step moves back`)
    await choose(ava, 'Speed', '8')
    await ava.getByRole('button', { name: 'Play' }).click()
    check(await shown(ava, 'button:has-text("Pause")', 5), `${engine}: Play becomes Pause`)
    const passed = await until(20, async () => (await currentStep(ava)) >= 12)
    await ava.getByRole('button', { name: 'Pause' }).click()
    const paused = await currentStep(ava)
    await sleep(900)
    check(passed && (await currentStep(ava)) === paused && paused >= 12, `${engine}: playing runs on through the steps, and pausing holds the step it is on (${String(paused)})`)
    check(ava.url().endsWith(`#/history/${sessions.long}/${String(paused)}`), `${engine}: once paused, the address names the step, so the page can be shared`)
    const played = await ava.locator('li.replay-step.ahead').count()
    check(played > 0 && (await ava.locator('li.replay-step.current').count()) === 1, `${engine}: the steps after the current one are marked as not reached`)
    await shoot(ava, 'replay', 'desktop')

    // The steps that went wrong.
    await ava.getByRole('button', { name: 'Previous error' }).click()
    const firstWrong = long.errors[0] ?? 0
    check(await until(10, async () => (await currentStep(ava)) === firstWrong), `${engine}: Previous error jumps back to the step that went wrong before it (${String(firstWrong)})`)
    check(/went wrong/i.test(await ava.locator('li.replay-step.current').innerText()) && (await ava.getByRole('button', { name: 'Previous error' }).isDisabled()), `${engine}: it says the step went wrong, and there is no error before it`)
    await ava.getByRole('button', { name: 'Next error' }).click()
    check(await until(10, async () => (await currentStep(ava)) === long.errors[1]), `${engine}: and the next one`)
    await ava.getByRole('button', { name: `Go to the error at step ${String(long.errors.at(-1))}` }).click()
    check(await until(10, async () => (await currentStep(ava)) === long.errors.at(-1)) && await ava.getByRole('button', { name: 'Next error' }).isDisabled(),
      `${engine}: a mark under the slider jumps to its error, and the last error has none after it`)
    check((await ava.locator('li.replay-step.current').innerText()).includes('The long session ended badly.'), `${engine}: the error step shows its words`)

    // Far away, and back, without loading it all.
    stepRequests.length = 0
    const slider = ava.getByRole('slider', { name: 'Position in the session' })
    await slider.fill('200')
    check(await until(10, async () => Math.abs((await currentStep(ava)) - 200) <= 2), `${engine}: moving the slider far away loads the steps around the place`)
    const middle = await stepIds(ava)
    check(middle.length <= MAX_LOADED && stepRequests.every((r) => r.to - r.from < STEPS_SPAN_MAX) && stepRequests.length >= 1 && stepRequests.length <= 3,
      `${engine}: and keeps a few steps, never more than ${String(MAX_LOADED)}, asking for ranges of less than ${String(STEPS_SPAN_MAX)} (${String(middle.length)} steps, ${String(stepRequests.length)} requests)`)
    await slider.fill(String(long.last))
    check(await until(10, async () => (await currentStep(ava)) >= long.last - 1), `${engine}: the end of the session is as near as the start`)
    check((await stepIds(ava)).length <= MAX_LOADED && !(await ava.getByRole('button', { name: 'Show later steps' }).isVisible()), `${engine}: at the end there are no later steps to show`)
    await ava.getByRole('button', { name: 'Play' }).click()
    check(await until(10, async () => (await currentStep(ava)) <= 3), `${engine}: playing from the end starts over`)
    await ava.getByRole('button', { name: 'Pause' }).click()

    // A result in full.
    await ava.goto(`/#/history/${sessions.long}/${String(long.big)}`)
    check(await shown(ava, 'li.replay-step[aria-current="step"]', 20), `${engine}: a link to a step opens it`)
    check((await currentStep(ava)) === long.big && (await ava.locator('li.replay-step.current pre').innerText()).endsWith(BIG_END),
      `${engine}: the step it opens on shows its result in full, to the last line`)
    await ava.getByRole('button', { name: 'Next step' }).click()
    check(await until(5, async () => (await currentStep(ava)) > long.big) && await ava.locator(`#step-${String(long.big)} details`).count() === 1 && await ava.locator(`#step-${String(long.big)} details[open]`).count() === 0,
      `${engine}: once the replay moves on, a long result folds to a line`)
    await ava.locator(`#step-${String(long.big)} summary`).click()
    check((await ava.locator(`#step-${String(long.big)} pre`).innerText()).endsWith(BIG_END), `${engine}: and opens again whole`)

    // ---- Ben cannot see what is private
    const ben = await open(logins.ben)
    await ben.goto('/#/history')
    check(await until(15, async () => (await rows(ben).count()) === 8), `${engine}: Ben's list holds eight sessions`)
    const benText = (await rows(ben).allInnerTexts()).join('\n')
    check(!/diary|Plan the surprise|surprise|narwhal/.test(benText) && /notes/.test(benText), `${engine}: it has nothing of Ava's private conversation, task or folder`)
    check(/private/i.test(await row(ben, 'notes').innerText()) && (await row(ben, 'notes').innerText()).includes('Your terminal'), `${engine}: and his own private folder is marked private, as his`)
    const benBox = ben.getByRole('searchbox', { name: 'Search the text of steps' })
    await benBox.fill(WORDS.privateTerminal)
    await benBox.press('Enter')
    check(await shown(ben, 'p', 10, 'No step matches those words.') && (await rows(ben).count()) === 0, `${engine}: a word from Ava's private folder finds nothing for Ben`)
    await benBox.fill(WORDS.terminal)
    await benBox.press('Enter')
    check(await until(10, async () => (await rows(ben).count()) === 3), `${engine}: while the same word from the team folder finds three steps`)
    for (const name of ['privateTerminal', 'privateDm', 'privateTask'] as const) {
      await ben.goto(`/#/history/${sessions[name]}`)
      check(await shown(ben, 'section[aria-label="Replay"] p', 15, 'This session is not one you can see.') && (await ben.locator('ol.replay-steps').count()) === 0, `${engine}: Ben opens Ava's ${name} replay and gets none of it`)
    }

    // ---- The pages keep the browser's policy, and are accessible
    const axe = async (page: Page, what: string) => {
      const found = (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
      for (const v of found) console.log(`      ${what}: ${v.id}: ${v.help} (${String(v.nodes.length)})`)
      check(found.length === 0, `${engine}: no serious accessibility problems on ${what}`)
    }
    await ava.goto('/#/history')
    await shown(ava, 'ul[aria-label="Sessions"] li', 15)
    await axe(ava, 'the History list')
    await ava.goto(`/#/history?q=${WORDS.terminal}`)
    await shown(ava, 'ul[aria-label="Search results"] li', 15)
    await axe(ava, 'search results')
    await ava.goto(`/#/history/${sessions.long}/${String(long.errors[0])}`)
    await shown(ava, 'li.replay-step[aria-current="step"]', 15)
    await axe(ava, 'a replay')
    check(await ava.evaluate(() => document.querySelectorAll('style').length) === 0, `${engine}: the page has no style element`)

    // ---- A phone
    const phone = await open(logins.ava, true)
    await phone.goto('/#/history')
    check(await until(15, async () => (await rows(phone).count()) === 10), `${engine}: on a phone the list shows the ten sessions`)
    // Nothing runs past the right edge of the screen, and no box holds more than it shows.
    const fits = async (page: Page) => {
      const wide = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('main *')]
        // The marks under the slider are centred on their place, so one at either end hangs half its width over the slider's end, inside the page.
        // An inline box has no client width, so only its edge says whether it runs past the screen.
        .filter((el) => el.getBoundingClientRect().width > 0 && (el.getBoundingClientRect().right > window.innerWidth + 1
          || (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).display !== 'inline' && !el.matches('.replay-ticks'))))
        .map((el) => `${el.tagName.toLowerCase()}.${el.className} ${String(Math.round(el.getBoundingClientRect().right))}/${String(window.innerWidth)} ${String(el.scrollWidth)}/${String(el.clientWidth)}`))
      const page_ = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      if (wide.length) console.log(`      wider than the screen: ${wide.slice(0, 12).join('; ')}`)
      return page_ && wide.length === 0
    }
    check(await fits(phone), `${engine}: nothing scrolls sideways or runs past the edge on the list`)
    await shoot(phone, 'list', 'phone')
    await phone.goto(`/#/history?q=${WORDS.terminal}`)
    await shown(phone, 'ul[aria-label="Search results"] li', 15)
    check(await fits(phone), `${engine}: or on the search results`)
    await shoot(phone, 'search', 'phone')
    await phone.goto(`/#/history/${sessions.long}/${String(long.big)}`)
    await shown(phone, 'li.replay-step[aria-current="step"]', 20)
    check(await fits(phone), `${engine}: or on a replay with a long result in view`)
    await shoot(phone, 'replay', 'phone')
    await phone.getByRole('button', { name: 'Play' }).click()
    check(await shown(phone, 'button:has-text("Pause")', 5), `${engine}: the controls work on a phone`)
    await phone.getByRole('button', { name: 'Pause' }).click()
    await phone.getByRole('button', { name: 'Menu' }).click()
    check(await shown(phone, 'nav.sidebar', 5) && await phone.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'History' }).isVisible(), `${engine}: History is in the phone's menu`)

    check(refusals === 3, `${engine}: Ben was refused exactly the three private sessions he asked for (${String(refusals)})`)
    check(errors.length === 0 && violations.length === 0, `${engine}: no page errors, no refused scripts or styles, no errors in the console${errors.length + violations.length ? ` (${[...errors, ...violations].join('; ')})` : ''}`)
  } finally {
    await browser.close()
  }
}

// A session that is still working is read again, so a replay of it learns of steps taken after it opened. A session with no steps says so.
async function working(engine: string) {
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  try {
    const context = await browser.newContext({ baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': logins.ava }, viewport: { width: 1280, height: 820 } })
    const page = await context.newPage()
    const make = async (where: string) => {
      const made = await world.machine(world.tokens.avaMac, 'POST', '/v1/instance/terminal-sessions', { folderId: world.folders.shop, harnessSessionId: randomUUID(), cwd: `/Users/ava/shop/${where}` })
      return must(made.body.sessionId as string | undefined, 'the new session')
    }
    const post = (session: string, status: string, ...events: ReturnType<typeof said>[]) => world.machine(world.tokens.avaMac, 'POST', `/v1/sessions/${session}/events`, { events, status })
    const live = await make('live')
    await post(live, 'running', typed('Start the migration'), said('Started.'), said('Still going.'))
    await page.goto(`/#/history/${live}`)
    const position = () => page.getByRole('status').first().innerText()
    check(await until(15, async () => /Step 1 of 3\b/.test(await position())), `${engine}: a replay of a session that is working says where it is in what has happened so far`)
    await post(live, 'running', said('Fourth.'), said('Fifth.'), said('Sixth.'))
    check(await until(30, async () => /Step 1 of 6\b/.test(await position())), `${engine}: and learns of the steps taken after it opened, without being reloaded`)
    await post(live, 'idle', said('Done.'))
    const none = await make('none')
    await page.goto(`/#/history/${none}`)
    check(await shown(page, 'p', 15, 'This session has no steps yet.') && /No steps yet/.test(await position()) && await page.getByRole('button', { name: 'Play' }).isDisabled(),
      `${engine}: a session with no steps yet says so, and has nothing to play`)
  } finally {
    await browser.close()
  }
}

try {
  mkdirSync(SHOTS, { recursive: true })
  for (const engine of engines) await run(engine)
  const first = engines[0]
  if (first) await working(first)
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack ?? (error as Error).message}`)
} finally {
  await world.stop(failures.length > 0)
}

console.log(`\nscreenshots in test/ui-shots\n${failures.length ? `${String(failures.length)} failed (team ${world.team} kept)` : 'all passed (test team removed)'} in ${String(Math.round((Date.now() - started) / 1000))} s`)
process.exit(failures.length ? 1 : 0)
