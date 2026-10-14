// Step 13, the app. Drives the Repos page, Connect GitHub, New project, a
// project's page, New task inside a project, a task's project and repos, and the
// sidebar's projects in Chromium, WebKit and Firefox against a real API, daemon
// and runner, a fake GitHub (test/fake-github.ts) and this Mac's forge, at
// desktop and phone width. Scans for accessibility problems and takes
// screenshots, light, dark and phone, to look at.
//   node --env-file=.env --env-file=.env.test test/step13b.ts
//   AGENTS_UI_ENGINES=chromium node --env-file=.env --env-file=.env.test test/step13b.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, firefox, webkit, type BrowserType, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import pg from 'pg'
import { z } from 'zod'
import { forgeAdmin, forgeConfig } from '../server/forge.ts'
import { startFakeGithub, type FakeGithub } from './fake-github.ts'
import { must } from './must.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
const SHOTS = join(ROOT, 'test', 'ui-shots')
// This check's ports, in the projects checks' range of 7940 to 7959.
const PORT = 7950
const PEOPLE_PORT = 7951
const STREAMS_PORT = 7952
const GITHUB_PORT = 7953
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PEOPLE_PORT}`
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
const team = `proj-ui-${id}`
const owner = `proj-ui-owner-${id}@local`
const org = `proj-ui-org-${id}`
const clientId = `Iv23-proj-ui-${id}`
const giteaOrg = forgeConfig().org
const SHOP = `proj-uishop-${id}`
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step13b-')))
const peopleSocket = join(home, 'people.sock')
const githubSettings = {
  AGENTS_GITHUB_DIR: join(home, 'github-tokens'), AGENTS_GITHUB_API: `http://127.0.0.1:${GITHUB_PORT}`,
  AGENTS_GITHUB_GIT: `http://127.0.0.1:${GITHUB_PORT}`, AGENTS_GITHUB_CLIENT_ID: clientId,
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
// A dropped connection fails the check instead of ending it, so the clean-up still stops the API and daemon it started.
db.on('error', (error) => { failures.push(`Postgres dropped the check's connection: ${error.message}`) })
const children: ChildProcess[] = []
const failures: string[] = []
const shots: string[] = []
let fake: FakeGithub | undefined

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

// The environment for a process this check starts: the check's own, never
// GitHub's settings from it, plus the ones given. The Node running this check
// comes first on the PATH, so a child started as `node`, such as the fake Claude,
// runs on it rather than on whatever else the PATH holds.
function envWith(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENTS_GITHUB_'))),
    PATH: `${dirname(process.execPath)}:${must(process.env.PATH, 'a PATH')}`, ...extra,
  }
}

const admin = (...args: string[]) => execFileSync(process.execPath, ['server/admin.ts', ...args], { cwd: ROOT, env: envWith({}), encoding: 'utf8' })

async function within(seconds: number, test: () => Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(400)
  }
  return false
}

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
    && list.every((selector) => [...document.querySelectorAll(selector)].every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1)), selectors)
}

async function shot(page: Page, name: string, fullPage = false) {
  const path = join(SHOTS, `${name}.png`)
  await page.screenshot({ path, fullPage })
  shots.push(`test/ui-shots/${name}.png`)
}

const one = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0]

async function run(engine: string, github: FakeGithub) {
  const alice = `proj-ui-alice-${engine}-${id}@local`
  const ghLogin = `proj-ui-gh-${engine}-${id}`
  const name = `UI Billing ${engine} ${id}`
  const repo = `${org}/ui-billing-${engine}-${id}`
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const errors: string[] = []
  const open = async (options: Record<string, unknown> = {}) => {
    const context = await browser.newContext({ baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': alice }, viewport: { width: 1280, height: 860 }, ...options })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/')
    return page
  }
  try {
    const page = await open()

    // The Repos page, from the sidebar, says what it is and lists every repo.
    const reposEntry = page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: /^All repos/ })
    const hasEntry = await reposEntry.waitFor({ timeout: 15_000 }).then(() => true, () => false)
    if (hasEntry) await reposEntry.click()
    check(hasEntry && await visible(page, '.page-head p', 15, /Every repo your team shares is listed here/) && await visible(page, '.page-head h1', 15, /\d+ repos?/),
      `${engine}: Repos in the sidebar opens a page that says in one line what it shows and how to come back`)
    const shopRow = page.getByRole('list', { name: "The team's repos" }).locator('li', { hasText: `${giteaOrg}/${SHOP}` })
    check(await shopRow.first().waitFor({ timeout: 20_000 }).then(() => true, () => false)
      && /this Mac's forge/.test(await shopRow.first().innerText()) && /no project/.test(await shopRow.first().innerText())
      && (await shopRow.first().getByRole('link', { name: /Open on this Mac's forge/ }).getAttribute('href')) === `${forgeConfig().url}/${giteaOrg}/${SHOP}`,
    `${engine}: each repo says where it lives, its project, and links to it on its forge`)

    // Connect GitHub with a code entered on GitHub.
    await page.getByRole('button', { name: 'Connect GitHub' }).click()
    const code = await page.locator('.device-code').first().innerText({ timeout: 15_000 }).catch(() => '')
    check(/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(code.trim()) && await visible(page, 'a', 5, /Open GitHub's device page/),
      `${engine}: Connect GitHub shows the code to enter and links to GitHub's device page`)
    if (code.trim()) github.approve(code.trim(), ghLogin)
    check(await visible(page, '.github-line', 20, new RegExp(`Signed in to GitHub as ${ghLogin}`)),
      `${engine}: once the code is entered on GitHub, the page says who is signed in`)
    await shot(page, `${engine}-projects-repos-light`, true)
    check(await serious(page) === 0, `${engine}: the Repos page has no serious accessibility problems`)

    // A new project.
    await page.getByRole('button', { name: 'New project' }).click()
    const form = page.getByRole('form', { name: 'New project' })
    await form.waitFor()
    await form.getByLabel('Name', { exact: true }).fill(name)
    await form.getByLabel('What it is for').fill('Invoices and payments.')
    await form.getByLabel('GitHub organization or account').fill(org)
    check(await visible(page, 'p', 5, new RegExp(`The repo: ${repo} on GitHub`)), `${engine}: New project says where the repo will go`)
    await form.getByLabel(owner, { exact: true }).check()
    await form.getByLabel(`fixer${engine}`, { exact: true }).check()
    await shot(page, `${engine}-projects-new-light`)
    await form.getByRole('button', { name: 'Create project' }).click()
    check(await visible(page, '.page-head h1', 20, new RegExp(name)) && await visible(page, '.page-head .kicker', 5, /Project/),
      `${engine}: creating a project opens its page`)
    // The row is read as soon as it shows, so a project name that arrives later doesn't count.
    const projectRepo = page.getByRole('list', { name: "The project's repos" }).locator('li', { hasText: repo })
    const repoShows = await projectRepo.first().waitFor({ timeout: 20_000 }).then(() => true, () => false)
    const repoRow = repoShows ? await projectRepo.first().innerText() : ''
    check(repoShows && /GitHub/.test(repoRow) && repoRow.includes(name) && !repoRow.includes('no project')
      && (await projectRepo.first().getByRole('link', { name: /Open on GitHub/ }).getAttribute('href')) === `${github.url}/${repo}`,
    `${engine}: the project's page lists its GitHub repo under the project's name, with a link to it (${repoRow.replace(/\s+/g, ' ')})`)
    check(await visible(page, 'p', 10, new RegExp(`${owner}.*fixer${engine}|fixer${engine}.*${owner}`)), `${engine}: the project's page names its people and agents`)
    // The sidebar reads projects every ten seconds.
    const shows = (locator: ReturnType<Page['getByRole']>) => locator.waitFor({ timeout: 20_000 }).then(() => true, () => false)
    const projects = page.getByRole('list', { name: 'Projects' })
    check(await shows(projects.getByRole('button', { name, exact: true }))
      && await shows(page.getByRole('list', { name: `In ${name}` }).getByRole('button', { name: `# ${name}` })),
    `${engine}: the sidebar shows the project, with its room under it`)

    // A task inside the project offers only the project's repos.
    await page.locator('.head-actions').getByRole('button', { name: 'New task' }).click()
    const taskForm = page.getByRole('form', { name: 'New task' })
    await taskForm.waitFor()
    const picker = taskForm.getByRole('group', { name: 'Repos' })
    await visible(page, 'fieldset label.check', 15, new RegExp(repo))
    const options = (await picker.locator('label.check').allInnerTexts()).map((text) => text.trim())
    check(JSON.stringify(options) === JSON.stringify([repo]) && await visible(page, '.page-head', 5, new RegExp(`In ${name}`)),
      `${engine}: New task inside a project offers only that project's repos (${options.join(', ')})`)

    // A draft saved inside the project says so, and its form offers only the project's repos too.
    await taskForm.getByLabel('What needs doing?').fill(`Invoice draft ${engine}`)
    await taskForm.getByLabel('Agent').selectOption({ label: `fixer${engine}` })
    await picker.getByRole('checkbox', { name: repo }).check()
    await taskForm.getByRole('button', { name: 'Save draft' }).click()
    const draftForm = page.getByRole('form', { name: 'Edit the draft' })
    const draftOpens = await visible(page, 'form[aria-label="Edit the draft"] fieldset label.check', 20, new RegExp(repo))
    const draftOptions = draftOpens ? (await draftForm.getByRole('group', { name: 'Repos' }).locator('label.check').allInnerTexts()).map((text) => text.trim()) : []
    check(draftOpens && JSON.stringify(draftOptions) === JSON.stringify([repo]) && await visible(page, '.page-head', 5, new RegExp(`In ${name}`)),
      `${engine}: a draft saved inside a project says so, and offers only that project's repos (${draftOptions.join(', ')})`)
    await projects.getByRole('button', { name, exact: true }).click()
    await page.locator('.head-actions').getByRole('button', { name: 'New task' }).click()
    await taskForm.waitFor()
    await taskForm.getByLabel('What needs doing?').fill(`Invoice page ${engine}`)
    await taskForm.getByLabel('Agent').selectOption({ label: `fixer${engine}` })
    await picker.getByRole('checkbox', { name: repo }).check()
    await taskForm.getByRole('button', { name: 'Start task' }).click()
    check(await visible(page, '.page-head h1', 20, new RegExp(`Invoice page ${engine}`))
      && await visible(page, '.task-place', 15, new RegExp(`In ${name}\\. Works in ${repo}\\.`)),
    `${engine}: a task's page says its project and the repos it works in`)
    await shot(page, `${engine}-projects-task-light`)
    check(await shows(page.getByRole('list', { name: `In ${name}` }).getByRole('button', { name: `Invoice page ${engine}` })),
      `${engine}: the task sits under its project in the sidebar`)

    // The project's page lists the task, and keeps it whole at phone width and in the dark.
    await projects.getByRole('button', { name, exact: true }).click()
    check(await visible(page, '.run-list li', 15, new RegExp(`Invoice page ${engine}.*${repo}`)), `${engine}: the project's page lists its tasks, each with its repos`)
    await shot(page, `${engine}-projects-project-light`, true)
    check(await serious(page) === 0, `${engine}: the project's page has no serious accessibility problems`)
    const projectUrl = page.url()
    const dark = await open({ colorScheme: 'dark' })
    await dark.goto(projectUrl)
    await visible(dark, '.repo-list li', 20)
    await shot(dark, `${engine}-projects-project-dark`, true)
    const phone = await open({ viewport: { width: 390, height: 844 }, isMobile: engine !== 'firefox', hasTouch: engine !== 'firefox' })
    await phone.goto(projectUrl)
    await visible(phone, '.repo-list li', 20)
    const projectFits = await noSideScroll(phone, ['.page-head', '.page-body', '.repo-list li', '.start-run'])
    // A long list of repos beside a task must not squeeze the task's title away.
    check(await visible(phone, '.run-list li .row > span:first-child', 10, new RegExp(`Invoice page ${engine}`)),
      `${engine}: at phone width the project's tasks still show their titles`)
    await shot(phone, `${engine}-projects-project-phone`, true)
    await phone.goto('/#/repos')
    await visible(phone, '.repo-list li', 20)
    const reposFits = await noSideScroll(phone, ['.page-head', '.page-body', '.repo-list li', '.github-line'])
    await shot(phone, `${engine}-projects-repos-phone`, true)
    await phone.getByRole('button', { name: 'Menu' }).click()
    check(projectFits && reposFits && await shows(phone.getByRole('list', { name: 'Projects' }).getByRole('button', { name, exact: true })),
      `${engine}: at phone width the project's page and the Repos page fit without sideways scrolling, and the menu lists the project`)
    await shot(phone, `${engine}-projects-menu-phone`)
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
  mkdirSync(SHOTS, { recursive: true })
  await db.connect()
  execFileSync(process.execPath, ['server/migrate.ts'], { cwd: ROOT, env: envWith({}) })
  admin('add-team', team, owner)
  const { token } = z.object({ token: z.string() }).parse(JSON.parse(admin('add-instance', team, `proj-ui-mac-${id}`, 'mac', owner)))
  for (const engine of engines) {
    admin('add-person', team, `proj-ui-alice-${engine}-${id}@local`)
    admin('add-agent', team, `fixer${engine}`, `proj-ui-mac-${id}`, '', 'You fix bugs.')
  }
  const teamId = must(await one('select id from teams where name = $1', [team]), 'the team').id
  await forgeAdmin.ensureRepo(SHOP, { 'README.md': '# shop\n' }, 'step 13b shop', false)
  await db.query('insert into repos (team_id, remote_url) values ($1, $2)', [teamId, `${forgeConfig().url}/${giteaOrg}/${SHOP}.git`])
  fake = await startFakeGithub({ port: GITHUB_PORT, dir: join(home, 'github'), org, clientId, stopgap: { token: `github_pat_${'0'.repeat(82)}`, login: `proj-ui-stopgap-${id}` } })
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  children.push(spawn(process.execPath, ['server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: envWith({
      ...githubSettings, AGENTS_REPOS_CACHE_SEC: '1', AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT),
      AGENTS_PEOPLE_SOCKET: peopleSocket, AGENTS_STREAMS_PORT: String(STREAMS_PORT), AGENTS_STREAMS_DIR: join(home, 'streams'),
    }),
  }))
  // People reach the API only on its socket. This port forwards to it, as tailscale serve does.
  await servePeople(PEOPLE_PORT, peopleSocket)
  await within(20, () => fetch(API).then(() => true, () => false))
  writeFileSync(join(home, 'scenario.json'), JSON.stringify({}))
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: envWith({ AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: join(home, 'machine'), AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json') }),
  }))
  await within(20, async () => (await one('select status from instances where name = $1', [`proj-ui-mac-${id}`]))?.status === 'online')
  for (const engine of engines) await run(engine, fake)
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  await fake?.stop()
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch((error: unknown) => { console.error('removing the team:', error) })
    await forgeAdmin.call('DELETE', `/repos/${giteaOrg}/${SHOP}`).catch((error: unknown) => { console.error(`removing ${SHOP}:`, error) })
    rmSync(home, { recursive: true, force: true })
  }
  await db.end()
}

console.log(`\nscreenshots:\n${shots.join('\n')}\n${failures.length ? `${failures.length} failed (team ${team}, ${SHOP} and ${home} kept)` : 'all passed (test team, repo and folder removed)'}`)
process.exit(failures.length ? 1 : 0)
