// Durability check 1, with real Claude. A person asks an agent for a poem. While
// the model is writing it, the machine dies. The daemon goes first, then Claude
// and every process under it. When the daemon starts again it reports the turn as
// interrupted and resumes the same Claude conversation, and the poem lands in
// the conversation. The record says what happened, and a reconnecting client
// reads what the record holds.
//   node --env-file=.env --env-file=.env.test test/step18a.ts

import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { stream } from '@durable-streams/client'
import type { LiveDelta } from '../shared/types.ts'
import { Check, clientsMatchRecord, killMachine, person, TURN_SECONDS, until } from './crash.ts'

const PORT = 8046
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const id = randomBytes(4).toString('hex')
const team = `dur-a-${id}`
const login = `${team}@local`
const ASK = 'Write a forty-line poem about lighthouses, one line of verse per line. Do not call any tools, and do not search the team record first. Reply with the poem only.'
// A few lines of the poem, enough to be sure the model is mid-reply.
const STREAMED_CHARS = 200

const c = new Check()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-dur-a-')))
const say = person(PEOPLE, login)

// Claude's own transcript of a conversation, as raw lines.
function transcript(harnessSessionId: string): string[] {
  const projects = join(homedir(), '.claude', 'projects')
  const dir = readdirSync(projects).find((d) => existsSync(join(projects, d, `${harnessSessionId}.jsonl`)))
  if (!dir) throw new Error(`no transcript for ${harnessSessionId}`)
  return readFileSync(join(projects, dir, `${harnessSessionId}.jsonl`), 'utf8').split('\n').filter(Boolean)
}

try {
  await c.db.connect()
  c.node({}, 'server/migrate.ts')
  c.node({}, 'server/admin.ts', 'add-team', team, login)
  const { token } = JSON.parse(c.node({}, 'server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  c.node({}, 'server/admin.ts', 'add-agent', team, `poet-${id}`, `mac-${id}`, 'haiku')

  c.start('server/api.ts', {
    AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'),
    AGENTS_STREAMS_PORT: String(PORT + 2), AGENTS_STREAMS_DIR: join(home, 'streams'),
  })
  await c.servePeople(PORT + 1, join(home, 'people.sock'))
  await until('the API', 20, async () => fetch(API).then(() => true, () => false))
  const daemonEnv = { AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home }
  const daemon = c.start('daemon/agentsd.ts', daemonEnv)
  await until('the machine online', 20, async () => (await c.row(`select status from instances where name = $1`, [`mac-${id}`]))?.status === 'online')

  const { conversationId } = await say('/v1/conversations', { kind: 'dm', agent: `poet-${id}` })
  await say(`/v1/conversations/${conversationId}/messages`, { text: ASK })
  const { id: sessionId } = await c.row('select id from sessions where conversation_id = $1', [conversationId])
  const turnsEnded = () => c.count(`select count(*) from events where session_id = $1 and kind = 'usage'`, [sessionId])

  // The model is writing. Its words are in the live stream, and its turn has not ended.
  const url = `${PEOPLE}/v1/streams/sessions/${sessionId}`
  const asMe = { 'tailscale-user-login': login }
  const streamed = async () => {
    if (!(await fetch(url, { method: 'HEAD', headers: asMe })).ok) return ''
    const deltas = await (await stream<LiveDelta>({ url, headers: asMe, offset: '-1', live: false })).json()
    return deltas.filter((d) => d.k === 'text' && !d.p).map((d) => d.d).join('')
  }
  await until('the model to be writing', 180, async () => (await streamed()).length >= STREAMED_CHARS)
  await killMachine(daemon)
  const cut = await c.row('select harness_session_id, status from sessions where id = $1', [sessionId])
  const before = await streamed()
  if ((await turnsEnded()) > 0) throw new Error('the turn ended before the machine died, so this run could not test a crash mid-reply')
  console.log(`killed the machine ${before.length} characters into the reply`)

  c.start('daemon/agentsd.ts', daemonEnv)
  await until('the resumed turn to end', TURN_SECONDS, async () => (await turnsEnded()) >= 1)

  const posts = await c.rows('select speaker, body from messages where conversation_id = $1 order by seq', [conversationId])
  const poem = String(posts[1]?.body ?? '')
  const lines = poem.split('\n').filter((line) => line.trim()).length
  c.check(posts.map((p) => p.speaker).join() === 'person,agent' && lines >= 20,
    `the conversation reads person, agent, and the agent's post is the poem (${lines} lines)`)

  const events = await c.rows('select seq::int, kind, author, text, body from events where session_id = $1 order by seq', [sessionId])
  const asked = events.find((e) => e.kind === 'user' && e.author)
  const notice = events.find((e) => e.kind === 'notice' && e.body?.subtype === 'interrupted')
  const resumedWith = events.find((e) => e.kind === 'user' && !e.author)
  c.check(asked && notice && resumedWith && asked.seq < notice.seq && notice.seq < resumedWith.seq && String(resumedWith.text).includes(ASK),
    'the record shows the turn interrupted, then resumed with a message that repeats what was asked')

  const session = await c.row('select status, turns, harness_session_id from sessions where id = $1', [sessionId])
  const lastPrompt = transcript(session.harness_session_id).map((line) => JSON.parse(line))
    .filter((line) => line.type === 'user' && typeof line.message?.content === 'string').at(-1)
  c.check(cut.harness_session_id && session.harness_session_id === cut.harness_session_id && lastPrompt?.message.content === resumedWith?.body?.text,
    "the turn resumed in the same Claude conversation, which holds the resume message")

  const commands = await c.rows('select kind, status from commands where session_id = $1', [sessionId])
  c.check(commands.length === 1 && commands[0].kind === 'message' && commands[0].status === 'done',
    "the turn's command stayed open through the crash and is done now that the turn has ended")
  c.check(session.status === 'idle' && session.turns === 1, `the session is idle after one turn (${session.status}, ${session.turns})`)

  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, when: 'after the resumed turn' })
} catch (error) {
  c.failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  c.closePeople()
  for (const child of c.children) child.kill('SIGTERM')
  if (!c.failures.length) {
    await c.db.query('delete from teams where name = $1', [team]).catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
  await c.db.end().catch(() => {})
}

console.log(`\n${c.failures.length ? `${c.failures.length} failed (team ${team} and ${home} kept)` : 'all passed (test team removed)'}`)
process.exit(c.failures.length ? 1 : 0)
