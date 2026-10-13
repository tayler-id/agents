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

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'

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
// Each start, so a check can see what a process was started with.
appendFileSync(join(state, 'starts.jsonl'), JSON.stringify({ sessionId, resumed: args.includes('--resume'), instructions: flag('--append-system-prompt') ?? '' }) + '\n')
type Rule = { match: string; reply?: string; write?: Record<string, string> }
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

function tool(name: string, input: Record<string, unknown>, result: string, isError = false) {
  const id = `toolu_${randomUUID().slice(0, 8)}`
  emit({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${randomUUID().slice(0, 8)}`, model: 'fake', content: [{ type: 'tool_use', id, name, input }] } })
  emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: isError }] } })
}

function say(text: string) {
  emit({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${randomUUID().slice(0, 8)}`, model: 'fake', content: [{ type: 'text', text }] } })
}

async function turn(text: string) {
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
  say(key ? `Done with this stage (${step.outcome ?? 'no outcome'}).` : rule?.reply ?? 'fake reply')
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
    queue = queue.then(() => turn(typeof content === 'string' ? content : ''))
  } else if (message.type === 'control_request') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } })
  }
}
await queue
