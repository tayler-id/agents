// Evidence, part 4: improve cites checked evidence, with the API, a daemon, the
// forge and the stand-in for Claude. Two past bug-fix runs each needed a reminder
// at triage. Improve's study cites both reminders, and a step with words that are
// not in it. Code keeps the two real quotes, the change's hunk cites them, and the
// pull request and the gate carry them and not the invented one. The shepherd
// turns the change down with a reason, and the next run's same change on the same
// evidence is refused before any replay, pull request or question. A study
// citing nothing code can find never reaches anyone.
//   node --env-file=.env --env-file=.env.test test/step20c.ts

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
const PORT = 8083
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const id = randomBytes(4).toString('hex')
const team = `evd-c-${id}`
const login = `alice-${id}@local`
const org = forgeConfig().org
const [SHOP, PIPES] = [`shop20c-${id}`, `pipes20c-${id}`]
const CLEARER = 'Always call report_result when you finish.'
const TRIAGE_LINE = 'Decide what this report is, without changing any code:'
const NUDGE = 'You ended your turn without calling report_result'
const INVENTED = 'Triage reported on its first try every time'

const TEST_FILE = `const test = require('node:test')
const assert = require('node:assert')
const { discount } = require('../checkout.js')

test('TENOFF never goes below zero', () => assert.strictEqual(discount(5, 'TENOFF'), 0))
`
const change = { replace: { [`${PIPES}/pipelines/bug-fix.ts`]: [TRIAGE_LINE, `${CLEARER} ${TRIAGE_LINE}`] as [string, string] } }
const SCENARIO: Record<string, Record<string, Record<string, unknown>[]>> = {
  TENOFF: {
    'new,duplicate,already_fixed,not_a_bug': [{ outcome: 'new', reportOnlyIf: CLEARER, summary: 'A new bug.' }],
    'easy,hard,cannot_reproduce': [{ outcome: 'easy', write: { [`${SHOP}/test/tenoff.test.js`]: TEST_FILE }, data: { test_command: 'node --test test/tenoff.test.js', suite_command: 'npm test' } }],
    'fixed,stuck': [{ outcome: 'fixed', summary: 'TENOFF stops at zero.', replace: { [`${SHOP}/checkout.js`]: ['amount - 10', 'Math.max(0, amount - 10)'] } }],
  },
  ImproveOne: { 'changed,nothing': [{ outcome: 'changed', summary: 'Triage now says to always call report_result.', ...change }] },
  ImproveTwo: { 'changed,nothing': [{ outcome: 'changed', summary: 'Triage now says to always call report_result.', ...change }] },
  ImproveThree: { 'changed,nothing': [{ outcome: 'changed', summary: 'Triage now says to always call report_result.', ...change }] },
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

const runOf = (runId: string) => one<{ status: string; note: string | null }>('select status, note from runs where id = $1', [runId])
const openAsk = (runId: string) => one<{ id: string; kind: string; payload: any }>(`select id, kind, payload from asks where run_id = $1 and status = 'open'`, [runId])
const stageRow = (runId: string, stage: string) => one<{ outcome: string; summary: string }>(
  'select outcome, summary from run_stages where run_id = $1 and stage = $2 order by n desc limit 1', [runId, stage])
const pulls = async () => (await forgeAdmin.call<unknown[]>('GET', `/repos/${org}/${PIPES}/pulls?state=all&limit=50`)).length

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, login)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  node('server/admin.ts', 'add-agent', team, 'fixer', `mac-${id}`, '', 'You fix bugs in small JavaScript projects.')
  node('server/admin.ts', 'add-agent', team, 'improver', `mac-${id}`)
  const { id: teamId } = must(await one<{ id: string }>('select id from teams where name = $1', [team]), 'teamId')

  await forgeAdmin.ensureRepo(SHOP, Object.fromEntries(['checkout.js', 'package.json', 'test/checkout.test.js']
    .map((f) => [f, readFileSync(join(ROOT, 'ops/seed/shop', f), 'utf8')])), 'step 20c shop', false)
  await forgeAdmin.ensureRepo(PIPES, {
    'shared/pipeline.ts': readFileSync(join(ROOT, 'shared/pipeline.ts'), 'utf8'),
    'pipelines/bug-fix.ts': readFileSync(join(ROOT, 'pipelines/bug-fix.ts'), 'utf8').replace("runsOn: 'box'", "runsOn: 'home'"),
    'pipelines/improve.ts': readFileSync(join(ROOT, 'pipelines/improve.ts'), 'utf8'),
  }, 'step 20c pipelines', false)
  for (const repo of [SHOP, PIPES]) await db.query('insert into repos (team_id, remote_url) values ($1, $2)', [teamId, `${forgeConfig().url}/${org}/${repo}.git`])
  const repoId = async (name: string) => must(await one<{ id: string }>('select id from repos where team_id = $1 and remote_url like $2', [teamId, `%/${name}.git`]), 'repoId').id

  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step20c-')))
  writeFileSync(join(home, 'scenario.json'), JSON.stringify(SCENARIO))
  children.push(spawn(process.execPath, ['--env-file=.env', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'), AGENTS_STREAMS_PORT: String(PORT + 2), AGENTS_STREAMS_DIR: join(home, 'streams'), AGENTS_REPLAYS: '2' },
  }))
  await servePeople(PORT + 1, join(home, 'people.sock'))
  await within(20, () => fetch(API).then(() => true, () => false))
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home, AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json') },
  }))
  await within(60, async () => Number((await one<{ n: number }>(`select count(*)::int as n from pipelines where team_id = $1 and current_version_id is not null`, [teamId]))?.n) === 2)
  const pipeline = async (name: string) => must(await one<{ id: string }>('select id from pipelines where team_id = $1 and name = $2', [teamId, name]), name).id

  // Two past runs, each needing a reminder at triage, turned down so both can be replayed.
  const past: string[] = []
  for (const title of ['TENOFF makes a $5 order negative', 'TENOFF goes below zero on small orders']) {
    const { runId } = await post(`/v1/pipelines/${await pipeline('bug-fix')}/runs`, { title, body: 'discount(5, "TENOFF") returns -5.', repoId: await repoId(SHOP) })
    past.push(runId)
    await within(240, async () => (await openAsk(runId))?.kind === 'gate')
    const gate = await openAsk(runId)
    if (gate) await post(`/v1/asks/${gate.id}/answer`, { decision: 'reject', message: 'Not this week.' })
    await within(60, async () => (await runOf(runId))?.status === 'failed')
  }
  const nudges = await all<{ session_id: string; seq: number }>(
    `select e.session_id, e.seq::int from events e join run_stages s on s.session_id = e.session_id
     where s.run_id = any($1) and e.kind = 'user' and e.text like $2 || '%' order by e.id`, [past, NUDGE])
  check(nudges.length === 2, 'each past run needed a reminder at triage')
  const real = nudges.map((n) => ({ kind: 'ignored', session: n.session_id, step: n.seq, quote: NUDGE, note: 'Triage needed a reminder to report.' }))
  const invented = { ...must(real[0], 'a real finding'), quote: INVENTED, note: 'Made up.' }
  const study = (findings: unknown[]) => [{ outcome: 'changed', summary: 'Triage now says to always call report_result.', ...change, data: { findings } }]
  Object.assign(SCENARIO, { ImproveOne: { 'changed,nothing': study([...real, invented]) }, ImproveTwo: { 'changed,nothing': study(real) }, ImproveThree: { 'changed,nothing': study([invented]) } })
  writeFileSync(join(home, 'scenario.json'), JSON.stringify(SCENARIO))
  const improve = async (title: string) => {
    const { runId } = await post(`/v1/pipelines/${await pipeline('improve')}/runs`, { title, body: 'Make bug-fix runs need fewer reminders.', repoId: await repoId(PIPES) })
    if (!await within(400, async () => ['done', 'failed'].includes((await runOf(runId))?.status ?? '') || (await openAsk(runId)) !== undefined)) {
      throw new Error(`${title} never finished or reached its gate`)
    }
    return String(runId)
  }

  // The study's two real quotes are kept, and the change cites them.
  const first = await improve('ImproveOne bug-fix')
  const recorded = await stageRow(first, 'record')
  check(recorded?.outcome === 'ready' && recorded.summary.startsWith('Kept 2 findings from 2 runs of bug-fix, and dropped 1.')
    && recorded.summary.includes('the quote is not in step'), `code kept the two real quotes and dropped the invented one: ${recorded?.summary}`)
  const proposal = must(await one<{ id: string; status: string }>('select id, status from proposals where run_id = $1', [first]), 'the proposal')
  const hunks = await all<{ id: string; target: string; op: string; before: string; after: string; evidence: any[]; finding_ids: string[] }>(
    'select * from proposal_hunks where proposal_id = $1 order by n', [proposal.id])
  check(hunks.length === 1 && hunks[0]?.target === 'pipeline' && hunks[0].op === 'change' && hunks[0].after.includes(CLEARER)
    && hunks[0].evidence.length === 2 && hunks[0].evidence.every((q) => q.quote === NUDGE),
  `the change's hunk cites both checked quotes: ${JSON.stringify(hunks.map((h) => ({ op: h.op, cites: h.evidence.length })))}`)
  const gate = await openAsk(first)
  const [pr] = await forgeAdmin.call<{ body: string }[]>('GET', `/repos/${org}/${PIPES}/pulls?state=open`)
  check(proposal.status === 'open' && gate?.kind === 'gate' && gate.payload.question.includes('It rests on: Kept 2 findings')
    && pr?.body.includes('The evidence, checked in code') && pr.body.includes(NUDGE) && !pr.body.includes(INVENTED) && !gate.payload.question.includes(INVENTED),
  'the pull request and the gate give only the reasons code found in the runs')
  // The change was scored whole, so one of its hunks is never decided alone.
  const alone = await fetch(`${PEOPLE}/v1/hunks/${must(hunks[0], 'the hunk').id}/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify({ decision: 'accept' }),
  })
  await alone.body?.cancel()
  check(alone.status === 409 && (await one<{ decision: string | null }>('select decision from proposal_hunks where id = $1', [must(hunks[0], 'the hunk').id]))?.decision === null,
    `one hunk of a pipeline change cannot be decided alone: ${alone.status}`)

  // The shepherd turns it down, with a reason.
  if (gate) await post(`/v1/asks/${gate.id}/answer`, { decision: 'reject', message: 'Not this wording.' })
  await within(60, async () => (await runOf(first))?.status === 'failed')
  const decided = await one<{ decision: string; reason: string; login: string }>(
    'select h.decision, h.reason, p.login from proposal_hunks h join people p on p.id = h.decided_by where h.proposal_id = $1', [proposal.id])
  check((await runOf(first))?.note === 'The shepherd turned the change down.' && decided?.decision === 'rejected' && decided.reason === 'Not this wording.' && decided.login === login,
    "the shepherd's decision is kept on the hunk, with who and why")
  const pullsAfterFirst = await pulls()

  // The same change on the same evidence is refused before any replay or question.
  const second = await improve('ImproveTwo bug-fix')
  const refused = await stageRow(second, 'score')
  check((await runOf(second))?.note === 'The change broke a rule for changes, so nobody was asked.' && refused?.outcome === 'refused'
    && refused.summary.includes('Not this wording.') && refused.summary.includes(login),
  `the same change on the same evidence is refused, saying who turned it down and why: ${refused?.summary}`)
  check(!(await openAsk(second)) && await pulls() === pullsAfterFirst
    && !(await one(`select 1 from runs r join proposals p on p.id = r.proposal_id where p.run_id = $1`, [second])),
  'it opened no pull request, ran no replays, and asked nobody')

  // A study citing nothing code can find is never proposed.
  const third = await improve('ImproveThree bug-fix')
  check((await runOf(third))?.note === 'The study cited no evidence code could find in the runs, so nobody was asked.'
    && !(await one('select 1 from proposals where run_id = $1', [third])) && await pulls() === pullsAfterFirst,
  `a change resting on no checked evidence never reaches anyone: ${(await runOf(third))?.note}`)
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
