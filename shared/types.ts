import { z } from 'zod'

export const EVENT_KINDS = [
  'user', 'assistant', 'thinking', 'tool_call', 'tool_result', 'ask', 'answer', 'notice', 'error', 'usage',
] as const
export type EventKind = (typeof EVENT_KINDS)[number]

export const SESSION_STATUSES = [
  'draft', 'starting', 'running', 'idle', 'needs_input', 'needs_approval', 'limited', 'lost', 'failed',
] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

// Agent, skill and plugin names. A skill's name is also its folder on each machine.
export const NAME = /^[a-z][a-z0-9-]{0,39}$/

// One entry for the record. The typed fields are what search, sync and the app read.
export type NewEvent = {
  clientId: string
  kind: EventKind
  body: unknown
  text?: string
  toolUseId?: string
  toolName?: string
  parentToolUseId?: string
}

// A line exactly as the harness printed it.
export type RawLine = { clientId: string; line: unknown }

// One token chunk for a session's live stream: which message, which content
// block, text or thinking, and the new text. Never stored in Postgres.
// `end` marks the end of a block, so text held back for scrubbing can be sent.
export type LiveDelta = { m: string; b: number; k: 'text' | 'thinking'; d: string; p: string | null; end?: true }

// What a harness produces for one session. The daemon posts everything but
// `live` to the API, and appends `live` to the session's stream.
export type EventBatch = {
  events: NewEvent[]
  raw?: RawLine[]
  live?: LiveDelta[]
  status?: SessionStatus
  harnessSessionId?: string
}

// What a session may do without asking a person, beyond the tools it is given.
// The server decides from where the session runs: in a task's workspace the
// agent may change files inside it. Commands always ask.
export const Permissions = z.object({ workspaceWrites: z.boolean() })
export type Permissions = z.infer<typeof Permissions>

// What a daemon needs to hand a person's message to an agent's harness.
export type MessagePayload = {
  permissions: Permissions
  text: string
  agentId: string
  harness: 'claude' | 'codex'
  model: string | null
  instructions: string
  harnessSessionId: string | null
  // A task's session runs in the task's workspace instead of the agent's folder.
  workspaceId?: string
  // Set when the session runs a pipeline stage.
  stage?: StageSpec
  // The agent's skills, its plugins (MCP servers) and what it remembers.
  skills?: AgentSkill[]
  plugins?: AgentPlugin[]
  memory?: string
}

export type AgentSkill = { name: string; description: string; content: string }
// Env and header values name a secret. The daemon fills them in from its machine.
export type SecretRef = { secret: string }
export type AgentPlugin =
  | { name: string; kind: 'stdio'; config: { command: string; args?: string[]; env?: Record<string, SecretRef> } }
  | { name: string; kind: 'http'; config: { url: string; headers?: Record<string, SecretRef> } }

// A pipeline stage's session: the outcomes its report_result tool accepts, the
// tools it may use without asking, and the most it may spend.
export type StageSpec = { outcomes: string[]; allow: string[]; maxBudgetUsd: number }

// A task's workspace: one folder per task attempt with a clone of each repo on
// the task's branch, and a task folder beside them for documents.
// `commit`, when set, starts the branch there instead of at the base branch's tip,
// as a replay of a past run does.
export type WorkspaceRepo = { repoId: string; name: string; branch: string; base: string; setup: string | null; commit?: string }
export type SetupWorkspacePayload = { workspaceId: string; repos: WorkspaceRepo[] }

// A command run in one of a workspace's repos, for a pipeline's checks.
export type ExecPayload = { workspaceId: string; repo: string; command: string; timeoutSec: number }
export type ExecResult = { exitCode: number | null; output: string; timedOut: boolean }

// Commits whatever changed in the workspace's repos, pushes each task branch,
// and counts the commits each holds past its base branch.
export type PushPayload = {
  workspaceId: string; repos: { repoId: string; name: string; branch: string; base: string }[]; message: string; author: string
}
// The server reads a push's result back from its command's JSON column, so it is parsed.
export const PushResult = z.object({
  pushed: z.array(z.object({ repoId: z.string(), commit: z.string(), ahead: z.number().int().min(0) })),
})
export type PushResult = z.infer<typeof PushResult>

// How a person answered an ask, as the harness needs it.
export type AnswerPayload = {
  requestId: string
  behavior: 'allow' | 'deny'
  message?: string
  updatedInput?: unknown
}

export type Command =
  | { id: string; kind: 'message'; sessionId: string; payload: MessagePayload }
  | { id: string; kind: 'answer'; sessionId: string; payload: AnswerPayload }
  | { id: string; kind: 'interrupt' | 'stop'; sessionId: string; payload: Record<string, never> }
  | { id: string; kind: 'setup_workspace'; sessionId: null; payload: SetupWorkspacePayload }
  | { id: string; kind: 'exec'; sessionId: null; payload: ExecPayload }
  | { id: string; kind: 'push'; sessionId: null; payload: PushPayload }
