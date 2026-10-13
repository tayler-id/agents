// Phase 2 step 6, the app. Drives the pipeline and run views in Chromium, WebKit
// and Firefox against a real API, daemon, forge and runner, with the stand-in for
// Claude. A person starts a bug-fix run from the app, watches its stages arrive
// live, approves its gate, opens a stage's session, reads the plan an agent
// wrote, rejects a plan with a note, and claims a box. Scans for accessibility
// problems and takes screenshots (light, dark, phone) to look at.
//   npm run check:step6b
//   AGENTS_UI_ENGINES=chromium npm run check:step6b

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
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
const SHOTS = join(ROOT, 'test', 'ui-shots')
const PORT = 7831
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
const team = `step6b-${id}`
const owner = `owner6b-${id}@local`
const org = forgeConfig().org
const PIPES = `pipes6b-${id}`
const shopOf = (engine: string) => `shop6b-${engine}-${id}`

const TEST_FILE = `const test = require('node:test')
const assert = require('node:assert')
const { discount } = require('../checkout.js')

test('TENOFF never goes below zero', () => assert.strictEqual(discount(5, 'TENOFF'), 0))
`
const PLAN = '# Plan\n\nMove tax rates into **one table** per country.\n\n- Add `rates.js`\n- Read it in `total()`\n'
const scenarioFor = (repo: string) => ({
  TENOFF: {
    // Slow enough that the page sees the stages arrive, in every browser.
    'new,duplicate,already_fixed,not_a_bug': [{ outcome: 'new', summary: 'A new bug in discount().', sleepMs: 4000 }],
    'easy,hard,cannot_reproduce': [{ outcome: 'easy', sleepMs: 4000, write: { [`${repo}/test/tenoff.test.js`]: TEST_FILE }, data: { test_command: 'node --test test/tenoff.test.js', suite_command: 'npm test' } }],
    'fixed,stuck': [{ outcome: 'fixed', summary: 'TENOFF now stops at **zero**.', sleepMs: 4000, replace: { [`${repo}/checkout.js`]: ['amount - 10', 'Math.max(0, amount - 10)'] } }],
  },
  PLANME: {
    'new,duplicate,already_fixed,not_a_bug': [{ outcome: 'new' }],
    'easy,hard,cannot_reproduce': [{ outcome: 'hard', summary: 'Needs a tax table per country.' }],
    planned: [{ outcome: 'planned', write: { 'task/plan.md': PLAN } }],
  },
})

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

async function noSideScroll(page: Page, selectors: string[]) {
  return page.evaluate((list) => document.documentElement.scrollWidth <= window.innerWidth
    && list.every((selector) => {
      const el = document.querySelector(selector)
      return !el || el.getBoundingClientRect().right <= window.innerWidth + 1
    }), selectors)
}

async function serious(page: Page) {
  const axe = await new AxeBuilder({ page }).analyze()
  const found = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  for (const v of found) console.log(`      ${v.id}: ${v.help} (${v.nodes.length}) ${JSON.stringify(v.nodes[0]?.target)}`)
  return found.length
}

async function startRun(page: Page, engine: string, title: string) {
  await page.getByRole('list', { name: 'Pipelines' }).getByRole('button', { name: 'bug-fix', exact: true }).click()
  await page.getByLabel('What should it work on?').fill(title)
  await page.getByLabel('Details').fill('A $5 order with TENOFF comes to -$5.00.')
  await page.getByLabel('Repo').selectOption({ label: `${org}/${shopOf(engine)}` })
  await page.getByRole('button', { name: 'Start', exact: true }).click()
}

async function run(engine: string) {
  const alice = `alice6b-${engine}-${id}@local`
  const amir = `amir6b-${engine}-${id}@local`
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const errors: string[] = []
  // Live shape requests still open, by page. Each holds one of the browser's six connections.
  const liveOpen = new Map<Page, Set<unknown>>()
  const open = async (login: string, options: Record<string, unknown> = {}) => {
    const context = await browser.newContext({ baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': login }, viewport: { width: 1280, height: 820 }, ...options })
    const page = await context.newPage()
    const pending = new Set<unknown>()
    liveOpen.set(page, pending)
    page.on('request', (r) => { if (r.url().includes('/v1/shape/') && r.url().includes('live=true')) pending.add(r) })
    page.on('requestfinished', (r) => pending.delete(r))
    page.on('requestfailed', (r) => pending.delete(r))
    page.on('pageerror', (error) => errors.push(`${login}: ${error.message}`))
    await page.goto('/')
    return page
  }
  try {
    const page = await open(alice)
    check(await visible(page, '.list button', 20, /^bug-fix$/), `${engine}: the pipelines list shows bug-fix`)
    await page.getByRole('list', { name: 'Pipelines' }).getByRole('button', { name: 'bug-fix', exact: true }).click()
    check(await visible(page, 'table.versions tbody tr.current', 15), `${engine}: the pipeline page shows its current version`)
    await page.screenshot({ path: join(SHOTS, `${engine}-pipeline-light.png`) })
    check(await serious(page) === 0, `${engine}: the pipeline page has no serious accessibility problems`)

    const title = `TENOFF-${engine} goes negative`
    await startRun(page, engine, title)
    check(await visible(page, '.page-head h1', 15, new RegExp(title)), `${engine}: starting a run opens its page`)
    check(await visible(page, '.page-head .muted', 15, /started \d{1,2}:\d{2}/), `${engine}: the run shows the time it started`)

    // A teammate sees the new run in their list without reloading.
    const teammate = await open(amir)
    check(await visible(teammate, 'nav .list button', 20, new RegExp(engine)), `${engine}: a teammate sees the run in their runs list`)

    // Stages arrive while the page stays open.
    const counts: number[] = []
    for (let i = 0; i < 60 && !(await page.locator('section.ask-card').count()); i++) {
      counts.push(await page.locator('.stages li.stage').count())
      await sleep(500)
    }
    check(counts.length > 1 && Math.max(...counts) > Math.min(...counts), `${engine}: stages appear live (${[...new Set(counts)].join(' → ')})`)
    const gate = await visible(page, 'section.ask-card', 60, /ready for review/)
    check(gate && await visible(page, 'section.ask-card a', 5, /Pull request #/), `${engine}: the gate asks for a decision and links the pull request`)
    await page.screenshot({ path: join(SHOTS, `${engine}-run-gate-light.png`) })
    await page.getByRole('button', { name: 'Approve' }).click()
    check(await visible(page, '.note-line', 60, /Fixed and merged/) && await visible(page, '.facts dd', 5, /\$/),
      `${engine}: approving finishes the run, with its note and cost`)
    check(await visible(page, '.artifacts li', 15, /merged/), `${engine}: the merged pull request is listed as made by the run`)

    await page.locator('li.stage', { hasText: /^fix/ }).getByRole('button', { name: 'Open session' }).click()
    check(await visible(page, 'aside.panel .event', 15, /Tool · Edit/), `${engine}: a stage's session opens beside the run`)
    await page.screenshot({ path: join(SHOTS, `${engine}-run-session-light.png`) })
    check(await serious(page) === 0, `${engine}: the run page has no serious accessibility problems`)
    const runUrl = page.url().replace(/\/s\/[^/]+$/, '')

    // The plan path: a document, and a gate rejected with a note.
    await startRun(page, engine, `PLANME-${engine} taxes`)
    check(await visible(page, '.artifacts li', 60, /plan\.md/), `${engine}: the plan the agent wrote is listed`)
    await page.locator('.artifacts').getByRole('button', { name: 'plan.md' }).click()
    check(await visible(page, 'aside.panel .markdown h3', 15, /Plan/) && await visible(page, 'aside.panel .markdown strong', 5, /one table/),
      `${engine}: the document opens beside the run, rendered`)
    await page.screenshot({ path: join(SHOTS, `${engine}-document-light.png`) })
    await page.getByLabel('Note').fill('Needs a design review first.')
    await page.getByRole('button', { name: 'Reject' }).click()
    check(await visible(page, '.note-line', 30, /rejected the plan/), `${engine}: rejecting the plan with a note ends the run`)
    const { rows: [answered] } = await db.query(
      `select a.answer->>'message' as message from asks a join runs r on r.id = a.run_id join tasks t on t.id = r.task_id
       where t.title = $1 and a.kind = 'gate'`, [`PLANME-${engine} taxes`])
    check(answered?.message === 'Needs a design review first.', `${engine}: the note is kept with the answer`)

    // The pipeline's room has the runs' posts.
    await page.getByRole('list', { name: 'Conversations' }).getByRole('button', { name: '# bug-fix' }).click()
    check(await visible(page, 'li.message.agent', 15, /Fixed and merged/), `${engine}: the pipeline's room shows the runs' progress`)

    // After visiting runs, sessions, a document and a room, only the open view's
    // live shapes may hold connections. The rest must have closed.
    await page.getByRole('list', { name: 'Pipelines' }).getByRole('button', { name: 'bug-fix', exact: true }).click()
    await sleep(4000)
    const held = must(liveOpen.get(page), 'held').size
    check(held <= 3, `${engine}: views you left hold no live connections (${held} open)`)

    // A box, claimed and released from the machines list.
    const machines = page.getByRole('list', { name: 'Machines' })
    const claims: string[] = []
    page.on('response', (r) => { if (/\/(claim|release)$/.test(r.url())) claims.push(`${r.status()} ${r.url().split('/').pop()}`) })
    await machines.getByRole('button', { name: 'Claim' }).click()
    const claimed = await machines.getByRole('button', { name: 'Release' }).waitFor({ timeout: 15000 }).then(() => true, () => false)
      && (await db.query(`select 1 from instances i join people p on p.id = i.claimed_by where i.name = $1 and p.login = $2`, [`box-${id}`, alice])).rows.length > 0
    if (!claimed) {
      await page.screenshot({ path: join(SHOTS, `${engine}-claim-failed.png`) })
      console.log(`      claim responses: ${claims.join(', ') || 'none'}; machines: ${JSON.stringify(await machines.innerText())}`)
    }
    check(claimed, `${engine}: claiming a box makes it yours`)
    await machines.getByRole('button', { name: 'Release' }).click()
    check(await machines.getByRole('button', { name: 'Claim' }).waitFor({ timeout: 15000 }).then(() => true, () => false), `${engine}: releasing it gives it back`)

    const dark = await open(alice, { colorScheme: 'dark' })
    await dark.goto(runUrl)
    await visible(dark, 'li.stage', 15)
    await dark.screenshot({ path: join(SHOTS, `${engine}-run-dark.png`) })
    const phone = await open(alice, { viewport: { width: 390, height: 844 }, isMobile: engine !== 'firefox', hasTouch: engine !== 'firefox' })
    await phone.goto(runUrl)
    await visible(phone, 'li.stage', 15)
    const runFits = await noSideScroll(phone, ['.page-head', '.page-body', '.stages', '.facts'])
    await phone.screenshot({ path: join(SHOTS, `${engine}-run-phone.png`) })
    await phone.getByRole('button', { name: 'Pipeline' }).click()
    await visible(phone, 'table.versions', 15)
    const pipelineFits = await noSideScroll(phone, ['.page-head', '.start-run'])
    await phone.screenshot({ path: join(SHOTS, `${engine}-pipeline-phone.png`) })
    check(runFits && pipelineFits, `${engine}: at phone width the run and pipeline pages fit without sideways scrolling`)

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
  for (const engine of engines) {
    node('server/admin.ts', 'add-person', team, `alice6b-${engine}-${id}@local`)
    node('server/admin.ts', 'add-person', team, `amir6b-${engine}-${id}@local`)
  }
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', owner))
  node('server/admin.ts', 'add-agent', team, 'fixer', `mac-${id}`)
  const { rows: [{ id: teamId }] } = await db.query('select id from teams where name = $1', [team])
  await db.query(`insert into instances (team_id, name, kind, token_sha256) values ($1, $2, 'box', $3)`, [teamId, `box-${id}`, randomBytes(16).toString('hex')])

  const shopFiles = Object.fromEntries(['checkout.js', 'package.json', 'test/checkout.test.js']
    .map((f) => [f, readFileSync(join(ROOT, 'ops/seed/shop', f), 'utf8')]))
  for (const engine of engines) {
    await forgeAdmin.ensureRepo(shopOf(engine), shopFiles, 'step 6b shop', false)
    await db.query('insert into repos (team_id, remote_url) values ($1, $2)', [teamId, `${forgeConfig().url}/${org}/${shopOf(engine)}.git`])
  }
  await forgeAdmin.ensureRepo(PIPES, {
    'shared/pipeline.ts': readFileSync(join(ROOT, 'shared/pipeline.ts'), 'utf8'),
    'pipelines/bug-fix.ts': readFileSync(join(ROOT, 'pipelines/bug-fix.ts'), 'utf8').replace("runsOn: 'box'", "runsOn: 'home'"),
  }, 'step 6b pipelines', false)
  await db.query('insert into repos (team_id, remote_url) values ($1, $2)', [teamId, `${forgeConfig().url}/${org}/${PIPES}.git`])

  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step6b-')))
  // Each engine's runs edit their own repo, so each engine has its own groups.
  const scenarioFile = join(home, 'scenario.json')
  writeFileSync(scenarioFile, JSON.stringify(Object.fromEntries(engines.flatMap((engine) =>
    Object.entries(scenarioFor(shopOf(engine))).map(([name, steps]) => [`${name}-${engine}`, steps])))))
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  const env = { ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'), AGENTS_STREAMS_PORT: String(PORT + 1), AGENTS_STREAMS_DIR: join(home, 'streams') }
  children.push(spawn(process.execPath, ['server/api.ts'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] }))
  await servePeople(PORT + 100, join(home, 'people.sock'))
  for (let i = 0; i < 80 && !(await fetch(API).then(() => true, () => false)); i++) await sleep(250)
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home, AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: scenarioFile },
  }))
  for (let i = 0; i < 120; i++) {
    if ((await db.query(`select 1 from pipelines where team_id = $1 and current_version_id is not null`, [teamId])).rows.length) break
    await sleep(500)
  }
  for (const engine of engines) await run(engine)
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  // The box the machines list claimed is removed whatever happened, or it would keep calling a closed port.
  const boxes = await db.query<{ id: string }>(`select i.id from instances i join teams t on t.id = i.team_id where t.name = $1 and i.kind = 'box'`, [team]).catch(() => ({ rows: [] }))
  for (const { id: boxId } of boxes.rows) {
    for (const args of [['rm', '-f', `agents-box-${boxId}`], ['volume', 'rm', `agents-box-${boxId}-home`]]) {
      try {
        execFileSync('docker', args, { stdio: 'ignore' })
      } catch {
        // Already gone, or never started.
      }
    }
  }
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch(() => {})
    for (const repo of [PIPES, ...engines.map(shopOf)]) await forgeAdmin.call('DELETE', `/repos/${org}/${repo}`).catch(() => {})
  }
  await db.end().catch(() => {})
}

console.log(`\nscreenshots in test/ui-shots\n${failures.length ? `${failures.length} failed (team ${team} and repos kept)` : 'all passed (test team and repos removed)'}`)
process.exit(failures.length ? 1 : 0)
