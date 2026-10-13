// Phase 1 step 1, on the agreed data model. A person DMs an agent, and the
// agent's session runs through a daemon. The record must hold every event in
// order and match Claude's own transcript. The agent's replies must come back
// into the conversation, the record must be searchable, and nothing may hold a
// secret.
//   npm run check:step1

import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { makeScrub } from '../shared/scrub.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = 7790
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 100}`
const id = randomBytes(4).toString('hex')
const team = `step1-${id}`
const login = `step1-${id}@local`
const agentName = `tester-${id}`
const instanceName = `mac-${id}`
const envSecret = randomBytes(18).toString('base64url')
const githubToken = `ghp_${randomBytes(27).toString('hex').slice(0, 36)}`

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

function node(...args: string[]) {
  return execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
}

function run(script: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] })
  children.push(child)
  return child
}

async function person(path: string, body: unknown) {
  const res = await fetch(PEOPLE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'tailscale-user-login': login },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

async function until(label: string, seconds: number, test: () => Promise<boolean>) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const count = async (sql: string, params: unknown[]) => Number((await db.query(sql, params)).rows[0].count)

// Tool use ids and assistant text from Claude's own transcript of the session.
function transcript(harnessSessionId: string) {
  const projects = join(homedir(), '.claude', 'projects')
  const dir = readdirSync(projects).find((d) => existsSync(join(projects, d, `${harnessSessionId}.jsonl`)))
  if (!dir) throw new Error(`no transcript for ${harnessSessionId}`)
  const toolUseIds = new Set<string>()
  const texts = new Set<string>()
  for (const raw of readFileSync(join(projects, dir, `${harnessSessionId}.jsonl`), 'utf8').split('\n')) {
    if (!raw) continue
    const line = JSON.parse(raw)
    if (line.type !== 'assistant' || line.isSidechain || !Array.isArray(line.message?.content)) continue
    for (const block of line.message.content) {
      if (block.type === 'tool_use') toolUseIds.add(block.id)
      if (block.type === 'text' && block.text) texts.add(block.text)
    }
  }
  return { toolUseIds, texts }
}

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, login)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, instanceName, 'mac', login))
  const { agentId } = JSON.parse(node('server/admin.ts', 'add-agent', team, agentName, instanceName, 'haiku', 'Answer briefly.'))

  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step1-')))
  const agentDir = join(home, 'agents', agentId)
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, 'notes.txt'),
    `Deploy password: ${envSecret}\nBackup token: ${githubToken}\nThe word to remember is pelican.\n`)

  run('server/api.ts', { AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'), AGENTS_STREAMS_PORT: '7797', AGENTS_STREAMS_DIR: join(home, 'streams') })
  await servePeople(PORT + 100, join(home, 'people.sock'))
  await until('api', 20, async () => fetch(API).then(() => true, () => false))
  const daemon = run('daemon/agentsd.ts', { AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home, AGENTS_TEST_SECRET: envSecret })
  const instanceIs = (status: string) => async () =>
    (await count('select count(*) from instances where name = $1 and status = $2', [instanceName, status])) === 1
  await until('instance online', 20, instanceIs('online'))

  const { conversationId } = await person('/v1/conversations', { kind: 'dm', agent: agentName })
  await person(`/v1/conversations/${conversationId}/messages`, {
    text: 'Read notes.txt with the Read tool, then quote every line of it back to me exactly.',
  })
  const { rows: [{ id: sessionId }] } = await db.query('select id from sessions where conversation_id = $1', [conversationId])
  const turnsEnded = () => count(`select count(*) from events where session_id = $1 and kind = 'usage'`, [sessionId])
  await until('first turn', 180, async () => (await turnsEnded()) === 1)
  await person(`/v1/conversations/${conversationId}/messages`, { text: 'Which word were you told to remember? Answer in one word.' })
  await until('second turn', 180, async () => (await turnsEnded()) === 2)

  daemon.kill('SIGTERM')
  await until('daemon exit', 30, async () => daemon.exitCode !== null)

  const { rows: [session] } = await db.query('select * from sessions where id = $1', [sessionId])
  const { rows: [me] } = await db.query('select id, team_id from people where login = $1', [login])
  const { rows: events } = await db.query(
    `select id::text, seq::int, kind, author, tool_use_id, tool_name, text, body, body::text as raw
     from events where session_id = $1 order by seq`, [sessionId])
  const { rows: messages } = await db.query(
    'select seq::int, speaker, body, session_id, event_id::text from messages where conversation_id = $1 order by seq',
    [conversationId])
  const of = (kind: string) => events.filter((e) => e.kind === kind)

  check(events.length > 0 && events.every((e, i) => e.seq === i + 1) && Number(session.last_seq) === events.length,
    `${events.length} events with seqs 1..${events.length} and no gaps`)
  check(of('user').length === 2 && of('user')[0].seq === 1 && of('user').every((e) => e.author === me.id),
    'both messages reached the session as user events, from the person who sent them')
  const [usage1, usage2] = of('usage')
  const user2 = of('user')[1]
  check(usage1 && user2 && usage2 && usage1.seq < user2.seq && user2.seq < usage2.seq,
    'turn one ends before the second message, which comes before turn two ends')
  check(of('notice').some((e) => e.body.subtype === 'init'), 'the harness init is recorded')

  const calls = of('tool_call')
  const resultIds = new Set(of('tool_result').map((e) => e.tool_use_id))
  check(calls.some((e) => e.tool_name === 'Read') && calls.every((e) => e.tool_use_id && resultIds.has(e.tool_use_id)),
    `every tool call (${calls.length}) has its result, linked by the tool_use_id column`)

  const truth = transcript(session.harness_session_id)
  const recordedCalls = new Set(calls.map((e) => e.tool_use_id))
  // Claude's transcript keeps the raw secrets that the record replaced.
  const scrub = makeScrub([['AGENTS_TEST_SECRET', envSecret]])
  const recordedTexts = new Set(of('assistant').map((e) => e.body.text))
  check([...truth.toolUseIds].every((i) => recordedCalls.has(i)),
    `all ${truth.toolUseIds.size} tool calls in Claude's transcript are in the record`)
  check(truth.texts.size > 0 && [...truth.texts].every((t) => recordedTexts.has(scrub(t))),
    `all ${truth.texts.size} assistant texts in Claude's transcript are in the record`)

  const byId = new Map(events.map((e) => [e.id, e]))
  const agentPosts = messages.filter((m) => m.speaker === 'agent')
  check(messages.map((m) => m.speaker).join() === 'person,agent,person,agent',
    'the conversation reads person, agent, person, agent')
  check(agentPosts.length === 2 && agentPosts.every((m) =>
    m.session_id === sessionId && byId.get(m.event_id)?.kind === 'assistant' && byId.get(m.event_id)?.body.text === m.body),
  'each agent post links to the assistant event that wrote it')
  check(/pelican/i.test(agentPosts[1]?.body ?? ''), 'the agent answered the second message from what it read')

  const recordHits = await count(
    `select count(*) from events where session_id = $1
       and to_tsvector('english', coalesce(text, '')) @@ plainto_tsquery('english', 'pelican')`, [sessionId])
  const postHits = await count(
    `select count(*) from messages where conversation_id = $1
       and to_tsvector('english', body) @@ plainto_tsquery('english', 'pelican')`, [conversationId])
  check(recordHits > 0 && postHits > 0, 'a search for "pelican" finds it in the record and in the conversation')

  const leaks = await count(
    `select (select count(*) from events where team_id = $1
               and (body::text like $2 or body::text like $3 or coalesce(text, '') like $2 or coalesce(text, '') like $3))
          + (select count(*) from raw_events r join sessions s on s.id = r.session_id
               where s.team_id = $1 and (r.line::text like $2 or r.line::text like $3))
          + (select count(*) from messages where team_id = $1 and (body like $2 or body like $3))
          + (select count(*) from commands where team_id = $1 and (payload::text like $2 or payload::text like $3))
       as count`, [me.team_id, `%${envSecret}%`, `%${githubToken}%`])
  check(leaks === 0, 'no event, raw line, post or command holds the environment secret or the GitHub token')
  check(of('tool_result').some((e) => e.raw.includes('[secret:AGENTS_TEST_SECRET]') && e.raw.includes('[secret:github]')),
    'the file contents reached the record with both secrets replaced')

  const rawResults = await count(`select count(*) from raw_events where session_id = $1 and line->>'type' = 'result'`, [sessionId])
  const rawInits = await count(`select count(*) from raw_events where session_id = $1 and line->>'subtype' = 'init'`, [sessionId])
  check(rawResults === 2 && rawInits >= 1, "Claude's raw lines are kept, including both turn results")

  const { rows: commands } = await db.query('select kind, status from commands where session_id = $1', [sessionId])
  check(commands.length === 2 && commands.every((c) => c.kind === 'message' && c.status === 'done'),
    'both messages went to the machine as commands, and both are done')
  check(session.status === 'idle' && Boolean(session.harness_session_id) && session.turns === 2,
    'the session ended idle and resumable, with 2 turns')
  check(await instanceIs('offline')(), 'the instance went offline when the daemon stopped')
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  if (!failures.length) await db.query('delete from teams where name = $1', [team]).catch(() => {})
  await db.end()
}

console.log(`\n${failures.length ? `${failures.length} failed (test team ${team} kept for inspection)` : 'all passed (test team removed)'}`)
process.exit(failures.length ? 1 : 0)
