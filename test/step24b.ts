// Agent setup and copies, the app. Drives the hooks and the copy control on the agent's
// page in Chromium, WebKit and Firefox, at desktop and phone width, against a real API
// and daemon with the stand-in for Claude and its hooks. The agent's owner adds two
// hooks and takes one off. A teammate sees the hooks and none of the controls that would
// change them. The teammate copies the agent with the team's memories, opens the copy,
// finds its hooks and the team's memories and none about a person, talks to it, and
// reads the hook's run in its session. Scans for accessibility problems and takes
// screenshots to look at.
//   node --env-file=.env --env-file=.env.test test/step24b.ts
//   AGENTS_UI_ENGINES=chromium node --env-file=.env --env-file=.env.test test/step24b.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, firefox, webkit, type BrowserType, type Page } from '@playwright/test'
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
  const [alice, bob] = [`alice24b-${engine}-${id}@local`, `bob24b-${engine}-${id}@local`]
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

    // Alice, the owner, adds hooks from the agent's page.
    const page = await open(alice)
    await page.goto(`/#/a/${source}`)
    check(await visible(page, '.page-head h1', 20, new RegExp(name)) && await visible(page, 'ul.items[aria-label="Hooks"] li.empty', 15, /No hooks yet/),
      `${engine}: the agent's page lists its hooks, and says there are none yet`)
    await page.getByText('Add a hook').click()
    const form = page.getByRole('form', { name: 'Add a hook' })
    await form.getByLabel('Name', { exact: true }).fill('note-prompts')
    check(await form.getByLabel('Only for these tools (optional)').count() === 0, `${engine}: a hook for a message takes no tools to match`)
    await form.getByLabel('What it runs').fill('mkdir -p task && echo noted >> task/hook-log.txt')
    await form.getByRole('button', { name: 'Save hook' }).click()
    check(await visible(page, 'ul.items[aria-label="Hooks"] li', 15, /note-prompts.*A message arrives/s), `${engine}: a hook added from the page shows in its list with when it runs`)
    await form.getByLabel('Name', { exact: true }).fill('stamp-writes')
    await form.getByLabel('Runs when').selectOption({ label: 'After a tool runs' })
    await form.getByLabel('Only for these tools (optional)').fill('Write')
    await form.getByLabel('What it runs').fill('mkdir -p task && echo wrote >> task/hook-log.txt')
    await form.getByLabel('Time limit in seconds (optional)').fill('20')
    await form.getByRole('button', { name: 'Save hook' }).click()
    check(await visible(page, 'ul.items[aria-label="Hooks"] li', 15, /stamp-writes.*After a tool runs · Write/s), `${engine}: a hook for a tool shows the tools it matches`)
    const stored = await row('select event, matcher, timeout_sec as limit from agent_hooks where agent_id = $1 and name = $2', [source, 'stamp-writes'])
    check(stored?.event === 'PostToolUse' && stored.matcher === 'Write' && stored.limit === 20, `${engine}: the hook is saved with its event, matcher and time limit`)
    await form.getByLabel('Name', { exact: true }).fill('Not A Name')
    await form.getByLabel('What it runs').fill('true')
    await form.getByRole('button', { name: 'Save hook' }).click()
    check(await visible(page, '[role="alert"]', 10, /hook name is lowercase letters, digits and dashes/), `${engine}: a hook the server refuses says why in the form`)
    await form.getByLabel('Name', { exact: true }).fill('scratch')
    await form.getByRole('button', { name: 'Save hook' }).click()
    await visible(page, 'ul.items[aria-label="Hooks"] li', 15, /scratch/)
    await page.locator('ul.items[aria-label="Hooks"] li', { hasText: 'scratch' }).getByRole('button', { name: 'Remove' }).click()
    check(await within(15, async () => !(await page.locator('ul.items[aria-label="Hooks"] li', { hasText: 'scratch' }).count())), `${engine}: Remove takes a hook off the agent`)
    await page.screenshot({ path: join(SHOTS, `${engine}-hooks-light.png`), fullPage: true })
    check(await serious(page) === 0, `${engine}: the agent page with hooks has no serious accessibility problems`)

    // Bob sees the hooks and none of the controls that change them, and copies the agent.
    const bobPage = await open(bob)
    await bobPage.goto(`/#/a/${source}`)
    check(await visible(bobPage, 'ul.items[aria-label="Hooks"] li', 20, /stamp-writes/)
      && !await bobPage.getByText('Add a hook').count() && !await bobPage.locator('ul.items[aria-label="Hooks"]').getByRole('button', { name: 'Remove' }).count()
      && await visible(bobPage, 'p', 5, /only the agent's owner or a team admin changes them/),
    `${engine}: a teammate reads the hooks, and is told who changes them instead of being offered the controls`)
    const copyButton = bobPage.getByRole('button', { name: 'Copy', exact: true })
    check(await copyButton.getAttribute('aria-expanded') === 'false', `${engine}: Copy starts closed`)
    await copyButton.click()
    const copyForm = bobPage.getByRole('form', { name: 'Copy this agent' })
    await copyForm.waitFor()
    check(await copyButton.getAttribute('aria-expanded') === 'true' && await copyForm.getByLabel('Name of the copy').inputValue() === copyName
      && (await copyForm.getByLabel('Machine for the copy').locator('option:checked').textContent()) === `mac-${id}`
      && await copyForm.getByLabel(/With the team's memories \(2\)/).isChecked() === false,
    `${engine}: the copy form starts with a name, a machine, and the team's memories counted and not chosen`)
    await bobPage.screenshot({ path: join(SHOTS, `${engine}-copy-light.png`), fullPage: true })
    await copyForm.getByLabel(/With the team's memories/).check()
    await copyForm.getByRole('button', { name: 'Copy agent' }).click()
    check(await visible(bobPage, '[role="status"]', 20, new RegExp(`Copied as ${copyName}\\. It carries 1 skill, 1 plugin, 1 routine, 2 hooks, 2 team memories\\.`)),
      `${engine}: copying says what the copy carries`)
    await bobPage.screenshot({ path: join(SHOTS, `${engine}-copied-light.png`) })
    await bobPage.getByRole('button', { name: `Open ${copyName}` }).click()
    check(await visible(bobPage, '.page-head h1', 20, new RegExp(copyName)) && await visible(bobPage, '.page-head p', 10, new RegExp(`Copied from ${name}`)),
      `${engine}: the copy opens, and says which agent it was copied from`)
    check(await visible(bobPage, 'ul.items[aria-label="Hooks"] li', 15, /note-prompts/) && await visible(bobPage, 'ul.items li', 5, /release-style/)
      && await visible(bobPage, 'ul.items[aria-label="Hooks"] li', 5, /stamp-writes.*After a tool runs · Write/s) && await visible(bobPage, '.items li', 5, /fmt/),
    `${engine}: the copy lists the skill, the plugin and both hooks`)
    check(await visible(bobPage, 'ul.memories li', 15, new RegExp(TEAM_NOTE)) && await bobPage.locator('ul.memories li').count() === 2
      && !(await bobPage.locator('ul.memories').innerText()).includes(ABOUT_ALICE),
    `${engine}: the copy remembers what the team told the agent, and nothing about a person`)
    check(await bobPage.getByText('Add a hook').count() === 1, `${engine}: Bob owns the copy, so he is offered the hook controls there`)
    await copyButton.click()
    await copyForm.getByLabel('Name of the copy').fill(name)
    await copyForm.getByRole('button', { name: 'Copy agent' }).click()
    check(await visible(bobPage, '[role="alert"]', 15, new RegExp(`there is already an agent named ${name}`)), `${engine}: a copy with a name that is taken says so in the form`)

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
    await visible(dark, 'ul.items[aria-label="Hooks"] li', 20)
    await dark.screenshot({ path: join(SHOTS, `${engine}-hooks-dark.png`), fullPage: true })
    const phone = await open(alice, { viewport: { width: 390, height: 844 }, isMobile: engine !== 'firefox', hasTouch: engine !== 'firefox' })
    await phone.goto(`/#/a/${source}`)
    await visible(phone, 'ul.items[aria-label="Hooks"] li', 20, /note-prompts/)
    await phone.getByText('Add a hook').click()
    await phone.getByRole('button', { name: 'Copy', exact: true }).click()
    await phone.getByRole('form', { name: 'Copy this agent' }).waitFor()
    await phone.screenshot({ path: join(SHOTS, `${engine}-hooks-phone.png`), fullPage: true })
    check(await noSideScroll(phone, ['.page-head', '.page-body', '.items']), `${engine}: at phone width the agent page, with the hook and copy forms open, fits without sideways scrolling`)
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
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', admin))
  for (const engine of engines) {
    node('server/admin.ts', 'add-person', team, `alice24b-${engine}-${id}@local`)
    node('server/admin.ts', 'add-person', team, `bob24b-${engine}-${id}@local`)
  }
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
