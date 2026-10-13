// The git forge: where repos, issues and pull requests live. It is a local Gitea
// (compose.yaml), set up by ops/forge-setup.ts, which writes ~/.agents-app/forge.json. The
// forge's tokens stay on the server. Machines reach repos through the API's git
// proxy with their own instance tokens.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

async function call<T>(method: string, path: string, body?: unknown, token = forgeConfig().token): Promise<T> {
  const res = await fetch(`${forgeConfig().url}/api/v1${path}`, {
    method,
    headers: { authorization: `token ${token}`, 'content-type': 'application/json', accept: 'application/json' },
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

export const forge = {
  openIssues: (repo: string) => call<Issue[]>('GET', `/repos/${repo}/issues?state=open&type=issues&limit=50`),
  issue: (repo: string, n: number) => call<Issue>('GET', `/repos/${repo}/issues/${n}`),
  comment: (repo: string, n: number, body: string) => call('POST', `/repos/${repo}/issues/${n}/comments`, { body }),
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
}
