// What every agentsctl command prints, in the shape agents read cheaply:
// a write leads with one `ok:` line saying what happened and the state it left,
// a read leads with its answer, and both end with next steps that fit that
// state. With --json the same result comes as one envelope, parsed by checks
// and the framework's runner with these schemas.
//
// Exit codes:
//   0  done, or already done (a rerun that changed nothing says `already: true`)
//   1  failed; safe to retry once the cause is fixed
//   2  the command line is wrong
//   3  refused, with nothing changed (the live system, a write to the database,
//      an instance in the way)

import { z } from 'zod'

export const Json = z.json()
export type Json = z.infer<typeof Json>

export const EXIT = { done: 0, failed: 1, usage: 2, refused: 3 } as const
export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export const Output = z.object({
  ok: z.boolean(),
  command: z.string(),
  // The ok: line of a write, the answer of a read, or the error: line of a failure.
  head: z.string(),
  // Everything else a person might read. Plain output shortens it; --json never does.
  detail: z.string(),
  already: z.boolean(),
  code: z.number().int(),
  // Files the command wrote as evidence.
  files: z.array(z.string()),
  // Next commands that fit the state the command left, never the command itself.
  help: z.array(z.string()),
  data: Json,
})
export type Output = z.infer<typeof Output>

// A failure that knows its exit code and the commands to run next.
export class CliError extends Error {
  code: Exclude<ExitCode, 0>
  help: string[]
  constructor(code: Exclude<ExitCode, 0>, message: string, help: string[] = []) {
    super(message)
    this.code = code
    this.help = help
  }
}
export class UsageError extends CliError {
  constructor(message: string, help: string[] = ['Run `bin/agentsctl help` for every command and its options']) {
    super(EXIT.usage, message, help)
  }
}
export class Refused extends CliError {
  constructor(message: string, help: string[] = []) {
    super(EXIT.refused, message, help)
  }
}

// Plain output keeps to this many lines of detail unless --full.
const DETAIL_LINES = 30
const DETAIL_CHARS = 4000

function shorten(text: string, full: boolean): string {
  if (full) return text
  const lines = text.split('\n')
  const kept = lines.slice(0, DETAIL_LINES).join('\n')
  const cut = kept.length > DETAIL_CHARS ? `${kept.slice(0, DETAIL_CHARS)}…` : kept
  const hidden = lines.length - DETAIL_LINES
  if (hidden <= 0 && cut === kept) return text
  return `${cut}\n(truncated${hidden > 0 ? `: ${String(hidden)} more lines` : ''}. Add --full to see all of it.)`
}

const list = (name: string, items: string[]) => (items.length ? `${name}[${String(items.length)}]:\n${items.map((i) => `  - ${i}`).join('\n')}` : '')

export function render(output: Output, full: boolean): string {
  const files = output.files.length > 5 && !full ? [...output.files.slice(0, 5), `and ${String(output.files.length - 5)} more`] : output.files
  return [
    output.head,
    output.already ? 'already: true' : '',
    output.code !== EXIT.done ? `code: ${String(output.code)}` : '',
    output.detail ? shorten(output.detail, full) : '',
    list('files', files),
    list('help', output.help),
  ].filter(Boolean).join('\n')
}
