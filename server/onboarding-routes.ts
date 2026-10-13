// The API's routes for onboarding: who you are, inviting and adding people, and
// the Tailscale key. api.ts adds them to its own list.

import { adminFrom, loginFrom, nameFrom } from './auth.ts'
import { parseBody, pathId, type Route } from './http.ts'
import { addToTeam, arrive, cancelInvite, inviteLink, makeInvite, meOf, resendInvite } from './onboarding.ts'
import { removeKey, saveKey, tailscaleView } from './tailscale.ts'
import {
  AddPersonBody, InviteBody, InviteId, TailscaleKeyBody,
  type InviteMade, type MeView, type TailscaleView,
} from '../shared/onboarding.ts'

const UUID = '([0-9a-f-]{36})'
const done = { ok: true } as const

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

  ['people', 'POST', new RegExp(`^/v1/invites/${UUID}/cancel$`), async (req, [inviteId]) => {
    await cancelInvite(await adminFrom(req), pathId(InviteId, inviteId))
    return done
  }],

  ['people', 'GET', new RegExp(`^/v1/invites/${UUID}/link$`), async (req, [inviteId]) =>
    inviteLink(await adminFrom(req), pathId(InviteId, inviteId))],

  // An admin adds a login that asked to join, or a tailnet user, to their team.
  ['people', 'POST', /^\/v1\/team\/people$/, async (req) => {
    const admin = await adminFrom(req)
    const body = await parseBody(req, AddPersonBody)
    const person = await addToTeam(admin, body.login, body.name)
    return { personId: person.id }
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
]
