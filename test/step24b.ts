// Agent setup and copies, the app. Drives the hooks and the copy button on the agent's
// page in Chromium, WebKit and Firefox, at desktop and phone width, against a real API
// and daemon with the stand-in for Claude and its hooks. The agent's owner adds two
// hooks from one line of choices and takes one off, and the server's refusal shows where
// they are looking. A teammate sees the hooks and none of the controls that would change
// them. A person with no machine taps Create a copy and is told so. The teammate who owns
// a machine taps it once, lands on the copy, finds its hooks and the team's memories and
// none about a person, talks to it, and reads the hook's run in its session. Scans for
// accessibility problems and takes screenshots to look at.
//   node --env-file=.env --env-file=.env.test test/step24b.ts
//   AGENTS_UI_ENGINES=chromium node --env-file=.env --env-file=.env.test test/step24b.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { chromium, firefox, webkit, type BrowserType, type Locator, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import pg from 'pg'
import { asPerson, results, ROOT, startApi, within } from './onboarding-kit.ts'
import { must } from './must.ts'

const SHOTS = join(ROOT, 'test', 'ui-shots')
const PORTS = { machines: 7894, people: 7994, streams: 7895 }
const API = `http://127.0.0.1:${PORTS.machines}`
const PEOPLE = `http://127.0.0.1:${PORTS.people}`
const INSECURE = `http://agents.test:${PORTS.people}`
const ORIGINS: Record<string, string> = { chromium: INSECURE, firefox: INSECURE, webkit: PEOPLE }
const LAUNCH: Record<string, Record<string, unknown>> = {
  chromium: { args: ['--host-resolver-rules=MAP agents.test 127.0.0.1'] },
  firefox: { firefoxUserPrefs: { 'network.dns.localDomains': 'agents.test' } },
  webkit: {},
}
const ENGINES: Record<string, BrowserType> = { chromium, webkit, firefox }
const engines = (process.env.AGENTS_UI_ENGINES ?? 'chromium,webkit,firefox').split(',')
const id = randomBytes(4).toString('hex')
const team = `step24b-${id}`
const admin = `admin24b-${id}@local`
// Bob owns the machine the daemon runs on, so a copy he makes lands there. Carol owns none.
const [bob, carol] = [`bob24b-${id}@local`, `carol24b-${id}@local`]
const same = isDeepStrictEqual
const TEAM_NOTE = `TEAMNOTE-${id}`
const ABOUT_ALICE = `ABOUTALICE-${id}`

const { failures, check } = results()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
const row = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0]

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

async function run(engine: string) {
  const alice = `alice24b-${engine}-${id}@local`
  const name = `notes${engine}`
  const copyName = `${name}-copy`
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const errors: string[] = []
  const open = async (login: string, options: Record<string, unknown> = {}) => {
    const context = await browser.newContext({ baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': login }, viewport: { width: 1280, height: 820 }, ...options })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    return page
  }
  const hooksOf = (page: Page) => page.locator('div.hooks')
  const hookRows = (page: Page) => hooksOf(page).locator('li.hooks-row')
  const focused = (locator: Locator) => locator.evaluate((el) => el === document.activeElement)
  try {
    // The agent Bob will copy: Alice owns it, with a skill, a plugin that needs no secret, a routine and memories.
    const made = await asPerson(PEOPLE, alice, 'POST', '/v1/agents', {
      name, homeInstanceId: must(await row('select id from instances where name = $1', [`mac-${id}`]), 'the machine').id,
      title: 'Writes release notes', instructions: 'You write release notes.',
    })
    const source = must(made.json?.agentId, 'the agent Alice made')
    const setup = (path: string, body: unknown) => asPerson(PEOPLE, alice, 'POST', `/v1/agents/${source}/${path}`, body)
    await setup('skills', { name: 'release-style', description: 'Writing release notes', content: 'One line for each merged pull request.' })
    await setup('plugins', { name: 'fmt', kind: 'stdio', config: { command: 'node', args: ['fmt.js'], env: {} } })
    await setup('routines', { name: 'weekly', schedule: '0 9 * * 5', prompt: 'Draft the release notes.' })
    const aliceId = must(await row('select id from people where login = $1', [alice]), 'Alice').id
    const teamId = must(await row('select id from teams where name = $1', [team]), 'the team').id
    await db.query(
      `insert into memories (team_id, agent_id, scope, person_id, kind, log_date, content) values
       ($1, $2, 'team', null, 'profile', null, $3), ($1, $2, 'team', null, 'log', current_date, $4), ($1, $2, 'person', $5, 'profile', null, $6)`,
      [teamId, source, `${TEAM_NOTE} release notes go out on Fridays.`, `${TEAM_NOTE} shipped the checkout fix.`, aliceId, `${ABOUT_ALICE} prefers terse notes.`])
    const hooksStored = async () => (await db.query('select name, event, matcher, timeout_sec as limit from agent_hooks where agent_id = $1 order by name', [source])).rows

    // Alice, the owner, adds hooks from the agent's page: one line of choices, with no form.
    const page = await open(alice)
    await page.goto(`/#/a/${source}`)
    check(await visible(page, '.page-head h1', 20, new RegExp(name)) && await visible(page, 'div.hooks .hooks-empty', 15, /No hooks yet/),
      `${engine}: the agent's page lists its hooks, and says there are none yet`)
    const addHook = hooksOf(page).getByRole('button', { name: 'Add a hook' })
    await addHook.click()
    const add = hooksOf(page).getByRole('group', { name: 'Add a hook' })
    await add.waitFor()
    const message = add.getByRole('button', { name: 'A message arrives' })
    check(await add.getByRole('group', { name: 'When it runs' }).getByRole('button').count() === 6 && await message.getAttribute('aria-pressed') === 'true'
      && await add.getByLabel('Only for these tools (optional)').count() === 0 && await focused(add.getByLabel('Command to run'))
      && await hooksOf(page).locator('form, select').count() === 0,
    `${engine}: adding a hook offers the six events with a message chosen, takes no tools to match for it, has the command ready to type in, and is no form`)
    await page.screenshot({ path: join(SHOTS, `${engine}-hooks-add.png`), fullPage: true })
    check(await serious(page) === 0, `${engine}: the agent page with the add-a-hook line open has no serious accessibility problems`)
    await add.getByLabel('Command to run').fill('mkdir -p task && echo noted >> task/hook-log.txt')
    await add.getByRole('button', { name: 'Add hook', exact: true }).click()
    check(await visible(page, 'div.hooks li.hooks-row', 15, /user-prompt-submit.*A message arrives.*hook-log\.txt/s)
      && await within(5, async () => await add.count() === 0) && await within(5, () => focused(addHook)),
    `${engine}: a hook added from the page shows in the list under the name made from its event, and the line closes`)
    // A tool event takes the tools it applies to, and Enter in the command adds the hook.
    await addHook.click()
    await add.getByRole('button', { name: 'After a tool runs' }).click()
    check(await add.getByRole('button', { name: 'After a tool runs' }).getAttribute('aria-pressed') === 'true' && await message.getAttribute('aria-pressed') === 'false'
      && await add.getByLabel('Only for these tools (optional)').count() === 1, `${engine}: choosing a tool event asks which tools`)
    await add.getByLabel('Only for these tools (optional)').fill('Write')
    await add.getByLabel('Command to run').fill('mkdir -p task && echo wrote >> task/hook-log.txt')
    await add.getByLabel('Command to run').press('Enter')
    check(await visible(page, 'div.hooks li.hooks-row', 15, /post-tool-use.*After a tool runs · Write/s), `${engine}: a hook for a tool shows the tools it applies to`)
    const stored = await hooksStored()
    check(same(stored, [
      { name: 'post-tool-use', event: 'PostToolUse', matcher: 'Write', limit: null }, { name: 'user-prompt-submit', event: 'UserPromptSubmit', matcher: null, limit: null },
    ]), `${engine}: the hooks are saved with their event and tools: ${JSON.stringify(stored)}`)
    // The server's refusals are said where the person is looking.
    await addHook.click()
    await add.getByLabel('Command to run').fill(`curl -H "Authorization: token ghp_${'a1B2c3D4'.repeat(5)}" https://example.test`)
    await add.getByRole('button', { name: 'Add hook', exact: true }).click()
    check(await visible(page, 'div.hooks [role="alert"]', 10, /holds what looks like a secret value/) && await add.count() === 1 && (await hooksStored()).length === 2,
      `${engine}: a command with a secret value is refused, the reason shows in the add line, and the line stays open`)
    await add.getByRole('button', { name: 'Cancel' }).click()
    check(await within(5, async () => await add.count() === 0), `${engine}: Cancel closes the line`)
    // Remove takes a hook off.
    await addHook.click()
    await add.getByRole('button', { name: 'A turn ends' }).click()
    await add.getByLabel('Command to run').fill('true')
    await add.getByRole('button', { name: 'Add hook', exact: true }).click()
    await visible(page, 'div.hooks li.hooks-row', 15, /A turn ends/)
    await hooksOf(page).getByRole('button', { name: 'Remove stop' }).click()
    check(await within(15, async () => !(await hookRows(page).filter({ hasText: 'A turn ends' }).count())) && (await hooksStored()).length === 2,
      `${engine}: Remove takes a hook off the agent`)
    await page.screenshot({ path: join(SHOTS, `${engine}-hooks-light.png`), fullPage: true })
    check(await serious(page) === 0, `${engine}: the agent page with hooks has no serious accessibility problems`)

    // Bob reads the hooks and is offered none of the controls that change them. Carol, who has no machine, is told so.
    const bobPage = await open(bob)
    await bobPage.goto(`/#/a/${source}`)
    check(await visible(bobPage, 'div.hooks li.hooks-row', 20, /post-tool-use/) && await hookRows(bobPage).count() === 2
      && !await hooksOf(bobPage).getByRole('button').count() && await visible(bobPage, 'div.hooks p', 5, new RegExp(`Only ${name}'s owner or a team admin changes its hooks`)),
    `${engine}: a teammate reads the hooks, and is told who changes them instead of being offered the controls`)
    const carolPage = await open(carol)
    await carolPage.goto(`/#/a/${source}`)
    const agentsBefore = Number((await row('select count(*)::int as n from agents where team_id = $1', [teamId])).n)
    await carolPage.getByRole('button', { name: 'Create a copy' }).click()
    check(await visible(carolPage, '[role="alert"]', 15, /You have no machine of your own to put it on\. Name a machine\./)
      && await carolPage.locator('.page-head h1', { hasText: name }).count() === 1
      && Number((await row('select count(*)::int as n from agents where team_id = $1', [teamId])).n) === agentsBefore,
    `${engine}: a person with no machine of their own is told so beside the button, and no agent is made`)
    await carolPage.screenshot({ path: join(SHOTS, `${engine}-copy-refused.png`) })
    await carolPage.getByRole('button', { name: 'Close' }).click()
    check(await within(5, async () => !(await carolPage.locator('[role="alert"]').count())), `${engine}: Close puts the note away`)

    // Bob copies the agent with one tap and lands on the copy.
    check(await bobPage.getByRole('button', { name: 'Create a copy' }).isEnabled(), `${engine}: Create a copy is one button`)
    await bobPage.getByRole('button', { name: 'Create a copy' }).click()
    check(await visible(bobPage, '.page-head h1', 30, new RegExp(`^${copyName}$`)) && await visible(bobPage, '.page-head p', 10, new RegExp(`Copied from ${name}`)),
      `${engine}: one tap makes the copy, named after the agent, and opens it, saying which agent it was copied from`)
    const made2 = await row('select owner_id, home_instance_id, copied_from_agent_id from agents where team_id = $1 and name = $2', [teamId, copyName])
    check(made2?.owner_id === must(await row('select id from people where login = $1', [bob]), 'Bob').id && made2.copied_from_agent_id === source
      && made2.home_instance_id === must(await row('select id from instances where name = $1', [`mac-${id}`]), 'the machine').id,
    `${engine}: the copy is Bob's, on his own machine`)
    check(await visible(bobPage, 'div.hooks li.hooks-row', 15, /user-prompt-submit/) && await visible(bobPage, 'ul.items li', 5, /release-style/)
      && await visible(bobPage, 'div.hooks li.hooks-row', 5, /post-tool-use.*After a tool runs · Write/s) && await visible(bobPage, '.items li', 5, /fmt/),
    `${engine}: the copy lists the skill, the plugin and both hooks`)
    check(await visible(bobPage, 'ul.memories li', 15, new RegExp(TEAM_NOTE)) && await bobPage.locator('ul.memories li').count() === 2
      && !(await bobPage.locator('ul.memories').innerText()).includes(ABOUT_ALICE),
    `${engine}: the copy remembers what the team told the agent, and nothing about a person`)
    check(await hooksOf(bobPage).getByRole('button', { name: 'Add a hook' }).count() === 1, `${engine}: Bob owns the copy, so he is offered the hook controls there`)
    await bobPage.screenshot({ path: join(SHOTS, `${engine}-copied-light.png`), fullPage: true })

    // The copy answers, and the hook's run is in its session.
    await bobPage.getByRole('button', { name: 'Message' }).click()
    await bobPage.getByRole('textbox', { name: 'Message' }).fill('Are you there?')
    await bobPage.getByRole('textbox', { name: 'Message' }).press('Enter')
    check(await visible(bobPage, 'li.message.agent', 40, /fake reply/), `${engine}: the copy answers on Bob's machine`)
    await bobPage.getByRole('button', { name: 'Session details' }).click()
    check(await visible(bobPage, 'ol.events li .kicker', 30, /^Hook$/) && await visible(bobPage, 'ol.events li pre', 10, /Hook UserPromptSubmit finished\./),
      `${engine}: the session lists the hook's run`)
    await bobPage.screenshot({ path: join(SHOTS, `${engine}-hook-run-light.png`) })

    // Dark, and a phone.
    const dark = await open(bob, { colorScheme: 'dark' })
    await dark.goto(`/#/a/${source}`)
    await visible(dark, 'div.hooks li.hooks-row', 20)
    await dark.screenshot({ path: join(SHOTS, `${engine}-hooks-dark.png`), fullPage: true })
    const phoneOptions = { viewport: { width: 390, height: 844 }, isMobile: engine !== 'firefox', hasTouch: engine !== 'firefox' }
    const phone = await open(alice, phoneOptions)
    await phone.goto(`/#/a/${source}`)
    await visible(phone, 'div.hooks li.hooks-row', 20, /user-prompt-submit/)
    await hooksOf(phone).getByRole('button', { name: 'Add a hook' }).click()
    await hooksOf(phone).getByRole('button', { name: 'After a tool runs' }).click()
    await phone.screenshot({ path: join(SHOTS, `${engine}-hooks-phone.png`), fullPage: true })
    check(await noSideScroll(phone, ['.page-head', '.page-body', 'div.hooks']), `${engine}: at phone width the agent page, with the add-a-hook line open, fits without sideways scrolling`)
    const carolPhone = await open(carol, phoneOptions)
    await carolPhone.goto(`/#/a/${source}`)
    await carolPhone.getByRole('button', { name: 'Create a copy' }).click()
    await visible(carolPhone, '[role="alert"]', 15, /no machine of your own/)
    await carolPhone.screenshot({ path: join(SHOTS, `${engine}-copy-refused-phone.png`) })
    check(await noSideScroll(carolPhone, ['.page-head', '.page-body', '.copy-problem']), `${engine}: at phone width the reason a copy was refused fits without sideways scrolling`)
    check(errors.length === 0, `${engine}: no page errors${errors.length ? ` (${errors.join('; ')})` : ''}`)
  } finally {
    await browser.close()
  }
}

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

let api: Awaited<ReturnType<typeof startApi>> | null = null
try {
  mkdirSync(SHOTS, { recursive: true })
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, admin)
  for (const login of [bob, carol, ...engines.map((engine) => `alice24b-${engine}-${id}@local`)]) node('server/admin.ts', 'add-person', team, login)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', bob))
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step24b-')))
  writeFileSync(join(home, 'scenario.json'), JSON.stringify({ turns: [] }))
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  api = await startApi(PORTS, { AGENTS_RUNNER_TEAMS: team }, join(home, 'streams'))
  check(await within(20, () => fetch(API).then(() => true, () => false)), 'the API starts')
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home, AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude-hooks.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json') },
  }))
  check(await within(20, async () => (await row('select status from instances where name = $1', [`mac-${id}`]))?.status === 'online'), "the machine's daemon is online")
  for (const engine of engines) await run(engine)
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await api?.stop()
  await sleep(500)
  if (!failures.length) await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
  await db.end().catch(() => undefined)
}

console.log(`\nscreenshots in test/ui-shots\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test team removed)'}`)
process.exit(failures.length ? 1 : 0)
