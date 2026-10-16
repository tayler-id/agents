// What a person can do to a chat post after it is sent: edit their own words,
// delete a post, pin it. A deleted post stays as a placeholder in the order of the
// chat, with no text, no versions and no files.

import type pg from 'pg'
import { canSeeConversation } from './access.ts'
import { deleteAttachmentsOf } from './attachments.ts'
import { cancelWaitingTurn } from './scheduler.ts'
import { TurnId } from '../shared/ids.ts'
import { maybe, one } from './db.ts'
import { HttpError, scrub, type Person } from './record.ts'

type Post = { id: string; conversation_id: string; speaker: 'person' | 'agent'; person_id: string | null; body: string; deleted: boolean }

// A post the person can see, locked, or 404. The chat's row is locked first, as posting and the room's next turn
// do, so a delete and a turn that is reading the chat's posts take their turns.
async function visiblePost(client: pg.PoolClient, person: Person, messageId: string): Promise<Post> {
  const where = await maybe<{ conversation_id: string }>(client, 'select conversation_id from messages where id = $1 and team_id = $2', [messageId, person.team_id])
  if (where) await client.query('select 1 from conversations where id = $1 for update', [where.conversation_id])
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
  if (post.deleted) throw new HttpError(409, 'That post was deleted.')
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

// What stands where a deleted post's words were, in a prompt that carried them among others.
const GONE = '[deleted post]'
// A reply's prompt quotes this many characters of the post it answers (record.ts).
const QUOTED_CHARS = 200

// Takes a deleted post's words out of every prompt record that carries them. The post's own event is wiped. A
// room turn's event lists the posts it quoted in `messageIds`, and a reply's names the one it answers in
// `quotedMessageId`, so only those events lose the words, replaced where they stood. A turn or command that waits
// for its machine is cancelled with the post's own, and the others lose the words in their payloads. The replayed
// raw lines of the chat's sessions lose them too. `texts` holds the post's words and every version they had.
async function eraseCopies(client: pg.PoolClient, post: Post, texts: string[]) {
  const sessions = (await client.query<{ id: string }>('select id from sessions where conversation_id = $1', [post.conversation_id])).rows.map((r) => r.id)
  const own = (await client.query<{ id: string }>(
    `update events set text = null, body = jsonb_build_object('messageId', $2::text, 'deleted', true)
     where session_id = any($1) and body->>'messageId' = $2 returning id`, [sessions, post.id])).rows.map((e) => e.id)
  const carrying = (await client.query<{ id: string }>(
    `select id from events where session_id = any($1) and (body->'messageIds' ? $2 or body->>'quotedMessageId' = $2)`, [sessions, post.id])).rows.map((e) => e.id)
  for (const text of texts) {
    const quoted = text.slice(0, QUOTED_CHARS)
    for (const t of text === quoted ? [text] : [text, quoted]) {
      await client.query(
        `update events set text = replace(text, $2, $3), body = case when body ? 'text' then jsonb_set(body, '{text}', to_jsonb(replace(body->>'text', $2, $3))) else body end
         where id = any($1)`, [carrying, t, GONE])
      await client.query(
        `update turns set payload = jsonb_set(payload, '{text}', to_jsonb(replace(payload->>'text', $2, $3))) where event_id = any($1) and payload ? 'text'`, [carrying, t, GONE])
      await client.query(
        `update commands set payload = jsonb_set(payload, '{text}', to_jsonb(replace(payload->>'text', $2, $3))) where event_id = any($1) and kind = 'message' and payload ? 'text'`, [carrying, t, GONE])
      // A line is JSON, so the words are in it as JSON writes them.
      await client.query(
        `update raw_events set line = jsonb_build_object('erased', true)
         where session_id = any($1) and strpos(line::text, substr(to_jsonb($2::text)::text, 2, length(to_jsonb($2::text)::text) - 2)) > 0`, [sessions, t])
    }
  }
  // The post's own prompt is blanked, or the turn is cancelled when its machine has not got it yet.
  const turns = (await client.query<{ id: string }>(`select id from turns where event_id = any($1) and status in ('queued', 'waiting') for update`, [own])).rows
  for (const turn of turns) await cancelWaitingTurn(client, TurnId.parse(turn.id))
  await client.query(`update turns set payload = jsonb_set(payload, '{text}', '""') where event_id = any($1) and payload ? 'text'`, [own])
  await client.query(`update commands set payload = jsonb_set(payload, '{text}', '""') where event_id = any($1) and kind = 'message' and payload ? 'text'`, [own])
}

// Deletes a post: its author may, and so may a team admin. The row stays with `deleted_at` and
// `deleted_by` and an empty body, and the text, the earlier versions, the files, the reactions and the pin go.
// So do the copies in the prompts and raw lines behind it (eraseCopies). What an agent wrote after reading it,
// and what it remembered, stays. Returns the ids of the files, for removeFiles once the delete commits.
// Deleting a deleted post is a no-op.
export async function deleteMessage(client: pg.PoolClient, person: Person, messageId: string): Promise<string[]> {
  const post = await visiblePost(client, person, messageId)
  if (post.deleted) return []
  const author = post.speaker === 'person' && post.person_id === person.id
  if (!author && person.role !== 'admin') throw new HttpError(403, 'Only the author or a team admin can delete a post.')
  const versions = (await client.query<{ body: string }>('select body from message_versions where message_id = $1', [messageId])).rows.map((r) => r.body)
  const texts = [post.body, ...versions].filter((t) => t !== '')
  await client.query(`update messages set body = '', deleted_at = now(), deleted_by = $2 where id = $1`, [messageId, person.id])
  await client.query('delete from message_versions where message_id = $1', [messageId])
  await client.query('delete from reactions where message_id = $1', [messageId])
  await client.query('delete from pins where message_id = $1', [messageId])
  const files = await deleteAttachmentsOf(client, { messageId })
  await eraseCopies(client, post, texts)
  return files
}

// Pins a post in its chat, or takes the pin off. Anyone who can see the chat may.
export async function setPin(client: pg.PoolClient, person: Person, conversationId: string, messageId: string, on: boolean): Promise<{ pinned: boolean }> {
  if (!(await canSeeConversation(person, conversationId))) throw new HttpError(404, 'no such conversation')
  const post = await maybe<{ deleted: boolean }>(client,
    'select deleted_at is not null as deleted from messages where id = $1 and conversation_id = $2 for share', [messageId, conversationId])
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
