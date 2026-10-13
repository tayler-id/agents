// Durability check 7, with real Claude. A person's follow-up, sent while the
// agent is running a command, joins the running turn, and Claude answers both
// messages with one result. Both messages finish with that turn, and the session
// is free again, so when the agent's setup changes the next message gets a new
// Claude process. On main the daemon counted one result per message, so after
// this turn the session looked busy forever, and the agent kept the process it
// started with. It shares ports with step18a, so the two run one after the other.
//   node --env-file=.env --env-file=.env.test test/step18g.ts

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alive, Check, clientsMatchRecord, person, TURN_SECONDS, until } from './crash.ts'

const PORT = 8046
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const id = randomBytes(4).toString('hex')
const team = `dur-g-${id}`
const login = `${team}@local`
const FIRST = 'Run this Bash command once: sleep 8 && echo first. Then reply with exactly: FIRST DONE'
const SECOND = 'Also, in the same reply, write exactly: SECOND DONE'

const c = new Check()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-dur-g-')))
const say = person(PEOPLE, login)

// The Claude process working a session under the daemon, by the session's MCP
// config file in its command line.
function claudeOf(daemonPid: number, sessionId: string): number | undefined {
  const table = execFileSync('ps', ['-ww', '-eo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line)).filter((match) => match !== null)
    .map((match) => ({ pid: Number(match[1]), parent: Number(match[2]), command: match[3] ?? '' }))
  return table.find((row) => row.parent === daemonPid && row.command.includes(`${sessionId}.mcp.json`))?.pid
}

try {
  await c.db.connect()
  c.node({}, 'server/migrate.ts')
  c.node({}, 'server/admin.ts', 'add-team', team, login)
  const { token } = JSON.parse(c.node({}, 'server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  const { agentId } = JSON.parse(c.node({}, 'server/admin.ts', 'add-agent', team, `folder-${id}`, `mac-${id}`, 'haiku',
    'When asked to run a command, run exactly that command with the Bash tool, once. Keep replies short.'))

  c.start('server/api.ts', {
    AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_PORT: String(PORT + 1),
    AGENTS_STREAMS_PORT: String(PORT + 2), AGENTS_STREAMS_DIR: join(home, 'streams'),
  })
  await until('the API', 20, async () => fetch(API).then(() => true, () => false))
  const daemon = c.start('daemon/agentsd.ts', { AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home })
  const daemonPid = daemon.pid
  if (daemonPid === undefined) throw new Error('the daemon has no pid')
  await until('the machine online', 20, async () => (await c.row(`select status from instances where name = $1`, [`mac-${id}`]))?.status === 'online')

  const { conversationId } = await say('/v1/conversations', { kind: 'dm', agent: `folder-${id}` })
  await say(`/v1/conversations/${conversationId}/messages`, { text: FIRST })
  const { id: sessionId } = await c.row('select id from sessions where conversation_id = $1', [conversationId])
  const turnsEnded = () => c.count(`select count(*) from events where session_id = $1 and kind = 'usage'`, [sessionId])
  // Claude runs a command it considers safe, such as this one, without asking.
  // Should it ask, the person allows it.
  await until('the agent to run the command', 120, async () => {
    const ask = await c.row(`select id from asks where session_id = $1 and status = 'open'`, [sessionId])
    if (ask) await say(`/v1/asks/${ask.id}/answer`, { decision: 'allow' })
    return (await c.count(`select count(*) from events where session_id = $1 and kind = 'tool_call' and tool_name = 'Bash'`, [sessionId])) === 1
  })
  // The command sleeps 8 seconds, so the follow-up reaches Claude while it runs.
  await say(`/v1/conversations/${conversationId}/messages`, { text: SECOND })
  await until('the turn to end', TURN_SECONDS, async () => (await turnsEnded()) >= 1)
  await until('both messages to be answered or a second turn to start', 30, async () =>
    (await c.count(`select count(*) from commands where session_id = $1 and kind = 'message' and status = 'claimed'`, [sessionId])) === 0
    || (await turnsEnded()) >= 2)
  if ((await turnsEnded()) !== 1) throw new Error('Claude answered the follow-up in a turn of its own, so this run could not test a folded turn')

  const posts = await c.rows('select speaker, body from messages where conversation_id = $1 order by seq', [conversationId])
  const reply = String(posts.at(-1)?.body ?? '')
  c.check(posts.map((p) => p.speaker).join() === 'person,person,agent' && reply.includes('FIRST DONE') && reply.includes('SECOND DONE'),
    'one reply answered both messages')
  const commands = await c.rows(`select status from commands where session_id = $1 and kind = 'message' order by created_at`, [sessionId])
  c.check(commands.map((m) => m.status).join() === 'done,done', 'both messages finished with the turn that answered them')

  const before = claudeOf(daemonPid, sessionId)
  if (before === undefined) throw new Error("no Claude process for the session after its first turn")
  await say(`/v1/agents/${agentId}`, { instructions: 'Keep replies to one line.' })
  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Reply with exactly: THIRD DONE' })
  await until('the third message to be answered', TURN_SECONDS, async () => (await turnsEnded()) >= 2)
  const after = claudeOf(daemonPid, sessionId)
  c.check(after !== undefined && after !== before && !alive(before),
    `the session was free after the folded turn, so the new setup got a new Claude process (${before} then ${String(after)})`)
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, when: 'after the folded turn and the restart' })
} catch (error) {
  c.failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  for (const child of c.children) child.kill('SIGTERM')
  if (!c.failures.length) {
    await c.db.query('delete from teams where name = $1', [team]).catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
  await c.db.end().catch(() => {})
}

console.log(`\n${c.failures.length ? `${c.failures.length} failed (team ${team} and ${home} kept)` : 'all passed (test team removed)'}`)
process.exit(c.failures.length ? 1 : 0)
