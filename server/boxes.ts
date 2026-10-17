// Boxes: Docker containers that run the daemon, for unattended work. Each box is
// an instance with its own token, and a volume for its home folder, so its
// workspaces survive a restart and a rebuild of the image. A run claims a box
// and releases it when it ends; a person can claim one to keep it. A box nobody
// holds is stopped once it has been idle for AGENTS_BOX_IDLE_MIN minutes. A
// person's own box sleeps once it has had nothing to do for as long, and wakes
// when something needs it, such as a turn for one of its agents.
//
// Claims are rows, written inside the run's transaction. Containers start only
// after that commits, in startClaimedBoxes, so a claim that rolls back never
// leaves a container behind.
//
// Boxes run on this machine's Docker, or on a box host's when
// AGENTS_BOX_DOCKER_HOST (or DOCKER_HOST) names one, such as
// ssh://agents@agents-boxes. Only box commands use that host, so `docker compose`
// on the server still reaches the server's own Docker.
//   node --env-file=.env server/boxes.ts build
//   node --env-file=.env server/boxes.ts create <team> <name>
//   node --env-file=.env server/boxes.ts recreate <team> <name>
//   node --env-file=.env server/boxes.ts list

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type pg from 'pg'
import { z } from 'zod'
import { isUniqueViolation, many, maybe, one, pool, tx } from './db.ts'
import { sha256 } from './auth.ts'
import { HttpError, scrub } from './record.ts'
import { messageOf } from '../shared/errors.ts'
import { BOX_LABEL, BOX_STATE_FORMAT, BoxLine, boxContainer, boxHomeVolume, type ContainerState } from '../shared/boxes.ts'
import { MACHINE_PORT, Port } from '../shared/listen.ts'
import { InstanceId, OPEN_CLAUDE_LOGIN, START_ERROR_MAX, type PersonId, type TeamId } from '../shared/onboarding.ts'

const run = promisify(execFile)
const ROOT = new URL('..', import.meta.url).pathname
const IMAGE = process.env.AGENTS_BOX_IMAGE ?? 'agents-box:latest'
const MAX_BOXES = Number(process.env.AGENTS_MAX_BOXES ?? 2)
// Minutes a box may go with nothing to do before it stops. Checks set a fraction of one.
const IdleMinutes = z.coerce.number().positive().default(30)
const idleMinutes = IdleMinutes.safeParse(process.env.AGENTS_BOX_IDLE_MIN)
if (!idleMinutes.success) throw new Error('AGENTS_BOX_IDLE_MIN must be a number of minutes above 0')
const IDLE_SEC = idleMinutes.data * 60
// A Claude token from `claude setup-token`, so agents in boxes run on the team's subscription.
const CLAUDE_TOKEN_FILE = process.env.AGENTS_BOX_TOKEN_FILE ?? join(homedir(), '.agents-app', 'box-claude-token')
// Browsers keep their rendering buffers in /dev/shm. Docker's default of 64 MB
// crashes tabs on real pages, and Playwright's own Docker guide raises it.
const BOX_SHM_SIZE = '512m'
// A box's ceiling is its size in `instances`, so a runaway browser or agent
// can't take the host, with swap equal to memory, which means no swap. In step
// 15, with a stand-in in place of Claude Code, a box running Chromium, Firefox
// and WebKit beside its own browser used 1.2 GB and 2.5 CPUs at most before
// there were limits. Every box keeps the 4 GiB and 2 CPUs of one seat, except
// a person's computer, which holds 4 seats in 4 CPUs and 8 GiB, as Tayler
// decided on 2026-10-15.
const PERSON_COMPUTER = { seats: 4, cpus: 4, memoryGib: 8 }
// Docker counts every thread against this, not only each process. One seat ran
// its browser and checks in three engines within 4,096, so a box gets that
// many for each seat.
const PIDS_PER_SEAT = 4096
// Room for `docker ps` over every box, and for a build's progress output.
const DOCKER_OUTPUT_BYTES = 8 * 1024 * 1024
const BUILD_OUTPUT_BYTES = 64 * 1024 * 1024

// Where box commands go, and where boxes reach this server's machine port. A box
// on this machine's Docker reaches it at host.docker.internal. A box on another
// host cannot, so there AGENTS_BOX_API must say where the server is.
const Settings = z.object({
  AGENTS_BOX_DOCKER_HOST: z.string().min(1).optional(),
  DOCKER_HOST: z.string().min(1).optional(),
  AGENTS_BOX_API: z.url().optional(),
  AGENTS_API_PORT: Port.default(MACHINE_PORT),
  // Extra `docker run` arguments, a JSON list of strings.
  AGENTS_BOX_DOCKER_ARGS: z.string().default('[]').transform((text, ctx) => {
    try {
      const value: unknown = JSON.parse(text)
      return value
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a JSON list of strings' })
      return z.NEVER
    }
  }).pipe(z.array(z.string())),
}).transform((env) => ({
  dockerHost: env.AGENTS_BOX_DOCKER_HOST ?? env.DOCKER_HOST,
  boxApi: env.AGENTS_BOX_API,
  localApi: `http://host.docker.internal:${env.AGENTS_API_PORT}`,
  extraArgs: env.AGENTS_BOX_DOCKER_ARGS,
})).superRefine((settings, ctx) => {
  if (settings.dockerHost && !settings.dockerHost.startsWith('unix://') && !settings.boxApi) {
    ctx.addIssue({
      code: 'custom', path: ['AGENTS_BOX_API'],
      message: `boxes run on ${settings.dockerHost}, so set AGENTS_BOX_API to where they reach this server's machine port, such as http://10.40.0.10:${String(MACHINE_PORT)}`,
    })
  }
})
const settings = Settings.safeParse(process.env)
if (!settings.success) throw new Error(`the box settings are wrong\n${z.prettifyError(settings.error)}`)
const { dockerHost: DOCKER_HOST, extraArgs: EXTRA_ARGS } = settings.data
const API_FROM_BOX = settings.data.boxApi ?? settings.data.localApi

// The Docker CLI's environment for box commands. Secrets travel here, named but
// never valued in the arguments, because a failed command's error message
// repeats its arguments into the log.
const dockerEnv = (secrets: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ ...process.env, ...(DOCKER_HOST ? { DOCKER_HOST } : {}), ...secrets })
const docker = async (args: string[], secrets: Record<string, string> = {}) =>
  (await run('docker', args, { maxBuffer: DOCKER_OUTPUT_BYTES, env: dockerEnv(secrets) })).stdout.trim()

// What docker said went wrong, scrubbed and cut short, since its words can repeat
// any value it was given. Never the error's message, which repeats the command
// line.
function dockerProblem(error: unknown): string {
  const stderr = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : ''
  // Docker ends with a usage hint, "Run 'docker run --help' for more information", which says nothing here.
  const said = stderr.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith("Run 'docker")).slice(-2).join(' ')
  // Docker usually says why on stderr. When it says nothing, this is all there is to tell.
  return scrub(said || 'Docker could not start the container and gave no reason.').slice(0, START_ERROR_MAX)
}

// What starting a box does in each of Docker's container states.
const START: Record<ContainerState, 'leave' | 'start' | 'replace'> = {
  running: 'leave', restarting: 'leave', removing: 'leave', created: 'start', exited: 'start', paused: 'replace', dead: 'replace',
}

// Every box container's state, by instance id, from one `docker ps`. A box host
// that cannot be reached throws, so an outage never looks like a missing container.
async function boxStates(): Promise<Map<string, ContainerState>> {
  const out = await docker(['ps', '--all', '--filter', `label=${BOX_LABEL}`, '--format', BOX_STATE_FORMAT])
  return new Map(out.split('\n').filter((line) => line !== '').map((line) => BoxLine.parse(line)))
}

const BoxSize = z.object({ seat_cap: z.int().positive(), cpus: z.int().positive(), memory_gib: z.int().positive() })

// Starts a fresh container for the box from the current image, on the box's volume.
// The token is new each time, since only its hash is kept. It changes only after
// the old container is gone, so a container that is still running keeps working.
// Every box signs in to Claude with the team's token, so a person's own computer
// works before its owner signs in. Once they have, its daemon runs Claude on
// their own token instead (daemon/claude.ts).
async function runContainer(client: pg.Pool | pg.PoolClient, instanceId: string) {
  await docker(['rm', '-f', boxContainer(instanceId)])
  const token = `machine_${randomBytes(24).toString('base64url')}`
  await client.query('update instances set token_sha256 = $2 where id = $1', [instanceId, sha256(token)])
  const box = BoxSize.parse(await one(client, 'the box', 'select seat_cap, cpus, memory_gib from instances where id = $1', [instanceId]))
  const secrets: Record<string, string> = { AGENTS_TOKEN: token }
  if (existsSync(CLAUDE_TOKEN_FILE)) secrets.CLAUDE_CODE_OAUTH_TOKEN = readFileSync(CLAUDE_TOKEN_FILE, 'utf8').trim()
  // Without NET_RAW a box cannot put raw frames on the shared bridge, such as ARP
  // replies that claim another box's address, and cannot capture packets or run
  // raw-socket scans. A ping an agent installs still works, through ICMP sockets.
  await docker(['run', '-d', '--name', boxContainer(instanceId), '--restart', 'unless-stopped', '--cap-drop', 'NET_RAW',
    '--shm-size', BOX_SHM_SIZE, '--memory', `${box.memory_gib}g`, '--memory-swap', `${box.memory_gib}g`, '--cpus', String(box.cpus),
    '--pids-limit', String(PIDS_PER_SEAT * box.seat_cap),
    '--label', `${BOX_LABEL}=${instanceId}`, '-v', `${boxHomeVolume(instanceId)}:/home/agent`,
    '-e', `AGENTS_API=${API_FROM_BOX}`, '-e', 'AGENTS_HOME=/home/agent/.agents-app',
    ...Object.keys(secrets).flatMap((name) => ['-e', name]), ...EXTRA_ARGS, IMAGE], secrets)
}

// A new box's token hash is a placeholder until its container starts with a real token.
const placeholderToken = () => sha256(randomBytes(24).toString('hex'))

// A new box's row for the team's pool.
async function addBox(client: pg.Pool | pg.PoolClient, teamId: string, name: string, claim?: { run?: string; person?: string }): Promise<string> {
  const box = await maybe<{ id: string }>(client,
    `insert into instances (team_id, name, kind, token_sha256, claimed_by, claimed_by_run, claimed_at, idle_since)
     values ($1, $2, 'box', $3, $4, $5, case when $4::uuid is null and $5::uuid is null then null else now() end, now())
     returning id`,
    [teamId, name, placeholderToken(), claim?.person ?? null, claim?.run ?? null])
  if (!box) throw new Error('the box was not added')
  return box.id
}

// How many names a personal box tries before it falls back to a random suffix.
const NAME_TRIES = 9

// The part of a login before the @, in the letters a box name holds. A login
// with no letters or digits there still gets a box, named box-person.
function boxNameFor(login: string): string {
  const local = (login.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  return `box-${local || 'person'}`
}

// A box for someone who joined before boxes were made on joining. Each person has one at most.
export async function makeOwnBox(person: { id: PersonId; team_id: TeamId; login: string }): Promise<InstanceId> {
  try {
    return await tx((client) => addPersonalBox(client, person.team_id, person.id, person.login))
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'You already have a box.')
    throw error
  }
}

// A person's own box, named after their login, held by them for good, with a
// person's computer's seats and size. The runner starts its container, as it
// does for any box a person holds.
export async function addPersonalBox(client: pg.PoolClient, teamId: TeamId, owner: PersonId, login: string): Promise<InstanceId> {
  const base = boxNameFor(login)
  const names = [base, ...Array.from({ length: NAME_TRIES - 1 }, (_, i) => `${base}-${i + 2}`), `${base}-${randomBytes(3).toString('hex')}`]
  for (const name of names) {
    const box = await maybe(client,
      `insert into instances (team_id, name, kind, owner_id, token_sha256, claimed_by, claimed_at, personal, idle_since, seat_cap, cpus, memory_gib)
       values ($1, $2, 'box', $3, $4, $3, now(), true, now(), $5, $6, $7)
       on conflict (team_id, name) do nothing returning id`,
      [teamId, name, owner, placeholderToken(), PERSON_COMPUTER.seats, PERSON_COMPUTER.cpus, PERSON_COMPUTER.memoryGib])
    if (box) return InstanceId.parse(box.id)
  }
  throw new Error(`no free name for ${login}'s box`)
}

export async function createBox(client: pg.Pool | pg.PoolClient, teamId: string, name: string) {
  const id = await addBox(client, teamId, name)
  await runContainer(client, id)
  return id
}

// Claims a box for a run: an online one nobody holds, else a stopped one, else a
// new one while the team is under AGENTS_MAX_BOXES. Null when every box is taken.
// Why agents in boxes cannot run yet, or null when they can. A box signs in to
// Claude with the token in ~/.agents-app/box-claude-token, unless it is given its own
// harness (AGENTS_CLAUDE_BIN in AGENTS_BOX_DOCKER_ARGS), as checks do.
export function boxLoginProblem(): string | null {
  if (existsSync(CLAUDE_TOKEN_FILE) || EXTRA_ARGS.some((arg) => arg.startsWith('AGENTS_CLAUDE_BIN='))) return null
  return `Boxes have no Claude login yet. Run \`claude setup-token\`, save the token in ${CLAUDE_TOKEN_FILE} on the server, and run the pipeline again.`
}

// The team's Claude token is saved on the server, so a computer can run Claude before its person signs in.
export const teamTokenSaved = (): boolean => existsSync(CLAUDE_TOKEN_FILE)

// The box image is built, so a computer can start.
export async function boxImageBuilt(): Promise<boolean> {
  try {
    await run('docker', ['image', 'inspect', IMAGE])
    return true
  } catch {
    return false
  }
}

// People's own boxes are not in the pool: runs never claim them and the limit does not count them.
export async function claimBox(client: pg.PoolClient, teamId: string, runId: string): Promise<string | null> {
  // One claim at a time per team, so two runners cannot both take the last free box.
  await client.query(`select pg_advisory_xact_lock(hashtext('boxes:' || $1))`, [teamId])
  const box = await maybe<{ id: string }>(client,
    `update instances set claimed_by_run = $2, claimed_at = now(), idle_since = null
     where id = (select id from instances
                 where team_id = $1 and kind = 'box' and not personal and claimed_by is null and claimed_by_run is null
                 order by status = 'online' desc, last_seen_at desc nulls last limit 1 for update skip locked)
     returning id`, [teamId, runId])
  if (box) return box.id
  const count = await maybe<{ n: number }>(client,
    `select count(*)::int as n from instances where team_id = $1 and kind = 'box' and not personal`, [teamId])
  if ((count?.n ?? 0) >= MAX_BOXES) return null
  return addBox(client, teamId, `box-${randomBytes(3).toString('hex')}`, { run: runId })
}

// What keeps a box running: a turn waiting for it, a command queued for it or in
// hand, its owner signing in to Claude on it, or a person holding its screen.
// Queries that use it pass the open sign-in statuses as $1.
const WANTED = `(exists (select 1 from turns t where t.instance_id = i.id and t.status = 'waiting')
  or exists (select 1 from commands c where c.instance_id = i.id and c.status in ('queued', 'claimed'))
  or exists (select 1 from claude_logins l where l.instance_id = i.id and l.status = any($1))
  or exists (select 1 from screen_takeovers s where s.instance_id = i.id and s.ended_at is null))`
const OPEN_LOGINS = [...OPEN_CLAUDE_LOGIN]

const HeldBox = z.object({ id: InstanceId, start_error: z.string().nullable(), asleep: z.boolean() })

// Starts the container of every box a person or an active run holds, if it is
// not running, except a person's own box asleep with nothing wanting it. Runs
// outside any run's transaction, after claims have committed. When the box host
// cannot be reached this throws before touching any box.
export async function startClaimedBoxes(teamIds: string[] | null) {
  const rows = (await many(pool,
    `select i.id, i.start_error, i.stopped_at is not null as asleep from instances i left join runs r on r.id = i.claimed_by_run
     where i.kind = 'box' and ($2::uuid[] is null or i.team_id = any($2))
       and (i.claimed_by is not null or r.status in ('queued', 'running', 'waiting'))
       and (i.stopped_at is null or ${WANTED})`, [OPEN_LOGINS, teamIds])).map((row) => HeldBox.parse(row))
  if (!rows.length) return
  const states = await boxStates()
  for (const box of rows) {
    const state = states.get(box.id)
    const action = state ? START[state] : 'replace'
    try {
      if (action === 'start') await docker(['start', boxContainer(box.id)])
      if (action === 'replace') await runContainer(pool, box.id)
      // A box woken from sleep gets its whole idle stretch again.
      if (box.asleep) await pool.query('update instances set stopped_at = null, idle_since = now() where id = $1', [box.id])
      if (box.start_error !== null) await pool.query('update instances set start_error = null where id = $1', [box.id])
    } catch (error) {
      // One box that cannot start, such as from a missing image, must not keep the
      // others from starting. The runner tries again on its next tick, and the
      // box's owner sees why it is not running. A reason is logged once, when it is new.
      const problem = dockerProblem(error)
      if (problem !== box.start_error) {
        console.error(`starting box ${box.id}: ${problem}`)
        await pool.query('update instances set start_error = $2 where id = $1', [box.id, problem])
      }
    }
  }
}

export async function releaseBox(client: pg.Pool | pg.PoolClient, runId: string) {
  await client.query(
    `update instances set claimed_by_run = null, claimed_at = null, idle_since = now() where claimed_by_run = $1`, [runId])
}

const IdleBox = z.object({ id: InstanceId, personal: z.boolean() })

// Wakes a person's own box that sleeps, for a request that needs it running, such
// as a key set for one of its agents. It clears the sleep mark and starts the box's
// idle stretch again, as startClaimedBoxes does for a box something wants, so the
// runner's next tick starts its container and the idle stopper puts it back to
// sleep later. It takes the row's lock first, the one markAsleep takes, so the two
// never interleave. Says whether the box was asleep.
export async function wakeOwnBox(boxId: InstanceId): Promise<boolean> {
  return tx(async (client) => {
    await client.query('select 1 from instances where id = $1 for update', [boxId])
    const woken = await maybe(client,
      'update instances set stopped_at = null, idle_since = now() where id = $1 and personal and stopped_at is not null returning id', [boxId])
    return woken !== undefined
  })
}

// Marks a person's own box asleep unless something wants it, and says whether it
// did. A turn placed on the box reads its row with a key share lock, so this waits
// for each such request to commit, and its second statement then sees the command
// that request wrote and leaves the box awake. A request that arrives while this
// holds the row waits for the mark, and then reads the box as asleep. Without the
// lock the statement reads a snapshot that cannot see a command still being
// written, and the box is stopped with a turn on its way to it.
export async function markAsleep(boxId: InstanceId): Promise<boolean> {
  return tx(async (client) => {
    await client.query('select 1 from instances where id = $1 for update', [boxId])
    const marked = await maybe(client,
      `update instances i set stopped_at = coalesce(stopped_at, now()) where id = $2 and not ${WANTED} returning id`, [OPEN_LOGINS, boxId])
    return marked !== undefined
  })
}

// Stops boxes with nothing to do. A box nobody holds stops once it has been idle
// for AGENTS_BOX_IDLE_MIN. A person's own box stops once that long has passed
// since it was made or woken and since its last turn ended. It is marked asleep
// first, so the runner leaves it stopped until something wants it, and one marked
// asleep whose container still runs, such as after a stop that failed, is stopped
// again. Their volumes stay, so they start again with their workspaces in place.
export async function stopIdleBoxes(teamIds: string[] | null) {
  const rows = (await many(pool,
    `select i.id, i.personal from instances i
     where i.kind = 'box' and i.claimed_by_run is null and i.status <> 'offline' and ($3::uuid[] is null or i.team_id = any($3))
       and not ${WANTED} and case when i.personal
         then i.stopped_at is not null
           or greatest(i.idle_since, (select max(t.finished_at) from turns t where t.instance_id = i.id)) < now() - make_interval(secs => $2)
         else i.claimed_by is null and i.idle_since < now() - make_interval(secs => $2) end`,
    [OPEN_LOGINS, IDLE_SEC, teamIds])).map((row) => IdleBox.parse(row))
  // Docker says which of the people's boxes still run, read once and only when one may.
  const states = rows.some((box) => box.personal) ? await boxStates() : new Map<string, ContainerState>()
  for (const box of rows) {
    if (box.personal) {
      if (!(await markAsleep(box.id)) || states.get(box.id) !== 'running') continue
    }
    await docker(['stop', boxContainer(box.id)]).catch((error: unknown) => { console.error(`stopping box ${box.id}:`, messageOf(error)) })
  }
}

if (import.meta.main) {
  const [command, team, name] = process.argv.slice(2)
  try {
    if (command === 'build') {
      // On a box host, the image is built there, for its architecture. Its build
      // steps use the host's network, outside the box firewall, and look names up
      // as the host does, since the Dockerfile is ours, not an agent's.
      await run('docker', ['build', '--network', 'host', '-t', IMAGE, '-f', 'box/Dockerfile', '.'], { cwd: ROOT, maxBuffer: BUILD_OUTPUT_BYTES, env: dockerEnv() })
      console.log(`built ${IMAGE}${DOCKER_HOST ? ` on ${DOCKER_HOST}` : ''}`)
    } else if (command === 'create' && team && name) {
      const found = await maybe<{ id: string }>(pool, 'select id from teams where name = $1', [team])
      if (!found) throw new Error(`no team ${team}`)
      console.log(JSON.stringify({ box: name, instanceId: await createBox(pool, found.id, name) }))
    } else if (command === 'recreate' && team && name) {
      const box = await maybe<{ id: string }>(pool,
        `select i.id from instances i join teams t on t.id = i.team_id where t.name = $1 and i.name = $2 and i.kind = 'box'`, [team, name])
      if (!box) throw new Error(`no box ${name} in ${team}`)
      await runContainer(pool, box.id)
      console.log(`recreated ${name} from ${IMAGE}, home volume kept`)
    } else if (command === 'list') {
      const { rows } = await pool.query(
        `select t.name as team, i.name, i.id, i.status, i.claimed_by_run, i.claimed_by, i.idle_since::text
         from instances i join teams t on t.id = i.team_id where i.kind = 'box' order by t.name, i.name`)
      console.table(rows)
    } else {
      console.error('usage: build | create <team> <name> | recreate <team> <name> | list')
      process.exitCode = 2
    }
  } finally {
    await pool.end()
  }
}
