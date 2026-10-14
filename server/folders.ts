// Connected folders and the terminal sessions in them. Only a Mac connects or
// disconnects its own folders, with its machine token, so no one in the app can
// make a person's sessions leave their Mac. The Mac's daemon reports each Claude
// Code session it finds in a connected folder, and this module gives it the
// record's session for it. The design is docs/design/local-sessions.md.

import type pg from 'pg'
import { many, maybe, one, pool } from './db.ts'
import { HttpError, scrub } from './record.ts'
import type { Instance } from './auth.ts'
import { PersonId } from '../shared/ids.ts'
import { EVENT_KINDS, type EventKind } from '../shared/types.ts'
import {
  FolderRow, insideFolder, type ConnectFolder, type DisconnectFolder, type FolderAnswer, type TerminalSessionAsk,
} from '../shared/terminal.ts'

const FOLDER = `id, team_id, instance_id, path, visibility, connected_by, connected_at::text, disconnected_at::text`

// The person whose terminal this Mac is. Their sessions are the ones a connected folder sends.
async function macOwner(client: pg.PoolClient, instance: Instance): Promise<PersonId> {
  const mac = await one<{ kind: string; owner_id: string | null }>(client, 'the calling machine',
    'select kind, owner_id from instances where id = $1 for update', [instance.id])
  if (mac.kind !== 'mac') throw new HttpError(409, 'Only a Mac connects folders. Boxes have no terminal of their own.')
  if (mac.owner_id === null) throw new HttpError(409, 'This Mac has no owner, so there is no one whose terminal sessions it could send.')
  return PersonId.parse(mac.owner_id)
}

export async function connectFolder(client: pg.PoolClient, instance: Instance, ask: ConnectFolder): Promise<FolderAnswer> {
  const owner = await macOwner(client, instance)
  const found = await maybe(client, `select ${FOLDER} from connected_folders where instance_id = $1 and path = $2`, [instance.id, ask.path])
  if (found) {
    const folder = FolderRow.parse(found)
    if (folder.disconnected_at === null && folder.visibility === ask.visibility) return { folder, already: true }
    // A folder connected again starts over: only sessions started from now on land.
    const again = await one(client, 'the folder connected again',
      `update connected_folders set visibility = $2, connected_by = $3,
         connected_at = case when disconnected_at is null then connected_at else now() end, disconnected_at = null
       where id = $1 returning ${FOLDER}`, [folder.id, ask.visibility, owner])
    return { folder: FolderRow.parse(again), already: false }
  }
  const made = await one(client, 'the new folder',
    `insert into connected_folders (team_id, instance_id, path, visibility, connected_by) values ($1, $2, $3, $4, $5)
     returning ${FOLDER}`, [instance.team_id, instance.id, ask.path, ask.visibility, owner])
  return { folder: FolderRow.parse(made), already: false }
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

export async function connectedFolders(instance: Instance): Promise<FolderRow[]> {
  const rows = await many(pool, `select ${FOLDER} from connected_folders where instance_id = $1 and disconnected_at is null order by path`, [instance.id])
  return rows.map((row) => FolderRow.parse(row))
}

// The record's session for a Claude Code session the Mac found in one of its
// connected folders. Asking twice gives the same session.
export async function terminalSession(client: pg.PoolClient, instance: Instance, ask: TerminalSessionAsk): Promise<string> {
  const found = await maybe(client, `select ${FOLDER} from connected_folders where id = $1 and instance_id = $2`, [ask.folderId, instance.id])
  if (!found) throw new HttpError(404, 'no such folder on this Mac')
  const folder = FolderRow.parse(found)
  if (folder.disconnected_at !== null) throw new HttpError(409, `${folder.path} is disconnected, so its sessions stay on the Mac`)
  // The daemon scrubbed both. The API scrubs them again, as it does every event.
  const cwd = scrub(ask.cwd)
  const harnessSessionId = scrub(ask.harnessSessionId)
  if (!insideFolder(folder.path, cwd)) throw new HttpError(400, `${cwd} is outside ${folder.path}`)
  const session = await one<{ id: string }>(client, 'the terminal session',
    `insert into sessions (team_id, instance_id, folder_id, cwd, harness, harness_session_id, started_by)
     values ($1, $2, $3, $4, 'claude', $5, $6)
     on conflict (instance_id, harness_session_id) where folder_id is not null
       do update set harness_session_id = excluded.harness_session_id
     returning id`, [folder.team_id, instance.id, folder.id, cwd, harnessSessionId, folder.connected_by])
  return session.id
}

// Who writes a session's events from a machine, and which kinds it may write.
// The daemon runs an app session, whose person-written events come only through
// the API. A terminal session is a person's own: its prompts are theirs, and
// they answer Claude's questions in their terminal, so it has no asks.
export type SessionWriter =
  | { kind: 'app'; kinds: readonly EventKind[] }
  | { kind: 'terminal'; kinds: readonly EventKind[]; author: string | null }

const APP_KINDS = EVENT_KINDS.filter((kind) => kind !== 'user' && kind !== 'answer')
const TERMINAL_KINDS = EVENT_KINDS.filter((kind) => kind !== 'ask' && kind !== 'answer')

export async function sessionWriter(instance: Instance, sessionId: string): Promise<SessionWriter> {
  const session = await maybe<{ folder_id: string | null; connected_by: string | null; disconnected: boolean | null }>(pool,
    `select s.folder_id, f.connected_by, f.disconnected_at is not null as disconnected
     from sessions s left join connected_folders f on f.id = s.folder_id where s.id = $1 and s.instance_id = $2`, [sessionId, instance.id])
  if (!session) throw new HttpError(404, 'no such session on this instance')
  if (session.folder_id === null) return { kind: 'app', kinds: APP_KINDS }
  if (session.disconnected) throw new HttpError(409, "this session's folder is disconnected, so its sessions stay on the Mac")
  return { kind: 'terminal', kinds: TERMINAL_KINDS, author: session.connected_by }
}
