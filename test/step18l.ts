// Durability check 12, with the fake Claude. A turn that never finishes, because
// its machine dies every time it runs, is resumed after each of the first three
// restarts. At the fourth, recovery fails the turn with the reason instead of
// resuming it again, so a turn can't keep a machine restarting forever. The
// person's next message starts a turn that ends. It shares ports with step18c
// and step18h, which the suite runs before it.
//   node --env-file=.env --env-file=.env.test test/step18l.ts

import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Check, clientsMatchRecord, fakeLog, killFakes, killMachine, person, ROOT, TURN_SECONDS, until } from './crash.ts'

const PORT = 8052
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const id = randomBytes(4).toString('hex')
const team = `dur-l-${id}`
const login = `${team}@local`
// How many restarts in one turn recovery resumes.
const RESUMES = 3

const c = new Check()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-dur-l-')))
const say = person(PEOPLE, login)
let folder = ''

try {
  await c.db.connect()
  c.node({}, 'server/migrate.ts')
  c.node({}, 'server/admin.ts', 'add-team', team, login)
  const { token } = JSON.parse(c.node({}, 'server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  const { agentId } = JSON.parse(c.node({}, 'server/admin.ts', 'add-agent', team, `looper-${id}`, `mac-${id}`))
  folder = join(home, 'agents', agentId)
  mkdirSync(folder, { recursive: true })
  // The turn hangs every time it runs, resumed or not, as if it took the machine down.
  writeFileSync(join(home, 'scenario.json'), JSON.stringify({ turns: [{ match: 'LOOP', hang: true }, { match: 'GREET', reply: 'Hello again.' }] }))

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
  let machine = c.start('daemon/agentsd.ts', daemonEnv)
  await until('the machine online', 20, async () => (await c.row(`select status from instances where name = $1`, [`mac-${id}`]))?.status === 'online')

  const { conversationId } = await say('/v1/conversations', { kind: 'dm', agent: `looper-${id}` })
  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Do the LOOP task.' })
  const { id: sessionId } = await c.row('select id from sessions where conversation_id = $1', [conversationId])
  const { id: loopId } = await c.row(`select id from commands where session_id = $1 and kind = 'message'`, [sessionId])
  await until('the turn to start', 60, async () => fakeLog(folder, 'starts').length === 1)

  for (let restart = 1; restart <= RESUMES; restart++) {
    await killMachine(machine)
    machine = c.start('daemon/agentsd.ts', daemonEnv)
    const resumed = await until(`the turn to resume after restart ${restart}`, 60, async () => fakeLog(folder, 'starts').length === restart + 1)
      .then(() => true, () => false)
    c.check(resumed, `restart ${restart} resumes the turn`)
  }

  await killMachine(machine)
  machine = c.start('daemon/agentsd.ts', daemonEnv)
  await until('the turn to fail', 60, async () => (await c.row('select status from commands where id = $1', [loopId]))?.status === 'failed')
  // A resume would start a new Claude within a second or two of recovery.
  await sleep(5000)
  const loop = await c.row('select error from commands where id = $1', [loopId])
  const session = await c.row('select status from sessions where id = $1', [sessionId])
  const error = await c.row(`select text from events where session_id = $1 and kind = 'error' order by seq desc limit 1`, [sessionId])
  c.check(fakeLog(folder, 'starts').length === RESUMES + 1, `restart ${RESUMES + 1} does not resume the turn`)
  c.check(/restarted in the middle of this turn 4 times/.test(String(loop.error)) && session.status === 'failed' && error?.text === loop.error,
    'the turn fails with the reason, in its command, its session and the record')
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, when: 'after the turn failed' })

  await say(`/v1/conversations/${conversationId}/messages`, { text: 'GREET me.' })
  await until('the next turn to end', TURN_SECONDS, async () =>
    (await c.count(`select count(*) from events where session_id = $1 and kind = 'usage'`, [sessionId])) === 1)
  const posts = await c.rows('select speaker, body from messages where conversation_id = $1 order by seq', [conversationId])
  c.check(posts.at(-1)?.body === 'Hello again.', "the person's next message gets an answer")
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
