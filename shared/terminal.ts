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

// A folder's absolute path on its Mac, with no trailing slash, so one folder has one spelling.
export const FolderPath = z.string().min(2).max(4096).startsWith('/').regex(/[^/]$/, 'a folder path has no trailing slash')

// Whether a path is the folder or inside it. A sibling that shares the folder's
// name as a prefix, such as /a/repo-old beside /a/repo, is outside it.
export function insideFolder(folder: string, path: string): boolean {
  return path === folder || path.startsWith(`${folder}/`)
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

// The answer to connecting or disconnecting. `already` is true when there was nothing to change.
export const FolderAnswer = z.object({ folder: FolderRow, already: z.boolean() })
export type FolderAnswer = z.infer<typeof FolderAnswer>
// Connecting also says how many sessions already in the record a widening to the team showed it.
export const ConnectAnswer = FolderAnswer.extend({ exposed: z.number().int().min(0) })
export type ConnectAnswer = z.infer<typeof ConnectAnswer>
// The Mac's own id, so the app can tell its folders from those on the person's other machines, its connected
// folders, and how many sessions in the record each holds, by the folder's id.
export const FolderList = z.object({ instanceId: InstanceId, folders: z.array(FolderRow), sessions: z.record(z.string(), z.number().int().min(0)) })
export type FolderList = z.infer<typeof FolderList>

// What this Mac's daemon tells the Agents app on the same Mac, through the socket
// in daemon/app-socket.ts. Each folder is one Claude Code ran in, with when its
// newest transcript changed, or one connected here, with how many sessions in the
// record it holds, or both. A temporary one is inside the system's temporary
// folders, where tools start Claude Code by the hundred. A folder that isn't
// connected never leaves the Mac.
const MacFolderPlace = { path: FolderPath, temporary: z.boolean() }
export const MacFolder = z.union([
  z.object({ ...MacFolderPlace, usedAt: Time, folder: z.null(), sessions: z.null() }),
  z.object({ ...MacFolderPlace, usedAt: Time.nullable(), folder: FolderRow, sessions: z.number().int().min(0) }),
])
export type MacFolder = z.infer<typeof MacFolder>
// This Mac's id, its person's home folder, which can't be connected, and its folders, newest first.
export const MacFolders = z.object({ instanceId: InstanceId, home: FolderPath, folders: z.array(MacFolder) })
export type MacFolders = z.infer<typeof MacFolders>
// The app connects a folder by choosing who sees its sessions, and Off disconnects it.
export const AppConnect = z.object({ path: FolderPath, visibility: FolderVisibility })
export type AppConnect = z.infer<typeof AppConnect>
// The daemon's answer to a connect from the app, with anything that will keep the folder's sessions from landing.
export const AppConnected = ConnectAnswer.extend({ warnings: z.array(z.string()) })
export type AppConnected = z.infer<typeof AppConnected>
// The daemon's answer when it changed nothing, in words the app shows as they are.
export const AppRefusal = z.object({ error: z.string() })
export type AppRefusal = z.infer<typeof AppRefusal>

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
