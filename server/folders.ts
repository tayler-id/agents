// Connected folders and the terminal sessions in them. Only a Mac connects or
// disconnects its own folders, with its machine token, so no one in the app can
// make a person's sessions leave their Mac. The Mac's daemon reports each Claude
// Code session it finds in a connected folder, and this module gives it the
// record's session for it. The design is docs/design/local-sessions.md.

import type pg from 'pg'
import { z } from 'zod'
import { many, maybe, one, pool } from './db.ts'
import { HttpError, scrub } from './record.ts'
import type { Instance } from './auth.ts'
import { PersonId, SessionId } from '../shared/ids.ts'
import { EVENT_KINDS, PERSON_KINDS, type EventKind } from '../shared/types.ts'
import {
  FolderRow, insideFolder, type ConnectAnswer, type ConnectFolder, type DisconnectFolder, type FolderAnswer, type FolderList, type TerminalSessionAsk,
} from '../shared/terminal.ts'

const FOLDER = `id, team_id, instance_id, path, visibility, connected_by, connected_at::text, disconnected_at::text`
// How many sessions in the record a folder holds, every one of which the team sees once a private folder is the team's.
const SESSIONS_OF = (folderId: string) => `(select count(*)::int from sessions where folder_id = ${folderId})`

// The person whose terminal this Mac is. Their sessions are the ones a connected folder sends.
async function macOwner(client: pg.PoolClient, instance: Instance): Promise<PersonId> {
  const mac = await one<{ kind: string; owner_id: string | null }>(client, 'the calling machine',
    'select kind, owner_id from instances where id = $1 for update', [instance.id])
  if (mac.kind !== 'mac') throw new HttpError(409, 'Only a Mac connects folders. Boxes have no terminal of their own.')
  if (mac.owner_id === null) throw new HttpError(409, 'This Mac has no owner, so there is no one whose terminal sessions it could send.')
  return PersonId.parse(mac.owner_id)
}

export async function connectFolder(client: pg.PoolClient, instance: Instance, ask: ConnectFolder): Promise<ConnectAnswer> {
  const owner = await macOwner(client, instance)
  const found = await maybe(client, `select ${FOLDER} from connected_folders where instance_id = $1 and path = $2 for update`, [instance.id, ask.path])
  if (found) {
    const folder = FolderRow.parse(found)
    // Only the person's own choice changes who sees a folder's sessions.
    const visibility = ask.visibility ?? folder.visibility
    if (folder.disconnected_at === null && folder.visibility === visibility) return { folder, already: true, exposed: 0 }
    // Widening a private folder shows the team every session of it already in the record.
    const exposed = folder.visibility === 'private' && visibility === 'team'
      ? (await one<{ count: number }>(client, 'the count of the folder\'s sessions', `select ${SESSIONS_OF('$1')} as count`, [folder.id])).count
      : 0
    // A folder connected again starts over: only sessions started from now on land.
    const again = await one(client, 'the folder connected again',
      `update connected_folders set visibility = $2, connected_by = $3,
         connected_at = case when disconnected_at is null then connected_at else now() end, disconnected_at = null
       where id = $1 returning ${FOLDER}`, [folder.id, visibility, owner])
    return { folder: FolderRow.parse(again), already: false, exposed }
  }
  const made = await one(client, 'the new folder',
    `insert into connected_folders (team_id, instance_id, path, visibility, connected_by) values ($1, $2, $3, $4, $5)
     returning ${FOLDER}`, [instance.team_id, instance.id, ask.path, ask.visibility ?? 'team', owner])
  return { folder: FolderRow.parse(made), already: false, exposed: 0 }
}

export async function disconnectFolder(client: pg.PoolClient, instance: Instance, ask: DisconnectFolder): Promise<FolderAnswer> {
  const found = await maybe(client, `select ${FOLDER} from connected_folders where instance_id = $1 and path = $2 for update`, [instance.id, ask.path])
  if (!found) throw new HttpError(404, `${ask.path} was never connected on this Mac`)
  const folder = FolderRow.parse(found)
  if (folder.disconnected_at !== null) return { folder, already: true }
  const gone = await one(client, 'the disconnected folder',
    `update connected_folders set disconnected_at = now() where id = $1 returning ${FOLDER}`, [folder.id])
  return { folder: FolderRow.parse(gone), already: false }
}

// This Mac's connected folders, and by path how many sessions in the record each of its private folders holds,
// connected or not. The team can't see those, and choosing Team for the folder shows them, so the app asks first.
const CountedFolder = FolderRow.extend({ sessions: z.number().int().min(0) })
export async function connectedFolders(instance: Instance): Promise<Omit<FolderList, 'instanceId'>> {
  const rows = (await many(pool, `select ${FOLDER}, ${SESSIONS_OF('connected_folders.id')} as sessions
    from connected_folders where instance_id = $1 order by path`, [instance.id])).map((row) => CountedFolder.parse(row))
  return {
    folders: rows.filter((row) => row.disconnected_at === null).map(({ sessions, ...folder }) => folder),
    hiddenSessions: Object.fromEntries(rows.filter((row) => row.visibility === 'private').map((row) => [row.path, row.sessions])),
  }
}

// The record's session for a Claude Code session the Mac found in one of its
// connected folders. Asking twice gives the same session.
export async function terminalSession(client: pg.PoolClient, instance: Instance, ask: TerminalSessionAsk): Promise<SessionId> {
  const found = await maybe(client, `select ${FOLDER} from connected_folders where id = $1 and instance_id = $2`, [ask.folderId, instance.id])
  if (!found) throw new HttpError(404, 'no such folder on this Mac')
  const folder = FolderRow.parse(found)
  if (folder.disconnected_at !== null) throw new HttpError(409, `${folder.path} is disconnected, so its sessions stay on the Mac`)
  // The daemon scrubbed both. The API scrubs them again, as it does every event.
  const cwd = scrub(ask.cwd)
  const harnessSessionId = scrub(ask.harnessSessionId)
  if (!insideFolder(folder.path, cwd)) throw new HttpError(400, `${cwd} is outside ${folder.path}`)
  // A Claude Code session id already taken by another folder's session gets
  // nothing back, so one folder's transcript can't write into another's session.
  const session = await maybe<{ id: string }>(client,
    `insert into sessions (team_id, instance_id, folder_id, cwd, harness, harness_session_id, started_by)
     values ($1, $2, $3, $4, 'claude', $5, $6)
     on conflict (instance_id, harness_session_id) where folder_id is not null
       do update set harness_session_id = excluded.harness_session_id
       where sessions.folder_id = excluded.folder_id
     returning id`, [folder.team_id, instance.id, folder.id, cwd, harnessSessionId, folder.connected_by])
  if (!session) throw new HttpError(409, `Claude Code session ${harnessSessionId} is another connected folder's session on this Mac`)
  return SessionId.parse(session.id)
}

// Who writes a session's events from a machine, and which kinds it may write.
// The daemon runs an app session, whose person-written events come only through
// the API. A terminal session is a person's own: its prompts are theirs, and
// they answer Claude's questions in their terminal, so it has no asks.
export type SessionWriter =
  | { kind: 'app'; kinds: readonly EventKind[] }
  | { kind: 'terminal'; kinds: readonly EventKind[]; author: PersonId | null }

const APP_KINDS = EVENT_KINDS.filter((kind) => !PERSON_KINDS.includes(kind))
const TERMINAL_KINDS = EVENT_KINDS.filter((kind) => kind === 'user' || (kind !== 'ask' && !PERSON_KINDS.includes(kind)))

export async function sessionWriter(instance: Instance, sessionId: SessionId): Promise<SessionWriter> {
  // A folder connected again starts over, so a session made under its earlier
  // connection is closed like one whose folder is disconnected now.
  const session = await maybe<{ folder_id: string | null; connected_by: string | null; closed: boolean | null }>(pool,
    `select s.folder_id, f.connected_by, (f.disconnected_at is not null or s.created_at < f.connected_at) as closed
     from sessions s left join connected_folders f on f.id = s.folder_id where s.id = $1 and s.instance_id = $2`, [sessionId, instance.id])
  if (!session) throw new HttpError(404, 'no such session on this instance')
  if (session.folder_id === null) return { kind: 'app', kinds: APP_KINDS }
  if (session.closed) throw new HttpError(409, "this session's folder was disconnected since the session started, so the rest of it stays on the Mac")
  return { kind: 'terminal', kinds: TERMINAL_KINDS, author: session.connected_by === null ? null : PersonId.parse(session.connected_by) }
}
