// Diffs of two texts, from git.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function gitDiff(before: string, after: string, name: string, context: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'agents-diff-'))
  try {
    writeFileSync(join(dir, 'a'), before)
    writeFileSync(join(dir, 'b'), after)
    execFileSync('git', ['diff', '--no-index', '--no-color', `--unified=${context}`, 'a', 'b'], { cwd: dir, encoding: 'utf8' })
    return ''
  } catch (error) {
    // git exits 1 when the files differ, with the diff on stdout.
    const stdout = (error as { stdout?: unknown }).stdout
    return (typeof stdout === 'string' ? stdout : '')
      .replace(/^diff --git a\/a b\/b\n(index [^\n]*\n)?/, '')
      .replace(/^--- a\/a$/m, `--- a/${name}`).replace(/^\+\+\+ b\/b$/m, `+++ b/${name}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A unified diff of two texts, with three lines of context.
export const diffText = (before: string, after: string, name: string): string => gitDiff(before, after, name, 3)

export type DiffHunk = { before: string; after: string; diff: string; removed: number; added: number }

// Each separate change between two texts: the lines it removes, the lines it
// adds, and its own diff with no context lines.
export function diffHunks(before: string, after: string, name: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let current: { head: string; removed: string[]; added: string[] } | null = null
  const close = () => {
    if (!current) return
    const { head, removed, added } = current
    hunks.push({
      before: removed.join('\n'), after: added.join('\n'), removed: removed.length, added: added.length,
      diff: [head, ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join('\n'),
    })
  }
  for (const line of gitDiff(before, after, name, 0).split('\n')) {
    if (line.startsWith('@@')) {
      close()
      current = { head: line, removed: [], added: [] }
    } else if (current && line.startsWith('-')) current.removed.push(line.slice(1))
    else if (current && line.startsWith('+')) current.added.push(line.slice(1))
  }
  close()
  return hunks
}
