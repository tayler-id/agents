// How the ops scripts act: as a list of steps, each said before it is done. A
// dry run says every step and does none, so it makes no AWS call and changes
// nothing on the machine.

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'

export type Step = { say: string; act: () => unknown }

export const isDryRun = (argv: string[] = process.argv) => argv.includes('--dry-run')

export async function perform(steps: Step[], dryRun: boolean): Promise<void> {
  for (const step of steps) {
    console.log(`${dryRun ? 'would ' : ''}${step.say}`)
    if (!dryRun) await step.act()
  }
  if (dryRun) console.log('dry run: nothing changed')
}

// Runs a program with an argument list, never a shell string, its output shown,
// and throws if it fails.
export function run(file: string, args: string[], options: ExecFileSyncOptions = {}): void {
  execFileSync(file, args, { stdio: 'inherit', ...options })
}

// Runs a program and returns what it printed.
export function output(file: string, args: string[], options: ExecFileSyncOptions = {}): string {
  return execFileSync(file, args, { stdio: ['ignore', 'pipe', 'inherit'], ...options }).toString().trim()
}
