// Draft tasks: written now, started later. A draft is a queued task, whose one
// session has the draft status, with no workspace and no events yet. The task
// holds the title and the first message to the agent, and its repos. Anyone who
// can see the task can edit, start or discard it, as anyone on the team can
// answer an ask. shared/work.ts holds the lifecycle: which action needs which state.

import type pg from 'pg'
import { many, maybe, one } from './db.ts'
import { HttpError, type Person } from './record.ts'
import { setTaskRepos } from './checkout.ts'
import { launchTask } from './launch.ts'
import { placeTask } from './projects.ts'
import { lockedTask, refuseIfBlocking } from './order.ts'
import type { DraftEdit, TaskFields } from '../shared/work.ts'
import type { AgentId, SessionId, TaskId } from '../shared/ids.ts'
import type { ProjectId } from '../shared/projects.ts'

type HomedAgent = { id: AgentId; home_instance_id: string; harness: 'claude' | 'codex'; model: string | null }

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

// The draft session of a task the action may still change.
async function draftOf(client: pg.PoolClient, person: Person, taskId: TaskId, action: 'edit' | 'start' | 'discard'): Promise<SessionId> {
  const task = await lockedTask(client, person, taskId, action)
  // Only a queued task can be edited, started or discarded, and a queued task has its draft.
  if (task.state !== 'queued') throw new Error(`the ${action} action let a ${task.state} task through`)
  return task.draft
}

// The repos match when the primary does and the rest are the same set.
const sameRepos = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a[0] === b[0] && [...a.slice(1)].sort().join() === [...b.slice(1)].sort().join()

export async function editDraft(client: pg.PoolClient, person: Person, taskId: TaskId, edit: DraftEdit) {
  const session = await draftOf(client, person, taskId, 'edit')
  const now = await one<{ title: string; instructions: string; agent_id: AgentId | null }>(client, 'the draft',
    'select title, instructions, agent_id from tasks where id = $1', [taskId])
  const repoIds = (await many<{ repo_id: string }>(client,
    'select repo_id from task_repos where task_id = $1 order by is_primary desc, repo_id', [taskId])).map((r) => r.repo_id)
  const { loaded } = edit
  if (now.title !== loaded.title || now.instructions !== loaded.instructions || now.agent_id !== loaded.agentId || !sameRepos(repoIds, loaded.repoIds)) {
    throw new HttpError(409, 'this draft changed since you opened it. Reload it to see the changes, then make yours again.')
  }
  const fields: TaskFields = edit
  const agent = await homedAgent(client, person, fields.agentId)
  await client.query('update tasks set title = $2, instructions = $3, agent_id = $4 where id = $1',
    [taskId, fields.title, fields.instructions, agent.id])
  const added = fields.repoIds.filter((repoId) => !repoIds.includes(repoId))
  await setTaskRepos(client, person, taskId, fields.repoIds)
  // As a new task: in a project it keeps to the project's repos, and outside one it joins its first repo's project.
  // Only the repos the edit adds must be the project's, so a draft keeps the repos it was started with.
  const { project_id: projectId } = await one<{ project_id: ProjectId | null }>(client, "the draft's project", 'select project_id from tasks where id = $1', [taskId])
  await placeTask(client, taskId, projectId ?? undefined, added)
  await client.query('update sessions set agent_id = $2, instance_id = $3, harness = $4, model = $5 where id = $1',
    [session, agent.id, agent.home_instance_id, agent.harness, agent.model])
}

export async function startDraft(client: pg.PoolClient, person: Person, taskId: TaskId) {
  await draftOf(client, person, taskId, 'start')
  return launchTask(client, person, taskId)
}

export async function discardDraft(client: pg.PoolClient, person: Person, taskId: TaskId) {
  const session = await draftOf(client, person, taskId, 'discard')
  await refuseIfBlocking(client, person, taskId)
  await client.query('update tasks set archived_at = now() where id = $1', [taskId])
  await client.query('update sessions set archived_at = now() where id = $1', [session])
}
