// What every agents-git command shares: how it reports, how it finds the repo and
// its main branch, the refs it keeps, and the tracked worktree a name stands for.

import { existsSync } from 'node:fs'
import { POLICY, type Policy } from '../../shared/policy.ts'
import { commitOf, git, gitRun, worktreeList, type GitWorktree, type Sha } from './git.ts'
import { MAIN_BRANCH, type Entry, type Ledger, type LiveEntry, type Name } from './ledger.ts'

export type Report = { code: 0 | 1 | 2 | 3, lines: string[] }
export const ok = (...lines: string[]): Report => ({ code: 0, lines })
export const failed = (what: string, ...lines: string[]): Report => ({ code: 1, lines: [`failed: ${what}`, ...lines] })
export const refused = (reason: string, next?: string): Report => ({ code: 3, lines: [`refused: ${reason}. Nothing changed.`, ...(next === undefined ? [] : [`next: ${next}`])] })
export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
// A word as a shell reads it back, in quotes only when it needs them.
export const quote = (word: string) => (/^[\w./@%+=:,-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)
// A moment in a form a ref or a folder name allows, such as 20261014T143105123Z.
export const stampOf = (at: Date) => at.toISOString().replace(/[-:.]/g, '')
export const isReport = <T extends object>(value: T | Report): value is Report => 'code' in value && 'lines' in value

export const MAIN = `refs/heads/${MAIN_BRANCH}`
// Worktrees live beside the main checkout, never inside it, in a folder named after
// it: ~/Projects/agents gets ~/Projects/agents-worktrees.
export const worktreeRoot = (main: string) => `${main}-worktrees`
// Every ref agents-git keeps for a worktree sits under this prefix.
export const refsOf = (name: Name) => `refs/agents-git/${name}`
// Where done keeps a worktree's last commit. Removing a worktree deletes its HEAD, the
// only thing that keeps a commit made on a detached HEAD, and gc later deletes the commit.
export const doneRef = (name: Name) => `${refsOf(name)}/done`
// Each save is a ref named for when it was made, so the newest sorts last.
export const savesOf = (name: Name) => `${refsOf(name)}/save-`

export type Repo = { main: string, others: GitWorktree[] }

export async function openRepo(cwd: string): Promise<Repo> {
  const [main, ...others] = await worktreeList(cwd)
  if (!main || main.bare) throw new Error(`agents-git needs a repo with a main checkout, and ${cwd} is in a bare one`)
  return { main: main.path, others }
}

export async function mainCommit(repo: string): Promise<Sha> {
  const sha = await commitOf(repo, MAIN)
  if (!sha) throw new Error(`${repo} has no local main branch`)
  return sha
}

export async function refsUnder(repo: string, prefix: string): Promise<string[]> {
  return (await git(repo, ['for-each-ref', '--format=%(refname)', prefix])).split('\n').filter((ref) => ref !== '')
}

export const isLive = (entry: Entry): entry is LiveEntry => entry.state !== 'done'

export function replace(ledger: Ledger, entry: Entry): Ledger {
  return { ...ledger, worktrees: ledger.worktrees.map((e) => (e.repo === entry.repo && e.name === entry.name ? entry : e)) }
}

// The fields every state shares.
export function tracked(entry: LiveEntry) {
  if (entry.state === 'active') {
    const { state, ...rest } = entry
    return rest
  }
  const { state, pid, ...rest } = entry
  return rest
}

// The tracked worktree a name stands for in this repo, once start has finished
// with it, or why there is none.
export function findReady(ledger: Ledger, repo: Repo, name: Name): LiveEntry | Report {
  const entry = ledger.worktrees.find((e) => e.repo === repo.main && e.name === name)
  if (!entry) return refused(`the ledger has no worktree named ${name} in ${repo.main}`)
  if (entry.state === 'done') return refused(`${name} is done`)
  if (entry.state === 'starting') return refused(`start has not finished ${name}`, `run done ${name} --yes, then start it again`)
  return entry
}

// Git's record of an entry's worktree, when its folder is there and git can reach it.
export function reachable(repo: Repo, entry: LiveEntry): (GitWorktree & { head: Sha }) | Report {
  const found = repo.others.find((w) => w.path === entry.path)
  if (!found?.head || found.prunable || !existsSync(entry.path)) return refused(`${entry.name} has no worktree at ${entry.path}`)
  return { ...found, head: found.head }
}

// The same, and on the branch the ledger says.
export function onBranch(repo: Repo, entry: LiveEntry): (GitWorktree & { head: Sha }) | Report {
  const found = reachable(repo, entry)
  if (isReport(found)) return found
  if (found.branch !== entry.branch) return refused(`${entry.name} is on ${found.branch ?? 'a detached HEAD'}, and the ledger says ${entry.branch ?? 'a detached HEAD'}`)
  return found
}

// The repo's policy as main has it, never as a branch has it, since an agent could
// edit the branch's copy.
export const POLICY_FILE = 'ops/policies/agents.json'
export async function policyAt(repo: string, commit: Sha): Promise<Policy> {
  const ran = await gitRun(repo, ['show', `${commit}:${POLICY_FILE}`])
  if (ran.code !== 0) throw new Error(`main at ${commit} has no ${POLICY_FILE}, which says what every change must pass`)
  return POLICY.parse(JSON.parse(ran.stdout))
}
