// check runs a worktree's steps the way AGENTS.md asks, so no part can be skipped.
// It takes the checks' run lock, loads main's .env and then .env.test by absolute
// path, stops a step past its time limit along with everything the step started,
// keeps each step's log, records what passed in the ledger, prunes the untagged
// images a docker build leaves, and lets go of the lock however it ends. land runs
// its full suite through the same pieces.

import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import type { Policy } from '../../shared/policy.ts'
import { commitOf, run, short, uncommitted, type Sha } from './git.ts'
import { childEnv, runGroup, stoppable, Stopped, type Group, type Running } from './group.ts'
import { appHome, errorCode, withLedger, type CheckRun, type Name } from './ledger.ts'
import { failed, findReady, isReport, mainCommit, ok, onBranch, openRepo, plural, policyAt, quote, refused, replace, stampOf, type Report } from './repo.ts'

// How often a check looks again for the run lock, which changes hands once a check at most.
const RUN_LOCK_POLL_MS = 1_000
// A docker build that runs this long is stuck. A warm build of the box image takes minutes.
export const BUILD_LIMIT_SEC = 20 * 60
const PRUNE_TIMEOUT_MS = 2 * 60_000
const SHIM = new URL('./docker.ts', import.meta.url).pathname

export const StepId = z.string().regex(/^[0-9]+[a-z]*$/, 'a step is its id, such as 22 or 18d')
export type StepId = z.infer<typeof StepId>
export const stepFile = (id: StepId) => `test/step${id}.ts`
export const runLockOf = (ledgerFile: string) => join(appHome(ledgerFile), 'checks', 'run.lock')
export const logsOf = (ledgerFile: string, name: Name) => join(appHome(ledgerFile), 'checks', 'agents-git', name)
// Main's env files, which a check loads in this order and agents-git never reads.
export const envFilesOf = (main: string) => [join(main, '.env'), join(main, '.env.test')]
// The longest anyone may hold the run lock under the policy, which is how long a check waits for it.
export const lockWaitOf = (policy: Policy) => Math.max(policy.checks.timeoutSec, ...policy.suite.commands.map((c) => c.timeoutSec)) * 1000

// Takes the run lock AGENTS.md names, a folder made with mkdir, waiting until the
// deadline. A return, a throw or a signal all remove it. Only SIGKILL can't. A signal
// stops the program work is running and ends work through its finally blocks, and the
// lock goes after them.
export async function withRunLock<T>(path: string, waitMs: number, work: (running: Running) => Promise<T>): Promise<T> {
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + waitMs
  let told = false
  for (;;) {
    try {
      mkdirSync(path)
      break
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
    if (Date.now() > deadline) throw new Error(`${path} is still held after ${Math.round(waitMs / 60_000)} minutes. Nothing ran.`)
    if (!told) {
      console.error(`waiting for ${path}, which another check holds`)
      told = true
    }
    await sleep(RUN_LOCK_POLL_MS)
  }
  const held = { now: true }
  const release = () => {
    if (!held.now) return
    held.now = false
    rmdirSync(path)
  }
  process.on('exit', release)
  try {
    return await stoppable(work)
  } finally {
    process.off('exit', release)
    release()
  }
}

type Docker = { real: string, folder: string, builds: string }

// The real docker on the PATH, and the docker every check sees, written in front of it.
function dockerFor(ledgerFile: string): Docker | null {
  const folder = join(appHome(ledgerFile), 'checks', 'agents-git', 'bin')
  const real = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== folder).map((dir) => join(dir, 'docker')).find((file) => {
    try {
      accessSync(file, constants.X_OK)
      return statSync(file).isFile()
    } catch {
      return false
    }
  })
  if (real === undefined) return null
  mkdirSync(folder, { recursive: true })
  const launcher = join(folder, 'docker')
  writeFileSync(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(SHIM)} "$@"\n`)
  chmodSync(launcher, 0o755)
  return { real, folder, builds: join(folder, 'builds') }
}

export type Outcome = { code: number | null, timedOut: boolean, seconds: number, passed: number, failed: number, log: string, pruned: string | null }

// Runs one program to completion or its limit with its output in a log, in a
// process group of its own, so stopping it stops everything it started.
export async function runLogged(running: Running, ledgerFile: string, cwd: string, argv: readonly string[], limitSec: number, buildLimitSec: number, log: string): Promise<Outcome> {
  const docker = dockerFor(ledgerFile)
  if (docker) writeFileSync(docker.builds, '')
  const env = childEnv(docker ? { AGENTS_GIT_DOCKER: docker.real, AGENTS_GIT_BUILDS: docker.builds, AGENTS_GIT_BUILD_LIMIT_SEC: String(buildLimitSec) } : {}, docker ? [docker.folder] : [])
  const built = () => docker !== null && statSync(docker.builds).size > 0
  let group: Group
  try {
    group = await runGroup(running, argv, cwd, env, limitSec, log)
  } catch (error) {
    // A stop leaves the images a build had made, as a finished step does.
    if (error instanceof Stopped && docker && built()) await prune(docker.real, cwd)
    throw error
  }
  const output = readFileSync(log, 'utf8')
  return {
    code: group.code,
    timedOut: group.timedOut,
    seconds: group.seconds,
    passed: (output.match(/^pass {2}/gm) ?? []).length,
    failed: (output.match(/^FAIL {2}/gm) ?? []).length,
    log,
    pruned: docker && built() ? await prune(docker.real, cwd) : null,
  }
}

// AGENTS.md: after a check run that builds a Docker image, docker image prune -f.
async function prune(docker: string, cwd: string): Promise<string> {
  const ran = await run(docker, ['image', 'prune', '-f'], cwd, PRUNE_TIMEOUT_MS, process.env)
  return ran.code === 0 ? 'pruned the untagged images its docker build left' : `docker image prune -f exited ${ran.code}: ${ran.stderr.trim()}`
}

export function resultOf(outcome: Outcome): CheckRun['result'] {
  if (outcome.timedOut) return 'timeout'
  return outcome.code === 0 ? 'pass' : 'fail'
}

export function describe(label: string, outcome: Outcome, limitSec: number): string {
  const how = outcome.timedOut ? `ran past ${limitSec}s and was stopped` : `${outcome.passed} passed, ${outcome.failed} failed, exit ${outcome.code ?? 'by signal'}, ${outcome.seconds}s`
  return `  ${label}  ${how}${outcome.pruned ? `, ${outcome.pruned}` : ''}`
}

// Adds a run to the worktree's entry in the ledger.
export async function record(ledgerFile: string, repo: string, name: Name, entryRun: CheckRun): Promise<void> {
  await withLedger(ledgerFile, `record a check of ${name}`, async (ledger, write) => {
    const entry = ledger.worktrees.find((e) => e.repo === repo && e.name === name)
    if (entry?.state !== 'active') throw new Error(`${name} left the ledger while its check ran`)
    write(replace(ledger, { ...entry, checks: [...entry.checks, entryRun] }))
  })
}

// What changed in the worktree since check read its commit and files, or null when nothing did.
// A result is recorded against a commit, so it must belong to the commit the step ran on.
// Files are read only before the first step, since a step may leave files of its own.
async function changedSince(path: string, head: Sha, files: boolean): Promise<string | null> {
  const now = await commitOf(path, 'HEAD')
  if (now !== head) return `its commit moved from ${short(head)} to ${now ? short(now) : 'nothing'}`
  const dirty = files ? await uncommitted(path) : 0
  return dirty ? `it has ${plural(dirty, 'uncommitted file')} now` : null
}

export async function check(ledgerFile: string, cwd: string, name: Name, steps: readonly StepId[], limitSec: number | undefined, buildLimitSec: number | undefined): Promise<Report> {
  const plan = await withLedger(ledgerFile, `check ${name}`, async (ledger) => {
    const repo = await openRepo(cwd)
    const entry = findReady(ledger, repo, name)
    if (isReport(entry)) return entry
    const worktree = onBranch(repo, entry)
    if (isReport(worktree)) return worktree
    // A linked node_modules also shows as an untracked file, since node_modules/ in
    // .gitignore matches only a folder, so it is named first, as the cause.
    if (lstatSync(join(entry.path, 'node_modules'), { throwIfNoEntry: false })?.isSymbolicLink()) return refused(`check ${name}: its node_modules is a link to another copy`, `run npm ci in ${entry.path}`)
    const changed = await uncommitted(entry.path)
    if (changed) return refused(`check ${name}: it has ${plural(changed, 'uncommitted file')}, and a result must belong to a commit`, 'commit them, then check again')
    const missing = steps.map(stepFile).filter((file) => !existsSync(join(entry.path, file)))
    if (missing.length) return refused(`check ${name}: there is no ${missing.join(' or ')}`)
    const envFiles = envFilesOf(repo.main)
    const absent = envFiles.filter((file) => !existsSync(file))
    if (absent.length) return refused(`check ${name}: main has no ${absent.join(' or ')}`)
    const policy = await policyAt(repo.main, await mainCommit(repo.main))
    return { repo: repo.main, entry, head: worktree.head, envFiles, limitSec: limitSec ?? policy.checks.timeoutSec, waitMs: lockWaitOf(policy) }
  })
  if (isReport(plan)) return plan
  const builds = buildLimitSec ?? BUILD_LIMIT_SEC
  const ran = await withRunLock(runLockOf(ledgerFile), plan.waitMs, async (running): Promise<Report | { id: StepId, outcome: Outcome }[]> => {
    // The wait for the lock can be long, and the worktree is an agent's to change meanwhile.
    const moved = await changedSince(plan.entry.path, plan.head, true)
    if (moved) return refused(`check ${name}: ${moved} since check read it, so no step ran`, 'commit or set aside what changed, then check again')
    const out: { id: StepId, outcome: Outcome }[] = []
    for (const id of steps) {
      const at = new Date()
      const argv = [process.execPath, ...plan.envFiles.map((file) => `--env-file=${file}`), stepFile(id)]
      const outcome = await runLogged(running, ledgerFile, plan.entry.path, argv, plan.limitSec, builds, join(logsOf(ledgerFile, name), `${stampOf(at)}-step${id}.log`))
      const after = await changedSince(plan.entry.path, plan.head, false)
      if (after) return failed(`check ${name}: ${after} while step${id} ran, so its result was not recorded`, `  log ${outcome.log}`)
      await record(ledgerFile, plan.repo, name, { step: id, head: plan.head, passed: outcome.passed, failed: outcome.failed, result: resultOf(outcome), at: at.toISOString(), seconds: outcome.seconds, log: outcome.log })
      out.push({ id, outcome })
    }
    return out
  })
  if (isReport(ran)) return ran
  const lines = ran
  const bad = lines.filter(({ outcome }) => resultOf(outcome) !== 'pass' || (outcome.pruned !== null && !outcome.pruned.startsWith('pruned')))
  const detail = [...lines.map(({ id, outcome }) => describe(`step${id}`, outcome, plan.limitSec)), `  logs in ${logsOf(ledgerFile, name)}`]
  if (bad.length) return failed(`${name} failed ${bad.map(({ id }) => `step${id}`).join(', ')} at ${short(plan.head)}`, ...detail)
  return ok(`ok: ${name} passed ${plural(lines.length, 'step')} at ${short(plan.head)}`, ...detail)
}
