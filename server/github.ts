// GitHub, the forge for project repos. It answers the same calls as this Mac's
// Gitea in server/forge.ts, so the runner and the pipelines work on either. Each
// call acts as a person or for a repo, with the token server/github-auth.ts
// finds for it. Machines reach GitHub's git only through the API's git proxy,
// which adds that token. Every answer from GitHub is parsed before anything
// reads it, and everything sent to GitHub passes forPublic first.

import { z } from 'zod'
import { ForgeError, repoPath, type Forge, type Issue, type PullRequest } from './forge.ts'
import { setup, tokenFor, type Who } from './github-auth.ts'
import { forPublic } from './public-text.ts'
import { messageOf } from '../shared/errors.ts'
import type { OpenPullRequest } from '../shared/projects.ts'

// GitHub's refusals: a message, and sometimes details.
const Refusal = z.object({ message: z.string(), errors: z.array(z.object({ message: z.string().optional() })).optional() })

// How much of a refusal that isn't GitHub's JSON, such as a proxy's error page, is shown.
const RAW_REFUSAL_CHARS = 300

function refusal(body: string): string {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return body.slice(0, RAW_REFUSAL_CHARS)
  }
  const parsed = Refusal.safeParse(value)
  if (!parsed.success) return body.slice(0, RAW_REFUSAL_CHARS)
  return [parsed.data.message, parsed.data.errors?.[0]?.message].filter((part) => part !== undefined).join(': ')
}

// One call to GitHub's REST API, as `who`. A GET can carry the ETag of an
// earlier answer, and then a 304 comes back as null. The answer is parsed with the schema.
async function request<S extends z.ZodType>(
  schema: S, who: Who, method: string, path: string, options: { body?: unknown; etag?: string } = {},
): Promise<{ value: z.infer<S>; etag: string | null } | null> {
  const { api } = setup()
  const { token } = await tokenFor(who)
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
      'user-agent': 'agents-app', 'content-type': 'application/json',
      ...(options.etag ? { 'if-none-match': options.etag } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(forPublic(options.body)),
  })
  if (res.status === 304 && options.etag) return null
  const text = await res.text()
  if (!res.ok) throw new ForgeError(res.status, `GitHub ${method} ${path.replace(/\?.*$/, '')}: ${res.status} ${refusal(text)}`)
  return { value: schema.parse(text ? JSON.parse(text) : null), etag: res.headers.get('etag') }
}

async function call<S extends z.ZodType>(schema: S, who: Who, method: string, path: string, body?: unknown): Promise<z.infer<S>> {
  const answer = await request(schema, who, method, path, { body })
  // Only a request that sent an ETag gets null back, and this one sent none.
  if (!answer) throw new Error(`GitHub answered ${method} ${path} with not modified, unasked`)
  return answer.value
}

// The last ETag of each polled path. Asking again with it costs nothing against
// GitHub's rate limit when nothing changed, and the answer is then null.
const polled = new Map<string, string>()

async function changedSince<S extends z.ZodType>(schema: S, who: Who, path: string): Promise<z.infer<S> | null> {
  const answer = await request(schema, who, 'GET', path, { etag: polled.get(path) })
  if (!answer) return null
  if (answer.etag) polled.set(path, answer.etag)
  return answer.value
}

// What a person should read when a call to GitHub fails.
export function explainGithub(error: unknown): string {
  if (!(error instanceof ForgeError)) return `Could not reach GitHub: ${messageOf(error)}`
  if (error.status === 401) return 'GitHub refused the sign-in. Whoever it belongs to connects GitHub again on the Repos page.'
  if (error.status === 403 && /not accessible/i.test(error.message)) {
    return 'GitHub would not let this sign-in do that. Making a repo needs Repository creation, and work in it needs Contents, Issues and Pull requests.'
  }
  return error.message
}

// GitHub's answers, as much of them as the app reads.
const WireIssue = z.object({
  number: z.number().int(), title: z.string(),
  // GitHub sends null for an issue nobody wrote a description for.
  body: z.string().nullable().transform((body) => body ?? ''),
  html_url: z.string(), state: z.string(), user: z.object({ login: z.string() }).nullable(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])), created_at: z.string(),
  // Present only on the pull requests GitHub lists among issues.
  pull_request: z.object({}).optional(),
})
const WirePull = z.object({
  number: z.number().int(), title: z.string(), html_url: z.string(), state: z.string(),
  // The list of pull requests leaves out `merged`, and says merged_at instead.
  merged: z.boolean().optional(), merged_at: z.string().nullable(), head: z.object({ ref: z.string() }),
})
const WireRepo = z.object({ full_name: z.string(), default_branch: z.string() })
const WireBranch = z.object({ name: z.string() })
const WireRole = z.object({ role_name: z.string() })
// One event on a repo's issues. A label event names who put which label on which issue.
const WireEvent = z.object({
  event: z.string(), created_at: z.string(), actor: z.object({ login: z.string() }).nullable(),
  label: z.object({ name: z.string().nullable() }).optional(), issue: WireIssue.nullable().optional(),
})
const Ignored = z.unknown()

export type GithubIssue = Issue & { labels: string[]; createdAt: string; isPullRequest: boolean }
export type GithubRepo = z.infer<typeof WireRepo>
export type LabelEvent = { actor: string; label: string; createdAt: string; issue: GithubIssue }

// The roles that may ask the team's agents for work on a public repo. Triage
// can label issues but not change code, so it is not enough. A custom role's
// name says nothing of what it allows, so it never counts.
const WRITE_OR_MORE = new Set(['admin', 'maintain', 'write'])

const issueOf = (wire: z.infer<typeof WireIssue>): GithubIssue => ({
  number: wire.number, title: wire.title, body: wire.body, html_url: wire.html_url, state: wire.state,
  user: wire.user ?? undefined, labels: wire.labels.map((l) => (typeof l === 'string' ? l : l.name)),
  createdAt: wire.created_at, isPullRequest: wire.pull_request !== undefined,
})
const pullOf = (wire: z.infer<typeof WirePull>): PullRequest & { branch: string } => ({
  number: wire.number, html_url: wire.html_url, state: wire.state, merged: wire.merged ?? (wire.merged_at !== null), branch: wire.head.ref,
})
const openOf = (wire: z.infer<typeof WirePull>): OpenPullRequest => ({ number: wire.number, title: wire.title, url: wire.html_url, branch: wire.head.ref })

// GitHub's largest page. A team's open issues, pull requests, branches and a
// minute of label events fit in one.
const PAGE = 100
const refPath = (branch: string) => branch.split('/').map(encodeURIComponent).join('/')

// Each call takes the repo's owner/name path, as the Gitea forge's calls do, and
// acts with the token of whoever brought the repo into its project.
export const github: Forge & {
  newLabels(repo: string): Promise<LabelEvent[] | null>
  hasWriteAccess(repo: string, login: string): Promise<boolean>
  pullRequestIfChanged(repo: string, n: number): Promise<PullRequest | null>
  repo(who: Who, owner: string, name: string): Promise<GithubRepo | null>
  createRepo(who: Who, owner: string, name: string, description: string): Promise<GithubRepo>
} = {
  openIssues: async (repo) =>
    (await call(z.array(WireIssue), { repo }, 'GET', `/repos/${repo}/issues?state=open&per_page=${PAGE}`)).map(issueOf).filter((i) => !i.isPullRequest),
  // The labels people put on the repo's issues lately, oldest first, or null when
  // nothing changed since the last ask. Other events, and labels on pull
  // requests, are not asks for work.
  async newLabels(repo) {
    const events = await changedSince(z.array(WireEvent), { repo }, `/repos/${repo}/issues/events?per_page=${PAGE}`)
    if (!events) return null
    return events.flatMap((e) => (e.event === 'labeled' && e.actor && e.label?.name && e.issue && e.issue.pull_request === undefined
      ? [{ actor: e.actor.login, label: e.label.name, createdAt: e.created_at, issue: issueOf(e.issue) }] : []))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  },
  // Whether a person has write, maintain or admin access to the repo. Someone
  // GitHub doesn't know as a collaborator has none.
  async hasWriteAccess(repo, login) {
    try {
      return WRITE_OR_MORE.has((await call(WireRole, { repo }, 'GET', `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`)).role_name)
    } catch (error) {
      if (error instanceof ForgeError && error.status === 404) return false
      throw error
    }
  },
  issue: async (repo, n) => issueOf(await call(WireIssue, { repo }, 'GET', `/repos/${repo}/issues/${n}`)),
  comment: (repo, n, body) => call(Ignored, { repo }, 'POST', `/repos/${repo}/issues/${n}/comments`, { body }),
  closeIssue: (repo, n) => call(Ignored, { repo }, 'PATCH', `/repos/${repo}/issues/${n}`, { state: 'closed' }),
  // An open pull request for the branch, if one exists, so a retried stage never opens two.
  async openPullRequest(repo, head, base, title, body) {
    const owner = /^([^/]+)\/[^/]+$/.exec(repo)?.[1]
    if (!owner) throw new Error(`${repo} is not an owner/name path`)
    const open = await call(z.array(WirePull), { repo }, 'GET', `/repos/${repo}/pulls?state=open&per_page=${PAGE}&head=${encodeURIComponent(`${owner}:${head}`)}`)
    const existing = open.find((pr) => pr.head.ref === head)
    return pullOf(existing ?? await call(WirePull, { repo }, 'POST', `/repos/${repo}/pulls`, { head, base, title, body }))
  },
  pullRequest: async (repo, n) => pullOf(await call(WirePull, { repo }, 'GET', `/repos/${repo}/pulls/${n}`)),
  // A pull request's state, or null when it hasn't changed since the last ask.
  async pullRequestIfChanged(repo, n) {
    const wire = await changedSince(WirePull, { repo }, `/repos/${repo}/pulls/${n}`)
    return wire ? pullOf(wire) : null
  },
  // Merges, then deletes the branch, as this Mac's forge does. GitHub only
  // deletes merged branches itself when a repo's owner turned that on.
  async merge(repo, n) {
    const pr = pullOf(await call(WirePull, { repo }, 'GET', `/repos/${repo}/pulls/${n}`))
    if (!pr.merged) {
      await call(Ignored, { repo }, 'PUT', `/repos/${repo}/pulls/${n}/merge`, { merge_method: 'merge' })
      await call(Ignored, { repo }, 'DELETE', `/repos/${repo}/git/refs/heads/${refPath(pr.branch)}`).catch((error: unknown) => {
        // 404 and 422 mean the branch is already gone, deleted by a person or by the repo's own setting.
        if (!(error instanceof ForgeError && (error.status === 404 || error.status === 422))) throw error
      })
    }
    return pullOf(await call(WirePull, { repo }, 'GET', `/repos/${repo}/pulls/${n}`))
  },
  openPullRequests: async (repo) => (await call(z.array(WirePull), { repo }, 'GET', `/repos/${repo}/pulls?state=open&per_page=${PAGE}`)).map(openOf),
  branches: async (repo) => (await call(z.array(WireBranch), { repo }, 'GET', `/repos/${repo}/branches?per_page=${PAGE}`)).map((b) => b.name),

  // A repo, or null when it does not exist or `who` can't see it.
  async repo(who, owner, name) {
    try {
      return await call(WireRepo, who, 'GET', `/repos/${owner}/${name}`)
    } catch (error) {
      if (error instanceof ForgeError && error.status === 404) return null
      throw error
    }
  },
  // A new private repo. Its first commit is GitHub's README with the repo's name and description.
  async createRepo(who, owner, name, description) {
    const { login } = await tokenFor(who)
    const path = owner.toLowerCase() === login.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`
    return call(WireRepo, who, 'POST', path, { name, description, private: true, auto_init: true })
  },
}

// Where the git proxy sends a GitHub repo's git traffic, with the token of whoever
// brought the repo in as the password. The host comes from the settings, never
// from the stored URL, so the token only ever goes to GitHub.
export async function githubUpstream(remoteUrl: string): Promise<{ url: string; authorization: string }> {
  const path = repoPath(remoteUrl)
  const { token, login } = await tokenFor({ repo: path })
  return { url: `${setup().git}/${path}.git`, authorization: `Basic ${Buffer.from(`${login}:${token}`).toString('base64')}` }
}

// The URL a GitHub repo is registered with.
export const githubRemoteUrl = (fullName: string) => `${setup().git}/${fullName}.git`
