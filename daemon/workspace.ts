// Task workspaces on this machine. Each is a folder under $AGENTS_HOME/workspaces with
// a clone of each repo on the task's branch, plus a `task` folder for documents,
// which sits beside the clones so it never enters git. Clones and pushes go
// through the API's git proxy with this machine's token.

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { workspaceChanges } from './changes.ts'
import type { ExecPayload, ExecResult, PushPayload, PushResult, SetupWorkspacePayload } from '../shared/types.ts'
import type { RepoChanges } from '../shared/work.ts'

const run = promisify(execFile)
const OUTPUT_LIMIT = 20_000
const DOCUMENT_LIMIT = 1024 * 1024

export type Workspaces = ReturnType<typeof workspaces>

export function workspaces(home: string, api: string, token: string) {
  const dir = (workspaceId: string) => join(home, 'workspaces', workspaceId)
  // The token reaches git through its environment, never its arguments, because a
  // failed command's message repeats its arguments and the record keeps that message.
  const gitEnv = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` }
  const git = async (cwd: string, ...args: string[]) =>
    (await run('git', args, { cwd, env: gitEnv, maxBuffer: 16 * 1024 * 1024 })).stdout.trim()
  const sh = (cwd: string, command: string, timeoutSec: number) => new Promise<ExecResult>((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd, env: { ...process.env, CI: '1' } })
    let output = ''
    const keep = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-OUTPUT_LIMIT) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutSec * 1000)
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, output, timedOut }) })
    child.on('error', (error) => { clearTimeout(timer); resolve({ exitCode: null, output: error.message, timedOut }) })
  })

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
    // either order. A message whose workspace this machine has neither set up
    // nor started setting up waits for that setup, which is always on its way.
    async ready(workspaceId: string) {
      if (!setups.has(workspaceId) && !existsSync(dir(workspaceId))) {
        await new Promise<void>((resolve) => { waiting.set(workspaceId, [...(waiting.get(workspaceId) ?? []), resolve]) })
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
        // The agent may rewrite its branch, but a commit someone added on the forge since this workspace last pushed is never pushed over.
        await git(path, 'push', '--quiet', `--force-with-lease=refs/heads/${repo.branch}:${repo.lease ?? ''}`, 'origin', `HEAD:refs/heads/${repo.branch}`)
        const ahead = Number(await git(path, 'rev-list', '--count', `origin/${repo.base}..HEAD`))
        if (!Number.isInteger(ahead)) throw new Error(`git did not count the commits of ${repo.name} past ${repo.base}`)
        pushed.push({ repoId: repo.repoId, commit: await git(path, 'rev-parse', 'HEAD'), ahead })
      }
      return { pushed }
    },

    // The documents in a task folder, by path, with a hash of each so only
    // changed ones are sent.
    documents(workspaceId: string): { path: string; hash: string; content: string }[] {
      const root = join(dir(workspaceId), 'task')
      const out: { path: string; hash: string; content: string }[] = []
      const walk = (folder: string) => {
        for (const entry of existsSync(folder) ? readdirSync(folder, { withFileTypes: true }) : []) {
          const path = join(folder, entry.name)
          if (entry.isDirectory()) walk(path)
          else if (entry.isFile() && statSync(path).size <= DOCUMENT_LIMIT) {
            const content = readFileSync(path, 'utf8')
            out.push({ path: relative(root, path), hash: createHash('sha256').update(content).digest('hex'), content })
          }
        }
      }
      walk(root)
      return out
    },
  }
}
