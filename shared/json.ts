// Text from outside, parsed as JSON and then by a schema. Bad JSON is an answer,
// not an exception, so a stray message can't crash whoever reads it.

import { z } from 'zod'

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string }

export function parseJson<S extends z.ZodType>(schema: S, text: string): Parsed<z.infer<S>> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false, reason: 'not JSON' }
    throw error
  }
  const parsed = schema.safeParse(value)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: z.prettifyError(parsed.error) }
}
