// The git forge: where repos, issues and pull requests live. It is a local Gitea
// (compose.yaml), set up by ops/forge-setup.ts, which writes ~/.agents-app/forge.json. The
// forge's tokens stay on the server. Machines reach repos through the API's git
// proxy with their own instance tokens.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { OpenPullRequest } from '../shared/projects.ts'

export type ForgeConfig = {
  // Where the API reaches the forge, and the address the forge reaches the API's machine port at.
  url: string
  hookUrl: string
  org: string
  // The factory user's token: what pipelines act as. The admin token sets up repos.
  token: string
  adminToken: string
  webhookSecret: string
}

export const FORGE_FILE = process.env.AGENTS_FORGE_FILE ?? join(homedir(), '.agents-app', 'forge.json')

let cached: ForgeConfig | null = null
export function forgeConfig(): ForgeConfig {
  cached ??= JSON.parse(readFileSync(FORGE_FILE, 'utf8')) as ForgeConfig
  return cached
}

export class ForgeError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// `sudo` acts as that forge user, which only the admin token may do.
async function call<T>(method: string, path: string, body?: unknown, token = forgeConfig().token, sudo?: string): Promise<T> {
  const res = await fetch(`${forgeConfig().url}/api/v1${path}`, {
    method,
    headers: {
      authorization: `token ${token}`, 'content-type': 'application/json', accept: 'application/json', ...(sudo ? { sudo } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new ForgeError(res.status, `${method} ${path}: ${res.status} ${text.slice(0, 300)}`)
  return (text ? JSON.parse(text) : null) as T
}

// owner/name from a clone URL such as http://127.0.0.1:3001/team/shop.git
export function repoPath(remoteUrl: string): string {
  const match = new URL(remoteUrl).pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  if (!match) throw new Error(`not a forge repo URL: ${remoteUrl}`)
  return `${match[1]}/${match[2]}`
}

// The forge address of a repo's git endpoint, with the factory's credentials.
export function gitUpstream(remoteUrl: string): { url: string; authorization: string } {
  const config = forgeConfig()
  return {
    url: `${config.url}/${repoPath(remoteUrl)}.git`,
    authorization: `Basic ${Buffer.from(`factory:${config.token}`).toString('base64')}`,
  }
}

// Gitea signs each delivery with HMAC-SHA256 of the body, hex encoded.
export function verifySignature(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'))
  const given = Buffer.from(signature.replace(/^sha256=/, ''))
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export type Issue = { number: number; title: string; body: string; html_url: string; state: string; user?: { login: string } }
export type PullRequest = { number: number; html_url: string; state: string; merged: boolean }

// What the runner and the app ask of a forge, this Mac's Gitea or GitHub in
// server/github.ts. Each call takes the repo's owner/name path.
export type Forge = {
  openIssues(repo: string): Promise<Issue[]>
  issue(repo: string, n: number): Promise<Issue>
  comment(repo: string, n: number, body: string): Promise<unknown>
  closeIssue(repo: string, n: number): Promise<unknown>
  openPullRequest(repo: string, head: string, base: string, title: string, body: string): Promise<PullRequest>
  pullRequest(repo: string, n: number): Promise<PullRequest>
  merge(repo: string, n: number): Promise<PullRequest>
  openPullRequests(repo: string): Promise<OpenPullRequest[]>
  branches(repo: string): Promise<string[]>
  // The branch the forge says is the repo's default now.
  defaultBranch(repo: string): Promise<string>
}

// What the coding framework reads of a pull request, parsed from the forge's answer.
const PULL = z.object({
  number: z.number().int(),
  html_url: z.string(),
  merged: z.boolean(),
  mergeable: z.boolean(),
  merge_commit_sha: z.string().nullable(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  body: z.string().nullable(),
})
export type Pull = z.infer<typeof PULL>
const REVIEWS = z.array(z.object({ state: z.string(), commit_id: z.string(), user: z.object({ login: z.string() }).nullable() }))
export type CommitState = 'pending' | 'success' | 'failure' | 'error'
// The forge checks a pull request again after each push or review, and refuses
// to merge until it has. A check takes milliseconds; this bounds the wait.
const MERGEABLE_WAIT_MS = 30_000
const MERGEABLE_POLL_MS = 250

async function parsed<T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown, token?: string, sudo?: string): Promise<T> {
  return schema.parse(await call<unknown>(method, path, body, token, sudo))
}

// Gitea's answers to the calls added for projects, as much as the app reads.
const GiteaPull = z.object({ number: z.number().int(), title: z.string(), html_url: z.string(), head: z.object({ ref: z.string() }) })
const GiteaBranch = z.object({ name: z.string() })
const GiteaRepo = z.object({ default_branch: z.string() })
// Gitea's largest page by default, its MAX_RESPONSE_ITEMS setting. A repo's open
// pull requests and branches fit in one.
const GITEA_PAGE = 50

export const forge = {
  openIssues: (repo: string) => call<Issue[]>('GET', `/repos/${repo}/issues?state=open&type=issues&limit=50`),
  issue: (repo: string, n: number) => call<Issue>('GET', `/repos/${repo}/issues/${n}`),
  comment: (repo: string, n: number, body: string) => call('POST', `/repos/${repo}/issues/${n}/comments`, { body }),
  comments: (repo: string, n: number) => call<unknown>('GET', `/repos/${repo}/issues/${n}/comments?limit=50`),
  closeIssue: (repo: string, n: number) => call('PATCH', `/repos/${repo}/issues/${n}`, { state: 'closed' }),
  // An open pull request for the branch, if one exists, so a retried stage never opens two.
  async openPullRequest(repo: string, head: string, base: string, title: string, body: string): Promise<PullRequest> {
    const open = await call<(PullRequest & { head: { ref: string } })[]>('GET', `/repos/${repo}/pulls?state=open&limit=50`)
    const existing = open.find((pr) => pr.head.ref === head)
    if (existing) return existing
    return call<PullRequest>('POST', `/repos/${repo}/pulls`, { head, base, title, body })
  },
  pullRequest: (repo: string, n: number) => call<PullRequest>('GET', `/repos/${repo}/pulls/${n}`),
  async merge(repo: string, n: number): Promise<PullRequest> {
    const pr = await call<PullRequest>('GET', `/repos/${repo}/pulls/${n}`)
    if (!pr.merged) await call('POST', `/repos/${repo}/pulls/${n}/merge`, { Do: 'merge', delete_branch_after_merge: true })
    return call<PullRequest>('GET', `/repos/${repo}/pulls/${n}`)
  },
  async openPullRequests(repo: string): Promise<OpenPullRequest[]> {
    const open = z.array(GiteaPull).parse(await call<unknown>('GET', `/repos/${repo}/pulls?state=open&limit=${GITEA_PAGE}`))
    return open.map((pr) => ({ number: pr.number, title: pr.title, url: pr.html_url, branch: pr.head.ref }))
  },
  branches: async (repo: string) =>
    z.array(GiteaBranch).parse(await call<unknown>('GET', `/repos/${repo}/branches?limit=${GITEA_PAGE}`)).map((b) => b.name),
  defaultBranch: async (repo: string) => GiteaRepo.parse(await call<unknown>('GET', `/repos/${repo}`)).default_branch,
  // The files in a folder on a branch, each with git's blob id for its content.
  async files(repo: string, dir: string, ref: string): Promise<{ path: string; sha: string; content: string }[]> {
    const entries = await call<{ type: string; path: string; sha: string }[]>('GET', `/repos/${repo}/contents/${dir}?ref=${ref}`)
      .catch((error: unknown) => {
        if (error instanceof ForgeError && error.status === 404) return []
        throw error
      })
    return Promise.all(entries.filter((e) => e.type === 'file').map(async (e) => {
      const file = await call<{ content: string; sha: string }>('GET', `/repos/${repo}/contents/${e.path}?ref=${ref}`)
      return { path: e.path, sha: file.sha, content: Buffer.from(file.content, 'base64').toString('utf8') }
    }))
  },
  // Commits new content for one file onto a new branch, for a proposed change.
  async proposeFile(repo: string, path: string, content: string, oldSha: string, base: string, branch: string, message: string) {
    return call('PUT', `/repos/${repo}/contents/${path}`, {
      content: Buffer.from(content).toString('base64'), sha: oldSha, branch: base, new_branch: branch, message,
    })
  },

  pull: (repo: string, n: number) => parsed(PULL, 'GET', `/repos/${repo}/pulls/${n}`),
  // Replaces a pull request's description, as the runner's evidence changes.
  describe: (repo: string, n: number, body: string) => call('PATCH', `/repos/${repo}/pulls/${n}`, { body }),

  // A gate's result on a commit, which the forge's branch protection can require.
  setStatus: (repo: string, sha: string, context: string, state: CommitState, description: string) =>
    call('POST', `/repos/${repo}/statuses/${sha}`, { context, state, description: description.slice(0, 140) }),

  // Approves a pull request as a person's own forge user, once per head commit.
  async approveAs(repo: string, n: number, login: string, head: string, body: string) {
    const reviews = await parsed(REVIEWS, 'GET', `/repos/${repo}/pulls/${n}/reviews`)
    if (reviews.some((r) => r.state === 'APPROVED' && r.commit_id === head && r.user?.login === login)) return
    await call('POST', `/repos/${repo}/pulls/${n}/reviews`, { event: 'APPROVED', body, commit_id: head }, forgeConfig().adminToken, login)
  },

  // Merges a pull request only if its head is still `head`. `owner` merges as
  // that forge user, and `force` passes protected file patterns, which only an
  // owner with admin rights on the repo may do.
  async mergeAt(repo: string, n: number, head: string, owner: { login: string; force: boolean } | null): Promise<Pull> {
    const deadline = Date.now() + MERGEABLE_WAIT_MS
    let pull = await forge.pull(repo, n)
    while (!pull.merged && !pull.mergeable && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, MERGEABLE_POLL_MS))
      pull = await forge.pull(repo, n)
    }
    if (!pull.merged) {
      const body = { Do: 'merge', head_commit_id: head, delete_branch_after_merge: true, ...(owner?.force ? { force_merge: true } : {}) }
      if (owner) await call('POST', `/repos/${repo}/pulls/${n}/merge`, body, forgeConfig().adminToken, owner.login)
      else await call('POST', `/repos/${repo}/pulls/${n}/merge`, body)
    }
    return forge.pull(repo, n)
  },
}

// Setting up repos: used by ops/forge-setup.ts and by the checks.
export const forgeAdmin = {
  call: <T>(method: string, path: string, body?: unknown) => call<T>(method, path, body, forgeConfig().adminToken),

  // Creates the repo in the org if it is missing, with the given files as its first
  // commit, the factory as a writer, main protected, and a webhook to the API.
  // `hook` false leaves the webhook out, and a URL sends it to that API instead,
  // such as a check's own.
  async ensureRepo(name: string, files: Record<string, string>, description = '', hook: boolean | string = true): Promise<string> {
    const { org, webhookSecret } = forgeConfig()
    const hookUrl = typeof hook === 'string' ? hook : forgeConfig().hookUrl
    const repo = `${org}/${name}`
    const exists = await this.call('GET', `/repos/${repo}`).then(() => true, (error: unknown) => {
      if (error instanceof ForgeError && error.status === 404) return false
      throw error
    })
    if (!exists) {
      await this.call('POST', `/orgs/${org}/repos`, { name, description, default_branch: 'main', private: true })
      await this.call('POST', `/repos/${repo}/contents`, {
        branch: 'main', message: 'First commit',
        files: Object.entries(files).map(([path, content]) => ({ operation: 'create', path, content: Buffer.from(content).toString('base64') })),
      })
    }
    await this.call('PUT', `/repos/${repo}/collaborators/factory`, { permission: 'write' })
    const protections = await this.call<{ rule_name: string }[]>('GET', `/repos/${repo}/branch_protections`)
    if (!protections.some((p) => p.rule_name === 'main')) {
      await this.call('POST', `/repos/${repo}/branch_protections`, { rule_name: 'main', enable_push: false })
    }
    const hooks = await this.call<{ config: { url: string } }[]>('GET', `/repos/${repo}/hooks`)
    if (hook && !hooks.some((h) => h.config.url === hookUrl)) {
      await this.call('POST', `/repos/${repo}/hooks`, {
        type: 'gitea', active: true, events: ['issues', 'push', 'pull_request'],
        config: { url: hookUrl, content_type: 'json', secret: webhookSecret },
      })
    }
    return repo
  },

  // Branch protection for a repo with a policy. Nobody pushes to the branch.
  // Merging needs every gate's status and an approval from the owner, whose
  // approval goes stale with a new push, and a pull request touching a
  // protected file merges only when the owner forces it.
  async protect(repo: string, branch: string, rules: { owner: string; contexts: readonly string[]; protectedFiles: readonly string[] }) {
    await this.call('PUT', `/repos/${repo}/collaborators/${rules.owner}`, { permission: 'admin' })
    const settings = {
      enable_push: false, enable_force_push: false,
      enable_merge_whitelist: true, merge_whitelist_usernames: ['factory', rules.owner],
      required_approvals: 1, enable_approvals_whitelist: true, approvals_whitelist_username: [rules.owner],
      dismiss_stale_approvals: true, block_on_rejected_reviews: true,
      enable_status_check: true, status_check_contexts: rules.contexts,
      protected_file_patterns: rules.protectedFiles.join(';'), block_admin_merge_override: false,
    }
    const existing = await this.call<{ rule_name: string }[]>('GET', `/repos/${repo}/branch_protections`)
    if (existing.some((p) => p.rule_name === branch)) await this.call('PATCH', `/repos/${repo}/branch_protections/${branch}`, settings)
    else await this.call('POST', `/repos/${repo}/branch_protections`, { rule_name: branch, ...settings })
  },
}
