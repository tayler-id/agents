// Draft tasks: written now, started later. A draft is a task whose one session
// has the draft status, with no workspace and no events yet. The task holds the
// title and the first message to the agent, and its repos. Anyone who can see the
// task can edit, start or discard it, as anyone on the team can answer an ask.
// shared/work.ts holds the lifecycle: which action needs which state.

import type pg from 'pg'
import { maybe, one } from './db.ts'
import { canSeeTask } from './access.ts'
import { HttpError, type Person } from './record.ts'
import { setTaskRepos } from './checkout.ts'
import { launchTask } from './launch.ts'
import { DRAFT_ACTIONS, draftState, type DraftAction, type DraftState, type TaskFields } from '../shared/work.ts'
import type { AgentId, SessionId, TaskId } from '../shared/ids.ts'
import type { SessionStatus } from '../shared/types.ts'

type HomedAgent = { id: AgentId; home_instance_id: string; harness: 'claude' | 'codex'; model: string | null }

// Why an action cannot happen in each state.
const REFUSALS: Record<DraftState, string> = {
  draft: 'this task is still a draft',
  started: 'this task has already started',
  discarded: 'this draft was discarded',
}

async function homedAgent(client: pg.PoolClient, person: Person, agentId: AgentId): Promise<HomedAgent> {
  const agent = await maybe<Omit<HomedAgent, 'home_instance_id'> & { home_instance_id: string | null }>(client,
    'select id, home_instance_id, harness, model from agents where id = $1 and team_id = $2 and archived_at is null',
    [agentId, person.team_id])
  if (!agent) throw new HttpError(404, 'no such agent')
  const { home_instance_id: home } = agent
  if (!home) throw new HttpError(409, 'this agent has no home machine')
  return { ...agent, home_instance_id: home }
}

// The new draft's session, on the agent's home machine until it starts.
export async function draftSession(client: pg.PoolClient, person: Person, taskId: TaskId, agentId: AgentId): Promise<SessionId> {
  const agent = await homedAgent(client, person, agentId)
  const session = await one<{ id: SessionId }>(client, 'the draft session',
    `insert into sessions (team_id, task_id, instance_id, agent_id, started_by, harness, model, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'draft') returning id`,
    [person.team_id, taskId, agent.home_instance_id, agent.id, person.id, agent.harness, agent.model])
  return session.id
}

// The task's session, locked, when the action may happen to it.
async function lockedFor(client: pg.PoolClient, person: Person, taskId: TaskId, action: DraftAction): Promise<{ id: SessionId }> {
  if (!(await canSeeTask(person, taskId))) throw new HttpError(404, 'no such task')
  const session = await maybe<{ id: SessionId; status: SessionStatus; archived: boolean }>(client,
    `select id, status, archived_at is not null as archived from sessions where task_id = $1 and team_id = $2
     order by created_at desc limit 1 for update`, [taskId, person.team_id])
  if (!session) throw new HttpError(404, 'no such task')
  const state = draftState(session)
  if (state !== DRAFT_ACTIONS[action].from) throw new HttpError(409, REFUSALS[state])
  return session
}

export async function editDraft(client: pg.PoolClient, person: Person, taskId: TaskId, fields: TaskFields) {
  const session = await lockedFor(client, person, taskId, 'edit')
  const agent = await homedAgent(client, person, fields.agentId)
  await client.query('update tasks set title = $2, instructions = $3, agent_id = $4 where id = $1',
    [taskId, fields.title, fields.instructions, agent.id])
  await setTaskRepos(client, person, taskId, fields.repoIds)
  await client.query('update sessions set agent_id = $2, instance_id = $3, harness = $4, model = $5 where id = $1',
    [session.id, agent.id, agent.home_instance_id, agent.harness, agent.model])
}

export async function startDraft(client: pg.PoolClient, person: Person, taskId: TaskId) {
  await lockedFor(client, person, taskId, 'start')
  return launchTask(client, person, taskId)
}

export async function discardDraft(client: pg.PoolClient, person: Person, taskId: TaskId) {
  const session = await lockedFor(client, person, taskId, 'discard')
  await client.query('update tasks set archived_at = now() where id = $1', [taskId])
  await client.query('update sessions set archived_at = now() where id = $1', [session.id])
}
