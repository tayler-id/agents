// Runs one headless `claude` process per session and turns its stream-json output
// into record events, keeping every raw line as well.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { AnswerPayload, EventBatch, NewEvent } from '../shared/types.ts'
import type { Harness, HarnessSession, HarnessStart } from './harness.ts'

// Set by a parent Claude Code session. A daemon started from inside one must not
// make its sessions look like that session's children.
const PARENT_SESSION_ENV = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_PLUGIN_DATA',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
]

// Progress counters and command lists. They stay in the raw lines but make no event.
const SKIPPED_SYSTEM = new Set(['thinking_tokens', 'commands_changed'])

type Block = { type: string; [key: string]: unknown }
type StreamEvent = {
  type?: string
  index?: number
  delta?: { type?: string; text?: string; thinking?: string }
}

type Line = {
  type: string
  subtype?: string
  uuid?: string
  session_id?: string
  parent_tool_use_id?: string | null
  message?: { id?: string; model?: string; content?: string | Block[] }
  [key: string]: unknown
}

// The part of a tool call a person would scan for: the command, the path, the query.
function toolCallText(name: unknown, input: unknown): string {
  const fields = (input ?? {}) as Record<string, unknown>
  const key = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']
    .find((k) => typeof fields[k] === 'string')
  const value = key ? fields[key] : undefined
  return `${typeof name === 'string' ? name : 'tool'} ${typeof value === 'string' ? value : JSON.stringify(fields)}`
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part: unknown) => {
      const text = typeof part === 'object' && part !== null && 'text' in part ? part.text : undefined
      return typeof text === 'string' ? text : ''
    }).filter(Boolean).join('\n')
  }
  return ''
}

function blockEvent(line: Line, block: Block, clientId: string): NewEvent {
  const parentToolUseId = line.parent_tool_use_id ?? undefined
  const context = { parentToolUseId: parentToolUseId ?? null, messageId: line.message?.id ?? null }
  switch (block.type) {
    case 'text':
      return line.type === 'assistant'
        ? { clientId, kind: 'assistant', parentToolUseId, text: block.text as string, body: { text: block.text, model: line.message?.model, ...context } }
        : { clientId, kind: 'notice', parentToolUseId, text: block.text as string, body: { role: 'user', text: block.text, ...context } }
    case 'thinking':
      return { clientId, kind: 'thinking', parentToolUseId, text: block.thinking as string, body: { thinking: block.thinking, ...context } }
    case 'tool_use':
    case 'server_tool_use':
      return {
        clientId, kind: 'tool_call', parentToolUseId,
        toolUseId: block.id as string, toolName: block.name as string, text: toolCallText(block.name, block.input),
        body: { id: block.id, name: block.name, input: block.input, ...context },
      }
    case 'tool_result':
      return {
        clientId, kind: 'tool_result', parentToolUseId,
        toolUseId: block.tool_use_id as string, text: resultText(block.content),
        body: { toolUseId: block.tool_use_id, content: block.content, isError: block.is_error ?? false, ...context },
      }
    default:
      return {
        clientId, kind: block.type.endsWith('_tool_result') ? 'tool_result' : 'notice', parentToolUseId,
        body: { block, ...context },
      }
  }
}

// One stdout line becomes one batch: its raw line, plus the events it holds.
// Never emits a 'user' event: those come only from people, through the API.
export function toBatch(line: Line): EventBatch {
  const clientId = line.uuid ?? randomUUID()
  const raw = [{ clientId, line }]
  // session_id and uuid are kept on the raw line and left out of each event's body.
  const { type, subtype, session_id: _session, uuid: _uuid, ...rest } = line

  if (type === 'system' && subtype === 'init') {
    return {
      events: [{ clientId, kind: 'notice', text: 'init', body: { subtype, ...rest } }],
      raw, harnessSessionId: line.session_id, status: 'running',
    }
  }
  if (type === 'system') {
    return { events: SKIPPED_SYSTEM.has(subtype ?? '') ? [] : [{ clientId, kind: 'notice', text: subtype, body: { subtype, ...rest } }], raw }
  }
  if (type === 'assistant' || type === 'user') {
    const content = line.message?.content
    const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? []
    return { events: blocks.map((block, i) => blockEvent(line, block, `${clientId}:${i}`)), raw, status: 'running' }
  }
  if (type === 'result') {
    const events: NewEvent[] = [{ clientId, kind: 'usage', body: { subtype, ...rest } }]
    if (line.is_error) {
      const reason = typeof line.result === 'string' ? line.result : subtype ?? 'error'
      events.push({ clientId: `${clientId}:error`, kind: 'error', text: reason, body: { subtype, result: line.result } })
    }
    return { events, raw, status: 'idle' }
  }
  // Claude asks before a gated tool runs. The session waits until a person answers.
  if (type === 'control_request') {
    const request = (line.request ?? {}) as { subtype?: string; tool_name?: string; input?: unknown; description?: string; tool_use_id?: string }
    if (request.subtype !== 'can_use_tool') return { events: [] }
    const requestId = String(line.request_id)
    return {
      events: [{
        clientId: `ask:${requestId}`, kind: 'ask', toolName: request.tool_name, toolUseId: request.tool_use_id,
        text: toolCallText(request.tool_name, request.input),
        body: { requestId, toolName: request.tool_name, input: request.input, description: request.description },
      }],
      raw, status: 'needs_approval',
    }
  }
  // Claude acknowledging an interrupt. The turn's result follows.
  if (type === 'control_response') return { events: [], raw }
  // Tokens while the agent types. They go to the live stream, never to the record.
  if (type === 'stream_event') return { events: [], live: liveDeltas(line) }
  return { events: [{ clientId, kind: 'notice', text: type, body: { type, subtype, ...rest } }], raw }
}

function liveDeltas(line: Line): EventBatch['live'] {
  const event = (line.event ?? {}) as StreamEvent
  const m = line.api_message_id
  if (typeof m !== 'string') return []
  const b = event.index ?? 0
  const p = line.parent_tool_use_id ?? null
  if (event.type === 'content_block_stop') return [{ m, b, k: 'text', d: '', p, end: true }]
  if (event.type !== 'content_block_delta') return []
  if (event.delta?.type === 'text_delta' && event.delta.text) return [{ m, b, k: 'text', d: event.delta.text, p }]
  if (event.delta?.type === 'thinking_delta' && event.delta.thinking) return [{ m, b, k: 'thinking', d: event.delta.thinking, p }]
  return []
}

class ClaudeSession implements HarnessSession {
  private child
  private stderr: string[] = []
  private turns = 0
  alive = true

  get busy() {
    return this.turns > 0
  }

  constructor(options: HarnessStart) {
    // An agent runs the same on every machine: none of the host user's own Claude
    // settings, hooks, plugins or MCP servers, only what the agent is given.
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio',
      '--setting-sources', 'project,local', '--strict-mcp-config']
    if (options.model) args.push('--model', options.model)
    if (options.resume) args.push('--resume', options.resume)
    if (options.instructions) args.push('--append-system-prompt', options.instructions)
    if (options.mcpConfig) args.push('--mcp-config', options.mcpConfig)
    if (options.allowedTools.length) args.push('--allowedTools', options.allowedTools.join(','))
    if (options.maxBudgetUsd) args.push('--max-budget-usd', options.maxBudgetUsd.toFixed(2))
    const env = { ...process.env }
    for (const name of PARENT_SESSION_ENV) delete env[name]
    this.child = spawn(process.env.AGENTS_CLAUDE_BIN ?? 'claude', args, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.on('close', () => { this.alive = false })
    this.child.stdin.on('error', () => {})
    this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderr.push(chunk)
      if (this.stderr.length > 50) this.stderr.shift()
    })
  }

  send(text: string) {
    this.turns += 1
    this.write({ type: 'user', message: { role: 'user', content: text } })
  }

  answer({ requestId, behavior, message, updatedInput }: AnswerPayload) {
    const response = behavior === 'allow'
      ? { behavior, updatedInput: updatedInput ?? {} }
      : { behavior, message: message ?? 'A person denied this.' }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
  }

  interrupt() {
    this.write({ type: 'control_request', request_id: `interrupt-${randomUUID()}`, request: { subtype: 'interrupt' } })
  }

  private write(message: unknown) {
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  async *updates(): AsyncIterable<EventBatch> {
    const exited = new Promise<number | null>((resolve) => {
      this.child.on('close', (code) => resolve(code))
      this.child.on('error', () => resolve(-1))
    })
    for await (const rawLine of createInterface({ input: this.child.stdout })) {
      if (!rawLine.trim()) continue
      let line: Line
      try {
        // Claude's stream-json lines. Fields are read defensively in toBatch.
        line = JSON.parse(rawLine) as Line
      } catch {
        const clientId = randomUUID()
        yield { events: [{ clientId, kind: 'notice', text: rawLine, body: { unparsed: rawLine } }], raw: [{ clientId, line: rawLine }] }
        continue
      }
      if (line.type === 'result') this.turns = Math.max(0, this.turns - 1)
      yield toBatch(line)
    }
    // A clean exit leaves the session idle, ready to resume on the next message.
    const code = await exited
    if (code === 0) {
      yield { events: [], status: 'idle' }
    } else {
      const stderr = this.stderr.join('').slice(-8000)
      yield { events: [{ clientId: randomUUID(), kind: 'error', text: stderr, body: { exitCode: code, stderr } }], status: 'failed' }
    }
  }

  // Once stopping, the session takes no more messages, so the next one starts a
  // fresh process that resumes the session.
  stop() {
    this.alive = false
    this.child.stdin.end()
    setTimeout(() => this.child.kill('SIGTERM'), 5000).unref()
  }
}

export const claude: Harness = {
  name: 'claude',
  start: (options) => new ClaudeSession(options),
}
