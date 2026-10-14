// Step 14: the work layer, against a real API, daemon, forge and runner, with the
// stand-in for Claude. Draft tasks are saved, edited by a teammate, started once
// and discarded. A task over two repos clones both and names both. The Changes
// list holds every file the agent added, changed or deleted in each repo, with
// its diff against the base and secrets scrubbed on the machine.
//   node --env-file=.env --env-file=.env.test test/step14.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Shape, ShapeStream, type Row } from '@electric-sql/client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import pg from 'pg'
import { forgeAdmin, forgeConfig } from '../server/forge.ts'
import { must } from './must.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
// Ports 7960 to 7979 are this step's: machines, people, then the stream server. Main's step 10
// checks put their people port at 7961 and 7971, so this one starts at 7962.
const PORT = 7962
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const id = randomBytes(4).toString('hex')
const [team, otherTeam] = [`flow-${id}`, `flow-x-${id}`]
const [alice, amir, outsider] = [`alice-flow-${id}@local`, `amir-flow-${id}@local`, `out-flow-${id}@local`]
const [SHOP, SERVICE, GONE] = [`flow-shop-${id}`, `flow-api-${id}`, `flow-gone-${id}`]
const org = forgeConfig().org
// Only the daemon knows it, so finding it scrubbed proves the machine scrubbed it.
const SECRET = `flow-${randomBytes(12).toString('hex')}`

const PIPES = `flow-pipes-${id}`
const RPI = join(ROOT, 'pipelines/research-plan-implement.ts')
const TENOFF_TEST = `const test = require('node:test')
const assert = require('node:assert')
const { discount } = require('../checkout.js')

test('TENOFF never goes below zero', () => assert.strictEqual(discount(5, 'TENOFF'), 0))
`

const SCENARIO = {
  turns: [
    { match: 'Draft one, edited', write: { [`${SHOP}/README.md`]: `# Shop\n\nCheckout math. The token is ${SECRET}.\n`, [`${SERVICE}/notes.txt`]: 'Notes\n' }, reply: 'Wrote the README and the notes.' },
  ],
  // The research, plan and implement pipeline's stages, by their outcomes.
  RPIFLOW: {
    researched: [
      { outcome: 'researched', summary: 'The discount is in checkout.js.', write: { 'task/research.md': '# Research\n\nThe discount lives in checkout.js.\n\nTENOFF subtracts ten, even from less than ten.\n' } },
      { outcome: 'researched', summary: 'Named the function.', write: { 'task/research.md': '# Research\n\nThe discount lives in checkout.js, in discount().\n\nTENOFF subtracts ten, even from less than ten.\n' } },
    ],
    planned: [{ outcome: 'planned', summary: 'Clamp TENOFF at zero.', data: { test_command: 'node --test test/tenoff.test.js' }, write: { 'task/plan.md': '# Plan\n\n1. Add a test that TENOFF never goes below zero.\n2. Clamp the result at zero.\n' } }],
    'implemented,stuck': [
      { outcome: 'implemented', summary: 'First try.', write: { [`${SHOP}/test/tenoff.test.js`]: TENOFF_TEST }, replace: { [`${SHOP}/checkout.js`]: ['amount - 10', 'amount - 9'] } },
      { outcome: 'implemented', summary: 'TENOFF now stops at zero.', replace: { [`${SHOP}/checkout.js`]: ['amount - 9', 'Math.max(0, amount - 10)'] } },
    ],
  },
  // Research that edits the code, every time.
  RPITOUCH: {
    researched: [{ outcome: 'researched', write: { 'task/research.md': '# Research\n', [`${SHOP}/oops.txt`]: 'changed during research\n' } }],
  },
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step14-')))

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

// One part of the check. An error inside it fails that part and the check goes on.
async function section(name: string, run: () => Promise<void>) {
  console.log(`\n-- ${name}`)
  try {
    await run()
  } catch (error) {
    check(false, `${name}: ${(error as Error).message}`)
  }
}

const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })

async function within(seconds: number, test: () => Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(400)
  }
  return false
}

const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T | undefined
const all = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[]

async function as(who: string, path: string, body: unknown = {}) {
  return fetch(PEOPLE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': who }, body: JSON.stringify(body) })
}
async function post(path: string, body: unknown = {}, who = alice) {
  const res = await as(who, path, body)
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

// A shape's rows as a person sees them now, or the status the proxy refused with.
async function shapeRows(login: string, name: string, args: Record<string, string> = {}): Promise<{ status: number; rows: any[] }> {
  const query = new URLSearchParams(args).toString()
  const url = `${PEOPLE}/v1/shape/${name}${query ? `?${query}` : ''}`
  const headers = { 'tailscale-user-login': login }
  const probe = await fetch(`${url}${query ? '&' : '?'}offset=-1`, { headers })
  await probe.body?.cancel()
  if (!probe.ok) return { status: probe.status, rows: [] }
  const shape = new Shape(new ShapeStream<Row>({ url, headers, subscribe: false }))
  return { status: 200, rows: await shape.rows }
}

// A shape's rows once they pass the test, or the last rows read when time runs
// out. Electric serves a write a moment after it commits, so a read right after
// one can miss it.
async function shapeUntil(login: string, name: string, args: Record<string, string>, test: (rows: any[]) => boolean, seconds = 20) {
  let last: { status: number; rows: any[] } = { status: 0, rows: [] }
  await within(seconds, async () => {
    last = await shapeRows(login, name, args)
    return last.status === 200 && test(last.rows)
  })
  return last
}

// The stand-in for Claude, wrapped so the check sees the flags each session started with.
function claudeWrapper(): string {
  const file = join(home, 'claude.mjs')
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
appendFileSync(${JSON.stringify(join(home, 'claude-args.jsonl'))}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n')
const child = spawn(process.execPath, [${JSON.stringify(join(ROOT, 'test/fake-claude.ts'))}, ...process.argv.slice(2)], { stdio: 'inherit' })
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('exit', (code) => process.exit(code ?? 1))
`, { mode: 0o755 })
  return file
}

function startDaemon(token: string, daemonHome: string): ChildProcess {
  const daemon = spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: daemonHome, AGENTS_CLAUDE_BIN: claudeWrapper(),
      AGENTS_FAKE_SCENARIO: join(home, 'scenario.json'), FLOW_TEST_TOKEN: SECRET,
    },
  })
  children.push(daemon)
  return daemon
}

const workspaceOf = (taskId: string) => one<{ id: string; status: string; path: string }>(
  'select id, status, path from workspaces where task_id = $1 order by created_at desc limit 1', [taskId])
const changesOf = (taskId: string) => all<{ repo: string; path: string; status: string; additions: number; deletions: number; preview: string; content: string | null; diff: string | null; updated_at: Date }>(
  `select r.remote_url as repo, f.path, f.status, f.additions, f.deletions, f.preview, f.content, f.diff, f.updated_at
   from file_changes f join repos r on r.id = f.repo_id where f.task_id = $1 order by f.path`, [taskId])

const unlistedOf = (taskId: string) => all<{ repo_id: string; kind: string; reason: string | null }>(
  'select repo_id, kind, reason from unlisted_changes where task_id = $1', [taskId])
// What is stored about a task's sessions and commands, as one string to search for a leaked token.
const recordOf = async (taskId: string) => JSON.stringify([
  await all(`select c.kind, c.error, c.payload from commands c where c.session_id in (select id from sessions where task_id = $1)
    or c.payload->>'workspaceId' in (select id::text from workspaces where task_id = $1)`, [taskId]),
  await all('select kind, text, body from events where session_id in (select id from sessions where task_id = $1)', [taskId]),
  await all('select title, body, error from pushes where task_id = $1', [taskId]),
])

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, alice)
  node('server/admin.ts', 'add-person', team, amir)
  node('server/admin.ts', 'add-team', otherTeam, outsider)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `flow-mac-${id}`, 'mac', alice))
  const { token: otherToken } = JSON.parse(node('server/admin.ts', 'add-instance', otherTeam, `flow-out-${id}`, 'mac', outsider))
  const { agentId: writer } = JSON.parse(node('server/admin.ts', 'add-agent', team, 'writer', `flow-mac-${id}`, '', 'You write docs.'))
  const { agentId: helper } = JSON.parse(node('server/admin.ts', 'add-agent', team, 'helper', `flow-mac-${id}`, '', 'You help.'))
  const { id: teamId } = must(await one<{ id: string }>('select id from teams where name = $1', [team]), 'the team')

  const seed = (file: string) => readFileSync(join(ROOT, 'ops/seed/shop', file), 'utf8')
  await forgeAdmin.ensureRepo(SHOP, { 'checkout.js': seed('checkout.js'), 'package.json': seed('package.json'), 'test/checkout.test.js': seed('test/checkout.test.js') }, 'step 14 shop', false)
  await forgeAdmin.ensureRepo(SERVICE, { 'README.md': '# api\n', 'server.js': "console.log('api')\n" }, 'step 14 api', false)
  await forgeAdmin.ensureRepo(GONE, { 'README.md': '# gone\n' }, 'step 14 gone', false)
  const repoIdOf = async (name: string) => must(await one<{ id: string }>(
    'insert into repos (team_id, remote_url) values ($1, $2) returning id', [teamId, `${forgeConfig().url}/${org}/${name}.git`]), name).id
  const shopRepo = await repoIdOf(SHOP)
  const serviceRepo = await repoIdOf(SERVICE)
  const goneRepo = await repoIdOf(GONE)
  // A slow setup in the first repo. An agent that started before setup ended would
  // write into the second repo's folder before its clone, and the clone would fail.
  await db.query(`update repos set setup_command = 'sleep 2' where id = $1`, [serviceRepo])
  // The pipelines repo, read when the API starts, with the new pipeline on the agents' own machine.
  const rpi = existsSync(RPI) ? readFileSync(RPI, 'utf8').replace("runsOn: 'box'", "runsOn: 'home'") : null
  check(rpi?.includes("runsOn: 'home'"), 'the research, plan and implement pipeline file exists')
  await forgeAdmin.ensureRepo(PIPES, {
    'shared/pipeline.ts': readFileSync(join(ROOT, 'shared/pipeline.ts'), 'utf8'),
    ...(rpi ? { 'pipelines/research-plan-implement.ts': rpi } : {}),
  }, 'step 14 pipelines', false)
  await repoIdOf(PIPES)
  node('server/admin.ts', 'add-agent', team, 'builder', `flow-mac-${id}`, '', 'You build features in phases.')

  writeFileSync(join(home, 'scenario.json'), JSON.stringify(SCENARIO))
  children.push(spawn(process.execPath, ['--env-file=.env', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'),
      AGENTS_STREAMS_PORT: String(PORT + 2), AGENTS_STREAMS_DIR: join(home, 'streams'), AGENTS_BOX_TOKEN_FILE: join(home, 'no-box-token'),
    },
  }))
  await servePeople(PORT + 1, join(home, 'people.sock'))
  await within(20, () => fetch(API).then(() => true, () => false))
  let daemon = startDaemon(token, home)
  await within(20, async () => (await one<{ status: string }>('select status from instances where name = $1', [`flow-mac-${id}`]))?.status === 'online')

  let draftTask = ''
  let draftSession = ''
  let twinTask = ''

  await section('drafts', async () => {
    const created = await post('/v1/tasks', { title: 'Draft one', instructions: 'Write it up later.', agentId: writer, repoIds: [shopRepo], draft: true })
    draftTask = created.taskId
    draftSession = created.sessionId
    const session = await one<{ status: string; workspace_id: string | null }>('select status, workspace_id from sessions where id = $1', [draftSession])
    const commands = await one<{ n: number }>(
      `select count(*)::int as n from commands where session_id = $1 or payload->>'workspaceId' in (select id::text from workspaces where task_id = $2)`, [draftSession, draftTask])
    check(session?.status === 'draft' && session.workspace_id === null && commands?.n === 0 && !(await workspaceOf(draftTask)),
      'a draft has a session in the draft status, and no workspace, message or command')

    const tasks = await shapeUntil(amir, 'tasks', {}, (rows) => rows.some((t) => t.id === draftTask))
    const sessions = await shapeUntil(amir, 'sessions', { of: 'tasks' }, (rows) => rows.some((s) => s.id === draftSession))
    check(tasks.rows.some((t) => t.id === draftTask) && sessions.rows.some((s) => s.id === draftSession && s.status === 'draft'),
      'a teammate sees the draft and its draft status')

    const loaded = { title: 'Draft one', instructions: 'Write it up later.', agentId: writer, repoIds: [shopRepo] }
    const missing = await as(amir, `/v1/tasks/${draftTask}/edit`, { title: 'No agent', instructions: '', repoIds: [], loaded })
    check(missing.status === 400 && (await missing.text()).includes('agentId'), 'an edit without its agent is refused with a 400 that names the field')
    const stranger = await as(outsider, `/v1/tasks/${draftTask}/edit`, { title: 'Mine now', instructions: '', agentId: writer, repoIds: [], loaded })
    check(stranger.status === 404, 'a person from another team cannot edit the draft')

    await post(`/v1/tasks/${draftTask}/edit`, { title: 'Draft one, edited', instructions: 'Now over two repos.', agentId: helper, repoIds: [serviceRepo, shopRepo], loaded }, amir)
    const edited = await one<{ title: string; agent_id: string }>('select title, agent_id from tasks where id = $1', [draftTask])
    const repos = await all<{ repo_id: string; is_primary: boolean }>('select repo_id, is_primary from task_repos where task_id = $1 order by is_primary desc', [draftTask])
    const sessionAgent = await one<{ agent_id: string; status: string }>('select agent_id, status from sessions where id = $1', [draftSession])
    check(edited?.title === 'Draft one, edited' && edited.agent_id === helper && repos.length === 2 && repos[0]?.repo_id === serviceRepo
      && repos[0].is_primary && sessionAgent?.agent_id === helper && sessionAgent?.status === 'draft',
    "a teammate's edit changes the draft's title, agent and repos, and it stays a draft")
    const shown = await shapeUntil(alice, 'task_repos', { task: draftTask }, (rows) => rows.length === 2)
    const hidden = await shapeRows(outsider, 'task_repos', { task: draftTask })
    check(shown.rows.length === 2 && shown.rows.some((r) => r.repo_id === serviceRepo && r.is_primary) && hidden.status === 404,
      "the draft's repos read back for its editor, and not for another team")
    // Both open another draft. Amir saves first, and Alice's form still holds the draft as it was.
    const shared = await post('/v1/tasks', { title: 'Shared draft', instructions: '', agentId: writer, draft: true })
    const opened = { title: 'Shared draft', instructions: '', agentId: writer, repoIds: [] }
    await post(`/v1/tasks/${shared.taskId}/edit`, { ...opened, title: 'Shared draft, by Amir', loaded: opened }, amir)
    const stale = await as(alice, `/v1/tasks/${shared.taskId}/edit`, { ...opened, title: 'Shared draft, by Alice', loaded: opened })
    const kept = await one<{ title: string }>('select title from tasks where id = $1', [shared.taskId])
    check(stale.status === 409 && (await stale.text()).includes('changed since') && kept?.title === 'Shared draft, by Amir',
      "a save from a form loaded before a teammate's edit is refused, and the edit stays")

    const started = await post(`/v1/tasks/${draftTask}/start`)
    const startedSession = await one<{ status: string; workspace_id: string | null }>('select status, workspace_id from sessions where id = $1', [draftSession])
    const setup = await one<{ payload: { repos: { name: string }[] } }>(
      `select payload from commands where kind = 'setup_workspace' and payload->>'workspaceId' = $1`, [startedSession?.workspace_id])
    const message = await one<{ n: number }>(`select count(*)::int as n from commands where session_id = $1 and kind = 'message'`, [draftSession])
    check(started.sessionId === draftSession && startedSession?.status !== 'draft' && startedSession?.workspace_id && setup?.payload.repos.length === 2 && message?.n === 1,
      'starting the draft gives its session a workspace with both repos and sends the agent its first message')
    const again = await as(alice, `/v1/tasks/${draftTask}/start`)
    check(again.status === 409 && (await again.text()).includes('already started'), 'a draft starts once, and starting it again says it already started')

    const other = await post('/v1/tasks', { title: 'Draft two', instructions: 'Maybe never.', agentId: writer, draft: true })
    await post(`/v1/tasks/${other.taskId}/discard`)
    const gone = await shapeUntil(amir, 'tasks', {}, (rows) => !rows.some((t) => t.id === other.taskId))
    const restart = await as(alice, `/v1/tasks/${other.taskId}/start`)
    check(!gone.rows.some((t) => t.id === other.taskId) && restart.status === 409 && (await restart.text()).includes('discarded'),
      'a discarded draft leaves the task list and cannot be started')
  })

  await section('several repos', async () => {
    check(await within(60, async () => (await workspaceOf(draftTask))?.status === 'ready'), 'the task with two repos has its workspace set up')
    const workspace = must(await workspaceOf(draftTask), 'the workspace')
    const trees = await all<{ repo_id: string; branch: string; base_commit: string | null }>('select repo_id, branch, base_commit from worktrees where workspace_id = $1', [workspace.id])
    const intro = await one<{ text: string }>(`select text from events where session_id = $1 and kind = 'user' order by seq limit 1`, [draftSession])
    check(trees.length === 2 && trees.every((t) => t.branch.startsWith('task/') && t.base_commit)
      && intro?.text.includes(`./${SERVICE} and ./${SHOP}, each on the branch task/`),
    `both repos are cloned on the task branch, and the first message names both folders: ${intro?.text.split('\n').at(-1) ?? ''}`)

    // No forge repo backs the twin, so its clone fails, and the daemon says so. Only the folder names matter here.
    const twin = must(await one<{ id: string }>('insert into repos (team_id, remote_url) values ($1, $2) returning id',
      [teamId, `${forgeConfig().url}/flow-twin-${id}/${SHOP}.git`]), 'the twin repo').id
    const twins = await post('/v1/tasks', { title: 'Twins', instructions: '', agentId: writer, repoIds: [shopRepo, twin], draft: true })
    twinTask = twins.taskId
    await post(`/v1/tasks/${twins.taskId}/start`)
    const twinSetup = await one<{ payload: { repos: { name: string }[] } }>(
      `select c.payload from commands c join workspaces w on c.payload->>'workspaceId' = w.id::text where w.task_id = $1 and c.kind = 'setup_workspace'`, [twins.taskId])
    const names = twinSetup?.payload.repos.map((r) => r.name).sort().join(' ')
    check(names === [`${org}-${SHOP}`, `flow-twin-${id}-${SHOP}`].sort().join(' '), `two repos with one name each take their owner in their folder: ${names ?? 'no setup'}`)
  })

  await section('a message claimed before its setup', async () => {
    // The API writes a workspace's setup and its first message in one transaction,
    // and a daemon catching up on its queue claimed them the other way round. The
    // check plays the API here so the message is claimed first every time.
    const mac = must(await one<{ id: string }>('select id from instances where name = $1', [`flow-mac-${id}`]), 'the mac').id
    const { taskId } = await post('/v1/tasks', { title: 'In order', instructions: '', agentId: writer, repoIds: [shopRepo], draft: true })
    const session = must(await one<{ id: string }>('select id from sessions where task_id = $1', [taskId]), 'the session').id
    const workspace = must(await one<{ id: string }>(`insert into workspaces (team_id, task_id, instance_id, path) values ($1, $2, $3, '') returning id`,
      [teamId, taskId, mac]), 'the workspace').id
    await db.query(`update sessions set workspace_id = $2, status = 'starting' where id = $1`, [session, workspace])
    const payload = { permissions: { workspaceWrites: true }, text: 'Look at the shop.', agentId: writer, harness: 'claude', model: null, instructions: '', harnessSessionId: null, workspaceId: workspace }
    const message = must(await one<{ id: string }>(`insert into commands (team_id, instance_id, session_id, kind, payload) values ($1, $2, $3, 'message', $4) returning id`,
      [teamId, mac, session, JSON.stringify(payload)]), 'the message').id
    const claimed = await within(20, async () => (await one<{ status: string }>('select status from commands where id = $1', [message]))?.status !== 'queued')
    await db.query(`insert into commands (team_id, instance_id, kind, payload) values ($1, $2, 'setup_workspace', $3)`,
      [teamId, mac, JSON.stringify({ workspaceId: workspace, repos: [{ repoId: shopRepo, name: SHOP, branch: 'task/in-order', base: 'main', setup: null }] })])
    const ran = await within(60, async () => (await one<{ status: string }>('select status from commands where id = $1', [message]))?.status === 'done')
    const failed = await one<{ error: string | null }>('select error from commands where id = $1', [message])
    check(claimed && ran, `a message claimed before its workspace's setup waits for it, then runs${failed?.error ? `: ${failed.error}` : ''}`)
  })

  await section('changes', async () => {
    const workspace = must(await workspaceOf(draftTask), 'the workspace')
    const first = await within(60, async () => (await changesOf(draftTask)).length === 2)
    const rows = await changesOf(draftTask)
    const readme = rows.find((r) => r.path === 'README.md')
    const notes = rows.find((r) => r.path === 'notes.txt')
    check(first && readme?.repo.endsWith(`/${SHOP}.git`) && readme.status === 'added' && readme.additions === 3
      && notes?.repo.endsWith(`/${SERVICE}.git`) && notes.status === 'added',
    `the Changes list has each file the agent wrote, in each repo: ${rows.map((r) => `${r.path} ${r.status}`).join(', ')}`)
    check(readme?.content?.includes('[secret:FLOW_TEST_TOKEN]') && readme.diff?.includes('[secret:FLOW_TEST_TOKEN]')
      && !JSON.stringify(rows).includes(SECRET), 'a secret in a changed file is scrubbed on the machine, in its content and its diff')
    check(readme?.preview === 'text' && readme.diff?.includes('new file mode') && readme.diff.includes('+# Shop'), "a file's diff is git's diff against the base")

    const list = await shapeUntil(amir, 'file_changes', { task: draftTask }, (rows) => rows.some((r) => r.path === 'README.md'))
    const listed = list.rows.find((r) => r.path === 'README.md')
    const detail = listed ? await shapeUntil(amir, 'file_change', { id: String(listed.id) }, (rows) => rows.length === 1) : { status: 0, rows: [] }
    const strangers = await shapeRows(outsider, 'file_changes', { task: draftTask })
    check(listed && !('content' in listed) && detail.rows[0]?.content?.includes('# Shop') && strangers.status === 404,
      "a teammate reads the list without contents and one file with them, and another team's person reads nothing")

    // Edit the checkout by hand, as an agent's command would, then let a turn end.
    const shop = join(workspace.path, SHOP)
    const service = join(workspace.path, SERVICE)
    writeFileSync(join(shop, 'checkout.js'), readFileSync(join(shop, 'checkout.js'), 'utf8').replace('amount - 10', 'Math.max(0, amount - 10)'))
    rmSync(join(shop, 'test/checkout.test.js'))
    rmSync(join(shop, 'README.md'))
    writeFileSync(join(service, 'logo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 0, 1, 2, 3]))
    const notesBefore = notes?.updated_at.getTime()
    await post(`/v1/sessions/${draftSession}/messages`, { text: 'Tidy up.' })
    const settled = await within(60, async () => {
      const now = await changesOf(draftTask)
      return now.some((r) => r.path === 'logo.bin') && !now.some((r) => r.path === 'README.md') && now.some((r) => r.path === 'test/checkout.test.js')
    })
    const after = await changesOf(draftTask)
    const checkout = after.find((r) => r.path === 'checkout.js')
    const removed = after.find((r) => r.path === 'test/checkout.test.js')
    const logo = after.find((r) => r.path === 'logo.bin')
    check(settled && checkout?.status === 'modified' && checkout.additions === 1 && checkout.deletions === 1
      && checkout.diff?.includes("\n-  if (code === 'TENOFF') return amount - 10\n") && checkout.diff.includes("\n+  if (code === 'TENOFF') return Math.max(0, amount - 10)\n")
      && checkout.content?.includes('Math.max(0, amount - 10)'),
    'a file changed in the workspace shows as modified, with its content and diff')
    check(removed?.status === 'deleted' && removed.content === null && removed.diff?.includes('deleted file mode'), 'a deleted file shows as deleted, with its diff and no content')
    check(logo?.preview === 'binary' && logo.content === null && logo.diff === null, 'a binary file is listed without content or diff')
    check(settled && !after.some((r) => r.path === 'README.md'), 'a file taken back out leaves the list')
    check(after.find((r) => r.path === 'notes.txt')?.updated_at.getTime() === notesBefore, 'a file that did not change is not written again')

    // Each turn's end sends the workspace's changes again.
    const turn = (text: string) => post(`/v1/sessions/${draftSession}/messages`, { text })
    // git only looks for a NUL byte in a file's first 8,000 bytes when it decides whether the file is text.
    writeFileSync(join(service, 'late-nul.txt'), `${'a'.repeat(9000)}\0tail\n`)
    await turn('Look again.')
    const nul = await within(60, async () => (await changesOf(draftTask)).some((r) => r.path === 'late-nul.txt'))
    const late = (await changesOf(draftTask)).find((r) => r.path === 'late-nul.txt')
    check(nul && late?.preview === 'binary' && late.content === null, 'a file with a NUL byte past where git looks is listed as binary')

    const many = join(shop, 'many')
    mkdirSync(many)
    for (let n = 0; n <= 20_000; n++) writeFileSync(join(many, `f${n}.txt`), `${n}\n`)
    await turn('Look at all of it.')
    const overflowed = await within(90, async () => (await unlistedOf(draftTask)).some((u) => u.repo_id === shopRepo && u.kind === 'too_many'))
    const shopRows = (await changesOf(draftTask)).filter((r) => r.repo.endsWith(`/${SHOP}.git`))
    const serviceKept = (await changesOf(draftTask)).some((r) => r.path === 'notes.txt')
    check(overflowed && !shopRows.length && serviceKept, 'a repo with more than 20,000 changed files is marked too many, its list cleared, and the other repo still listed')
    rmSync(many, { recursive: true, force: true })
    await turn('Tidy that away.')
    const listedAgain = await within(60, async () => !(await unlistedOf(draftTask)).length && (await changesOf(draftTask)).some((r) => r.path === 'checkout.js'))
    check(listedAgain, 'once the files go, the repo is listed again')

    // A file git cannot read fails the second repo's scan, and the first repo's changes still arrive.
    writeFileSync(join(service, 'locked.txt'), 'private\n')
    chmodSync(join(service, 'locked.txt'), 0o000)
    writeFileSync(join(shop, 'fresh.txt'), 'fresh\n')
    await turn('One more look.')
    const fresh = await within(60, async () => (await changesOf(draftTask)).some((r) => r.path === 'fresh.txt'))
    const unreadable = (await unlistedOf(draftTask)).find((u) => u.repo_id === serviceRepo)
    const serviceStill = (await changesOf(draftTask)).some((r) => r.path === 'notes.txt')
    check(fresh && unreadable?.kind === 'unreadable' && unreadable.reason?.includes('locked.txt') && serviceStill,
      `a repo git cannot read is marked unreadable and keeps its last list, and the other repo's changes still arrive: ${unreadable?.reason ?? 'no reason'}`)
    chmodSync(join(service, 'locked.txt'), 0o644)
    rmSync(join(service, 'locked.txt'))
    await turn('All readable again.')
    check(await within(60, async () => !(await unlistedOf(draftTask)).length), 'once git can read it again, the repo is listed again')

    const foreign = await fetch(`${API}/v1/workspaces/${workspace.id}/changes`, {
      method: 'POST', headers: { authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ repos: [] }),
    })
    const malformed = await fetch(`${API}/v1/workspaces/${workspace.id}/changes`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ repos: [{ state: 'listed', repoId: shopRepo, files: [] }] }),
    })
    check(foreign.status === 404 && malformed.status === 400 && (await malformed.text()).includes('baseCommit'),
      "another team's machine cannot post a workspace's changes, and a post missing its base is refused")
  })

  await section('pull requests', async () => {
    const ask = { title: 'Add a README and notes', body: 'From step 14.' }
    const pushed = (pushId: string) => within(60, async () => (await one<{ status: string }>('select status from pushes where id = $1', [pushId]))?.status !== 'pushing')
    // Set the session working by hand: the fake agent's turns end too fast to catch one.
    await db.query(`update sessions set status = 'running' where id = $1`, [draftSession])
    const busy = await as(alice, `/v1/tasks/${draftTask}/pull-requests`, ask)
    await db.query(`update sessions set status = 'idle' where id = $1`, [draftSession])
    check(busy.status === 409 && (await busy.text()).includes('still working'), 'no pull request opens while the agent is working')

    const { pushId } = await post(`/v1/tasks/${draftTask}/pull-requests`, ask)
    const ended = await pushed(pushId)
    const push = await one<{ status: string; error: string | null }>('select status, error from pushes where id = $1', [pushId])
    const links = await all<{ title: string; state: string }>(`select title, state from artifacts where task_id = $1 and kind = 'link' order by title`, [draftTask])
    check(ended && push?.status === 'done' && links.length === 2 && links.every((l) => l.state === 'open')
      && links.some((l) => l.title.includes(`${org}/${SHOP}`)) && links.some((l) => l.title.includes(`${org}/${SERVICE}`)),
    `a pull request opens for each repo with changes, and shows on the task: ${links.map((l) => l.title).join(', ') || (push?.error ?? 'none')}`)

    const slug = must(await one<{ slug: string }>('select slug from tasks where id = $1', [draftTask]), 'the slug').slug
    const open = await forgeAdmin.call<{ number: number; title: string; body: string; head: { ref: string } }[]>('GET', `/repos/${org}/${SHOP}/pulls?state=open`)
    const pr = open.find((p) => p.head.ref === `task/${slug}`)
    const files = pr ? await forgeAdmin.call<{ filename: string }[]>('GET', `/repos/${org}/${SHOP}/pulls/${pr.number}/files`) : []
    const commits = pr ? await forgeAdmin.call<{ commit: { author: { name: string } } }[]>('GET', `/repos/${org}/${SHOP}/pulls/${pr.number}/commits`) : []
    check(pr?.title === ask.title && pr.body === ask.body && files.some((f) => f.filename === 'checkout.js')
      && commits.length > 0 && commits.every((c) => c.commit.author.name === 'helper'),
    "the forge has the pull request on the task branch, with the change, in the task agent's name")
    const seen = await shapeUntil(amir, 'pushes', { task: draftTask }, (rows) => rows.some((r) => r.id === pushId && r.status === 'done'))
    check(seen.rows.some((r) => r.id === pushId && r.status === 'done' && r.error === null), 'a teammate sees how the push went')

    const again = await post(`/v1/tasks/${draftTask}/pull-requests`, ask)
    await pushed(again.pushId)
    const linksAgain = await all(`select 1 from artifacts where task_id = $1 and kind = 'link'`, [draftTask])
    const openAgain = await forgeAdmin.call<unknown[]>('GET', `/repos/${org}/${SHOP}/pulls?state=open`)
    check(linksAgain.length === 2 && openAgain.length === open.length, 'asking again opens no second pull request')

    const branchFile = `/repos/${org}/${SHOP}/contents/from-the-forge.txt`
    await forgeAdmin.call('POST', branchFile, { content: Buffer.from('Added on the forge.\n').toString('base64'), message: 'Added on the forge', branch: `task/${slug}` })
    const third = await post(`/v1/tasks/${draftTask}/pull-requests`, ask)
    await pushed(third.pushId)
    const refused = await one<{ status: string; error: string | null }>('select status, error from pushes where id = $1', [third.pushId])
    const survived = await forgeAdmin.call('GET', `${branchFile}?ref=task/${slug}`).then(() => true, () => false)
    check(refused?.status === 'failed' && survived, `a push never overwrites a commit added on the forge since the last push: ${refused?.error?.slice(0, 120) ?? 'no error'}`)

    const quiet = await post('/v1/tasks', { title: 'Look around', instructions: 'Change nothing.', agentId: writer, repoIds: [shopRepo] })
    await within(60, async () => (await one<{ status: string }>('select status from sessions where id = $1', [quiet.sessionId]))?.status === 'idle')
    const nothing = await post(`/v1/tasks/${quiet.taskId}/pull-requests`, { title: 'Nothing', body: '' })
    await pushed(nothing.pushId)
    const failed = await one<{ status: string; error: string | null }>('select status, error from pushes where id = $1', [nothing.pushId])
    check(failed?.status === 'failed' && failed.error?.includes('nothing to open'), `a task with no changes opens no pull request, and says why: ${failed?.error ?? 'no error'}`)

    const leaked = `ghp_${randomBytes(18).toString('hex')}`
    const titled = await post(`/v1/tasks/${quiet.taskId}/pull-requests`, { title: `Ship ${leaked}`, body: `Uses ${leaked}` })
    await pushed(titled.pushId)
    const stored = JSON.stringify([
      await one('select title, body from pushes where id = $1', [titled.pushId]),
      await one(`select c.payload from commands c join pushes p on p.command_id = c.id where p.id = $1`, [titled.pushId]),
    ])
    check(!stored.includes(leaked) && stored.includes('[secret:github]'), "a pull request's title and body are scrubbed before they are stored or pushed")

    // A machine that went away mid-push leaves the push running. Once it is old, it no longer blocks a new one.
    const mac = must(await one<{ id: string }>('select id from instances where name = $1', [`flow-mac-${id}`]), 'the mac').id
    const quietWorkspace = must(await workspaceOf(quiet.taskId), 'the quiet workspace').id
    const lostPayload = { workspaceId: quietWorkspace, repos: [], message: 'Lost', author: 'writer' }
    const lost = must(await one<{ id: string }>(`insert into commands (team_id, instance_id, kind, payload, status, claimed_at)
      values ($1, $2, 'push', $3, 'claimed', now() - interval '20 minutes') returning id`, [teamId, mac, JSON.stringify(lostPayload)]), 'the lost push command').id
    const stuck = must(await one<{ id: string }>(`insert into pushes (team_id, task_id, workspace_id, command_id, title, body, created_at)
      values ($1, $2, $3, $4, 'Lost', '', now() - interval '20 minutes') returning id`, [teamId, quiet.taskId, quietWorkspace, lost]), 'the stuck push').id
    const fresh = await as(alice, `/v1/tasks/${quiet.taskId}/pull-requests`, { title: 'After the lost one', body: '' })
    const expired = await one<{ status: string; error: string | null }>('select status, error from pushes where id = $1', [stuck])
    check(fresh.ok && expired?.status === 'failed' && expired.error?.includes('did not finish'), `a push stuck for 20 minutes expires, and a new one starts: ${expired?.error ?? expired?.status ?? 'gone'}`)
    if (fresh.ok) await pushed(((await fresh.json()) as { pushId: string }).pushId)
  })

  await section('a failed clone and a failed push leak no token', async () => {
    // The twin task's second repo has no forge repo behind it, so its clone fails, and its first message with it.
    const cloneFailed = await within(60, async () => (await one<{ n: number }>(
      `select count(*)::int as n from events where kind = 'error' and session_id in (select id from sessions where task_id = $1)`, [twinTask]))?.n === 1)
    const cloneRecord = await recordOf(twinTask)
    check(cloneFailed && cloneRecord.includes('failed') && !cloneRecord.includes('machine_'),
      "a failed clone fails the setup and the first message, and neither the commands nor the transcript hold the machine's token")

    const nowhere = await post('/v1/tasks', { title: 'Push nowhere', instructions: 'Nothing to do.', agentId: writer, repoIds: [goneRepo] })
    await within(60, async () => (await one<{ status: string }>('select status from sessions where id = $1', [nowhere.sessionId]))?.status === 'idle')
    await forgeAdmin.call('DELETE', `/repos/${org}/${GONE}`)
    const { pushId } = await post(`/v1/tasks/${nowhere.taskId}/pull-requests`, { title: 'Nowhere', body: '' })
    await within(60, async () => (await one<{ status: string }>('select status from pushes where id = $1', [pushId]))?.status !== 'pushing')
    const push = await one<{ status: string; error: string | null }>('select status, error from pushes where id = $1', [pushId])
    const pushRecord = await recordOf(nowhere.taskId)
    check(push?.status === 'failed' && push.error?.includes('push failed') && !pushRecord.includes('machine_'),
      `a failed push says so, and neither its command nor the push hold the machine's token: ${push?.error?.slice(0, 120) ?? 'no error'}`)
  })

  await section('order of work', async () => {
    type Answer = { ready: { id: string; title: string }[]; held: { id: string; kind: string; reason: string; until: string | null }[] }
    const readyFor = async (who: string): Promise<Answer> => {
      const res = await fetch(`${PEOPLE}/v1/tasks/ready`, { headers: { 'tailscale-user-login': who } })
      if (!res.ok) throw new Error(`/v1/tasks/ready: ${res.status} ${await res.text()}`)
      return res.json() as Promise<Answer>
    }
    const queue = async (title: string) => String((await post('/v1/tasks', { title, instructions: '', agentId: writer, draft: true })).taskId)
    const [a, b, c, d] = [await queue('Order A, the base'), await queue('Order B, stacked on A'), await queue('Order C, urgent'), await queue('Order D, later')]
    const mine = (answer: Answer) => answer.ready.map((t) => t.id).filter((taskId) => [a, b, c, d].includes(taskId))
    await post(`/v1/tasks/${c}/priority`, { priority: 0 })

    const added = await post(`/v1/tasks/${b}/blockers`, { blockerId: a, reason: 'Its branch stacks on A' })
    const again = await post(`/v1/tasks/${b}/blockers`, { blockerId: a, reason: 'Its branch stacks on A' })
    check(added.already === false && again.already === true, 'adding the same edge twice changes nothing the second time, and says so')
    const stranger = must(await one<{ id: string }>(`insert into tasks (team_id, slug, title) select id, $2, 'Elsewhere' from teams where name = $1 returning id`,
      [otherTeam, `elsewhere-${id}`]), 'the other team task').id
    const cycle = await as(alice, `/v1/tasks/${a}/blockers`, { blockerId: b, reason: null })
    const itself = await as(alice, `/v1/tasks/${a}/blockers`, { blockerId: a, reason: null })
    const foreign = await as(alice, `/v1/tasks/${a}/blockers`, { blockerId: stranger, reason: null })
    check(cycle.status === 409 && (await cycle.text()).includes('wait on each other') && itself.status === 400 && foreign.status === 404,
      "an edge that would close a cycle, an edge to the task itself and one to another team's task are refused")

    const held = await post(`/v1/tasks/${d}/hold`, { kind: 'decision', reason: 'Waiting on Tayler', until: null })
    const heldAgain = await post(`/v1/tasks/${d}/hold`, { kind: 'decision', reason: 'Waiting on Tayler', until: null })
    const twoLines = await as(alice, `/v1/tasks/${d}/hold`, { kind: 'decision', reason: 'one\ntwo', until: null })
    check(held.already === false && heldAgain.already === true && twoLines.status === 400, 'a hold is set once, and its reason must be one line')

    const first = await readyFor(alice)
    check(mine(first).join(' ') === [c, a].join(' '), 'ready lists queued tasks that nothing blocks or holds, the most urgent first, then the oldest')
    check(first.held.some((t) => t.id === d && t.kind === 'decision' && t.reason === 'Waiting on Tayler' && t.until === null), 'held work shows apart, with its kind and reason')
    check(mine(await readyFor(amir)).join(' ') === [c, a].join(' ') && !mine(await readyFor(outsider)).length,
      "a teammate sees the same ready list, and another team's person sees none of it")

    const today = must(await one<{ day: string }>('select current_date::text as day'), 'the date').day
    await post(`/v1/tasks/${d}/hold`, { kind: 'future', reason: 'Not before today', until: today })
    const lapsed = await readyFor(alice)
    check(mine(lapsed).includes(d) && !lapsed.held.some((t) => t.id === d), 'a hold lapses on its until date, and the task is ready again')
    const removedHold = await post(`/v1/tasks/${d}/unhold`)
    const removedHoldAgain = await post(`/v1/tasks/${d}/unhold`)
    check(removedHold.already === false && removedHoldAgain.already === true, 'lifting a hold twice changes nothing the second time')

    const discard = await as(alice, `/v1/tasks/${a}/discard`)
    const refusal = await discard.json() as { error?: string }
    check(discard.status === 409 && refusal.error === 'this task still blocks "Order B, stacked on A"', `a task that queued work waits on cannot be discarded, and the refusal names that work: ${refusal.error ?? ''}`)
    const done = await post(`/v1/tasks/${a}/done`)
    const doneAgain = await post(`/v1/tasks/${a}/done`)
    const freed = await readyFor(alice)
    const doneHold = await as(alice, `/v1/tasks/${a}/hold`, { kind: 'parked', reason: 'No', until: null })
    check(done.already === false && doneAgain.already === true && mine(freed).includes(b) && !mine(freed).includes(a) && doneHold.status === 409,
      'marking the blocker done frees the task waiting on it, marking it again changes nothing, and a done task takes no hold')
    await post(`/v1/tasks/${a}/reopen`)
    const reopenAgain = await post(`/v1/tasks/${a}/reopen`)
    check(reopenAgain.already === true && !mine(await readyFor(alice)).includes(b), 'reopening the blocker blocks its dependent again')
    const unblocked = await post(`/v1/tasks/${b}/blockers/${a}/remove`)
    const unblockedAgain = await post(`/v1/tasks/${b}/blockers/${a}/remove`)
    check(unblocked.already === false && unblockedAgain.already === true && mine(await readyFor(alice)).includes(b), 'removing the edge frees the task, and removing it again changes nothing')

    // Agents read the same list through their team-record tool, as a session on this machine.
    const client = new Client({ name: 'step14', version: '1.0.0' })
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [join(ROOT, 'daemon/record-mcp.ts')],
      env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_SESSION: draftSession },
    }))
    const result = await client.callTool({ name: 'ready_tasks', arguments: {} })
    await client.close()
    const said = JSON.stringify(result.content)
    check(said.indexOf('Order C, urgent') < said.indexOf('Order A, the base') && said.includes('Order B, stacked on A') && said.includes('1. Order C, urgent'),
      `an agent's ready_tasks tool lists the same tasks in the same order: ${said.slice(0, 160)}`)
  })

  await section('writing without asking', async () => {
    const starts = () => readFileSync(join(home, 'claude-args.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { cwd: string; args: string[] })
    const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
    const tools = (args: string[]) => (flag(args, '--allowedTools') ?? '').split(',')
    const startedIn = (folder: string) => starts().find((s) => s.cwd.startsWith(folder))

    const task = startedIn(join(home, 'workspaces'))
    check(task && flag(task.args, '--permission-mode') === 'acceptEdits' && !tools(task.args).includes('Bash'),
      "a task's session on a Mac changes files in its workspace without asking, and still asks before commands")

    const { conversationId } = await post('/v1/conversations', { kind: 'dm', agent: 'writer' })
    await post(`/v1/conversations/${conversationId}/messages`, { text: 'Hello there.' })
    await within(30, async () => startedIn(join(home, 'agents')))
    const dm = startedIn(join(home, 'agents'))
    check(dm && flag(dm.args, '--permission-mode') === undefined && !tools(dm.args).includes('Bash'),
      "a conversation's session asks before writes and commands, as before")

    // An instance of the box kind, whose daemon runs here rather than in a container.
    const { token: boxToken } = JSON.parse(node('server/admin.ts', 'add-instance', team, `flow-box-${id}`, 'box', alice))
    const { agentId: boxer } = JSON.parse(node('server/admin.ts', 'add-agent', team, 'boxer', `flow-box-${id}`, '', 'You work on a box.'))
    const boxHome = join(home, 'box')
    mkdirSync(boxHome)
    startDaemon(boxToken, boxHome)
    await post('/v1/tasks', { title: 'On the box', instructions: 'Nothing to do.', agentId: boxer, repoIds: [shopRepo] })
    await within(60, async () => startedIn(join(boxHome, 'workspaces')))
    const box = startedIn(join(boxHome, 'workspaces'))
    check(box && flag(box.args, '--permission-mode') === 'acceptEdits' && !tools(box.args).includes('Bash'),
      "a task's session on a box changes files without asking, and still asks before commands")
  })

  await section('research, plan and implement', async () => {
    type Ask = { id: string; kind: string; payload: { stage?: string; question: string; labels: { approve: string; reject: string } | null } }
    const openAsk = (runId: string) => one<Ask>(`select id, kind, payload from asks where run_id = $1 and status = 'open' order by created_at desc limit 1`, [runId])
    // The run's next open ask at that stage, other than the one just answered.
    const askAt = async (runId: string, stage: string, after?: string) => {
      await within(120, async () => {
        const ask = await openAsk(runId)
        return ask?.payload.stage === stage && ask.id !== after
      })
      const ask = await openAsk(runId)
      return ask?.payload.stage === stage && ask.id !== after ? ask : undefined
    }
    const stagesOf = (runId: string) => all<{ stage: string; outcome: string | null; summary: string | null }>(
      'select stage, outcome, summary from run_stages where run_id = $1 order by n', [runId])
    const documentOf = (runId: string, path: string) => one<{ id: string; current_version: number }>(
      'select id, current_version from artifacts where task_id = (select task_id from runs where id = $1) and path = $2', [runId, path])

    await within(60, async () => (await one(`select 1 from pipelines where team_id = $1 and name = 'research-plan-implement' and current_version_id is not null`, [teamId])))
    const pipeline = await one<{ id: string; error: string | null }>(
      `select p.id, v.error from pipelines p join pipeline_versions v on v.id = p.current_version_id where p.team_id = $1 and p.name = 'research-plan-implement'`, [teamId])
    check(pipeline && pipeline.error === null, 'the pipeline loads from its file and is current')
    const pipelineId = must(pipeline, 'the pipeline').id

    const { runId } = await post(`/v1/pipelines/${pipelineId}/runs`, { title: 'RPIFLOW: TENOFF goes below zero', body: 'A $5 order with TENOFF comes to -$5.00.', repoId: shopRepo })
    const first = await askAt(runId, 'review_research')
    const research = await documentOf(runId, 'research.md')
    check(first?.kind === 'gate' && first.payload.labels?.approve === 'Approve research' && first.payload.labels.reject === 'Send back' && research?.current_version === 1,
      'the research reaches its gate with research.md, and the buttons say what they do')

    const doc = must(research, 'research.md')
    const { commentId } = await post(`/v1/artifacts/${doc.id}/comments`, { version: 1, text: 'Which function?', quote: 'checkout.js', occurrence: 0 })
    const anchor = await one<{ anchor: unknown }>('select anchor from comments where id = $1', [commentId])
    const unplaced = await as(alice, `/v1/artifacts/${doc.id}/comments`, { version: 1, text: 'Somewhere.', occurrence: 2 })
    check(JSON.stringify(anchor?.anchor) === JSON.stringify({ quote: 'checkout.js', occurrence: 0 }) && unplaced.status === 400,
      'a comment keeps its quote and which match it means, and one that places no quote is refused')

    await post(`/v1/asks/${must(first, 'the research gate').id}/answer`, { decision: 'reject', message: 'Name the function too.' })
    const second = await askAt(runId, 'review_research', first?.id)
    const prompts = await all<{ text: string }>(
      `select e.text from events e where e.kind = 'user' and e.session_id = (select session_id from run_stages where run_id = $1 and stage = 'research' and session_id is not null order by n limit 1) order by e.seq`, [runId])
    check(second && prompts[1]?.text.includes('Name the function too.') && prompts[1].text.includes('- On "checkout.js": Which function?')
      && (await documentOf(runId, 'research.md'))?.current_version === 2,
    'sending research back gives the agent the note and each comment with its quote, and it writes a second version')

    const read = (who: string, path: string) => fetch(PEOPLE + path, { headers: { 'tailscale-user-login': who } })
    const revised = await read(amir, `/v1/artifacts/${doc.id}/versions/2/diff`)
    const { diff } = revised.ok ? await revised.json() as { diff: string } : { diff: '' }
    const hidden = await read(outsider, `/v1/artifacts/${doc.id}/versions/2/diff`)
    check(diff.includes('\n-The discount lives in checkout.js.\n') && diff.includes('\n+The discount lives in checkout.js, in discount().\n') && hidden.status === 404,
      "a teammate reads what changed in research.md from its first version, and another team's person cannot")

    await post(`/v1/asks/${must(second, 'the second research gate').id}/answer`, { decision: 'approve' })
    const planGate = await askAt(runId, 'review_plan')
    check(planGate && (await documentOf(runId, 'plan.md'))?.current_version === 1, 'the plan reaches its gate with plan.md')
    await post(`/v1/asks/${must(planGate, 'the plan gate').id}/answer`, { decision: 'approve' })
    const changeGate = await askAt(runId, 'review_change')
    check(changeGate?.payload.question.includes('ready for review') && changeGate.payload.labels?.approve === 'Merge', 'the implementation, once verified, reaches its review')
    await post(`/v1/asks/${must(changeGate, 'the change gate').id}/answer`, { decision: 'approve' })
    await within(60, async () => (await one<{ status: string }>('select status from runs where id = $1', [runId]))?.status === 'done')
    const stages = await stagesOf(runId)
    check(stages.map((s) => s.stage).join(' ') === 'research research_untouched review_research research research_untouched review_research plan plan_untouched review_plan implement verify implement verify open_pr review_change merge'
      && stages.filter((s) => s.stage === 'verify').map((s) => s.outcome).join(' ') === 'fails passes',
    `the run went through each phase, with a send-back and a failed verification: ${stages.map((s) => `${s.stage}:${s.outcome ?? ''}`).join(' ')}`)
    const main = await forgeAdmin.call<{ content: string }>('GET', `/repos/${org}/${SHOP}/contents/checkout.js?ref=main`)
    check(Buffer.from(main.content, 'base64').toString().includes('Math.max(0, amount - 10)'), 'the approved change is merged on the forge')

    const docs = await shapeUntil(amir, 'documents', {}, (rows) => rows.some((d) => d.path === 'plan.md'))
    const strangers = await shapeRows(outsider, 'documents')
    check(docs.rows.some((d) => d.path === 'research.md') && docs.rows.some((d) => d.path === 'plan.md') && docs.rows.every((d) => !('content' in d))
      && strangers.status === 200 && !strangers.rows.some((d) => d.path === 'research.md'),
    "a teammate's documents list has the run's documents without contents, and another team's has none of them")

    const touch = await post(`/v1/pipelines/${pipelineId}/runs`, { title: 'RPITOUCH: research that edits', body: 'Look, do not touch.', repoId: shopRepo })
    await within(120, async () => (await openAsk(touch.runId))?.kind === 'question')
    const handoff = await openAsk(touch.runId)
    const touched = (await stagesOf(touch.runId)).filter((s) => s.stage === 'research_untouched')
    const retry = await one<{ text: string }>(
      `select e.text from events e where e.kind = 'user' and e.session_id = (select session_id from run_stages where run_id = $1 and stage = 'research' and session_id is not null order by n limit 1) order by e.seq offset 1 limit 1`, [touch.runId])
    check(handoff?.payload.question.includes('research has run 3 times') && touched.length === 3 && touched.every((s) => s.outcome === 'fails' && s.summary?.includes('oops.txt'))
      && retry?.text.includes('The runner found changes'),
    'research that changes code fails the runner\'s check, goes back to the agent, and reaches a person after three tries')
    if (handoff) await post(`/v1/asks/${handoff.id}/answer`, { decision: 'stop' })
  })

  await section('a message for a workspace gone from disk', async () => {
    const lost = await post('/v1/tasks', { title: 'Lost folder', instructions: 'Nothing to do.', agentId: writer, repoIds: [shopRepo] })
    await within(60, async () => (await one<{ status: string }>('select status from sessions where id = $1', [lost.sessionId]))?.status === 'idle')
    const workspace = must(await workspaceOf(lost.taskId), 'the lost workspace')
    // A new daemon process knows nothing of the setups the old one ran.
    daemon.kill('SIGTERM')
    await once(daemon, 'exit')
    rmSync(workspace.path, { recursive: true, force: true })
    daemon = startDaemon(token, home)
    await post(`/v1/sessions/${lost.sessionId}/messages`, { text: 'Are you still there?' })
    await post(`/v1/sessions/${lost.sessionId}/interrupt`)
    const commandOf = (kind: string) => one<{ status: string; error: string | null }>(
      'select status, error from commands where session_id = $1 and kind = $2 order by created_at desc limit 1', [lost.sessionId, kind])
    const failedFast = await within(30, async () => (await commandOf('message'))?.status === 'failed')
    const message = await commandOf('message')
    const behind = await within(30, async () => !['queued', 'claimed'].includes((await commandOf('interrupt'))?.status ?? 'queued'))
    check(failedFast && message?.error?.includes('is not set up on this machine') && behind,
      `a message for a workspace gone from disk fails at once, and an interrupt behind it is not held up: ${message?.error ?? message?.status ?? 'no command'}`)
  })
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack ?? ''}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) {
    await db.query('delete from teams where name = any($1)', [[team, otherTeam]]).catch(() => undefined)
    for (const repo of [SHOP, SERVICE, GONE, PIPES]) await forgeAdmin.call('DELETE', `/repos/${org}/${repo}`).catch(() => undefined)
  }
  await db.end().catch(() => undefined)
}

console.log(`\n${failures.length ? `${failures.length} failed (teams ${team}, ${otherTeam} and forge repos kept)` : 'all passed (test teams and repos removed)'}`)
process.exit(failures.length ? 1 : 0)
