// AWS step 11f: a rehearsal of the move on this Mac, boxes' home folders
// included. A task runs on a box with the stand-in for Claude and writes a file
// in its workspace. ops/aws/export.ts refuses while the API or the box runs.
// With both stopped, as at cutover, it and ops/aws/restore.ts run for real
// against a fake AWS. In between, the box's container and home volume are
// removed, as if the box had moved to a new host, and the restore refuses while
// a container holds the home. The restore reaches the box host's Docker over
// SSH, as it does on AWS. When the API starts again, the runner starts the box on
// its restored home, and a new message to the task resumes the same Claude
// session in the same workspace, with the file still there and every file in
// the home byte for byte. Without the boxes' homes in the export, the task's
// session fails instead, because its workspace is gone.
//
// The box reaches the API on port 7701, the one port besides the live API's that
// colima's box firewall leaves open, so this check holds the checks' shared lock.
//   node --env-file=.env --env-file=.env.test test/step11f.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { z } from 'zod'
import { startFakeAws } from './fake-aws.ts'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
// This check owns ports 7903 to 7905. The machine port is 7701, for the box firewall.
const MACHINES = 7701
const PEOPLE = 7903
const STREAMS = 7904
const AWS_PORT = 7905
const BUCKET = 'agents-test-bucket'
// Lima writes this SSH config for colima's VM. `ssh -F` with it reaches the VM as `colima`.
const COLIMA_SSH_CONFIG = join(homedir(), '.colima', 'ssh_config')
// The shared lock for checks on port 7701, and how long to wait for another holder.
// A caller that runs several checks in a row may hold it for all of them, and
// says so with AGENTS_CHECK_LOCK_HELD=1.
const LOCK = join(homedir(), '.agents-app', 'checks', 'run.lock')
const LOCK_WAIT_MS = 30 * 60_000
const LOCK_POLL_MS = 10_000
const LOCK_HELD = process.env.AGENTS_CHECK_LOCK_HELD === '1'
// How long a box may take to come online, and a turn to finish.
const ONLINE_MS = 120_000
const TURN_MS = 120_000

const id = randomBytes(4).toString('hex')
const team = `aws-${id}`
const login = `aws-${id}@local`
const image = `agents-box:aws-step11f-${id}`
// Box mounts come from colima's VM, which sees only the home folder.
const work = join(homedir(), '.agents-app', 'checks', `aws-step11f-${id}`)
const appHome = join(work, 'app-home')
// The restore reaches the box host's Docker over SSH, as on AWS, with colima's VM
// as the box host. The Docker CLI runs `ssh` from the PATH, so a wrapper first on
// it adds Lima's config and notes each call.
const bin = join(work, 'bin')
const sshLog = join(work, 'ssh.log')
const forgeContainer = `aws-step11f-${id}-forge`
const holder = `aws-step11f-${id}-holder`
const forgeVolume = `aws-step11f-${id}-forge`
const forge2 = `aws-step11f-${id}-forge2`
const electricVolume = `aws-step11f-${id}-electric`
const scratch = `aws_step11f_${id}`
const plan = `Step one, ${id}\n`
const SCENARIO = {
  turns: [
    { match: 'Write the plan', reply: 'Wrote the plan.', write: { 'notes/plan.md': plan } },
    { match: 'Read the plan', reply: 'The plan is still here.' },
  ],
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const failures: string[] = []
const children: ChildProcess[] = []
function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
// Null when the command fails, as it does for a container, volume or image that is not there.
const tryDocker = (...args: string[]) => {
  try {
    return docker(...args)
  } catch {
    return null
  }
}
const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...apiEnv } })
const testUrl = new URL(must(process.env.DATABASE_URL, 'DATABASE_URL'))
const urlFor = (database: string) => { const url = new URL(testUrl); url.pathname = `/${database}`; return url.toString() }

async function within(ms: number, test: () => Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(500)
  }
  return false
}

// mkdir succeeds for one holder at a time, which is how the checks share port 7701.
async function takeLock() {
  mkdirSync(join(LOCK, '..'), { recursive: true })
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      mkdirSync(LOCK)
      return
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error
      if (Date.now() > deadline) throw new Error(`${LOCK} has been held for ${LOCK_WAIT_MS / 60_000} minutes`)
      await sleep(LOCK_POLL_MS)
    }
  }
}

const apiEnv: Record<string, string> = {
  AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(MACHINES), AGENTS_PEOPLE_PORT: String(PEOPLE), AGENTS_STREAMS_PORT: String(STREAMS),
  AGENTS_STREAMS_DIR: join(work, 'streams'), AGENTS_BOX_IMAGE: image, AGENTS_BOX_API: `http://host.docker.internal:${MACHINES}`,
  AGENTS_BOX_DOCKER_ARGS: JSON.stringify([
    '-v', `${join(ROOT, 'test/fake-claude.ts')}:/opt/fake/fake-claude.ts:ro`, '-v', `${join(work, 'scenario.json')}:/opt/fake/scenario.json:ro`,
    '-e', 'AGENTS_CLAUDE_BIN=/opt/fake/fake-claude.ts', '-e', 'AGENTS_FAKE_SCENARIO=/opt/fake/scenario.json',
  ]),
}

// The API, with a promise of its end made when it starts. A process killed by a
// signal keeps a null exitCode and has already sent 'exit', so waiting for 'exit'
// only after stopping it could wait forever.
let api: { child: ChildProcess; exited: Promise<unknown> } | undefined
function startApi() {
  const env: NodeJS.ProcessEnv = { ...process.env, ...apiEnv }
  for (const name of ['AGENTS_MACHINE_HOST', 'DOCKER_HOST', 'AGENTS_BOX_DOCKER_HOST', 'AGENTS_BOX_TOKEN_FILE']) delete env[name]
  const child = spawn(process.execPath, ['--env-file=.env', 'server/api.ts'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] })
  children.push(child)
  api = { child, exited: new Promise((resolve) => { child.once('exit', resolve) }) }
}
async function stopApi() {
  if (!api) return
  api.child.kill('SIGTERM')
  await api.exited
}

async function post(path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${PEOPLE}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

// The first row a query returns, for the caller to parse.
async function one(sql: string, params: unknown[]): Promise<unknown> {
  const row: unknown = (await db.query(sql, params)).rows[0]
  return row
}
const said = async (sessionId: string, text: string) =>
  Boolean(await one(`select 1 from events where session_id = $1 and kind = 'assistant' and text = $2`, [sessionId, text]))
const status = async (sessionId: string) => z.object({ status: z.string() }).parse(await one('select status from sessions where id = $1', [sessionId])).status
const online = async (boxId: string, since: Date) =>
  Boolean(await one(`select 1 from instances where id = $1 and status = 'online' and last_seen_at > $2`, [boxId, since]))
// Every file in a volume with its SHA-256, sorted, for comparing a home before and after.
const fingerprint = (volume: string) => docker('run', '--rm', '-v', `${volume}:/data:ro`, 'alpine:3.20', 'find', '/data', '-type', 'f', '-exec', 'sha256sum', '{}', '+')
  .split('\n').sort().join('\n')

let boxId = ''
let locked = false
let connected = false
// The Docker things this check made go whatever happened, and the lock is released.
function removeOwn() {
  if (boxId) {
    tryDocker('rm', '-f', `agents-box-${boxId}`)
    tryDocker('volume', 'rm', `agents-box-${boxId}-home`)
  }
  tryDocker('rm', '-f', forgeContainer, holder)
  for (const volume of [forgeVolume, forge2, electricVolume]) tryDocker('volume', 'rm', volume)
  tryDocker('image', 'rm', image)
  if (locked) rmdirSync(LOCK)
  locked = false
}
// Stopped from outside, the check kills the API first, so its runner cannot start the box again.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    for (const child of children) child.kill('SIGKILL')
    removeOwn()
    process.exit(1)
  })
}
const fake = await startFakeAws(AWS_PORT, BUCKET)
try {
  if (!LOCK_HELD) {
    await takeLock()
    locked = true
  }
  await db.connect()
  connected = true
  mkdirSync(appHome, { recursive: true })
  writeFileSync(join(work, 'scenario.json'), JSON.stringify(SCENARIO))
  if (!existsSync(COLIMA_SSH_CONFIG)) throw new Error(`no ${COLIMA_SSH_CONFIG}: colima must be running`)
  mkdirSync(bin)
  writeFileSync(join(bin, 'ssh'), `#!/bin/sh\necho "$@" >> '${sshLog}'\nexec /usr/bin/ssh -F '${COLIMA_SSH_CONFIG}' "$@"\n`, { mode: 0o755 })
  writeFileSync(join(appHome, 'forge.json'), JSON.stringify({ url: 'http://127.0.0.1:3001', token: 'rehearsal' }), { mode: 0o600 })
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, login)
  node('server/boxes.ts', 'build')
  boxId = must(z.object({ id: z.uuid() }).parse(await one(
    `insert into instances (team_id, name, kind, token_sha256, claimed_by, claimed_at)
     select t.id, $2, 'box', $3, p.id, now() from teams t join people p on p.team_id = t.id and p.login = $4
     where t.name = $1 returning id`, [team, `box-${id}`, randomBytes(24).toString('hex'), login])).id, 'the box')
  const { agentId } = z.object({ agentId: z.uuid() }).parse(JSON.parse(node('server/admin.ts', 'add-agent', team, 'helper', `box-${id}`)))
  docker('volume', 'create', forgeVolume)
  docker('run', '-d', '--name', forgeContainer, '-v', `${forgeVolume}:/data`, 'alpine:3.20', 'sleep', '600')

  // Before the move: a task on the box writes its plan.
  const firstStart = new Date()
  startApi()
  check(await within(ONLINE_MS, () => online(boxId, firstStart)), 'a box held by a person starts and comes online')
  const task = z.object({ taskId: z.uuid(), sessionId: z.uuid() }).parse(await post('/v1/tasks', { title: 'Write the plan', instructions: 'Write the plan for the move.', agentId }))
  check(await within(TURN_MS, () => said(task.sessionId, 'Wrote the plan.')), "the task's session runs on the box and answers")
  const { path, harness } = z.object({ path: z.string().startsWith('/home/agent/'), harness: z.string() }).parse(await one(
    'select w.path, s.harness_session_id as harness from workspaces w join sessions s on s.workspace_id = w.id where s.id = $1', [task.sessionId]))
  check(docker('exec', `agents-box-${boxId}`, 'cat', join(path, 'notes/plan.md')) === plan.trim(), `the agent wrote notes/plan.md in its workspace, ${path}`)

  // The cutover: the export refuses while the API or the box runs, then takes the box's home.
  fake.parameters.set('/agents/config', {
    type: 'String', tags: {},
    value: JSON.stringify({ region: 'us-east-1', bucket: BUCKET, databaseSecretArn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:rehearsal', serverAddress: '10.40.0.10', boxHostAddress: '10.40.0.20', resolver: '10.40.0.2', machinePort: 7700, peoplePort: 7710 }),
  })
  const exportEnv = {
    DATABASE_URL: testUrl.toString(), AGENTS_HOOK_SECRET: 'rehearsal', AGENTS_API_PORT: String(MACHINES), AGENTS_PEOPLE_PORT: String(PEOPLE),
    AGENTS_HOME: appHome, AGENTS_FORGE_CONTAINER: forgeContainer, AGENTS_FORGE_VOLUME: forgeVolume, AGENTS_RUNNER_TEAMS: team,
  }
  const apiUp = await fake.script(['ops/aws/export.ts'], exportEnv)
  check(apiUp.status !== 0 && apiUp.out.includes('the API on this Mac is still running'), 'the export refuses while the API runs')
  await stopApi()
  const boxUp = await fake.script(['ops/aws/export.ts'], exportEnv)
  check(boxUp.status !== 0 && boxUp.out.includes(`still running: agents-box-${boxId}.`) && fake.objects.size === 0
    && docker('inspect', '-f', '{{.State.Running}}', forgeContainer) === 'true',
  'it refuses while the box runs, and names it, before it uploads anything or stops the forge')
  docker('stop', `agents-box-${boxId}`)
  const before = fingerprint(`agents-box-${boxId}-home`)
  const exported = await fake.script(['ops/aws/export.ts'], exportEnv)
  const dumps = [...fake.objects.keys()].filter((key) => /^[^/]+\/cutover\/[0-9TZ-]+\/agents\.dump$/.test(key)).sort()
  const prefix = dumps.at(-1)?.slice(`${BUCKET}/`.length).replace(/agents\.dump$/, '') ?? 'none/'
  check(exported.status === 0 && fake.objects.has(`${BUCKET}/${prefix}boxes/${boxId}.tar.gz`), `the export holds the box's home, as ${prefix}boxes/${boxId}.tar.gz`)

  // The move: the box host is new, so the box's container and home are not there.
  // The restore first refuses while any container uses the box's home.
  const restoreEnv = {
    DATABASE_URL: urlFor(scratch), AGENTS_FORGE_VOLUME: forge2, AGENTS_ELECTRIC_VOLUME: electricVolume,
    AGENTS_BOX_DOCKER_HOST: 'ssh://colima', PATH: `${bin}:${process.env.PATH ?? ''}`,
  }
  docker('run', '-d', '--name', holder, '-v', `agents-box-${boxId}-home:/data`, 'alpine:3.20', 'sleep', '600')
  const homeInUse = await fake.script(['ops/aws/restore.ts', `s3://${BUCKET}/${prefix}`], restoreEnv)
  check(homeInUse.status !== 0 && homeInUse.out.includes(`agents-box-${boxId}-home is in use by ${holder}`), "the restore refuses while a container uses the box's home, and names it")
  docker('rm', '-f', holder, `agents-box-${boxId}`)
  docker('volume', 'rm', `agents-box-${boxId}-home`)
  rmSync(sshLog, { force: true })
  const restored = await fake.script(['ops/aws/restore.ts', `s3://${BUCKET}/${prefix}`], restoreEnv)
  const after = tryDocker('volume', 'inspect', `agents-box-${boxId}-home`) === null ? '' : fingerprint(`agents-box-${boxId}-home`)
  const overSsh = existsSync(sshLog) && readFileSync(sshLog, 'utf8').includes('colima docker system dial-stdio')
  check(restored.status === 0 && after === before && before.includes('notes/plan.md') && overSsh,
    `the restore brings back every file in the box's home byte for byte, on the box host over SSH (${before.split('\n').length} files)`)

  // After the move: the runner starts the box on its home, and the task resumes.
  const secondStart = new Date()
  startApi()
  check(await within(ONLINE_MS, () => online(boxId, secondStart)), 'the runner starts the box again on its restored home, and it comes online')
  await post(`/v1/sessions/${task.sessionId}/messages`, { text: 'Read the plan' })
  const answered = await within(TURN_MS, async () => await said(task.sessionId, 'The plan is still here.') || await status(task.sessionId) === 'failed')
  check(answered && await said(task.sessionId, 'The plan is still here.') && await status(task.sessionId) !== 'failed',
    `a new message to the task gets its answer after the move (session ${await status(task.sessionId)})`)
  const starts = (tryDocker('exec', `agents-box-${boxId}`, 'cat', join(path, '.fake/starts.jsonl')) ?? '').split('\n').filter((line) => line !== '')
    .map((line) => z.object({ sessionId: z.string(), resumed: z.boolean() }).parse(JSON.parse(line)))
  check(starts.at(-1)?.resumed === true && starts.at(-1)?.sessionId === harness, 'the box resumed the same Claude session, in the same workspace')
  check(tryDocker('exec', `agents-box-${boxId}`, 'cat', join(path, 'notes/plan.md')) === plan.trim(), "the agent's file is still in its workspace")
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  await stopApi()
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  await fake.close()
  removeOwn()
  // A client that never connected would hold these queries forever.
  if (connected) {
    await db.query(`drop database if exists ${db.escapeIdentifier(scratch)} with (force)`).catch((error: unknown) => {
      console.error(`dropping ${scratch}: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (!failures.length) {
      await db.query('delete from teams where name = $1', [team]).catch((error: unknown) => {
        console.error(`removing ${team}: ${error instanceof Error ? error.message : String(error)}`)
      })
      rmSync(work, { recursive: true, force: true })
    }
    await db.end().catch((error: unknown) => { console.error(`closing: ${error instanceof Error ? error.message : String(error)}`) })
  }
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} and ${work} kept)` : 'all passed (test team, box, volumes, image and database removed)'}`)
process.exit(failures.length ? 1 : 0)
