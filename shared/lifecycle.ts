// The lifecycle of a message an agent is asked to answer, and the session
// statuses it depends on. docs/design/durability.md explains both, and
// moveMessages in server/durability.ts is the only writer of a message's status.

import type { SessionStatus } from './types.ts'

// A session whose harness may be working on a turn right now.
export const WORKING: readonly SessionStatus[] = ['starting', 'running', 'needs_approval', 'needs_input']
// The app reads a session's status as a plain string.
export const isWorking = (status: string): boolean => WORKING.some((working) => working === status)
// A session that is waiting for a person, who is why it says nothing new.
export const WAITING_ON_PERSON: readonly SessionStatus[] = ['needs_input', 'needs_approval']
// A session whose turn is not over: working now, or cut off with its machine and
// to be resumed. Its agent may still change files, and a person can interrupt it.
export const IN_FLIGHT: readonly SessionStatus[] = [...WORKING, 'lost']
export const inFlight = (status: string): boolean => IN_FLIGHT.some((state) => state === status)

// How often a daemon tells the API its machine is up.
export const HEARTBEAT_SEC = 15
// A machine silent for three heartbeats has stopped answering, and its working
// sessions show as lost. Less than two would mark a machine whose heartbeat is
// merely late.
export const MACHINE_LOST_AFTER_SEC = 3 * HEARTBEAT_SEC
export const MACHINE_LOST_AFTER_MIN_SEC = 2 * HEARTBEAT_SEC

export const MESSAGE_STATES = ['queued', 'handed_over', 'interrupted', 'done', 'failed'] as const
export type MessageState = (typeof MESSAGE_STATES)[number]

// Where a message may go from each state. A message never goes back to the
// queue, since handing it over again would run its turn twice, and a finished
// message never changes.
export const MESSAGE_MOVES = {
  queued: ['handed_over'],
  // A turn ends, the harness exits, or its machine stops.
  handed_over: ['done', 'failed', 'interrupted'],
  // The machine resumes it, a person's interrupt ends it, or the turn turns out
  // to have gone on, as after a network outage.
  interrupted: ['handed_over', 'done', 'failed'],
  done: [],
  failed: [],
} as const satisfies Record<MessageState, readonly MessageState[]>

export type CommandStatus = 'queued' | 'claimed' | 'done' | 'failed'

// A message's command's status in each state. Handed over and interrupted differ
// only in the session's status, which is lost when interrupted.
export const COMMAND_STATUS_OF = {
  queued: 'queued', handed_over: 'claimed', interrupted: 'claimed', done: 'done', failed: 'failed',
} as const satisfies Record<MessageState, CommandStatus>

// The statuses MESSAGE_MOVES lets a message's command leave for the status of
// `to`. A move that keeps the command's status, such as a machine stopping,
// changes only the session's.
export function commandSources(to: MessageState): CommandStatus[] {
  const from = MESSAGE_STATES.filter((state) => {
    const moves: readonly MessageState[] = MESSAGE_MOVES[state]
    return moves.includes(to) && COMMAND_STATUS_OF[state] !== COMMAND_STATUS_OF[to]
  })
  return [...new Set(from.map((state) => COMMAND_STATUS_OF[state]))]
}
