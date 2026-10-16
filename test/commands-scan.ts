// Which source files write to the commands table, read from the code itself, for
// step23. server/scheduler.ts is the one writer of message, stop and interrupt
// commands, since a turn must not reach a machine except through its door, and
// server/durability.ts is the one place a message command's status changes. Every
// other statement names a kind that is not a message, or leaves messages out.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// Folders that hold no product code, or hold checks, which write rows directly to set a scene.
const SKIP = new Set(['node_modules', 'test', 'docs', 'research', 'dist', '.git', '.scratch', 'ui-shots'])
// The kinds other files may insert. A message, a stop and an interrupt go through the scheduler.
const OTHER_KINDS = /'(setup_workspace|push|exec|verify|suite|answer)'/

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(path)
    else if (/\.tsx?$/.test(entry.name)) yield path
  }
}

// Every write to commands the code could make that its owner should not, as one
// line each, naming the file.
export function commandWritersOutOfPlace(root: string): string[] {
  const found: string[] = []
  for (const path of sourceFiles(root)) {
    const file = relative(root, path)
    const text = readFileSync(path, 'utf8')
    for (const match of text.matchAll(/\b(insert\s+into\s+commands|update\s+commands)\b[^`]*/gi)) {
      const statement = match[0]
      if (/^insert/i.test(statement)) {
        if (file !== 'server/scheduler.ts' && !OTHER_KINDS.test(statement)) found.push(`${file} inserts a command that is not a setup, push, exec, verify, suite or answer`)
      } else if (file !== 'server/durability.ts' && !/kind\s*<>\s*'message'/.test(statement)) {
        found.push(`${file} updates commands without leaving messages out`)
      }
    }
  }
  return found
}
