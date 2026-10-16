// Starting a task's work: a workspace on the agent's home machine with a clone
// of each of the task's repos, and the agent's first message. A task started at
// once, a draft started later and a task one agent hands another all come through here.

import type pg from 'pg'
import { many, maybe, one } from './db.ts'
import { HttpError, type Person } from './record.ts'
import { sendToSession } from './session-messages.ts'
import { sendAgentTurn } from './agent-turns.ts'
import type { AgentCause } from './scheduler.ts'
import { checkoutsOf } from './checkout.ts'
import type { AgentId, SessionId, TaskId, WorkspaceId } from '../shared/ids.ts'
import type { WorkspaceRepo } from '../shared/types.ts'
import { POLICY } from '../shared/policy.ts'

type TaskRow = { id: TaskId; team_id: string; slug: string; title: string; instructions: string; agent_id: AgentId | null }
type AgentRow = { id: AgentId; home_instance_id: string | null; harness: 'claude' | 'codex'; model: string | null }

export async function launchTask(client: pg.PoolClient, person: Person, taskId: TaskId): Promise<{ taskId: TaskId; sessionId: SessionId }> {
  const { task, repos, sessionId } = await startTaskSession(client, taskId, { person: person.id })
  await sendToSession(client, person, sessionId, introOf(task, repos), `${task.title}\n\n${task.instructions}`)
  return { taskId: task.id, sessionId }
}

// A task one agent handed another. Its first message names the agent that handed
// it over and says how to report back, and its turn carries the hand-over's
// place in the chain.
export async function launchHandedTask(client: pg.PoolClient, taskId: TaskId, from: { agentId: AgentId; name: string }, cause: AgentCause): Promise<SessionId> {
  const { task, repos, sessionId } = await startTaskSession(client, taskId, { session: cause.askedBySession })
  const text = `${from.name} handed you this task. When it is done, call report_back with the result, which goes back to ${from.name} and marks the task done.\n\n${introOf(task, repos)}`
  const turnId = await sendAgentTurn(client, sessionId, { text, clientId: `handed:${task.id}`, links: { taskId: task.id } }, from.agentId, cause)
  if (turnId === null) throw new Error(`task ${task.id} was handed over already`)
  return sessionId
}

// The task's workspace on its agent's machine, with the command that sets it up,
// and the session that works in it, started by a person or by an agent's session.
async function startTaskSession(client: pg.PoolClient, taskId: TaskId, startedBy: { person: string } | { session: SessionId }) {
  const task = await one<TaskRow>(client, `task ${taskId}`,
    'select id, team_id, slug, title, instructions, agent_id from tasks where id = $1', [taskId])
  const agent = await maybe<AgentRow>(client,
    'select id, home_instance_id, harness, model from agents where id = $1 and archived_at is null', [task.agent_id])
  if (!agent) throw new HttpError(409, "the task's agent is gone")
  if (!agent.home_instance_id) throw new HttpError(409, 'this agent has no home machine')
  // A repo whose policy keeps coding work in boxes takes no task on another machine.
  const home = await one<{ kind: string }>(client, "the agent's home machine", 'select kind from instances where id = $1', [agent.home_instance_id])
  if (home.kind !== 'box') {
    const policies = await many<{ rules: unknown }>(client,
      'select p.rules from task_repos tr join repos r on r.id = tr.repo_id join policies p on p.id = r.policy_id where tr.task_id = $1', [task.id])
    if (policies.some((p) => POLICY.parse(p.rules).sandbox === 'box')) {
      throw new HttpError(409, `This repo's policy keeps coding work in boxes, and the task's agent lives on a ${home.kind}. Start an app-change run on the repo instead.`)
    }
  }
  const repos = await checkoutsOf(client, task.id, `task/${task.slug}`)
  const workspace = await one<{ id: WorkspaceId }>(client, 'the new workspace',
    `insert into workspaces (team_id, task_id, instance_id, path) values ($1, $2, $3, '') returning id`,
    [task.team_id, task.id, agent.home_instance_id])
  await client.query(`insert into commands (team_id, instance_id, kind, payload) values ($1, $2, 'setup_workspace', $3)`,
    [task.team_id, agent.home_instance_id, JSON.stringify({ workspaceId: workspace.id, repos })])
  // A draft already has its session, which starts now on the agent's current machine.
  const draft = await maybe<{ id: SessionId }>(client,
    `select id from sessions where task_id = $1 and status = 'draft' and archived_at is null for update`, [task.id])
  const values = [workspace.id, agent.home_instance_id, agent.id, 'person' in startedBy ? startedBy.person : null,
    'session' in startedBy ? startedBy.session : null, agent.harness, agent.model]
  const session = draft
    ? await one<{ id: SessionId }>(client, 'the started draft',
      `update sessions set workspace_id = $2, instance_id = $3, agent_id = $4, started_by = $5, started_by_session = $6, harness = $7, model = $8,
         status = 'starting'
       where id = $1 returning id`, [draft.id, ...values])
    : await one<{ id: SessionId }>(client, 'the new session',
      `insert into sessions (team_id, task_id, workspace_id, instance_id, agent_id, started_by, started_by_session, harness, model)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`, [task.team_id, task.id, ...values])
  return { task, repos, sessionId: session.id }
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
