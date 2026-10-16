// The read side. A client asks for a named shape, such as the messages of one
// conversation. The proxy decides who is asking, sets the table and the filter on
// the server, and streams Electric's answer back. Clients never choose the table
// or the filter, so a person only ever sees their team, minus private
// conversations and tasks they are not part of.

import { Readable } from 'node:stream'
import type { ReadableStream as WebReadable } from 'node:stream/web'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { instanceFrom, personFrom, type Instance } from './auth.ts'
import { canSeeConversation, canSeeSession, canSeeTask, VISIBLE_CONVERSATION, VISIBLE_FOLDER, VISIBLE_TASK } from './access.ts'
import { maybe, pool } from './db.ts'
import type { Audience } from './http.ts'
import { HttpError, type Person } from './record.ts'
import { DOCUMENT_COLUMNS, FILE_CHANGE_COLUMNS, FILE_CHANGE_DETAIL_COLUMNS, PUSH_COLUMNS, UNLISTED_CHANGE_COLUMNS } from '../shared/work.ts'
import { TURN_WAIT_COLUMNS } from '../shared/turns.ts'
import { AttachmentShapeRow, PinShapeRow, ReactionShapeRow } from '../shared/attachments.ts'

const ELECTRIC_URL = process.env.ELECTRIC_URL ?? 'http://127.0.0.1:3000'

// The keys of a client's read that reach Electric, each one Electric 1.8.1 reads.
// offset and handle say where the reader is, and live holds the read open for the
// next change. Electric answers each live read with a cursor that differs from
// the one sent, so no live URL repeats and no browser answers one from its cache.
// Every other key is dropped, including any a later Electric client adds.
const CLIENT_KEYS = ['offset', 'handle', 'live', 'cursor']

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

// A chat or a task's session the person may see, named by `conversation` or `session`. The filter on its
// rows is by the column that names it.
async function placeOf(person: Person, args: URLSearchParams): Promise<{ column: 'conversation_id' | 'session_id'; id: string }> {
  if (args.has('session')) {
    const id = arg(args, 'session')
    if (!(await canSeeSession(person, id))) throw new HttpError(404, 'no such session')
    return { column: 'session_id', id }
  }
  return { column: 'conversation_id', id: await requireConversation(person, args) }
}

const ATTACHMENT_COLUMNS = Object.keys(AttachmentShapeRow.shape)
const REACTION_COLUMNS = Object.keys(ReactionShapeRow.shape)

const personShapes: Record<string, PersonShape> = {
  people: async (p) => ({ table: 'people', where: 'team_id = $1', params: [p.team_id] }),
  // Never sync token hashes.
  instances: async (p) => ({
    table: 'instances', where: 'team_id = $1', params: [p.team_id],
    columns: ['id', 'team_id', 'name', 'kind', 'owner_id', 'harnesses', 'status', 'last_seen_at', 'created_at',
      'claimed_by', 'claimed_by_run', 'claimed_at', 'idle_since', 'personal', 'start_error', 'screen_width', 'screen_height', 'stopped_at'],
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
  // The files in a chat or a task's session. A file nobody has sent yet is its uploader's alone.
  attachments: async (p, args) => {
    const place = await placeOf(p, args)
    return {
      table: 'attachments', columns: ATTACHMENT_COLUMNS, params: [place.id, p.id],
      where: `${place.column} = $1 and (message_id is not null or event_id is not null or added_by_person = $2)`,
    }
  },
  reactions: async (p, args) => {
    const place = await placeOf(p, args)
    return { table: 'reactions', columns: REACTION_COLUMNS, where: `${place.column} = $1`, params: [place.id] }
  },
  // The messages pinned in a chat.
  pins: async (p, args) => ({ table: 'pins', columns: Object.keys(PinShapeRow.shape), where: 'conversation_id = $1', params: [await requireConversation(p, args)] }),
  // Sessions the person may see: conversations', tasks', or the terminal sessions
  // of connected folders. They are separate shapes because Electric 1.8 never
  // sends a row that moves into a filter ORing two subqueries, so a new task's
  // session would never arrive.
  sessions: async (p, args) => {
    const of = args.get('of')
    if (of !== 'conversations' && of !== 'tasks' && of !== 'folders') throw new HttpError(400, 'of must be conversations, tasks or folders')
    const parent = of === 'tasks'
      ? `task_id in (select id from tasks where ${VISIBLE_TASK})`
      : of === 'folders'
        ? `folder_id in (select id from connected_folders where ${VISIBLE_FOLDER})`
        : `conversation_id in (select id from conversations where ${VISIBLE_CONVERSATION})`
    return { table: 'sessions', where: `team_id = $1 and archived_at is null and ${parent}`, params: [p.team_id, p.id] }
  },
  // The team's connected folders the person may see, to name where a terminal session ran.
  connected_folders: async (p) => ({ table: 'connected_folders', where: `team_id = $1 and ${VISIBLE_FOLDER}`, params: [p.team_id, p.id] }),
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
  // Projects and the repos asked of GitHub for them. Everyone on the team sees every one.
  projects: async (p) => ({ table: 'projects', where: 'team_id = $1 and archived_at is null', params: [p.team_id] }),
  repo_requests: async (p) => ({ table: 'repo_requests', where: 'team_id = $1', params: [p.team_id] }),
  // The documents and links that a project's tasks made.
  project_artifacts: async (p, args) => {
    const projectId = arg(args, 'project')
    if (!(await maybe(pool, 'select 1 from projects where id = $1 and team_id = $2', [projectId, p.team_id]))) throw new HttpError(404, 'no such project')
    return {
      table: 'artifacts', where: `task_id in (select id from tasks where team_id = $1 and project_id = $3 and ${VISIBLE_TASK})`,
      params: [p.team_id, p.id, projectId],
    }
  },
  pipelines: async (p) => ({ table: 'pipelines', where: 'team_id = $1', params: [p.team_id] }),
  proposals: async (p) => ({ table: 'proposals', where: 'team_id = $1', params: [p.team_id] }),
  // Hunks quote only team sessions, since coach reads no private ones.
  proposal_hunks: async (p) => ({ table: 'proposal_hunks', where: 'team_id = $1', params: [p.team_id] }),
  skills: async (p) => ({ table: 'skills', where: 'team_id = $1', params: [p.team_id] }),
  plugins: async (p) => ({ table: 'plugins', where: 'agent_id in (select id from agents where team_id = $1)', params: [p.team_id] }),
  routines: async (p) => ({ table: 'routines', where: 'agent_id in (select id from agents where team_id = $1)', params: [p.team_id] }),
  agent_hooks: async (p) => ({ table: 'agent_hooks', where: 'agent_id in (select id from agents where team_id = $1)', params: [p.team_id] }),
  memories: async (p) => ({ table: 'memories', where: 'team_id = $1', params: [p.team_id] }),
  templates: async (p) => ({ table: 'templates', where: 'team_id = $1', params: [p.team_id] }),
  // Secret names a team's agents need, never values.
  secrets: async (p) => ({ table: 'secrets', where: 'team_id = $1', params: [p.team_id] }),
  // A conversation's turns, or a task's, that wait for their machine, or that run
  // and have gone quiet, for the line it shows. Never the prompt each turn carries.
  turn_waits: async (p, args) => {
    const waiting = `(status = 'waiting' or (status = 'running' and stuck_since is not null))`
    if (args.has('task')) {
      const task = arg(args, 'task')
      if (!(await canSeeTask(p, task))) throw new HttpError(404, 'no such task')
      return { table: 'turns', where: `task_id = $1 and ${waiting}`, params: [task], columns: TURN_WAIT_COLUMNS }
    }
    return { table: 'turns', where: `conversation_id = $1 and ${waiting}`, params: [await requireConversation(p, args)], columns: TURN_WAIT_COLUMNS }
  },
  // Where a secret was set from the app and when. Still no value.
  secret_sets: async (p) => ({ table: 'secret_sets', where: 'team_id = $1', params: [p.team_id] }),
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
  // The tasks blocking one task, or, given `blocker`, the tasks it blocks that the person may see.
  task_blocks: async (p, args) => {
    if (args.has('blocker')) {
      const blocker = arg(args, 'blocker')
      if (!(await canSeeTask(p, blocker))) throw new HttpError(404, 'no such task')
      return { table: 'task_blocks', where: `blocker_id = $1 and blocked_id in (select id from tasks where ${VISIBLE_TASK})`, params: [blocker, p.id] }
    }
    const taskId = arg(args, 'task')
    if (!(await canSeeTask(p, taskId))) throw new HttpError(404, 'no such task')
    return { table: 'task_blocks', where: 'blocked_id = $1', params: [taskId] }
  },
  // A task's hold, current or lapsed.
  task_holds: async (p, args) => {
    const taskId = arg(args, 'task')
    if (!(await canSeeTask(p, taskId))) throw new HttpError(404, 'no such task')
    return { table: 'task_holds', where: 'task_id = $1', params: [taskId] }
  },
  // A task's repos, for editing a draft. Without `task`, the repos of every task
  // the person may see, which the project pages show.
  task_repos: async (p, args) => {
    if (!args.has('task')) {
      return { table: 'task_repos', where: `task_id in (select id from tasks where team_id = $1 and ${VISIBLE_TASK})`, params: [p.team_id, p.id] }
    }
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
  // A task's repos whose changes are not listed, and why.
  unlisted_changes: async (p, args) => {
    const taskId = arg(args, 'task')
    if (!(await canSeeTask(p, taskId))) throw new HttpError(404, 'no such task')
    return { table: 'unlisted_changes', where: 'task_id = $1', params: [taskId], columns: UNLISTED_CHANGE_COLUMNS }
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
  // The folders on this Mac whose terminal sessions its daemon sends.
  connected_folders: async (i) => ({ table: 'connected_folders', where: 'instance_id = $1 and disconnected_at is null', params: [i.id] }),
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
    // Electric serves a subset of any shape, and a subset's filter may name a
    // column the shape hides, which answers yes-or-no questions about its values.
    if (key.startsWith('subset')) throw new HttpError(400, 'subset reads are not served')
    if (CLIENT_KEYS.includes(key)) origin.searchParams.set(key, value)
  }
  origin.searchParams.set('table', shape.table)
  origin.searchParams.set('where', shape.where.replace(/\s+/g, ' '))
  shape.params.forEach((value, i) => origin.searchParams.set(`params[${i + 1}]`, value))
  if (shape.columns) {
    origin.searchParams.set('columns', shape.columns.join(','))
    // Should a subset ever reach Electric, its filter and order may name only these.
    origin.searchParams.set('queryable_columns', shape.columns.join(','))
  }
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
