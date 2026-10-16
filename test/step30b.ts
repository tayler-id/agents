// Reactions and what a person can do to a post: reply, edit your own words, delete
// (the author, or a team admin), and pin. Each is driven as a person drives it,
// through the people port, and the agent's side through the team-record server's
// `react` tool over MCP. A deleted post's words are looked for in every column of
// the database. The API is real, on ports 8356 to 8358, which no other check uses.
//   node --env-file=.env --env-file=.env.test test/step30b.ts

import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chatSetup, PNG } from './chat-kit.ts'
import { foundInDatabase, ROOT, results, shapeRows, within } from './onboarding-kit.ts'

const PORTS = { machines: 8356, people: 8357, streams: 8358 }
const { failures, check } = results()
const kit = await chatSetup('step30b', PORTS)
const { as, send, q, q1, logins, conversations, tasks } = kit
const { alice, bob, carol } = logins
const THUMB = encodeURIComponent('👍')
const HEART = encodeURIComponent('❤️')
const clients: Client[] = []

const react = (login: string, kind: 'messages' | 'events', id: string, emoji: string, method: 'PUT' | 'DELETE' = 'PUT') =>
  as(login, method, `/v1/${kind}/${id}/reactions/${emoji}`)
const reactionRows = async (messageId: string) => q('select emoji, person_id, agent_id from reactions where message_id = $1 order by emoji', [messageId])
const say = async (login: string, conversationId: string, text: string, extras: Record<string, unknown> = {}) => {
  const answer = await send(login, conversationId, { text, ...extras })
  if (answer.status !== 200) throw new Error(`${login} could not post "${text}" (${answer.status} ${answer.text})`)
  return answer.json.messageId as string
}
// The words the agent was handed with the post of this message, from the command to its machine.
const handedOver = async (messageId: string) => (await q1(
  `select c.payload->>'text' as text from commands c join events e on e.id = c.event_id where c.kind = 'message' and e.client_id = $1`, [`message:${messageId}`])).text as string

try {
  const aliceRoomPost = await say(alice, conversations.teamRoom, 'Draft plan for Friday')
  const bobRoomPost = await say(bob, conversations.teamRoom, 'Bob here, I can review the plan')

  // 1. Reactions: idempotent, one emoji, by anyone who can see the chat.
  const first = await react(alice, 'messages', aliceRoomPost, THUMB)
  const second = await react(alice, 'messages', aliceRoomPost, THUMB)
  check(first.status === 200 && first.json.reacted === true && second.json.reacted === true && (await reactionRows(aliceRoomPost)).length === 1,
    `putting 👍 twice leaves one reaction and answers { reacted: true } both times (${first.text} ${second.text})`)
  const bobHeart = await react(bob, 'messages', aliceRoomPost, HEART)
  check(bobHeart.json.reacted === true && (await reactionRows(aliceRoomPost)).map((r) => r.emoji).join('') === '❤️👍', 'bob adds ❤️ beside it')
  const outsiderDm = await react(bob, 'messages', await say(alice, conversations.dm, 'dm only'), THUMB)
  const privatePost = await say(alice, conversations.privateRoom, 'private words')
  const outsiderPrivate = await react(bob, 'messages', privatePost, THUMB)
  check(outsiderDm.status === 404 && outsiderPrivate.status === 404 && outsiderPrivate.json.error === 'no such post',
    `a person outside a private chat cannot react and is told there is no such post (${outsiderDm.status}, ${outsiderPrivate.status} ${outsiderPrivate.text})`)
  const removed = await react(alice, 'messages', aliceRoomPost, THUMB, 'DELETE')
  const removedAgain = await react(alice, 'messages', aliceRoomPost, THUMB, 'DELETE')
  check(removed.json.reacted === false && removedAgain.json.reacted === false && (await reactionRows(aliceRoomPost)).map((r) => r.emoji).join('') === '❤️',
    "removing 👍 twice answers { reacted: false } both times and leaves bob's ❤️")
  const other = await react(carol, 'messages', aliceRoomPost, HEART, 'DELETE')
  check(other.status === 200 && (await reactionRows(aliceRoomPost)).length === 1, "removing a reaction takes only your own: carol's remove leaves bob's ❤️")

  for (const [emoji, why] of [['a', 'a letter'], ['👍👍', 'two emoji'], ['👩🏽‍❤️‍💋‍👨🏼', 'one emoji of 35 bytes'], ['', 'nothing']] as const) {
    const bad = await react(alice, 'messages', aliceRoomPost, encodeURIComponent(emoji) || '%20')
    check(bad.status === 400 && bad.json.error === 'A reaction is one emoji of at most 32 bytes.', `${why} is not a reaction (${bad.status} ${bad.text})`)
  }
  for (const emoji of ['👍🏽', '1️⃣', '🇨🇦', '👨‍👩‍👧‍👦']) {
    const good = await react(alice, 'messages', aliceRoomPost, encodeURIComponent(emoji))
    check(good.status === 200, `${emoji} is one emoji and is taken`)
  }

  // 2. A task's posts take reactions too.
  const taskPost = await as(alice, 'POST', `/v1/sessions/${tasks.team.sessionId}/messages`, { text: 'Please look at the failing test' })
  const event = await q1(`select id from events where session_id = $1 and kind = 'user' order by seq desc limit 1`, [tasks.team.sessionId])
  const onEvent = await react(bob, 'events', event.id as string, THUMB)
  check(taskPost.status === 200 && onEvent.json.reacted === true && (await q1('select count(*)::int as n from reactions where event_id = $1', [event.id])).n === 1,
    `bob reacts to a post in a team task's session (${onEvent.status} ${onEvent.text})`)
  const privateEvent = await q1(`insert into events (team_id, session_id, seq, updated_seq, kind, text, body, client_id) values ($1, $2, 1, 1, 'user', 'x', '{}', 'c1') returning id`,
    [kit.teamId, tasks.private.sessionId])
  const outsiderEvent = await react(bob, 'events', privateEvent.id as string, THUMB)
  const dmEvent = await q1(`select e.id from events e join sessions s on s.id = e.session_id where s.conversation_id = $1 limit 1`, [conversations.dm])
  const dmReact = await react(alice, 'events', dmEvent.id as string, THUMB)
  check(outsiderEvent.status === 404 && dmReact.status === 404, `no reaction on a private task's post for a teammate outside it, or on the prompts behind a chat (${outsiderEvent.status}, ${dmReact.status})`)

  // 3. The reactions shape.
  const shapeSeen = await within(20, async () => (await shapeRows(kit.PEOPLE, bob, 'reactions', { conversation: conversations.teamRoom })).rows.length >= 5)
  const shape = await shapeRows(kit.PEOPLE, bob, 'reactions', { conversation: conversations.teamRoom })
  const heart = shape.rows.find((r) => r.emoji === '❤️')
  check(shapeSeen && heart && Object.keys(heart).sort().join() === 'agent_id,conversation_id,created_at,emoji,event_id,id,message_id,person_id,session_id'
    && heart.message_id === aliceRoomPost && heart.person_id === kit.people.bob && heart.agent_id === null && heart.session_id === null && heart.conversation_id === conversations.teamRoom,
    `the room's reactions shape carries { id, conversation_id, session_id, message_id, event_id, emoji, person_id, agent_id, created_at } (${Object.keys(heart ?? {}).join()})`)
  const taskShape = await within(20, async () => (await shapeRows(kit.PEOPLE, alice, 'reactions', { session: tasks.team.sessionId })).rows.some((r) => String(r.event_id) === String(event.id)))
  check(taskShape, "a task's reactions shape, by session, carries the reaction on its event")

  // 4. An agent reacts with the react tool, and hears of reactions to its own posts.
  const dmSession = (await q1('select id from sessions where conversation_id = $1', [conversations.dm])).id as string
  const record = new Client({ name: 'step30b', version: '1.0.0' })
  await record.connect(new StdioClientTransport({
    command: process.execPath, args: [join(ROOT, 'daemon/record-mcp.ts')], cwd: kit.home, stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', AGENTS_API: kit.MACHINES, AGENTS_TOKEN: kit.token, AGENTS_SESSION: dmSession },
  }))
  clients.push(record)
  const latest = await say(alice, conversations.dm, 'Thanks for checking')
  const reacted = await record.callTool({ name: 'react', arguments: { emoji: '👍' } })
  const agentRow = await q1('select emoji, agent_id, person_id, message_id from reactions where agent_id = $1', [kit.agentId])
  check(reacted.isError !== true && agentRow.emoji === '👍' && agentRow.message_id === latest && agentRow.person_id === null,
    "the react tool with no post named reacts to the person's latest post, as the agent")
  const agentOnly = await shapeRows(kit.PEOPLE, alice, 'reactions', { conversation: conversations.dm })
  check(agentOnly.rows.some((r) => r.agent_id === kit.agentId && r.message_id === latest), 'alice sees the agent\'s reaction in the shape')
  const unreacted = await record.callTool({ name: 'react', arguments: { emoji: '👍', remove: true } })
  check(unreacted.isError !== true && (await q1('select count(*)::int as n from reactions where agent_id = $1', [kit.agentId])).n === 0, 'remove: true takes the agent\'s reaction back off')
  const foreign = await record.callTool({ name: 'react', arguments: { emoji: '👍', message_id: privatePost } })
  check(foreign.isError === true, "the agent cannot react to a post in a chat that is not its own")

  const agentShare = await fetch(`${kit.MACHINES}/v1/record/share?${new URLSearchParams({ session: dmSession, caption: 'Report is ready' })}`, {
    method: 'POST', headers: { authorization: `Bearer ${kit.token}`, 'x-file-name': 'r.txt', 'content-type': 'text/plain' }, body: 'numbers',
  })
  const agentPost = (await agentShare.json() as { messageId: string }).messageId
  await react(alice, 'messages', agentPost, THUMB)
  const next = await say(alice, conversations.dm, 'What about the second report?')
  const handed = await handedOver(next)
  check(handed === `Reactions on your posts since your last turn:\n- ${alice} reacted 👍 to your post "Report is ready"\n\nWhat about the second report?`,
    `the agent's next turn begins with who reacted to its post (${JSON.stringify(handed)})`)
  const after = await say(alice, conversations.dm, 'And the third?')
  check(await handedOver(after) === 'And the third?', 'a reaction is told once')

  // 5. Reply.
  const replyId = await say(bob, conversations.teamRoom, 'Agreed with the plan', { replyToMessageId: aliceRoomPost })
  check((await q1('select quoted_message_id from messages where id = $1', [replyId])).quoted_message_id === aliceRoomPost, 'a reply stores the post it answers in quoted_message_id')
  const dmReply = await say(alice, conversations.dm, 'Yes, that one', { replyToMessageId: latest })
  check(await handedOver(dmReply) === `(In reply to ${alice}: "Thanks for checking") Yes, that one`, 'the agent is told which post a reply answers')
  const elsewhere = await send(alice, conversations.dm, { text: 'x', replyToMessageId: aliceRoomPost })
  check(elsewhere.status === 400 && elsewhere.json.error.includes('replyToMessageId'), `a reply to a post in another chat is refused (${elsewhere.status} ${elsewhere.text})`)

  // 6. Edit: the author's own words only.
  const edited = await as(alice, 'PATCH', `/v1/messages/${aliceRoomPost}`, { text: 'Draft plan for Monday' })
  const mine = await q1('select body, edited_at from messages where id = $1', [aliceRoomPost])
  const versions = await q('select body, edited_by from message_versions where message_id = $1', [aliceRoomPost])
  check(edited.status === 200 && mine.body === 'Draft plan for Monday' && mine.edited_at !== null && versions.length === 1
    && versions[0]?.body === 'Draft plan for Friday' && versions[0].edited_by === kit.people.alice,
    `alice edits her post, and the words it had stay as a version (${edited.status} ${edited.text})`)
  await as(alice, 'PATCH', `/v1/messages/${aliceRoomPost}`, { text: 'Draft plan for Monday' })
  check((await q('select 1 from message_versions where message_id = $1', [aliceRoomPost])).length === 1, 'saving the same words again makes no new version')
  const bobEdits = await as(bob, 'PATCH', `/v1/messages/${aliceRoomPost}`, { text: 'Bob rewrote this' })
  const adminEdits = await as(alice, 'PATCH', `/v1/messages/${bobRoomPost}`, { text: 'Alice rewrote this' })
  check(bobEdits.status === 403 && bobEdits.json.error === 'Only the author can edit a post.' && adminEdits.status === 403
    && (await q1('select body from messages where id = $1', [aliceRoomPost])).body === 'Draft plan for Monday' && (await q1('select body from messages where id = $1', [bobRoomPost])).body === 'Bob here, I can review the plan',
    `a teammate, and even an admin, is refused an edit of someone else's post, and the words stand (${bobEdits.status} ${bobEdits.text}, ${adminEdits.status})`)
  const outsiderEdit = await as(bob, 'PATCH', `/v1/messages/${privatePost}`, { text: 'x' })
  check(outsiderEdit.status === 404, `a person outside a private chat gets 404 on an edit (${outsiderEdit.status})`)
  const emptyEdit = await as(alice, 'PATCH', `/v1/messages/${aliceRoomPost}`, { text: '   ' })
  check(emptyEdit.status === 400, `an edit to nothing is refused when the post has no files (${emptyEdit.status})`)
  const leaky = await as(alice, 'PATCH', `/v1/messages/${aliceRoomPost}`, { text: `key ${'gh' + 'p_'}${'C3'.repeat(18)}` })
  check(leaky.status === 200 && (await q1('select body from messages where id = $1', [aliceRoomPost])).body === 'key [secret:github]', 'an edit is scrubbed of secrets like any post')
  await as(alice, 'PATCH', `/v1/messages/${aliceRoomPost}`, { text: 'Draft plan for Monday' })
  const agentPostRow = await q1('select id from messages where speaker = $1 and conversation_id = $2 limit 1', ['agent', conversations.dm])
  const editAgent = await as(alice, 'PATCH', `/v1/messages/${agentPostRow.id}`, { text: 'fake' })
  check(editAgent.status === 403, "nobody edits an agent's post")

  // 7. Pins.
  const pinned = await as(alice, 'PUT', `/v1/conversations/${conversations.teamRoom}/pins/${aliceRoomPost}`)
  const pinTwice = await as(bob, 'PUT', `/v1/conversations/${conversations.teamRoom}/pins/${aliceRoomPost}`)
  check(pinned.json.pinned === true && pinTwice.json.pinned === true && (await q('select 1 from pins where message_id = $1', [aliceRoomPost])).length === 1, 'pinning twice leaves one pin, and answers { pinned: true }')
  const pinsSeen = await within(20, async () => (await shapeRows(kit.PEOPLE, bob, 'pins', { conversation: conversations.teamRoom })).rows.some((r) => r.message_id === aliceRoomPost))
  check(pinsSeen, "the pins shape for the room lists the pinned post")
  const pinOutside = await as(bob, 'PUT', `/v1/conversations/${conversations.privateRoom}/pins/${privatePost}`)
  const pinsOutside = await shapeRows(kit.PEOPLE, bob, 'pins', { conversation: conversations.privateRoom })
  check(pinOutside.status === 404 && pinsOutside.status === 404, 'a person outside a private chat cannot pin in it or read its pins')
  const pinStranger = await as(alice, 'PUT', `/v1/conversations/${conversations.teamRoom}/pins/${privatePost}`)
  check(pinStranger.status === 404, 'a post from another chat cannot be pinned here')
  const unpinned = await as(bob, 'DELETE', `/v1/conversations/${conversations.teamRoom}/pins/${aliceRoomPost}`)
  check(unpinned.json.pinned === false && (await q('select 1 from pins where message_id = $1', [aliceRoomPost])).length === 0, 'unpinning answers { pinned: false }')
  await as(alice, 'PUT', `/v1/conversations/${conversations.teamRoom}/pins/${bobRoomPost}`)

  // 8. Delete: the author, or an admin. The words go from everywhere.
  const secretWords = `zebra-${kit.id}-quartz`
  const upload = await kit.upload(bob, `/v1/conversations/${conversations.teamRoom}/attachments`, PNG, 'with-post.png', 'image/png')
  const bobsPost = await say(bob, conversations.teamRoom, `Bob's opinion ${secretWords}`, { attachmentIds: [upload.json.attachmentId] })
  await as(bob, 'PATCH', `/v1/messages/${bobsPost}`, { text: `Bob's second thoughts ${secretWords}` })
  await react(alice, 'messages', bobsPost, THUMB)
  await as(alice, 'PUT', `/v1/conversations/${conversations.teamRoom}/pins/${bobsPost}`)
  check((await foundInDatabase(kit.db, secretWords)).includes('messages.body') && (await foundInDatabase(kit.db, secretWords)).includes('message_versions.body'),
    'before the delete, the words are in the post and in the version it kept')
  const memberDeletesOther = await as(carol, 'DELETE', `/v1/messages/${bobsPost}`)
  check(memberDeletesOther.status === 403 && memberDeletesOther.json.error === 'Only the author or a team admin can delete a post.', `a member cannot delete someone else's post (${memberDeletesOther.status} ${memberDeletesOther.text})`)
  const adminDeletes = await as(alice, 'DELETE', `/v1/messages/${bobsPost}`)
  const gone = await q1('select body, deleted_at, deleted_by, edited_at, seq from messages where id = $1', [bobsPost])
  check(adminDeletes.status === 200 && adminDeletes.json.deleted === true && gone.body === null && gone.deleted_at !== null && gone.deleted_by === kit.people.alice,
    `an admin deletes another person's post, and the row says who (${adminDeletes.status} ${adminDeletes.text})`)
  check((await foundInDatabase(kit.db, secretWords)).length === 0, `the deleted words are in no column of the database (${(await foundInDatabase(kit.db, secretWords)).join(', ')})`)
  check((await q('select 1 from attachments where message_id = $1', [bobsPost])).length === 0 && (await kit.download(alice, `/v1/attachments/${upload.json.attachmentId}`)).status === 404
    && (await q('select 1 from reactions where message_id = $1', [bobsPost])).length === 0 && (await q('select 1 from pins where message_id = $1', [bobsPost])).length === 0,
    "the post's file, reactions and pin go with it, and the file no longer opens")
  const deletedShape = await within(20, async () => (await shapeRows(kit.PEOPLE, carol, 'messages', { conversation: conversations.teamRoom })).rows.some((r) => r.id === bobsPost && r.body === null))
  const messagesShape = await shapeRows(kit.PEOPLE, carol, 'messages', { conversation: conversations.teamRoom })
  const placeholder = messagesShape.rows.find((r) => r.id === bobsPost)
  check(deletedShape && placeholder.body === null && placeholder.deleted_by === kit.people.alice && placeholder.deleted_at !== null && String(placeholder.seq) === String(gone.seq),
    'the messages shape gives the placeholder body: null, with deleted_at and deleted_by, in its place in the order')
  const again = await as(alice, 'DELETE', `/v1/messages/${bobsPost}`)
  check(again.status === 200 && (await q1('select deleted_by from messages where id = $1', [bobsPost])).deleted_by === kit.people.alice, 'deleting a deleted post changes nothing')
  const after2 = await Promise.all([
    react(alice, 'messages', bobsPost, THUMB), as(bob, 'PATCH', `/v1/messages/${bobsPost}`, { text: 'back' }), as(alice, 'PUT', `/v1/conversations/${conversations.teamRoom}/pins/${bobsPost}`),
    send(alice, conversations.teamRoom, { text: 'replying', replyToMessageId: bobsPost }),
  ])
  check(after2.map((a) => a.status).join() === '409,409,409,400', `a deleted post takes no reaction, edit, pin or reply (${after2.map((a) => a.status).join()})`)

  const ownPost = await say(carol, conversations.teamRoom, 'Carol will take this one')
  check((await as(carol, 'DELETE', `/v1/messages/${ownPost}`)).status === 200 && (await q1('select deleted_by from messages where id = $1', [ownPost])).deleted_by === kit.people.carol,
    'a member deletes their own post')
  const roomSession = (await q1(`insert into sessions (team_id, conversation_id, instance_id, agent_id, status) values ($1, $2, $3, $4, 'idle') returning id`,
    [kit.teamId, conversations.teamRoom, kit.instanceId, kit.agentId])).id as string
  const roomShare = await fetch(`${kit.MACHINES}/v1/record/share?${new URLSearchParams({ session: roomSession, caption: 'Notes from scout' })}`, {
    method: 'POST', headers: { authorization: `Bearer ${kit.token}`, 'x-file-name': 'n.txt', 'content-type': 'text/plain' }, body: 'notes',
  })
  const roomAgentPost = (await roomShare.json() as { messageId: string }).messageId
  const agentDelete = await as(carol, 'DELETE', `/v1/messages/${roomAgentPost}`)
  check(agentDelete.status === 403, "a member cannot delete an agent's post")
  check((await as(alice, 'DELETE', `/v1/messages/${roomAgentPost}`)).status === 200 && (await q1('select deleted_by from messages where id = $1', [roomAgentPost])).deleted_by === kit.people.alice,
    "an admin deletes an agent's post")
  const outsiderDelete = await as(bob, 'DELETE', `/v1/messages/${privatePost}`)
  check(outsiderDelete.status === 404 && (await q1('select deleted_at from messages where id = $1', [privatePost])).deleted_at === null, 'a person outside a private chat gets 404 and the post stays')

  // A post to an agent leaves its words in the agent's prompt too. Deleting it takes them from there.
  const dmWords = `giraffe-${kit.id}-basalt`
  const dmPost = await say(alice, conversations.dm, `Do not tell anyone ${dmWords}`)
  check((await foundInDatabase(kit.db, dmWords)).length >= 3, `a post to an agent is in its event, its turn and its command as well (${(await foundInDatabase(kit.db, dmWords)).join(', ')})`)
  await as(alice, 'DELETE', `/v1/messages/${dmPost}`)
  check((await foundInDatabase(kit.db, dmWords)).length === 0, `deleting it takes the words out of the agent's prompt records too (${(await foundInDatabase(kit.db, dmWords)).join(', ')})`)
} finally {
  if (failures.length) console.log(`\nthe API printed:\n${kit.api.text().slice(-1500)}`)
  for (const client of clients) await client.close().catch((error: unknown) => { console.error(error) })
  await q('delete from teams where id = $1', [kit.teamId]).catch((error: unknown) => { console.error(error) })
  await kit.stop()
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed')
process.exit(failures.length ? 1 : 0)
