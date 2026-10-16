// What the seat checks, steps 15c, 15d and 15g, share: a session's computer tools,
// pages that fill a seat's browser with one color, how to tell the colors apart
// on a screen, how to read a screenshot's pixels, where the dock's buttons are,
// and how much memory a computer and each of its seats hold.

import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { inflateSync } from 'node:zlib'
import pg from 'pg'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { docker, SCREEN, within } from './computers.ts'
import { DOCK_BUTTONS, DOCK_HEIGHT, type DockButton } from '../daemon/dock.ts'

// A session's `computer` MCP server in the box, started in the session's folder
// as the daemon's MCP config says, the way Claude Code starts it. Its `docker
// exec` keeps this check's environment, which the docker agents-git puts first
// on a check's PATH reads. The MCP client would otherwise pass it only a few
// variables, such as PATH and HOME.
export async function seatTools(container: string, sessionId: string, cwd: string) {
  const config = JSON.parse(docker('exec', container, 'cat', `/home/agent/.agents-app/sessions/${sessionId}.mcp.json`))
  const server = config.mcpServers.computer
  const env = Object.entries(server.env).flatMap(([key, value]) => ['-e', `${key}=${String(value)}`])
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const client = new Client({ name: 'seats-check', version: '1.0.0' })
  await client.connect(new StdioClientTransport({
    command: 'docker', args: ['exec', '-i', '-w', cwd, ...env, container, server.command, ...server.args], env: inherited,
  }))
  return { client, env: server.env }
}

// A page that fills a seat's browser with one color, named for the seat.
export const seatPage = (title: string, color: string) => `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><title>${title}</title><style>html,body{margin:0;height:100%;background:${color}}</style><h1>${title}</h1>`)}`
// A point well inside a seat's page, below its browser's toolbar.
export const IN_PAGE = { x: SCREEN.width / 2, y: SCREEN.height - 100 }
export const isRed = ([r, g, b]: number[]) => (r ?? 0) > 200 && (g ?? 255) < 60 && (b ?? 255) < 60
export const isBlue = ([r, g, b]: number[]) => (r ?? 255) < 60 && (g ?? 255) < 60 && (b ?? 0) > 200

// A screenshot's pixels. The screen service encodes RGB at 8 bits, with PNG's five row filters.
export type Pixels = { width: number; height: number; at(x: number, y: number): [number, number, number] }
export function pixelsOf(base64: string): Pixels {
  const png = Buffer.from(base64, 'base64')
  let width = 0
  let height = 0
  const data: Buffer[] = []
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    const body = png.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body.readUInt8(8) !== 8 || body.readUInt8(9) !== 2) throw new Error('the screenshot is not 8-bit RGB')
    }
    if (type === 'IDAT') data.push(body)
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * 3
  const rows = Buffer.alloc(stride * height)
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let row = 0; row < height; row++) {
    const filter = raw.readUInt8(row * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? rows.readUInt8(row * stride + i - 3) : 0
      const b = row > 0 ? rows.readUInt8((row - 1) * stride + i) : 0
      const c = i >= 3 && row > 0 ? rows.readUInt8((row - 1) * stride + i - 3) : 0
      const predicted = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0
      rows.writeUInt8((raw.readUInt8(row * (stride + 1) + 1 + i) + predicted) & 0xff, row * stride + i)
    }
  }
  return {
    width, height,
    at: (x, y) => [rows.readUInt8(y * stride + x * 3), rows.readUInt8(y * stride + x * 3 + 1), rows.readUInt8(y * stride + x * 3 + 2)],
  }
}

// The middle of a dock button on the screen. JWM makes each icon button as
// wide as the dock is tall inside its 1-pixel edge, from the left.
export function dockButton(button: DockButton): [number, number] {
  const size = DOCK_HEIGHT - 2
  return [1 + size * DOCK_BUTTONS.indexOf(button) + size / 2, SCREEN.height - DOCK_HEIGHT / 2]
}

// The memory each seat's processes hold, from inside the box: its Xvnc, its
// window manager with every window its dock opened, and its browser with every
// process the browser started, as the proportional share of what they hold, so
// shared pages count once.
const SEAT_MEMORY = `const fs = require('node:fs')
const procs = new Map()
for (const pid of fs.readdirSync('/proc').filter((p) => /^[0-9]+$/.test(p))) {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8')
    const parent = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]
    const args = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\0')
    const env = fs.readFileSync('/proc/' + pid + '/environ', 'utf8').split('\\0')
    const pss = Number((/Pss:\\s+([0-9]+) kB/.exec(fs.readFileSync('/proc/' + pid + '/smaps_rollup', 'utf8')) || [])[1] || 0)
    procs.set(pid, { parent, args, env, pss })
  } catch { /* a process that ended while this read */ }
}
const seatOf = (pid) => {
  for (let at = pid, hops = 0; procs.has(at) && hops < 64; at = procs.get(at).parent, hops++) {
    const { args, env } = procs.get(at)
    const port = args.find((arg) => arg.startsWith('--remote-debugging-port='))
    if (port) return Number(port.split('=')[1]) - 9221
    if (args[0] === 'Xvnc') return Number(args[1].slice(1))
    if (args[0] === 'jwm') return Number((env.find((e) => e.startsWith('DISPLAY=:')) || 'DISPLAY=:0').slice(9))
  }
  return 0
}
const seats = {}
for (const [pid, { pss }] of procs) { const n = seatOf(pid); if (n) seats[n] = (seats[n] || 0) + pss }
console.log(JSON.stringify(Object.fromEntries(Object.entries(seats).map(([n, kb]) => [n, Math.round(kb / 1024)]))))`

// Samples the container's memory and CPU from docker stats while `during` runs.
export async function measure(container: string, during: () => Promise<unknown>) {
  const stats = spawn('docker', ['stats', '--format', '{{.MemUsage}}|{{.CPUPerc}}', container])
  const samples: { mib: number; cpu: number }[] = []
  stats.stdout.setEncoding('utf8').on('data', (text: string) => {
    for (const line of text.split('\n')) {
      // Each refresh starts with terminal escape codes before the values.
      const match = /([\d.]+)(MiB|GiB)\s*\/[^|]*\|([\d.]+)%/.exec(line)
      if (match) samples.push({ mib: Number(match[1]) * (match[2] === 'GiB' ? 1024 : 1), cpu: Number(match[3]) })
    }
  })
  await within(10, async () => samples.length > 0)
  const seats = await during()
  const after = samples.length
  await within(5, async () => samples.length > after)
  stats.kill()
  return { peak: Math.round(Math.max(...samples.map((s) => s.mib))), cpu: Math.round(Math.max(...samples.map((s) => s.cpu))), seats }
}
export const seatMemory = (container: string): Record<string, number> => JSON.parse(docker('exec', container, 'node', '-e', SEAT_MEMORY))

// A Postgres 17 of a check's own, in a throwaway container on a free port of
// this Mac's loopback, so no shared database changes. `url` resolves once it
// takes connections, and `remove` takes the container away, with its data.
export function ownPostgres(name: string): { url: Promise<string>; remove(): void } {
  const password = randomBytes(12).toString('hex')
  const url = (async () => {
    docker('run', '-d', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', 'postgres:17')
    const port = /:(\d+)$/.exec(docker('port', name, '5432/tcp').split('\n')[0] ?? '')?.[1]
    if (port === undefined) throw new Error(`${name} published no port`)
    const address = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`
    // While the image sets the database up, its Postgres takes no TCP connections,
    // so the first one that answers is the one that stays up.
    const deadline = Date.now() + 60_000
    for (;;) {
      const probe = new pg.Client({ connectionString: address })
      const answered = await probe.connect().then(() => probe.query('select 1').then(() => true), () => false)
      await probe.end().catch(() => undefined)
      if (answered) return address
      if (Date.now() > deadline) throw new Error(`${name} did not take connections within 60s`)
      await sleep(500)
    }
  })()
  return {
    url,
    // It was started with --rm, so its data goes with it. A container that never started is no error.
    remove: () => { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }) },
  }
}
