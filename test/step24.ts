// Agent setup and copies, step 7 of the target architecture, with the stand-in for
// Claude and Claude Code's hooks (test/fake-claude-hooks.ts). Alice's agent has a
// skill, a plugin that needs a secret, a routine, three hooks, and memories about the
// team and about two people. Bob copies it onto his own machine. The copy carries the
// skill, the plugin, the routine, the hooks and the team's memories. It carries no
// memory about a person and no secret value: the plugin names its secret, Bob's
// machine lacks the value, and the copy stops and says which until Bob sets his own.
// The copy's hooks run, and what they did is in the record: a notice for each run, and
// a file a hook wrote in a task's folder as a document. Only an agent's owner or an
// admin changes its hooks. A template keeps the hooks and no memories.
//   node --env-file=.env --env-file=.env.test test/step24.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { asPerson, foundInDatabase, results, ROOT, shapeRows, startApi, within } from './onboarding-kit.ts'
import { must } from './must.ts'

const PORTS = { machines: 7891, people: 7991, streams: 7892 }
const API = `http://127.0.0.1:${PORTS.machines}`
const PEOPLE = `http://127.0.0.1:${PORTS.people}`
const id = randomBytes(4).toString('hex')
const [team, otherTeam] = [`step24-${id}`, `step24x-${id}`]
const [alice, bob, outsider] = [`alice24-${id}@local`, `bob24-${id}@local`, `out24-${id}@local`]
// Alice's machine holds the plugin's secret. Bob's holds a value of his own, set later.
const ALICE_SECRET = `alice-lucky-${randomBytes(8).toString('hex')}`
const BOB_SECRET = `bob-lucky-${randomBytes(8).toString('hex')}`
const TEAM_PROFILE = `TEAMPROFILE-${randomBytes(4).toString('hex')} release notes go out on Fridays.`
const TEAM_LOG = `TEAMLOG-${randomBytes(4).toString('hex')} shipped the checkout fix.`
const ABOUT_ALICE = `ABOUTALICE-${randomBytes(4).toString('hex')} prefers terse notes.`
const ABOUT_BOB = `ABOUTBOB-${randomBytes(4).toString('hex')} reviews on Mondays.`

const SCENARIO = {
  turns: [{ match: 'Write the shipping notes', write: { 'task/notes.md': '# Notes\n\nShipping notes go here.\n' }, reply: 'Wrote task/notes.md.' }],
}
// The hooks, as the app's form sends them. The first logs the event Claude Code gives
// it to a file in the task folder and prints a line. The second runs after the Write
// tool. The third fails when the turn stops.
const STOP = { name: 'check-stop', event: 'Stop', matcher: null, command: 'echo stop-hook-failed >&2; exit 3', timeoutSec: null }
const PROMPT = { name: 'note-prompts', event: 'UserPromptSubmit', matcher: null, command: 'mkdir -p task && { cat; echo; } >> task/hook-log.txt && echo noted-the-prompt', timeoutSec: 20 }
const WRITE = { name: 'stamp-writes', event: 'PostToolUse', matcher: 'Write', command: 'echo a-file-was-written >> task/hook-log.txt', timeoutSec: null }
// By name, which is the order the server reads them in.
const HOOKS = [STOP, PROMPT, WRITE]
// What Claude Code reads for them, grouped by event and matcher.
const SETTINGS = {
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: STOP.command }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: PROMPT.command, timeout: 20 }] }],
    PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: WRITE.command }] }],
  },
}

const { failures, check } = results()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
const row = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows
const as = (who: string, path: string, body: unknown = {}) => asPerson(PEOPLE, who, 'POST', path, body)
const same = isDeepStrictEqual
const homeA = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step24a-')))
const homeB = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step24b-')))

function daemon(home: string, token: string): ChildProcess {
  return spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home,
      AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude-hooks.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json'),
    },
  })
}

const jsonFile = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null)
const settingsOf = (home: string, agentId: string | undefined) => (agentId ? jsonFile(join(home, 'agents', agentId, '.claude', 'settings.local.json')) : null)
const eventsOf = (home: string, agentId: string | undefined): string[] | null => {
  const settings = settingsOf(home, agentId)
  return settings ? Object.keys(settings.hooks).sort() : null
}
// The files under a folder that hold some text.
const filesHolding = (dir: string, value: string) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).filter((file) => readFileSync(file, 'utf8').includes(value))
const dmWith = async (who: string, agent: string) => (await as(who, '/v1/conversations', { kind: 'dm', agent })).json.conversationId
const say = (who: string, conversationId: string, text: string) => as(who, `/v1/conversations/${conversationId}/messages`, { text })
const sessionOf = async (conversationId: string) => (await row('select id, status from sessions where conversation_id = $1', [conversationId]))
const notices = (sessionId: string) => rows(
  `select text, body from events where session_id = $1 and kind = 'notice' and body->>'subtype' = 'hook_response' order by seq`, [sessionId])
const replies = (conversationId: string) => rows(
  `select body from messages where conversation_id = $1 and speaker = 'agent' order by seq`, [conversationId])
const agentRow = (name: string) => row(
  'select * from agents where team_id = (select id from teams where name = $1) and name = $2 and archived_at is null', [team, name])

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

let api: Awaited<ReturnType<typeof startApi>> | null = null
try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, alice)
  node('server/admin.ts', 'add-person', team, bob)
  node('server/admin.ts', 'add-team', otherTeam, outsider)
  const machineA = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-a-${id}`, 'mac', alice))
  const machineB = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-b-${id}`, 'mac', bob))
  // Alice's own box. Nothing runs on it, and the runner starts a box only when a person holds it.
  node('server/admin.ts', 'add-instance', team, `box-a-${id}`, 'box', alice)
  await db.query(`update instances set personal = true where name = $1`, [`box-a-${id}`])
  const idOf = async (name: string) => must(await row('select id from instances where name = $1', [name]), name).id
  const [macA, macB, boxA] = [await idOf(`mac-a-${id}`), await idOf(`mac-b-${id}`), await idOf(`box-a-${id}`)]
  for (const home of [homeA, homeB]) writeFileSync(join(home, 'scenario.json'), JSON.stringify(SCENARIO))
  writeFileSync(join(homeA, 'secrets.json'), JSON.stringify({ LUCKY_TOKEN: ALICE_SECRET }), { mode: 0o600 })
  api = await startApi(PORTS, { AGENTS_RUNNER_TEAMS: team }, join(homeA, 'streams'))
  check(await within(20, () => fetch(API).then(() => true, () => false)), 'the API starts')
  children.push(daemon(homeA, machineA.token), daemon(homeB, machineB.token))
  check(await within(30, async () => Number((await row(`select count(*)::int as n from instances where team_id = (select id from teams where name = $1) and status = 'online'`, [team])).n) === 2),
    "both machines' daemons are online")

  // Alice makes the agent that Bob will copy.
  const made = await as(alice, '/v1/agents', { name: 'release-notes', homeInstanceId: macA, title: 'Writes release notes', instructions: 'You write release notes. Keep them short.', model: 'sonnet' })
  const source = must(made.json?.agentId, 'the agent Alice made')
  await as(alice, `/v1/agents/${source}/skills`, { name: 'release-style', description: 'Writing release notes', content: 'One line for each merged pull request.' })
  await as(alice, `/v1/agents/${source}/plugins`, { name: 'lucky', kind: 'stdio', config: { command: 'node', args: ['lucky.js'], env: { LUCKY: { secret: 'LUCKY_TOKEN' } } } })
  await as(alice, `/v1/agents/${source}/routines`, { name: 'weekly', schedule: '0 9 * * 5', prompt: 'Draft this week\'s release notes.' })

  // Who may change a hook, and what a hook may be.
  const bad = [
    await as(alice, `/v1/agents/${source}/hooks`, { name: 'x', event: 'NoSuchEvent', command: 'true' }),
    await as(alice, `/v1/agents/${source}/hooks`, { name: 'x', event: 'UserPromptSubmit', matcher: 'Write', command: 'true' }),
    await as(alice, `/v1/agents/${source}/hooks`, { name: 'Not A Name', event: 'Stop', command: 'true' }),
    await as(alice, `/v1/agents/${source}/hooks`, { name: 'x', event: 'Stop', command: '   ' }),
    await as(alice, `/v1/agents/${source}/hooks`, { name: 'x', event: 'Stop', command: 'true', timeoutSec: 0 }),
  ]
  check(bad.every((answer) => answer.status === 400) && Number((await row('select count(*)::int as n from agent_hooks where agent_id = $1', [source])).n) === 0,
    `a hook needs a known event, a matcher only on a tool event, a name, a command and a time limit that can run: ${bad.map((answer) => answer.status).join(' ')}`)
  const keyed = await as(alice, `/v1/agents/${source}/hooks`, { name: 'leaky', event: 'Stop', command: `curl -H "Authorization: token ghp_${'a1B2c3D4'.repeat(5)}" https://example.test` })
  check(keyed.status === 400 && Number((await row('select count(*)::int as n from agent_hooks where agent_id = $1', [source])).n) === 0,
    'a command that holds a secret value is refused, since the record keeps commands')
  const bobAdds = await as(bob, `/v1/agents/${source}/hooks`, STOP)
  const outsiderAdds = await as(outsider, `/v1/agents/${source}/hooks`, STOP)
  check(bobAdds.status === 403 && /owner or a team admin/.test(bobAdds.json?.error) && outsiderAdds.status === 404
    && Number((await row('select count(*)::int as n from agent_hooks where agent_id = $1', [source])).n) === 0,
  "a teammate who does not own the agent cannot add a hook to it, and nobody from another team can reach it")
  for (const hook of HOOKS) await as(alice, `/v1/agents/${source}/hooks`, hook)
  const bobRemoves = await as(bob, `/v1/agents/${source}/hooks/check-stop/delete`)
  const stored = await rows('select name, event, matcher, command, timeout_sec as "timeoutSec" from agent_hooks where agent_id = $1 order by name', [source])
  check(bobRemoves.status === 403 && same(stored, HOOKS),
    "the owner's three hooks are stored as sent, and a teammate cannot take one off")
  const seen = await shapeRows(PEOPLE, bob, 'agent_hooks')
  check(seen.rows.filter((r) => r.agent_id === source).length === 3, "teammates read an agent's hooks through the agent_hooks shape")

  // Alice talks to her agent. The hooks run in its session, on her machine.
  const aliceDm = await dmWith(alice, 'release-notes')
  await say(alice, aliceDm, 'Hello, are you there?')
  check(await within(40, async () => {
    const session = await sessionOf(aliceDm)
    return session && (await replies(aliceDm)).length === 1 && (await notices(session.id)).length >= 2
  }), "Alice's message gets a reply, and her agent's hooks ran")
  const aliceSession = must((await sessionOf(aliceDm))?.id, "Alice's session")
  const written = settingsOf(homeA, source)
  check(same(written, SETTINGS), `the daemon wrote the hooks where Claude Code reads them, grouped by event and matcher: ${JSON.stringify(written)}`)
  const ran = await notices(aliceSession)
  const prompt = ran.find((n) => n.body.hook_event === 'UserPromptSubmit')
  const stop = ran.find((n) => n.body.hook_event === 'Stop')
  check(prompt?.body.outcome === 'success' && prompt.text === 'Hook UserPromptSubmit finished.\nnoted-the-prompt',
    `a hook's run is in the record, with what it printed: ${JSON.stringify(prompt?.text)}`)
  check(stop?.body.outcome === 'error' && stop.body.exit_code === 3 && stop.text === 'Hook Stop failed with exit code 3.\nstop-hook-failed',
    `a hook that fails is in the record too, with its exit code and what it said: ${JSON.stringify(stop?.text)}`)

  // What the agent remembers, written through the route its tool calls, as its machine.
  const remember = async (about: string, kind: string, content: string) => {
    const res = await fetch(`${API}/v1/record/memory?session=${aliceSession}`, {
      method: 'POST', headers: { authorization: `Bearer ${machineA.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ about, kind, content }),
    })
    return res.ok
  }
  check(await remember('team', 'profile', TEAM_PROFILE) && await remember('team', 'log', TEAM_LOG)
    && await remember(alice, 'profile', ABOUT_ALICE) && await remember(bob, 'log', ABOUT_BOB), "the agent keeps memories of the team, of Alice and of Bob")
  // A log about a person from an earlier day, so it is no copy of the team's log of today.
  await db.query(`update memories set log_date = current_date - 1 where agent_id = $1 and scope = 'person' and kind = 'log'`, [source])

  // Bob copies it.
  const copied = await as(bob, `/v1/agents/${source}/copy`, { name: 'release-notes-bob', homeInstanceId: macB, memories: true })
  const copy = copied.json?.agentId
  const mine = await agentRow('release-notes-bob')
  check(copied.status === 200 && mine?.id === copy && mine.owner_id === (await row('select id from people where login = $1', [bob])).id
    && mine.home_instance_id === macB && mine.copied_from_agent_id === source && mine.title === 'Writes release notes'
    && mine.instructions === 'You write release notes. Keep them short.' && mine.model === 'sonnet',
  `Bob's copy is his own agent on his machine, made from Alice's: ${copied.status} ${JSON.stringify(copied.json)}`)
  check(same(copied.json?.carried, { skills: 1, plugins: 1, routines: 1, hooks: 3, memories: 2 }),
    `the copy says what it carried: ${JSON.stringify(copied.json?.carried)}`)
  // One query at a time, since a client runs one.
  const slice = async (agentId: string) => ({
    skills: await rows('select name, description, content from skills where agent_id = $1 order by name', [agentId]),
    plugins: await rows('select name, kind, config from plugins where agent_id = $1 order by name', [agentId]),
    routines: await rows(`select name, prompt, trigger_config->>'schedule' as schedule from routines where agent_id = $1 order by name`, [agentId]),
    hooks: await rows('select name, event, matcher, command, timeout_sec as "timeoutSec" from agent_hooks where agent_id = $1 order by name', [agentId]),
  })
  const from = await slice(source)
  const to = await slice(copy)
  check(from.skills.length === 1 && same(to.skills, from.skills) && from.plugins.length === 1 && same(to.plugins, from.plugins)
    && from.routines.length === 1 && same(to.routines, from.routines) && from.hooks.length === 3 && same(to.hooks, from.hooks),
  "the copy carries the agent's skill, plugin, routine and three hooks as they are")
  const teamRows = (agentId: string) => rows(`select kind, log_date::text as day, content from memories where agent_id = $1 and scope = 'team' order by kind desc`, [agentId])
  const sourceTeam = await teamRows(source)
  const copyTeam = await teamRows(copy)
  check(sourceTeam.length === 2 && same(copyTeam, sourceTeam) && copyTeam.some((m) => m.content === TEAM_PROFILE) && copyTeam.some((m) => m.content === TEAM_LOG && m.day !== null),
    "the copy carries the team's memories, the profile and the dated log")
  const personal = await rows(`select content from memories where agent_id = $1 and scope = 'person'`, [copy])
  const everything = JSON.stringify(await rows('select * from memories where agent_id = $1', [copy]))
  check(mine?.id === copy && personal.length === 0 && !everything.includes(ABOUT_ALICE) && !everything.includes(ABOUT_BOB)
    && (await rows(`select 1 from memories where agent_id = $1 and scope = 'person'`, [source])).length === 2,
  'the copy carries no memory about a person, though its source keeps two')
  const secretRow = await row(`select scope, stored_in from secrets where agent_id = $1 and name = 'LUCKY_TOKEN'`, [copy])
  check(to.plugins[0]?.config.env.LUCKY.secret === 'LUCKY_TOKEN' && secretRow?.scope === 'agent' && secretRow.stored_in === 'machine',
    "the copy's plugin names its secret, and the page will list the name for Bob's machine")
  const bare = await as(bob, `/v1/agents/${source}/copy`, { name: 'release-notes-bare', homeInstanceId: macB, memories: false })
  check(bare.status === 200 && (await teamRows(bare.json.agentId)).length === 0 && bare.json.carried.memories === 0
    && Number((await row('select count(*)::int as n from agent_hooks where agent_id = $1', [bare.json.agentId])).n) === 3,
  "a copy made without the team's memories has none, and has the hooks all the same")
  check(Number((await row('select count(*)::int as n from agent_hooks where agent_id = $1', [source])).n) === 3 && (await teamRows(source)).length === 2
    && (await row('select count(*)::int as n from templates where team_id = (select id from teams where name = $1)', [team])).n === 0,
  "copying changes nothing on the source, and saves no template")

  // What a copy may not do.
  const taken = await as(bob, `/v1/agents/${source}/copy`, { name: 'release-notes-bob', homeInstanceId: macB, memories: false })
  const notName = await as(bob, `/v1/agents/${source}/copy`, { name: 'Not A Name', homeInstanceId: macB, memories: false })
  check(taken.status === 409 && notName.status === 400, `a copy needs a name no agent has, and one that is a name: ${taken.status} ${notName.status}`)
  const onBox = await as(bob, `/v1/agents/${source}/copy`, { name: 'on-alices-box', homeInstanceId: boxA, memories: false })
  check(onBox.status === 403 && /teammate's own/.test(onBox.json?.error) && !(await agentRow('on-alices-box')),
    "a copy cannot go on a teammate's own box, where agents run on that teammate's sign-in")
  const stranger = await as(outsider, `/v1/agents/${source}/copy`, { name: 'taken-from-away', homeInstanceId: macB, memories: true })
  check(stranger.status === 404 && stranger.json?.error === 'no such agent', "a person from another team cannot copy the agent")
  await db.query(`insert into plugins (agent_id, name, kind, config) values ($1, 'leaky', 'stdio', $2)`,
    [source, JSON.stringify({ command: 'node', env: { TOKEN: 'sk-a-real-value-pasted-in' } })])
  const leaky = await as(bob, `/v1/agents/${source}/copy`, { name: 'release-notes-leaky', homeInstanceId: macB, memories: true })
  await db.query(`delete from plugins where agent_id = $1 and name = 'leaky'`, [source])
  check(leaky.status === 409 && !(await agentRow('release-notes-leaky')) && !leaky.text.includes('sk-a-real-value-pasted-in'),
    `a plugin that holds a secret value is not copied, and the answer does not repeat it: ${leaky.status}`)

  // Bob's first message: his machine lacks the plugin's secret, so the copy stops and says which.
  const bobDm = await dmWith(bob, 'release-notes-bob')
  await say(bob, bobDm, 'Are you there?')
  check(await within(30, () => row(`select 1 from sessions s join events e on e.session_id = s.id
    where s.conversation_id = $1 and s.status = 'failed' and e.kind = 'error' and e.text like '%LUCKY_TOKEN%'`, [bobDm])),
  "the copy's session stops on Bob's machine, which has no value for the secret, and names the secret")
  const stopped = await row(`select string_agg(e.text, ' ') as said from sessions s join events e on e.session_id = s.id where s.conversation_id = $1 and e.kind = 'error'`, [bobDm])
  const said: string = stopped?.said ?? ''
  check(said.includes('LUCKY_TOKEN') && !said.includes(ALICE_SECRET) && settingsOf(homeB, copy) === null, "Alice's value did not reach Bob's machine, and no hooks were written there")
  writeFileSync(join(homeB, 'secrets.json'), JSON.stringify({ LUCKY_TOKEN: BOB_SECRET }), { mode: 0o600 })
  await say(bob, bobDm, 'Try again.')
  check(await within(40, async () => (await replies(bobDm)).length === 1), 'with a value of his own set on his machine, the copy answers')
  const bobSession = (await sessionOf(bobDm))?.id
  const plugin = jsonFile(join(homeB, 'sessions', `${bobSession}.mcp.json`))
  check(plugin?.mcpServers.lucky?.env.LUCKY === BOB_SECRET, "the copy's plugin took the secret from Bob's machine")
  const first = await row(`select c.payload from commands c where c.session_id = $1 and c.kind = 'message' order by c.created_at limit 1`, [bobSession])
  const remembered: string = first?.payload.memory ?? ''
  check(remembered.includes(TEAM_PROFILE) && remembered.includes(TEAM_LOG) && !remembered.includes(ABOUT_ALICE) && !remembered.includes(ABOUT_BOB),
    "the copy's sessions start with the team's memories, and with nothing about Alice or Bob that Alice's agent learned")
  check(same(settingsOf(homeB, copy), SETTINGS), "the copy's hooks are written on Bob's machine as they are on Alice's")
  const copyRan = await notices(bobSession)
  check(copyRan.some((n) => n.body.hook_event === 'UserPromptSubmit' && n.text === 'Hook UserPromptSubmit finished.\nnoted-the-prompt')
    && copyRan.some((n) => n.body.hook_event === 'Stop' && n.body.exit_code === 3),
  "the copy's hooks ran in its session, and their runs are in the record")

  // The hooks reach a task's workspace too, and a file a hook writes there is a document.
  const started = await as(bob, '/v1/tasks', { title: 'Write the shipping notes', instructions: 'Put them in a document.', agentId: copy, repoIds: [] })
  const taskId = started.json?.taskId
  check(await within(60, async () => (await rows(`select path from artifacts where task_id = $1 and kind = 'document'`, [taskId])).length === 2),
    `the task the copy works on has two documents, the notes and the hooks' log: ${started.status}`)
  const log = await row(`select v.content from artifacts a join artifact_versions v on v.artifact_id = a.id and v.version = a.current_version
    where a.task_id = $1 and a.path = 'hook-log.txt'`, [taskId])
  const lines: string[] = (log?.content ?? '').split('\n').filter(Boolean)
  const event = lines.length ? JSON.parse(lines[0] ?? '{}') : {}
  check(event.hook_event_name === 'UserPromptSubmit' && /Write the shipping notes/.test(event.prompt ?? '') && lines.includes('a-file-was-written'),
    "a file the hooks wrote in the task's folder is a document: the event Claude Code gave the first hook, and the line the second added after the Write tool")

  // A change to the agent's hooks reaches its running session, and an agent with none has no file.
  // A message sent while a turn runs joins it, so each waits for the answer to the one before.
  const removed = await as(bob, `/v1/agents/${copy}/hooks/stamp-writes/delete`)
  await say(bob, bobDm, 'And now?')
  check(removed.status === 200 && await within(40, async () => same(eventsOf(homeB, copy), ['Stop', 'UserPromptSubmit']) && (await replies(bobDm)).length === 2),
    "taking a hook off the agent takes it from the file of the session that was already running")
  await as(bob, `/v1/agents/${copy}/hooks/check-stop/delete`)
  await as(bob, `/v1/agents/${copy}/hooks/note-prompts/delete`)
  await say(bob, bobDm, 'And again?')
  check(await within(40, async () => settingsOf(homeB, copy) === null && (await replies(bobDm)).length === 3), 'an agent with no hooks has no settings file')

  // Templates keep the hooks and no memory.
  const saved = await as(alice, `/v1/agents/${source}/templates`, { name: 'release notes' })
  const template = await row('select recipe from templates where share_slug = $1', [saved.json?.slug])
  check(saved.status === 200 && template?.recipe.hooks?.length === 3 && same(template.recipe.memories, []),
    'a template saved from the agent keeps its hooks and none of its memories')
  const fromTemplate = await as(bob, '/v1/agents', { name: 'from-template', homeInstanceId: macB, templateSlug: saved.json?.slug })
  const templated = await slice(fromTemplate.json?.agentId)
  check(fromTemplate.status === 200 && same(templated.hooks, from.hooks) && (await teamRows(fromTemplate.json?.agentId)).length === 0,
    'a new agent started from the template has the hooks and no memory')
  const old = { title: 'Old', role: null, instructions: 'Made before hooks.', model: null, skills: [], plugins: [], routines: [] }
  await db.query(`insert into templates (team_id, name, recipe, share_slug) values ((select id from teams where name = $1), 'old', $2, $3)`, [team, JSON.stringify(old), `old-${id}`])
  const fromOld = await as(bob, '/v1/agents', { name: 'from-old', homeInstanceId: macB, templateSlug: `old-${id}` })
  check(fromOld.status === 200 && (await agentRow('from-old'))?.instructions === 'Made before hooks.',
    'a template saved before hooks and memories existed still starts an agent')

  // No secret value is anywhere it must not be.
  const aliceValueAt = await foundInDatabase(db, ALICE_SECRET)
  const bobValueAt = await foundInDatabase(db, BOB_SECRET)
  check(aliceValueAt.length === 0 && bobValueAt.length === 0 && !api.text().includes(ALICE_SECRET) && !api.text().includes(BOB_SECRET),
    `neither machine's secret value is in Postgres or the API's log: ${[...aliceValueAt, ...bobValueAt].join(', ')}`)
  check(filesHolding(homeB, ALICE_SECRET).length === 0, "Alice's secret value is in no file on Bob's machine")
  check(filesHolding(homeA, ALICE_SECRET).length > 0, "Alice's machine does hold it, so the search for it means something")
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await api?.stop()
  await sleep(500)
  if (!failures.length) await db.query('delete from teams where name = any($1)', [[team, otherTeam]]).catch(() => undefined)
  await db.end().catch(() => undefined)
}

console.log(`\n${failures.length ? `${failures.length} failed (teams ${team}, ${otherTeam} kept)` : 'all passed (test teams removed)'}`)
process.exit(failures.length ? 1 : 0)
