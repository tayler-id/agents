// Durability check 2, with the fake Claude. The agent appends a line to a file
// with one Bash call, and the machine dies after the line is written and before
// the call's result is saved. On restart the line is still there once. The turn
// resumes in the same conversation, the resumed session is told that call may
// have run, it checks before running it again, and the turn ends. Then only the
// daemon dies while the agent is mid-call, and its Claude is stopped before the
// turn resumes, so two processes never work one conversation. Last, the machine
// dies mid-call and a person interrupts while it is down, so the restart ends
// the turn instead of resuming it.
//   node --env-file=.env --env-file=.env.test test/step18b.ts

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alive, Check, clientsMatchRecord, fakeLog, killFakes, killMachine, person, ROOT, TURN_SECONDS, until } from './crash.ts'

const PORT = 8049
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const id = randomBytes(4).toString('hex')
const team = `dur-b-${id}`
const login = `${team}@local`

const c = new Check()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-dur-b-')))
const say = person(PEOPLE, login)

const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
// The agent's folder, where the fake Claude works and logs.
let folder = ''

try {
  await c.db.connect()
  c.node({}, 'server/migrate.ts')
  c.node({}, 'server/admin.ts', 'add-team', team, login)
  const { token } = JSON.parse(c.node({}, 'server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  const { agentId } = JSON.parse(c.node({}, 'server/admin.ts', 'add-agent', team, `clerk-${id}`, `mac-${id}`))
  folder = join(home, 'agents', agentId)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(home, 'scenario.json'), JSON.stringify({
    turns: [
      { match: 'LEDGER', append: { id: 'toolu_ledger', file: 'ledger.txt', line: 'entry-1', hangOnce: true, checkNamed: true }, reply: 'Appended entry-1.' },
      { match: 'DIARY', append: { id: 'toolu_diary', file: 'diary.txt', line: 'day-1', hangOnce: true, checkNamed: true }, reply: 'Appended day-1.' },
      { match: 'JOURNAL', append: { id: 'toolu_journal', file: 'journal.txt', line: 'page-1', hangOnce: true, checkNamed: true }, reply: 'Appended page-1.' },
    ],
  }))

  c.start('server/api.ts', {
    AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_PORT: String(PORT + 1),
    AGENTS_STREAMS_PORT: String(PORT + 2), AGENTS_STREAMS_DIR: join(home, 'streams'),
  })
  await until('the API', 20, async () => fetch(API).then(() => true, () => false))
  const daemonEnv = {
    AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home,
    AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json'),
  }
  const daemon = c.start('daemon/agentsd.ts', daemonEnv)
  await until('the machine online', 20, async () => (await c.row(`select status from instances where name = $1`, [`mac-${id}`]))?.status === 'online')

  const { conversationId } = await say('/v1/conversations', { kind: 'dm', agent: `clerk-${id}` })
  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Do the LEDGER task.' })
  const { id: sessionId } = await c.row('select id from sessions where conversation_id = $1', [conversationId])
  const turnsEnded = () => c.count(`select count(*) from events where session_id = $1 and kind = 'usage'`, [sessionId])
  const called = (toolUseId: string) => c.count(`select count(*) from events where session_id = $1 and kind = 'tool_call' and tool_use_id = $2`, [sessionId, toolUseId])

  // The call has acted and is in the record, and its result is not.
  await until('the ledger line and its call in the record', 60, async () =>
    lines(join(folder, 'ledger.txt')).length === 1 && (await called('toolu_ledger')) === 1)
  await killMachine(daemon)
  c.check(await c.count(`select count(*) from events where session_id = $1 and kind = 'tool_result'`, [sessionId]) === 0,
    "the machine died with the call's result unsaved")

  const second = c.start('daemon/agentsd.ts', daemonEnv)
  await until('the resumed turn to end', TURN_SECONDS, async () => (await turnsEnded()) >= 1)

  c.check(lines(join(folder, 'ledger.txt')).join() === 'entry-1', 'the ledger has its line once: the effect was neither lost nor repeated')
  const events = await c.rows('select seq::int, kind, author, tool_name, tool_use_id, text, body from events where session_id = $1 order by seq', [sessionId])
  const notice = events.find((e) => e.kind === 'notice' && e.body?.subtype === 'interrupted')
  const resumedWith = events.find((e) => e.kind === 'user' && !e.author)
  c.check(notice && JSON.stringify(notice.body).includes('toolu_ledger'), 'the record names the call that was cut off')
  c.check(resumedWith && notice && resumedWith.seq > notice.seq && String(resumedWith.text).includes('toolu_ledger') && String(resumedWith.text).includes('echo entry-1 >> ledger.txt'),
    'the resumed session was told that call may have run, by its id and command')
  const looked = events.find((e) => e.kind === 'tool_call' && e.tool_name === 'Read' && resumedWith && e.seq > resumedWith.seq)
  c.check(looked, 'the resumed session read the ledger before acting again')

  const starts = fakeLog(folder, 'starts')
  c.check(starts.length === 2 && starts[1].resumed && starts[1].sessionId === starts[0].sessionId,
    'the turn resumed the same Claude conversation rather than starting a new one')
  const posts = await c.rows('select speaker, body from messages where conversation_id = $1 order by seq', [conversationId])
  c.check(posts.map((p) => p.speaker).join() === 'person,agent' && posts[1]?.body === 'ledger.txt already has entry-1, so I left it alone.',
    "the agent's reply reached the conversation")
  const commands = await c.rows(`select status from commands where session_id = $1 and kind = 'message'`, [sessionId])
  c.check(commands.map((m) => m.status).join() === 'done', "the turn's command is done")
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, when: 'after the machine died mid-call' })

  // Now only the daemon dies. Its Claude is left working the turn.
  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Do the DIARY task.' })
  await until('the diary line and its call in the record', 60, async () =>
    lines(join(folder, 'diary.txt')).length === 1 && (await called('toolu_diary')) === 1)
  const orphan = fakeLog(folder, 'starts').at(-1)?.pid
  if (typeof orphan !== 'number' || second.pid === undefined) throw new Error('no pid for the daemon or its Claude')
  process.kill(second.pid, 'SIGKILL')
  await until('the daemon to die', 10, async () => !alive(Number(second.pid)))
  c.check(alive(orphan), "with only the daemon dead, its Claude is still running")

  c.start('daemon/agentsd.ts', daemonEnv)
  await until('a new Claude for the turn', 60, async () => fakeLog(folder, 'starts').length === 3)
  c.check(!alive(orphan), 'the old Claude was stopped before the turn resumed')
  await until('the second resumed turn to end', TURN_SECONDS, async () => (await turnsEnded()) >= 2)
  c.check(lines(join(folder, 'diary.txt')).join() === 'day-1', 'the diary has its line once')
  const toldOld = fakeLog(folder, 'received').filter((r) => r.pid === orphan && String(r.text).includes('toolu_diary'))
  c.check(toldOld.length === 0, 'only the new Claude was told to resume')
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, when: 'after only the daemon died' })

  // Last, a person interrupts while the machine is down.
  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Do the JOURNAL task.' })
  await until('the journal line and its call in the record', 60, async () =>
    lines(join(folder, 'journal.txt')).length === 1 && (await called('toolu_journal')) === 1)
  const third = c.children.at(-1)
  if (!third) throw new Error('no daemon to kill')
  await killMachine(third)
  await say(`/v1/sessions/${sessionId}/interrupt`, {})
  const startsBefore = fakeLog(folder, 'starts').length
  c.start('daemon/agentsd.ts', daemonEnv)
  const journal = await c.row(`select id from commands where session_id = $1 and kind = 'message' order by created_at desc limit 1`, [sessionId])
  await until('the interrupted message to end', 60, async () => (await c.row('select status from commands where id = $1', [journal.id]))?.status === 'done')
  const stopped = await c.row(`select text from events where session_id = $1 and kind = 'notice' and body->>'subtype' = 'interrupted' order by seq desc limit 1`, [sessionId])
  const interrupts = await c.rows(`select status from commands where session_id = $1 and kind = 'interrupt'`, [sessionId])
  c.check(/asked to stop/.test(String(stopped?.text)) && interrupts.map((i) => i.status).join() === 'done' && (await c.row('select status from sessions where id = $1', [sessionId]))?.status === 'idle',
    'an interrupt sent while the machine was down ended the turn when it came back, and the record says why')
  c.check(fakeLog(folder, 'starts').length === startsBefore && lines(join(folder, 'journal.txt')).length === 1, 'the interrupted turn was not resumed')
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, when: 'after an interrupt during the outage' })
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
