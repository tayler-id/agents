// How a task's repos sit in its workspace. Each repo is a folder named after it,
// such as ./shop. When two repos share a name, each takes its owner too, such as
// ./team-shop and ./ops-shop, so no clone lands on another.

import type pg from 'pg'
import { many } from './db.ts'
import { repoPath } from './forge.ts'
import { HttpError } from './record.ts'
import type { WorkspaceRepo } from '../shared/types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// The workspace folder of each repo, in the order given.
export function folderNames(remoteUrls: string[]): string[] {
  const parts = remoteUrls.map((url) => repoPath(url).split('/'))
  return parts.map(([owner = '', name = '']) =>
    parts.filter(([, other]) => other === name).length > 1 ? `${owner}-${name}` : name)
}

// The task's repos as its workspace checks them out, the primary one first.
export async function checkoutsOf(client: pg.PoolClient, taskId: string, branch: string): Promise<WorkspaceRepo[]> {
  const rows = await many<{ id: string; remote_url: string; default_branch: string; setup_command: string | null }>(client,
    `select r.id, r.remote_url, r.default_branch, r.setup_command from task_repos tr join repos r on r.id = tr.repo_id
     where tr.task_id = $1 order by tr.is_primary desc, r.remote_url`, [taskId])
  const names = folderNames(rows.map((r) => r.remote_url))
  return rows.map((r, i) => ({ repoId: r.id, name: names[i] ?? r.id, branch, base: r.default_branch, setup: r.setup_command }))
}

// Sets the task's repos, the first one primary. Each must be one of the team's.
export async function setTaskRepos(client: pg.PoolClient, teamId: string, taskId: string, repoIds: string[]) {
  const wanted = [...new Set(repoIds)]
  if (wanted.some((id) => !UUID.test(id))) throw new HttpError(400, 'repoIds must be repo ids')
  const found = await many<{ id: string }>(client, 'select id from repos where team_id = $1 and id = any($2)', [teamId, wanted])
  if (found.length !== wanted.length) throw new HttpError(404, 'no such repo')
  await client.query('delete from task_repos where task_id = $1', [taskId])
  for (const [i, repoId] of wanted.entries()) {
    await client.query('insert into task_repos (task_id, repo_id, is_primary) values ($1, $2, $3)', [taskId, repoId, i === 0])
  }
}
