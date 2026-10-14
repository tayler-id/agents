// Webhooks that start pipeline runs. The forge's arrive on the machine port, the
// one its container can reach, signed with the forge's webhook secret. Any other
// system can start a pipeline through that pipeline's own webhook URL, signed with
// a secret derived from AGENTS_HOOK_SECRET for that pipeline.

import { createHmac } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { many, maybe, pool, tx } from './db.ts'
import { forgeConfig, repoPath, verifySignature } from './forge.ts'
import { loadSource } from './pipelines.ts'
import { HttpError } from './record.ts'
import { forgeFor, type RepoOnForge } from './repos.ts'
import { startRun } from './runner.ts'
import type { Report } from '../shared/pipeline.ts'

export const hookSecret = (pipelineId: string) =>
  createHmac('sha256', process.env.AGENTS_HOOK_SECRET ?? '').update(pipelineId).digest('hex')

const header = (headers: IncomingHttpHeaders, name: string) => {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

// Webhook bodies come from outside, so every field is checked before use.
type Loose = Record<string, unknown>
const isObject = (value: unknown): value is Loose => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

function parse(body: Buffer): Loose {
  let value: unknown
  try {
    value = JSON.parse(body.toString('utf8'))
  } catch {
    throw new HttpError(400, 'body must be JSON')
  }
  if (!isObject(value)) throw new HttpError(400, 'body must be a JSON object')
  return value
}

// `sender` is who asked for the work on a public forge, by putting a label on the issue.
export type IssueEvent = { action: string; number: number; labels: string[]; report: Report; sender?: string }

// The parts of Gitea's issues event a run needs, or null if it has none of them.
function issueEvent(payload: Loose): IssueEvent | null {
  const issue = payload.issue
  if (!isObject(issue) || typeof issue.number !== 'number' || !str(issue.title)) return null
  const labels = Array.isArray(issue.labels) ? issue.labels.flatMap((l) => (isObject(l) && typeof l.name === 'string' ? [l.name] : [])) : []
  const author = isObject(issue.user) ? str(issue.user.login) : undefined
  return {
    action: str(payload.action) ?? '', number: issue.number, labels,
    report: { title: str(issue.title) ?? '', body: str(issue.body) ?? '', issue: issue.number, url: str(issue.html_url), author },
  }
}

// A run, unless the same source event already started one.
async function start(options: Parameters<typeof startRun>[1]): Promise<string | null> {
  try {
    return await tx((client) => startRun(client, options))
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return null
    throw error
  }
}

type Sync = (repoIds: string[]) => Promise<void>

export async function forgeHook(body: Buffer, headers: IncomingHttpHeaders, sync: Sync): Promise<{ runs: string[] }> {
  if (!verifySignature(body, header(headers, 'x-gitea-signature'), forgeConfig().webhookSecret)) {
    throw new HttpError(401, 'bad signature')
  }
  const event = header(headers, 'x-gitea-event')
  const payload = parse(body)
  const cloneUrl = isObject(payload.repository) ? str(payload.repository.clone_url) ?? '' : ''
  const repos = await many<RepoOnForge & { id: string; team_id: string }>(pool,
    'select id, team_id, forge, remote_url from repos where remote_url = $1', [cloneUrl])
  if (event === 'push') {
    await sync(repos.map((r) => r.id))
    return { runs: [] }
  }
  const issue = event === 'issues' ? issueEvent(payload) : null
  if (!issue || !['opened', 'label_updated'].includes(issue.action)) return { runs: [] }
  const runs: string[] = []
  for (const repo of repos) runs.push(...await startIssueRuns(repo, issue))
  return { runs }
}

const currentPipelines = (teamId: string) => many<{ id: string; source: string }>(pool,
  `select p.id, v.source from pipelines p join pipeline_versions v on v.id = p.current_version_id where p.team_id = $1`, [teamId])

// Starts a run of each of the team's pipelines whose forge trigger the issue
// matches, once per issue and pipeline. This Mac's forge reaches here through
// its webhook, and GitHub through the poller in server/github-worker.ts.
export async function startIssueRuns(repo: RepoOnForge & { id: string; team_id: string }, issue: IssueEvent): Promise<string[]> {
  const { labels, report } = issue
  const runs: string[] = []
  for (const row of await currentPipelines(repo.team_id)) {
    const { pipeline } = await loadSource(row.source)
    const wanted = pipeline?.triggers.some((t) => t.kind === 'forge' && (t.label ? labels.includes(t.label) : issue.action === 'opened'))
    if (!wanted) continue
    const openIssues = (await forgeFor(repo).openIssues(repoPath(repo.remote_url)))
      .filter((i) => i.number !== issue.number).map((i) => ({ number: i.number, title: i.title }))
    const runId = await start({
      pipelineId: row.id, trigger: 'forge', report, repoId: repo.id, openIssues, sender: issue.sender,
      once: `issue:${row.id}:${repo.id}:${issue.number}`,
    })
    if (runId) runs.push(runId)
  }
  return runs
}

// Whether any of the team's pipelines starts from forge issues, so the GitHub
// worker asks GitHub only for the teams that need it.
export async function wantsIssues(teamId: string): Promise<boolean> {
  for (const row of await currentPipelines(teamId)) {
    if ((await loadSource(row.source)).pipeline?.triggers.some((t) => t.kind === 'forge')) return true
  }
  return false
}

// A pipeline's own webhook: {title, body, repo, id?}. repo is the forge path, such
// as team/shop. An id makes a repeated delivery start only one run.
export async function pipelineHook(pipelineId: string, body: Buffer, headers: IncomingHttpHeaders): Promise<{ runs: string[] }> {
  if (!process.env.AGENTS_HOOK_SECRET || !verifySignature(body, header(headers, 'x-agents-signature'), hookSecret(pipelineId))) {
    throw new HttpError(401, 'bad signature')
  }
  const payload = parse(body)
  const title = str(payload.title)
  if (!title) throw new HttpError(400, 'title is required')
  const id = str(payload.id) ?? (typeof payload.id === 'number' ? String(payload.id) : undefined)
  const repo = await maybe<RepoOnForge & { id: string }>(pool,
    `select r.id, r.forge, r.remote_url from repos r join pipelines p on p.team_id = r.team_id
     where p.id = $1 and r.remote_url like '%/' || $2 || '.git'`, [pipelineId, str(payload.repo) ?? ''])
  if (!repo) throw new HttpError(404, 'repo must name one of the team\'s repos, such as team/shop')
  const openIssues = (await forgeFor(repo).openIssues(repoPath(repo.remote_url))).map((i) => ({ number: i.number, title: i.title }))
  const runId = await start({
    pipelineId, trigger: 'webhook', repoId: repo.id, openIssues,
    report: { title, body: str(payload.body) ?? '', url: str(payload.url) },
    once: id ? `webhook:${pipelineId}:${id}` : undefined,
  })
  return { runs: runId ? [runId] : [] }
}
