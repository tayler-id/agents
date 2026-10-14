// Background work against GitHub, beside the runner. GitHub can't send webhooks
// to this server, which only the tailnet reaches, so the worker asks it instead:
// for labels put on issues of the repos of teams with a pipeline that starts
// from forge issues, and for the state of the pull requests the app opened. It
// also tries again any repo request that an API restart left half done. Like
// the runner it serves only AGENTS_RUNNER_TEAMS when that is set.
//
// Anyone can open an issue on a public repo, so on GitHub a run starts only
// from a label that starts with agent:, put on the issue by someone with write,
// maintain or admin access, and only while the issue is open and still has the
// label. Triage access can label issues but is not enough. Opening an issue
// starts nothing, whatever labels its form adds. The issue's text reaches the
// agent as a quoted report, without the parts a reader can't see.

import { z } from 'zod'
import { many, pool } from './db.ts'
import { repoPath } from './forge.ts'
import { githubFor } from './github.ts'
import { GITHUB } from './github-auth.ts'
import { startIssueRuns, wantsIssues } from './hooks.ts'
import { CLAIM_SEC, fulfillRepoRequest } from './projects.ts'
import { reportFromIssue } from './public-text.ts'
import { scopedTeams, wakeRunner } from './runner.ts'
import { messageOf } from '../shared/errors.ts'
import type { RepoId, RepoRequestId } from '../shared/projects.ts'

// How often the worker asks GitHub. Once a minute keeps a team's few repos far
// under GitHub's 5,000 calls an hour. Checks set it lower to see results sooner.
const ROUND_MS = z.coerce.number().positive().default(60).parse(process.env.AGENTS_GITHUB_POLL_SEC) * 1000
// Each poll asks for changes since the last one less this much, so a clock a
// little apart from GitHub's misses nothing. A run starts once per issue anyway.
const OVERLAP_MS = 60_000

// Repo requests whose last try stopped holding them, such as one a restart cut off.
async function retryStuckRequests(teams: string[] | null) {
  const stuck = await many<{ id: RepoRequestId }>(pool,
    `select id from repo_requests where status = 'creating' and updated_at < now() - make_interval(secs => $2)
       and ($1::uuid[] is null or team_id = any($1))`, [teams, CLAIM_SEC])
  for (const { id } of stuck) await fulfillRepoRequest(id, 'worker')
}

type PolledRepo = { id: RepoId; team_id: string; forge: 'github'; remote_url: string; created_at: Date; polled_at: Date | null }

// The labels that ask agents for work on GitHub. bug and its like never qualify,
// since an issue form puts them on for whoever opens the issue.
const AGENT_LABEL = /^agent:/

// Starts runs for the agent labels people with write access put on the repo's
// issues since the last poll, for issues still open with the label. Returns how
// many. GitHub's list is marked read only once all of it is handled, so a poll
// that fails partway reads it again next time.
async function pollRepo(repo: PolledRepo): Promise<number> {
  const asked = new Date()
  const path = repoPath(repo.remote_url)
  const github = githubFor(repo.id)
  // A repo never polled has had labels worth a run since it joined the team.
  const since = repo.polled_at ? new Date(repo.polled_at.getTime() - OVERLAP_MS) : repo.created_at
  const labels = await github.newLabels(path)
  let started = 0
  // Null means GitHub's list is as it was at the last poll, so there is nothing new.
  for (const event of labels?.value ?? []) {
    if (new Date(event.createdAt) < since || !AGENT_LABEL.test(event.label)) continue
    if (!(await github.hasWriteAccess(path, event.actor))) {
      console.log(`${event.actor} put ${event.label} on ${path}#${event.issue} without write access, so no run starts`)
      continue
    }
    // The label could have come off, or the issue closed, before this poll.
    const issue = await github.issue(path, event.issue)
    if (issue.state !== 'open') {
      console.log(`${path}#${issue.number} is closed, so no run starts`)
      continue
    }
    if (!issue.labels.includes(event.label)) {
      console.log(`${path}#${issue.number} no longer has ${event.label}, so no run starts`)
      continue
    }
    const report = { ...reportFromIssue(issue), issue: issue.number, url: issue.html_url, author: issue.user?.login }
    started += (await startIssueRuns(repo, { action: 'label_updated', number: issue.number, labels: [event.label], report, sender: event.actor })).length
  }
  await pool.query('update repos set polled_at = $2 where id = $1', [repo.id, asked])
  labels?.handled()
  return started
}

async function pollIssues(teams: string[] | null) {
  const repos = await many<PolledRepo>(pool,
    `select id, team_id, forge, remote_url, created_at, polled_at from repos
     where forge = 'github' and ($1::uuid[] is null or team_id = any($1)) order by created_at, id`, [teams])
  let started = 0
  for (const repo of repos) {
    if (!(await wantsIssues(repo.team_id))) continue
    try {
      started += await pollRepo(repo)
    } catch (error) {
      // GitHub refused or did not answer for this repo. Its cursor and GitHub's
      // list stay where they were, so the next round asks again and misses
      // nothing, and the other repos go on.
      console.error(`polling ${repo.remote_url}:`, messageOf(error))
    }
  }
  if (started) await wakeRunner()
}

const PullNumber = z.coerce.number().int().positive()

// The pull requests the app opened on GitHub and still has as open. One merged
// or closed on GitHub gets that state, so the run and the Repos page show it.
async function pollPullRequests(teams: string[] | null) {
  const links = await many<{ id: string; url: string; remote_url: string; repo_id: RepoId }>(pool,
    `select distinct a.id, a.url, r.remote_url, r.id as repo_id from artifacts a
     join task_repos tr on tr.task_id = a.task_id join repos r on r.id = tr.repo_id
     where a.kind = 'link' and a.state = 'open' and r.forge = 'github'
       and starts_with(a.url, left(r.remote_url, -length('.git')) || '/pull/')
       and ($1::uuid[] is null or a.team_id = any($1))`, [teams])
  for (const link of links) {
    try {
      const pr = await githubFor(link.repo_id).pullRequestIfChanged(repoPath(link.remote_url), PullNumber.parse(link.url.split('/pull/')[1]))
      // Null means unchanged since the last poll, so it is still open.
      if (!pr) continue
      const state = pr.value.merged ? 'merged' : pr.value.state === 'closed' ? 'closed' : null
      if (state) await pool.query(`update artifacts set state = $2, updated_at = now() where id = $1 and state = 'open'`, [link.id, state])
      pr.handled()
    } catch (error) {
      // As for issues, the link stays open and the next round asks again.
      console.error(`reading ${link.url}:`, messageOf(error))
    }
  }
}

async function round() {
  const teams = await scopedTeams()
  await retryStuckRequests(teams)
  if (!GITHUB.on) return
  await pollIssues(teams)
  await pollPullRequests(teams)
}

// Runs a round every ROUND_MS until stopped. Stopping waits for the round in
// progress, if any, and starts no other.
export function startGithubWorker(): { stop(): Promise<void> } {
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let current: Promise<void> = Promise.resolve()
  const loop = () => {
    current = round()
      // A round that fails, such as while Postgres restarts, is logged, and the next round starts afresh.
      .catch((error: unknown) => { console.error('github worker:', messageOf(error)) })
      .finally(() => { if (!stopped) timer = setTimeout(loop, ROUND_MS) })
  }
  loop()
  return {
    async stop() {
      stopped = true
      clearTimeout(timer)
      await current
    },
  }
}
