// The Anthropic Messages API, as far as Claude Code needs it to run a turn that makes one tool
// call, so a check can run the real `claude` with no model and no spend. Point the CLI at it
// with ANTHROPIC_BASE_URL. The person's message picks a rule by the words it holds. The rule
// either says something, or writes a file in the folder Claude Code works in, and says
// something once the tool's result is back. Claude Code 2.1.301 sent only POST /v1/messages,
// streaming, once for the model's turn and again with the tool's result. A request this
// cannot answer gets an API error, which fails the session the check is watching, and is
// listed in `problems`.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { z } from 'zod'

export type Rule = { match: string; say: string; write?: { file: string; content: string } }

const Block = z.looseObject({ type: z.string(), text: z.string().optional() })
const Message = z.looseObject({ role: z.string(), content: z.union([z.string(), z.array(Block)]) })
const Request = z.looseObject({
  model: z.string(),
  stream: z.boolean().optional(),
  tools: z.array(z.unknown()).optional(),
  system: z.union([z.string(), z.array(Block)]).optional(),
  messages: z.array(Message),
})
type Message = z.infer<typeof Message>

const WORKING_DIRECTORY = /Primary working directory: (.+)/
const TOOL_USE_ID = 'toolu_standin01'

// The text blocks of a message.
const textsOf = (message: Message): string[] => (typeof message.content === 'string'
  ? [message.content] : message.content.flatMap((block) => (block.type === 'text' && block.text !== undefined ? [block.text] : [])))

// What the person said in the turn the request is part of: the text of the last user message that holds
// any outside Claude Code's own reminders, which are wrapped in tags. Whether a tool has answered since.
function turnOf(messages: Message[]): { said: string; answered: boolean } {
  const said = (message: Message) => (message.role === 'user' ? textsOf(message).filter((text) => !text.startsWith('<')).join('\n') : '')
  const last = messages.findLastIndex((message) => said(message) !== '')
  const after = last < 0 ? [] : messages.slice(last + 1)
  const answered = after.some((message) => message.role === 'user' && Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result'))
  return { said: last < 0 ? '' : said(messages[last] ?? { role: 'user', content: '' }), answered }
}

type Event = [string, Record<string, unknown>]

const open = (model: string): Event => ['message_start', {
  type: 'message_start',
  message: { id: 'msg_standin', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
}]
const close = (stop: 'end_turn' | 'tool_use'): Event[] => [
  ['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } }],
  ['message_stop', { type: 'message_stop' }],
]
const says = (model: string, text: string): Event[] => [
  open(model),
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ...close('end_turn'),
]
const writes = (model: string, input: { file_path: string; content: string }): Event[] => [
  open(model),
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: TOOL_USE_ID, name: 'Write', input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ...close('tool_use'),
]

function stream(res: ServerResponse, events: Event[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  res.end()
}

function refuse(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }))
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function fakeAnthropic(rules: Rule[]) {
  const problems: string[] = []
  const fail = (res: ServerResponse, message: string) => {
    problems.push(message)
    refuse(res, 400, message)
  }
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) return fail(res, `nothing here answers ${req.method ?? ''} ${req.url ?? ''}`)
      const parsed = Request.safeParse(await bodyOf(req))
      if (!parsed.success) return fail(res, `a request this does not read: ${z.prettifyError(parsed.error)}`)
      const body = parsed.data
      // A request with no tools is not a turn of the agent, such as a title for it.
      if (!body.tools?.length) return body.stream ? stream(res, says(body.model, 'ok')) : fail(res, 'a request with no stream and no tools')
      const turn = turnOf(body.messages)
      const rule = rules.find((r) => turn.said.includes(r.match))
      if (!rule) return fail(res, `no rule for what the person said: ${turn.said.slice(0, 120)}`)
      if (!body.stream) return fail(res, 'a turn that did not ask for a stream')
      if (turn.answered || !rule.write) return stream(res, says(body.model, rule.say))
      // Claude Code states the folder in its environment notes, which it has put in the system prompt and in a system message.
      const system = typeof body.system === 'string' ? [body.system] : (body.system ?? []).map((block) => block.text ?? '')
      const folder = WORKING_DIRECTORY.exec([...system, ...body.messages.flatMap(textsOf)].join('\n'))?.[1]
      if (!folder) return fail(res, "the request names no working directory, so there is nowhere to write")
      return stream(res, writes(body.model, { file_path: join(folder, rule.write.file), content: rule.write.content }))
    })().catch((error: unknown) => { fail(res, `the request failed: ${error instanceof Error ? error.message : String(error)}`) })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the stand-in API has no port')
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    problems,
    stop: () => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }),
  }
}
