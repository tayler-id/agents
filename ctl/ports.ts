// Port blocks for instances. Each instance takes three ports in a row: the
// machine door, the people door and the stream server. A block is claimed with
// a lock file per port, created exclusively, so two `up`s on this Mac, from any
// worktree, never pick the same block, and then each port is test-bound, so a
// port some other program holds is skipped.

import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { LIVE_PORTS, PORT_RANGE } from './config.ts'
import { Refused } from '../shared/cli/output.ts'
import { stateFile, type InstanceName, type Ports } from './state.ts'

export const PORTS_PER_INSTANCE = 3
const LOCKS = join(tmpdir(), 'agentsctl', 'ports')
const Lock = z.object({ instance: z.string(), stateFile: z.string() })

const blockOf = (first: number): Ports => ({ machines: first, people: first + 1, streams: first + 2 })
const portsOf = (ports: Ports) => [ports.machines, ports.people, ports.streams]

function free(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => { resolve(false) })
    server.listen(port, '127.0.0.1', () => { server.close(() => { resolve(true) }) })
  })
}

// A lock is stale when the instance that wrote it has no state file any more.
function stale(port: number): boolean {
  const file = join(LOCKS, String(port))
  if (!existsSync(file)) return true
  const lock = Lock.safeParse(JSON.parse(readFileSync(file, 'utf8')))
  return !lock.success || !existsSync(lock.data.stateFile)
}

function lockPort(port: number, name: InstanceName): boolean {
  mkdirSync(LOCKS, { recursive: true })
  const file = join(LOCKS, String(port))
  if (existsSync(file) && stale(port)) rmSync(file)
  try {
    writeFileSync(file, JSON.stringify({ instance: name, stateFile: stateFile(name) }), { flag: 'wx' })
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false
    throw error
  }
}

export function releasePorts(ports: Ports, name: InstanceName) {
  for (const port of portsOf(ports)) {
    const file = join(LOCKS, String(port))
    if (!existsSync(file)) continue
    const lock = Lock.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    if (lock.success && lock.data.instance === name) rmSync(file)
  }
}

// The first free block in the range, or the block starting at `first`.
export async function claimPorts(name: InstanceName, first?: number): Promise<Ports> {
  const starts: number[] = []
  if (first !== undefined) starts.push(first)
  else for (let p = PORT_RANGE.first; p + PORTS_PER_INSTANCE - 1 <= PORT_RANGE.last; p += PORTS_PER_INSTANCE) starts.push(p)
  const tried: string[] = []
  for (const start of starts) {
    const block = blockOf(start)
    const ports = portsOf(block)
    if (ports.some((p) => LIVE_PORTS.includes(p))) throw new Refused(`ports ${ports.join(', ')} include one the live system uses`, ['Run `bin/agentsctl up` without --port to take a free block in 8020-8039'])
    const locked: number[] = []
    for (const port of ports) {
      if (!lockPort(port, name)) break
      locked.push(port)
    }
    const bound = locked.length === ports.length && (await Promise.all(ports.map(free))).every(Boolean)
    if (bound) return block
    tried.push(`${String(start)}-${String(start + PORTS_PER_INSTANCE - 1)}`)
    for (const port of locked) rmSync(join(LOCKS, String(port)))
  }
  throw new Refused(`no free block of ${String(PORTS_PER_INSTANCE)} ports: tried ${tried.join(', ')}`, [
    'Run `bin/agentsctl list` to see the instances in this checkout, and `bin/agentsctl down --instance <name>` to stop one',
    'Or pass `--port <first>` for a block you know is free',
  ])
}
