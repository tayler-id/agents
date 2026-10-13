// Starting a task's work: a workspace on the agent's home machine with a clone
// of each of the task's repos, and the agent's first message. A task started at
// once and a draft started later both come through here.

import type pg from 'pg'
import { maybe, one } from './db.ts'
import { HttpError, type Person } from './record.ts'
import { sendToSession } from './session-messages.ts'
import { checkoutsOf } from './checkout.ts'
import type { AgentId, SessionId, TaskId, WorkspaceId } from '../shared/ids.ts'
import type { WorkspaceRepo } from '../shared/types.ts'

type TaskRow = { id: TaskId; team_id: string; slug: string; title: string; instructions: string; agent_id: AgentId | null }
type AgentRow = { id: AgentId; home_instance_id: string | null; harness: 'claude' | 'codex'; model: string | null }

export async function launchTask(client: pg.PoolClient, person: Person, taskId: TaskId): Promise<{ taskId: TaskId; sessionId: SessionId }> {
  const task = await one<TaskRow>(client, `task ${taskId}`,
    'select id, team_id, slug, title, instructions, agent_id from tasks where id = $1', [taskId])
  const agent = await maybe<AgentRow>(client,
    'select id, home_instance_id, harness, model from agents where id = $1 and archived_at is null', [task.agent_id])
  if (!agent) throw new HttpError(409, "the task's agent is gone")
  if (!agent.home_instance_id) throw new HttpError(409, 'this agent has no home machine')
  const repos = await checkoutsOf(client, task.id, `task/${task.slug}`)
  const workspace = await one<{ id: WorkspaceId }>(client, 'the new workspace',
    `insert into workspaces (team_id, task_id, instance_id, path) values ($1, $2, $3, '') returning id`,
    [task.team_id, task.id, agent.home_instance_id])
  await client.query(`insert into commands (team_id, instance_id, kind, payload) values ($1, $2, 'setup_workspace', $3)`,
    [task.team_id, agent.home_instance_id, JSON.stringify({ workspaceId: workspace.id, repos })])
  // A draft already has its session, which starts now on the agent's current machine.
  const draft = await maybe<{ id: SessionId }>(client,
    `select id from sessions where task_id = $1 and status = 'draft' and archived_at is null for update`, [task.id])
  const values = [workspace.id, agent.home_instance_id, agent.id, person.id, agent.harness, agent.model]
  const session = draft
    ? await one<{ id: SessionId }>(client, 'the started draft',
      `update sessions set workspace_id = $2, instance_id = $3, agent_id = $4, started_by = $5, harness = $6, model = $7, status = 'starting'
       where id = $1 returning id`, [draft.id, ...values])
    : await one<{ id: SessionId }>(client, 'the new session',
      `insert into sessions (team_id, task_id, workspace_id, instance_id, agent_id, started_by, harness, model)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`, [task.team_id, task.id, ...values])
  await sendToSession(client, person, session.id, introOf(task, repos))
  return { taskId: task.id, sessionId: session.id }
}

// "a", "a and b", "a, b and c".
function listed(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.slice(-1).join('')}`
}

// The agent's first message: the task, and where its repos are.
function introOf(task: TaskRow, repos: WorkspaceRepo[]): string {
  const [first] = repos
  const where = !first ? ''
    : repos.length === 1 ? ` The repo is checked out in ./${first.name} on the branch ${first.branch}.`
      : ` The repos are checked out in ${listed(repos.map((r) => `./${r.name}`))}, each on the branch ${first.branch}.`
  return `${task.title}\n\n${task.instructions}\n\nYou are working in a task workspace.${where} Put any documents you write for people in ./task, where they become versioned documents the team can read and comment on.`
}
