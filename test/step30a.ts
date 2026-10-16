// Files in chats and tasks, as a person uses them: upload, send with a post,
// open. An image shows inline and every other file downloads, whatever its
// sender called it. The cap is 25 MB, a pending upload is its uploader's and is
// deleted after 24 hours, and a file follows the access of the chat or task it is
// in. The API is real, on ports 8350 to 8352, which no other check uses.
//   node --env-file=.env --env-file=.env.test test/step30a.ts

import { existsSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chatSetup, GIF_30x20, JPEG_640x480, PNG, WEBP_100x50 } from './chat-kit.ts'
import { results, shapeRows, startApi, within } from './onboarding-kit.ts'
import { MAX_ATTACHMENT_BYTES } from '../shared/attachments.ts'

const PORTS = { machines: 8350, people: 8351, streams: 8352 }
const { failures, check } = results()
const kit = await chatSetup('step30a', PORTS)
const { as, upload, download, send, logins, conversations, tasks, q, q1 } = kit
const { alice, bob, carol } = logins

try {
  // 1. Uploading is not sending, and what the answer says is what the bytes show.
  const html = Buffer.from('<script>alert(1)</script>')
  const png = await upload(alice, `/v1/conversations/${conversations.dm}/attachments`, PNG, 'shot ñ.png', 'image/png')
  check(png.status === 201 && png.json.kind === 'image' && png.json.mediaType === 'image/png' && png.json.size === PNG.length
    && png.json.width === 1 && png.json.height === 1 && png.json.name === 'shot ñ.png',
    `an upload of a PNG answers 201 with kind image, its type, size ${PNG.length} and size 1x1 (${png.status} ${png.text.slice(0, 120)})`)
  const idOfPng: string = png.json.attachmentId
  const row = await q1('select message_id, event_id, conversation_id, added_by_person from attachments where id = $1', [idOfPng])
  check(row.message_id === null && row.event_id === null && row.conversation_id === conversations.dm && row.added_by_person === kit.people.alice,
    'the upload is pending: in the DM, by alice, on no message')

  const sizes: [string, Buffer, string, number, number][] = [
    ['jpeg', JPEG_640x480, 'image/jpeg', 640, 480], ['gif', GIF_30x20, 'image/gif', 30, 20], ['webp', WEBP_100x50, 'image/webp', 100, 50],
  ]
  for (const [name, bytes, type, width, height] of sizes) {
    const answer = await upload(alice, `/v1/conversations/${conversations.dm}/attachments`, bytes, `x.${name}`, 'application/octet-stream')
    check(answer.status === 201 && answer.json.kind === 'image' && answer.json.mediaType === type && answer.json.width === width && answer.json.height === height,
      `a ${name} sent as octet-stream is judged an image by its bytes, ${width}x${height} (${answer.status} ${answer.text.slice(0, 100)})`)
  }

  // 2. An image is inline. Everything else downloads, whatever it says it is.
  const inline = await download(alice, `/v1/attachments/${idOfPng}`)
  check(inline.status === 200 && inline.headers.get('content-type') === 'image/png' && inline.bytes.equals(PNG)
    && /^inline;/.test(inline.headers.get('content-disposition') ?? '') && inline.headers.get('x-content-type-options') === 'nosniff',
    `the PNG comes back inline as image/png with the same bytes (${inline.status} ${inline.headers.get('content-disposition')})`)
  check((inline.headers.get('content-disposition') ?? '').includes("filename*=UTF-8''shot%20%C3%B1.png"),
    `its download name keeps the ñ, encoded (${inline.headers.get('content-disposition')})`)
  const forced = await download(alice, `/v1/attachments/${idOfPng}?download=1`)
  check(/^attachment;/.test(forced.headers.get('content-disposition') ?? '') && forced.bytes.equals(PNG), '?download=1 downloads the image too')

  const asHtml = await upload(alice, `/v1/conversations/${conversations.dm}/attachments`, html, 'page.html', 'text/html')
  const htmlBack = await download(alice, `/v1/attachments/${asHtml.json.attachmentId}`)
  check(asHtml.json.kind === 'file' && /^attachment;/.test(htmlBack.headers.get('content-disposition') ?? '') && htmlBack.bytes.equals(html)
    && (htmlBack.headers.get('content-security-policy') ?? '').includes('sandbox'),
    `an HTML file is a file that downloads, with a sandboxing policy (${htmlBack.headers.get('content-disposition')})`)
  const fakePng = await upload(alice, `/v1/conversations/${conversations.dm}/attachments`, html, 'fake.png', 'image/png')
  const fakeBack = await download(alice, `/v1/attachments/${fakePng.json.attachmentId}`)
  check(fakePng.json.kind === 'file' && /^attachment;/.test(fakeBack.headers.get('content-disposition') ?? ''),
    'HTML sent as image/png is a file and downloads, since its bytes are not an image')
  const svg = await upload(alice, `/v1/conversations/${conversations.dm}/attachments`, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.svg', 'image/svg+xml')
  const svgBack = await download(alice, `/v1/attachments/${svg.json.attachmentId}`)
  check(svg.json.kind === 'file' && /^attachment;/.test(svgBack.headers.get('content-disposition') ?? ''), 'an SVG is a file and downloads')
  const noName = await kit.upload(alice, `/v1/conversations/${conversations.dm}/attachments`, html, '../../etc/passwd', 'text/plain')
  check(noName.json.name === 'passwd', `a path in the file name is cut to its last part (${noName.json.name})`)
  const bare = await fetch(`${kit.PEOPLE}/v1/conversations/${conversations.dm}/attachments`, {
    method: 'POST', headers: { 'tailscale-user-login': alice, 'content-type': 'text/plain' }, body: 'hello',
  })
  check(bare.status === 415, `an upload with no X-File-Name is refused like any change that is not JSON (${bare.status})`)

  // 3. The cap.
  const limit = await upload(alice, `/v1/conversations/${conversations.dm}/attachments`, Buffer.alloc(MAX_ATTACHMENT_BYTES, 7), 'exactly.bin')
  check(limit.status === 201 && limit.json.size === 25 * 1024 * 1024, `a file of exactly 25 MB is taken (${limit.status})`)
  const over = await upload(alice, `/v1/conversations/${conversations.dm}/attachments`, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 7), 'over.bin')
  check(over.status === 413 && over.json.error === 'That file is over 25 MB.', `a file one byte over 25 MB answers 413 "That file is over 25 MB." (${over.status} ${over.text})`)
  const empty = await upload(alice, `/v1/conversations/${conversations.dm}/attachments`, Buffer.alloc(0), 'empty.txt')
  check(empty.status === 400 && empty.json.error === 'That file is empty.', `an empty file answers 400 "That file is empty." (${empty.status} ${empty.text})`)
  check((await q1(`select count(*)::int as n from attachments where name = 'over.bin'`)).n === 0, 'the refused file left no row')

  // 4. Access follows the chat. A pending upload is its uploader's alone.
  const bobsPending = await as(bob, 'GET', `/v1/attachments/${idOfPng}`)
  check(bobsPending.status === 404, `bob, who is not in alice's DM, cannot open her pending upload (${bobsPending.status})`)
  const bobUp = await upload(bob, `/v1/conversations/${conversations.dm}/attachments`, PNG, 'x.png', 'image/png')
  check(bobUp.status === 404, `bob cannot upload to alice's DM (${bobUp.status} ${bobUp.text})`)
  const carolUp = await upload(carol, `/v1/conversations/${conversations.privateRoom}/attachments`, PNG, 'x.png', 'image/png')
  check(carolUp.status === 404, `carol cannot upload to a private room she is not in (${carolUp.status})`)
  const secretUp = await upload(alice, `/v1/conversations/${conversations.privateRoom}/attachments`, Buffer.from('private plans'), 'plans.txt', 'text/plain')
  const posted = await send(alice, conversations.privateRoom, { text: 'the plans', attachmentIds: [secretUp.json.attachmentId] })
  check(posted.status === 200, `alice posts a file in her private room (${posted.status} ${posted.text})`)
  const outsider = await download(bob, `/v1/attachments/${secretUp.json.attachmentId}`)
  check(outsider.status === 404 && !outsider.bytes.includes(Buffer.from('private plans')), `bob gets 404 and no bytes for a file in a private room (${outsider.status})`)
  const outsiderShape = await shapeRows(kit.PEOPLE, bob, 'attachments', { conversation: conversations.privateRoom })
  check(outsiderShape.status === 404, `bob cannot read the private room's attachments shape (${outsiderShape.status})`)
  const outsiderReactions = await shapeRows(kit.PEOPLE, bob, 'reactions', { conversation: conversations.privateRoom })
  check(outsiderReactions.status === 404, `bob cannot read the private room's reactions shape (${outsiderReactions.status})`)
  const insider = await download(alice, `/v1/attachments/${secretUp.json.attachmentId}`)
  check(insider.status === 200 && insider.bytes.toString() === 'private plans', 'alice opens it')

  // 5. A post carries its files, and a wrong id fails it by name.
  const gif = (await upload(alice, `/v1/conversations/${conversations.dm}/attachments`, GIF_30x20, 'wave.gif', 'image/gif')).json.attachmentId as string
  const stranger = await upload(carol, '/v1/attachments', PNG, 'carols.png', 'image/png')
  check(stranger.status === 201 && stranger.json.kind === 'image', 'carol uploads with no place yet')
  const wrong = randomUUID()
  const missing = await send(alice, conversations.dm, { text: 'hi', attachmentIds: [wrong] })
  check(missing.status === 400 && missing.json.error.includes(wrong), `a made-up id fails the post with 400, naming it (${missing.status} ${missing.text})`)
  const notMine = await send(alice, conversations.dm, { text: 'hi', attachmentIds: [stranger.json.attachmentId] })
  check(notMine.status === 400 && notMine.json.error.includes(stranger.json.attachmentId), `carol's pending upload cannot ride on alice's post (${notMine.status})`)
  const none = await send(alice, conversations.dm, {})
  check(none.status === 400 && none.json.error.includes('send text, attachmentIds, or both'), `a post with neither words nor files is refused (${none.status} ${none.text})`)
  const tooMany = await send(alice, conversations.dm, { attachmentIds: Array.from({ length: 11 }, () => randomUUID()) })
  check(tooMany.status === 400, `11 attachments are refused, since a post takes 10 at most (${tooMany.status})`)
  const twice = await send(alice, conversations.dm, { attachmentIds: [gif, gif] })
  check(twice.status === 400 && twice.json.error.includes('each attachment can be named once'), `one id twice is refused (${twice.status} ${twice.text})`)
  check((await q1('select message_id from attachments where id = $1', [gif])).message_id === null, 'a failed post claimed nothing')

  const sent = await send(alice, conversations.dm, { text: 'look at these', attachmentIds: [idOfPng, gif], clientId: 'post-1' })
  check(sent.status === 200 && typeof sent.json.messageId === 'string', `a post with text and two files is taken (${sent.status} ${sent.text})`)
  const claimed = await q('select id, message_id, conversation_id from attachments where message_id = $1 order by name', [sent.json.messageId])
  check(claimed.length === 2 && claimed.every((r) => r.conversation_id === conversations.dm), 'both files belong to the message now')
  const again = await send(alice, conversations.dm, { text: 'look at these', attachmentIds: [idOfPng, gif], clientId: 'post-1' })
  check(again.status === 200 && again.json.messageId === sent.json.messageId, 'sending the same post again (same clientId) is the same message')
  const reuse = await send(alice, conversations.dm, { text: 'again', attachmentIds: [gif] })
  check(reuse.status === 400, `a file already sent cannot ride on another post (${reuse.status})`)
  const onlyFile = await send(alice, conversations.dm, { attachmentIds: [(await upload(alice, `/v1/conversations/${conversations.dm}/attachments`, html, 'notes.txt', 'text/plain')).json.attachmentId] })
  check(onlyFile.status === 200 && (await q1('select body from messages where id = $1', [onlyFile.json.messageId])).body === '', 'a post of only a file is taken, with empty words')

  const event = await q1(`select text, body from events e where client_id = $1`, [`message:${sent.json.messageId}`])
  check(typeof event.text === 'string' && event.text.startsWith('look at these\n\nAttached files:\n- shot ñ.png (image/png, ')
    && event.text.includes(`attachment ${idOfPng}`) && event.text.includes('get_attachment'),
    `the agent's prompt names each file and the tool that saves it (${JSON.stringify(event.text).slice(0, 200)})`)
  const command = await q1(`select c.payload->>'text' as text from commands c join events e on e.id = c.event_id where c.kind = 'message' and e.client_id = $1`,
    [`message:${sent.json.messageId}`])
  check(typeof command.text === 'string' && command.text.includes(`attachment ${gif}`), 'the message command to the machine carries the same words')

  // 6. A bob who can see the shared room sees what was sent, and no one's pending uploads.
  const sentTo = await send(alice, conversations.teamRoom, { text: 'for the room', attachmentIds: [(await upload(alice, `/v1/conversations/${conversations.teamRoom}/attachments`, PNG, 'room.png', 'image/png')).json.attachmentId] })
  check(sentTo.status === 200, 'alice posts a picture in the team room')
  const roomPrompt = await q1(`select e.text from events e join sessions s on s.id = e.session_id where s.conversation_id = $1 and e.kind = 'user' order by e.seq limit 1`, [conversations.teamRoom])
  check(String(roomPrompt.text).includes('alice-') && String(roomPrompt.text).includes('for the room\n\nAttached files:\n- room.png (image/png, 70 bytes), attachment '),
    `the agent's room turn names the file under the post that carries it (${JSON.stringify(roomPrompt.text).slice(0, 200)})`)
  const pendingInRoom = (await upload(alice, `/v1/conversations/${conversations.teamRoom}/attachments`, html, 'draft.txt', 'text/plain')).json.attachmentId as string
  const seen = await within(20, async () => {
    const shape = await shapeRows(kit.PEOPLE, bob, 'attachments', { conversation: conversations.teamRoom })
    return shape.status === 200 && shape.rows.some((r) => r.name === 'room.png')
  })
  const bobRows = await shapeRows(kit.PEOPLE, bob, 'attachments', { conversation: conversations.teamRoom })
  check(seen && bobRows.rows.length === 1 && bobRows.rows[0].message_id === sentTo.json.messageId && bobRows.rows[0].kind === 'image'
    && bobRows.rows[0].media_type === 'image/png' && bobRows.rows[0].added_by_person === kit.people.alice && !('store_key' in bobRows.rows[0]),
    `bob's attachments shape for the room has room.png and not alice's pending draft (${JSON.stringify(bobRows.rows.map((r) => r.name))})`)
  const aliceRows = await shapeRows(kit.PEOPLE, alice, 'attachments', { conversation: conversations.teamRoom })
  check(aliceRows.rows.some((r) => r.name === 'draft.txt' && r.message_id === null), "alice's own shape also holds her pending draft, with no message")
  const bobOpens = await download(bob, `/v1/attachments/${bobRows.rows[0]?.id}`)
  check(bobOpens.status === 200 && bobOpens.bytes.equals(PNG), 'bob opens the picture alice posted in the room')
  const bobDraft = await as(bob, 'GET', `/v1/attachments/${pendingInRoom}`)
  check(bobDraft.status === 404, "bob cannot open alice's pending draft in the room")

  // 7. A task's session takes files the same way.
  const taskUp = await upload(alice, `/v1/sessions/${tasks.team.sessionId}/attachments`, PNG, 'bug.png', 'image/png')
  check(taskUp.status === 201 && (await q1('select session_id, conversation_id from attachments where id = $1', [taskUp.json.attachmentId])).session_id === tasks.team.sessionId,
    `alice uploads to a task's session (${taskUp.status})`)
  const bobTask = await upload(bob, `/v1/sessions/${tasks.team.sessionId}/attachments`, PNG, 'bobs.png', 'image/png')
  check(bobTask.status === 201, "bob, who can see the team task, uploads to its session too")
  const privateTask = await upload(bob, `/v1/sessions/${tasks.private.sessionId}/attachments`, PNG, 'x.png', 'image/png')
  check(privateTask.status === 404, `bob cannot upload to a private task's session (${privateTask.status})`)
  const noSession = await upload(alice, `/v1/sessions/${randomUUID()}/attachments`, PNG, 'x.png', 'image/png')
  check(noSession.status === 404, 'a session that does not exist answers 404')
  const toTask = await as(alice, 'POST', `/v1/sessions/${tasks.team.sessionId}/messages`, { text: 'see the screenshot', attachmentIds: [taskUp.json.attachmentId] })
  check(toTask.status === 200, `a message to the task's session carries the file (${toTask.status} ${toTask.text})`)
  const taskEvent = await q1(`select e.id, e.text, e.body from events e where e.session_id = $1 and e.kind = 'user' order by seq desc limit 1`, [tasks.team.sessionId])
  const taskRow = await q1('select event_id, message_id from attachments where id = $1', [taskUp.json.attachmentId])
  check(taskRow.event_id === taskEvent.id && taskRow.message_id === null && taskEvent.text.includes('Attached files:\n- bug.png (image/png,') && taskEvent.body.said === 'see the screenshot',
    `the file hangs on the post's event, the agent is told of it, and the person's own words stay in the record (${JSON.stringify(taskEvent.body)})`)
  const taskShape = await within(20, async () => (await shapeRows(kit.PEOPLE, bob, 'attachments', { session: tasks.team.sessionId })).rows.some((r) => r.name === 'bug.png' && String(r.event_id) === String(taskEvent.id)))
  check(taskShape, 'the task page reads the file from the attachments shape for its session, with its event')
  const outsideTaskShape = await shapeRows(kit.PEOPLE, bob, 'attachments', { session: tasks.private.sessionId })
  check(outsideTaskShape.status === 404, `bob cannot read a private task's attachments shape (${outsideTaskShape.status})`)

  // 8. A New task and a New chat claim uploads when they are made.
  const loose = await upload(alice, '/v1/attachments', Buffer.from('spec text'), 'spec.txt', 'text/plain')
  const made = await as(alice, 'POST', '/v1/tasks', { title: 'From a file', instructions: 'Read the spec.', agentId: kit.agentId, attachmentIds: [loose.json.attachmentId] })
  check(made.status === 200 && typeof made.json.sessionId === 'string', `a new task takes attachmentIds (${made.status} ${made.text.slice(0, 160)})`)
  const claimedFile = await q1('select session_id, event_id from attachments where id = $1', [loose.json.attachmentId])
  const first = await q1(`select id, text from events where session_id = $1 and kind = 'user' order by seq limit 1`, [made.json.sessionId])
  check(claimedFile.session_id === made.json.sessionId && claimedFile.event_id === first.id && first.text.includes('Attached files:\n- spec.txt (text/plain, 9 bytes)'),
    "the file is in the new task's session, on its first post, and the first turn names it")
  const draftTry = await as(alice, 'POST', '/v1/tasks', { title: 'Draft', instructions: '', agentId: kit.agentId, draft: true, attachmentIds: [(await upload(alice, '/v1/attachments', PNG, 'd.png')).json.attachmentId] })
  check(draftTry.status === 400 && draftTry.json.error.includes('A draft takes no attachments yet'), `a draft task refuses attachments by saying so (${draftTry.status} ${draftTry.text})`)

  const roomFile = await upload(alice, '/v1/attachments', PNG, 'kickoff.png', 'image/png')
  const room = await as(alice, 'POST', '/v1/conversations', { kind: 'room', name: `kickoff-${kit.id}`, people: [], agents: ['scout'], text: 'Kickoff', attachmentIds: [roomFile.json.attachmentId] })
  check(room.status === 200, `a new group chat takes a first post with files (${room.status} ${room.text})`)
  const [roomRow] = await q('select a.conversation_id, a.message_id, m.body from attachments a join messages m on m.id = a.message_id where a.id = $1', [roomFile.json.attachmentId])
  check(roomRow?.conversation_id === room.json.conversationId && roomRow?.body === 'Kickoff', 'the file is in the new chat, on its first post')

  // 9. Pending uploads are deleted after 24 hours, with their bytes. Sent files stay.
  const old = await upload(alice, '/v1/attachments', Buffer.from('forgotten'), 'old.txt', 'text/plain')
  const young = await upload(alice, '/v1/attachments', Buffer.from('recent'), 'young.txt', 'text/plain')
  const oldPath = (id: string) => join(kit.filesDir, id.slice(0, 2), id)
  check(existsSync(oldPath(old.json.attachmentId)), 'the pending upload is on disk')
  await q(`update attachments set created_at = now() - interval '25 hours' where id = $1`, [old.json.attachmentId])
  await q(`update attachments set created_at = now() - interval '23 hours' where id = $1`, [young.json.attachmentId])
  await q(`update attachments set created_at = now() - interval '48 hours' where id = $1`, [idOfPng])
  const swept = await within(20, async () => (await q1('select count(*)::int as n from attachments where id = $1', [old.json.attachmentId])).n === 0)
  check(swept && !existsSync(oldPath(old.json.attachmentId)), 'a pending upload older than 24 hours is deleted, row and bytes')
  check((await q1('select count(*)::int as n from attachments where id = $1', [young.json.attachmentId])).n === 1 && existsSync(oldPath(young.json.attachmentId)),
    'a pending upload of 23 hours is kept')
  check(existsSync(oldPath(idOfPng)) && (await download(alice, `/v1/attachments/${idOfPng}`)).status === 200, 'a file that a post carries stays, however old')
  const strayId = randomUUID()
  const strayNewId = randomUUID()
  const stray = oldPath(strayId)
  const strayNew = oldPath(strayNewId)
  mkdirSync(join(kit.filesDir, strayId.slice(0, 2)), { recursive: true })
  mkdirSync(join(kit.filesDir, strayNewId.slice(0, 2)), { recursive: true })
  writeFileSync(stray, 'orphan')
  writeFileSync(strayNew, 'fresh orphan')
  utimesSync(stray, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000))
  const orphanGone = await within(20, async () => !existsSync(stray))
  check(orphanGone && existsSync(strayNew), 'a stored file with no row is removed after an hour, and a fresh one is left alone')

  // 10. A server told no folder keeps its files in a folder named for its database, and its sweep looks only there.
  // The old default was one folder for every database, which a server on the test database would have swept clean.
  const databaseName = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1)
  const home2 = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step30a-home-')))
  const liveId = randomUUID()
  const orphanId = randomUUID()
  const liveLike = join(home2, 'attachments', liveId.slice(0, 2), liveId)
  const ownOrphan = join(home2, 'attachments', databaseName, orphanId.slice(0, 2), orphanId)
  for (const file of [liveLike, ownOrphan]) {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'x')
    utimesSync(file, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000))
  }
  const second = await startApi({ machines: 8360, people: 8361, streams: 8362 },
    { AGENTS_RUNNER: 'off', AGENTS_RUNNER_TEAMS: kit.team, AGENTS_HOME: home2, AGENTS_ATTACHMENTS_DIR: undefined, AGENTS_ATTACHMENT_SWEEP_SECONDS: '1' }, join(home2, 'streams'))
  try {
    const sweptOwn = await within(30, async () => !existsSync(ownOrphan))
    check(sweptOwn && existsSync(liveLike),
      "a server given no folder sweeps the folder named for its database and leaves another database's files alone")
  } finally {
    if (failures.length) console.log(second.text().slice(-1200))
    await second.stop()
  }
} finally {
  if (failures.length) console.log(`\nthe API printed:\n${kit.api.text().slice(-1500)}`)
  await q(`delete from teams where id = $1`, [kit.teamId]).catch((error: unknown) => { console.error(error) })
  await kit.stop()
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed')
process.exit(failures.length ? 1 : 0)
