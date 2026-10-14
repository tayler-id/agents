// Calls the instance's API the way its callers do. A person comes through the
// people door with the login Tailscale would set. A machine comes through the
// machine door with its token. Another system starts a pipeline through the
// pipeline's own webhook, signed with that pipeline's secret.

import { createHmac } from 'node:crypto'
import { z } from 'zod'
import { config } from './config.ts'
import { JSON_VALUE, type JsonValue } from '../shared/cli/output.ts'
import type { ReadyState } from './state.ts'

export const Caller = z.enum(['person', 'machine', 'webhook'])
export type Caller = z.infer<typeof Caller>
export const Door = z.enum(['people', 'machines'])
export type Door = z.infer<typeof Door>
export const Method = z.enum(['GET', 'POST', 'HEAD'])
export type Method = z.infer<typeof Method>

export const Reply = z.object({ status: z.number().int(), body: z.union([JSON_VALUE, z.string()]) })
export type Reply = z.infer<typeof Reply>

// An API call answers in well under a second. One that takes this long has hung, and the command says so.
const FETCH_TIMEOUT_MS = 30_000

const PIPELINE_HOOK = /^\/v1\/hooks\/pipelines\/([0-9a-f-]{36})$/

export const url = (state: ReadyState, door: Door, path: string) =>
  `http://127.0.0.1:${String(door === 'people' ? state.ports.people : state.ports.machines)}${path}`

export async function call(state: ReadyState, options: {
  method: Method; path: string; as: Caller; login?: string; door?: Door; body?: JsonValue
}): Promise<Reply> {
  if (!options.path.startsWith('/v1/') && options.path !== '/') throw new Error(`the path must start with /v1/: ${options.path}`)
  const headers: Record<string, string> = {}
  const body = options.body === undefined ? undefined : JSON.stringify(options.body)
  // The API refuses a person's change that is not declared JSON, body or not, as the app sends it.
  if (options.method !== 'GET' && options.method !== 'HEAD') headers['content-type'] = 'application/json'
  const door = options.door ?? (options.as === 'person' ? 'people' : 'machines')
  if (options.as === 'person') headers['tailscale-user-login'] = options.login ?? state.seed.owner.login
  if (options.as === 'machine') headers.authorization = `Bearer ${state.seed.machine.token}`
  if (options.as === 'webhook') {
    const pipelineId = PIPELINE_HOOK.exec(options.path)?.[1]
    if (!pipelineId) throw new Error('a webhook call goes to /v1/hooks/pipelines/<pipeline id>')
    // The pipeline's secret is derived from the server's hook secret, as server/hooks.ts does.
    const secret = createHmac('sha256', config().AGENTS_HOOK_SECRET).update(pipelineId).digest('hex')
    headers['x-agents-signature'] = `sha256=${createHmac('sha256', secret).update(body ?? '').digest('hex')}`
  }
  const res = await fetch(url(state, door, options.path), { method: options.method, headers, body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  const text = await res.text()
  const parsed = text ? JSON_VALUE.safeParse(safeJson(text)) : { success: true as const, data: null }
  return { status: res.status, body: parsed.success ? parsed.data : text }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Not JSON, such as the app's HTML. The caller keeps the text instead.
    return undefined
  }
}

// A call that must succeed, parsed with the schema of what it answers.
export async function expectOk<T>(state: ReadyState, schema: z.ZodType<T>, options: Parameters<typeof call>[1]): Promise<T> {
  const reply = await call(state, options)
  if (reply.status < 200 || reply.status > 299) {
    throw new Error(`${options.method} ${options.path} as ${options.as} answered ${String(reply.status)}: ${JSON.stringify(reply.body)}`)
  }
  return schema.parse(reply.body)
}
