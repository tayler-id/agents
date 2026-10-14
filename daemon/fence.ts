// Stops the harness processes a daemon's last run left behind, before the new
// run resumes their sessions. Two processes on one conversation would both write
// its transcript. Each harness's process id is in AGENTS_HOME/sessions as
// <session>.pid, and a process is stopped only while its command line still
// names that session's MCP config file, since the id may belong to another
// process by now, or come from another container.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

// How long a killed process gets to disappear before the daemon gives up on it.
const GONE_WITHIN_MS = 5000

const pidFile = (dir: string, sessionId: string) => join(dir, `${sessionId}.pid`)

export function rememberHarness(dir: string, sessionId: string, pid: number) {
  writeFileSync(pidFile(dir, sessionId), String(pid))
}

// Removes the record of a harness that exited, unless a newer process for the
// same session has replaced it.
export function forgetHarness(dir: string, sessionId: string, pid: number) {
  const file = pidFile(dir, sessionId)
  if (existsSync(file) && readFileSync(file, 'utf8') === String(pid)) rmSync(file)
}

// Every process running, with its parent, read from ps.
function processTable(): { pid: number; parent: number; command: string }[] {
  return execFileSync('ps', ['-ww', '-eo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line)
    return match?.[1] && match[2] ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] ?? '' }] : []
  })
}

// Every process below `pid`.
export function descendants(pid: number, table = processTable()): number[] {
  const below: number[] = []
  let frontier = [pid]
  while (frontier.length) {
    const next = table.filter((row) => frontier.includes(row.parent)).map((row) => row.pid)
    below.push(...next)
    frontier = next
  }
  return below
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: no such process.
    return false
  }
}

export function killAll(pids: number[]) {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

// Stops each harness the last run left, with every process under it, and
// returns the sessions whose harness it stopped. A harness's record goes once
// its processes have, so after a failure the next start tries again.
export async function stopLeftHarnesses(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const table = processTable()
  const stopped: { sessionId: string; file: string; tree: number[] }[] = []
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.pid'))) {
    const sessionId = name.slice(0, -'.pid'.length)
    const file = join(dir, name)
    const pid = Number(readFileSync(file, 'utf8'))
    // A process id that is gone, or belongs to another process by now, has nothing to stop.
    if (!table.find((entry) => entry.pid === pid)?.command.includes(`${sessionId}.mcp.json`)) {
      rmSync(file)
      continue
    }
    const tree = [pid, ...descendants(pid, table)]
    killAll(tree)
    stopped.push({ sessionId, file, tree })
  }
  const deadline = Date.now() + GONE_WITHIN_MS
  while (stopped.some(({ tree }) => tree.some(alive)) && Date.now() < deadline) await sleep(50)
  for (const { file, tree } of stopped) if (!tree.some(alive)) rmSync(file)
  const left = stopped.flatMap(({ tree }) => tree.filter(alive))
  if (left.length) throw new Error(`processes ${left.join(', ')} from the last run would not stop`)
  return stopped.map(({ sessionId }) => sessionId)
}
