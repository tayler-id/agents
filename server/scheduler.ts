// The one door every turn goes through. A person's message, a room's go, a
// routine's firing and a pipeline's stage each become a row in turns, saying who
// asked and what for, and carrying what any place needs to run the turn: its
// session, the event that holds its prompt, and what the engine is handed. The
// scheduler picks the turn's place and writes its message command there once the
// machine takes work, or marks it waiting with the reason. No other file writes a
// message command. The runner's loop places waiting turns as their machines come
// up, and marks a running turn stuck when its session goes quiet. The design is
// "A scheduler places every turn" in docs/design/target-architecture.md.

import type pg from 'pg'
import { z } from 'zod'
import { many, maybe, one, pool, tx } from './db.ts'
import { InstanceId, movesInto } from '../shared/onboarding.ts'
import { messageOf } from '../shared/errors.ts'
import { WAITING_ON_PERSON } from '../shared/lifecycle.ts'
import { TURN_MOVES, type WaitReason } from '../shared/turns.ts'
import { TurnId, type SessionId } from '../shared/ids.ts'
import { MessagePayload } from '../shared/types.ts'

// How long a running turn may go without a new event before it is marked stuck,
// long enough for a slow build or test run between two steps. Nothing is stopped.
const STUCK_AFTER_MIN = 10

function stuckAfterSec(raw: string | undefined): number {
  if (raw === undefined) return STUCK_AFTER_MIN * 60
  const minutes = z.coerce.number().positive().safeParse(raw)
  if (!minutes.success) throw new Error('AGENTS_TURN_STUCK_MIN must be a number of minutes above 0')
  return minutes.data * 60
}
const STUCK_AFTER_SEC = stuckAfterSec(process.env.AGENTS_TURN_STUCK_MIN)

// Who asked for a turn, and what for. A person's message is for the DM or room
// it was posted in, or the task whose session it went to. A routine's firing is
// for its agent's main conversation, and a pipeline's stage, reminder or replay
// for its run.
type Asker = { teamId: string; agentId: string }
export type TurnAsk = Asker & (
  | { source: 'person'; askedBy: string; conversationId: string }
  | { source: 'person'; askedBy: string; taskId: string }
  | { source: 'routine'; askedBy: string | null; conversationId: string; routineId: string }
  | { source: 'pipeline'; runId: string }
)
// A room's turn waits in the room's line, without a prompt, until the room gives
// it its go. The deadline is how long it may take once it has the go.
export type RoomTurnAsk = Asker & { conversationId: string; askedBy: string; deadlineSec: number }
// What the engine runs: the session the turn's record goes to, the place in it of
// the user event that holds the prompt, and what the engine is handed.
export type Prompt = { sessionId: string; seq: number; payload: MessagePayload }

// The machine a session's turns run on, and whether it takes work now. A box takes
// none until it is online and its daemon has reported in since it last went
// offline, which is once its desktop is up, and none while it is marked asleep,
// since the runner is about to stop it. A Mac takes commands whenever its daemon
// comes, so a turn for one goes to its queue at once, even while the Mac is
// offline, as it did before the door. A box is held when a person or a run holds
// it, which is when the runner starts it.
const TAKES_WORK = `(i.kind <> 'box' or (i.status = 'online' and i.ready and i.stopped_at is null))`
const Machine = z.object({ id: InstanceId, held: z.boolean(), takes_work: z.boolean() })
type Machine = z.infer<typeof Machine>

// Where a session's turns run. Each runs on the machine its session started on,
// since the engine's own transcript, which resuming needs, lives there. This is
// the one place the choice is made, so a place of another kind, such as the
// server running the engine's loop itself (decision 1, option b), is another
// answer here, not a change to any caller. It reads the machine's row with a key
// share lock, which the runner's mark that puts a box to sleep waits for, so a
// turn is placed on a box before the mark or waits for it after, never between.
async function whereTurnsRun(client: pg.PoolClient, sessionId: string): Promise<Machine> {
  return Machine.parse(await one(client, `the machine of session ${sessionId}`,
    `select i.id, i.claimed_by is not null or i.claimed_by_run is not null as held, ${TAKES_WORK} as takes_work
     from sessions s join instances i on i.id = s.instance_id where s.id = $1 for key share of i`, [sessionId]))
}

// Only a box waits. The runner starts a box a person or a run holds, and one nobody
// holds stays offline until someone does.
const waitFor = (machine: Machine): WaitReason => (machine.held ? 'computer_starting' : 'machine_offline')

// Each move a turn can make before its machine takes it, with what that state holds.
type Move =
  | { to: 'waiting'; wait: WaitReason; instanceId: string }
  | { to: 'placed'; instanceId: string; commandId: string }
  | { to: 'cancelled' | 'failed' }

// Moves a turn on, only from a status the lifecycle allows. A refused move is a
// bug, so it throws, having changed nothing.
async function moveTurn(client: pg.PoolClient, turnId: string, move: Move) {
  const instanceId = move.to === 'waiting' || move.to === 'placed' ? move.instanceId : null
  const moved = await maybe(client,
    `update turns set status = $2::text, wait = $3,
       instance_id = coalesce($4, instance_id), command_id = coalesce($5, command_id),
       placed_at = case when $2::text = 'placed' then now() else placed_at end,
       finished_at = case when $2::text in ('cancelled', 'failed') then now() else finished_at end
     where id = $1 and status = any($6) returning id`,
    [turnId, move.to, move.to === 'waiting' ? move.wait : null, instanceId,
      move.to === 'placed' ? move.commandId : null, movesInto(TURN_MOVES, move.to)])
  if (!moved) throw new Error(`turn ${turnId} cannot move to ${move.to} from where it is`)
}

// What the runner does for a turn it gives up on, because the request it stored no
// longer reads. The turn is failed first, and this tells the person why.
export type GiveUp = (client: pg.PoolClient, turn: { turnId: TurnId; sessionId: string; reason: string }) => Promise<void>

// Places a session's unplaced turns, oldest first, on the machine its turns run
// on, when that machine takes work. Until then each one waits, with the reason.
// The caller holds the session's row, so its turns go in the order they were asked for.
// A turn whose stored request no longer reads, as after a release that added a
// field to it, is failed and reported through `giveUp`, so it does not hold up the
// turns behind it. A request, which has just built its own, has no one to give up to.
async function placeSession(client: pg.PoolClient, sessionId: string, giveUp?: GiveUp) {
  const turns = await many<{ id: string; team_id: string; status: 'queued' | 'waiting'; event_id: string; payload: unknown }>(client,
    `select id, team_id, status, event_id, payload from turns
     where session_id = $1 and status in ('queued', 'waiting') and payload is not null
     order by requested_at, id for update`, [sessionId])
  if (!turns.length) return
  const machine = await whereTurnsRun(client, sessionId)
  // Nothing starts a session while its turns wait. A new one would otherwise
  // read as starting, which the app shows as the agent thinking, and which the
  // watchdog marks lost once the machine stays silent, so it reads as idle.
  if (!machine.takes_work) await client.query(`update sessions set status = 'idle' where id = $1 and status = 'starting'`, [sessionId])
  for (const turn of turns) {
    if (machine.takes_work) {
      const request = MessagePayload.safeParse(turn.payload)
      if (!request.success) {
        const issue = request.error.issues[0]
        const reason = `The message could not be sent to the agent, because what it carries no longer reads (${issue ? `${issue.path.join('.') || 'the request'}: ${issue.message}` : 'unreadable'}).`
        if (!giveUp) throw new Error(`turn ${turn.id}: ${reason}`)
        console.error(`turn ${turn.id}: ${reason}`)
        await moveTurn(client, turn.id, { to: 'failed' })
        await giveUp(client, { turnId: TurnId.parse(turn.id), sessionId, reason })
        continue
      }
      // clock_timestamp, unlike now, moves on within a transaction, so turns placed
      // together keep the order they were asked in where a machine or a resume reads them.
      const command = await one<{ id: string }>(client, 'the message command',
        `insert into commands (team_id, instance_id, session_id, kind, payload, event_id, created_at)
         values ($1, $2, $3, 'message', $4, $5, clock_timestamp()) returning id`,
        [turn.team_id, machine.id, sessionId, JSON.stringify(request.data), turn.event_id])
      await moveTurn(client, turn.id, { to: 'placed', instanceId: machine.id, commandId: command.id })
    } else if (turn.status === 'queued') {
      await moveTurn(client, turn.id, { to: 'waiting', wait: waitFor(machine), instanceId: machine.id })
    }
  }
}

// The one way into the queue for a turn with its prompt, or for a room's turn
// that the room has given its go. It comes after the prompt went into the
// session, and is placed at once when its machine takes work.
export async function requestTurn(client: pg.PoolClient, turn: TurnAsk | { queued: TurnId }, prompt: Prompt): Promise<TurnId> {
  // Placing takes the session's row first, as appending its prompt did, and as the
  // runner's loop does, so the two never wait on each other.
  await client.query('select 1 from sessions where id = $1 for update', [prompt.sessionId])
  const event = await one<{ id: string }>(client, 'the turn\'s prompt in its session',
    'select id from events where session_id = $1 and seq = $2', [prompt.sessionId, prompt.seq])
  const payload = JSON.stringify(prompt.payload)
  const row = 'queued' in turn
    ? await one<{ id: string }>(client, `room turn ${turn.queued}, queued without a prompt`,
      `update turns set session_id = $2, event_id = $3, payload = $4
       where id = $1 and status = 'queued' and session_id is null returning id`, [turn.queued, prompt.sessionId, event.id, payload])
    : await one<{ id: string }>(client, 'the new turn',
      `insert into turns (team_id, agent_id, source, conversation_id, task_id, run_id, routine_id, asked_by_person,
         session_id, event_id, payload, status, requested_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'queued', clock_timestamp()) returning id`,
      [turn.teamId, turn.agentId, turn.source,
        'conversationId' in turn ? turn.conversationId : null, 'taskId' in turn ? turn.taskId : null,
        turn.source === 'pipeline' ? turn.runId : null, turn.source === 'routine' ? turn.routineId : null,
        turn.source === 'pipeline' ? null : turn.askedBy, prompt.sessionId, event.id, payload])
  await placeSession(client, prompt.sessionId)
  return TurnId.parse(row.id)
}

// A turn in a room's line. clock_timestamp, unlike now, moves on within a
// transaction, so turns queued together keep their order.
export async function queueRoomTurn(client: pg.PoolClient, turn: RoomTurnAsk): Promise<TurnId> {
  const row = await one<{ id: string }>(client, 'the room turn',
    `insert into turns (team_id, agent_id, source, conversation_id, asked_by_person, status, requested_at, deadline)
     values ($1, $2, 'room', $3, $4, 'queued', clock_timestamp(), now() + make_interval(secs => $5)) returning id`,
    [turn.teamId, turn.agentId, turn.conversationId, turn.askedBy, turn.deadlineSec])
  return TurnId.parse(row.id)
}

// A turn that never reached its machine and no longer should.
export async function cancelTurn(client: pg.PoolClient, turnId: string) {
  await moveTurn(client, turnId, { to: 'cancelled' })
}

// A person cancels a turn that waits for its machine. A room's turn is left to
// its deadline, which ends its place in the room's line, and a turn its machine has
// is stopped with an interrupt. Says what became of the request.
export async function cancelWaitingTurn(client: pg.PoolClient, turnId: TurnId): Promise<'cancelled' | 'not waiting' | 'room' | 'missing'> {
  const turn = await maybe<{ status: string; source: string }>(client, 'select status, source from turns where id = $1 for update', [turnId])
  if (!turn) return 'missing'
  if (turn.source === 'room') return 'room'
  if (turn.status !== 'waiting') return 'not waiting'
  await moveTurn(client, turnId, { to: 'cancelled' })
  return 'cancelled'
}

// Cancels the turns of a session that have not reached its machine. A turn that
// waits has no message command yet, so a stop or an interrupt written now would
// queue ahead of the message the scheduler writes later, find nothing to stop, and
// let the turn start. A room's turn also ends its line, which the room moves on from.
export async function cancelWaitingTurns(client: pg.PoolClient, sessionId: SessionId) {
  const turns = await many<{ id: string; source: string }>(client,
    `select id, source from turns where session_id = $1 and status in ('queued', 'waiting') order by requested_at, id for update`, [sessionId])
  for (const turn of turns) {
    if (turn.source === 'room') await client.query(`update turns set outcome = coalesce(outcome, 'cancelled') where id = $1`, [turn.id])
    await moveTurn(client, turn.id, { to: 'cancelled' })
  }
}

// The one writer of stop and interrupt commands, as this file is of message
// commands. It cancels the session's turns that wait before it writes the command,
// in the caller's transaction, so none of them is sent after it.
export async function signalSession(client: pg.PoolClient, sessionId: SessionId, kind: 'stop' | 'interrupt') {
  await cancelWaitingTurns(client, sessionId)
  await client.query(
    `insert into commands (team_id, instance_id, session_id, kind) select team_id, instance_id, id, $2 from sessions where id = $1`, [sessionId, kind])
}

// Places the turns waiting on machines that take work now, one session at a
// time, the one that has waited longest first. A session a request holds is left
// to that request, which places the session's turns in order itself. placeSession
// decides again, under the lock. One session that cannot be placed, for a reason
// of its own, must not keep the sessions behind it waiting, so its error is
// logged and the next tick tries it again.
export async function placeWaitingTurns(teamIds: string[] | null, giveUp: GiveUp) {
  const sessions = await many<{ session_id: string }>(pool,
    `select t.session_id from turns t join instances i on i.id = t.instance_id
     where t.status = 'waiting' and ${TAKES_WORK} and ($1::uuid[] is null or t.team_id = any($1))
     group by t.session_id order by min(t.requested_at), t.session_id`, [teamIds])
  for (const { session_id: sessionId } of sessions) {
    try {
      await tx(async (client) => {
        if (await maybe(client, 'select 1 from sessions where id = $1 for update skip locked', [sessionId])) await placeSession(client, sessionId, giveUp)
      })
    } catch (error) {
      console.error(`placing the turns of session ${sessionId}: ${messageOf(error)}`)
    }
  }
}

// When a running turn was last heard from: its session's newest event, or the
// moment its machine took it, whichever is later.
const LAST_HEARD = `greatest(t.started_at, (select e.created_at from events e where e.session_id = t.session_id order by e.seq desc limit 1))`

// Marks each running turn whose session has had no new event for
// AGENTS_TURN_STUCK_MIN, 10 minutes by default, with when it was last heard
// from, and clears the mark when an event comes. A session that waits for a
// person to answer is quiet because of them, so it is not marked. Nothing is stopped.
export async function markStuckTurns(teamIds: string[] | null) {
  await pool.query(
    `update turns t set stuck_since = ${LAST_HEARD}
     where t.status = 'running' and t.stuck_since is null and ($2::uuid[] is null or t.team_id = any($2))
       and ${LAST_HEARD} < now() - make_interval(secs => $1)
       and not exists (select 1 from sessions s where s.id = t.session_id and s.status = any($3))`, [STUCK_AFTER_SEC, teamIds, WAITING_ON_PERSON])
  await pool.query(
    `update turns t set stuck_since = null
     where t.status = 'running' and t.stuck_since is not null and ($1::uuid[] is null or t.team_id = any($1))
       and ${LAST_HEARD} > t.stuck_since`, [teamIds])
}
