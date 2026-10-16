// The routes for files in chats and tasks, reactions, and what a person can do to a
// chat post: edit, delete, pin. The agent side is here too, since an agent shares and
// reacts through the same record. The contract is docs/design/chat-attachments.md on
// branch ui, and docs/ui/feature-briefs.md sections 13 and 20.

import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import { readBody } from '../shared/body.ts'
import { dispositionOf, declaredType, MAX_ATTACHMENT_BYTES } from '../shared/attachments.ts'
import { Emoji } from '../shared/reactions.ts'
import { canSeeSession } from './access.ts'
import { agentScope } from './agent-scope.ts'
import { attachmentFor, attachmentForSession, readBytes, removeFiles, saveUpload, type AttachmentRow } from './attachments.ts'
import { maybe, one, pool, tx } from './db.ts'
import { Created, FileAnswer, parseBody, type Route } from './http.ts'
import { personFrom } from './auth.ts'
import { deleteMessage, editMessage, setPin } from './message-actions.ts'
import { HttpError, postableConversation } from './record.ts'
import { latestPersonPost, reactAsAgent, reactAsPerson } from './reactions.ts'
import { shareFromSession } from './share.ts'

const UUID = '([0-9a-f-]{36})'
const EVENT = '([0-9]{1,18})'

// The file an upload route carries: its bytes as the body, its name in X-File-Name, its type in Content-Type.
async function fileOf(req: IncomingMessage) {
  const header = req.headers['x-file-name']
  if (typeof header !== 'string' || header === '') throw new HttpError(400, 'X-File-Name must be the file name, URL-encoded')
  let name: string
  try {
    name = decodeURIComponent(header)
  } catch {
    throw new HttpError(400, 'X-File-Name must be the file name, URL-encoded')
  }
  const bytes = await readBody(req, MAX_ATTACHMENT_BYTES, () => new HttpError(413, 'That file is over 25 MB.'))
  return { bytes, name, declaredType: declaredType(req.headers['content-type']) }
}

// Uploading is not sending: the file waits for a post to carry it.
const uploaded = async (req: IncomingMessage, teamId: string, place: Parameters<typeof saveUpload>[1]['place'], personId: string) =>
  new Created(await saveUpload(pool, { teamId, place, by: { personId }, ...await fileOf(req) }))

const emojiOf = (value: string): string => {
  const emoji = Emoji.safeParse(value)
  if (!emoji.success) throw new HttpError(400, 'A reaction is one emoji of at most 32 bytes.')
  return emoji.data
}
// An emoji in a path arrives URL-encoded.
const emojiInPath = (value: string): string => {
  try {
    return emojiOf(decodeURIComponent(value))
  } catch (error) {
    if (error instanceof URIError) throw new HttpError(400, 'A reaction is one emoji of at most 32 bytes.')
    throw error
  }
}


// How a file is served. An image the bytes show is inline, and everything else is a download, so an
// uploaded page or SVG never runs on the app's origin. The file never changes, so it may be kept.
async function served(row: AttachmentRow, forceDownload: boolean): Promise<FileAnswer> {
  const inline = row.kind === 'image' && !forceDownload
  return new FileAnswer(await readBytes(row), {
    'content-type': row.media_type,
    'x-file-name': encodeURIComponent(row.name),
    'content-disposition': dispositionOf(inline ? 'inline' : 'attachment', row.name),
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  })
}

const Edit = z.object({ text: z.string() })
const ReactBody = z.object({ messageId: z.uuid().optional(), eventId: z.string().regex(/^[0-9]{1,18}$/).optional(), emoji: z.string(), remove: z.boolean().optional() })
  .refine((b) => b.messageId === undefined || b.eventId === undefined, 'name a messageId or an eventId, not both')

export const chatRoutes: Route[] = [
  ['people', 'POST', new RegExp(`^/v1/conversations/${UUID}/attachments$`), async (req, [conversationId]) => {
    const person = await personFrom(req)
    await postableConversation(pool, person, conversationId)
    return uploaded(req, person.team_id, { conversationId }, person.id)
  }],

  ['people', 'POST', new RegExp(`^/v1/sessions/${UUID}/attachments$`), async (req, [sessionId]) => {
    const person = await personFrom(req)
    const task = await maybe<{ task_id: string | null }>(pool, 'select task_id from sessions where id = $1 and team_id = $2', [sessionId, person.team_id])
    if (!task?.task_id || !(await canSeeSession(person, sessionId))) throw new HttpError(404, 'no such session')
    return uploaded(req, person.team_id, { sessionId }, person.id)
  }],

  // Before there is a place for the file: a New task, run or group chat claims it when it is made.
  ['people', 'POST', /^\/v1\/attachments$/, async (req) => {
    const person = await personFrom(req)
    return uploaded(req, person.team_id, null, person.id)
  }],

  ['people', 'GET', new RegExp(`^/v1/attachments/${UUID}$`), async (req, [id], url) => {
    const person = await personFrom(req)
    return served(await attachmentFor(person, id), url.searchParams.get('download') === '1')
  }],

  // The same bytes for an agent, to save in its working folder.
  ['machines', 'GET', new RegExp(`^/v1/record/attachments/${UUID}$`), async (req, [id], url) => {
    const { teamId, sessionId } = await agentScope(req, url)
    return served(await attachmentForSession(teamId, sessionId, id), true)
  }],

  // An agent posts a file or a screenshot into its chat, or onto its task's page.
  ['machines', 'POST', /^\/v1\/record\/share$/, async (req, _params, url) => {
    const { teamId, sessionId } = await agentScope(req, url)
    const caption = (url.searchParams.get('caption') ?? '').slice(0, 2000)
    return new Created(await shareFromSession({ teamId, sessionId, caption, ...await fileOf(req) }))
  }],

  ['people', 'PUT', new RegExp(`^/v1/messages/${UUID}/reactions/([^/]+)$`), async (req, [id, emoji]) => {
    const person = await personFrom(req)
    return tx((client) => reactAsPerson(client, person, { kind: 'message', id }, emojiInPath(emoji), true))
  }],
  ['people', 'DELETE', new RegExp(`^/v1/messages/${UUID}/reactions/([^/]+)$`), async (req, [id, emoji]) => {
    const person = await personFrom(req)
    return tx((client) => reactAsPerson(client, person, { kind: 'message', id }, emojiInPath(emoji), false))
  }],
  ['people', 'PUT', new RegExp(`^/v1/events/${EVENT}/reactions/([^/]+)$`), async (req, [id, emoji]) => {
    const person = await personFrom(req)
    return tx((client) => reactAsPerson(client, person, { kind: 'event', id }, emojiInPath(emoji), true))
  }],
  ['people', 'DELETE', new RegExp(`^/v1/events/${EVENT}/reactions/([^/]+)$`), async (req, [id, emoji]) => {
    const person = await personFrom(req)
    return tx((client) => reactAsPerson(client, person, { kind: 'event', id }, emojiInPath(emoji), false))
  }],

  // An agent reacts to a post in its chat or its task.
  ['machines', 'POST', /^\/v1\/record\/react$/, async (req, _params, url) => {
    const { teamId, sessionId } = await agentScope(req, url)
    const body = await parseBody(req, ReactBody)
    return tx(async (client) => {
      const session = await one<{ id: string; team_id: string; agent_id: string }>(client, 'the session', 'select id, team_id, agent_id from sessions where id = $1', [sessionId])
      const target = body.messageId !== undefined ? { kind: 'message' as const, id: body.messageId }
        : body.eventId !== undefined ? { kind: 'event' as const, id: body.eventId } : await latestPersonPost(client, session.id)
      return reactAsAgent(client, { ...session, team_id: teamId }, target, emojiOf(body.emoji), body.remove !== true)
    })
  }],

  ['people', 'PATCH', new RegExp(`^/v1/messages/${UUID}$`), async (req, [id]) => {
    const person = await personFrom(req)
    const body = await parseBody(req, Edit)
    return tx((client) => editMessage(client, person, id, body.text))
  }],

  ['people', 'DELETE', new RegExp(`^/v1/messages/${UUID}$`), async (req, [id]) => {
    const person = await personFrom(req)
    const files = await tx((client) => deleteMessage(client, person, id))
    await removeFiles(files)
    return { deleted: true }
  }],

  ['people', 'PUT', new RegExp(`^/v1/conversations/${UUID}/pins/${UUID}$`), async (req, [conversationId, messageId]) => {
    const person = await personFrom(req)
    return tx((client) => setPin(client, person, conversationId, messageId, true))
  }],
  ['people', 'DELETE', new RegExp(`^/v1/conversations/${UUID}/pins/${UUID}$`), async (req, [conversationId, messageId]) => {
    const person = await personFrom(req)
    return tx((client) => setPin(client, person, conversationId, messageId, false))
  }],
]
