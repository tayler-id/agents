// Git for agents-git. Every call passes an argument list, never a shell string, and
// has a time limit. Hooks and fsmonitor are off, so no code from the repo runs, and
// git never stops to ask for a password. Optional locks are off, so reading a
// worktree an agent is using never takes its index lock.

import { execFile } from 'node:child_process'
import { z } from 'zod'

// A git call that runs this long is stuck on a lock or a network. Removing a worktree
// also deletes its node_modules, about 14,000 files for this repo, which takes seconds.
export const GIT_TIMEOUT_MS = 2 * 60_000
// git status prints a line for every untracked file, and a worktree can hold many.
const OUTPUT_LIMIT = 64 * 1024 * 1024
const PINNED = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false']
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
// update-ref reads an all-zero old value as "this ref must not exist yet".
const NO_COMMIT = '0'.repeat(40)

export const Sha = z.string().regex(/^[0-9a-f]{40}$/, 'a full commit id').brand<'Sha'>()
export type Sha = z.infer<typeof Sha>
export const short = (sha: Sha) => sha.slice(0, 7)

export type Ran = { code: number, stdout: string, stderr: string }

// Resolves with the exit code, so a caller can read a 1 as an answer. A command that
// could not start, ran past its limit or printed too much rejects.
export function run(file: string, args: readonly string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<Ran> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, env, timeout: timeoutMs, maxBuffer: OUTPUT_LIMIT, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) resolve({ code: 0, stdout, stderr })
      else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr })
      else reject(new Error(`${[file, ...args].join(' ')} in ${cwd} ${error.killed ? `was stopped after ${timeoutMs} ms` : `failed: ${error.message}`}`))
    })
  })
}

export function gitRun(cwd: string, args: readonly string[]): Promise<Ran> {
  return run('git', [...PINNED, ...args], cwd, GIT_TIMEOUT_MS, GIT_ENV)
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const ran = await gitRun(cwd, args)
  if (ran.code !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} exited ${ran.code}: ${ran.stderr.trim()}`)
  return ran.stdout
}

export type GitWorktree = { path: string, head: Sha | null, branch: string | null, locked: string | null, prunable: boolean, bare: boolean }

// One record of `git worktree list --porcelain -z`. Fields git adds later are dropped.
const Porcelain = z.object({
  worktree: z.string().startsWith('/'),
  HEAD: Sha.optional(),
  branch: z.string().startsWith('refs/heads/').transform((ref) => ref.slice('refs/heads/'.length)).optional(),
  bare: z.literal('').optional(),
  detached: z.literal('').optional(),
  locked: z.string().optional(),
  prunable: z.string().optional(),
})

// Every worktree git knows, the main checkout first, as git promises.
export async function worktreeList(cwd: string): Promise<GitWorktree[]> {
  const records: Record<string, string>[] = []
  let record: Record<string, string> = {}
  for (const field of (await git(cwd, ['worktree', 'list', '--porcelain', '-z'])).split('\0')) {
    if (field === '') {
      if (Object.keys(record).length) records.push(record)
      record = {}
      continue
    }
    const space = field.indexOf(' ')
    if (space === -1) record[field] = ''
    else record[field.slice(0, space)] = field.slice(space + 1)
  }
  return records.map((raw) => {
    const parsed = Porcelain.parse(raw)
    return { path: parsed.worktree, head: parsed.HEAD ?? null, branch: parsed.branch ?? null, locked: parsed.locked ?? null, prunable: parsed.prunable !== undefined, bare: parsed.bare !== undefined }
  })
}

const StatusEntry = z.string().regex(/^[12u?] /, 'a git status entry')

// Changed, staged, conflicted and untracked files. Untracked files count whatever the
// repo's config says, and ignored ones, like node_modules, never do.
export async function uncommitted(path: string): Promise<number> {
  const fields = (await git(path, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])).split('\0')
  let count = 0
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (!field) continue
    StatusEntry.parse(field)
    count++
    // A rename or a copy is followed by a field holding the old path.
    if (field.startsWith('2 ')) i++
  }
  return count
}

export async function commitOf(cwd: string, ref: string): Promise<Sha | null> {
  const ran = await gitRun(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (ran.code === 1) return null
  if (ran.code !== 0) throw new Error(`git rev-parse ${ref} in ${cwd} exited ${ran.code}: ${ran.stderr.trim()}`)
  return Sha.parse(ran.stdout.trim())
}

const Count = z.string().regex(/^[0-9]+$/, 'a count').transform(Number)

// Commits reachable from commit that main doesn't have. Zero means main has all of it.
export async function aheadOf(cwd: string, commit: Sha, main: Sha): Promise<number> {
  return Count.parse((await git(cwd, ['rev-list', '--count', `${main}..${commit}`])).trim())
}

export async function isAncestor(cwd: string, commit: Sha, of: string): Promise<boolean> {
  const ran = await gitRun(cwd, ['merge-base', '--is-ancestor', commit, of])
  if (ran.code === 0) return true
  if (ran.code === 1) return false
  throw new Error(`git merge-base --is-ancestor ${commit} ${of} in ${cwd} exited ${ran.code}: ${ran.stderr.trim()}`)
}

export async function mergeBase(cwd: string, a: Sha, b: Sha): Promise<Sha | null> {
  const ran = await gitRun(cwd, ['merge-base', a, b])
  if (ran.code === 1) return null
  if (ran.code !== 0) throw new Error(`git merge-base ${a} ${b} in ${cwd} exited ${ran.code}: ${ran.stderr.trim()}`)
  return Sha.parse(ran.stdout.trim())
}

// Points ref at commit only if it still holds expected, or doesn't exist when
// expected is null. Git checks and writes under its own lock on the ref.
export async function moveRef(cwd: string, ref: string, commit: Sha, expected: Sha | null): Promise<void> {
  await git(cwd, ['update-ref', ref, commit, expected ?? NO_COMMIT])
}

// Deletes ref only if it still holds expected.
export async function deleteRef(cwd: string, ref: string, expected: Sha): Promise<void> {
  await git(cwd, ['update-ref', '-d', ref, expected])
}
