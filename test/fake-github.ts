// A fake GitHub for the checks. It answers the parts of GitHub's REST API that
// server/github.ts calls, signs people in with GitHub's device flow, and serves
// git over HTTP with `git http-backend` from bare repos in a folder of its own.
// Every request must carry a token it issued, and it logs whose each was, so a
// check can see where each token went. A check imports it and runs it in its
// own process.

import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { z } from 'zod'

type Issue = {
  number: number; title: string; body: string | null; state: 'open' | 'closed'; labels: string[]; comments: string[]
  created_at: string; updated_at: string; author: string
}
type Pull = { number: number; title: string; body: string; head: string; base: string; state: 'open' | 'closed'; merged: boolean; merged_at: string | null }
type LabelEvent = { event: 'labeled' | 'unlabeled'; actor: string; label: string; issue: number; created_at: string }
type Repo = { owner: string; name: string; description: string; defaultBranch: string; issues: Issue[]; pulls: Pull[]; events: LabelEvent[]; next: number; createdBy: string }
type Grant = { login: string; expiresAt: number | null }
type DeviceCode = { userCode: string; approvedAs: string | null; denied: boolean }

// `login` is whose token the request carried, when it carried a good one.
export type Seen = { method: string; path: string; auth: 'token' | 'none' | 'wrong' | 'expired'; login: string | null; status: number }

export type FakeGithub = {
  url: string
  seen: Seen[]
  // Each person's role on every repo, as GitHub's collaborator permission call names it. Anyone else reads only.
  // Whoever made a repo is its admin.
  roles: Map<string, string>
  // While set, creating a repo is refused as GitHub refuses a token without the permission for it.
  refuseCreate: boolean
  // People whose role GitHub fails to answer for, once each, with a 500.
  failRoleOnce: Set<string>
  // Accepts another token, as a personal access token of the account.
  grantToken(token: string, login: string): void
  // Holds GitHub's answer to making the named repo until it is released, as a GitHub that hangs would.
  hold(name: string): void
  held(name: string): boolean
  release(name: string): void
  // Every token issued, which a check looks for where none may be.
  issued(): string[]
  // How many times a refresh token bought a new token.
  refreshes(): number
  // A person enters the code at GitHub's device page and approves, or cancels.
  approve(userCode: string, login: string): void
  deny(userCode: string): void
  repoExists(fullName: string): boolean
  // Who made a repo, by the token they made it with.
  createdBy(fullName: string): string | undefined
  // How many times a POST made each repo.
  created: Map<string, number>
  git(fullName: string, ...args: string[]): string
  // Opens an issue as its author would, outside the app. Labels it opens with are
  // put on by the author, as an issue form does.
  openIssue(fullName: string, title: string, body: string, labels: string[], author: string): Issue
  // Someone puts a label on an issue, or takes it off.
  label(fullName: string, n: number, label: string, actor: string): void
  unlabel(fullName: string, n: number, label: string, actor: string): void
  // Someone closes an issue on GitHub.
  close(fullName: string, n: number): void
  // A repo's owner makes another branch its default, starting from the old default's head.
  setDefaultBranch(fullName: string, branch: string): void
  issue(fullName: string, n: number): Issue | undefined
  pull(fullName: string, n: number): Pull | undefined
  pulls(fullName: string): Pull[]
  // Merges a pull request on GitHub, as a person would there.
  mergeOnGithub(fullName: string, n: number): void
  stop(): Promise<void>
}

const CreateRepo = z.object({ name: z.string(), description: z.string().default(''), private: z.boolean().default(false), auto_init: z.boolean().default(false) })
const NewIssue = z.object({ title: z.string(), body: z.string().default(''), labels: z.array(z.string()).default([]) })
const NewPull = z.object({ head: z.string(), base: z.string(), title: z.string(), body: z.string().default('') })
const Comment = z.object({ body: z.string() })
const IssueChange = z.object({ state: z.enum(['open', 'closed']) })
const DeviceAsk = z.object({ client_id: z.string() })
const TokenAsk = z.union([
  z.object({ client_id: z.string(), grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code'), device_code: z.string() }),
  z.object({ client_id: z.string(), grant_type: z.literal('refresh_token'), refresh_token: z.string() }),
])

// User tokens last this long, in seconds. Just over the server's five minutes of
// early renewal, so the server renews them again and again while a check runs.
const USER_TOKEN_SECONDS = 301
const REFRESH_TOKEN_SECONDS = 15_897_600

export async function startFakeGithub(options: {
  port: number; dir: string; org: string; clientId: string
  // A personal access token the fake accepts, as the stopgap's.
  stopgap: { token: string; login: string }
}): Promise<FakeGithub> {
  const { port, dir, org, clientId } = options
  const url = `http://127.0.0.1:${port}`
  const repos = new Map<string, Repo>()
  const grants = new Map<string, Grant>([[options.stopgap.token, { login: options.stopgap.login, expiresAt: null }]])
  const refreshTokens = new Map<string, string>()
  const devices = new Map<string, DeviceCode>()
  let refreshed = 0
  const key = (owner: string, name: string) => `${owner}/${name}`.toLowerCase()
  const gitDir = (repo: Repo) => join(dir, repo.owner, `${repo.name}.git`)
  const git = (repo: Repo, ...args: string[]) => execFileSync('git', ['--git-dir', gitDir(repo), ...args], { encoding: 'utf8' }).trim()
  const now = () => new Date().toISOString()
  const seen: Seen[] = []
  const created = new Map<string, number>()
  // Repos whose making waits until released, by name in lower case.
  const holds = new Map<string, { reached: boolean; released: Promise<void>; release: () => void }>()
  mkdirSync(dir, { recursive: true })

  function grant(login: string) {
    const token = `ghu_${randomBytes(18).toString('hex')}`
    const refresh = `ghr_${randomBytes(18).toString('hex')}`
    grants.set(token, { login, expiresAt: Date.now() + USER_TOKEN_SECONDS * 1000 })
    refreshTokens.set(refresh, login)
    return { access_token: token, token_type: 'bearer', scope: '', expires_in: USER_TOKEN_SECONDS, refresh_token: refresh, refresh_token_expires_in: REFRESH_TOKEN_SECONDS }
  }

  // A person's role on a repo: whoever made it is its admin, and anyone else has the role a check gave them.
  const roleOn = (repo: Repo, login: string) => (login.toLowerCase() === repo.createdBy.toLowerCase() ? 'admin' : fake.roles.get(login) ?? 'read')
  const PUSHES = new Set(['admin', 'maintain', 'write'])
  // A repo as `login` sees it, with what they may do in it.
  const repoJson = (repo: Repo, login: string) => {
    const role = roleOn(repo, login)
    return {
      full_name: `${repo.owner}/${repo.name}`, name: repo.name, owner: { login: repo.owner }, private: true, description: repo.description,
      default_branch: repo.defaultBranch, html_url: `${url}/${repo.owner}/${repo.name}`, clone_url: `${url}/${repo.owner}/${repo.name}.git`,
      permissions: { admin: role === 'admin', maintain: role === 'admin' || role === 'maintain', push: PUSHES.has(role), triage: PUSHES.has(role) || role === 'triage', pull: true },
    }
  }
  const issueJson = (repo: Repo, issue: Issue) => ({
    number: issue.number, title: issue.title, body: issue.body, state: issue.state, html_url: `${url}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    user: { login: issue.author }, labels: issue.labels.map((name) => ({ name })), created_at: issue.created_at, updated_at: issue.updated_at,
  })
  const pullJson = (repo: Repo, pull: Pull) => ({
    number: pull.number, title: pull.title, body: pull.body, state: pull.state, merged: pull.merged, merged_at: pull.merged_at,
    html_url: `${url}/${repo.owner}/${repo.name}/pull/${pull.number}`, head: { ref: pull.head }, base: { ref: pull.base },
  })
  // Pull requests show among issues too, as GitHub lists them.
  const pullAsIssue = (repo: Repo, pull: Pull) => ({
    number: pull.number, title: pull.title, body: pull.body, state: pull.state, html_url: `${url}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    user: { login: repo.createdBy }, labels: [], created_at: now(), updated_at: now(), pull_request: { url: `${url}/repos/${repo.owner}/${repo.name}/pulls/${pull.number}` },
  })

  function makeRepo(owner: string, name: string, description: string, init: boolean, by: string): Repo {
    const repo: Repo = { owner, name, description, defaultBranch: 'main', issues: [], pulls: [], events: [], next: 1, createdBy: by }
    mkdirSync(join(dir, owner), { recursive: true })
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', gitDir(repo)])
    if (init) {
      // GitHub's first commit for auto_init: a README with the name and the description.
      const blob = execFileSync('git', ['--git-dir', gitDir(repo), 'hash-object', '-w', '--stdin'], { input: `# ${name}\n\n${description}\n`, encoding: 'utf8' }).trim()
      const tree = execFileSync('git', ['--git-dir', gitDir(repo), 'mktree'], { input: `100644 blob ${blob}\tREADME.md\n`, encoding: 'utf8' }).trim()
      const commit = execFileSync('git', ['--git-dir', gitDir(repo), '-c', 'user.name=GitHub', '-c', 'user.email=noreply@github.com', 'commit-tree', tree, '-m', 'Initial commit'], { encoding: 'utf8' }).trim()
      git(repo, 'update-ref', 'refs/heads/main', commit)
    }
    repos.set(key(owner, name), repo)
    return repo
  }

  function merge(repo: Repo, pull: Pull) {
    const tree = git(repo, 'merge-tree', '--write-tree', pull.base, pull.head)
    const commit = git(repo, '-c', 'user.name=GitHub', '-c', 'user.email=noreply@github.com', 'commit-tree', tree,
      '-p', pull.base, '-p', pull.head, '-m', `Merge pull request #${pull.number} from ${pull.head}`)
    git(repo, 'update-ref', `refs/heads/${pull.base}`, commit)
    pull.merged = true
    pull.merged_at = now()
    pull.state = 'closed'
  }

  const branches = (repo: Repo) => git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean)

  async function body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      if (!Buffer.isBuffer(chunk)) throw new Error('a request body arrived as something other than bytes')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return text ? JSON.parse(text) : {}
  }

  // The request each response answers, for the ETag check in send.
  const asked = new WeakMap<ServerResponse, IncomingMessage>()
  // JSON answers carry an ETag, and a GET that sends the same one back gets a 304, as GitHub does.
  const send = (res: ServerResponse, status: number, value?: unknown) => {
    const text = value === undefined ? '' : JSON.stringify(value)
    const etag = `"${createHash('sha1').update(text).digest('hex')}"`
    const req = asked.get(res)
    if (req?.method === 'GET' && status === 200 && req.headers['if-none-match'] === etag) return void res.writeHead(304, { etag }).end()
    res.writeHead(status, { 'content-type': 'application/json', etag }).end(text)
  }
  const notFound = (res: ServerResponse) => send(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' })

  // git over HTTP, as GitHub serves it, through git http-backend.
  function serveGit(req: IncomingMessage, res: ServerResponse, path: string, query: string, login: string) {
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env, GIT_PROJECT_ROOT: dir, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: path, REQUEST_METHOD: req.method ?? 'GET',
        QUERY_STRING: query, CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: login,
        ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
        ...(typeof req.headers['git-protocol'] === 'string' ? { GIT_PROTOCOL: req.headers['git-protocol'] } : {}),
        ...(typeof req.headers['content-encoding'] === 'string' ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
      },
    })
    req.pipe(child.stdin)
    let head = Buffer.alloc(0)
    let started = false
    child.stdout.on('data', (chunk: Buffer) => {
      if (started) return void res.write(chunk)
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) return
      started = true
      const headers: Record<string, string> = {}
      let status = 200
      for (const line of head.subarray(0, end).toString('latin1').split('\r\n')) {
        const [name = '', ...rest] = line.split(':')
        const value = rest.join(':').trim()
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0])
        else headers[name] = value
      }
      res.writeHead(status, headers)
      res.write(head.subarray(end + 4))
    })
    child.stdout.on('end', () => res.end())
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(`fake github git: ${chunk.toString()}`))
  }

  // Who a request's credentials belong to: a bearer token for the REST API, or
  // the account and token as the user name and password for git.
  function whoIs(req: IncomingMessage): { auth: Seen['auth']; login: string | null } {
    const authorization = req.headers.authorization ?? ''
    if (!authorization) return { auth: 'none', login: null }
    const bearer = /^(?:Bearer|token) (.+)$/.exec(authorization)?.[1]
    const basic = /^Basic (.+)$/.exec(authorization)?.[1]
    const [user, password] = basic ? Buffer.from(basic, 'base64').toString().split(':') : []
    const found = grants.get(bearer ?? password ?? '')
    if (!found || (basic !== undefined && found.login !== user)) return { auth: 'wrong', login: null }
    if (found.expiresAt !== null && found.expiresAt < Date.now()) return { auth: 'expired', login: null }
    return { auth: 'token', login: found.login }
  }

  const server = createServer((req, res) => {
    void (async () => {
      const where = new URL(req.url ?? '/', url)
      const path = where.pathname
      const { auth, login } = whoIs(req)
      asked.set(res, req)
      res.on('finish', () => seen.push({ method: req.method ?? 'GET', path, auth, login, status: res.statusCode }))

      // Signing in with the device flow, on GitHub's web host as on github.com.
      if (req.method === 'POST' && path === '/login/device/code') {
        if (DeviceAsk.parse(await body(req)).client_id !== clientId) return send(res, 200, { error: 'device_flow_disabled' })
        const deviceCode = randomBytes(10).toString('hex')
        const userCode = `${randomBytes(2).toString('hex')}-${randomBytes(2).toString('hex')}`.toUpperCase()
        devices.set(deviceCode, { userCode, approvedAs: null, denied: false })
        return send(res, 200, { device_code: deviceCode, user_code: userCode, verification_uri: `${url}/login/device`, expires_in: 900, interval: 1 })
      }
      if (req.method === 'POST' && path === '/login/oauth/access_token') {
        const ask = TokenAsk.parse(await body(req))
        if (ask.client_id !== clientId) return send(res, 200, { error: 'incorrect_client_credentials' })
        if (ask.grant_type === 'refresh_token') {
          const holder = refreshTokens.get(ask.refresh_token)
          if (!holder) return send(res, 200, { error: 'bad_refresh_token' })
          // A refresh token works once, as GitHub's do.
          refreshTokens.delete(ask.refresh_token)
          refreshed++
          return send(res, 200, grant(holder))
        }
        const device = devices.get(ask.device_code)
        if (!device) return send(res, 200, { error: 'expired_token' })
        if (device.denied) return send(res, 200, { error: 'access_denied' })
        if (!device.approvedAs) return send(res, 200, { error: 'authorization_pending' })
        devices.delete(ask.device_code)
        return send(res, 200, grant(device.approvedAs))
      }

      const gitPath = /^\/([^/]+)\/([^/]+)\.git(\/(?:info\/refs|git-upload-pack|git-receive-pack))$/.exec(path)
      if (gitPath) {
        if (!login) return void res.writeHead(401, { 'www-authenticate': 'Basic realm="GitHub"' }).end()
        const repo = repos.get(key(gitPath[1] ?? '', gitPath[2] ?? ''))
        if (!repo) return notFound(res)
        return serveGit(req, res, `/${repo.owner}/${repo.name}.git${gitPath[3] ?? ''}`, where.search.slice(1), login)
      }
      // A repo's page, for links that open it on GitHub.
      const page = /^\/([^/]+)\/([^/]+)$/.exec(path)
      if (page && req.method === 'GET' && repos.has(key(page[1] ?? '', page[2] ?? ''))) {
        return void res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>${page[1] ?? ''}/${page[2] ?? ''}</title><h1>Fake GitHub</h1>`)
      }
      if (!login) return send(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' })

      if (req.method === 'GET' && path === '/user') return send(res, 200, { login })
      const orgPath = /^\/orgs\/([^/]+)$/.exec(path)
      if (req.method === 'GET' && orgPath) return orgPath[1]?.toLowerCase() === org.toLowerCase() ? send(res, 200, { login: org }) : notFound(res)

      const create = req.method === 'POST' && (path === '/user/repos' ? login : /^\/orgs\/([^/]+)\/repos$/.exec(path)?.[1])
      if (create) {
        if (create.toLowerCase() !== login.toLowerCase() && create.toLowerCase() !== org.toLowerCase()) return notFound(res)
        if (fake.refuseCreate) return send(res, 403, { message: 'Resource not accessible by integration' })
        const wanted = CreateRepo.parse(await body(req))
        const full = `${create}/${wanted.name}`
        if (repos.has(full.toLowerCase())) {
          return send(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] })
        }
        const wait = holds.get(wanted.name.toLowerCase())
        if (wait) {
          wait.reached = true
          await wait.released
        }
        created.set(full, (created.get(full) ?? 0) + 1)
        return send(res, 201, repoJson(makeRepo(create, wanted.name, wanted.description, wanted.auto_init, login), login))
      }

      const inRepo = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path)
      const repo = inRepo ? repos.get(key(inRepo[1] ?? '', inRepo[2] ?? '')) : undefined
      if (!inRepo || !repo) return notFound(res)
      const rest = inRepo[3] ?? ''
      const number = Number(/^\/(?:issues|pulls)\/(\d+)/.exec(rest)?.[1])
      const issue = repo.issues.find((i) => i.number === number)
      const pull = repo.pulls.find((p) => p.number === number)

      if (req.method === 'GET' && rest === '') return send(res, 200, repoJson(repo, login))
      if (req.method === 'GET' && rest === '/issues') {
        return send(res, 200, [...repo.issues.filter((i) => i.state === 'open').map((i) => issueJson(repo, i)),
          ...repo.pulls.filter((p) => p.state === 'open').map((p) => pullAsIssue(repo, p))])
      }
      if (req.method === 'POST' && rest === '/issues') {
        const wanted = NewIssue.parse(await body(req))
        return send(res, 201, issueJson(repo, fake.openIssue(`${repo.owner}/${repo.name}`, wanted.title, wanted.body, wanted.labels, login)))
      }
      // Label events across the repo's issues, newest first, as GitHub lists them.
      if (req.method === 'GET' && rest === '/issues/events') {
        return send(res, 200, [...repo.events].reverse().map((e) => {
          const target = repo.issues.find((i) => i.number === e.issue)
          return { event: e.event, actor: { login: e.actor }, label: { name: e.label }, created_at: e.created_at, issue: target ? issueJson(repo, target) : null }
        }))
      }
      const roleOf = /^\/collaborators\/([^/]+)\/permission$/.exec(rest)?.[1]
      if (req.method === 'GET' && roleOf) {
        const person = decodeURIComponent(roleOf)
        if (fake.failRoleOnce.delete(person)) return send(res, 500, { message: 'Server Error' })
        const name = roleOn(repo, person)
        // GitHub's legacy permission maps maintain to write and triage to read.
        const legacy = name === 'admin' ? 'admin' : name === 'maintain' || name === 'write' ? 'write' : 'read'
        return send(res, 200, { permission: legacy, role_name: name, user: { login: person } })
      }
      if (/^\/issues\/\d+$/.test(rest) && issue) {
        if (req.method === 'GET') return send(res, 200, issueJson(repo, issue))
        if (req.method === 'PATCH') {
          issue.state = IssueChange.parse(await body(req)).state
          issue.updated_at = now()
          return send(res, 200, issueJson(repo, issue))
        }
      }
      if (req.method === 'POST' && /^\/issues\/\d+\/comments$/.test(rest) && issue) {
        issue.comments.push(Comment.parse(await body(req)).body)
        issue.updated_at = now()
        return send(res, 201, { id: issue.comments.length })
      }
      if (req.method === 'GET' && rest === '/pulls') {
        const head = where.searchParams.get('head')
        const open = repo.pulls.filter((p) => p.state === 'open' && (!head || `${repo.owner}:${p.head}` === head))
        return send(res, 200, open.map((p) => pullJson(repo, p)))
      }
      if (req.method === 'POST' && rest === '/pulls') {
        const wanted = NewPull.parse(await body(req))
        if (!branches(repo).includes(wanted.head)) {
          return send(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] })
        }
        const made: Pull = { number: repo.next++, title: wanted.title, body: wanted.body, head: wanted.head, base: wanted.base, state: 'open', merged: false, merged_at: null }
        repo.pulls.push(made)
        return send(res, 201, pullJson(repo, made))
      }
      if (req.method === 'GET' && /^\/pulls\/\d+$/.test(rest) && pull) return send(res, 200, pullJson(repo, pull))
      if (req.method === 'PUT' && /^\/pulls\/\d+\/merge$/.test(rest) && pull) {
        if (pull.merged || pull.state === 'closed') return send(res, 405, { message: 'Pull Request is not mergeable' })
        merge(repo, pull)
        return send(res, 200, { merged: true, message: 'Pull Request successfully merged', sha: git(repo, 'rev-parse', pull.base) })
      }
      const ref = /^\/git\/refs\/heads\/(.+)$/.exec(rest)?.[1]
      if (req.method === 'DELETE' && ref) {
        const branch = decodeURIComponent(ref)
        if (!branches(repo).includes(branch)) return send(res, 422, { message: 'Reference does not exist' })
        git(repo, 'update-ref', '-d', `refs/heads/${branch}`)
        return send(res, 204)
      }
      if (req.method === 'GET' && rest === '/branches') return send(res, 200, branches(repo).map((name) => ({ name, commit: { sha: git(repo, 'rev-parse', name) } })))
      return notFound(res)
    })().catch((error: unknown) => {
      process.stderr.write(`fake github: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      if (!res.headersSent) send(res, 500, { message: 'fake github failed' })
    })
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))

  const repoNamed = (fullName: string) => {
    const repo = repos.get(fullName.toLowerCase())
    if (!repo) throw new Error(`the fake GitHub has no repo ${fullName}`)
    return repo
  }
  const issueNamed = (repo: Repo, n: number) => {
    const issue = repo.issues.find((i) => i.number === n)
    if (!issue) throw new Error(`the fake GitHub has no issue ${repo.owner}/${repo.name}#${n}`)
    return issue
  }
  const fake: FakeGithub = {
    url, seen, created, refuseCreate: false, roles: new Map(), failRoleOnce: new Set(),
    grantToken(token, login) {
      grants.set(token, { login, expiresAt: null })
    },
    hold(name) {
      const { promise, resolve } = Promise.withResolvers<undefined>()
      holds.set(name.toLowerCase(), { reached: false, released: promise, release: () => { resolve(undefined) } })
    },
    held: (name) => holds.get(name.toLowerCase())?.reached ?? false,
    release(name) {
      holds.get(name.toLowerCase())?.release()
      holds.delete(name.toLowerCase())
    },
    issued: () => [...grants.keys(), ...refreshTokens.keys()],
    refreshes: () => refreshed,
    approve(userCode, login) {
      const device = [...devices.values()].find((d) => d.userCode === userCode)
      if (!device) throw new Error(`the fake GitHub has no device code ${userCode}`)
      device.approvedAs = login
    },
    deny(userCode) {
      const device = [...devices.values()].find((d) => d.userCode === userCode)
      if (!device) throw new Error(`the fake GitHub has no device code ${userCode}`)
      device.denied = true
    },
    repoExists: (fullName) => repos.has(fullName.toLowerCase()),
    createdBy: (fullName) => repos.get(fullName.toLowerCase())?.createdBy,
    git: (fullName, ...args) => git(repoNamed(fullName), ...args),
    openIssue(fullName, title, text, labels, author) {
      const repo = repoNamed(fullName)
      const made: Issue = { number: repo.next++, title, body: text || null, state: 'open', labels: [], comments: [], created_at: now(), updated_at: now(), author }
      repo.issues.push(made)
      for (const label of labels) fake.label(fullName, made.number, label, author)
      return made
    },
    label(fullName, n, label, actor) {
      const repo = repoNamed(fullName)
      const target = issueNamed(repo, n)
      target.labels.push(label)
      target.updated_at = now()
      repo.events.push({ event: 'labeled', actor, label, issue: n, created_at: now() })
    },
    unlabel(fullName, n, label, actor) {
      const repo = repoNamed(fullName)
      const target = issueNamed(repo, n)
      target.labels = target.labels.filter((l) => l !== label)
      target.updated_at = now()
      repo.events.push({ event: 'unlabeled', actor, label, issue: n, created_at: now() })
    },
    close(fullName, n) {
      const target = issueNamed(repoNamed(fullName), n)
      target.state = 'closed'
      target.updated_at = now()
    },
    setDefaultBranch(fullName, branch) {
      const repo = repoNamed(fullName)
      if (!branches(repo).includes(branch)) git(repo, 'update-ref', `refs/heads/${branch}`, git(repo, 'rev-parse', repo.defaultBranch))
      git(repo, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`)
      repo.defaultBranch = branch
    },
    issue: (fullName, n) => repos.get(fullName.toLowerCase())?.issues.find((i) => i.number === n),
    pull: (fullName, n) => repos.get(fullName.toLowerCase())?.pulls.find((p) => p.number === n),
    pulls: (fullName) => [...repos.get(fullName.toLowerCase())?.pulls ?? []],
    mergeOnGithub(fullName, n) {
      const repo = repoNamed(fullName)
      const pull = repo.pulls.find((p) => p.number === n)
      if (!pull) throw new Error(`the fake GitHub has no pull request ${fullName}#${n}`)
      merge(repo, pull)
    },
    stop: () => new Promise<void>((resolve) => {
      for (const wait of holds.values()) wait.release()
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
  return fake
}
