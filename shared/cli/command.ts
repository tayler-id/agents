// How our CLIs define commands and run them. A command names its flags with a
// line of help each and parses them with a zod schema, so help is generated
// from the definitions and an unknown flag or command is refused with the valid
// ones listed. The dispatcher turns what a command returns into the envelope in
// output.ts, so every command words its head the same way.

import { parseArgs } from 'node:util'
import { z } from 'zod'
import { CliError, counted, EXIT, fence, JSON_VALUE, OUTPUT, UsageError, type ExitCode, type Outside, type Output } from './output.ts'

export type Flag = { kind: 'string' | 'boolean' | 'strings'; about: string }
export type Flags = Record<string, Flag>

// Flags every command of every CLI takes.
const OWN: Flags = {
  json: { kind: 'boolean', about: 'print one JSON envelope instead of text' },
  full: { kind: 'boolean', about: 'show long output whole instead of cut' },
  help: { kind: 'boolean', about: "show this command's flags" },
}
const DRY_RUN: Flags = { 'dry-run': { kind: 'boolean', about: 'check the command line and its target, and run nothing' } }
const FIELDS: Flags = { fields: { kind: 'string', about: 'the fields to show, comma separated' } }

type Shared = {
  detail?: string
  // Text from outside the CLI, shown fenced and named in the envelope's untrusted list.
  outside?: Outside
  help: string[]
  files?: string[]
  data: unknown
  // A folder the CLI's own `after` hook logs this command in.
  log?: string
}
export type Row = Record<string, string>
// What a command returns. The dispatcher builds the head from it.
export type Result =
  | (Shared & { kind: 'read'; answer: string })
  // Every row there is; the dispatcher shows a few fields and rows, says how many of how many, and says when there are none.
  // `source` names where the rows came from when they hold outside text.
  | (Shared & { kind: 'list'; noun: string; rows: Row[]; source?: string })
  // `state` is what a read after the write found, never what the write meant to leave.
  | (Shared & { kind: 'write'; did: string; state: string; already: boolean })
  | (Shared & { kind: 'failed'; code: typeof EXIT.failed | typeof EXIT.refused; error: string })
export type Run = () => Promise<Result>

export type Command = {
  name: string
  args: string
  about: string
  flags: Flags
  // For a list: every field a row has, and the ones shown unless --fields names others.
  fields?: { all: readonly string[]; shown: readonly string[] }
  prepare: (values: Record<string, unknown>, positionals: string[]) => Run
}

// A command whose flags parse with a zod schema before it can run.
export function command<S extends z.ZodType>(spec: Omit<Command, 'prepare'> & { schema: S; prepare: (values: z.infer<S>, positionals: string[]) => Run }): Command {
  return {
    name: spec.name, args: spec.args, about: spec.about, flags: spec.flags, fields: spec.fields,
    prepare: (values, positionals) => {
      const parsed = spec.schema.safeParse(values)
      if (!parsed.success) throw new UsageError(`${spec.name}: ${z.prettifyError(parsed.error)}`)
      return spec.prepare(parsed.data, positionals)
    },
  }
}

export type Cli = {
  name: string
  // How a person runs it, as next steps write it, such as bin/agentsctl.
  invoke: string
  about: string
  // Flags every command of this CLI takes, beyond --json, --full and --help.
  global: Flags
  commands: Command[]
  // What runs with no command.
  dashboard: Run
  // What a command would do, for --dry-run. Without it the CLI has no --dry-run.
  dryRun?: (command: Command, argv: string[], values: Record<string, unknown>) => Result
  // Runs after every command, with what it returned and printed.
  after?: (result: Result, output: Output, argv: string[]) => void
  // Next steps after a command fails with an error it did not expect.
  failureHelp: string[]
}

const flagLine = (name: string, flag: Flag) => `  --${name}${flag.kind === 'boolean' ? '' : ' <value>'}${flag.kind === 'strings' ? ' (repeatable)' : ''}: ${flag.about}`
const flagsOf = (cli: Cli, command: Command | null): Flags => ({
  ...(command?.flags ?? {}), ...cli.global, ...OWN, ...(cli.dryRun ? DRY_RUN : {}), ...(command?.fields ? FIELDS : {}),
})

// A group with more commands than this shows as one line naming them, so help stays short.
const GROUP_LINES = 8

export function cliHelp(cli: Cli): string {
  const firstWord = (c: Command) => c.name.split(' ')[0] ?? c.name
  const lines: [string, string][] = []
  for (const word of new Set(cli.commands.map(firstWord))) {
    const group = cli.commands.filter((c) => firstWord(c) === word)
    if (group.length > GROUP_LINES) lines.push([`${word} <op>`, `one of: ${group.map((c) => c.name.slice(word.length + 1)).join(', ')}`])
    else for (const c of group) lines.push([c.name, c.about])
  }
  const width = Math.max(...lines.map(([name]) => name.length))
  return [
    `${cli.name}: ${cli.about}`,
    '',
    'Commands:',
    ...lines.map(([name, about]) => `  ${name.padEnd(width)}  ${about}`),
    '',
    `Run \`${cli.invoke} <command> --help\` for a command's flags. Every command takes:`,
    ...Object.entries({ ...cli.global, ...OWN, ...(cli.dryRun ? DRY_RUN : {}) }).map(([name, flag]) => flagLine(name, flag)),
    '',
    'Exit codes: 0 done, 1 failed and safe to retry once fixed, 2 usage error, 3 refused with nothing changed.',
  ].join('\n')
}

export function commandHelp(cli: Cli, command: Command): string {
  return [
    `${cli.invoke} ${command.name}${command.args ? ` ${command.args}` : ''}`,
    command.about,
    ...(command.fields ? [`Fields: ${command.fields.all.join(', ')}. Shown unless --fields names others: ${command.fields.shown.join(', ')}.`] : []),
    'Flags:',
    ...Object.entries(flagsOf(cli, command)).map(([name, flag]) => flagLine(name, flag)),
  ].join('\n')
}

// The command an argument list names, and the arguments after its name.
function find(cli: Cli, argv: string[]): { command: Command; rest: string[] } {
  const [first = '', second] = argv
  const two = second === undefined ? undefined : cli.commands.find((c) => c.name === `${first} ${second}`)
  if (two) return { command: two, rest: argv.slice(2) }
  const one = cli.commands.find((c) => c.name === first)
  if (one) return { command: one, rest: argv.slice(1) }
  const group = cli.commands.filter((c) => c.name.startsWith(`${first} `))
  if (group.length) {
    const words = group.map((c) => c.name.slice(first.length + 1))
    const takes = `${first} takes one of: ${words.join(', ')}`
    throw new UsageError(second === undefined ? takes : `${second} is not one of its commands. ${takes}`, [`Run \`${cli.invoke} ${first} ${words[0] ?? ''} --help\` for its flags`])
  }
  throw new UsageError(`not a command. Commands: ${[...new Set(cli.commands.map((c) => c.name.split(' ')[0]))].join(', ')}`, [`Run \`${cli.invoke} help\` for every command`])
}

type Parsed = { values: Record<string, unknown>; positionals: string[] }
// `help` is the next step a usage error suggests, such as the command's own --help.
function parseFlags(flags: Flags, args: string[], help: string): Parsed {
  const options = Object.fromEntries(Object.entries(flags).map(([name, flag]) => [name, flag.kind === 'boolean' ? { type: 'boolean' as const } : { type: 'string' as const, multiple: flag.kind === 'strings' }]))
  try {
    const { values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: true })
    return { values, positionals }
  } catch (error) {
    const message = error instanceof Error ? error.message.split('.')[0] ?? error.message : String(error)
    throw new UsageError(`${message}. It takes: ${Object.keys(flags).map((f) => `--${f}`).join(', ')}`, [help])
  }
}

// The commands a next step names, in backticks, as words.
const named = (line: string, invoke: string) => [...line.matchAll(/`([^`]+)`/g)].flatMap((m) => (m[1]?.startsWith(`${invoke} `) ? [m[1].replace(/["']/g, '').split(/\s+/).join(' ')] : []))

// Next steps never suggest the command that just ran, word for word.
export function withoutSelf(help: string[], invoke: string, argv: string[]): string[] {
  const ran = [invoke, ...argv.filter((a) => a !== '--json' && a !== '--full')].join(' ').split(/\s+/).join(' ')
  return help.filter((line) => !named(line, invoke).includes(ran))
}

const LIST_ROWS = 30
const rowLine = (row: Row, fields: readonly string[]) => fields.map((f) => `${f}=${row[f] ?? ''}`).join('  ')

function headOf(result: Result, commandName: string): string {
  switch (result.kind) {
    case 'read': return result.answer
    case 'list': return counted(result.noun, Math.min(result.rows.length, LIST_ROWS), result.rows.length)
    case 'write': return `ok: ${result.did} -> ${result.state}`
    case 'failed': return `error: ${commandName}: ${result.error}`
  }
}

// The fields --fields names, refused before anything runs when a list has no such field.
function requestedFields(command: Command, requested: unknown): string[] | null {
  if (typeof requested !== 'string' || !command.fields) return null
  const names = requested.split(',').map((f) => f.trim())
  const unknown = names.filter((f) => !command.fields?.all.includes(f))
  if (unknown.length) throw new UsageError(`${command.name} has no field ${unknown.join(', ')}. Its fields: ${command.fields.all.join(', ')}`)
  return names
}

// The detail of a list: the chosen fields of each row, all rows only with --full.
function listDetail(result: Extract<Result, { kind: 'list' }>, command: Command, requested: string[] | null, full: boolean): string {
  const shown = requested ?? command.fields?.shown ?? [...new Set(result.rows.flatMap((r) => Object.keys(r)))]
  const rows = full ? result.rows : result.rows.slice(0, LIST_ROWS)
  const lines = rows.map((r) => rowLine(r, shown)).join('\n')
  const more = rows.length < result.rows.length ? `\n(${String(result.rows.length - rows.length)} more ${result.noun}. Add --full for all of them.)` : ''
  return result.source ? `${fence({ source: result.source, text: lines })}${more}` : `${lines}${more}`
}

function envelope(result: Result, command: Command | null, commandName: string, requested: string[] | null, full: boolean): Output {
  const code: ExitCode = result.kind === 'failed' ? result.code : EXIT.done
  const parts = [
    result.detail ?? '',
    result.kind === 'list' && command ? listDetail(result, command, requested, full) : '',
    result.outside ? fence(result.outside) : '',
  ].filter(Boolean)
  const untrusted = [...(result.outside ? [result.outside.source] : []), ...(result.kind === 'list' && result.source ? [result.source] : [])]
  return OUTPUT.parse({
    ok: code === EXIT.done, command: commandName, head: headOf(result, commandName), detail: parts.join('\n'),
    already: result.kind === 'write' && result.already, code, files: result.files ?? [], help: result.help, untrusted,
    data: JSON_VALUE.parse(JSON.parse(JSON.stringify(result.data ?? null))),
  })
}

// Help comes back as a read: its first line as the head, the rest as detail, never cut.
const helpOutput = (text: string, commandName: string): Output => {
  const [first = '', ...rest] = text.split('\n')
  return envelope({ kind: 'read', answer: first, detail: rest.join('\n'), help: [], data: null }, null, commandName, null, true)
}

const failure = (commandName: string, error: unknown, help: string[]): Output => {
  const known = error instanceof CliError
  const code = known ? error.code : EXIT.failed
  const message = error instanceof Error ? error.message : String(error)
  return OUTPUT.parse({
    ok: false, command: commandName, head: `error: ${commandName}: ${message}`, detail: '', already: false, code,
    files: [], help: known && error.help.length ? error.help : help, untrusted: [], data: null,
  })
}

// A command's flags parsed and checked, and what runs it. Touches nothing.
function prepared(cli: Cli, command: Command, rest: string[]) {
  const { values, positionals } = parseFlags(flagsOf(cli, command), rest, `Run \`${cli.invoke} ${command.name} --help\` for its flags`)
  const { json: _json, full: _full, help: _help, 'dry-run': dry, fields, ...own } = values
  return { run: command.prepare(own, positionals), own, requested: requestedFields(command, fields), dry: dry === true }
}

// Checks a command line the way dispatch would, and runs nothing. Throws a UsageError naming what is wrong.
export function parseOnly(cli: Cli, argv: string[]): void {
  const { command, rest } = find(cli, argv)
  prepared(cli, command, rest)
}

// Runs one command line. Never throws: a failure comes back as an envelope with its exit code.
export async function dispatch(cli: Cli, argv: string[]): Promise<{ code: ExitCode; output: Output; json: boolean; full: boolean }> {
  const json = argv.includes('--json')
  const full = argv.includes('--full')
  const words = argv.filter((a) => !a.startsWith('--'))
  let commandName = words[0] ?? 'dashboard'
  try {
    if (!argv.length || argv.every((a) => a.startsWith('--'))) {
      if (argv.includes('--help')) return { code: EXIT.done, output: helpOutput(cliHelp(cli), 'help'), json, full: true }
      parseFlags({ ...cli.global, ...OWN }, argv, `Run \`${cli.invoke} help\` for every command`)
      const result = await cli.dashboard()
      const output = envelope(result, null, commandName, null, full)
      cli.after?.(result, output, argv)
      return { code: output.code, output, json, full }
    }
    if (argv[0] === 'help') return { code: EXIT.done, output: helpOutput(cliHelp(cli), 'help'), json, full: true }
    const { command, rest } = find(cli, argv)
    commandName = command.name
    if (rest.includes('--help')) return { code: EXIT.done, output: helpOutput(commandHelp(cli, command), `${command.name} --help`), json, full: true }
    const { run, own, requested, dry } = prepared(cli, command, rest)
    const result = dry && cli.dryRun ? cli.dryRun(command, argv, own) : await run()
    const output = envelope({ ...result, help: withoutSelf(result.help, cli.invoke, argv) }, command, command.name, requested, full)
    cli.after?.(result, output, argv)
    return { code: output.code, output, json, full }
  } catch (error) {
    const output = failure(commandName, error, error instanceof UsageError ? [`Run \`${cli.invoke} help\` for every command`] : cli.failureHelp)
    return { code: output.code, output, json, full }
  }
}

