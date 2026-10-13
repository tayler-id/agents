// What differs from the base branch in each repo of a workspace, for a task's
// Changes list. The working tree is staged into a temporary index, so new,
// changed and deleted files all show without touching the agent's own index.
// Content comes from git's blobs, so a symlink is never followed out of the repo.

import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { RepoId } from '../shared/ids.ts'
import { messageOf } from '../shared/errors.ts'
import { CHANGE_LIMITS, type ChangedFile, type ChangeStatus, type RepoChanges } from '../shared/work.ts'

const run = promisify(execFile)
// Room for the raw diff of CHANGE_LIMITS.files files, each line under 200 characters.
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024
// A submodule or nested repo, which git records as a commit, not a file.
const GITLINK = '160000'
// The daemon clones every task repo through the API's git proxy, so the origin names the repo.
const ORIGIN = /\/v1\/git\/([0-9a-f-]{36})\.git$/
const STATUS: Partial<Record<string, ChangeStatus>> = { A: 'added', D: 'deleted', M: 'modified', T: 'modified' }

type Entry = { path: string; status: ChangeStatus; oldBlob: string; newBlob: string; newMode: string }
type Counts = { additions: number; deletions: number; binary: boolean }

// The key of a file in the map of what was last sent.
export const changeKey = (repoId: string, path: string) => `${repoId}\0${path}`

const exitedWith = (error: unknown, code: number) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code

// git for commands that never leave the machine. No token, and no fsmonitor,
// which a repo's config could set to a program for git to run.
async function git(cwd: string, args: string[], index?: string): Promise<string> {
  const env = index ? { ...process.env, GIT_INDEX_FILE: index } : process.env
  const { stdout } = await run('git', ['-c', 'core.fsmonitor=false', '--literal-pathspecs', ...args], { cwd, env, maxBuffer: GIT_OUTPUT_LIMIT })
  return stdout
}

// How many NUL-ended paths a git command lists, counting no further than
// limit + 1, so a repo with a huge tree is never read in full.
function countUpTo(cwd: string, args: string[], limit: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let count = 0
    let stopped = false
    let errors = ''
    child.stdout.on('data', (chunk: Buffer) => {
      for (const byte of chunk) if (byte === 0) count++
      if (count > limit && !stopped) {
        stopped = true
        child.kill('SIGTERM')
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString('utf8')).slice(-CHANGE_LIMITS.reason) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (stopped) resolve(limit + 1)
      else if (code === 0) resolve(count)
      else reject(new Error(errors.trim() || `git ${args.join(' ')} exited with ${String(code)}`))
    })
  })
}

// What a person reads of a git failure: its own lines, without the command execFile puts first.
const reasonOf = (error: unknown) =>
  messageOf(error).replace(/^Command failed: .*\n/, '').trim().slice(0, CHANGE_LIMITS.reason) || 'git gave no reason'

// Where the task branch left its base: the branch it tracks, or the remote's default.
async function baseCommit(path: string): Promise<string> {
  for (const ref of ['@{upstream}', 'refs/remotes/origin/HEAD']) {
    const tip = await git(path, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch((error: unknown) => {
      // --verify --quiet exits 1, saying nothing, when the ref does not exist.
      if (exitedWith(error, 1)) return ''
      throw error
    })
    if (tip.trim()) return (await git(path, ['merge-base', 'HEAD', tip.trim()])).trim()
  }
  throw new Error(`${path} tracks no branch and its origin has no default branch to compare with`)
}

function parseRaw(out: string): Entry[] {
  const entries: Entry[] = []
  for (const match of out.matchAll(/:\d{6} (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])\d*\0([^\0]+)\0/g)) {
    const [, newMode, oldBlob, newBlob, letter, path] = match
    const status = letter === undefined ? undefined : STATUS[letter]
    if (!newMode || !oldBlob || !newBlob || !path || !status) throw new Error(`git diff --raw gave an entry this cannot read: ${match[0]}`)
    entries.push({ path, status, oldBlob, newBlob, newMode })
  }
  if (out.split('\0').length - 1 !== entries.length * 2) throw new Error('git diff --raw gave entries this cannot read')
  return entries
}

function parseNumstat(out: string): Map<string, Counts> {
  const counts = new Map<string, Counts>()
  for (const match of out.matchAll(/(\d+|-)\t(\d+|-)\t([^\0]+)\0/g)) {
    const [, added, deleted, path] = match
    if (!added || !deleted || !path) throw new Error(`git diff --numstat gave a line this cannot read: ${match[0]}`)
    // git counts no lines in a binary file, and says so with a dash.
    counts.set(path, added === '-' ? { additions: 0, deletions: 0, binary: true } : { additions: Number(added), deletions: Number(deleted), binary: false })
  }
  if (out.split('\0').length - 1 !== counts.size) throw new Error('git diff --numstat gave lines this cannot read')
  return counts
}

// One repo's changed files. A file whose hash matches what was last sent goes as
// facts alone, as does one past the post's budget, which the API then asks for.
async function repoChanges(path: string, repoId: RepoId, sent: ReadonlyMap<string, string>, budget: { left: number }): Promise<RepoChanges> {
  const base = await baseCommit(path)
  // Counting writes nothing, unlike staging, so a repo past the limit is never staged.
  const tracked = await countUpTo(path, ['diff', '--name-only', '--no-renames', '-z', base], CHANGE_LIMITS.files)
  const untracked = tracked > CHANGE_LIMITS.files ? 0 : await countUpTo(path, ['ls-files', '--others', '--exclude-standard', '-z'], CHANGE_LIMITS.files - tracked)
  if (tracked + untracked > CHANGE_LIMITS.files) return { state: 'too_many', repoId }
  const index = join(tmpdir(), `agents-index-${randomUUID()}`)
  try {
    const own = (await git(path, ['rev-parse', '--git-path', 'index'])).trim()
    const ownPath = isAbsolute(own) ? own : join(path, own)
    if (existsSync(ownPath)) copyFileSync(ownPath, index)
    await git(path, ['add', '--all'], index)
    const diff = ['diff', '--cached', '--no-renames', '--no-ext-diff', '--no-textconv']
    const entries = parseRaw(await git(path, [...diff, '--raw', '-z', '--no-abbrev', base], index))
    const counts = parseNumstat(await git(path, [...diff, '--numstat', '-z', base], index))
    const files: ChangedFile[] = []
    for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path))) {
      const count = counts.get(entry.path)
      if (!count) throw new Error(`git listed ${entry.path} as changed but counted no lines for it`)
      const facts = { path: entry.path, status: entry.status, additions: count.additions, deletions: count.deletions, hash: `${entry.oldBlob}:${entry.newBlob}:${entry.status}` }
      if (sent.get(changeKey(repoId, entry.path)) === facts.hash) {
        files.push({ ...facts, sent: 'facts' })
        continue
      }
      if (count.binary || entry.newMode === GITLINK) {
        files.push({ ...facts, sent: 'binary' })
        continue
      }
      const size = entry.status === 'deleted' ? 0 : Number(await git(path, ['cat-file', '-s', entry.newBlob]))
      const patch = size > CHANGE_LIMITS.text ? '' : await git(path, [...diff, '--no-color', base, '--', entry.path], index)
      if (size > CHANGE_LIMITS.text || patch.length > CHANGE_LIMITS.text) {
        files.push({ ...facts, sent: 'too_large' })
        continue
      }
      const content = entry.status === 'deleted' ? null : await git(path, ['cat-file', 'blob', entry.newBlob])
      // git calls a file text when its first 8,000 bytes hold no NUL, and Postgres stores no NUL in text.
      if (patch.includes('\0') || content?.includes('\0')) {
        files.push({ ...facts, sent: 'binary' })
        continue
      }
      const cost = patch.length + (content === null ? 0 : content.length)
      if (cost > budget.left) {
        files.push({ ...facts, sent: 'facts' })
        continue
      }
      budget.left -= cost
      files.push({ ...facts, sent: 'text', content, diff: patch })
    }
    return { state: 'listed', repoId, baseCommit: base, files }
  } finally {
    rmSync(index, { force: true })
  }
}

// Every repo the daemon cloned into the workspace, with what differs in it.
export async function workspaceChanges(root: string, sent: ReadonlyMap<string, string>): Promise<RepoChanges[]> {
  const budget = { left: CHANGE_LIMITS.post }
  const repos: RepoChanges[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (!entry.isDirectory() || !existsSync(join(path, '.git'))) continue
    const origin = await git(path, ['remote', 'get-url', 'origin']).catch((error: unknown) => {
      // get-url exits 2 when the repo has no origin.
      if (exitedWith(error, 2)) return ''
      throw error
    })
    const repoId = RepoId.safeParse(ORIGIN.exec(origin.trim())?.[1])
    // A repo the agent cloned or made itself is not one of the task's.
    if (!repoId.success) continue
    // One repo git cannot read keeps its last list, and the others are still read.
    repos.push(await repoChanges(path, repoId.data, sent, budget).catch((error: unknown): RepoChanges => ({ state: 'unreadable', repoId: repoId.data, reason: reasonOf(error) })))
  }
  return repos
}
