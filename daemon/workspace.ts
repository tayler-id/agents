// Task workspaces on this machine. Each is a folder under $AGENTS_HOME/workspaces with
// a clone of each repo on the task's branch, plus a `task` folder for documents,
// which sits beside the clones so it never enters git. Clones and pushes go
// through the API's git proxy with this machine's token.

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { workspaceChanges } from './changes.ts'
import type { ExecPayload, ExecResult, PushPayload, PushResult, SetupWorkspacePayload } from '../shared/types.ts'
import type { RepoChanges } from '../shared/work.ts'
import { MAX_IMAGE_BYTES, MAX_TEXT_BYTES, sniffImage, type ImageMediaType } from '../shared/documents.ts'

// A file in a task's folder, as the daemon sends it to become a document version.
export type TaskFile = { path: string; hash: string } & (
  | { kind: 'text'; content: string }
  | { kind: 'image'; mediaType: ImageMediaType; bytes: Buffer }
)

const run = promisify(execFile)
const OUTPUT_LIMIT = 20_000
// A local ref in each checkout holding the commit this workspace last pushed a task
// branch at. It never leaves the machine.
const pushedRef = (branch: string) => `refs/agents/pushed/${branch}`
// What a push says when the forge's branch holds commits this workspace never had.
const FORGE_AHEAD = 'someone added commits on the forge, ask the agent to merge them'
// The files a repo keeps its rules for agents in, the first found winning.
const RULES_FILES = ['CLAUDE.md', 'AGENTS.md']

export type Workspaces = ReturnType<typeof workspaces>

// The token reaches git through its environment, never its arguments, because a
// failed command's message repeats its arguments and the record keeps that message.
const gitEnvOf = (token: string) => ({ ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` })

// git through the API's proxy, as this machine.
export function gitAs(token: string) {
  const env = gitEnvOf(token)
  return async (cwd: string, ...args: string[]) =>
    (await run('git', args, { cwd, env, maxBuffer: 16 * 1024 * 1024 })).stdout.trim()
}

// Runs a program with its arguments in a folder, keeps the end of its output,
// and kills it after timeoutSec.
export function runProgram(cwd: string, argv: readonly string[], timeoutSec: number) {
  return new Promise<ExecResult>((resolve) => {
    const [program = '', ...args] = argv
    const child = spawn(program, args, { cwd, env: { ...process.env, CI: '1' } })
    let output = ''
    const keep = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-OUTPUT_LIMIT) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutSec * 1000)
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, output, timedOut }) })
    child.on('error', (error) => { clearTimeout(timer); resolve({ exitCode: null, output: error.message, timedOut }) })
  })
}

export function workspaces(home: string, api: string, token: string) {
  const dir = (workspaceId: string) => join(home, 'workspaces', workspaceId)
  const gitEnv = gitEnvOf(token)
  const git = gitAs(token)
  // A git command that answers yes or no with its exit code, 0 or 1.
  const gitSays = (cwd: string, ...args: string[]) => run('git', args, { cwd, env: gitEnv }).then(() => true, (error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) return false
    throw error
  })

  // The commit the forge's copy of a task branch must still be at for the push to
  // replace it, or '' when the forge has no such branch. The tip is fetched into
  // origin/<branch>, so the agent can merge it. The push may replace it when this
  // workspace pushed it last, so the agent may rewrite its own branch, or when HEAD
  // already holds it. Anything else is someone else's work, and stays.
  async function forgeTip(path: string, name: string, branch: string): Promise<string> {
    if (!(await git(path, 'ls-remote', 'origin', `refs/heads/${branch}`))) return ''
    await git(path, 'fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`)
    const tip = await git(path, 'rev-parse', `refs/remotes/origin/${branch}^{commit}`)
    const last = await git(path, 'for-each-ref', '--format=%(objectname)', pushedRef(branch))
    if (tip === last || await gitSays(path, 'merge-base', '--is-ancestor', tip, 'HEAD')) return tip
    throw new Error(`In ${name}, ${FORGE_AHEAD}.`)
  }
  const sh = (cwd: string, command: string, timeoutSec: number) => runProgram(cwd, ['sh', '-c', command], timeoutSec)

  // Clones each repo and checks out the task branch. Running it again reuses
  // what is already there, so a retried command does no harm.
  async function cloneAll({ workspaceId, repos }: SetupWorkspacePayload) {
    const root = dir(workspaceId)
    mkdirSync(join(root, 'task'), { recursive: true })
    const worktrees = []
    for (const repo of repos) {
      const path = join(root, repo.name)
      if (!existsSync(join(path, '.git'))) {
        await git(root, 'clone', '--quiet', '--branch', repo.base, `${api}/v1/git/${repo.repoId}.git`, repo.name)
      }
      // Dependencies are installed or linked into a clone and never belong in
      // its commits, even as a link a repo's own ignore rules miss. This
      // exclude is the clone's own and is never committed.
      const exclude = join(path, '.git', 'info', 'exclude')
      const excluded = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
      if (!excluded.split('\n').includes('/node_modules')) {
        mkdirSync(join(path, '.git', 'info'), { recursive: true })
        writeFileSync(exclude, `${excluded}${excluded && !excluded.endsWith('\n') ? '\n' : ''}/node_modules\n`)
      }
      const branches = await git(path, 'branch', '--list', repo.branch)
      if (branches) await git(path, 'switch', '--quiet', repo.branch)
      else await git(path, 'switch', '--quiet', '-c', repo.branch, repo.commit ?? `origin/${repo.base}`)
      const baseCommit = repo.commit ?? await git(path, 'rev-parse', `origin/${repo.base}`)
      if (repo.setup) {
        const result = await sh(path, repo.setup, 600)
        if (result.exitCode !== 0) throw new Error(`setup for ${repo.name} failed: ${result.output.slice(-2000)}`)
      }
      worktrees.push({ repoId: repo.repoId, baseCommit })
    }
    // Sessions start in the workspace root, above the clones, where Claude
    // Code would not find a repo's own rules. Importing them here loads them.
    // A repo's CLAUDE.md, which may import its AGENTS.md, comes first, and
    // its AGENTS.md is imported when it has no CLAUDE.md.
    const rules = repos.flatMap((r) => RULES_FILES.filter((f) => existsSync(join(root, r.name, f))).slice(0, 1).map((f) => `@${r.name}/${f}`))
    if (rules.length) writeFileSync(join(root, 'CLAUDE.md'), `Each repo here has its own rules. Follow them.\n\n${rules.join('\n')}\n`)
    return { path: root, worktrees }
  }

  // Each workspace's latest setup. A session in the workspace waits for it, and
  // fails with its error, so the agent never starts in a half-cloned repo.
  const setups = new Map<string, Promise<unknown>>()
  const settingUp = new Set<string>()
  // Sessions whose workspace's setup has not been claimed yet.
  const waiting = new Map<string, (() => void)[]>()

  return {
    dir,
    taskFolder: (workspaceId: string) => join(dir(workspaceId), 'task'),

    setup(payload: SetupWorkspacePayload) {
      const work = cloneAll(payload)
      setups.set(payload.workspaceId, work)
      settingUp.add(payload.workspaceId)
      const settled = () => { settingUp.delete(payload.workspaceId) }
      void work.then(settled, settled)
      for (const wake of waiting.get(payload.workspaceId) ?? []) wake()
      waiting.delete(payload.workspaceId)
      return work
    },

    // The API writes a workspace's setup before the first message there, in one
    // transaction, but a daemon catching up on its queue can claim the two in
    // either order. A message whose workspace this process has neither set up nor
    // found on disk waits for the setup only while the server says it is queued or
    // running. Otherwise the workspace is gone, and the message fails.
    async ready(workspaceId: string, settingUp: () => Promise<boolean>) {
      if (!setups.has(workspaceId) && !existsSync(dir(workspaceId))) {
        if (!(await settingUp())) throw new Error(`workspace ${workspaceId} is not set up on this machine`)
        // The setup may have been claimed while the server answered.
        if (!setups.has(workspaceId)) {
          await new Promise<void>((resolve) => { waiting.set(workspaceId, [...(waiting.get(workspaceId) ?? []), resolve]) })
        }
      }
      await setups.get(workspaceId)
    },

    // What differs from each repo's base, or null while the workspace is being set up.
    async changes(workspaceId: string, sent: ReadonlyMap<string, string>): Promise<RepoChanges[] | null> {
      if (settingUp.has(workspaceId) || !existsSync(dir(workspaceId))) return null
      return workspaceChanges(dir(workspaceId), sent)
    },

    // The workspaces on this machine.
    ids(): string[] {
      const root = join(home, 'workspaces')
      return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []
    },

    exec: ({ workspaceId, repo, command, timeoutSec }: ExecPayload) => sh(join(dir(workspaceId), repo), command, timeoutSec),

    // Commits anything the agent left uncommitted, pushes the task branch, and
    // counts the commits it holds past its base.
    async push({ workspaceId, repos, message, author }: PushPayload): Promise<PushResult> {
      const pushed = []
      for (const repo of repos) {
        const path = join(dir(workspaceId), repo.name)
        await git(path, 'add', '--all')
        if (await git(path, 'status', '--porcelain')) {
          await git(path, '-c', `user.name=${author}`, '-c', `user.email=${author}@agents.local`, 'commit', '--quiet', '-m', message)
        }
        // The lease makes git refuse the push if the forge's branch moved after it was read.
        const expected = await forgeTip(path, repo.name, repo.branch)
        await git(path, 'push', '--quiet', `--force-with-lease=refs/heads/${repo.branch}:${expected}`, 'origin', `HEAD:refs/heads/${repo.branch}`)
        await git(path, 'update-ref', pushedRef(repo.branch), 'HEAD')
        const ahead = Number(await git(path, 'rev-list', '--count', `origin/${repo.base}..HEAD`))
        if (!Number.isInteger(ahead)) throw new Error(`git did not count the commits of ${repo.name} past ${repo.base}`)
        pushed.push({ repoId: repo.repoId, commit: await git(path, 'rev-parse', 'HEAD'), ahead })
      }
      return { pushed }
    },

    // The documents in a task folder, by path, with a hash of each so only
    // changed ones are sent. A file whose bytes say it is an image is an image,
    // whatever its name, and any other file is text.
    documents(workspaceId: string): TaskFile[] {
      const root = join(dir(workspaceId), 'task')
      const out: TaskFile[] = []
      const walk = (folder: string) => {
        for (const entry of existsSync(folder) ? readdirSync(folder, { withFileTypes: true }) : []) {
          const path = join(folder, entry.name)
          if (entry.isDirectory()) walk(path)
          if (!entry.isFile() || statSync(path).size > Math.max(MAX_IMAGE_BYTES, MAX_TEXT_BYTES)) continue
          const bytes = readFileSync(path)
          const file = { path: relative(root, path), hash: createHash('sha256').update(bytes).digest('hex') }
          const mediaType = sniffImage(bytes)
          if (mediaType && bytes.length <= MAX_IMAGE_BYTES) out.push({ ...file, kind: 'image', mediaType, bytes })
          else if (!mediaType && bytes.length <= MAX_TEXT_BYTES) out.push({ ...file, kind: 'text', content: bytes.toString('utf8') })
        }
      }
      walk(root)
      return out
    },
  }
}
