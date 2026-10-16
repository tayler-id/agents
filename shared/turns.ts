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
  // A turn whose stored request no longer reads fails, since it can never be sent.
  queued: ['waiting', 'placed', 'cancelled', 'failed'],
  // Its machine comes up, or a room's deadline passes first, or a person or a stop
  // cancels it before its machine has it.
  waiting: ['placed', 'cancelled', 'failed'],
  // The machine takes the message command, then the turn ends as the command does.
  // The runner can also give up on a command no machine took, and then it fails.
  placed: ['running', 'failed'],
  running: ['done', 'failed'],
  done: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<TurnStatus, readonly TurnStatus[]>

// A placed turn's status for each status its message command moves to.
export const TURN_OF_COMMAND = {
  claimed: 'running', done: 'done', failed: 'failed',
} as const satisfies Record<Exclude<CommandStatus, 'queued'>, TurnStatus>

// Who or what asked for a turn, as the turns table keeps it. An agent turn
// carries one agent's message to another, or the answer back. A delegation turn
// starts a task one agent handed another, or carries its result back.
export const TurnSource = z.enum(['person', 'room', 'routine', 'pipeline', 'agent', 'delegation'])
export type TurnSource = z.infer<typeof TurnSource>

// What the app reads of a turn that waits, or that runs and has gone quiet, for
// the line its conversation or task shows. stuck_since is when it was last heard
// from, and source says whether a person may cancel it, which they may not for a
// room's turn.
export const TURN_WAIT_COLUMNS = ['id', 'agent_id', 'status', 'wait', 'instance_id', 'stuck_since', 'source']
export const TurnWaitRow = z.discriminatedUnion('status', [
  z.object({ id: TurnId, agent_id: AgentId, status: z.literal('waiting'), wait: WaitReason, instance_id: InstanceId, stuck_since: z.null(), source: TurnSource }),
  z.object({ id: TurnId, agent_id: AgentId, status: z.literal('running'), wait: z.null(), instance_id: InstanceId, stuck_since: z.string().min(1), source: TurnSource }),
])
export type TurnWaitRow = z.infer<typeof TurnWaitRow>

// What the line for a turn says to the person reading it. A machine not read yet is
// named for what it is to the turn, until the next read names it. `owner` is the
// person whose computer it is, and `clock` says a time as the reader's page does.
// The app shows this line, and step23 reads it from the rows a page reads.
export function turnLine(turn: TurnWaitRow, machine: { name: string; personal: boolean; owner_id: string | null } | undefined,
  viewer: string, owner: { name: string | null; login: string } | undefined, clock: (time: string) => string): string {
  if (turn.status === 'running') return `No new step since ${clock(turn.stuck_since)}. It may be stuck.`
  if (!machine) return turn.wait === 'computer_starting' ? 'Starting its computer' : 'Waiting for its machine, which is offline'
  if (turn.wait === 'machine_offline') return `Waiting for ${machine.name}, which is offline`
  if (!machine.personal || !machine.owner_id) return `Starting ${machine.name}`
  if (machine.owner_id === viewer) return 'Starting your computer'
  return owner ? `Starting ${owner.name ?? owner.login}'s computer` : `Starting ${machine.name}`
}
