// Step 1 of the target architecture: one door for every turn. A person's own box
// goes to sleep once it has had nothing to do. A DM to an agent on it waits, and
// the conversation's line reads that the computer is starting, until the box is
// up. Then the turn goes to the box and the reply is posted. The check times the
// start. It also covers a DM sent while a new box first starts, a routine's firing
// kept as a turn, a turn that waits for a Mac that is offline, a running turn
// marked stuck and cleared when an event comes, and that only the scheduler
// writes message commands. The box is a real container from this branch's image,
// with the stand-in for Claude, and the API listens on 7701, the port the box
// firewall keeps open for checks. The caller holds ~/.agents-app/checks/run.lock
// while it runs, as for step15.
//   node --env-file=.env --env-file=.env.test test/step23.ts

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { asPerson, results, shapeRows, within } from './onboarding-kit.ts'
import { boxCheckEnv, IMAGE, MACHINE_PORT, peopleSocket, ROOT, stopAll, tryDocker } from './computers.ts'
import { killFakes } from './crash.ts'
import { must } from './must.ts'
import { servePeople } from './people.ts'
import { messageOf } from '../shared/errors.ts'

const PEOPLE_PORT = 8120
const STREAMS_PORT = 8121
const API = `http://127.0.0.1:${MACHINE_PORT}`
const PEOPLE = `http://127.0.0.1:${PEOPLE_PORT}`
// A box sleeps after 15 seconds with nothing to do, where the default is 30
// minutes. The runner looks once a minute, so it sleeps within 75 seconds, and
// its daemon then says it is going offline, or is found silent 45 seconds later.
const IDLE_MIN = '0.25'
const SLEEP_SECONDS = 150
// A running turn is marked stuck after 6 seconds with no new event, where the default is 10 minutes.
const STUCK_MIN = '0.1'
const STUCK_SECONDS = 30
// The desktop gets 30 seconds to come up (daemon/desktop.ts), and the daemon
// reports in once it has. A start that takes longer means the turn missed its
// computer coming up. A wake on this Mac took 2.5 s on 2026-10-15.
const START_LIMIT_SECONDS = 30

const id = randomBytes(4).toString('hex')
const team = `door-23-${id}`
const alice = `alice23-${id}@local`
// Box mounts come from the colima VM, which sees only the home folder.
const work = join(homedir(), '.agents-app', 'checks', team)
const macHome = join(work, 'mac')

const { failures, check } = results()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const row = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0]
const env = {
  ...boxCheckEnv(team, work, STREAMS_PORT, [PEOPLE]),
  AGENTS_BOX_IDLE_MIN: IDLE_MIN, AGENTS_TURN_STUCK_MIN: STUCK_MIN, AGENTS_BOX_TOKEN_FILE: join(work, 'no-team-token'),
}
const node = (...args: string[]) => {
  const run = spawn(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] })
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
const latestTurn = (conversationId: string) => row('select * from turns where conversation_id = $1 order by requested_at desc, id desc limit 1', [conversationId])
const agentPosts = async (conversationId: string) =>
  Number((await row(`select count(*)::int as n from messages where conversation_id = $1 and speaker = 'agent'`, [conversationId])).n)
// What a person reads of a conversation's waiting and stuck turns, as the app reads it.
const waitsOf = async (conversationId: string) => (await shapeRows(PEOPLE, alice, 'turn_waits', { conversation: conversationId })).rows
const seconds = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 100) / 10

let boxId = ''
let sleeperFolder = ''
try {
  await db.connect()
  mkdirSync(macHome, { recursive: true })
  writeFileSync(join(work, 'scenario.json'), JSON.stringify({ turns: [{ match: 'HANG', hang: true }] }))

  // Only the scheduler writes message commands, so every turn goes through its door.
  const writers = readdirSync(join(ROOT, 'server')).filter((file) => file.endsWith('.ts'))
    .filter((file) => /insert into commands\b[^`]*'message'/.test(readFileSync(join(ROOT, 'server', file), 'utf8')))
  check(writers.join() === 'scheduler.ts', `only server/scheduler.ts writes message commands (written in ${writers.join(', ') || 'no file'})`)

  await node('server/migrate.ts')
  await node('server/admin.ts', 'add-team', team, alice)
  const built = Date.now()
  await node('server/boxes.ts', 'build')
  console.log(`      built ${IMAGE} in ${Math.round((Date.now() - built) / 1000)} s`)
  children.push(spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, ...env },
  }))
  await servePeople(PEOPLE_PORT, peopleSocket(work))
  await within(20, () => fetch(API).then(() => true, () => false))
  const aliceId = must(await row('select id from people where login = $1', [alice]), 'alice').id

  // Alice's own box, and an agent on it, messaged while the new box first starts.
  boxId = (await post('/v1/me/box')).instanceId
  const container = `agents-box-${boxId}`
  await post('/v1/agents', { name: 'scout', homeInstanceId: boxId })
  const { conversationId: dm } = await post('/v1/conversations', { kind: 'dm', agent: 'scout' })
  await post(`/v1/conversations/${dm}/messages`, { text: 'Are you there?' })
  const first = await latestTurn(dm)
  check(first?.source === 'person' && first.asked_by_person === aliceId && first.status === 'waiting' && first.wait === 'computer_starting'
    && first.instance_id === boxId && first.command_id === null,
  `a DM sent while its agent's new computer starts is a turn that waits for it, with no command yet (${first?.status} ${first?.wait})`)
  // The app shows a working session as the agent thinking, and the watchdog marks one lost when its machine is silent.
  const waitingSession = await row('select status from sessions where id = $1', [first?.session_id])
  check(waitingSession?.status === 'idle', `while its turn waits, the new session is idle, not shown as working (${waitingSession?.status})`)
  const firstDone = await within(START_LIMIT_SECONDS * 2, async () => (await latestTurn(dm))?.status === 'done' && await agentPosts(dm) === 1)
  const firstEnd = await latestTurn(dm)
  check(firstDone && firstEnd.placed_at && firstEnd.started_at && firstEnd.finished_at && firstEnd.command_id,
    `once the computer is up the turn is placed, taken and ended, and the reply is posted (${firstEnd?.status}, placed ${
      firstEnd?.placed_at ? seconds(firstEnd.requested_at, firstEnd.placed_at) : '?'} s after the DM, which came just after the box was made)`)

  // A routine run from the app is a turn kept with its routine and whoever ran it,
  // and goes straight to a computer that takes work.
  const scoutId = must(await row(`select id from agents where name = 'scout' and team_id = (select team_id from people where id = $1)`, [aliceId]), 'scout').id
  await post(`/v1/agents/${scoutId}/routines`, { name: 'standup', schedule: '0 9 * * *', prompt: 'Say what is blocked.' })
  const routine = must(await row(`select id from routines where agent_id = $1 and name = 'standup'`, [scoutId]), 'the routine')
  const { conversationId: main } = await post(`/v1/routines/${routine.id}/run`)
  const firing = await row('select * from turns where routine_id = $1', [routine.id])
  check(firing?.source === 'routine' && firing.conversation_id === main && firing.asked_by_person === aliceId && firing.status !== 'waiting'
    && firing.placed_at !== null && firing.command_id !== null,
  `a routine's firing is a turn with its routine and who ran it, placed at once on a computer that takes work (${firing?.status})`)
  check(await within(30, async () => (await row('select status from turns where id = $1', [firing.id]))?.status === 'done'),
    "the routine's turn ends with its reply")

  // With nothing to do, the box goes to sleep.
  const slept = await within(SLEEP_SECONDS, async () => {
    const box = await row('select status, stopped_at from instances where id = $1', [boxId])
    return box?.stopped_at !== null && box?.status !== 'online' && tryDocker('inspect', '-f', '{{.State.Running}}', container) === 'false'
  })
  check(slept, "a person's own computer with nothing to do goes to sleep: marked asleep, its container stopped, no longer online")

  // A DM wakes it. The conversation says the computer is starting, then the reply comes.
  const posts = await agentPosts(dm)
  await post(`/v1/conversations/${dm}/messages`, { text: 'Are you awake?' })
  const woken = await latestTurn(dm)
  const waits = await waitsOf(dm)
  check(woken?.status === 'waiting' && woken.wait === 'computer_starting' && woken.instance_id === boxId,
    `a DM to an agent whose computer is asleep waits for the computer to start (${woken?.status} ${woken?.wait})`)
  check(waits.length === 1 && waits[0].id === woken?.id && waits[0].wait === 'computer_starting' && waits[0].instance_id === boxId && !('payload' in waits[0]),
    `the conversation reads that its computer is starting, and never the turn's prompt (${JSON.stringify(waits)})`)
  const answered = await within(START_LIMIT_SECONDS * 2, async () => (await latestTurn(dm))?.status === 'done' && await agentPosts(dm) === posts + 1)
  const end = await latestTurn(dm)
  const started = end?.placed_at ? seconds(end.requested_at, end.placed_at) : null
  const replied = answered ? seconds(end.requested_at, (await row(`select max(created_at) as at from messages where conversation_id = $1`, [dm])).at) : null
  console.log(`      the computer woke and took the turn ${started ?? '?'} s after the message, and the reply came ${replied ?? '?'} s after it`)
  check(answered && started !== null && started <= START_LIMIT_SECONDS,
    `the computer starts, the turn goes to it and the reply is posted, with the start under ${START_LIMIT_SECONDS} s (${started ?? '?'} s)`)
  const awake = await row('select stopped_at, idle_since from instances where id = $1', [boxId])
  check(awake?.stopped_at === null && awake.idle_since > woken.requested_at && (await waitsOf(dm)).length === 0,
    'waking clears the sleep mark and starts its idle time again, and the line goes once the turn has its computer')

  // A Mac that is offline: the turn waits for it, and goes when it reports in.
  const { token: macToken } = JSON.parse(await node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', alice))
  await node('server/admin.ts', 'add-agent', team, 'courier', `mac-${id}`)
  const macId = must(await row('select id from instances where name = $1', [`mac-${id}`]), 'the Mac').id
  const { conversationId: courierDm } = await post('/v1/conversations', { kind: 'dm', agent: 'courier' })
  await post(`/v1/conversations/${courierDm}/messages`, { text: 'Where are you?' })
  const offline = await latestTurn(courierDm)
  const offlineWaits = await waitsOf(courierDm)
  check(offline?.status === 'waiting' && offline.wait === 'machine_offline' && offline.instance_id === macId
    && offlineWaits.length === 1 && offlineWaits[0].wait === 'machine_offline',
  `a DM to an agent on a Mac that is offline waits, and the conversation reads why (${offline?.status} ${offline?.wait})`)
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: macToken, AGENTS_HOME: macHome, AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(work, 'scenario.json') },
  }))
  check(await within(60, async () => (await latestTurn(courierDm))?.status === 'done' && await agentPosts(courierDm) === 1),
    'once the Mac reports in, the waiting turn goes to it and the reply is posted')

  // A running turn with no new event is marked stuck with when it was last heard
  // from, which the conversation reads. An event clears the mark. Nothing is stopped.
  await node('server/admin.ts', 'add-agent', team, 'sleeper', `mac-${id}`)
  const sleeperId = must(await row(`select id from agents where name = 'sleeper' and home_instance_id = $1`, [macId]), 'sleeper').id
  sleeperFolder = join(macHome, 'agents', sleeperId)
  const { conversationId: sleeperDm } = await post('/v1/conversations', { kind: 'dm', agent: 'sleeper' })
  await post(`/v1/conversations/${sleeperDm}/messages`, { text: 'HANG until told' })
  const marked = await within(STUCK_SECONDS, async () => (await latestTurn(sleeperDm))?.stuck_since !== null)
  const stuck = await latestTurn(sleeperDm)
  const stuckWaits = await waitsOf(sleeperDm)
  check(marked && stuck.status === 'running' && stuckWaits.length === 1 && stuckWaits[0].status === 'running' && stuckWaits[0].stuck_since,
    `a running turn quiet past its limit is marked stuck, and the conversation reads since when (${stuck?.status}, ${String(stuck?.stuck_since)})`)
  const heard = await fetch(`${API}/v1/sessions/${stuck.session_id}/events`, {
    method: 'POST', headers: { authorization: `Bearer ${macToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ clientId: `still-here-${id}`, kind: 'thinking', text: 'Still on it.', body: { text: 'Still on it.' } }] }),
  })
  check(heard.ok && await within(10, async () => (await latestTurn(sleeperDm))?.stuck_since === null) && (await latestTurn(sleeperDm))?.status === 'running',
    'a new event clears the stuck mark, and the turn is still running')
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : messageOf(error)}`)
} finally {
  await stopAll(children)
  if (sleeperFolder) killFakes(sleeperFolder)
  // The box, its volume and its image are this check's own, and go whatever happened.
  if (boxId) {
    tryDocker('rm', '-f', `agents-box-${boxId}`)
    tryDocker('volume', 'rm', `agents-box-${boxId}-home`)
  }
  tryDocker('rmi', IMAGE)
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
    rmSync(work, { recursive: true, force: true })
  }
  await db.end().catch(() => undefined)
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test team and box removed)'}`)
process.exit(failures.length ? 1 : 0)
