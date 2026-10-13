// Phase 4 step 10: rooms, tasks, comments, agents' setup, routines and
// templates, with the stand-in for Claude. In a room two agents take turns after
// a post, one passes, and an @mention asks one agent alone. A task started from a
// post reports back to its conversation. A comment on a task's document reaches
// the agent, which revises it. An agent's skills become skill files, its plugins
// become MCP servers with secrets from the machine, and its memory rides along in
// its instructions. The team-record tools are called through a real MCP client.
// A routine fires on its minute, and a template makes a second agent like the first.
//   npm run check:step10

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { writeSkills } from '../daemon/agentfiles.ts'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = 7861
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 100}`
const id = randomBytes(4).toString('hex')
const [team, otherTeam] = [`step10-${id}`, `step10x-${id}`]
const [alice, amir, outsider] = [`alice10-${id}@local`, `amir10-${id}@local`, `out10-${id}@local`]
const LUCKY = `lucky-${randomBytes(6).toString('hex')}`

const SCENARIO = {
  turns: [
    { match: 'You are fixer in the room', reply: 'I can look at the checkout bug today.' },
    { match: 'You are writer in the room', reply: 'PASS' },
    { match: 'commented on ./task/notes.md', write: { 'task/notes.md': '# Notes\n\nRevised after the comment: totals never go below zero.\n' }, reply: 'Revised notes.md.' },
    { match: 'Write up the shipping rules', write: { 'task/notes.md': '# Notes\n\nShipping rules go here.\n' }, reply: 'Wrote task/notes.md with the shipping rules.' },
    { match: 'Routine "standup"', reply: 'Standup: nothing is blocked.' },
  ],
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })

async function within(seconds: number, test: () => Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(400)
  }
  return false
}

const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T | undefined
const all = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[]

async function as(who: string, path: string, body: unknown = {}) {
  return fetch(PEOPLE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': who }, body: JSON.stringify(body) })
}
async function post(path: string, body: unknown = {}, who = alice) {
  const res = await as(who, path, body)
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}
const messages = (conversationId: string) => all<{ speaker: string; body: string; agent: string | null; person_id: string | null }>(
  `select m.speaker, m.body, a.name as agent, m.person_id from messages m left join agents a on a.id = m.agent_id
   where m.conversation_id = $1 order by m.seq`, [conversationId])

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step10-')))

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, alice)
  node('server/admin.ts', 'add-person', team, amir)
  node('server/admin.ts', 'add-team', otherTeam, outsider)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', alice))
  const { agentId: fixer } = JSON.parse(node('server/admin.ts', 'add-agent', team, 'fixer', `mac-${id}`, '', 'You fix bugs.'))
  const { agentId: writer } = JSON.parse(node('server/admin.ts', 'add-agent', team, 'writer', `mac-${id}`, '', 'You write docs.'))
  writeFileSync(join(home, 'scenario.json'), JSON.stringify(SCENARIO))
  writeFileSync(join(home, 'secrets.json'), JSON.stringify({ LUCKY_TOKEN: LUCKY }), { mode: 0o600 })

  children.push(spawn(process.execPath, ['--env-file=.env', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_PORT: String(PORT + 100), AGENTS_STREAMS_PORT: String(PORT + 1), AGENTS_STREAMS_DIR: join(home, 'streams') },
  }))
  await within(20, () => fetch(API).then(() => true, () => false))
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home, AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json') },
  }))

  // Setup from the app: a skill, a plugin that needs a secret, a routine.
  await post(`/v1/agents/${fixer}`, { title: 'Fixes bugs', instructions: 'You fix bugs. Keep replies short.' })
  await post(`/v1/agents/${fixer}/skills`, { name: 'release-notes', description: 'Writing release notes', content: 'List each merged pull request with one line.' })
  await post(`/v1/agents/${fixer}/plugins`, { name: 'lucky', kind: 'stdio', config: { command: 'node', args: ['lucky.js'], env: { LUCKY: { secret: 'LUCKY_TOKEN' } } } })
  const leaked = await as(alice, `/v1/agents/${fixer}/plugins`, { name: 'leaky', kind: 'stdio', config: { command: 'node', env: { TOKEN: 'sk-real-value' } } })
  check(leaked.status === 400, 'a plugin may name a secret but never hold its value')
  const stranger = await as(outsider, `/v1/agents/${fixer}`, { instructions: 'Take over.' })
  check(stranger.status === 404, "a person from another team cannot change the agent")

  // A room: both agents take a turn, one after the other, and one passes.
  const { conversationId: room } = await post('/v1/conversations', { kind: 'room', name: 'launch', people: [amir], agents: ['fixer', 'writer'] })
  await post(`/v1/conversations/${room}/messages`, { text: 'What should we ship this week?' })
  const bothWent = await within(60, async () => Number((await one<{ n: number }>(`select count(*)::int as n from turns where conversation_id = $1 and outcome is not null`, [room]))?.n) === 2)
  const turns = await all<{ agent: string; outcome: string; started_at: Date; finished_at: Date }>(
    `select a.name as agent, t.outcome, t.started_at, t.finished_at from turns t join agents a on a.id = t.agent_id where t.conversation_id = $1 order by t.started_at`, [room])
  check(bothWent && turns[0]?.agent === 'fixer' && turns[0].outcome === 'sent' && turns[1]?.agent === 'writer' && turns[1].outcome === 'pass'
    && turns[1].started_at >= turns[0].finished_at,
  `after a post both agents took a turn, one after the other: ${turns.map((t) => `${t.agent}:${t.outcome}`).join(' ')}`)
  const said = await messages(room)
  check(said.some((m) => m.agent === 'fixer' && m.body.includes('checkout bug')) && !said.some((m) => m.body.trim() === 'PASS'),
    'the reply was posted to the room and the pass was not')
  const writerPrompt = await one<{ text: string }>(
    `select e.text from events e join sessions s on s.id = e.session_id join agents a on a.id = s.agent_id
     where s.conversation_id = $1 and a.name = 'writer' and e.kind = 'user' order by e.seq desc limit 1`, [room])
  check(writerPrompt?.text.includes('fixer: I can look at the checkout bug today.'), 'the second agent saw what the first one said')
  await post(`/v1/conversations/${room}/messages`, { text: '@writer can you draft the announcement?' }, amir)
  await within(30, async () => Number((await one<{ n: number }>(`select count(*)::int as n from turns where conversation_id = $1 and outcome is not null`, [room]))?.n) === 3)
  const third = await all<{ agent: string }>(`select a.name as agent from turns t join agents a on a.id = t.agent_id where t.conversation_id = $1 order by t.requested_at`, [room])
  check(third.length === 3 && third[2]?.agent === 'writer', "a teammate's @mention gives only that agent a turn")

  // The fixer's session got its skill as a file and its plugin with the secret filled in.
  const fixerSession = await one<{ id: string }>(`select id from sessions where conversation_id = $1 and agent_id = $2`, [room, fixer])
  const skillFile = join(home, 'agents', fixer, '.claude', 'skills', 'release-notes', 'SKILL.md')
  const mcp = JSON.parse(readFileSync(join(home, 'sessions', `${fixerSession?.id}.mcp.json`), 'utf8'))
  check(existsSync(skillFile) && readFileSync(skillFile, 'utf8').includes('description: Writing release notes'), "the agent's skill became a skill file in its folder")
  // A skill's name is a folder on the machine, so a daemon refuses one that is a path, whatever the server sent.
  const folder = join(realpathSync(mkdtempSync(join(tmpdir(), 'agents-step10-skills-'))), 'agent')
  let refused = ''
  try {
    writeSkills(folder, [{ name: '../escaped', description: 'x', content: 'x' }])
  } catch (error) {
    refused = (error as Error).message
  }
  check(refused.includes('../escaped') && !existsSync(join(folder, '.claude', 'escaped')) && !existsSync(join(folder, '.claude', 'skills')),
    'a daemon refuses a skill whose name is a path, and writes nothing')
  check(mcp.mcpServers.lucky?.env?.LUCKY === LUCKY && mcp.mcpServers['team-record'], "the agent's plugin became an MCP server with the secret from this machine")
  const anywhere = await all(`select 1 from plugins where config::text like $1 union all select 1 from events where text like $1 or body::text like $1`, [`%${LUCKY}%`])
  check(anywhere.length === 0, "the secret's value never reached Postgres")

  // Memory: the agent writes it through its tool, and the next session starts with it.
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(ROOT, 'daemon/record-mcp.ts')],
    env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_SESSION: must(fixerSession, 'fixerSession').id },
  })
  const tools = new Client({ name: 'step10', version: '1.0.0' })
  await tools.connect(transport)
  const listed = (await tools.listTools()).tools.map((t) => t.name)
  check(['search_record', 'read_session', 'recent_activity', 'pipeline_history', 'agent_profile', 'update_memory'].every((t) => listed.includes(t)),
    `the team-record tools are all there: ${listed.join(', ')}`)
  await tools.callTool({ name: 'update_memory', arguments: { about: alice, kind: 'profile', content: 'Prefers short replies with the command first.' } })
  await tools.callTool({ name: 'update_memory', arguments: { about: 'team', kind: 'log', content: 'Agreed to ship the checkout fix this week.' } })
  const profile = await tools.callTool({ name: 'agent_profile', arguments: { name: 'fixer' } }) as { content: { text: string }[] }
  const profileText = profile.content[0]?.text ?? ''
  check(profileText.includes('You fix bugs. Keep replies short.') && profileText.includes('release-notes'),
    "agent_profile shows the agent's instructions and skills")
  const bad = await tools.callTool({ name: 'update_memory', arguments: { about: outsider, kind: 'log', content: 'x' } }) as { isError?: boolean }
  check(bad.isError, 'an agent cannot keep memories about someone outside its team')
  await tools.close()
  const { conversationId: dm } = await post('/v1/conversations', { kind: 'dm', agent: 'fixer' })
  await post(`/v1/conversations/${dm}/messages`, { text: 'hello' })
  await within(30, () => one(`select 1 from commands c join sessions s on s.id = c.session_id where s.conversation_id = $1 and c.kind = 'message'`, [dm]))
  const sent = await one<{ payload: { memory?: string } }>(
    `select c.payload from commands c join sessions s on s.id = c.session_id where s.conversation_id = $1 and c.kind = 'message'`, [dm])
  check(sent?.payload.memory?.includes('Prefers short replies with the command first.') && sent.payload.memory.includes('Agreed to ship the checkout fix'),
    "the agent's next session starts with what it remembered about that person and the team")

  // A running session takes a change to its agent on the next message: the process
  // restarts with the new instructions and resumes the same conversation.
  const starts = () => readFileSync(join(home, 'agents', fixer, '.fake', 'starts.jsonl'), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as { sessionId: string; resumed: boolean; instructions: string })
  await within(30, () => one(`select 1 from sessions where conversation_id = $1 and status = 'idle'`, [dm]))
  await post(`/v1/agents/${fixer}`, { instructions: 'You fix bugs. Lead with the diff.' })
  await post(`/v1/conversations/${dm}/messages`, { text: 'Anything else?' })
  const dmSession = await one<{ harness_session_id: string }>('select harness_session_id from sessions where conversation_id = $1', [dm])
  check(await within(30, async () => starts().some((s) => s.resumed && s.sessionId === dmSession?.harness_session_id && s.instructions.includes('Lead with the diff')))
    && await within(30, async () => (await messages(dm)).filter((m) => m.agent === 'fixer').length === 2),
  "after the agent's instructions changed, its next message restarted the session with them, in the same conversation")
  await post(`/v1/agents/${fixer}`, { instructions: 'You fix bugs. Keep replies short.' })

  // A task started from a post: it works in its own workspace and reports back.
  const post1 = must((await db.query<{ id: string }>(`select id from messages where conversation_id = $1 and speaker = 'person' order by seq desc limit 1`, [dm])).rows[0], 'the post in the DM')
  const { taskId, sessionId } = await post('/v1/tasks', { title: 'Write up the shipping rules', instructions: 'Put them in a document.', agentId: fixer, conversationId: dm, messageId: post1.id })
  const reported = await within(60, async () => (await messages(dm)).some((m) => m.body.startsWith('Task "Write up the shipping rules"')))
  check(reported && (await one<{ task_id: string }>('select task_id from messages where id = $1', [post1.id]))?.task_id === taskId,
    'a task started from a post did its work and reported back to that conversation')
  const doc = await one<{ id: string; current_version: number }>(`select id, current_version from artifacts where task_id = $1 and path = 'notes.md'`, [taskId])
  check(doc?.current_version === 1, "the task's document was saved as version 1")

  // A comment sent to the agent gets the document revised.
  const outsiderComment = await as(outsider, `/v1/artifacts/${doc?.id}/comments`, { version: 1, text: 'hi', send: true })
  check(outsiderComment.status === 404, 'a person from another team cannot comment')
  await post(`/v1/artifacts/${must(doc, 'doc').id}/comments`, { version: 1, text: 'Say that totals never go below zero.', quote: 'Shipping rules go here.', send: true })
  check(await within(60, async () => (await one<{ current_version: number }>('select current_version from artifacts where id = $1', [must(doc, 'doc').id]))?.current_version === 2),
    'a comment sent to the agent reached its session, and it revised the document to version 2')
  const v2 = await one<{ content: string }>('select content from artifact_versions where artifact_id = $1 and version = 2', [must(doc, 'v2').id])
  const asked = await one<{ text: string }>(`select text from events where session_id = $1 and kind = 'user' order by seq desc limit 1`, [sessionId])
  check(v2?.content.includes('never go below zero') && asked?.text.includes('On "Shipping rules go here."'), 'the agent saw the quote and the comment')
  const comment = must((await db.query<{ id: string }>('select id from comments where artifact_id = $1', [must(doc, 'doc').id])).rows[0], 'the comment')
  await post(`/v1/comments/${comment.id}/resolve`)
  check((await one<{ status: string }>('select status from comments where id = $1', [comment.id]))?.status === 'resolved', 'the comment can be resolved')

  // A routine, run now and on its schedule.
  const at = new Date(Date.now() + 2 * 60_000)
  await post(`/v1/agents/${fixer}/routines`, { name: 'standup', schedule: `${at.getMinutes()} ${at.getHours()} * * *`, prompt: 'Say what is blocked.' })
  const badRoutine = await as(alice, `/v1/agents/${fixer}/routines`, { name: 'never', schedule: '61 * * * *', prompt: 'x' })
  check(badRoutine.status === 400, 'a routine with a schedule that cannot run is refused')
  const routine = must((await db.query<{ id: string }>(`select id from routines where agent_id = $1 and name = 'standup'`, [fixer])).rows[0], 'the routine')
  const { conversationId: main } = await post(`/v1/routines/${routine.id}/run`)
  check(await within(60, async () => (await messages(main)).some((m) => m.agent === 'fixer' && m.body.includes('nothing is blocked'))),
    "running a routine sends its prompt to the agent's main conversation, and the agent answers there")
  const before = (await messages(main)).length
  check(await within(200, async () => (await messages(main)).length >= before + 2), 'the routine fired again on its minute')

  // A template makes a second agent like the first.
  const { slug, version } = await post(`/v1/agents/${fixer}/templates`, { name: 'bug fixer' })
  const { agentId: copy } = await post('/v1/agents', { name: 'fixer-two', homeInstanceId: must(await one<{ id: string }>('select id from instances where name = $1', [`mac-${id}`]), 'copy').id, templateSlug: slug })
  const copied = await one<{ instructions: string; title: string }>('select instructions, title from agents where id = $1', [copy])
  const copiedParts = await one<{ skills: number; plugins: number; routines: number }>(
    `select (select count(*)::int from skills where agent_id = $1) as skills, (select count(*)::int from plugins where agent_id = $1) as plugins,
       (select count(*)::int from routines where agent_id = $1) as routines`, [copy])
  check(version === 1 && copied?.instructions === 'You fix bugs. Keep replies short.' && copied.title === 'Fixes bugs'
    && copiedParts?.skills === 1 && copiedParts.plugins === 1 && copiedParts.routines === 1,
  'a template saved from one agent gave a new agent the same instructions, skill, plugin and routine')
  const again = await post(`/v1/agents/${fixer}/templates`, { name: 'bug fixer' })
  check(again.version === 2 && again.slug === slug, 'saving the template again makes version 2')

  // A plugin whose secret this machine lacks stops the session with a clear reason.
  await post(`/v1/agents/${writer}/plugins`, { name: 'needs-key', kind: 'stdio', config: { command: 'node', env: { KEY: { secret: 'MISSING_KEY_FOR_STEP10' } } } })
  const { conversationId: writerDm } = await post('/v1/conversations', { kind: 'dm', agent: 'writer' })
  await post(`/v1/conversations/${writerDm}/messages`, { text: 'hi' })
  check(await within(30, () => one(`select 1 from sessions s join events e on e.session_id = s.id
    where s.conversation_id = $1 and s.status = 'failed' and e.kind = 'error' and e.text like '%MISSING_KEY_FOR_STEP10%'`, [writerDm])),
  "a plugin's missing secret fails the session, and the session says which secret")
  // In a room that agent gives up its turn at once, rather than holding the room until its deadline.
  await post(`/v1/conversations/${room}/messages`, { text: '@writer one more thing?' }, amir)
  check(await within(30, () => one(`select 1 from turns t join agents a on a.id = t.agent_id
    where t.conversation_id = $1 and a.name = 'writer' and t.outcome = 'error'`, [room])),
  'an agent whose session cannot start gives up its turn in the room at once')
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) await db.query('delete from teams where name = any($1)', [[team, otherTeam]]).catch(() => {})
  await db.end().catch(() => {})
}

console.log(`\n${failures.length ? `${failures.length} failed (teams ${team}, ${otherTeam} kept)` : 'all passed (test teams removed)'}`)
process.exit(failures.length ? 1 : 0)
