// Phase 2 step 8: the bug-fix pipeline with real Claude, start to finish. A bug
// report filed on the forge reaches the API through Gitea's own webhook. Real
// agent sessions triage it, write a failing test, and fix the code, and the
// runner checks both. The shepherd approves and the fix lands on main. A second
// report of the same bug is closed as a duplicate. Runs on a Mac instance, since
// boxes need a Claude token from `claude setup-token`.
//   npm run check:step8          AGENTS_STEP8_MODEL=sonnet to use another model

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { forge, forgeAdmin, forgeConfig } from '../server/forge.ts'
import { must } from './must.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
// The forge container reaches this Mac only on 7700 and 7701.
const PORT = 7701
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const MODEL = process.env.AGENTS_STEP8_MODEL ?? 'haiku'
const id = randomBytes(4).toString('hex')
const team = `step8-${id}`
const login = `step8-${id}@local`
const org = forgeConfig().org
const [SHOP, PIPES] = [`shop8-${id}`, `pipes8-${id}`]

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
    await sleep(1000)
  }
  return false
}

const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T | undefined
const runFor = (issue: number) => one<{ id: string; status: string; note: string | null; task_id: string; cost_usd: string | null; metrics: any }>(
  `select r.* from runs r join teams t on t.id = r.team_id where t.name = $1 and (r.trigger_payload->'report'->>'issue')::int = $2`, [team, issue])
const stagesOf = async (runId: string) => (await db.query<{ stage: string; outcome: string | null; status: string; summary: string | null; session_id: string | null }>(
  'select stage, outcome, status, summary, session_id from run_stages where run_id = $1 order by n', [runId])).rows

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, login)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  node('server/admin.ts', 'add-agent', team, 'fixer', `mac-${id}`, MODEL, 'You fix bugs in small JavaScript projects. Keep replies short.')
  const { id: teamId } = must(await one<{ id: string }>('select id from teams where name = $1', [team]), 'teamId')

  const hook = `http://host.docker.internal:${PORT}/v1/hooks/forge`
  await forgeAdmin.ensureRepo(SHOP, Object.fromEntries(['checkout.js', 'package.json', 'test/checkout.test.js', 'README.md']
    .map((f) => [f, readFileSync(join(ROOT, 'ops/seed/shop', f), 'utf8')])), 'step 8 shop', hook)
  await forgeAdmin.ensureRepo(PIPES, {
    'shared/pipeline.ts': readFileSync(join(ROOT, 'shared/pipeline.ts'), 'utf8'),
    'pipelines/bug-fix.ts': readFileSync(join(ROOT, 'pipelines/bug-fix.ts'), 'utf8').replace("runsOn: 'box'", "runsOn: 'home'"),
  }, 'step 8 pipelines', hook)
  for (const repo of [SHOP, PIPES]) await db.query('insert into repos (team_id, remote_url) values ($1, $2)', [teamId, `${forgeConfig().url}/${org}/${repo}.git`])
  const label = await forgeAdmin.call<{ id: number }>('POST', `/repos/${org}/${SHOP}/labels`, { name: 'bug', color: '#d73a4a' })

  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step8-')))
  children.push(spawn(process.execPath, ['--env-file=.env', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'), AGENTS_STREAMS_PORT: String(PORT + 2), AGENTS_STREAMS_DIR: join(home, 'streams') },
  }))
  await servePeople(PORT + 1, join(home, 'people.sock'))
  await within(20, () => fetch(API).then(() => true, () => false))
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home },
  }))
  await within(60, () => one(`select 1 from pipelines where team_id = $1 and name = 'bug-fix' and current_version_id is not null`, [teamId]))

  // Filed on the forge like any bug report. Gitea delivers the webhook itself.
  const issue = await forgeAdmin.call<{ number: number }>('POST', `/repos/${org}/${SHOP}/issues`, {
    title: 'TENOFF code makes small orders negative',
    body: 'Steps: call discount(5, "TENOFF") in checkout.js.\nExpected: 0, since a discount should never make an order cost less than nothing.\nActual: -5.',
    labels: [label.id],
  })
  check(await within(30, () => runFor(issue.number)), "Gitea's own webhook delivery started a run")
  // The same bug, reported again while the first report is still open.
  const dupe = await forgeAdmin.call<{ number: number }>('POST', `/repos/${org}/${SHOP}/issues`, {
    title: 'Negative total with discount code TENOFF',
    body: 'Using TENOFF on a $5 order gives a total of -$5.',
    labels: [label.id],
  })

  const run = must(await runFor(issue.number), 'run')
  const gate = await within(900, () => one(`select 1 from asks where run_id = $1 and kind = 'gate' and status = 'open'`, [run.id]))
  const stages = await stagesOf(run.id)
  console.log(`      stages: ${stages.map((s) => `${s.stage}:${s.outcome ?? s.status}`).join(' ')}`)
  check(gate, 'real agents took the report to a pull request waiting on the shepherd')
  const by = (name: string) => stages.filter((s) => s.stage === name)
  check(by('triage')[0]?.outcome === 'new' && by('reproduce')[0]?.outcome === 'easy' && by('confirm')[0]?.outcome === 'fails'
    && by('verify').at(-1)?.outcome === 'passes',
  "the agent's reproduction failed before the fix and the suite passed after it, as the runner saw")
  const reports = await one<{ n: number }>(
    `select count(*)::int as n from events e join run_stages s on s.session_id = e.session_id
     where s.run_id = $1 and e.kind = 'tool_call' and e.tool_name = 'mcp__stage__report_result'`, [run.id])
  check(Number(reports?.n) >= by('triage').length + by('reproduce').length + by('fix').length,
    'every agent stage ended by calling report_result')

  const ask = await one<{ id: string }>(`select id from asks where run_id = $1 and kind = 'gate' and status = 'open'`, [run.id])
  if (ask) {
    await fetch(`${PEOPLE}/v1/asks/${ask.id}/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify({ decision: 'approve' }),
    })
  }
  check(await within(120, async () => (await runFor(issue.number))?.status === 'done'), 'approving merged the pull request and finished the run')

  // The fix on main, tried for real.
  const main = await forgeAdmin.call<{ content: string }>('GET', `/repos/${org}/${SHOP}/contents/checkout.js?ref=main`)
  const source = Buffer.from(main.content, 'base64').toString()
  const tryIt = execFileSync(process.execPath, ['-e', `const m = {}; new Function('module', ${JSON.stringify(source)})(m); const { discount, total } = m.exports; console.log(JSON.stringify([discount(5, 'TENOFF'), discount(40, 'TENOFF'), discount(40, 'HALF'), total([{ price: 10, qty: 2 }], 'CA')]))`], { encoding: 'utf8' }).trim()
  check(tryIt === '[0,30,20,22.6]', `main's discount() no longer goes below zero and nothing else changed: ${tryIt}`)
  // The agent may add a new test file or a test to an existing one, as long as a test came with the fix.
  const merged = (await forgeAdmin.call<{ number: number; merged: boolean }[]>('GET', `/repos/${org}/${SHOP}/pulls?state=closed`)).find((pr) => pr.merged)
  const changed = merged ? await forgeAdmin.call<{ filename: string; additions: number }[]>('GET', `/repos/${org}/${SHOP}/pulls/${merged.number}/files`) : []
  check(changed.some((f) => f.filename === 'checkout.js') && changed.some((f) => /^test\/.+\.test\.js$/.test(f.filename) && f.additions > 0),
    `the merged pull request changed the code and added a test: ${changed.map((f) => f.filename).join(', ')}`)
  check((await forge.issue(`${org}/${SHOP}`, issue.number)).state === 'closed', 'the issue was closed by the merge')
  const finished = await runFor(issue.number)
  check(Number(finished?.cost_usd) > 0 && Number(finished?.cost_usd) < 5, `the run's cost is recorded and under its cap: $${finished?.cost_usd}`)

  const dupeRun = await runFor(dupe.number)
  check(await within(600, async () => (await runFor(dupe.number))?.status === 'done'), 'the second report ran to the end')
  const dupeTriage = dupeRun ? (await stagesOf(dupeRun.id))[0] : undefined
  console.log(`      second report: ${dupeTriage?.outcome}: ${dupeTriage?.summary}`)
  check(['duplicate', 'already_fixed'].includes(dupeTriage?.outcome ?? '') && (await forge.issue(`${org}/${SHOP}`, dupe.number)).state === 'closed',
    'the second report of the same bug was closed without another fix')
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
