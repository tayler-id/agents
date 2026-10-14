// Lock files that are whole from their first moment. A lock is written under a
// temporary name and then linked into place, which fails when the lock already
// exists, so a reader never finds an empty or half-written lock and takes it for
// a stale one.

import { randomBytes } from 'node:crypto'
import { linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hasCode } from '../shared/errors.ts'

// Makes the lock with this content, or returns false when someone holds it.
export function claimFile(path: string, content: string): boolean {
  const temporary = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temporary, content)
  try {
    linkSync(temporary, path)
    return true
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return false
    throw error
  } finally {
    rmSync(temporary, { force: true })
  }
}

// A lock's content parsed as JSON, or null when it is gone or is not JSON, which
// only a lock from before locks were written whole can be.
export function readLock(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null
    throw error
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}
