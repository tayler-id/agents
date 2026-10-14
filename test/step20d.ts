// Evidence, part 5: the proposal page. Chromium starts coach from its pipeline's
// page, over plain HTTP. The run page shows the proposal once it has won its
// replays: both versions' scores, and the hunk with its diff, the quotes it rests
// on and its counts of sessions and people. The person turns the hunk down with a
// reason, approves the gate, and the agent is left as it was. The page fits a
// phone. WebKit and Firefox show the settled proposal. Scans for accessibility
// problems and takes screenshots.
//   node --env-file=.env --env-file=.env.test test/step20d.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
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
const PORT = 8086
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
const id = randomBytes(4).toString('hex')
const team = `evd-d-${id}`
const [aliceLogin, bobLogin] = [`alice-${id}@local`, `bob-${id}@local`]
const org = forgeConfig().org
const PIPES = `pipes20d-${id}`
const INSTRUCTIONS = 'You fix bugs in small JavaScript projects.\n\n- Keep replies short.'

const british = { match: 'No, use British English', kind: 'gap', correction: 'Write in British English.', same: 'british', fix: 'text' }
const SCENARIO = {
  turns: [
    { match: 'release note', reply: 'Release note: added a color picker.', replyIf: { 'Write in British English': 'Release note: added a colour picker.' } },
  ],
  CoachPage: {
    read: [{ outcome: 'read', summary: 'Read the sessions.', findings: [british, { ...british, match: 'Please use British English' }] }],
    'changed,nothing': [{ outcome: 'changed', summary: 'Two people asked for British English in separate sessions.',
      hunks: [{ op: 'add', text: '- Write in British English.', cite: ['British'] }] }],
    judged: [{ outcome: 'judged', summary: 'Judged each reply.', verdicts: { fixedIf: 'colour' } }],
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
const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T | undefined

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

async function post(login: string, path: string, body: unknown) {
  const res = await fetch(PEOPLE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

async function browse(engine: string, url: string, errors: string[]) {
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const context = await browser.newContext({ baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': aliceLogin }, viewport: { width: 1280, height: 900 } })
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
  node('server/admin.ts', 'add-team', team, aliceLogin)
  node('server/admin.ts', 'add-person', team, bobLogin)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', aliceLogin))
  node('server/admin.ts', 'add-agent', team, 'fixer', `mac-${id}`, '', INSTRUCTIONS)
  node('server/admin.ts', 'add-agent', team, 'improver', `mac-${id}`)
  const teamId = must(await one<{ id: string }>('select id from teams where name = $1', [team]), 'the team').id
  const fixer = must(await one<{ id: string }>(`select id from agents where team_id = $1 and name = 'fixer'`, [teamId]), 'fixer').id
  await forgeAdmin.ensureRepo(PIPES, {
    'shared/pipeline.ts': readFileSync(join(ROOT, 'shared/pipeline.ts'), 'utf8'),
    'pipelines/coach.ts': readFileSync(join(ROOT, 'pipelines/coach.ts'), 'utf8'),
  }, 'step 20d pipelines', false)
  await db.query('insert into repos (team_id, remote_url) values ($1, $2)', [teamId, `${forgeConfig().url}/${org}/${PIPES}.git`])
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step20d-')))
  writeFileSync(join(home, 'scenario.json'), JSON.stringify(SCENARIO))
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  children.push(spawn(process.execPath, ['--env-file=.env', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'), AGENTS_STREAMS_PORT: String(PORT + 2), AGENTS_STREAMS_DIR: join(home, 'streams') },
  }))
  await servePeople(PORT + 1, join(home, 'people.sock'))
  await within(20, () => fetch(API).then(() => true, () => false))
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home, AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json') },
  }))
  await within(60, async () => (await one(`select 1 from pipelines where team_id = $1 and name = 'coach' and current_version_id is not null`, [teamId])) !== undefined)

  // Two people correct fixer the same way, in their own DMs.
  for (const [login, ask, correction] of [[aliceLogin, 'Write the release note for 1.2', 'No, use British English: colour, not color.'],
    [bobLogin, 'Write the release note for 1.3', 'Please use British English, colour not color.']] as const) {
    const { conversationId } = await post(login, '/v1/conversations', { kind: 'dm', agent: 'fixer' })
    for (const text of [ask, correction]) {
      const replies = async () => Number((await one<{ n: number }>(`select count(*)::int as n from messages where conversation_id = $1 and speaker = 'agent'`, [conversationId]))?.n)
      const before = await replies()
      await post(login, `/v1/conversations/${conversationId}/messages`, { text, clientId: randomUUID() })
      if (!await within(60, async () => await replies() > before)) throw new Error(`fixer never answered "${text}"`)
    }
  }
  await db.query(`update sessions set last_active_at = now() - interval '2 hours' where agent_id = $1`, [fixer])

  const errors: string[] = []
  const { browser, page } = await browse('chromium', '/', errors)
  let runId = ''
  try {
    // Coach starts from its pipeline's page.
    await page.getByRole('list', { name: 'Pipelines' }).getByRole('button', { name: 'coach', exact: true }).click()
    await page.getByLabel('What should it work on?').fill('CoachPage fixer')
    await page.getByLabel('Details').fill('Look at the last week.')
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    check(await visible(page, 'section.proposal', 300, /waiting for the shepherd/), 'the run page shows the proposal once it has won its replays')
    runId = must(await one<{ id: string }>(`select r.id from runs r join pipeline_versions v on v.id = r.pipeline_version_id
      join pipelines p on p.id = v.pipeline_id where p.team_id = $1 and p.name = 'coach'`, [teamId]), 'the coach run').id
    check(await visible(page, 'section.proposal .kicker', 10, /Proposed change to fixer/), 'the proposal says which agent it changes')
    const scores = page.locator('table.scores')
    check(await visible(page, 'table.scores tbody tr', 10, /With the change/) && /With the change\s+0 of 2/.test(await scores.innerText())
      && /Current\s+2 of 2/.test(await scores.innerText()),
    `both versions' scores show how many corrections were still needed: ${(await scores.innerText().catch(() => '')).replace(/\s+/g, ' ')}`)
    const hunk = page.getByRole('listitem', { name: 'Hunk 1' })
    check(await visible(page, 'li.hunk', 10, /Add a rule/) && (await hunk.innerText()).includes("2 sessions: 2 people's, 0 pipeline, 0 box · 2 people"),
      `the hunk shows its sessions and its people, counted apart: ${(await hunk.innerText().catch(() => '')).split('\n')[0] ?? ''}`)
    check(await visible(page, 'li.hunk .diff .added', 10, /\+- Write in British English\./), "the hunk's diff shows the added rule")
    const quotes = await page.getByRole('list', { name: 'What hunk 1 rests on' }).innerText()
    check(quotes.includes('No, use British English') && quotes.includes('Please use British English') && quotes.includes(aliceLogin) && quotes.includes(bobLogin),
      'the hunk shows the quotes it rests on, and who said them')
    check(await visible(page, 'section.ask-card', 10, /Keep or turn down each hunk/), 'the gate sits beside the proposal')
    await page.screenshot({ path: join(SHOTS, 'chromium-hunks-light.png'), fullPage: true })
    check(await serious(page) === 0, 'chromium: the proposal page has no serious accessibility problems')

    // Turning the hunk down needs a reason.
    check(await visible(page, 'li.hunk .decide', 10), 'at the gate a person can keep or turn down each hunk')
    const turnDown = hunk.getByRole('button', { name: 'Turn down' })
    check(await turnDown.isDisabled(), 'turning a hunk down waits for a reason')
    await hunk.getByLabel('Why, for hunk 1').fill('We write American English.')
    await turnDown.click()
    check(await visible(page, 'li.hunk .decision', 30, /Turned down by .*We write American English\./), 'the hunk shows it was turned down, by whom and why')
    const decided = await one<{ decision: string; reason: string; login: string }>(
      `select h.decision, h.reason, p.login from proposal_hunks h join people p on p.id = h.decided_by join proposals pr on pr.id = h.proposal_id
       where pr.run_id = $1`, [runId])
    check(decided?.decision === 'rejected' && decided.reason === 'We write American English.' && decided.login === aliceLogin, 'the decision is stored on the hunk')

    // The page fits a phone: nothing scrolls sideways, and every part of the
    // proposal ends inside the screen. A diff and a table scroll inside themselves.
    await page.setViewportSize({ width: 390, height: 844 })
    const fits = await page.evaluate(() => {
      const body = document.querySelector('.page-body')
      const inside = (selector: string) => [...document.querySelectorAll(selector)].every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1)
      return document.documentElement.scrollWidth <= window.innerWidth && (!body || body.scrollWidth <= body.clientWidth + 1)
        && ['section.proposal', 'li.hunk', '.quotes', '.decide', '.decision'].every(inside)
    })
    check(fits, 'at phone width the page is no wider than the screen')
    await page.screenshot({ path: join(SHOTS, 'chromium-hunks-phone.png'), fullPage: true })
    await page.setViewportSize({ width: 1280, height: 900 })

    await page.getByRole('button', { name: 'Approve' }).click()
    check(await visible(page, '.note-line', 120, /kept the agent as it is/), 'approving with the only hunk turned down leaves the agent as it was')
    check((await one<{ instructions: string }>('select instructions from agents where id = $1', [fixer]))?.instructions === INSTRUCTIONS, "fixer's instructions are unchanged")
  } finally {
    await browser.close()
  }

  // WebKit and Firefox show the settled proposal.
  for (const engine of ['webkit', 'firefox']) {
    const other = await browse(engine, `/#/r/${runId}`, errors)
    try {
      check(await visible(other.page, 'section.proposal', 30, /turned down/) && await visible(other.page, 'li.hunk .decision', 10, /Turned down by/)
        && await visible(other.page, 'table.scores tbody tr', 10, /Current/), `${engine}: the run page shows the settled proposal with its decision and scores`)
      await other.page.screenshot({ path: join(SHOTS, `${engine}-hunks-light.png`), fullPage: true })
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
    await forgeAdmin.call('DELETE', `/repos/${org}/${PIPES}`).catch(() => undefined)
  }
  await db.end().catch(() => undefined)
}

console.log(`\nscreenshots in test/ui-shots\n${failures.length ? `${failures.length} failed (team ${team} and repo kept)` : 'all passed (test team and repo removed)'}`)
process.exit(failures.length ? 1 : 0)
