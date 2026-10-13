#!/usr/bin/env node
// A stand-in for `claude -p` in stream-json mode, for checks that test the
// factory rather than the model. It follows a scenario file (AGENTS_FAKE_SCENARIO):
// groups of steps, picked by a group name that appears in a run's first prompt,
// such as a word in the bug report's title. Within a group, a pipeline stage's
// steps are keyed by the stage's outcomes joined with commas, one step per try. A
// step can write or edit files, report a result, skip reporting, cost money, or
// fail. Outside a stage, the first of the scenario's `turns` rules whose `match`
// appears in the message decides the reply and any files written. Otherwise it
// answers "fake reply".
//
// A rule can also append a line to a file through one Bash call, asking a person
// first the way Claude asks before a gated tool. For crash checks it can stop
// once the line is written and before the call's result is printed, and wait to
// be killed. Told about that call by its id after a restart, it reads the file
// before appending again. Each start and everything it receives is logged in
// .fake, with its process id.

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { fakeSetupToken } from './fake-claude-login.ts'

// `claude setup-token`, for the checks of a box's own Claude sign-in.
if (process.argv[2] === 'setup-token') process.exit(await fakeSetupToken())

type Step = {
  outcome?: string
  summary?: string
  data?: Record<string, unknown>
  write?: Record<string, string>
  replace?: Record<string, [string, string]>
  // true: report only when reminded. 'always': never report.
  noReport?: boolean | 'always'
  // Report on the first try only if the prompt says this, the way a model
  // follows a clearer instruction. Otherwise report only when reminded.
  reportOnlyIf?: string
  fail?: boolean
  sleepMs?: number
  cost?: number
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
// Each start, so a check can see what a process was started with. The Claude
// token it was given is kept only as a fingerprint.
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
const tokenSha = token === undefined ? null : createHash('sha256').update(token).digest('hex')
appendFileSync(join(state, 'starts.jsonl'), JSON.stringify({ sessionId, resumed: args.includes('--resume'), instructions: flag('--append-system-prompt') ?? '', tokenSha, pid: process.pid }) + '\n')
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
}
type Rule = { match: string; reply?: string; write?: Record<string, string>; append?: Append }
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
const mcp = flag('--mcp-config')
const outcomes: string[] = mcp ? JSON.parse(JSON.parse(readFileSync(mcp, 'utf8')).mcpServers?.stage?.env?.AGENTS_STAGE_OUTCOMES ?? '[]') : []
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
    const decision = await askPerson(id, input)
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

function say(text: string) {
  emit({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${randomUUID().slice(0, 8)}`, model: 'fake', content: [{ type: 'text', text }] } })
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
  const holdsBack = step.noReport || (step.reportOnlyIf !== undefined && !text.includes(step.reportOnlyIf))
  if (key && step.outcome && !(holdsBack && !nudge)) {
    tool('mcp__stage__report_result', { outcome: step.outcome, summary: step.summary ?? `fake ${step.outcome}`, data: step.data ?? {} }, `Recorded ${step.outcome}.`)
  }
  say(key ? `Done with this stage (${step.outcome ?? 'no outcome'}).` : note ?? rule?.reply ?? 'fake reply')
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
