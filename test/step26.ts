// Step 6 of the fit design: agents working together, with the stand-in for Claude
// calling the team-agents tools over MCP as Claude Code does. Alice asks scout to
// have writer write a note: scout's message is a turn for writer through the door,
// their thread is the team's to read, and scout carries on with writer's answer.
// scout hands writer a task, and the result comes back when writer reports back,
// and again when Alice marks another task done. scout asks to make an agent, which
// waits on Alice's yes and is made only with it. A message to Bob's agent is
// refused until Bob allows it, and a chain stops at its fifth hop with every answer
// still coming back. Last, a person's post and a turn ending in one DM at the same
// moment both go through. The API, its runner and the daemon are real, on a Mac
// instance, with ports 8310 to 8312, which no other check uses.
//   node --env-file=.env --env-file=.env.test test/step26.ts

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { asPerson, results, ROOT, shapeRows, startApi, within } from './onboarding-kit.ts'
import { stopAll } from './computers.ts'
import { must } from './must.ts'
import { messageOf } from '../shared/errors.ts'
import { CREATE_AGENT_TOOL, MAX_HOPS } from '../shared/team-agents.ts'

const PORTS = { machines: 8310, people: 8311, streams: 8312 }
const API = `http://127.0.0.1:${PORTS.machines}`
const PEOPLE = `http://127.0.0.1:${PORTS.people}`
// A turn with the stand-in takes a second or two, and a relay of ten turns goes one after another.
const TURN_SECONDS = 60
const RELAY_SECONDS = 180
// The two writes deadlocked in 149 rounds of 150 before they took their locks in one order.
const CLASH_ROUNDS = 20

const id = randomBytes(4).toString('hex')
const team = `together-26-${id}`
const [alice, bob] = [`alice26-${id}@local`, `bob26-${id}@local`]
const send = (to: string, text: string) => ({ tool: 'mcp__team-agents__send_to_agent', input: { to, text } })
// What each agent does, by words in its prompt. The stand-in's own `turns` rules
// give a turn its words, and the wrapper's `calls` rules its tool calls.
const SCENARIO = {
  turns: [
    { match: 'Please write a short note about the launch.', reply: 'Note: the launch moved to Friday, and the release notes are ready.' },
    { match: 'GLOSSARY-JOB', reply: 'Glossary draft: agent, turn, thread.' },
    { match: 'Please review the launch note.', reply: 'Review: the note reads well.' },
  ],
  calls: [
    { match: 'Have writer write a note', calls: [send('writer', 'Please write a short note about the launch.')], say: 'I asked writer for the note.' },
    { match: 'writer answered you', say: 'From writer: {answer}', calls: [] },
    { match: 'answered you, in your thread', say: 'Heard back: {answer}', calls: [] },
    { match: 'Hand the changelog to writer', say: 'I handed the changelog to writer.', calls: [{
      tool: 'mcp__team-agents__delegate_task', input: { to: 'writer', title: 'Write the changelog', instructions: 'List the three changes in this release. CHANGELOG-JOB' },
    }] },
    { match: 'CHANGELOG-JOB', say: 'Reported back.', calls: [{ tool: 'mcp__team-agents__report_back', input: { text: 'Changelog: login fix, faster search, new export.' } }] },
    { match: 'finished the task you handed it', say: "writer's result: {answer}", calls: [] },
    { match: 'Hand the glossary to writer', say: 'I handed the glossary to writer.', calls: [{
      tool: 'mcp__team-agents__delegate_task', input: { to: 'writer', title: 'Write the glossary', instructions: 'Three words we use. GLOSSARY-JOB' },
    }] },
    { match: 'marked the task you handed', say: 'Noted: {answer}', calls: [] },
    { match: 'Make a copy editor', say: 'Asked to make copyedit.', calls: [{
      tool: CREATE_AGENT_TOOL, input: { name: 'copyedit', title: 'Copy edits drafts', instructions: 'Fix spelling and grammar.' },
    }] },
    { match: 'Make a second helper', say: 'Asked to make helper2.', calls: [{ tool: CREATE_AGENT_TOOL, input: { name: 'helper2' } }] },
    { match: 'Who is on the team', say: 'Listed them.', calls: [{ tool: 'mcp__team-agents__list_agents', input: {} }] },
    { match: 'Ask critic for a review', say: 'Asked critic.', calls: [send('critic', 'Please review the launch note.')] },
    { match: 'Ask critic again for a review', say: 'Asked critic again.', calls: [send('critic', 'Please review the launch note.')] },
    { match: 'Ask writer from the room', say: 'Tried writer.', calls: [send('writer', 'Hello from the room.')] },
    // A relay: each agent passes it on, and the fifth hop is refused. An answer
    // coming back quotes no message, so only the leg itself matches.
    { match: 'Start the relay', say: 'Started the relay.', calls: [send('writer', 'Relay leg two for writer.')] },
    { match: 'Relay leg two for writer', say: 'Passed it to editor.', calls: [send('editor', 'Relay leg three for editor.')] },
    { match: 'Relay leg three for editor', say: 'Passed it to proof.', calls: [send('proof', 'Relay leg four for proof.')] },
    { match: 'Relay leg four for proof', say: 'Passed it to typo.', calls: [send('typo', 'Relay leg five for typo.')] },
    { match: 'Relay leg five for typo', say: 'The relay ends with me.', calls: [send('scout', 'Relay leg six for scout.')] },
  ],
}

const { failures, check } = results()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step26-')))
let stopApi: (() => Promise<void>) | null = null
// What the API printed, for a failed run to show its errors.
let apiLog = () => ''

const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
const all = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows
const node = (...args: string[]) => {
  const run = spawn(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  run.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
  return new Promise<string>((resolve, reject) => {
    run.on('exit', (code) => { if (code === 0) resolve(out); else reject(new Error(`${args.join(' ')} exited ${String(code)}`)) })
  })
}
const post = async (login: string, path: string, body: unknown = {}) => {
  const answer = await asPerson(PEOPLE, login, 'POST', path, body)
  if (answer.status !== 200) throw new Error(`${path} as ${login}: ${answer.status} ${answer.text}`)
  return answer.json
}
// A call to the API as a machine's agent session, the way its team-agents tools call.
const asSession = (token: string, sessionId: string, method: string, path: string, body?: unknown) =>
  fetch(`${API}${path}?session=${sessionId}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }))

const agentPosts = async (conversationId: string) => (await all(
  `select body from messages where conversation_id = $1 and speaker = 'agent' order by seq`, [conversationId])).map((m) => String(m.body))
const sessionOf = async (conversationId: string, agentId: string) => must(await one(
  'select id from sessions where conversation_id = $1 and agent_id = $2', [conversationId, agentId]), 'the session').id as string
// The result a session's tool call got, by the tool's name, newest first.
const toolResult = async (sessionId: string, tool: string) => {
  const call = await one(`select tool_use_id from events where session_id = $1 and kind = 'tool_call' and tool_name = $2 order by seq desc limit 1`, [sessionId, tool])
  return call ? one(`select text, body->>'isError' as is_error from events where session_id = $1 and kind = 'tool_result' and tool_use_id = $2`, [sessionId, call.tool_use_id]) : undefined
}
const dmWith = async (login: string, agent: string, text: string) => {
  const { conversationId } = await post(login, '/v1/conversations', { kind: 'dm', agent })
  await post(login, `/v1/conversations/${conversationId}/messages`, { text })
  return String(conversationId)
}
// An agent of this check's team, by name.
const agentNamed = (name: string) => one('select * from agents where name = $1 and team_id = (select team_id from people where login = $2)', [name, alice])
const posted = (conversationId: string, words: string, seconds = TURN_SECONDS) =>
  within(seconds, async () => (await agentPosts(conversationId)).some((body) => body.includes(words)))

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  await db.connect()
  await node('server/migrate.ts')
  await node('server/admin.ts', 'add-team', team, alice)
  await node('server/admin.ts', 'add-person', team, bob)
  const { token } = JSON.parse(await node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', alice))
  const macId = must(await one('select id from instances where name = $1', [`mac-${id}`]), 'the Mac').id
  writeFileSync(join(home, 'scenario.json'), JSON.stringify(SCENARIO))
  const api = await startApi(PORTS, { AGENTS_RUNNER_TEAMS: team }, join(home, 'streams'))
  stopApi = api.stop
  apiLog = api.text
  children.push(api.child)
  await within(20, () => fetch(`${API}/v1/health`).then((res) => res.ok, () => false))
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home,
      AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude-agents.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json'),
    },
  }))

  // Alice's agents, and Bob's critic, on the one Mac.
  const make = async (login: string, name: string, title?: string) => String((await post(login, '/v1/agents', { name, homeInstanceId: macId, title })).agentId)
  const ids = {
    scout: await make(alice, 'scout'), writer: await make(alice, 'writer'), editor: await make(alice, 'editor'),
    proof: await make(alice, 'proof'), typo: await make(alice, 'typo'), critic: await make(bob, 'critic', 'Reviews drafts'),
  }

  // 1. Alice asks scout to have writer write a note.
  const dm = await dmWith(alice, 'scout', 'Have writer write a note about the launch.')
  check(await posted(dm, 'From writer: Note: the launch moved to Friday, and the release notes are ready.'),
    "scout carries on with writer's answer: its next post in Alice's DM quotes writer's note")
  const scoutDm = await sessionOf(dm, ids.scout)
  const thread = await one(`select c.id, c.kind, c.visibility, array_agg(m.agent_id order by m.agent_id) filter (where m.agent_id is not null) as agents,
      count(m.person_id) as people from conversations c join conversation_members m on m.conversation_id = c.id
    where c.team_id = (select team_id from people where login = $1) and c.kind = 'agents' group by c.id`, [alice])
  check(thread?.visibility === 'team' && Number(thread.people) === 0 && JSON.stringify(thread.agents) === JSON.stringify([ids.scout, ids.writer].sort()),
    'the message made a thread between scout and writer that the team can read, with the two agents in it and no person')
  const threadId = String(must(thread, 'the thread').id)
  const inThread = await all(`select m.body, a.name from messages m join agents a on a.id = m.agent_id where m.conversation_id = $1 order by m.seq`, [threadId])
  check(inThread.length === 2 && inThread[0].name === 'scout' && inThread[0].body === 'Please write a short note about the launch.'
    && inThread[1].name === 'writer' && inThread[1].body.startsWith('Note: the launch moved to Friday'),
  `the thread holds scout's message and writer's answer (${inThread.map((m) => `${m.name}: ${m.body.slice(0, 30)}`).join(' | ')})`)
  const writerThread = await sessionOf(threadId, ids.writer)
  const scoutTurn = must(await one(`select id from turns where session_id = $1 and source = 'person' order by requested_at limit 1`, [scoutDm]), "Alice's turn").id
  const message = await one(`select * from turns where session_id = $1 and source = 'agent'`, [writerThread])
  check(message?.asked_by_session === scoutDm && message.answer_to_turn === scoutTurn && message.hops === 1 && message.conversation_id === threadId
    && message.asked_by_person === null && message.status === 'done' && message.command_id !== null && message.instance_id === macId && message.answer_sent_at !== null,
  `scout's message is a turn for writer with source agent, asked by scout's session, one hop, placed by the scheduler with a command, done, and answered (${message?.status}, hops ${message?.hops})`)
  const prompt = await one(`select author, author_agent, text from events where session_id = $1 and kind = 'user' order by seq limit 1`, [writerThread])
  check(prompt?.author === null && prompt.author_agent === ids.scout && prompt.text.includes('scout sent you a message') && prompt.text.includes('Please write a short note'),
    "writer's prompt is a user event written by scout, with no person as its author")
  const answer = await one(`select * from turns where session_id = $1 and source = 'agent'`, [scoutDm])
  check(answer?.asked_by_session === writerThread && answer.hops === 1 && answer.answer_to_turn === null && answer.status === 'done' && answer.conversation_id === dm,
    `writer's answer came back to scout's DM session as a turn with source agent, asked by writer's thread session (${answer?.status})`)
  const sent = await toolResult(scoutDm, 'mcp__team-agents__send_to_agent')
  check(sent?.is_error === 'false' && sent.text.includes(`hop 1 of at most ${MAX_HOPS}`), `scout's send_to_agent call returned at once, naming the hop (${sent?.text})`)
  const seen = (await shapeRows(PEOPLE, alice, 'conversations')).rows.find((c) => c.id === threadId)
  const seenMessages = (await shapeRows(PEOPLE, bob, 'messages', { conversation: threadId })).rows
  check(seen?.kind === 'agents' && seenMessages.length === 2, 'Alice lists the thread among her conversations, and Bob, a teammate, reads its two messages')
  // A thread has no person in it, so to a person it is no conversation of theirs to post in.
  const intruding = await asPerson(PEOPLE, alice, 'POST', `/v1/conversations/${threadId}/messages`, { text: 'Can I join in?' })
  check(intruding.status === 404 && (await all('select 1 from messages where conversation_id = $1', [threadId])).length === 2,
    `a person posts nothing to a thread between agents (${intruding.status} ${intruding.text})`)
  const starts = readFileSync(join(home, 'agents', ids.scout, '.fake', 'starts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  check(starts.length > 0 && starts.every((s) => s.mcpServers.includes('team-agents') && s.allowedTools.includes('mcp__team-agents__send_to_agent')
    && !s.allowedTools.includes(CREATE_AGENT_TOOL) && !s.allowedTools.split(',').includes('mcp__team-agents')),
  "scout's sessions start with the team-agents tools, sending allowed and making an agent left to ask")

  // 2. scout hands writer a task, and writer reports back.
  await post(alice, `/v1/conversations/${dm}/messages`, { text: 'Hand the changelog to writer.' })
  check(await posted(dm, "writer's result: Changelog: login fix, faster search, new export."),
    "writer's report on the handed task comes back to scout, which carries on with it in Alice's DM")
  const task = await one(`select * from tasks where title = 'Write the changelog' and agent_id = $1`, [ids.writer])
  const handTurn = must(await one(`select turn.id from turns turn join events e on e.id = turn.event_id
    where turn.session_id = $1 and e.text = 'Hand the changelog to writer.'`, [scoutDm]), 'the turn that handed the task over').id
  const taskSession = await one('select * from sessions where task_id = $1', [task?.id])
  check(task?.source === 'agent' && task.asked_by_turn === handTurn && task.done_at !== null && task.owner_id !== null
    && taskSession?.started_by_session === scoutDm && taskSession.started_by === null && taskSession.workspace_id !== null,
  "the handed task is writer's, with its own workspace, started by scout's session, and done once writer reported back")
  const firstTurn = await one(`select * from turns where task_id = $1 order by requested_at limit 1`, [task?.id])
  check(firstTurn?.source === 'delegation' && firstTurn.asked_by_session === scoutDm && firstTurn.hops === 1 && firstTurn.answer_to_turn === null,
    `the task's first turn has source delegation, one hop, asked by scout's session (${firstTurn?.source})`)
  const result = await one(`select * from turns where session_id = $1 and source = 'delegation'`, [scoutDm])
  check(result?.asked_by_session === taskSession?.id && result.hops === 1 && result.status === 'done',
    `the result came back to scout's DM session as a delegation turn, asked by the task's session (${result?.status})`)
  const again = await asSession(token, String(taskSession?.id), 'POST', '/v1/team-agents/report', { text: 'Once more.' })
  check(again.status === 409, `a task's result goes back once: a second report is refused (${again.status} ${JSON.stringify(again.json)})`)
  const noTask = await asSession(token, scoutDm, 'POST', '/v1/team-agents/report', { text: 'Done.' })
  check(noTask.status === 409, `a session no agent handed a task reports back to nobody (${noTask.status})`)

  // 2b. A task writer does not report on: Alice marks it done, and scout hears.
  await post(alice, `/v1/conversations/${dm}/messages`, { text: 'Hand the glossary to writer.' })
  const glossary = await within(TURN_SECONDS, async () => (await one(`select t.id from tasks t join turns u on u.task_id = t.id
    where t.title = 'Write the glossary' and t.agent_id = $1 and u.status = 'done'`, [ids.writer])) !== undefined)
  const glossaryTask = must(await one(`select id from tasks where title = 'Write the glossary' and agent_id = $1`, [ids.writer]), 'the glossary task').id
  await post(alice, `/v1/tasks/${glossaryTask}/done`)
  check(glossary && await posted(dm, 'Noted: Glossary draft: agent, turn, thread.'),
    "marking a handed task done sends writer's last words on it to scout, which carries on with them")
  const marked = await one(`select e.text from turns t join events e on e.id = t.event_id where t.session_id = $1 and t.source = 'delegation' order by t.requested_at desc limit 1`, [scoutDm])
  check(marked?.text.startsWith(`${alice} marked the task you handed writer, "Write the glossary", done.`), `the result says who marked the task done (${marked?.text.split('\n')[0]})`)

  // 3. scout asks to make an agent. It waits on Alice's yes, and is made only with it.
  await post(alice, `/v1/conversations/${dm}/messages`, { text: 'Make a copy editor for us.' })
  const asking = await within(TURN_SECONDS, async () => (await one(`select id from asks where session_id = $1 and status = 'open'`, [scoutDm])) !== undefined)
  const opened = await one(`select * from asks where session_id = $1 and status = 'open'`, [scoutDm])
  check(asking && opened?.kind === 'tool_approval' && opened.payload.toolName === CREATE_AGENT_TOOL && opened.conversation_id === dm && opened.payload.input.name === 'copyedit'
    && (await agentNamed('copyedit')) === undefined,
  'making an agent waits on an ask in the DM, and no agent exists while it waits')
  const ask = must(opened, 'the ask')
  const aliceId = must(await one('select id from people where login = $1', [alice]), 'Alice').id
  const shown = { question: ask.payload.question, choices: ask.payload.choices, answerer: ask.payload.answerer }
  check(JSON.stringify(shown) === JSON.stringify({
    question: `scout asks to make a new agent, copyedit. It would be ${alice}'s, on mac-${id}.`,
    choices: [{ id: 'allow', label: 'Make copyedit' }, { id: 'deny', label: "Don't make copyedit" }],
    answerer: { id: aliceId, login: alice },
  }), `the ask carries a question, a choice for each answer, and the one person who may choose (${JSON.stringify(shown)})`)
  const skipped = await asSession(token, scoutDm, 'POST', '/v1/team-agents/agents', { name: 'copyedit', title: 'Copy edits drafts', instructions: 'Fix spelling and grammar.' })
  check(skipped.status === 403 && (await agentNamed('copyedit')) === undefined,
    `the API refuses to make an agent with no answered yes behind it, so an engine that skips the ask makes none (${skipped.status})`)
  const byBob = await asPerson(PEOPLE, bob, 'POST', `/v1/asks/${ask.id}/answer`, { decision: 'allow' })
  const always = await asPerson(PEOPLE, alice, 'POST', `/v1/asks/${ask.id}/answer`, { decision: 'always' })
  check(byBob.status === 403 && always.status === 400, `only the owner says yes to a new agent, one at a time (Bob ${byBob.status}, Always ${always.status})`)
  await post(alice, `/v1/asks/${ask.id}/answer`, { decision: 'allow' })
  const made = await within(TURN_SECONDS, async () => (await agentNamed('copyedit')) !== undefined)
  const copyedit = await one(`select * from agents where name = 'copyedit' and team_id = (select team_id from people where login = $1)`, [alice])
  check(made && copyedit?.owner_id === aliceId && copyedit.home_instance_id === macId
    && copyedit.made_by_session === scoutDm && copyedit.made_by_ask === ask.id && copyedit.title === 'Copy edits drafts',
  "once Alice says yes, the new agent exists: Alice's, on scout's machine, made by scout's session with that yes")
  // With copyedit archived its name is free again, so only the yes itself stands in the way of a second one.
  await db.query('update agents set archived_at = now() where id = $1', [copyedit?.id])
  const reused = await asSession(token, scoutDm, 'POST', '/v1/team-agents/agents', { name: 'copyedit', title: 'Copy edits drafts', instructions: 'Fix spelling and grammar.' })
  const copies = await one(`select count(*)::int as n from agents where made_by_ask = $1 or (name = 'copyedit' and team_id = $2)`, [ask.id, copyedit?.team_id])
  check(reused.status === 403 && Number(copies?.n) === 1, `one yes makes one agent: using it again is refused (${reused.status}), and there is still one copyedit`)
  await post(alice, `/v1/conversations/${dm}/messages`, { text: 'Make a second helper too.' })
  await within(TURN_SECONDS, async () => (await one(`select id from asks where session_id = $1 and status = 'open'`, [scoutDm])) !== undefined)
  const second = must(await one(`select id from asks where session_id = $1 and status = 'open'`, [scoutDm]), 'the second ask')
  await post(alice, `/v1/asks/${second.id}/answer`, { decision: 'deny' })
  const denied = await within(TURN_SECONDS, async () => (await toolResult(scoutDm, CREATE_AGENT_TOOL))?.is_error === 'true')
  check(denied && (await agentNamed('helper2')) === undefined, 'a no makes no agent, and scout is told')

  // 4. A message to Bob's agent is refused until Bob lets other people's agents in.
  await post(alice, `/v1/conversations/${dm}/messages`, { text: 'Who is on the team?' })
  await within(TURN_SECONDS, async () => (await toolResult(scoutDm, 'mcp__team-agents__list_agents')) !== undefined)
  const listed = await toolResult(scoutDm, 'mcp__team-agents__list_agents')
  check(listed?.text.includes('scout (you)') && listed.text.includes(`critic · Reviews drafts · ${bob}'s · does not take your messages`)
    && listed.text.includes(`writer · no title · ${alice}'s · takes your messages`), `list_agents says whose each agent is and whether it takes scout's messages`)
  await post(alice, `/v1/conversations/${dm}/messages`, { text: 'Ask critic for a review.' })
  const refused = await within(TURN_SECONDS, async () => (await toolResult(scoutDm, 'mcp__team-agents__send_to_agent'))?.text.includes('critic'))
  const refusal = await toolResult(scoutDm, 'mcp__team-agents__send_to_agent')
  check(refused && refusal?.is_error === 'true' && refusal.text.includes(`critic is ${bob}'s agent`)
    && (await one(`select 1 from turns where agent_id = $1`, [ids.critic])) === undefined,
  `a message to another person's agent is refused, and critic gets no turn (${refusal?.text})`)
  const byAlice = await asPerson(PEOPLE, alice, 'POST', `/v1/agents/${ids.critic}/accepts`, { agents: 'team' })
  check(byAlice.status === 403, `only critic's owner lets other people's agents message it (${byAlice.status})`)
  await post(bob, `/v1/agents/${ids.critic}/accepts`, { agents: 'team' })
  await post(alice, `/v1/conversations/${dm}/messages`, { text: 'Ask critic again for a review.' })
  check(await within(TURN_SECONDS, async () => (await one(`select status from turns where agent_id = $1 and source = 'agent'`, [ids.critic]))?.status === 'done')
    && await posted(dm, 'Heard back: Review: the note reads well.'),
  "once Bob allows it, scout's message reaches critic as a turn, and critic's answer comes back to scout")

  // 5. A room's agent cannot message other agents yet.
  const { conversationId: room } = await post(alice, '/v1/conversations', { kind: 'room', name: `relay-${id}`, agents: ['scout'] })
  await post(alice, `/v1/conversations/${room}/messages`, { text: 'Ask writer from the room, please.' })
  const roomSession = await within(TURN_SECONDS, async () => (await one(`select id from sessions where conversation_id = $1`, [room])) !== undefined)
  const fromRoom = roomSession ? await within(TURN_SECONDS, async () => (await toolResult(await sessionOf(room, ids.scout), 'mcp__team-agents__send_to_agent')) !== undefined) : false
  const roomRefusal = fromRoom ? await toolResult(await sessionOf(room, ids.scout), 'mcp__team-agents__send_to_agent') : undefined
  check(roomRefusal?.is_error === 'true' && roomRefusal.text.includes('in a room'), `an agent in a room is told it cannot message other agents yet (${roomRefusal?.text})`)

  // 6. A relay of agents stops at the fifth hop, and every answer still comes back.
  await post(alice, `/v1/conversations/${dm}/messages`, { text: 'Start the relay.' })
  // typo's one session is its thread with proof, the relay's last leg.
  const typoSession = async () => String((await one('select id from sessions where agent_id = $1', [ids.typo]))?.id ?? '')
  const reachedTypo = await within(RELAY_SECONDS, async () => {
    const session = await typoSession()
    return session !== '' && (await toolResult(session, 'mcp__team-agents__send_to_agent')) !== undefined
  })
  const fifth = await toolResult(await typoSession(), 'mcp__team-agents__send_to_agent')
  const typoTurn = await one(`select t.hops, c.kind from turns t join conversations c on c.id = t.conversation_id
    where t.session_id = $1 and t.source = 'agent' order by t.requested_at limit 1`, [await typoSession()])
  check(reachedTypo && typoTurn?.hops === MAX_HOPS && typoTurn.kind === 'agents' && fifth?.is_error === 'true' && fifth.text.includes(`hop ${MAX_HOPS + 1} of the chain`),
    `the fourth agent in the relay is hop ${MAX_HOPS}, and its message, hop ${MAX_HOPS + 1}, is refused (${fifth?.text})`)
  const tooFar = await one(`select count(*)::int as n from turns where team_id = (select team_id from people where login = $1) and hops > $2`, [alice, MAX_HOPS])
  check(Number(tooFar?.n) === 0, `no turn in the team is past hop ${MAX_HOPS}`)
  const settled = await within(RELAY_SECONDS, async () => {
    const open = await one(`select count(*)::int as n from turns where team_id = (select team_id from people where login = $1)
      and (status not in ('done', 'failed', 'cancelled') or (answer_to_turn is not null and answer_sent_at is null))`, [alice])
    return Number(open?.n) === 0
  })
  const backToScout = await one(`select count(*)::int as n from turns where session_id = $1 and source = 'agent' and hops = $2`, [scoutDm, MAX_HOPS])
  check(settled && Number(backToScout?.n) === 1, `every turn of the relay ended and sent its answer back, the last one to scout's DM at hop ${MAX_HOPS}`)

  // 7. Answers end turns in DMs while people type in them. A person's post and a
  // turn's end in one DM, at the same moment, both go through.
  const echo = await make(alice, 'echo')
  const echoDm = await dmWith(alice, 'echo', 'Hello, echo.')
  const echoSession = await within(TURN_SECONDS, async () => (await one('select 1 from sessions where conversation_id = $1', [echoDm])) !== undefined)
    ? await sessionOf(echoDm, echo) : ''
  let clashes = 0
  for (let round = 0; round < CLASH_ROUNDS; round++) {
    const [person, machine] = await Promise.all([
      asPerson(PEOPLE, alice, 'POST', `/v1/conversations/${echoDm}/messages`, { text: `At once, round ${round}.` }),
      asSession(token, echoSession, 'POST', `/v1/sessions/${echoSession}/events`, { events: [
        { clientId: `clash-${round}-reply`, kind: 'assistant', text: `Reply ${round}.`, body: { text: `Reply ${round}.` } },
        { clientId: `clash-${round}-end`, kind: 'usage', body: {} },
      ] }),
    ])
    if (person.status !== 200 || machine.status !== 200) clashes++
  }
  check(echoSession !== '' && clashes === 0, `a person's post and a turn ending in one DM at once both go through, ${CLASH_ROUNDS - clashes} rounds of ${CLASH_ROUNDS}`)
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : messageOf(error)}`)
} finally {
  await stopAll(children.filter((child) => child !== children[0]))
  await stopApi?.()
  if (failures.length) console.log(`\nthe API's errors:\n${apiLog().split('\n').filter((line) => /error|deadlock|at /i.test(line)).slice(0, 40).join('\n')}`)
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
    rmSync(home, { recursive: true, force: true })
  }
  await db.end().catch(() => undefined)
}


console.log(`\n${failures.length ? `${failures.length} failed (team ${team} kept, files in ${home})` : 'all passed (test team removed)'}`)
process.exit(failures.length ? 1 : 0)
