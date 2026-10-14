// Signs this box in to a person's own Claude account with `claude setup-token`.
// The CLI draws a full-screen terminal interface, which needs a terminal, so it
// runs under util-linux's `script` with a pseudo-terminal. It prints a sign-in link as a
// terminal hyperlink and waits at "Paste code here if prompted >". The person
// opens the link, approves, and pastes the code Claude's page shows into the
// app, which hands it to this box once. The CLI exchanges it, with the PKCE
// secret only this process holds, for a token it prints. The token is saved in
// this box's home and goes nowhere else. See docs/design/onboarding.md.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PARENT_SESSION_ENV } from './claude.ts'

// `script -c` runs its command through a shell, so the command is fixed text and
// the CLI's path reaches it in an environment variable, never inside the text.
// A wide terminal keeps Ink from wrapping the link or the token across lines.
const COMMAND = 'stty cols 4000 rows 50 && exec "$AGENTS_SIGN_IN_CLAUDE" setup-token'
// The CLI's first start in a fresh box takes a few seconds; this leaves room for a slow one.
const LINK_WAIT_MS = 90_000
// A person needs a few minutes to sign in and approve. After this the link is abandoned.
const SIGN_IN_WAIT_MS = 15 * 60_000
// Once the code is typed, the CLI exchanges it with Anthropic in a second or two.
const TOKEN_WAIT_MS = 60_000
// The CLI's whole screen is a few kilobytes. Older output is dropped beyond this.
const OUTPUT_KEPT = 256 * 1024
// The CLI treats a burst of characters and the Enter key that ends it as one
// paste unless Enter comes on its own a moment later.
const ENTER_AFTER_MS = 300
// Credentials meant for agent sessions, never for signing in.
const CREDENTIALS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']

const ESC = '\u001b'
const BEL = '\u0007'
// OSC 8, a terminal hyperlink: ESC ] 8 ; params ; URI, ended by BEL or ESC \.
const HYPERLINK = new RegExp(`${ESC}\\]8;[^;${BEL}${ESC}]*;(https://[^${BEL}${ESC}]+)(?:${BEL}|${ESC}\\\\)`)
// The token on screen ends where the CLI's colour code, a space or the line does.
// Output can arrive cut partway through it, so the end of what has arrived so far
// never counts as its end.
const TOKEN_ON_SCREEN = new RegExp(`sk-ant-oat\\d{2}-[A-Za-z0-9_-]{20,}(?=[\\s${ESC}${BEL}])`)
// A token as this box saves it.
const SAVED_TOKEN = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}$/
const DAYS_IN_YEAR = 365

// The screen as text. The CLI places words and lines with cursor moves rather
// than spaces and line breaks, so a move to another line becomes a line break, a
// move along the line a space, and every other escape sequence goes.
export function plainText(raw: string): string {
  return raw
    .replace(new RegExp(`${ESC}\\[\\d*(?:;\\d*)?[BEHf]`, 'g'), '\n')
    .replace(new RegExp(`${ESC}\\[\\d*[CG]`, 'g'), ' ')
    .replace(new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g'), '')
    .replace(new RegExp(`${ESC}\\[[0-9;?<>=]*[ -/]*[@-~]`, 'g'), '')
    .replace(new RegExp(`${ESC}[@-Z\\\\-_]`, 'g'), '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
}

// The sign-in link, from its hyperlink or, failing that, from the text.
export function linkIn(raw: string): string | null {
  const link = HYPERLINK.exec(raw)?.[1] ?? /https:\/\/\S+\/oauth\/authorize\?\S+/.exec(plainText(raw))?.[0]
  return link && /\/oauth\/authorize\?/.test(link) ? link : null
}

export const tokenIn = (raw: string): string | null => TOKEN_ON_SCREEN.exec(raw)?.[0] ?? null

// How long the CLI says the token lasts: "valid for 1 year", "valid for 30 days" or "less than a day".
export function validDaysIn(raw: string): number | null {
  const said = /valid for\s+(1 year|(\d+) days?|less than a day)/.exec(plainText(raw))
  if (!said) return null
  if (said[1] === '1 year') return DAYS_IN_YEAR
  return said[2] === undefined ? 0 : Number(said[2])
}

// What the CLI said went wrong, such as "OAuth error: Failed to exchange authorization code".
export function problemIn(raw: string): string | null {
  return /(OAuth error:[^\n]*|Invalid code[^\n]*|Error:[^\n]*)/.exec(plainText(raw))?.[1]?.trim() ?? null
}

export type SignIn = {
  // The link the person opens. Rejects if the CLI fails or prints none in time.
  link: Promise<string>
  // Types the person's code at the CLI's prompt.
  enterCode(code: string): void
  // The token and how many days it lasts. Rejects with the CLI's reason.
  done: Promise<{ token: string; validDays: number }>
  stop(): void
}

export function signIn(claudeBin: string, home: string): SignIn {
  if (process.platform !== 'linux') throw new Error('Signing in to Claude from the app works on a box. Sign in on this machine with `claude` itself.')
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTS_SIGN_IN_CLAUDE: claudeBin, SHELL: '/bin/sh', TERM: 'xterm-256color', HOME: home }
  for (const name of [...PARENT_SESSION_ENV, ...CREDENTIALS]) delete env[name]
  const child = spawn('script', ['-q', '-e', '-E', 'never', '-c', COMMAND, '/dev/null'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  // Everything the CLI printed, and separately what it printed since the code
  // was typed, which is where its answer to the code appears.
  let output = ''
  let sinceCode: string | null = null
  let ended = false
  // Read through a function: the process's events change it while the steps below await.
  const hasEnded = () => ended
  const watchers = new Set<() => void>()
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-OUTPUT_KEPT)
    if (sinceCode !== null) sinceCode = (sinceCode + chunk.toString('utf8')).slice(-OUTPUT_KEPT)
    for (const watch of watchers) watch()
  }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  child.stdin.on('error', () => {
    // The CLI has gone; `done` reports why when the process closes.
  })
  const closed = new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      ended = true
      for (const watch of watchers) watch()
      resolve(code)
    })
    child.on('error', (error) => {
      ended = true
      output += `\nError: ${error.message}`
      for (const watch of watchers) watch()
      resolve(null)
    })
  })

  // Resolves with what `find` sees in the output, or rejects with the CLI's own
  // reason when it stops first, or when `ms` pass.
  const waitFor = <T>(read: () => string, find: (raw: string) => T | null, ms: number, what: string) => new Promise<T>((resolve, reject) => {
    const watch = () => {
      const found = find(read())
      if (found !== null) return finish(() => resolve(found))
      if (ended) return finish(() => reject(new Error(problemIn(read()) ?? `claude setup-token stopped before ${what}`)))
    }
    const timer = setTimeout(() => finish(() => reject(new Error(`claude setup-token gave no ${what} in time`))), ms)
    const finish = (settle: () => void) => {
      clearTimeout(timer)
      watchers.delete(watch)
      settle()
    }
    watchers.add(watch)
    watch()
  })

  const link = waitFor(() => output, linkIn, LINK_WAIT_MS, 'sign-in link')
  let entered: () => void = () => undefined
  const codeEntered = new Promise<void>((resolve) => { entered = resolve })
  const answer = () => sinceCode ?? ''
  const done = (async () => {
    try {
      await link
      await Promise.race([codeEntered, new Promise<never>((_resolve, reject) => {
        setTimeout(() => { reject(new Error('Nobody pasted a code within 15 minutes. Start the sign-in again.')) }, SIGN_IN_WAIT_MS).unref()
      })])
      // A refused code shows its reason while the CLI waits for Enter to try again.
      const token = await waitFor(answer, (raw) => tokenIn(raw) ?? (problemIn(raw) === null ? null : ''), TOKEN_WAIT_MS, 'token')
      if (!token) throw new Error(problemIn(answer()) ?? 'Claude did not accept the code.')
      await closed
      return { token, validDays: validDaysIn(answer()) ?? DAYS_IN_YEAR }
    } finally {
      if (!hasEnded()) child.kill('SIGTERM')
    }
  })()

  return {
    link,
    done,
    enterCode(code: string) {
      sinceCode = ''
      child.stdin.write(code)
      setTimeout(() => {
        child.stdin.write('\r')
        entered()
      }, ENTER_AFTER_MS)
    },
    stop() {
      if (!ended) child.kill('SIGTERM')
    },
  }
}

// The token lives in the box's home, which is its own volume.
const tokenFile = (home: string) => join(home, 'claude-token')

export function saveClaudeToken(home: string, token: string) {
  mkdirSync(dirname(tokenFile(home)), { recursive: true })
  const temp = `${tokenFile(home)}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(temp, `${token}\n`, { mode: 0o600, flag: 'wx' })
  renameSync(temp, tokenFile(home))
}

// The token this box signed in with, or null when its owner has not signed in.
export function ownClaudeToken(home: string): string | null {
  let saved: string
  try {
    saved = readFileSync(tokenFile(home), 'utf8').trim()
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  if (!SAVED_TOKEN.test(saved)) throw new Error(`${tokenFile(home)} does not hold a Claude token`)
  return saved
}
