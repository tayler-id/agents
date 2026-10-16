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

// Where a terminal session ran: its folder's name, and the folder inside it the session started in.
export function placeOf(folderPath: string, cwd: string): string {
  return `${folderPath.split('/').pop() ?? folderPath}${cwd.slice(folderPath.length)}`
}

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
export const FolderList = z.object({ folders: z.array(FolderRow) })
export type FolderList = z.infer<typeof FolderList>

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
