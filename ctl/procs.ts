// The processes an instance starts. Each starts in its own process group, so
// everything it spawns (Claude processes, checks, git, browsers) can be found and
// stopped with it. A process is only ever signalled after ps shows the same start
// time and command line that were recorded when it started, so a later process
// that reuses its pid is never touched. Nothing here finds a process by name.

import { execFile, spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ProcessRecord, ProcessRole } from './state.ts'
import { hasCode } from '../shared/errors.ts'

const run = promisify(execFile)
// How often stop() looks again while a process shuts down.
const POLL_MS = 200

async function ps(args: string[]): Promise<string> {
  try {
    return (await run('ps', args)).stdout
  } catch (error) {
    // ps exits 1 when no process matches, which is an answer, not a failure.
    if (hasCode(error, 1)) return ''
    throw error
  }
}

// When a process started, as ps prints it, and its command line, or null once it has exited.
export async function describe(pid: number): Promise<{ started: string; command: string } | null> {
  const line = (await ps(['-ww', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)])).trim()
  if (!line) return null
  const words = line.split(/\s+/)
  // lstart is five words, such as "Tue Oct 13 12:01:02 2026".
  return { started: words.slice(0, 5).join(' '), command: words.slice(5).join(' ') }
}

export async function spawnRecorded(role: ProcessRole, argv: string[], options: { cwd: string; env: Record<string, string>; log: string }): Promise<ProcessRecord> {
  const [command, ...args] = argv
  if (!command) throw new Error(`no command to start the ${role}`)
  const fd = openSync(options.log, 'a')
  try {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', fd, fd] })
    const pid = child.pid
    if (pid === undefined) throw new Error(`the ${role} did not start: ${command} ${args.join(' ')}`)
    child.unref()
    const seen = await describe(pid)
    if (!seen) throw new Error(`the ${role} exited at once. Its log is ${options.log}`)
    return { role, pid, started: seen.started, argv, log: options.log }
  } finally {
    closeSync(fd)
  }
}

// Whether the recorded process is still running, and still the same process.
export async function isOurs(record: Pick<ProcessRecord, 'pid' | 'started' | 'argv'>): Promise<boolean> {
  const seen = await describe(record.pid)
  return seen !== null && seen.started === record.started && seen.command === record.argv.join(' ')
}

type Row = { pid: number; ppid: number; pgid: number }

async function table(): Promise<Row[]> {
  const out = await ps(['-ax', '-o', 'pid=,ppid=,pgid='])
  return out.split('\n').flatMap((line) => {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number)
    return pid && ppid !== undefined && pgid !== undefined ? [{ pid, ppid, pgid }] : []
  })
}

export type Owned = { pid: number; started: string; command: string }

// The live children of a process, each with what identifies it later.
export async function childrenOf(parent: number): Promise<Owned[]> {
  const found: Owned[] = []
  for (const row of await table()) {
    if (row.ppid !== parent) continue
    const seen = await describe(row.pid)
    if (seen) found.push({ pid: row.pid, ...seen })
  }
  return found
}

// Every live process an instance owns: each recorded process that is still the
// same process, everything descended from it, and anything left in its process
// group after it exited. A group id cannot be handed to a new process while any
// member of the group is alive, so the members of a group whose leader is gone
// are still ours.
export async function owned(records: ProcessRecord[]): Promise<Owned[]> {
  const rows = await table()
  const pids = new Set<number>()
  for (const record of records) {
    const alive = rows.some((r) => r.pid === record.pid)
    if (alive && !(await isOurs(record))) continue
    if (alive) pids.add(record.pid)
    for (const r of rows) if (r.pgid === record.pid) pids.add(r.pid)
  }
  for (let grew = true; grew;) {
    grew = false
    for (const r of rows) {
      if (pids.has(r.ppid) && !pids.has(r.pid)) {
        pids.add(r.pid)
        grew = true
      }
    }
  }
  const found: Owned[] = []
  for (const pid of pids) {
    const seen = await describe(pid)
    if (seen) found.push({ pid, ...seen })
  }
  return found.sort((a, b) => a.pid - b.pid)
}

const signal = (pid: number, name: NodeJS.Signals) => {
  try {
    process.kill(pid, name)
  } catch (error) {
    // ESRCH: it exited between the look and the signal, which is what we wanted.
    if (!(hasCode(error, 'ESRCH'))) throw error
  }
}

// Asks the processes to stop, then makes them, after checking each is still the
// process that was found. Returns the ones that would not stop.
export async function stop(processes: Owned[], graceMs: number): Promise<Owned[]> {
  const current = async () => {
    const left: Owned[] = []
    for (const p of processes) if (await isOurs({ pid: p.pid, started: p.started, argv: [p.command] })) left.push(p)
    return left
  }
  for (const p of await current()) signal(p.pid, 'SIGTERM')
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && (await current()).length) await sleep(POLL_MS)
  for (const p of await current()) signal(p.pid, 'SIGKILL')
  await sleep(POLL_MS)
  return current()
}
