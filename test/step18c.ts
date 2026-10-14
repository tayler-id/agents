// Durability check 3, with the fake Claude. The agent asks a person before
// appending a line, and the machine dies while the ask waits. First a person
// answers while the machine is down, then, on a second turn, after it is back.
// Each time the card the person saw takes the answer, no second card opens, the
// answer reaches the resumed session's new request, and the line is written once.
//   node --env-file=.env --env-file=.env.test test/step18c.ts

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Check, clientsMatchRecord, fakeLog, killFakes, killMachine, person, ROOT, TURN_SECONDS, until } from './crash.ts'

const PORT = 8052
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const id = randomBytes(4).toString('hex')
const team = `dur-c-${id}`
const login = `${team}@local`

const c = new Check()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-dur-c-')))
const say = person(PEOPLE, login)
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
let folder = ''

try {
  await c.db.connect()
  c.node({}, 'server/migrate.ts')
  c.node({}, 'server/admin.ts', 'add-team', team, login)
  const { token } = JSON.parse(c.node({}, 'server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  const { agentId } = JSON.parse(c.node({}, 'server/admin.ts', 'add-agent', team, `asker-${id}`, `mac-${id}`))
  folder = join(home, 'agents', agentId)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(home, 'scenario.json'), JSON.stringify({
    turns: [
      { match: 'APPROVE-ONE', append: { file: 'one.txt', line: 'approved-1', ask: true }, reply: 'Appended approved-1.' },
      { match: 'APPROVE-TWO', append: { file: 'two.txt', line: 'approved-2', ask: true }, reply: 'Appended approved-2.' },
    ],
  }))

  c.start('server/api.ts', {
    AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'),
    AGENTS_STREAMS_PORT: String(PORT + 2), AGENTS_STREAMS_DIR: join(home, 'streams'),
  })
  await c.servePeople(PORT + 1, join(home, 'people.sock'))
  await until('the API', 20, async () => fetch(API).then(() => true, () => false))
  const daemonEnv = {
    AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home,
    AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json'),
  }
  let daemon = c.start('daemon/agentsd.ts', daemonEnv)
  await until('the machine online', 20, async () => (await c.row(`select status from instances where name = $1`, [`mac-${id}`]))?.status === 'online')

  const { conversationId } = await say('/v1/conversations', { kind: 'dm', agent: `asker-${id}` })
  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Do APPROVE-ONE.' })
  const { id: sessionId } = await c.row('select id from sessions where conversation_id = $1', [conversationId])
  const turnsEnded = () => c.count(`select count(*) from events where session_id = $1 and kind = 'usage'`, [sessionId])
  const asks = () => c.rows(`select id, status, payload from asks where session_id = $1 order by created_at`, [sessionId])
  // Each allow the fake Claude processes received, with the request it answered.
  const allowed = () => fakeLog(folder, 'received').filter((r) => r.kind === 'answer' && r.behavior === 'allow')

  // First the person answers while the machine is down.
  await until('the first ask', 60, async () => (await asks()).some((a) => a.status === 'open'))
  const [first] = await asks()
  await killMachine(daemon)
  await say(`/v1/asks/${first.id}/answer`, { decision: 'allow' })
  daemon = c.start('daemon/agentsd.ts', daemonEnv)
  await until('the first resumed turn to end', TURN_SECONDS, async () => (await turnsEnded()) >= 1)

  c.check(lines(join(folder, 'one.txt')).join() === 'approved-1', 'the approved line was written once')
  const afterOne = await asks()
  c.check(afterOne.length === 1 && afterOne[0].id === first.id && afterOne[0].status === 'answered',
    'the card the person answered during the outage is the only one, and it is answered')
  const starts = fakeLog(folder, 'starts')
  const askEvents = await c.rows(`select body from events where session_id = $1 and kind = 'ask' order by seq`, [sessionId])
  const renewed = askEvents[1]?.body.requestId
  c.check(askEvents.length === 2 && renewed !== askEvents[0].body.requestId && starts.length === 2 && starts[1].resumed
    && allowed().some((r) => r.pid === starts[1].pid && r.requestId === renewed),
  'the resumed session asked again with a new request, and the answer reached that request')
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, when: 'after an answer given during the outage' })

  // Then the machine dies with the ask waiting, and the person answers after it is back.
  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Do APPROVE-TWO.' })
  await until('the second ask', 60, async () => (await asks()).some((a) => a.status === 'open'))
  const second = (await asks()).find((a) => a.status === 'open')
  await killMachine(daemon)
  c.start('daemon/agentsd.ts', daemonEnv)
  await until('the resumed session to ask again', 60, async () =>
    (await c.count(`select count(*) from events where session_id = $1 and kind = 'ask'`, [sessionId])) === 4)
  const waitingAgain = await asks()
  c.check(waitingAgain.length === 2 && waitingAgain[1].id === second.id && waitingAgain[1].status === 'open',
    'after the restart the same card waits for an answer, and no second card opened')
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, when: 'while the carried ask waits' })
  await say(`/v1/asks/${second.id}/answer`, { decision: 'allow' })
  await until('the second resumed turn to end', TURN_SECONDS, async () => (await turnsEnded()) >= 2)
  c.check(lines(join(folder, 'two.txt')).join() === 'approved-2', 'the line approved after the restart was written once')
  const posts = await c.rows('select speaker, body from messages where conversation_id = $1 order by seq', [conversationId])
  c.check(posts.map((p) => `${p.speaker}:${p.body}`).join('|') === 'person:Do APPROVE-ONE.|agent:Appended approved-1.|person:Do APPROVE-TWO.|agent:Appended approved-2.',
    'the conversation shows both requests and both replies')
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, when: 'after an answer given after the restart' })
} catch (error) {
  c.failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  c.closePeople()
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
