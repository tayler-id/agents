// Secret values the daemon learns on the Mac besides its own environment's: what
// the person's login shell exports, and what a connected folder's .env files
// hold. They are used only to scrub what leaves the Mac, and never leave it.

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { MIN_SECRET_LENGTH } from '../shared/scrub.ts'

export type Secrets = [string, string][]

// A value that names something on this Mac, or a list of paths such as PATH,
// says where things are and is not a credential. Scrubbing it would hide every
// path under it, a connected folder's own included.
function isPath(value: string): boolean {
  if (value.startsWith('/') && existsSync(value)) return true
  return value.includes(':') && value.split(':').every((part) => part === '' || part.startsWith('/'))
}

// Every value long enough to be a secret, whatever its name. A name filter misses
// REDIS_URL with a password in it, MONGODB_URI and SMTP_PASS.
export function unnamedSecrets(entries: [string, string][]): Secrets {
  return entries.filter(([, value]) => value.length >= MIN_SECRET_LENGTH && !isPath(value))
}

// A login shell that loads a version manager can take a few seconds to start.
const SHELL_TIMEOUT_MS = 20_000
const START = 'AGENTS-ENV-START'
const END = 'AGENTS-ENV-END'
// Prints the environment between two marks, with a NUL after each entry, so
// anything the startup files print is left out and a value may hold a newline.
const PRINT_ENV = `echo ${START}; env -0; echo; echo ${END}`

// What the person's login shell exports beyond the daemon's own environment. The
// daemon runs under launchd, which never runs the shell's startup files, so a
// token exported in ~/.zshrc reaches the person's terminal sessions but not the
// daemon. The shell starts from the daemon's environment, so whatever it adds
// or changes came from those files.
export function loginShellSecrets(): Promise<Secrets> {
  const shell = process.env.SHELL ?? userInfo().shell
  return new Promise((resolve, reject) => {
    if (!shell) {
      reject(new Error('neither SHELL nor the user record names a login shell'))
      return
    }
    // stdin is closed, so a startup file that asks for input reads nothing and goes on.
    const child = spawn(shell, ['-l', '-i', '-c', PRINT_ENV], { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, SHELL_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const out = Buffer.concat(chunks).toString('utf8')
      const from = out.indexOf(`${START}\n`)
      const to = out.lastIndexOf(`\n${END}`)
      if (from < 0 || to < from) {
        // The output is never quoted here, since it may hold the very values this protects.
        const how = signal === 'SIGKILL' ? `took over ${SHELL_TIMEOUT_MS / 1000} s` : `exited ${String(code ?? signal)}`
        reject(new Error(`${shell} -l -i ${how} without printing its environment`))
        return
      }
      const entries = out.slice(from + START.length + 1, to).split('\0').flatMap((entry): [string, string][] => {
        const at = entry.indexOf('=')
        return at > 0 ? [[entry.slice(0, at), entry.slice(at + 1)]] : []
      })
      resolve(unnamedSecrets(entries.filter(([name, value]) => process.env[name] !== value)))
    })
  })
}

// Folders a .env walk never enters. Neither holds the person's own .env files,
// and the two held 38,800 of the 42,800 folders in this repo's main checkout.
const SKIPPED = new Set(['node_modules', '.git'])
const DOTENV = /^\.env(\..+)?$/

// A folder that is gone, or that the person can't read either, so Claude can't
// read a .env file in it. macOS privacy settings answer EPERM instead, to the
// daemon alone, and that is an error the caller has to stop on.
const unreadable = (error: unknown) =>
  error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'EACCES', 'EISDIR'].includes(String(error.code))

type Listing = { mtimeMs: number; files: string[]; dirs: string[] }

function listingOf(dir: string, last: Listing | undefined): Listing | undefined {
  let mtimeMs: number
  try {
    mtimeMs = statSync(dir).mtimeMs
  } catch (error) {
    if (unreadable(error)) return undefined
    throw error
  }
  // A folder's mtime changes when an entry in it is added, removed or renamed.
  if (last?.mtimeMs === mtimeMs) return last
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (unreadable(error)) return undefined
    throw error
  }
  const files = entries.filter((e) => !e.isDirectory() && DOTENV.test(e.name)).map((e) => join(dir, e.name))
  // Links to folders are not followed, so a link can't lead the walk in a circle.
  const dirs = entries.filter((e) => e.isDirectory() && !SKIPPED.has(e.name)).map((e) => join(dir, e.name))
  return { mtimeMs, files, dirs }
}

// Finds every .env file under a folder. Each walk stats every folder in it, and
// lists one again only when its mtime changed since the walk before.
export function dotenvFinder(): (root: string) => string[] {
  let listings = new Map<string, Listing>()
  return (root) => {
    const seen = new Map<string, Listing>()
    const files: string[] = []
    const stack = [root]
    for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
      const listing = listingOf(dir, listings.get(dir))
      if (!listing) continue
      seen.set(dir, listing)
      files.push(...listing.files)
      stack.push(...listing.dirs)
    }
    listings = seen
    return files
  }
}

// The values in .env files, read again each time, so one changed since is scrubbed too.
export function dotenvSecrets(files: string[]): Secrets {
  return files.flatMap((file) => {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      // Gone since the walk, a link to nothing, or one the person can't read either.
      if (unreadable(error)) return []
      throw error
    }
    return unnamedSecrets(Object.entries(parseEnv(text)).filter((entry): entry is [string, string] => entry[1] !== undefined))
  })
}
