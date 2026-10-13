// Where each repo lives, and how to reach it. A repo is on this Mac's Gitea or on
// GitHub. The runner, the git proxy and the Repos page ask here, so nothing else
// needs to know which forge holds a repo.

import { many, pool } from './db.ts'
import { forge, gitUpstream, repoPath, type Forge, type OpenPullRequest } from './forge.ts'
import { explainGithub, github, githubStatus, githubUpstream, isGithubUrl, type GithubStatus } from './github.ts'
import { messageOf } from '../shared/errors.ts'

export type Where = 'github' | 'forge'

export const whereRepoLives = (remoteUrl: string): Where => (isGithubUrl(remoteUrl) ? 'github' : 'forge')

export const forgeFor = (remoteUrl: string): Forge => (isGithubUrl(remoteUrl) ? github : forge)

// The repo's git endpoint on its forge, and the credentials the proxy adds.
export const gitUpstreamFor = (remoteUrl: string) => (isGithubUrl(remoteUrl) ? githubUpstream(remoteUrl) : gitUpstream(remoteUrl))

// What the Repos page shows for one repo. The pull requests and task branches
// come from its forge, or are null with the reason when the forge can't be read.
export type RepoView = {
  id: string; name: string; where: Where; webUrl: string; defaultBranch: string; projectId: string | null
  pullRequests: OpenPullRequest[] | null; taskBranches: string[] | null; problem: string | null
}

type ForgeView = Pick<RepoView, 'pullRequests' | 'taskBranches' | 'problem'>

// Each forge's answer is kept a while, so however many people have the page
// open, GitHub sees a couple of calls per repo every half minute.
const CACHE_MS = Number(process.env.AGENTS_REPOS_CACHE_SEC ?? 30) * 1000
const cache = new Map<string, { at: number; view: ForgeView }>()

async function forgeView(remoteUrl: string): Promise<ForgeView> {
  const kept = cache.get(remoteUrl)
  if (kept && Date.now() - kept.at < CACHE_MS) return kept.view
  const path = repoPath(remoteUrl)
  const host = forgeFor(remoteUrl)
  let view: ForgeView
  try {
    const [pullRequests, branches] = await Promise.all([host.openPullRequests(path), host.branches(path)])
    view = { pullRequests, taskBranches: branches.filter((b) => b.startsWith('task/')).sort(), problem: null }
  } catch (error) {
    view = { pullRequests: null, taskBranches: null, problem: isGithubUrl(remoteUrl) ? explainGithub(error) : `Could not read this Mac's forge: ${messageOf(error)}` }
  }
  cache.set(remoteUrl, { at: Date.now(), view })
  return view
}

// Every repo of a team, oldest first, with what its forge says is open on it.
export async function reposOverview(teamId: string): Promise<{ github: GithubStatus; repos: RepoView[] }> {
  const rows = await many<{ id: string; remote_url: string; default_branch: string; project_id: string | null }>(pool,
    'select id, remote_url, default_branch, project_id from repos where team_id = $1 order by created_at, id', [teamId])
  const repos = await Promise.all(rows.map(async (r): Promise<RepoView> => ({
    id: r.id, name: repoPath(r.remote_url), where: whereRepoLives(r.remote_url), webUrl: r.remote_url.replace(/\.git$/, ''),
    defaultBranch: r.default_branch, projectId: r.project_id, ...(await forgeView(r.remote_url)),
  })))
  return { github: githubStatus(), repos }
}
