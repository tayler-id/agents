// Promises made outside Agents, kept as obligations. A run that starts from an
// issue on a repo with a policy tells the reporter it started and promises the
// outcome there. The promise closes only with proof: the runner posts the
// outcome and records the comment. A stale or conflicting delivery changes
// nothing, a repeated one is a no-op, and a person can waive a promise by name.
//   node --env-file=.env --env-file=.env.test test/step16d.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { tx } from '../server/db.ts'
import { forgeAdmin, forgeConfig } from '../server/forge.ts'
import { deliver, promiseOnIssue } from '../server/obligations.ts'
import { OBLIGATION_ID } from '../shared/framework.ts'
import { must } from './must.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
// Ports 8000 to 8019 are this work's checks'.
const PORT = 8009
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 10}`
const id = randomBytes(4).toString('hex')
const team = `self-${id}`
const [owner, mate] = [`self-owner-${id}@local`, `self-mate-${id}@local`]
const forgeUser = `self-owner-${id}`
const [REPO, PIPES] = [`self-follow-${id}`, `self-followpipes-${id}`]
const { org, url: forgeUrl, webhookSecret, adminToken } = forgeConfig()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step16d-')))
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

async function within(seconds: number, test: () => Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(500)
  }
  return false
}

const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', '--env-file=.env.test', ...args], { cwd: ROOT, encoding: 'utf8' })
const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
const people = (who: string, method: string, path: string, body?: unknown) =>
  fetch(PEOPLE + path, { method, headers: { 'content-type': 'application/json', 'tailscale-user-login': who }, body: body === undefined ? undefined : JSON.stringify(body) })
async function forgeCall(method: string, path: string, body?: unknown) {
  const res = await fetch(`${forgeUrl}/api/v1${path}`, {
    method, headers: { authorization: `token ${adminToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
// A delivery that must fail closed: it throws, and the obligation is left as it was.
async function refused(obligation: string, event: Parameters<typeof deliver>[2]) {
  const before = await one('select status, generation, delivery_event from obligations where id = $1', [obligation])
  const thrown = await tx((client) => deliver(client, OBLIGATION_ID.parse(obligation), event)).then(() => null, (error: unknown) => error instanceof Error ? error.message : String(error))
  const after = await one('select status, generation, delivery_event from obligations where id = $1', [obligation])
  return thrown !== null && JSON.stringify(before) === JSON.stringify(after) ? thrown : null
}

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, owner)
  node('server/admin.ts', 'add-person', team, mate)
  const mac = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', owner))
  node('server/admin.ts', 'add-agent', team, 'builder', `mac-${id}`, 'claude-opus-test')
  const { id: teamId } = must(await one('select id from teams where name = $1', [team]), 'the team')
  await forgeCall('POST', '/admin/users', { username: forgeUser, email: `${forgeUser}@forge.local`, password: randomBytes(18).toString('base64url'), must_change_password: false })
  node('server/admin.ts', 'forge-login', owner, forgeUser)

  // A repo with a policy, and a pipeline that runs on issues labeled agents and waits at one gate.
  await forgeAdmin.ensureRepo(REPO, { 'README.md': '# follow\n' }, 'step 16d', false)
  await forgeAdmin.call('POST', `/repos/${org}/${REPO}/labels`, { name: 'agents', color: '#777777' })
  await forgeAdmin.ensureRepo(PIPES, {
    'shared/pipeline.ts': readFileSync(join(ROOT, 'shared/pipeline.ts'), 'utf8'),
    'pipelines/followup.ts': `export default {
  description: 'Waits for a person on an issue labeled agents.',
  agent: 'builder', runsOn: 'home', spendCapUsd: 1,
  triggers: [{ kind: 'forge', event: 'issues', action: 'opened', label: 'agents' }],
  start: 'hold',
  stages: { hold: { kind: 'gate', question: () => 'Finish?', next: { approved: { done: 'succeeded', note: 'Looked at and closed.' }, rejected: { done: 'failed', note: 'Turned down.' } } } },
}
`,
  }, 'step 16d pipelines', false)
  const remote = `${forgeUrl}/${org}/${REPO}.git`
  await db.query('insert into repos (team_id, remote_url) values ($1, $2), ($1, $3)', [teamId, remote, `${forgeUrl}/${org}/${PIPES}.git`])
  writeFileSync(join(home, 'agents-follow.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(ROOT, 'ops/policies/agents.json'), 'utf8')), sandbox: 'any' }))
  node('server/admin.ts', 'set-policy', team, remote, join(home, 'agents-follow.json'), owner)
  const { id: repoId } = must(await one('select id from repos where remote_url = $1 and team_id = $2', [remote, teamId]), 'the repo')

  children.push(spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env, AGENTS_HOME: join(home, 'api'), AGENTS_RUNNER_TEAMS: team, AGENTS_BOX_TOKEN_FILE: join(home, 'no-box-token'),
      AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'), AGENTS_STREAMS_PORT: String(PORT + 2), AGENTS_STREAMS_DIR: join(home, 'streams'),
    },
  }))
  if (!(await within(30, () => fetch(`${API}/v1/health`).then((r) => r.ok, () => false)))) throw new Error(`the API did not start on ${API}`)
  await servePeople(PORT + 10, join(home, 'people.sock'))
  mkdirSync(join(home, 'mac'), { recursive: true })
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: mac.token, AGENTS_HOME: join(home, 'mac'), AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts') },
  }))
  await within(60, () => one(`select 1 from pipelines where team_id = $1 and name = 'followup' and current_version_id is not null`, [teamId]))

  // An issue labeled agents starts a run, as the forge's webhook would.
  const issue = (await forgeCall('POST', `/repos/${org}/${REPO}/issues`, { title: 'Totals are off', body: 'They are off by one.' })).json
  const payload = JSON.stringify({
    action: 'opened', issue: { number: issue.number, title: issue.title, body: issue.body, html_url: issue.html_url, labels: [{ name: 'agents' }], user: { login: 'reporter' } },
    repository: { clone_url: remote },
  })
  const hook = await fetch(`${API}/v1/hooks/forge`, {
    method: 'POST', body: payload,
    headers: { 'content-type': 'application/json', 'x-gitea-event': 'issues', 'x-gitea-signature': createHmac('sha256', webhookSecret).update(payload).digest('hex') },
  })
  const { runs } = await hook.json()
  const runId = must(runs[0], 'the run the issue started')
  const comments = async () => (await forgeCall('GET', `/repos/${org}/${REPO}/issues/${issue.number}/comments`)).json
  const promised = await within(60, async () => one('select * from obligations where run_id = $1', [runId]))
  const obligation = must(await one('select * from obligations where run_id = $1', [runId]), 'the obligation')
  check(promised && obligation.status === 'open' && obligation.target === issue.html_url && obligation.proof === 'comment'
    && (await comments()).some((c: any) => c.body.includes('The outcome will be posted here')),
  'a run from an issue told the reporter it started, and promised the outcome there as an open obligation')
  const listed = await (await people(mate, 'GET', '/v1/obligations')).json()
  check(listed.obligations.some((o: any) => o.id === obligation.id && o.overdue === false), 'the open promise is listed for the team, with when it is due')

  // Deliveries that do not fit the promise change nothing.
  const fake = { kind: 'comment' as const, id: 999999, url: `${issue.html_url}#issuecomment-999999` }
  const stale = await refused(obligation.id, { id: 'stale', generation: Number(obligation.generation) + 5, target: obligation.target, delivery: fake })
  check(stale?.includes('generation'), `a stale delivery fails closed: ${stale ?? 'it went through'}`)
  const elsewhere = await refused(obligation.id, { id: 'elsewhere', generation: obligation.generation, target: `${issue.html_url}0`, delivery: fake })
  check(elsewhere?.includes('the promise was for'), `a delivery to another place fails closed: ${elsewhere ?? 'it went through'}`)
  const wrongProof = await refused(obligation.id, { id: 'commit', generation: obligation.generation, target: obligation.target, delivery: { kind: 'commit', sha: 'a'.repeat(40) } })
  check(wrongProof?.includes('needs a comment'), `a delivery with the wrong kind of proof fails closed: ${wrongProof ?? 'it went through'}`)

  // A promise on an issue the forge does not have is due first, and must not hold up the rest.
  await tx((client) => promiseOnIssue(client, { teamId, taskId: obligation.task_id, runId, repoId, issue: 999999, target: `${issue.html_url}#lost`, promise: 'Post on an issue that is gone', dueAt: new Date(Date.now() - 120_000) }))

  // The run ends, and the runner posts the outcome and closes the promise with the comment as proof.
  await within(60, () => one(`select id from asks where run_id = $1 and status = 'open'`, [runId]))
  const ask = must(await one(`select id from asks where run_id = $1 and status = 'open'`, [runId]), 'the gate')
  await people(mate, 'POST', `/v1/asks/${ask.id}/answer`, { decision: 'approve' })
  const kept = await within(60, async () => (await one('select status from obligations where id = $1', [obligation.id]))?.status === 'done')
  const closed = await one('select * from obligations where id = $1', [obligation.id])
  const outcome = (await comments()).find((c: any) => c.id === closed.delivery?.id)
  check(kept && closed.delivery_event === `run:${runId}:outcome` && outcome?.body.includes('Looked at and closed.') && closed.delivery.url === outcome.html_url,
    'the runner posted the outcome on the issue and closed the promise with that comment as proof')
  check((await one('select status from obligations where target = $1', [`${issue.html_url}#lost`]))?.status === 'open',
    'a promise that cannot be delivered, due before the others, stays open and holds none of them up')
  const again = await tx((client) => deliver(client, OBLIGATION_ID.parse(obligation.id), { id: `run:${runId}:outcome`, generation: 1, target: obligation.target, delivery: closed.delivery }))
  check(again === 'duplicate' && (await comments()).filter((c: any) => c.body.includes(`agents run ${runId} -->`)).length === 1,
    'delivering the same event again is a no-op, and the outcome was posted once')
  const late = await refused(obligation.id, { id: 'late', generation: closed.generation, target: obligation.target, delivery: closed.delivery })
  check(late?.includes('already done'), `a new delivery to a kept promise fails closed: ${late ?? 'it went through'}`)

  // A promise nobody can keep is waived by a person, by name, and an overdue one shows as overdue.
  const { id: taskId } = must(await one('select task_id as id from runs where id = $1', [runId]), 'the task')
  await tx((client) => promiseOnIssue(client, { teamId, taskId, runId, repoId, issue: issue.number, target: `${issue.html_url}#second`, promise: 'Post a second note', dueAt: new Date(Date.now() - 60_000) }))
  const second = must(await one(`select id from obligations where target = $1`, [`${issue.html_url}#second`]), 'the second promise')
  const overdue = await (await people(mate, 'GET', '/v1/obligations')).json()
  check(overdue.obligations.some((o: any) => o.id === second.id && o.overdue === true), 'a promise past its time shows as overdue')
  const noReason = await people(mate, 'POST', `/v1/obligations/${second.id}/waive`, {})
  check(noReason.status === 400, 'a waiver needs a reason')
  check((await people(mate, 'POST', `/v1/obligations/${second.id}/waive`, { reason: 'The reporter closed the issue.' })).ok, 'a teammate waives it with a reason')
  const waived = await one('select status, waived_by, waive_reason from obligations where id = $1', [second.id])
  const mateId = must(await one('select id from people where login = $1', [mate]), 'the teammate').id
  check(waived.status === 'waived' && waived.waived_by === mateId && waived.waive_reason === 'The reporter closed the issue.', 'the waiver records who waived it and why')
  check((await people(mate, 'POST', `/v1/obligations/${second.id}/waive`, { reason: 'Again.' })).status === 409, 'a closed promise cannot be waived again')
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team])
    for (const repo of [REPO, PIPES]) await forgeCall('DELETE', `/repos/${org}/${repo}`)
    await forgeCall('DELETE', `/admin/users/${forgeUser}`)
  }
  await db.end()
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} and the self- forge repos kept)` : 'all passed (test team and repos removed)'}`)
process.exit(failures.length ? 1 : 0)
