// Phase 3 step 9: refinement, with the stand-in for Claude. Past bug-fix runs
// each needed a reminder to report. The improve pipeline changes bug-fix's file,
// replays those past runs with the change and with the current version at the
// commits they started from, and only because the change scored better does a
// pull request reach the shepherd. Approving it makes the change current. A change
// that scores no better, and one that does not load, never reach anyone. Coach
// is checked in test/step20a.ts and test/step20b.ts.
//   npm run check:step9

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { forgeAdmin, forgeConfig } from '../server/forge.ts'
import { must } from './must.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = 7851
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 100}`
const id = randomBytes(4).toString('hex')
const team = `step9-${id}`
const login = `step9-${id}@local`
const org = forgeConfig().org
const [SHOP, PIPES] = [`shop9-${id}`, `pipes9-${id}`]
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
    'changed,nothing': [{ outcome: 'changed', summary: 'Both recent runs needed a reminder at triage, so the triage prompt now says to always call report_result.',
      replace: { [`${PIPES}/pipelines/bug-fix.ts`]: [TRIAGE_LINE, `${CLEARER} ${TRIAGE_LINE}`] } }],
  },
  Shuffle: {
    'changed,nothing': [{ outcome: 'changed', summary: 'Reworded the plan prompt.',
      replace: { [`${PIPES}/pipelines/bug-fix.ts`]: ['This bug needs a plan before anyone changes code.', 'Plan this bug before anyone changes code.'] } }],
  },
  Broken: {
    'changed,nothing': [{ outcome: 'changed', summary: 'Starts somewhere else.', replace: { [`${PIPES}/pipelines/bug-fix.ts`]: ["start: 'triage'", "start: 'nowhere'"] } }],
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

async function within(seconds: number, test: () => Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(500)
  }
  return false
}

const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T | undefined
const all = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[]

async function post(path: string, body: unknown = {}) {
  const res = await fetch(PEOPLE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

type RunRow = { id: string; status: string; note: string | null; pipeline_version_id: string; task_id: string }
const run = (runId: string) => one<RunRow>('select * from runs where id = $1', [runId])
const waitFor = async (runId: string, statuses: string[], seconds = 240) => within(seconds, async () => statuses.includes((await run(runId))?.status ?? ''))
const openAsk = (runId: string) => one<{ id: string; kind: string; payload: any }>(`select id, kind, payload from asks where run_id = $1 and status = 'open'`, [runId])
const reminders = async (runId: string) => Number((await one<{ n: number }>(
  `select count(*)::int as n from events e join run_stages s on s.session_id = e.session_id
   where s.run_id = $1 and e.kind = 'user' and e.text like 'You ended your turn without calling report_result%'`, [runId]))?.n)

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, login)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  node('server/admin.ts', 'add-agent', team, 'fixer', `mac-${id}`, '', 'You fix bugs in small JavaScript projects. Keep replies short.')
  node('server/admin.ts', 'add-agent', team, 'improver', `mac-${id}`)
  const { id: teamId } = must(await one<{ id: string }>('select id from teams where name = $1', [team]), 'teamId')

  await forgeAdmin.ensureRepo(SHOP, Object.fromEntries(['checkout.js', 'package.json', 'test/checkout.test.js']
    .map((f) => [f, readFileSync(join(ROOT, 'ops/seed/shop', f), 'utf8')])), 'step 9 shop', false)
  await forgeAdmin.ensureRepo(PIPES, {
    'shared/pipeline.ts': readFileSync(join(ROOT, 'shared/pipeline.ts'), 'utf8'),
    'pipelines/bug-fix.ts': readFileSync(join(ROOT, 'pipelines/bug-fix.ts'), 'utf8').replace("runsOn: 'box'", "runsOn: 'home'"),
    'pipelines/improve.ts': readFileSync(join(ROOT, 'pipelines/improve.ts'), 'utf8'),
  }, 'step 9 pipelines', false)
  for (const repo of [SHOP, PIPES]) await db.query('insert into repos (team_id, remote_url) values ($1, $2)', [teamId, `${forgeConfig().url}/${org}/${repo}.git`])
  const repoId = async (name: string) => must(await one<{ id: string }>('select id from repos where team_id = $1 and remote_url like $2', [teamId, `%/${name}.git`]), 'repoId').id

  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step9-')))
  writeFileSync(join(home, 'scenario.json'), JSON.stringify(SCENARIO))
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
  await within(60, async () => Number((await one<{ n: number }>(`select count(*)::int as n from pipelines where team_id = $1 and current_version_id is not null`, [teamId]))?.n) === 2)
  const pipeline = async (name: string) => must(await one<{ id: string; current_version_id: string }>('select id, current_version_id from pipelines where team_id = $1 and name = $2', [teamId, name]), 'pipeline')
  const bugFix = await pipeline('bug-fix')

  // Two past runs, each needing a reminder at triage. The shepherd turns both
  // fixes down, so main keeps the bug and both can be replayed.
  const past: string[] = []
  for (const title of ['TENOFF makes a $5 order negative', 'TENOFF goes below zero on small orders']) {
    const { runId } = await post(`/v1/pipelines/${bugFix.id}/runs`, { title, body: 'discount(5, "TENOFF") returns -5.', repoId: await repoId(SHOP) })
    past.push(runId)
    await within(240, async () => (await openAsk(runId))?.kind === 'gate')
    const gate = await openAsk(runId)
    if (gate) await post(`/v1/asks/${gate.id}/answer`, { decision: 'reject', message: 'Not this week.' })
    await waitFor(runId, ['failed'], 60)
  }
  check((await reminders(must(past[0], 'the first past run'))) === 1 && (await reminders(must(past[1], 'the second past run'))) === 1,
    'each past run needed a reminder at triage')
  const prsBefore = (await forgeAdmin.call<unknown[]>('GET', `/repos/${org}/${SHOP}/pulls?state=all&limit=50`)).length

  // The improve pipeline proposes a clearer triage prompt.
  const { runId: improve } = await post(`/v1/pipelines/${(await pipeline('improve')).id}/runs`, { title: 'Improve bug-fix', body: 'Make bug-fix runs need fewer reminders.', repoId: await repoId(PIPES) })
  const reachedGate = await within(400, async () => (await openAsk(improve))?.kind === 'gate')
  const proposal = await one<{ id: string; status: string; scores: any; diff: string; summary: string; candidate_version_id: string; base_version_id: string; pull_request: string | null }>(
    'select * from proposals where run_id = $1', [improve])
  const replays = await all<{ id: string; replay_of: string; pipeline_version_id: string; status: string; task_id: string }>(
    'select id, replay_of, pipeline_version_id, status, task_id from runs where proposal_id = $1', [proposal?.id])
  check(reachedGate && replays.length === 4 && new Set(replays.map((r) => r.replay_of)).size === 2
    && replays.filter((r) => r.pipeline_version_id === proposal?.candidate_version_id).length === 2
    && replays.filter((r) => r.pipeline_version_id === bugFix.current_version_id).length === 2,
  'the change was scored by replaying both past runs with the change and with the current version')
  const baseCommits = await all<{ replay: string; replayed: string }>(
    `select rt.base_commit as replay, ot.base_commit as replayed from runs r
     join workspaces rw on rw.task_id = r.task_id join worktrees rt on rt.workspace_id = rw.id
     join runs o on o.id = r.replay_of join workspaces ow on ow.task_id = o.task_id join worktrees ot on ot.workspace_id = ow.id
     where r.proposal_id = $1`, [proposal?.id])
  check(baseCommits.length === 4 && baseCommits.every((c) => c.replay === c.replayed), 'each replay started from the commit its past run started from')
  const prsAfter = (await forgeAdmin.call<unknown[]>('GET', `/repos/${org}/${SHOP}/pulls?state=all&limit=50`)).length
  const replayAsks = await one<{ n: number }>(`select count(*)::int as n from asks where run_id = any($1)`, [replays.map((r) => r.id)])
  check(prsAfter === prsBefore && Number(replayAsks?.n) === 0 && replays.every((r) => r.status === 'done'),
    'replays finished without opening pull requests or asking anyone')
  const { candidate, current } = proposal?.scores ?? {}
  check(candidate?.finished === 2 && current?.finished === 2 && candidate?.problems === 0 && current?.problems === 2,
    `the scores show the change needs no reminders where the current version needed two: ${JSON.stringify(proposal?.scores)}`)
  check(proposal?.diff.includes(`+`) && proposal.diff.includes(CLEARER) && proposal.status === 'open', 'the proposal carries the diff and waits for the shepherd')
  const pr = await forgeAdmin.call<{ number: number; body: string }[]>('GET', `/repos/${org}/${PIPES}/pulls?state=open`)
  const gate = await openAsk(improve)
  check(pr.length === 1 && pr[0]?.body.includes('Replayed 2 past runs') && proposal?.pull_request?.includes(`/pulls/${pr[0].number}`)
    && gate?.payload.question.includes('scored better'),
  'only then did a pull request with the scores reach the shepherd')

  if (gate) await post(`/v1/asks/${gate.id}/answer`, { decision: 'approve' })
  check(await waitFor(improve, ['done'], 120), 'approving merged the change')
  const after = await pipeline('bug-fix')
  const onForge = await forgeAdmin.call<{ sha: string }>('GET', `/repos/${org}/${PIPES}/contents/pipelines/bug-fix.ts?ref=main`)
  const approved = await one<{ status: string; decided_by: string | null }>('select status, decided_by from proposals where id = $1', [proposal?.id])
  check(after.current_version_id === proposal?.candidate_version_id && (await one<{ git_sha: string }>('select git_sha from pipeline_versions where id = $1', [after.current_version_id]))?.git_sha === onForge.sha
    && approved?.status === 'approved' && approved.decided_by,
  'the merged change is now the current version, and the proposal records who approved it')

  // The next real run uses the new version and needs no reminder.
  const { runId: next } = await post(`/v1/pipelines/${bugFix.id}/runs`, { title: 'TENOFF again after the change', body: 'Still -5.', repoId: await repoId(SHOP) })
  await within(240, async () => (await openAsk(next))?.kind === 'gate')
  check((await run(next))?.pipeline_version_id === proposal?.candidate_version_id && (await reminders(next)) === 0, 'the next bug-fix run uses the new version and needs no reminder')
  const nextGate = await openAsk(next)
  if (nextGate) await post(`/v1/asks/${nextGate.id}/answer`, { decision: 'reject' })

  // A change that scores no better, and one that does not load.
  const { runId: shuffle } = await post(`/v1/pipelines/${(await pipeline('improve')).id}/runs`, { title: 'Shuffle bug-fix wording', body: '', repoId: await repoId(PIPES) })
  const { runId: broken } = await post(`/v1/pipelines/${(await pipeline('improve')).id}/runs`, { title: 'Broken bug-fix start', body: '', repoId: await repoId(PIPES) })
  check(await waitFor(shuffle, ['failed'], 400) && (await run(shuffle))?.note?.includes('did not score better')
    && (await one<{ status: string }>('select status from proposals where run_id = $1', [shuffle]))?.status === 'rejected'
    && !(await one('select 1 from asks where run_id = $1', [shuffle])),
  'a change that scores no better is dropped without asking anyone')
  await within(120, async () => (await openAsk(broken))?.kind === 'question')
  const brokenAsk = await openAsk(broken)
  check(brokenAsk?.payload.question.includes('could not be scored') && !(await one(`select 1 from proposals where run_id = $1 and status = 'open'`, [broken])),
    `a change that does not load is caught before scoring: ${brokenAsk?.payload.question}`)
  if (brokenAsk) await post(`/v1/asks/${brokenAsk.id}/answer`, { decision: 'stop' })
  const prsNow = await forgeAdmin.call<unknown[]>('GET', `/repos/${org}/${PIPES}/pulls?state=all&limit=50`)
  check(prsNow.length === 1, 'neither of those opened a pull request')
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch(() => {})
    for (const repo of [SHOP, PIPES]) await forgeAdmin.call('DELETE', `/repos/${org}/${repo}`).catch(() => {})
  }
  await db.end().catch(() => {})
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} and repos kept)` : 'all passed (test team and repos removed)'}`)
process.exit(failures.length ? 1 : 0)
