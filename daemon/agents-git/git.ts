// Git for agents-git. Every call passes an argument list, never a shell string, and
// has a time limit. Hooks and fsmonitor are off, so no code from the repo runs, and
// git never stops to ask for a password. Optional locks are off, so reading a
// worktree an agent is using never takes its index lock.

import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
// could not start, ran past its limit or printed too much rejects. Its stdin gets
// the input, or ends at once, so nothing waits on a terminal.
export function run(file: string, args: readonly string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv, input = ''): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { cwd, env, timeout: timeoutMs, maxBuffer: OUTPUT_LIMIT, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) resolve({ code: 0, stdout, stderr })
      else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr })
      else reject(new Error(`${[file, ...args].join(' ')} in ${cwd} ${error.killed ? `was stopped after ${timeoutMs} ms` : `failed: ${error.message}`}`))
    })
    child.stdin?.end(input)
  })
}

// Extra environment for one call, and what to write to its stdin.
export type GitCall = { env?: Record<string, string>, input?: string }

export function gitRun(cwd: string, args: readonly string[], call: GitCall = {}): Promise<Ran> {
  return run('git', [...PINNED, ...args], cwd, GIT_TIMEOUT_MS, { ...GIT_ENV, ...call.env }, call.input)
}

export async function git(cwd: string, args: readonly string[], call: GitCall = {}): Promise<string> {
  const ran = await gitRun(cwd, args, call)
  if (ran.code !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} exited ${ran.code}: ${ran.stderr.trim()}`)
  return ran.stdout
}

export const Tree = z.string().regex(/^[0-9a-f]{40}$/, 'a full tree id').brand<'Tree'>()
export type Tree = z.infer<typeof Tree>
export const treeOf = async (cwd: string, commit: Sha) => Tree.parse((await git(cwd, ['rev-parse', `${commit}^{tree}`])).trim())

export const Blob = z.string().regex(/^[0-9a-f]{40}$/, 'a full blob id').brand<'Blob'>()
export type Blob = z.infer<typeof Blob>

// The file a commit holds at path, as its blob, or null when the commit has no file there. A
// folder or a submodule at the path is not a file. git reads everything after the colon as the
// path, so the type is asked of cat-file and not added to the name.
export async function blobAt(cwd: string, commit: Sha, path: string): Promise<Blob | null> {
  const found = (await git(cwd, ['cat-file', '--batch-check'], { input: `${commit}:${path}\n` })).trim()
  const blob = /^([0-9a-f]{40}) blob \d+$/.exec(found)
  return blob ? Blob.parse(blob[1]) : null
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

// The ignored files and folders git lists in a worktree, a folder whole when all of it is
// ignored, with a slash on the end of a folder's name. Removing a worktree deletes them
// without a word, since git counts only changed and untracked files as work.
export async function ignoredPaths(path: string): Promise<string[]> {
  const fields = (await git(path, ['status', '--porcelain=v2', '-z', '--ignored=matching', '--untracked-files=normal'])).split('\0')
  const out: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? ''
    // A rename or a copy is followed by a field holding the old path.
    if (field.startsWith('2 ')) i++
    else if (field.startsWith('! ')) out.push(field.slice('! '.length))
  }
  return out
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

// Moves refs that belong together, each by the rule moveRef states. Git moves all of
// them or none, so a failure on one never leaves the others moved.
export async function moveRefs(cwd: string, moves: readonly { ref: string, commit: Sha, expected: Sha | null }[]): Promise<void> {
  await git(cwd, ['update-ref', '--stdin'], { input: moves.map((move) => `update ${move.ref} ${move.commit} ${move.expected ?? NO_COMMIT}\n`).join('') })
}

// Deletes ref only if it still holds expected.
export async function deleteRef(cwd: string, ref: string, expected: Sha): Promise<void> {
  await git(cwd, ['update-ref', '-d', ref, expected])
}

// The tree the worktree's files would make if all of them were committed now:
// changes, staged or not, and untracked files, but no ignored ones. It is built in
// a copy of the index, so the worktree's own index and files stay as they are.
export async function snapshotTree(path: string): Promise<Tree> {
  const index = (await git(path, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim()
  const dir = mkdtempSync(join(tmpdir(), 'agents-git-index-'))
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  try {
    if (existsSync(index)) copyFileSync(index, env.GIT_INDEX_FILE)
    else await git(path, ['read-tree', 'HEAD'], { env })
    await git(path, ['add', '--all'], { env })
    return Tree.parse((await git(path, ['write-tree'], { env })).trim())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const Latest = z.string().regex(/^\S+ [0-9a-f]{40} [0-9a-f]{40}$/, 'a ref, its commit and its tree').transform((line) => {
  const [ref = '', commit, tree] = line.split(' ')
  return { ref, commit: Sha.parse(commit), tree: Tree.parse(tree) }
})

// The ref under prefix whose name sorts last, with its commit and tree, or null.
export async function latestRef(cwd: string, prefix: string): Promise<{ ref: string, commit: Sha, tree: Tree } | null> {
  const line = (await git(cwd, ['for-each-ref', '--sort=-refname', '--count=1', '--format=%(refname) %(objectname) %(tree)', `${prefix}*`])).trim()
  return line ? Latest.parse(line) : null
}
