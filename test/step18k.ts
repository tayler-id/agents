// Durability check 11, on the server's own code. A person answering an approval
// takes its session's lock before the ask's, the order a machine's recovery and
// a harness's batches take them in. While another transaction holds the session
// and then reaches for the ask, as recovery does, both finish, and Postgres
// finds no deadlock. It uses no ports.
//   node --env-file=.env --env-file=.env.test test/step18k.ts

import { randomBytes } from 'node:crypto'
import { answerAsk } from '../server/record.ts'
import { pool, tx } from '../server/db.ts'
import { Check, until } from './crash.ts'

const id = randomBytes(4).toString('hex')
const team = `dur-k-${id}`
const login = `${team}@local`

const c = new Check()
const outcome = (work: Promise<unknown>) => work.then(() => 'finished', (error: unknown) => (error instanceof Error ? error.message : String(error)))

try {
  await c.db.connect()
  c.node({}, 'server/migrate.ts')
  c.node({}, 'server/admin.ts', 'add-team', team, login)
  c.node({}, 'server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login)
  const { agentId } = JSON.parse(c.node({}, 'server/admin.ts', 'add-agent', team, `asker-${id}`, `mac-${id}`))
  const { teamId, instanceId } = await c.row(
    `select t.id as "teamId", i.id as "instanceId" from teams t join instances i on i.team_id = t.id where t.name = $1`, [team])
  const { id: conversationId } = await c.row(`insert into conversations (team_id, kind, agent_id) values ($1, 'dm', $2) returning id`, [teamId, agentId])
  const { id: sessionId } = await c.row(
    `insert into sessions (team_id, conversation_id, instance_id, agent_id, status) values ($1, $2, $3, $4, 'needs_approval') returning id`,
    [teamId, conversationId, instanceId, agentId])
  const { id: askId } = await c.row(
    `insert into asks (team_id, kind, session_id, conversation_id, tool_use_id, payload) values ($1, 'tool_approval', $2, $3, 'toolu_lock', $4) returning id`,
    [teamId, sessionId, conversationId, JSON.stringify({ requestId: `request-${id}`, toolName: 'Bash', input: { command: 'echo lock' } })])

  // This connection plays recovery: the session first, then the ask.
  const holder = (await c.row('select pg_backend_pid() as pid')).pid
  await c.db.query('begin')
  await c.db.query(`set local lock_timeout = '20s'`)
  await c.db.query('select 1 from sessions where id = $1 for update', [sessionId])
  const answering = outcome(tx((client) => answerAsk(client, askId, null, 'allow')))
  // Asked on another connection, since a transaction keeps reading the activity it saw first.
  const blocked = await until('the answer to wait on the session', 10, async () =>
    (await pool.query('select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))', [holder])).rowCount).then(() => true, () => false)
  const holding = await outcome(c.db.query('select 1 from asks where id = $1 for update', [askId]))
  await c.db.query(holding === 'finished' ? 'commit' : 'rollback')
  const answered = await answering
  c.check(blocked, 'the answer waits for the session that recovery holds')
  c.check(holding === 'finished' && answered === 'finished',
    `recovery takes the ask and the answer goes through after it, with no deadlock (recovery: ${holding}; answer: ${answered})`)
  const ask = await c.row('select status, answer from asks where id = $1', [askId])
  c.check(ask.status === 'answered' && ask.answer?.decision === 'allow', 'the ask holds the answer')
  c.check(await c.count(`select count(*) from commands where session_id = $1 and kind = 'answer' and status = 'queued'`, [sessionId]) === 1,
    'the answer is on its way to the machine')
} catch (error) {
  c.failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  await c.db.query('rollback').catch(() => {})
  if (!c.failures.length) await c.db.query('delete from teams where name = $1', [team]).catch(() => {})
  await pool.end().catch(() => {})
  await c.db.end().catch(() => {})
}

console.log(`\n${c.failures.length ? `${c.failures.length} failed (team ${team} kept)` : 'all passed (test team removed)'}`)
process.exit(c.failures.length ? 1 : 0)
