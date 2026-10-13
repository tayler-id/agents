// The lifecycle of a message an agent is asked to answer, and the session
// statuses it depends on. docs/design/durability.md explains both.

import type { SessionStatus } from './types.ts'

// A session whose harness may be working on a turn right now.
export const WORKING: readonly SessionStatus[] = ['starting', 'running', 'needs_approval', 'needs_input']

// How often a daemon tells the API its machine is up.
export const HEARTBEAT_SEC = 15
// A machine silent this long has stopped answering, and its working sessions
// show as lost: three missed heartbeats. Less than two would mark a machine
// whose heartbeat is merely late.
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

// A message's state, from its command's status and its session's status.
export function messageState(command: CommandStatus, session: SessionStatus): MessageState {
  switch (command) {
    case 'queued': return 'queued'
    case 'claimed': return session === 'lost' ? 'interrupted' : 'handed_over'
    case 'done': return 'done'
    case 'failed': return 'failed'
  }
}

export function moveMessage(from: MessageState, to: MessageState): MessageState {
  const allowed: readonly MessageState[] = MESSAGE_MOVES[from]
  if (!allowed.includes(to)) throw new Error(`a message cannot go from ${from} to ${to}`)
  return to
}
