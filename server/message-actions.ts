// What a person can do to a chat post after it is sent: edit their own words,
// delete a post, pin it. A deleted post stays as a placeholder in the order of the
// chat, with no text, no versions and no files.

import type pg from 'pg'
import { canSeeConversation } from './access.ts'
import { deleteAttachmentsOf } from './attachments.ts'
import { maybe, one } from './db.ts'
import { HttpError, scrub, type Person } from './record.ts'

type Post = { id: string; conversation_id: string; speaker: 'person' | 'agent'; person_id: string | null; body: string | null; deleted: boolean }

// A post the person can see, locked, or 404.
async function visiblePost(client: pg.PoolClient, person: Person, messageId: string): Promise<Post> {
  const post = await maybe<Post>(client,
    `select id, conversation_id, speaker, person_id, body, deleted_at is not null as deleted
     from messages where id = $1 and team_id = $2 for update`, [messageId, person.team_id])
  if (!post || !(await canSeeConversation(person, post.conversation_id))) throw new HttpError(404, 'no such post')
  return post
}

// Changes the words of a person's own post. The text it had stays as a version. Only the author may,
// since changing someone else's words misrepresents them.
export async function editMessage(client: pg.PoolClient, person: Person, messageId: string, text: string): Promise<{ editedAt: string | null }> {
  const post = await visiblePost(client, person, messageId)
  if (post.speaker !== 'person' || post.person_id !== person.id) throw new HttpError(403, 'Only the author can edit a post.')
  if (post.deleted || post.body === null) throw new HttpError(409, 'That post was deleted.')
  const next = scrub(text)
  if (next.trim() === '' && !await maybe(client, 'select 1 from attachments where message_id = $1', [messageId])) {
    throw new HttpError(400, 'text must be non-empty, since the post has no files')
  }
  if (next !== post.body) {
    await client.query('insert into message_versions (message_id, body, edited_by) values ($1, $2, $3)', [messageId, post.body, person.id])
    await client.query('update messages set body = $2, edited_at = now() where id = $1', [messageId, next])
  }
  const row = await one<{ edited_at: string | null }>(client, 'the post', 'select edited_at::text from messages where id = $1', [messageId])
  return { editedAt: row.edited_at }
}

// Deletes a post: its author may, and so may a team admin. The row stays with `deleted_at` and
// `deleted_by`, and the text, the earlier versions, the files, the reactions and the pin go. The
// prompt copies the post made for its agent go too: the user event, the turn and the command.
// Returns the ids of the files, for removeFiles once the delete commits. Deleting a deleted post is a no-op.
export async function deleteMessage(client: pg.PoolClient, person: Person, messageId: string): Promise<string[]> {
  const post = await visiblePost(client, person, messageId)
  if (post.deleted) return []
  const author = post.speaker === 'person' && post.person_id === person.id
  if (!author && person.role !== 'admin') throw new HttpError(403, 'Only the author or a team admin can delete a post.')
  await client.query('update messages set body = null, deleted_at = now(), deleted_by = $2 where id = $1', [messageId, person.id])
  await client.query('delete from message_versions where message_id = $1', [messageId])
  await client.query('delete from reactions where message_id = $1', [messageId])
  await client.query('delete from pins where message_id = $1', [messageId])
  const files = await deleteAttachmentsOf(client, { messageId })
  // The event behind a DM post is keyed by the message, and carries the same words as its turn and command.
  const events = await client.query<{ id: string }>(
    `update events set text = null, body = jsonb_build_object('messageId', $2::text, 'deleted', true)
     where client_id = $1 returning id`, [`message:${messageId}`, messageId])
  const eventIds = events.rows.map((e) => e.id)
  await client.query(`update turns set payload = jsonb_set(payload, '{text}', '""') where event_id = any($1) and payload is not null`, [eventIds])
  await client.query(`update commands set payload = jsonb_set(payload, '{text}', '""') where event_id = any($1) and kind = 'message'`, [eventIds])
  return files
}

// Pins a post in its chat, or takes the pin off. Anyone who can see the chat may.
export async function setPin(client: pg.PoolClient, person: Person, conversationId: string, messageId: string, on: boolean): Promise<{ pinned: boolean }> {
  if (!(await canSeeConversation(person, conversationId))) throw new HttpError(404, 'no such conversation')
  const post = await maybe<{ deleted: boolean }>(client,
    'select deleted_at is not null as deleted from messages where id = $1 and conversation_id = $2', [messageId, conversationId])
  if (!post) throw new HttpError(404, 'no such post in this chat')
  if (on) {
    if (post.deleted) throw new HttpError(409, 'That post was deleted.')
    await client.query(
      'insert into pins (conversation_id, message_id, team_id, pinned_by) values ($1, $2, $3, $4) on conflict do nothing',
      [conversationId, messageId, person.team_id, person.id])
  } else {
    await client.query('delete from pins where conversation_id = $1 and message_id = $2', [conversationId, messageId])
  }
  return { pinned: on }
}
