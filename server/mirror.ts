// The API's own copy of each repo: a bare clone under $AGENTS_HOME/mirrors,
// fetched from the forge with the factory's credentials. Gates read changes
// from it, so judging a change never runs any of the change's code. The
// credentials go to git through its environment, not its arguments, so they
// never show in a process list.

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gitUpstream } from './forge.ts'
import { IMAGE_HEAD_BYTES, imageFormat, type FileChange } from '../shared/gates/diff.ts'

const run = promisify(execFile)
const MIRRORS = join(process.env.AGENTS_HOME ?? join(homedir(), '.agents-app'), 'mirrors')
// A whole diff can be large, and git's output is read at once.
const GIT_OUTPUT_LIMIT = 256 * 1024 * 1024
// Files bigger than this are judged by their numbers alone, never read whole.
const READ_LIMIT = 2 * 1024 * 1024
// No git command against a mirror may run longer than this.
const GIT_TIMEOUT_MS = 10 * 60_000

export type Mirror = { dir: string; env: NodeJS.ProcessEnv }

async function git(mirror: Mirror, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-c', 'core.quotePath=false', ...args], { cwd: mirror.dir, env: mirror.env, maxBuffer: GIT_OUTPUT_LIMIT, encoding: 'utf8', timeout: GIT_TIMEOUT_MS })
  return stdout
}

// The repo's mirror with the given branches fetched, each to the same name.
export async function mirror(repoId: string, remoteUrl: string, branches: readonly string[]): Promise<Mirror> {
  const dir = join(MIRRORS, `${repoId}.git`)
  const upstream = gitUpstream(remoteUrl)
  const env = {
    ...process.env, GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: ${upstream.authorization}`,
  }
  const found: Mirror = { dir, env }
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    await git(found, ['init', '--quiet', '--bare'])
  }
  await git(found, ['fetch', '--quiet', '--force', '--prune', upstream.url, ...branches.map((b) => `+refs/heads/${b}:refs/heads/${b}`)])
  return found
}

export const commitOf = async (m: Mirror, ref: string) => (await git(m, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()
export const mergeBase = async (m: Mirror, a: string, b: string) => (await git(m, ['merge-base', a, b])).trim()

export async function exists(m: Mirror, commit: string, path: string): Promise<boolean> {
  const tree = await git(m, ['ls-tree', '--name-only', commit, '--', path])
  return tree.trim() === path
}

export async function read(m: Mirror, commit: string, path: string): Promise<string | null> {
  return (await exists(m, commit, path)) ? git(m, ['show', `${commit}:${path}`]) : null
}

// The names of the files in a folder at a commit.
export async function list(m: Mirror, commit: string, folder: string): Promise<string[]> {
  // A folder missing at that commit has no files, which git reports as an unknown object.
  const out = await git(m, ['ls-tree', '--name-only', `${commit}:${folder}`]).catch((error: unknown) => {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : ''
    if (stderr.includes('Not a valid object name')) return ''
    throw error
  })
  return out.split('\n').filter(Boolean)
}

// The unified diff between two commits, three dots: what `head` changed since they parted.
export const diffText = (m: Mirror, base: string, head: string, paths: readonly string[] = []) =>
  git(m, ['diff', '--no-color', '-M', `${base}...${head}`, '--', ...paths])

// git's stable patch-id of what `head` changed since `base`. A rebase that
// keeps the same change keeps the same patch-id, so a verdict can outlive it.
export async function patchId(m: Mirror, base: string, head: string): Promise<string> {
  const diff = await diffText(m, base, head)
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn('git', ['patch-id', '--stable'], { cwd: m.dir, env: m.env })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => { if (code === 0) resolve(stdout); else reject(new Error(`git patch-id exited with ${code ?? 'a signal'}`)) })
    child.stdin.end(diff)
  })
  // An empty change has no patch, and no id.
  return out.split(' ')[0]?.trim() || 'empty'
}

// Whether `head` merges into `main` without conflicts, without touching any
// checkout: git exits 0 for a clean merge and 1 with the conflicted files.
export async function mergeTree(m: Mirror, main: string, head: string): Promise<{ clean: true } | { clean: false; files: string[] }> {
  try {
    await git(m, ['merge-tree', '--write-tree', '--name-only', '--no-messages', main, head])
    return { clean: true }
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 1) throw error
    const stdout = 'stdout' in error ? String(error.stdout) : ''
    return { clean: false, files: stdout.split('\n').slice(1).filter(Boolean) }
  }
}

const STATUS: Record<string, FileChange['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'modified' }

// Each file `head` changed since `base`, with its content before and after and
// the numbers of the lines it added.
export async function changes(m: Mirror, base: string, head: string): Promise<FileChange[]> {
  const names = (await git(m, ['diff', '--name-status', '-z', '-M', base, head])).split('\0').filter(Boolean)
  const entries: { status: FileChange['status']; path: string; from: string | null }[] = []
  for (let i = 0; i < names.length;) {
    const code = (names[i] ?? '').charAt(0)
    const status = STATUS[code]
    if (status === undefined) throw new Error(`git reported a change it calls ${names[i] ?? ''}`)
    if (status === 'renamed') {
      entries.push({ status, from: names[i + 1] ?? '', path: names[i + 2] ?? '' })
      i += 3
    } else {
      entries.push({ status, from: null, path: names[i + 1] ?? '' })
      i += 2
    }
  }
  // With -z each entry is "added<TAB>deleted<TAB>path", or for a rename
  // "added<TAB>deleted<TAB>" followed by the old and new paths. Binary files count "-".
  const counts = new Map<string, { added: number; deleted: number; binary: boolean }>()
  const numbers = (await git(m, ['diff', '--numstat', '-z', '-M', base, head])).split('\0')
  for (let i = 0; i < numbers.length; i++) {
    // A path may hold a tab, so only the first two tabs split the entry.
    const [added = '', deleted = '', ...rest] = (numbers[i] ?? '').split('\t')
    const path = rest.join('\t')
    if (!added) continue
    const binary = added === '-'
    let target = path
    if (!target) {
      target = numbers[i + 2] ?? ''
      i += 2
    }
    counts.set(target, { added: binary ? 0 : Number(added), deleted: binary ? 0 : Number(deleted), binary })
  }
  // Node reads a name that is not UTF-8 with U+FFFD in place of its bytes, so
  // two files can come out as one path, and the gates would read one of them
  // twice and the other never.
  const listed = entries.map((e) => e.path)
  const twice = new Set(listed.filter((path, i) => listed.indexOf(path) !== i))
  const out: FileChange[] = []
  for (const entry of entries) {
    const count = counts.get(entry.path)
    if (!count) throw new Error(`git listed ${entry.path} as changed and gave no line counts for it`)
    // Each file's diff is read alone, through a literal pathspec, so no line
    // of one file's diff can pass for another file's header.
    const paths = entry.from === null ? [entry.path] : [entry.from, entry.path]
    const diff = await git(m, ['-c', 'diff.suppressBlankEmpty=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', base, head, '--', ...paths.map((p) => `:(literal)${p}`)])
    const addedLines = hunkAdds(diff)
    const sizeAt = async (commit: string, path: string) => Number((await git(m, ['cat-file', '-s', `${commit}:${path}`])).trim())
    const readable = async (commit: string, path: string | null) => {
      if (path === null || count.binary) return null
      return (await sizeAt(commit, path)) > READ_LIMIT ? null : git(m, ['show', `${commit}:${path}`])
    }
    out.push({
      ...entry, ...count,
      addedLines,
      untrusted: untrusted(paths, addedLines, count.added, twice),
      image: count.binary && entry.status !== 'deleted' ? imageFormat(await firstBytes(m, head, entry.path, IMAGE_HEAD_BYTES)) : null,
      before: entry.status === 'added' ? null : await readable(base, entry.from ?? entry.path),
      after: entry.status === 'deleted' ? null : await readable(head, entry.path),
      bytes: entry.status === 'deleted' ? null : await sizeAt(head, entry.path),
      diff,
    })
  }
  return out
}

// git quotes a path holding a double quote, a backslash or a control
// character, even with core.quotePath off.
const quotedByGit = (path: string) => {
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i)
    if (code < 0x20 || code === 0x7f || code === 0x22 || code === 0x5c) return true
  }
  return false
}

// Why the gates cannot trust a file's diff, or null when they can. git quotes
// a path holding a quote, a backslash or a control character. A path holding
// U+FFFD may be a name that is not UTF-8, which reads the same as another
// file's, and `shared` holds the paths git lists for more than one change. A
// diff whose hunks add another number of lines than git counts was misread.
export function untrusted(paths: readonly string[], added: ReadonlySet<number>, counted: number, shared: ReadonlySet<string>): string | null {
  const quoted = paths.find(quotedByGit)
  if (quoted !== undefined) return `git quotes the path ${JSON.stringify(quoted)}, which holds a quote, a backslash or a control character, so the gates cannot match it to its diff. Rename the file.`
  const replaced = paths.find((p) => p.includes('\uFFFD'))
  if (replaced !== undefined) return `the path ${JSON.stringify(replaced)} holds U+FFFD, which is how a name that is not UTF-8 reads, so the gates cannot tell it from another file. Rename the file.`
  const twice = paths.find((p) => shared.has(p))
  if (twice !== undefined) return `git lists ${JSON.stringify(twice)} for more than one change, so the gates cannot tell which file they read. Rename the files.`
  if (added.size !== counted) return `git counts ${counted} added lines and the diff's hunks add ${added.size}, so no gate can trust which lines are new.`
  return null
}

// The numbers of the lines one file's diff adds. Each hunk is read by the
// counts in its header, so no line inside a hunk is taken for a header, and a
// hunk that breaks its counts throws.
export function hunkAdds(diff: string): Set<number> {
  const out = new Set<number>()
  const lines = diff.split('\n')
  for (let i = 0; i < lines.length;) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i++] ?? '')
    if (!hunk) continue
    let old = Number(hunk[1] ?? 1)
    let added = Number(hunk[3] ?? 1)
    let next = Number(hunk[2])
    while (old > 0 || added > 0) {
      const line = lines[i++]
      if (line === undefined) throw new Error('a hunk ended before its counts did')
      if (line.startsWith('\\')) continue
      if (line.startsWith('-') && old > 0) old--
      else if (line.startsWith('+') && added > 0) {
        out.add(next++)
        added--
      } else if (line.startsWith(' ') && old > 0 && added > 0) {
        old--
        added--
        next++
      } else throw new Error(`a hunk holds a line its counts do not allow: ${JSON.stringify(line.slice(0, 40))}`)
    }
  }
  return out
}

// The first bytes of a file at a commit, read without the rest of it.
function firstBytes(m: Mirror, commit: string, path: string, n: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', 'blob', `${commit}:${path}`], { cwd: m.dir, env: m.env })
    const chunks: Buffer[] = []
    let size = 0
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      size += chunk.length
      if (size >= n) child.kill()
    })
    child.on('error', reject)
    child.on('close', () => { resolve(Buffer.concat(chunks).subarray(0, n)) })
  })
}
