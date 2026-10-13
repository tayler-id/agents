// What the daemon needs from an agent harness. Claude is the first; Codex can
// implement the same interface later. docs/design/durability.md says what an
// engine must do for a turn to survive its machine dying.

import type { AnswerPayload, EventBatch } from '../shared/types.ts'

export type HarnessStart = {
  cwd: string
  model: string | null
  resume: string | null
  // The agent's own instructions, added to the harness's system prompt.
  instructions: string
  // MCP servers for this session, as a config file the harness reads.
  mcpConfig: string | null
  // Tools the harness may use without asking, such as the team-record tools.
  allowedTools: string[]
  // Changes to files inside cwd go ahead without asking, as in a task's workspace.
  acceptEdits: boolean
  // Stops the session once it has cost this much, in US dollars.
  maxBudgetUsd?: number
  // The Claude token this machine's owner signed in with from the app, or null to use the machine's own login.
  oauthToken: string | null
}

export interface HarnessSession {
  // False once the harness process has exited. A dead session cannot take a message.
  readonly alive: boolean
  // True while it holds a message that no turn's result has ended.
  readonly busy: boolean
  // The process to stop before this session runs anywhere else.
  readonly pid: number | undefined
  // Hands over a message. A message sent while a turn runs may join that turn.
  // `ids` are the message commands the text answers: one for a person's message,
  // every unfinished one for a resumed session. They come back in `ended` on the
  // batch that finishes them.
  send(text: string, ids: readonly string[]): void
  // Answers a permission request the harness raised as an ask event. Throws when
  // no such request is waiting in this process.
  answer(answer: AnswerPayload): void
  // Stops the current turn. The session stays open for the next message.
  interrupt(): void
  // Each update is one batch for the record. Ends when the harness process exits.
  updates(): AsyncIterable<EventBatch>
  stop(): void
}

export interface Harness {
  name: string
  start(options: HarnessStart): HarnessSession
}
