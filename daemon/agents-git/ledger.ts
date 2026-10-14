// The ledger: every worktree agents-git tracks, in one JSON file for the whole Mac.
// Each read and write holds an exclusive lock and parses the file, and each write
// replaces the whole file through a rename, so no reader ever sees half of one.

import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { messageOf } from '../../shared/errors.ts'
import { Blob, Sha } from './git.ts'

// AGENTS_GIT_LEDGER moves the ledger. Only the step 22 check sets it, so the check
// never reads or writes the real one. It is the one seam, and it sits at a real
// boundary: the file the ledger lives in.
export function ledgerFile(env: NodeJS.ProcessEnv): string {
  const moved = z.string().startsWith('/', 'AGENTS_GIT_LEDGER must be an absolute path').optional().parse(env.AGENTS_GIT_LEDGER)
  return moved ?? join(homedir(), '.agents-app', 'worktrees.json')
}

// The folder the ledger is in, ~/.agents-app. The checks' run lock and agents-git's
// logs live there too, so the check's AGENTS_GIT_LEDGER moves them with the ledger.
export const appHome = (ledger: string) => dirname(ledger)

// The branch every landing goes to, which GitHub also calls its default. It is named
// here once, and every command that pushes, merges or checks out main reads it.
export const MAIN_BRANCH = 'main'
// submit pushes a worktree's name to GitHub as a branch of that name, so a name that
// is the main branch would push to GitHub's main, and git reads HEAD as the checked-out commit.
const RESERVED = [MAIN_BRANCH, 'HEAD']

// A name is a branch, a folder and a ref, so it keeps to characters all three accept.
export const Name = z.string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'a name is 1 to 63 lowercase letters, digits and dashes, starting with a letter or digit')
  .refine((name) => !RESERVED.includes(name), `a name can't be ${RESERVED.join(' or ')}, since submit pushes it to GitHub as a branch of that name`)
  .brand<'WorktreeName'>()
export type Name = z.infer<typeof Name>
const Time = z.iso.datetime()
const Path = z.string().startsWith('/')

// A protected path Tayler approved changing, with the content he approved: the file's blob
// at the branch tip when the approval was given, or null when it approved deleting the file.
// It counts only while the tip still holds that blob, so an edit made after it needs a new one.
export const Approval = z.strictObject({ path: z.string().min(1), blob: Blob.nullable() })
export type Approval = z.infer<typeof Approval>

// One run of a check on one commit. The step is a step's id, such as 18d, or
// "suite" for land's full suite, or "main: <file>" for a changed check land ran
// on main's code, where it must fail.
export const CheckRun = z.strictObject({
  step: z.string().min(1),
  head: Sha,
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  result: z.enum(['pass', 'fail', 'timeout']),
  at: Time,
  seconds: z.number().nonnegative(),
  log: Path,
})
export type CheckRun = z.infer<typeof CheckRun>

const Tracked = {
  name: Name,
  // The repo's main checkout. One ledger serves every repo on the Mac.
  repo: Path,
  path: Path,
  // Null for a worktree adopted on a detached HEAD.
  branch: z.string().min(1).nullable(),
  // The main commit it started from. For an adopted worktree, its merge base with main when adopted.
  base: Sha,
  origin: z.enum(['started', 'adopted']),
  // For an adopted worktree, when it was adopted.
  createdAt: Time,
  note: z.string().min(1).nullable(),
  // Every check and suite run on its commits, oldest first.
  checks: z.array(CheckRun).default([]),
  // What submit records and land reuses: the change's message, the reviews noted,
  // and the regression it carries, which goes first wherever the message goes.
  message: z.string().min(1).nullable().default(null),
  reviews: z.array(z.string().min(1)).default([]),
  regression: z.string().min(1).nullable().default(null),
  // Protected paths Tayler approved changing, as named with --approve, each with the content approved.
  approved: z.array(Approval).default([]),
  // The branch tip submit scanned and pushed, its copy on GitHub, and the pull request.
  submitted: z.strictObject({ head: Sha, copy: Sha, pr: z.string().min(1), at: Time }).nullable().default(null),
  // The merge commit land put on main, and its copy on GitHub once mirrored.
  landed: z.strictObject({ merge: Sha, copy: Sha.nullable(), at: Time }).nullable().default(null),
}

// What a worktree has before any of save, check, submit or land has run.
export const UNTOUCHED = { checks: [], message: null, reviews: [], regression: null, approved: [], submitted: null, landed: null }

export const Entry = z.discriminatedUnion('state', [
  // start writes this before npm ci and moves it on after. The pid is start's own, so
  // done can tell an install that is still running from one that was stopped.
  z.strictObject({ ...Tracked, state: z.literal('starting'), pid: z.number().int().positive() }),
  z.strictObject({ ...Tracked, state: z.literal('active') }),
  z.strictObject({ ...Tracked, state: z.literal('done'), doneAt: Time, finalHead: Sha, branchDeleted: z.boolean() }),
])
export type Entry = z.infer<typeof Entry>
export type LiveEntry = Exclude<Entry, { state: 'done' }>

const Ledger = z.strictObject({ version: z.literal(1), worktrees: z.array(Entry) })
export type Ledger = z.infer<typeof Ledger>

// A command holds the lock for a few git calls. The longest is removing a worktree
// with its node_modules, which takes seconds. Five minutes means the holder is stuck.
const LOCK_WAIT_MS = 5 * 60_000
const LOCK_POLL_MS = 100
const Holder = z.strictObject({ pid: z.number().int().positive(), command: z.string(), since: Time })
type Holder = z.infer<typeof Holder>

export async function withLedger<T>(file: string, command: string, work: (ledger: Ledger, write: (next: Ledger) => void) => Promise<T>): Promise<T> {
  const release = await lock(`${file}.lock`, command)
  try {
    return await work(read(file), (next) => { write(file, next) })
  } finally {
    release()
  }
}

function read(file: string): Ledger {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    // No ledger yet means nothing is tracked yet.
    if (errorCode(error) === 'ENOENT') return { version: 1, worktrees: [] }
    throw error
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not JSON: ${messageOf(error)}`)
  }
  const parsed = Ledger.safeParse(raw)
  if (!parsed.success) throw new Error(`${file} is not a ledger agents-git can read:\n${z.prettifyError(parsed.error)}`)
  return parsed.data
}

function write(file: string, ledger: Ledger): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${String(process.pid)}-${randomBytes(4).toString('hex')}.tmp`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(Ledger.parse(ledger), null, 2)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
}

async function lock(path: string, command: string): Promise<() => void> {
  mkdirSync(dirname(path), { recursive: true })
  const mine: Holder = { pid: process.pid, command, since: new Date().toISOString() }
  const deadline = Date.now() + LOCK_WAIT_MS
  let told = false
  for (;;) {
    if (create(path, mine)) return () => { release(path, mine) }
    const holder = readHolder(path)
    if (holder && !alive(holder.pid) && clearStale(path, holder)) continue
    if (Date.now() > deadline) throw new Error(`${path} is still held${holder ? ` by pid ${String(holder.pid)} (${holder.command}) since ${holder.since}` : ''}. Nothing changed.`)
    if (holder && !told) {
      console.error(`waiting for ${path}, held by pid ${String(holder.pid)} (${holder.command})`)
      told = true
    }
    await sleep(LOCK_POLL_MS)
  }
}

// The holder goes into a file of its own first, which is then linked into place. A
// link fails when the lock exists, so a lock never exists without its holder in it.
function create(path: string, holder: Holder): boolean {
  const temp = `${path}.${String(process.pid)}-${randomBytes(4).toString('hex')}`
  writeFileSync(temp, JSON.stringify(holder), { mode: 0o600, flag: 'wx' })
  try {
    linkSync(temp, path)
    return true
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    throw error
  } finally {
    unlinkSync(temp)
  }
}

function readHolder(path: string): Holder | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    // Released between our attempt and this read.
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
  try {
    return Holder.parse(JSON.parse(text))
  } catch {
    throw new Error(`${path} holds something agents-git did not write. Nothing changed.`)
  }
}

// The holder's process is gone, so it can never release the lock. Clearing takes a
// second lock, so two waiters can't both clear it and then both take the first.
// Returns false while another waiter is clearing.
function clearStale(path: string, stale: Holder): boolean {
  const clearing = `${path}.clearing`
  if (!create(clearing, { pid: process.pid, command: 'clearing a stale lock', since: new Date().toISOString() })) return false
  try {
    const now = readHolder(path)
    if (now?.pid === stale.pid && now.since === stale.since) unlinkSync(path)
    return true
  } finally {
    unlinkSync(clearing)
  }
}

function release(path: string, mine: Holder): void {
  const holder = readHolder(path)
  if (holder?.pid !== mine.pid || holder.since !== mine.since) throw new Error(`${path} was taken from this command while it held it`)
  unlinkSync(path)
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false
    // The process exists but belongs to another user.
    if (errorCode(error) === 'EPERM') return true
    throw error
  }
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}
