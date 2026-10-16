// Phase 1 step 2c. The shape proxy passes on only the keys a live read needs.
// Electric serves a subset read on any shape, and its filter may name a column
// the shape hides, so a person asking whether an instance's token hash is set
// learned the answer. Now both questions get the same refusal. Live reads, their
// cursor, and the 409 that replaces a shape still work.
//   node --env-file=.env --env-file=.env.test test/step2c.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isChangeMessage, isControlMessage, ShapeStream, type Message, type Row } from '@electric-sql/client'
import pg from 'pg'
import { must } from './must.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = 7811
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 100}`
const id = randomBytes(4).toString('hex')
const team = `step2c-${id}`
const alice = `alice-${id}@local`
const as = { 'tailscale-user-login': alice }

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const stop = new AbortController()
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

function node(...args: string[]) {
  return execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
}

async function until(label: string, test: () => boolean, seconds = 15) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (test()) return true
    await sleep(100)
  }
  console.log(`      (gave up waiting for ${label})`)
  return false
}

const rowsIn = (body: string) => body.split('"operation"').length - 1

// One read of the instances shape through the people port, as a browser sends it.
async function read(query: Record<string, string>) {
  const res = await fetch(`${PEOPLE}/v1/shape/instances?${new URLSearchParams(query).toString()}`, { headers: as })
  return {
    status: res.status, body: await res.text(),
    handle: res.headers.get('electric-handle'), offset: res.headers.get('electric-offset'), cursor: res.headers.get('electric-cursor'),
  }
}

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, alice)
  node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', alice)

  const home = mkdtempSync(join(tmpdir(), 'agents-step2c-'))
  const api = spawn(process.execPath, ['server/api.ts'], {
    cwd: ROOT,
    env: { ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'), AGENTS_STREAMS_PORT: String(PORT + 1), AGENTS_STREAMS_DIR: join(home, 'streams') },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  children.push(api)
  await servePeople(PORT + 100, join(home, 'people.sock'))
  for (let i = 0; i < 40 && !(await fetch(API).then(() => true, () => false)); i++) await sleep(250)

  const hidden = await read({ offset: '-1', log: 'changes_only', subset__where: 'token_sha256 is not null' })
  const opposite = await read({ offset: '-1', log: 'changes_only', subset__where: 'token_sha256 is null' })
  console.log(`      (token_sha256 is not null: ${String(hidden.status)}, ${String(rowsIn(hidden.body))} rows; is null: ${String(opposite.status)}, ${String(rowsIn(opposite.body))} rows)`)
  check(hidden.status === 400 && opposite.status === 400 && hidden.body === opposite.body,
    'a subset read naming the hidden token hash gets the same refusal whether the hash is set or not')

  const rows = new Map<string, Row>()
  let upToDate = false
  const stream = new ShapeStream<Row>({ url: `${PEOPLE}/v1/shape/instances`, headers: as, signal: stop.signal })
  stream.subscribe((messages: Message<Row>[]) => {
    for (const m of messages) {
      if (isChangeMessage(m)) rows.set(m.key, { ...(rows.get(m.key) ?? {}), ...m.value })
      else if (isControlMessage(m) && m.headers.control === 'up-to-date') upToDate = true
    }
  }, () => {})
  await until('the first instance', () => upToDate && rows.size === 1)
  node('server/admin.ts', 'add-instance', team, `mac2-${id}`, 'mac', alice)
  check(await until('the second instance', () => [...rows.values()].some((r) => r.name === `mac2-${id}`)),
    'a live read through the Electric client gets an instance added after it opened')

  const handle = must(stream.shapeHandle, 'the shape handle')
  const firstId = must((await db.query<{ id: string }>('select id from instances where name = $1', [`mac-${id}`])).rows[0], 'the first instance').id
  const rename = (from: string, to: string) => db.query('update instances set name = $1 where name = $2', [to, from])
  await rename(`mac-${id}`, `mac-a-${id}`)
  const first = await read({ offset: stream.lastOffset, handle, live: 'true' })
  await rename(`mac-a-${id}`, `mac-b-${id}`)
  const second = await read({ offset: must(first.offset, 'the offset after a live read'), handle, live: 'true', cursor: must(first.cursor, 'a live cursor') })
  check(first.status === 200 && second.status === 200 && second.cursor !== null && second.cursor !== first.cursor,
    'a live read sent with the last cursor gets a new one, so a browser never answers a live read from its cache')

  const stale = await read({ offset: stream.lastOffset, handle: `${handle.split('-')[0] ?? ''}-1` })
  const refetch = await read({ offset: '-1', handle: must(stale.handle, 'the handle a 409 names') })
  check(stale.status === 409 && stale.handle === handle && refetch.status === 200 && refetch.body.includes(firstId),
    'a read with a handle that is not the shape\'s gets a 409 naming the current one, and reading that one from the start works')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  failures.push(message)
  console.error(`FAIL  ${message}`)
} finally {
  stop.abort()
  for (const child of children) child.kill('SIGTERM')
  await db.query('delete from teams where name = $1', [team])
  await db.end()
}

console.log(`\n${failures.length ? `${String(failures.length)} failed` : 'all passed'} (test team removed)`)
process.exit(failures.length ? 1 : 0)
