// Durability check 5, with the fake Claude. A person has a DM open in the app,
// and another client is connected to it, while the agent waits for an approval,
// and the machine dies. Once the machine has stopped answering, the app shows the
// turn as interrupted with the reason and the card still open, and a client that
// stayed connected and one that reconnects both read exactly what the record
// holds. After the machine is back, the person answers the same card in the app,
// the turn ends, the app shows the reply with no card and no interrupted line,
// and both clients read the record again. Checks 1 to 4 make the same
// comparison of clients and record when they finish. A task of the same agent,
// mid-call when the machine dies, shows the same way on its page: interrupted
// with the reason and an Interrupt button, then the reply, and never the text
// the resumed session was sent.
//   node --env-file=.env --env-file=.env.test test/step18e.ts

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from '@playwright/test'
import { Check, clientsMatchRecord, killFakes, killMachine, liveClient, LOST_SEC, person, ROOT, TURN_SECONDS, until } from './crash.ts'

const PORT = 8057
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const id = randomBytes(4).toString('hex')
const team = `dur-e-${id}`
const login = `${team}@local`
// How long the app gets to show what the record holds. The interrupted line's
// reason is read every 10 seconds.
const SHOWN_SEC = 30

const c = new Check()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-dur-e-')))
const say = person(PEOPLE, login)
let folder = ''
let taskFolder = ''
let live: ReturnType<typeof liveClient> | undefined
let browser: Browser | undefined

const shows = (seen: Promise<unknown>) => seen.then(() => true, () => false)

try {
  await c.db.connect()
  c.node({}, 'server/migrate.ts')
  c.node({}, 'server/admin.ts', 'add-team', team, login)
  const { token } = JSON.parse(c.node({}, 'server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  const { agentId } = JSON.parse(c.node({}, 'server/admin.ts', 'add-agent', team, `watcher-${id}`, `mac-${id}`))
  folder = join(home, 'agents', agentId)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(home, 'scenario.json'), JSON.stringify({
    turns: [
      { match: 'WATCH', append: { file: 'watched.txt', line: 'seen-1', ask: true }, reply: 'Appended seen-1.' },
      { match: 'TASKHOLD', append: { id: 'toolu_task', file: 'task.txt', line: 'task-1', hangOnce: true, checkNamed: true }, reply: 'Appended task-1.' },
    ],
  }))

  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  c.start('server/api.ts', {
    AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'),
    AGENTS_STREAMS_PORT: String(PORT + 2), AGENTS_STREAMS_DIR: join(home, 'streams'), AGENTS_MACHINE_LOST_SEC: String(LOST_SEC),
  })
  await c.servePeople(PORT + 1, join(home, 'people.sock'))
  await until('the API', 20, async () => fetch(API).then(() => true, () => false))
  const daemonEnv = {
    AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home,
    AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json'),
  }
  const daemon = c.start('daemon/agentsd.ts', daemonEnv)
  await until('the machine online', 20, async () => (await c.row(`select status from instances where name = $1`, [`mac-${id}`]))?.status === 'online')

  const { conversationId } = await say('/v1/conversations', { kind: 'dm', agent: `watcher-${id}` })
  await say(`/v1/conversations/${conversationId}/messages`, { text: 'Do WATCH.' })
  const { id: sessionId } = await c.row('select id from sessions where conversation_id = $1', [conversationId])
  const openAsk = () => c.row(`select id from asks where session_id = $1 and status = 'open'`, [sessionId])
  await until('the ask', 60, openAsk)
  const ask = await openAsk()
  const { taskId, sessionId: taskSessionId } = await say('/v1/tasks', { title: 'Hold a task', instructions: 'Do TASKHOLD.', agentId })
  taskFolder = join(home, 'workspaces', (await c.row('select workspace_id from sessions where id = $1', [taskSessionId])).workspace_id)
  await until('the task call in the record', 60, async () =>
    (await c.count(`select count(*) from events where session_id = $1 and kind = 'tool_call' and tool_use_id = 'toolu_task'`, [taskSessionId])) === 1)
  live = liveClient(PEOPLE, login, conversationId, sessionId)
  browser = await chromium.launch()
  const context = await browser.newContext({ baseURL: PEOPLE, extraHTTPHeaders: { 'tailscale-user-login': login } })
  const page = await context.newPage()
  await page.goto(`/#/c/${conversationId}`)
  const taskPage = await context.newPage()
  await taskPage.goto(`/#/t/${taskId}`)
  const taskInterrupted = taskPage.getByTestId('interrupted')
  const card = page.locator('section[aria-label="Needs approval"]')
  const interrupted = page.getByTestId('interrupted')
  c.check(await shows(card.waitFor({ timeout: SHOWN_SEC * 1000 })), 'the app shows the card while the ask waits')
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, live, when: 'while the ask waits' })

  await killMachine(daemon)
  await until('the session to show as lost', LOST_SEC * 3, async () => (await c.row('select status from sessions where id = $1', [sessionId]))?.status === 'lost')
  c.check((await openAsk())?.id === ask.id, 'during the outage the card is still open in the record')
  c.check(await shows(page.getByText('stopped answering').waitFor({ timeout: SHOWN_SEC * 1000 })) && await interrupted.isVisible() && await card.isVisible(),
    'during the outage the app shows the turn as interrupted, with the reason, and the card still open')
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, live, when: 'during the outage' })
  await until('the task session to show as lost', LOST_SEC * 3, async () => (await c.row('select status from sessions where id = $1', [taskSessionId]))?.status === 'lost')
  c.check(await shows(taskPage.getByText('stopped answering').waitFor({ timeout: SHOWN_SEC * 1000 })) && await taskInterrupted.isVisible()
    && await taskPage.getByRole('button', { name: 'Interrupt' }).isVisible(),
  'during the outage the task page shows the turn as interrupted, with the reason and an Interrupt button')

  c.start('daemon/agentsd.ts', daemonEnv)
  await until('the resumed session to ask again', 60, async () =>
    (await c.count(`select count(*) from events where session_id = $1 and kind = 'ask'`, [sessionId])) === 2)
  await page.getByRole('button', { name: 'Allow once' }).click()
  await until('the turn to end', TURN_SECONDS, async () =>
    (await c.count(`select count(*) from events where session_id = $1 and kind = 'usage'`, [sessionId])) >= 1)
  const session = await c.row('select status from sessions where id = $1', [sessionId])
  const answered = await c.row('select status from asks where id = $1', [ask.id])
  const posts = await c.rows('select speaker from messages where conversation_id = $1 order by seq', [conversationId])
  c.check(session.status === 'idle' && answered.status === 'answered' && !(await openAsk()) && posts.map((p) => p.speaker).join() === 'person,agent',
    'after the restart the card the person answered in the app is answered, the session is idle, and the reply is posted')
  c.check(await shows(page.locator('li.message.agent', { hasText: 'Appended seen-1.' }).waitFor({ timeout: SHOWN_SEC * 1000 }))
    && await shows(interrupted.waitFor({ state: 'detached', timeout: SHOWN_SEC * 1000 })) && await shows(card.waitFor({ state: 'detached', timeout: SHOWN_SEC * 1000 })),
  'the app shows the reply, with no card and no interrupted line')
  await clientsMatchRecord(c, { people: PEOPLE, login, conversationId, sessionId, live, when: 'after the restart' })
  await until('the task turn to end', TURN_SECONDS, async () =>
    (await c.count(`select count(*) from events where session_id = $1 and kind = 'usage'`, [taskSessionId])) >= 1)
  c.check(await shows(taskPage.locator('li.message.agent', { hasText: 'task.txt already has task-1' }).waitFor({ timeout: SHOWN_SEC * 1000 }))
    && await shows(taskInterrupted.waitFor({ state: 'detached', timeout: SHOWN_SEC * 1000 })),
  'after the restart the task page shows the reply, with no interrupted line')
  c.check(await taskPage.getByText('This session was resumed').count() === 0 && await taskPage.locator('li.message.person').count() === 1,
    'the task page shows the one request a person made, never the text the resumed session was sent')
} catch (error) {
  c.failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  c.closePeople()
  live?.close()
  await browser?.close()
  for (const child of c.children) child.kill('SIGTERM')
  if (folder) killFakes(folder)
  if (taskFolder) killFakes(taskFolder)
  if (!c.failures.length) {
    await c.db.query('delete from teams where name = $1', [team]).catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
  await c.db.end().catch(() => {})
}

console.log(`\n${c.failures.length ? `${c.failures.length} failed (team ${team} and ${home} kept)` : 'all passed (test team removed)'}`)
process.exit(c.failures.length ? 1 : 0)
