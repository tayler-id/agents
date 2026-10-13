// The API's routes for onboarding: who you are, inviting and adding people to
// the team and to rooms, and the Tailscale key. api.ts adds them to its own list.

import { adminFrom, loginFrom, nameFrom, personFrom } from './auth.ts'
import { tx } from './db.ts'
import { parseBody, pathId, type Route } from './http.ts'
import {
  addToTeam, arrive, cancelInvite, cancelTailnetInvite, inviteLink, makeInvite, meOf, resendInvite, tailnetDevices, tailnetInvites, tailnetUsers,
} from './onboarding.ts'
import { addRoomMember } from './rooms.ts'
import { removeKey, saveKey, tailscale, tailscaleView } from './tailscale.ts'
import {
  AddPersonBody, ConversationId, DeviceAction, InviteBody, InviteId, RoomMemberBody, TailnetInviteAction, TailscaleKeyBody, TailscaleRoleBody, UserAction,
  type Done, type InviteMade, type MeView, type PersonAdded, type TailnetDevices, type TailnetInvites, type TailnetUsers, type TailscaleView,
} from '../shared/onboarding.ts'

const UUID = '([0-9a-f-]{36})'
// Tailscale's ids for users, devices and invites: digits, or letters and digits such as n292kg92CNTRL.
const TAILSCALE_ID = '([A-Za-z0-9]+)'
const done: Done = { ok: true }

export const onboardingRoutes: Route[] = [
  // Who is calling. A login with an open invite joins its team here, and one
  // with none is recorded as wanting to join.
  ['people', 'GET', /^\/v1\/me$/, async (req): Promise<MeView> => meOf(await arrive(loginFrom(req), nameFrom(req)))],

  ['people', 'POST', /^\/v1\/invites$/, async (req): Promise<InviteMade> => {
    const admin = await adminFrom(req)
    const body = await parseBody(req, InviteBody)
    return makeInvite(admin, body.email, body.role)
  }],

  ['people', 'POST', new RegExp(`^/v1/invites/${UUID}/resend$`), async (req, [inviteId]) =>
    resendInvite(await adminFrom(req), pathId(InviteId, inviteId))],

  ['people', 'POST', new RegExp(`^/v1/invites/${UUID}/cancel$`), async (req, [inviteId]): Promise<Done> => {
    await cancelInvite(await adminFrom(req), pathId(InviteId, inviteId))
    return done
  }],

  ['people', 'GET', new RegExp(`^/v1/invites/${UUID}/link$`), async (req, [inviteId]) =>
    inviteLink(await adminFrom(req), pathId(InviteId, inviteId))],

  // An admin adds a login that asked to join, or a tailnet user, to their team.
  ['people', 'POST', /^\/v1\/team\/people$/, async (req): Promise<PersonAdded> => {
    const admin = await adminFrom(req)
    const body = await parseBody(req, AddPersonBody)
    const person = await addToTeam(admin, body.login, body.name)
    return { personId: person.id }
  }],

  // An admin, or someone in the room, adds a teammate to it.
  ['people', 'POST', new RegExp(`^/v1/conversations/${UUID}/members$`), async (req, [roomId]): Promise<PersonAdded> => {
    const person = await personFrom(req)
    const body = await parseBody(req, RoomMemberBody)
    return { personId: await tx((client) => addRoomMember(client, person, pathId(ConversationId, roomId), body.login)) }
  }],

  ['people', 'GET', /^\/v1\/tailscale$/, async (req): Promise<TailscaleView> => {
    await adminFrom(req)
    return tailscaleView()
  }],

  ['people', 'POST', /^\/v1\/tailscale\/key$/, async (req): Promise<TailscaleView> => {
    const admin = await adminFrom(req)
    const body = await parseBody(req, TailscaleKeyBody)
    return saveKey(body.key, body.expires, admin.login)
  }],

  ['people', 'POST', /^\/v1\/tailscale\/key\/delete$/, async (req): Promise<TailscaleView> => {
    await adminFrom(req)
    await removeKey()
    return tailscaleView()
  }],

  // The tailnet's users, devices and invites, read from Tailscale each time and never stored.
  ['people', 'GET', /^\/v1\/tailscale\/users$/, async (req): Promise<TailnetUsers> => ({ users: await tailnetUsers(await adminFrom(req)) })],

  ['people', 'POST', new RegExp(`^/v1/tailscale/users/${TAILSCALE_ID}/(approve|suspend|restore|delete)$`), async (req, [userId, action]): Promise<Done> => {
    await adminFrom(req)
    await tailscale.userAction(userId, UserAction.parse(action))
    return done
  }],

  ['people', 'POST', new RegExp(`^/v1/tailscale/users/${TAILSCALE_ID}/role$`), async (req, [userId]): Promise<Done> => {
    await adminFrom(req)
    await tailscale.setRole(userId, (await parseBody(req, TailscaleRoleBody)).role)
    return done
  }],

  ['people', 'GET', /^\/v1\/tailscale\/devices$/, async (req): Promise<TailnetDevices> => {
    await adminFrom(req)
    return { devices: await tailnetDevices() }
  }],

  ['people', 'POST', new RegExp(`^/v1/tailscale/devices/${TAILSCALE_ID}/(authorize|delete)$`), async (req, [deviceId, action]): Promise<Done> => {
    await adminFrom(req)
    const asked = DeviceAction.parse(action)
    if (asked === 'authorize') await tailscale.authorizeDevice(deviceId)
    else await tailscale.deleteDevice(deviceId)
    return done
  }],

  ['people', 'GET', /^\/v1\/tailscale\/invites$/, async (req): Promise<TailnetInvites> => {
    await adminFrom(req)
    return { invites: await tailnetInvites() }
  }],

  ['people', 'POST', new RegExp(`^/v1/tailscale/invites/${TAILSCALE_ID}/(resend|cancel)$`), async (req, [inviteId, action]): Promise<Done> => {
    const admin = await adminFrom(req)
    if (TailnetInviteAction.parse(action) === 'resend') await tailscale.resendInvite(inviteId)
    else await cancelTailnetInvite(admin, inviteId)
    return done
  }],
]
