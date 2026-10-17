// Seats, defined once for the server, the daemon and the app. A seat is one
// agent's place on a computer, with a display, a browser and a screen of its
// own. These are the rows of the `seats` table, how a seat's status moves, and
// what a machine and the API tell each other about seats. The design is
// "Seats" in docs/design/target-architecture.md.

import { z } from 'zod'
import { AgentId, SeatId, TeamId } from './ids.ts'
import { InstanceId } from './onboarding.ts'

// Inside the computer, seat n has display :n and its browser's DevTools port
// is 9221 + n, so seat 1 keeps the display :1 and port 9222 a box had before
// seats. The `seats` table allows 16, which end below port 9238.
export const MAX_SEATS = 16
export const SeatNumber = z.int().min(1).max(MAX_SEATS)
export type SeatNumber = z.infer<typeof SeatNumber>
// A seat's number as a route's path names it.
export const SeatInPath = z.string().regex(/^[1-9][0-9]?$/).transform(Number).pipe(SeatNumber)
// The seat that runs whenever its computer runs, and the one a box session
// runs on when its agent holds no seat on that computer, as all of a box's
// sessions did before seats.
export const FIRST_SEAT: SeatNumber = 1

export const SEAT_STATUSES = ['free', 'starting', 'ready'] as const
export type SeatStatus = (typeof SEAT_STATUSES)[number]

// Postgres's driver gives a timestamp as a Date, and Electric as text.
const Time = z.union([z.string().min(1), z.date().transform((date) => date.toISOString())])

const seatBase = { id: SeatId, team_id: TeamId, instance_id: InstanceId, n: SeatNumber, last_turn_at: Time.nullable() }
// A free seat holds no agent. A held one is starting for its agent until the
// computer reports it up, then ready.
export const SeatRow = z.discriminatedUnion('status', [
  z.object({ ...seatBase, status: z.literal('free'), agent_id: z.null(), held_since: z.null() }),
  z.object({ ...seatBase, status: z.literal('starting'), agent_id: AgentId, held_since: Time }),
  z.object({ ...seatBase, status: z.literal('ready'), agent_id: AgentId, held_since: Time }),
])
export type SeatRow = z.infer<typeof SeatRow>

// Where a seat's status may go. An agent takes a free seat. A seat given to
// another agent starts again for that agent, which closes the pages and windows
// the last one had open, and only a seat still starting for its agent becomes ready.
export const SEAT_MOVES = {
  free: ['starting'],
  starting: ['starting', 'ready'],
  ready: ['starting'],
} as const satisfies Record<SeatStatus, readonly SeatStatus[]>

// The seat a session runs on, as the API answers its machine: a number, or
// null on a machine without seats. With it comes the agent the seat is held by,
// which the machine waits to see as the holder before it starts the session
// there, so the last agent's pages are gone first. Null when no agent holds it.
export const SessionSeat = z.object({ seat: SeatNumber.nullable(), agentId: AgentId.nullable() })
export type SessionSeat = z.infer<typeof SessionSeat>

// A machine's report that a seat is up for the agent it was started for.
export const SeatUp = z.object({ agentId: AgentId })
export type SeatUp = z.infer<typeof SeatUp>
