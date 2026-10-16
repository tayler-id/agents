// Agent hooks with the real Claude Code, step 7's check that the stand-in for Claude is not the only
// thing that has run them. The daemon starts the real `claude`, which talks to a stand-in for the
// Anthropic API (test/fake-anthropic.ts) that never reaches a model, so nothing is spent and no
// sign-in is used. An agent has hooks for six moments of a turn. A task makes the agent write a file,
// and the check reads what Claude Code did with them from the record. Each hook runs when its event
// happens, in Claude Code's own order and under its own names, with the input Claude Code gives it. A
// hook with another tool's name does not run. The runs are notices in the session's record. A file a
// hook writes in the task's folder is a document. A change to the hooks restarts the session on the
// next message, and Claude Code reports the new start as a resume.
//   node --env-file=.env --env-file=.env.test test/step24d.ts

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { fakeAnthropic } from './fake-anthropic.ts'
import { asPerson, results, ROOT, startApi, within } from './onboarding-kit.ts'
import { must } from './must.ts'

const PORTS = { machines: 7893, people: 7993, streams: 7896 }
const API = `http://127.0.0.1:${PORTS.machines}`
const PEOPLE = `http://127.0.0.1:${PORTS.people}`
const id = randomBytes(4).toString('hex')
const team = `step24d-${id}`
const alice = `alice24d-${id}@local`
const NOTES = 'Shipping notes go here.\n'

// A hook that logs the event Claude Code gives it appends one line of JSON to a file in the task's
// folder, which becomes a document. The Write hook after the tool exits 3, which Claude Code reports as
// an error and goes on. The hook for Bash must never run, since the agent calls no Bash.
const LOG = 'task/hook-log.txt'
const logging = (rest = '') => `{ cat; echo; } >> ${LOG}${rest}`
const STARTED = { name: 'started', event: 'SessionStart', matcher: null, command: 'echo started-up', timeoutSec: null }
const PROMPT = { name: 'note-prompts', event: 'UserPromptSubmit', matcher: null, command: `mkdir -p task && ${logging(' && echo noted-the-prompt')}`, timeoutSec: 20 }
const BEFORE = { name: 'check-writes', event: 'PreToolUse', matcher: 'Write', command: logging(), timeoutSec: null }
const AFTER = { name: 'stamp-writes', event: 'PostToolUse', matcher: 'Write', command: logging('; echo wrote-it >&2; exit 3'), timeoutSec: null }
const OTHER = { name: 'skip-bash', event: 'PostToolUse', matcher: 'Bash', command: 'echo should-not-run >> task/hook-log.txt', timeoutSec: null }
const FINISH = { name: 'finish', event: 'Stop', matcher: null, command: logging(' && echo stopping'), timeoutSec: null }
const HOOKS = [STARTED, PROMPT, BEFORE, AFTER, OTHER, FINISH]
// What the daemon writes for them where Claude Code reads hooks, in the order of the hooks' names.
const command = (hook: { command: string }, timeout?: number) => ({ type: 'command', command: hook.command, ...(timeout === undefined ? {} : { timeout }) })
const SETTINGS = {
  hooks: {
    PreToolUse: [{ matcher: 'Write', hooks: [command(BEFORE)] }],
    Stop: [{ hooks: [command(FINISH)] }],
    UserPromptSubmit: [{ hooks: [command(PROMPT, 20)] }],
    PostToolUse: [{ matcher: 'Bash', hooks: [command(OTHER)] }, { matcher: 'Write', hooks: [command(AFTER)] }],
    SessionStart: [{ hooks: [command(STARTED)] }],
  },
}
const { Stop: _stopped, ...WITHOUT_STOP } = SETTINGS.hooks

const RULES = [
  { match: 'Write the shipping notes', say: 'Wrote the notes.', write: { file: 'task/notes.md', content: NOTES } },
  { match: 'Add a line about speed', say: 'Added it.' },
]

const { failures, check } = results()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows
const row = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
const as = (method: string, path: string, body?: unknown) => asPerson(PEOPLE, alice, method, path, body)
const same = isDeepStrictEqual
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step24d-')))
let daemon: ChildProcess | null = null
let api: Awaited<ReturnType<typeof startApi>> | null = null
let standIn: Awaited<ReturnType<typeof fakeAnthropic>> | null = null

type EventRow = { seq: string; kind: string; tool_name: string | null; text: string | null; body: Record<string, unknown> }
const eventsOf = (sessionId: string) => rows('select seq, kind, tool_name, text, body from events where session_id = $1 order by seq', [sessionId]) as Promise<EventRow[]>
// Each hook run the record holds, as a notice's first line and the lines it printed.
const hookRuns = (events: EventRow[]) => events.filter((e) => e.body.subtype === 'hook_response').map((e) => ({ seq: Number(e.seq), name: String(e.body.hook_name), text: e.text ?? '', outcome: e.body.outcome, exit: e.body.exit_code }))
const turnsOf = (events: EventRow[]) => events.filter((e) => e.kind === 'usage').length
const namesOf = (events: EventRow[]) => hookRuns(events).map((run) => run.name)

// The lines the hooks logged in the task's folder, as the document the record holds.
async function loggedLines(taskId: string): Promise<{ lines: string[]; inputs: Record<string, any>[] }> {
  const doc = await row(`select v.content from artifacts a join artifact_versions v on v.artifact_id = a.id and v.version = a.current_version
    where a.task_id = $1 and a.path = 'hook-log.txt'`, [taskId])
  const lines: string[] = (doc?.content ?? '').split('\n').filter(Boolean)
  return { lines, inputs: lines.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Record<string, any>) }
}

process.on('SIGTERM', () => {
  daemon?.kill('SIGTERM')
  process.exit(1)
})

try {
  // The real CLI, or nothing to check.
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8' })
  check(version.status === 0, `the real claude CLI is on the path: ${version.status === 0 ? version.stdout.trim() : String(version.error?.message)}`)
  if (version.status !== 0) throw new Error('claude is not on the PATH, so there is no Claude Code to run the hooks')
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, alice)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', alice))
  const machine = must(await row('select id from instances where name = $1', [`mac-${id}`]), 'the machine').id
  api = await startApi(PORTS, { AGENTS_RUNNER_TEAMS: team }, join(home, 'streams'))
  check(await within(20, () => fetch(API).then(() => true, () => false)), 'the API starts')
  standIn = await fakeAnthropic(RULES)

  const made = await as('POST', '/v1/agents', { name: 'release-notes', homeInstanceId: machine, title: 'Writes release notes', instructions: 'You write release notes.' })
  const agent = must(made.json?.agentId, 'the agent')
  for (const hook of HOOKS) await as('POST', `/v1/agents/${agent}/hooks`, hook)
  check(Number((await row('select count(*)::int as n from agent_hooks where agent_id = $1', [agent])).n) === HOOKS.length, `the agent has its ${HOOKS.length} hooks`)

  // The daemon runs the real claude, which is sent to the stand-in API with a key that belongs to nobody
  // and a settings folder of its own. Nothing reaches Anthropic, and no sign-in of the person's is read.
  const env = { ...process.env }
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'AGENTS_CLAUDE_BIN']) delete env[name]
  daemon = spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home,
      ANTHROPIC_BASE_URL: standIn.url, ANTHROPIC_API_KEY: `sk-ant-api03-${randomBytes(24).toString('hex')}`, CLAUDE_CONFIG_DIR: join(home, 'claude'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    },
  })
  check(await within(30, async () => (await row('select status from instances where id = $1', [machine]))?.status === 'online'), "the machine's daemon is online")

  // A task: the agent writes a file, with the hooks around the prompt, the tool and the end of the turn.
  const started = await as('POST', '/v1/tasks', { title: 'Write the shipping notes', instructions: 'Put them in a document.', agentId: agent, repoIds: [] })
  const taskId = must(started.json?.taskId, 'the task')
  const sessionId = must(started.json?.sessionId, "the task's session")
  check(await within(60, async () => turnsOf(await eventsOf(sessionId)) === 1), `the real Claude Code answers the task: ${started.status}`)
  const first = await eventsOf(sessionId)
  const runs = hookRuns(first)
  check(same(namesOf(first), ['SessionStart:startup', 'UserPromptSubmit', 'PreToolUse:Write', 'PostToolUse:Write', 'Stop']),
    `each hook ran under Claude Code's own name, in its order, and the one for Bash did not: ${namesOf(first).join(' > ')}`)
  const text = (name: string) => runs.find((run) => run.name === name)?.text
  check(text('SessionStart:startup') === 'Hook SessionStart:startup finished.\nstarted-up' && text('UserPromptSubmit') === 'Hook UserPromptSubmit finished.\nnoted-the-prompt'
    && text('PreToolUse:Write') === 'Hook PreToolUse:Write finished.' && text('Stop') === 'Hook Stop finished.\nstopping',
  `each run is a notice that says what the hook did and printed: ${JSON.stringify(runs.map((run) => run.text))}`)
  const post = runs.find((run) => run.name === 'PostToolUse:Write')
  check(post?.text === 'Hook PostToolUse:Write failed with exit code 3.\nwrote-it' && post.outcome === 'error' && post.exit === 3,
    `a hook that exits 3 is a notice with its exit code and what it said, and the turn went on: ${JSON.stringify(post?.text)}`)

  // The record keeps the order Claude Code printed: the tool call, the hooks around it, then the tool's result.
  const call = first.find((e) => e.kind === 'tool_call' && e.tool_name === 'Write')
  const result = first.find((e) => e.kind === 'tool_result')
  const [before, after] = [runs.find((run) => run.name === 'PreToolUse:Write'), post]
  check(call && result && before && after && Number(call.seq) < before.seq && before.seq < after.seq && after.seq < Number(result.seq),
    'the record has the tool call, its two hooks, then its result, as Claude Code printed them')
  const stop = runs.find((run) => run.name === 'Stop')
  check(stop && result && stop.seq > Number(result.seq), "the Stop hook's notice comes after the tool's result, in the turn's last moments")

  // What the hooks did to the task's folder is in the record as documents, and each saw Claude Code's own input.
  check(await within(30, async () => (await rows(`select path from artifacts where task_id = $1 and kind = 'document' order by path`, [taskId])).map((r) => r.path).join() === 'hook-log.txt,notes.md'),
    'the file the agent wrote and the file the hooks wrote are both documents of the task')
  const notes = await row(`select v.content from artifacts a join artifact_versions v on v.artifact_id = a.id and v.version = a.current_version where a.task_id = $1 and a.path = 'notes.md'`, [taskId])
  check(notes?.content === NOTES, "the agent's file holds what the stand-in API told it to write")
  const log = await loggedLines(taskId)
  const input = (event: string) => log.inputs.find((i) => i.hook_event_name === event)
  const [prompt, pre, postInput, finish] = [input('UserPromptSubmit'), input('PreToolUse'), input('PostToolUse'), input('Stop')]
  check(!log.lines.includes('should-not-run') && log.inputs.length === 4, `the hook for Bash left nothing in the log, and the four others each logged their input: ${log.inputs.length} inputs`)
  check(prompt && /Write the shipping notes/.test(prompt.prompt) && prompt.permission_mode === 'acceptEdits' && typeof prompt.prompt_id === 'string'
    && typeof prompt.session_id === 'string' && typeof prompt.transcript_path === 'string' && typeof prompt.cwd === 'string',
  'the prompt hook got the message, the permission mode, and the ids of the session and the turn')
  check(pre?.tool_name === 'Write' && pre.tool_input.file_path === join(String(pre.cwd), 'task', 'notes.md') && pre.tool_input.content === NOTES && typeof pre.tool_use_id === 'string',
    'the hook before the tool got its name, its input and its id')
  check(postInput?.tool_name === 'Write' && postInput.tool_response?.type === 'create' && postInput.tool_use_id === pre?.tool_use_id,
    "the hook after the tool got Claude Code's own account of what Write did, and the same tool id")
  check(finish?.stop_hook_active === false && finish.last_assistant_message === 'Wrote the notes.',
    "the Stop hook got the agent's last words")
  check(new Set([prompt, pre, postInput, finish].map((i) => i?.prompt_id)).size === 1 && new Set([prompt, pre, postInput, finish].map((i) => i?.session_id)).size === 1,
    "all four hooks saw one turn's id and one session's id")
  const workspace = must(await row('select id from workspaces where task_id = $1', [taskId]), "the task's workspace").id
  const settingsFile = join(home, 'sessions', `${sessionId}.settings.json`)
  check(existsSync(settingsFile) && same(JSON.parse(readFileSync(settingsFile, 'utf8')), SETTINGS), "the daemon wrote the hooks into the session's own settings file, which Claude Code read, with their matchers and time limits")
  check(!existsSync(join(home, 'workspaces', String(workspace), '.claude', 'settings.local.json')),
    "and nothing into the task's workspace, which another session, such as a judge's, may share")

  // A change to the agent's hooks restarts its session on the next message, as a resume.
  const removed = await as('POST', `/v1/agents/${agent}/hooks/finish/delete`)
  const said = await as('POST', `/v1/sessions/${sessionId}/messages`, { text: 'Add a line about speed.' })
  check(removed.status === 200 && said.status === 200 && await within(60, async () => turnsOf(await eventsOf(sessionId)) === 2), 'with a hook taken off, the next message gets its answer')
  const second = await eventsOf(sessionId)
  const later = namesOf(second).slice(namesOf(first).length)
  check(same(later, ['SessionStart:resume', 'UserPromptSubmit']),
    `the restarted session was a resume as Claude Code reports it, ran the hooks it still has, and ran no Stop hook: ${later.join(' > ')}`)
  check((await loggedLines(taskId)).inputs.filter((i) => i.hook_event_name === 'UserPromptSubmit').length === 2, 'the prompt hook logged the second message too')
  check(same(JSON.parse(readFileSync(settingsFile, 'utf8')), { hooks: WITHOUT_STOP }), 'the restart wrote the file again without the hook that was taken off')
  check(standIn.problems.length === 0, `the stand-in API answered every request: ${standIn.problems.join('; ')}`)
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  daemon?.kill('SIGTERM')
  await standIn?.stop()
  await api?.stop()
  await sleep(500)
  if (!failures.length) await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
  await db.end().catch(() => undefined)
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test team removed)'}`)
process.exit(failures.length ? 1 : 0)
