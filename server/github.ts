// GitHub, the forge for project repos. It answers the same calls as this Mac's
// Gitea in server/forge.ts, so the runner and the pipelines work on either. The
// token lives only in the file AGENTS_GITHUB_FILE names, mode 600, and is read
// from there for each use. It never enters Postgres, a log, a command or a
// browser. Machines reach GitHub's git only through the API's git proxy, which
// adds the token. Every answer from GitHub is parsed before anything reads it.

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { ForgeError, repoPath, type Forge, type Issue, type PullRequest } from './forge.ts'
import { messageOf } from '../shared/errors.ts'
import { GithubOwner, GithubToken, type GithubStatus, type OpenPullRequest } from '../shared/projects.ts'

// Where GitHub is and where its token is kept, from the server's .env. The three
// are set together or not at all, and none has a default, so a process started
// without them, such as another check, never reaches GitHub or the real token.
const SETTINGS = ['AGENTS_GITHUB_FILE', 'AGENTS_GITHUB_API', 'AGENTS_GITHUB_GIT'] as const
const Settings = z.object({
  AGENTS_GITHUB_FILE: z.string().min(1),
  AGENTS_GITHUB_API: z.url().transform((url) => url.replace(/\/+$/, '')),
  AGENTS_GITHUB_GIT: z.url().transform((url) => url.replace(/\/+$/, '')),
})

type Setup = { on: true; file: string; api: string; git: string } | { on: false; missing: string[] }

function readSetup(): Setup {
  const missing = SETTINGS.filter((name) => !process.env[name])
  if (missing.length === SETTINGS.length) return { on: false, missing }
  if (missing.length) throw new Error(`GitHub's settings go together. Set ${missing.join(' and ')} as well, or none of them.`)
  const settings = Settings.parse(process.env)
  return { on: true, file: settings.AGENTS_GITHUB_FILE, api: settings.AGENTS_GITHUB_API, git: settings.AGENTS_GITHUB_GIT }
}

export const GITHUB = readSetup()

// The credential file, as saveGithub writes it.
const Credential = z.object({
  token: GithubToken, login: z.string(), owner: GithubOwner, ownerKind: z.enum(['org', 'user']), savedAt: z.string(),
})
type Credential = z.infer<typeof Credential>

export const NOT_CONNECTED = 'GitHub is not connected. An admin connects it on the Repos page.'
const notSetUp = (missing: string[]) => `GitHub is not set up on this server. Add ${missing.join(', ')} to its .env and restart the API.`

// The connection, or null when no admin has connected GitHub yet.
function credential(file: string): Credential | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    // No file means nobody has connected GitHub yet. Any other failure is real.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  return Credential.parse(JSON.parse(raw))
}

export function githubStatus(): GithubStatus {
  if (!GITHUB.on) return { state: 'off', missing: GITHUB.missing }
  const found = credential(GITHUB.file)
  if (!found) return { state: 'disconnected' }
  return { state: 'connected', login: found.login, owner: found.owner, ownerKind: found.ownerKind, savedAt: found.savedAt }
}

// The settings and the token, or a 503 that says what is missing.
function connection(): { api: string; git: string; credential: Credential } {
  if (!GITHUB.on) throw new ForgeError(503, notSetUp(GITHUB.missing))
  const found = credential(GITHUB.file)
  if (!found) throw new ForgeError(503, NOT_CONNECTED)
  return { api: GITHUB.api, git: GITHUB.git, credential: found }
}

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

// One call to GitHub's REST API with the saved token, or with a token being
// checked before it is saved. The answer is parsed with the schema.
async function call<S extends z.ZodType>(
  schema: S, method: string, path: string, body?: unknown, token = connection().credential.token,
): Promise<z.infer<S>> {
  if (!GITHUB.on) throw new ForgeError(503, notSetUp(GITHUB.missing))
  const res = await fetch(`${GITHUB.api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
      'user-agent': 'agents-app', 'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new ForgeError(res.status, `GitHub ${method} ${path.replace(/\?.*$/, '')}: ${res.status} ${refusal(text)}`)
  return schema.parse(text ? JSON.parse(text) : null)
}

// What a person should read when a call to GitHub fails.
export function explainGithub(error: unknown): string {
  if (!(error instanceof ForgeError)) return `Could not reach GitHub: ${messageOf(error)}`
  if (error.status === 401) return 'GitHub refused the token. An admin sets a new one on the Repos page.'
  if (error.status === 403 && /not accessible/i.test(error.message)) {
    return 'The GitHub token may not do this. It needs Administration, Contents, Issues and Pull requests, each read and write.'
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
const WireUser = z.object({ login: z.string() })
const WireBranch = z.object({ name: z.string() })
const Ignored = z.unknown()

export type GithubIssue = Issue & { labels: string[]; createdAt: string; isPullRequest: boolean }
export type GithubRepo = z.infer<typeof WireRepo>

const issueOf = (wire: z.infer<typeof WireIssue>): GithubIssue => ({
  number: wire.number, title: wire.title, body: wire.body, html_url: wire.html_url, state: wire.state,
  user: wire.user ?? undefined, labels: wire.labels.map((l) => (typeof l === 'string' ? l : l.name)),
  createdAt: wire.created_at, isPullRequest: wire.pull_request !== undefined,
})
const pullOf = (wire: z.infer<typeof WirePull>): PullRequest & { branch: string } => ({
  number: wire.number, html_url: wire.html_url, state: wire.state, merged: wire.merged ?? (wire.merged_at !== null), branch: wire.head.ref,
})
const openOf = (wire: z.infer<typeof WirePull>): OpenPullRequest => ({ number: wire.number, title: wire.title, url: wire.html_url, branch: wire.head.ref })

// GitHub's largest page. A team's open issues, pull requests and branches fit in one.
const PAGE = 100
const refPath = (branch: string) => branch.split('/').map(encodeURIComponent).join('/')

const issuesOf = async (repo: string, query: string) =>
  (await call(z.array(WireIssue), 'GET', `/repos/${repo}/issues?state=open&per_page=${PAGE}${query}`)).map(issueOf)

// Each call takes the repo's owner/name path, as the Gitea forge's calls do.
export const github: Forge & {
  issuesSince(repo: string, since: Date): Promise<GithubIssue[]>
  repo(owner: string, name: string): Promise<GithubRepo | null>
  createRepo(owner: string, name: string, description: string): Promise<GithubRepo>
} = {
  openIssues: async (repo) => (await issuesOf(repo, '')).filter((i) => !i.isPullRequest),
  // Open issues and pull requests changed since a time, oldest change first.
  issuesSince: (repo, since) => issuesOf(repo, `&sort=updated&direction=asc&since=${since.toISOString()}`),
  issue: async (repo, n) => issueOf(await call(WireIssue, 'GET', `/repos/${repo}/issues/${n}`)),
  comment: (repo, n, body) => call(Ignored, 'POST', `/repos/${repo}/issues/${n}/comments`, { body }),
  closeIssue: (repo, n) => call(Ignored, 'PATCH', `/repos/${repo}/issues/${n}`, { state: 'closed' }),
  // An open pull request for the branch, if one exists, so a retried stage never opens two.
  async openPullRequest(repo, head, base, title, body) {
    const owner = /^([^/]+)\/[^/]+$/.exec(repo)?.[1]
    if (!owner) throw new Error(`${repo} is not an owner/name path`)
    const open = await call(z.array(WirePull), 'GET', `/repos/${repo}/pulls?state=open&per_page=${PAGE}&head=${encodeURIComponent(`${owner}:${head}`)}`)
    const existing = open.find((pr) => pr.head.ref === head)
    return pullOf(existing ?? await call(WirePull, 'POST', `/repos/${repo}/pulls`, { head, base, title, body }))
  },
  pullRequest: async (repo, n) => pullOf(await call(WirePull, 'GET', `/repos/${repo}/pulls/${n}`)),
  // Merges, then deletes the branch, as this Mac's forge does. GitHub only
  // deletes merged branches itself when a repo's owner turned that on.
  async merge(repo, n) {
    const pr = pullOf(await call(WirePull, 'GET', `/repos/${repo}/pulls/${n}`))
    if (!pr.merged) {
      await call(Ignored, 'PUT', `/repos/${repo}/pulls/${n}/merge`, { merge_method: 'merge' })
      await call(Ignored, 'DELETE', `/repos/${repo}/git/refs/heads/${refPath(pr.branch)}`).catch((error: unknown) => {
        // 404 and 422 mean the branch is already gone, deleted by a person or by the repo's own setting.
        if (!(error instanceof ForgeError && (error.status === 404 || error.status === 422))) throw error
      })
    }
    return pullOf(await call(WirePull, 'GET', `/repos/${repo}/pulls/${n}`))
  },
  openPullRequests: async (repo) => (await call(z.array(WirePull), 'GET', `/repos/${repo}/pulls?state=open&per_page=${PAGE}`)).map(openOf),
  branches: async (repo) => (await call(z.array(WireBranch), 'GET', `/repos/${repo}/branches?per_page=${PAGE}`)).map((b) => b.name),

  // A repo, or null when it does not exist or the token can't see it.
  async repo(owner, name) {
    try {
      return await call(WireRepo, 'GET', `/repos/${owner}/${name}`)
    } catch (error) {
      if (error instanceof ForgeError && error.status === 404) return null
      throw error
    }
  },
  // A new private repo. Its first commit is GitHub's README with the repo's name and description.
  async createRepo(owner, name, description) {
    const { credential: found } = connection()
    const path = owner.toLowerCase() === found.login.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`
    return call(WireRepo, 'POST', path, { name, description, private: true, auto_init: true })
  },
}

// Where the git proxy sends a GitHub repo's git traffic, with the token as the
// password. The host comes from the settings, never from the stored URL, so the
// token only ever goes to GitHub.
export function githubUpstream(remoteUrl: string): { url: string; authorization: string } {
  const { git, credential: found } = connection()
  return {
    url: `${git}/${repoPath(remoteUrl)}.git`,
    authorization: `Basic ${Buffer.from(`${found.login}:${found.token}`).toString('base64')}`,
  }
}

// The URL a GitHub repo is registered with.
export function githubRemoteUrl(fullName: string): string {
  return `${connection().git}/${fullName}.git`
}

// The organization or account that new repos go under. Throws a 503 that says
// what is missing when GitHub is off or not connected.
export function connectedOwner(): string {
  return connection().credential.owner
}

// Checks a token with GitHub, by asking whose it is and then for the
// organization, and saves it. Throws, with a reason a person can act on, when
// GitHub refuses.
export async function connectGithub(token: string, owner: string): Promise<GithubStatus> {
  if (!GITHUB.on) throw new Error(notSetUp(GITHUB.missing))
  const parsedToken = GithubToken.parse(token)
  const parsedOwner = GithubOwner.parse(owner)
  const user = await call(WireUser, 'GET', '/user', undefined, parsedToken).catch((error: unknown) => {
    throw new Error(error instanceof ForgeError && error.status === 401 ? 'GitHub refused the token.' : explainGithub(error))
  })
  const ownerKind = parsedOwner.toLowerCase() === user.login.toLowerCase() ? 'user' : 'org'
  if (ownerKind === 'org') {
    await call(Ignored, 'GET', `/orgs/${parsedOwner}`, undefined, parsedToken).catch((error: unknown) => {
      throw new Error(error instanceof ForgeError && error.status === 404
        ? `The token belongs to ${user.login}, and can't see an organization named ${parsedOwner}.`
        : explainGithub(error))
    })
  }
  saveCredential(GITHUB.file, { token: parsedToken, login: user.login, owner: parsedOwner, ownerKind, savedAt: new Date().toISOString() })
  return githubStatus()
}

// Written beside the file and renamed over it, so a reader never sees half of it.
function saveCredential(file: string, value: Credential) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(temp, file)
}
