// Step 14, the app: the README acceptance check, from what Tayler did on the live
// server on 2026-10-13. A person asks a task for a README in a test repo, sees
// README.md in the task's Changes, opens it rendered beside the task, reads its
// diff, opens a code file with line numbers and highlighting, opens a document
// from the task folder in the same panel, clicks Open pull request, and sees the
// pull request on the task. In Chromium, Firefox and WebKit, at desktop and
// phone width, with an accessibility scan and screenshots to look at.
//   node --env-file=.env --env-file=.env.test test/step14b.ts
//   AGENTS_UI_ENGINES=chromium node --env-file=.env --env-file=.env.test test/step14b.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, firefox, webkit, type BrowserType, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import pg from 'pg'
import { forgeAdmin, forgeConfig } from '../server/forge.ts'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
const SHOTS = join(ROOT, 'test', 'ui-shots')
// Ports 7960 to 7979 are this step's. This check: machines, people, streams.
const PORT = 7965
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const INSECURE = `http://agents.test:${PORT + 1}`
const ORIGINS: Record<string, string> = { chromium: INSECURE, firefox: INSECURE, webkit: PEOPLE }
const LAUNCH: Record<string, Record<string, unknown>> = {
  chromium: { args: ['--host-resolver-rules=MAP agents.test 127.0.0.1'] },
  firefox: { firefoxUserPrefs: { 'network.dns.localDomains': 'agents.test' } },
  webkit: {},
}
const ENGINES: Record<string, BrowserType> = { chromium, webkit, firefox }
const engines = (process.env.AGENTS_UI_ENGINES ?? 'chromium,webkit,firefox').split(',')
const id = randomBytes(4).toString('hex')
const team = `flow-ui-${id}`
const owner = `owner-flowui-${id}@local`
const REPO = `flow-readme-${id}`
const org = forgeConfig().org

const README = '# Shop\n\nCheckout math for the shop.\n\n- `total()` adds tax\n- `discount()` takes codes\n'
const HELLO = "// Says hello.\nconst greeting = 'hello'\nexport function hello() {\n  return greeting\n}\n"
const SCENARIO = {
  turns: [{
    match: 'Create a README',
    write: { [`${REPO}/README.md`]: README, [`${REPO}/scripts/hello.js`]: HELLO, 'task/notes.md': '# Notes\n\nThe README covers checkout.\n' },
    reply: 'Wrote README.md, a script and notes.',
  }],
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

async function noSideScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth
    && [...document.querySelectorAll('.page-head, .page-body, .panel, .code, .diff-view')].every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1))
}

async function within(seconds: number, test: () => Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(400)
  }
  return false
}

const one = async <T>(sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0] as T | undefined

async function run(engine: string) {
  const alice = `alice-flowui-${engine}-${id}@local`
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
    const title = `Create a README for the repo (${engine})`
    await page.getByRole('button', { name: 'New task' }).click()
    const form = page.getByRole('form', { name: 'New task' })
    await form.waitFor()
    await form.getByLabel('What needs doing?').fill(title)
    await form.getByLabel(`${org}/${REPO}`).check()
    await form.getByRole('button', { name: 'Start task' }).click()
    check(await visible(page, '.page-head h1', 15, /Create a README/) && await visible(page, '.task-messages li.message.agent', 60, /Wrote README\.md/),
      `${engine}: the task starts on the picked repo, and the agent's reply arrives`)

    const changes = page.getByRole('region', { name: 'Changes' })
    check(await visible(page, 'section[aria-label="Changes"] button', 30, /README\.md/) && await changes.getByRole('button', { name: /README\.md/ }).textContent().then((t) => t?.includes('added')),
      `${engine}: README.md shows in the task's Changes, as added`)
    await page.screenshot({ path: join(SHOTS, `${engine}-task-changes-light.png`), fullPage: true })

    await changes.getByRole('button', { name: /README\.md/ }).click()
    const panel = page.getByRole('complementary', { name: 'File' })
    check(await visible(page, 'aside[aria-label="File"] .markdown h3', 15, /^Shop$/) && await visible(page, 'aside[aria-label="File"] .markdown code', 5, /total\(\)/)
      && (await panel.getByRole('tab', { name: 'File' }).getAttribute('aria-selected')) === 'true',
    `${engine}: README.md opens beside the task, rendered`)
    await page.screenshot({ path: join(SHOTS, `${engine}-readme-file-light.png`) })

    // Keyboard, as the tabs pattern has it: Right moves to Diff.
    await panel.getByRole('tab', { name: 'File' }).focus()
    await page.keyboard.press('ArrowRight')
    check(await visible(page, 'aside[aria-label="File"] .diff-line.added', 10, /# Shop/)
      && (await panel.getByRole('tab', { name: 'Diff' }).getAttribute('aria-selected')) === 'true'
      && (await panel.locator('.diff-line.added').count()) === README.split('\n').length - 1,
    `${engine}: the Diff tab shows every line of README.md as added against the base branch`)
    await page.screenshot({ path: join(SHOTS, `${engine}-readme-diff-light.png`) })
    check(await serious(page) === 0, `${engine}: the task page with the file panel open has no serious accessibility problems`)

    await changes.getByRole('button', { name: /hello\.js/ }).click()
    const code = page.locator('aside[aria-label="File"] .code')
    check(await visible(page, 'aside[aria-label="File"] .code .tok-keyword', 15, /^const$/)
      && await code.locator('.code-line').count() === 5 && await code.locator('.code-line .ln').first().textContent() === '1'
      && await visible(page, 'aside[aria-label="File"] .code .tok-string', 2, /'hello'/) && await visible(page, 'aside[aria-label="File"] .code .tok-comment', 2, /Says hello/),
    `${engine}: a code file shows with line numbers and highlighting`)
    await page.screenshot({ path: join(SHOTS, `${engine}-code-file-light.png`) })

    await page.getByRole('list', { name: 'Made by this task' }).getByRole('button', { name: 'notes.md' }).click()
    check(await visible(page, 'aside[aria-label="Document"] [role="tab"][aria-selected="true"]', 15, /File/)
      && await visible(page, 'aside[aria-label="Document"] .markdown h3', 5, /Notes/),
    `${engine}: a document from the task folder opens in the same kind of panel`)

    await page.getByRole('button', { name: 'Close' }).click()
    await page.getByRole('button', { name: 'Open pull request' }).click()
    check(await visible(page, 'section[aria-label="Pull requests"] a', 60, new RegExp(`Pull request #\\d+ on ${org}/${REPO}`)),
      `${engine}: clicking Open pull request puts the pull request on the task`)
    const taskId = page.url().split('/t/')[1]?.split('/')[0] ?? ''
    const slug = (await one<{ slug: string }>('select slug from tasks where id = $1', [taskId]))?.slug
    const pulls = await forgeAdmin.call<{ number: number; head: { ref: string } }[]>('GET', `/repos/${org}/${REPO}/pulls?state=open`)
    const pull = pulls.find((p) => p.head.ref === `task/${slug ?? ''}`)
    const files = pull ? await forgeAdmin.call<{ filename: string }[]>('GET', `/repos/${org}/${REPO}/pulls/${pull.number}/files`) : []
    check(files.some((f) => f.filename === 'README.md'), `${engine}: the forge has the pull request with README.md`)
    await page.screenshot({ path: join(SHOTS, `${engine}-task-pull-request-light.png`), fullPage: true })

    const taskUrl = page.url()
    const dark = await open({ colorScheme: 'dark' })
    await dark.goto(taskUrl)
    await visible(dark, 'section[aria-label="Changes"] button', 20)
    await dark.getByRole('region', { name: 'Changes' }).getByRole('button', { name: /hello\.js/ }).click()
    await visible(dark, 'aside[aria-label="File"] .code', 15)
    await dark.screenshot({ path: join(SHOTS, `${engine}-code-file-dark.png`) })

    const phone = await open({ viewport: { width: 390, height: 844 }, isMobile: engine !== 'firefox', hasTouch: engine !== 'firefox' })
    await phone.goto(taskUrl)
    await visible(phone, 'section[aria-label="Changes"] button', 20)
    const taskFits = await noSideScroll(phone)
    await phone.screenshot({ path: join(SHOTS, `${engine}-task-changes-phone.png`), fullPage: true })
    await phone.getByRole('region', { name: 'Changes' }).getByRole('button', { name: /README\.md/ }).click()
    const opened = await visible(phone, 'aside[aria-label="File"] .markdown h3', 15, /Shop/)
    const panelFits = await noSideScroll(phone)
    await phone.screenshot({ path: join(SHOTS, `${engine}-readme-file-phone.png`) })
    await phone.getByRole('tab', { name: 'Diff' }).click()
    const diffShown = await visible(phone, 'aside[aria-label="File"] .diff-line.added', 10)
    const diffFits = await noSideScroll(phone)
    await phone.screenshot({ path: join(SHOTS, `${engine}-readme-diff-phone.png`) })
    check(taskFits && opened && panelFits && diffShown && diffFits, `${engine}: at phone width the Changes, the file and its diff fit without sideways scrolling`)
    await phone.getByRole('button', { name: 'Close' }).click()
    check(await visible(phone, 'section[aria-label="Changes"]', 10), `${engine}: closing the panel on a phone goes back to the task`)

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
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, owner)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `flow-mac-${id}`, 'mac', owner)) as { token: string }
  for (const engine of engines) node('server/admin.ts', 'add-person', team, `alice-flowui-${engine}-${id}@local`)
  node('server/admin.ts', 'add-agent', team, 'writer', `flow-mac-${id}`, '', 'You write docs.')
  const seed = (file: string) => readFileSync(join(ROOT, 'ops/seed/shop', file), 'utf8')
  await forgeAdmin.ensureRepo(REPO, { 'checkout.js': seed('checkout.js'), 'package.json': seed('package.json') }, 'step 14b', false)
  const { id: teamId } = must(await one<{ id: string }>('select id from teams where name = $1', [team]), 'the team')
  await db.query('insert into repos (team_id, remote_url) values ($1, $2)', [teamId, `${forgeConfig().url}/${org}/${REPO}.git`])

  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step14b-')))
  writeFileSync(join(home, 'scenario.json'), JSON.stringify(SCENARIO))
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  children.push(spawn(process.execPath, ['--env-file=.env', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_PORT: String(PORT + 1), AGENTS_STREAMS_PORT: String(PORT + 2), AGENTS_STREAMS_DIR: join(home, 'streams') },
  }))
  await within(20, () => fetch(API).then(() => true, () => false))
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home, AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json') },
  }))
  await within(20, async () => (await one<{ status: string }>('select status from instances where name = $1', [`flow-mac-${id}`]))?.status === 'online')
  for (const engine of engines) await run(engine)
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack ?? ''}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
    await forgeAdmin.call('DELETE', `/repos/${org}/${REPO}`).catch(() => undefined)
  }
  await db.end().catch(() => undefined)
}

console.log(`\nscreenshots in test/ui-shots\n${failures.length ? `${failures.length} failed (team ${team} and repo ${REPO} kept)` : 'all passed (test team and repo removed)'}`)
process.exit(failures.length ? 1 : 0)
