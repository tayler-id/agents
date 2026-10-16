// Seats and the scheduler, step 15h. On a Postgres of its own in a throwaway
// container, people message agents whose home is Bob's computer, and the
// scheduler places each turn the way the API does. Each agent's turn takes a
// seat of its own. A seat's last turn time is set as its turn starts and ends.
// A fifth agent's turn waits for a seat while all four are busy, and its
// waiting line says so in the words the app shows. The reclaim rule frees no
// seat whose agent has a turn not over, whose screen a person holds, or whose
// last turn was under 15 minutes ago. Once a seat is free of all three, the
// waiting turn is placed there, and an agent taking a seat back takes the one
// idle longest. A turn on a pool box takes no seat, as before seats. Then three
// races on separate connections. Eight agents asking at once for four seats get four.
// A reclaim meeting a takeover that is not committed yet waits for it. A screen handed
// back while the agent on that seat is messaged never deadlocks.
//   node --env-file=.env --env-file=.env.test test/step15h.ts

import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { must } from './must.ts'
import { ownPostgres } from './seats.ts'
import { messageOf } from '../shared/errors.ts'

const ROOT = new URL('..', import.meta.url).pathname
const MIGRATIONS = join(ROOT, 'server', 'migrations')
const failures: string[] = []
const postgres = ownPostgres(`seats-turns-${randomBytes(4).toString('hex')}`)

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

try {
  const url = await postgres.url
  // The server code below talks to this Postgres.
  process.env.DATABASE_URL = url
  const db = new pg.Client({ connectionString: url })
  await db.connect()
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows
  const one = async (sql: string, params: unknown[] = []) => must((await q(sql, params))[0], sql)
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    await db.query('begin')
    await db.query(readFileSync(join(MIGRATIONS, file), 'utf8'))
    await db.query('commit')
  }
  const { openDm, sendPersonMessage, Person } = await import('../server/record.ts')
  const { placeWaitingTurns } = await import('../server/scheduler.ts')
  const { moveMessages } = await import('../server/durability.ts')
  const { RECLAIM_IDLE_MIN } = await import('../server/seats.ts')
  const { tx, pool } = await import('../server/db.ts')
  const { TurnWaitRow, TURN_WAIT_COLUMNS, turnLine } = await import('../shared/turns.ts')

  // Bob's computer, up and taking work, with its 4 seats, and a pool box.
  const team = String((await one(`insert into teams (name) values ('seats-turns') returning id`)).id)
  const person = async (login: string, name: string) => Person.parse(await one(
    `insert into people (team_id, login, name, role) values ($1, $2, $3, 'admin') returning id, team_id, login, role`, [team, login, name]))
  const bob = await person('bob@mail.test', 'Bob')
  const carol = await person('carol@mail.test', 'Carol')
  const box = async (name: string, personal: boolean, owner = bob) => String((await one(
    `insert into instances (team_id, name, kind, owner_id, token_sha256, personal, claimed_by, seat_cap, status, ready, last_seen_at)
     values ($1, $2, 'box', $3, $4, $5, $3, $6, 'online', true, now()) returning id`,
    [team, name, personal ? owner.id : null, randomBytes(16).toString('hex'), personal, personal ? 4 : 1])).id)
  const computer = await box('box-bob', true)
  const pooled = await box('box-pool', false)
  const agentOn = async (name: string, home: string) => String((await one(
    `insert into agents (team_id, name, home_instance_id, owner_id, visibility) values ($1, $2, $3, $4, 'team') returning id`, [team, name, home, bob.id])).id)
  const names = ['ann', 'ben', 'cal', 'dot', 'eve']
  const agents = new Map<string, string>()
  for (const name of names) agents.set(name, await agentOn(name, computer))
  const agentOf = (name: string) => must(agents.get(name), name)

  // A person's message to an agent, through the API's own path, and the turn it made.
  const message = async (from: typeof bob, name: string) => {
    const dm = await tx((client) => openDm(client, from, name))
    await tx((client) => sendPersonMessage(client, from, dm, `Hello ${name}`, randomUUID()))
    return one(`select t.id, t.status, t.wait, t.command_id from turns t where t.conversation_id = $1 order by t.requested_at desc limit 1`, [dm])
  }
  const seatOf = (name: string) => q('select n, status, last_turn_at from seats where instance_id = $1 and agent_id = $2', [computer, agentOf(name)])
  // The machine takes the turn's command, then finishes it.
  const run = async (commandId: string, to: 'handed_over' | 'done', on = computer) => tx((client) => moveMessages(client, [commandId], to, { instanceId: on }))

  // Four agents, four seats.
  const firsts = new Map<string, Record<string, unknown>>()
  for (const name of names.slice(0, 4)) firsts.set(name, await message(bob, name))
  const held = await q(`select n, agent_id, status from seats where instance_id = $1 order by n`, [computer])
  check([...firsts.values()].every((turn) => turn.status === 'placed' && turn.command_id !== null)
    && held.map((seat) => `${seat.n}:${seat.agent_id === agentOf(names[seat.n - 1] ?? '') ? 'own' : 'other'}:${seat.status}`).join() === '1:own:starting,2:own:starting,3:own:starting,4:own:starting',
  `each agent's turn is placed on Bob's computer with a seat of its own (${held.map((seat) => `${seat.n}:${seat.status}`).join(', ')})`)

  // A seat's last turn time moves as its turn starts and ends.
  const annTurn = must(firsts.get('ann'), "ann's turn")
  await run(String(annTurn.command_id), 'handed_over')
  const started = (await seatOf('ann'))[0]?.last_turn_at
  await new Promise((resolve) => setTimeout(resolve, 20))
  await run(String(annTurn.command_id), 'done')
  const ended = (await seatOf('ann'))[0]?.last_turn_at
  check(started instanceof Date && ended instanceof Date && ended > started, 'a seat records when its turn started, then when it ended')

  // A fifth agent waits while every seat is busy.
  const eveTurn = await message(bob, 'eve')
  const waits = (await q(`select ${TURN_WAIT_COLUMNS.join(', ')} from turns where id = $1`, [eveTurn.id])).map((row) => TurnWaitRow.parse(row))
  const machine = await one('select name, personal, owner_id, seat_cap from instances where id = $1', [computer])
  const line = (viewer: string) => turnLine(must(waits[0], "eve's wait"), { name: String(machine.name), personal: Boolean(machine.personal), owner_id: String(machine.owner_id), seat_cap: Number(machine.seat_cap) },
    viewer, { name: 'Bob', login: bob.login }, (time) => time)
  check(eveTurn.status === 'waiting' && eveTurn.wait === 'seat' && eveTurn.command_id === null && (await seatOf('eve')).length === 0,
    "a fifth agent's turn waits for a seat, with no command, while all four are busy")
  check(line(bob.id) === 'Waiting for a seat on your computer, 4 of 4 busy' && line(carol.id) === "Waiting for a seat on Bob's computer, 4 of 4 busy",
    `its waiting line says so (Bob reads "${line(bob.id)}", Carol "${line(carol.id)}")`)

  // The reclaim rule: ann's turn is over, but her last one was moments ago.
  const giveUp = async () => { throw new Error('no turn should be given up on here') }
  const placeAgain = async () => {
    await placeWaitingTurns(null, giveUp)
    return one('select status, wait, command_id from turns where id = $1', [eveTurn.id])
  }
  check((await placeAgain()).status === 'waiting', `a seat whose last turn was under ${RECLAIM_IDLE_MIN} minutes ago is not taken back`)
  // Ben's turn is placed but not over, however long ago his seat was busy.
  await db.query(`update seats set held_since = now() - interval '1 hour', last_turn_at = now() - interval '1 hour' where agent_id = $1`, [agentOf('ben')])
  check((await placeAgain()).status === 'waiting', 'a seat whose agent has a turn not over is not taken back')
  // Ann's seat, idle for longer than the rule asks, while Carol holds its screen.
  await db.query(`update seats set last_turn_at = now() - make_interval(mins => $2 + 1) where agent_id = $1`, [agentOf('ann'), RECLAIM_IDLE_MIN])
  const annSeat = String((await one('select id from seats where agent_id = $1', [agentOf('ann')])).id)
  await db.query(`insert into screen_takeovers (team_id, instance_id, seat_id, person_id) values ($1, $2, $3, $4)`, [team, computer, annSeat, carol.id])
  check((await placeAgain()).status === 'waiting', 'a seat whose screen a person holds is not taken back')
  await db.query(`update screen_takeovers set ended_at = now(), ended_by = 'handed_back' where seat_id = $1 and ended_at is null`, [annSeat])
  const placed = await placeAgain()
  const eveSeat = (await seatOf('eve'))[0]
  check(placed.status === 'placed' && placed.command_id !== null && eveSeat?.n === 1 && eveSeat.status === 'starting' && (await seatOf('ann')).length === 0,
    `once ann's seat has been idle ${RECLAIM_IDLE_MIN} minutes with nothing to do, eve's waiting turn takes it back and is placed there (${String(placed.status)}, seat ${String(eveSeat?.n)})`)

  // Taking a seat back takes the one idle longest.
  for (const name of ['cal', 'dot']) {
    const turn = must(firsts.get(name), `${name}'s turn`)
    await run(String(turn.command_id), 'handed_over')
    await run(String(turn.command_id), 'done')
  }
  await db.query(`update seats set last_turn_at = now() - interval '20 minutes' where agent_id = $1`, [agentOf('cal')])
  await db.query(`update seats set last_turn_at = now() - interval '40 minutes' where agent_id = $1`, [agentOf('dot')])
  const annAgain = await message(bob, 'ann')
  const annNow = (await seatOf('ann'))[0]
  check(annAgain.status === 'placed' && annNow?.n === 4 && (await seatOf('dot')).length === 0 && (await seatOf('cal')).length === 1,
    `an agent taking a seat back takes the one idle longest, dot's seat 4 over cal's (ann now on seat ${String(annNow?.n)})`)

  // A pool box runs every session on seat 1, holding no seat, as before seats.
  const poolAgent = await agentOn('pip', pooled)
  const pipTurn = await message(bob, 'pip')
  const poolSeat = await one('select agent_id, status from seats where instance_id = $1', [pooled])
  check(pipTurn.status === 'placed' && poolSeat.agent_id === null && poolSeat.status === 'free' && poolAgent !== '',
    'a turn on a pool box is placed without taking a seat, so its stages keep their placement')

  // Races. Each runs on its own connections, so the locks decide the outcome.
  // Eight agents ask for a seat at once on a computer of four.
  const crowd = await box('box-crowd', true, carol)
  const crowdNames = Array.from({ length: 8 }, (_, i) => `rush${i}`)
  for (const name of crowdNames) agents.set(name, await agentOn(name, crowd))
  await Promise.all(crowdNames.map((name) => message(bob, name)))
  const seated = await q('select agent_id from seats where instance_id = $1 and agent_id is not null', [crowd])
  const crowdTurns = await q(`select t.status, t.wait from turns t join sessions x on x.id = t.session_id where x.instance_id = $1 or t.agent_id = any($2)`,
    [crowd, crowdNames.map(agentOf)])
  const placedTurns = crowdTurns.filter((turn) => turn.status === 'placed').length
  const waitingTurns = crowdTurns.filter((turn) => turn.status === 'waiting' && turn.wait === 'seat').length
  check(seated.length === 4 && new Set(seated.map((seat) => seat.agent_id)).size === 4 && placedTurns === 4 && waitingTurns === 4,
    `eight agents asking at once for four seats get four seats, one each, and four turns wait (${seated.length} held, ${placedTurns} placed, ${waitingTurns} waiting)`)

  // A reclaim that runs while a person's takeover of the seat is not committed yet
  // waits for it, then skips the seat.
  const { takeSeat } = await import('../server/seats.ts')
  const idleSeat = must((await q(`select s.id, s.agent_id from seats s where s.instance_id = $1 and s.agent_id is not null order by n limit 1`, [crowd]))[0], 'a held seat')
  for (const turnRow of await q(`select command_id from turns where agent_id = $1 and command_id is not null`, [idleSeat.agent_id])) {
    await run(String(turnRow.command_id), 'handed_over', crowd)
    await run(String(turnRow.command_id), 'done', crowd)
  }
  await db.query(`update seats set last_turn_at = now() - interval '1 hour' where instance_id = $1`, [crowd])
  const outsider = await agentOn('outsider', crowd)
  const taker = await pool.connect()
  await taker.query('begin')
  await taker.query('select 1 from seats where id = $1 for update', [idleSeat.id])
  await taker.query(`insert into screen_takeovers (team_id, instance_id, seat_id, person_id) values ($1, $2, $3, $4)`, [team, crowd, idleSeat.id, carol.id])
  let reclaimDone = false
  const reclaim = tx((client) => takeSeat(client, crowd as never, outsider as never)).then((result) => { reclaimDone = true; return result })
  await new Promise((resolve) => setTimeout(resolve, 400))
  const waitedForTakeover = !reclaimDone
  await taker.query('commit')
  taker.release()
  const reclaimed = await reclaim
  check(waitedForTakeover && reclaimed.kind === 'busy',
    "a reclaim that meets an uncommitted takeover waits for it, then leaves that seat to the person and finds every seat busy")
  await db.query(`update screen_takeovers set ended_at = now(), ended_by = 'handed_back' where seat_id = $1 and ended_at is null`, [idleSeat.id])

  // A person handing a screen back while someone talks to the agent working on
  // that seat. Both lock the session and the seat, so they must lock them in one order.
  const { handBackScreen } = await import('../server/screens.ts')
  const talker = agentOf('rush0')
  const talkerSeat = must((await q('select id, n from seats where instance_id = $1 and agent_id = $2', [crowd, talker]))[0], "the talker's seat")
  const talkerSession = must((await q(`select x.id from sessions x join conversations c on c.id = x.conversation_id where x.instance_id = $1 and x.agent_id = $2`, [crowd, talker]))[0], "the talker's session")
  await db.query(`update sessions set status = 'running', seat_id = $2 where id = $1`, [talkerSession.id, talkerSeat.id])
  let deadlocks = 0
  let hits = 0
  for (let round = 0; round < 12; round++) {
    await db.query(`insert into screen_takeovers (team_id, instance_id, seat_id, person_id) values ($1, $2, $3, $4)`, [team, crowd, talkerSeat.id, carol.id])
    const results = await Promise.allSettled([handBackScreen(carol, crowd, talkerSeat.n, null), message(bob, 'rush0')])
    for (const result of results) {
      if (result.status === 'rejected') deadlocks += /deadlock/.test(messageOf(result.reason)) ? 1 : 0
      else hits++
    }
    await db.query(`update screen_takeovers set ended_at = now(), ended_by = 'handed_back' where seat_id = $1 and ended_at is null`, [talkerSeat.id])
    await db.query(`update sessions set status = 'running' where id = $1`, [talkerSession.id])
  }
  check(deadlocks === 0 && hits === 24, `a screen handed back while the agent on that seat is messaged never deadlocks (12 rounds, ${deadlocks} deadlocks)`)

  await pool.end()
  await db.end()
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  postgres.remove()
}

console.log(failures.length ? `\n${failures.length} failed` : '\nall passed (the check\'s Postgres removed)')
process.exit(failures.length ? 1 : 0)
