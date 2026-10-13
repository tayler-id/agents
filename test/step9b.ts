// Phase 3 step 9, the app. A person starts the improve pipeline from its page in
// Chromium. The run page shows the proposed change with its scores and diff
// beside the gate, and approving it there makes the change the pipeline's current
// version. WebKit and Firefox then open the same pages and must show the same
// proposal. Scans for accessibility problems and takes screenshots.
//   npm run check:step9b

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
const PORT = 7881
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
const id = randomBytes(4).toString('hex')
const team = `step9b-${id}`
const login = `step9b-${id}@local`
const org = forgeConfig().org
const [SHOP, PIPES] = [`shop9b-${id}`, `pipes9b-${id}`]
const CLEARER = 'Always call report_result when you finish.'
const TRIAGE_LINE = 'Decide what this report is, without changing any code:'
const TEST_FILE = `const test = require('node:test')
const assert = require('node:assert')
const { discount } = require('../checkout.js')

test('TENOFF never goes below zero', () => assert.strictEqual(discount(5, 'TENOFF'), 0))
`
const SCENARIO = {
  TENOFF: {
    'new,duplicate,already_fixed,not_a_bug': [{ outcome: 'new', reportOnlyIf: CLEARER, summary: 'A new bug.' }],
    'easy,hard,cannot_reproduce': [{ outcome: 'easy', write: { [`${SHOP}/test/tenoff.test.js`]: TEST_FILE }, data: { test_command: 'node --test test/tenoff.test.js', suite_command: 'npm test' } }],
    'fixed,stuck': [{ outcome: 'fixed', summary: 'TENOFF stops at zero.', replace: { [`${SHOP}/checkout.js`]: ['amount - 10', 'Math.max(0, amount - 10)'] } }],
  },
  Improve: {
    'changed,nothing': [{ outcome: 'changed', summary: 'Both runs needed a reminder at triage, so the triage prompt now says to always call report_result.',
      replace: { [`${PIPES}/pipelines/bug-fix.ts`]: [TRIAGE_LINE, `${CLEARER} ${TRIAGE_LINE}`] } }],
  },
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
const one = async <T>(sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0] as T | undefined

async function within(seconds: number, test: () => Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(500)
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

async function post(path: string, body: unknown) {
  const res = await fetch(PEOPLE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json() as Promise<Record<string, string>>
}

async function browse(engine: string, url: string, errors: string[]) {
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const context = await browser.newContext({ baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': login }, viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(`${engine}: ${error.message}`))
  await page.goto(url)
  return { browser, page }
}

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  mkdirSync(SHOTS, { recursive: true })
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, login)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login)) as { token: string }
  node('server/admin.ts', 'add-agent', team, 'fixer', `mac-${id}`)
  node('server/admin.ts', 'add-agent', team, 'improver', `mac-${id}`)
  const teamId = must(await one<{ id: string }>('select id from teams where name = $1', [team]), 'the team').id
  await forgeAdmin.ensureRepo(SHOP, Object.fromEntries(['checkout.js', 'package.json', 'test/checkout.test.js']
    .map((f) => [f, readFileSync(join(ROOT, 'ops/seed/shop', f), 'utf8')])), 'step 9b shop', false)
  await forgeAdmin.ensureRepo(PIPES, {
    'shared/pipeline.ts': readFileSync(join(ROOT, 'shared/pipeline.ts'), 'utf8'),
    'pipelines/bug-fix.ts': readFileSync(join(ROOT, 'pipelines/bug-fix.ts'), 'utf8').replace("runsOn: 'box'", "runsOn: 'home'"),
    'pipelines/improve.ts': readFileSync(join(ROOT, 'pipelines/improve.ts'), 'utf8'),
  }, 'step 9b pipelines', false)
  for (const repo of [SHOP, PIPES]) await db.query('insert into repos (team_id, remote_url) values ($1, $2)', [teamId, `${forgeConfig().url}/${org}/${repo}.git`])
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step9b-')))
  writeFileSync(join(home, 'scenario.json'), JSON.stringify(SCENARIO))
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  children.push(spawn(process.execPath, ['--env-file=.env', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'), AGENTS_STREAMS_PORT: String(PORT + 1), AGENTS_STREAMS_DIR: join(home, 'streams'), AGENTS_REPLAYS: '2' },
  }))
  await servePeople(PORT + 100, join(home, 'people.sock'))
  await within(20, () => fetch(API).then(() => true, () => false))
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home, AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json') },
  }))
  await within(60, async () => (await one<{ n: number }>(`select count(*)::int as n from pipelines where team_id = $1 and current_version_id is not null`, [teamId]))?.n === 2)
  const pipelineId = async (name: string) => must(await one<{ id: string }>('select id from pipelines where team_id = $1 and name = $2', [teamId, name]), name).id
  const shopRepo = must(await one<{ id: string }>('select id from repos where team_id = $1 and remote_url like $2', [teamId, `%/${SHOP}.git`]), 'the shop repo').id

  // Two past runs that each needed a reminder, both turned down so main keeps the bug.
  const past: string[] = []
  for (const title of ['TENOFF makes a $5 order negative', 'TENOFF goes below zero']) {
    const { runId } = await post(`/v1/pipelines/${await pipelineId('bug-fix')}/runs`, { title, body: 'discount(5) is -5.', repoId: shopRepo })
    past.push(must(runId, 'the past run'))
    await within(240, () => one(`select 1 from asks where run_id = $1 and kind = 'gate' and status = 'open'`, [runId]))
    const gate = await one<{ id: string }>(`select id from asks where run_id = $1 and kind = 'gate' and status = 'open'`, [runId])
    if (gate) await post(`/v1/asks/${gate.id}/answer`, { decision: 'reject' })
    await within(60, async () => (await one<{ status: string }>('select status from runs where id = $1', [runId]))?.status === 'failed')
  }
  // The study cites the step of each past run where triage needed its reminder.
  const { rows: nudges } = await db.query<{ session_id: string; seq: number }>(
    `select e.session_id, e.seq::int from events e join run_stages s on s.session_id = e.session_id
     where s.run_id = any($1) and e.kind = 'user' and e.text like 'You ended your turn without calling report_result%' order by e.id`, [past])
  for (const step of SCENARIO.Improve['changed,nothing']) {
    Object.assign(step, { data: { findings: nudges.map((n) => ({ kind: 'ignored', session: n.session_id, step: n.seq, quote: 'You ended your turn without calling report_result', note: 'Triage needed a reminder to report.' })) } })
  }
  writeFileSync(join(home, 'scenario.json'), JSON.stringify(SCENARIO))

  const errors: string[] = []
  // Chromium drives the improvement from the improve pipeline's page.
  const { browser, page } = await browse('chromium', '/', errors)
  try {
    await page.getByRole('list', { name: 'Pipelines' }).getByRole('button', { name: 'improve', exact: true }).click()
    await page.getByLabel('What should it work on?').fill('Improve bug-fix')
    await page.getByLabel('Details').fill('Make bug-fix runs need fewer reminders.')
    await page.getByLabel('Repo').selectOption({ label: `${org}/${PIPES}` })
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    check(await visible(page, 'section.proposal', 400, /waiting for the shepherd/), 'the run page shows the proposed change once it has scored')
    const scores = page.locator('table.scores')
    check(await visible(page, 'table.scores tbody tr', 10, /With the change/) && /2 of 2/.test(await scores.innerText()),
      `the proposal shows both versions' scores: ${(await scores.innerText().catch(() => '')).replace(/\s+/g, ' ')}`)
    check(await visible(page, '.diff .added', 10, /Always call report_result/), "the proposal's diff shows the added line")
    check(await visible(page, 'section.ask-card', 10, /scored better/), 'the gate to approve it sits beside the proposal')
    await page.screenshot({ path: join(SHOTS, 'chromium-proposal-light.png'), fullPage: true })
    check(await serious(page) === 0, 'chromium: the proposal page has no serious accessibility problems')
    await page.getByRole('button', { name: 'Approve' }).click()
    check(await visible(page, '.note-line', 120, /now the current version/), 'approving in the app merges the change')
    await page.getByRole('list', { name: 'Pipelines' }).getByRole('button', { name: 'bug-fix', exact: true }).click()
    check(await visible(page, 'section.proposal', 30, /approved/) && await visible(page, 'table.versions tbody tr.current', 10),
      "the bug-fix page shows the approved change and its new current version")
    await page.screenshot({ path: join(SHOTS, 'chromium-pipeline-proposal-light.png'), fullPage: true })
  } finally {
    await browser.close()
  }

  // WebKit and Firefox show the same proposal.
  const improveRun = must(await one<{ id: string }>(
    `select r.id from runs r join pipeline_versions v on v.id = r.pipeline_version_id join pipelines p on p.id = v.pipeline_id
     where p.team_id = $1 and p.name = 'improve'`, [teamId]), 'the improve run').id
  for (const engine of ['webkit', 'firefox']) {
    const other = await browse(engine, `/#/r/${improveRun}`, errors)
    try {
      check(await visible(other.page, 'section.proposal', 30, /approved/) && await visible(other.page, 'table.scores tbody tr', 10, /Current/)
        && await visible(other.page, '.diff summary', 10), `${engine}: the run page shows the approved proposal with its scores and diff`)
      await other.page.screenshot({ path: join(SHOTS, `${engine}-proposal-light.png`), fullPage: true })
      check(await serious(other.page) === 0, `${engine}: the proposal page has no serious accessibility problems`)
    } finally {
      await other.browser.close()
    }
  }
  check(errors.length === 0, `no page errors${errors.length ? ` (${errors.join('; ')})` : ''}`)
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack ?? ''}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
    for (const repo of [SHOP, PIPES]) await forgeAdmin.call('DELETE', `/repos/${org}/${repo}`).catch(() => undefined)
  }
  await db.end().catch(() => undefined)
}

console.log(`\nscreenshots in test/ui-shots\n${failures.length ? `${failures.length} failed (team ${team} and repos kept)` : 'all passed (test team and repos removed)'}`)
process.exit(failures.length ? 1 : 0)
