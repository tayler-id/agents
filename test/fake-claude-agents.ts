#!/usr/bin/env node
// The stand-in for `claude -p`, test/fake-claude.ts, that also calls MCP tools the
// way Claude Code does. A scenario's `calls` rules name a turn by words in its
// prompt, and the tools the turn calls. Each call prints its tool_use line, and
// for a tool the session's --allowedTools does not allow it first asks the
// daemon with a can_use_tool request and waits for the answer, as Claude Code
// does. An allowed call starts the tool's server from the session's MCP config,
// as Claude Code starts it, calls the tool over MCP, and prints what came back as
// the tool's result. Then the stand-in's own reply follows, or the rule's `say`,
// where {answer} stands for the prompt after its first blank line.
//
// This runs the stand-in as it is and does that around it: every line the
// stand-in prints passes through here, and a matched turn's calls go out just
// before its reply. A `calls` rule is skipped when the prompt has its `unless` words.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { PassThrough, Writable } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'

const Call = z.object({ tool: z.string().regex(/^mcp__[a-z0-9-]+__[a-z_]+$/), input: z.record(z.string(), z.unknown()) })
const Rule = z.object({ match: z.string(), unless: z.string().optional(), calls: z.array(Call), say: z.string().optional() })
const Scenario = z.object({ calls: z.array(Rule).default([]) })
const McpConfig = z.object({ mcpServers: z.record(z.string(), z.object({ command: z.string(), args: z.array(z.string()), env: z.record(z.string(), z.string()).optional() })) })
const Line = z.looseObject({ type: z.string(), isReplay: z.boolean().optional(), message: z.looseObject({ content: z.unknown() }).optional() })
const Answer = z.object({ type: z.literal('control_response'), response: z.object({ request_id: z.string(), response: z.looseObject({ behavior: z.enum(['allow', 'deny']), message: z.string().optional() }) }) })

const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const sessionId = flag('--resume') ?? randomUUID()
const allowed = (flag('--allowedTools') ?? '').split(',').filter(Boolean)
const mcpFile = flag('--mcp-config')
const servers = mcpFile ? McpConfig.parse(JSON.parse(readFileSync(mcpFile, 'utf8'))).mcpServers : {}
const rules = process.env.AGENTS_FAKE_SCENARIO ? Scenario.parse(JSON.parse(readFileSync(process.env.AGENTS_FAKE_SCENARIO, 'utf8'))).calls : []

const realStdout = process.stdout
const print = (line: Record<string, unknown>) => new Promise<void>((resolve) => {
  realStdout.write(`${JSON.stringify({ session_id: sessionId, uuid: randomUUID(), ...line })}\n`, () => { resolve() })
})
const parse = (text: string) => {
  try {
    return Line.safeParse(JSON.parse(text)).data ?? null
  } catch {
    return null
  }
}

// Claude Code allows a whole server by its mcp__server name, or one tool by its full name.
const isAllowed = (tool: string) => allowed.includes(tool) || allowed.includes(tool.split('__').slice(0, 2).join('__'))

// One client for each server a call names, started the first time it is called.
const clients = new Map<string, Promise<Client>>()
function clientFor(server: string): Promise<Client> {
  const found = clients.get(server)
  if (found) return found
  const config = servers[server]
  if (!config) throw new Error(`the session's MCP config has no ${server} server`)
  const client = new Client({ name: 'fake-claude', version: '1.0.0' })
  const started = client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { ...getDefaultEnvironment(), ...config.env } })).then(() => client)
  clients.set(server, started)
  return started
}

// The daemon's answers to this stand-in's own permission requests, by request id.
const waiting = new Map<string, (answer: { behavior: 'allow' | 'deny'; message?: string }) => void>()

async function makeCall(call: z.infer<typeof Call>) {
  const id = `toolu_${randomUUID().slice(0, 8)}`
  await print({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${randomUUID().slice(0, 8)}`, model: 'fake', content: [{ type: 'tool_use', id, name: call.tool, input: call.input }] } })
  const result = (content: unknown, isError: boolean) =>
    print({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } })
  if (!isAllowed(call.tool)) {
    const requestId = randomUUID()
    const answered = new Promise<{ behavior: 'allow' | 'deny'; message?: string }>((resolve) => waiting.set(requestId, resolve))
    await print({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: call.tool, input: call.input, tool_use_id: id } })
    const answer = await answered
    if (answer.behavior === 'deny') return result(answer.message ?? 'A person denied this.', true)
  }
  const [, server = '', tool = ''] = call.tool.split('__')
  const called = await (await clientFor(server)).callTool({ name: tool, arguments: call.input })
  return result(called.content, called.isError === true)
}

// The prompt of the turn the stand-in is on, from the line it prints back as it takes it in.
let prompt = ''
const ruleFor = (text: string) => rules.find((rule) => text.includes(rule.match) && !(rule.unless && text.includes(rule.unless)))
const answerIn = (text: string) => text.split('\n\n').slice(1).join('\n\n')

const standInOut = new Writable({
  write(chunk: Buffer | string, _encoding, done) {
    const text = chunk.toString()
    void (async () => {
      const line = parse(text)
      if (line?.type === 'user' && line.isReplay && typeof line.message?.content === 'string') prompt = line.message.content
      const blocks = z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).safeParse(line?.message?.content).data ?? []
      const rule = line?.type === 'assistant' && blocks.some((b) => b.type === 'text') ? ruleFor(prompt) : undefined
      if (!line || !rule) {
        await new Promise<void>((resolve) => { realStdout.write(text, () => { resolve() }) })
        return
      }
      for (const call of rule.calls) await makeCall(call)
      const said = rule.say?.replaceAll('{answer}', answerIn(prompt))
      const content = said === undefined ? line.message?.content : [{ type: 'text', text: said }]
      await new Promise<void>((resolve) => { realStdout.write(`${JSON.stringify({ ...line, message: { ...line.message, content } })}\n`, () => { resolve() }) })
    })().then(() => { done() }, (error: unknown) => { done(error instanceof Error ? error : new Error(String(error))) })
  },
})

// Every line from the daemon passes through here. An answer to this stand-in's own
// request stops here, and everything else goes on to the stand-in.
const standInIn = new PassThrough()
const lines = createInterface({ input: process.stdin })
lines.on('line', (text) => {
  const answer = Answer.safeParse((() => { try { return JSON.parse(text) } catch { return null } })())
  const resolve = answer.success ? waiting.get(answer.data.response.request_id) : undefined
  if (answer.success && resolve) {
    waiting.delete(answer.data.response.request_id)
    resolve(answer.data.response.response)
    return
  }
  standInIn.write(`${text}\n`)
})
lines.on('close', () => { standInIn.end() })

Object.defineProperty(process, 'stdout', { value: standInOut, configurable: true })
Object.defineProperty(process, 'stdin', { value: standInIn, configurable: true })
await import('./fake-claude.ts')
await new Promise<void>((resolve) => { standInOut.end(resolve) })
await Promise.all([...clients.values()].map(async (client) => (await client).close()))
