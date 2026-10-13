// What the crash checks (step18a to step18e) share: starting an API and a
// daemon, killing a machine the way a crash does, and comparing what a person's
// client reads through the sync proxy with the record in Postgres.

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Shape, ShapeStream, type Row } from '@electric-sql/client'
import pg from 'pg'
import { alive, descendants, killAll } from '../daemon/fence.ts'

export { alive }
export const ROOT = new URL('..', import.meta.url).pathname
// How long a check waits for a turn to finish, with real Claude or the fake.
export const TURN_SECONDS = 240
// The watchdog's threshold the checks run the API with: two heartbeats.
export const LOST_SEC = 30

export class Check {
  readonly failures: string[] = []
  readonly children: ChildProcess[] = []
  readonly db = new pg.Client({ connectionString: process.env.DATABASE_URL })

  check(ok: unknown, label: string) {
    console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
    if (!ok) this.failures.push(label)
  }

  // Runs a server script to its end, with .env loaded the way npm scripts load it.
  node(env: Record<string, string>, ...args: string[]): string {
    return execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } })
  }

  start(script: string, env: Record<string, string>): ChildProcess {
    const child = spawn(process.execPath, [script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] })
    this.children.push(child)
    return child
  }

  async rows(sql: string, params: unknown[] = []): Promise<any[]> {
    return (await this.db.query(sql, params)).rows
  }

  async row(sql: string, params: unknown[] = []): Promise<any> {
    return (await this.db.query(sql, params)).rows[0]
  }

  async count(sql: string, params: unknown[] = []): Promise<number> {
    return Number((await this.db.query(sql, params)).rows[0].count)
  }
}

export async function until(label: string, seconds: number, test: () => Promise<unknown>) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return
    await sleep(250)
  }
  throw new Error(`timed out after ${seconds}s waiting for ${label}`)
}

// A machine crash: the daemon dies first, so it can't report what happens to its
// Claude, then Claude and every process under it. Only processes the check
// started are touched, by their PIDs.
export async function killMachine(daemon: ChildProcess) {
  const pid = daemon.pid
  if (pid === undefined) throw new Error('the daemon has no pid')
  const below = descendants(pid)
  killAll([pid, ...below])
  await until('the machine to die', 10, async () => !alive(pid) && below.every((child) => !alive(child)))
}

export function person(people: string, login: string) {
  return async (path: string, body: unknown = {}): Promise<any> => {
    const res = await fetch(people + path, {
      method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
    return res.json()
  }
}

// One line of the fake Claude's logs in its working folder.
export const fakeLog = (dir: string, name: 'starts' | 'received'): any[] => {
  const file = join(dir, '.fake', `${name}.jsonl`)
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
}

// Stops each fake Claude a check's daemons started in `dir` and left running. A
// logged PID is killed only while its command line is still the fake's, since
// the PID may belong to another process by now.
export function killFakes(dir: string) {
  for (const { pid } of fakeLog(dir, 'starts')) {
    if (typeof pid !== 'number' || !alive(pid)) continue
    // Empty when the process has gone since.
    const command = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout
    if (command.includes('fake-claude.ts')) killAll([pid])
  }
}

// What a person's client reads about one DM: the session row, its events, the
// conversation's posts and its open asks. Each view pairs the shape the app opens
// with the SQL that reads the same rows from the record.
type View = { name: string; shape: string; args: Record<string, string>; sql: string; params: string[]; pick: (row: any) => unknown }

function viewsOf(conversationId: string, sessionId: string): View[] {
  return [
    {
      name: 'session', shape: 'sessions', args: { of: 'conversations' },
      sql: 'select * from sessions where id = $1', params: [sessionId],
      pick: (r) => (r.id === sessionId ? { status: r.status, turns: Number(r.turns), harness: r.harness_session_id, lastSeq: Number(r.last_seq) } : undefined),
    },
    {
      name: 'events', shape: 'events', args: { session: sessionId },
      sql: 'select * from events where session_id = $1', params: [sessionId],
      pick: (r) => ({ seq: Number(r.seq), kind: r.kind, text: r.text, toolUseId: r.tool_use_id }),
    },
    {
      name: 'posts', shape: 'messages', args: { conversation: conversationId },
      sql: 'select * from messages where conversation_id = $1', params: [conversationId],
      pick: (r) => ({ seq: Number(r.seq), speaker: r.speaker, body: r.body }),
    },
    {
      name: 'open asks', shape: 'asks', args: {},
      sql: `select * from asks where conversation_id = $1 and status = 'open'`, params: [conversationId],
      pick: (r) => (r.conversation_id === conversationId ? { id: r.id, status: r.status } : undefined),
    },
  ]
}

const normal = (rows: readonly any[], pick: View['pick']) =>
  JSON.stringify(rows.map(pick).filter((r) => r !== undefined).map((r) => JSON.stringify(r)).sort())

const shapeUrl = (people: string, view: View) => `${people}/v1/shape/${view.shape}?${new URLSearchParams(view.args).toString()}`

// A client that stays connected: one live shape per view, opened once.
export function liveClient(people: string, login: string, conversationId: string, sessionId: string) {
  const abort = new AbortController()
  const shapes = viewsOf(conversationId, sessionId).map((view) => ({
    view,
    shape: new Shape(new ShapeStream<Row>({ url: shapeUrl(people, view), headers: { 'tailscale-user-login': login }, signal: abort.signal })),
  }))
  return {
    read: (name: string): readonly Row[] => shapes.find((s) => s.view.name === name)?.shape.currentRows ?? [],
    close: () => abort.abort(),
  }
}

// Reads each view the way a client that just reconnected does: from scratch.
async function freshRead(people: string, login: string, view: View): Promise<Row[]> {
  return new Shape(new ShapeStream<Row>({ url: shapeUrl(people, view), headers: { 'tailscale-user-login': login }, subscribe: false })).rows
}

// Waits until both a reconnecting client and the live one, when there is one,
// read what the record holds, and names each view that never matched.
export async function clientsMatchRecord(check: Check, options: {
  people: string; login: string; conversationId: string; sessionId: string; live?: ReturnType<typeof liveClient>; when: string
}) {
  const { people, login, conversationId, sessionId, live, when } = options
  for (const view of viewsOf(conversationId, sessionId)) {
    let fresh = ''
    let held = ''
    let record = ''
    const matched = await until(`${view.name} to match`, 30, async () => {
      record = normal((await check.db.query(view.sql, view.params)).rows, view.pick)
      fresh = normal(await freshRead(people, login, view), view.pick)
      held = live ? normal(live.read(view.name), view.pick) : record
      return fresh === record && held === record
    }).then(() => true, () => false)
    check.check(matched, `${when}: ${live ? 'a reconnecting client and a connected one read' : 'a reconnecting client reads'} the ${view.name} the record holds`)
    if (!matched) console.error(`  record ${record}\n  fresh  ${fresh}\n  live   ${held}`)
  }
}
