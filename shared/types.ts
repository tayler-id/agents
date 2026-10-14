import { z } from 'zod'
import type { SuitePayload, VerifyPayload } from './framework.ts'

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
  ended?: EndedMessages
}

// What a session may do without asking a person, beyond the tools it is given.
// The server decides from where the session runs: in a task's workspace the
// agent may change files inside it. Commands always ask.
export const Permissions = z.object({ workspaceWrites: z.boolean() })
export type Permissions = z.infer<typeof Permissions>

// The message commands a batch finishes. A turn that printed its result answered
// the messages it took in. A harness that exited still holding messages failed
// them, for the reason it gives.
export const EndedMessages = z.discriminatedUnion('how', [
  z.object({ how: z.literal('answered'), ids: z.array(z.uuid()).min(1) }),
  z.object({ how: z.literal('exited'), ids: z.array(z.uuid()).min(1), reason: z.string() }),
])
export type EndedMessages = z.infer<typeof EndedMessages>

export const AgentSkill = z.object({ name: z.string(), description: z.string(), content: z.string() })
export type AgentSkill = z.infer<typeof AgentSkill>
// Env and header values name a secret. The daemon fills them in from its machine.
export const SecretRef = z.object({ secret: z.string() })
export type SecretRef = z.infer<typeof SecretRef>
export const AgentPlugin = z.discriminatedUnion('kind', [
  z.object({
    name: z.string(), kind: z.literal('stdio'),
    config: z.object({ command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string(), SecretRef).optional() }),
  }),
  z.object({ name: z.string(), kind: z.literal('http'), config: z.object({ url: z.string(), headers: z.record(z.string(), SecretRef).optional() }) }),
])
export type AgentPlugin = z.infer<typeof AgentPlugin>

// A pipeline stage's session: the outcomes its report_result tool accepts, the
// tools it may use without asking, and the most it may spend. The budget is
// required, so a stage payload without one fails the daemon's parse instead of
// starting Claude with no cap. The server sends it here too, where daemons
// before the payload's own maxBudgetUsd read it. An isolated session, such as a
// reviewer's, gets no team-record tools, so it cannot read the session of the
// agent whose work it judges.
export const StageSpec = z.object({
  outcomes: z.array(z.string()), allow: z.array(z.string()), maxBudgetUsd: z.number(), isolated: z.boolean(),
})
export type StageSpec = z.infer<typeof StageSpec>

// What a daemon needs to hand a person's message to an agent's harness.
export const MessagePayload = z.object({
  permissions: Permissions,
  text: z.string(),
  agentId: z.string(),
  harness: z.enum(['claude', 'codex']),
  model: z.string().nullable(),
  instructions: z.string(),
  harnessSessionId: z.string().nullable(),
  // A task's session runs in the task's workspace instead of the agent's folder.
  workspaceId: z.string().optional(),
  // Set when the session runs a pipeline stage.
  stage: StageSpec.optional(),
  // The most the session may spend, for a pipeline stage or a replay.
  maxBudgetUsd: z.number().optional(),
  // The agent's skills, its plugins (MCP servers) and what it remembers.
  skills: z.array(AgentSkill).optional(),
  plugins: z.array(AgentPlugin).optional(),
  memory: z.string().optional(),
})
export type MessagePayload = z.infer<typeof MessagePayload>

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
// and counts the commits each holds past its base branch. The machine reads the
// forge's branch before pushing, and never pushes over commits it has not seen.
// The daemon parses it, since it arrives as JSON.
export const PUSH_PAYLOAD = z.object({
  workspaceId: z.uuid(),
  repos: z.array(z.object({ repoId: z.uuid(), name: z.string().min(1), branch: z.string().min(1), base: z.string().min(1) })),
  message: z.string(),
  author: z.string().min(1),
})
export type PushPayload = z.infer<typeof PUSH_PAYLOAD>
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

// A session a restarted machine resumes. The command is its oldest unfinished
// message, carrying the text that resumes the session, and the turn that takes
// it in answers every message in `covers`.
export const ResumeTurn = z.object({
  command: z.object({ id: z.uuid(), kind: z.literal('message'), sessionId: z.uuid(), payload: MessagePayload }),
  covers: z.array(z.uuid()).min(1),
})
export type ResumeTurn = z.infer<typeof ResumeTurn>
// What a machine gets back when it reports in after starting. `ended` counts the
// messages a person's interrupt ended, and `gaveUp` those of turns that stopped
// their machine too many times to resume again.
export const Recovery = z.object({
  requeued: z.number().int(), resumed: z.array(ResumeTurn), ended: z.number().int(), gaveUp: z.number().int(),
})
export type Recovery = z.infer<typeof Recovery>

export type Command =
  | { id: string; kind: 'message'; sessionId: string; payload: MessagePayload }
  | { id: string; kind: 'answer'; sessionId: string; payload: AnswerPayload }
  | { id: string; kind: 'interrupt' | 'stop'; sessionId: string; payload: Record<string, never> }
  | { id: string; kind: 'setup_workspace'; sessionId: null; payload: SetupWorkspacePayload }
  | { id: string; kind: 'exec'; sessionId: null; payload: ExecPayload }
  | { id: string; kind: 'push'; sessionId: null; payload: PushPayload }
  | { id: string; kind: 'verify'; sessionId: null; payload: VerifyPayload }
  | { id: string; kind: 'suite'; sessionId: null; payload: SuitePayload }
