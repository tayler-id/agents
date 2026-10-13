// The read side. A client asks for a named shape, such as the messages of one
// conversation. The proxy decides who is asking, sets the table and the filter on
// the server, and streams Electric's answer back. Clients never choose the table
// or the filter, so a person only ever sees their team, minus private
// conversations and tasks they are not part of.

import { Readable } from 'node:stream'
import type { ReadableStream as WebReadable } from 'node:stream/web'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ELECTRIC_PROTOCOL_QUERY_PARAMS } from '@electric-sql/client'
import { instanceFrom, personFrom, type Instance } from './auth.ts'
import { canSeeConversation, canSeeSession, canSeeTask, VISIBLE_CONVERSATION, VISIBLE_TASK } from './access.ts'
import { maybe, pool } from './db.ts'
import type { Audience } from './http.ts'
import { HttpError, type Person } from './record.ts'
import { DOCUMENT_COLUMNS, FILE_CHANGE_COLUMNS, FILE_CHANGE_DETAIL_COLUMNS, PUSH_COLUMNS } from '../shared/work.ts'

const ELECTRIC_URL = process.env.ELECTRIC_URL ?? 'http://127.0.0.1:3000'

type Shape = { table: string; where: string; params: string[]; columns?: string[] }
type PersonShape = (person: Person, args: URLSearchParams) => Promise<Shape>
type InstanceShape = (instance: Instance, args: URLSearchParams) => Promise<Shape>

function arg(args: URLSearchParams, name: string): string {
  const value = args.get(name)
  if (!value || !/^[0-9a-f-]{36}$/.test(value)) throw new HttpError(400, `${name} must be an id`)
  return value
}

async function requireConversation(person: Person, args: URLSearchParams): Promise<string> {
  const id = arg(args, 'conversation')
  if (!(await canSeeConversation(person, id))) throw new HttpError(404, 'no such conversation')
  return id
}

// Invites and the logins waiting to join are for admins only.
function requireAdmin(person: Person) {
  if (person.role !== 'admin') throw new HttpError(403, 'Only team admins can see this.')
}

// Rows that hang off a task (a run's stages, a task's documents) are visible to
// whoever can see the task.
async function requireTaskOf(person: Person, sql: string, id: string): Promise<string> {
  const row = await maybe<{ task_id: string }>(pool, sql, [id, person.team_id])
  if (!row || !(await canSeeTask(person, row.task_id))) throw new HttpError(404, 'not found')
  return id
}

const personShapes: Record<string, PersonShape> = {
  people: async (p) => ({ table: 'people', where: 'team_id = $1', params: [p.team_id] }),
  // Never sync token hashes.
  instances: async (p) => ({
    table: 'instances', where: 'team_id = $1', params: [p.team_id],
    columns: ['id', 'team_id', 'name', 'kind', 'owner_id', 'harnesses', 'status', 'last_seen_at', 'created_at',
      'claimed_by', 'claimed_by_run', 'claimed_at', 'idle_since', 'personal', 'start_error'],
  }),
  invites: async (p) => {
    requireAdmin(p)
    return { table: 'invites', where: 'team_id = $1', params: [p.team_id] }
  },
  // Logins on no team, so not any team's. Every admin on the server sees them.
  join_requests: async (p) => {
    requireAdmin(p)
    return { table: 'join_requests', where: `status = 'waiting'`, params: [] }
  },
  // A person's own Claude sign-ins, with the link their box made. Nobody else sees them.
  claude_logins: async (p) => ({ table: 'claude_logins', where: 'person_id = $1', params: [p.id] }),
  agents: async (p) => ({ table: 'agents', where: 'team_id = $1 and archived_at is null', params: [p.team_id] }),
  conversations: async (p) => ({
    table: 'conversations',
    where: `team_id = $1 and archived_at is null and ${VISIBLE_CONVERSATION}`,
    params: [p.team_id, p.id],
  }),
  conversation_members: async (p) => ({ table: 'conversation_members', where: 'team_id = $1', params: [p.team_id] }),
  messages: async (p, args) => ({
    table: 'messages', where: 'conversation_id = $1', params: [await requireConversation(p, args)],
  }),
  // Sessions the person may see, either conversations' or tasks'. They are two
  // shapes because Electric 1.8 never sends a row that moves into a filter ORing
  // two subqueries, so a new task's session would never arrive.
  sessions: async (p, args) => {
    const of = args.get('of')
    if (of !== 'conversations' && of !== 'tasks') throw new HttpError(400, 'of must be conversations or tasks')
    const parent = of === 'tasks'
      ? `task_id in (select id from tasks where ${VISIBLE_TASK})`
      : `conversation_id in (select id from conversations where ${VISIBLE_CONVERSATION})`
    return { table: 'sessions', where: `team_id = $1 and archived_at is null and ${parent}`, params: [p.team_id, p.id] }
  },
  events: async (p, args) => {
    const sessionId = arg(args, 'session')
    if (!(await canSeeSession(p, sessionId))) throw new HttpError(404, 'no such session')
    return { table: 'events', where: 'session_id = $1', params: [sessionId] }
  },
  asks: async (p) => ({
    table: 'asks',
    where: `team_id = $1 and status = 'open' and (conversation_id is null
      or conversation_id in (select id from conversations where ${VISIBLE_CONVERSATION}))`,
    params: [p.team_id, p.id],
  }),
  tasks: async (p) => ({
    table: 'tasks', where: `team_id = $1 and archived_at is null and ${VISIBLE_TASK}`, params: [p.team_id, p.id],
  }),
  repos: async (p) => ({ table: 'repos', where: 'team_id = $1', params: [p.team_id] }),
  pipelines: async (p) => ({ table: 'pipelines', where: 'team_id = $1', params: [p.team_id] }),
  proposals: async (p) => ({ table: 'proposals', where: 'team_id = $1', params: [p.team_id] }),
  skills: async (p) => ({ table: 'skills', where: 'team_id = $1', params: [p.team_id] }),
  plugins: async (p) => ({ table: 'plugins', where: 'agent_id in (select id from agents where team_id = $1)', params: [p.team_id] }),
  routines: async (p) => ({ table: 'routines', where: 'agent_id in (select id from agents where team_id = $1)', params: [p.team_id] }),
  memories: async (p) => ({ table: 'memories', where: 'team_id = $1', params: [p.team_id] }),
  templates: async (p) => ({ table: 'templates', where: 'team_id = $1', params: [p.team_id] }),
  // Secret names a team's agents need, never values.
  secrets: async (p) => ({ table: 'secrets', where: 'team_id = $1', params: [p.team_id] }),
  turns: async (p, args) => ({ table: 'turns', where: 'conversation_id = $1', params: [await requireConversation(p, args)] }),
  comments: async (p, args) => ({
    table: 'comments', where: 'artifact_id = $1',
    params: [await requireTaskOf(p, 'select task_id from artifacts where id = $1 and team_id = $2', arg(args, 'artifact'))],
  }),
  pipeline_versions: async (p) => ({
    table: 'pipeline_versions', where: 'pipeline_id in (select id from pipelines where team_id = $1)', params: [p.team_id],
  }),
  runs: async (p) => ({
    table: 'runs', where: `team_id = $1 and task_id in (select id from tasks where ${VISIBLE_TASK})`, params: [p.team_id, p.id],
  }),
  run_stages: async (p, args) => ({
    table: 'run_stages', where: 'run_id = $1',
    params: [await requireTaskOf(p, 'select task_id from runs where id = $1 and team_id = $2', arg(args, 'run'))],
  }),
  artifacts: async (p, args) => {
    const taskId = arg(args, 'task')
    if (!(await canSeeTask(p, taskId))) throw new HttpError(404, 'no such task')
    return { table: 'artifacts', where: 'task_id = $1', params: [taskId] }
  },
  artifact_versions: async (p, args) => ({
    table: 'artifact_versions', where: 'artifact_id = $1',
    params: [await requireTaskOf(p, 'select task_id from artifacts where id = $1 and team_id = $2', arg(args, 'artifact'))],
  }),
  // A task's repos, for editing a draft.
  task_repos: async (p, args) => {
    const taskId = arg(args, 'task')
    if (!(await canSeeTask(p, taskId))) throw new HttpError(404, 'no such task')
    return { table: 'task_repos', where: 'task_id = $1', params: [taskId] }
  },
  // A task's changed files, without their contents, and one file with them.
  file_changes: async (p, args) => {
    const taskId = arg(args, 'task')
    if (!(await canSeeTask(p, taskId))) throw new HttpError(404, 'no such task')
    return { table: 'file_changes', where: 'task_id = $1', params: [taskId], columns: FILE_CHANGE_COLUMNS }
  },
  file_change: async (p, args) => ({
    table: 'file_changes', where: 'id = $1', columns: FILE_CHANGE_DETAIL_COLUMNS,
    params: [await requireTaskOf(p, 'select task_id from file_changes where id = $1 and team_id = $2', arg(args, 'id'))],
  }),
  // Every document of every task the person may see, without contents, for the palette.
  documents: async (p) => ({
    table: 'artifacts', where: `team_id = $1 and kind = 'document' and task_id in (select id from tasks where ${VISIBLE_TASK})`,
    params: [p.team_id, p.id], columns: DOCUMENT_COLUMNS,
  }),
  // Each time someone asked to open a task's pull requests, and how it went.
  pushes: async (p, args) => {
    const taskId = arg(args, 'task')
    if (!(await canSeeTask(p, taskId))) throw new HttpError(404, 'no such task')
    return { table: 'pushes', where: 'task_id = $1', params: [taskId], columns: PUSH_COLUMNS }
  },
}

const instanceShapes: Record<string, InstanceShape> = {
  // A machine's queue: the commands waiting for it.
  commands: async (i) => ({ table: 'commands', where: `instance_id = $1 and status = 'queued'`, params: [i.id] }),
  // The Claude sign-ins this box's owner has under way on it.
  claude_logins: async (i) => ({
    table: 'claude_logins', where: `instance_id = $1 and status in ('starting', 'waiting_for_code', 'checking')`, params: [i.id],
  }),
}

// Streams one shape request through to Electric with the server's own filter.
export async function proxyShape(req: IncomingMessage, res: ServerResponse, name: string, url: URL, audience: Audience) {
  let shape: Shape
  if (audience === 'machines' && instanceShapes[name]) {
    shape = await instanceShapes[name](await instanceFrom(req), url.searchParams)
  } else if (audience === 'people' && personShapes[name]) {
    shape = await personShapes[name](await personFrom(req), url.searchParams)
  } else {
    throw new HttpError(404, `no shape named ${name}`)
  }

  const origin = new URL('/v1/shape', ELECTRIC_URL)
  for (const [key, value] of url.searchParams) {
    if (ELECTRIC_PROTOCOL_QUERY_PARAMS.includes(key)) origin.searchParams.set(key, value)
  }
  origin.searchParams.set('table', shape.table)
  origin.searchParams.set('where', shape.where.replace(/\s+/g, ' '))
  shape.params.forEach((value, i) => origin.searchParams.set(`params[${i + 1}]`, value))
  if (shape.columns) origin.searchParams.set('columns', shape.columns.join(','))
  origin.searchParams.set('secret', process.env.ELECTRIC_SECRET ?? '')

  const abort = new AbortController()
  res.on('close', () => abort.abort())
  const upstream = await fetch(origin, { signal: abort.signal }).catch((error: unknown) => {
    if (abort.signal.aborted) return null
    throw error
  })
  if (!upstream) return
  const headers: Record<string, string> = {}
  upstream.headers.forEach((value, key) => {
    if (key !== 'content-encoding' && key !== 'content-length' && key !== 'transfer-encoding') headers[key] = value
  })
  // Electric marks catch-up responses cacheable for a CDN. Their URLs repeat (the
  // first snapshot, then the same follow-up offset), so a browser would keep
  // serving a stale copy. Only live requests, whose URLs never repeat, may cache.
  if (!url.searchParams.has('live')) headers['cache-control'] = 'no-store'
  res.writeHead(upstream.status, headers)
  if (upstream.body) {
    Readable.fromWeb(upstream.body as WebReadable).on('error', () => res.end()).pipe(res)
  } else {
    res.end()
  }
}
