// GitHub, the forge for project repos. It answers the same calls as this Mac's
// Gitea in server/forge.ts, so the runner and the pipelines work on either. The
// token lives only in ~/.agents-app/github.json, mode 600, and is read from there
// for each use. It never enters Postgres, a log, a command or a browser. Machines
// reach GitHub's git only through the API's git proxy, which adds the token.

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ForgeError, repoPath, type Issue, type OpenPullRequest, type PullRequest } from './forge.ts'
import { messageOf } from '../shared/errors.ts'

export const GITHUB_FILE = process.env.AGENTS_GITHUB_FILE ?? join(homedir(), '.agents-app', 'github.json')
// Where GitHub's REST API and its git live. The checks point both at a fake.
export const GITHUB_API = (process.env.AGENTS_GITHUB_API ?? 'https://api.github.com').replace(/\/+$/, '')
export const GITHUB_GIT = (process.env.AGENTS_GITHUB_GIT ?? 'https://github.com').replace(/\/+$/, '')

export type GithubConfig = { token: string; login: string; owner: string; ownerKind: 'org' | 'user'; savedAt: string }
// What anyone on the team may know about the connection. Never the token.
export type GithubStatus =
  | { connected: false }
  | { connected: true; login: string; owner: string; ownerKind: 'org' | 'user'; savedAt: string }

export const NOT_CONNECTED = 'GitHub is not connected. An admin connects it on the Repos page.'

type Loose = Record<string, unknown>
const isObject = (value: unknown): value is Loose => typeof value === 'object' && value !== null && !Array.isArray(value)
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

function textOf(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`GitHub sent no ${what}`)
  return value
}

function numberOf(value: unknown, what: string): number {
  if (typeof value !== 'number') throw new Error(`GitHub sent no ${what}`)
  return value
}

// The connection, or null when no admin has connected GitHub. The file is the
// API's own output, but it is checked like anything read from disk.
export function githubConfig(): GithubConfig | null {
  let raw: string
  try {
    raw = readFileSync(GITHUB_FILE, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null
    throw error
  }
  const value: unknown = JSON.parse(raw)
  if (!isObject(value)) throw new Error(`${GITHUB_FILE} is not a GitHub connection`)
  const ownerKind = value.ownerKind === 'org' || value.ownerKind === 'user' ? value.ownerKind : null
  if (!ownerKind) throw new Error(`${GITHUB_FILE} says neither org nor user`)
  return {
    token: textOf(value.token, 'token in the file'), login: textOf(value.login, 'login in the file'),
    owner: textOf(value.owner, 'owner in the file'), ownerKind, savedAt: textOf(value.savedAt, 'time in the file'),
  }
}

export function githubStatus(): GithubStatus {
  const config = githubConfig()
  if (!config) return { connected: false }
  const { token, ...known } = config
  return { connected: true, ...known }
}

function requireGithub(): GithubConfig {
  const config = githubConfig()
  if (!config) throw new ForgeError(503, NOT_CONNECTED)
  return config
}

// GitHub's own words for a refusal: its message and the first detail it gives.
function refusal(body: string): string {
  try {
    const value: unknown = JSON.parse(body)
    if (!isObject(value)) return body.slice(0, 300)
    const first = listOf(value.errors)[0]
    const detail = isObject(first) && typeof first.message === 'string' ? first.message : ''
    return [typeof value.message === 'string' ? value.message : '', detail].filter(Boolean).join(': ')
  } catch {
    return body.slice(0, 300)
  }
}

async function call(method: string, path: string, body?: unknown, token = requireGithub().token): Promise<unknown> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
      'user-agent': 'agents-app', 'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new ForgeError(res.status, `GitHub ${method} ${path.split('?')[0] ?? path}: ${res.status} ${refusal(text)}`)
  return text ? JSON.parse(text) as unknown : null
}

// What a person should read when a call to GitHub fails.
export function explainGithub(error: unknown): string {
  if (!(error instanceof ForgeError)) return `Could not reach GitHub: ${messageOf(error)}`
  if (error.status === 503) return error.message
  if (error.status === 401) return 'GitHub refused the token. An admin sets a new one on the Repos page.'
  if (error.status === 403 && /not accessible/i.test(error.message)) {
    return 'The GitHub token may not do this. It needs Administration, Contents, Issues and Pull requests, each read and write.'
  }
  return error.message
}

export type GithubIssue = Issue & { labels: string[]; createdAt: string; pullRequest: boolean }
export type GithubRepo = { fullName: string; defaultBranch: string }
type GithubPull = PullRequest & { branch: string; title: string }

function issueOf(value: unknown): GithubIssue {
  if (!isObject(value)) throw new Error('GitHub sent no issue')
  const labels = Array.isArray(value.labels)
    ? value.labels.flatMap((l) => (typeof l === 'string' ? [l] : isObject(l) && typeof l.name === 'string' ? [l.name] : []))
    : []
  return {
    number: numberOf(value.number, 'issue number'), title: textOf(value.title, 'issue title'),
    body: typeof value.body === 'string' ? value.body : '', html_url: textOf(value.html_url, 'issue link'),
    state: textOf(value.state, 'issue state'), user: isObject(value.user) && typeof value.user.login === 'string' ? { login: value.user.login } : undefined,
    labels, createdAt: textOf(value.created_at, 'issue time'), pullRequest: value.pull_request !== undefined,
  }
}

function pullOf(value: unknown): GithubPull {
  if (!isObject(value) || !isObject(value.head)) throw new Error('GitHub sent no pull request')
  return {
    number: numberOf(value.number, 'pull request number'), html_url: textOf(value.html_url, 'pull request link'),
    state: textOf(value.state, 'pull request state'), merged: value.merged === true || typeof value.merged_at === 'string',
    branch: textOf(value.head.ref, 'pull request branch'), title: textOf(value.title, 'pull request title'),
  }
}

function repoOf(value: unknown): GithubRepo {
  if (!isObject(value)) throw new Error('GitHub sent no repo')
  return { fullName: textOf(value.full_name, 'repo name'), defaultBranch: textOf(value.default_branch, 'default branch') }
}

const refPath = (branch: string) => branch.split('/').map(encodeURIComponent).join('/')

async function issuesOf(repo: string, query: string): Promise<GithubIssue[]> {
  return listOf(await call('GET', `/repos/${repo}/issues?state=open&per_page=100${query}`)).map(issueOf)
}

// Each call takes the repo's owner/name path, as the Gitea forge's do. Lists
// read one page of 100, plenty for a team's open issues and pull requests.
export const github = {
  openIssues: async (repo: string): Promise<Issue[]> => (await issuesOf(repo, '')).filter((i) => !i.pullRequest),
  // Open issues and pull requests changed since a time, oldest change first.
  issuesSince: (repo: string, since: Date) => issuesOf(repo, `&sort=updated&direction=asc&since=${since.toISOString()}`),
  issue: async (repo: string, n: number): Promise<Issue> => issueOf(await call('GET', `/repos/${repo}/issues/${n}`)),
  comment: (repo: string, n: number, body: string) => call('POST', `/repos/${repo}/issues/${n}/comments`, { body }),
  closeIssue: (repo: string, n: number) => call('PATCH', `/repos/${repo}/issues/${n}`, { state: 'closed' }),
  // An open pull request for the branch, if one exists, so a retried stage never opens two.
  async openPullRequest(repo: string, head: string, base: string, title: string, body: string): Promise<PullRequest> {
    const owner = repo.split('/')[0] ?? ''
    const open = listOf(await call('GET', `/repos/${repo}/pulls?state=open&per_page=100&head=${encodeURIComponent(`${owner}:${head}`)}`)).map(pullOf)
    const existing = open.find((pr) => pr.branch === head)
    if (existing) return existing
    return pullOf(await call('POST', `/repos/${repo}/pulls`, { head, base, title, body }))
  },
  pullRequest: async (repo: string, n: number): Promise<PullRequest> => pullOf(await call('GET', `/repos/${repo}/pulls/${n}`)),
  // Merges, then deletes the branch, as this Mac's forge does. GitHub only
  // deletes merged branches itself when a repo's owner turned that on.
  async merge(repo: string, n: number): Promise<PullRequest> {
    const pr = pullOf(await call('GET', `/repos/${repo}/pulls/${n}`))
    if (!pr.merged) {
      await call('PUT', `/repos/${repo}/pulls/${n}/merge`, { merge_method: 'merge' })
      await call('DELETE', `/repos/${repo}/git/refs/heads/${refPath(pr.branch)}`).catch((error: unknown) => {
        // Already gone: someone deleted the branch, or the repo deletes merged branches itself.
        if (!(error instanceof ForgeError && (error.status === 404 || error.status === 422))) throw error
      })
    }
    return pullOf(await call('GET', `/repos/${repo}/pulls/${n}`))
  },
  openPullRequests: async (repo: string): Promise<OpenPullRequest[]> =>
    listOf(await call('GET', `/repos/${repo}/pulls?state=open&per_page=100`)).map(pullOf)
      .map((pr) => ({ number: pr.number, title: pr.title, url: pr.html_url, branch: pr.branch })),
  branches: async (repo: string): Promise<string[]> =>
    listOf(await call('GET', `/repos/${repo}/branches?per_page=100`)).map((b) => textOf(isObject(b) ? b.name : undefined, 'branch name')),

  // A repo, or null when it does not exist or the token can't see it.
  async repo(owner: string, name: string): Promise<GithubRepo | null> {
    try {
      return repoOf(await call('GET', `/repos/${owner}/${name}`))
    } catch (error) {
      if (error instanceof ForgeError && error.status === 404) return null
      throw error
    }
  },
  // A new private repo whose first commit is GitHub's README with its name and description.
  async createRepo(owner: string, name: string, description: string): Promise<GithubRepo> {
    const config = requireGithub()
    const path = owner.toLowerCase() === config.login.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`
    return repoOf(await call('POST', path, { name, description, private: true, auto_init: true }))
  },
}

// A repo URL is GitHub's when it starts with GitHub's address.
export const isGithubUrl = (remoteUrl: string) => remoteUrl.startsWith(`${GITHUB_GIT}/`)

// Where the git proxy sends a GitHub repo's git traffic, with the token as the
// password. The host comes from the settings, never from the stored URL, so the
// token only ever goes to GitHub.
export function githubUpstream(remoteUrl: string): { url: string; authorization: string } {
  const config = requireGithub()
  return {
    url: `${GITHUB_GIT}/${repoPath(remoteUrl)}.git`,
    authorization: `Basic ${Buffer.from(`${config.login}:${config.token}`).toString('base64')}`,
  }
}

const TOKEN = /^[A-Za-z0-9_]{20,255}$/
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

// Checks a token with GitHub, by asking whose it is and then for the
// organization, and saves it. Throws, with a reason a person can act on, when
// GitHub refuses.
export async function connectGithub(token: string, owner: string): Promise<GithubStatus> {
  if (!TOKEN.test(token)) throw new Error('That does not look like a GitHub token.')
  if (!OWNER.test(owner)) throw new Error('An organization or account name is letters, digits and dashes.')
  let login: string
  try {
    const user = await call('GET', '/user', undefined, token)
    login = textOf(isObject(user) ? user.login : undefined, 'account for the token')
  } catch (error) {
    throw new Error(error instanceof ForgeError && error.status === 401 ? 'GitHub refused the token.' : explainGithub(error))
  }
  const ownerKind = owner.toLowerCase() === login.toLowerCase() ? 'user' : 'org'
  if (ownerKind === 'org') {
    await call('GET', `/orgs/${owner}`, undefined, token).catch((error: unknown) => {
      throw new Error(error instanceof ForgeError && error.status === 404
        ? `The token belongs to ${login}, and can't see an organization named ${owner}.`
        : explainGithub(error))
    })
  }
  saveGithub({ token, login, owner, ownerKind, savedAt: new Date().toISOString() })
  return githubStatus()
}

// Written beside the file and renamed over it, so a reader never sees half of it.
function saveGithub(config: GithubConfig) {
  mkdirSync(dirname(GITHUB_FILE), { recursive: true, mode: 0o700 })
  const temp = `${GITHUB_FILE}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 })
  renameSync(temp, GITHUB_FILE)
}
