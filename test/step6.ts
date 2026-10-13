// Phase 2 step 6: the factory, with a stand-in for Claude (test/fake-claude.ts).
// Bug reports arrive by forge webhook, by a pipeline's own webhook and by hand,
// and the team's real bug-fix pipeline runs them on a machine's daemon: real
// clones through the git proxy, real test runs as checks, a real pull request
// opened and merged on the forge, and gates a person answers. Covers loops and
// their caps, reminders, the spend cap, documents, closing duplicates,
// cancelling, cron, broken pipeline versions, and an API restart mid-run.
//   npm run check:step6

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { forge, forgeAdmin, forgeConfig } from '../server/forge.ts'
import { hookSecret } from '../server/hooks.ts'
import { lastFire } from '../shared/cron.ts'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = 7821
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 100}`
const id = randomBytes(4).toString('hex')
const [team, otherTeam] = [`step6-${id}`, `step6x-${id}`]
const [login, outsider] = [`step6-${id}@local`, `outsider6-${id}@local`]
const [SHOP, PIPES] = [`shop-${id}`, `pipes-${id}`]
const org = forgeConfig().org

const TEST_FILE = `const test = require('node:test')
const assert = require('node:assert')
const { discount } = require('../checkout.js')

test('TENOFF never goes below zero', () => assert.strictEqual(discount(5, 'TENOFF'), 0))
`
const TRIAGE = 'new,duplicate,already_fixed,not_a_bug'
const REPRODUCE = 'easy,hard,cannot_reproduce'
const FIX = 'fixed,stuck'
const reproduced = { outcome: 'easy', write: { 'SHOP/test/tenoff.test.js': TEST_FILE }, data: { test_command: 'node --test test/tenoff.test.js', suite_command: 'npm test' } }
const SCENARIO = {
  TENOFF: {
    [TRIAGE]: [{ outcome: 'new', noReport: true, summary: 'A new bug in discount().' }],
    [REPRODUCE]: [reproduced],
    [FIX]: [
      { outcome: 'fixed', summary: 'First try.', replace: { 'SHOP/checkout.js': ['amount - 10', 'amount - 9'] } },
      { outcome: 'fixed', summary: 'TENOFF now stops at zero.', replace: { 'SHOP/checkout.js': ['amount - 9', 'Math.max(0, amount - 10)'] } },
    ],
  },
  LOOPY: { [TRIAGE]: [{ outcome: 'new' }], [REPRODUCE]: [reproduced], [FIX]: [{ outcome: 'fixed', summary: 'Changed nothing.' }] },
  PRICEY: { [TRIAGE]: [{ outcome: 'new', cost: 6 }] },
  PLANME: {
    [TRIAGE]: [{ outcome: 'new' }],
    [REPRODUCE]: [{ outcome: 'hard', summary: 'Needs a tax table per country.' }],
    planned: [{ outcome: 'planned', write: { 'task/plan.md': '# Plan\n\nMove tax rates into a table per country.\n' } }],
  },
  DUPE: { [TRIAGE]: [{ outcome: 'duplicate', summary: 'This is the TENOFF bug again, already reported.', data: { duplicate_of: 1 } }] },
  // Still working whenever the check gets to it, however long the earlier runs took.
  SLOW: { [TRIAGE]: [{ outcome: 'new', sleepMs: 900_000 }] },
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []
let api: ChildProcess | undefined

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

async function as(who: string, path: string, body: unknown = {}) {
  return fetch(PEOPLE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': who }, body: JSON.stringify(body) })
}
async function post(path: string, body: unknown = {}) {
  const res = await as(login, path, body)
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

function startApi() {
  api = spawn(process.execPath, ['--env-file=.env', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    // No Claude token for boxes here, whatever this Mac has, so box runs stop at once.
    env: { ...process.env, AGENTS_BOX_TOKEN_FILE: join(home, 'no-box-token'), AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_PORT: String(PORT + 100), AGENTS_STREAMS_PORT: String(PORT + 1), AGENTS_STREAMS_DIR: join(home, 'streams') },
  })
  children.push(api)
  return within(20, () => fetch(API).then(() => true, () => false))
}

// What Gitea sends for an issue, signed the way Gitea signs it.
async function deliverIssue(issue: { number: number; title: string; body: string; html_url: string }, signature?: string) {
  const body = JSON.stringify({
    action: 'opened', issue: { ...issue, labels: [{ name: 'bug' }], user: { login: 'reporter' } },
    repository: { clone_url: `${forgeConfig().url}/${org}/${SHOP}.git` },
  })
  return fetch(`${API}/v1/hooks/forge`, {
    method: 'POST', body,
    headers: {
      'content-type': 'application/json', 'x-gitea-event': 'issues',
      'x-gitea-signature': signature ?? createHmac('sha256', forgeConfig().webhookSecret).update(body).digest('hex'),
    },
  })
}

async function openIssue(title: string, body: string) {
  return forgeAdmin.call<{ number: number; title: string; body: string; html_url: string }>(
    'POST', `/repos/${org}/${SHOP}/issues`, { title, body })
}

const runOf = (taskTitle: string) => one<{ id: string; status: string; note: string | null; task_id: string; pipeline_version_id: string; metrics: any; trigger: string }>(
  'select r.* from runs r join tasks t on t.id = r.task_id join teams tm on tm.id = r.team_id where tm.name = $1 and t.title = $2', [team, taskTitle])
const waitStatus = async (runId: string, statuses: string[], seconds = 300) =>
  within(seconds, async () => statuses.includes((await one('select status from runs where id = $1', [runId]))?.status))
const openAsk = (runId: string) => one<{ id: string; kind: string; payload: any }>(
  `select id, kind, payload from asks where run_id = $1 and status = 'open' order by created_at desc limit 1`, [runId])
const stagesOf = (runId: string) => all<{ stage: string; kind: string; status: string; outcome: string | null; session_id: string | null; summary: string | null; attempt: number }>(
  'select stage, kind, status, outcome, session_id, summary, attempt from run_stages where run_id = $1 order by n', [runId])

const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step6-')))
// ps cuts long command lines short unless told not to, and the home folder comes late in them.
const agentProcesses = () => execFileSync('ps', ['-axww', '-o', 'command'], { encoding: 'utf8' }).split('\n')
  .filter((l) => l.includes('fake-claude') && l.includes(home)).length
// Stopped from outside, still take the API and daemon down with it.
process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, login)
  node('server/admin.ts', 'add-team', otherTeam, outsider)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  node('server/admin.ts', 'add-agent', team, 'fixer', `mac-${id}`)
  const { id: teamId } = must(await one<{ id: string }>('select id from teams where name = $1', [team]), 'the team')

  // The forge: a shop repo with the bug, and a pipelines repo with the team's
  // bug-fix pipeline, set to run on the agent's home machine, plus a nightly check.
  const shopFiles: Record<string, string> = {
    'checkout.js': readFileSync(join(ROOT, 'ops/seed/shop/checkout.js'), 'utf8'),
    'package.json': readFileSync(join(ROOT, 'ops/seed/shop/package.json'), 'utf8'),
    'test/checkout.test.js': readFileSync(join(ROOT, 'ops/seed/shop/test/checkout.test.js'), 'utf8'),
  }
  await forgeAdmin.ensureRepo(SHOP, shopFiles, 'step 6 shop', false)
  const bugFix = readFileSync(join(ROOT, 'pipelines/bug-fix.ts'), 'utf8').replace("runsOn: 'box'", "runsOn: 'home'")
  const minute = new Date(Date.now() + 2 * 60_000)
  const nightly = `export default {
  description: 'Runs the shop tests every night.',
  agent: 'fixer', runsOn: 'home', spendCapUsd: 1,
  triggers: [{ kind: 'cron', schedule: '${minute.getMinutes()} ${minute.getHours()} * * *', title: 'Nightly tests', repo: '${org}/${SHOP}' }],
  start: 'tests',
  stages: { tests: { kind: 'check', command: () => 'npm test', next: { passes: { done: 'succeeded', note: 'All tests pass.' }, fails: { handoff: 'Tests fail on main.' } } } },
}
`
  const boxed = `export default {
  description: 'Runs on a box.',
  agent: 'fixer', runsOn: 'box', spendCapUsd: 1,
  triggers: [{ kind: 'manual' }],
  start: 'tests',
  stages: { tests: { kind: 'check', command: () => 'true', next: { passes: { done: 'succeeded', note: 'ok' }, fails: { done: 'failed', note: 'no' } } } },
}
`
  await forgeAdmin.ensureRepo(PIPES, {
    'shared/pipeline.ts': readFileSync(join(ROOT, 'shared/pipeline.ts'), 'utf8'),
    'pipelines/bug-fix.ts': bugFix, 'pipelines/nightly.ts': nightly, 'pipelines/boxed.ts': boxed,
  }, 'step 6 pipelines', false)
  for (const repo of [SHOP, PIPES]) {
    await db.query('insert into repos (team_id, remote_url) values ($1, $2)', [teamId, `${forgeConfig().url}/${org}/${repo}.git`])
  }
  await forgeAdmin.call('POST', `/repos/${org}/${SHOP}/labels`, { name: 'bug', color: '#d73a4a' }).catch(() => {})

  const scenario = join(home, 'scenario.json')
  writeFileSync(scenario, JSON.stringify(SCENARIO).replaceAll('SHOP/', `${SHOP}/`))
  await startApi()
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home, AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: scenario },
  }))

  const pipeline = await within(60, () => one(`select 1 from pipelines p join teams t on t.id = p.team_id where t.name = $1 and p.name = 'bug-fix' and p.current_version_id is not null`, [team]))
  const bugFixRow = must(await one<{ id: string; current_version_id: string; conversation_id: string }>(
    `select p.id, p.current_version_id, p.conversation_id from pipelines p where p.team_id = $1 and p.name = 'bug-fix'`, [teamId]), 'bugFixRow')
  const version = await one<{ git_sha: string }>('select git_sha from pipeline_versions where id = $1', [bugFixRow.current_version_id])
  const onForge = await forgeAdmin.call<{ sha: string }>('GET', `/repos/${org}/${PIPES}/contents/pipelines/bug-fix.ts?ref=main`)
  check(pipeline && version?.git_sha === onForge.sha, "the pipelines repo was read, and the bug-fix version is git's id for the file")

  // Webhooks.
  const tenoff = await openIssue('TENOFF discount charges a negative total', 'A $5 order with code TENOFF comes to -$5.00. It should be $0.')
  const forged = await deliverIssue(tenoff, 'deadbeef')
  const first = await deliverIssue(tenoff)
  const firstBody = await first.json()
  const again = await (await deliverIssue(tenoff)).json()
  check(forged.status === 401 && first.ok && firstBody.runs.length === 1 && again.runs.length === 0,
    'a signed forge delivery starts one run, a repeat starts none, and a bad signature is refused')
  const loopy = await openIssue('LOOPY: HALF rounds the wrong way', 'HALF on $5 gives 2.5, which should round.')
  await deliverIssue(loopy)
  const dupe = await openIssue('DUPE: discount codes can go below zero', 'Same as before?')
  await deliverIssue(dupe)

  const hookBody = JSON.stringify({ title: 'PRICEY report from support', body: 'Something is off.', repo: `${org}/${SHOP}`, id: 'support-1' })
  const sign = (body: string, key: string) => `sha256=${createHmac('sha256', key).update(body).digest('hex')}`
  const badHook = await fetch(`${API}/v1/hooks/pipelines/${bugFixRow.id}`, { method: 'POST', body: hookBody, headers: { 'x-agents-signature': sign(hookBody, 'wrong') } })
  const goodHook = await fetch(`${API}/v1/hooks/pipelines/${bugFixRow.id}`, { method: 'POST', body: hookBody, headers: { 'x-agents-signature': sign(hookBody, hookSecret(bugFixRow.id)) } })
  check(badHook.status === 401 && goodHook.ok && (await goodHook.json()).runs.length === 1, "a pipeline's own webhook starts a run only when signed with its secret")

  const { id: shopRepo } = must(await one<{ id: string }>('select id from repos where team_id = $1 and remote_url like $2', [teamId, `%/${SHOP}.git`]), 'shopRepo')
  await post(`/v1/pipelines/${bugFixRow.id}/runs`, { title: 'PLANME: taxes for every country', body: 'Each country needs its own rules.', repoId: shopRepo })
  await post(`/v1/pipelines/${bugFixRow.id}/runs`, { title: 'SLOW report', body: 'Takes a while.', repoId: shopRepo })

  // The main run, all the way to the gate.
  const a = must(await runOf(tenoff.title), 'a')
  const atGate = await within(180, async () => (await openAsk(a.id))?.kind === 'gate')
  const gate = await openAsk(a.id)
  check(atGate && gate?.payload.links?.some((l: { url: string }) => l.url.includes('/pulls/')),
    'the run reached the shepherd gate with a link to its pull request')
  const room = await all<{ body: string }>('select body from messages where conversation_id = $1 order by seq', [bugFixRow.conversation_id])
  check(room.some((m) => m.body.includes(gate?.payload.question ?? '?')), "the gate was posted in the pipeline's room")
  const stranger = await as(outsider, `/v1/asks/${gate?.id}/answer`, { decision: 'approve' })
  check(stranger.status === 404, 'a person from another team cannot answer the gate')

  // Restart the API while the run waits, then approve through the new one.
  if (gate) {
    api?.kill('SIGTERM')
    await within(10, async () => api?.exitCode !== null)
    await startApi()
    await as(login, `/v1/asks/${gate.id}/answer`, { decision: 'approve' })
  }
  check(gate && await waitStatus(a.id, ['done', 'failed'], 120) && (await runOf(tenoff.title))?.status === 'done',
    'after an API restart the approved run finishes')

  const stages = await stagesOf(a.id)
  check(stages.map((s) => s.stage).join(' ') === 'triage reproduce confirm fix verify fix verify open_pr shepherd merge',
    `the stages ran in order: ${stages.map((s) => `${s.stage}:${s.outcome}`).join(' ')}`)
  check(stages[2]?.outcome === 'fails' && stages[4]?.outcome === 'fails' && stages[6]?.outcome === 'passes',
    'the runner saw the reproduction fail before the fix, the first fix fail, and the second pass')
  const triageEvents = await all<{ text: string }>(`select text from events where session_id = $1 and kind = 'user' order by seq`, [stages[0]?.session_id])
  check(triageEvents.length === 2 && triageEvents[1]?.text.startsWith('You ended your turn without calling report_result') && stages[0]?.outcome === 'new',
    'an agent that forgot to report was reminded once, then reported')
  const fixPrompts = await all<{ text: string }>(`select text from events where session_id = $1 and kind = 'user' order by seq`, [stages[3]?.session_id])
  check(stages[3] && stages[3].session_id === stages[5]?.session_id && fixPrompts[1]?.text.includes('The fix did not pass') && fixPrompts[1].text.includes('TENOFF never goes below zero'),
    "the second fix went back to the same session, with the failed test's output")

  const prs = await forgeAdmin.call<{ number: number; merged: boolean; head: { ref: string } }[]>('GET', `/repos/${org}/${SHOP}/pulls?state=closed`)
  const main = await forgeAdmin.call<{ content: string }>('GET', `/repos/${org}/${SHOP}/contents/checkout.js?ref=main`)
  check(prs.some((pr) => pr.merged) && Buffer.from(main.content, 'base64').toString().includes('Math.max(0, amount - 10)'),
    "the pull request was merged on the forge, and main has the fix")
  const issueAfter = await forge.issue(`${org}/${SHOP}`, tenoff.number)
  check(issueAfter.state === 'closed', 'merging closed the issue')
  const finished = must(await runOf(tenoff.title), 'finished')
  const link = await one<{ state: string }>(`select state from artifacts where task_id = $1 and kind = 'link'`, [finished.task_id])
  check(finished.pipeline_version_id === bugFixRow.current_version_id && finished.metrics.attempts?.fix === 2
    && finished.metrics.costUsd > 0 && link?.state === 'merged',
  `the run records its version, metrics and merged link: ${JSON.stringify(finished.metrics)}`)
  const outsiderShape = await fetch(`${PEOPLE}/v1/shape/run_stages?run=${a.id}&offset=-1`, { headers: { 'tailscale-user-login': outsider } })
  check(outsiderShape.status === 404, "a person from another team cannot read the run's stages")

  // The fix that never works: three tries, then a person stops it.
  const b = must(await runOf(loopy.title), 'b')
  await within(300, async () => (await openAsk(b.id))?.kind === 'question')
  const handoff = await openAsk(b.id)
  check(handoff?.payload.question.includes('fix has run 3 times'), `after three failed fixes a person is asked: ${handoff?.payload.question}`)
  if (handoff) await as(login, `/v1/asks/${handoff.id}/answer`, { decision: 'stop' })
  check(await waitStatus(b.id, ['failed'], 60) && (await runOf(loopy.title))?.note === `Handed off to ${login}.`, 'stop ends the run, handed to that person')

  const d = must(await runOf('PRICEY report from support'), 'd')
  check(await waitStatus(d.id, ['failed'], 120) && (await runOf('PRICEY report from support'))?.note?.includes('spend cap'),
    `the spend cap stopped the run: ${(await runOf('PRICEY report from support'))?.note}`)

  const f = must(await runOf('PLANME: taxes for every country'), 'f')
  await within(300, async () => (await openAsk(f.id))?.kind === 'gate')
  const plan = await one<{ path: string; current_version: number; content: string }>(
    `select a.path, a.current_version, v.content from artifacts a join artifact_versions v on v.artifact_id = a.id and v.version = a.current_version
     where a.task_id = $1 and a.kind = 'document'`, [f.task_id])
  check(plan?.path === 'plan.md' && plan.content.includes('tax rates'), 'the plan the agent wrote in the task folder became a document')
  const planGate = await openAsk(f.id)
  if (planGate) await as(login, `/v1/asks/${planGate.id}/answer`, { decision: 'reject', message: 'Needs a design review first.' })
  check(await waitStatus(f.id, ['failed'], 60) && (await runOf('PLANME: taxes for every country'))?.note === 'The shepherd rejected the plan.',
    'rejecting the plan ends the run')

  const g = must(await runOf(dupe.title), 'g')
  check(await waitStatus(g.id, ['done'], 120), 'a duplicate report ends the run without code changes')
  const dupeIssue = await forge.issue(`${org}/${SHOP}`, dupe.number)
  const comments = await forgeAdmin.call<{ body: string }[]>('GET', `/repos/${org}/${SHOP}/issues/${dupe.number}/comments`)
  check(dupeIssue.state === 'closed' && comments.some((c) => c.body.includes('already reported')), "the duplicate was closed with the agent's explanation")

  const e = must(await runOf('SLOW report'), 'e')
  await within(120, async () => (await stagesOf(e.id)).some((s) => s.status === 'running'))
  check(await within(20, async () => agentProcesses() > 0), "a running stage's agent process can be seen")
  await post(`/v1/runs/${e.id}/cancel`)
  const eStages = await stagesOf(e.id)
  const stop = await one(`select 1 from commands where session_id = $1 and kind = 'stop'`, [eStages[0]?.session_id])
  check((await runOf('SLOW report'))?.status === 'cancelled' && eStages[0]?.status === 'cancelled' && stop,
    'cancelling a running run cancels its stage and stops its session')

  // A run on a box, when boxes cannot sign in to Claude, stops at once and says how to fix it.
  const boxedRow = must(await one<{ id: string }>(`select id from pipelines where team_id = $1 and name = 'boxed'`, [teamId]), 'the boxed pipeline')
  const { runId: boxedRun } = await post(`/v1/pipelines/${boxedRow.id}/runs`, { title: 'On a box', body: '', repoId: shopRepo }) as { runId: string }
  check(await waitStatus(boxedRun, ['failed'], 30) && (await one<{ note: string }>('select note from runs where id = $1', [boxedRun]))?.note.includes('claude setup-token')
    && !(await one(`select 1 from instances where team_id = $1 and kind = 'box'`, [teamId])),
  'a run on a box with no Claude login for boxes stops at once, says how to fix it, and starts no box')

  // Cron, then a broken change to the same pipeline.
  check(lastFire('30 9 * * *', new Date(2026, 0, 1, 9, 0), new Date(2026, 0, 1, 10, 0))?.getMinutes() === 30
    && lastFire('30 9 * * *', new Date(2026, 0, 1, 9, 31), new Date(2026, 0, 1, 10, 0)) === null
    && lastFire('0 0 * * 1', new Date(2026, 0, 4, 0, 0), new Date(2026, 0, 5, 12, 0))?.getDay() === 1,
  'cron schedules fire on the right minute and day, and only once')
  const cronRun = await within(240, () => one(`select 1 from runs r join tasks t on t.id = r.task_id where r.team_id = $1 and r.trigger = 'cron' and r.status = 'done'`, [teamId]))
  check(cronRun, 'the nightly schedule started a run on its minute, and its check passed')
  const nightlyRow = must(await one<{ id: string; current_version_id: string }>(`select id, current_version_id from pipelines where team_id = $1 and name = 'nightly'`, [teamId]), 'nightlyRow')
  const old = await forgeAdmin.call<{ sha: string }>('GET', `/repos/${org}/${PIPES}/contents/pipelines/nightly.ts?ref=main`)
  await forge.proposeFile(`${org}/${PIPES}`, 'pipelines/nightly.ts', nightly.replace("start: 'tests'", "start: 'missing'"), old.sha, 'main', 'broken', 'Break it')
  const pr = await forge.openPullRequest(`${org}/${PIPES}`, 'broken', 'main', 'Break nightly', '')
  await forge.merge(`${org}/${PIPES}`, pr.number)
  const pushBody = JSON.stringify({ ref: 'refs/heads/main', repository: { clone_url: `${forgeConfig().url}/${org}/${PIPES}.git` } })
  await fetch(`${API}/v1/hooks/forge`, { method: 'POST', body: pushBody, headers: { 'x-gitea-event': 'push', 'x-gitea-signature': createHmac('sha256', forgeConfig().webhookSecret).update(pushBody).digest('hex') } })
  const broken = await within(30, () => one(`select 1 from pipeline_versions where pipeline_id = $1 and error like '%start names no stage%'`, [nightlyRow.id]))
  const stillCurrent = await one<{ current_version_id: string }>('select current_version_id from pipelines where id = $1', [nightlyRow.id])
  check(broken && stillCurrent?.current_version_id === nightlyRow.current_version_id, 'a broken pipeline version is recorded with its error and never becomes current')

  check(await within(30, async () => agentProcesses() === 0), 'every agent process of the finished runs has exited')
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) {
    await db.query('delete from teams where name = any($1)', [[team, otherTeam]]).catch(() => {})
    for (const repo of [SHOP, PIPES]) await forgeAdmin.call('DELETE', `/repos/${org}/${repo}`).catch(() => {})
  }
  await db.end().catch(() => {})
}

console.log(`\n${failures.length ? `${failures.length} failed (teams ${team}, ${otherTeam} and forge repos kept)` : 'all passed (test teams and repos removed)'}`)
process.exit(failures.length ? 1 : 0)
