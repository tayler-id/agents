// The programs agents-git starts and may have to stop: a step, the suite, npm ci. Each
// runs in a process group of its own, so one signal reaches everything it started. A
// signal to agents-git stops the program the way a time limit does, TERM first and KILL
// after a grace, and then ends the command through its own cleanup, so a lock, a scratch
// worktree or a half-made install is never left behind.

import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { constants as os } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { parseEnv } from 'node:util'
import { errorCode } from './ledger.ts'

// A program told to stop gets this long to stop its own children before it is killed.
export const KILL_GRACE_MS = 5_000
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

// Main's env files, which a check loads in this order. agents-git reads only the names
// they set, never a value.
export const envFilesOf = (main: string) => [join(main, '.env'), join(main, '.env.test')]

// Settings that say which database, or which Agents, a program talks to, left out even
// where main's env files don't set them.
const pointsSomewhere = (name: string) => name === 'DATABASE_URL' || name.startsWith('PG') || name.startsWith('AGENTS_')

// The environment for a program agents-git starts in a repo whose main checkout is main.
// Node's --env-file never overrides a variable that is already set, so one left in the
// caller's shell would beat main's env files, and a check could reach the live database
// or Electric. A program is given no variable the files set and none of the settings
// above, so the files decide. A file main lacks sets nothing, and check and land refuse
// to run without it. npm's script and a step's own children start node from the PATH,
// so the node running agents-git goes first, after any folders the caller puts in front
// of it. extra is added after the variables are left out, so a caller can pass one on.
export function childEnv(main: string, extra: Record<string, string> = {}, first: readonly string[] = []): NodeJS.ProcessEnv {
  const setByFiles = new Set(envFilesOf(main).filter((file) => existsSync(file)).flatMap((file) => Object.keys(parseEnv(readFileSync(file, 'utf8')))))
  const path = [...first, dirname(process.execPath), ...(process.env.PATH ? [process.env.PATH] : [])].join(delimiter)
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !setByFiles.has(name) && !pointsSomewhere(name)))
  return { ...inherited, ...extra, PATH: path }
}

// The program running now, the signal that asked to stop it if one came, and the
// timer that kills it when it ignores TERM.
export type Running = { child: ChildProcess | null, stopped: NodeJS.Signals | null, grace: NodeJS.Timeout | null }

// What a command throws when a signal ended it, after its programs were stopped.
export class Stopped extends Error {
  signal: NodeJS.Signals

  constructor(signal: NodeJS.Signals) {
    super(`${signal} ended the command, and it cleaned up what it held`)
    this.signal = signal
  }
}

// The exit code a shell reports for a process that a signal killed.
export const exitCodeOf = (signal: NodeJS.Signals) => 128 + os.signals[signal]

// Signals a program and every process it started, which share its process group.
export function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    // ESRCH says the group has no process left, which is what stopping it wants. macOS
    // answers EPERM when every member has exited and waits to be reaped, which is the same.
    const code = errorCode(error)
    if (code !== 'ESRCH' && code !== 'EPERM') throw error
  }
}

// Runs work with SIGINT, SIGTERM and SIGHUP handled. The first one sends TERM to the
// program that is running and KILL after the grace, and the next program work starts
// throws Stopped instead of starting, so work ends through its own finally blocks. One
// that comes after work's last program throws Stopped once work ends, so the caller
// goes no further, as land must not move main. A signal that comes while one is being
// handled changes nothing.
export async function stoppable<T>(work: (running: Running) => Promise<T>): Promise<T> {
  const running: Running = { child: null, stopped: null, grace: null }
  const stop = (signal: NodeJS.Signals) => {
    if (running.stopped !== null) return
    running.stopped = signal
    const pid = running.child?.pid
    if (pid === undefined) return
    killGroup(pid, 'SIGTERM')
    running.grace = setTimeout(() => { killGroup(pid, 'SIGKILL') }, KILL_GRACE_MS)
  }
  for (const signal of SIGNALS) process.on(signal, stop)
  try {
    const result = await work(running)
    const late = stoppedBy(running)
    if (late) throw new Stopped(late)
    return result
  } finally {
    for (const signal of SIGNALS) process.off(signal, stop)
    if (running.grace) clearTimeout(running.grace)
  }
}

// A signal can arrive while a program runs, so this is read again after each wait, through a
// function, since the compiler would take a flag it just saw unset to still be unset.
const stoppedBy = (running: Running) => running.stopped

export type Group = { code: number | null, timedOut: boolean, seconds: number }

// Runs a program to completion or its limit, in a process group of its own, with its
// output in log. Past the limit the whole group gets TERM, then KILL after the grace,
// and whatever the program left running is killed when it ends. Throws Stopped when a
// signal asked agents-git to stop, either before it starts or while it runs.
export async function runGroup(running: Running, argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv, limitSec: number, log: string): Promise<Group> {
  const before = stoppedBy(running)
  if (before) throw new Stopped(before)
  mkdirSync(dirname(log), { recursive: true })
  const fd = openSync(log, 'w', 0o600)
  const started = Date.now()
  const [program = '', ...args] = argv
  const child = spawn(program, args, { cwd, env, stdio: ['ignore', fd, fd], detached: true })
  closeSync(fd)
  running.child = child
  const timedOut = { now: false }
  const timers: NodeJS.Timeout[] = []
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', () => {
      const pid = child.pid
      if (pid === undefined) return
      timers.push(setTimeout(() => {
        timedOut.now = true
        killGroup(pid, 'SIGTERM')
        timers.push(setTimeout(() => { killGroup(pid, 'SIGKILL') }, KILL_GRACE_MS))
      }, limitSec * 1000))
    })
    child.once('exit', (exit) => { resolve(exit) })
  })
  for (const timer of timers) clearTimeout(timer)
  if (running.grace) clearTimeout(running.grace)
  running.grace = null
  // Whatever the program started and left running goes with it.
  if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL')
  running.child = null
  const after = stoppedBy(running)
  if (after) throw new Stopped(after)
  return { code, timedOut: timedOut.now, seconds: Math.round((Date.now() - started) / 100) / 10 }
}
