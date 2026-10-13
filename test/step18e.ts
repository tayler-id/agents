// Durability check 5, with the fake Claude. A person's client is connected to a
// DM while the agent waits for an approval, and the machine dies. Once the
// machine has stopped answering, a client that stayed connected and one that
// reconnects both show the session as lost with its card still open, and both
// read exactly what the record holds. After the machine is back and the turn
// ends, both read the record again: the session idle, the card gone and the
// reply posted. Checks 1 to 4 make the same comparison when they finish.
//   node --env-file=.env --env-file=.env.test test/step18e.ts

import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Check, clientsMatchRecord, killFakes, killMachine, liveClient, LOST_SEC, person, ROOT, TURN_SECONDS, until } from './crash.ts'

const PORT = 8057
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const id = randomBytes(4).toString('hex')
const team = `dur-e-${id}`
const login = `${team}@local`

const c = new Check()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-dur-e-')))
const say = person(PEOPLE, login)
let folder = ''
let live: ReturnType<typeof liveClient> | undefined

try {
  await c.db.connect()
  c.node({}, 'server/migrate.ts')
  c.node({}, 'server/admin.ts', 'add-team', team, login)
  const { token } = JSON.parse(c.node({}, 'server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  const { agentId } = JSON.parse(c.node({}, 'server/admin.ts', 'add-agent', team, `watcher-${id}`, `mac-${id}`))
  folder = join(home, 'agents', agentId)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(home, 'scenario.json'), JSON.stringify({
    turns: [{ match: 'WATCH', append: { file: 'watched.txt', line: 'seen-1', ask: true }, reply: 'Appended seen-1.' }],
  }))

  c.start('server/api.ts', {
    AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_PORT: String(PORT + 1),
    AGENTS_STREAMS_PORT: String(PORT + 2), AGENTS_STREAMS_DIR: join(home, 'streams'), AGENTS_MACHINE_LOST_SEC: String(LOST_SEC),
  })
  await until('the API', 20, async () => fetch(API).then(() => true, () => false))
  const daemonEnv = {
    AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home,
    AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json'),
  }
  const daemon = c.start('daemon/agentsd.ts', daemonEnv)
  await until('the machine online', 20, async () => (await c.row(`select status from instances where name = $1`, [`mac-${id}`]))?.status === 'online')

  const { conversationId } = await say('/v1/conversations', { kind: 'dm', agent: `watcher-${id}` })
  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Do WATCH.' })
  const { id: sessionId } = await c.row('select id from sessions where conversation_id = $1', [conversationId])
  const openAsk = () => c.row(`select id from asks where session_id = $1 and status = 'open'`, [sessionId])
  await until('the ask', 60, openAsk)
  const ask = await openAsk()
  live = liveClient(PEOPLE, login, conversationId, sessionId)
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, live, when: 'while the ask waits' })

  await killMachine(daemon)
  await until('the session to show as lost', LOST_SEC * 3, async () => (await c.row('select status from sessions where id = $1', [sessionId]))?.status === 'lost')
  c.check((await openAsk())?.id === ask.id, 'during the outage the card is still open')
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, live, when: 'during the outage' })

  c.start('daemon/agentsd.ts', daemonEnv)
  await until('the resumed session to ask again', 60, async () =>
    (await c.count(`select count(*) from events where session_id = $1 and kind = 'ask'`, [sessionId])) === 2)
  await say(`/v1/asks/${ask.id}/answer`, { decision: 'allow' })
  await until('the turn to end', TURN_SECONDS, async () =>
    (await c.count(`select count(*) from events where session_id = $1 and kind = 'usage'`, [sessionId])) >= 1)
  const session = await c.row('select status from sessions where id = $1', [sessionId])
  const posts = await c.rows('select speaker from messages where conversation_id = $1 order by seq', [conversationId])
  c.check(session.status === 'idle' && !(await openAsk()) && posts.map((p) => p.speaker).join() === 'person,agent',
    'after the restart the session is idle, no card is open, and the reply is posted')
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, live, when: 'after the restart' })
} catch (error) {
  c.failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  live?.close()
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
