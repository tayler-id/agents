// What an agent can do with files from inside its session, as Claude Code calls the
// tools over MCP: share a file from its working folder into its chat or its task,
// share a screenshot of its screen, and save a file a person attached. The MCP
// servers are the real ones. Only the box's screen service and its browser tools
// are stood in for, and they speak the real protocol. The API is real, on ports
// 8353 to 8355, which no other check uses.
//   node --env-file=.env --env-file=.env.test test/step30c.ts

import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chatSetup, PNG, GIF_30x20 } from './chat-kit.ts'
import { ROOT, results } from './onboarding-kit.ts'
import { must } from './must.ts'

const PORTS = { machines: 8353, people: 8354, streams: 8355 }
const { failures, check } = results()
const kit = await chatSetup('step30c', PORTS)
const { q, q1, upload, download, send, logins, conversations, tasks } = kit
const { alice } = logins
const work = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step30c-work-')))
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step30c-outside-')))
const clients: Client[] = []

// An MCP server of this repo, started as Claude Code starts it, in the agent's working folder.
async function connect(script: string, env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'step30c', version: '1.0.0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [join(ROOT, script)], cwd: work, env: { PATH: process.env.PATH ?? '', ...env }, stderr: 'pipe',
  }))
  clients.push(client)
  return client
}
const asSession = (sessionId: string) => ({ AGENTS_API: kit.MACHINES, AGENTS_TOKEN: kit.token, AGENTS_SESSION: sessionId })

// What a tool call answered: whether it failed, and its text.
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  const content = Array.isArray(result.content) ? result.content : []
  const text = content.map((c: { type?: string; text?: string }) => (c.type === 'text' ? c.text ?? '' : `[${c.type ?? 'part'}]`)).join('\n')
  return { failed: result.isError === true, text }
}

let screenSocket = ''
let secretsOnScreen: string[] = []
const screen = createServer((req, res) => {
  const reply = (body: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body)) }
  if (req.url === '/secrets-shown') reply({ names: secretsOnScreen })
  else if (req.url === '/act') {
    req.resume()
    reply({ shot: { png: PNG.toString('base64'), width: 1, height: 1 }, cursor: { x: 0, y: 0 }, epoch: 1, lastPerson: null })
  } else res.writeHead(404).end('{"error":"no such route"}')
})

try {
  // A DM with a post from alice that carries a picture, so the agent has a session and an attachment to save.
  const sentFile = (await upload(alice, `/v1/conversations/${conversations.dm}/attachments`, GIF_30x20, 'wave.gif', 'image/gif')).json.attachmentId as string
  const sent = await send(alice, conversations.dm, { text: 'here is a wave', attachmentIds: [sentFile] })
  const dmSession = (await q1('select id from sessions where conversation_id = $1', [conversations.dm])).id as string
  check(sent.status === 200, 'alice sends the agent a picture')

  const record = await connect('daemon/record-mcp.ts', asSession(dmSession))
  const tools = (await record.listTools()).tools.map((t) => t.name)
  check(['share_file', 'get_attachment', 'react'].every((name) => tools.includes(name)), `the team-record server offers share_file, get_attachment and react (${tools.join(', ')})`)

  // Sharing a file from the working folder posts it in the chat as the agent.
  writeFileSync(join(work, 'report.txt'), 'quarterly numbers')
  const shared = await call(record, 'share_file', { path: 'report.txt', caption: 'Here is the report' })
  check(!shared.failed && shared.text === 'Shared report.txt (file, 17 bytes).', `share_file answers what it shared (${shared.text})`)
  const post = await q1(`select m.id, m.body, m.speaker, m.agent_id, a.name, a.kind, a.size, a.added_by_agent, a.added_by_person, a.message_id
    from messages m join attachments a on a.message_id = m.id where m.conversation_id = $1 and m.speaker = 'agent'`, [conversations.dm])
  check(post.body === 'Here is the report' && post.agent_id === kit.agentId && post.name === 'report.txt' && post.kind === 'file' && Number(post.size) === 17
    && post.added_by_agent === kit.agentId && post.added_by_person === null,
    `it is a post by the agent with the caption as its words and one file, added by the agent (${JSON.stringify(post)})`)
  const got = await download(alice, `/v1/attachments/${await attachmentOf(post.id)}`)
  check(got.status === 200 && got.bytes.toString() === 'quarterly numbers' && /^attachment;/.test(got.headers.get('content-disposition') ?? ''),
    'alice downloads the shared file with the same bytes')

  writeFileSync(join(work, 'shot.png'), PNG)
  const picture = await call(record, 'share_file', { path: 'shot.png' })
  const pictureRow = await q1(`select a.id, a.kind, m.body from attachments a join messages m on m.id = a.message_id where a.name = 'shot.png'`)
  const pictureBack = await download(alice, `/v1/attachments/${pictureRow.id}`)
  check(!picture.failed && pictureRow.kind === 'image' && pictureRow.body === '' && /^inline;/.test(pictureBack.headers.get('content-disposition') ?? ''),
    'a picture with no caption is shared as an image that shows inline')

  // The working folder is the limit.
  writeFileSync(join(outside, 'secret.txt'), 'not for sharing')
  symlinkSync(join(outside, 'secret.txt'), join(work, 'link.txt'))
  mkdirSync(join(work, 'sub'), { recursive: true })
  const escapes: [string, string][] = [
    [`../${outside.split('/').pop() ?? ''}/secret.txt`, 'a path up out of the folder'],
    [join(outside, 'secret.txt'), 'an absolute path elsewhere'],
    ['link.txt', 'a link inside the folder to a file outside it'],
  ]
  for (const [path, what] of escapes) {
    const refused = await call(record, 'share_file', { path })
    check(refused.failed && refused.text.includes('only shares files inside your working folder'), `share_file refuses ${what} (${refused.text})`)
  }
  const missing = await call(record, 'share_file', { path: 'nope.txt' })
  check(missing.failed && missing.text.includes('There is no file at nope.txt.'), `a missing file is said to be missing (${missing.text})`)
  const dir = await call(record, 'share_file', { path: 'sub' })
  check(dir.failed && dir.text.includes('sub is not a file.'), `a folder is not a file (${dir.text})`)
  const before = (await q1('select count(*)::int as n from attachments where added_by_agent is not null')).n
  check(before === 2, `only the two good shares made files (${before})`)

  // A file with a secret in its text is not shared.
  writeFileSync(join(work, 'notes.env'), `token = ${'gh' + 'p_'}${'A1'.repeat(18)}\n`)
  const leaked = await call(record, 'share_file', { path: 'notes.env', caption: 'config' })
  check(leaked.failed && leaked.text.includes('That file holds a secret this team keeps, so it was not shared.')
    && (await q1('select count(*)::int as n from attachments where name = $1', ['notes.env'])).n === 0, `a file with a secret in it is refused and leaves nothing (${leaked.text})`)
  const leakedCaption = await call(record, 'share_file', { path: 'report.txt', caption: `use ${'gh' + 'p_'}${'B2'.repeat(18)}` })
  const captionRow = await q1(`select body from messages where conversation_id = $1 and speaker = 'agent' order by seq desc limit 1`, [conversations.dm])
  check(!leakedCaption.failed && captionRow.body === 'use [secret:github]', `a secret in a caption is scrubbed, as in any post (${captionRow.body})`)

  // Saving what a person attached.
  const saved = await call(record, 'get_attachment', { attachment_id: sentFile })
  const savedPath = join(work, 'attachments', `${sentFile.slice(0, 8)}-wave.gif`)
  check(!saved.failed && saved.text === `Saved at ${savedPath}.` && readFileSync(savedPath).equals(GIF_30x20), `get_attachment saves the picture under attachments/ (${saved.text})`)
  const privateFile = (await upload(alice, `/v1/conversations/${conversations.privateRoom}/attachments`, PNG, 'private.png', 'image/png')).json.attachmentId as string
  await send(alice, conversations.privateRoom, { text: 'private', attachmentIds: [privateFile] })
  const notHere = await call(record, 'get_attachment', { attachment_id: privateFile })
  check(notHere.failed && notHere.text.includes('no such attachment in this chat or task'), `a file from another chat is not available to this session (${notHere.text})`)
  const pending = (await upload(alice, `/v1/conversations/${conversations.dm}/attachments`, PNG, 'unsent.png', 'image/png')).json.attachmentId as string
  const notSent = await call(record, 'get_attachment', { attachment_id: pending })
  check(notSent.failed && notSent.text.includes('no such attachment in this chat or task'), `a file nobody has sent yet is not available to the agent (${notSent.text})`)

  // In a task's session, the file hangs on a notice event the task page shows.
  const taskTools = await connect('daemon/record-mcp.ts', asSession(tasks.team.sessionId))
  const inTask = await call(taskTools, 'share_file', { path: 'report.txt', caption: 'Task report' })
  const notice = await q1(`select e.id, e.kind, e.text, e.body from events e where e.session_id = $1 and e.kind = 'notice' and e.body->>'subtype' = 'share'`, [tasks.team.sessionId])
  const taskFile = await q1('select id, event_id, message_id, session_id, conversation_id from attachments where event_id = $1', [notice.id])
  check(!inTask.failed && notice.text === 'Task report' && notice.body.caption === 'Task report' && notice.body.attachmentIds[0] === taskFile.id
    && taskFile.session_id === tasks.team.sessionId && taskFile.message_id === null && taskFile.conversation_id === null,
    `in a task session a share is a notice event with the caption, carrying the file (${inTask.text})`)
  check((await download(alice, `/v1/attachments/${taskFile.id}`)).status === 200 && (await download(logins.bob, `/v1/attachments/${taskFile.id}`)).status === 200,
    'people who can see the task open it')
  const bobPrivate = await q1(`select id from sessions where task_id = $1`, [tasks.private.taskId])
  const privateTool = await connect('daemon/record-mcp.ts', asSession(bobPrivate.id as string))
  const inPrivate = await call(privateTool, 'share_file', { path: 'report.txt' })
  const privateRow = await q1('select id from attachments where session_id = $1', [tasks.private.sessionId])
  check(!inPrivate.failed && (await download(logins.bob, `/v1/attachments/${privateRow.id}`)).status === 404, "a share in a private task is not open to a teammate outside it")

  // share_screen, from the box's computer server, with its screen service and browser stood in for.
  screenSocket = join(work, 'screen.sock')
  await new Promise<void>((resolve) => { screen.listen(screenSocket, resolve) })
  const computer = await connect('daemon/computer-mcp.ts', {
    ...asSession(dmSession), AGENTS_SCREEN_SOCKET: screenSocket, AGENTS_BROWSER_MCP: join(ROOT, 'test/fake-browser-mcp.ts'), AGENTS_BROWSER_CDP: 'http://127.0.0.1:9',
  })
  const computerTools = (await computer.listTools()).tools.map((t) => t.name)
  check(computerTools.includes('share_screen'), `the computer server offers share_screen (${computerTools.join(', ')})`)
  const screenShare = await call(computer, 'share_screen', { caption: 'The login page' })
  const screenRow = await q1(`select a.id, a.kind, a.name, a.media_type, a.width, a.added_by_agent, m.body, m.speaker from attachments a join messages m on m.id = a.message_id where a.name = 'screen.png'`)
  check(!screenShare.failed && screenShare.text === 'Shared a screenshot of your screen.' && screenRow.kind === 'image' && screenRow.media_type === 'image/png'
    && screenRow.body === 'The login page' && screenRow.speaker === 'agent' && screenRow.added_by_agent === kit.agentId,
    `share_screen posts the screen as a picture by the agent with the caption (${screenShare.text})`)
  check((await download(alice, `/v1/attachments/${screenRow.id}`)).bytes.equals(PNG), 'alice sees the screenshot the screen service took')
  secretsOnScreen = ['STRIPE_KEY']
  const countBefore = (await q1(`select count(*)::int as n from attachments where name = 'screen.png'`)).n
  const refusedShot = await call(computer, 'share_screen', {})
  check(refusedShot.failed && refusedShot.text.includes('STRIPE_KEY') && (await q1(`select count(*)::int as n from attachments where name = 'screen.png'`)).n === countBefore,
    `nothing is shared while a page shows a secret the box holds (${refusedShot.text.slice(0, 120)})`)
  secretsOnScreen = []
} finally {
  if (failures.length) console.log(`\nthe API printed:\n${kit.api.text().slice(-1500)}`)
  for (const client of clients) await client.close().catch((error: unknown) => { console.error(error) })
  screen.close()
  rmSync(work, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  await q('delete from teams where id = $1', [kit.teamId]).catch((error: unknown) => { console.error(error) })
  await kit.stop()
}

async function attachmentOf(messageId: string): Promise<string> {
  return must((await q('select id from attachments where message_id = $1', [messageId]))[0], 'the post\'s file').id as string
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed')
process.exit(failures.length ? 1 : 0)
