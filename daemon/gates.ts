// A machine's part of the coding framework's gates. This code ships with the
// daemon, in the box image, and never comes from a workspace, so a change
// cannot alter what judges it.
// - verify, in a box: the policy's commands on a clean checkout of the pushed
//   commit, with the check configuration copied from main, then each changed
//   check on main's code, where it must fail, and on the change, where it must pass.
// - suite, on the check host: the same seen-failing runs and the full suite, on
//   the result of merging the change into the current main.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type CommandResult, type GateCommand, type SeenFailing, type SuitePayload, type SuiteResult,
  type VerifyPayload, type VerifyResult,
} from '../shared/framework.ts'
import { buildOf } from '../shared/build.ts'
import { envSecrets, makeScrub } from '../shared/scrub.ts'
import { EVIDENCE_MANIFEST, type Shot } from '../shared/verification.ts'
import { gitAs, runProgram } from './workspace.ts'

// How long a repo's setup command may take on the check host, as for a workspace.
const SETUP_TIMEOUT_SEC = 600
// This daemon's build, which every result it returns names.
const BUILD = buildOf(['shared', 'daemon'])
// A gate's output leaves the machine with this machine's secrets and the
// known secret patterns replaced.
const scrub = makeScrub(envSecrets(process.env))

type Git = ReturnType<typeof gitAs>

async function timed(cwd: string, name: string, argv: readonly string[], timeoutSec: number): Promise<CommandResult> {
  const started = Date.now()
  const result = await runProgram(cwd, argv, timeoutSec)
  return { name, argv: [...argv], ...result, output: scrub(result.output), seconds: Math.round((Date.now() - started) / 100) / 10 }
}

const runGate = (cwd: string, command: GateCommand) => timed(cwd, command.name, command.argv, command.timeoutSec)

// A checkout uses the workspace's installed dependencies.
function linkModules(from: string, to: string) {
  if (existsSync(join(from, 'node_modules')) && !existsSync(join(to, 'node_modules'))) symlinkSync(join(from, 'node_modules'), join(to, 'node_modules'))
}

// Each changed check on `base` with only that file taken from the change, then on `change`.
async function seenFailing(git: Git, source: string, head: string, base: string, change: string, checks: readonly string[], argv: readonly string[], timeoutSec: number): Promise<SeenFailing[]> {
  const out: SeenFailing[] = []
  for (const file of checks) {
    const target = join(base, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, await git(source, 'show', `${head}:${file}`))
    const command = argv.map((a) => (a === '{file}' ? file : a))
    out.push({ file, base: await timed(base, file, command, timeoutSec), change: await timed(change, file, command, timeoutSec) })
  }
  return out
}

export function gates(home: string, api: string, token: string) {
  const git = gitAs(token)

  // A throwaway folder for checkouts, removed with its worktrees whatever happens.
  async function scratch<T>(under: string, source: string | null, work: (root: string) => Promise<T>): Promise<T> {
    const root = join(under, `${Date.now()}-${randomBytes(3).toString('hex')}`)
    mkdirSync(root, { recursive: true })
    try {
      return await work(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
      if (source) await git(source, 'worktree', 'prune')
    }
  }

  return {
    async verify(payload: VerifyPayload): Promise<VerifyResult> {
      const workspace = join(home, 'workspaces', payload.workspaceId)
      const source = join(workspace, payload.repo)
      if (!existsSync(join(source, '.git'))) throw new Error(`workspace ${payload.workspaceId} has no clone of ${payload.repo}`)
      return scratch(join(workspace, 'gates'), source, async (root) => {
        const change = join(root, 'change')
        await git(source, 'worktree', 'add', '--detach', '--quiet', change, payload.head)
        for (const path of payload.overlay) {
          if (await git(source, 'ls-tree', '--name-only', payload.base, '--', path) === path) await git(change, 'checkout', payload.base, '--', path)
        }
        linkModules(source, change)
        const commands: CommandResult[] = []
        for (const command of payload.commands) commands.push(await runGate(change, command))
        if (!payload.checks.length) return { build: BUILD, commands, checks: [] }
        const base = join(root, 'base')
        await git(source, 'worktree', 'add', '--detach', '--quiet', base, payload.base)
        linkModules(source, base)
        return { build: BUILD, commands, checks: await seenFailing(git, source, payload.head, base, change, payload.checks, payload.checkArgv, payload.checkTimeoutSec) }
      })
    },

    async suite(payload: SuitePayload): Promise<SuiteResult> {
      return scratch(join(home, 'suites'), null, async (root) => {
        const merged = join(root, 'merged')
        await git(root, 'clone', '--quiet', '--no-checkout', `${api}/v1/git/${payload.repoId}.git`, merged)
        await git(merged, 'fetch', '--quiet', 'origin', `+refs/heads/${payload.branch}:refs/remotes/origin/${payload.branch}`)
        const tip = await git(merged, 'rev-parse', `origin/${payload.branch}`)
        if (tip !== payload.head) throw new Error(`${payload.branch} is at ${tip}, not the approved ${payload.head}`)
        const main = await git(merged, 'rev-parse', `origin/${payload.main}`)
        await git(merged, 'checkout', '--quiet', '--detach', main)
        const merge = await runProgram(merged, ['git', '-c', 'user.name=agents', '-c', 'user.email=agents@agents.local', 'merge', '--no-ff', '--no-edit', payload.head], SETUP_TIMEOUT_SEC)
        if (merge.exitCode !== 0) return { merged: false, build: BUILD, main, conflict: merge.output }
        // A repo's setup command is a shell line its admin wrote, run as workspace setup runs it.
        const commands: CommandResult[] = []
        if (payload.setup !== null) commands.push(await timed(merged, 'setup', ['sh', '-c', payload.setup], SETUP_TIMEOUT_SEC))
        if (commands.every((c) => c.exitCode === 0)) {
          for (const command of payload.commands) commands.push(await runGate(merged, command))
        }
        let checks: SeenFailing[] = []
        if (payload.checks.length) {
          const base = join(root, 'base')
          await git(merged, 'worktree', 'add', '--detach', '--quiet', base, main)
          linkModules(merged, base)
          checks = await seenFailing(git, merged, payload.head, base, merged, payload.checks, payload.checkArgv, payload.checkTimeoutSec)
        }
        const manifest = join(merged, payload.evidence)
        const shots: Shot[] = existsSync(manifest) ? EVIDENCE_MANIFEST.parse(JSON.parse(readFileSync(manifest, 'utf8'))).shots : []
        return { merged: true, build: BUILD, main, commands, checks, shots }
      })
    },
  }
}
