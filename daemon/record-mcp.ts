// The team-record tools every agent session gets: search everything the team's
// people and agents have said and done, read one session, and see what is
// happening now. Claude starts this as an MCP server over stdio. It reads the
// record through the API, as the session it serves.
// Env: AGENTS_API, AGENTS_TOKEN, AGENTS_SESSION (set by the daemon in the session's MCP config).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const API = process.env.AGENTS_API ?? 'http://127.0.0.1:7700'
const TOKEN = process.env.AGENTS_TOKEN ?? ''
const SESSION = process.env.AGENTS_SESSION ?? ''

async function get<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const query = new URLSearchParams({ session: SESSION, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) })
  const res = await fetch(`${API}${path}?${query}`, { headers: { authorization: `Bearer ${TOKEN}` } })
  const json: unknown = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(errorOf(json) ?? `the record answered ${res.status}`)
  // The API's answers are this repo's own types.
  return json as T
}

const errorOf = (json: unknown): string | undefined =>
  typeof json === 'object' && json !== null && 'error' in json && typeof json.error === 'string' ? json.error : undefined

async function send(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${API}${path}?${new URLSearchParams({ session: SESSION })}`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(errorOf(await res.json().catch(() => ({}))) ?? `the record answered ${res.status}`)
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })
const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '')
const strip = (snippet: string) => snippet.replace(/<\/?b>/g, '')

type Hit = {
  source: string; session_id: string | null; seq: string; kind: string; tool_name: string | null
  agent: string | null; person: string | null; snippet: string; created_at: string
}

const server = new McpServer({ name: 'team-record', version: '1.0.0' })

server.registerTool('search_record', {
  title: 'Search the team record',
  description: 'Search everything your team\'s people and agents have said and done, on every machine: messages, '
    + 'tool calls, command output and replies. Use it before starting work, to find earlier fixes, decisions and '
    + 'related work by teammates. Plain words work; any word can match.',
  inputSchema: { query: z.string().describe('What to look for, in plain words or exact error text'), limit: z.number().int().min(1).max(50).optional() },
}, async ({ query, limit }) => {
  const { hits } = await get<{ hits: Hit[] }>('/v1/record/search', { q: query, limit: limit ?? 10 })
  if (!hits.length) return text(`Nothing in the team record matches "${query}".`)
  return text(hits.map((h) => [
    `${h.source === 'event' ? `session ${h.session_id} step ${h.seq}` : 'conversation post'} · ${h.kind}${h.tool_name ? ` ${h.tool_name}` : ''}`
      + ` · ${h.agent ?? 'agent'}${h.person ? ` for ${h.person}` : ''} · ${when(h.created_at)}`,
    strip(h.snippet),
  ].join('\n')).join('\n\n') + '\n\nUse read_session with a session id to see the whole session.')
})

server.registerTool('read_session', {
  title: 'Read a session',
  description: 'Read what one agent session did, step by step: the messages it got, its tool calls and their output, and its replies.',
  inputSchema: { session_id: z.string(), from_step: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(200).optional() },
}, async ({ session_id, from_step, limit }) => {
  const { session, events } = await get<{
    session: { agent: string; person: string | null; status: string; turns: number; created_at: string }
    events: { seq: number; kind: string; tool_name: string | null; text: string; created_at: string }[]
  }>(`/v1/record/sessions/${session_id}`, { from: from_step ?? 1, limit: limit ?? 60 })
  const head = `Session ${session_id}: ${session.agent}${session.person ? ` for ${session.person}` : ''}, ${session.status}, ${session.turns} turns, started ${when(session.created_at)}`
  return text([head, ...events.map((e) => `${e.seq}. ${e.kind}${e.tool_name ? ` ${e.tool_name}` : ''}: ${e.text}`)].join('\n'))
})

server.registerTool('recent_activity', {
  title: 'Recent team activity',
  description: 'See which agent sessions on the team were active recently, who asked for what, and their latest reply.',
  inputSchema: { hours: z.number().int().min(1).max(336).optional() },
}, async ({ hours }) => {
  const { sessions } = await get<{ sessions: { id: string; agent: string; person: string | null; status: string; last_active_at: string; asked: string | null; last_reply: string | null }[] }>(
    '/v1/record/recent', { hours: hours ?? 24 })
  if (!sessions.length) return text('No other team sessions were active in that time.')
  return text(sessions.map((s) => `session ${s.id} · ${s.agent}${s.person ? ` for ${s.person}` : ''} · ${s.status} · ${when(s.last_active_at)}\n`
    + `asked: ${s.asked ?? '(nothing)'}\nlatest reply: ${s.last_reply ?? '(none yet)'}`).join('\n\n'))
})

server.registerTool('pipeline_history', {
  title: "A pipeline's recent runs",
  description: "See how a pipeline's recent runs went: each stage's outcome and summary, how often an agent had to be "
    + 'reminded to report, hand-offs to people, what people said at gates, and what each run cost.',
  inputSchema: { name: z.string().describe('The pipeline, such as bug-fix'), limit: z.number().int().min(1).max(30).optional() },
}, async ({ name, limit }) => {
  const { runs } = await get<{ runs: {
    id: string; status: string; note: string | null; title: string; version: string; cost_usd: number | null; created_at: string
    stages: { n: number; stage: string; attempt: number; kind: string; status: string; outcome: string | null; summary: string
      session_id: string | null; reminders: number; decision: string | null; said: string | null; by: string | null }[]
  }[] }>(`/v1/record/pipelines/${encodeURIComponent(name)}/history`, { limit: limit ?? 10 })
  if (!runs.length) return text(`No finished runs of ${name} yet.`)
  return text(runs.map((r) => [
    `run ${r.id} · "${r.title}" · ${r.status} · version ${r.version.slice(0, 8)} · $${(r.cost_usd ?? 0).toFixed(2)} · ${when(r.created_at)}`,
    r.note ? `ended: ${r.note}` : '',
    ...r.stages.map((s) => `  ${s.n}. ${s.stage}${s.attempt > 1 ? ` (try ${s.attempt})` : ''} [${s.kind}] ${s.outcome ?? s.status}`
      + `${s.reminders ? ` · reminded ${s.reminders}x` : ''}${s.decision ? ` · ${s.by} said ${s.decision}${s.said ? `: ${s.said}` : ''}` : ''}`
      + `${s.session_id ? ` · session ${s.session_id}` : ''}${s.summary ? `\n     ${s.summary.replace(/\n/g, '\n     ')}` : ''}`),
  ].filter(Boolean).join('\n')).join('\n\n'))
})

server.registerTool('update_memory', {
  title: 'Update what you remember',
  description: 'Keep your memory of a person or of the team current. A profile is what you know about them, rewritten whole. '
    + "A log adds a dated note to today's log, such as what you did for someone or a preference they stated.",
  inputSchema: {
    about: z.string().describe("A teammate's login, or team"),
    kind: z.enum(['profile', 'log']),
    content: z.string().min(1).max(20_000),
  },
}, async ({ about, kind, content }) => {
  await send('/v1/record/memory', { about, kind, content })
  return text(kind === 'profile' ? `Updated your profile of ${about}.` : `Added to today's notes on ${about}.`)
})

server.registerTool('agent_profile', {
  title: "An agent's profile",
  description: "Read a teammate agent's role, model, instructions and skills.",
  inputSchema: { name: z.string() },
}, async ({ name }) => {
  const agent = await get<{ name: string; title: string | null; role: string | null; model: string | null; instructions: string; skills: { name: string; description: string }[] }>(
    `/v1/record/agents/${encodeURIComponent(name)}`, {})
  return text([
    `${agent.name}${agent.title ? `, ${agent.title}` : ''}${agent.model ? ` (${agent.model})` : ''}`,
    `instructions:\n${agent.instructions || '(none)'}`,
    agent.skills.length ? `skills: ${agent.skills.map((s) => `${s.name}: ${s.description}`).join('; ')}` : 'skills: none',
  ].join('\n\n'))
})

await server.connect(new StdioServerTransport())
