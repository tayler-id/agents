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

// Electric answers a shape's first read with the snapshot it took when the
// shape was made, and each later read with the changes after the offset it
// names. This many reads is far more than an instance's shapes need to catch up.
const SHAPE_READS = 20

const ShapeMessage = z.object({
  key: z.string().optional(),
  value: z.record(z.string(), JSON_VALUE).optional(),
  headers: z.object({ operation: z.enum(['insert', 'update', 'delete']).optional(), control: z.string().optional() }),
})
export type ShapeRead = { ok: true; rows: Record<string, JsonValue>[] } | { ok: false; why: string }

// The rows a shape holds now, as the owner reads it the way the app does: the
// snapshot, then each next offset, until Electric says the reader is up to date.
export async function readShape(state: ReadyState, table: string): Promise<ShapeRead> {
  const rows = new Map<string, Record<string, JsonValue>>()
  let offset = '-1'
  let handle: string | null = null
  for (let read = 0; read < SHAPE_READS; read++) {
    const query: URLSearchParams = new URLSearchParams({ offset, ...(handle === null ? {} : { handle }) })
    const res: Response = await fetch(url(state, 'people', `/v1/shape/${table}?${query.toString()}`), {
      headers: { 'tailscale-user-login': state.seed.owner.login }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const text = await res.text()
    // Electric replaced the shape: read the new one from its snapshot.
    if (res.status === 409) {
      rows.clear()
      offset = '-1'
      handle = res.headers.get('electric-handle')
      continue
    }
    if (res.status !== 200) return { ok: false, why: `the ${table} shape answered ${String(res.status)}: ${text.slice(0, 200)}` }
    const messages = z.array(ShapeMessage).safeParse(safeJson(text))
    if (!messages.success) return { ok: false, why: `the ${table} shape is not a list of messages: ${messages.error.message}` }
    for (const message of messages.data) {
      const { operation } = message.headers
      if (operation === undefined || message.key === undefined) continue
      if (operation === 'delete') rows.delete(message.key)
      else rows.set(message.key, { ...rows.get(message.key), ...message.value })
    }
    if (res.headers.has('electric-up-to-date')) return { ok: true, rows: [...rows.values()] }
    handle = res.headers.get('electric-handle')
    const next = res.headers.get('electric-offset')
    if (handle === null || next === null) return { ok: false, why: `the ${table} shape answered without the handle and offset to read on from` }
    offset = next
  }
  return { ok: false, why: `the ${table} shape was still not up to date after ${String(SHAPE_READS)} reads` }
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
