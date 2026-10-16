// Step 26b, the app, for agents working together. Drives Chromium, Firefox and
// WebKit at desktop and phone width against a real API, runner and daemon, with
// the stand-in for Claude calling the team-agents tools. Each engine has its own
// people and agents: Alice asks scout to have writer write a note, asks scout to
// make an agent, and has scout hand writer a task. Their thread lists in the
// sidebar by the two agents' names and reads with no composer. The ask to make an
// agent is its question with a lettered choice for each answer, which Alice alone
// gets, and Bob reads whose choice it waits for. The handed task lists with the
// tasks. The agent page gives Bob, and not Alice, a switch for whether other
// people's agents may message his critic. Then choosing Make makes the agent and
// the switch makes the change. Scans for accessibility problems,
// checks the phone fit, and keeps screenshots in test/ui-shots. Ports 8313 to
// 8315 are its own.
//   node --env-file=.env --env-file=.env.test test/step26b.ts
//   AGENTS_UI_ENGINES=chromium node --env-file=.env --env-file=.env.test test/step26b.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, firefox, webkit, type BrowserType, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import pg from 'pg'
import { asPerson, results, ROOT, startApi, within } from './onboarding-kit.ts'
import { stopAll } from './computers.ts'
import { stopStandIns } from './stand-ins.ts'
import { must } from './must.ts'
import { messageOf } from '../shared/errors.ts'
import { CREATE_AGENT_TOOL } from '../shared/team-agents.ts'

const SHOTS = join(ROOT, 'test', 'ui-shots')
const PORTS = { machines: 8313, people: 8314, streams: 8315 }
const API = `http://127.0.0.1:${PORTS.machines}`
const PEOPLE = `http://127.0.0.1:${PORTS.people}`
// Chromium and Firefox reach the app on a name that is not localhost, as people do
// over the tailnet's plain HTTP, where a page is not a secure one.
const INSECURE = `http://agents.test:${PORTS.people}`
const ORIGINS: Record<string, string> = { chromium: INSECURE, firefox: INSECURE, webkit: PEOPLE }
const LAUNCH: Record<string, Record<string, unknown>> = {
  chromium: { args: ['--host-resolver-rules=MAP agents.test 127.0.0.1'] },
  firefox: { firefoxUserPrefs: { 'network.dns.localDomains': 'agents.test' } },
  webkit: {},
}
const ENGINES: Record<string, BrowserType> = { chromium, webkit, firefox }
const engines = (process.env.AGENTS_UI_ENGINES ?? 'chromium,webkit,firefox').split(',')
const WIDTHS = { desktop: { width: 1280, height: 820 }, phone: { width: 390, height: 844 } } as const
const TURN_SECONDS = 60

const id = randomBytes(4).toString('hex')
const team = `together-26b-${id}`
const admin = `admin26b-${id}@local`
const loginOf = (who: 'alice' | 'bob', engine: string) => `${who}26b-${engine}-${id}@local`

// Each engine's agents are named after it, and so are the words that set them going.
function scenario() {
  return {
    turns: engines.map((e) => ({ match: `Write a note for scout-${e}.`, reply: `Note from writer-${e}: the launch is on Friday.` })),
    calls: engines.flatMap((e) => [
      { match: `Have writer-${e} write a note`, say: `I asked writer-${e}.`, calls: [{ tool: 'mcp__team-agents__send_to_agent', input: { to: `writer-${e}`, text: `Write a note for scout-${e}.` } }] },
      { match: `Make a helper for ${e}`, say: 'Asked.', calls: [{ tool: CREATE_AGENT_TOOL, input: { name: `helper-${e}`, title: 'Helps with drafts', instructions: 'Check every draft for typos.' } }] },
      { match: `Hand writer-${e} the changelog`, say: 'Handed over.', calls: [{
        tool: 'mcp__team-agents__delegate_task', input: { to: `writer-${e}`, title: `Changelog for ${e}`, instructions: 'List the changes.' },
      }] },
    ]),
  }
}

type Scene = { alice: string; bob: string; dm: string; thread: string; threadName: string; task: string; critic: string; ask: string; machine: string }

const { failures, check } = results()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step26b-')))
let stopApi: (() => Promise<void>) | null = null
// What the API printed, for a failed run to show its errors.
let apiLog = () => ''

const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
const post = async (login: string, path: string, body: unknown = {}) => {
  const answer = await asPerson(PEOPLE, login, 'POST', path, body)
  if (answer.status !== 200) throw new Error(`${path} as ${login}: ${answer.status} ${answer.text}`)
  return answer.json
}

async function visible(page: Page, selector: string, seconds: number, text?: RegExp | string): Promise<boolean> {
  const locator = text ? page.locator(selector, { hasText: text }) : page.locator(selector)
  return locator.first().waitFor({ state: 'visible', timeout: seconds * 1000 }).then(() => true, () => false)
}

async function serious(page: Page) {
  const axe = await new AxeBuilder({ page }).analyze()
  const found = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  for (const v of found) console.log(`      ${v.id}: ${v.help} (${v.nodes.length}) ${JSON.stringify(v.nodes[0]?.target)}`)
  return found.length
}

async function noSideScroll(page: Page, selectors: string[]) {
  return page.evaluate((list) => document.documentElement.scrollWidth <= window.innerWidth
    && list.every((selector) => {
      const el = document.querySelector(selector)
      return !el || el.getBoundingClientRect().right <= window.innerWidth + 1
    }), selectors)
}

// One engine's people, agents and work: a thread between scout and writer with
// writer's answer in it, an ask to make an agent waiting in Alice's DM, a task
// scout handed writer, and Bob's critic.
async function scene(engine: string, macId: string, teamId: string): Promise<Scene> {
  const [alice, bob] = [loginOf('alice', engine), loginOf('bob', engine)]
  const make = async (login: string, name: string) => String((await post(login, '/v1/agents', { name, homeInstanceId: macId })).agentId)
  const scout = await make(alice, `scout-${engine}`)
  await make(alice, `writer-${engine}`)
  const critic = await make(bob, `critic-${engine}`)
  const { conversationId: dm } = await post(alice, '/v1/conversations', { kind: 'dm', agent: `scout-${engine}` })
  const say = async (text: string, done: () => Promise<unknown>) => {
    await post(alice, `/v1/conversations/${dm}/messages`, { text })
    if (!(await within(TURN_SECONDS, done))) throw new Error(`${engine}: nothing came of "${text}"`)
  }
  await say(`Have writer-${engine} write a note.`, async () => (await one(`select count(*)::int as n from messages m join conversations c on c.id = m.conversation_id
    where c.kind = 'agents' and m.body like $1 and c.team_id = $2`, [`Note from writer-${engine}%`, teamId]))?.n === 1)
  await say(`Hand writer-${engine} the changelog.`, () => one(`select id from tasks where title = $1 and team_id = $2`, [`Changelog for ${engine}`, teamId]))
  await say(`Make a helper for ${engine}.`, () => one(`select a.id from asks a join sessions s on s.id = a.session_id where s.agent_id = $1 and a.status = 'open'`, [scout]))
  const thread = must(await one(`select m.conversation_id as id from messages m join conversations c on c.id = m.conversation_id
    where c.kind = 'agents' and m.body like $1 and c.team_id = $2`, [`Note from writer-${engine}%`, teamId]), 'the thread').id
  const task = must(await one(`select id from tasks where title = $1 and team_id = $2`, [`Changelog for ${engine}`, teamId]), 'the task').id
  const ask = must(await one(`select a.id from asks a join sessions s on s.id = a.session_id where s.agent_id = $1 and a.status = 'open'`, [scout]), 'the ask').id
  return { alice, bob, dm: String(dm), thread: String(thread), threadName: `scout-${engine} and writer-${engine}`, task: String(task), critic, ask: String(ask), machine: `mac-${id}` }
}

async function run(engine: string, s: Scene, teamId: string) {
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const errors: string[] = []
  const open = async (login: string, width: keyof typeof WIDTHS, hash: string) => {
    const phone = width === 'phone'
    const context = await browser.newContext({
      baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': login }, viewport: WIDTHS[width],
      ...(phone ? { isMobile: engine !== 'firefox', hasTouch: engine !== 'firefox' } : {}),
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/#/${hash}`)
    return page
  }
  const shot = (page: Page, name: string, width: string) => page.screenshot({ path: join(SHOTS, `${engine}-${width}-${name}.png`) })
  try {
    for (const width of ['desktop', 'phone'] as const) {
      // The thread lists in the sidebar by the two agents' names, and opens from there.
      const sidebar = await open(s.alice, width, '')
      if (width === 'phone') await sidebar.getByRole('button', { name: 'Menu' }).click()
      const listed = sidebar.getByRole('list', { name: 'Conversations' }).getByRole('button', { name: s.threadName })
      check(await listed.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false), `${engine} ${width}: the sidebar lists the thread as "${s.threadName}"`)
      check(await sidebar.getByRole('list', { name: 'Tasks' }).getByRole('button', { name: `Changelog for ${engine}` }).waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false),
        `${engine} ${width}: the task scout handed writer lists with the tasks`)
      await listed.click()
      const thread = sidebar
      check(await visible(thread, '.conversation-head h1', 20, s.threadName) && await visible(thread, '.conversation-head', 5, 'Between two agents'),
        `${engine} ${width}: the thread opens, named for its two agents, between two agents`)
      check(await visible(thread, '.message.agent', 20, `Write a note for scout-${engine}.`) && await visible(thread, '.message.agent', 5, `Note from writer-${engine}`),
        `${engine} ${width}: the thread shows scout's message and writer's answer`)
      check(await visible(thread, '.thread-note', 5, 'Only the two agents write here') && await thread.locator('#composer-text').count() === 0,
        `${engine} ${width}: the thread has no composer, and says only the agents write there`)
      await shot(thread, 'thread', width)
      if (width === 'phone') check(await noSideScroll(thread, ['.conversation-head', '.messages', '.thread-note']), `${engine} phone: the thread fits without sideways scrolling`)
      if (width === 'desktop') check(await serious(thread) === 0, `${engine} desktop: the thread has no serious accessibility problems`)

      // The ask to make an agent: its question, and a lettered choice for each answer, for Alice, whose agent asked.
      const owner = await open(s.alice, width, `c/${s.dm}`)
      const card = owner.getByRole('region', { name: 'Asks to make an agent' })
      check(await card.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false)
        && await card.getByText(`scout-${engine} asks to make a new agent, helper-${engine}. It would be ${s.alice}'s, on ${s.machine}.`).isVisible()
        && await card.getByText('Check every draft for typos.').isVisible(),
      `${engine} ${width}: Alice's DM shows scout's ask to make helper-${engine} as a question, with its instructions`)
      const choices = card.getByRole('list', { name: 'Choices' })
      check(await choices.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false)
        && JSON.stringify(await choices.locator('.choice-letter').allInnerTexts()) === JSON.stringify(['A', 'B'])
        && JSON.stringify(await choices.getByRole('button').evaluateAll((buttons) => buttons.map((b) => b.textContent))) === JSON.stringify([`AMake helper-${engine}`, `BDon't make helper-${engine}`])
        && await choices.getByRole('button', { name: `Make helper-${engine}`, exact: true }).isVisible(),
      `${engine} ${width}: the ask offers Alice a lettered choice for each answer`)
      await shot(owner, 'ask-owner', width)
      if (width === 'phone') check(await noSideScroll(owner, ['.conversation-head', '.messages', '.ask-card', '.composer']), `${engine} phone: the ask fits without sideways scrolling`)
      if (width === 'desktop') check(await serious(owner) === 0, `${engine} desktop: the DM with the ask has no serious accessibility problems`)

      // Bob reads whose choice it waits for, and gets no choices.
      const teammate = await open(s.bob, width, `c/${s.dm}`)
      const theirs = teammate.getByRole('region', { name: 'Asks to make an agent' })
      check(await theirs.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false)
        && await visible(teammate, '.ask-card', 20, `Waiting for ${s.alice} to choose.`) && await theirs.getByRole('button').count() === 0,
      `${engine} ${width}: Bob reads that the ask waits for Alice, with no button to answer it`)
      await shot(teammate, 'ask-teammate', width)

      // Bob decides whether other people's agents may message his critic, and Alice reads it.
      const bobsPage = await open(s.bob, width, `a/${s.critic}`)
      const toggle = bobsPage.getByRole('switch', { name: "Other people's agents" })
      check(await toggle.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false) && await toggle.getAttribute('aria-checked') === 'false'
        && await visible(bobsPage, 'section[aria-label="Other agents"]', 5, `Only ${s.bob}'s own agents may message critic-${engine}`),
      `${engine} ${width}: Bob's critic page gives him a switch for other people's agents, off at first`)
      await shot(bobsPage, 'accepts-owner', width)
      if (width === 'phone') check(await noSideScroll(bobsPage, ['.page-head', '.page-body']), `${engine} phone: the agent page fits without sideways scrolling`)
      if (width === 'desktop') check(await serious(bobsPage) === 0, `${engine} desktop: the agent page has no serious accessibility problems`)
      const alicesView = await open(s.alice, width, `a/${s.critic}`)
      check(await visible(alicesView, 'section[aria-label="Other agents"]', 20, `Only ${s.bob}'s own agents may message critic-${engine}`)
        && await alicesView.getByRole('switch').count() === 0,
      `${engine} ${width}: Alice reads that only Bob's agents may message his critic, with nothing to change`)
      await shot(alicesView, 'accepts-teammate', width)
    }

    // Choosing Make makes the agent, and the card goes.
    const owner = await open(s.alice, 'desktop', `c/${s.dm}`)
    await owner.getByRole('region', { name: 'Asks to make an agent' }).getByRole('button', { name: `Make helper-${engine}`, exact: true }).click()
    const made = await within(TURN_SECONDS, () => one(`select owner_id from agents where name = $1 and team_id = $2`, [`helper-${engine}`, teamId]))
    check(made && await owner.getByRole('region', { name: 'Asks to make an agent' }).waitFor({ state: 'detached', timeout: 20_000 }).then(() => true, () => false),
      `${engine}: choosing Make makes helper-${engine}, and the ask leaves the DM`)
    // The switch lets other people's agents in, in the record.
    const bobsPage = await open(s.bob, 'desktop', `a/${s.critic}`)
    const toggle = bobsPage.getByRole('switch', { name: "Other people's agents" })
    await toggle.click()
    check(await within(10, async () => (await one('select accepts_agents from agents where id = $1', [s.critic]))?.accepts_agents === 'team')
      && await toggle.getAttribute('aria-checked') === 'true' && await visible(bobsPage, 'section[aria-label="Other agents"]', 5, `Any agent on the team may message critic-${engine}`),
    `${engine}: Bob's switch lets other people's agents message critic-${engine}`)
    check(errors.length === 0, `${engine}: no page errors${errors.length ? ` (${errors.join('; ')})` : ''}`)
  } finally {
    await browser.close()
  }
}

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  mkdirSync(SHOTS, { recursive: true })
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, admin)
  for (const engine of engines) {
    node('server/admin.ts', 'add-person', team, loginOf('alice', engine))
    node('server/admin.ts', 'add-person', team, loginOf('bob', engine))
  }
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', admin))
  const macId = String(must(await one('select id from instances where name = $1', [`mac-${id}`]), 'the Mac').id)
  const teamId = String(must(await one('select id from teams where name = $1', [team]), 'the team').id)
  writeFileSync(join(home, 'scenario.json'), JSON.stringify(scenario()))
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  const api = await startApi(PORTS, { AGENTS_RUNNER_TEAMS: team }, join(home, 'streams'))
  stopApi = api.stop
  apiLog = api.text
  await within(20, () => fetch(`${API}/v1/health`).then((res) => res.ok, () => false))
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home, AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude-agents.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json') },
  }))
  const scenes = new Map<string, Scene>()
  for (const engine of engines) scenes.set(engine, await scene(engine, macId, teamId))
  for (const engine of engines) await run(engine, must(scenes.get(engine), engine), teamId)
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : messageOf(error)}`)
} finally {
  await stopAll(children)
  await stopApi?.()
  // The daemon leaves a busy session's stand-in behind, such as one still asking to make an agent.
  stopStandIns(home)
  if (failures.length) console.log(`\nthe API's errors:\n${apiLog().split('\n').filter((line) => /error|deadlock|at /i.test(line)).slice(0, 40).join('\n')}`)
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
    rmSync(home, { recursive: true, force: true })
  }
  await db.end().catch(() => undefined)
}

console.log(`\nscreenshots in test/ui-shots\n${failures.length ? `${failures.length} failed (team ${team} kept, files in ${home})` : 'all passed (test team removed)'}`)
process.exit(failures.length ? 1 : 0)
