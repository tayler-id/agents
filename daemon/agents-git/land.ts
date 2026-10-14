// land merges a submitted branch into main through every landing gate, and stops
// at the first that fails. It runs the coding framework's static gates on main's
// policy, needs Tayler's approval for each protected path and a review noted, runs
// each changed check on main's code, where it must fail, merges in a throwaway
// worktree of main, never in the main checkout the live app runs from, and runs
// the policy's full suite there under the checks' run lock. Only on green does it
// fast-forward local main and mirror main to GitHub. It restarts nothing.

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { messageOf } from '../../shared/errors.ts'
import type { Policy } from '../../shared/policy.ts'
import { aheadOf, commitOf, git, gitRun, mergeBase, moveRef, Sha, short, uncommitted, worktreeList } from './git.ts'
import { withLedger, type CheckRun, type Name } from './ledger.ts'
import { BUILD_LIMIT_SEC, describe, envFilesOf, lockWaitOf, logsOf, record, resultOf, runLockOf, runLogged, withRunLock, type Outcome } from './checks.ts'
import { gates, listed, mirrorMain, withNotes } from './github.ts'
import { failed, findReady, isReport, mainCommit, MAIN, ok, onBranch, openRepo, plural, policyAt, refsOf, refused, replace, worktreeRoot, type Report } from './repo.ts'
import { npmCi } from './worktrees.ts'

// all.ts ends with one line a step, and the suite's counts come from those lines.
const SUITE_LINE = /^(pass|FAIL) {2}step[0-9a-z]+\.ts \(\d+s\)$/gm
// Where land keeps the merge commit it made, so it stays reachable after its worktree goes.
const landRef = (name: Name) => `${refsOf(name)}/land`
const stampOf = (at: Date) => at.toISOString().replace(/[-:.]/g, '')

type Plan = { main: string, tip: Sha, mainSha: Sha, base: Sha, envFiles: string[], scratch: string, policy: Policy, approved: string[], message: string }

export async function land(ledgerFile: string, cwd: string, name: Name, approve: readonly string[]): Promise<Report> {
  const plan = await withLedger(ledgerFile, `land ${name}`, async (ledger): Promise<Plan | Report | { mirror: Sha, main: string }> => {
    const repo = await openRepo(cwd)
    const entry = findReady(ledger, repo, name)
    if (isReport(entry)) return entry
    if (entry.landed?.copy) return ok(`ok: ${name} already landed as ${short(entry.landed.merge)}, and GitHub's main has it as ${short(entry.landed.copy)}`)
    if (entry.landed) return { mirror: entry.landed.merge, main: repo.main }
    const worktree = onBranch(repo, entry)
    if (isReport(worktree)) return worktree
    const changed = await uncommitted(entry.path)
    if (changed) return refused(`land ${name}: it has ${plural(changed, 'uncommitted file')}`, 'commit them and submit again, or save them')
    const mainSha = await mainCommit(repo.main)
    if (!(await aheadOf(repo.main, worktree.head, mainSha))) return refused(`land ${name}: main already has every commit on it`, `done ${name} --yes`)
    if (entry.submitted?.head !== worktree.head) return refused(`land ${name}: ${entry.submitted ? 'its branch changed after it was submitted' : 'it was never submitted'}, so its commits were not scanned`, `submit ${name}`)
    if (entry.message === null) return refused(`land ${name}: the ledger has no message for the merge`, `submit ${name} --message <text>`)
    if (!entry.reviews.length) return refused(`land ${name}: no review is noted, and a change lands only after an agent on a different model reviews it`, `submit ${name} --review <who reviewed it and what they found>`)
    const envFiles = envFilesOf(repo.main)
    const absent = envFiles.filter((file) => !existsSync(file))
    if (absent.length) return refused(`land ${name}: main has no ${absent.join(' or ')}, which the suite loads`)
    const holder = (await worktreeList(repo.main)).find((w) => w.branch === 'main')
    if (holder && holder.path !== repo.main) return refused(`land ${name}: ${holder.path} has main checked out`)
    const dirty = holder ? await uncommitted(repo.main) : 0
    if (dirty) return refused(`land ${name}: the main checkout has ${plural(dirty, 'uncommitted file')}, so main can't fast-forward there`)
    const scratch = join(worktreeRoot(repo.main), `.land-${name}`)
    if (existsSync(scratch)) return refused(`land ${name}: ${scratch} is left from an earlier land`, `git worktree remove --force ${scratch}`)
    const base = await mergeBase(repo.main, mainSha, worktree.head)
    if (!base) return refused(`land ${name}: it shares no history with main`)
    const approved = withNotes(entry, { message: undefined, reviews: [], regression: undefined, approve }).approved
    // The merge commit's message is the ledger's, with its regression line first.
    const message = [...(entry.regression ? [`Regression: ${entry.regression}`] : []), entry.message].join('\n\n')
    return { main: repo.main, tip: worktree.head, mainSha, base, envFiles, scratch, policy: await policyAt(repo.main, mainSha), approved, message }
  })
  if (isReport(plan)) return plan
  if ('mirror' in plan) return mirror(ledgerFile, plan.main, name, plan.mirror)
  const judged = await gates(await openRepo(cwd), plan.policy, plan.mainSha, plan.base, plan.tip, new Set(plan.approved))
  if (judged.problems.length) return { code: 3, lines: [`refused: land ${name}: the gates found ${plural(judged.problems.length, 'problem')}. Nothing changed.`, ...listed(judged.problems)] }
  if (judged.unapproved.length) return { code: 3, lines: [`refused: land ${name}: these need Tayler's approval. Nothing changed.`, ...listed(judged.unapproved), `next: once Tayler approves, land ${name} --approve <path> for each`] }
  const verdict = await withRunLock(runLockOf(ledgerFile), lockWaitOf(plan.policy), async (running) => {
    const log = (label: string) => join(logsOf(ledgerFile, name), `${stampOf(new Date())}-land-${label}.log`)
    const keep = (step: string, head: Sha, outcome: Outcome, passed: number, failedCount: number, at: Date) => record(ledgerFile, plan.main, name,
      { step, head, passed, failed: failedCount, result: resultOf(outcome), at: at.toISOString(), seconds: outcome.seconds, log: outcome.log } satisfies CheckRun)
    try {
      mkdirSync(dirname(plan.scratch), { recursive: true })
      await git(plan.main, ['worktree', 'add', '--detach', '--quiet', plan.scratch, plan.mainSha])
      // The suite loads .env and .env.test from its own folder, and these links
      // point at main's, so they are never read here or copied.
      for (const file of plan.envFiles) symlinkSync(file, join(plan.scratch, basename(file)))
      const install = await npmCi(plan.scratch)
      if (install !== null) return failed(`land ${name}: npm ci in ${plan.scratch} failed`, install)
      const envFlags = plan.envFiles.map((file) => `--env-file=${file}`)
      const passing: string[] = []
      for (const file of judged.checks) {
        mkdirSync(dirname(join(plan.scratch, file)), { recursive: true })
        writeFileSync(join(plan.scratch, file), await git(plan.main, ['show', `${plan.tip}:${file}`]))
        const at = new Date()
        const outcome = await runLogged(running, ledgerFile, plan.scratch, [process.execPath, ...envFlags, file], plan.policy.checks.timeoutSec, BUILD_LIMIT_SEC, log(basename(file, '.ts')))
        await keep(`main: ${file}`, plan.mainSha, outcome, outcome.passed, outcome.failed, at)
        if (resultOf(outcome) === 'pass') passing.push(file)
      }
      if (passing.length) return refused(`land ${name}: ${passing.join(', ')} ${passing.length === 1 ? 'passes' : 'pass'} on main's code, so ${passing.length === 1 ? 'it guards' : 'they guard'} nothing yet`)
      await git(plan.scratch, ['checkout', '--force', '--quiet', '--detach', plan.mainSha])
      await git(plan.scratch, ['clean', '-fdq'])
      const merging = await gitRun(plan.scratch, ['merge', '--no-ff', '--no-edit', '-m', plan.message, plan.tip])
      if (merging.code !== 0) {
        const conflicts = (await git(plan.scratch, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter((file) => file !== '')
        return refused(`land ${name}: merging into main ${conflicts.length ? `conflicts in ${conflicts.join(', ')}` : `failed: ${merging.stderr.trim()}`}`, `sync ${name}, resolve, and submit again`)
      }
      const merge = Sha.parse((await git(plan.scratch, ['rev-parse', 'HEAD'])).trim())
      await moveRef(plan.main, landRef(name), merge, await commitOf(plan.main, landRef(name)))
      if ((await gitRun(plan.scratch, ['diff', '--quiet', plan.mainSha, merge, '--', 'package.json', 'package-lock.json'])).code !== 0) {
        const again = await npmCi(plan.scratch)
        if (again !== null) return failed(`land ${name}: npm ci after the merge failed`, again)
      }
      const outcomes: { label: string, outcome: Outcome, limitSec: number }[] = []
      for (const command of plan.policy.suite.commands) {
        const at = new Date()
        const outcome = await runLogged(running, ledgerFile, plan.scratch, command.argv, command.timeoutSec, BUILD_LIMIT_SEC, log(command.name))
        const lines = [...readFileSync(outcome.log, 'utf8').matchAll(SUITE_LINE)]
        await keep(command.name, merge, outcome, lines.filter((l) => l[1] === 'pass').length, lines.filter((l) => l[1] === 'FAIL').length, at)
        outcomes.push({ label: command.name, outcome, limitSec: command.timeoutSec })
      }
      const red = outcomes.filter(({ outcome }) => resultOf(outcome) !== 'pass')
      if (red.length) return { code: 3, lines: [`refused: land ${name}: the suite failed on the merge. Nothing changed.`, ...red.map(({ label, outcome, limitSec }) => describe(label, outcome, limitSec)), `  logs in ${logsOf(ledgerFile, name)}`] } satisfies Report
      return merge
    } finally {
      // Only a worktree git lists is removed. A folder left by a failed add stays
      // for a person, and the next land refuses until it is gone.
      if ((await worktreeList(plan.main)).some((w) => w.path === plan.scratch)) await git(plan.main, ['worktree', 'remove', '--force', plan.scratch])
    }
  })
  if (typeof verdict !== 'string') return verdict
  const moved = await withLedger(ledgerFile, `land ${name}`, async (ledger, write) => {
    const repo = await openRepo(cwd)
    const entry = findReady(ledger, repo, name)
    if (isReport(entry)) return entry
    if (await mainCommit(repo.main) !== plan.mainSha) return refused(`land ${name}: main moved while the suite ran`, `land ${name} again`)
    if (entry.branch === null) return refused(`land ${name}: it is on a detached HEAD`)
    if ((await commitOf(repo.main, `refs/heads/${entry.branch}`)) !== plan.tip) return refused(`land ${name}: its branch moved while the suite ran`, `submit ${name}, then land again`)
    const holder = (await worktreeList(repo.main)).find((w) => w.branch === 'main')
    if (holder && holder.path !== repo.main) return refused(`land ${name}: ${holder.path} has main checked out`)
    if (holder) {
      const dirty = await uncommitted(repo.main)
      if (dirty) return refused(`land ${name}: the main checkout has ${plural(dirty, 'uncommitted file')}, so main can't fast-forward there`)
      // The main checkout is where the live app runs from, so its files move with
      // main, as when the coordinator merged there. Nothing running is restarted.
      await git(repo.main, ['merge', '--ff-only', '--quiet', verdict])
    } else {
      await moveRef(repo.main, MAIN, verdict, plan.mainSha)
    }
    write(replace(ledger, { ...entry, approved: plan.approved, landed: { merge: verdict, copy: null, at: new Date().toISOString() } }))
    return null
  })
  if (moved) return moved
  return mirror(ledgerFile, plan.main, name, verdict)
}

// Copies main onto GitHub's history and pushes it, then records the copy.
async function mirror(ledgerFile: string, main: string, name: Name, merge: Sha): Promise<Report> {
  let copy: Sha
  try {
    copy = await mirrorMain(main, await mainCommit(main))
  } catch (error) {
    return failed(`${name} landed on local main as ${short(merge)}, and mirroring main to GitHub failed: ${messageOf(error)}`, `next: land ${name} again to mirror it`)
  }
  await withLedger(ledgerFile, `land ${name}`, async (ledger, write) => {
    const entry = ledger.worktrees.find((e) => e.repo === main && e.name === name)
    if (entry?.state !== 'active' || !entry.landed) throw new Error(`${name} left the ledger while main was mirrored`)
    write(replace(ledger, { ...entry, landed: { ...entry.landed, copy } }))
  })
  return ok(`ok: landed ${name} as ${short(merge)} on main, and GitHub's main is ${short(copy)}`)
}

