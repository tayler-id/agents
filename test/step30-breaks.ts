// Watches step30a's, step30b's and step30c's checks fail. First it runs each check with nothing broken, as a
// control. Then for each break it copies the files the break touches aside, applies its edits (each anchor must
// be in its file exactly once, or nothing is written), runs the check the break names, and confirms that the
// lines it names went red. Last it puts every file back byte for byte and confirms its sha256. A run killed
// midway puts the files back when it next starts. Nothing else may run in this folder while it does, since the
// edits are in the tree.
//   node --env-file=.env --env-file=.env.test test/step30-breaks.ts               the controls, then every break
//   node --env-file=.env --env-file=.env.test test/step30-breaks.ts cap           only the breaks named
//   node test/step30-breaks.ts --check                                             each anchor is there once, and nothing runs

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const ROOT = new URL('..', import.meta.url).pathname
const WORK = join(ROOT, '.scratch', 'verify', 'breaks-30')
const BACKUP = join(WORK, 'backup')
const PENDING = join(WORK, 'pending.json')
// Each check takes under ten seconds. A break that hangs one is cut off here.
const RUN_TIMEOUT_MS = 3 * 60 * 1000

type Edit = { file: string; anchor: string; replace: string }
type CheckName = 'step30a' | 'step30b' | 'step30c'
// `red` holds a piece of each check line the break must turn red.
type Break = { name: string; check: CheckName; why: string; red: string[]; edits: Edit[] }

const ATTACHMENTS = 'server/attachments.ts'
const ROUTES = 'server/chat-routes.ts'
const ACTIONS = 'server/message-actions.ts'
const REACTIONS = 'server/reactions.ts'
const SYNC = 'server/sync.ts'

const BREAKS: Break[] = [
  // What is an image, and how a file is served.
  { name: 'trust-declared', check: 'step30a', why: "a file is an image because its sender said so, not because its bytes are one", red: ['HTML sent as image/png is a file and downloads'],
    edits: [{ file: 'shared/attachments.ts', anchor: '  const image = sniffImage(bytes)\n', replace: "  const image = sniffImage(bytes) ?? (declared === 'image/png' ? 'image/png' : null)\n" }] },
  { name: 'inline-everything', check: 'step30a', why: 'every file shows inline, so an uploaded page runs on the app origin', red: ['an HTML file is a file that downloads', 'an SVG is a file and downloads'],
    edits: [{ file: ROUTES, anchor: "  const inline = row.kind === 'image' && !forceDownload\n", replace: '  const inline = !forceDownload\n' }] },
  { name: 'download-flag', check: 'step30a', why: '?download=1 is ignored, so an image cannot be saved', red: ['?download=1 downloads the image too'],
    edits: [{ file: ROUTES, anchor: "  const inline = row.kind === 'image' && !forceDownload\n", replace: "  const inline = row.kind === 'image'\n" }] },
  { name: 'header-required', check: 'step30a', why: 'an upload needs no X-File-Name, so a form posted from another site can upload as a person', red: ['an upload with no X-File-Name is refused'],
    edits: [{ file: 'server/api.ts', anchor: " && UPLOAD.test(url.pathname) && req.headers['x-file-name'] !== undefined)) {", replace: ' && UPLOAD.test(url.pathname))) {' }] },
  // The cap.
  { name: 'cap-off-by-one', check: 'step30a', why: 'a file of exactly 25 MB is turned away', red: ['a file of exactly 25 MB is taken'],
    edits: [{ file: ATTACHMENTS, anchor: '  if (input.bytes.length > MAX_ATTACHMENT_BYTES) throw', replace: '  if (input.bytes.length >= MAX_ATTACHMENT_BYTES) throw' }] },
  { name: 'cap', check: 'step30a', why: 'a file over 25 MB is taken', red: ['a file one byte over 25 MB answers 413'],
    edits: [
      { file: ROUTES, anchor: 'readBody(req, MAX_ATTACHMENT_BYTES, ()', replace: 'readBody(req, MAX_ATTACHMENT_BYTES * 2, ()' },
      { file: ATTACHMENTS, anchor: '  if (input.bytes.length > MAX_ATTACHMENT_BYTES) throw', replace: '  if (false) throw' },
    ] },
  // Who sees a file.
  { name: 'pending-open', check: 'step30a', why: "anyone who can see the chat opens a file its uploader has not sent", red: ["cannot open her pending upload", "cannot open alice's pending draft in the room"],
    edits: [{ file: ATTACHMENTS, anchor: '    : found.added_by_person === person.id)', replace: '    : true)' }] },
  { name: 'chat-access', check: 'step30a', why: 'a file in a private chat opens for anyone on the team', red: ['bob gets 404 and no bytes for a file in a private room'],
    edits: [{ file: ATTACHMENTS, anchor: '    ? found.conversation_id !== null ? await canSeeConversation(person, found.conversation_id)', replace: '    ? found.conversation_id !== null ? true' }] },
  { name: 'upload-access', check: 'step30a', why: 'anyone on the team uploads to any chat', red: ["bob cannot upload to alice's DM", 'carol cannot upload to a private room'],
    edits: [{ file: ROUTES, anchor: '    await postableConversation(pool, person, conversationId)\n', replace: '' }] },
  { name: 'session-access', check: 'step30a', why: "anyone on the team uploads to a private task's session", red: ["bob cannot upload to a private task's session"],
    edits: [{ file: ROUTES, anchor: '    if (!task?.task_id || !(await canSeeSession(person, sessionId))) throw', replace: '    if (!task?.task_id) throw' }] },
  { name: 'shape-pending', check: 'step30a', why: "the attachments shape shows a file nobody has sent to everyone in the chat", red: ["bob's attachments shape for the room has room.png and not alice's pending draft"],
    edits: [{ file: SYNC, anchor: 'added_by_person = $2)`,', replace: 'added_by_person = $2 or true)`,' }] },
  { name: 'shape-chat', check: 'step30b', why: "the pins shape of a private chat is open to anyone", red: ['a person outside a private chat cannot pin in it or read its pins'],
    edits: [{ file: SYNC, anchor: "where: 'conversation_id = $1', params: [await requireConversation(p, args)] }),\n  // Sessions the person may see", replace: "where: 'conversation_id = $1', params: [arg(args, 'conversation')] }),\n  // Sessions the person may see" }] },
  { name: 'shape-session', check: 'step30a', why: "a private task's attachments shape is open to anyone", red: ["bob cannot read a private task's attachments shape"],
    edits: [{ file: SYNC, anchor: "    if (!(await canSeeSession(person, id))) throw new HttpError(404, 'no such session')\n    return { column: 'session_id', id }", replace: "    return { column: 'session_id', id }" }] },
  // Sending files.
  { name: 'claim-owner', check: 'step30a', why: "a post carries another person's pending upload", red: ["carol's pending upload cannot ride on alice's post"],
    edits: [{ file: ATTACHMENTS, anchor: 'row.added_by_person !== who.id || row.message_id !== null || row.event_id !== null', replace: 'row.message_id !== null || row.event_id !== null' }] },
  { name: 'claim-twice', check: 'step30a', why: 'a file already sent rides on another post', red: ['a file already sent cannot ride on another post'],
    edits: [{ file: ATTACHMENTS, anchor: 'row.added_by_person !== who.id || row.message_id !== null || row.event_id !== null', replace: 'row.added_by_person !== who.id' }] },
  { name: 'agent-not-told', check: 'step30a', why: 'the agent is never told a post carries files', red: ["the agent's prompt names each file and the tool that saves it", 'the message command to the machine carries the same words'],
    edits: [{ file: ATTACHMENTS, anchor: '  if (files.length === 0) return \'\'\n', replace: "  return ''\n" }] },
  { name: 'task-first-post', check: 'step30a', why: "a new task's files are never put in its session", red: ["the file is in the new task's session, on its first post"],
    edits: [{ file: 'server/api.ts', anchor: '        await placeUploads(client, files.map((f) => f.id), { sessionId: started.sessionId, eventId: first.id })\n', replace: '' }] },
  { name: 'draft-files', check: 'step30a', why: 'a draft task takes files it can never give the agent', red: ['a draft task refuses attachments by saying so'],
    edits: [{ file: 'server/api.ts', anchor: "    if (attachmentIds && task.draft) throw new HttpError(400, 'A draft takes no attachments yet. Attach files when the task starts.')\n", replace: '' }] },
  { name: 'first-post', check: 'step30a', why: "a new group chat drops its first post's files", red: ['the file is in the new chat, on its first post'],
    edits: [{ file: 'server/api.ts', anchor: "{ attachmentIds: post.attachmentIds ?? [] })", replace: '{})' }] },
  { name: 'room-files', check: 'step30a', why: "a room's agent is never told of the files on a post", red: ["the agent's room turn names the file"],
    edits: [{ file: 'server/rooms.ts', anchor: '${withFiles(m.body, files.filter((f) => f.message_id === m.id))}', replace: '${m.body}' }] },
  { name: 'folder-shared', check: 'step30a', why: "every database's server keeps its files in one folder, so a test server sweeps the live server's files", red: ["leaves another database's files alone"],
    edits: [{ file: ATTACHMENTS, anchor: "'attachments', name.data)", replace: "'attachments')" }] },
  // The sweep.
  { name: 'sweep-off', check: 'step30a', why: 'pending uploads are never deleted', red: ['a pending upload older than 24 hours is deleted', 'a stored file with no row is removed after an hour'],
    edits: [{ file: ATTACHMENTS, anchor: '    sweepOnce().catch(', replace: '    Promise.resolve().catch(' }] },
  { name: 'sweep-sent', check: 'step30a', why: 'the sweep deletes sent files too', red: ['a file that a post carries stays, however old'],
    edits: [{ file: ATTACHMENTS, anchor: '`delete from attachments where message_id is null and event_id is null\n       and created_at', replace: '`delete from attachments where true\n       and created_at' }] },
  { name: 'sweep-young', check: 'step30a', why: 'the sweep deletes uploads before a day is up', red: ['a pending upload of 23 hours is kept'],
    edits: [{ file: 'shared/attachments.ts', anchor: 'export const PENDING_HOURS = 24', replace: 'export const PENDING_HOURS = 22' }] },
  { name: 'orphan-grace', check: 'step30a', why: 'the sweep removes a file the moment it is written, before its row', red: ['a fresh one is left alone'],
    edits: [{ file: ATTACHMENTS, anchor: 'const ORPHAN_GRACE_MS = 60 * 60 * 1000', replace: 'const ORPHAN_GRACE_MS = -60 * 1000' }] },
  // What agents do with files.
  { name: 'share-escape', check: 'step30c', why: 'share_file reads any file on the machine', red: ['share_file refuses a path up out of the folder', 'share_file refuses an absolute path elsewhere', 'a link inside the folder to a file outside it'],
    edits: [{ file: 'daemon/record-mcp.ts', anchor: "  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw", replace: '  if (false) throw' }] },
  { name: 'guard-skipped', check: 'step30c', why: "share_file shares a file whose secret the machine keeps", red: ['share_file refuses plain.txt', 'share_file refuses dump.bin', 'copy-of-env.txt'],
    edits: [{ file: 'daemon/record-mcp.ts', anchor: '  if (held.length) throw', replace: '  if (false) throw' }] },
  { name: 'guard-unreachable', check: 'step30c', why: "a machine whose daemon can't check a file shares it anyway", red: ["a machine whose guard can't be reached shares nothing"],
    edits: [{ file: 'daemon/share-client.ts', anchor: '    if (!guardSocket) {\n      reject(', replace: '    if (!guardSocket) {\n      resolve([])\n      reject(' }] },
  { name: 'scan-utf16', check: 'step30c', why: 'a secret in a UTF-16 file goes unseen', red: ['share_file refuses wide.txt'],
    edits: [{ file: 'shared/secret-scan.ts', anchor: ", bytes.toString('utf16le'), bytes.subarray(1).toString('utf16le')]", replace: ']' }] },
  { name: 'scan-dotenv', check: 'step30c', why: "the agent's own .env values are not secrets to the guard", red: ['share_file refuses copy-of-env.txt'],
    edits: [{ file: 'daemon/share-guard.ts', anchor: ', ...dotenvSecrets(find(root))]', replace: ']' }] },
  { name: 'api-second-look', check: 'step30c', why: 'the API shares a file with a secret it knows', red: ['the API looks again'],
    edits: [{ file: ATTACHMENTS, anchor: '  if (secretsIn(bytes, envSecrets(process.env)).length > 0) throw', replace: '  if (false) throw' }] },
  { name: 'caption-scrub', check: 'step30c', why: "an agent's caption goes out unscrubbed", red: ['a secret in a caption is scrubbed'],
    edits: [{ file: 'server/record.ts', anchor: '      scrub(message.body), message.sessionId', replace: '      message.body, message.sessionId' }] },
  { name: 'save-other-chat', check: 'step30c', why: "an agent saves a file from a chat that is not its own", red: ['a file from another chat is not available to this session'],
    edits: [{ file: ATTACHMENTS, anchor: '       and (a.conversation_id = s.conversation_id\n', replace: '       and (true or a.conversation_id = s.conversation_id\n' }] },
  { name: 'save-unsent', check: 'step30c', why: "an agent saves a file nobody has sent yet", red: ['a file nobody has sent yet is not available to the agent'],
    edits: [{ file: ATTACHMENTS, anchor: ' and (a.message_id is not null or a.event_id is not null)\n', replace: '\n' }] },
  { name: 'task-share', check: 'step30c', why: "a share in a task's session is not a share event the page can find", red: ['in a task session a share is a notice event with the caption'],
    edits: [{ file: 'server/share.ts', anchor: "body: { subtype: 'share',", replace: "body: { subtype: 'shared',"}] },
  { name: 'screen-secret', check: 'step30c', why: 'share_screen shares the screen while a page shows a secret', red: ['nothing is shared while a page shows a secret the box holds'],
    edits: [{ file: 'daemon/computer-mcp.ts', anchor: '  // The shot is read for secrets once it is taken, as a saved screenshot is.\n  const secretShown = await secretRefusal()\n  if (secretShown) return secretShown\n', replace: '' }] },
  // Reactions.
  { name: 'react-twice', check: 'step30b', why: 'putting a reaction twice makes two', red: ['putting 👍 twice leaves one reaction'],
    edits: [{ file: REACTIONS, anchor: ' on conflict do nothing`,', replace: '`,' }] },
  { name: 'react-visible', check: 'step30b', why: 'anyone on the team reacts in a private chat', red: ['a person outside a private chat cannot react'],
    edits: [{ file: REACTIONS, anchor: "  if (!post || !visible) throw new HttpError(404, 'no such post')", replace: "  if (!post) throw new HttpError(404, 'no such post')" }] },
  { name: 'unreact-others', check: 'step30b', why: "removing a reaction removes everyone's", red: ["removing a reaction takes only your own"],
    edits: [{ file: REACTIONS, anchor: '         and person_id is not distinct from $4 and agent_id is not distinct from $5`,', replace: '         and ($4::uuid is null or $5::uuid is null or true)`,' }] },
  { name: 'emoji-any', check: 'step30b', why: 'any text is a reaction', red: ['a letter is not a reaction', 'two emoji is not a reaction'],
    edits: [{ file: 'shared/reactions.ts', anchor: '  return parts.length === 1 && EMOJI.test(value)', replace: '  return parts.length > 0' }] },
  { name: 'emoji-bytes', check: 'step30b', why: 'a reaction is as long as the sender likes', red: ['one emoji of 35 bytes is not a reaction'],
    edits: [{ file: 'shared/reactions.ts', anchor: '  if (Buffer.byteLength(value) > MAX_EMOJI_BYTES) return false\n', replace: '' }] },
  { name: 'react-deleted', check: 'step30b', why: 'a deleted post takes reactions', red: ['a deleted post takes no reaction, edit, pin or reply'],
    edits: [{ file: REACTIONS, anchor: "    if (post.deleted) throw new HttpError(409, 'That post was deleted.')\n", replace: '' }] },
  { name: 'react-tool-latest', check: 'step30b', why: "the react tool picks the oldest post, not the latest", red: ["reacts to the person's latest post"],
    edits: [{ file: REACTIONS, anchor: "where s.id = $1 and m.speaker = 'person' and m.deleted_at is null order by m.seq desc limit 1", replace: "where s.id = $1 and m.speaker = 'person' and m.deleted_at is null order by m.seq asc limit 1" }] },
  { name: 'agent-react-scope', check: 'step30b', why: "an agent reacts in chats that are not its own", red: ['the agent cannot react to a post in a chat that is not its own'],
    edits: [{ file: REACTIONS, anchor: "  if (!post || !here) throw new HttpError(404, 'no such post in your chat or task')", replace: "  if (!post) throw new HttpError(404, 'no such post in your chat or task')" }] },
  { name: 'reaction-unheard', check: 'step30b', why: "the agent is never told of reactions to its posts", red: ["the agent's next turn begins with who reacted to its post"],
    edits: [{ file: REACTIONS, anchor: "  if (rows.length === 0) return ''\n", replace: "  return ''\n" }] },
  { name: 'reaction-repeated', check: 'step30b', why: 'the agent is told of a reaction on every turn', red: ['a reaction is told once'],
    edits: [{ file: REACTIONS, anchor: "  await client.query('update reactions set told_agent_at = now() where id = any($1)', [rows.map((r) => r.id)])\n", replace: '' }] },
  // Reply, edit, delete, pin.
  { name: 'task-reaction', check: 'step30b', why: "a task's agent is never told of reactions to its posts", red: ["a task's agent is told of a reaction to its post"],
    edits: [{ file: 'server/session-messages.ts', anchor: '  const reactions = await reactionsNote(client, agent.id, { sessionId })', replace: "  const reactions = ''" }] },
  { name: 'reply-kept', check: 'step30b', why: 'a reply does not keep the post it answers', red: ['a reply stores the post it answers in quoted_message_id'],
    edits: [{ file: 'server/record.ts', anchor: ', quotedMessageId: extras.replyToMessageId,', replace: ',' }] },
  { name: 'reply-unsaid', check: 'step30b', why: 'the agent is not told which post a reply answers', red: ['the agent is told which post a reply answers'],
    edits: [{ file: 'server/record.ts', anchor: "  const reply = extras.replyToMessageId ? await replyContext(client, conversationId, extras.replyToMessageId) : ''", replace: "  const reply = ''" }] },
  { name: 'reply-elsewhere', check: 'step30b', why: 'a reply names a post in another chat', red: ['a reply to a post in another chat is refused'],
    edits: [{ file: 'server/record.ts', anchor: '     where m.id = $1 and m.conversation_id = $2`, [replyToMessageId, conversationId])', replace: '     where m.id = $1 and $2::uuid is not null`, [replyToMessageId, conversationId])' }] },
  { name: 'edit-anyone', check: 'step30b', why: "a teammate, or an admin, edits another person's words", red: ['a teammate, and even an admin, is refused an edit', "nobody edits an agent's post"],
    edits: [{ file: ACTIONS, anchor: "  if (post.speaker !== 'person' || post.person_id !== person.id) throw", replace: '  if (false) throw' }] },
  { name: 'edit-admin', check: 'step30b', why: 'an admin edits what a member wrote', red: ['a teammate, and even an admin, is refused an edit'],
    edits: [{ file: ACTIONS, anchor: "  if (post.speaker !== 'person' || post.person_id !== person.id) throw", replace: "  if ((post.speaker !== 'person' || post.person_id !== person.id) && person.role !== 'admin') throw" }] },
  { name: 'edit-version', check: 'step30b', why: 'an edit keeps no version of the words it replaced', red: ['the words it had stay as a version'],
    edits: [{ file: ACTIONS, anchor: "    await client.query('insert into message_versions (message_id, body, edited_by) values ($1, $2, $3)', [messageId, post.body, person.id])\n", replace: '' }] },
  { name: 'edit-scrub', check: 'step30b', why: 'an edit lets a secret into the record', red: ['an edit is scrubbed of secrets like any post'],
    edits: [{ file: ACTIONS, anchor: '  const next = scrub(text)', replace: '  const next = text' }] },
  { name: 'edit-nothing', check: 'step30b', why: 'an edit leaves a post with no words and no files', red: ['an edit to nothing is refused when the post has no files'],
    edits: [{ file: ACTIONS, anchor: "  if (next.trim() === '' && !await maybe(", replace: "  if (false && !await maybe(" }] },
  { name: 'delete-admin', check: 'step30b', why: "an admin cannot delete another person's post", red: ["an admin deletes another person's post", "an admin deletes an agent's post"],
    edits: [{ file: ACTIONS, anchor: "  if (!author && person.role !== 'admin') throw", replace: '  if (!author) throw' }] },
  { name: 'delete-anyone', check: 'step30b', why: "a member deletes another person's post", red: ["a member cannot delete someone else's post", "a member cannot delete an agent's post"],
    edits: [{ file: ACTIONS, anchor: "  if (!author && person.role !== 'admin') throw", replace: '  if (false) throw' }] },
  { name: 'delete-by', check: 'step30b', why: 'the placeholder does not say who deleted the post', red: ['the row says who'],
    edits: [{ file: ACTIONS, anchor: "update messages set body = '', deleted_at = now(), deleted_by = $2 where id = $1`, [messageId, person.id])", replace: "update messages set body = '', deleted_at = now() where id = $1 and $2::uuid is not null`, [messageId, person.id])" }] },
  { name: 'delete-versions', check: 'step30b', why: "a deleted post's earlier words stay in its versions", red: ['the deleted words are in no column of the database'],
    edits: [{ file: ACTIONS, anchor: "  await client.query('delete from message_versions where message_id = $1', [messageId])\n", replace: '' }] },
  { name: 'delete-files', check: 'step30b', why: "a deleted post's files stay", red: ["the post's file, reactions and pin go with it"],
    edits: [{ file: ACTIONS, anchor: '  const files = await deleteAttachmentsOf(client, { messageId })', replace: '  const files: string[] = []' }] },
  { name: 'delete-prompt', check: 'step30b', why: "a deleted post's own prompt keeps its words", red: ["deleting it takes the words out of the agent's prompt records too"],
    edits: [{ file: ACTIONS, anchor: "where session_id = any($1) and body->>'messageId' = $2 returning id`", replace: "where session_id = any($1) and body->>'messageId' = $2 and false returning id`" }] },
  { name: 'erase-room', check: 'step30b', why: "a room turn's prompt keeps a deleted post's words", red: ["deleting the post takes its words from the finished turn's prompt records and raw line"],
    edits: [{ file: ACTIONS, anchor: "(body->'messageIds' ? $2 or body->>'quotedMessageId' = $2)", replace: "(body->>'quotedMessageId' = $2)" }] },
  { name: 'erase-quote', check: 'step30b', why: "a reply's prompt keeps the words of the post it quoted", red: ["deleting the original takes its words from the reply's prompt records too"],
    edits: [{ file: ACTIONS, anchor: "(body->'messageIds' ? $2 or body->>'quotedMessageId' = $2)", replace: "(body->'messageIds' ? $2)" }] },
  { name: 'erase-raw', check: 'step30b', why: 'the replayed raw line keeps a deleted post\'s words', red: ["deleting the post takes its words from the finished turn's prompt records and raw line"],
    edits: [{ file: ACTIONS, anchor: "update raw_events set line = jsonb_build_object('erased', true)", replace: "update raw_events set line = line" }] },
  { name: 'cancel-waiting', check: 'step30b', why: 'a turn waiting for its machine runs with its post deleted', red: ['a turn still waiting for its machine is cancelled with its deleted post'],
    edits: [{ file: ACTIONS, anchor: "  for (const turn of turns) await cancelWaitingTurn(client, TurnId.parse(turn.id))\n", replace: '' }] },
  { name: 'delete-outsider', check: 'step30b', why: "a person outside a private chat deletes and edits its posts", red: ['a person outside a private chat gets 404 and the post stays', 'a person outside a private chat gets 404 on an edit'],
    edits: [{ file: ACTIONS, anchor: "  if (!post || !(await canSeeConversation(person, post.conversation_id))) throw new HttpError(404, 'no such post')", replace: "  if (!post) throw new HttpError(404, 'no such post')" }] },
  { name: 'pin-outsider', check: 'step30b', why: 'a person outside a private chat pins in it', red: ['a person outside a private chat cannot pin in it'],
    edits: [{ file: ACTIONS, anchor: "  if (!(await canSeeConversation(person, conversationId))) throw new HttpError(404, 'no such conversation')\n  const post", replace: '  const post' }] },
  { name: 'pin-elsewhere', check: 'step30b', why: "a post from another chat is pinned here", red: ['a post from another chat cannot be pinned here'],
    edits: [{ file: ACTIONS, anchor: "from messages where id = $1 and conversation_id = $2', [messageId, conversationId])", replace: "from messages where id = $1 and $2::uuid is not null', [messageId, conversationId])" }] },
]

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const Pending = z.array(z.object({ file: z.string(), sha: z.string() }))
const at = (file: string) => join(ROOT, file)

// Puts back the files a run that was killed had changed.
function restorePending() {
  if (!existsSync(PENDING)) return
  for (const { file, sha: wanted } of Pending.parse(JSON.parse(readFileSync(PENDING, 'utf8')))) {
    copyFileSync(join(BACKUP, file), at(file))
    if (sha(readFileSync(at(file))) !== wanted) throw new Error(`${file} did not come back as it was`)
    console.log(`restored ${file}, left changed by a run that was killed`)
  }
  rmSync(PENDING)
}

// What each file the break touches would hold with its edits made. Throws, writing nothing, when an anchor is not there exactly once.
function edited(b: Break): Map<string, string> {
  const files = new Map<string, string>()
  for (const edit of b.edits) {
    const text = files.get(edit.file) ?? readFileSync(at(edit.file), 'utf8')
    const found = text.split(edit.anchor).length - 1
    if (found !== 1) throw new Error(`${b.name}: the anchor ${JSON.stringify(edit.anchor)} is in ${edit.file} ${String(found)} times, not once`)
    files.set(edit.file, text.replace(edit.anchor, () => edit.replace))
  }
  return files
}

function runCheck(name: CheckName): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', `test/${name}.ts`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    const timer = setTimeout(() => { child.kill('SIGTERM') }, RUN_TIMEOUT_MS)
    child.once('error', reject)
    child.once('close', () => { clearTimeout(timer); resolve(output) })
  })
}

const redLines = (output: string) => output.split('\n').filter((line) => line.startsWith('FAIL  '))
const lines = (n: number) => `${String(n)} ${n === 1 ? 'line' : 'lines'}`

async function runBreak(b: Break): Promise<{ ok: boolean; detail: string }> {
  const files = edited(b)
  mkdirSync(BACKUP, { recursive: true })
  const before = [...files.keys()].map((file) => ({ file, sha: sha(readFileSync(at(file))) }))
  for (const { file } of before) {
    mkdirSync(dirname(join(BACKUP, file)), { recursive: true })
    copyFileSync(at(file), join(BACKUP, file))
  }
  writeFileSync(PENDING, JSON.stringify(before))
  let output: string
  try {
    for (const [file, text] of files) writeFileSync(at(file), text)
    output = await runCheck(b.check)
  } finally {
    for (const { file } of before) copyFileSync(join(BACKUP, file), at(file))
  }
  const back = before.filter(({ file, sha: wanted }) => sha(readFileSync(at(file))) !== wanted)
  if (back.length) throw new Error(`${back.map((f) => f.file).join(', ')} did not come back as it was`)
  rmSync(PENDING)
  const fails = redLines(output)
  const missing = b.red.filter((piece) => !fails.some((line) => line.includes(piece)))
  return {
    ok: missing.length === 0 && fails.length > 0,
    detail: missing.length
      ? `${lines(fails.length)} went red, and none held "${missing.join('" or "')}". Red: ${fails.map((l) => l.slice(0, 120)).join(' | ')}`
      : `${lines(fails.length)} went red, and the files are back byte for byte`,
  }
}

const args = process.argv.slice(2)
const only = args.filter((a) => !a.startsWith('--'))
const unknown = only.filter((name) => !BREAKS.some((b) => b.name === name))
if (unknown.length) throw new Error(`no break named ${unknown.join(', ')}. They are ${BREAKS.map((b) => b.name).join(', ')}`)
const chosen = BREAKS.filter((b) => !only.length || only.includes(b.name))

if (args.includes('--check')) {
  for (const b of BREAKS) edited(b)
  console.log(`all ${String(BREAKS.length)} breaks find each anchor once`)
  process.exit(0)
}

restorePending()
let failed = 0
for (const name of [...new Set(chosen.map((b) => b.check))]) {
  const control = redLines(await runCheck(name))
  console.log(`${control.length ? 'FAIL' : 'pass'}  control: ${name} with nothing broken${control.length ? ` has ${String(control.length)} red lines, so no break can be judged` : ' is green'}`)
  if (control.length) process.exit(1)
}
for (const b of chosen) {
  const result = await runBreak(b)
  console.log(`${result.ok ? 'pass' : 'FAIL'}  ${b.name}: ${b.why}. ${result.detail}`)
  if (!result.ok) failed++
}
console.log(`\n${failed ? `${String(failed)} breaks were not seen failing` : `all ${String(chosen.length)} breaks were seen failing, and every file is back as it was`}`)
process.exit(failed ? 1 : 0)
