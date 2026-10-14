// What agents read from the shared record: search across every session and
// conversation, one session's events, and recent activity. An agent sees what the
// team shares, plus its own conversation or task. Private work stays private.

import { maybe, pool } from './db.ts'
import { HttpError } from './record.ts'

// Sessions an agent may read, given the session it is asking from. A terminal
// session in a folder its person shares with the team is the team's to read.
const READABLE = `s.team_id = $1 and (
  (s.conversation_id is not null and (c.visibility = 'team' or s.conversation_id = own.conversation_id))
  or (s.task_id is not null and (t.visibility = 'team' or s.task_id = own.task_id))
  or (s.folder_id is not null and f.visibility = 'team'))`

const FROM_SESSIONS = `from sessions s
  left join conversations c on c.id = s.conversation_id
  left join tasks t on t.id = s.task_id
  left join connected_folders f on f.id = s.folder_id
  left join agents a on a.id = s.agent_id
  left join people p on p.id = s.started_by
  cross join (select conversation_id, task_id from sessions where id = $2) own`

// Any word matches, ranked by how well. A question in plain words still finds things.
const QUERY = `replace(plainto_tsquery('english', $3)::text, '&', '|')::tsquery`

export type Hit = {
  source: 'event' | 'message'; session_id: string | null; conversation_id: string | null; seq: string
  kind: string; tool_name: string | null; agent: string | null; person: string | null; snippet: string; created_at: string
}

export async function searchRecord(teamId: string, ownSession: string, query: string, limit: number): Promise<Hit[]> {
  if (!query.trim()) return []
  const { rows } = await pool.query<Hit & { rank: number }>(
    `with q as (select ${QUERY} as query)
     (select 'event' as source, e.session_id, s.conversation_id, e.seq::text, e.kind, e.tool_name, a.name as agent, p.login as person,
        ts_headline('english', e.text, q.query, 'MaxFragments=2, MaxWords=40, MinWords=12') as snippet,
        ts_rank(to_tsvector('english', coalesce(e.text, '')), q.query) as rank, e.created_at::text
      ${FROM_SESSIONS}
      join events e on e.session_id = s.id
      cross join q
      where ${READABLE} and s.id <> $2 and e.team_id = $1
        and to_tsvector('english', coalesce(e.text, '')) @@ q.query)
     union all
     (select 'message', m.session_id, m.conversation_id, m.seq::text, m.speaker, null, a.name, p.login,
        ts_headline('english', m.body, q.query, 'MaxFragments=2, MaxWords=40, MinWords=12'),
        ts_rank(to_tsvector('english', m.body), q.query), m.created_at::text
      from messages m
      join conversations c on c.id = m.conversation_id
      left join agents a on a.id = m.agent_id
      left join people p on p.id = m.person_id
      cross join (select conversation_id from sessions where id = $2) own
      cross join q
      where m.team_id = $1 and c.visibility = 'team' and m.conversation_id is distinct from own.conversation_id
        and to_tsvector('english', m.body) @@ q.query)
     order by rank desc, created_at desc limit $4`,
    [teamId, ownSession, query, limit])
  return rows
}

export async function readSession(teamId: string, ownSession: string, sessionId: string, fromSeq: number, limit: number) {
  const session = await maybe(pool,
    `select s.id, s.status, s.turns, s.created_at::text, s.last_active_at::text, a.name as agent, p.login as person,
       s.conversation_id, s.task_id
     ${FROM_SESSIONS}
     where s.id = $3 and ${READABLE}`, [teamId, ownSession, sessionId])
  if (!session) throw new HttpError(404, 'no such session you can read')
  const { rows: events } = await pool.query(
    `select seq::int, kind, tool_name, left(coalesce(text, ''), 1500) as text, created_at::text
     from events where session_id = $1 and seq >= $2 and kind <> 'notice' order by seq limit $3`,
    [sessionId, fromSeq, limit])
  return { session, events }
}

type Activity = {
  id: string; agent: string | null; person: string | null; status: string; turns: number
  last_active_at: string | null; asked: string | null; last_reply: string | null
}

export async function recentActivity(teamId: string, ownSession: string, hours: number) {
  const { rows } = await pool.query<Activity>(
    `select s.id, a.name as agent, p.login as person, s.status, s.turns, s.last_active_at::text,
       (select left(text, 200) from events where session_id = s.id and kind = 'user' order by seq limit 1) as asked,
       (select left(text, 300) from events where session_id = s.id and kind = 'assistant' and parent_tool_use_id is null
          order by seq desc limit 1) as last_reply
     ${FROM_SESSIONS}
     where ${READABLE} and s.id <> $2 and s.last_active_at > now() - make_interval(hours => $3)
     order by s.last_active_at desc limit 30`, [teamId, ownSession, hours])
  return rows
}

// How a pipeline's recent runs went, for an agent studying it: each run's
// stages with outcomes and summaries, reminders, hand-offs, what people said at
// its gates, and what it cost. Replays and private tasks are left out.
type HistoryRun = { id: string; status: string; note: string | null; trigger: string; cost_usd: number | null; created_at: string; title: string; version: string }
type HistoryStage = {
  run_id: string; n: number; stage: string; attempt: number; kind: string; status: string; outcome: string | null; summary: string
  session_id: string | null; reminders: number; decision: string | null; said: string | null; by: string | null
}

export async function pipelineHistory(teamId: string, name: string, limit: number) {
  const { rows: runs } = await pool.query<HistoryRun>(
    `select r.id, r.status, r.note, r.trigger, r.cost_usd::float as cost_usd, r.created_at::text, t.title, v.git_sha as version
     from runs r join tasks t on t.id = r.task_id join pipeline_versions v on v.id = r.pipeline_version_id
     join pipelines p on p.id = v.pipeline_id
     where r.team_id = $1 and p.name = $2 and r.replay_of is null and t.visibility = 'team'
       and r.status in ('done', 'failed', 'cancelled')
     order by r.created_at desc limit $3`, [teamId, name, limit])
  if (!runs.length) return []
  const { rows: stages } = await pool.query<HistoryStage>(
    `select s.run_id, s.n, s.stage, s.attempt, s.kind, s.status, s.outcome, left(coalesce(s.summary, ''), 1200) as summary, s.session_id,
       (select count(*)::int from events e where e.session_id = s.session_id and e.kind = 'user'
          and e.text like 'You ended your turn without calling report_result%') as reminders,
       a.answer->>'decision' as decision, a.answer->>'message' as said, a.answer->>'login' as by
     from run_stages s left join asks a on a.id = s.ask_id
     where s.run_id = any($1) order by s.run_id, s.n`, [runs.map((r) => r.id)])
  return runs.map((run) => ({ ...run, stages: stages.filter((s) => s.run_id === run.id) }))
}

export async function agentProfile(teamId: string, name: string) {
  const agent = await maybe<{ id: string; name: string; title: string | null; role: string | null; model: string | null; instructions: string }>(pool,
    `select id, name, title, role, model, instructions from agents where team_id = $1 and name = $2 and archived_at is null`, [teamId, name])
  if (!agent) throw new HttpError(404, `no agent named ${name}`)
  const { rows: skills } = await pool.query<{ name: string; description: string; content: string }>(
    `select name, description, content from skills where team_id = $1 and (agent_id is null or agent_id = $2) order by name`, [teamId, agent.id])
  return { name: agent.name, title: agent.title, role: agent.role, model: agent.model, instructions: agent.instructions, skills }
}
