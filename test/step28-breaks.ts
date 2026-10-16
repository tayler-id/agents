// Watches step28's and step28b's checks fail. First it runs each check with nothing broken, as a control.
// Then for each break it copies the files the break touches aside, applies its edits (each anchor must be in
// its file exactly once, or nothing is written), runs the check the break names, and confirms that the lines
// it names went red. Last it puts every file back byte for byte and confirms its sha256, and removes the team
// and the folder the red run kept. A run killed midway puts the files back when it next starts. Nothing else
// may run while it does, since the edits are in the tree.
//   node --env-file=.env --env-file=.env.test test/step28-breaks.ts               the controls, then every break
//   node --env-file=.env --env-file=.env.test test/step28-breaks.ts hop-limit     only the breaks named
//   node test/step28-breaks.ts --check                                             each anchor is there once, and nothing runs

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { z } from 'zod'

const ROOT = new URL('..', import.meta.url).pathname
const WORK = join(ROOT, '.scratch', 'verify', 'breaks-28')
const BACKUP = join(WORK, 'backup')
const PENDING = join(WORK, 'pending.json')
// step28 takes about a minute and a half, and step28b in one engine about one. A
// break that leaves a turn waiting is cut off by the checks' own limits, which add up to a few minutes.
const RUN_TIMEOUT_MS = 15 * 60 * 1000

type Edit = { file: string; anchor: string; replace: string }
type CheckName = 'step28' | 'step28b' | 'step28c'
// `red` holds a piece of each check line the break must turn red.
type Break = { name: string; check: CheckName; why: string; red: string[]; edits: Edit[] }

const TEAM_AGENTS = 'server/team-agents.ts'
const RECORD = 'server/record.ts'

const BREAKS: Break[] = [
  // Who may message whom, and how far a chain goes.
  { name: 'other-owner', check: 'step28', why: "an agent messages another person's agent without that person's say", red: ["a message to another person's agent is refused", 'list_agents says whose each agent is'],
    edits: [{ file: TEAM_AGENTS, anchor: "  (caller.owner_id !== null && caller.owner_id === target.owner_id) || target.accepts_agents === 'team'", replace: '  true' }] },
  { name: 'accepts-owner', check: 'step28', why: "anyone on the team opens an agent to other people's agents", red: ["only critic's owner lets other people's agents message it"],
    edits: [{ file: 'server/agents.ts', anchor: "  const decides = agent.owner_id === null ? person.role === 'admin' : agent.owner_id === person.id", replace: '  const decides = true' }] },
  { name: 'hop-limit', check: 'step28', why: 'a chain of agents has no end', red: ['and its message, hop 5, is refused', 'no turn in the team is past hop 4'],
    edits: [{ file: TEAM_AGENTS, anchor: '  if (hops <= MAX_HOPS) return { hops }', replace: '  if (true as boolean) return { hops }' }] },
  { name: 'stop-note', check: 'step28', why: 'a chain stopped at its limit leaves no note where it started', red: ['the DM where the relay started shows one note'],
    edits: [{ file: TEAM_AGENTS, anchor: '  if (turn.origin !== null) {\n    await appendMessage(client, turn.origin, {', replace: '  if (false as boolean) {\n    await appendMessage(client, turn.origin, {' }] },
  { name: 'answer-post', check: 'step28', why: "an answer or a result goes back to the agent only, and the conversation where the work started never shows it", red: ["writer's answer is also a post in Alice's DM", "writer's report on the handed task is also a post"],
    edits: [{ file: 'server/agent-turns.ts', anchor: '  if (waiting.hops !== 0 || waiting.conversationId === null) return\n', replace: '  return\n' }] },
  { name: 'origin-last-hop', check: 'step28', why: "a chain's start is taken to be the conversation of its latest turn, so a stop note lands in an agents thread, even for a chain that started in a task", red: ['the DM where the relay started shows one note', 'no thread between agents got a stop note', 'posted no answer and no stop note anywhere'],
    edits: [{ file: 'server/agent-turns.ts', anchor: 'export const CHAIN_ORIGIN = `coalesce(origin_conversation_id, case when hops = 0 then conversation_id end)`', replace: 'export const CHAIN_ORIGIN = `conversation_id`' }] },
  { name: 'fan-out', check: 'step28', why: 'one turn starts any number of chains', red: ['a turn that tries 6 sends gets 5 through and the 6th refused'],
    edits: [{ file: TEAM_AGENTS, anchor: '  if (sent.n >= MAX_SENDS_PER_TURN) {', replace: '  if (false) {' }] },
  { name: 'room', check: 'step28', why: "an agent in a room messages other agents, and the answer comes back outside the room's turns", red: ['an agent in a room is told it cannot message other agents yet'],
    edits: [{ file: TEAM_AGENTS, anchor: "  if (caller.conversation_kind === 'room') throw new HttpError(409, 'Agents in a room cannot message other agents yet. Say what you need in the room instead.')\n", replace: '' }] },
  // Answers and results going back.
  { name: 'answers-back', check: 'step28', why: "the runner never sends an answer back, so the first agent never hears", red: ["scout carries on with writer's answer"],
    edits: [{ file: 'server/runner.ts', anchor: "        await answerAgentTurns(teams).catch(logged('answers to agents'))\n", replace: '' }] },
  { name: 'answer-sent', check: 'step28', why: 'an answer sent is never marked so, and the runner tries it again on every tick', red: ['placed by the scheduler with a command, done, and answered', 'every turn of the relay ended and sent its answer back'],
    edits: [{ file: 'server/agent-turns.ts', anchor: "  await client.query('update turns set answer_sent_at = now() where id = $1', [turn.id])\n", replace: '' }] },
  { name: 'author-agent', check: 'step28', why: "a message from an agent reaches the other agent's session with no author at all", red: ["writer's prompt is a user event written by scout"],
    edits: [{ file: RECORD, anchor: "  const agent = author !== null && typeof author === 'object' ? author.agent : null", replace: '  const agent = null' }] },
  { name: 'report-once', check: 'step28', why: "a task's result goes back every time its agent reports", red: ["a task's result goes back once"],
    edits: [{ file: TEAM_AGENTS, anchor: "  if (task.done) throw new HttpError(409, 'This task is done, and its result went back already. A person can reopen it.')\n", replace: '' }] },
  { name: 'marked-done', check: 'step28', why: 'a person marking a handed task done tells the agent that handed it nothing', red: ["marking a handed task done sends writer's last words on it to scout"],
    edits: [{ file: 'server/order.ts', anchor: '  await deliverMarkedDone(client, taskId, person.login)\n', replace: '' }] },
  // The ask before a new agent.
  { name: 'create-allowed', check: 'step28', why: 'the daemon lets create_agent run without asking', red: ['making an agent left to ask', 'making an agent waits on an ask in the DM'],
    edits: [{ file: 'shared/team-agents.ts', anchor: "['list_agents', 'send_to_agent', 'delegate_task', 'report_back'].map(tool)", replace: "['list_agents', 'send_to_agent', 'delegate_task', 'report_back', 'create_agent'].map(tool)" }] },
  { name: 'create-unanswered', check: 'step28', why: 'the API makes an agent on an ask nobody has answered', red: ['the API refuses to make an agent with no answered yes behind it'],
    edits: [{ file: TEAM_AGENTS, anchor: "a.status = 'answered'\n       and a.answer->>'decision' = 'allow' and a.answered_by = $3 and not exists",
      replace: "a.status in ('open', 'answered')\n       and coalesce(a.answer->>'decision', 'allow') = 'allow' and (a.answered_by = $3 or a.answered_by is null) and not exists" }] },
  { name: 'create-reused', check: 'step28', why: 'a yes that made an agent makes another', red: ['one yes makes one agent'],
    edits: [{ file: TEAM_AGENTS, anchor: ' and not exists (select 1 from agents g where g.made_by_ask = a.id)', replace: '' }] },
  { name: 'create-owner', check: 'step28', why: 'a teammate says yes to an agent asking for an agent of its owner', red: ['only the owner says yes to a new agent'],
    edits: [{ file: RECORD, anchor: '  if (person?.id !== maker.owner_id) {', replace: '  if (false) {' }] },
  { name: 'create-always', check: 'step28', why: 'Always answers every later ask to make an agent', red: ['only the owner says yes to a new agent, one at a time'],
    edits: [{ file: RECORD, anchor: "  if (decision !== 'allow' && decision !== 'deny') throw new HttpError(400, 'A new agent is approved or denied one at a time, so Always and Never are not offered.')\n", replace: '' }] },
  // What the landing review found: locks, the cap, the machine port and answers that cannot be delivered. They
  // run on a database built by the migrator, with Electric on it, which the environment of this run names.
  { name: 'fanout-row-lock', check: 'step28c', why: "the sender's session row is locked for the fan-out count, so two agents sending to each other at once wait for each other", red: ['messages between pairs of agents'],
    edits: [{ file: TEAM_AGENTS, anchor: "await client.query(`select pg_advisory_xact_lock(hashtext('fanout:' || $1))`, [caller.id])", replace: "await client.query('select 1 from sessions where id = $1 for no key update', [caller.id])" }] },
  { name: 'fanout-no-lock', check: 'step28c', why: 'sends from one turn at the same moment all see the count before any of them is written', red: ['sends from one turn at the same moment'],
    edits: [{ file: TEAM_AGENTS, anchor: "await client.query(`select pg_advisory_xact_lock(hashtext('fanout:' || $1))`, [caller.id])", replace: 'void caller' }] },
  { name: 'pair-lock', check: 'step28c', why: "two agents' first messages to each other at the same moment make two threads", red: ["first messages to each other at the same moment make one thread"],
    edits: [{ file: TEAM_AGENTS, anchor: "  await client.query(`select pg_advisory_xact_lock(hashtext('agents-thread:' || $1 || ':' || $2))`, [first, second])\n", replace: '' }] },
  { name: 'report-lock', check: 'step28c', why: "a report locks its task and a person's message locks the task's session, each in a way the other's foreign keys wait on, so the two deadlock", red: ["a report on each task and a person's message to it"],
    edits: [
      { file: 'server/session-messages.ts', anchor: "team_id = $2 for no key update'", replace: "team_id = $2 for update'" },
      { file: TEAM_AGENTS, anchor: 'where t.id = $1 for no key update of t`', replace: 'where t.id = $1 for update of t`' },
    ] },
  { name: 'send-count', check: 'step28c', why: "an answer passing through a turn counts as one of its sends", red: ["is not one of its sends"],
    edits: [{ file: TEAM_AGENTS, anchor: '(select count(*) from turns where sent_by_turn in (select id from running))', replace: "(select count(*) from turns where answer_to_turn in (select id from running) and source = 'agent')" }] },
  { name: 'tools-scope', check: 'step28c', why: 'a session with no turn running on the machine still gets the agent tools', red: ['gets no agent tools'],
    edits: [{ file: 'server/api.ts', anchor: "  if (!running) throw new HttpError(403, 'agent tools work only in a session with a turn running on this machine')\n", replace: '' }] },
  { name: 'private-send', check: 'step28c', why: "an agent in private work copies it into a thread the team reads", red: ['sends nothing to another agent'],
    edits: [{ file: TEAM_AGENTS, anchor: "  if (caller.visibility === 'private') {", replace: '  if (false as boolean) {' }] },
  { name: 'answer-lost', check: 'step28c', why: 'an answer that cannot be delivered is tried on every tick for good', red: ['cannot be delivered is marked once'],
    edits: [{ file: 'server/agent-turns.ts', anchor: '      if (!isTransient(error)) await tx(', replace: '      if (false as boolean) await tx(' }] },
  { name: 'lock-modes', check: 'step28', why: "the session and conversation locks wait on foreign-key checks again, so sends meeting answers deadlock", red: ['a turn that tries 6 sends'],
    edits: [
      { file: RECORD, anchor: "folder_id, last_seq from sessions where id = $1 for no key update'", replace: "folder_id, last_seq from sessions where id = $1 for update'" },
      { file: RECORD, anchor: "'select team_id, last_seq from conversations where id = $1 for no key update'", replace: "'select team_id, last_seq from conversations where id = $1 for update'" },
      { file: 'server/scheduler.ts', anchor: "select 1 from sessions where id = $1 for no key update', [prompt.sessionId]", replace: "select 1 from sessions where id = $1 for update', [prompt.sessionId]" },
    ] },
  // The two writes that met in a DM.
  { name: 'lock-order', check: 'step28', why: 'a turn that ends locks its session before its conversation, the other way from a post', red: ["a person's post and a turn ending in one DM at once both go through"],
    edits: [{ file: RECORD, anchor: "  if (batch.status === 'failed' || batch.events.some((e) => e.kind === 'usage')) {\n    await client.query('select 1 from conversations where id = (select conversation_id from sessions where id = $1) for no key update', [sessionId])\n  }\n", replace: '' }] },
  // The app.
  { name: 'ui-thread-label', check: 'step28b', why: 'a thread lists as Two agents, not by its agents', red: ['the sidebar lists the thread as'],
    edits: [{ file: 'app/src/data.ts', anchor: "    return pair.length ? pair.join(' and ') : 'Two agents'\n", replace: "    return 'Two agents'\n" }] },
  { name: 'ui-thread-composer', check: 'step28b', why: 'a thread offers a composer people cannot post with', red: ['the thread has no composer'],
    edits: [{ file: 'app/src/Conversation.tsx', anchor: '      {threadName !== null ? <ThreadNote /> : <Composer', replace: '      {false ? <ThreadNote /> : <Composer' }] },
  { name: 'ui-handed-tasks', check: 'step28b', why: 'a task one agent handed another lists nowhere', red: ['the task scout handed writer lists with the tasks'],
    edits: [{ file: 'app/src/App.tsx', anchor: " || t.source === 'agent'))", replace: '))' }] },
  { name: 'ui-choices-owner', check: 'step28b', why: 'everyone gets the choices on an ask only its owner may answer', red: ['Bob reads that the ask waits for Alice, with no button to answer it'],
    edits: [{ file: 'app/src/NewAgentAsk.tsx', anchor: "  const mine = me?.kind === 'member' && me.person.id === answerer.id", replace: "  const mine = me?.kind === 'member'" }] },
  { name: 'ui-switch-owner', check: 'step28b', why: 'everyone gets the switch only the owner may use', red: ["Alice reads that only Bob's agents may message his critic, with nothing to change"],
    edits: [{ file: 'app/src/AgentAccepts.tsx', anchor: "  const decides = agent.owner_id === null ? me.person.role === 'admin' : agent.owner_id === me.person.id", replace: '  const decides = true' }] },
]

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const Pending = z.array(z.object({ file: z.string(), sha: z.string() }))
const at = (file: string) => join(ROOT, file)

// Puts back the files a run that was killed had changed.
function restorePending() {
  if (!existsSync(PENDING)) return
  for (const { file, sha: wanted } of Pending.parse(JSON.parse(readFileSync(PENDING, 'utf8')))) {
    copyFileSync(join(BACKUP, file), at(file))
    if (sha(readFileSync(at(file))) !== wanted) throw new Error(`${file} did not come back as it was`)
    console.log(`restored ${file}, left changed by a run that was killed`)
  }
  rmSync(PENDING)
}

// What each file the break touches would hold with its edits made. Throws, writing nothing, when an anchor is not there exactly once.
function edited(b: Break): Map<string, string> {
  const files = new Map<string, string>()
  for (const edit of b.edits) {
    const text = files.get(edit.file) ?? readFileSync(at(edit.file), 'utf8')
    const found = text.split(edit.anchor).length - 1
    if (found !== 1) throw new Error(`${b.name}: the anchor ${JSON.stringify(edit.anchor)} is in ${edit.file} ${String(found)} times, not once`)
    files.set(edit.file, text.replace(edit.anchor, () => edit.replace))
  }
  return files
}

function runCheck(name: CheckName): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = name === 'step28b' ? { ...process.env, AGENTS_UI_ENGINES: 'chromium' } : process.env
    const child = spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', `test/${name}.ts`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    const timer = setTimeout(() => { child.kill('SIGTERM') }, RUN_TIMEOUT_MS)
    child.once('error', reject)
    child.once('close', () => { clearTimeout(timer); resolve(output) })
  })
}

// A red run keeps its team and its folder to look at. Once its lines are read they go.
async function removeKept(output: string) {
  const kept = /\(team (together-28[bc]?-[0-9a-f]+) kept, files in (\S+)\)/.exec(output)
  if (!kept?.[1] || !kept[2]) return
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  await db.query('delete from teams where name = $1', [kept[1]])
  await db.end()
  rmSync(kept[2], { recursive: true, force: true })
}

const redLines = (output: string) => output.split('\n').filter((line) => line.startsWith('FAIL  '))
const lines = (n: number) => `${String(n)} ${n === 1 ? 'line' : 'lines'}`

async function runBreak(b: Break): Promise<{ ok: boolean; detail: string }> {
  const files = edited(b)
  mkdirSync(BACKUP, { recursive: true })
  const before = [...files.keys()].map((file) => ({ file, sha: sha(readFileSync(at(file))) }))
  for (const { file } of before) {
    mkdirSync(dirname(join(BACKUP, file)), { recursive: true })
    copyFileSync(at(file), join(BACKUP, file))
  }
  writeFileSync(PENDING, JSON.stringify(before))
  let output: string
  try {
    for (const [file, text] of files) writeFileSync(at(file), text)
    output = await runCheck(b.check)
  } finally {
    for (const { file } of before) copyFileSync(join(BACKUP, file), at(file))
  }
  const back = before.filter(({ file, sha: wanted }) => sha(readFileSync(at(file))) !== wanted)
  if (back.length) throw new Error(`${back.map((f) => f.file).join(', ')} did not come back as it was`)
  rmSync(PENDING)
  await removeKept(output)
  const fails = redLines(output)
  const missing = b.red.filter((piece) => !fails.some((line) => line.includes(piece)))
  return {
    ok: missing.length === 0 && fails.length > 0,
    detail: missing.length ? `${lines(fails.length)} went red, and none held "${missing.join('" or "')}". Red: ${fails.map((l) => l.slice(0, 120)).join(' | ')}` : `${lines(fails.length)} went red, and the files are back byte for byte`,
  }
}

const args = process.argv.slice(2)
const only = args.filter((a) => !a.startsWith('--'))
const unknown = only.filter((name) => !BREAKS.some((b) => b.name === name))
if (unknown.length) throw new Error(`no break named ${unknown.join(', ')}. They are ${BREAKS.map((b) => b.name).join(', ')}`)
const chosen = BREAKS.filter((b) => !only.length || only.includes(b.name))

if (args.includes('--check')) {
  for (const b of BREAKS) edited(b)
  console.log(`all ${String(BREAKS.length)} breaks find each anchor once`)
  process.exit(0)
}

restorePending()
let failed = 0
for (const name of [...new Set(chosen.map((b) => b.check))]) {
  const control = redLines(await runCheck(name))
  console.log(`${control.length ? 'FAIL' : 'pass'}  control: ${name} with nothing broken${control.length ? ` has ${String(control.length)} red lines, so no break can be judged` : ' is green'}`)
  if (control.length) process.exit(1)
}
for (const b of chosen) {
  const result = await runBreak(b)
  console.log(`${result.ok ? 'pass' : 'FAIL'}  ${b.name}: ${b.why}. ${result.detail}`)
  if (!result.ok) failed++
}
console.log(`\n${failed ? `${String(failed)} breaks were not seen failing` : `all ${String(chosen.length)} breaks were seen failing, and every file is back as it was`}`)
process.exit(failed ? 1 : 0)
