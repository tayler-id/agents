// Durability check 9, with the fake Claude. Approvals across two restarts in one
// turn. First, a person allows a command, it runs, and the machine dies after its
// daemon handed Claude the answer and before it reported that done. Two restarts
// later the resumed session is still told the command may have run, and is never
// offered the old approval to run it again. Second, a person denies an approval
// while the machine is down, and the next resumed session is told it was denied,
// never that it was allowed. It shares ports with step18e, which the suite never
// runs right before it.
//   node --env-file=.env --env-file=.env.test test/step18j.ts

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Check, clientsMatchRecord, fakeLog, killFakes, killMachine, person, ROOT, TURN_SECONDS, until } from './crash.ts'

const PORT = 8057
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const id = randomBytes(4).toString('hex')
const team = `dur-j-${id}`
const login = `${team}@local`

const c = new Check()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-dur-j-')))
const say = person(PEOPLE, login)
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
let folder = ''

const RULES = [
  { match: 'reach-1', append: { id: 'toolu_reach', file: 'reach.txt', line: 'reach-1', ask: true, hangOnce: true, checkNamed: true }, reply: 'Appended reach-1.' },
  { match: 'deny-1', append: { file: 'deny.txt', line: 'deny-1', ask: true }, reply: 'Appended deny-1.' },
]

try {
  await c.db.connect()
  c.node({}, 'server/migrate.ts')
  c.node({}, 'server/admin.ts', 'add-team', team, login)
  const { token } = JSON.parse(c.node({}, 'server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  const { agentId } = JSON.parse(c.node({}, 'server/admin.ts', 'add-agent', team, `asker-${id}`, `mac-${id}`))
  folder = join(home, 'agents', agentId)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(home, 'scenario.json'), JSON.stringify({ turns: RULES }))
  // A resumed session that stays busy, so the machine can be cut off again mid-turn.
  writeFileSync(join(home, 'hold-resumed.json'), JSON.stringify({ turns: [{ match: 'This session was resumed', hang: true }, ...RULES] }))

  c.start('server/api.ts', {
    AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'),
    AGENTS_STREAMS_PORT: String(PORT + 2), AGENTS_STREAMS_DIR: join(home, 'streams'),
  })
  await c.servePeople(PORT + 1, join(home, 'people.sock'))
  await until('the API', 20, async () => fetch(API).then(() => true, () => false))
  const daemon = (scenario: string) => c.start('daemon/agentsd.ts', {
    AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home,
    AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(home, scenario),
  })
  let machine = daemon('scenario.json')
  await until('the machine online', 20, async () => (await c.row(`select status from instances where name = $1`, [`mac-${id}`]))?.status === 'online')
  const restart = async (scenario: string) => {
    const before = fakeLog(folder, 'starts').length
    await killMachine(machine)
    machine = daemon(scenario)
    await until('the resumed session to start', 60, async () => fakeLog(folder, 'starts').length > before)
  }

  const { conversationId } = await say('/v1/conversations', { kind: 'dm', agent: `asker-${id}` })
  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Append reach-1 to reach.txt.' })
  const { id: sessionId } = await c.row('select id from sessions where conversation_id = $1', [conversationId])
  const turnsEnded = () => c.count(`select count(*) from events where session_id = $1 and kind = 'usage'`, [sessionId])
  const askFor = (file: string) => c.row(`select id, status, payload from asks where session_id = $1 and payload->'input'->>'command' like $2`, [sessionId, `% >> ${file}`])
  const continuation = async () => String((await c.row(`select text from events where session_id = $1 and kind = 'user' and body ? 'resumes' order by seq desc limit 1`, [sessionId]))?.text ?? '')

  // One: the answer reached Claude, and the command ran.
  await until('the reach card', 60, async () => (await askFor('reach.txt'))?.status === 'open')
  const reach = await askFor('reach.txt')
  await say(`/v1/asks/${reach.id}/answer`, { decision: 'allow' })
  await until('the command to run and its answer to be reported', 60, async () => lines(join(folder, 'reach.txt')).length === 1
    && (await c.count(`select count(*) from commands where session_id = $1 and kind = 'answer' and status = 'done'`, [sessionId])) === 1)
  // The daemon reports an answer done right after handing it to Claude, too soon
  // after to kill it in between. Put that answer back as the daemon had it then.
  await c.db.query(`update commands set status = 'claimed', done_at = null where session_id = $1 and kind = 'answer'`, [sessionId])
  await restart('hold-resumed.json')
  await restart('scenario.json')
  await until('the turn to end', TURN_SECONDS, async () => (await turnsEnded()) >= 1)
  const second = await continuation()
  c.check(lines(join(folder, 'reach.txt')).join() === 'reach-1', 'after two restarts the command that ran once has still run once')
  c.check(second.includes('toolu_reach') && !second.includes('A person allowed it'),
    'the second recovery still names the call as possibly run, and offers no approval to run it again')

  // Two: a person denies while the machine is down.
  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Append deny-1 to deny.txt.' })
  await until('the deny card', 60, async () => (await askFor('deny.txt'))?.status === 'open')
  await restart('hold-resumed.json')
  const deny = await askFor('deny.txt')
  await say(`/v1/asks/${deny.id}/answer`, { decision: 'deny', message: 'not now' })
  await restart('scenario.json')
  await until('the second turn to end', TURN_SECONDS, async () => (await turnsEnded()) >= 2)
  const afterDeny = await continuation()
  c.check(/denied/.test(afterDeny) && afterDeny.includes('not now') && !afterDeny.includes('A person allowed it'),
    'the next recovery says the approval was denied, with the reason, and never that it was allowed')
  c.check(!existsSync(join(folder, 'deny.txt')), 'the denied command never ran')
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, when: 'after both turns' })
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
