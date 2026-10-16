// Files in chats and tasks. The row says whose file it is and where it sits, and
// the bytes live on disk in AGENTS_ATTACHMENTS_DIR, one file per row named by the
// row's id, so Postgres holds no file. A file is an upload first. A post claims it,
// and one that no post claims within PENDING_HOURS is deleted with its bytes.

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { hasCode, messageOf } from '../shared/errors.ts'
import { envSecrets } from '../shared/scrub.ts'
import { secretsIn } from '../shared/secret-scan.ts'
import {
  AttachmentId, cleanFileName, MAX_ATTACHMENT_BYTES, PENDING_HOURS, sortUpload, type UploadAnswer,
} from '../shared/attachments.ts'
import { canSeeConversation, canSeeSession } from './access.ts'
import { many, maybe, pool, type Db } from './db.ts'
import { HttpError, type Person } from './record.ts'
import { scopedTeams } from './runner.ts'

// Where the bytes live. Unless the server is told a folder, it is named for the database it serves, so every file
// in it has its row in that database. A server on agents_test then never reads the live server's folder, and the
// sweep for files with no row can't take live files for strays.
const DATABASE_NAME = z.string().regex(/^[A-Za-z0-9_-]+$/, 'a database name of letters, digits, dashes and low lines')
function attachmentsFolder(env: NodeJS.ProcessEnv): string {
  if (env.AGENTS_ATTACHMENTS_DIR) return env.AGENTS_ATTACHMENTS_DIR
  const url = z.url().safeParse(env.DATABASE_URL)
  const name = url.success ? DATABASE_NAME.safeParse(new URL(url.data).pathname.slice(1)) : null
  if (!name?.success) throw new Error('DATABASE_URL must name a database, or AGENTS_ATTACHMENTS_DIR a folder, so attachments know where to live')
  return join(env.AGENTS_HOME ?? join(homedir(), '.agents-app'), 'attachments', name.data)
}
export const ATTACHMENTS_DIR = attachmentsFolder(process.env)

const fileOf = (id: string) => join(ATTACHMENTS_DIR, id.slice(0, 2), id)

// The columns a row is read with, of the table under `alias`. A bigint comes back as text, so each is cast for the schema.
const columns = (alias: string) => ['id', 'team_id', 'conversation_id', 'session_id', 'message_id', 'kind', 'name', 'media_type', 'width', 'height',
  'added_by_person', 'added_by_agent'].map((c) => `${alias}.${c}`).concat(`${alias}.event_id::text as event_id`, `${alias}.size::int as size`).join(', ')
const COLUMNS = columns('attachments')

export const AttachmentRow = z.object({
  id: AttachmentId,
  team_id: z.uuid(),
  conversation_id: z.uuid().nullable(),
  session_id: z.uuid().nullable(),
  message_id: z.uuid().nullable(),
  event_id: z.string().nullable(),
  kind: z.enum(['image', 'file']),
  name: z.string(),
  media_type: z.string(),
  size: z.int(),
  width: z.int().nullable(),
  height: z.int().nullable(),
  added_by_person: z.uuid().nullable(),
  added_by_agent: z.uuid().nullable(),
})
export type AttachmentRow = z.infer<typeof AttachmentRow>

// Where an upload sits: in a chat, in a task's session, or nowhere yet.
export type Place = { conversationId: string } | { sessionId: string } | null
export type Uploader = { personId: string } | { agentId: string }

// Saves a file and its row. The bytes go to disk first, so a row never points at nothing, and a
// failed insert removes them again.
export async function saveUpload(db: Db, input: {
  teamId: string; place: Place; by: Uploader; bytes: Buffer; name: string; declaredType: string
}): Promise<UploadAnswer> {
  if (input.bytes.length === 0) throw new HttpError(400, 'That file is empty.')
  if (input.bytes.length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, `A file can be ${MAX_ATTACHMENT_BYTES} bytes at most.`)
  const sorted = sortUpload(input.bytes, input.declaredType)
  const id = AttachmentId.parse(randomUUID())
  const name = cleanFileName(input.name)
  await mkdir(join(ATTACHMENTS_DIR, id.slice(0, 2)), { recursive: true, mode: 0o700 })
  await writeFile(fileOf(id), input.bytes, { flag: 'wx', mode: 0o600 })
  try {
    await db.query(
      `insert into attachments (id, team_id, conversation_id, session_id, kind, name, media_type, size, width, height, added_by_person, added_by_agent)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, input.teamId, input.place && 'conversationId' in input.place ? input.place.conversationId : null,
        input.place && 'sessionId' in input.place ? input.place.sessionId : null, sorted.kind, name, sorted.mediaType, input.bytes.length,
        sorted.width, sorted.height, 'personId' in input.by ? input.by.personId : null, 'agentId' in input.by ? input.by.agentId : null])
  } catch (error) {
    await removeFiles([id])
    throw error
  }
  return {
    attachmentId: id, name, mediaType: sorted.mediaType, size: input.bytes.length, kind: sorted.kind,
    ...(sorted.width === null || sorted.height === null ? {} : { width: sorted.width, height: sorted.height }),
  }
}

// Where a post puts the files it claims.
export type Placement = { conversationId: string; messageId: string } | { sessionId: string; eventId: string }

// The uploads a person names for a post, checked and locked: each must be theirs, still pending, and
// either unplaced or already in the chat or session the post is for. A wrong id fails the post, naming the id.
export async function pendingUploads(
  client: Db, who: Pick<Person, 'id' | 'team_id'>, ids: readonly string[], scope: { conversationId?: string; sessionId?: string },
): Promise<AttachmentRow[]> {
  const rows = (await many(client, `select ${COLUMNS} from attachments where id = any($1) and team_id = $2 for update`, [ids, who.team_id]))
    .map((row) => AttachmentRow.parse(row))
  return ids.map((id) => {
    const row = rows.find((r) => r.id === id)
    const here = row && ((row.conversation_id === null && row.session_id === null)
      || (scope.conversationId !== undefined && row.conversation_id === scope.conversationId)
      || (scope.sessionId !== undefined && row.session_id === scope.sessionId))
    if (!row || !here || row.added_by_person !== who.id || row.message_id !== null || row.event_id !== null) {
      throw new HttpError(400, `attachmentIds: ${id} is not a pending upload of yours for this post`)
    }
    return row
  })
}

// Puts uploads in their place, on the post that carries them.
export async function placeUploads(client: Db, ids: readonly string[], place: Placement) {
  await client.query(
    `update attachments set conversation_id = $2, session_id = $3, message_id = $4, event_id = $5 where id = any($1)`,
    [ids, 'conversationId' in place ? place.conversationId : null, 'sessionId' in place ? place.sessionId : null,
      'messageId' in place ? place.messageId : null, 'eventId' in place ? place.eventId : null])
}

type Described = { id: string; name: string; media_type: string; size: number }

// What an agent is told of the files on a post, in the words of the prompt it gets.
export function filesNote(files: readonly Described[]): string {
  if (files.length === 0) return ''
  return `Attached files:\n${files.map((f) => `- ${f.name} (${f.media_type}, ${f.size} bytes), attachment ${f.id}`).join('\n')}\n`
    + 'Save one into your working folder with the team-record tool get_attachment.'
}

// A post's text and its files as one prompt.
export const withFiles = (text: string, files: readonly Described[]) => [text, filesNote(files)].filter(Boolean).join('\n\n')

// A file a person may open, or 404. A pending upload is its uploader's alone. A sent one follows the
// chat or the task session it sits in.
export async function attachmentFor(person: Person, id: string): Promise<AttachmentRow> {
  const row = await maybe(pool, `select ${COLUMNS} from attachments where id = $1 and team_id = $2`, [id, person.team_id])
  const found = row && AttachmentRow.parse(row)
  const sent = found && (found.message_id !== null || found.event_id !== null)
  const allowed = found && (sent
    ? found.conversation_id !== null ? await canSeeConversation(person, found.conversation_id)
      : found.session_id !== null && await canSeeSession(person, found.session_id)
    : found.added_by_person === person.id)
  if (!found || !allowed) throw new HttpError(404, 'no such attachment')
  return found
}

// A file an agent's session may open: one sent in its chat, or in its task's sessions.
export async function attachmentForSession(teamId: string, sessionId: string, id: string): Promise<AttachmentRow> {
  const row = await maybe(pool,
    `select ${columns('a')}
     from attachments a
     join sessions s on s.id = $3
     where a.id = $1 and a.team_id = $2 and (a.message_id is not null or a.event_id is not null)
       and (a.conversation_id = s.conversation_id
         or a.session_id in (select id from sessions where task_id = s.task_id and s.task_id is not null))`,
    [id, teamId, sessionId])
  if (!row) throw new HttpError(404, 'no such attachment in this chat or task')
  return AttachmentRow.parse(row)
}

export async function readBytes(row: Pick<AttachmentRow, 'id'>): Promise<Buffer> {
  try {
    return await readFile(fileOf(row.id))
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
    throw new HttpError(404, 'That file is no longer stored.')
  }
}

// Removes the bytes of rows already deleted. It runs after the delete commits, so a rolled-back
// delete never loses a file, and a crash between the two leaves bytes the sweep finds.
export async function removeFiles(ids: readonly string[]) {
  await Promise.all(ids.map((id) => rm(fileOf(id), { force: true })))
}

// A file an agent shares can't be sent if its bytes hold a secret this server knows. The machine checks
// the secrets only it knows before the file is sent (daemon/share-guard.ts), and this is the second look.
export function refuseSecret(bytes: Buffer) {
  if (secretsIn(bytes, envSecrets(process.env)).length > 0) throw new HttpError(400, 'That file holds a secret this team keeps, so it was not shared.')
}

// Files that sit in the store with no row, from an upload that crashed between the two. A file is
// left alone for this long first, since its row may be a moment behind it.
const ORPHAN_GRACE_MS = 60 * 60 * 1000
const SWEEP_SECONDS = z.coerce.number().int().min(1).default(600)

async function sweepOnce() {
  const teams = await scopedTeams()
  const gone = await many<{ id: string }>(pool,
    `delete from attachments where message_id is null and event_id is null
       and created_at < now() - make_interval(hours => $1) and ($2::uuid[] is null or team_id = any($2)) returning id`,
    [PENDING_HOURS, teams])
  await removeFiles(gone.map((r) => r.id))
  for (const shard of await readdir(ATTACHMENTS_DIR).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return []
    throw error
  })) {
    const names = await readdir(join(ATTACHMENTS_DIR, shard))
    const old: string[] = []
    for (const name of names) {
      if ((await stat(join(ATTACHMENTS_DIR, shard, name))).mtimeMs < Date.now() - ORPHAN_GRACE_MS) old.push(name)
    }
    if (old.length === 0) continue
    const kept = new Set((await many<{ id: string }>(pool, 'select id from attachments where id = any($1::uuid[])', [old.filter((n) => z.uuid().safeParse(n).success)])).map((r) => r.id))
    await removeFiles(old.filter((name) => !kept.has(name)))
  }
}

// Starts the sweep and returns what stops it.
export function startAttachmentSweep(): () => void {
  const every = SWEEP_SECONDS.parse(process.env.AGENTS_ATTACHMENT_SWEEP_SECONDS) * 1000
  const timer = setInterval(() => {
    sweepOnce().catch((error: unknown) => { console.error('attachment sweep:', messageOf(error)) })
  }, every)
  return () => { clearInterval(timer) }
}

// Deletes the rows of a post's files and returns their ids, for removeFiles once the delete commits.
export async function deleteAttachmentsOf(client: Db, target: { messageId: string } | { eventId: string }): Promise<string[]> {
  const rows = await many<{ id: string }>(client,
    `delete from attachments where ${'messageId' in target ? 'message_id' : 'event_id'} = $1 returning id`,
    ['messageId' in target ? target.messageId : target.eventId])
  return rows.map((r) => r.id)
}
