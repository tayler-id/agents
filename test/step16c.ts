// Deploys with the deployer, ops/deploy.ts, against a stand-in for the server:
// releases in a temporary folder, and a test API on port 8005 that this file
// restarts from the release `current` points at. Two good releases go out,
// then one whose API cannot start, which must roll back by itself. Then a run
// asks for a deploy, which only the repo's owner may approve. Nothing here
// touches launchd, the live API or the live database.
//   node --env-file=.env --env-file=.env.test test/step16c.ts
// The deployer runs this file as the stand-in's restart and backup steps:
//   node test/step16c.ts --restart <folder>
//   node test/step16c.ts --mark <folder> <step>

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { expireDeploy } from '../server/framework.ts'
import { forgeAdmin, forgeConfig } from '../server/forge.ts'
import { must } from './must.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
// The stand-in server, and the API whose runner asks for deploys. Ports 8000 to 8019 are this work's.
const SERVED = { machines: 8005, streams: 8006 }
const RUNNER = { machines: 8007, people: 8017, streams: 8008 }

const gone = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'

// Stops the stand-in's API and starts it again from the current release, as launchctl kickstart would.
async function restart(folder: string) {
  const pidFile = join(folder, 'api.pid')
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'))
    try {
      process.kill(pid, 'SIGTERM')
      for (let i = 0; i < 100; i++) {
        process.kill(pid, 0)
        await sleep(100)
      }
    } catch (error) {
      // The old release has exited, or had already crashed, which a bad release does.
      if (!gone(error)) throw error
    }
  }
  const current = join(folder, 'releases', 'current')
  const log = openSync(join(folder, 'api.log'), 'a')
  const child = spawn(process.execPath, [`--env-file=${ROOT}.env`, `--env-file=${ROOT}.env.test`, join(current, 'server/api.ts')], {
    cwd: current, detached: true, stdio: ['ignore', log, log],
    env: {
      ...process.env, AGENTS_RUNNER: 'off', AGENTS_HOME: join(folder, 'served'), AGENTS_API_PORT: String(SERVED.machines),
      AGENTS_PEOPLE_SOCKET: join(folder, 'served-people.sock'), AGENTS_STREAMS_PORT: String(SERVED.streams), AGENTS_STREAMS_DIR: join(folder, 'served-streams'),
    },
  })
  writeFileSync(pidFile, String(child.pid))
  child.unref()
}

const [mode, folder, stepName] = process.argv.slice(2)
if (mode === '--restart' && folder) {
  await restart(folder)
  process.exit(0)
}
if (mode === '--mark' && folder && stepName) {
  appendFileSync(join(folder, 'steps.log'), `${stepName}\n`)
  process.exit(0)
}

const id = randomBytes(4).toString('hex')
const team = `self-${id}`
const [owner, mate] = [`self-owner-${id}@local`, `self-mate-${id}@local`]
const forgeUser = `self-owner-${id}`
const [REPO, PIPES, SPARE] = [`self-deploy-${id}`, `self-deploypipes-${id}`, `self-deployspare-${id}`]
// Stand-ins for a service whose health answer is not JSON, and one that never answers.
const STANDINS = { garbage: 8013, silent: 8014 }
// A deployer handling one deploy gets this long before it counts as hung.
const ONCE_LIMIT_MS = 120_000
const { org, url: forgeUrl, token: factoryToken, adminToken } = forgeConfig()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step16c-')))
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
const health = async () => fetch(`http://127.0.0.1:${SERVED.machines}/v1/health`).then((r) => r.json(), () => null)
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const factoryAuth = `http.extraHeader=Authorization: Basic ${Buffer.from(`factory:${factoryToken}`).toString('base64')}`

async function forgeCall(method: string, path: string, body?: unknown) {
  const res = await fetch(`${forgeUrl}/api/v1${path}`, {
    method, headers: { authorization: `token ${adminToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status }
}

async function as(who: string, path: string, body: unknown = {}) {
  return fetch(`http://127.0.0.1:${RUNNER.people}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': who }, body: JSON.stringify(body) })
}

// Asks for a deploy as the runner would, and waits for the deployer to finish it.
async function deploy(teamId: string, repoId: string, ownerId: string, commit: string) {
  const row = must(await one(`insert into deploys (team_id, repo_id, commit, approved_by) values ($1, $2, $3, $4) returning id`, [teamId, repoId, commit, ownerId]), 'the deploy')
  await within(240, async () => ['healthy', 'rolled_back', 'failed'].includes((await one('select status from deploys where id = $1', [row.id]))?.status))
  return one('select * from deploys where id = $1', [row.id])
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
  const { id: ownerId } = must(await one('select id from people where login = $1', [owner]), 'the owner')
  await forgeCall('POST', '/admin/users', { username: forgeUser, email: `${forgeUser}@forge.local`, password: randomBytes(18).toString('base64url'), must_change_password: false })
  node('server/admin.ts', 'forge-login', owner, forgeUser)

  // The repo to deploy: a copy of this repo on main, a good change on one branch, and a broken API on another.
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
  const files = Object.fromEntries(listed.filter((f) => f && existsSync(join(ROOT, f)) && statSync(join(ROOT, f)).isFile()).map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]))
  await forgeAdmin.ensureRepo(REPO, files, 'a copy of Agents to deploy in step 16c', false)
  const clone = join(home, 'clone')
  git(home, '-c', factoryAuth, 'clone', '--quiet', `${forgeUrl}/${org}/${REPO}.git`, clone)
  const first = git(clone, 'rev-parse', 'HEAD')
  writeFileSync(join(clone, 'README.md'), `${readFileSync(join(clone, 'README.md'), 'utf8')}\nDeployed by step 16c.\n`)
  git(clone, 'checkout', '--quiet', '-b', 'good')
  git(clone, '-c', 'user.name=step16c', '-c', 'user.email=step16c@local', 'commit', '--quiet', '-am', 'A good release')
  const good = git(clone, 'rev-parse', 'HEAD')
  writeFileSync(join(clone, 'server/api.ts'), `throw new Error('a release that cannot start')\n${readFileSync(join(clone, 'server/api.ts'), 'utf8')}`)
  git(clone, 'checkout', '--quiet', '-b', 'bad')
  git(clone, '-c', 'user.name=step16c', '-c', 'user.email=step16c@local', 'commit', '--quiet', '-am', 'A release whose API cannot start')
  const bad = git(clone, 'rev-parse', 'HEAD')
  git(clone, '-c', factoryAuth, 'push', '--quiet', 'origin', 'good', 'bad')
  const remote = `${forgeUrl}/${org}/${REPO}.git`
  await db.query('insert into repos (team_id, remote_url, setup_command) values ($1, $2, $3)', [teamId, remote, `ln -s ${ROOT}node_modules node_modules`])
  const policy = { ...JSON.parse(readFileSync(join(ROOT, 'ops/policies/agents.json'), 'utf8')), sandbox: 'any' }
  writeFileSync(join(home, 'agents-deploy.json'), JSON.stringify(policy))
  node('server/admin.ts', 'set-policy', team, remote, join(home, 'agents-deploy.json'), owner)
  const { id: repoId } = must(await one('select id from repos where remote_url = $1 and team_id = $2', [remote, teamId]), 'the repo')

  // The deployer, with each step an argument list and this file standing in for launchctl.
  const target = {
    repoId, releases: join(home, 'releases'),
    install: ['ln', '-s', `${ROOT}node_modules`, 'node_modules'],
    backup: [process.execPath, `${ROOT}test/step16c.ts`, '--mark', home, 'backup'],
    migrate: [process.execPath, `--env-file=${ROOT}.env`, `--env-file=${ROOT}.env.test`, 'server/migrate.ts'],
    restart: [process.execPath, `${ROOT}test/step16c.ts`, '--restart', home],
    health: { url: `http://127.0.0.1:${SERVED.machines}/v1/health`, timeoutSec: 25 },
    stepTimeoutSec: 180,
  }
  writeFileSync(join(home, 'target.json'), JSON.stringify(target))
  children.push(spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', 'ops/deploy.ts', join(home, 'target.json')], {
    cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, AGENTS_HOME: join(home, 'deployer') },
  }))

  const one1 = await deploy(teamId, repoId, ownerId, first)
  check(one1.status === 'healthy' && (await health())?.commit === first && realpathSync(join(home, 'releases', 'current')) === realpathSync(join(home, 'releases', first)),
    `the first release went out and answers with its commit: ${one1.status} ${one1.note ?? ''}`)
  const log = String(one1.log)
  check(log.indexOf('--mark') < log.indexOf('migrate.ts') && log.indexOf('migrate.ts') < log.indexOf('--restart'),
    'the deployer backed up, then migrated, then restarted')
  const two = await deploy(teamId, repoId, ownerId, good)
  check(two.status === 'healthy' && (await health())?.commit === good, `a second release went out and answers with its commit: ${two.status}`)
  const three = await deploy(teamId, repoId, ownerId, bad)
  check(three.status === 'rolled_back' && three.note.includes('went back to') && (await health())?.commit === good
    && realpathSync(join(home, 'releases', 'current')) === realpathSync(join(home, 'releases', good)),
  `a release that failed its health check rolled back by itself, and the release before answers again: ${three.status} ${three.note ?? ''}`)

  // One deployer runs for a repo at a time. A second one for the same repo
  // stops at once, before it could fail a deploy the first one is working on.
  const { id: heldId } = must(await one(`insert into deploys (team_id, repo_id, commit, approved_by, status, started_at) values ($1, $2, $3, $4, 'checking', now()) returning id`,
    [teamId, repoId, good, ownerId]), 'a deploy the running deployer is checking')
  const second = await new Promise<{ exit: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', 'ops/deploy.ts', join(home, 'target.json'), '--once'], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, AGENTS_HOME: join(home, 'deployer-second') },
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, ONCE_LIMIT_MS)
    child.on('close', (code) => { clearTimeout(timer); resolve({ exit: code, stderr }) })
  })
  const heldRow = await one('select status from deploys where id = $1', [heldId])
  check(second.exit === 1 && second.stderr.includes('Another deployer runs') && heldRow?.status === 'checking',
    `a second deployer for a repo stops at once, and leaves the first one's deploy alone: exit ${second.exit ?? 'none'}, ${heldRow?.status ?? 'gone'}`)
  await db.query('delete from deploys where id = $1', [heldId])

  // The deployer's failure paths. Each deploys a small spare repo, handled by a
  // deployer that takes one deploy and exits, with stand-ins for the restart and
  // the health answer. A deployer that crashed or hung would leave the deploy
  // unfinished.
  await forgeAdmin.ensureRepo(SPARE, { 'README.md': '# spare\n' }, 'a spare repo for the deployer failure paths', false)
  const spareRemote = `${forgeUrl}/${org}/${SPARE}.git`
  const { id: spareId } = must(await one('insert into repos (team_id, remote_url) values ($1, $2) returning id', [teamId, spareRemote]), 'the spare repo')
  const spareHead = must(git(home, '-c', factoryAuth, 'ls-remote', spareRemote, 'refs/heads/main').split(/\s/)[0], 'the spare repo\'s main')
  const garbage = createServer((_req, res) => { res.end('not the health answer') }).listen(STANDINS.garbage, '127.0.0.1')
  const silent = createServer(() => undefined).listen(STANDINS.silent, '127.0.0.1')
  const once = async (name: string, overrides: object, prepare: (releases: string) => void = () => undefined) => {
    const releases = join(home, `spare-${name}`)
    mkdirSync(releases, { recursive: true })
    prepare(releases)
    const noop = [process.execPath, '-e', '0']
    writeFileSync(join(home, `spare-${name}.json`), JSON.stringify({
      repoId: spareId, releases, install: ['ln', '-s', `${ROOT}node_modules`, 'node_modules'], backup: noop, migrate: noop, restart: noop,
      health: { url: `http://127.0.0.1:${STANDINS.garbage}/v1/health`, timeoutSec: 3 }, stepTimeoutSec: 60, ...overrides,
    }))
    const exit = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', 'ops/deploy.ts', join(home, `spare-${name}.json`), '--once'], {
        cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, AGENTS_HOME: join(home, `deployer-${name}`) },
      })
      const timer = setTimeout(() => { child.kill('SIGKILL') }, ONCE_LIMIT_MS)
      child.on('close', (code) => { clearTimeout(timer); resolve(code) })
    })
    return { exit, releases }
  }
  const spareDeploy = async () => must(await one('insert into deploys (team_id, repo_id, commit, approved_by) values ($1, $2, $3, $4) returning id', [teamId, spareId, spareHead, ownerId]), 'a spare deploy').id
  const spareRow = (deployId: string) => one('select * from deploys where id = $1', [deployId])

  const halfId = await spareDeploy()
  const half = await once('install', { install: [process.execPath, '-e', 'process.exit(1)'] })
  const halfRow = await spareRow(halfId)
  check(half.exit === 0 && halfRow.status === 'failed' && !existsSync(join(half.releases, spareHead)) && !existsSync(join(half.releases, `${spareHead}.partial`)),
    `a release that did not install is deleted, never left half-installed: ${halfRow.status} ${halfRow.note ?? ''}`)

  const garbageId = await spareDeploy()
  const answeredGarbage = await once('garbage', {})
  const garbageRow = await spareRow(garbageId)
  check(answeredGarbage.exit === 0 && garbageRow.status === 'failed' && String(garbageRow.log).includes('did not answer with'),
    `a health answer that is not JSON counts as no answer, and the deployer ends the deploy instead of stopping: ${garbageRow.status}`)

  const silentId = await spareDeploy()
  const answeredNothing = await once('silent', { health: { url: `http://127.0.0.1:${STANDINS.silent}/v1/health`, timeoutSec: 4 } })
  const silentRow = await spareRow(silentId)
  check(answeredNothing.exit === 0 && silentRow.status === 'failed',
    `a health check that never answers times out, and the deploy ends: ${silentRow.status} ${silentRow.note ?? ''}`)

  const blockedId = await spareDeploy()
  const blocked = await once('blocked', {}, (releases) => {
    mkdirSync(join(releases, 'current'), { recursive: true })
    writeFileSync(join(releases, 'current', 'in-the-way'), 'a folder where the link should go\n')
  })
  const blockedRow = await spareRow(blockedId)
  check(blocked.exit === 0 && blockedRow.status === 'failed' && String(blockedRow.note).includes('An error after the switch'),
    `an error after the switch tries to go back and ends the deploy failed, without stopping the deployer: ${blockedRow.note ?? blockedRow.status}`)

  const { id: staleId } = must(await one(`insert into deploys (team_id, repo_id, commit, approved_by, created_at) values ($1, $2, $3, $4, now() - interval '2 hours') returning id`,
    [teamId, spareId, spareHead, ownerId]), 'a stale deploy')
  await once('stale', {})
  const staleRow = await spareRow(staleId)
  check(staleRow.status === 'failed' && String(staleRow.note).includes('never went out'), `a deploy that waited past its limit fails, and never goes out: ${staleRow.status} ${staleRow.note ?? ''}`)
  // A deployer that stopped partway left its deploy checking. The next
  // deployer to start fails it, so no run waits on it.
  const { id: stuckId } = must(await one(`insert into deploys (team_id, repo_id, commit, approved_by, status, started_at) values ($1, $2, $3, $4, 'checking', now() - interval '2 hours') returning id`,
    [teamId, spareId, spareHead, ownerId]), 'a stuck deploy')
  await once('stuck', {})
  const stuckRow = await spareRow(stuckId)
  check(stuckRow.status === 'failed' && String(stuckRow.note).includes('stopped while this deploy was checking'),
    `a deploy left checking by a deployer that stopped fails when the next deployer starts: ${stuckRow.status} ${stuckRow.note ?? ''}`)
  // The runner fails a deploy a deployer started and never finished.
  const { id: lostId } = must(await one(`insert into deploys (team_id, repo_id, commit, approved_by, status, started_at) values ($1, $2, $3, $4, 'switching', now() - interval '2 hours') returning id`,
    [teamId, spareId, spareHead, ownerId]), 'a deploy its deployer lost')
  await expireDeploy(db, lostId)
  const lostRow = await spareRow(lostId)
  check(lostRow.status === 'failed' && String(lostRow.note).includes('did not finish within'),
    `the runner fails a deploy whose deployer started it and never finished: ${lostRow.status} ${lostRow.note ?? ''}`)
  // The runner fails a deploy while its deployer still works on it. The
  // deployer finds the row moved before it migrates, writes nothing and stops,
  // so the deploy neither migrates nor switches.
  const movedId = await spareDeploy()
  const [backingUp, goOn, migrated] = [join(home, 'moved.started'), join(home, 'moved.go'), join(home, 'moved.migrated')]
  const waitToGoOn = [process.execPath, '-e',
    "const fs = process.getBuiltinModule('node:fs'); fs.writeFileSync(process.argv[1], ''); const t = setInterval(() => { if (fs.existsSync(process.argv[2])) clearInterval(t) }, 100)",
    backingUp, goOn]
  const markMigrated = [process.execPath, '-e', "process.getBuiltinModule('node:fs').writeFileSync(process.argv[1], '')", migrated]
  const moving = once('moved', { backup: waitToGoOn, migrate: markMigrated })
  const reachedBackup = await within(90, async () => existsSync(backingUp))
  await db.query(`update deploys set started_at = now() - interval '2 hours' where id = $1`, [movedId])
  await expireDeploy(db, movedId)
  writeFileSync(goOn, '')
  const moved = await moving
  const movedRow = await spareRow(movedId)
  check(reachedBackup && moved.exit === 1 && movedRow.status === 'failed' && String(movedRow.note).includes('did not finish within') && !existsSync(join(moved.releases, 'current')),
    `a deployer whose deploy the runner failed meanwhile writes nothing more and stops before the switch: exit ${moved.exit ?? 'none'}, ${movedRow.status} ${movedRow.note ?? ''}`)
  check(reachedBackup && movedRow.status === 'failed' && !existsSync(migrated),
    `a deploy the runner failed while it was preparing never migrates the database: ${existsSync(migrated) ? 'it migrated' : 'no migrate'}, ${movedRow.status}`)
  garbage.close()
  silent.close()

  // A run asks for a deploy, which only the owner may approve, and the deployer carries it out.
  await forgeAdmin.ensureRepo(PIPES, {
    'shared/pipeline.ts': readFileSync(join(ROOT, 'shared/pipeline.ts'), 'utf8'),
    'pipelines/release.ts': `export default {
  description: 'Deploys main, once the owner approves.',
  agent: 'builder', runsOn: 'home', spendCapUsd: 1,
  triggers: [{ kind: 'manual' }],
  start: 'approve_deploy',
  stages: {
    approve_deploy: { kind: 'gate', role: 'deploy', question: () => 'Deploy main?', next: { approved: 'deploy', rejected: { done: 'failed', note: 'Not deployed.' } } },
    deploy: { kind: 'action', action: 'deploy', next: { done: { done: 'succeeded', note: 'Deployed.' }, rolled_back: { done: 'failed', note: 'Rolled back.' }, failed: { handoff: 'The deploy failed.' } } },
  },
}
`,
  }, 'step 16c pipelines', false)
  await db.query('insert into repos (team_id, remote_url) values ($1, $2)', [teamId, `${forgeUrl}/${org}/${PIPES}.git`])
  children.push(spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env, AGENTS_HOME: join(home, 'runner'), AGENTS_RUNNER_TEAMS: team, AGENTS_BOX_TOKEN_FILE: join(home, 'no-box-token'),
      AGENTS_API_PORT: String(RUNNER.machines), AGENTS_PEOPLE_SOCKET: join(home, 'runner-people.sock'), AGENTS_STREAMS_PORT: String(RUNNER.streams), AGENTS_STREAMS_DIR: join(home, 'runner-streams'),
    },
  }))
  if (!(await within(30, () => fetch(`http://127.0.0.1:${RUNNER.machines}/v1/health`).then((r) => r.ok, () => false)))) throw new Error('the runner\'s API did not start')
  await servePeople(RUNNER.people, join(home, 'runner-people.sock'))
  mkdirSync(join(home, 'mac'), { recursive: true })
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_API: `http://127.0.0.1:${RUNNER.machines}`, AGENTS_TOKEN: mac.token, AGENTS_HOME: join(home, 'mac'), AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts') },
  }))
  const release = await within(60, () => one(`select id from pipelines where team_id = $1 and name = 'release' and current_version_id is not null`, [teamId]))
  const { id: pipelineId } = must(await one(`select id from pipelines where team_id = $1 and name = 'release'`, [teamId]), 'the release pipeline')
  check(release, 'the release pipeline loads, with a deploy gate and a deploy step')
  const started = await as(mate, `/v1/pipelines/${pipelineId}/runs`, { title: 'Release main', body: '', repoId })
  const { runId } = await started.json()
  await within(120, () => one(`select id from asks where run_id = $1 and status = 'open'`, [runId]))
  const ask = must(await one(`select id from asks where run_id = $1 and status = 'open'`, [runId]), 'the deploy gate')
  const byMate = await as(mate, `/v1/asks/${ask.id}/answer`, { decision: 'approve' })
  check(byMate.status === 403, 'a teammate cannot approve a deploy')
  check((await as(owner, `/v1/asks/${ask.id}/answer`, { decision: 'approve' })).ok, 'the owner approves it')
  const done = await within(240, async () => ['done', 'failed'].includes((await one('select status from runs where id = $1', [runId]))?.status))
  const run = await one('select status, note from runs where id = $1', [runId])
  const asked = await one('select * from deploys where run_id = $1', [runId])
  check(done && run.status === 'done' && asked?.commit === first && asked.previous_commit === good && asked.approved_by === ownerId && asked.status === 'healthy'
    && (await health())?.commit === first,
  `the run's deploy went out after the owner's approval, recording the release it replaced: ${run.status} ${run.note ?? ''}`)
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  if (existsSync(join(home, 'api.pid'))) {
    try {
      process.kill(Number(readFileSync(join(home, 'api.pid'), 'utf8')), 'SIGTERM')
    } catch (error) {
      // An API that already exited needs no stopping. Anything else is said, and cleanup goes on.
      if (!gone(error)) console.error('stopping the stand-in API:', error instanceof Error ? error.message : String(error))
    }
  }
  await sleep(1000)
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team])
    for (const repo of [REPO, PIPES, SPARE]) await forgeCall('DELETE', `/repos/${org}/${repo}`)
    await forgeCall('DELETE', `/admin/users/${forgeUser}`)
  }
  await db.end()
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team}, the self- forge repos and ${home} kept)` : 'all passed (test team and repos removed)'}`)
process.exit(failures.length ? 1 : 0)
