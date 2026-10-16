import { z } from 'zod'
import { SUITE_PAYLOAD, VERIFY_PAYLOAD } from './framework.ts'
import { WebmcpOrigins } from './webmcp.ts'

export const EVENT_KINDS = [
  'user', 'assistant', 'thinking', 'tool_call', 'tool_result', 'ask', 'answer', 'notice', 'error', 'usage',
] as const
export type EventKind = (typeof EVENT_KINDS)[number]
// The kinds a person writes, what they say and their answer to an ask. Only these carry an author.
export const PERSON_KINDS: readonly EventKind[] = ['user', 'answer']

export const SESSION_STATUSES = [
  'draft', 'starting', 'running', 'idle', 'needs_input', 'needs_approval', 'limited', 'lost', 'failed',
] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

// The most a request body may hold. The API refuses a bigger one with 413, and
// the daemon sizes its posts of a transcript to fit.
export const MAX_BODY_BYTES = 20 * 1024 * 1024

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

// The Claude Code hooks an agent's setup can name. A hook runs a command on the
// agent's machine when its event happens. The two tool events can say which tools
// they apply to, and the others take no matcher.
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop'] as const
export const HookEvent = z.enum(HOOK_EVENTS)
export type HookEvent = z.infer<typeof HookEvent>
const TOOL_HOOK_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse']
export const takesMatcher = (event: HookEvent) => TOOL_HOOK_EVENTS.includes(event)
// The longest time limit a hook may be given, since a hook holds up the turn it runs in. A hook
// with no limit gets Claude Code's own, which cancelled one on a message after 30 seconds and let
// one on each other event run past 130.
export const HOOK_TIMEOUT_MAX_SEC = 600
export const HOOK_COMMAND_MAX = 2000
export const HOOK_MATCHER_MAX = 200
export const AgentHook = z.object({
  name: z.string().regex(NAME, 'a hook name is lowercase letters, digits and dashes'),
  event: HookEvent,
  matcher: z.string().min(1).max(HOOK_MATCHER_MAX).nullable().default(null),
  command: z.string().trim().min(1).max(HOOK_COMMAND_MAX),
  timeoutSec: z.number().int().min(1).max(HOOK_TIMEOUT_MAX_SEC).nullable().default(null),
}).refine((hook) => hook.matcher === null || takesMatcher(hook.event), {
  path: ['matcher'], message: 'only PreToolUse and PostToolUse hooks name the tools they apply to',
})
export type AgentHook = z.infer<typeof AgentHook>

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
  // The agent's skills, its plugins (MCP servers), its hooks and what it remembers.
  // A session sent no hooks, such as a pipeline stage's, runs none.
  skills: z.array(AgentSkill).optional(),
  plugins: z.array(AgentPlugin).optional(),
  hooks: z.array(AgentHook).optional(),
  memory: z.string().optional(),
  // The sites whose WebMCP tools the agent's browser may take, as the team lists them now. Left out, there are none.
  webmcpOrigins: WebmcpOrigins.optional(),
})
export type MessagePayload = z.infer<typeof MessagePayload>

// A task's workspace: one folder per task attempt with a clone of each repo on
// the task's branch, and a task folder beside them for documents.
// `commit`, when set, starts the branch there instead of at the base branch's tip,
// as a replay of a past run does.
export const WorkspaceRepo = z.object({
  repoId: z.string(), name: z.string(), branch: z.string(), base: z.string(), setup: z.string().nullable(), commit: z.string().optional(),
})
export type WorkspaceRepo = z.infer<typeof WorkspaceRepo>
export const SetupWorkspacePayload = z.object({ workspaceId: z.string(), repos: z.array(WorkspaceRepo) })
export type SetupWorkspacePayload = z.infer<typeof SetupWorkspacePayload>

// A command run in one of a workspace's repos, for a pipeline's checks.
export const ExecPayload = z.object({ workspaceId: z.string(), repo: z.string(), command: z.string(), timeoutSec: z.number() })
export type ExecPayload = z.infer<typeof ExecPayload>
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
export const AnswerPayload = z.object({
  requestId: z.string(), behavior: z.enum(['allow', 'deny']), message: z.string().optional(), updatedInput: z.unknown().optional(),
})
export type AnswerPayload = z.infer<typeof AnswerPayload>

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

// A command a machine claims, by kind. A message is a session's, and its payload is
// read on its own where it is claimed, so a payload this machine can't use fails
// that turn with the reason. The other kinds are read whole.
export const MessageCommand = z.object({ id: z.string(), kind: z.literal('message'), sessionId: z.string(), payload: MessagePayload })
export const OtherCommand = z.discriminatedUnion('kind', [
  z.object({ id: z.string(), kind: z.literal('answer'), sessionId: z.string(), payload: AnswerPayload }),
  z.object({ id: z.string(), kind: z.enum(['interrupt', 'stop']), sessionId: z.string(), payload: z.object({}) }),
  z.object({ id: z.string(), kind: z.literal('setup_workspace'), sessionId: z.null(), payload: SetupWorkspacePayload }),
  z.object({ id: z.string(), kind: z.literal('exec'), sessionId: z.null(), payload: ExecPayload }),
  z.object({ id: z.string(), kind: z.literal('push'), sessionId: z.null(), payload: PUSH_PAYLOAD }),
  z.object({ id: z.string(), kind: z.literal('verify'), sessionId: z.null(), payload: VERIFY_PAYLOAD }),
  z.object({ id: z.string(), kind: z.literal('suite'), sessionId: z.null(), payload: SUITE_PAYLOAD }),
])
export type Command = z.infer<typeof MessageCommand> | z.infer<typeof OtherCommand>
