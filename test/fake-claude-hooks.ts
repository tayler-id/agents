#!/usr/bin/env node
// The stand-in for `claude -p`, test/fake-claude.ts, with Claude Code's hooks. Claude Code
// reads the hooks in .claude/settings.json and .claude/settings.local.json of its folder, and
// in the file --settings names, which is where Agents puts a session's hooks. It
// runs a hook's command when its event happens, and gives the command the event as JSON on
// its standard input. This runs the stand-in as it is and does that around it, so a check
// can watch a turn with hooks on, with no model and no Claude Code.
//
// What it copies was seen by running Claude Code 2.1.301 through a turn with a tool call
// against a stand-in for the Anthropic API (test/fake-anthropic.ts, which step24d drives
// through the daemon). Each hook prints hook_started and hook_response lines, named
// SessionStart:startup, UserPromptSubmit, PostToolUse:<tool> and Stop. The order is
// SessionStart, UserPromptSubmit, the tool call, its PostToolUse hooks, the tool's result,
// then the Stop hooks before the turn's result. A hook's matcher is a pattern for the
// tool's whole name. A hook that exits 0 succeeds, one that exits another number is an
// error that carries on, and one that runs past its time limit is cancelled with exit
// code 1. SessionStart prints its lines always, and the others only with
// --include-hook-events.
//
// It stops with an error, where Claude Code would go on differently, so that a check never
// passes on a hook that did not do what it says. That is a hook that exits 2, which blocks
// the tool or the turn, and an event it does not run: PreToolUse, which no check here
// needs it for, and SubagentStop, since the stand-in runs no subagent. step24d covers both
// with the real Claude Code. It leaves out what no check reads: the `effort`,
// `background_tasks` and `session_crons` fields of an input, a PostToolUse input's
// `duration_ms`, and the tool response of any tool but Write, which is the result's text
// here and an object there.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough, Writable } from 'node:stream'
import { z } from 'zod'

const MODELLED = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']
// How long a hook that names no limit runs before it is cancelled. Claude Code 2.1.301 cancelled a
// UserPromptSubmit hook after 30 seconds, and let a hook of each other event run past 130, so 600 stands
// for those, and no check waits that long.
const defaultLimit = (event: string) => (event === 'UserPromptSubmit' ? 30 : 600)
// What Claude Code reports for a hook it cancelled.
const CANCELLED_EXIT_CODE = 1
// What a hook's exit code means when it blocks the tool, the prompt or the stop.
const BLOCKING_EXIT_CODE = 2

const Settings = z.object({
  hooks: z.record(z.string(), z.array(z.object({
    matcher: z.string().optional(),
    hooks: z.array(z.object({ type: z.literal('command'), command: z.string(), timeout: z.number().optional() })),
  }))).default({}),
})
type Settings = z.infer<typeof Settings>

const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const resume = flag('--resume')
const sessionId = resume ?? randomUUID()
const reportAll = args.includes('--include-hook-events')
const permissionMode = flag('--permission-mode') ?? 'default'
const cwd = process.cwd()

// The hooks of the folder's two settings files and of the file --settings names, as Claude Code merges them.
function settings(): Settings['hooks'] {
  const merged: Settings['hooks'] = {}
  const given = flag('--settings')
  for (const file of [join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'), ...(given ? [given] : [])]) {
    if (!existsSync(file)) continue
    const read = Settings.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    if (!read.success) throw new Error(`${file} is not a settings file this stand-in reads: ${z.prettifyError(read.error)}`)
    for (const [event, groups] of Object.entries(read.data.hooks)) merged[event] = [...(merged[event] ?? []), ...groups]
  }
  return merged
}

// Stops the run with a reason the daemon records as the session's failure.
function refuse(why: string): never {
  process.stderr.write(`fake-claude-hooks: ${why}\n`)
  process.exit(2)
}

const hooks = settings()
const unmodelled = Object.keys(hooks).filter((event) => !MODELLED.includes(event))
if (unmodelled.length) refuse(`${unmodelled.join(', ')} hooks are not modelled, so this run would not run them`)

const realStdout = process.stdout
const realStdin = process.stdin
const print = (line: Record<string, unknown>) => new Promise<void>((resolve) => {
  realStdout.write(`${JSON.stringify({ ...line, uuid: randomUUID(), session_id: sessionId })}\n`, () => { resolve() })
})

type Ran = { stdout: string; stderr: string; code: number; timedOut: boolean }
function execute(command: string, input: Record<string, unknown>, timeoutSec: number): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd }, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    // A command that never reads its input closes the pipe, and the write to it fails. That is not the hook failing.
    child.stdin.on('error', () => undefined)
    child.stdin.end(JSON.stringify(input))
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutSec * 1000)
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code: code ?? 1, timedOut })
    })
  })
}

// The turn the hooks belong to, and the last words the agent said in it.
let promptId = randomUUID()
let lastSaid = ''

// Runs the hooks of one event, in order. `tool` is the tool's name for a tool event.
async function runHooks(event: string, tool: string | null, input: Record<string, unknown>) {
  const reported = event === 'SessionStart' || reportAll
  const fits = (matcher: string | undefined) => tool === null || matcher === undefined || matcher === '' || matcher === '*'
    || new RegExp(`^(?:${matcher})$`).test(tool)
  const source = resume === undefined ? 'startup' : 'resume'
  const name = event === 'SessionStart' ? `SessionStart:${source}` : tool === null ? event : `${event}:${tool}`
  const given = event === 'SessionStart'
    ? { session_id: sessionId, transcript_path: join(cwd, '.fake', `${sessionId}.jsonl`), cwd, hook_event_name: event, source }
    : { session_id: sessionId, transcript_path: join(cwd, '.fake', `${sessionId}.jsonl`), cwd, prompt_id: promptId, permission_mode: permissionMode, hook_event_name: event, ...input }
  for (const group of hooks[event] ?? []) {
    if (!fits(group.matcher)) continue
    for (const hook of group.hooks) {
      const hookId = randomUUID()
      if (reported) await print({ type: 'system', subtype: 'hook_started', hook_id: hookId, hook_name: name, hook_event: event })
      const ran = await execute(hook.command, given, hook.timeout ?? defaultLimit(event))
      if (ran.code === BLOCKING_EXIT_CODE && !ran.timedOut) refuse(`the ${name} hook "${hook.command}" exited ${String(BLOCKING_EXIT_CODE)}, which blocks in Claude Code, and this stand-in cannot block`)
      if (reported) {
        const [stdout, stderr] = ran.timedOut ? ['', ''] : [ran.stdout, ran.stderr]
        await print({
          type: 'system', subtype: 'hook_response', hook_id: hookId, hook_name: name, hook_event: event,
          output: stdout + stderr, stdout, stderr, exit_code: ran.timedOut ? CANCELLED_EXIT_CODE : ran.code,
          outcome: ran.timedOut ? 'cancelled' : ran.code === 0 ? 'success' : 'error',
        })
      }
    }
  }
}

const Line = z.looseObject({ type: z.string(), message: z.looseObject({ content: z.unknown() }).optional() })

// A line of the stand-in's output or of Agents' input, or null for text that is no line, such as an empty write.
function parseLine(text: string) {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const line = Line.safeParse(value)
  return line.success ? line.data : null
}
const Block = z.looseObject({
  type: z.string(), id: z.string().optional(), name: z.string().optional(), input: z.unknown().optional(),
  tool_use_id: z.string().optional(), content: z.unknown().optional(), text: z.string().optional(),
})
const blocksOf = (content: unknown) => z.array(Block).safeParse(content).data ?? []
const ToolInput = z.looseObject({ file_path: z.string().optional(), content: z.string().optional() })

// The tools the stand-in called, by id, for the hooks that run around their results.
const called = new Map<string, { name: string; input: unknown }>()

// What a tool's result is to a PostToolUse hook. Claude Code gives Write's an object.
function responseOf(tool: { name: string; input: unknown }, result: unknown): unknown {
  const input = ToolInput.safeParse(tool.input).data
  if (tool.name !== 'Write' || !input) return result
  return { type: 'create', filePath: input.file_path, content: input.content, structuredPatch: [], originalFile: null, userModified: false }
}

// Every line the stand-in prints passes through here, in order. A tool call's PostToolUse hooks
// run before the line with its result, and the Stop hooks before the turn's result.
const standInOut = new Writable({
  write(chunk: Buffer | string, _encoding, done) {
    const text = chunk.toString()
    void (async () => {
      const message = parseLine(text)
      const blocks = blocksOf(message?.message?.content)
      if (message?.type === 'result') await runHooks('Stop', null, { stop_hook_active: false, last_assistant_message: lastSaid })
      for (const block of blocks) {
        const tool = block.type === 'tool_result' && block.tool_use_id ? called.get(block.tool_use_id) : undefined
        if (tool) await runHooks('PostToolUse', tool.name, { tool_name: tool.name, tool_input: tool.input, tool_response: responseOf(tool, block.content), tool_use_id: block.tool_use_id })
      }
      await new Promise<void>((resolve) => { realStdout.write(text, () => { resolve() }) })
      for (const block of blocks) {
        if (message?.type === 'assistant' && block.type === 'text' && block.text) lastSaid = block.text
        if (block.type === 'tool_use' && block.id && block.name) called.set(block.id, { name: block.name, input: block.input })
      }
    })().then(() => { done() }, (error: unknown) => { done(error instanceof Error ? error : new Error(String(error))) })
  },
})

// Every message passes through here too, after the SessionStart hooks and its own UserPromptSubmit hooks have run.
const standInIn = new PassThrough()
let fed: Promise<void> = runHooks('SessionStart', null, {})
const lines = createInterface({ input: realStdin })
lines.on('line', (line) => {
  fed = fed.then(async () => {
    const message = parseLine(line)
    const prompt = message?.type === 'user' ? message.message?.content : undefined
    if (typeof prompt === 'string') {
      promptId = randomUUID()
      await runHooks('UserPromptSubmit', null, { prompt })
    }
    standInIn.write(`${line}\n`)
  })
})
lines.on('close', () => { fed = fed.then(() => { standInIn.end() }) })

Object.defineProperty(process, 'stdout', { value: standInOut, configurable: true })
Object.defineProperty(process, 'stdin', { value: standInIn, configurable: true })
await import('./fake-claude.ts')
await new Promise<void>((resolve) => { standInOut.end(resolve) })
