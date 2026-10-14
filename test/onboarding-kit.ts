// What the onboarding checks share: their results, waiting for a condition, an
// API under test with its output kept, people's requests to it, reading a
// shape, and looking for a secret everywhere it must never be.

import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { Shape, ShapeStream } from '@electric-sql/client'
import type pg from 'pg'
import { servePeople } from './people.ts'

export const ROOT = new URL('..', import.meta.url).pathname

export function results() {
  const failures: string[] = []
  const check = (ok: unknown, label: string) => {
    console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
    if (!ok) failures.push(label)
  }
  return { failures, check }
}

// How often a check looks again while it waits for something.
const POLL_MS = 300

export async function within(seconds: number, test: () => Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(POLL_MS)
  }
  return false
}

// An API process with its own ports and settings. A setting given as undefined
// is removed, so nothing from .env reaches it. Everything it prints is kept in
// `log`, so a check can show that a secret never reached it. It serves people
// on a socket beside its streams folder, in the check's own folder, and the
// people port forwards to it as tailscale serve would.
export async function startApi(ports: { machines: number; people: number; streams: number }, env: Record<string, string | undefined>, streamsDir: string) {
  const log: string[] = []
  const socket = `${streamsDir}.sock`
  const merged: Record<string, string | undefined> = {
    ...process.env, AGENTS_API_PORT: String(ports.machines), AGENTS_PEOPLE_SOCKET: socket,
    AGENTS_STREAMS_PORT: String(ports.streams), AGENTS_STREAMS_DIR: streamsDir, ...env,
  }
  for (const name of Object.keys(merged)) if (merged[name] === undefined) delete merged[name]
  const child: ChildProcess = spawn(process.execPath, ['server/api.ts'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: merged })
  child.stdout?.on('data', (chunk: Buffer) => log.push(chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => log.push(chunk.toString()))
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => { resolve(code) }))
  const people = await servePeople(ports.people, socket)
  let stopping: Promise<void> | null = null
  // Stops the API and frees its people port, so another API can take it. Safe to call twice.
  const stop = () => {
    stopping ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await exited
      await new Promise<void>((resolve, reject) => { people.close((error) => { if (error) reject(error); else resolve() }) })
    })()
    return stopping
  }
  return { child, log, exited, stop, text: () => log.join('') }
}

export type Answer = { status: number; json: any; text: string }

// A request as a person, through the people port, as tailscale serve would pass it.
export async function asPerson(base: string, login: string, method: string, path: string, body?: unknown, name?: string): Promise<Answer> {
  const res = await fetch(base + path, {
    method,
    headers: {
      'tailscale-user-login': login, ...(name ? { 'tailscale-user-name': name } : {}),
      // The API refuses a person's change that isn't declared JSON, and the app always declares it.
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // Not JSON. The check reads `text` instead.
  }
  return { status: res.status, json, text }
}

// A shape's rows as a person sees them now, or the status that refused them.
// The Electric client follows the shape's log to its end, as the app does: a
// shape made earlier answers its first request with the rows it began with.
export async function shapeRows(base: string, login: string, name: string, args: Record<string, string> = {}): Promise<{ status: number; rows: any[] }> {
  const url = `${base}/v1/shape/${name}${Object.keys(args).length ? `?${new URLSearchParams(args)}` : ''}`
  const headers = { 'tailscale-user-login': login }
  const first = await fetch(`${url}${url.includes('?') ? '&' : '?'}offset=-1`, { headers })
  await first.body?.cancel()
  if (!first.ok) return { status: first.status, rows: [] }
  const rows = await new Shape(new ShapeStream({ url, headers, subscribe: false })).rows
  return { status: first.status, rows }
}

// Every text column, in every table, that holds `value` anywhere in it.
export async function foundInDatabase(db: pg.Client, value: string): Promise<string[]> {
  const { rows: columns } = await db.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
     where table_schema = 'public' and data_type in ('text', 'jsonb', 'json', 'character varying')`)
  const hits: string[] = []
  for (const { table_name: table, column_name: column } of columns) {
    const { rows } = await db.query(`select 1 from "${table}" where position($1 in "${column}"::text) > 0 limit 1`, [value])
    if (rows.length) hits.push(`${table}.${column}`)
  }
  return hits
}
