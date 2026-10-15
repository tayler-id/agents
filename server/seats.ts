// A computer's seats: which agent holds each, the reclaim rule that gives an
// idle agent's seat to the next agent that needs one, and the seat a session
// runs on. The database makes each box's seat rows (migration 0015), and the
// box starts, clears and stops each seat's computer to match them
// (daemon/seats.ts). The design is "Seats" in docs/design/target-architecture.md.

import type pg from 'pg'
import { z } from 'zod'
import { many, maybe, one } from './db.ts'
import { HttpError } from './record.ts'
import { AgentId, SeatId, type SessionId } from '../shared/ids.ts'
import { IN_FLIGHT } from '../shared/lifecycle.ts'
import { movesInto, type InstanceId } from '../shared/onboarding.ts'
import { FIRST_SEAT, SEAT_MOVES, SeatNumber, SeatRow } from '../shared/seats.ts'

// An idle agent keeps its seat this long after its last turn there, so an agent
// someone talks to every few minutes keeps the pages it has open.
export const RECLAIM_IDLE_MIN = 15

const SEAT = 'id, team_id, instance_id, n, agent_id, status, held_since, last_turn_at'

// Where an agent's turn can run on a computer: the seat it holds, which it kept,
// took free or took back from an idle agent, or none while every seat is held
// by an agent that is busy or worked there in the last RECLAIM_IDLE_MIN.
export type Seated =
  | { kind: 'seated'; seat: SeatRow; how: 'kept' | 'free' | 'reclaimed' }
  | { kind: 'busy'; seats: number }

// The seat the reclaim rule takes back on a computer, or none. Its agent has
// no turn running or waiting there, nobody holds its screen, and its last turn
// there began the longest ago, more than RECLAIM_IDLE_MIN back.
async function reclaimable(client: pg.PoolClient, instanceId: InstanceId): Promise<SeatId | null> {
  const row = await maybe(client,
    `select s.id from seats s
     where s.instance_id = $1 and s.agent_id is not null
       and not exists (select 1 from sessions x where x.instance_id = s.instance_id and x.agent_id = s.agent_id and x.status = any($2))
       and not exists (select 1 from commands c join sessions x on x.id = c.session_id
                       where c.instance_id = s.instance_id and x.agent_id = s.agent_id and c.kind = 'message' and c.status in ('queued', 'claimed'))
       and not exists (select 1 from screen_takeovers t where t.seat_id = s.id and t.ended_at is null)
       and coalesce(s.last_turn_at, s.held_since) < now() - make_interval(mins => $3)
     order by coalesce(s.last_turn_at, s.held_since), s.n
     limit 1`, [instanceId, IN_FLIGHT, RECLAIM_IDLE_MIN])
  return row ? z.object({ id: SeatId }).parse(row).id : null
}

// Gives an agent a seat on a computer: the one it holds, else the free seat
// with the lowest number, else the one the reclaim rule takes back. The
// computer then starts the seat for the agent, closing the last agent's pages,
// and reports it up, which makes it ready.
export async function takeSeat(client: pg.PoolClient, instanceId: InstanceId, agentId: AgentId): Promise<Seated> {
  // One placement on a computer at a time, so two agents never take one free seat.
  const seats = (await many(client, `select ${SEAT} from seats where instance_id = $1 order by n for update`, [instanceId])).map((row) => SeatRow.parse(row))
  if (!seats.length) throw new HttpError(409, 'This machine has no seats. Only a box has seats.')
  const held = seats.find((seat) => seat.agent_id === agentId)
  if (held) return { kind: 'seated', seat: held, how: 'kept' }
  const free = seats.find((seat) => seat.status === 'free')
  const target = free?.id ?? await reclaimable(client, instanceId)
  if (target === null) return { kind: 'busy', seats: seats.length }
  const taken = SeatRow.parse(await one(client, 'the seat taken',
    `update seats set agent_id = $2, status = 'starting', held_since = now(), last_turn_at = null
     where id = $1 and status = any($3) returning ${SEAT}`, [target, agentId, movesInto(SEAT_MOVES, 'starting')]))
  return { kind: 'seated', seat: taken, how: free ? 'free' : 'reclaimed' }
}

const SessionAgent = z.object({ agent_id: AgentId.nullable() })
const SeatOf = z.object({ id: SeatId, n: SeatNumber, agent_id: AgentId.nullable() })

// The seat a session runs on when its machine starts it or hands it a message:
// the seat its agent holds on that computer, else seat 1, where every session
// on a box ran before seats. It is recorded on the session, for the screen's
// privacy rule and the app's Screen button, and a held seat counts the turn
// for the reclaim rule. Null on a machine without seats, such as a Mac.
export async function sessionSeat(client: pg.PoolClient, instanceId: InstanceId, sessionId: SessionId): Promise<SeatNumber | null> {
  const session = await maybe(client, 'select agent_id from sessions where id = $1 and instance_id = $2', [sessionId, instanceId])
  if (!session) throw new HttpError(404, 'no such session on this machine')
  const { agent_id: agentId } = SessionAgent.parse(session)
  const seats = (await many(client, 'select id, n, agent_id from seats where instance_id = $1 and (agent_id = $2 or n = $3)',
    [instanceId, agentId, FIRST_SEAT])).map((row) => SeatOf.parse(row))
  const held = seats.find((seat) => agentId !== null && seat.agent_id === agentId)
  const seat = held ?? seats.find((s) => s.n === FIRST_SEAT)
  if (!seat) return null
  await client.query('update sessions set seat_id = $2 where id = $1', [sessionId, seat.id])
  if (held) await client.query('update seats set last_turn_at = now() where id = $1', [held.id])
  return seat.n
}

// A machine reports a seat up for the agent it started it for. Only a seat
// still starting for that agent becomes ready, so a report that arrives after
// the seat went to another agent changes nothing.
export async function seatUp(db: pg.Pool | pg.PoolClient, instanceId: InstanceId, n: SeatNumber, agentId: AgentId): Promise<void> {
  await db.query(`update seats set status = 'ready' where instance_id = $1 and n = $2 and agent_id = $3 and status = any($4)`,
    [instanceId, n, agentId, movesInto(SEAT_MOVES, 'ready')])
}
