// Where each repo lives, and how to reach it. repos.forge says whether a repo is
// on this Mac's Gitea or on GitHub. The runner, the git proxy and the Repos page
// ask here, so nothing else needs to know which forge holds a repo. A repo is
// one team's row in repos, so a GitHub repo two teams share keeps each team's
// own sign-in.

import { z } from 'zod'
import { many, pool } from './db.ts'
import { forge, gitUpstream, repoPath, type Forge } from './forge.ts'
import { explainGithub, githubFor, githubUpstream } from './github.ts'
import { githubStatus, type Someone } from './github-auth.ts'
import { messageOf } from '../shared/errors.ts'
import { ProjectRef, RepoId, type RepoForge, type ReposOverview, type RepoView } from '../shared/projects.ts'

// The columns a repo's forge is chosen by.
export type RepoOnForge = { forge: RepoForge; remote_url: string }
// A team's repo row, as the calls to its forge need it.
export type TeamRepo = RepoOnForge & { id: string }

export function forgeFor(repo: TeamRepo): Forge {
  switch (repo.forge) {
    case 'gitea': return forge
    case 'github': return githubFor(RepoId.parse(repo.id))
  }
}

// A run that someone asked for by labelling a GitHub issue opens its pull
// request only while they still have write access or more. Throws, saying so,
// when they no longer do. A run a teammate started in the app has no asker here.
export async function checkAsker(repo: TeamRepo, sender: string | undefined): Promise<void> {
  if (repo.forge !== 'github' || sender === undefined) return
  const path = repoPath(repo.remote_url)
  if (!(await githubFor(RepoId.parse(repo.id)).hasWriteAccess(path, sender))) {
    throw new Error(`${sender}, who asked for this run, no longer has write access to ${path}, so its pull request was not opened.`)
  }
}

// The repo's git endpoint on its forge, and the credentials the proxy adds.
export async function gitUpstreamFor(repo: TeamRepo): Promise<{ url: string; authorization: string }> {
  switch (repo.forge) {
    case 'gitea': return gitUpstream(repo.remote_url)
    case 'github': return githubUpstream({ id: RepoId.parse(repo.id), remote_url: repo.remote_url })
  }
}

// The branch the repo's forge says is its default now. A repo's owner can make
// another branch the default at any time, so the branch rule asks the forge,
// and the stored one is brought up to date.
export async function currentDefaultBranch(repo: TeamRepo & { default_branch: string }): Promise<string> {
  const now = await forgeFor(repo).defaultBranch(repoPath(repo.remote_url))
  if (now !== repo.default_branch) await pool.query('update repos set default_branch = $2 where id = $1', [repo.id, now])
  return now
}

// How long the Repos page keeps a forge's answer, so however many people have it
// open, each forge sees two calls per repo every half minute. GitHub allows
// 5,000 calls an hour. Checks set it lower to see changes sooner.
const CACHE_MS = z.coerce.number().positive().default(30).parse(process.env.AGENTS_REPOS_CACHE_SEC) * 1000
// Kept per repo row, so one team never sees an answer read with another's sign-in.
const cache = new Map<string, { at: number; open: RepoView['open'] }>()

// What is open on a repo, from its forge, or why the forge could not say.
async function openOn(repo: TeamRepo): Promise<RepoView['open']> {
  const kept = cache.get(repo.id)
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
  cache.set(repo.id, { at: Date.now(), open })
  return open
}

// Every repo of a person's team, oldest first, with what its forge says is open
// on it, and GitHub as that person sees it.
export async function reposOverview(person: Someone): Promise<ReposOverview> {
  const rows = await many<RepoOnForge & { id: RepoId; default_branch: string; project: unknown }>(pool,
    `select r.id, r.forge, r.remote_url, r.default_branch,
       case when p.id is null then null else json_build_object('id', p.id, 'name', p.name) end as project
     from repos r left join projects p on p.id = r.project_id
     where r.team_id = $1 order by r.created_at, r.id`, [person.team_id])
  const repos = await Promise.all(rows.map(async (row): Promise<RepoView> => ({
    id: row.id, name: repoPath(row.remote_url), forge: row.forge, webUrl: row.remote_url.replace(/\.git$/, ''),
    defaultBranch: row.default_branch, project: ProjectRef.nullable().parse(row.project), open: await openOn(row),
  })))
  return { github: githubStatus(person), repos }
}
