// Every person's own computer, step 15f. Runs the migration that gives every
// person a computer and moves agents whose home is a Mac to their person's
// computer, on a Postgres of its own in a throwaway container, so no shared
// database changes. The migrations before it make the schema, the check adds
// people, Macs, boxes and agents, and the migration runs twice: the first run
// makes the computers and moves the agents, and the second changes nothing.
// Then a moved agent's conversation goes on at its new home through
// conversationSession, unless its turn on the Mac is still running.
//   node --env-file=.env --env-file=.env.test test/step15f.ts

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { must } from './must.ts'
import { messageOf } from '../shared/errors.ts'

const ROOT = new URL('..', import.meta.url).pathname
const MIGRATIONS = join(ROOT, 'server', 'migrations')
const id = randomBytes(4).toString('hex')
const container = `seats-mig-${id}`
const password = randomBytes(12).toString('hex')
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()

// A Postgres 17 of the check's own, on a free port of this Mac's loopback.
async function startPostgres(): Promise<string> {
  docker('run', '-d', '--rm', '--name', container, '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', 'postgres:17')
  const port = must(/:(\d+)$/.exec(docker('port', container, '5432/tcp').split('\n')[0] ?? '')?.[1], "the check's Postgres port")
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`
  // While the image sets the database up, its Postgres takes no TCP connections,
  // so the first one that answers is the one that stays up.
  const deadline = Date.now() + 60_000
  for (;;) {
    const probe = new pg.Client({ connectionString: url })
    const answered = await probe.connect().then(() => probe.query('select 1').then(() => true), () => false)
    await probe.end().catch(() => undefined)
    if (answered) return url
    if (Date.now() > deadline) throw new Error("the check's Postgres did not start within 60s")
    await sleep(500)
  }
}

type Row = Record<string, unknown>

try {
  const files = readdirSync(MIGRATIONS).filter((file) => file.endsWith('.sql')).sort()
  const mine = must(files.find((file) => file.endsWith('_own_computers.sql')), 'the migration that gives every person a computer')
  const url = await startPostgres()
  // The server code below talks to this Postgres too.
  process.env.DATABASE_URL = url
  const db = new pg.Client({ connectionString: url })
  await db.connect()
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => must((await q(sql, params))[0], sql)
  const run = async (file: string) => {
    await db.query('begin')
    await db.query(readFileSync(join(MIGRATIONS, file), 'utf8'))
    await db.query('commit')
  }
  for (const file of files.slice(0, files.indexOf(mine))) await run(file)

  // Two teams. Bob has a computer already. A pool box holds the name Dave's
  // computer would take, and nine hold every numbered name Gus's could.
  const team = String((await one(`insert into teams (name) values ('seats-mig-a') returning id`)).id)
  const other = String((await one(`insert into teams (name) values ('seats-mig-b') returning id`)).id)
  const person = async (teamId: string, login: string) => String((await one('insert into people (team_id, login) values ($1, $2) returning id', [teamId, login])).id)
  const alice = await person(team, 'Alice.Smith@mail.test')
  const bob = await person(team, 'bob@mail.test')
  const carol = await person(team, 'carol+test@mail.test')
  const dave = await person(team, 'dave@mail.test')
  const erin = await person(team, '!!!@mail.test')
  const gus = await person(team, 'gus@mail.test')
  const frank = await person(other, 'frank@mail.test')
  const machine = async (teamId: string, name: string, kind: string, owner: string | null, personal = false) => String((await one(
    `insert into instances (team_id, name, kind, owner_id, token_sha256, personal, claimed_by, seat_cap)
     values ($1, $2, $3, $4, $5, $6, case when $6 then $4::uuid end, case when $6 then 4 else 1 end) returning id`,
    [teamId, name, kind, owner, randomBytes(16).toString('hex'), personal])).id)
  const bobComputer = await machine(team, 'box-bob', 'box', bob, true)
  const pool = await machine(team, 'box-dave', 'box', null)
  for (const name of ['box-gus', ...Array.from({ length: 8 }, (_, i) => `box-gus-${i + 2}`)]) await machine(team, name, 'box', null)
  const aliceMac = await machine(team, 'alice-mac', 'mac', alice)
  const teamMac = await machine(team, 'shared-mac', 'mac', null)
  const frankMac = await machine(other, 'frank-mac', 'mac', frank)
  const agent = async (teamId: string, name: string, home: string | null, owner: string | null) => String((await one(
    'insert into agents (team_id, name, home_instance_id, owner_id) values ($1, $2, $3, $4) returning id', [teamId, name, home, owner])).id)
  const agents = {
    macOwner: await agent(team, 'assistant', aliceMac, null),
    ownOwner: await agent(team, 'fixer', aliceMac, carol),
    nobody: await agent(team, 'improver', teamMac, null),
    daves: await agent(team, 'daves', teamMac, dave),
    onPool: await agent(team, 'pooled', pool, alice),
    onBob: await agent(team, 'bobs', bobComputer, bob),
    homeless: await agent(team, 'homeless', null, alice),
    franks: await agent(other, 'franks', frankMac, null),
  }

  await run(mine)
  const computers = await q(`select owner_id, name, kind, claimed_by, seat_cap, cpus, memory_gib, team_id,
      (select count(*)::int from seats s where s.instance_id = i.id) as seats
    from instances i where personal order by name`)
  const of = (owner: string) => computers.filter((computer) => computer.owner_id === owner)
  const names = Object.fromEntries([alice, carol, dave, erin, gus, frank].map((owner) => [owner, of(owner).map((computer) => String(computer.name))]))
  check([alice, bob, carol, dave, erin, gus, frank].every((owner) => of(owner).length === 1), `every person has one computer (${computers.length} in all)`)
  check(names[alice]?.[0] === 'box-alice-smith' && names[carol]?.[0] === 'box-carol-test' && names[dave]?.[0] === 'box-dave-2'
    && names[erin]?.[0] === 'box-person' && /^box-gus-[0-9a-f]{6}$/.test(names[gus]?.[0] ?? '') && names[frank]?.[0] === 'box-frank',
  `each is named as joining names one, past names that are taken (${JSON.stringify(Object.values(names).flat())})`)
  const made = computers.filter((computer) => computer.owner_id !== bob)
  check(made.length === 6 && made.every((computer) => computer.kind === 'box' && computer.claimed_by === computer.owner_id && computer.seat_cap === 4 && computer.cpus === 4
    && computer.memory_gib === 8 && computer.seats === 4),
  `each of the ${made.length} new ones is a person's computer, held by its owner, with 4 seats, 4 CPUs and 8 GiB`)
  check(of(frank)[0]?.team_id === other && of(alice)[0]?.team_id === team, "each is on its owner's team")

  const homes = async () => Object.fromEntries((await db.query<{ id: string; home_instance_id: string | null }>('select id, home_instance_id from agents order by id')).rows
    .map((row) => [row.id, row.home_instance_id]))
  const computerOf = async (owner: string) => String((await one('select id from instances where owner_id = $1 and personal', [owner])).id)
  const moved = await homes()
  check(moved[agents.macOwner] === await computerOf(alice) && moved[agents.ownOwner] === await computerOf(carol) && moved[agents.daves] === await computerOf(dave)
    && moved[agents.franks] === await computerOf(frank),
  "agents whose home is a Mac move to their owner's computer, or the Mac owner's when they have none")
  check(moved[agents.nobody] === teamMac && moved[agents.onPool] === pool && moved[agents.onBob] === bobComputer && moved[agents.homeless] === null,
    'an agent with no owner on a Mac with none stays, and agents on boxes or with no home stay where they are')

  // The second run changes nothing.
  const before = JSON.stringify(await q('select id, name, owner_id, token_sha256 from instances order by id'))
  await run(mine)
  check(JSON.stringify(await q('select id, name, owner_id, token_sha256 from instances order by id')) === before
    && JSON.stringify(await homes()) === JSON.stringify(moved), 'running the migration again changes nothing')

  // A moved agent's conversation goes on at its new home. A session whose turn
  // is still running on the Mac keeps the conversation until the turn ends.
  const { conversationSession } = await import('../server/record.ts')
  const { pool: serverPool } = await import('../server/db.ts')
  const dm = async (agentId: string) => String((await one(`insert into conversations (team_id, kind, agent_id) values ($1, 'dm', $2) returning id`, [team, agentId])).id)
  const session = async (conversation: string, agentId: string, status: string) => String((await one(
    `insert into sessions (team_id, conversation_id, instance_id, agent_id, status) values ($1, $2, $3, $4, $5) returning id`,
    [team, conversation, aliceMac, agentId, status])).id)
  const idleDm = await dm(agents.macOwner)
  const idleOnMac = await session(idleDm, agents.macOwner, 'idle')
  const busyDm = await dm(agents.ownOwner)
  const busyOnMac = await session(busyDm, agents.ownOwner, 'running')
  const aliceComputer = await computerOf(alice)
  const carolComputer = await computerOf(carol)
  const next = async (conversation: string, agentId: string, home: string) => {
    const client = await serverPool.connect()
    try {
      return await conversationSession(client, team, alice, conversation, { id: agentId, home_instance_id: home, harness: 'claude', model: null })
    } finally {
      client.release()
    }
  }
  const atHome = await next(idleDm, agents.macOwner, aliceComputer)
  const archived = (await one('select archived_at from sessions where id = $1', [idleOnMac])).archived_at
  check(atHome.instance_id === aliceComputer && atHome.id !== idleOnMac && archived !== null,
    "a moved agent's idle conversation goes on in a new session on its computer, and the Mac's session is archived")
  check((await next(idleDm, agents.macOwner, aliceComputer)).id === atHome.id, 'the next message stays in that new session')
  const stillBusy = await next(busyDm, agents.ownOwner, carolComputer)
  check(stillBusy.id === busyOnMac && (await one('select archived_at from sessions where id = $1', [busyOnMac])).archived_at === null,
    "a conversation whose turn is still running on the Mac stays there until the turn ends")
  await db.query(`update sessions set status = 'idle' where id = $1`, [busyOnMac])
  check((await next(busyDm, agents.ownOwner, carolComputer)).instance_id === carolComputer, 'once that turn ends, the conversation moves to the computer')
  await serverPool.end()
  await db.end()
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  // The container goes whatever happened. It was started with --rm, so its volume goes with it.
  try {
    docker('rm', '-f', container)
  } catch {
    // It never started.
  }
}

console.log(failures.length ? `\n${failures.length} failed` : '\nall passed (the check\'s Postgres removed)')
process.exit(failures.length ? 1 : 0)
