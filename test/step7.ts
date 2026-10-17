// Phase 2 step 7: boxes. A pipeline that runs on boxes gets a real Docker
// container built from box/Dockerfile, with the daemon inside it and the
// stand-in for Claude mounted in. The box clones and pushes through the API's
// git proxy, a second run waits for the box, an idle box is stopped, a stopped
// box comes back for the next run with its home folder intact, and recreating it
// from the image keeps that folder. From inside the box only the machine port is
// reachable. The check's API listens on 7701, the port the box firewall keeps
// open for checks.
//   npm run check:step7

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { forgeAdmin, forgeConfig } from '../server/forge.ts'
import { must } from './must.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = 7701
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const id = randomBytes(4).toString('hex')
const team = `step7-${id}`
// The check builds and runs its own image. agents-box:latest is the image the live
// server starts boxes from, so a check run from any branch must leave it alone.
const IMAGE = `agents-box:step7-${id}`
const LIVE_IMAGE = 'agents-box:latest'
const login = `step7-${id}@local`
const org = forgeConfig().org
const [SHOP, PIPES] = [`shop7-${id}`, `pipes7-${id}`]
// Box mounts come from the colima VM, which sees only the home folder.
const work = join(homedir(), '.agents-app', 'checks', `step7-${id}`)

const TEST_FILE = `const test = require('node:test')
const assert = require('node:assert')
const { discount } = require('../checkout.js')

test('TENOFF never goes below zero', () => assert.strictEqual(discount(5, 'TENOFF'), 0))
`
const BOX_CHECK = `export default {
  description: 'Checks that a box can run an agent and a check.',
  agent: 'fixer', runsOn: 'box', spendCapUsd: 1,
  triggers: [{ kind: 'manual' }],
  start: 'look',
  stages: {
    look: { kind: 'agent', allow: ['Bash'], prompt: (ctx) => \`List the files in ./\${ctx.repo}.\`, next: { done: 'tests' } },
    tests: { kind: 'check', command: () => 'npm test', next: { passes: { done: 'succeeded', note: 'The box works.' }, fails: { handoff: 'Tests fail.' } } },
  },
}
`

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...boxEnv } })
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
const tryDocker = (...args: string[]) => { try { return docker(...args) } catch { return null } }

async function within(seconds: number, test: () => Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(500)
  }
  return false
}

const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T | undefined

async function post(path: string, body: unknown = {}) {
  const res = await fetch(PEOPLE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

const run = (runId: string) => one<{ status: string; note: string | null; task_id: string }>('select status, note, task_id from runs where id = $1', [runId])
const box = () => one<{ id: string; name: string; status: string; claimed_by_run: string | null; claimed_by: string | null }>(
  `select i.id, i.name, i.status, i.claimed_by_run, i.claimed_by from instances i join teams t on t.id = i.team_id where t.name = $1 and i.kind = 'box'`, [team])
const running = (container: string) => tryDocker('inspect', '-f', '{{.State.Running}}', container) === 'true'

const boxEnv: Record<string, string> = {
  AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(work, 'people', 'people.sock'), AGENTS_STREAMS_PORT: String(PORT + 2),
  AGENTS_BOX_API: `http://host.docker.internal:${PORT}`, AGENTS_MAX_BOXES: '1', AGENTS_BOX_IDLE_MIN: '1', AGENTS_BOX_IMAGE: IMAGE,
  AGENTS_BOX_DOCKER_ARGS: JSON.stringify([
    '-v', `${join(ROOT, 'test/fake-claude.ts')}:/opt/fake/fake-claude.ts:ro`, '-v', `${join(ROOT, 'test/fake-claude-login.ts')}:/opt/fake/fake-claude-login.ts:ro`,
    '-v', `${join(work, 'scenario.json')}:/opt/fake/scenario.json:ro`,
    '-e', 'AGENTS_CLAUDE_BIN=/opt/fake/fake-claude.ts', '-e', 'AGENTS_FAKE_SCENARIO=/opt/fake/scenario.json',
  ]),
}

let api: ChildProcess | undefined
process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  await db.connect()
  mkdirSync(work, { recursive: true })
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, login)
  node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login)
  node('server/admin.ts', 'add-agent', team, 'fixer', `mac-${id}`)
  const { id: teamId } = must(await one<{ id: string }>('select id from teams where name = $1', [team]), 'teamId')

  await forgeAdmin.ensureRepo(SHOP, Object.fromEntries(['checkout.js', 'package.json', 'test/checkout.test.js']
    .map((f) => [f, readFileSync(join(ROOT, 'ops/seed/shop', f), 'utf8')])), 'step 7 shop', false)
  await forgeAdmin.ensureRepo(PIPES, {
    'shared/pipeline.ts': readFileSync(join(ROOT, 'shared/pipeline.ts'), 'utf8'),
    'pipelines/bug-fix.ts': readFileSync(join(ROOT, 'pipelines/bug-fix.ts'), 'utf8'),
    'pipelines/box-check.ts': BOX_CHECK,
  }, 'step 7 pipelines', false)
  for (const repo of [SHOP, PIPES]) await db.query('insert into repos (team_id, remote_url) values ($1, $2)', [teamId, `${forgeConfig().url}/${org}/${repo}.git`])
  writeFileSync(join(work, 'scenario.json'), JSON.stringify({
    TENOFF: {
      'new,duplicate,already_fixed,not_a_bug': [{ outcome: 'new' }],
      'easy,hard,cannot_reproduce': [{ outcome: 'easy', write: { [`${SHOP}/test/tenoff.test.js`]: TEST_FILE }, data: { test_command: 'node --test test/tenoff.test.js', suite_command: 'npm test' } }],
      'fixed,stuck': [{ outcome: 'fixed', summary: 'TENOFF stops at zero.', replace: { [`${SHOP}/checkout.js`]: ['amount - 10', 'Math.max(0, amount - 10)'] } }],
    },
    default: { done: [{ outcome: 'done', summary: 'Listed the files.' }] },
  }))

  const liveBefore = tryDocker('image', 'inspect', '-f', '{{.Id}}', LIVE_IMAGE)
  node('server/boxes.ts', 'build')
  await servePeople(PORT + 1, join(work, 'people', 'people.sock'))
  api = spawn(process.execPath, ['--env-file=.env', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, ...boxEnv, AGENTS_STREAMS_DIR: join(work, 'streams') },
  })
  children.push(api)
  await within(20, () => fetch(API).then(() => true, () => false))
  // The API records each pipeline file in a transaction of its own, box-check before bug-fix, so wait for both.
  await within(60, async () => (await one<{ n: number }>(
    `select count(*)::int as n from pipelines where team_id = $1 and name in ('box-check', 'bug-fix') and current_version_id is not null`, [teamId]))?.n === 2)
  const pipelineId = async (name: string) => must(await one<{ id: string }>('select id from pipelines where team_id = $1 and name = $2', [teamId, name]), 'pipelineId').id
  const { id: repoId } = must(await one<{ id: string }>('select id from repos where team_id = $1 and remote_url like $2', [teamId, `%/${SHOP}.git`]), 'repoId')

  const { runId: a } = await post(`/v1/pipelines/${await pipelineId('bug-fix')}/runs`, { title: 'TENOFF goes negative on a box', body: 'A $5 order comes to -$5.', repoId })
  await sleep(1500)
  const { runId: b } = await post(`/v1/pipelines/${await pipelineId('box-check')}/runs`, { title: 'Second run', body: '', repoId })

  const online = await within(120, async () => (await box())?.status === 'online')
  const first = await box()
  const container = `agents-box-${first?.id}`
  check(online && first?.claimed_by_run === a && docker('inspect', '-f', '{{.Config.Image}}', container) === IMAGE,
    'the run created a box from the image, its daemon came online, and the run holds it')
  check(await within(30, async () => (await run(b))?.note === 'Waiting for a free box.' && (await run(b))?.status === 'queued'),
    'a second run waits while the only box is taken')

  const gate = await within(240, () => one(`select 1 from asks where run_id = $1 and kind = 'gate' and status = 'open'`, [a]))
  const workspace = await one<{ id: string; path: string; instance_id: string }>(
    'select w.id, w.path, w.instance_id from workspaces w join runs r on r.task_id = w.task_id where r.id = $1', [a])
  const sessionsOnBox = await one<{ n: number }>(
    `select count(*)::int as n from sessions s join runs r on r.task_id = s.task_id where r.id = $1 and s.instance_id = $2`, [a, first?.id])
  check(gate && workspace?.instance_id === first?.id && workspace?.path.startsWith('/home/agent/.agents-app/workspaces/') && Number(sessionsOnBox?.n) >= 3,
    `every stage ran inside the box (${workspace?.path})`)
  const ask = await one<{ id: string }>(`select id from asks where run_id = $1 and kind = 'gate' and status = 'open'`, [a])
  if (ask) await post(`/v1/asks/${ask.id}/answer`, { decision: 'approve' })
  check(await within(120, async () => (await run(a))?.status === 'done'), 'the box pushed through the git proxy, and the pull request merged')
  const main = await forgeAdmin.call<{ content: string }>('GET', `/repos/${org}/${SHOP}/contents/checkout.js?ref=main`)
  check(Buffer.from(main.content, 'base64').toString().includes('Math.max(0, amount - 10)'), "main on the forge has the box's fix")

  check(await within(120, async () => (await run(b))?.status === 'done') && (await one('select 1 from workspaces w join runs r on r.task_id = w.task_id where r.id = $1 and w.instance_id = $2', [b, first?.id])),
    'once the box was free, the waiting run took it and finished')
  check(await within(30, async () => !(await box())?.claimed_by_run), 'the box is released when no run needs it')

  const { id: boxId } = must(await box(), 'boxId')
  await post(`/v1/instances/${boxId}/claim`)
  const held = (await box())?.claimed_by
  await post(`/v1/instances/${boxId}/release`)
  check(held && !(await box())?.claimed_by, 'a person can claim the box and release it')

  check(docker('exec', container, 'sh', '-c', `curl -s -m 3 -o /dev/null -w '%{http_code}' http://host.docker.internal:${PORT}/v1/me || true`) !== '000'
    && docker('exec', container, 'sh', '-c', `curl -s -m 3 -o /dev/null -w '%{http_code}' -H 'Tailscale-User-Login: ${login}' http://host.docker.internal:${PORT + 1}/v1/me || true`) === '000',
  'from inside the box the machine port answers and the people port cannot be reached')

  check(await within(200, async () => !running(container) && (await box())?.status === 'offline'), 'an idle box is stopped, and shows offline')

  const { runId: c } = await post(`/v1/pipelines/${await pipelineId('box-check')}/runs`, { title: 'Third run', body: '', repoId })
  check(await within(180, async () => (await run(c))?.status === 'done') && running(container), 'the next run starts the stopped box again and finishes')
  const kept = (container: string) => Boolean(workspace) && tryDocker('exec', container, 'test', '-d', `${must(workspace, 'kept').path}/${SHOP}/.git`) !== null
  check(kept(container), "the box's home folder kept the first run's workspace")

  const before = docker('inspect', '-f', '{{.Id}}', container)
  node('server/boxes.ts', 'recreate', team, must(await box(), 'await box').name)
  const after = tryDocker('inspect', '-f', '{{.Id}}', container)
  check(after && after !== before && await within(60, async () => (await box())?.status === 'online') && kept(container),
    'recreating the box from the image gives a new container that comes online with the same home folder')
  check(tryDocker('image', 'inspect', '-f', '{{.Id}}', LIVE_IMAGE) === liveBefore, 'the check builds and runs its own image, and leaves the live one as it was')
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  // Boxes are removed whatever happened, or they would keep calling a closed port.
  const boxes = await db.query<{ id: string }>(`select i.id from instances i join teams t on t.id = i.team_id where t.name = $1 and i.kind = 'box'`, [team]).catch(() => ({ rows: [] }))
  for (const { id: boxId } of boxes.rows) {
    tryDocker('rm', '-f', `agents-box-${boxId}`)
    tryDocker('volume', 'rm', `agents-box-${boxId}-home`)
  }
  tryDocker('rmi', IMAGE)
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch(() => {})
    for (const repo of [SHOP, PIPES]) await forgeAdmin.call('DELETE', `/repos/${org}/${repo}`).catch(() => {})
    rmSync(work, { recursive: true, force: true })
  }
  await db.end().catch(() => {})
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} and repos kept)` : 'all passed (test team, repos and boxes removed)'}`)
process.exit(failures.length ? 1 : 0)
