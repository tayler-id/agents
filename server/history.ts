// What the History page reads: the sessions a person may see, a search across
// the text of their steps, and one session's steps for a replay. Who may see a
// session is VISIBLE_SESSION in access.ts, the one rule the app's other reads
// use too, so a session a person cannot open is in no list, no search and no
// replay. The search is the agents' search_record, in server/teamrecord.ts, with
// a person's access and filters in place of an agent's.

import { z } from 'zod'
import {
  Cursor, ERRORS_MAX, HistorySession, MARK_END, MARK_START, NO_SUCH_SESSION, SearchHit, SHOWN_NOTICES, Step,
  type HistoryKind, type HistoryPage, type HistoryQuery, type SearchPage, type SearchQuery, type SearchScope, type SessionFilters, type SessionView, type StepsPage,
} from '../shared/history.ts'
import type { SessionId } from '../shared/ids.ts'
import { canSeeSession, VISIBLE_SESSION } from './access.ts'
import { maybe, pool } from './db.ts'
import { HttpError, type Person } from './record.ts'
import { stepBlocks } from './steps.ts'
import { headline, matching, SNIPPET, STEP_VECTOR } from './teamrecord.ts'

// The steps that went wrong. The events_errors index (migration 0022) holds
// exactly these, and Postgres uses it only for a condition written the same way.
const ERROR_STEP = `(e.kind = 'error' or (e.kind = 'tool_result' and e.body->>'isError' = 'true'))`

// A step is any event but the notices that are bookkeeping. The list of notices
// that count is fixed in shared/history.ts, so quoting it here takes no value from a person.
const SHOWN_STEP = `(e.kind <> 'notice' or e.body->>'subtype' in (${SHOWN_NOTICES.map((notice) => `'${notice}'`).join(', ')}))`

// A session joined to everything its row names. The first words a person said
// are read only where they say what the session was about: a terminal session
// has no other title, and a direct message has none but its agent.
const JOINS = `
  join instances i on i.id = s.instance_id
  left join agents a on a.id = s.agent_id
  left join people p on p.id = s.started_by
  left join conversations c on c.id = s.conversation_id
  left join tasks t on t.id = s.task_id
  left join connected_folders f on f.id = s.folder_id
  left join lateral (
    select r.id, r.replay_of is not null as replay, pl.name as pipeline
    from runs r join pipeline_versions pv on pv.id = r.pipeline_version_id join pipelines pl on pl.id = pv.pipeline_id
    where r.task_id = s.task_id order by r.created_at, r.id limit 1) run on true
  left join projects pr on pr.id = coalesce(t.project_id, c.project_id)`

// Which steps a search reads. Errors are the steps events_errors holds.
const OF_SCOPE: Record<SearchScope, string> = {
  all: 'true',
  messages: `e.kind in ('user', 'assistant')`,
  tools: `e.kind in ('tool_call', 'tool_result')`,
  errors: ERROR_STEP,
}

// A session as HistorySession describes it, built in the query so the answer
// parses against the shared schema with no mapping between.
const SESSION = `jsonb_build_object(
  'id', s.id,
  'subject', case
    when s.folder_id is not null then jsonb_build_object('kind', 'terminal', 'id', f.id, 'path', f.path, 'cwd', s.cwd)
    when run.id is not null then jsonb_build_object('kind', 'run', 'id', run.id, 'task_id', t.id, 'title', t.title, 'pipeline', run.pipeline, 'replay', run.replay)
    when s.task_id is not null then jsonb_build_object('kind', 'task', 'id', t.id, 'title', t.title)
    else jsonb_build_object('kind', 'conversation', 'id', c.id, 'conversation', c.kind, 'name', c.name, 'people',
      (select coalesce(jsonb_agg(coalesce(pp.name, pp.login) order by pp.login), '[]') from conversation_members m join people pp on pp.id = m.person_id
       where m.conversation_id = c.id))
  end,
  'status', s.status,
  'agent', case when a.id is null then null else jsonb_build_object('id', a.id, 'name', a.name) end,
  'person', case when p.id is null then null else jsonb_build_object('id', p.id, 'login', p.login, 'name', p.name) end,
  'machine', i.name,
  'stage', s.stage,
  'stage_outcome', (select rs.outcome from run_stages rs where rs.session_id = s.id order by rs.n desc limit 1),
  'project', case when pr.id is null then null else jsonb_build_object('id', pr.id, 'name', pr.name) end,
  'repos', (select coalesce(jsonb_agg(rp.remote_url order by tr.is_primary desc, rp.remote_url), '[]')
    from task_repos tr join repos rp on rp.id = tr.repo_id where tr.task_id = s.task_id),
  'private', coalesce(f.visibility, t.visibility, c.visibility) = 'private',
  'asked', case when s.folder_id is not null or c.kind in ('dm', 'main')
    then (select left(e.text, 200) from events e where e.session_id = s.id and e.kind = 'user' order by e.seq limit 1) end,
  'steps', s.last_seq,
  'turns', s.turns,
  'errors', (select count(*) from events e where e.session_id = s.id and ${ERROR_STEP}),
  'started_at', s.created_at::text,
  'last_active_at', s.last_active_at::text)`

// What a session was started for, as a condition. A run is a task a pipeline
// started, and any other task is one a person did.
const OF_KIND: Record<HistoryKind, string> = {
  conversation: 's.conversation_id is not null',
  task: 's.task_id is not null and run.id is null',
  run: 'run.id is not null',
  terminal: 's.folder_id is not null',
}

// A query's values, numbered after the team and the person, which are $1 and $2.
type Bind = (value: unknown) => string
function binder(params: unknown[]): Bind {
  return (value) => `$${params.push(value)}`
}

// The conditions every list and search puts on a session. The day is judged
// where the list and the search differ, so it is not here.
function ofSession(filters: SessionFilters, bind: Bind): string[] {
  return [
    ...(filters.agent ? [`s.agent_id = ${bind(filters.agent)}`] : []),
    ...(filters.person ? [`s.started_by = ${bind(filters.person)}`] : []),
    ...(filters.kind ? [OF_KIND[filters.kind]] : []),
    ...(filters.project ? [`pr.id = ${bind(filters.project)}`] : []),
    ...(filters.repo ? [`exists (select 1 from task_repos tr where tr.task_id = s.task_id and tr.repo_id = ${bind(filters.repo)})`] : []),
  ]
}

// Where a page begins, from the cursor the last page ended with.
function resume(cursor: Cursor): { at: string; id: string } {
  const [at = '', id = ''] = cursor.split('|')
  return { at, id }
}

// A cursor for the row a page ended on. Postgres wrote its time, so it round-trips.
const cursorOf = (at: string, id: string): Cursor => Cursor.parse(`${at}|${id}`)

const SessionRow = z.object({ session: HistorySession, active_at: z.string() })
const SeqRow = z.object({ seq: z.number().int() })
const ErrorRow = SeqRow.extend({ total: z.number().int() })

// Every session the person may see, the one active most recently first. A
// session is on a day when it ran or waited on it, from its first step to its
// last. A draft has no steps, and a discarded one is gone.
export async function listSessions(person: Person, query: HistoryQuery): Promise<HistoryPage> {
  const params: unknown[] = [person.team_id, person.id]
  const bind = binder(params)
  const activeAt = 'coalesce(s.last_active_at, s.created_at)'
  const where = [
    's.team_id = $1', 's.archived_at is null', `s.status <> 'draft'`, VISIBLE_SESSION, ...ofSession(query, bind),
    ...(query.since ? [`${activeAt} >= ${bind(query.since)}::timestamptz`] : []),
    ...(query.until ? [`s.created_at < ${bind(query.until)}::timestamptz`] : []),
  ]
  if (query.before) {
    const { at, id } = resume(query.before)
    where.push(`(${activeAt}, s.id) < (${bind(at)}::timestamptz, ${bind(id)}::uuid)`)
  }
  // One more than a page, to know whether another page follows.
  const { rows } = await pool.query(
    `select ${SESSION} as session, ${activeAt}::text as active_at
     from sessions s ${JOINS}
     where ${where.join(' and ')}
     order by ${activeAt} desc, s.id desc
     limit ${bind(query.limit + 1)}`, params)
  const found = rows.map((row) => SessionRow.parse(row))
  const page = found.slice(0, query.limit)
  const last = page.at(-1)
  return { sessions: page.map((row) => row.session), next: found.length > query.limit && last ? cursorOf(last.active_at, last.session.id) : null }
}

const HitRow = SearchHit.extend({ id: z.string() })

// The steps whose text matches the words, the newest first, in sessions the
// person may see. The page of matches is found first, so the snippets and the
// sessions' details are made for those few and not for every match.
export async function searchSteps(person: Person, query: SearchQuery): Promise<SearchPage> {
  const params: unknown[] = [person.team_id, person.id, query.q]
  const bind = binder(params)
  const where = [
    'e.team_id = $1', 's.archived_at is null', VISIBLE_SESSION, SHOWN_STEP, OF_SCOPE[query.scope], `${STEP_VECTOR} @@ q.query`, ...ofSession(query, bind),
    ...(query.since ? [`e.created_at >= ${bind(query.since)}::timestamptz`] : []),
    ...(query.until ? [`e.created_at < ${bind(query.until)}::timestamptz`] : []),
  ]
  if (query.before) {
    const { at, id } = resume(query.before)
    where.push(`(e.created_at, e.id) < (${bind(at)}::timestamptz, ${bind(id)}::bigint)`)
  }
  const limit = bind(query.limit + 1)
  const options = bind(`${SNIPPET}, StartSel=${MARK_START}, StopSel=${MARK_END}`)
  const { rows } = await pool.query(
    `with q as (select ${matching('$3')} as query),
     found as (
       select e.id, e.session_id, e.seq, e.kind, e.tool_name, e.created_at
       from events e join sessions s on s.id = e.session_id ${JOINS}
       cross join q
       where ${where.join(' and ')}
       order by e.created_at desc, e.id desc limit ${limit})
     select ${SESSION} as session, found.seq::int as seq, found.kind, found.tool_name,
       ${headline('e.text', `${options}::text`)} as snippet, found.created_at::text as created_at, found.id::text as id
     from found
     join events e on e.id = found.id
     join sessions s on s.id = found.session_id ${JOINS}
     cross join q
     order by found.created_at desc, found.id desc`, params)
  const found = rows.map((row) => HitRow.parse(row))
  const page = found.slice(0, query.limit)
  const last = page.at(-1)
  return {
    hits: page.map(({ id: _id, ...hit }) => hit),
    next: found.length > query.limit && last ? cursorOf(last.created_at, last.id) : null,
  }
}

// A session for a replay to open on: its header, which steps it has, and where
// the ones that went wrong are. A session the person may not see is not found.
export async function sessionView(person: Person, sessionId: SessionId): Promise<SessionView> {
  const row = await maybe(pool,
    `select ${SESSION} as session from sessions s ${JOINS} where s.id = $3 and s.team_id = $1 and ${VISIBLE_SESSION}`,
    [person.team_id, person.id, sessionId])
  if (!row) throw new HttpError(404, NO_SUCH_SESSION)
  const session = HistorySession.parse(row.session)
  const [first, last, errors] = await Promise.all([
    pool.query(`select e.seq::int as seq from events e where e.session_id = $1 and ${SHOWN_STEP} order by e.seq limit 1`, [sessionId]),
    pool.query(`select e.seq::int as seq from events e where e.session_id = $1 and ${SHOWN_STEP} order by e.seq desc limit 1`, [sessionId]),
    pool.query(
      `select e.seq::int as seq, count(*) over ()::int as total from events e where e.session_id = $1 and ${ERROR_STEP} order by e.seq limit ${ERRORS_MAX}`,
      [sessionId]),
  ])
  const seqs = errors.rows.map((r) => ErrorRow.parse(r))
  return {
    session,
    first_seq: first.rows[0] ? SeqRow.parse(first.rows[0]).seq : null,
    last_seq: last.rows[0] ? SeqRow.parse(last.rows[0]).seq : null,
    errors: seqs.map((r) => r.seq),
    errors_total: seqs[0]?.total ?? 0,
  }
}

const StepRow = z.object({
  seq: z.number().int(), kind: Step.shape.kind, tool_name: z.string().nullable(), sub: z.boolean(), error: z.boolean(),
  created_at: z.string(), text: z.string().nullable(), body: z.unknown(),
})

// The steps of a session from one number to another, in the order they happened.
// A tool's result is named for the call it answers, since only the call carries the name.
export async function sessionSteps(person: Person, sessionId: SessionId, range: { from: number; to: number }): Promise<StepsPage> {
  if (!(await canSeeSession(person, sessionId))) throw new HttpError(404, NO_SUCH_SESSION)
  const { rows } = await pool.query(
    `select e.seq::int as seq, e.kind,
       case when e.kind = 'tool_result' then (select c.tool_name from events c
         where c.session_id = e.session_id and c.tool_use_id = e.tool_use_id and c.kind = 'tool_call' limit 1) else e.tool_name end as tool_name,
       e.parent_tool_use_id is not null as sub, ${ERROR_STEP} as error, e.created_at::text as created_at, e.text, e.body
     from events e
     where e.session_id = $1 and e.seq between $2 and $3 and ${SHOWN_STEP}
     order by e.seq`, [sessionId, range.from, range.to])
  const steps = rows.map((row) => {
    const { text, body, ...step } = StepRow.parse(row)
    return { ...step, blocks: stepBlocks(step.kind, text, body) }
  })
  return { steps, from: range.from, to: range.to }
}
