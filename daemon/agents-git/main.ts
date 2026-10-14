// agents-git runs the git side of an agent's work on this repo: it sets up and
// tracks worktrees, keeps work safe, runs checks, submits pull requests and lands
// them, each step a command that does what AGENTS.md asks or refuses. Run it from
// anywhere inside the repo, with Node from ~/.local/node/bin:
//   node daemon/agents-git/main.ts <command>
// With no command it lists. done and prune only preview without --yes. The first
// line says how it went, and the exit code says it too: 0 done, 1 failed and safe
// to retry, 2 a usage error, 3 refused with nothing changed.

import { parseArgs } from 'node:util'
import { z } from 'zod'
import { messageOf } from '../../shared/errors.ts'
import { check, StepId } from './checks.ts'
import { exitCodeOf, Stopped } from './group.ts'
import { ledgerFile, Name } from './ledger.ts'
import type { Report } from './repo.ts'
import { save, sync } from './work.ts'
import { adopt, done, list, prune, start } from './worktrees.ts'

const USAGE = {
  start: 'start <name> --note <text>   a branch from local main and a worktree beside the repo, with its own npm ci',
  list: 'list   every worktree, tracked or not, and where the ledger and git disagree',
  adopt: 'adopt <path> [--name <name>] [--note <text>]   track a worktree that exists, without changing it',
  done: 'done <name> [--yes] [--backup <path>]...   save its last commit, copy the ignored paths named by --backup to ~/.agents-app/backups, remove the worktree, and delete its branch once main has it',
  prune: 'prune [--yes]   done for each tracked worktree that is merged and clean, or whose folder is gone',
  save: 'save <name>   keep its uncommitted work in a ref, and leave the worktree as it is',
  sync: 'sync <name>   bring local main into its branch: a rebase, or a merge once the branch is submitted',
  check: 'check <name> <step...> [--limit <seconds>] [--build-limit <seconds>]   run test/step<step>.ts under the run lock, and record it',
  submit: 'submit <name> [--message <text>] [--review <text>]... [--regression <text>] [--approve <path>]...   scan, push to GitHub and open the pull request',
  land: 'land <name> [--approve <path>]...   run every landing gate, then fast-forward main and mirror it to GitHub',
}
type CommandName = keyof typeof USAGE
const isCommand = (name: string): name is CommandName => Object.keys(USAGE).includes(name)

const NOTE = 'start needs --note, saying who works there and on what'
const named = (command: CommandName) => z.string({ error: `${command} needs a name` }).pipe(Name)
const Text = z.string().trim().min(1)
const Seconds = z.coerce.number().int('a limit is a whole number of seconds').positive('a limit is a whole number of seconds above 0')
const Paths = z.array(z.string().min(1)).default([])

const Command = z.discriminatedUnion('command', [
  z.strictObject({ command: z.literal('start'), args: z.tuple([named('start')]), note: z.string({ error: NOTE }).trim().min(1, NOTE) }),
  z.strictObject({ command: z.literal('list'), args: z.tuple([]) }),
  z.strictObject({ command: z.literal('adopt'), args: z.tuple([z.string({ error: 'adopt needs the path of a worktree' }).min(1)]), name: Name.optional(), note: Text.optional() }),
  z.strictObject({ command: z.literal('done'), args: z.tuple([named('done')]), yes: z.boolean().default(false), backup: Paths }),
  z.strictObject({ command: z.literal('prune'), args: z.tuple([]), yes: z.boolean().default(false) }),
  z.strictObject({ command: z.literal('save'), args: z.tuple([named('save')]) }),
  z.strictObject({ command: z.literal('sync'), args: z.tuple([named('sync')]) }),
  z.strictObject({ command: z.literal('check'), args: z.tuple([named('check'), z.string({ error: 'check needs at least one step, such as 22' }).pipe(StepId)], StepId), limit: Seconds.optional(), 'build-limit': Seconds.optional() }),
  z.strictObject({ command: z.literal('submit'), args: z.tuple([named('submit')]), message: Text.optional(), review: z.array(Text).default([]), regression: Text.optional(), approve: Paths }),
  z.strictObject({ command: z.literal('land'), args: z.tuple([named('land')]), approve: Paths }),
])

// The problem, then how to use the command it was about, or every command.
function usage(problem: string, command?: CommandName): Report {
  return { code: 2, lines: [`usage: ${problem}`, ...(command ? [USAGE[command]] : Object.values(USAGE)).map((line) => `  ${line}`)] }
}

async function main(argv: string[]): Promise<Report> {
  let input: { command: string } & Record<string, unknown>
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        note: { type: 'string' }, name: { type: 'string' }, yes: { type: 'boolean' }, limit: { type: 'string' }, 'build-limit': { type: 'string' },
        message: { type: 'string' }, review: { type: 'string', multiple: true }, regression: { type: 'string' }, approve: { type: 'string', multiple: true }, backup: { type: 'string', multiple: true },
      },
      allowPositionals: true,
      strict: true,
    })
    const [command = 'list', ...args] = positionals
    input = { ...values, command, args }
  } catch (error) {
    return usage(messageOf(error))
  }
  const name = input.command
  if (!isCommand(name)) return usage(`there is no command ${name}`)
  const parsed = Command.safeParse(input)
  if (!parsed.success) {
    // The positional arguments are parsed as args, so they are named for what they are.
    const option = (key: string) => (key === 'args' ? 'arguments' : `--${key}`)
    return usage(parsed.error.issues.map((issue) => {
      if (issue.code === 'unrecognized_keys') return `${name} takes no ${issue.keys.map(option).join(' or ')}`
      if (issue.path[0] === 'args' && (issue.code === 'too_big' || issue.code === 'too_small')) {
        const shape = (USAGE[name].split('   ')[0] ?? '').slice(name.length).trim()
        return shape ? `${name} takes ${shape}` : `${name} takes no arguments`
      }
      return issue.message
    }).join('; '), name)
  }
  const ledger = ledgerFile(process.env)
  const cwd = process.cwd()
  const command = parsed.data
  switch (command.command) {
    case 'start': return start(ledger, cwd, command.args[0], command.note)
    case 'list': return list(ledger, cwd)
    case 'adopt': return adopt(ledger, cwd, command.args[0], command.name, command.note)
    case 'done': return done(ledger, cwd, command.args[0], command.yes, command.backup)
    case 'prune': return prune(ledger, cwd, command.yes)
    case 'save': return save(ledger, cwd, command.args[0])
    case 'sync': return sync(ledger, cwd, command.args[0])
    case 'check': return check(ledger, cwd, command.args[0], command.args.slice(1), command.limit, command['build-limit'])
    // These two load the coding framework's gates, which load the TypeScript compiler, so only they wait for it.
    case 'submit': return (await import('./github.ts')).submit(ledger, cwd, command.args[0], { message: command.message, reviews: command.review, regression: command.regression, approve: command.approve })
    case 'land': return (await import('./land.ts')).land(ledger, cwd, command.args[0], command.approve)
  }
}

const finished = await main(process.argv.slice(2)).then(
  (report) => ({ report, exit: report.code }),
  (error: unknown): { report: Report, exit: number } => {
    // A signal ends a command with the code a shell reports for a process a signal killed.
    if (error instanceof Stopped) return { report: { code: 1, lines: [`stopped: ${error.message}`] }, exit: exitCodeOf(error.signal) }
    return { report: { code: 1, lines: [`failed: ${messageOf(error)}`] }, exit: 1 }
  },
)
for (const line of finished.report.lines) console.log(line)
process.exitCode = finished.exit
