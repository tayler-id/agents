// Step 6 of the fit design, the landing review's findings: agents working together
// under concurrency and from the machine port. It runs on a database that
// server/migrate.ts built from the migration files alone, with the final 0019 among
// them, and Electric following it, so the schema is the one a deploy gets. Start one
// with a private Postgres and Electric and run this with their environment. Turns are held running by a create_agent ask
// nobody answers, so the check can make the calls an agent's tools make, from those
// sessions, at the same moment as another write.
//   node --env-file=.env --env-file=.env.test test/step28c.ts

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { asPerson, results, ROOT, startApi, within } from './onboarding-kit.ts'
import { stopAll } from './computers.ts'
import { stopStandIns } from './stand-ins.ts'
import { must } from './must.ts'
import { messageOf } from '../shared/errors.ts'
import { CREATE_AGENT_TOOL, MAX_SENDS_PER_TURN } from '../shared/team-agents.ts'

// The same ports as step28, which this never runs beside.
const PORTS = { machines: 8310, people: 8311, streams: 8312 }
const API = `http://127.0.0.1:${PORTS.machines}`
const PEOPLE = `http://127.0.0.1:${PORTS.people}`
const TURN_SECONDS = 90
// Pairs of agents that message each other at once, and the rounds each pair makes.
const PAIRS = 3
const CLASH_ROUNDS = 3
// Tasks one agent hands another, each reported on while a person writes to it.
const TASKS = 4

const id = randomBytes(4).toString('hex')
const team = `together-28c-${id}`
const alice = `alice28c-${id}@local`
const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) throw new Error('DATABASE_URL names no database')
const PARK = 'PARK-IT'
const SCENARIO = {
  turns: [],
  calls: [
    // A relay through z: it passes a message on to aa, and aa's answer comes back to z.
    { match: 'PASS-ON', unless: 'answered you', say: 'Passed it on.', calls: [{ tool: 'mcp__team-agents__send_to_agent', input: { to: 'aa', text: 'Plain hello from z.' } }] },
    { match: PARK, say: 'Parked.', calls: [{ tool: CREATE_AGENT_TOOL, input: { name: 'parked-never-made' } }] },
  ],
}

const { failures, check } = results()
const db = new pg.Pool({ connectionString: DATABASE_URL })
const children: ChildProcess[] = []
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step28c-')))
let stopApi: (() => Promise<void>) | null = null
let apiLog = () => ''

const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
const all = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows
const node = (...args: string[]) => {
  const run = spawn(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  run.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
  return new Promise<string>((resolve, reject) => {
    run.on('exit', (code) => { if (code === 0) resolve(out); else reject(new Error(`${args.join(' ')} exited ${String(code)}`)) })
  })
}
const post = async (path: string, body: unknown = {}) => {
  const answer = await asPerson(PEOPLE, alice, 'POST', path, body)
  if (answer.status !== 200) throw new Error(`${path}: ${answer.status} ${answer.text}`)
  return answer.json
}
// A call to the API as a machine's agent session, the way its team-agents tools call.
let token = ''
const asSession = (sessionId: string, method: string, path: string, body?: unknown) =>
  fetch(`${API}${path}?session=${sessionId}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }))
const sessionOf = async (conversationId: string, agentId: string) => must(await one(
  'select id from sessions where conversation_id = $1 and agent_id = $2', [conversationId, agentId]), 'the session').id as string
// A turn the stand-in holds running on the create_agent ask nobody answers.
const parked = (sessionId: string) => within(TURN_SECONDS, async () => (await one(
  `select 1 from turns t join asks a on a.session_id = t.session_id and a.status = 'open'
   where t.session_id = $1 and t.status = 'running'`, [sessionId])) !== undefined)
// An agent with a turn held running in a DM with Alice: the DM's session.
const parkInDm = async (name: string, agentId: string) => {
  const { conversationId } = await post('/v1/conversations', { kind: 'dm', agent: name })
  await post(`/v1/conversations/${conversationId}/messages`, { text: `${PARK} please` })
  const session = await within(TURN_SECONDS, async () => (await one('select 1 from sessions where conversation_id = $1', [conversationId])) !== undefined)
    ? await sessionOf(String(conversationId), agentId) : ''
  return { dm: String(conversationId), session, held: session !== '' && await parked(session) }
}

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  await node('server/migrate.ts')
  const finalFile = await one(`select 1 as ok from schema_migrations where version like '0019_agents_together%'`)
  const columns = await all(`select table_name || '.' || column_name as name from information_schema.columns
    where (table_name = 'messages' and column_name in ('kind', 'asked_agent_id')) or (table_name = 'turns' and column_name in ('origin_conversation_id', 'sent_by_turn'))`)
  check(finalFile?.ok === 1 && columns.length === 4,
    `the migrator built the final 0019 into this database: ${columns.map((c) => String(c.name)).sort().join(', ')}`)
  await node('server/admin.ts', 'add-team', team, alice)
  const added = JSON.parse(await node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', alice))
  token = String(added.token)
  const macId = must(await one('select id from instances where name = $1', [`mac-${id}`]), 'the Mac').id
  writeFileSync(join(home, 'scenario.json'), JSON.stringify(SCENARIO))
  const api = await startApi(PORTS, { AGENTS_RUNNER_TEAMS: team }, join(home, 'streams'))
  stopApi = api.stop
  apiLog = api.text
  children.push(api.child)
  await within(20, () => fetch(`${API}/v1/health`).then((res) => res.ok, () => false))
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home,
      AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude-agents.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json'),
    },
  }))
  const make = async (name: string) => String((await post('/v1/agents', { name, homeInstanceId: macId })).agentId)

  // 1. Two agents message each other at the same moment, many times over.
  const pairs = await Promise.all(Array.from({ length: PAIRS }, async (_, i) => ({ a: await make(`left${i}`), b: await make(`right${i}`), i })))
  const ready = await Promise.all(pairs.map(async ({ a, b, i }) => {
    const mine = await parkInDm(`left${i}`, a)
    // The first message makes the thread and holds the other agent's turn running in it.
    const first = await asSession(mine.session, 'POST', '/v1/team-agents/messages', { to: `right${i}`, text: `${PARK} hello` })
    if (first.status !== 200) throw new Error(`the first message: ${first.status} ${JSON.stringify(first.json)}`)
    const thread = must(first.json, 'the first message').threadId as string
    const theirs = await sessionOf(thread, b)
    return { i, mine: mine.session, theirs, held: mine.held && await parked(theirs) }
  }))
  check(ready.every((r) => r.held), `each of ${PAIRS} pairs has a turn held running on both sides of its thread`)
  const clashes = await Promise.all(ready.map(async (pair) => {
    const statuses: number[] = []
    for (let round = 0; round < CLASH_ROUNDS; round++) {
      const [forth, back] = await Promise.all([
        asSession(pair.mine, 'POST', '/v1/team-agents/messages', { to: `right${pair.i}`, text: `ping ${round}` }),
        asSession(pair.theirs, 'POST', '/v1/team-agents/messages', { to: `left${pair.i}`, text: `pong ${round}` }),
      ])
      statuses.push(forth.status, back.status)
    }
    return statuses
  }))
  const sent = clashes.flat()
  check(sent.length === PAIRS * CLASH_ROUNDS * 2 && sent.every((s) => s === 200),
    `${sent.length} messages between pairs of agents, each way at the same moment, all went through (${sent.join(' ')})`)

  // 2. A handed task's agent reports back while a person writes to the task.
  const boss = await make('boss')
  await make('worker')
  const bossDm = await parkInDm('boss', boss)
  const handed = []
  for (let k = 0; k < TASKS; k++) {
    const task = await asSession(bossDm.session, 'POST', '/v1/team-agents/tasks', { to: 'worker', title: `Job ${k}`, instructions: `${PARK} job ${k}` })
    handed.push(task)
  }
  const sessions = handed.map((h) => String(must(h.json, 'a handed task').sessionId))
  const heldTasks = await Promise.all(sessions.map((s) => parked(s)))
  check(bossDm.held && handed.every((h) => h.status === 200) && heldTasks.every(Boolean), `${TASKS} tasks handed to worker, each with its turn held running`)
  const reports = await Promise.all(sessions.map(async (session, k) => {
    const [report, person] = await Promise.all([
      asSession(session, 'POST', '/v1/team-agents/report', { text: `Job ${k} is done.` }),
      asPerson(PEOPLE, alice, 'POST', `/v1/sessions/${session}/messages`, { text: `One more thing on job ${k}.` }),
    ])
    return [report.status, person.status]
  }))
  check(reports.flat().every((s) => s === 200), `a report on each task and a person's message to it at the same moment all went through (${reports.flat().join(' ')})`)

  // 3. A turn sends 5 messages of its own while answers pass through it. y's message to z
  // makes z ask aa, and aa's answer comes back to z as a turn that answers to y's turn.
  const [y] = [await make('why'), await make('z'), await make('aa')]
  const yDm = await parkInDm('why', y)
  const asked = await asSession(yDm.session, 'POST', '/v1/team-agents/messages', { to: 'z', text: 'PASS-ON please' })
  const yTurn = must(await one(`select id from turns where session_id = $1 and status = 'running'`, [yDm.session]), "y's running turn").id
  const passed = await within(TURN_SECONDS, async () => Number((await one(
    `select count(*)::int as n from turns where answer_to_turn = $1 and source = 'agent'`, [yTurn]))?.n) >= 2)
  const more = []
  for (let k = 0; k < MAX_SENDS_PER_TURN - 1; k++) more.push(await asSession(yDm.session, 'POST', '/v1/team-agents/messages', { to: 'z', text: `Plain note ${k}.` }))
  const sixth = await asSession(yDm.session, 'POST', '/v1/team-agents/messages', { to: 'z', text: 'Plain note 6.' })
  check(yDm.held && asked.status === 200 && passed && more.every((m) => m.status === 200) && sixth.status === 409,
    `an answer passing through y's turn is not one of its sends: y sends ${MAX_SENDS_PER_TURN} of its own and the next is refused (${more.map((m) => m.status).join(' ')}, then ${sixth.status})`)

  // 4. A call from the machine port is tied to a turn running on that machine. A session
  // that names itself with no turn running, such as an idle one, gets nothing.
  const idle = await make('idler')
  const { conversationId: idleDm } = await post('/v1/conversations', { kind: 'dm', agent: 'idler' })
  await post(`/v1/conversations/${idleDm}/messages`, { text: 'Say hello.' })
  const idleSession = await within(TURN_SECONDS, async () => (await one(
    `select 1 from turns t join sessions s on s.id = t.session_id where s.conversation_id = $1 and t.status = 'done'`, [idleDm])) !== undefined)
    ? await sessionOf(String(idleDm), idle) : ''
  const listed = await asSession(idleSession, 'GET', '/v1/team-agents')
  const reported = await asSession(idleSession, 'POST', '/v1/team-agents/agents', { name: 'idle-made' })
  const alive = await asSession(yDm.session, 'GET', '/v1/team-agents')
  check(idleSession !== '' && listed.status === 403 && reported.status === 403 && alive.status === 200,
    `a session with no turn running on the machine gets no agent tools, and one with a turn running does (${listed.status} ${reported.status}, then ${alive.status})`)

  // 5. Sends at the same moment from one turn stop at the cap, and two agents' first messages to
  // each other at the same moment make one thread. The pair lock and the fan-out lock hold these.
  const burst = await parkInDm('burster', await make('burster'))
  const bursts = await Promise.all(Array.from({ length: MAX_SENDS_PER_TURN + 3 }, (_, k) =>
    asSession(burst.session, 'POST', '/v1/team-agents/messages', { to: 'z', text: `Burst ${k}.` })))
  const passedBurst = bursts.filter((b) => b.status === 200).length
  check(burst.held && passedBurst === MAX_SENDS_PER_TURN && bursts.filter((b) => b.status === 409).length === 3,
    `${bursts.length} sends from one turn at the same moment: ${passedBurst} went through and ${bursts.length - passedBurst} were refused (${bursts.map((b) => b.status).join(' ')})`)
  const [p1, p2] = [await make('pone'), await make('ptwo')]
  const [one1, two1] = [await parkInDm('pone', p1), await parkInDm('ptwo', p2)]
  const firsts = await Promise.all([
    asSession(one1.session, 'POST', '/v1/team-agents/messages', { to: 'ptwo', text: 'First one.' }),
    asSession(two1.session, 'POST', '/v1/team-agents/messages', { to: 'pone', text: 'First two.' }),
  ])
  const threads = await all(`select c.id from conversations c where c.kind = 'agents'
    and exists (select 1 from conversation_members m where m.conversation_id = c.id and m.agent_id = $1)
    and exists (select 1 from conversation_members m where m.conversation_id = c.id and m.agent_id = $2)`, [p1, p2])
  check(firsts.every((f) => f.status === 200) && threads.length === 1,
    `two agents' first messages to each other at the same moment make one thread (${threads.length} threads, ${firsts.map((f) => f.status).join(' ')})`)

  // 6. What an agent says in private work is not copied into a thread the team reads.
  const secret = await parkInDm('secretive', await make('secretive'))
  await db.query(`update conversations set visibility = 'private' where id = $1`, [secret.dm])
  const leaked = await asSession(secret.session, 'POST', '/v1/team-agents/messages', { to: 'z', text: 'Private work, passed on.' })
  check(secret.held && leaked.status === 409 && JSON.stringify(leaked.json).includes('private'),
    `an agent in private work sends nothing to another agent (${leaked.status} ${JSON.stringify(leaked.json)})`)

  // 7. An answer that can never be delivered is marked so once and posted where the chain started,
  // not tried on every tick for good. A trigger refuses any new user event in ua's session, a failure of
  // its own that no retry cures.
  const [ua, ub] = [await make('ua'), await make('ub')]
  const uaDm = await parkInDm('ua', ua)
  const uaSent = await asSession(uaDm.session, 'POST', '/v1/team-agents/messages', { to: 'ub', text: `${PARK} go` })
  const ubSession = await sessionOf(String(uaSent.json.threadId), ub)
  const ubHeld = await parked(ubSession)
  const ubTurn = must(await one(`select id from turns where session_id = $1 and status = 'running'`, [ubSession]), "ub's running turn").id
  await db.query(`create function pg_temp.refuse() returns trigger language plpgsql as $$ begin raise exception 'step28c refuses this session new messages'; end $$`.replace('pg_temp.', 'public.step28c_'))
  await db.query(`create trigger step28c_refuse before insert on events for each row when (new.session_id = '${uaDm.session}' and new.kind = 'user') execute function public.step28c_refuse()`)
  const ubAsk = must(await one(`select id from asks where session_id = $1 and status = 'open'`, [ubSession]), "ub's ask").id
  await asPerson(PEOPLE, alice, 'POST', `/v1/asks/${ubAsk}/answer`, { decision: 'deny' })
  const marked = await within(TURN_SECONDS, async () => (await one('select 1 from turns where id = $1 and answer_sent_at is not null', [ubTurn])) !== undefined)
  const lost = await one('select answer_error from turns where id = $1', [ubTurn])
  const note = await one(`select body, agent_id, asked_agent_id from messages where conversation_id = $1 and kind = 'answer'`, [uaDm.dm])
  await db.query('drop trigger step28c_refuse on events')
  await db.query('drop function public.step28c_refuse()')
  check(uaDm.held && ubHeld && marked && String(lost?.answer_error).length > 0 && note?.agent_id === ub && note.asked_agent_id === ua && String(note.body).includes('could not be delivered'),
    `an answer that cannot be delivered is marked once, with its reason, and posted where the chain started (${String(lost?.answer_error)} | ${String(note?.body)})`)
  check(!/deadlock detected/.test(apiLog()), 'the API reported no deadlock')
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : messageOf(error)}`)
} finally {
  await stopAll(children.filter((child) => child !== children[0]))
  await stopApi?.()
  stopStandIns(home)
  if (failures.length) console.log(`\nthe API's errors:\n${apiLog().split('\n').filter((line) => /error|deadlock/i.test(line)).slice(0, 20).join('\n')}`)
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
    rmSync(home, { recursive: true, force: true })
  }
  await db.end().catch(() => undefined)
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} kept, files in ${home})` : 'all passed (test team removed)'}`)
process.exit(failures.length ? 1 : 0)
