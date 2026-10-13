// Step 14: the work layer, against a real API, daemon, forge and runner, with the
// stand-in for Claude. Draft tasks are saved, edited by a teammate, started once
// and discarded. A task over two repos clones both and names both. The Changes
// list holds every file the agent added, changed or deleted in each repo, with
// its diff against the base and secrets scrubbed on the machine.
//   npm run check:step14

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Shape, ShapeStream, type Row } from '@electric-sql/client'
import pg from 'pg'
import { forgeAdmin, forgeConfig } from '../server/forge.ts'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
// Ports 7960 to 7979 are this step's: machines, people, then the stream server.
const PORT = 7960
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const id = randomBytes(4).toString('hex')
const [team, otherTeam] = [`flow-${id}`, `flow-x-${id}`]
const [alice, amir, outsider] = [`alice-flow-${id}@local`, `amir-flow-${id}@local`, `out-flow-${id}@local`]
const [SHOP, SERVICE] = [`flow-shop-${id}`, `flow-api-${id}`]
const org = forgeConfig().org
// Only the daemon knows it, so finding it scrubbed proves the machine scrubbed it.
const SECRET = `flow-${randomBytes(12).toString('hex')}`

const SCENARIO = {
  turns: [
    { match: 'Draft one, edited', write: { [`${SHOP}/README.md`]: `# Shop\n\nCheckout math. The token is ${SECRET}.\n`, [`${SERVICE}/notes.txt`]: 'Notes\n' }, reply: 'Wrote the README and the notes.' },
  ],
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

function startDaemon(token: string, daemonHome: string) {
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: daemonHome, AGENTS_CLAUDE_BIN: claudeWrapper(),
      AGENTS_FAKE_SCENARIO: join(home, 'scenario.json'), FLOW_TEST_TOKEN: SECRET,
    },
  }))
}

const workspaceOf = (taskId: string) => one<{ id: string; status: string; path: string }>(
  'select id, status, path from workspaces where task_id = $1 order by created_at desc limit 1', [taskId])
const changesOf = (taskId: string) => all<{ repo: string; path: string; status: string; additions: number; deletions: number; preview: string; content: string | null; diff: string | null; updated_at: Date }>(
  `select r.remote_url as repo, f.path, f.status, f.additions, f.deletions, f.preview, f.content, f.diff, f.updated_at
   from file_changes f join repos r on r.id = f.repo_id where f.task_id = $1 order by f.path`, [taskId])

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
  const repoIdOf = async (name: string) => must(await one<{ id: string }>(
    'insert into repos (team_id, remote_url) values ($1, $2) returning id', [teamId, `${forgeConfig().url}/${org}/${name}.git`]), name).id
  const shopRepo = await repoIdOf(SHOP)
  const serviceRepo = await repoIdOf(SERVICE)
  // A slow setup in the first repo. An agent that started before setup ended would
  // write into the second repo's folder before its clone, and the clone would fail.
  await db.query(`update repos set setup_command = 'sleep 2' where id = $1`, [serviceRepo])

  writeFileSync(join(home, 'scenario.json'), JSON.stringify(SCENARIO))
  children.push(spawn(process.execPath, ['--env-file=.env', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_PORT: String(PORT + 1),
      AGENTS_STREAMS_PORT: String(PORT + 2), AGENTS_STREAMS_DIR: join(home, 'streams'), AGENTS_BOX_TOKEN_FILE: join(home, 'no-box-token'),
    },
  }))
  await within(20, () => fetch(API).then(() => true, () => false))
  startDaemon(token, home)
  await within(20, async () => (await one<{ status: string }>('select status from instances where name = $1', [`flow-mac-${id}`]))?.status === 'online')

  let draftTask = ''
  let draftSession = ''

  await section('drafts', async () => {
    const created = await post('/v1/tasks', { title: 'Draft one', instructions: 'Write it up later.', agentId: writer, repoIds: [shopRepo], draft: true })
    draftTask = created.taskId
    draftSession = created.sessionId
    const session = await one<{ status: string; workspace_id: string | null }>('select status, workspace_id from sessions where id = $1', [draftSession])
    const commands = await one<{ n: number }>(
      `select count(*)::int as n from commands where session_id = $1 or payload->>'workspaceId' in (select id::text from workspaces where task_id = $2)`, [draftSession, draftTask])
    check(session?.status === 'draft' && session.workspace_id === null && commands?.n === 0 && !(await workspaceOf(draftTask)),
      'a draft has a session in the draft status, and no workspace, message or command')

    const tasks = await shapeRows(amir, 'tasks')
    const sessions = await shapeRows(amir, 'sessions', { of: 'tasks' })
    check(tasks.rows.some((t) => t.id === draftTask) && sessions.rows.some((s) => s.id === draftSession && s.status === 'draft'),
      'a teammate sees the draft and its draft status')

    const missing = await as(amir, `/v1/tasks/${draftTask}/edit`, { title: 'No agent', instructions: '', repoIds: [] })
    check(missing.status === 400 && (await missing.text()).includes('agentId'), 'an edit without its agent is refused with a 400 that names the field')
    const stranger = await as(outsider, `/v1/tasks/${draftTask}/edit`, { title: 'Mine now', instructions: '', agentId: writer, repoIds: [] })
    check(stranger.status === 404, 'a person from another team cannot edit the draft')

    await post(`/v1/tasks/${draftTask}/edit`, { title: 'Draft one, edited', instructions: 'Now over two repos.', agentId: helper, repoIds: [serviceRepo, shopRepo] }, amir)
    const edited = await one<{ title: string; agent_id: string }>('select title, agent_id from tasks where id = $1', [draftTask])
    const repos = await all<{ repo_id: string; is_primary: boolean }>('select repo_id, is_primary from task_repos where task_id = $1 order by is_primary desc', [draftTask])
    const sessionAgent = await one<{ agent_id: string; status: string }>('select agent_id, status from sessions where id = $1', [draftSession])
    check(edited?.title === 'Draft one, edited' && edited.agent_id === helper && repos.length === 2 && repos[0]?.repo_id === serviceRepo
      && repos[0].is_primary && sessionAgent?.agent_id === helper && sessionAgent?.status === 'draft',
    "a teammate's edit changes the draft's title, agent and repos, and it stays a draft")

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
    const gone = await shapeRows(amir, 'tasks')
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
    await post(`/v1/tasks/${twins.taskId}/start`)
    const twinSetup = await one<{ payload: { repos: { name: string }[] } }>(
      `select c.payload from commands c join workspaces w on c.payload->>'workspaceId' = w.id::text where w.task_id = $1 and c.kind = 'setup_workspace'`, [twins.taskId])
    const names = twinSetup?.payload.repos.map((r) => r.name).sort().join(' ')
    check(names === [`${org}-${SHOP}`, `flow-twin-${id}-${SHOP}`].sort().join(' '), `two repos with one name each take their owner in their folder: ${names ?? 'no setup'}`)
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

    const list = await shapeRows(amir, 'file_changes', { task: draftTask })
    const listed = list.rows.find((r) => r.path === 'README.md')
    const detail = listed ? await shapeRows(amir, 'file_change', { id: String(listed.id) }) : { status: 0, rows: [] }
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

    const foreign = await fetch(`${API}/v1/workspaces/${workspace.id}/changes`, {
      method: 'POST', headers: { authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ repos: [] }),
    })
    const malformed = await fetch(`${API}/v1/workspaces/${workspace.id}/changes`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ repos: [{ repoId: shopRepo, files: [] }] }),
    })
    check(foreign.status === 404 && malformed.status === 400 && (await malformed.text()).includes('baseCommit'),
      "another team's machine cannot post a workspace's changes, and a post missing its base is refused")
  })
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack ?? ''}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) {
    await db.query('delete from teams where name = any($1)', [[team, otherTeam]]).catch(() => undefined)
    for (const repo of [SHOP, SERVICE]) await forgeAdmin.call('DELETE', `/repos/${org}/${repo}`).catch(() => undefined)
  }
  await db.end().catch(() => undefined)
}

console.log(`\n${failures.length ? `${failures.length} failed (teams ${team}, ${otherTeam} and forge repos kept)` : 'all passed (test teams and repos removed)'}`)
process.exit(failures.length ? 1 : 0)
