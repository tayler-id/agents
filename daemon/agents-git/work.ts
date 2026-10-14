// save and sync. save keeps a worktree's uncommitted work in a ref, so it outlives
// an agent that stops. sync rebases the worktree's branch onto local main.

import { existsSync } from 'node:fs'
import { aheadOf, git, gitRun, isAncestor, latestRef, moveRef, Sha, short, snapshotTree, treeOf, uncommitted } from './git.ts'
import { withLedger, type Name } from './ledger.ts'
import { failed, findReady, isReport, mainCommit, ok, onBranch, openRepo, plural, reachable, refused, replace, savesOf, type Report } from './repo.ts'

// A save's ref is named for the moment it was made, in a form a ref name allows.
const stamp = () => new Date().toISOString().replace(/[-:.]/g, '')

export async function save(ledgerFile: string, cwd: string, name: Name): Promise<Report> {
  return withLedger(ledgerFile, `save ${name}`, async (ledger) => {
    const repo = await openRepo(cwd)
    const entry = findReady(ledger, repo, name)
    if (isReport(entry)) return entry
    // A worktree stopped part way through a rebase is on a detached HEAD, and its
    // work is the work most worth keeping, so save takes any branch.
    const worktree = reachable(repo, entry)
    if (isReport(worktree)) return worktree
    const tree = await snapshotTree(entry.path)
    if (tree === await treeOf(repo.main, worktree.head)) return ok(`ok: ${name} has nothing uncommitted, so there is nothing to save`)
    const latest = await latestRef(repo.main, savesOf(name))
    if (latest?.tree === tree) return ok(`ok: ${latest.ref} already holds ${name}'s uncommitted work`)
    const commit = Sha.parse((await git(entry.path, ['commit-tree', '--no-gpg-sign', tree, '-p', worktree.head], { input: `agents-git save of ${name}\n` })).trim())
    const ref = `${savesOf(name)}${stamp()}`
    await moveRef(repo.main, ref, commit, null)
    return ok(`ok: saved ${name}'s ${plural(await uncommitted(entry.path), 'uncommitted file')} as ${ref}, on top of ${short(worktree.head)}`)
  })
}

// The git operation a worktree stopped part way through, if any.
async function inProgress(path: string): Promise<string | null> {
  const has = async (name: string) => existsSync((await git(path, ['rev-parse', '--path-format=absolute', '--git-path', name])).trim())
  if (await has('rebase-merge') || await has('rebase-apply')) return 'rebase'
  if (await has('MERGE_HEAD')) return 'merge'
  if (await has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (await has('REVERT_HEAD')) return 'revert'
  return null
}

export async function sync(ledgerFile: string, cwd: string, name: Name): Promise<Report> {
  return withLedger(ledgerFile, `sync ${name}`, async (ledger, write) => {
    const repo = await openRepo(cwd)
    const entry = findReady(ledger, repo, name)
    if (isReport(entry)) return entry
    const found = reachable(repo, entry)
    if (isReport(found)) return found
    // Part way through a rebase the worktree is on a detached HEAD, so this comes
    // before the branch check, which would give the wrong reason.
    const busy = await inProgress(entry.path)
    if (busy) return refused(`${name} is part way through a ${busy}`, `finish it with git ${busy} --continue in ${entry.path}, or stop it with git ${busy} --abort`)
    const worktree = onBranch(repo, entry)
    if (isReport(worktree)) return worktree
    if (entry.branch === null) return refused(`${name} is on a detached HEAD, and sync rebases a branch`)
    const changed = await uncommitted(entry.path)
    if (changed) return refused(`${name} has ${plural(changed, 'uncommitted file')}`, `commit them, or save ${name} and set them aside, then sync again`)
    const main = await mainCommit(repo.main)
    if (await isAncestor(repo.main, main, worktree.head)) {
      if (entry.base !== main) write(replace(ledger, { ...entry, base: main }))
      return ok(`ok: ${name} already has every commit on main ${short(main)}`)
    }
    const ran = await gitRun(entry.path, ['rebase', '--no-autostash', '--no-autosquash', '--no-update-refs', main])
    if (ran.code !== 0) {
      const conflicts = (await git(entry.path, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter((file) => file !== '')
      if (!conflicts.length) throw new Error(`git rebase in ${entry.path} exited ${ran.code}: ${ran.stderr.trim()}`)
      return failed(`sync ${name} stopped on a conflict in ${conflicts.join(', ')}, and the worktree is as git left it, part way through the rebase`, `next: resolve them, git add them and git rebase --continue in ${entry.path}, or git rebase --abort, then sync again`)
    }
    const head = Sha.parse((await git(entry.path, ['rev-parse', 'HEAD'])).trim())
    write(replace(ledger, { ...entry, base: main }))
    return ok(`ok: rebased ${name} onto main ${short(main)}, with ${plural(await aheadOf(repo.main, head, main), 'commit')} on top`)
  })
}
