// Fit design step 16, secrets set from the app. A plugin names a secret and the
// agent's computer holds its value. A person sets the value from the app and
// never pastes it onto a machine. This runs a real API, a real daemon and
// Postgres, with the stand-in for Claude and a stand-in plugin, and a pass-through
// in front of the API that keeps every request it receives.
//
// A plugin with no value stops its agent. The owner sets one, the computer writes
// it to secrets.json with mode 600, and the agent's next message starts with the
// plugin, which gets the value. The value is in exactly one request the API
// received, the one that set it, and in the one frame the API sent on, and in no
// table, answer, log or file but the computer's secrets file and the config that
// starts the plugin. Setting it again replaces it, and an agent in the middle of
// a turn restarts with its next message. A value removed from the app is gone
// from the computer. A computer that is not running is asked to start, and the
// request waits for it: one that comes up in time gets the value, and one that
// does not ends in a refusal that names it. An unreadable or unwritable secrets
// file, a reserved name, a name the daemon's environment already sets and a teammate's
// computer each refuse and store nothing. A value set as a computer connects survives the
// record's comparison with what the computer says it holds.
// An agent that repeats a value is scrubbed at once, a removed value too.
//   node --env-file=.env --env-file=.env.test test/step25.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import pg from 'pg'
import WebSocket, { WebSocketServer } from 'ws'
import { z } from 'zod'
import { LINK_ANSWER_MS, LINK_PATH, LINK_UNSUPPORTED, LINK_WAIT_MS, ToDaemon, type FromDaemon } from '../shared/link.ts'
import { messageOf } from '../shared/errors.ts'
import { parseJson } from '../shared/json.ts'
import { bytesOf } from '../shared/websocket.ts'
import { boxContainer } from '../shared/boxes.ts'
import { asPerson, foundInDatabase, results, ROOT, shapeRows, startApi, within } from './onboarding-kit.ts'
import { must } from './must.ts'
import { tap, type Heard, type Tap } from './wiretap.ts'

// Ports 8160 to 8165 are this check's: machines, people and streams, a
// pass-through in front of each of the first two, and a stand-in for the API.
const PORTS = { machines: 8160, people: 8161, streams: 8162 }
const MACHINES_TAP = 8163
const PEOPLE_TAP = 8164
const STAND_IN = 8165
const PEOPLE = `http://127.0.0.1:${String(PEOPLE_TAP)}`
const THROUGH_TAP = `http://127.0.0.1:${String(MACHINES_TAP)}`
const FAKE_PLUGIN = join(ROOT, 'test', 'fake-plugin.ts')

const id = randomBytes(4).toString('hex')
const team = `secrets25-${id}`
const otherTeam = `secrets25x-${id}`
const [alice, bob, mallory] = [`alice25-${id}@local`, `bob25-${id}@local`, `mallory25-${id}@local`]
const computer = { a: `mac-a-${id}`, b: `mac-b-${id}`, c: `mac-c-${id}`, box: `box-a-${id}` }

// Values a person sets, one for each time. The second holds a quote, a backslash
// and a letter outside ASCII, so it is stored and found in the form JSON writes it.
const rand = () => randomBytes(12).toString('hex')
const value = {
  first: `first25-${rand()}`, second: `second"25\\${rand()}é`, third: `third25-${rand()}`, fourth: `fourth25-${rand()}`,
  fifth: `fifth25-${rand()}`, sixth: `sixth25-${rand()}`, seventh: `seventh25-${rand()}`, eighth: `eighth25-${rand()}`,
  carl: `carl25-${rand()}`, shadowed: `shadowed25-${rand()}`, ninth: `ninth25-${rand()}`, box: `box25-${rand()}`,
}
const SENT = Object.values(value)
// Seconds the API waits for a computer that is not running, where it waits 90 for a person. Long enough for a daemon to start.
const WAKE_SEC = 8
// What the daemon's environment holds under ENV_HELD_TOKEN, which a value set from the app could never replace.
const ENV_HELD = `held-by-the-environment25-${rand()}`
const BAD_MARK = `badframe25-${rand()}`
const CORRUPT_MARK = `corrupt25-${rand()}`
const HAND_PLACED = `by-hand25-${rand()}`

const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step25-')))
const homes = { a: join(home, 'computer-a'), stand: join(home, 'computer-stand'), box: join(home, 'computer-box') }
// The stand-in for Docker that the API's runner calls, what it was asked, and the box containers it has.
const dockerBin = join(home, 'docker-bin')
const dockerLog = join(home, 'docker.log')
const dockerState = join(home, 'docker-state')
const dockerCalls = () => (existsSync(dockerLog) ? readFileSync(dockerLog, 'utf8').split('\n').filter((line) => line !== '') : [])
const streamsDir = join(home, 'streams')

const { failures, check } = results()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const closers: (() => Promise<void>)[] = []
// What the API and the daemons printed, for the end of a run that failed.
const logs: { name: string; text: () => string }[] = []
const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
const all = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows
// A value read from a row or an answer, as the text it must be.
const stringOf = (value: unknown): string => z.string().parse(value)

// The node running this check comes first on the PATH, so the stand-in for Claude
// (which starts with `env node`) runs on it and not on whatever else the PATH holds.
const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ ...process.env, PATH: `${dirname(process.execPath)}:${must(process.env.PATH, 'a PATH')}`, ...extra })
const admin = (...args: string[]) => execFileSync(process.execPath, ['server/admin.ts', ...args], { cwd: ROOT, env: env({}), encoding: 'utf8' })
const Token = z.object({ token: z.string() })

// A value as it may be read in a file or a body: itself, and as JSON writes it.
const forms = (text: string) => [...new Set([text, JSON.stringify(text).slice(1, -1)])]
const holds = (text: string, wanted: string) => forms(wanted).some((form) => text.includes(form))
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

// A daemon on a computer, with what it printed kept. Its Claude is the stand-in
// that holds a message asking it to work slowly.
type Daemon = { text: () => string; stop: () => Promise<void> }
function startDaemon(token: string, agentsHome: string, api: string, scenario: string, extra: Record<string, string> = {}): Daemon {
  const log: string[] = []
  const child = spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: env({ AGENTS_API: api, AGENTS_TOKEN: token, AGENTS_HOME: agentsHome, AGENTS_CLAUDE_BIN: join(ROOT, 'test', 'fake-claude-slow.ts'), AGENTS_FAKE_SCENARIO: scenario, ...extra }),
  })
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', (text: string) => { log.push(text) })
  const exited = new Promise<void>((resolve) => child.once('exit', () => { resolve() }))
  children.push(child)
  logs.push({ name: `a daemon on ${agentsHome.split('/').pop() ?? agentsHome}`, text: () => log.join('') })
  return {
    text: () => log.join(''),
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await Promise.race([exited, sleep(15_000)])
    },
  }
}

// Every file under a folder that holds the value, by path inside it.
function filesHolding(dir: string, wanted: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => holds(readFileSync(file, 'utf8'), wanted))
    .map((file) => relative(dir, file))
    .sort()
}

// The text of what the API received or sent, in the places a value could be.
function textsOf(heard: Heard): { where: string; text: string }[] {
  switch (heard.kind) {
    case 'request': return [
      { where: 'address', text: heard.url },
      { where: 'headers', text: Object.entries(heard.headers).map(([name, header]) => `${name}: ${Array.isArray(header) ? header.join(', ') : header ?? ''}`).join('\n') },
      { where: 'body', text: heard.body },
    ]
    case 'upgrade': return [{ where: 'address', text: heard.url }, { where: 'headers', text: JSON.stringify(heard.headers) }]
    case 'response': return [{ where: 'answer', text: heard.body }]
    case 'client-message': return [{ where: 'message', text: heard.text }]
    case 'server-bytes': return [{ where: 'bytes', text: heard.text }]
  }
}

// Opens a WebSocket to the API's control path and says how it went: the status
// of a refused upgrade, or null when it opened.
function probe(headers: Record<string, string>): Promise<{ ws: WebSocket; refusedWith: number | null }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(PORTS.machines)}${LINK_PATH}`, { headers })
    ws.once('open', () => { resolve({ ws, refusedWith: null }) })
    ws.once('unexpected-response', (_request, response) => { resolve({ ws, refusedWith: response.statusCode ?? 0 }); response.resume() })
    ws.once('error', () => undefined)
  })
}
// Whether a process is still running.
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: no such process.
    return false
  }
}
// The process id the daemon keeps for a session's harness while it runs.
const harnessPid = (agentsHome: string, session: string) => Number(readFileSync(join(agentsHome, 'sessions', `${session}.pid`), 'utf8'))

// When a WebSocket has closed, with the code it closed with. One that has closed already gives 0, since its code is gone.
const closedWith = (ws: WebSocket) => new Promise<number>((resolve) => {
  if (ws.readyState === WebSocket.CLOSED) resolve(0)
  else ws.once('close', (code) => { resolve(code) })
})
// Waits for a promise for at most `seconds`, and gives `otherwise` if it does not settle by then.
const boundedBy = async <T>(promise: Promise<T>, seconds: number, otherwise: T): Promise<T> => Promise.race([promise, sleep(seconds * 1000).then(() => otherwise)])

async function main() {
  const people = await tap(PEOPLE_TAP, { port: PORTS.people })
  closers.push(people.close)
  let machines: Tap = await tap(MACHINES_TAP, { port: PORTS.machines })
  const machineTaps = [machines]
  closers.push(() => machines.close())
  const heardAll = () => [...machineTaps.flatMap((t) => t.heard), ...people.heard]
  // The requests and answers that carry a value, with where in each it sits.
  const carrying = (wanted: string) => heardAll().flatMap((heard) => textsOf(heard).filter((part) => holds(part.text, wanted)).map((part) => ({ heard, where: part.where })))
  const ask = (who: string, method: string, path: string, body?: unknown) => asPerson(PEOPLE, who, method, path, body)

  await db.connect()
  db.on('error', (error) => { failures.push(`Postgres dropped the check's connection: ${error.message}`) })
  // The runner runs for this team, so a person's own box asleep can be started, and its Docker is the stand-in.
  mkdirSync(dockerBin, { recursive: true })
  writeFileSync(join(dockerBin, 'docker'), `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'test', 'fake-box-docker.ts')}" "$@"\n`, { mode: 0o755 })
  writeFileSync(dockerState, '')
  const api = await startApi(PORTS, {
    AGENTS_RUNNER: 'on', AGENTS_RUNNER_TEAMS: team, AGENTS_SECRET_WAKE_SEC: String(WAKE_SEC),
    PATH: `${dockerBin}:${must(process.env.PATH, 'a PATH')}`, STEP25_DOCKER_LOG: dockerLog, STEP25_DOCKER_STATE: dockerState,
  }, streamsDir)
  closers.push(api.stop)
  logs.push({ name: 'the API', text: api.text })

  admin('add-team', team, alice)
  admin('add-person', team, bob)
  admin('add-team', otherTeam, mallory)
  const macA = Token.parse(JSON.parse(admin('add-instance', team, computer.a, 'mac', alice)))
  Token.parse(JSON.parse(admin('add-instance', team, computer.b, 'mac', bob)))
  const macC = Token.parse(JSON.parse(admin('add-instance', team, computer.c, 'mac', alice)))
  const agentOn = (name: string, on: string) => z.object({ agentId: z.string() }).parse(JSON.parse(admin('add-agent', team, name, on, '', 'You help.'))).agentId
  const scout = agentOn('scout', computer.a)
  agentOn('writer', computer.a)
  const odd = agentOn('odd', computer.a)
  const bobby = agentOn('bobby', computer.b)
  const carl = agentOn('carl', computer.c)
  const instanceA = stringOf(must(await one('select id from instances where name = $1', [computer.a]), 'the first computer').id)
  const instanceC = stringOf(must(await one('select id from instances where name = $1', [computer.c]), 'the third computer').id)
  const teamId = stringOf(must(await one('select id from teams where name = $1', [team]), 'the team').id)
  const personId = async (login: string) => stringOf(must(await one('select id from people where login = $1', [login]), login).id)

  // The stand-in for Claude repeats a value when asked for it.
  const scenario = join(home, 'scenario.json')
  writeFileSync(scenario, JSON.stringify({ turns: [{ match: 'What is the token?', reply: value.first }, { match: 'What is the new token?', reply: value.second }] }))
  mkdirSync(homes.a, { recursive: true })
  const secretsFile = join(homes.a, 'secrets.json')
  // A secrets file a person made by hand, readable by others, to see it kept and tightened.
  writeFileSync(secretsFile, JSON.stringify({ HAND_PLACED }), { mode: 0o644 })
  chmodSync(secretsFile, 0o644)
  if (!await within(30, () => fetch(PEOPLE).then(() => true, () => false))) throw new Error('the API did not start')
  check(true, 'the API starts, and the app reaches it through the pass-through')

  const linkUp = (tapped: Tap, from: number) => within(40, async () => tapped.heard.slice(from).some((h) => h.kind === 'server-bytes' && h.url === LINK_PATH && h.text.startsWith('HTTP/1.1 101')))
  const daemons = [startDaemon(macA.token, homes.a, THROUGH_TAP, scenario, { ENV_HELD_TOKEN: ENV_HELD })]
  const opened = await linkUp(machines, 0) && await within(20, async () => (await one('select status from instances where id = $1', [instanceA]))?.status === 'online')
  check(opened, "the computer's daemon starts, reports in, and opens its control connection to the API")
  if (!opened) throw new Error('the daemon never opened its control connection, so nothing after it can run')

  // A plugin that needs a secret, on an agent whose computer has no value for it.
  const pluginOf = (name: string, secret: string) => ({ name, kind: 'stdio', config: { command: process.execPath, args: [FAKE_PLUGIN], env: { TOKEN: { secret } } } })
  check((await ask(alice, 'POST', `/v1/agents/${scout}/plugins`, pluginOf('sentry', 'SENTRY_TOKEN'))).status === 200, "a plugin that needs SENTRY_TOKEN is added to scout from the agent's page")
  // A row reaches the app's shape a moment after it is written.
  const secretIdOf = async (who: string, agent: string, name: string) => {
    let found: { id: string } | undefined
    await within(20, async () => {
      found = (await shapeRows(PEOPLE, who, 'secrets')).rows.find((row) => row.agent_id === agent && row.name === name)
      return found
    })
    return must(found, `${name}'s row`).id
  }
  const secretId = await secretIdOf(alice, scout, 'SENTRY_TOKEN')
  const dm = async (agent: string, who = alice) => stringOf((await ask(who, 'POST', '/v1/conversations', { kind: 'dm', agent })).json.conversationId)
  const say = async (conversation: string, text: string, who = alice) => {
    const sent = await ask(who, 'POST', `/v1/conversations/${conversation}/messages`, { text })
    if (sent.status !== 200) throw new Error(`could not say "${text}": ${String(sent.status)} ${sent.text}`)
  }
  const replies = async (conversation: string): Promise<string[]> =>
    (await all(`select body from messages where conversation_id = $1 and speaker = 'agent' order by seq`, [conversation])).map((row) => stringOf(row.body))
  const errors = async (conversation: string): Promise<string[]> => (await all(
    `select e.text from events e join sessions s on s.id = e.session_id where s.conversation_id = $1 and e.kind = 'error' order by e.seq`, [conversation])).map((row) => stringOf(row.text))
  // Says something to an agent and returns its next reply, or null if none comes.
  const exchange = async (conversation: string, text: string): Promise<string | null> => {
    const before = (await replies(conversation)).length
    await say(conversation, text)
    const got: string[] = []
    await within(40, async () => {
      const reply = (await replies(conversation))[before]
      if (reply !== undefined) got.push(reply)
      return reply !== undefined
    })
    return got[0] ?? null
  }
  // Says something to an agent whose plugin lacks its value, and waits for one more stop that names the secret.
  const stops = async (conversation: string, text: string, secret: string) => {
    const count = async () => (await errors(conversation)).filter((error) => error.includes(`no value for ${secret}`)).length
    const before = await count()
    await say(conversation, text)
    return within(40, async () => await count() === before + 1)
  }
  const scoutDm = await dm('scout')
  const writerDm = await dm('writer')

  // The writer's session starts before any value is set, so a value set later has to reach a session already running.
  check(await exchange(writerDm, 'hello writer') === 'fake reply', 'another agent on the computer starts its session')
  check(await stops(scoutDm, 'hello scout', 'SENTRY_TOKEN'), 'before a value is set, scout stops and says which secret its computer lacks')
  check((await errors(scoutDm)).some((text) => text.includes("on the agent's page in the app")), "and the message says to set it from the agent's page in the app")
  check(!('SENTRY_TOKEN' in JSON.parse(readFileSync(secretsFile, 'utf8'))), "the computer's secrets file holds no SENTRY_TOKEN yet")

  // The agent's keys, from its plugins' declared names, before and after a value is set.
  const keysBefore = await ask(alice, 'GET', `/v1/agents/${scout}/keys`)
  const missingKey = keysBefore.json.keys?.[0]
  check(keysBefore.status === 200 && keysBefore.json.keys.length === 1 && missingKey.name === 'SENTRY_TOKEN' && missingKey.state === 'missing' && missingKey.plugins.join() === 'sentry' && missingKey.secretId === secretId && keysBefore.json.missing === 1 && keysBefore.json.computer === computer.a,
    `the agent's keys list SENTRY_TOKEN as missing, with the plugin that uses it and a count of 1 missing (${keysBefore.text.slice(0, 160)})`)
  const summaryBefore = await ask(alice, 'GET', '/v1/keys')
  check(summaryBefore.status === 200 && summaryBefore.json.agents.some((a: { agentId: string; total: number; missing: number }) => a.agentId === scout && a.total === 1 && a.missing === 1), 'the team summary says scout has 1 key and 1 missing')

  // Setting a value from the app.
  const valueRoute = `/v1/secrets/${secretId}/value`
  const removeRoute = `/v1/secrets/${secretId}/remove`
  const setRowOf = (instance: string, name = 'SENTRY_TOKEN') => one('select set_by, set_at::text as set_at from secret_sets where name = $1 and instance_id = $2', [name, instance])
  const set = await ask(alice, 'POST', valueRoute, { value: value.first })
  check(set.status === 200 && set.json.name === 'SENTRY_TOKEN' && set.json.computer === computer.a && Object.keys(set.json).sort().join() === 'computer,name,setAt' && !holds(set.text, value.first),
    `the owner sets SENTRY_TOKEN from the app, and the answer holds its name, the computer and the time, never the value (${String(set.status)} ${set.text.slice(0, 120)})`)
  const stored = JSON.parse(readFileSync(secretsFile, 'utf8'))
  check(stored.SENTRY_TOKEN === value.first && stored.HAND_PLACED === HAND_PLACED, "the computer's secrets.json holds the value, and the one a person put there by hand")
  const mode = statSync(secretsFile).mode & 0o777
  check(mode === 0o600, `secrets.json is readable by its owner alone, though the hand-made file was not (mode ${mode.toString(8)})`)
  check(readdirSync(homes.a).every((name) => !name.endsWith('.tmp')), 'the write left no temporary file behind')
  const setRow = await setRowOf(instanceA)
  check(setRow?.set_by === await personId(alice) && Date.now() - new Date(setRow.set_at).getTime() < 60_000, 'the record says who set it on that computer, and when')
  const bobSees = await within(20, async () => (await shapeRows(PEOPLE, bob, 'secret_sets')).rows.some((row) => row.name === 'SENTRY_TOKEN' && row.instance_id === instanceA))
  check(bobSees && !holds(JSON.stringify((await shapeRows(PEOPLE, bob, 'secret_sets')).rows), value.first), 'a teammate sees the name, the computer and the time, and nothing of the value')
  const keysAfter = await ask(alice, 'GET', `/v1/agents/${scout}/keys`)
  check(keysAfter.status === 200 && keysAfter.json.keys[0].state === 'set' && typeof keysAfter.json.keys[0].setAt === 'string' && typeof keysAfter.json.keys[0].setBy === 'string' && keysAfter.json.missing === 0 && !holds(keysAfter.text, value.first),
    `once set, the agent's keys list SENTRY_TOKEN as set, with when and by whom, 0 missing, and never the value (${keysAfter.text.slice(0, 160)})`)

  // The other agent, already running, repeats the value, and it is scrubbed at once. No session has started since
  // the value was set, so only the daemon learning the value when it arrives can scrub it.
  const writerReply = await exchange(writerDm, 'What is the token?') ?? ''
  check(writerReply.includes('[secret:SENTRY_TOKEN]') && !holds(writerReply, value.first),
    `an agent that repeats the value has it replaced by its name, though its session began before the value was set (${writerReply})`)

  // The agent's next message starts with the plugin, which gets the value.
  const scoutReplied = await exchange(scoutDm, 'hello again') === 'fake reply'
  const scoutSession = stringOf((await one('select id from sessions where conversation_id = $1 and agent_id = $2 order by created_at desc limit 1', [scoutDm, scout])).id)
  const McpConfig = z.object({ mcpServers: z.record(z.string(), z.looseObject({ command: z.string().optional(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() })) })
  const configFile = `sessions/${scoutSession}.mcp.json`
  const startsOf = (agent: string) => readFileSync(join(homes.a, 'agents', agent, '.fake', 'starts.jsonl'), 'utf8').trim().split('\n')
    .map((line) => z.object({ mcpServers: z.array(z.string()) }).parse(JSON.parse(line)))
  check(scoutReplied && startsOf(scout).some((start) => start.mcpServers.includes('sentry')), "after the value is set, scout's next message starts its session with the sentry plugin")
  // A plugin is started from its config as Claude starts it, and answers with the hash of what it got.
  async function pluginSees(variable: string): Promise<string> {
    const entry = must(McpConfig.parse(JSON.parse(readFileSync(join(homes.a, configFile), 'utf8'))).mcpServers.sentry, "the sentry plugin's entry")
    const client = new Client({ name: 'step25', version: '1.0.0' })
    await client.connect(new StdioClientTransport({ command: must(entry.command, 'a command'), args: entry.args ?? [], env: entry.env ?? {} }))
    const answer = z.object({ content: z.array(z.object({ text: z.string() })) }).parse(await client.callTool({ name: 'fingerprint', arguments: { variable } }))
    await client.close()
    return must(answer.content[0], 'the plugin answer').text
  }
  check(await pluginSees('TOKEN') === sha(value.first), 'the plugin, started from the config the daemon wrote, gets the value as its TOKEN variable')

  // The value is in one request, in the one frame the API sent on, and in no table, answer, log or file but the two the computer needs.
  const first = carrying(value.first)
  const [setting, relayed] = [first.filter((c) => c.heard.kind === 'request'), first.filter((c) => c.heard.kind === 'server-bytes')]
  check(first.length === 2 && setting[0]?.heard.kind === 'request' && setting[0].heard.method === 'POST' && setting[0].heard.url === valueRoute && setting[0].where === 'body',
    `the value is in one request the API received, the one that set it, and in its body only (${first.map((c) => `${c.heard.kind} ${c.where}`).join(', ')})`)
  check(relayed.length === 1 && relayed[0]?.heard.kind === 'server-bytes' && relayed[0].heard.url === LINK_PATH && relayed[0].heard.text.includes('"secret_put"'),
    "and in one thing the API sent, the secret_put frame on the computer's own control connection")
  const everywhere = async (wanted: string) => {
    const places = new Set<string>()
    for (const form of forms(wanted)) for (const column of await foundInDatabase(db, form)) places.add(`Postgres ${column}`)
    for (const log of logs) if (holds(log.text(), wanted)) places.add(`the log of ${log.name}`)
    for (const file of filesHolding(streamsDir, wanted)) places.add(`the API's streams folder, ${file}`)
    return [...places]
  }
  const firstPlaces = await everywhere(value.first)
  check(firstPlaces.length === 0, `the value is in no Postgres column, no API or daemon log and no file of the API${firstPlaces.length ? ` (found in ${firstPlaces.join(', ')})` : ''}`)
  const onComputer = filesHolding(homes.a, value.first)
  check(onComputer.join() === ['secrets.json', configFile].sort().join(),
    `on the computer the value is in its secrets file and the config that starts the plugin, and no other file (${onComputer.join(', ')})`)
  check(daemons[0]?.text().includes('secret SENTRY_TOKEN stored') === true, 'the daemon logs the name it stored')

  // A teammate, a stranger and values that cannot be set.
  const bobTries = await ask(bob, 'POST', valueRoute, { value: value.third })
  check(bobTries.status === 403 && /teammate's own computer/.test(bobTries.json.error) && !holds(bobTries.text, value.third), `a teammate cannot set a value on someone else's computer (${String(bobTries.status)})`)
  const bobRemoves = await ask(bob, 'POST', removeRoute)
  check(bobRemoves.status === 403, `nor remove one (${String(bobRemoves.status)})`)
  const strangerSets = await ask(mallory, 'POST', valueRoute, { value: value.third })
  const strangerRemoves = await ask(mallory, 'POST', removeRoute)
  check(strangerSets.status === 404 && strangerRemoves.status === 404, `a person from another team finds no such secret (${String(strangerSets.status)} ${String(strangerRemoves.status)})`)
  const tooShort = await ask(alice, 'POST', valueRoute, { value: 'short' })
  const tooLong = await ask(alice, 'POST', valueRoute, { value: 'x'.repeat(4097) })
  const withNul = await ask(alice, 'POST', valueRoute, { value: `has${String.fromCharCode(0)}nul-value` })
  const notText = await ask(alice, 'POST', valueRoute, { value: 12345678 })
  check([tooShort, tooLong, withNul, notText].every((answer) => answer.status === 400 && !answer.text.includes('xxxx')) && /at least 8 characters/.test(tooShort.json.error)
    && /at most 4096 bytes/.test(tooLong.json.error) && /NUL/.test(withNul.json.error),
  `a value under 8 characters, over 4096 bytes, with a NUL or not text is refused with the rule and never the value (${[tooShort, tooLong, withNul, notText].map((a) => String(a.status)).join(' ')})`)
  const notJson = await fetch(PEOPLE + valueRoute, { method: 'POST', headers: { 'tailscale-user-login': alice, 'content-type': 'text/plain' }, body: JSON.stringify({ value: value.third }) })
  check(notJson.status === 415, `a request not declared as JSON is refused, as every change is (${String(notJson.status)})`)
  check(JSON.parse(readFileSync(secretsFile, 'utf8')).SENTRY_TOKEN === value.first, 'none of those changed the computer')

  // A name the computer uses for itself, and a secret that is no agent's.
  const names = ['PATH', 'AGENTS_TOKEN', 'HTTPS_PROXY']
  await ask(alice, 'POST', `/v1/agents/${odd}/plugins`, { name: 'odd', kind: 'stdio', config: { command: process.execPath, args: [FAKE_PLUGIN], env: Object.fromEntries(names.map((name) => [name, { secret: name }])) } })
  const reserved = await Promise.all(names.map(async (name) => ask(alice, 'POST', `/v1/secrets/${await secretIdOf(alice, odd, name)}/value`, { value: value.third })))
  check(reserved.every((answer) => answer.status === 400 && /can't be set from the app/.test(answer.json.error))
    && /itself/.test(reserved[0]?.json.error) && /AGENTS_/.test(reserved[1]?.json.error) && /proxy/.test(reserved[2]?.json.error),
  `a name the computer uses for itself, one the daemon owns and a proxy setting are refused, each with why (${reserved.map((a) => String(a.json.error)).join(' | ')})`)
  const personal = stringOf((await one(`insert into secrets (team_id, scope, person_id, name, stored_in) values ($1, 'person', $2, 'PERSONAL_TOKEN', 'machine') returning id`, [teamId, await personId(alice)])).id)
  const personalTries = await ask(alice, 'POST', `/v1/secrets/${personal}/value`, { value: value.third })
  check(personalTries.status === 400 && /agent's plugin/.test(personalTries.json.error), `a secret that belongs to no agent is refused (${String(personalTries.status)})`)
  const putFrames = machines.heard.filter((h) => h.kind === 'server-bytes' && h.url === LINK_PATH && h.text.includes('"secret_put"')).length
  check(putFrames === 1, `only the one value that could be set was sent to the computer (${String(putFrames)} secret_put frame)`)

  // A name the daemon's environment already sets. The environment is read before the secrets file, so a value
  // stored here would be set and never used, and the computer says so instead.
  check((await ask(alice, 'POST', `/v1/agents/${odd}/plugins`, pluginOf('envy', 'ENV_HELD_TOKEN'))).status === 200, 'a plugin that needs ENV_HELD_TOKEN is added to odd')
  const shadowed = await ask(alice, 'POST', `/v1/secrets/${await secretIdOf(alice, odd, 'ENV_HELD_TOKEN')}/value`, { value: value.shadowed })
  check(shadowed.status === 409 && /environment already sets ENV_HELD_TOKEN/.test(shadowed.json.error) && !holds(shadowed.text, value.shadowed)
    && !('ENV_HELD_TOKEN' in JSON.parse(readFileSync(secretsFile, 'utf8'))) && (await all('select 1 from secret_sets where instance_id = $1 and name = $2', [instanceA, 'ENV_HELD_TOKEN'])).length === 0,
  `a value for a name the daemon's environment already sets is refused with why, and stored nowhere (${String(shadowed.status)} ${String(shadowed.json.error)})`)

  // Setting it again replaces the value, and the old one is gone from the computer.
  const holdingFirst = harnessPid(homes.a, scoutSession)
  const replaced = await ask(alice, 'POST', valueRoute, { value: value.second })
  check(replaced.status === 200 && !holds(replaced.text, value.second), `setting it again answers 200 (${String(replaced.status)})`)
  const storedAgain = JSON.parse(readFileSync(secretsFile, 'utf8'))
  check(storedAgain.SENTRY_TOKEN === value.second && storedAgain.HAND_PLACED === HAND_PLACED, 'the new value, with its quote and backslash, is in secrets.json as written, beside the hand-placed one')
  check(filesHolding(homes.a, value.first).length === 0, `nothing of the old value is left on the computer, not even in the config that started the plugin (${filesHolding(homes.a, value.first).join(', ')})`)
  check((await all('select 1 from secret_sets where name = $1 and instance_id = $2', ['SENTRY_TOKEN', instanceA])).length === 1, 'the record still has one row for it')
  check(await within(15, async () => !running(holdingFirst)), "the process that held the old value is stopped when the new one is set, and does not wait for scout's next message")
  check(await exchange(scoutDm, 'hello third time') === 'fake reply', 'scout answers its next message')
  check(startsOf(scout).length === 2, 'its idle session was stopped for the new value and started again, not left holding the old one')
  check(await pluginSees('TOKEN') === sha(value.second), 'the plugin started from the new config gets the new value, quote and backslash intact')
  const writerOld = await exchange(writerDm, 'What is the token?') ?? ''
  const writerNew = await exchange(writerDm, 'What is the new token?') ?? ''
  check([writerOld, writerNew].every((reply) => reply.includes('[secret:SENTRY_TOKEN]') && !holds(reply, value.first) && !holds(reply, value.second)),
    `a repeated value is scrubbed whether it is the new one or the one that was replaced (${writerOld} | ${writerNew})`)
  const second = carrying(value.second)
  check(second.map((c) => `${c.heard.kind} ${c.where}`).sort().join() === 'request body,server-bytes bytes', `the new value is in one request and one frame too (${second.map((c) => `${c.heard.kind} ${c.where}`).join(', ')})`)

  // Setting it again while the agent is in the middle of a turn: the turn finishes, and the next message starts the plugin afresh.
  await say(scoutDm, 'work slowly')
  const sessionCommand = () => one(`select status from commands where session_id = $1 and kind = 'message' order by created_at desc limit 1`, [scoutSession])
  check(await within(20, async () => (await sessionCommand())?.status === 'claimed'), 'scout is in the middle of a turn')
  const mid = await ask(alice, 'POST', valueRoute, { value: value.third })
  check(mid.status === 200 && JSON.parse(readFileSync(secretsFile, 'utf8')).SENTRY_TOKEN === value.third && filesHolding(homes.a, value.second).length === 0,
    `a value set while it works is stored, and the config that held the old one is gone (${String(mid.status)})`)
  check(await within(40, async () => (await sessionCommand())?.status === 'done') && startsOf(scout).length === 2, 'its turn finishes undisturbed, in the process that began it')
  check(await exchange(scoutDm, 'hello after the slow turn') === 'fake reply' && startsOf(scout).length === 3, 'and its next message starts a new process')
  check(await pluginSees('TOKEN') === sha(value.third), 'which starts the plugin with the value set during the turn')

  // The connection drops while a person sets a value: the API waits for the daemon to come back.
  await machines.close()
  const waiting = ask(alice, 'POST', valueRoute, { value: value.fourth })
  await sleep(2000)
  machines = await tap(MACHINES_TAP, { port: PORTS.machines })
  machineTaps.push(machines)
  const afterWait = await waiting
  check(afterWait.status === 200 && JSON.parse(readFileSync(secretsFile, 'utf8')).SENTRY_TOKEN === value.fourth,
    `a person who sets a value while the computer's connection is down waits for it to come back, and the value is set (${String(afterWait.status)} ${afterWait.text.slice(0, 100)})`)

  // A computer that reports in but never opens the connection: a refusal that says what to do, and nothing kept.
  await machines.close()
  const started = Date.now()
  const lost = await ask(alice, 'POST', valueRoute, { value: value.fifth })
  const waited = (Date.now() - started) / 1000
  check(lost.status === 504 && /connection for keys is not up/.test(lost.json.error) && /from before this version/.test(lost.json.error) && lost.json.error.includes(computer.a) && waited >= LINK_WAIT_MS / 1000 - 1 && waited < LINK_WAIT_MS / 1000 + 5,
    `a computer that is running but has no connection gets ${String(LINK_WAIT_MS / 1000)} seconds, then a 504 that names it and says what to do (${String(lost.status)} after ${waited.toFixed(0)} s)`)
  machines = await tap(MACHINES_TAP, { port: PORTS.machines })
  machineTaps.push(machines)
  check(await linkUp(machines, 0), 'the daemon reconnects when the pass-through is back')
  await sleep(1000)
  check(JSON.parse(readFileSync(secretsFile, 'utf8')).SENTRY_TOKEN === value.fourth && carrying(value.fifth).every((c) => c.heard.kind === 'request') && (await everywhere(value.fifth)).length === 0,
    'the refused value was not queued or sent: when the computer is back its file still holds the earlier value')

  // A secrets file the daemon cannot read is left alone, and so is one it cannot write.
  const rowBefore = await setRowOf(instanceA)
  // The file starts with the mark, since Node's error for text that is not JSON quotes its first ten characters.
  const corrupt = `${CORRUPT_MARK} {"OTHER": 1`
  const quoted = CORRUPT_MARK.slice(0, 10)
  writeFileSync(secretsFile, corrupt, { mode: 0o600 })
  const refused = await ask(alice, 'POST', valueRoute, { value: value.sixth })
  check(refused.status === 409 && /not valid JSON/.test(refused.json.error) && !refused.text.includes(quoted) && !holds(refused.text, value.sixth) && readFileSync(secretsFile, 'utf8') === corrupt,
    `a secrets file that is not JSON is refused, not rewritten and not quoted (${String(refused.status)} ${String(refused.json.error)})`)
  check(!daemons.some((d) => d.text().includes(quoted)) && !api.text().includes(quoted), 'and neither log quotes what was in the file')
  writeFileSync(secretsFile, JSON.stringify({ SENTRY_TOKEN: value.fourth, HAND_PLACED }), { mode: 0o600 })
  chmodSync(homes.a, 0o500)
  const unwritable = await ask(alice, 'POST', valueRoute, { value: value.sixth }).finally(() => { chmodSync(homes.a, 0o700) })
  check(unwritable.status === 409 && /could not change what this computer holds/.test(unwritable.json.error) && !holds(unwritable.text, value.sixth) && JSON.parse(readFileSync(secretsFile, 'utf8')).SENTRY_TOKEN === value.fourth,
    `a folder the daemon cannot write to is refused with the daemon's words, and the file is as it was (${String(unwritable.status)} ${String(unwritable.json.error)})`)
  check((await setRowOf(instanceA))?.set_at === rowBefore?.set_at, 'neither refusal changed what the record says about when it was set')

  // Removing the value from the app removes it from the computer.
  check(await exchange(scoutDm, 'hello with the fourth value') === 'fake reply', 'scout starts its plugin with the value that is about to be removed')
  const holdingFourth = harnessPid(homes.a, scoutSession)
  const removed = await ask(alice, 'POST', removeRoute)
  check(removed.status === 200 && removed.json.had === true && removed.json.name === 'SENTRY_TOKEN' && !holds(removed.text, value.fourth), `the owner removes it from the app (${String(removed.status)} ${removed.text})`)
  const afterRemove = JSON.parse(readFileSync(secretsFile, 'utf8'))
  check(!('SENTRY_TOKEN' in afterRemove) && afterRemove.HAND_PLACED === HAND_PLACED, 'it is gone from secrets.json, and the value put there by hand is not')
  const left = SENT.flatMap((text) => filesHolding(homes.a, text))
  check(left.length === 0, `no file on the computer holds any value that was set, the plugin's config included (${left.join(', ')})`)
  check(await within(15, async () => !running(holdingFourth)), 'and the idle process whose plugin held the value is stopped')
  check((await all('select 1 from secret_sets where instance_id = $1', [instanceA])).length === 0, 'the record no longer says it is set')
  check(await stops(scoutDm, 'hello after removal', 'SENTRY_TOKEN'), 'scout stops again, saying its computer lacks the value')
  check((await exchange(writerDm, 'What is the new token?'))?.includes('[secret:SENTRY_TOKEN]') === true, 'a value removed from the computer is still scrubbed when an agent repeats it')
  const removedAgain = await ask(alice, 'POST', removeRoute)
  check(removedAgain.status === 200 && removedAgain.json.had === false, 'removing it again changes nothing and says so')

  // A computer that is not running is asked to start, and the request waits for it. Nothing here starts it, so the wait
  // runs out in a refusal that names the computer, and nothing is kept for when it starts.
  const startAsks = (name: string) => api.text().split('\n').filter((line) => line.includes(`asking for ${name} to start`)).length
  check((await ask(alice, 'POST', valueRoute, { value: value.seventh })).status === 200, 'a value is set again while the computer runs')
  await daemons[0]?.stop()
  check(await within(20, async () => (await one('select status from instances where id = $1', [instanceA]))?.status === 'offline'), 'the computer reports that it is stopped')
  const askedBefore = startAsks(computer.a)
  const stoppedAt = Date.now()
  const stopped = await ask(alice, 'POST', valueRoute, { value: value.eighth })
  const stoppedFor = (Date.now() - stoppedAt) / 1000
  check(stopped.status === 504 && stopped.json.error.includes(computer.a) && stopped.json.error.includes(`within ${String(WAKE_SEC)} seconds`) && stopped.json.error.includes('not saved') && !holds(stopped.text, value.eighth),
    `a request for a stopped computer waits, then answers 504 with a reason that names the computer (${String(stopped.status)} ${String(stopped.json.error)})`)
  check(stoppedFor >= WAKE_SEC - 0.5 && stoppedFor < WAKE_SEC + 5, `it waits the time it is given, and no longer (${stoppedFor.toFixed(1)} s of ${String(WAKE_SEC)})`)
  check(startAsks(computer.a) === askedBefore + 1, 'and it asks once for the computer to be started')
  await db.query(`update instances set status = 'stale' where id = $1`, [instanceA])
  const silentRemove = await ask(alice, 'POST', removeRoute)
  check(silentRemove.status === 504 && silentRemove.json.error.includes(computer.a) && silentRemove.json.error.includes('not removed') && (await all('select 1 from secret_sets where instance_id = $1', [instanceA])).length === 1,
    `a computer that stopped answering is waited for the same way, and removing from it ends in a 504 that names it, with the record still saying the value is set (${String(silentRemove.status)} ${String(silentRemove.json.error)})`)
  // While it is stopped the value is lost from its home, as when a box is made again with an empty volume.
  writeFileSync(secretsFile, JSON.stringify({ HAND_PLACED }), { mode: 0o600 })
  const beforeRestart = machines.heard.length
  daemons.push(startDaemon(macA.token, homes.a, THROUGH_TAP, scenario, { ENV_HELD_TOKEN: ENV_HELD }))
  check(await linkUp(machines, beforeRestart) && await within(30, async () => (await one('select status from instances where id = $1', [instanceA]))?.status === 'online'), 'the computer starts again and opens its connection')
  check(!holds(readFileSync(secretsFile, 'utf8'), value.eighth) && carrying(value.eighth).every((c) => c.heard.kind === 'request'), 'nothing was kept or sent for it while it was stopped')
  check(await within(20, async () => (await all('select 1 from secret_sets where instance_id = $1', [instanceA])).length === 0),
    'the computer says what it holds when it connects, and the record stops saying a value is set that it lost')
  check((await ask(alice, 'POST', valueRoute, { value: value.eighth })).status === 200 && JSON.parse(readFileSync(secretsFile, 'utf8')).SENTRY_TOKEN === value.eighth, 'and the value is set once it runs')
  check((await ask(alice, 'POST', removeRoute)).status === 200 && !('SENTRY_TOKEN' in JSON.parse(readFileSync(secretsFile, 'utf8'))), 'and removed')

  // A computer that starts while a request waits gets the value the request held. This check's own daemon plays the start.
  await daemons.at(-1)?.stop()
  check(await within(20, async () => (await one('select status from instances where id = $1', [instanceA]))?.status === 'offline'), 'the computer is stopped again')
  const askedAgain = startAsks(computer.a)
  const holding = ask(alice, 'POST', valueRoute, { value: value.ninth })
  check(await within(10, async () => startAsks(computer.a) > askedAgain), 'a person sets a value, and the API asks for the computer to be started')
  const beforeStart = machines.heard.length
  daemons.push(startDaemon(macA.token, homes.a, THROUGH_TAP, scenario, { ENV_HELD_TOKEN: ENV_HELD }))
  const delivered = await boundedBy(holding, WAKE_SEC + 10, null)
  check(delivered?.status === 200 && delivered.json.name === 'SENTRY_TOKEN' && JSON.parse(readFileSync(secretsFile, 'utf8')).SENTRY_TOKEN === value.ninth && !holds(delivered.text, value.ninth),
    `the computer comes up while the request waits, and the request delivers the value and answers 200 (${String(delivered?.status)} ${delivered?.text.slice(0, 100) ?? ''})`)
  check(await linkUp(machines, beforeStart) && (await setRowOf(instanceA))?.set_by === await personId(alice), 'and the record says who set it')
  check((await ask(alice, 'POST', removeRoute)).status === 200 && !('SENTRY_TOKEN' in JSON.parse(readFileSync(secretsFile, 'utf8'))), 'and the value is removed again')

  // A person's own box that is asleep. A key for it wakes it the way the runner wakes a box something wants: the runner
  // starts its container (here the stand-in for Docker), the box's daemon comes up, and the request delivers the value.
  // This check's daemon plays the box, and starts only once the runner has started the box's container.
  const boxToken = `box25-${randomBytes(18).toString('hex')}`
  const boxId = stringOf(must(await one(
    `insert into instances (team_id, name, kind, owner_id, token_sha256, claimed_by, claimed_at, personal, idle_since, stopped_at, status)
     values ($1, $2, 'box', $3, $4, $3, now(), true, now(), now(), 'offline') returning id`,
    [teamId, computer.box, await personId(alice), sha(boxToken)]), 'the box').id)
  writeFileSync(dockerState, `${boxId} exited\n`)
  const boxie = agentOn('boxie', computer.box)
  check((await ask(alice, 'POST', `/v1/agents/${boxie}/plugins`, pluginOf('boxtool', 'BOX_TOKEN'))).status === 200, "a plugin that needs BOX_TOKEN is added to boxie, whose computer is alice's own box, asleep")
  const boxRoute = `/v1/secrets/${await secretIdOf(alice, boxie, 'BOX_TOKEN')}/value`
  const waking = ask(alice, 'POST', boxRoute, { value: value.box })
  const containerStarted = await within(WAKE_SEC, async () => dockerCalls().includes(`start ${boxContainer(boxId)}`))
  check(containerStarted, `a key for a person's own box that is asleep has the runner start the box's container (${dockerCalls().filter((c) => c.includes(boxId)).join('; ') || 'no call for it'})`)
  check((await one('select stopped_at from instances where id = $1', [boxId]))?.stopped_at === null, 'and the box is no longer marked asleep')
  if (containerStarted) daemons.push(startDaemon(boxToken, homes.box, THROUGH_TAP, scenario))
  const woke = await boundedBy(waking, WAKE_SEC + 10, null)
  const boxFile = join(homes.box, 'secrets.json')
  check(woke?.status === 200 && existsSync(boxFile) && JSON.parse(readFileSync(boxFile, 'utf8')).BOX_TOKEN === value.box && !holds(woke.text, value.box),
    `the box's daemon comes up while the request waits, the value lands in the box's secrets.json, and the request answers 200 (${String(woke?.status)} ${woke?.text.slice(0, 120) ?? ''})`)
  check((await setRowOf(boxId, 'BOX_TOKEN'))?.set_by === await personId(alice), 'and the record says alice set it on her box')

  // A teammate's computer, and one with no owner. Any teammate's run may use a computer with no owner, and read what
  // is put there, so neither takes alice's value. The refusal comes at once, without waiting for the computer.
  check((await ask(bob, 'POST', `/v1/agents/${bobby}/plugins`, pluginOf('jira', 'JIRA_TOKEN'))).status === 200, "a plugin that needs JIRA_TOKEN is added to bobby, whose computer is bob's")
  const jira = await secretIdOf(bob, bobby, 'JIRA_TOKEN')
  const notAlices = await ask(alice, 'POST', `/v1/secrets/${jira}/value`, { value: value.eighth })
  check(notAlices.status === 403, `another person cannot set a value on a teammate's computer (${String(notAlices.status)})`)
  await db.query('update instances set owner_id = null where name = $1', [computer.b])
  const ownerlessAt = Date.now()
  const ownerless = await ask(alice, 'POST', `/v1/secrets/${jira}/value`, { value: value.eighth })
  const ownerlessFor = (Date.now() - ownerlessAt) / 1000
  await db.query('update instances set owner_id = $2 where name = $1', [computer.b, await personId(bob)])
  check(ownerless.status === 403 && ownerless.json.error.includes(computer.b) && ownerless.json.error.includes('no owner') && ownerlessFor < 3 && !holds(ownerless.text, value.eighth),
    `a computer with no owner takes no value, and the refusal says why at once (${String(ownerless.status)} ${String(ownerless.json.error)}, ${ownerlessFor.toFixed(1)} s)`)

  // What the API does with a computer's answers, with the check playing the daemon of a third computer.
  check((await ask(alice, 'POST', `/v1/agents/${carl}/plugins`, pluginOf('crm', 'CARL_TOKEN'))).status === 200, 'a plugin that needs CARL_TOKEN is added to carl, whose computer has no daemon here')
  const carlRoute = `/v1/secrets/${await secretIdOf(alice, carl, 'CARL_TOKEN')}`
  const received: ToDaemon[] = []
  // Connects as the third computer, says what it holds if `hello` is given, and answers each frame the way `behave` says.
  const playDaemon = async (behave: (ws: WebSocket, frame: ToDaemon) => void, hello?: FromDaemon) => {
    const link = await probe({ authorization: `Bearer ${macC.token}` })
    if (link.refusedWith !== null) throw new Error(`the third computer's connection was refused with ${String(link.refusedWith)}`)
    if (hello) link.ws.send(JSON.stringify(hello))
    link.ws.on('message', (data) => {
      const frame = parseJson(ToDaemon, bytesOf(data).toString('utf8'))
      if (!frame.ok) return
      received.push(frame.value)
      behave(link.ws, frame.value)
    })
    return link.ws
  }
  const lines = async () => (await all('select 1 from secret_sets where instance_id = $1', [instanceC])).length
  const obliging = await playDaemon((ws, frame) => { ws.send(JSON.stringify({ type: frame.type === 'secret_put' ? 'secret_stored' : 'secret_removed', id: frame.id, name: frame.name, had: true })) })
  const carlSet = await ask(alice, 'POST', `${carlRoute}/value`, { value: value.carl })
  const sentFrame = received[0]
  check(carlSet.status === 200 && sentFrame?.type === 'secret_put' && sentFrame.value === value.carl && sentFrame.name === 'CARL_TOKEN' && Object.keys(sentFrame).sort().join() === 'id,name,type,value' && await lines() === 1,
    `the API sends a computer the secret_put frame with an id, the name and the value, and records the answer (${String(carlSet.status)})`)
  const carlRemove = await ask(alice, 'POST', `${carlRoute}/remove`)
  check(carlRemove.status === 200 && carlRemove.json.had === true && received[1]?.type === 'secret_remove' && await lines() === 0, 'and the secret_remove frame, and records that the value is gone')
  obliging.close()
  await boundedBy(closedWith(obliging), 5, 0)

  // A computer lists the secrets it holds when it connects, and the record drops each row for a name that is not
  // listed. A value set while that comparison is under way has to survive it. The check holds a lock on one row,
  // so the comparison cannot finish until the check lets it.
  const aliceId = await personId(alice)
  for (const name of ['KEPT_ONE', 'LOCKED_ONE']) await db.query('insert into secret_sets (team_id, instance_id, name, set_by) values ($1, $2, $3, $4)', [teamId, instanceC, name, aliceId])
  const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
  closers.push(async () => {
    await holder.query('rollback').catch(() => undefined)
    await holder.end().catch(() => undefined)
  })
  await holder.connect()
  await holder.query('begin')
  await holder.query('select 1 from secret_sets where instance_id = $1 and name = $2 for update', [instanceC, 'LOCKED_ONE'])
  const framesBefore = received.length
  const reporting = await playDaemon((ws, frame) => { ws.send(JSON.stringify({ type: 'secret_stored', id: frame.id, name: frame.name })) }, { type: 'secrets_held', names: ['KEPT_ONE'] })
  check(await within(10, async () => (await one(`select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like 'delete from secret_sets%'`)) !== undefined),
    "the record's comparison with a computer's list waits on a row that another transaction holds")
  const settingDuring = ask(alice, 'POST', `${carlRoute}/value`, { value: value.carl })
  const answered = { during: false }
  void settingDuring.then(() => { answered.during = true }, () => { answered.during = true })
  check(await within(10, async () => received.length > framesBefore), 'a value is set on the computer while the comparison waits, and the computer stores it')
  // Nothing can be waited for when what has to be seen is nothing happening.
  await sleep(1000)
  check(!answered.during && await lines() === 2, 'the set waits for the comparison, and no row is written before it has finished')
  await holder.query('rollback')
  const afterComparison = await boundedBy(settingDuring, 15, null)
  const kept = (await all('select name from secret_sets where instance_id = $1 order by name', [instanceC])).map((row) => String(row.name)).join()
  check(afterComparison?.status === 200 && kept === 'CARL_TOKEN,KEPT_ONE',
    `once the comparison has finished the set is recorded, a name the computer lists is kept and one it does not is dropped (${String(afterComparison?.status)} ${kept})`)
  await holder.end()
  reporting.close()
  await boundedBy(closedWith(reporting), 5, 0)
  await db.query('delete from secret_sets where instance_id = $1', [instanceC])

  const wrong = await playDaemon((ws, frame) => { ws.send(JSON.stringify({ type: 'secret_removed', id: frame.id, name: frame.name, had: true })) })
  const wrongAnswer = await ask(alice, 'POST', `${carlRoute}/value`, { value: value.carl })
  check(wrongAnswer.status === 502 && await lines() === 0, `an answer that is not for the request is refused and nothing is recorded (${String(wrongAnswer.status)})`)
  wrong.close()
  await boundedBy(closedWith(wrong), 5, 0)

  const refusing = await playDaemon((ws, frame) => { ws.send(JSON.stringify({ type: 'secret_refused', id: frame.id, name: frame.name, reason: 'No room on this disk.' })) })
  const refusedBy = await ask(alice, 'POST', `${carlRoute}/value`, { value: value.carl })
  check(refusedBy.status === 409 && refusedBy.json.error.includes('would not take it. No room on this disk.') && await lines() === 0, `a computer's refusal reaches the person with its reason, and nothing is recorded (${String(refusedBy.status)} ${String(refusedBy.json.error)})`)
  refusing.close()
  await boundedBy(closedWith(refusing), 5, 0)

  const leaving = await playDaemon((ws) => { ws.close() })
  const leftWith = await ask(alice, 'POST', `${carlRoute}/value`, { value: value.carl })
  check(leftWith.status === 409 && /closed its connection before it answered/.test(leftWith.json.error) && await lines() === 0, `a computer that closes its connection before it answers leaves a refusal and nothing recorded (${String(leftWith.status)} ${String(leftWith.json.error)})`)
  await boundedBy(closedWith(leaving), 5, 0)

  const mute = await playDaemon(() => undefined)
  const asked = Date.now()
  const noAnswer = await boundedBy(ask(alice, 'POST', `${carlRoute}/value`, { value: value.carl }), 30, null)
  check(noAnswer?.status === 409 && /did not answer in time/.test(noAnswer.json.error) && Date.now() - asked >= LINK_ANSWER_MS - 500 && await lines() === 0,
    `a computer that answers nothing is given ${String(LINK_ANSWER_MS / 1000)} seconds, then a refusal, and nothing is recorded (${String(noAnswer?.status)})`)
  mute.close()
  await boundedBy(closedWith(mute), 5, 0)

  // The API's control path takes only a daemon with its token, and reads frames strictly.
  const withTailscale = await probe({ authorization: `Bearer ${macC.token}`, 'tailscale-user-login': alice })
  const noToken = await probe({})
  const wrongToken = await probe({ authorization: 'Bearer a-token-no-instance-has' })
  check(withTailscale.refusedWith === 400 && noToken.refusedWith === 401 && wrongToken.refusedWith === 401,
    `the control path refuses a person's identity, no token and an unknown token (${String(withTailscale.refusedWith)} ${String(noToken.refusedWith)} ${String(wrongToken.refusedWith)})`)
  const earlier = await probe({ authorization: `Bearer ${macC.token}` })
  const replacedBy = closedWith(earlier.ws)
  const later = await probe({ authorization: `Bearer ${macC.token}` })
  check(earlier.refusedWith === null && later.refusedWith === null && await boundedBy(replacedBy.then(() => true), 5, false),
    'a daemon that connects again replaces its earlier connection')
  later.ws.send(JSON.stringify({ type: 'secret_stored', id: randomUUID(), name: 'SENTRY_TOKEN' }))
  const stillOpen = await boundedBy(closedWith(later.ws).then(() => false), 1.5, true)
  check(stillOpen, 'an answer to a request nobody waits for is ignored')
  const badCode = closedWith(later.ws)
  later.ws.send(JSON.stringify({ type: 'secret_stored', id: 'not-an-id', name: 'SENTRY_TOKEN', mark: BAD_MARK }))
  check(await boundedBy(badCode, 5, 0) === LINK_UNSUPPORTED && !api.text().includes(BAD_MARK) && /a frame was refused/.test(api.text()),
    'a frame the API cannot read closes the connection, and the log says so without quoting it')

  // A frame the daemon cannot read, from a stand-in for the API.
  const unreadable = [
    JSON.stringify({ type: 'secret_put', id: 'not-a-uuid', name: 'SENTRY_TOKEN', value: BAD_MARK }),
    JSON.stringify({ type: 'secret_put', id: randomUUID(), name: 'PATH', value: BAD_MARK }),
    Buffer.from(BAD_MARK),
  ]
  const codes: number[] = []
  const standIn = new WebSocketServer({ port: STAND_IN, host: '127.0.0.1' })
  closers.push(() => new Promise<void>((done) => { standIn.close(() => { done() }) }))
  standIn.on('connection', (ws) => {
    ws.on('close', (code) => { codes.push(code) })
    ws.on('error', () => undefined)
    const frame = unreadable[codes.length]
    if (frame !== undefined) ws.send(frame)
  })
  mkdirSync(homes.stand, { recursive: true })
  const standDaemon = startDaemon('a-token-the-stand-in-never-checks', homes.stand, `http://127.0.0.1:${String(STAND_IN)}`, scenario)
  daemons.push(standDaemon)
  check(await within(40, async () => codes.length >= 3) && codes.slice(0, 3).every((code) => code === LINK_UNSUPPORTED),
    `a daemon closes the connection on a frame it cannot read, for a bad id, a reserved name and a binary message (${codes.join(' ')})`)
  check(!standDaemon.text().includes(BAD_MARK) && /a frame was refused/.test(standDaemon.text()), 'and its log says a frame was refused without quoting it')
  check(!existsSync(join(homes.stand, 'secrets.json')), 'and it stored nothing')

  // Whatever was set: only in the request that set it and the frame that carried it down, and nowhere else.
  const strays = SENT.flatMap(carrying).filter((c) => {
    const setsValue = c.heard.kind === 'request' && c.heard.method === 'POST' && /^\/v1\/secrets\/[0-9a-f-]{36}\/value$/.test(c.heard.url) && c.where === 'body'
    const carriesDown = c.heard.kind === 'server-bytes' && c.heard.url === LINK_PATH && c.heard.text.includes('"secret_put"')
    return !setsValue && !carriesDown
  })
  check(strays.length === 0, `every value that was sent is in a request body to the route that sets a value or a secret_put frame on a control connection, and in no address, header, answer or other message (${strays.map((c) => `${c.heard.kind} ${c.where}`).join(', ')})`)
  const places: string[] = []
  for (const text of SENT) places.push(...await everywhere(text))
  check(places.length === 0, `no value is in any Postgres column, API or daemon log, or file of the API${places.length ? ` (found in ${[...new Set(places)].join(', ')})` : ''}`)
  const files = SENT.flatMap((text) => filesHolding(homes.a, text))
  check(files.length === 0, `and none is on the computer once removed (${files.join(', ')})`)
}

try {
  await main()
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? messageOf(error) : messageOf(error)}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  for (const close of closers) await close().catch((error: unknown) => { console.error('closing:', messageOf(error)) })
  if (!failures.length) {
    await db.query('delete from teams where name = any($1)', [[team, otherTeam]]).catch((error: unknown) => { console.error('removing the teams:', messageOf(error)) })
    rmSync(home, { recursive: true, force: true })
  }
  await db.end().catch(() => undefined)
}

for (const log of failures.length ? logs : []) console.log(`\nthe last of ${log.name}'s log:\n${log.text().split('\n').slice(-25).join('\n')}`)
console.log(`\n${failures.length ? `${String(failures.length)} failed (teams ${team} and ${otherTeam}, and ${home}, kept)` : 'all passed (test teams and folder removed)'}`)
process.exit(failures.length ? 1 : 0)
