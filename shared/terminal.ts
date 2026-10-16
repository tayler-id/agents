// Terminal sessions: the Claude Code sessions a person starts in their own
// terminal, in a folder they connected on their Mac. These shapes are defined
// once for the server, the daemon and the app. The design is
// docs/design/local-sessions.md, and the tables are migration 0013's.

import { z } from 'zod'
import { FolderId, PersonId, SessionId, TeamId } from './ids.ts'
import { InstanceId } from './onboarding.ts'
import { SESSION_STATUSES } from './types.ts'

// Who sees a folder's sessions: the whole team, or only the person who connected it.
export const FOLDER_VISIBILITIES = ['team', 'private'] as const
export const FolderVisibility = z.enum(FOLDER_VISIBILITIES)
export type FolderVisibility = z.infer<typeof FolderVisibility>

// A folder's absolute path on its Mac, with no trailing slash, so one folder has
// one spelling. The root folder holds every folder on the Mac, so it is never one.
export const FolderPath = z.string().max(4096).startsWith('/')
  .refine((path) => path !== '/', "the root folder holds every folder on the Mac and can't be connected")
  .regex(/[^/]$/, 'a folder path has no trailing slash')

// Where a terminal session ran: its folder's name, and the folder inside it the session started in.
export function placeOf(folderPath: string, cwd: string): string {
  return `${folderPath.split('/').pop() ?? folderPath}${cwd.slice(folderPath.length)}`
}

// Whether a path is the folder or inside it. A sibling that shares the folder's
// name as a prefix, such as /a/repo-old beside /a/repo, is outside it. Every
// path is inside the root folder.
export function insideFolder(folder: string, path: string): boolean {
  return path === folder || path.startsWith(folder === '/' ? '/' : `${folder}/`)
}

// Whether a folder is the home folder or holds it. A person's home holds every
// project they have, so connecting it would send every session they start under it.
export function holdsHome(folder: string, home: string): boolean {
  return insideFolder(folder, home)
}

// What the Mac asks for when its person connects or disconnects a folder. With no
// visibility, a folder connected before keeps its own, and a new one is the team's.
export const ConnectFolder = z.object({ path: FolderPath, visibility: FolderVisibility.optional() })
export type ConnectFolder = z.infer<typeof ConnectFolder>
export const DisconnectFolder = z.object({ path: FolderPath })
export type DisconnectFolder = z.infer<typeof DisconnectFolder>

const Time = z.string()

export const FolderRow = z.object({
  id: FolderId, team_id: TeamId, instance_id: InstanceId, path: FolderPath, visibility: FolderVisibility,
  connected_by: PersonId.nullable(), connected_at: Time, disconnected_at: Time.nullable(),
})
export type FolderRow = z.infer<typeof FolderRow>

// The folder whose choice decides where a session started in `path` goes: the
// deepest folder holding it that has a choice of its own, connected, or turned
// Off and kept on this Mac. A folder's own choice wins over the folders it is in.
// Off wins over a connected row at the same path, so a change that failed between
// its two steps never sends more. A connected folder that holds `home` decides
// nothing, since the daemon reads no session in it. None means the session stays
// on the Mac.
export type Deciding = { kept: true; path: string } | { kept: false; folder: FolderRow }
export function decidingFolder(path: string, connected: readonly FolderRow[], kept: readonly string[], home: string): Deciding | null {
  let found: Deciding | null = null
  // Two folders that both hold the path are one inside the other, so the longer path is the deeper one.
  let depth = -1
  for (const folder of connected) {
    if (insideFolder(folder.path, path) && !holdsHome(folder.path, home) && folder.path.length > depth) {
      found = { kept: false, folder }
      depth = folder.path.length
    }
  }
  for (const off of kept) {
    if (insideFolder(off, path) && off.length >= depth) {
      found = { kept: true, path: off }
      depth = off.length
    }
  }
  return found
}

// The answer to connecting or disconnecting. `already` is true when there was nothing to change.
export const FolderAnswer = z.object({ folder: FolderRow, already: z.boolean() })
export type FolderAnswer = z.infer<typeof FolderAnswer>
// Connecting also says how many sessions already in the record a widening to the team showed it.
export const ConnectAnswer = FolderAnswer.extend({ exposed: z.number().int().min(0) })
export type ConnectAnswer = z.infer<typeof ConnectAnswer>
// The Mac's own id, so the app can tell its folders from those on the person's other machines, its connected
// folders, and by path how many sessions in the record each of its private folders holds, connected or not. The
// team can't see those, and choosing Team for the folder shows them.
export const FolderList = z.object({ instanceId: InstanceId, folders: z.array(FolderRow), hiddenSessions: z.record(z.string(), z.number().int().min(0)) })
export type FolderList = z.infer<typeof FolderList>

// What this Mac's daemon tells the Agents app on the same Mac, through the socket
// in daemon/app-socket.ts. Each folder is one Claude Code ran in, with when its
// newest transcript changed, one connected here, or one turned Off here, which
// the daemon keeps on this Mac, and it can be more than one of those.
// `hiddenSessions` is how many of its sessions in the record the team can't see
// now, which choosing Team shows them. A temporary one is inside the system's
// temporary folders, where tools start Claude Code by the hundred. A folder that
// isn't connected never leaves the Mac.
const MacFolderPlace = { path: FolderPath, temporary: z.boolean(), hiddenSessions: z.number().int().min(0) }
export const MacFolder = z.union([
  // Claude Code ran in it, and it has no choice of its own.
  z.object({ ...MacFolderPlace, usedAt: Time, folder: z.null(), kept: z.literal(false) }),
  // Connected here.
  z.object({ ...MacFolderPlace, usedAt: Time.nullable(), folder: FolderRow, kept: z.literal(false) }),
  // Turned Off here, so its sessions stay on this Mac whatever folder it is in.
  z.object({ ...MacFolderPlace, usedAt: Time.nullable(), folder: z.null(), kept: z.literal(true) }),
])
export type MacFolder = z.infer<typeof MacFolder>
// A folder Claude Code ran in whose path can't be a connected folder's, such as / for a session started there, which
// the list leaves out, and why.
export const UnlistedFolder = z.object({ path: z.string(), why: z.string() })
export type UnlistedFolder = z.infer<typeof UnlistedFolder>
// This Mac's id, its person's home folder, which can't be connected, its folders, newest first, and the ones left out.
export const MacFolders = z.object({ instanceId: InstanceId, home: FolderPath, folders: z.array(MacFolder), unlisted: z.array(UnlistedFolder) })
export type MacFolders = z.infer<typeof MacFolders>
// The app connects a folder by choosing who sees its sessions, and Off disconnects it. Team on a folder whose
// sessions in the record the team can't see carries how many of them the person said yes to showing the team.
export const AppConnect = z.object({ path: FolderPath, visibility: FolderVisibility, confirmed: z.number().int().min(1).optional() })
export type AppConnect = z.infer<typeof AppConnect>
// The daemon's answer to a connect from the app, with anything that will keep the folder's sessions from landing.
export const AppConnected = ConnectAnswer.extend({ warnings: z.array(z.string()) })
export type AppConnected = z.infer<typeof AppConnected>
// What Off did. `folder` is the folder's row in the record, disconnected now, when it was connected, and `inside` the
// connected folder it is in, whose sessions it would land with but for its Off. `already` is true when it was off.
export const OffAnswer = z.object({ folder: FolderRow.nullable(), inside: FolderRow.nullable(), already: z.boolean() })
export type OffAnswer = z.infer<typeof OffAnswer>
// The daemon's answer when it changed nothing, in words the app shows as they are.
export const AppRefusal = z.object({ error: z.string() })
export type AppRefusal = z.infer<typeof AppRefusal>
// The daemon's refusal of Team when the ask didn't carry the person's yes to the sessions it would show the team,
// with how many those are now, for the app to ask about.
export const AppAskFirst = AppRefusal.extend({ hiddenSessions: z.number().int().min(1) })
export type AppAskFirst = z.infer<typeof AppAskFirst>

// The daemon found a Claude Code session that started in a connected folder.
// The API answers with the record's session for it, the same one each time.
export const TerminalSessionAsk = z.object({ folderId: FolderId, harnessSessionId: z.string().min(1).max(200), cwd: FolderPath })
export type TerminalSessionAsk = z.infer<typeof TerminalSessionAsk>
export const TerminalSessionAnswer = z.object({ sessionId: SessionId })

// A terminal session as the app lists it.
export const TerminalSessionRow = z.object({
  id: SessionId, team_id: TeamId, instance_id: InstanceId, folder_id: FolderId, started_by: PersonId.nullable(), cwd: FolderPath,
  status: z.enum(SESSION_STATUSES), turns: z.number(), harness_session_id: z.string(), created_at: Time, last_active_at: Time.nullable(),
})
export type TerminalSessionRow = z.infer<typeof TerminalSessionRow>
