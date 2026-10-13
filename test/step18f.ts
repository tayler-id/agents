// Durability check 6, with the fake Claude. An agent has a running session, and
// a person adds a plugin whose secret its machine lacks. The next message makes
// the daemon stop the session's process to start one with the new setup, and
// that start fails. The session must show as failed, with the machine's reason,
// and stay that way: the process stopped for the restart no longer speaks for
// the session, so its clean exit can't set the session idle over the failure.
// It shares ports with step18e, so the two run one after the other.
//   node --env-file=.env --env-file=.env.test test/step18f.ts

import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alive, Check, clientsMatchRecord, fakeLog, killFakes, person, ROOT, TURN_SECONDS, until } from './crash.ts'

const PORT = 8057
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const id = randomBytes(4).toString('hex')
const team = `dur-f-${id}`
const login = `${team}@local`
const MISSING = 'DUR_MISSING_KEY'

const c = new Check()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-dur-f-')))
const say = person(PEOPLE, login)
let folder = ''

try {
  await c.db.connect()
  c.node({}, 'server/migrate.ts')
  c.node({}, 'server/admin.ts', 'add-team', team, login)
  const { token } = JSON.parse(c.node({}, 'server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  const { agentId } = JSON.parse(c.node({}, 'server/admin.ts', 'add-agent', team, `keeper-${id}`, `mac-${id}`))
  folder = join(home, 'agents', agentId)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(home, 'scenario.json'), JSON.stringify({ turns: [] }))

  c.start('server/api.ts', {
    AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_PORT: String(PORT + 1),
    AGENTS_STREAMS_PORT: String(PORT + 2), AGENTS_STREAMS_DIR: join(home, 'streams'),
  })
  await until('the API', 20, async () => fetch(API).then(() => true, () => false))
  const daemon = c.start('daemon/agentsd.ts', {
    AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home,
    AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json'),
  })
  await until('the machine online', 20, async () => (await c.row(`select status from instances where name = $1`, [`mac-${id}`]))?.status === 'online')

  const { conversationId } = await say('/v1/conversations', { kind: 'dm', agent: `keeper-${id}` })
  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Say hello.' })
  const { id: sessionId } = await c.row('select id from sessions where conversation_id = $1', [conversationId])
  const session = () => c.row('select status from sessions where id = $1', [sessionId])
  await until('the first turn', TURN_SECONDS, async () => (await session())?.status === 'idle'
    && (await c.count(`select count(*) from events where session_id = $1 and kind = 'usage'`, [sessionId])) === 1)
  const running = fakeLog(folder, 'starts').at(-1)?.pid
  if (typeof running !== 'number') throw new Error("no pid for the session's process")
  c.check(alive(running), "after the first turn the session's process is still running, ready for the next message")

  await say(`/v1/agents/${agentId}/plugins`, { name: 'needs-key', kind: 'stdio', config: { command: 'node', env: { KEY: { secret: MISSING } } } })
  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Say hello again.' })
  const reason = () => c.row(`select text from events where session_id = $1 and kind = 'error' order by seq desc limit 1`, [sessionId])
  await until("the machine's reason in the record, and the old process gone", 60, async () =>
    String((await reason())?.text ?? '').includes(MISSING) && !alive(running))

  // Once the daemon has stopped, everything it was going to post has been posted.
  daemon.kill('SIGTERM')
  await until('the daemon to stop', 30, async () => daemon.exitCode !== null)
  const failed = await session()
  c.check(failed?.status === 'failed', `the session shows as failed, not idle (${String(failed?.status)})`)
  const commands = await c.rows(`select status, error from commands where session_id = $1 and kind = 'message' order by created_at`, [sessionId])
  c.check(commands.map((m) => m.status).join() === 'done,failed' && String(commands[1]?.error).includes(MISSING),
    "the second message failed with the machine's reason")
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, when: 'after the restart failed' })
} catch (error) {
  c.failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  for (const child of c.children) child.kill('SIGTERM')
  if (folder) killFakes(folder)
  if (!c.failures.length) {
    await c.db.query('delete from teams where name = $1', [team]).catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
  await c.db.end().catch(() => {})
}

console.log(`\n${c.failures.length ? `${c.failures.length} failed (team ${team} and ${home} kept)` : 'all passed (test team removed)'}`)
process.exit(c.failures.length ? 1 : 0)
