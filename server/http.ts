// What every route shares: who a route is for, its handler's shape, and reading
// a request's body.

import type { IncomingMessage } from 'node:http'
import type { z } from 'zod'
import { HttpError } from './record.ts'
import { readBody as readWhole } from '../shared/body.ts'
import { MAX_BODY_BYTES } from '../shared/types.ts'

// People reach the API only through tailscale serve, on a Unix socket. Machines,
// boxes included, reach it on a loopback port with their tokens. Containers and
// tailnet peers can reach that port, so it never accepts a person's identity.
export type Audience = 'people' | 'machines'

// The parts of the path a route's pattern captures, in order. Every group in a
// route's pattern is required, so a match always fills the ones it has.
export type Params = readonly [string, string, string]
export type Handler = (req: IncomingMessage, params: Params, url: URL) => Promise<unknown>
export type Route = [Audience, string, RegExp, Handler]

// A handler's answer is JSON with status 200. These two change that: a created thing
// answers 201, and a file answers its bytes with the headers the handler sets.
export class Created {
  readonly body: unknown
  constructor(body: unknown) {
    this.body = body
  }
}
export class FileAnswer {
  readonly bytes: Buffer
  readonly headers: Record<string, string>
  constructor(bytes: Buffer, headers: Record<string, string>) {
    this.bytes = bytes
    this.headers = headers
  }
}

export const readBody = (req: IncomingMessage): Promise<Buffer> => readWhole(req, MAX_BODY_BYTES, () => new HttpError(413, 'body too large'))

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req)
  let value: unknown
  try {
    value = JSON.parse(body.toString('utf8') || '{}')
  } catch {
    throw new HttpError(400, 'body must be JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'body must be a JSON object')
  return value as Record<string, unknown>
}

// A JSON body read through its schema. A body that does not fit answers 400 with
// what is wrong, in the schema's own words.
export async function parseBody<S extends z.ZodType>(req: IncomingMessage, schema: S): Promise<z.output<S>> {
  const result = schema.safeParse(await readJson(req))
  if (!result.success) throw new HttpError(400, problems(result.error))
  return result.data
}

// An id from a route's path, as its own type. One that cannot be an id names nothing.
export function pathId<S extends z.ZodType>(schema: S, value: string): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new HttpError(404, 'not found')
  return result.data
}

export function problems(error: z.ZodError): string {
  return error.issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message)).join('; ')
}

// A property of a value from outside, which may be anything at all.
export const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined

export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new HttpError(400, `${field} must be a non-empty string`)
  return value
}

export function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined || value === null ? undefined : text(value, field)
}
