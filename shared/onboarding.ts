// Onboarding's shapes, defined once for the server, the daemon and the app: ids,
// the rows of the tables migration 0005 adds with the states each may be in,
// and the bodies the API takes and answers with. Every value from outside goes
// through one of these schemas, and each type is inferred from its schema.

import { z } from 'zod'

// Ids. Each table's id is its own type, so a person's id cannot stand in for a team's.
export const TeamId = z.uuid().brand<'TeamId'>()
export type TeamId = z.infer<typeof TeamId>
export const PersonId = z.uuid().brand<'PersonId'>()
export type PersonId = z.infer<typeof PersonId>
export const InstanceId = z.uuid().brand<'InstanceId'>()
export type InstanceId = z.infer<typeof InstanceId>
export const ConversationId = z.uuid().brand<'ConversationId'>()
export type ConversationId = z.infer<typeof ConversationId>
export const InviteId = z.uuid().brand<'InviteId'>()
export type InviteId = z.infer<typeof InviteId>
export const JoinRequestId = z.uuid().brand<'JoinRequestId'>()
export type JoinRequestId = z.infer<typeof JoinRequestId>
export const ClaudeLoginId = z.uuid().brand<'ClaudeLoginId'>()
export type ClaudeLoginId = z.infer<typeof ClaudeLoginId>

// A Tailscale login as tailscale serve passes it. Most identity providers give
// an email; GitHub gives a name like alice@github.
export const Login = z.string().trim().min(3).max(320).regex(/@/, 'a Tailscale login has an @ in it')
export type Login = z.infer<typeof Login>

export const TeamRole = z.enum(['admin', 'member'])
export type TeamRole = z.infer<typeof TeamRole>

// A timestamp as Postgres writes it in text, which is how Electric sends it.
const Time = z.string().min(1)

// Every status a row may move to from each status. Moves not listed are refused.
type Moves<S extends string> = Readonly<Record<S, readonly S[]>>

// The statuses a row must be in to move to `to`.
export function movesInto<S extends string>(moves: Moves<S>, to: S): S[] {
  const from: S[] = []
  for (const status in moves) if (moves[status].includes(to)) from.push(status)
  return from
}

// Invites. An invite is open until its person joins or an admin cancels it.

const inviteBase = {
  id: InviteId,
  team_id: TeamId,
  email: z.email(),
  role: TeamRole,
  tailscale_invite_id: z.string().nullable(),
  invited_by: PersonId.nullable(),
  created_at: Time,
}
export const InviteRow = z.discriminatedUnion('status', [
  z.object({ ...inviteBase, status: z.literal('open'), person_id: z.null(), closed_at: z.null() }),
  // The person who joined with it, until they are removed from the team.
  z.object({ ...inviteBase, status: z.literal('joined'), person_id: PersonId.nullable(), closed_at: Time }),
  z.object({ ...inviteBase, status: z.literal('cancelled'), person_id: z.null(), closed_at: Time }),
])
export type InviteRow = z.infer<typeof InviteRow>
export type InviteStatus = InviteRow['status']
export const INVITE_MOVES = {
  open: ['joined', 'cancelled'],
  joined: [],
  cancelled: [],
} as const satisfies Moves<InviteStatus>

// Join requests. A login waits until an admin adds it, and waits again if it
// comes back after leaving the team.

const joinBase = { id: JoinRequestId, login: z.string(), name: z.string().nullable(), first_seen_at: Time, last_seen_at: Time }
export const JoinRequestRow = z.discriminatedUnion('status', [
  z.object({ ...joinBase, status: z.literal('waiting'), person_id: z.null(), added_by: z.null() }),
  z.object({ ...joinBase, status: z.literal('added'), person_id: PersonId.nullable(), added_by: PersonId.nullable() }),
])
export type JoinRequestRow = z.infer<typeof JoinRequestRow>
export type JoinRequestStatus = JoinRequestRow['status']
export const JOIN_REQUEST_MOVES = {
  waiting: ['added'],
  added: ['waiting'],
} as const satisfies Moves<JoinRequestStatus>

// Claude sign-ins on a person's box. See docs/design/onboarding.md for the relay.

const loginBase = {
  id: ClaudeLoginId, team_id: TeamId, instance_id: InstanceId, person_id: PersonId, created_at: Time, updated_at: Time,
}
export const ClaudeLoginRow = z.discriminatedUnion('status', [
  z.object({ ...loginBase, status: z.literal('starting'), url: z.null(), note: z.null(), valid_until: z.null() }),
  // The note says why the person must paste their code again, when they must.
  z.object({ ...loginBase, status: z.literal('waiting_for_code'), url: z.string(), note: z.string().nullable(), valid_until: z.null() }),
  z.object({ ...loginBase, status: z.literal('checking'), url: z.string(), note: z.null(), valid_until: z.null() }),
  z.object({ ...loginBase, status: z.literal('signed_in'), url: z.string(), note: z.null(), valid_until: Time }),
  z.object({ ...loginBase, status: z.literal('failed'), url: z.string().nullable(), note: z.string(), valid_until: z.null() }),
  z.object({ ...loginBase, status: z.literal('cancelled'), url: z.string().nullable(), note: z.null(), valid_until: z.null() }),
])
export type ClaudeLoginRow = z.infer<typeof ClaudeLoginRow>
export type ClaudeLoginStatus = ClaudeLoginRow['status']
export const CLAUDE_LOGIN_MOVES = {
  starting: ['waiting_for_code', 'failed', 'cancelled'],
  waiting_for_code: ['checking', 'failed', 'cancelled'],
  // Back to waiting when the API restarted before the box took the code.
  checking: ['signed_in', 'waiting_for_code', 'failed', 'cancelled'],
  signed_in: [],
  failed: [],
  cancelled: [],
} as const satisfies Moves<ClaudeLoginStatus>
export const OPEN_CLAUDE_LOGIN = ['starting', 'waiting_for_code', 'checking'] as const satisfies readonly ClaudeLoginStatus[]

// What Claude's sign-in page shows once the person approves: a code, then #,
// then the state the sign-in link carried.
export const ClaudeCode = z.string().trim().max(2000).regex(/^[^#\s]+#[^#\s]+$/, 'Paste the whole code, including the part after #.')

// Tailscale's roles and statuses for a tailnet user, as its API names them.
export const TailscaleRole = z.enum(['owner', 'member', 'admin', 'it-admin', 'network-admin', 'billing-admin', 'auditor'])
export type TailscaleRole = z.infer<typeof TailscaleRole>
export const TailscaleStatus = z.enum(['active', 'idle', 'suspended', 'needs-approval', 'over-billing-limit'])
export type TailscaleStatus = z.infer<typeof TailscaleStatus>
// A user-owned API access token. Its id sits between tskey-api- and the next dash.
export const TailscaleKey = z.string().trim().regex(/^tskey-api-[A-Za-z0-9]+-\S+$/, 'an API access token starts with tskey-api-')

// Request bodies, people port.

export const InviteBody = z.object({ email: z.email().max(320).transform((email) => email.toLowerCase()), role: TeamRole })
export const AddPersonBody = z.object({ login: Login, name: z.string().trim().max(200).nullable() })
export const TailscaleKeyBody = z.object({ key: TailscaleKey, expires: z.iso.date().nullable() })
export const TailscaleRoleBody = z.object({ role: TailscaleRole.exclude(['owner']) })
export const ClaudeCodeBody = z.object({ code: ClaudeCode })
export const RoomMemberBody = z.object({ login: Login })

// Request bodies, machine port, from a box's daemon during a Claude sign-in.

export const LoginLinkBody = z.object({ url: z.url({ protocol: /^https$/ }) })
export const LoginDoneBody = z.object({ validDays: z.number().int().min(0).max(3660) })
export const LoginFailedBody = z.object({ reason: z.string().trim().min(1).max(500) })
export const LoginCodeReply = z.object({ code: ClaudeCode })

// Answers.

export const MeView = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('member'),
    person: z.object({ id: PersonId, login: z.string(), name: z.string().nullable(), role: TeamRole }),
    team: z.object({ id: TeamId, name: z.string() }),
  }),
  // On no team yet. An admin sees the login under "Wants to join".
  z.object({ kind: z.literal('waiting'), login: z.string(), name: z.string().nullable() }),
])
export type MeView = z.infer<typeof MeView>
export type MemberView = Extract<MeView, { kind: 'member' }>

export const TailscaleView = z.discriminatedUnion('state', [
  // The server has no AGENTS_TAILSCALE_KEY_FILE, so no key can be saved.
  z.object({ state: z.literal('off') }),
  z.object({ state: z.literal('no_key') }),
  z.object({
    state: z.literal('connected'),
    lastFour: z.string().length(4),
    // Null when neither Tailscale nor the admin said when the key expires.
    expires: z.iso.datetime({ offset: true }).nullable(),
    daysLeft: z.number().int().nullable(),
    savedAt: z.iso.datetime({ offset: true }),
    savedBy: z.string(),
  }),
])
export type TailscaleView = z.infer<typeof TailscaleView>

// Admins are warned from this many days before the key expires.
export const KEY_WARNING_DAYS = 14

export const InviteMade = z.object({
  invite: InviteRow,
  // Tailscale's invite link, returned once. Null when Tailscale is not connected,
  // or when the email is in the tailnet's own domain and needs no link.
  link: z.string().nullable(),
})
export type InviteMade = z.infer<typeof InviteMade>
export const InviteLink = z.object({ link: z.string() })

// Whether a tailnet user's login is on the asking admin's team.
export const TeamStanding = z.discriminatedUnion('on', [
  z.object({ on: z.literal('this_team'), role: TeamRole }),
  z.object({ on: z.literal('other_team') }),
  z.object({ on: z.literal('no_team') }),
])
export const TailnetUser = z.object({
  id: z.string(), name: z.string(), login: z.string(), role: TailscaleRole, status: TailscaleStatus, team: TeamStanding,
})
export type TailnetUser = z.infer<typeof TailnetUser>
export const TailnetDevice = z.object({
  id: z.string(), name: z.string(), owner: z.string(), os: z.string(), authorized: z.boolean(),
  // Tailscale gives a last-seen time only for a device that is not online now, and none for one never online.
  online: z.boolean(), lastSeen: z.string().nullable(),
})
export type TailnetDevice = z.infer<typeof TailnetDevice>
export const TailnetInvite = z.object({
  id: z.string(), email: z.string(), role: TailscaleRole, lastSentAt: z.string().nullable(),
  // Tailscale gives no link for an email in the tailnet's own domain. That person signs in to join.
  link: z.string().nullable(),
})
export type TailnetInvite = z.infer<typeof TailnetInvite>
export const TailnetUsers = z.object({ users: z.array(TailnetUser) })
export const TailnetDevices = z.object({ devices: z.array(TailnetDevice) })
export const TailnetInvites = z.object({ invites: z.array(TailnetInvite) })
export const Done = z.object({ ok: z.literal(true) })
export const LoginStarted = z.object({ loginId: ClaudeLoginId })
export const BoxMade = z.object({ instanceId: InstanceId })
