// Durability check 10, on the server's own code. A message command's status
// changes only through the one writer, which moves all the commands it is given
// or none, and only along the lifecycle table. A transaction whose connection
// Postgres drops fails to its caller without stopping the process. And an API
// given a watchdog threshold under two heartbeats refuses to start.
//   node --env-file=.env --env-file=.env.test test/step18i.ts

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandSources } from '../shared/lifecycle.ts'
import { MessageMoveRefused, moveMessages } from '../server/durability.ts'
import { claimCommand } from '../server/record.ts'
import { pool, tx } from '../server/db.ts'
import { Check, ROOT, until } from './crash.ts'

const id = randomBytes(4).toString('hex')
const team = `dur-i-${id}`
const login = `${team}@local`
// The machine port an API refused here would have used. Nothing else in the suite uses it.
const PORT = 8040

const c = new Check()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-dur-i-')))

// Whether `work` throws an error of `kind`. Any other error fails the check too.
const refuses = async (work: () => Promise<unknown>, kind: new (...args: never[]) => Error) => {
  try {
    await work()
    return false
  } catch (error) {
    return error instanceof kind
  }
}

try {
  await c.db.connect()
  c.node({}, 'server/migrate.ts')
  c.node({}, 'server/admin.ts', 'add-team', team, login)
  c.node({}, 'server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login)
  c.node({}, 'server/admin.ts', 'add-instance', team, `other-${id}`, 'mac', login)
  const { agentId } = JSON.parse(c.node({}, 'server/admin.ts', 'add-agent', team, `mover-${id}`, `mac-${id}`))
  const instanceOf = async (name: string) => (await c.row('select id from instances where name = $1', [name])).id
  const instanceId = await instanceOf(`mac-${id}`)
  const otherId = await instanceOf(`other-${id}`)
  const { teamId } = await c.row('select id as "teamId" from teams where name = $1', [team])
  const { id: conversationId } = await c.row(`insert into conversations (team_id, kind, agent_id) values ($1, 'dm', $2) returning id`, [teamId, agentId])
  const { id: sessionId } = await c.row(
    `insert into sessions (team_id, conversation_id, instance_id, agent_id) values ($1, $2, $3, $4) returning id`, [teamId, conversationId, instanceId, agentId])
  const message = async (status: string) => (await c.row(
    `insert into commands (team_id, instance_id, session_id, kind, status, payload) values ($1, $2, $3, 'message', $4, $5) returning id`,
    [teamId, instanceId, sessionId, status, JSON.stringify({ text: 'hello' })])).id
  const statusOf = async (commandId: string) => (await c.row('select status from commands where id = $1', [commandId])).status

  // The table.
  const sources = [commandSources('handed_over'), commandSources('done'), commandSources('failed'), commandSources('queued')]
  c.check(JSON.stringify(sources) === JSON.stringify([['queued'], ['claimed'], ['claimed'], []]),
    `the lifecycle table moves a message's command only from queued to claimed, and from claimed to done or failed (${JSON.stringify(sources)})`)

  // The one writer.
  const done = await message('done')
  const failed = await message('failed')
  const queued = await message('queued')
  const claimed = await message('claimed')
  c.check(await refuses(() => moveMessages(pool, [done], 'handed_over'), MessageMoveRefused) && await statusOf(done) === 'done',
    'a finished message is never handed over again, and stays done')
  c.check(await refuses(() => moveMessages(pool, [failed], 'done'), MessageMoveRefused) && await statusOf(failed) === 'failed',
    'a failed message is never marked done')
  c.check(await refuses(() => moveMessages(pool, [queued], 'done'), MessageMoveRefused) && await statusOf(queued) === 'queued',
    'a queued message is never marked done before a machine has it')
  c.check(await refuses(() => moveMessages(pool, [claimed, done], 'done'), MessageMoveRefused) && await statusOf(claimed) === 'claimed',
    'a move of several messages, one of them in the wrong state, moves none of them')
  c.check(await refuses(() => moveMessages(pool, [queued], 'handed_over', { instanceId: otherId }), MessageMoveRefused) && await statusOf(queued) === 'queued',
    'a machine cannot take a message queued for another machine')
  const claim = await claimCommand(pool, instanceId, queued)
  c.check(claim?.kind === 'message' && await statusOf(queued) === 'claimed', 'a machine claims a queued message, and it is handed over')
  c.check(await claimCommand(pool, instanceId, queued) === null && await claimCommand(pool, instanceId, done) === null,
    'a second claim of the message, or a claim of a finished one, gets nothing')

  // A transaction whose connection Postgres drops.
  const sleeping = tx(async (client) => { await client.query(`select pg_sleep(30), 'durability-check-${id}'`) })
  await until('the transaction to be running', 10, async () =>
    (await c.count(`select count(*) from pg_stat_activity where query like $1 and state = 'active'`, [`%durability-check-${id}%`])) === 1)
  await c.db.query(`select pg_terminate_backend(pid) from pg_stat_activity where query like $1 and pid <> pg_backend_pid()`, [`%durability-check-${id}%`])
  const ended = await sleeping.then(() => 'committed', (error: unknown) => (error instanceof Error ? error.message : String(error)))
  c.check(ended !== 'committed', `a transaction whose connection Postgres dropped fails to its caller (${ended}), and the process keeps running`)
  const after = await tx(async (client) => (await client.query<{ one: number }>('select 1 as one')).rows[0]?.one)
  c.check(after === 1, 'the next transaction runs on a good connection')

  // A watchdog threshold under two heartbeats.
  const api = spawn(process.execPath, ['--env-file=.env', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env, AGENTS_MACHINE_LOST_SEC: '10', AGENTS_RUNNER: 'off', AGENTS_API_PORT: String(PORT),
      AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'), AGENTS_STREAMS_DIR: join(home, 'streams'), AGENTS_STREAMS_PORT: String(PORT + 100),
    },
  })
  c.children.push(api)
  let stderr = ''
  api.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const stopped = await until('the API to stop', 20, async () => api.exitCode !== null).then(() => true, () => false)
  c.check(stopped && api.exitCode !== 0 && stderr.includes('AGENTS_MACHINE_LOST_SEC'),
    'an API given a watchdog threshold under two heartbeats stops at once and names the setting')
} catch (error) {
  c.failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  for (const child of c.children) child.kill('SIGTERM')
  if (!c.failures.length) {
    await c.db.query('delete from teams where name = $1', [team]).catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
  await pool.end().catch(() => {})
  await c.db.end().catch(() => {})
}

console.log(`\n${c.failures.length ? `${c.failures.length} failed (team ${team} and ${home} kept)` : 'all passed (test team removed)'}`)
process.exit(c.failures.length ? 1 : 0)
