// The team-agents tools every agent session gets but a pipeline stage's: see the
// team's other agents, message one, hand one a task, report back on a task one
// handed you, and make a new agent, which asks your owner first. Claude starts
// this as an MCP server over stdio. It acts through the API as the session it
// serves, and the API checks every call: who may message whom, how long a chain
// of agents may grow, and the owner's yes behind a new agent.
// Env: AGENTS_API, AGENTS_TOKEN, AGENTS_SESSION (set by the daemon in the session's MCP config).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  AgentMade, DelegateTask, MAX_HOPS, MessageSent, NewAgentAsk, Reported, ReportBack, SendToAgent, TaskHanded, TEAM_AGENTS_SERVER, TeamAgents,
} from '../shared/team-agents.ts'

const Env = z.object({ AGENTS_API: z.url(), AGENTS_TOKEN: z.string().min(1), AGENTS_SESSION: z.uuid() })
const env = Env.safeParse(process.env)
if (!env.success) throw new Error(`the team-agents tools need their session's settings: ${z.prettifyError(env.error)}`)
const { AGENTS_API: API, AGENTS_TOKEN: TOKEN, AGENTS_SESSION: SESSION } = env.data

const ApiError = z.object({ error: z.string() })

// One call to the API as this session, with its answer read through `answer`.
async function call<S extends z.ZodType>(answer: S, method: 'GET' | 'POST', path: string, body?: unknown): Promise<z.output<S>> {
  const res = await fetch(`${API}${path}?${new URLSearchParams({ session: SESSION })}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error(ApiError.safeParse(json).data?.error ?? `the API answered ${res.status}`)
  return answer.parse(json)
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })

const server = new McpServer({ name: TEAM_AGENTS_SERVER, version: '1.0.0' })

server.registerTool('list_agents', {
  title: "Your team's agents",
  description: "See the other agents on your team: what each does, whose it is, and whether it takes your messages. An agent takes messages from its owner's other agents, and from other people's agents only when its owner allows it.",
  inputSchema: {},
}, async () => {
  const { agents } = await call(TeamAgents, 'GET', '/v1/team-agents')
  return text(agents.map((a) => [
    a.you ? `${a.name} (you)` : a.name, a.title ?? 'no title', a.owner ? `${a.owner}'s` : 'no owner',
    a.you ? '' : a.takesYourMessages ? 'takes your messages' : 'does not take your messages',
  ].filter(Boolean).join(' · ')).join('\n'))
})

server.registerTool('send_to_agent', {
  title: 'Message another agent',
  description: 'Send a message to another agent on your team, such as asking it to write or check something. It returns at once. '
    + 'The other agent answers in its own time, and its answer comes back to you here as a new message, so finish your turn after sending. '
    + `People can read your thread with that agent. A chain of agents messaging agents stops after ${MAX_HOPS} hops.`,
  inputSchema: SendToAgent.shape,
}, async (ask) => {
  const sent = await call(MessageSent, 'POST', '/v1/team-agents/messages', ask)
  return text(`Sent to ${ask.to}, hop ${sent.hops} of at most ${MAX_HOPS}. Its answer comes back to you here when ${ask.to} replies.`)
})

server.registerTool('delegate_task', {
  title: 'Hand a task to another agent',
  description: 'Hand a piece of work to another agent on your team as a task of its own, with its own workspace. It returns at once. '
    + 'When the other agent reports back, or a person marks the task done, the result comes back to you here as a new message.',
  inputSchema: DelegateTask.shape,
}, async (ask) => {
  const handed = await call(TaskHanded, 'POST', '/v1/team-agents/tasks', ask)
  return text(`Handed "${ask.title}" to ${ask.to} as task ${handed.taskId}. Its result comes back to you here. `
    + `read_session with session ${handed.sessionId} shows how it is going.`)
})

server.registerTool('report_back', {
  title: 'Report back on a task',
  description: 'Send the result of a task another agent handed you back to that agent, and mark the task done. Call it once, when the task is finished.',
  inputSchema: ReportBack.shape,
}, async (ask) => {
  const reported = await call(Reported, 'POST', '/v1/team-agents/report', ask)
  return text(`Sent your result to ${reported.to}, and the task is done.`)
})

// The engine asks a person before every call, since the daemon never allows this
// tool without asking, and the API makes the agent only with that yes behind it.
server.registerTool('create_agent', {
  title: 'Make a new agent',
  description: 'Make a new agent on your team, owned by your owner and on your machine. Your owner is asked first, and says yes or no to exactly what you send.',
  inputSchema: NewAgentAsk.shape,
}, async (ask) => {
  const made = await call(AgentMade, 'POST', '/v1/team-agents/agents', ask)
  return text(`Made ${made.name}, ${made.owner}'s new agent.`)
})

await server.connect(new StdioServerTransport())
