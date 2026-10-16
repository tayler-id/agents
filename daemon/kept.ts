// The folders whose sessions stay on this Mac because their person turned them
// Off, whatever folder they are in is connected. Each is a file in
// $AGENTS_HOME/kept, named by a hash of the folder's path and holding the path,
// so the folders command and the app's socket each add or take one away whole,
// and neither loses the other's. The list never leaves the Mac.
// daemon/folders.ts changes it, the daemon reads it before it takes or sends a
// session, and the app's list shows it. docs/design/local-sessions.md has the rule.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasCode } from '../shared/errors.ts'
import { parseJson } from '../shared/json.ts'
import { FolderPath } from '../shared/terminal.ts'

const keptDir = (home: string) => join(home, 'kept')
const fileOf = (home: string, path: string) => join(keptDir(home), `${createHash('sha256').update(path).digest('hex')}.json`)

// The folders turned Off on this Mac. A file that doesn't hold one is an error
// that names it, since leaving it out would send what its person kept here.
export function keptFolders(home: string): string[] {
  let names: string[]
  try {
    names = readdirSync(keptDir(home)).filter((name) => name.endsWith('.json'))
  } catch (error) {
    // No folder was ever turned Off on this Mac.
    if (hasCode(error, 'ENOENT')) return []
    throw error
  }
  const kept: string[] = []
  for (const name of names) {
    const file = join(keptDir(home), name)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      // Taken away since the folder was listed, by a connect.
      if (hasCode(error, 'ENOENT')) continue
      throw error
    }
    const path = parseJson(FolderPath, text)
    if (!path.ok) throw new Error(`${file} should hold the path of a folder turned Off, and doesn't: ${path.reason}`)
    kept.push(path.value)
  }
  return kept
}

// Keeps a folder's sessions on this Mac, and says whether it was kept already.
export function keep(home: string, path: string): boolean {
  const file = fileOf(home, FolderPath.parse(path))
  if (existsSync(file)) return true
  mkdirSync(keptDir(home), { recursive: true, mode: 0o700 })
  // Written whole under another name first, so a read never finds half of it.
  const next = `${file}.${process.pid}.next`
  writeFileSync(next, JSON.stringify(path), { mode: 0o600 })
  renameSync(next, file)
  return false
}

// The folder's own Team or Just me takes the place of its Off.
export function unkeep(home: string, path: string): void {
  rmSync(fileOf(home, path), { force: true })
}
