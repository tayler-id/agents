// How a task's repos sit in its workspace. Each repo is a folder named after it,
// such as ./shop. When two repos share a name, each takes its owner too, such as
// ./team-shop and ./ops-shop, so no clone lands on another.

import type pg from 'pg'
import { many } from './db.ts'
import { repoPath } from './forge.ts'
import { HttpError, type Person } from './record.ts'
import type { RepoId, TaskId } from '../shared/ids.ts'
import type { WorkspaceRepo } from '../shared/types.ts'

function ownerAndName(remoteUrl: string): { owner: string; name: string } {
  const match = /^([^/]+)\/([^/]+)$/.exec(repoPath(remoteUrl))
  if (!match?.[1] || !match[2]) throw new Error(`${remoteUrl} has no owner and name`)
  return { owner: match[1], name: match[2] }
}

// Each repo with its workspace folder.
export function withFolders<T extends { remote_url: string }>(repos: T[]): (T & { folder: string })[] {
  const named = repos.map((repo) => ({ repo, ...ownerAndName(repo.remote_url) }))
  return named.map(({ repo, owner, name }) => ({
    ...repo,
    folder: named.filter((other) => other.name === name).length > 1 ? `${owner}-${name}` : name,
  }))
}

// The task's repos as its workspace checks them out, the primary one first.
export async function checkoutsOf(client: pg.PoolClient, taskId: TaskId, branch: string): Promise<WorkspaceRepo[]> {
  const rows = await many<{ id: RepoId; remote_url: string; default_branch: string; setup_command: string | null }>(client,
    `select r.id, r.remote_url, r.default_branch, r.setup_command from task_repos tr join repos r on r.id = tr.repo_id
     where tr.task_id = $1 order by tr.is_primary desc, r.remote_url`, [taskId])
  return withFolders(rows).map((r) => ({ repoId: r.id, name: r.folder, branch, base: r.default_branch, setup: r.setup_command }))
}

// Sets the task's repos, the first one primary. Each must be one of the person's team's.
export async function setTaskRepos(client: pg.PoolClient, person: Person, taskId: TaskId, repoIds: RepoId[]) {
  const wanted = [...new Set(repoIds)]
  const found = await many<{ id: RepoId }>(client, 'select id from repos where team_id = $1 and id = any($2)', [person.team_id, wanted])
  if (found.length !== wanted.length) throw new HttpError(404, 'no such repo')
  await client.query('delete from task_repos where task_id = $1', [taskId])
  for (const [i, repoId] of wanted.entries()) {
    await client.query('insert into task_repos (task_id, repo_id, is_primary) values ($1, $2, $3)', [taskId, repoId, i === 0])
  }
}
