// The deployer. It releases a repo's commit on this server once the repo's
// owner approved the deploy, and rolls back by itself when the new release
// fails its health check. It runs as its own process, since a deploy restarts
// the API the runner lives in. On the server that is the launch agent
// com.agents.deployer, which Tayler installs once the API runs from a release.
//   node --env-file=.env ops/deploy.ts <target.json>          handles deploys until stopped
//   node --env-file=.env ops/deploy.ts <target.json> --once   handles the oldest waiting deploy and exits
//
// The target names the repo, the folder of releases with its `current` link,
// and each step as an argument list: install, back up, migrate, and restart.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { z } from 'zod'
import { maybe, one, pool } from '../server/db.ts'
import { mirror } from '../server/mirror.ts'
import { runProgram } from '../daemon/workspace.ts'
import { messageOf } from '../shared/errors.ts'
import { DEPLOY_NEXT, DEPLOY_WAIT_LIMIT_MIN, type DeployStatus } from '../shared/framework.ts'
import { envSecrets, makeScrub } from '../shared/scrub.ts'

const run = promisify(execFile)
const argv = z.array(z.string().min(1)).min(1)
const TARGET = z.object({
  repoId: z.uuid(),
  releases: z.string().min(1),
  install: argv,
  backup: argv,
  migrate: argv,
  restart: argv,
  health: z.object({ url: z.url(), timeoutSec: z.number().int().positive() }),
  stepTimeoutSec: z.number().int().positive(),
})
const HEALTH = z.object({ ok: z.boolean(), commit: z.string().nullable() })
// How often to look for a deploy to do, and to ask a new release whether it answers.
const IDLE_POLL_MS = 3000
const HEALTH_POLL_MS = 500
// One health request may take this long before it counts as no answer.
const HEALTH_REQUEST_MS = 3000

const [file, mode] = process.argv.slice(2)
if (!file) {
  console.error('usage: node --env-file=.env ops/deploy.ts <target.json> [--once]')
  process.exit(2)
}
const target = TARGET.parse(JSON.parse(readFileSync(file, 'utf8')))
const scrub = makeScrub(envSecrets(process.env))
const current = join(target.releases, 'current')
let stopping = false

type Deploy = { id: string; commit: string; status: DeployStatus; log: string[] }

// Moves a deploy to its next status, refusing any move the lifecycle does not allow.
async function move(deploy: Deploy, to: DeployStatus, note: string | null = null) {
  if (!DEPLOY_NEXT[deploy.status].includes(to)) throw new Error(`a deploy cannot go from ${deploy.status} to ${to}`)
  const done = DEPLOY_NEXT[to].length === 0
  await pool.query(
    `update deploys set status = $2, log = $3, note = coalesce($4, note), ended_at = case when $5 then now() else ended_at end where id = $1`,
    [deploy.id, to, scrub(deploy.log.join('\n')), note, done])
  deploy.status = to
  console.log(`deploy ${deploy.id}: ${to}${note ? `, ${note}` : ''}`)
}

async function step(deploy: Deploy, name: string, command: readonly string[], cwd: string): Promise<boolean> {
  const result = await runProgram(cwd, command, target.stepTimeoutSec)
  deploy.log.push(`$ ${command.join(' ')}`, result.output.trim(), `${name} exited with ${result.exitCode ?? 'no code'}${result.timedOut ? ' after timing out' : ''}`)
  return result.exitCode === 0
}

// Points `current` at a release in one rename, so nothing ever sees it missing.
function pointAt(dir: string) {
  const next = `${current}.next`
  rmSync(next, { force: true })
  symlinkSync(dir, next)
  renameSync(next, current)
}

// Whether the service answers its health check with the commit it should run.
// Each request has a time limit, and an answer that is slow, unreachable or not
// the health JSON counts as no answer. The last such answer goes in the log.
async function answers(deploy: Deploy, commit: string): Promise<boolean> {
  const deadline = Date.now() + target.health.timeoutSec * 1000
  let last = 'no answer yet'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(target.health.url, { signal: AbortSignal.timeout(HEALTH_REQUEST_MS) })
      const health = HEALTH.safeParse(await res.json())
      if (health.success && health.data.ok && health.data.commit === commit) return true
      last = health.success ? `it answered with ${health.data.commit ?? 'no commit'}` : `it answered ${res.status} with something other than the health answer`
    } catch (error) {
      last = messageOf(error)
    }
    await sleep(HEALTH_POLL_MS)
  }
  deploy.log.push(`${target.health.url} did not answer with ${commit} within ${target.health.timeoutSec}s. The last try: ${last}`)
  return false
}

const commitIn = async (dir: string) => (await run('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', timeout: target.stepTimeoutSec * 1000 })).stdout.trim()

// A release folder holding the commit, made from the repo's mirror and
// installed. It is built under a .partial name and renamed into place only once
// it installed, so a release that failed, or a deployer that stopped part way,
// never leaves a half-installed release to be used later.
async function release(deploy: Deploy): Promise<string | null> {
  const dir = join(target.releases, deploy.commit)
  if (existsSync(dir)) return dir
  const partial = `${dir}.partial`
  rmSync(partial, { recursive: true, force: true })
  mkdirSync(target.releases, { recursive: true })
  try {
    const repo = await one<{ remote_url: string }>(pool, 'the repo to deploy', 'select remote_url from repos where id = $1', [target.repoId])
    const m = await mirror(target.repoId, repo.remote_url, ['*'])
    const limit = { timeout: target.stepTimeoutSec * 1000 }
    await run('git', ['clone', '--quiet', '--no-checkout', m.dir, partial], limit)
    await run('git', ['checkout', '--quiet', '--detach', deploy.commit], { cwd: partial, ...limit })
    if (!(await step(deploy, 'install', target.install, partial))) {
      rmSync(partial, { recursive: true, force: true })
      return null
    }
    renameSync(partial, dir)
    return dir
  } catch (error) {
    rmSync(partial, { recursive: true, force: true })
    throw error
  }
}

async function handle(deploy: Deploy) {
  const dir = await release(deploy)
  if (!dir) return move(deploy, 'failed', 'The release did not install. Nothing changed on the server.')
  if (!(await step(deploy, 'backup', target.backup, dir))) return move(deploy, 'failed', 'The database backup failed. Nothing changed on the server.')
  if (!(await step(deploy, 'migrate', target.migrate, dir))) return move(deploy, 'failed', 'The migrations failed. The server still runs the release before.')
  const previous = existsSync(current) ? realpathSync(current) : null
  await move(deploy, 'switching')
  try {
    pointAt(dir)
    if (await step(deploy, 'restart', target.restart, target.releases)) {
      await move(deploy, 'checking')
      if (await answers(deploy, deploy.commit)) return await move(deploy, 'healthy')
    }
    return await rollBack(deploy, previous, null)
  } catch (error) {
    // Anything that goes wrong after the switch puts the release before back,
    // and the deploy ends failed, since nobody can say what state it left.
    deploy.log.push(`after the switch: ${messageOf(error)}`)
    return rollBack(deploy, previous, messageOf(error))
  }
}

// Puts the release before back, restarts, and checks it answers. A failed
// health check that went back cleanly ends rolled_back. An error, or a
// release before that does not answer either, ends failed.
async function rollBack(deploy: Deploy, previous: string | null, error: string | null) {
  if (deploy.status !== 'rolling_back') await move(deploy, 'rolling_back')
  const why = error === null ? 'The release failed its health check.' : `An error after the switch: ${error}.`
  if (!previous) return move(deploy, 'failed', `${why} There is no release before it to go back to. A person must look now.`)
  try {
    pointAt(previous)
    const back = await commitIn(previous)
    const answered = await step(deploy, 'restart', target.restart, target.releases) && await answers(deploy, back)
    if (!answered) return await move(deploy, 'failed', `${why} Going back to ${back.slice(0, 10)} did not answer either. A person must look now.`)
    const note = `${why} The server went back to ${back.slice(0, 10)}, which answers. Its migrations stay applied.`
    return await move(deploy, error === null ? 'rolled_back' : 'failed', note)
  } catch (rollbackError) {
    deploy.log.push(`going back: ${messageOf(rollbackError)}`)
    return move(deploy, 'failed', `${why} Going back failed too: ${messageOf(rollbackError)}. A person must look now.`)
  }
}

// Fails each deploy of the repo that waited longer than the limit for a
// deployer, so a stale approval never goes out.
async function expireWaiting() {
  const { rows } = await pool.query<{ id: string }>(
    `update deploys set status = 'failed', note = $2, ended_at = now()
     where repo_id = $1 and status = 'requested' and created_at < now() - make_interval(mins => $3) returning id`,
    [target.repoId, `No deployer started it within ${DEPLOY_WAIT_LIMIT_MIN} minutes, so it never went out. Approve a new deploy.`, DEPLOY_WAIT_LIMIT_MIN])
  for (const { id } of rows) console.log(`deploy ${id}: failed, it waited past ${DEPLOY_WAIT_LIMIT_MIN} minutes`)
}

// Takes the oldest waiting deploy of the repo. Only one deployer gets each.
async function claim(): Promise<Deploy | null> {
  const row = await maybe<{ id: string; commit: string }>(pool,
    `update deploys set status = 'preparing', started_at = now() where id = (
       select id from deploys where repo_id = $1 and status = 'requested' order by created_at limit 1 for update skip locked)
     returning id, commit`, [target.repoId])
  return row ? { id: row.id, commit: row.commit, status: 'preparing', log: [] } : null
}

process.on('SIGTERM', () => { stopping = true })
process.on('SIGINT', () => { stopping = true })
// A signal sets the flag between awaits, so it is read through a function.
const stopped = (): boolean => stopping
try {
  while (!stopped()) {
    await expireWaiting()
    const deploy = await claim()
    if (deploy) {
      await handle(deploy).catch(async (error: unknown) => {
        deploy.log.push(error instanceof Error ? error.message : String(error))
        if (deploy.status === 'preparing') await move(deploy, 'failed', 'The deployer failed before switching. Nothing changed on the server.')
        else throw error
      })
    }
    if (mode === '--once') break
    if (!deploy) await sleep(IDLE_POLL_MS)
  }
} finally {
  await pool.end()
}
