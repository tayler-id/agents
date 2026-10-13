// Durability check 4, with the fake Claude in a box. An agent whose home is a box
// writes a file and is mid-call when the box's container is removed. While the
// box is gone, its session shows as lost. A new container on the same home
// volume brings back the file and the session, and the turn finishes without
// writing the file twice. The check's API listens on 7701, the port the box
// firewall keeps open for checks, so it takes the shared lock first.
//   node --env-file=.env --env-file=.env.test test/step18d.ts

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Check, clientsMatchRecord, LOST_SEC, person, ROOT, TURN_SECONDS, until } from './crash.ts'

const PORT = 7701
const PEOPLE_PORT = 8055
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PEOPLE_PORT}`
const id = randomBytes(4).toString('hex')
const team = `dur-d-${id}`
const login = `${team}@local`
const boxName = `box-${id}`
const image = `agents-box:dur-${id}`
// Box mounts come from the colima VM, which sees only the home folder.
const work = join(homedir(), '.agents-app', 'checks', team)
const lock = join(homedir(), '.agents-app', 'checks', 'run.lock')
// Other agents' checks hold the lock while they use 7701.
const LOCK_WAIT_MIN = 20

const c = new Check()
const say = person(PEOPLE, login)
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
const tryDocker = (...args: string[]) => {
  try {
    return docker(...args)
  } catch {
    // The container or file is not there.
    return null
  }
}
const boxEnv: Record<string, string> = {
  AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_PORT: String(PEOPLE_PORT), AGENTS_STREAMS_PORT: String(PEOPLE_PORT + 1),
  AGENTS_BOX_IMAGE: image, AGENTS_BOX_API: `http://host.docker.internal:${PORT}`,
  // The box gets no Claude login: it runs the fake.
  AGENTS_BOX_TOKEN_FILE: join(work, 'no-token'),
  AGENTS_BOX_DOCKER_ARGS: JSON.stringify([
    '-v', `${join(ROOT, 'test/fake-claude.ts')}:/opt/fake/fake-claude.ts:ro`, '-v', `${join(work, 'scenario.json')}:/opt/fake/scenario.json:ro`,
    '-e', 'AGENTS_CLAUDE_BIN=/opt/fake/fake-claude.ts', '-e', 'AGENTS_FAKE_SCENARIO=/opt/fake/scenario.json',
  ]),
}

async function takeLock() {
  const deadline = Date.now() + LOCK_WAIT_MIN * 60_000
  for (;;) {
    try {
      mkdirSync(lock)
      return
    } catch {
      // Another check holds it.
      if (Date.now() > deadline) throw new Error(`${lock} was held for ${LOCK_WAIT_MIN} minutes`)
      await sleep(5000)
    }
  }
}

let locked = false
let instanceId = ''
const container = () => `agents-box-${instanceId}`

try {
  await takeLock()
  locked = true
  await c.db.connect()
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'scenario.json'), JSON.stringify({
    turns: [{ match: 'NOTES', append: { id: 'toolu_notes', file: 'notes.txt', line: 'note-1', hangOnce: true, checkNamed: true }, reply: 'Wrote note-1.' }],
  }))
  c.node(boxEnv, 'server/migrate.ts')
  c.node(boxEnv, 'server/admin.ts', 'add-team', team, login)
  c.node(boxEnv, 'server/boxes.ts', 'build')
  c.start('server/api.ts', { ...boxEnv, AGENTS_STREAMS_DIR: join(work, 'streams'), AGENTS_MACHINE_LOST_SEC: String(LOST_SEC) })
  await until('the API', 20, async () => fetch(API).then(() => true, () => false))
  instanceId = JSON.parse(c.node(boxEnv, 'server/boxes.ts', 'create', team, boxName)).instanceId
  const { agentId } = JSON.parse(c.node(boxEnv, 'server/admin.ts', 'add-agent', team, `writer-${id}`, boxName))
  const instance = () => c.row('select status from instances where id = $1', [instanceId])
  await until('the box online', 120, async () => (await instance())?.status === 'online')

  const { conversationId } = await say('/v1/conversations', { kind: 'dm', agent: `writer-${id}` })
  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Do the NOTES task.' })
  const { id: sessionId } = await c.row('select id from sessions where conversation_id = $1', [conversationId])
  const folder = `/home/agent/.agents-app/agents/${agentId}`
  const notes = () => tryDocker('exec', container(), 'cat', `${folder}/notes.txt`)
  const session = () => c.row('select status, harness_session_id from sessions where id = $1', [sessionId])

  await until('the note and its call in the record', 90, async () => notes() === 'note-1'
    && (await c.count(`select count(*) from events where session_id = $1 and tool_use_id = 'toolu_notes'`, [sessionId])) === 1)
  const before = docker('inspect', '-f', '{{.Id}}', container())
  const cut = await session()
  docker('rm', '-f', container())

  await until('the session to show as lost', LOST_SEC * 3, async () => (await session())?.status === 'lost')
  c.check((await instance())?.status === 'stale', 'with its container gone, the box shows as stale')
  const notice = await c.row(`select body from events where session_id = $1 and kind = 'notice' and body->>'subtype' = 'interrupted'`, [sessionId])
  c.check(notice && /stopped answering/.test(String(notice.body.reason)), "the session shows as lost, and the record says the box stopped answering")
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, when: 'while the box is gone' })

  c.node(boxEnv, 'server/boxes.ts', 'recreate', team, boxName)
  await until('the resumed turn to end', TURN_SECONDS, async () =>
    (await c.count(`select count(*) from events where session_id = $1 and kind = 'usage'`, [sessionId])) >= 1)

  const after = tryDocker('inspect', '-f', '{{.Id}}', container())
  c.check(after && after !== before && notes() === 'note-1', 'a new container on the same volume has the note, written once')
  const starts = (tryDocker('exec', container(), 'cat', `${folder}/.fake/starts.jsonl`) ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const now = await session()
  c.check(starts.length === 2 && starts[1].resumed && starts[1].sessionId === cut.harness_session_id && now.harness_session_id === cut.harness_session_id,
    'the new container resumed the same Claude conversation from the volume')
  const posts = await c.rows('select speaker, body from messages where conversation_id = $1 order by seq', [conversationId])
  c.check(posts.map((p) => p.speaker).join() === 'person,agent' && posts[1]?.body === 'notes.txt already has note-1, so I left it alone.',
    "the agent's reply reached the conversation")
  c.check(now.status === 'idle' && (await instance())?.status === 'online', 'the session is idle and the box is online')
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, when: 'after the box was replaced' })
} catch (error) {
  c.failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack ?? String(error)}`)
} finally {
  for (const child of c.children) child.kill('SIGTERM')
  await sleep(1000)
  // The box, its volume and its image are removed whatever happened, or the box
  // would keep calling a closed port. All three are this check's own.
  if (instanceId) {
    tryDocker('rm', '-f', container())
    tryDocker('volume', 'rm', `${container()}-home`)
  }
  tryDocker('rmi', image)
  if (!c.failures.length) {
    await c.db.query('delete from teams where name = $1', [team]).catch(() => {})
    rmSync(work, { recursive: true, force: true })
  }
  await c.db.end().catch(() => {})
  if (locked) rmdirSync(lock)
}

console.log(`\n${c.failures.length ? `${c.failures.length} failed (team ${team} kept)` : 'all passed (test team, box and image removed)'}`)
process.exit(c.failures.length ? 1 : 0)
