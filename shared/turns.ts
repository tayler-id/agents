// Every turn an agent is asked to take, from any source, and the one lifecycle
// each follows. server/scheduler.ts moves a turn until its message command is
// written, and moveMessages in server/durability.ts moves it after, with the
// command. "A scheduler places every turn" in docs/design/target-architecture.md
// has the design.

import { z } from 'zod'
import type { CommandStatus } from './lifecycle.ts'
import { AgentId, TurnId } from './ids.ts'
import { InstanceId } from './onboarding.ts'

export type TurnStatus = 'queued' | 'waiting' | 'placed' | 'running' | 'done' | 'failed' | 'cancelled'

// Why a turn can't go to its machine yet. Only a box holds a turn, since a box takes
// no work until its desktop is up. One a person or a run holds is starting, which
// the runner does. One nobody holds is offline until someone holds it.
export const WaitReason = z.enum(['computer_starting', 'machine_offline'])
export type WaitReason = z.infer<typeof WaitReason>

// Where a turn may go from each status. No move goes back, so no path can hand
// a turn to a machine twice.
export const TURN_MOVES = {
  // A room's turn waits here for the room to give it its go, and any other turn
  // passes through as it is requested. A room cancels one whose agent has no machine.
  queued: ['waiting', 'placed', 'cancelled'],
  // Its machine comes up, or a room's deadline passes first.
  waiting: ['placed', 'cancelled'],
  // The machine takes the message command, then the turn ends as the command does.
  placed: ['running'],
  running: ['done', 'failed'],
  done: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<TurnStatus, readonly TurnStatus[]>

// A placed turn's status for each status its message command moves to.
export const TURN_OF_COMMAND = {
  claimed: 'running', done: 'done', failed: 'failed',
} as const satisfies Record<Exclude<CommandStatus, 'queued'>, TurnStatus>

// What the app reads of a turn that waits, or that runs and has gone quiet, for
// the line its conversation shows. stuck_since is when it was last heard from.
export const TURN_WAIT_COLUMNS = ['id', 'agent_id', 'status', 'wait', 'instance_id', 'stuck_since']
export const TurnWaitRow = z.discriminatedUnion('status', [
  z.object({ id: TurnId, agent_id: AgentId, status: z.literal('waiting'), wait: WaitReason, instance_id: InstanceId, stuck_since: z.null() }),
  z.object({ id: TurnId, agent_id: AgentId, status: z.literal('running'), wait: z.null(), instance_id: InstanceId, stuck_since: z.string().min(1) }),
])
export type TurnWaitRow = z.infer<typeof TurnWaitRow>
