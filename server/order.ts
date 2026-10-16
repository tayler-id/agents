// The order of work: a task's priority, the tasks that block it, its hold,
// whether it is done, and which queued tasks are ready to start. Every command
// checks the task's state against the transition table in shared/work.ts, and
// answers whether there was anything to change, so running one twice is safe.

import type pg from 'pg'
import { many, maybe, type Db } from './db.ts'
import { canSeeTask } from './access.ts'
import { HttpError, type Person } from './record.ts'
import { deliverMarkedDone } from './agent-turns.ts'
import { TASK_ACTIONS, taskState, type BlockAsk, type HoldAsk, type Outcome, type ReadyAnswer, type StateOf, type TaskAction, type TaskState } from '../shared/work.ts'
import type { SessionId, TaskId } from '../shared/ids.ts'

// Why an action cannot start from each state.
const REFUSALS: Record<TaskState, string> = {
  queued: 'this task is still a draft',
  active: 'this task has already started',
  done: 'this task is done',
  discarded: 'this draft was discarded',
}

// The task, locked, in a state the action may start from. A queued task carries
// its draft session.
export async function lockedTask(client: pg.PoolClient, person: Person, taskId: TaskId, action: TaskAction): Promise<StateOf<SessionId>> {
  if (!(await canSeeTask(person, taskId))) throw new HttpError(404, 'no such task')
  const row = await maybe<{ archived: boolean; done: boolean; draft: SessionId | null }>(client,
    `select t.archived_at is not null as archived, t.done_at is not null as done,
       (select s.id from sessions s where s.task_id = t.id and s.status = 'draft' and s.archived_at is null
        order by s.created_at desc limit 1) as draft
     from tasks t where t.id = $1 and t.team_id = $2 for update of t`, [taskId, person.team_id])
  if (!row) throw new HttpError(404, 'no such task')
  const task = taskState(row)
  if (!TASK_ACTIONS[action].from.includes(task.state)) throw new HttpError(409, REFUSALS[task.state])
  return task
}

// One change to a team's edges at a time, so two people cannot close a cycle
// between them, and nobody adds an edge to a task as it is discarded.
export async function lockEdges(client: pg.PoolClient, teamId: string) {
  await client.query(`select pg_advisory_xact_lock(hashtext('task_blocks:' || $1))`, [teamId])
}

export async function prioritize(client: pg.PoolClient, person: Person, taskId: TaskId, priority: number): Promise<Outcome> {
  await lockedTask(client, person, taskId, 'prioritize')
  const { rowCount } = await client.query('update tasks set priority = $2 where id = $1 and priority <> $2', [taskId, priority])
  return { already: rowCount === 0 }
}

export async function markDone(client: pg.PoolClient, person: Person, taskId: TaskId): Promise<Outcome> {
  const task = await lockedTask(client, person, taskId, 'done')
  if (task.state === 'done') return { already: true }
  await client.query('update tasks set done_at = now() where id = $1', [taskId])
  // A task an agent handed over tells that agent it is done.
  await deliverMarkedDone(client, taskId, person.login)
  return { already: false }
}

export async function reopen(client: pg.PoolClient, person: Person, taskId: TaskId): Promise<Outcome> {
  const task = await lockedTask(client, person, taskId, 'reopen')
  if (task.state !== 'done') return { already: true }
  await client.query('update tasks set done_at = null where id = $1', [taskId])
  return { already: false }
}

export async function block(client: pg.PoolClient, person: Person, taskId: TaskId, ask: BlockAsk): Promise<Outcome> {
  if (ask.blockerId === taskId) throw new HttpError(400, 'a task cannot block itself')
  await lockedTask(client, person, taskId, 'block')
  if (!(await canSeeTask(person, ask.blockerId))) throw new HttpError(404, 'no such task to wait on')
  await lockEdges(client, person.team_id)
  const blocker = await maybe<{ archived: boolean }>(client,
    'select archived_at is not null as archived from tasks where id = $1 and team_id = $2', [ask.blockerId, person.team_id])
  if (!blocker) throw new HttpError(404, 'no such task to wait on')
  if (blocker.archived) throw new HttpError(409, 'that task was discarded')
  const edge = await maybe<{ reason: string | null }>(client,
    'select reason from task_blocks where blocked_id = $1 and blocker_id = $2', [taskId, ask.blockerId])
  if (edge) {
    if (edge.reason === ask.reason) return { already: true }
    await client.query('update task_blocks set reason = $3 where blocked_id = $1 and blocker_id = $2', [taskId, ask.blockerId, ask.reason])
    return { already: false }
  }
  // The edge closes a cycle when the blocker already waits, through other edges, on this task.
  const cycle = await maybe(client,
    `with recursive waits(id) as (
       select blocker_id from task_blocks where blocked_id = $1
       union select b.blocker_id from task_blocks b join waits w on b.blocked_id = w.id)
     select 1 from waits where id = $2`, [ask.blockerId, taskId])
  if (cycle) throw new HttpError(409, 'that task already waits on this one, so this would make them wait on each other')
  await client.query('insert into task_blocks (team_id, blocked_id, blocker_id, reason, created_by) values ($1, $2, $3, $4, $5)',
    [person.team_id, taskId, ask.blockerId, ask.reason, person.id])
  return { already: false }
}

export async function unblock(client: pg.PoolClient, person: Person, taskId: TaskId, blockerId: TaskId): Promise<Outcome> {
  await lockedTask(client, person, taskId, 'unblock')
  const { rowCount } = await client.query('delete from task_blocks where blocked_id = $1 and blocker_id = $2', [taskId, blockerId])
  return { already: rowCount === 0 }
}

export async function hold(client: pg.PoolClient, person: Person, taskId: TaskId, ask: HoldAsk): Promise<Outcome> {
  await lockedTask(client, person, taskId, 'hold')
  const current = await maybe<{ kind: string; reason: string; until: string | null }>(client,
    'select kind, reason, until::text from task_holds where task_id = $1', [taskId])
  if (current?.kind === ask.kind && current.reason === ask.reason && current.until === ask.until) return { already: true }
  await client.query(
    `insert into task_holds (task_id, team_id, kind, reason, until, held_by) values ($1, $2, $3, $4, $5, $6)
     on conflict (task_id) do update set kind = excluded.kind, reason = excluded.reason, until = excluded.until,
       held_by = excluded.held_by, created_at = now()`,
    [taskId, person.team_id, ask.kind, ask.reason, ask.until, person.id])
  return { already: false }
}

export async function unhold(client: pg.PoolClient, person: Person, taskId: TaskId): Promise<Outcome> {
  await lockedTask(client, person, taskId, 'unhold')
  const { rowCount } = await client.query('delete from task_holds where task_id = $1', [taskId])
  return { already: rowCount === 0 }
}

// Refuses to discard a task that queued or active work still waits on. Names
// the tasks the person may see, and counts the rest.
export async function refuseIfBlocking(client: pg.PoolClient, person: Person, taskId: TaskId) {
  await lockEdges(client, person.team_id)
  const waiting = await many<{ id: string; title: string }>(client,
    `select t.id, t.title from task_blocks b join tasks t on t.id = b.blocked_id
     where b.blocker_id = $1 and t.archived_at is null and t.done_at is null order by t.created_at, t.id`, [taskId])
  if (!waiting.length) return
  const seen = await Promise.all(waiting.map(async (t) => ((await canSeeTask(person, t.id)) ? `"${t.title}"` : null)))
  const named = seen.filter((title): title is string => title !== null)
  const hidden = waiting.length - named.length
  throw new HttpError(409, `this task still blocks ${[...named, ...(hidden ? [`${hidden} private ${hidden === 1 ? 'task' : 'tasks'}`] : [])].join(', ')}`)
}

// A task's visible to the person, or to agents when there is no person: the
// team's shared tasks, plus a person's own and those they are members of.
const VISIBLE = `t.team_id = $1 and (t.visibility = 'team' or t.owner_id = $2 or t.id in (select task_id from task_members where person_id = $2))`
// A hold pauses work until its until date, by the server's date.
const HELD_NOW = 'h.until is null or h.until > current_date'

// Queued tasks that nothing blocks and no current hold pauses, most urgent and
// then oldest first, and the held tasks beside them. Agents ask with no person.
export async function readyAnswer(db: Db, teamId: string, personId: string | null): Promise<ReadyAnswer> {
  const ready = await many<ReadyAnswer['ready'][number]>(db,
    `select t.id, t.title, t.priority, a.name as agent, t.created_at::text as created_at
     from tasks t left join agents a on a.id = t.agent_id
     where ${VISIBLE} and t.archived_at is null and t.done_at is null
       and exists (select 1 from sessions s where s.task_id = t.id and s.status = 'draft' and s.archived_at is null)
       and not exists (select 1 from task_holds h where h.task_id = t.id and (${HELD_NOW}))
       and not exists (select 1 from task_blocks b join tasks w on w.id = b.blocker_id
                       where b.blocked_id = t.id and w.done_at is null and w.archived_at is null)
     order by t.priority, t.created_at, t.id`, [teamId, personId])
  const held = await many<ReadyAnswer['held'][number]>(db,
    `select t.id, t.title, h.kind, h.reason, h.until::text as until, p.login as held_by,
       case when exists (select 1 from sessions s where s.task_id = t.id and s.status = 'draft' and s.archived_at is null)
         then 'queued' else 'active' end as state
     from tasks t join task_holds h on h.task_id = t.id left join people p on p.id = h.held_by
     where ${VISIBLE} and t.archived_at is null and t.done_at is null and (${HELD_NOW})
     order by h.created_at, t.id`, [teamId, personId])
  return { ready, held }
}
