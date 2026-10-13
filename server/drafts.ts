// Draft tasks: written now, started later. A draft is a task whose one session
// has the status draft, with no workspace and no events yet. The task holds the
// title and the first message to the agent, and its repos. Anyone who can see the
// task can edit, start or discard it, as anyone on the team can answer an ask.

import type pg from 'pg'
import { maybe, one } from './db.ts'
import { canSeeTask } from './access.ts'
import { HttpError, type Person } from './record.ts'
import { setTaskRepos } from './checkout.ts'
import { launchTask } from './launch.ts'

type AgentRow = { id: string; home_instance_id: string | null; harness: 'claude' | 'codex'; model: string | null }

async function agentOf(client: pg.PoolClient, teamId: string, agentId: string): Promise<AgentRow & { home_instance_id: string }> {
  const agent = await maybe<AgentRow>(client,
    'select id, home_instance_id, harness, model from agents where id = $1 and team_id = $2 and archived_at is null', [agentId, teamId])
  if (!agent) throw new HttpError(404, 'no such agent')
  if (!agent.home_instance_id) throw new HttpError(409, 'this agent has no home machine')
  return { ...agent, home_instance_id: agent.home_instance_id }
}

// The new draft's session, on the agent's home machine for now.
export async function draftSession(client: pg.PoolClient, person: Person, taskId: string, agentId: string): Promise<string> {
  const agent = await agentOf(client, person.team_id, agentId)
  const session = await one<{ id: string }>(client, 'the draft session',
    `insert into sessions (team_id, task_id, instance_id, agent_id, started_by, harness, model, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'draft') returning id`,
    [person.team_id, taskId, agent.home_instance_id, agent.id, person.id, agent.harness, agent.model])
  return session.id
}

// The draft's session, locked. Anything that has started is no longer a draft.
async function lockedDraft(client: pg.PoolClient, person: Person, taskId: string): Promise<{ id: string }> {
  if (!(await canSeeTask(person, taskId))) throw new HttpError(404, 'no such task')
  const session = await maybe<{ id: string; status: string }>(client,
    `select id, status from sessions where task_id = $1 and team_id = $2 and archived_at is null
     order by created_at desc limit 1 for update`, [taskId, person.team_id])
  if (!session) throw new HttpError(404, 'no such task')
  if (session.status !== 'draft') throw new HttpError(409, 'this task has already started')
  return session
}

export async function editDraft(client: pg.PoolClient, person: Person, taskId: string, body: {
  title: string; instructions: string; agentId: string; repoIds: string[]
}) {
  const session = await lockedDraft(client, person, taskId)
  const agent = await agentOf(client, person.team_id, body.agentId)
  await client.query('update tasks set title = $2, instructions = $3, agent_id = $4 where id = $1',
    [taskId, body.title, body.instructions, agent.id])
  await setTaskRepos(client, person.team_id, taskId, body.repoIds)
  await client.query('update sessions set agent_id = $2, instance_id = $3, harness = $4, model = $5 where id = $1',
    [session.id, agent.id, agent.home_instance_id, agent.harness, agent.model])
}

export async function startDraft(client: pg.PoolClient, person: Person, taskId: string) {
  await lockedDraft(client, person, taskId)
  return launchTask(client, person, taskId)
}

export async function discardDraft(client: pg.PoolClient, person: Person, taskId: string) {
  const session = await lockedDraft(client, person, taskId)
  await client.query('update tasks set archived_at = now() where id = $1', [taskId])
  await client.query('update sessions set archived_at = now() where id = $1', [session.id])
}
