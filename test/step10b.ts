// Phase 4 step 10, the app. Drives the agent, room, task and document views in
// Chromium, WebKit and Firefox against a real API, daemon and runner, with the
// stand-in for Claude. A person changes an agent's instructions and adds a skill,
// a plugin and a routine, saves it as a template and makes a new agent from it,
// sees the agent stop because its machine lacks the plugin's secret and sets it,
// opens a room where two agents take turns, starts a task and talks to it, and
// comments on the document it wrote. Scans for accessibility problems and takes
// screenshots (light, dark, phone) to look at.
//   npm run check:step10b
//   AGENTS_UI_ENGINES=chromium npm run check:step10b

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const PORT = 7871
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
const id = randomBytes(4).toString('hex')
const team = `step10b-${id}`
const owner = `owner10b-${id}@local`

const SCENARIO = {
  turns: [
    { match: 'You are fixer', reply: 'I will take the **checkout** bug.' },
    { match: 'You are writer', reply: 'PASS' },
    { match: 'Write the release notes', write: { 'task/notes.md': '# Release notes\n\n- TENOFF stops at zero.\n' }, reply: 'Wrote task/notes.md.' },
    { match: 'commented on ./task/notes.md', write: { 'task/notes.md': '# Release notes\n\n- TENOFF never goes below zero.\n- Faster checkout.\n' }, reply: 'Revised notes.md.' },
    { match: 'Add a line about speed', reply: 'Done.' },
  ],
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })

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

const one = async <T>(sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0] as T | undefined

async function run(engine: string, home: string) {
  const alice = `alice10b-${engine}-${id}@local`
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const errors: string[] = []
  const open = async (options: Record<string, unknown> = {}) => {
    const context = await browser.newContext({ baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': alice }, viewport: { width: 1280, height: 820 }, ...options })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/')
    return page
  }
  try {
    const page = await open()
    const agentName = `fixer${engine}`

    // An agent's setup, from its page.
    await page.getByRole('list', { name: 'Agents' }).getByRole('button', { name: agentName, exact: true }).click()
    await page.getByRole('button', { name: 'Agent setup' }).click()
    check(await visible(page, '.page-head h1', 15, new RegExp(agentName)), `${engine}: the DM opens the agent's setup page`)
    await page.getByLabel('Instructions').fill('You fix bugs. Answer with the fix first.')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    check(await visible(page, '[role="status"]', 10, /Saved/), `${engine}: saving the instructions says so`)
    check(await within(10, async () => (await one<{ instructions: string }>('select instructions from agents where team_id = (select id from teams where name = $1) and name = $2', [team, agentName]))?.instructions === 'You fix bugs. Answer with the fix first.'),
      `${engine}: the new instructions are saved`)

    await page.getByText('Add a skill').click()
    const skillForm = page.getByRole('form', { name: 'Add a skill' })
    await skillForm.getByLabel('Name', { exact: true }).fill('release-notes')
    await skillForm.getByLabel('When to use it').fill('Writing release notes')
    await skillForm.getByLabel('How to do it').fill('One line per merged pull request.')
    await skillForm.getByRole('button', { name: 'Save skill' }).click()
    check(await visible(page, '.items li', 15, /release-notes/), `${engine}: a skill added from the page shows in its list`)

    await page.getByText('Add a plugin').click()
    await page.getByRole('form', { name: 'Add a plugin' }).getByLabel('Name', { exact: true }).fill('github')
    await page.getByLabel('Command').fill('npx -y @modelcontextprotocol/server-github')
    await page.getByLabel(/from secrets/).fill('GITHUB_TOKEN=GITHUB_TOKEN')
    await page.getByRole('button', { name: 'Save plugin' }).click()
    check(await visible(page, '.items li', 15, /needs GITHUB_TOKEN on its machine/), `${engine}: a plugin shows the secret its machine must hold`)

    await page.getByText('Add a routine').click()
    await page.getByRole('form', { name: 'Add a routine' }).getByLabel('Name', { exact: true }).fill('standup')
    await page.getByLabel(/Schedule/).fill('0 9 * * 1-5')
    await page.getByLabel('What to do').fill('Say what is blocked.')
    await page.getByRole('button', { name: 'Save routine' }).click()
    check(await visible(page, '.items li', 15, /standup/), `${engine}: a routine shows with its schedule`)
    await page.screenshot({ path: join(SHOTS, `${engine}-agent-light.png`), fullPage: true })
    check(await serious(page) === 0, `${engine}: the agent page has no serious accessibility problems`)

    await page.getByRole('button', { name: 'Save as template' }).click()
    check(await visible(page, '[role="status"]', 10, /version 1/), `${engine}: saving as a template says which version`)

    // A new agent from that template.
    await page.getByRole('button', { name: 'New agent' }).click()
    const newAgent = page.getByRole('form', { name: 'New agent' })
    await newAgent.waitFor()
    await newAgent.getByLabel('Name').fill(`copy${engine}`)
    await newAgent.getByLabel('Start from').selectOption({ label: `The template "${agentName}", version 1` })
    await newAgent.getByRole('button', { name: 'Create agent' }).click()
    check(await visible(page, '.page-head h1', 15, new RegExp(`copy${engine}`)) && await visible(page, '.items li', 10, /release-notes/),
      `${engine}: a new agent made from the template has its skills`)

    // The plugin's secret is not on the machine yet, so the agent stops and says what to set.
    rmSync(join(home, 'secrets.json'), { force: true })
    await page.getByRole('list', { name: 'Agents' }).getByRole('button', { name: agentName, exact: true }).click()
    await page.getByRole('textbox', { name: 'Message' }).fill('Are you there?')
    await page.getByRole('textbox', { name: 'Message' }).press('Enter')
    check(await visible(page, 'li.message.stopped', 30, /no value for GITHUB_TOKEN/) && !await page.locator('li.message.typing').count(),
      `${engine}: an agent that cannot start says why, and stops showing as thinking`)
    await page.screenshot({ path: join(SHOTS, `${engine}-stopped-light.png`) })
    writeFileSync(join(home, 'secrets.json'), JSON.stringify({ GITHUB_TOKEN: 'step10b-not-a-real-token' }))
    await page.getByRole('textbox', { name: 'Message' }).fill('Try again.')
    await page.getByRole('textbox', { name: 'Message' }).press('Enter')
    check(await visible(page, 'li.message.agent', 30, /fake reply/) && await within(10, async () => !await page.locator('li.message.stopped').count()),
      `${engine}: with the secret set on its machine, the agent answers`)

    // A room with two agents, who take turns.
    await page.getByRole('button', { name: 'New room' }).click()
    const newRoom = page.getByRole('form', { name: 'New room' })
    await newRoom.waitFor()
    await newRoom.getByLabel('Name').fill(`launch-${engine}`)
    await newRoom.getByLabel(agentName, { exact: true }).check()
    await newRoom.getByLabel(`writer${engine}`, { exact: true }).check()
    await newRoom.getByRole('button', { name: 'Create room' }).click()
    check(await visible(page, '.conversation-head h1', 15, new RegExp(`# launch-${engine}`)), `${engine}: creating a room opens it`)
    await page.getByRole('textbox', { name: 'Message' }).fill('What should we ship this week?')
    await page.getByRole('textbox', { name: 'Message' }).press('Enter')
    check(await visible(page, 'li.message.agent strong', 60, /checkout/), `${engine}: an agent's turn appears in the room, rendered`)
    const roomId = page.url().split('/c/')[1]?.split('/')[0] ?? ''
    check(await within(30, async () => (await one<{ n: number }>(`select count(*)::int as n from turns where conversation_id = $1 and outcome = 'pass'`, [roomId]))?.n === 1)
      && !(await page.locator('li.message', { hasText: /^PASS$/ }).count()),
    `${engine}: the second agent passed, and its pass is not shown`)
    await page.screenshot({ path: join(SHOTS, `${engine}-room-light.png`) })

    // A task, talked to, with a document that gets a comment.
    await page.getByRole('button', { name: 'New task' }).click()
    const newTask = page.getByRole('form', { name: 'New task' })
    await newTask.waitFor()
    await newTask.getByLabel('What needs doing?').fill('Write the release notes')
    await newTask.getByLabel('Agent').selectOption({ label: agentName })
    await newTask.getByRole('button', { name: 'Start task' }).click()
    check(await visible(page, '.page-head h1', 15, /Write the release notes/) && await visible(page, '.task-messages li.message.agent', 60, /notes\.md/),
      `${engine}: a new task opens, and the agent's reply arrives`)
    check(await visible(page, '.artifacts li', 30, /notes\.md/), `${engine}: the document the task wrote is listed`)
    await page.getByRole('textbox', { name: 'Message' }).fill('Add a line about speed.')
    await page.getByRole('button', { name: 'Send' }).click()
    check(await visible(page, '.task-messages li.message.person', 15, /Add a line about speed/), `${engine}: a person's message to the task shows`)
    await page.locator('.artifacts').getByRole('button', { name: 'notes.md' }).click()
    check(await visible(page, 'aside.panel .markdown h3', 15, /Release notes/), `${engine}: the document opens beside the task, rendered`)
    await page.getByLabel('Quote (optional)').fill('TENOFF stops at zero.')
    await page.getByLabel(/Comment on version/).fill('Say it never goes below zero.')
    await page.getByRole('button', { name: 'Comment', exact: true }).click()
    check(await visible(page, '.comment', 15, /never goes below zero/) && await visible(page, '.comment', 5, /sent to the agent/),
      `${engine}: a comment sent to the agent shows on the document`)
    check(await visible(page, '#doc-version', 60), `${engine}: the agent's revision appears as a second version`)
    await page.screenshot({ path: join(SHOTS, `${engine}-task-document-light.png`) })
    check(await serious(page) === 0, `${engine}: the task page has no serious accessibility problems`)

    const taskUrl = page.url().replace(/\/d\/[^/]+$/, '')
    const dark = await open({ colorScheme: 'dark' })
    await dark.goto(taskUrl)
    await visible(dark, '.task-messages li', 15)
    await dark.screenshot({ path: join(SHOTS, `${engine}-task-dark.png`) })
    const phone = await open({ viewport: { width: 390, height: 844 }, isMobile: engine !== 'firefox', hasTouch: engine !== 'firefox' })
    await phone.goto(taskUrl)
    await visible(phone, '.task-messages li', 15)
    const fits = await noSideScroll(phone, ['.page-head', '.page-body', '.composer'])
    await phone.screenshot({ path: join(SHOTS, `${engine}-task-phone.png`) })
    check(fits, `${engine}: at phone width the task page fits without sideways scrolling`)

    check(errors.length === 0, `${engine}: no page errors${errors.length ? ` (${errors.join('; ')})` : ''}`)
  } finally {
    await browser.close()
  }
}

async function within(seconds: number, test: () => Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(400)
  }
  return false
}

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  mkdirSync(SHOTS, { recursive: true })
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, owner)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', owner)) as { token: string }
  for (const engine of engines) {
    node('server/admin.ts', 'add-person', team, `alice10b-${engine}-${id}@local`)
    node('server/admin.ts', 'add-agent', team, `fixer${engine}`, `mac-${id}`, '', 'You fix bugs.')
    node('server/admin.ts', 'add-agent', team, `writer${engine}`, `mac-${id}`, '', 'You write docs.')
  }
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step10b-')))
  writeFileSync(join(home, 'scenario.json'), JSON.stringify(SCENARIO))
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  children.push(spawn(process.execPath, ['--env-file=.env', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'), AGENTS_STREAMS_PORT: String(PORT + 1), AGENTS_STREAMS_DIR: join(home, 'streams') },
  }))
  await servePeople(PORT + 100, join(home, 'people.sock'))
  await within(20, () => fetch(API).then(() => true, () => false))
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home, AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json') },
  }))
  await within(20, async () => (await one<{ status: string }>('select status from instances where name = $1', [`mac-${id}`]))?.status === 'online')
  for (const engine of engines) await run(engine, home)
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
