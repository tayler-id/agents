// What agents use to work together, defined once for the server, the daemon's
// team-agents tools and the app: the tools' names, what each sends the API and
// what it gets back, and the limit on a chain of agents. The design is "Agents
// creating, messaging and delegating to agents" in docs/design/target-architecture.md.

import { z } from 'zod'
import { AgentId, ConversationId, SessionId, TaskId, TurnId } from './ids.ts'
import { NAME } from './types.ts'
import { TaskFields, TEXT_MAX } from './work.ts'

// A chain of agents stops after this many hops, Tayler's call on 2026-10-16,
// until budgets put a ceiling on what a chain spends. A message or a handed-over
// task from a turn is one hop more than that turn.
export const MAX_HOPS = 4

// The MCP server each session but a pipeline stage's gets, beside team-record.
export const TEAM_AGENTS_SERVER = 'team-agents'
const tool = (name: string) => `mcp__${TEAM_AGENTS_SERVER}__${name}`
// Making an agent always asks a person, its maker's owner, so it is never allowed
// without asking. The API also refuses one that no answered ask lets.
export const CREATE_AGENT_TOOL = tool('create_agent')
export const TEAM_AGENT_TOOLS_ALLOWED = ['list_agents', 'send_to_agent', 'delegate_task', 'report_back'].map(tool)

// Who may message an agent and hand it tasks: agents with its owner, or any agent on the team.
export const AcceptsAgents = z.enum(['owner', 'team'])
export type AcceptsAgents = z.infer<typeof AcceptsAgents>
// POST /v1/agents/:id/accepts, from the agent's owner.
export const SetAccepts = z.object({ agents: AcceptsAgents })
export type SetAccepts = z.infer<typeof SetAccepts>

// GET /v1/team-agents: the team's agents as the asking agent sees them.
// `takesYourMessages` says whether a message from it would be let through.
export const TeamAgent = z.object({
  name: z.string(), title: z.string().nullable(), owner: z.string().nullable(), you: z.boolean(), takesYourMessages: z.boolean(),
})
export const TeamAgents = z.object({ agents: z.array(TeamAgent) })
export type TeamAgents = z.infer<typeof TeamAgents>

const MessageText = z.string().trim().min(1).max(TEXT_MAX)

// POST /v1/team-agents/messages: a message to another agent.
export const SendToAgent = z.object({ to: z.string().min(1), text: MessageText })
export type SendToAgent = z.infer<typeof SendToAgent>
export const MessageSent = z.object({ threadId: ConversationId, turnId: TurnId, hops: z.number().int() })
export type MessageSent = z.infer<typeof MessageSent>

// POST /v1/team-agents/tasks: a task handed to another agent.
export const DelegateTask = z.object({ to: z.string().min(1), title: TaskFields.shape.title, instructions: TaskFields.shape.instructions })
export type DelegateTask = z.infer<typeof DelegateTask>
export const TaskHanded = z.object({ taskId: TaskId, sessionId: SessionId, hops: z.number().int() })
export type TaskHanded = z.infer<typeof TaskHanded>

// POST /v1/team-agents/report: the result of a handed-over task, from its session.
export const ReportBack = z.object({ text: MessageText })
export type ReportBack = z.infer<typeof ReportBack>
export const Reported = z.object({ to: z.string(), turnId: TurnId })
export type Reported = z.infer<typeof Reported>

// POST /v1/team-agents/agents: the agent its owner said yes to, exactly as the ask showed it.
export const NewAgentAsk = z.object({
  name: z.string().regex(NAME, 'a name is lowercase letters, digits and dashes, starting with a letter, at most 40'),
  title: z.string().trim().min(1).max(80).optional(),
  instructions: z.string().max(20_000).optional(),
})
export type NewAgentAsk = z.infer<typeof NewAgentAsk>
export const AgentMade = z.object({ agentId: AgentId, name: z.string(), owner: z.string() })
export type AgentMade = z.infer<typeof AgentMade>
