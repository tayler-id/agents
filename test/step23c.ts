// Step 23c, the door's edges, against the database with no machine and no port.
// Each line calls the server's own code the way the API and the runner do, then
// reads the rows a person or the next process would see. A person's own box is
// marked asleep and a request that places a turn on it never interleave, so a
// turn asked for while a box is going to sleep waits for it and wakes it. Turns
// released together keep the order they were asked in. A session that waits for a
// person is not stuck. One waiting turn that cannot be read does not hold up the
// rest. A stop or an interrupt cancels the turns that wait for the session, and a
// governed stage whose machine went silent fails its turn with its command.
//   node --env-file=.env --env-file=.env.test test/step23c.ts

import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { markAsleep, makeOwnBox } from '../server/boxes.ts'
import { pool, tx } from '../server/db.ts'
import { moveMessages } from '../server/durability.ts'
import { lostMachine } from '../server/framework.ts'
import { recordVersion } from '../server/pipelines.ts'
import { interruptSession, openDm, Person, reportUnplaceableTurn, sendPersonMessage } from '../server/record.ts'
import { cancelWaitingTurn, markStuckTurns, placeWaitingTurns, queueRoomTurn, signalSession } from '../server/scheduler.ts'
import { InstanceId } from '../shared/onboarding.ts'
import { AgentId, ConversationId, SessionId, TurnId } from '../shared/ids.ts'
import { messageOf } from '../shared/errors.ts'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
const id = randomBytes(4).toString('hex')
const team = `door-23c-${id}`
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
const all = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows
const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0]

// A promise settled by hand, so a transaction can be held open between two steps.
function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

// Waits for a condition, polling, and says whether it held before the limit.
async function within(seconds: number, test: () => Promise<boolean>): Promise<boolean> {
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    if (await test()) return true
    await new Promise((done) => setTimeout(done, 25))
  }
  return false
}

// Whether some backend is waiting for a lock the given backend holds.
const waitsFor = async (pid: number) =>
  Number((await one('select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))', [pid])).n) > 0

// What a person who started something that may wait sees come of it: it finished
// first, or it is still waiting for the lock the other holds.
async function settledOrWaiting<T>(started: Promise<T>, holder: number): Promise<'settled' | 'waiting'> {
  const settled = started.then(() => 'settled' as const, () => 'settled' as const)
  const waiting = within(10, () => waitsFor(holder)).then((held) => (held ? 'waiting' as const : 'settled' as const))
  return Promise.race([settled, waiting])
}

type World = { person: Person; boxId: InstanceId; conversationId: string; sessionId: () => Promise<SessionId>; ask: (text: string) => Promise<void> }

// A person with a machine for their agent and a DM with that agent. A box is their
// own, and has not reported in, so it takes no work until `up` says its daemon has.
// A Mac takes commands whenever it comes, so its turns are placed at once.
async function world(label: string, kind: 'box' | 'mac' = 'box'): Promise<World> {
  const login = `${label}-${id}@local`
  node('server/admin.ts', 'add-person', team, login)
  const person = Person.parse(must(await one('select id, team_id, login, role from people where login = $1', [login]), login))
  if (kind === 'mac') node('server/admin.ts', 'add-instance', team, `mac-${label}-${id}`, 'mac', login)
  const boxId = kind === 'box' ? await makeOwnBox(person) : InstanceId.parse(must(await one('select id from instances where name = $1', [`mac-${label}-${id}`]), 'the Mac').id)
  const box = must(await one('select name from instances where id = $1', [boxId]), 'the machine')
  const agent = `scout-${label}`
  node('server/admin.ts', 'add-agent', team, agent, String(box.name))
  const conversationId = await tx((client) => openDm(client, person, agent))
  const ask = async (text: string) => {
    await tx((client) => sendPersonMessage(client, person, conversationId, text, randomUUID()))
  }
  const sessionId = async () => SessionId.parse(must(await one('select id from sessions where conversation_id = $1', [conversationId]), 'the session').id)
  return { person, boxId, conversationId, sessionId, ask }
}

// The daemon reporting in, and going away.
const up = (w: World) => pool.query(`update instances set status = 'online', ready = true, last_seen_at = now() where id = $1`, [w.boxId])
const turnsOf = (w: World) => all(
  `select status, wait, command_id is not null as has_command from turns where conversation_id = $1 order by requested_at, id`, [w.conversationId])
const commandsOfConversation = (w: World) => all(
  `select c.kind from commands c join sessions s on s.id = c.session_id where s.conversation_id = $1 and c.kind = 'message'`, [w.conversationId])
const asleep = async (w: World) => Boolean((await one('select stopped_at is not null as asleep from instances where id = $1', [w.boxId])).asleep)
const shown = (turns: { status: string; wait: string | null; has_command: boolean }[]) =>
  turns.map((t) => `${t.status}${t.wait ? ` ${t.wait}` : ''}${t.has_command ? ' with a command' : ''}`).join(', ') || 'no turns'

try {
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, `admin-${id}@local`)
  const teamId = String(must(await one('select id from teams where name = $1', [team]), 'the team').id)

  // A box marked asleep takes no work. The runner is about to stop it, so a turn
  // asked for now waits, and its waiting is what makes the runner start the box again.
  {
    const w = await world('asleep')
    await up(w)
    check(await markAsleep(w.boxId) && await asleep(w), 'a box with nothing wanting it is marked asleep')
    await w.ask('Are you there?')
    const turns = await turnsOf(w)
    check(turns.length === 1 && turns[0]?.status === 'waiting' && turns[0].wait === 'computer_starting' && !turns[0].has_command,
      `a turn asked for after the box is marked asleep waits for it and has no command (${shown(turns)})`)
    check(!(await markAsleep(w.boxId)), 'a box a turn waits for is wanted, so the runner starts it again')
  }

  // A request that has placed a turn on the box and not yet committed keeps the
  // box from being marked, since the mark waits for it and then sees its command.
  {
    const w = await world('inflight')
    await up(w)
    const written = deferred()
    const commit = deferred()
    let requester = 0
    const request = tx(async (client) => {
      requester = Number((await client.query('select pg_backend_pid() as pid')).rows[0]?.pid)
      await sendPersonMessage(client, w.person, w.conversationId, 'In flight.', randomUUID())
      written.resolve()
      await commit.promise
    })
    await written.promise
    const marking = markAsleep(w.boxId)
    const how = await settledOrWaiting(marking, requester)
    commit.resolve()
    await request
    const marked = await marking
    const turns = await turnsOf(w)
    check(how === 'waiting' && !marked && !(await asleep(w)) && turns[0]?.status === 'placed' && turns[0].has_command,
      `a box is not marked asleep while a request that placed a turn on it is in flight (mark ${how}, marked ${String(marked)}, ${shown(turns)})`)
  }

  // The other way round. While the mark holds the box's row, a request waits for
  // it, and then reads the box as asleep. The agent has a session already, so the
  // request reads the box before it writes anything that names it.
  {
    const w = await world('sleeping')
    await w.ask('First.')
    await up(w)
    await placeWaitingTurns([teamId], reportUnplaceableTurn)
    const marked = deferred()
    const commit = deferred()
    let sleeper = 0
    const sleeping = tx(async (client) => {
      sleeper = Number((await client.query('select pg_backend_pid() as pid')).rows[0]?.pid)
      await client.query('select 1 from instances where id = $1 for update', [w.boxId])
      await client.query('update instances set stopped_at = now() where id = $1', [w.boxId])
      marked.resolve()
      await commit.promise
    })
    await marked.promise
    const asking = w.ask('Are you awake?')
    const how = await settledOrWaiting(asking, sleeper)
    commit.resolve()
    await sleeping
    await asking
    const turns = await turnsOf(w)
    check(how === 'waiting' && turns[1]?.status === 'waiting' && turns[1].wait === 'computer_starting' && !turns[1].has_command,
      `a request that arrives while the box is being marked asleep waits for the mark, then waits for the box (request ${how}, ${shown(turns)})`)
  }

  // Turns asked for while the box was away are placed together, and each command
  // gets a moment of its own, so a machine and a resume read them in the order they
  // were asked in.
  {
    const w = await world('together')
    for (const text of ['one', 'two', 'three', 'four', 'five']) await w.ask(text)
    await up(w)
    await placeWaitingTurns([teamId], reportUnplaceableTurn)
    const read = await one(
      `select count(*)::int as commands, count(distinct c.created_at)::int as moments,
         string_agg(c.payload->>'text', ',' order by c.created_at, c.id) as order_read
       from commands c where c.kind = 'message' and c.session_id = (select session_id from turns where conversation_id = $1 limit 1)`, [w.conversationId])
    check(read?.commands === 5 && read.moments === 5 && read.order_read === 'one,two,three,four,five',
      `five turns placed together are five commands at five moments, read back in the order asked (${String(read?.moments)} moments, ${String(read?.order_read)})`)
  }

  // A turn that waits for a person's answer is quiet because of them. The same
  // quiet turn with a session that is working is stuck.
  for (const [label, status, stuck] of [['approval', 'needs_approval', false], ['working', 'running', true]] as const) {
    const w = await world(label)
    await up(w)
    await w.ask('Do the thing.')
    const command = must(await one(`select c.id from commands c join sessions s on s.id = c.session_id where s.conversation_id = $1 and c.kind = 'message'`, [w.conversationId]), 'its command')
    await moveMessages(pool, [String(command.id)], 'handed_over')
    await pool.query(`update sessions set status = $2 where conversation_id = $1`, [w.conversationId, status])
    await pool.query(`update events set created_at = now() - interval '11 minutes' where session_id = (select id from sessions where conversation_id = $1)`, [w.conversationId])
    await pool.query(`update turns set started_at = now() - interval '11 minutes' where conversation_id = $1`, [w.conversationId])
    await markStuckTurns([teamId])
    const marked = Boolean((await one('select stuck_since is not null as marked from turns where conversation_id = $1', [w.conversationId])).marked)
    check(marked === stuck, `a turn quiet for 11 minutes ${stuck ? 'is marked stuck while its session works' : 'is not marked stuck while its session waits for a person'} (${status})`)
  }

  // One waiting turn that cannot be read does not hold up the turns behind it. It
  // fails alone, and its person is told why.
  {
    const bad = await world('unreadable')
    const good = await world('readable')
    await bad.ask('This one is asked first.')
    await good.ask('This one is behind it.')
    await pool.query(`update turns set payload = '{"text": 5}'::jsonb where conversation_id = $1`, [bad.conversationId])
    await up(bad)
    await up(good)
    await placeWaitingTurns([teamId], reportUnplaceableTurn)
    const [badTurns, goodTurns] = [await turnsOf(bad), await turnsOf(good)]
    const told = await one(
      `select s.status, (select e.text from events e where e.session_id = s.id and e.kind = 'error' order by e.seq desc limit 1) as said
       from sessions s where s.conversation_id = $1`, [bad.conversationId])
    check(goodTurns[0]?.status === 'placed' && goodTurns[0].has_command,
      `a waiting turn that cannot be read does not keep the turn behind it from being placed (${shown(goodTurns)})`)
    check(badTurns[0]?.status === 'failed' && !badTurns[0].has_command && told?.status === 'failed' && String(told.said).includes('could not be sent'),
      `the turn that cannot be read fails alone, and its session says it could not be sent (${shown(badTurns)}, session ${String(told?.status)})`)
  }

  // A session whose turns cannot be placed for a reason of its own, here that
  // telling its person failed, does not hold up the session behind it either. Its
  // turn is left waiting for the next tick.
  {
    const first = await world('stalls')
    const second = await world('carries')
    await first.ask('Asked first.')
    await second.ask('Asked second.')
    await pool.query(`update turns set payload = '{"text": 5}'::jsonb where conversation_id = $1`, [first.conversationId])
    await up(first)
    await up(second)
    const ticked = await placeWaitingTurns([teamId], () => Promise.reject(new Error('the report could not be written')))
      .then(() => 'went on', (error: unknown) => `stopped with "${messageOf(error)}"`)
    const [stalled, carried] = [await turnsOf(first), await turnsOf(second)]
    check(ticked === 'went on' && carried[0]?.status === 'placed' && stalled[0]?.status === 'waiting',
      `a session that cannot be placed does not stop the next session from being placed, and its turn waits for the next tick (the tick ${ticked}; ${shown(stalled)}; ${shown(carried)})`)
  }

  // A stop or an interrupt written while a turn waits cancels the turn, so the
  // message is not sent after it when the box comes up. A turn that already has
  // its command is left to run, with the stop queued behind it, as before the door.
  for (const [label, how] of [
    ['an interrupt from the app', (client: Parameters<typeof interruptSession>[0], sessionId: SessionId) => interruptSession(client, sessionId)],
    ['a stop from a run or a replay', (client: Parameters<typeof signalSession>[0], sessionId: SessionId) => signalSession(client, sessionId, 'stop')],
  ] as const) {
    const w = await world(label.startsWith('an') ? 'interrupted' : 'stopped')
    await w.ask('Start this.')
    await tx(async (client) => how(client, await w.sessionId()))
    await up(w)
    await placeWaitingTurns([teamId], reportUnplaceableTurn)
    const turns = await turnsOf(w)
    const sent = await all(`select kind from commands where session_id = $1 order by created_at, id`, [await w.sessionId()])
    check(turns[0]?.status === 'cancelled' && !turns[0].has_command && sent.every((c) => c.kind !== 'message') && sent.length === 1,
      `${label} cancels a turn that waits, and no message follows it when the box comes up (${shown(turns)}; commands ${sent.map((c) => String(c.kind)).join(', ') || 'none'})`)
  }
  {
    const w = await world('running', 'mac')
    await w.ask('Start this.')
    await tx(async (client) => interruptSession(client, await w.sessionId()))
    const turns = await turnsOf(w)
    const sent = await all(`select kind from commands where session_id = $1 order by created_at, id`, [await w.sessionId()])
    check(turns[0]?.status === 'placed' && turns[0].has_command && sent.map((c) => String(c.kind)).join() === 'message,interrupt',
      `an interrupt leaves a turn that already has its command, with the interrupt queued behind the message (${shown(turns)}; commands ${sent.map((c) => String(c.kind)).join(', ')})`)
  }

  // A person cancels a turn that waits for its machine, and nothing is sent when
  // the box comes up. A turn its machine has is refused, since an interrupt stops
  // that one, and so is a room's, which ends at its deadline.
  {
    const w = await world('cancelled')
    await w.ask('Never mind.')
    const waiting = String(must(await one('select id from turns where conversation_id = $1', [w.conversationId]), 'its turn').id)
    const result = await tx((client) => cancelWaitingTurn(client, TurnId.parse(waiting)))
    await up(w)
    await placeWaitingTurns([teamId], reportUnplaceableTurn)
    const turns = await turnsOf(w)
    check(result === 'cancelled' && turns[0]?.status === 'cancelled' && !turns[0].has_command && (await commandsOfConversation(w)).length === 0,
      `a person cancels a turn that waits, and no message follows it when the box comes up (${result}; ${shown(turns)})`)

    const started = await world('started', 'mac')
    await started.ask('Go.')
    const startedTurn = String(must(await one('select id from turns where conversation_id = $1', [started.conversationId]), 'its turn').id)
    const refused = await tx((client) => cancelWaitingTurn(client, TurnId.parse(startedTurn))).then((r) => r, (error: unknown) => `threw ${messageOf(error)}`)
    check(refused === 'not waiting' && (await turnsOf(started))[0]?.status === 'placed',
      `a turn whose message is already with its machine is refused, and goes on (${refused}; ${shown(await turnsOf(started))})`)

    const room = String(must(await one(`insert into conversations (team_id, kind, name) values ($1, 'room', $2) returning id`, [teamId, `room-${id}`]), 'the room').id)
    const agent = String(must(await one('select agent_id from conversations where id = $1', [w.conversationId]), 'the agent').agent_id)
    const roomTurn = await tx((client) => queueRoomTurn(client, { teamId, agentId: AgentId.parse(agent), conversationId: ConversationId.parse(room), askedBy: w.person.id, deadlineSec: 60 }))
    const roomResult = await tx((client) => cancelWaitingTurn(client, roomTurn))
    check(roomResult === 'room', `a room's turn is left to its deadline (${roomResult})`)
  }

  // A governed stage whose machine went silent fails, and what it held ends with
  // it. A message ends through the one writer, so its turn ends too, and a turn
  // that waits for a box that never came up is cancelled, so it is not sent when the
  // box returns. A stage on a machine that has reported lately is left alone.
  const PIPELINE = `export default {
    description: 'Works.', agent: 'scout', runsOn: 'home', spendCapUsd: 1, triggers: [{ kind: 'manual' }], start: 'work',
    stages: { work: { kind: 'agent', prompt: () => 'Work.', next: { work: { done: 'succeeded', note: 'ok' } } } },
  }`
  const rules = JSON.stringify(JSON.parse(readFileSync(join(ROOT, 'ops/policies/agents.json'), 'utf8')))
  const governedStage = async (w: World, label: string) => {
    const policy = must(await one(`insert into policies (team_id, name, version, rules, created_by) values ($1, $2, 1, $3, $4) returning id`,
      [teamId, `policy-${label}-${id}`, rules, w.person.id]), 'the policy').id
    const repo = must(await one(`insert into repos (team_id, remote_url, forge, owner_id, policy_id) values ($1, $2, 'gitea', $3, $4) returning id`,
      [teamId, `http://127.0.0.1:3000/door-23c/${label}-${id}.git`, w.person.id, policy]), 'the repo').id
    const task = must(await one(`insert into tasks (team_id, slug, title, owner_id, source) values ($1, $2, 'Governed work', $3, 'manual') returning id`,
      [teamId, `governed-${label}-${id}`, w.person.id]), 'the task').id
    await pool.query('insert into task_repos (task_id, repo_id, is_primary) values ($1, $2, true)', [task, repo])
    const version = await recordVersion(teamId, null, `gate-${label}-${id}`, 'pipelines/gate.ts', PIPELINE)
    const run = must(await one(`insert into runs (team_id, pipeline_version_id, task_id, trigger, status) values ($1, $2, $3, 'manual', 'running') returning *`,
      [teamId, version.versionId, task]), 'the run')
    const stage = must(await one(
      `insert into run_stages (team_id, run_id, n, stage, attempt, kind, status, session_id, started_at) values ($1, $2, 1, 'work', 1, 'agent', 'running', $3, now() - interval '20 minutes') returning *`,
      [teamId, run.id, String(await w.sessionId())]), 'the stage')
    return { run, stage, sessions: [await w.sessionId()] }
  }
  const silent = (w: World) => pool.query(`update instances set status = 'offline', ready = false, last_seen_at = now() - interval '20 minutes' where id = $1`, [w.boxId])
  const aged = async (w: World) => {
    await pool.query(`update commands set created_at = now() - interval '20 minutes' where session_id = (select id from sessions where conversation_id = $1)`, [w.conversationId])
    await pool.query(`update turns set requested_at = now() - interval '20 minutes' where conversation_id = $1`, [w.conversationId])
  }
  const stageStatus = async (stage: { id: string }) => String((await one('select status from run_stages where id = $1', [stage.id])).status)
  const commandsOf = async (w: World) => all(`select kind, status from commands where session_id = $1 and kind = 'message'`, [await w.sessionId()])

  {
    const w = await world('lostwaiting')
    await w.ask('Build it.')
    const { run, stage, sessions } = await governedStage(w, 'lostwaiting')
    await silent(w)
    await aged(w)
    const failed = await tx((client) => lostMachine(client, run, stage, sessions))
    const turns = await turnsOf(w)
    await up(w)
    await placeWaitingTurns([teamId], reportUnplaceableTurn)
    check(failed && await stageStatus(stage) === 'failed' && (await turnsOf(w))[0]?.status === 'cancelled' && (await commandsOf(w)).length === 0,
      `a stage whose turn waits for a box that never came up fails, and the turn is cancelled, so nothing is sent when the box returns (stage ${await stageStatus(stage)}, ${shown(turns)}, then ${shown(await turnsOf(w))})`)
  }
  {
    const w = await world('lostqueued', 'mac')
    await w.ask('Build it.')
    const { run, stage, sessions } = await governedStage(w, 'lostqueued')
    await silent(w)
    await aged(w)
    const failed = await tx((client) => lostMachine(client, run, stage, sessions))
    const turns = await turnsOf(w)
    const commands = await commandsOf(w)
    check(failed && await stageStatus(stage) === 'failed' && commands[0]?.status === 'failed' && turns[0]?.status === 'failed',
      `a stage whose message no machine took fails with the message, and its turn fails with it (stage ${await stageStatus(stage)}, message ${String(commands[0]?.status)}, ${shown(turns)})`)
  }
  {
    const w = await world('lostclaimed', 'mac')
    await w.ask('Build it.')
    const command = must(await one(`select id from commands where session_id = (select id from sessions where conversation_id = $1) and kind = 'message'`, [w.conversationId]), 'its message')
    await moveMessages(pool, [String(command.id)], 'handed_over')
    const { run, stage, sessions } = await governedStage(w, 'lostclaimed')
    await silent(w)
    await aged(w)
    const failed = await tx((client) => lostMachine(client, run, stage, sessions))
    const turns = await turnsOf(w)
    const commands = await commandsOf(w)
    check(failed && await stageStatus(stage) === 'failed' && commands[0]?.status === 'failed' && turns[0]?.status === 'failed',
      `a stage whose message a machine took and then went silent fails with the message, and its turn fails with it (stage ${await stageStatus(stage)}, message ${String(commands[0]?.status)}, ${shown(turns)})`)
  }
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : messageOf(error)}`)
} finally {
  if (!failures.length) await pool.query('delete from teams where name = $1', [team]).catch(() => undefined)
  await pool.end().catch(() => undefined)
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test team removed)'}`)
process.exit(failures.length ? 1 : 0)
