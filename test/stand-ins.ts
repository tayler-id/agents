// Stops each stand-in for Claude that a check's daemon left running under `home`,
// with the MCP servers it started. A daemon that stops leaves a busy session's
// process running, for its next start to resume, and a check's daemon has no next
// start. Each stand-in logs its start in `.fake/starts.jsonl` in the session's
// folder. A logged PID is stopped only while its command line is still a
// stand-in's, since the PID may belong to another process by now.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const Start = z.looseObject({ pid: z.number().int() })
// A session's folder is an agent's folder or a task's workspace, two levels below the daemon's home.
const FOLDER_DEPTH = 2

function loggedPids(dir: string, depth: number): number[] {
  const log = join(dir, '.fake', 'starts.jsonl')
  const here = existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(Boolean).flatMap((line) => Start.safeParse(JSON.parse(line)).data?.pid ?? [])
    : []
  if (depth === 0 || !existsSync(dir)) return here
  const below = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== '.fake')
    .flatMap((entry) => loggedPids(join(dir, entry.name), depth - 1))
  return [...here, ...below]
}

export function stopStandIns(home: string): number {
  const table = execFileSync('ps', ['-ww', '-eo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').flatMap((line) => {
    const found = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return found?.[1] && found[2] && found[3] !== undefined ? [{ pid: Number(found[1]), parent: Number(found[2]), command: found[3] }] : []
  })
  const standIns = new Set(loggedPids(home, FOLDER_DEPTH).filter((pid) => table.some((p) => p.pid === pid && p.command.includes('test/fake-claude'))))
  const children = table.filter((p) => standIns.has(p.parent)).map((p) => p.pid)
  for (const pid of [...standIns, ...children]) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone since ps listed it.
    }
  }
  return standIns.size
}
