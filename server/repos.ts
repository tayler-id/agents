// Where each repo lives, and how to reach it. repos.forge says whether a repo is
// on this Mac's Gitea or on GitHub. The runner, the git proxy and the Repos page
// ask here, so nothing else needs to know which forge holds a repo.

import { z } from 'zod'
import { many, pool } from './db.ts'
import { forge, gitUpstream, repoPath, type Forge } from './forge.ts'
import { explainGithub, github, githubUpstream } from './github.ts'
import { githubStatus } from './github-auth.ts'
import { messageOf } from '../shared/errors.ts'
import type { ProjectId, RepoForge, RepoId, ReposOverview, RepoView } from '../shared/projects.ts'

// The columns a repo's forge is chosen by.
export type RepoOnForge = { forge: RepoForge; remote_url: string }

export function forgeFor(repo: RepoOnForge): Forge {
  switch (repo.forge) {
    case 'gitea': return forge
    case 'github': return github
  }
}

// A run that someone asked for by labelling a GitHub issue opens its pull
// request only while they still have write access or more. Throws, saying so,
// when they no longer do. A run a teammate started in the app has no asker here.
export async function checkAsker(repo: RepoOnForge, sender: string | undefined): Promise<void> {
  if (repo.forge !== 'github' || sender === undefined) return
  const path = repoPath(repo.remote_url)
  if (!(await github.hasWriteAccess(path, sender))) {
    throw new Error(`${sender}, who asked for this run, no longer has write access to ${path}, so its pull request was not opened.`)
  }
}

// The repo's git endpoint on its forge, and the credentials the proxy adds.
export async function gitUpstreamFor(repo: RepoOnForge): Promise<{ url: string; authorization: string }> {
  switch (repo.forge) {
    case 'gitea': return gitUpstream(repo.remote_url)
    case 'github': return githubUpstream(repo.remote_url)
  }
}

// How long the Repos page keeps a forge's answer, so however many people have it
// open, each forge sees two calls per repo every half minute. GitHub allows
// 5,000 calls an hour. Checks set it lower to see changes sooner.
const CACHE_MS = z.coerce.number().positive().default(30).parse(process.env.AGENTS_REPOS_CACHE_SEC) * 1000
const cache = new Map<string, { at: number; open: RepoView['open'] }>()

// What is open on a repo, from its forge, or why the forge could not say.
async function openOn(repo: RepoOnForge): Promise<RepoView['open']> {
  const kept = cache.get(repo.remote_url)
  if (kept && Date.now() - kept.at < CACHE_MS) return kept.open
  const path = repoPath(repo.remote_url)
  const host = forgeFor(repo)
  let open: RepoView['open']
  try {
    const [pullRequests, branches] = await Promise.all([host.openPullRequests(path), host.branches(path)])
    open = { read: true, pullRequests, taskBranches: branches.filter((b) => b.startsWith('task/')).sort() }
  } catch (error) {
    // The page lists the repo anyway and says why its forge could not be read.
    open = { read: false, problem: repo.forge === 'github' ? explainGithub(error) : `This Mac's forge did not answer: ${messageOf(error)}` }
  }
  cache.set(repo.remote_url, { at: Date.now(), open })
  return open
}

// Every repo of a person's team, oldest first, with what its forge says is open
// on it, and GitHub as that person sees it.
export async function reposOverview(person: { id: string; team_id: string }): Promise<ReposOverview> {
  const rows = await many<RepoOnForge & { id: RepoId; default_branch: string; project_id: ProjectId | null }>(pool,
    'select id, forge, remote_url, default_branch, project_id from repos where team_id = $1 order by created_at, id', [person.team_id])
  const repos = await Promise.all(rows.map(async (row): Promise<RepoView> => ({
    id: row.id, name: repoPath(row.remote_url), forge: row.forge, webUrl: row.remote_url.replace(/\.git$/, ''),
    defaultBranch: row.default_branch, projectId: row.project_id, open: await openOn(row),
  })))
  return { github: githubStatus(person.id), repos }
}
