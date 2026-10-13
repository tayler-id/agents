// Pull requests from a task. A person asks, the task's machine pushes each
// repo's task branch, and once the push ends the runner's loop opens a pull
// request on the forge for each repo with commits past its base. They become
// link artifacts on the task, as a run's do. shared/work.ts holds the lifecycle.

import type pg from 'pg'
import { z } from 'zod'
import { many, maybe, one, pool, tx } from './db.ts'
import { canSeeTask } from './access.ts'
import { HttpError, type Person } from './record.ts'
import { checkoutsOf } from './checkout.ts'
import { forge, repoPath } from './forge.ts'
import { messageOf } from '../shared/errors.ts'
import { canMove, type PullRequestAsk, type PushStatus } from '../shared/work.ts'
import { PushResult, type PushPayload, type SessionStatus } from '../shared/types.ts'
import type { PushId, TaskId } from '../shared/ids.ts'

// While a session is in one of these, its agent may still be changing files.
const WORKING: SessionStatus[] = ['starting', 'running', 'needs_approval', 'needs_input']

export async function askForPullRequests(client: pg.PoolClient, person: Person, taskId: TaskId, ask: PullRequestAsk): Promise<{ pushId: PushId }> {
  if (!(await canSeeTask(person, taskId))) throw new HttpError(404, 'no such task')
  const task = await one<{ slug: string; agent: string | null }>(client, `task ${taskId}`,
    'select t.slug, a.name as agent from tasks t left join agents a on a.id = t.agent_id where t.id = $1', [taskId])
  if (!task.agent) throw new HttpError(409, "the task's agent is gone, and its commits are made in its name")
  const workspace = await maybe<{ id: string; instance_id: string; team_id: string; status: string }>(client,
    'select id, instance_id, team_id, status from workspaces where task_id = $1 order by created_at desc limit 1', [taskId])
  if (workspace?.status !== 'ready') throw new HttpError(409, "the task's workspace is not set up yet")
  if (await maybe(client, 'select 1 from sessions where task_id = $1 and status = any($2) and archived_at is null', [taskId, WORKING])) {
    throw new HttpError(409, 'the agent is still working. Open the pull request when its turn ends.')
  }
  const repos = await checkoutsOf(client, taskId, `task/${task.slug}`)
  if (!repos.length) throw new HttpError(409, 'this task has no repo to open a pull request on')
  const payload: PushPayload = {
    workspaceId: workspace.id, message: ask.title, author: task.agent,
    repos: repos.map((r) => ({ repoId: r.repoId, name: r.name, branch: r.branch, base: r.base })),
  }
  const command = await one<{ id: string }>(client, 'the push command',
    `insert into commands (team_id, instance_id, kind, payload) values ($1, $2, 'push', $3) returning id`,
    [workspace.team_id, workspace.instance_id, JSON.stringify(payload)])
  const push = await maybe<{ id: PushId }>(client,
    `insert into pushes (team_id, task_id, workspace_id, command_id, requested_by, title, body) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (task_id) where status = 'pushing' do nothing returning id`,
    [workspace.team_id, taskId, workspace.id, command.id, person.id, ask.title, ask.body])
  if (!push) throw new HttpError(409, 'a push for this task is already under way')
  return { pushId: push.id }
}

type Push = {
  id: PushId; task_id: TaskId; team_id: string; status: PushStatus; title: string; body: string; slug: string
  command_status: string; command_error: string | null; command_result: unknown
}
type Ending = { status: 'done' } | { status: 'failed'; error: string }

async function end(client: pg.PoolClient, push: Push, ending: Ending) {
  if (!canMove(push.status, ending.status)) throw new Error(`a push cannot go from ${push.status} to ${ending.status}`)
  await client.query('update pushes set status = $2, error = $3, finished_at = now() where id = $1 and status = $4',
    [push.id, ending.status, ending.status === 'failed' ? ending.error : null, push.status])
}

// A push whose command has ended: open its pull requests, or say why not. The
// row stays locked while the forge is called, and the forge finds a branch's
// open pull request before making one, so a retry never opens two.
async function finishPush(client: pg.PoolClient, pushId: PushId) {
  const push = await maybe<Push>(client,
    `select p.id, p.task_id, p.team_id, p.status, p.title, p.body, t.slug, c.status as command_status, c.error as command_error,
       c.result as command_result
     from pushes p join tasks t on t.id = p.task_id join commands c on c.id = p.command_id
     where p.id = $1 and p.status = 'pushing' and c.status in ('done', 'failed') for update of p skip locked`, [pushId])
  if (!push) return
  if (push.command_status === 'failed') {
    // A machine that fails a command says why, and the API stores no reason only when none came.
    return end(client, push, { status: 'failed', error: `The push failed: ${push.command_error ?? 'the machine gave no reason'}` })
  }
  const result = PushResult.safeParse(push.command_result)
  if (!result.success) return end(client, push, { status: 'failed', error: `The machine's report of the push did not read: ${z.prettifyError(result.error)}` })
  const ahead = new Set(result.data.pushed.filter((p) => p.ahead > 0).map((p) => p.repoId))
  const repos = (await checkoutsOf(client, push.task_id, `task/${push.slug}`)).filter((r) => ahead.has(r.repoId))
  if (!repos.length) return end(client, push, { status: 'failed', error: 'There is nothing to open a pull request for. No branch has commits past its base.' })
  const urls = new Map((await many<{ id: string; remote_url: string }>(client,
    'select id, remote_url from repos where id = any($1)', [repos.map((r) => r.repoId)])).map((r) => [r.id, r.remote_url]))
  try {
    for (const repo of repos) {
      const url = urls.get(repo.repoId)
      if (!url) throw new Error(`repo ${repo.repoId} is gone`)
      const path = repoPath(url)
      const pr = await forge.openPullRequest(path, repo.branch, repo.base, push.title, push.body)
      await client.query(
        `insert into artifacts (team_id, task_id, kind, title, url, state)
         select $1, $2, 'link', $3, $4, 'open' where not exists (select 1 from artifacts where task_id = $2 and url = $4)`,
        [push.team_id, push.task_id, `Pull request #${pr.number} on ${path}`, pr.html_url])
    }
  } catch (error) {
    return end(client, push, { status: 'failed', error: messageOf(error) })
  }
  return end(client, push, { status: 'done' })
}

// Finishes every push whose command has ended, for the runner's teams.
export async function finishPushes(teamIds: string[] | null) {
  const due = await many<{ id: PushId }>(pool,
    `select p.id from pushes p join commands c on c.id = p.command_id
     where p.status = 'pushing' and c.status in ('done', 'failed') and ($1::uuid[] is null or p.team_id = any($1))`, [teamIds])
  for (const { id } of due) await tx((client) => finishPush(client, id))
}
