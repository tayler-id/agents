// Runs one headless `claude` process per session and turns its stream-json output
// into record events, keeping every raw line as well.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import type { AnswerPayload, EventBatch, NewEvent, RawLine, SessionStatus } from '../shared/types.ts'
import type { Harness, HarnessSession, HarnessStart } from './harness.ts'

// Set by a parent Claude Code session. A daemon started from inside one must not
// make its sessions look like that session's children.
export const PARENT_SESSION_ENV = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_PLUGIN_DATA',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
]

// The Claude CLI this machine runs. Checks name a stand-in.
export const CLAUDE_BIN = process.env.AGENTS_CLAUDE_BIN ?? 'claude'

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

function blockEvent(line: Pick<Line, 'type' | 'parent_tool_use_id' | 'message'>, block: Block, clientId: string): NewEvent {
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
  // A message printed back as Claude takes it into a turn. It is already in the
  // record as the person's user event, so it only tells the harness which turn took it.
  if (type === 'user' && line.isReplay === true) return { events: [], raw }
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

// Claude Code's transcripts: one JSON line per entry, written under
// ~/.claude/projects for every session, in a terminal or headless. The format is
// Claude Code's own and not documented, so every field is optional here, and a
// line of a type this file does not map makes no event.
const TranscriptBlock = z.looseObject({ type: z.string() })
export const TranscriptLine = z.looseObject({
  type: z.string(),
  uuid: z.string().optional(),
  subtype: z.string().optional(),
  content: z.unknown().optional(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  origin: z.looseObject({ kind: z.string() }).optional(),
  turnOrigin: z.string().optional(),
  message: z.looseObject({
    id: z.string().optional(),
    model: z.string().optional(),
    stop_reason: z.string().nullable().optional(),
    usage: z.unknown().optional(),
    content: z.union([z.string(), z.array(TranscriptBlock)]).optional(),
  }).optional(),
})
export type TranscriptLine = z.infer<typeof TranscriptLine>

// Claude Code's own bookkeeping, not part of the conversation.
const SKIPPED_TRANSCRIPT_SYSTEM = new Set(['stop_hook_summary', 'turn_duration'])
// What Claude Code writes when a person stops a turn with Esc.
const INTERRUPTED = /^\[Request interrupted by user/
// Stop reasons that leave the turn with the model. Any other ends the turn.
const CONTINUING = new Set(['tool_use', 'pause_turn'])
const THINKING = new Set(['thinking', 'redacted_thinking'])

// Images stay on the Mac. A screenshot can show a secret no scrubber can read.
export function withoutImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutImages)
  if (typeof value !== 'object' || value === null) return value
  if ('type' in value && value.type === 'image') return { type: 'image', omitted: 'Images stay on the Mac.' }
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, withoutImages(inner)]))
}

// Where a person's own prompt comes from: typed in the terminal, or given to
// `claude -p`, which Claude Code marks sdk.
const PERSON_TURNS = new Set(['human', 'sdk'])

// Whether a user line is the person's prompt, rather than Claude Code, a hook, a
// background task, another session or an agent's orders to its subagent.
function fromPerson(line: TranscriptLine): boolean {
  return !line.isSidechain && !line.isCompactSummary
    && (line.origin === undefined || line.origin.kind === 'human')
    && (line.turnOrigin === undefined || PERSON_TURNS.has(line.turnOrigin))
}

type Mapped = { events: NewEvent[]; status?: SessionStatus }

function transcriptEvents(line: TranscriptLine, id: string, parentToolUseId: string | null): Mapped | null {
  const subagent = parentToolUseId !== null
  const context = { type: line.type, parent_tool_use_id: parentToolUseId, message: line.message }
  const content = line.message?.content
  const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? []
  if (line.type === 'assistant') {
    const events = blocks.map((block, i) => blockEvent(context, block, `${id}:${i}`))
    if (subagent) return { events }
    // Every line of a message carries the message's stop reason. A message that
    // ends the turn has its words after its thinking, so its thinking ends nothing.
    const stop = line.message?.stop_reason
    if (typeof stop !== 'string' || CONTINUING.has(stop) || blocks.every((b) => THINKING.has(b.type))) return { events, status: 'running' }
    return { events: [...events, { clientId: `${id}:end`, kind: 'usage', body: { stopReason: stop, usage: line.message?.usage } }], status: 'idle' }
  }
  if (line.type === 'user') {
    if (line.isMeta) return null
    const events = blocks.flatMap((block, i) => (block.type === 'text' || block.type === 'image' ? [] : [blockEvent(context, block, `${id}:${i}`)]))
    const said = blocks.flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n')
    const images = blocks.filter((b) => b.type === 'image').length
    if (!said && !images) return { events, status: subagent ? undefined : 'running' }
    if (INTERRUPTED.test(said)) {
      return { events: [...events, { clientId: `${id}:said`, kind: 'notice', text: said, body: { interrupted: true, text: said } }], status: subagent ? undefined : 'idle' }
    }
    if (!subagent && fromPerson(line)) {
      return { events: [...events, { clientId: `${id}:said`, kind: 'user', text: said, body: { text: said, images } }], status: 'running' }
    }
    return { events: [...events, blockEvent(context, { type: 'text', text: said }, `${id}:said`)] }
  }
  if (line.type === 'system' && line.subtype !== undefined && !SKIPPED_TRANSCRIPT_SYSTEM.has(line.subtype)) {
    return { events: [{ clientId: id, kind: 'notice', text: line.subtype, parentToolUseId: parentToolUseId ?? undefined, body: { subtype: line.subtype, content: line.content } }] }
  }
  return null
}

// The events and raw lines that transcript lines make, in order. A subagent's
// lines carry the Agent call that started it. The raw line leaves out
// toolUseResult, Claude Code's second copy of a tool's result.
export function transcriptBatch(lines: TranscriptLine[], parentToolUseId: string | null): EventBatch & { raw: RawLine[] } {
  const events: NewEvent[] = []
  const raw: RawLine[] = []
  let status: SessionStatus | undefined
  for (const line of lines) {
    if (line.uuid === undefined) continue
    const mapped = transcriptEvents(line, line.uuid, parentToolUseId)
    if (!mapped) continue
    events.push(...mapped.events)
    const { toolUseResult: _copy, ...kept } = line
    raw.push({ clientId: line.uuid, line: kept })
    status = mapped.status ?? status
  }
  return status === undefined ? { events, raw } : { events, raw, status }
}

class ClaudeSession implements HarnessSession {
  private child
  private stderr: string[] = []
  // Each message sent and not yet answered, by the uuid it was sent with, and
  // the message commands it answers.
  private sent = new Map<string, readonly string[]>()
  // The uuids of the messages the running turn has taken in, in order.
  private taken: string[] = []
  // Permission requests waiting for an answer, by request id.
  private requests = new Set<string>()
  alive = true

  get busy() {
    return this.sent.size > 0
  }

  get pid() {
    return this.child.pid
  }

  constructor(options: HarnessStart) {
    // An agent runs the same on every machine: none of the host user's own Claude
    // settings, hooks, plugins or MCP servers, only what the agent is given.
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio',
      '--setting-sources', 'project,local', '--strict-mcp-config']
    if (options.model) args.push('--model', options.model)
    if (options.resume) args.push('--resume', options.resume)
    if (options.instructions) args.push('--append-system-prompt', options.instructions)
    if (options.mcpConfig) args.push('--mcp-config', options.mcpConfig)
    if (options.allowedTools.length) args.push('--allowedTools', options.allowedTools.join(','))
    // Claude Code still asks before writes in .git and .claude, and outside cwd.
    if (options.acceptEdits) args.push('--permission-mode', 'acceptEdits')
    if (options.maxBudgetUsd) args.push('--max-budget-usd', options.maxBudgetUsd.toFixed(2))
    const env = { ...process.env }
    for (const name of PARENT_SESSION_ENV) delete env[name]
    // A box's owner signed in from the app. Their token wins over any team-wide one.
    if (options.oauthToken !== null) env.CLAUDE_CODE_OAUTH_TOKEN = options.oauthToken
    this.child = spawn(CLAUDE_BIN, args, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.on('close', () => { this.alive = false })
    this.child.stdin.on('error', () => {})
    this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderr.push(chunk)
      if (this.stderr.length > 50) this.stderr.shift()
    })
  }

  // Claude prints a message back with its uuid when a turn takes it in, which is
  // how the turn's result knows which messages it answered.
  send(text: string, ids: readonly string[]) {
    const uuid = randomUUID()
    this.sent.set(uuid, ids)
    this.write({ type: 'user', uuid, message: { role: 'user', content: text } })
  }

  answer({ requestId, behavior, message, updatedInput }: AnswerPayload) {
    if (!this.requests.delete(requestId)) throw new Error(`no request ${requestId} is waiting in this session's process`)
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
      const batch = toBatch(line)
      this.follow(line, batch)
      yield batch
    }
    // A clean exit with nothing left to answer leaves the session idle, ready to
    // resume on the next message. Any message still held failed with the process.
    const code = await exited
    const held = [...this.sent.values()].flat()
    this.sent.clear()
    if (code === 0 && !held.length) {
      yield { events: [], status: 'idle' }
      return
    }
    const stderr = this.stderr.join('').slice(-8000)
    const reason = code === 0 ? 'Claude exited before it answered every message it was given.'
      : stderr || `Claude exited ${code === null ? 'on a signal' : `with code ${code}`} and said nothing.`
    yield {
      events: [{ clientId: randomUUID(), kind: 'error', text: reason, body: { exitCode: code, stderr } }], status: 'failed',
      ...(held.length ? { ended: { how: 'exited', ids: held, reason } } : {}),
    }
  }

  // Which messages the running turn has taken in, and which permission requests wait.
  private follow(line: Line, batch: EventBatch) {
    if (line.type === 'user' && line.isReplay === true && typeof line.uuid === 'string' && this.sent.has(line.uuid)) this.taken.push(line.uuid)
    if (line.type === 'control_request' && batch.events.some((event) => event.kind === 'ask')) this.requests.add(String(line.request_id))
    if (line.type === 'result') {
      const ids = this.taken.flatMap((uuid) => this.sent.get(uuid) ?? [])
      if (ids.length) batch.ended = { how: 'answered', ids }
      for (const uuid of this.taken) this.sent.delete(uuid)
      this.taken = []
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
