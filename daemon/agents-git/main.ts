// agents-git sets up, tracks and removes the git worktrees agents work in. Run it
// from anywhere inside the repo, with Node from ~/.local/node/bin:
//   node daemon/agents-git/main.ts                      the same as list
//   node daemon/agents-git/main.ts start <name> --note <who works there, on what>
//   node daemon/agents-git/main.ts list
//   node daemon/agents-git/main.ts adopt <path> [--name <name>] [--note <text>]
//   node daemon/agents-git/main.ts done <name> [--yes]
//   node daemon/agents-git/main.ts prune [--yes]
// done and prune only preview without --yes. The first line says how it went, and
// the exit code says it too: 0 done, 1 failed and safe to retry, 2 a usage error,
// 3 refused with nothing changed.

import { parseArgs } from 'node:util'
import { z } from 'zod'
import { messageOf } from '../../shared/errors.ts'
import { ledgerFile, Name } from './ledger.ts'
import { adopt, done, list, prune, start, type Report } from './worktrees.ts'

const USAGE = {
  start: 'start <name> --note <text>   a branch from local main and a worktree beside the repo, with its own npm ci',
  list: 'list                         every worktree, tracked or not, with what the ledger and git each say',
  adopt: 'adopt <path> [--name <name>] [--note <text>]   track a worktree that exists, without changing it',
  done: 'done <name> [--yes]          save its last commit, remove the worktree, and delete its branch once main has it',
  prune: 'prune [--yes]                done for each tracked worktree that is merged and clean, or whose folder is gone',
}
const NOTE = 'start needs --note, saying who works there and on what'

const Command = z.discriminatedUnion('command', [
  z.strictObject({ command: z.literal('start'), target: z.string({ error: 'start needs a name' }).pipe(Name), note: z.string({ error: NOTE }).trim().min(1, NOTE) }),
  z.strictObject({ command: z.literal('list') }),
  z.strictObject({ command: z.literal('adopt'), target: z.string({ error: 'adopt needs the path of a worktree' }).min(1), name: Name.optional(), note: z.string().trim().min(1).optional() }),
  z.strictObject({ command: z.literal('done'), target: z.string({ error: 'done needs a name' }).pipe(Name), yes: z.boolean().default(false) }),
  z.strictObject({ command: z.literal('prune'), yes: z.boolean().default(false) }),
])

// The problem, then how to use the command it was about, or every command.
function usage(problem: string, command?: string): Report {
  const known = Object.entries(USAGE).find(([name]) => name === command)
  return { code: 2, lines: [`usage: ${problem}`, ...(known ? [known[1]] : Object.values(USAGE)).map((line) => `  ${line}`)] }
}

async function main(argv: string[]): Promise<Report> {
  let input: Record<string, unknown>
  try {
    const { values, positionals } = parseArgs({ args: argv, options: { note: { type: 'string' }, name: { type: 'string' }, yes: { type: 'boolean' } }, allowPositionals: true, strict: true })
    const [command = 'list', target, ...extra] = positionals
    if (extra.length) return usage(`unexpected ${extra.join(' ')}`, command)
    input = { command, ...(target === undefined ? {} : { target }), ...values }
  } catch (error) {
    return usage(messageOf(error))
  }
  const parsed = Command.safeParse(input)
  if (!parsed.success) {
    const command = String(input.command)
    if (!Object.keys(USAGE).includes(command)) return usage(`there is no command ${command}`)
    // The positional argument is parsed as target, so it is named for what it is.
    const named = (key: string) => (key === 'target' ? 'argument' : `--${key}`)
    return usage(parsed.error.issues.map((issue) => (issue.code === 'unrecognized_keys' ? `${command} takes no ${issue.keys.map(named).join(' or ')}` : issue.message)).join('; '), command)
  }
  const ledger = ledgerFile(process.env)
  const cwd = process.cwd()
  const command = parsed.data
  switch (command.command) {
    case 'start': return start(ledger, cwd, command.target, command.note)
    case 'list': return list(ledger, cwd)
    case 'adopt': return adopt(ledger, cwd, command.target, command.name, command.note)
    case 'done': return done(ledger, cwd, command.target, command.yes)
    case 'prune': return prune(ledger, cwd, command.yes)
  }
}

const report = await main(process.argv.slice(2)).catch((error: unknown): Report => ({ code: 1, lines: [`failed: ${messageOf(error)}`] }))
for (const line of report.lines) console.log(line)
process.exitCode = report.code
