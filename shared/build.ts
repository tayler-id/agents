// The build of the code a process runs: the commit it was checked out at,
// when it has one, a hash over the source folders it runs from, and the Node
// version. The hash tells two builds apart even where there is no git
// history, as in a box, or where the checkout has uncommitted edits. Every
// result the framework records names the build that produced it.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { ToolBuild } from './framework.ts'

const ROOT = new URL('..', import.meta.url).pathname

function commitOf(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    // Code copied without its git history, as in a box, has no commit to report.
    return null
  }
}

function sources(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path)
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
  })
}

// `folders` are the source folders the process runs from, relative to the repo root.
export function buildOf(folders: readonly string[]): ToolBuild {
  const hash = createHash('sha256')
  for (const file of folders.flatMap((f) => sources(join(ROOT, f))).sort()) {
    hash.update(`${relative(ROOT, file)}\0${readFileSync(file, 'utf8')}\0`)
  }
  return { commit: commitOf(), files: hash.digest('hex'), node: process.version }
}
