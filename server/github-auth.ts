// Who the app acts as on GitHub. Each person connects their own GitHub account
// by signing in with GitHub's device flow, as GitHub's own command line tool
// does. The API asks GitHub for a code, the person enters it at GitHub's device
// page, and the API keeps the token GitHub then gives it. Tokens live only in files on this
// machine, mode 600, one per person, and never reach Postgres, a log, a machine
// or a browser. A repo's calls to GitHub use the token of the person who brought
// the repo into a project. An admin's personal access token is a stopgap for a
// team before anyone has signed in, and the docs mark it as one.

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { maybe, pool } from './db.ts'
import { ForgeError } from './forge.ts'
import { messageOf } from '../shared/errors.ts'
import { GithubOwner, GithubToken, type GithubStatus, type YourGithub } from '../shared/projects.ts'

const trimSlash = (url: string) => url.replace(/\/+$/, '')

// Where GitHub is, and the folder its tokens are kept in, from the server's .env.
// The three are set together or not at all, and none has a default, so a process
// started without them, such as another check, never reaches GitHub or a real token.
const SETTINGS = ['AGENTS_GITHUB_DIR', 'AGENTS_GITHUB_API', 'AGENTS_GITHUB_GIT'] as const
const Settings = z.object({
  AGENTS_GITHUB_DIR: z.string().min(1),
  AGENTS_GITHUB_API: z.url().transform(trimSlash),
  AGENTS_GITHUB_GIT: z.url().transform(trimSlash),
  // The Agents GitHub App's client id. Signing in needs it and nothing else does.
  // It is public: the device flow uses no client secret, not even to refresh.
  AGENTS_GITHUB_CLIENT_ID: z.string().min(1).optional(),
})

type Setup = { on: true; dir: string; api: string; git: string; clientId: string | null } | { on: false; missing: string[] }

function readSetup(): Setup {
  const missing = SETTINGS.filter((name) => !process.env[name])
  if (missing.length === SETTINGS.length) return { on: false, missing }
  if (missing.length) throw new Error(`GitHub's settings go together. Set ${missing.join(' and ')} as well, or none of them.`)
  const settings = Settings.parse(process.env)
  return { on: true, dir: settings.AGENTS_GITHUB_DIR, api: settings.AGENTS_GITHUB_API, git: settings.AGENTS_GITHUB_GIT, clientId: settings.AGENTS_GITHUB_CLIENT_ID ?? null }
}

export const GITHUB: Setup = readSetup()

export const notSetUp = (missing: string[]) => `GitHub is not set up on this server. Add ${missing.join(', ')} to its .env and restart the API.`

// The settings, or a 503 that says what is missing.
export function setup(): Extract<Setup, { on: true }> {
  if (!GITHUB.on) throw new ForgeError(503, notSetUp(GITHUB.missing))
  return GITHUB
}

// A person's sign-in. With the app's expiring tokens, the token lasts eight hours
// and the refresh token renews it for six months.
const SignedIn = z.object({
  login: z.string(), token: z.string(), savedAt: z.string(),
  expiresAt: z.string().nullable(), refreshToken: z.string().nullable(), refreshExpiresAt: z.string().nullable(),
})
type SignedIn = z.infer<typeof SignedIn>
// The stopgap: an admin's personal access token, for the whole team.
const Stopgap = z.object({ token: GithubToken, login: z.string(), owner: GithubOwner, ownerKind: z.enum(['org', 'user']), savedAt: z.string() })
type Stopgap = z.infer<typeof Stopgap>

const PersonId = z.uuid()
const personFile = (personId: string) => join(setup().dir, 'people', `${PersonId.parse(personId)}.json`)
const stopgapFile = () => join(setup().dir, 'stopgap.json')

function readFile<S extends z.ZodType>(schema: S, file: string): z.infer<S> | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    // No file means nobody signed in, or nobody set a stopgap. Any other failure is real.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  return schema.parse(JSON.parse(raw))
}

// Written beside the file and renamed over it, so a reader never sees half of it.
function writeSecret(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(temp, file)
}

// GitHub's sign-in endpoints answer JSON when asked to.
async function postLogin(path: string, body: Record<string, string>): Promise<unknown> {
  const res = await fetch(`${setup().git}${path}`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'agents-app' }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new ForgeError(res.status, `GitHub ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

// The account a token belongs to.
export async function loginOf(token: string): Promise<string> {
  const res = await fetch(`${setup().api}/user`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'agents-app' },
  })
  if (!res.ok) throw new ForgeError(res.status, res.status === 401 ? 'GitHub refused the token.' : `GitHub /user: ${res.status}`)
  return z.object({ login: z.string() }).parse(await res.json()).login
}

const DeviceCode = z.object({
  device_code: z.string(), user_code: z.string(), verification_uri: z.string(), expires_in: z.number(), interval: z.number(),
})
const TokenAnswer = z.union([
  z.object({
    access_token: z.string(), expires_in: z.number().optional(), refresh_token: z.string().optional(), refresh_token_expires_in: z.number().optional(),
  }),
  z.object({ error: z.string(), interval: z.number().optional() }),
])
type Granted = Extract<z.infer<typeof TokenAnswer>, { access_token: string }>

const inSeconds = (seconds: number | undefined) => (seconds === undefined ? null : new Date(Date.now() + seconds * 1000).toISOString())
const signedInFrom = (login: string, granted: Granted): SignedIn => ({
  login, token: granted.access_token, savedAt: new Date().toISOString(), expiresAt: inSeconds(granted.expires_in),
  refreshToken: granted.refresh_token ?? null, refreshExpiresAt: inSeconds(granted.refresh_token_expires_in),
})

// Sign-ins waiting for their person to enter the code, by person. Kept in memory:
// after a restart the person asks for a new code.
type Waiting = {
  state: 'waiting'; clientId: string; userCode: string; verificationUri: string; expiresAt: number; deviceCode: string; intervalMs: number
  timer?: NodeJS.Timeout
}
const signIns = new Map<string, Waiting | { state: 'stopped'; reason: string }>()
// GitHub adds this to the wait between polls each time it says slow_down.
const SLOW_DOWN_MS = 5000

// Asks GitHub for a sign-in code for the person and starts waiting for them to enter it.
export async function startSignIn(personId: string): Promise<YourGithub> {
  const { clientId } = setup()
  if (!clientId) throw new ForgeError(503, 'Signing in with GitHub needs AGENTS_GITHUB_CLIENT_ID, the Agents GitHub App\'s client id, in the server\'s .env.')
  stopSignIn(personId)
  const code = DeviceCode.parse(await postLogin('/login/device/code', { client_id: clientId }))
  const waiting: Waiting = {
    state: 'waiting', clientId, userCode: code.user_code, verificationUri: code.verification_uri, expiresAt: Date.now() + code.expires_in * 1000,
    deviceCode: code.device_code, intervalMs: code.interval * 1000,
  }
  signIns.set(personId, waiting)
  waitFor(personId, waiting)
  return yourGithub(personId)
}

function waitFor(personId: string, waiting: Waiting) {
  waiting.timer = setTimeout(() => {
    pollSignIn(personId, waiting).catch((error: unknown) => {
      // GitHub didn't answer this poll. The code is still good until it expires, so the next poll asks again.
      console.error('github sign-in:', messageOf(error))
      if (signIns.get(personId) === waiting) waitFor(personId, waiting)
    })
  }, waiting.intervalMs)
}

async function pollSignIn(personId: string, waiting: Waiting) {
  if (signIns.get(personId) !== waiting) return
  if (Date.now() > waiting.expiresAt) {
    signIns.set(personId, { state: 'stopped', reason: 'The code expired before anyone entered it. Connect again for a new one.' })
    return
  }
  const answer = TokenAnswer.parse(await postLogin('/login/oauth/access_token', {
    client_id: waiting.clientId, device_code: waiting.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  }))
  if ('error' in answer) {
    if (answer.error === 'authorization_pending') return waitFor(personId, waiting)
    if (answer.error === 'slow_down') {
      waiting.intervalMs = answer.interval ? answer.interval * 1000 : waiting.intervalMs + SLOW_DOWN_MS
      return waitFor(personId, waiting)
    }
    const reason = answer.error === 'access_denied' ? 'Sign-in was cancelled on GitHub.'
      : answer.error === 'expired_token' ? 'The code expired before anyone entered it. Connect again for a new one.'
        : `GitHub stopped the sign-in: ${answer.error}.`
    signIns.set(personId, { state: 'stopped', reason })
    return
  }
  writeSecret(personFile(personId), signedInFrom(await loginOf(answer.access_token), answer))
  signIns.delete(personId)
}

function stopSignIn(personId: string) {
  const found = signIns.get(personId)
  if (found?.state === 'waiting') clearTimeout(found.timer)
  signIns.delete(personId)
}

// Forgets a person's GitHub sign-in on this server. Their token stays valid on
// GitHub until they revoke it there.
export function signOut(personId: string) {
  stopSignIn(personId)
  rmSync(personFile(personId), { force: true })
}

// Renew a token this close to expiring, so a call never starts with one that runs out midway.
const RENEW_EARLY_MS = 5 * 60_000
const renewing = new Map<string, Promise<SignedIn | null>>()

// A person's sign-in, renewed first if its token is about to expire. Null when
// they never signed in, or their refresh token ran out and they must sign in again.
async function signedIn(personId: string): Promise<SignedIn | null> {
  const found = readFile(SignedIn, personFile(personId))
  if (!found?.expiresAt || Date.parse(found.expiresAt) - RENEW_EARLY_MS > Date.now()) return found
  // One renewal per person at a time: GitHub's refresh tokens work once.
  let job = renewing.get(personId)
  if (!job) {
    job = renew(personId, found).finally(() => renewing.delete(personId))
    renewing.set(personId, job)
  }
  return job
}

async function renew(personId: string, found: SignedIn): Promise<SignedIn | null> {
  const { clientId } = setup()
  // Without a refresh token that still works, the person signs in again.
  if (!found.refreshToken || !clientId || (found.refreshExpiresAt && Date.parse(found.refreshExpiresAt) <= Date.now())) {
    signOut(personId)
    return null
  }
  const answer = TokenAnswer.parse(await postLogin('/login/oauth/access_token', {
    client_id: clientId, grant_type: 'refresh_token', refresh_token: found.refreshToken,
  }))
  if ('error' in answer) {
    // GitHub no longer takes the refresh token, so the person signs in again.
    if (answer.error === 'bad_refresh_token') {
      signOut(personId)
      return null
    }
    throw new ForgeError(502, `GitHub would not renew ${found.login}'s token: ${answer.error}`)
  }
  const renewed = signedInFrom(found.login, answer)
  writeSecret(personFile(personId), renewed)
  return renewed
}

function stopgap(): Stopgap | null {
  return readFile(Stopgap, stopgapFile())
}

// Who a call to GitHub acts as: a person, for what they do themselves, or a
// repo, for what agents and the server do in it.
export type Who = { person: string } | { repo: string }

// The person who brought a GitHub repo into a project, whose sign-in its calls use.
async function bringerOf(path: string): Promise<string | null> {
  const row = await maybe<{ requested_by: string | null }>(pool,
    `select rr.requested_by from repo_requests rr join repos r on r.id = rr.repo_id
     where r.forge = 'github' and r.remote_url = $1 order by rr.updated_at desc limit 1`, [`${setup().git}/${path}.git`])
  return row?.requested_by ?? null
}

// The token and account a call acts with: the person's own sign-in, or the
// stopgap token when they have none. A 503 says what to do when there is neither.
export async function tokenFor(who: Who): Promise<{ token: string; login: string }> {
  const personId = 'person' in who ? who.person : await bringerOf(who.repo)
  const own = personId ? await signedIn(personId) : null
  if (own) return own
  const shared = stopgap()
  if (shared) return shared
  throw new ForgeError(503, 'person' in who
    ? 'Connect GitHub on the Repos page first.'
    : `No one's GitHub sign-in reaches ${who.repo}. Whoever added it to its project connects GitHub again on the Repos page.`)
}

// What a person may know about GitHub on this server: whether it is set up,
// whether they are signed in and as whom, and the stopgap's account. Never a token.
export function githubStatus(personId: string): GithubStatus {
  if (!GITHUB.on) return { state: 'off', missing: GITHUB.missing }
  const shared = stopgap()
  return {
    state: 'on', signIn: GITHUB.clientId !== null, you: yourGithub(personId),
    stopgap: shared ? { login: shared.login, owner: shared.owner } : null,
  }
}

function yourGithub(personId: string): YourGithub {
  const mine = readFile(SignedIn, personFile(personId))
  if (mine) return { state: 'connected', login: mine.login, savedAt: mine.savedAt }
  const pending = signIns.get(personId)
  if (pending?.state === 'waiting') {
    return { state: 'waiting', userCode: pending.userCode, verificationUri: pending.verificationUri, expiresAt: new Date(pending.expiresAt).toISOString() }
  }
  return pending ? { state: 'stopped', reason: pending.reason } : { state: 'none' }
}

// The organization or account a person's new project repos go under, unless
// they name another: their own account, or the stopgap's organization.
export async function defaultOwner(personId: string): Promise<string> {
  const own = await signedIn(personId)
  if (own) return own.login
  const shared = stopgap()
  if (shared) return shared.owner
  throw new ForgeError(503, 'Connect GitHub on the Repos page first.')
}

// Sets the stopgap token, after checking with GitHub whose it is and that it can
// see the organization. Throws, with a reason an admin can act on, when GitHub
// refuses. Returns the token's account and the owner, never the token.
export async function setStopgap(token: string, owner: string): Promise<{ login: string; owner: string }> {
  const parsedToken = GithubToken.parse(token)
  const parsedOwner = GithubOwner.parse(owner)
  const login = await loginOf(parsedToken).catch((error: unknown) => {
    throw new Error(error instanceof ForgeError && error.status === 401 ? 'GitHub refused the token.' : `Could not ask GitHub about the token: ${messageOf(error)}`)
  })
  const ownerKind = parsedOwner.toLowerCase() === login.toLowerCase() ? 'user' : 'org'
  if (ownerKind === 'org') {
    const res = await fetch(`${setup().api}/orgs/${parsedOwner}`, {
      headers: { authorization: `Bearer ${parsedToken}`, accept: 'application/vnd.github+json', 'user-agent': 'agents-app' },
    })
    if (res.status === 404) throw new Error(`The token belongs to ${login}, and can't see an organization named ${parsedOwner}.`)
    if (!res.ok) throw new Error(`GitHub answered ${res.status} about ${parsedOwner}.`)
  }
  writeSecret(stopgapFile(), { token: parsedToken, login, owner: parsedOwner, ownerKind, savedAt: new Date().toISOString() } satisfies Stopgap)
  return { login, owner: parsedOwner }
}
