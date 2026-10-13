// The tailnet's admin API, called with the user-owned API access token an admin
// saves from the app. The token is kept only in a file on this machine, mode
// 600, never in Postgres or a log, and the browser only ever sees its last four
// characters. Shapes are Tailscale's own, from its OpenAPI spec
// (https://api.tailscale.com/api/v2?outputOpenapiSchema=true).
//
// Two settings turn it on, and both are needed:
//   AGENTS_TAILSCALE_API       Tailscale's API, https://api.tailscale.com/api/v2
//   AGENTS_TAILSCALE_KEY_FILE  where the saved key lives, ~/.agents-app/tailscale-api.json
// With neither, the app makes invites without Tailscale and says so.

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { messageOf } from '../shared/errors.ts'
import { TailscaleKey, TailscaleRole, TailscaleStatus, type TailscaleView } from '../shared/onboarding.ts'
import { problems } from './http.ts'
import { HttpError, scrub } from './record.ts'

const Settings = z.object({
  AGENTS_TAILSCALE_API: z.url().optional(),
  AGENTS_TAILSCALE_KEY_FILE: z.string().min(1).optional(),
}).refine((s) => (s.AGENTS_TAILSCALE_API === undefined) === (s.AGENTS_TAILSCALE_KEY_FILE === undefined), {
  message: 'set AGENTS_TAILSCALE_API and AGENTS_TAILSCALE_KEY_FILE together, or neither',
})

// Checked when the API starts, so a half-set pair stops it at once.
const settings = (() => {
  const parsed = Settings.parse(process.env)
  return parsed.AGENTS_TAILSCALE_API && parsed.AGENTS_TAILSCALE_KEY_FILE
    ? { api: parsed.AGENTS_TAILSCALE_API.replace(/\/+$/, ''), keyFile: parsed.AGENTS_TAILSCALE_KEY_FILE }
    : null
})()

// Tailscale answers in well under a second. This covers a slow network without
// leaving a person's request hanging.
const TAILSCALE_TIMEOUT_MS = 15_000
const DAY_MS = 24 * 60 * 60 * 1000
const OFF = 'Tailscale is off on this server. Set AGENTS_TAILSCALE_API and AGENTS_TAILSCALE_KEY_FILE for the API to turn it on.'

export const NEW_KEY_HOWTO = 'In the Tailscale admin console, open Settings, then Keys, and generate an API access token. '
  + 'Tailscale lets it last 1 to 90 days. Paste it on the Tailscale page here.'

const KeyFile = z.object({
  key: TailscaleKey,
  expires: z.iso.datetime().nullable(),
  savedAt: z.iso.datetime(),
  savedBy: z.string(),
})
type KeyFile = z.infer<typeof KeyFile>

// A time as Tailscale writes it, which can carry nanoseconds.
const TailscaleTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'not a time')
const iso = (value: string) => new Date(value).toISOString()

const KeyInfo = z.object({
  id: z.string(),
  expires: TailscaleTime.optional(),
  // Present, and true, only for a key that was revoked or has expired.
  invalid: z.boolean().optional(),
})
const User = z.object({
  id: z.string(),
  displayName: z.string(),
  loginName: z.string(),
  role: TailscaleRole,
  status: TailscaleStatus,
})
export type TailscaleUser = z.infer<typeof User>
const Device = z.object({
  nodeId: z.string(),
  name: z.string(),
  hostname: z.string(),
  user: z.string(),
  os: z.string(),
  authorized: z.boolean(),
  connectedToControl: z.boolean(),
  // Left out while the device is online, and for one never online.
  lastSeen: TailscaleTime.optional(),
})
export type TailscaleDevice = z.infer<typeof Device>
const Invite = z.object({
  id: z.string(),
  role: TailscaleRole.exclude(['owner']),
  email: z.string(),
  // Left out when the invite was never emailed.
  lastEmailSentAt: TailscaleTime.optional(),
  // Left out for an email in the tailnet's own domain, who joins by signing in.
  inviteUrl: z.string().optional(),
})
export type TailscaleInvite = z.infer<typeof Invite>
const Problem = z.object({ message: z.string() })

function keyIdOf(key: string): string {
  const keyId = /^tskey-api-([A-Za-z0-9]+)-/.exec(key)?.[1]
  if (!keyId) throw new HttpError(400, 'an API access token starts with tskey-api-')
  return keyId
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

// The saved key, or null when Tailscale is off or no key has been saved.
async function savedKeyFile(): Promise<KeyFile | null> {
  if (!settings) return null
  let raw: string
  try {
    raw = await readFile(settings.keyFile, 'utf8')
  } catch (error) {
    // No key has been saved yet.
    if (isMissingFile(error)) return null
    throw error
  }
  return KeyFile.parse(JSON.parse(raw))
}

// Written whole under a new name, then moved into place, so a reader never sees
// half a file and the file is created with mode 600.
async function writeKeyFile(file: string, value: KeyFile) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  await rename(temp, file)
}

// The key, refused once it has expired.
function usable(saved: KeyFile): string {
  if (saved.expires !== null && Date.parse(saved.expires) <= Date.now()) {
    throw new HttpError(409, `The Tailscale key expired on ${saved.expires.slice(0, 10)}. ${NEW_KEY_HOWTO}`)
  }
  return saved.key
}

async function savedKey(): Promise<string> {
  if (!settings) throw new HttpError(409, OFF)
  const saved = await savedKeyFile()
  if (!saved) throw new HttpError(409, `Tailscale is not connected yet. ${NEW_KEY_HOWTO}`)
  return usable(saved)
}

export async function tailscaleView(): Promise<TailscaleView> {
  if (!settings) return { state: 'off' }
  const saved = await savedKeyFile()
  if (!saved) return { state: 'no_key' }
  return {
    state: 'connected',
    lastFour: saved.key.slice(-4),
    expires: saved.expires,
    daysLeft: saved.expires === null ? null : Math.floor((Date.parse(saved.expires) - Date.now()) / DAY_MS),
    savedAt: saved.savedAt,
    savedBy: saved.savedBy,
  }
}

// Whether invites go through Tailscale. An expired key is an error, not a
// reason to skip Tailscale quietly.
export async function tailscaleConnected(): Promise<boolean> {
  const saved = await savedKeyFile()
  if (!saved) return false
  usable(saved)
  return true
}

function json(text: string, what: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(502, `Tailscale sent ${what} that is not JSON.`)
  }
}

// One call to Tailscale with a given key. Its refusal is passed on in its own
// words, never with the key.
async function call(key: string, method: string, path: string, body?: unknown): Promise<unknown> {
  if (!settings) throw new HttpError(409, OFF)
  let res: Response
  try {
    res = await fetch(`${settings.api}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TAILSCALE_TIMEOUT_MS),
    })
  } catch (error) {
    throw new HttpError(502, `Tailscale could not be reached: ${messageOf(error)}`)
  }
  const text = await res.text()
  if (!res.ok) {
    const said = Problem.safeParse(text ? json(text, 'an error') : null)
    const message = scrub(said.success ? said.data.message : `status ${res.status}`)
    if (res.status === 401) throw new HttpError(502, `Tailscale refused the key (${message}). ${NEW_KEY_HOWTO}`)
    if (res.status >= 500) throw new HttpError(502, `Tailscale had a problem (${message}). Try again in a minute.`)
    throw new HttpError(res.status, `Tailscale said: ${message}`)
  }
  return text ? json(text, 'an answer') : null
}

function parsed<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new HttpError(502, `Tailscale sent an answer this app does not understand: ${problems(result.error)}`)
  return result.data
}

const read = async <S extends z.ZodType>(schema: S, path: string): Promise<z.output<S>> =>
  parsed(schema, await call(await savedKey(), 'GET', path))
const act = async (method: string, path: string, body?: unknown) => { await call(await savedKey(), method, path, body) }
const segment = (value: string) => encodeURIComponent(value)

export async function saveKey(key: string, typedExpiry: string | null, savedBy: string): Promise<TailscaleView> {
  if (!settings) throw new HttpError(409, OFF)
  const info = parsed(KeyInfo, await call(key, 'GET', `/tailnet/-/keys/${segment(keyIdOf(key))}`))
  if (info.invalid === true) throw new HttpError(400, `Tailscale says this key was revoked or has expired. ${NEW_KEY_HOWTO}`)
  // Tailscale's own expiry wins over the date the admin typed.
  const expires = info.expires ?? (typedExpiry === null ? null : `${typedExpiry}T00:00:00Z`)
  await writeKeyFile(settings.keyFile, { key, expires: expires === null ? null : iso(expires), savedAt: new Date().toISOString(), savedBy })
  return tailscaleView()
}

export async function removeKey() {
  if (!settings) throw new HttpError(409, OFF)
  await rm(settings.keyFile, { force: true })
}

export const tailscale = {
  users: async () => (await read(z.object({ users: z.array(User) }), '/tailnet/-/users')).users,
  devices: async () => (await read(z.object({ devices: z.array(Device) }), '/tailnet/-/devices')).devices,
  invites: () => read(z.array(Invite), '/tailnet/-/user-invites'),
  invite: (inviteId: string) => read(Invite, `/user-invites/${segment(inviteId)}`),
  async createInvite(email: string): Promise<TailscaleInvite> {
    const [invite] = parsed(z.tuple([Invite]), await call(await savedKey(), 'POST', '/tailnet/-/user-invites', [{ role: 'member', email }]))
    return invite
  },
  resendInvite: (inviteId: string) => act('POST', `/user-invites/${segment(inviteId)}/resend`),
  deleteInvite: (inviteId: string) => act('DELETE', `/user-invites/${segment(inviteId)}`),
  userAction: (userId: string, action: 'approve' | 'suspend' | 'restore' | 'delete') => act('POST', `/users/${segment(userId)}/${action}`),
  setRole: (userId: string, role: TailscaleRole) => act('POST', `/users/${segment(userId)}/role`, { role }),
  authorizeDevice: (deviceId: string) => act('POST', `/device/${segment(deviceId)}/authorized`, { authorized: true }),
  deleteDevice: (deviceId: string) => act('DELETE', `/device/${segment(deviceId)}`),
}

export const lastSeenOf = (device: TailscaleDevice) => (device.lastSeen === undefined ? null : iso(device.lastSeen))
export const sentAtOf = (invite: TailscaleInvite) => (invite.lastEmailSentAt === undefined ? null : iso(invite.lastEmailSentAt))
