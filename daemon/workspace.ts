// Task workspaces on this machine. Each is a folder under $AGENTS_HOME/workspaces with
// a clone of each repo on the task's branch, plus a `task` folder for documents,
// which sits beside the clones so it never enters git. Clones and pushes go
// through the API's git proxy with this machine's token.

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import type { ExecPayload, ExecResult, PushPayload, PushResult, SetupWorkspacePayload } from '../shared/types.ts'

const run = promisify(execFile)
const OUTPUT_LIMIT = 20_000
const DOCUMENT_LIMIT = 1024 * 1024

export type Workspaces = ReturnType<typeof workspaces>

export function workspaces(home: string, api: string, token: string) {
  const dir = (workspaceId: string) => join(home, 'workspaces', workspaceId)
  const auth = ['-c', `http.extraHeader=Authorization: Bearer ${token}`]
  const git = async (cwd: string, ...args: string[]) =>
    (await run('git', [...auth, ...args], { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim()
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

  return {
    dir,
    taskFolder: (workspaceId: string) => join(dir(workspaceId), 'task'),

    // Clones each repo and checks out the task branch. Running it again reuses
    // what is already there, so a retried command does no harm.
    async setup({ workspaceId, repos }: SetupWorkspacePayload) {
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
    },

    exec: ({ workspaceId, repo, command, timeoutSec }: ExecPayload) => sh(join(dir(workspaceId), repo), command, timeoutSec),

    // Commits anything the agent left uncommitted, then pushes the task branch.
    async push({ workspaceId, repos, message, author }: PushPayload): Promise<PushResult> {
      const pushed = []
      for (const repo of repos) {
        const path = join(dir(workspaceId), repo.name)
        await git(path, 'add', '--all')
        if (await git(path, 'status', '--porcelain')) {
          await git(path, '-c', `user.name=${author}`, '-c', `user.email=${author}@agents.local`, 'commit', '--quiet', '-m', message)
        }
        await git(path, 'push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${repo.branch}`)
        pushed.push({ repoId: repo.repoId, commit: await git(path, 'rev-parse', 'HEAD') })
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
