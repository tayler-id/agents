#!/usr/bin/env node
// The stand-in for `claude -p`, test/fake-claude.ts, with Claude Code's hooks. Claude
// Code reads the hooks in .claude/settings.json and .claude/settings.local.json of its
// folder, and runs a hook's command when its event happens, giving the command the event
// as JSON on its standard input. This runs the stand-in as it is and does that around it,
// so a check can watch a turn with hooks on. It reads the same settings, runs the same
// commands in the same folder, and prints the same hook lines as the real CLI. What
// the real CLI does is from running version 2.1.301 on a settings file with no model
// call: an input of the event's own, then lines named hook_started and hook_response.
//
// It models SessionStart, before the process reads a message, and UserPromptSubmit,
// before a message reaches the stand-in. Those two print their lines only with
// --include-hook-events, except SessionStart, which always prints them. It models
// PostToolUse, after a tool's result, for hooks whose matcher fits the tool's name, and
// Stop, before the turn's result. A hook that exits 0 succeeds, and any other exit is
// an error that carries on. It does not model a hook that blocks, with exit 2, or
// PreToolUse and SubagentStop, and a settings file that names one stops it at the start
// with an error, so a check never passes on a hook that did not run.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough, Writable } from 'node:stream'
import { z } from 'zod'

const MODELLED = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']
// Claude Code's default for a hook that names no limit.
const HOOK_TIMEOUT_SEC = 60

const Settings = z.object({
  hooks: z.record(z.string(), z.array(z.object({
    matcher: z.string().optional(),
    hooks: z.array(z.object({ type: z.literal('command'), command: z.string(), timeout: z.number().optional() })),
  }))).default({}),
})
type Settings = z.infer<typeof Settings>

const args = process.argv.slice(2)
const resume = args.indexOf('--resume') >= 0 ? args[args.indexOf('--resume') + 1] : undefined
const sessionId = resume ?? randomUUID()
const reportAll = args.includes('--include-hook-events')
const cwd = process.cwd()

// The hooks of both settings files Agents starts Claude with.
function settings(): Settings['hooks'] {
  const merged: Settings['hooks'] = {}
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = join(cwd, '.claude', name)
    if (!existsSync(file)) continue
    const read = Settings.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    if (!read.success) throw new Error(`${file} is not a settings file this stand-in reads: ${z.prettifyError(read.error)}`)
    for (const [event, groups] of Object.entries(read.data.hooks)) merged[event] = [...(merged[event] ?? []), ...groups]
  }
  return merged
}
const hooks = settings()
const unmodelled = Object.keys(hooks).filter((event) => !MODELLED.includes(event))
if (unmodelled.length) {
  process.stderr.write(`fake-claude-hooks: ${unmodelled.join(', ')} hooks are not modelled, so this run would not run them\n`)
  process.exit(2)
}

const realStdout = process.stdout
const realStdin = process.stdin
const print = (line: Record<string, unknown>) => new Promise<void>((resolve) => {
  realStdout.write(`${JSON.stringify({ ...line, uuid: randomUUID(), session_id: sessionId })}\n`, () => { resolve() })
})

type Ran = { stdout: string; stderr: string; code: number }
function execute(command: string, input: Record<string, unknown>, timeoutSec: number): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd }, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    // A command that never reads its input closes the pipe, and the write to it fails. That is not the hook failing.
    child.stdin.on('error', () => undefined)
    child.stdin.end(JSON.stringify(input))
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutSec * 1000)
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code: code ?? 1 })
    })
  })
}

// Runs the hooks of one event, in order. `tool` is the tool's name for a tool event.
async function runHooks(event: string, tool: string | null, input: Record<string, unknown>) {
  const reported = event === 'SessionStart' || reportAll
  const fits = (matcher: string | undefined) => tool === null || matcher === undefined || matcher === '' || matcher === '*'
    || new RegExp(`^(?:${matcher})$`).test(tool)
  const source = resume === undefined ? 'startup' : 'resume'
  const name = event === 'SessionStart' ? `SessionStart:${source}` : tool === null ? event : `${event}:${tool}`
  for (const group of hooks[event] ?? []) {
    if (!fits(group.matcher)) continue
    for (const hook of group.hooks) {
      const hookId = randomUUID()
      if (reported) await print({ type: 'system', subtype: 'hook_started', hook_id: hookId, hook_name: name, hook_event: event })
      const ran = await execute(hook.command, {
        session_id: sessionId, transcript_path: join(cwd, '.fake', `${sessionId}.jsonl`), cwd, permission_mode: 'default', hook_event_name: event,
        ...(event === 'SessionStart' ? { source } : {}), ...input,
      }, hook.timeout ?? HOOK_TIMEOUT_SEC)
      if (reported) {
        await print({
          type: 'system', subtype: 'hook_response', hook_id: hookId, hook_name: name, hook_event: event,
          output: ran.stdout + ran.stderr, stdout: ran.stdout, stderr: ran.stderr, exit_code: ran.code, outcome: ran.code === 0 ? 'success' : 'error',
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
const Block = z.looseObject({ type: z.string(), id: z.string().optional(), name: z.string().optional(), input: z.unknown().optional(), tool_use_id: z.string().optional(), content: z.unknown().optional() })
const blocksOf = (content: unknown) => z.array(Block).safeParse(content).data ?? []

// The tools the stand-in called, by id, for the hooks that run after their results.
const called = new Map<string, { name: string; input: unknown }>()

// Every line the stand-in prints passes through here, in order. A tool's result is
// followed by its PostToolUse hooks, and the turn's result is preceded by the Stop hooks.
const standInOut = new Writable({
  write(chunk: Buffer | string, _encoding, done) {
    const text = chunk.toString()
    void (async () => {
      const message = parseLine(text)
      if (message?.type === 'result') await runHooks('Stop', null, { stop_hook_active: false })
      await new Promise<void>((resolve) => { realStdout.write(text, () => { resolve() }) })
      for (const block of blocksOf(message?.message?.content)) {
        if (block.type === 'tool_use' && block.id && block.name) called.set(block.id, { name: block.name, input: block.input })
        const tool = block.type === 'tool_result' && block.tool_use_id ? called.get(block.tool_use_id) : undefined
        if (tool) await runHooks('PostToolUse', tool.name, { tool_name: tool.name, tool_input: tool.input, tool_response: block.content, tool_use_id: block.tool_use_id })
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
    if (typeof prompt === 'string') await runHooks('UserPromptSubmit', null, { prompt, prompt_id: randomUUID() })
    standInIn.write(`${line}\n`)
  })
})
lines.on('close', () => { fed = fed.then(() => { standInIn.end() }) })

Object.defineProperty(process, 'stdout', { value: standInOut, configurable: true })
Object.defineProperty(process, 'stdin', { value: standInIn, configurable: true })
await import('./fake-claude.ts')
await new Promise<void>((resolve) => { standInOut.end(resolve) })
