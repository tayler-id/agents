// Boxes: Docker containers that run the daemon, for unattended work. Each box is
// an instance with its own token, and a volume for its home folder, so its
// workspaces survive a restart and a rebuild of the image. A run claims a box
// and releases it when it ends; a person can claim one to keep it. A box nobody
// holds is stopped once it has been idle for AGENTS_BOX_IDLE_MIN minutes.
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
import { BOX_LABEL, boxContainer, boxHomeVolume } from '../shared/boxes.ts'
import { InstanceId, START_ERROR_MAX, type PersonId, type TeamId } from '../shared/onboarding.ts'

const run = promisify(execFile)
const ROOT = new URL('..', import.meta.url).pathname
const IMAGE = process.env.AGENTS_BOX_IMAGE ?? 'agents-box:latest'
const MAX_BOXES = Number(process.env.AGENTS_MAX_BOXES ?? 2)
const IDLE_MIN = Number(process.env.AGENTS_BOX_IDLE_MIN ?? 30)
// A Claude token from `claude setup-token`, so agents in boxes run on the team's subscription.
const CLAUDE_TOKEN_FILE = process.env.AGENTS_BOX_TOKEN_FILE ?? join(homedir(), '.agents-app', 'box-claude-token')
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
  AGENTS_API_PORT: z.coerce.number().int().min(1).max(65535).default(7700),
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
      message: `boxes run on ${settings.dockerHost}, so set AGENTS_BOX_API to where they reach this server's machine port, such as http://10.40.0.10:7700`,
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

// Docker's container states, and what starting a box does in each.
const ContainerState = z.enum(['created', 'restarting', 'running', 'removing', 'paused', 'exited', 'dead'])
type ContainerState = z.infer<typeof ContainerState>
const START: Record<ContainerState, 'leave' | 'start' | 'replace'> = {
  running: 'leave', restarting: 'leave', removing: 'leave', created: 'start', exited: 'start', paused: 'replace', dead: 'replace',
}
const BoxLine = z.string().transform((line) => line.split(' ')).pipe(z.tuple([z.uuid(), ContainerState]))

// Every box container's state, by instance id, from one `docker ps`. A box host
// that cannot be reached throws, so an outage never looks like a missing container.
async function boxStates(): Promise<Map<string, ContainerState>> {
  const out = await docker(['ps', '--all', '--filter', `label=${BOX_LABEL}`, '--format', `{{.Label "${BOX_LABEL}"}} {{.State}}`])
  return new Map(out.split('\n').filter((line) => line !== '').map((line) => BoxLine.parse(line)))
}

const BoxKind = z.object({ personal: z.boolean() })

// Starts a fresh container for the box from the current image, on the box's volume.
// The token is new each time, since only its hash is kept. It changes only after
// the old container is gone, so a container that is still running keeps working.
// A person's own box never gets the team's Claude token: it runs Claude on its
// owner's own sign-in.
async function runContainer(client: pg.Pool | pg.PoolClient, instanceId: string) {
  await docker(['rm', '-f', boxContainer(instanceId)])
  const token = `machine_${randomBytes(24).toString('base64url')}`
  await client.query('update instances set token_sha256 = $2 where id = $1', [instanceId, sha256(token)])
  const { personal } = BoxKind.parse(await one(client, 'the box', 'select personal from instances where id = $1', [instanceId]))
  const secrets: Record<string, string> = { AGENTS_TOKEN: token }
  if (!personal && existsSync(CLAUDE_TOKEN_FILE)) secrets.CLAUDE_CODE_OAUTH_TOKEN = readFileSync(CLAUDE_TOKEN_FILE, 'utf8').trim()
  await docker(['run', '-d', '--name', boxContainer(instanceId), '--restart', 'unless-stopped',
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

// A person's own box, named after their login, held by them for good. The
// runner starts its container, as it does for any box a person holds.
export async function addPersonalBox(client: pg.PoolClient, teamId: TeamId, owner: PersonId, login: string): Promise<InstanceId> {
  const base = boxNameFor(login)
  const names = [base, ...Array.from({ length: NAME_TRIES - 1 }, (_, i) => `${base}-${i + 2}`), `${base}-${randomBytes(3).toString('hex')}`]
  for (const name of names) {
    const box = await maybe(client,
      `insert into instances (team_id, name, kind, owner_id, token_sha256, claimed_by, claimed_at, personal)
       values ($1, $2, 'box', $3, $4, $3, now(), true)
       on conflict (team_id, name) do nothing returning id`,
      [teamId, name, owner, placeholderToken()])
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

const HeldBox = z.object({ id: InstanceId, start_error: z.string().nullable() })

// Starts the container of every box a person or an active run holds, if it is
// not running. Runs outside any run's transaction, after claims have committed.
// When the box host cannot be reached this throws before touching any box.
export async function startClaimedBoxes(teamIds: string[] | null) {
  const rows = (await many(pool,
    `select i.id, i.start_error from instances i left join runs r on r.id = i.claimed_by_run
     where i.kind = 'box' and ($1::uuid[] is null or i.team_id = any($1))
       and (i.claimed_by is not null or r.status in ('queued', 'running', 'waiting'))`, [teamIds])).map((row) => HeldBox.parse(row))
  if (!rows.length) return
  const states = await boxStates()
  for (const box of rows) {
    const state = states.get(box.id)
    const action = state ? START[state] : 'replace'
    try {
      if (action === 'start') await docker(['start', boxContainer(box.id)])
      if (action === 'replace') await runContainer(pool, box.id)
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

// Stops boxes nobody has held for a while. Their volumes stay, so the next claim
// starts them again with their workspaces in place.
export async function stopIdleBoxes(teamIds: string[] | null) {
  const { rows } = await pool.query<{ id: string }>(
    `select id from instances where kind = 'box' and claimed_by is null and claimed_by_run is null
     and ($2::uuid[] is null or team_id = any($2))
     and status <> 'offline' and idle_since < now() - make_interval(mins => $1)`, [IDLE_MIN, teamIds])
  for (const box of rows) {
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
