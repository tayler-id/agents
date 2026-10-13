// What differs from the base branch in a task workspace's repos, as its machine
// sees it. The machine posts after tool results, turns and commands in the
// workspace. A file sent in full replaces its row, a file no longer listed loses
// its row, and the reply names each file listed by its facts alone that the API
// lacks, so the machine sends it in full. A repo with too many files loses its
// rows, and one git could not read keeps them; unlisted_changes says which.

import type pg from 'pg'
import { many, maybe } from './db.ts'
import { HttpError, scrub } from './record.ts'
import type { RepoId, TaskId, WorkspaceId } from '../shared/ids.ts'
import type { ChangedFile, ChangesPost, ChangesReply, Preview, RepoChanges } from '../shared/work.ts'

type Workspace = { team_id: string; task_id: TaskId }
type Listed = Extract<RepoChanges, { state: 'listed' }>

export async function saveChanges(client: pg.PoolClient, instanceId: string, workspaceId: WorkspaceId, post: ChangesPost): Promise<ChangesReply> {
  const workspace = await maybe<Workspace>(client,
    'select team_id, task_id from workspaces where id = $1 and instance_id = $2 for update', [workspaceId, instanceId])
  if (!workspace) throw new HttpError(404, 'no such workspace on this machine')
  const own = new Set((await many<{ repo_id: RepoId }>(client,
    'select repo_id from task_repos where task_id = $1', [workspace.task_id])).map((r) => r.repo_id))
  // A repo the agent cloned for itself through the git proxy is not one of the task's.
  const repos = post.repos.filter((repo) => own.has(repo.repoId))
  const present = repos.map((r) => r.repoId)
  await client.query('delete from file_changes where workspace_id = $1 and not (repo_id = any($2))', [workspaceId, present])
  await client.query('delete from unlisted_changes where workspace_id = $1 and not (repo_id = any($2))', [workspaceId, present])
  const missing: ChangesReply['missing'] = []
  for (const repo of repos) {
    switch (repo.state) {
      case 'listed':
        await client.query('delete from unlisted_changes where workspace_id = $1 and repo_id = $2', [workspaceId, repo.repoId])
        missing.push(...await saveListed(client, workspace, workspaceId, repo))
        break
      case 'too_many':
        await client.query('delete from file_changes where workspace_id = $1 and repo_id = $2', [workspaceId, repo.repoId])
        await saveUnlisted(client, workspace, workspaceId, repo.repoId, 'too_many', null)
        break
      case 'unreadable':
        await saveUnlisted(client, workspace, workspaceId, repo.repoId, 'unreadable', scrub(repo.reason))
        break
    }
  }
  return { missing }
}

async function saveListed(client: pg.PoolClient, workspace: Workspace, workspaceId: WorkspaceId, repo: Listed): Promise<ChangesReply['missing']> {
  await client.query('delete from file_changes where workspace_id = $1 and repo_id = $2 and not (path = any($3))',
    [workspaceId, repo.repoId, repo.files.map((f) => f.path)])
  const stored = new Map((await many<{ path: string; hash: string }>(client,
    'select path, hash from file_changes where workspace_id = $1 and repo_id = $2', [workspaceId, repo.repoId])).map((r) => [r.path, r.hash]))
  const missing: ChangesReply['missing'] = []
  for (const file of repo.files) {
    if (file.sent === 'facts') {
      if (stored.get(file.path) !== file.hash) missing.push({ repoId: repo.repoId, path: file.path })
    } else {
      await saveFile(client, workspace, workspaceId, repo, file)
    }
  }
  return missing
}

async function saveUnlisted(client: pg.PoolClient, workspace: Workspace, workspaceId: WorkspaceId, repoId: RepoId, kind: 'too_many' | 'unreadable', reason: string | null) {
  await client.query(
    `insert into unlisted_changes (workspace_id, repo_id, team_id, task_id, kind, reason) values ($1, $2, $3, $4, $5, $6)
     on conflict (workspace_id, repo_id) do update set kind = excluded.kind, reason = excluded.reason, updated_at = now()`,
    [workspaceId, repoId, workspace.team_id, workspace.task_id, kind, reason])
}

// What the app can show of a file sent in full, scrubbed again here.
function previewOf(file: Exclude<ChangedFile, { sent: 'facts' }>): { preview: Preview; content: string | null; diff: string | null } {
  switch (file.sent) {
    case 'text': return { preview: 'text', content: file.content === null ? null : scrub(file.content), diff: scrub(file.diff) }
    case 'binary': return { preview: 'binary', content: null, diff: null }
    case 'too_large': return { preview: 'too_large', content: null, diff: null }
  }
}

async function saveFile(client: pg.PoolClient, workspace: Workspace, workspaceId: WorkspaceId, repo: Listed, file: Exclude<ChangedFile, { sent: 'facts' }>) {
  const { preview, content, diff } = previewOf(file)
  await client.query(
    `insert into file_changes (team_id, task_id, workspace_id, repo_id, path, status, additions, deletions, preview, content, diff, base_commit, hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (workspace_id, repo_id, path) do update set status = excluded.status, additions = excluded.additions,
       deletions = excluded.deletions, preview = excluded.preview, content = excluded.content, diff = excluded.diff,
       base_commit = excluded.base_commit, hash = excluded.hash, updated_at = now()`,
    [workspace.team_id, workspace.task_id, workspaceId, repo.repoId, file.path, file.status, file.additions, file.deletions,
      preview, content, diff, repo.baseCommit, file.hash])
}
