#!/usr/bin/env node
// A stand-in for `claude -p` in stream-json mode, for checks that test the
// factory rather than the model. It follows a scenario file (AGENTS_FAKE_SCENARIO):
// groups of steps, picked by a group name that appears in a run's first prompt,
// such as a word in the bug report's title. Within a group, a pipeline stage's
// steps are keyed by the stage's outcomes joined with commas, one step per try. A
// step can write or edit files, report a result, skip reporting, cost money, or
// fail. Outside a stage, the first of the scenario's `turns` rules whose `match`
// appears in the message decides the reply and any files written, and whether
// the turn takes a screenshot with the computer tool. Otherwise it answers "fake
// reply".
//
// A rule can also append a line to a file through one Bash call, asking a person
// first the way Claude asks before a gated tool. For crash checks it can stop
// once the line is written and before the call's result is printed, and wait to
// be killed. Told about that call by its id after a restart, it reads the file
// before appending again. Each start and everything it receives is logged in
// .fake, with its process id.

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { fakeSetupToken } from './fake-claude-login.ts'

// `claude setup-token`, for the checks of a box's own Claude sign-in.
if (process.argv[2] === 'setup-token') process.exit(await fakeSetupToken())

// A reader's finding, placed by finding `match` in the transcript the prompt
// holds: the step it is on and the session above it. `rule` and `candidate` are
// words of the line that names the rule or candidate meant.
type FakeFinding = {
  match: string; kind: string; quote?: string; rule?: string; candidate?: string
  correction?: string; same?: string; fix?: string; when?: string; note?: string
}
// A writer's hunk, citing every finding whose line in the prompt has any of the
// words in `cite`. `rule` and `after` are words of the rule meant.
type FakeHunk = { op: string; cite: string[]; rule?: string; after?: string; text?: string; name?: string; description?: string; person?: string }

type Step = {
  outcome?: string
  summary?: string
  data?: Record<string, unknown>
  write?: Record<string, string>
  replace?: Record<string, [string, string]>
  // Shell commands run in the session's folder, shown as Bash calls with their real output.
  run?: string[]
  // Decisions logged with the team-record log_decision tool.
  decide?: { what: string; why: string; alternatives?: string[] }[]
  // true: report only when reminded. 'always': never report.
  noReport?: boolean | 'always'
  // Report on the first try only if the prompt says this, the way a model
  // follows a clearer instruction. Otherwise report only when reminded.
  reportOnlyIf?: string
  fail?: boolean
  sleepMs?: number
  cost?: number
  findings?: FakeFinding[]
  hunks?: FakeHunk[]
  // A judge: a correction is fixed when the reply has `fixedIf`, and a turn that
  // went fine is worse when the reply has `worseIf`.
  verdicts?: { fixedIf: string; worseIf?: string }
}

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const cwd = process.cwd()
const state = join(cwd, '.fake')
mkdirSync(state, { recursive: true })
const sessionId = flag('--resume') ?? randomUUID()
const mcpFile = flag('--mcp-config')
const mcpServers = mcpFile ? Object.keys(JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers ?? {}) : []
// Each start, so a check can see what a process was started with. The Claude
// token it was given is kept only as a fingerprint.
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
const tokenSha = token === undefined ? null : createHash('sha256').update(token).digest('hex')
appendFileSync(join(state, 'starts.jsonl'), JSON.stringify({
  sessionId, resumed: args.includes('--resume'), instructions: flag('--append-system-prompt') ?? '', tokenSha, pid: process.pid, maxBudgetUsd: flag('--max-budget-usd') ?? null,
  model: flag('--model') ?? null, allowedTools: flag('--allowedTools') ?? '', mcpServers, permissionMode: flag('--permission-mode') ?? null,
}) + '\n')
type Append = {
  // The call's tool_use id. Random when unset.
  id?: string
  file: string
  line: string
  // Ask a person before the line is written.
  ask?: boolean
  // The first time this rule runs in this folder, stop after writing the line and
  // before printing the call's result.
  hangOnce?: boolean
  // When the message names this call's id, read the file first, and leave it
  // alone if the line is there.
  checkNamed?: boolean
  // Make the call only the first time this rule runs in this folder, as a resumed
  // session might decide not to ask again.
  askOnce?: boolean
  // Exit while the approval waits, before the call has a result.
  dieAsking?: boolean
}
// `hang` stops the turn when the rule matches, as if the model never finished.
// `replyIf` answers differently when the session's instructions have these
// words, the way an agent follows what it was told.
type Rule = {
  match: string; reply?: string; replyIf?: Record<string, string>; write?: Record<string, string>; append?: Append; hang?: boolean; screenshot?: boolean
}
const scenario: Record<string, Record<string, Step[]>> & { turns?: Rule[] } = process.env.AGENTS_FAKE_SCENARIO
  ? JSON.parse(readFileSync(process.env.AGENTS_FAKE_SCENARIO, 'utf8')) : {}

// Each workspace is one run, so the group it picks first sticks for the run.
function group(text: string): Record<string, Step[]> {
  const file = join(state, 'group')
  // The name that comes first in the prompt, so other issues listed later don't count.
  const named = Object.keys(scenario).filter((name) => name !== 'turns' && text.includes(name)).sort((a, b) => text.indexOf(a) - text.indexOf(b))
  if (!existsSync(file)) writeFileSync(file, named[0] ?? 'default')
  return scenario[readFileSync(file, 'utf8')] ?? {}
}

// The stage's outcomes, from the stage server in the MCP config.
const outcomes: string[] = mcpFile ? JSON.parse(JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers?.stage?.env?.AGENTS_STAGE_OUTCOMES ?? '[]') : []
const key = outcomes.join(',')

const emit = (line: Record<string, unknown>) => process.stdout.write(JSON.stringify({ session_id: sessionId, uuid: randomUUID(), ...line }) + '\n')
const counter = (name: string) => {
  const file = join(state, name)
  const n = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0
  writeFileSync(file, String(n + 1))
  return n
}
const costFile = join(state, `${sessionId}.cost`)

const received = (entry: Record<string, unknown>) =>
  appendFileSync(join(state, 'received.jsonl'), JSON.stringify({ pid: process.pid, sessionId, ...entry }) + '\n')

function callStart(id: string, name: string, input: Record<string, unknown>) {
  emit({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${randomUUID().slice(0, 8)}`, model: 'fake', content: [{ type: 'tool_use', id, name, input }] } })
}

function callResult(id: string, result: string, isError = false) {
  emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: isError }] } })
}

function tool(name: string, input: Record<string, unknown>, result: string, isError = false) {
  const id = `toolu_${randomUUID().slice(0, 8)}`
  callStart(id, name, input)
  callResult(id, result, isError)
}

// Permission requests waiting for the daemon's answer, by request id.
type Decision = { behavior: 'allow' | 'deny'; message?: string }
const waiting = new Map<string, (decision: Decision) => void>()

function askPerson(toolUseId: string, input: Record<string, unknown>): Promise<Decision> {
  const requestId = randomUUID()
  emit({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', input, tool_use_id: toolUseId, description: input.description } })
  return new Promise((resolve) => waiting.set(requestId, resolve))
}

// Stays alive, as Claude does mid-turn, until something kills it.
const hang = () => new Promise<never>(() => { setInterval(() => undefined, 60_000) })

// Appends the rule's line through one Bash call. Returns what to say instead of
// the rule's reply, or null.
async function appendLine(text: string, append: Append): Promise<string | null> {
  const file = join(cwd, append.file)
  if (append.askOnce && counter(`asked-${append.file}`) > 0) return `I left ${append.file} alone.`
  if (append.checkNamed && append.id && text.includes(append.id)) {
    const readId = `toolu_${randomUUID().slice(0, 8)}`
    const content = existsSync(file) ? readFileSync(file, 'utf8') : ''
    callStart(readId, 'Read', { file_path: file })
    callResult(readId, content)
    if (content.split('\n').includes(append.line)) return `${append.file} already has ${append.line}, so I left it alone.`
  }
  const id = append.id ?? `toolu_${randomUUID().slice(0, 8)}`
  const input = { command: `echo ${append.line} >> ${append.file}`, description: `Append ${append.line} to ${append.file}` }
  callStart(id, 'Bash', input)
  if (append.ask) {
    const asking = askPerson(id, input)
    if (append.dieAsking) {
      // On macOS a pipe write is still in flight when the call returns.
      await new Promise((resolve) => process.stdout.write('', resolve))
      process.stderr.write('fake claude died while a person was asked\n')
      process.exit(3)
    }
    const decision = await asking
    if (decision.behavior === 'deny') {
      callResult(id, decision.message ?? 'A person denied this.', true)
      return `A person denied appending to ${append.file}.`
    }
  }
  appendFileSync(file, `${append.line}\n`)
  if (append.hangOnce && counter(`hang-${append.file}`) === 0) await hang()
  callResult(id, '')
  return null
}

// A 1x1 PNG, standing in for a screenshot.
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

// A computer-tool screenshot, printed the way Claude Code 2.1.296 prints an MCP
// tool's image: in the tool result and again in the line's tool_use_result.
function screenshot() {
  const id = `toolu_${randomUUID().slice(0, 8)}`
  const content = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXEL_PNG } }, { type: 'text', text: 'Screen 1x1.' }]
  emit({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${randomUUID().slice(0, 8)}`, model: 'fake', content: [{ type: 'tool_use', id, name: 'mcp__computer__computer', input: { action: 'screenshot' } }] } })
  emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, tool_use_result: content })
}

function say(text: string) {
  emit({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${randomUUID().slice(0, 8)}`, model: 'fake', content: [{ type: 'text', text }] } })
}

// Where words appear in a transcript: the step whose line holds them, and the
// session that step is under.
function locate(prompt: string, words: string): { session: string; step: number } | null {
  const lines = prompt.split('\n')
  let step: number | null = null
  for (let i = lines.findIndex((l) => l.includes(words)); i >= 0; i--) {
    const line = lines[i] ?? ''
    const numbered = /^(\d+)\. /.exec(line)
    if (step === null && numbered) step = Number(numbered[1])
    const session = /^session ([0-9a-f-]{36}) /.exec(line)?.[1]
    if (session && step !== null) return { session, step }
  }
  return null
}

// The id on the first line naming a rule or candidate whose text has these words.
const idOf = (prompt: string, kind: 'rule' | 'candidate', words: string | undefined) => words === undefined ? undefined
  : prompt.split('\n').find((l) => l.startsWith(`${kind} `) && l.includes(words))?.split(/[ :]/)[1]

function findingsIn(prompt: string, wanted: FakeFinding[]) {
  return wanted.flatMap((f) => {
    const at = locate(prompt, f.match)
    if (!at) return []
    const { match, rule, candidate, ...rest } = f
    return [{ ...rest, ...at, quote: f.quote ?? match, rule: idOf(prompt, 'rule', rule), candidate: idOf(prompt, 'candidate', candidate) }]
  })
}

function hunksIn(prompt: string, wanted: FakeHunk[]) {
  const findings = (words: string[]) => prompt.split('\n').flatMap((line) => {
    const id = /^\s*finding ([0-9a-f-]{36}) /.exec(line)?.[1]
    return id && words.some((w) => line.includes(w)) ? [id] : []
  })
  return wanted.map(({ cite, rule, after, ...rest }) => ({ ...rest, rule: idOf(prompt, 'rule', rule), after: idOf(prompt, 'rule', after), findings: findings(cite) }))
}

function verdictsIn(prompt: string, { fixedIf, worseIf }: { fixedIf: string; worseIf?: string }) {
  const verdicts: Record<string, string> = {}
  for (const block of prompt.split(/\n(?=replay R\d+ · )/)) {
    const head = /^replay (R\d+) · (a correction|went fine before)/.exec(block)
    if (!head?.[1]) continue
    const reply = block.split('\nThe reply:\n')[1] ?? ''
    verdicts[head[1]] = head[2] === 'a correction' ? (reply.includes(fixedIf) ? 'fixed' : 'still') : (worseIf && reply.includes(worseIf) ? 'worse' : 'ok')
  }
  return verdicts
}

// With --replay-user-messages, Claude prints each message back, with the uuid it
// was sent with, when a turn takes it in.
const replays = args.includes('--replay-user-messages')

async function turn(text: string, uuid: string | undefined) {
  if (replays) emit({ type: 'user', isReplay: true, uuid: uuid ?? randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: text } })
  emit({ type: 'system', subtype: 'init', cwd, tools: [], model: 'fake' })
  let step: Step = {}
  const nudge = text.startsWith('You ended your turn without calling report_result')
  if (key) {
    const steps = group(text)[key] ?? []
    // A reminder belongs to the try before it, so it reuses that step without its edits.
    const index = nudge ? Number(readFileSync(join(state, `${key}.last`), 'utf8')) : counter(`${key}.count`)
    writeFileSync(join(state, `${key}.last`), String(index))
    step = steps[Math.min(index, steps.length - 1)] ?? {}
    if (nudge) step = { outcome: step.noReport === 'always' ? undefined : step.outcome, summary: step.summary, data: step.data }
  }
  const rule = key ? undefined : scenario.turns?.find((r) => text.includes(r.match))
  if (rule?.write) step = { write: rule.write }
  if (step.sleepMs) await sleep(step.sleepMs)
  if (step.fail) {
    process.stderr.write('fake claude was told to fail\n')
    process.exit(3)
  }
  if (rule?.hang) await hang()
  const note = rule?.append ? await appendLine(text, rule.append) : null
  for (const [path, content] of Object.entries(step.write ?? {})) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), content)
    tool('Write', { file_path: join(cwd, path), content }, `Wrote ${path}`)
  }
  for (const [path, [from, to]] of Object.entries(step.replace ?? {})) {
    const file = join(cwd, path)
    writeFileSync(file, readFileSync(file, 'utf8').replace(from, to))
    tool('Edit', { file_path: file, old_string: from, new_string: to }, `Edited ${path}`)
  }
  for (const command of step.run ?? []) {
    const ran = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8' })
    tool('Bash', { command }, `${ran.stdout}${ran.stderr}`.trim() || `exit ${ran.status ?? 'none'}`, ran.status !== 0)
  }
  for (const decision of step.decide ?? []) tool('mcp__team-record__log_decision', decision, 'Logged in the decision log.')
  if (rule?.screenshot) screenshot()
  const holdsBack = step.noReport || (step.reportOnlyIf !== undefined && !text.includes(step.reportOnlyIf))
  if (key && step.outcome && !(holdsBack && !nudge)) {
    const data = {
      ...step.data,
      ...(step.findings ? { findings: findingsIn(text, step.findings), merges: [] } : {}),
      ...(step.hunks ? { hunks: hunksIn(text, step.hunks) } : {}),
      ...(step.verdicts ? { verdicts: verdictsIn(text, step.verdicts) } : {}),
    }
    tool('mcp__stage__report_result', { outcome: step.outcome, summary: step.summary ?? `fake ${step.outcome}`, data }, `Recorded ${step.outcome}.`)
  }
  const instructions = flag('--append-system-prompt') ?? ''
  const told = Object.entries(rule?.replyIf ?? {}).find(([words]) => instructions.includes(words))?.[1]
  say(key ? `Done with this stage (${step.outcome ?? 'no outcome'}).` : note ?? told ?? rule?.reply ?? 'fake reply')
  const cost = (existsSync(costFile) ? Number(readFileSync(costFile, 'utf8')) : 0) + (step.cost ?? 0.01)
  writeFileSync(costFile, String(cost))
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: cost })
}

let queue = Promise.resolve()
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue
  const message = JSON.parse(line)
  if (message.type === 'user') {
    const content = message.message?.content
    const text = typeof content === 'string' ? content : ''
    received({ kind: 'message', text })
    const uuid = typeof message.uuid === 'string' ? message.uuid : undefined
    queue = queue.then(() => turn(text, uuid))
  } else if (message.type === 'control_request') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } })
  } else if (message.type === 'control_response') {
    const { request_id: requestId, response: decision } = message.response ?? {}
    received({ kind: 'answer', requestId, behavior: decision?.behavior })
    waiting.get(requestId)?.(decision)
    waiting.delete(requestId)
  }
}
await queue
