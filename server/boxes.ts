// Boxes: Docker containers that run the daemon, for unattended work. Each box is
// an instance with its own token, and a volume for its home folder, so its
// workspaces survive a restart and a rebuild of the image. A run claims a box
// and releases it when it ends; a person can claim one to keep it. A box nobody
// holds is stopped once it has been idle for AGENTS_BOX_IDLE_MIN minutes.
//
// Claims are rows, written inside the run's transaction. Containers start only
// after that commits, in startClaimedBoxes, so a claim that rolls back never
// leaves a container behind.
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
import { maybe, pool } from './db.ts'
import { sha256 } from './auth.ts'
import { messageOf } from '../shared/errors.ts'

const run = promisify(execFile)
const ROOT = new URL('..', import.meta.url).pathname
const IMAGE = process.env.AGENTS_BOX_IMAGE ?? 'agents-box:latest'
const MAX_BOXES = Number(process.env.AGENTS_MAX_BOXES ?? 2)
const IDLE_MIN = Number(process.env.AGENTS_BOX_IDLE_MIN ?? 30)
// Boxes reach the API's machine port on this Mac, the one port the firewall allows.
const API_FROM_BOX = process.env.AGENTS_BOX_API ?? `http://host.docker.internal:${process.env.AGENTS_API_PORT ?? 7700}`
// A Claude token from `claude setup-token`, so agents in boxes run on the team's subscription.
const CLAUDE_TOKEN_FILE = process.env.AGENTS_BOX_TOKEN_FILE ?? join(homedir(), '.agents-app', 'box-claude-token')

export const containerName = (instanceId: string) => `agents-box-${instanceId}`
const docker = async (...args: string[]) => (await run('docker', args, { maxBuffer: 8 * 1024 * 1024 })).stdout.trim()

// Starts a fresh container for the box from the current image, on the box's volume.
// The token is new each time, since only its hash is kept.
async function runContainer(client: pg.Pool | pg.PoolClient, instanceId: string) {
  const token = `machine_${randomBytes(24).toString('base64url')}`
  await client.query('update instances set token_sha256 = $2 where id = $1', [instanceId, sha256(token)])
  await docker('rm', '-f', containerName(instanceId)).catch(() => {})
  const env = ['-e', `AGENTS_API=${API_FROM_BOX}`, '-e', `AGENTS_TOKEN=${token}`, '-e', 'AGENTS_HOME=/home/agent/.agents-app']
  if (existsSync(CLAUDE_TOKEN_FILE)) env.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${readFileSync(CLAUDE_TOKEN_FILE, 'utf8').trim()}`)
  const extra = JSON.parse(process.env.AGENTS_BOX_DOCKER_ARGS ?? '[]') as string[]
  await docker('run', '-d', '--name', containerName(instanceId), '--restart', 'unless-stopped',
    '--label', `agents.instance=${instanceId}`, '-v', `${containerName(instanceId)}-home:/home/agent`, ...env, ...extra, IMAGE)
}

async function startContainer(client: pg.Pool | pg.PoolClient, instanceId: string) {
  const state = await docker('inspect', '-f', '{{.State.Running}}', containerName(instanceId)).catch(() => null)
  if (state === 'true') return
  if (state === 'false') await docker('start', containerName(instanceId))
  else await runContainer(client, instanceId)
}

// A new box's row. Its token is a placeholder until its container starts with a real one.
async function addBox(client: pg.Pool | pg.PoolClient, teamId: string, name: string, claim?: { run?: string; person?: string }): Promise<string> {
  const box = await maybe<{ id: string }>(client,
    `insert into instances (team_id, name, kind, token_sha256, claimed_by, claimed_by_run, claimed_at, idle_since)
     values ($1, $2, 'box', $3, $4, $5, case when $4::uuid is null and $5::uuid is null then null else now() end, now())
     returning id`,
    [teamId, name, sha256(randomBytes(24).toString('hex')), claim?.person ?? null, claim?.run ?? null])
  if (!box) throw new Error('the box was not added')
  return box.id
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
  if (existsSync(CLAUDE_TOKEN_FILE) || (process.env.AGENTS_BOX_DOCKER_ARGS ?? '').includes('AGENTS_CLAUDE_BIN=')) return null
  return `Boxes have no Claude login yet. Run \`claude setup-token\` on the server Mac, save the token in ${CLAUDE_TOKEN_FILE}, and run the pipeline again.`
}

export async function claimBox(client: pg.PoolClient, teamId: string, runId: string): Promise<string | null> {
  // One claim at a time per team, so two runners cannot both take the last free box.
  await client.query(`select pg_advisory_xact_lock(hashtext('boxes:' || $1))`, [teamId])
  const box = await maybe<{ id: string }>(client,
    `update instances set claimed_by_run = $2, claimed_at = now(), idle_since = null
     where id = (select id from instances
                 where team_id = $1 and kind = 'box' and claimed_by is null and claimed_by_run is null
                 order by status = 'online' desc, last_seen_at desc nulls last limit 1 for update skip locked)
     returning id`, [teamId, runId])
  if (box) return box.id
  const count = await maybe<{ n: number }>(client,
    `select count(*)::int as n from instances where team_id = $1 and kind = 'box'`, [teamId])
  if ((count?.n ?? 0) >= MAX_BOXES) return null
  return addBox(client, teamId, `box-${randomBytes(3).toString('hex')}`, { run: runId })
}

// Starts the container of every box a person or an active run holds, if it is
// not running. Runs outside any run's transaction, after claims have committed.
export async function startClaimedBoxes(teamIds: string[] | null) {
  const { rows } = await pool.query<{ id: string }>(
    `select i.id from instances i left join runs r on r.id = i.claimed_by_run
     where i.kind = 'box' and ($1::uuid[] is null or i.team_id = any($1))
       and (i.claimed_by is not null or r.status in ('queued', 'running', 'waiting'))`, [teamIds])
  for (const box of rows) {
    await startContainer(pool, box.id).catch((e: unknown) => { console.error(`starting box ${box.id}:`, e instanceof Error ? e.message : e) })
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
    await docker('stop', containerName(box.id)).catch((error: unknown) => { console.error(`stopping box ${box.id}:`, messageOf(error)) })
  }
}

if (import.meta.main) {
  const [command, team, name] = process.argv.slice(2)
  try {
    if (command === 'build') {
      await run('docker', ['build', '-t', IMAGE, '-f', 'box/Dockerfile', '.'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
      console.log(`built ${IMAGE}`)
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
