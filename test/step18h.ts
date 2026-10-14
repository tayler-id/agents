// Durability check 8, with the fake Claude. An approval belongs to the turn that
// raised it and never outlives it. First, Claude dies while an approval waits:
// the card expires with the turn, so nobody can allow it later. Second, a resumed
// session never asks again for an approval a person answered while it ran: the
// answer is kept without a command for a dead request, and when the turn ends
// the decision is let go for good. Each time, a later turn is cut off, and its
// recovery must not offer the old approval again. It shares ports with step18c,
// which the suite never runs right before it.
//   node --env-file=.env --env-file=.env.test test/step18h.ts

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Check, clientsMatchRecord, fakeLog, killFakes, killMachine, ROOT, TURN_SECONDS, until } from './crash.ts'

const PORT = 8052
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const id = randomBytes(4).toString('hex')
const team = `dur-h-${id}`
const login = `${team}@local`

const c = new Check()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-dur-h-')))
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
let folder = ''

// A person's request through the stand-in for serve, answering with its status.
async function asPerson(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(PEOPLE + path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function say(path: string, body: unknown = {}): Promise<any> {
  const { status, json } = await asPerson(path, body)
  if (status !== 200) throw new Error(`${path}: ${status} ${JSON.stringify(json)}`)
  return json
}

// The rules the agent follows. The ones that ask come first, so a continuation
// that offered an old approval would make the agent ask for it again.
const RULES = [
  { match: 'die-1', append: { file: 'die.txt', line: 'die-1', ask: true, dieAsking: true }, reply: 'Appended die-1.' },
  { match: 'once-1', append: { file: 'once.txt', line: 'once-1', ask: true, askOnce: true }, reply: 'Appended once-1.' },
  { match: 'HOLD', append: { id: 'toolu_hold', file: 'hold.txt', line: 'hold-1', hangOnce: true, checkNamed: true }, reply: 'Appended hold-1.' },
  { match: 'KEEP', append: { id: 'toolu_keep', file: 'keep.txt', line: 'keep-1', hangOnce: true, checkNamed: true }, reply: 'Appended keep-1.' },
]

try {
  await c.db.connect()
  c.node({}, 'server/migrate.ts')
  c.node({}, 'server/admin.ts', 'add-team', team, login)
  const { token } = JSON.parse(c.node({}, 'server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  const { agentId } = JSON.parse(c.node({}, 'server/admin.ts', 'add-agent', team, `keeper-${id}`, `mac-${id}`))
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

  const { conversationId } = await say('/v1/conversations', { kind: 'dm', agent: `keeper-${id}` })
  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Append die-1 to die.txt.' })
  const { id: sessionId } = await c.row('select id from sessions where conversation_id = $1', [conversationId])
  const turnsEnded = () => c.count(`select count(*) from events where session_id = $1 and kind = 'usage'`, [sessionId])
  const askFor = (file: string) => c.row(`select id, status, request_ended_at, payload from asks where session_id = $1 and payload->'input'->>'command' like $2`, [sessionId, `% >> ${file}`])
  const continuation = async () => String((await c.row(`select text from events where session_id = $1 and kind = 'user' and body ? 'resumes' order by seq desc limit 1`, [sessionId]))?.text ?? '')
  const restart = async (scenario: string) => {
    await killMachine(machine)
    machine = daemon(scenario)
  }

  // One: Claude dies while the approval waits.
  await until('Claude to die while asking', 60, async () => (await c.row('select status from sessions where id = $1', [sessionId]))?.status === 'failed')
  const died = await askFor('die.txt')
  c.check(died?.status === 'expired', `the card expired when Claude died without finishing the turn (${String(died?.status)})`)
  const lateAllow = await asPerson(`/v1/asks/${died?.id}/answer`, { decision: 'allow' })
  c.check(lateAllow.status === 409, `allowing the card afterwards is refused (${lateAllow.status})`)

  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Do the HOLD task.' })
  await until('the hold line and its call in the record', 60, async () =>
    lines(join(folder, 'hold.txt')).length === 1 && (await c.count(`select count(*) from events where session_id = $1 and tool_use_id = 'toolu_hold'`, [sessionId])) === 1)
  await restart('scenario.json')
  await until('the HOLD turn to end', TURN_SECONDS, async () => (await turnsEnded()) >= 1)
  const afterHold = await continuation()
  c.check(afterHold.includes('toolu_hold') && !afterHold.includes('die.txt'), 'the next recovery named the cut-off call and not the expired approval')
  c.check(!existsSync(join(folder, 'die.txt')), 'the expired approval never ran')

  // Two: a resumed session never asks again, and the person answers meanwhile.
  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Append once-1 to once.txt.' })
  await until('the once card', 60, async () => (await askFor('once.txt'))?.status === 'open')
  const startsBefore = fakeLog(folder, 'starts').length
  await restart('hold-resumed.json')
  await until('the resumed session to start and hold', 60, async () =>
    fakeLog(folder, 'starts').length > startsBefore && (await askFor('once.txt'))?.request_ended_at !== null)
  const once = await askFor('once.txt')
  await say(`/v1/asks/${once.id}/answer`, { decision: 'allow' })
  const sentToMachine = await c.count(`select count(*) from commands where session_id = $1 and kind = 'answer' and payload->>'requestId' = $2`, [sessionId, once.payload.requestId])
  c.check(sentToMachine === 0, 'an answer to an approval whose request ended is kept on the card, with no command for a dead request')
  await restart('scenario.json')
  await until('the once turn to end', TURN_SECONDS, async () => (await turnsEnded()) >= 2)
  const letGo = await askFor('once.txt')
  c.check(letGo?.status === 'expired', `when the turn ended without asking again, the kept decision was let go for good (${String(letGo?.status)})`)

  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Do the KEEP task.' })
  await until('the keep line and its call in the record', 60, async () =>
    lines(join(folder, 'keep.txt')).length === 1 && (await c.count(`select count(*) from events where session_id = $1 and tool_use_id = 'toolu_keep'`, [sessionId])) === 1)
  await restart('scenario.json')
  await until('the KEEP turn to end', TURN_SECONDS, async () => (await turnsEnded()) >= 3)
  const afterKeep = await continuation()
  c.check(afterKeep.includes('toolu_keep') && !afterKeep.includes('once.txt'), 'the next recovery named the cut-off call and not the decision from the earlier turn')
  c.check((await askFor('once.txt'))?.payload.requestId === once.payload.requestId, 'no later request took over the old card')
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
