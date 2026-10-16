// A stand-in for Tailscale's admin API, for checks. It speaks the real protocol
// from Tailscale's OpenAPI spec: the same paths under /api/v2, a bearer API
// access token, the same JSON shapes, errors as { message }, and invite resends
// limited to one a minute. It keeps every call it took, so a check can see what
// the app asked Tailscale to do.

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { buffer } from 'node:stream/consumers'
import { z } from 'zod'

export type FakeUser = {
  id: string; displayName: string; loginName: string; profilePicUrl: string; tailnetId: string; created: string
  type: 'member' | 'shared'; role: string; status: string; deviceCount: number; lastSeen: string; currentlyConnected: boolean
}
export type FakeDevice = {
  addresses: string[]; id: string; nodeId: string; user: string; name: string; hostname: string; clientVersion: string
  updateAvailable: boolean; os: string; created: string; connectedToControl: boolean; lastSeen?: string; keyExpiryDisabled: boolean
  expires: string; authorized: boolean; isExternal: boolean; machineKey: string; nodeKey: string; blocksIncomingConnections: boolean
  tags: string[]
}
export type FakeInvite = {
  id: string; role: string; tailnetId: number; inviterId: number; email: string; lastEmailSentAt?: string; inviteUrl?: string
}
export type Call = { method: string; path: string; body: unknown }
export type FakeState = {
  key: string
  keyExpires: string
  users: Map<string, FakeUser>
  devices: Map<string, FakeDevice>
  invites: Map<string, FakeInvite>
  lastSent: Map<string, number>
  calls: Call[]
  // When set, the next invite Tailscale is asked to make fails with this message.
  refuseNextInvite: string | null
  // When set, the next invite Tailscale is asked to delete stays, and the call fails with this message.
  refuseNextDelete: string | null
}

const RESEND_EVERY_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000
const InviteRequest = z.array(z.object({ role: z.string().default('member'), email: z.string().optional() }))

const keyIdOf = (key: string) => {
  const keyId = /^tskey-api-([A-Za-z0-9]+)-/.exec(key)?.[1]
  if (!keyId) throw new Error('the fake needs a key shaped like tskey-api-<id>-<secret>')
  return keyId
}

export function fakeTailscale(options: { key: string; keyExpiresInDays: number; domain: string }) {
  keyIdOf(options.key)
  const state: FakeState = {
    key: options.key,
    keyExpires: new Date(Date.now() + options.keyExpiresInDays * DAY_MS).toISOString(),
    users: new Map(),
    devices: new Map(),
    invites: new Map(),
    lastSent: new Map(),
    calls: [],
    refuseNextInvite: null,
    refuseNextDelete: null,
  }

  const user = (loginName: string, displayName: string, role = 'member', status = 'active'): FakeUser => {
    const created = new Date().toISOString()
    const added: FakeUser = {
      id: String(100000 + state.users.size), displayName, loginName, profilePicUrl: '', tailnetId: 'example.com', created,
      type: 'member', role, status, deviceCount: 0, lastSeen: created, currentlyConnected: false,
    }
    state.users.set(added.id, added)
    return added
  }
  const device = (owner: string, hostname: string, os: string, authorized: boolean, online: boolean): FakeDevice => {
    const added: FakeDevice = {
      addresses: [`100.64.0.${state.devices.size + 1}`], id: String(900000 + state.devices.size), nodeId: `n${randomBytes(5).toString('hex')}CNTRL`,
      user: owner, name: `${hostname}.tail1234.ts.net`, hostname, clientVersion: '1.90.0', updateAvailable: false, os,
      created: new Date().toISOString(), connectedToControl: online, keyExpiryDisabled: false,
      expires: new Date(Date.now() + 180 * DAY_MS).toISOString(), authorized, isExternal: false, machineKey: '',
      nodeKey: `nodekey:${randomBytes(8).toString('hex')}`, blocksIncomingConnections: false, tags: [],
      ...(online ? {} : { lastSeen: new Date(Date.now() - 2 * DAY_MS).toISOString() }),
    }
    state.devices.set(added.nodeId, added)
    return added
  }
  // A new key replaces the old one, as when an admin makes another in Tailscale's console.
  const useKey = (key: string, expiresInDays: number) => {
    keyIdOf(key)
    state.key = key
    state.keyExpires = new Date(Date.now() + expiresInDays * DAY_MS).toISOString()
  }
  // The person accepts their invite: it closes, and they become a tailnet user.
  const accept = (email: string, displayName: string) => {
    for (const [inviteId, invite] of state.invites) if (invite.email === email) state.invites.delete(inviteId)
    return user(email, displayName)
  }

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(body === undefined ? '' : JSON.stringify(body))
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const text = (await buffer(req)).toString('utf8')
    const body: unknown = text ? JSON.parse(text) : undefined
    const path = new URL(req.url ?? '/', 'http://fake').pathname.replace(/^\/api\/v2/, '')
    const method = req.method ?? 'GET'
    state.calls.push({ method, path, body })
    if (req.headers.authorization !== `Bearer ${state.key}`) return send(res, 401, { message: 'API token invalid' })

    const route = (pattern: RegExp) => pattern.exec(path)
    let m: RegExpExecArray | null
    if (method === 'GET' && (m = route(/^\/tailnet\/-\/keys\/([^/]+)$/))) {
      if (m[1] !== keyIdOf(state.key)) return send(res, 404, { message: 'key not found' })
      return send(res, 200, { id: m[1], key: '', keyType: 'api', created: new Date().toISOString(), expires: state.keyExpires, scopes: ['all'], userId: 'u1' })
    }
    if (method === 'GET' && path === '/tailnet/-/users') return send(res, 200, { users: [...state.users.values()].filter((u) => u.type === 'member') })
    if (method === 'POST' && (m = route(/^\/users\/([^/]+)\/(approve|suspend|restore|delete|role)$/))) {
      const found = state.users.get(m[1] ?? '')
      if (!found) return send(res, 404, { message: 'user not found' })
      const action = m[2]
      if (action === 'approve') found.status = 'active'
      if (action === 'suspend') found.status = 'suspended'
      if (action === 'restore') found.status = 'active'
      if (action === 'delete') state.users.delete(found.id)
      if (action === 'role') found.role = z.object({ role: z.string() }).parse(body).role
      return send(res, 200)
    }
    if (method === 'GET' && path === '/tailnet/-/devices') return send(res, 200, { devices: [...state.devices.values()] })
    if (method === 'POST' && (m = route(/^\/device\/([^/]+)\/authorized$/))) {
      const found = state.devices.get(m[1] ?? '')
      if (!found) return send(res, 404, { message: 'device not found' })
      found.authorized = z.object({ authorized: z.boolean() }).parse(body).authorized
      return send(res, 200)
    }
    if (method === 'DELETE' && (m = route(/^\/device\/([^/]+)$/))) {
      if (!state.devices.delete(m[1] ?? '')) return send(res, 404, { message: 'device not found' })
      return send(res, 200)
    }
    // The real Tailscale answers null, not [], when no invite is open. Seen on 2026-10-16, the first call to it.
    if (method === 'GET' && path === '/tailnet/-/user-invites') return send(res, 200, state.invites.size ? [...state.invites.values()] : null)
    if (method === 'POST' && path === '/tailnet/-/user-invites') {
      if (state.refuseNextInvite !== null) {
        const message = state.refuseNextInvite
        state.refuseNextInvite = null
        return send(res, 400, { message })
      }
      const made = InviteRequest.parse(body).map((asked) => {
        const invite: FakeInvite = {
          id: String(29000 + state.invites.size + state.calls.length), role: asked.role, tailnetId: 12345, inviterId: 34567, email: asked.email ?? '',
          ...(asked.email ? { lastEmailSentAt: new Date().toISOString() } : {}),
          // Tailscale gives no link for an email in the tailnet's own domain.
          ...(asked.email?.endsWith(`@${options.domain}`) ? {} : { inviteUrl: `https://login.tailscale.com/admin/invite/${randomBytes(9).toString('hex')}` }),
        }
        state.invites.set(invite.id, invite)
        if (asked.email) state.lastSent.set(invite.id, Date.now())
        return invite
      })
      return send(res, 200, made)
    }
    if ((m = route(/^\/user-invites\/([^/]+)$/))) {
      const found = state.invites.get(m[1] ?? '')
      if (!found) return send(res, 404, { message: 'user invite not found' })
      if (method === 'GET') return send(res, 200, found)
      if (method === 'DELETE') {
        if (state.refuseNextDelete !== null) {
          const message = state.refuseNextDelete
          state.refuseNextDelete = null
          return send(res, 500, { message })
        }
        state.invites.delete(found.id)
        return send(res, 200)
      }
    }
    if (method === 'POST' && (m = route(/^\/user-invites\/([^/]+)\/resend$/))) {
      const found = state.invites.get(m[1] ?? '')
      if (!found) return send(res, 404, { message: 'user invite not found' })
      if (Date.now() - (state.lastSent.get(found.id) ?? 0) < RESEND_EVERY_MS) return send(res, 429, { message: 'invite resends are limited to one per minute' })
      state.lastSent.set(found.id, Date.now())
      found.lastEmailSentAt = new Date().toISOString()
      return send(res, 200)
    }
    return send(res, 404, { message: `no route ${method} ${path}` })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => { send(res, 500, { message: error instanceof Error ? error.message : String(error) }) })
  })
  return {
    state, user, device, accept, useKey,
    listen: (port: number) => new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', resolve) }),
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
    url: (port: number) => `http://127.0.0.1:${port}/api/v2`,
  }
}
