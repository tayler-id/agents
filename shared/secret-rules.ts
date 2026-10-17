// What a computer accepts as a secret set from the app: names it does not use for
// itself, and values the scrubber can find. The API checks them before it sends a
// value, and the daemon checks them again. The app does not compile this file,
// which reads ES2024 string methods. The design is "Secrets set from the app" in
// docs/design/target-architecture.md.

import { z } from 'zod'
import { SecretName } from './secrets.ts'
import { MIN_SECRET_LENGTH } from './scrub.ts'

// Names a computer uses for itself, which a value set under would be shadowed by
// or would confuse. The daemon reads a plugin's secret from its own environment
// before its file, so a value under any name that environment already holds
// would be ignored.
const OWN_NAMES: readonly string[] = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'PWD', 'DISPLAY']
const OWN_PREFIXES = ['AGENTS_', 'CLAUDE_', 'LD_'] as const
const PROXY_NAME = /(^|_)PROXY$/

// Why a computer would not take a value under this name, or null.
export function ownNameReason(name: string): string | null {
  if (OWN_NAMES.includes(name)) return `${name} is a name the computer uses for itself`
  const prefix = OWN_PREFIXES.find((start) => name.startsWith(start))
  if (prefix) return `a name that starts with ${prefix} belongs to the daemon or to Claude`
  if (PROXY_NAME.test(name)) return `${name} is a proxy setting`
  return null
}

// The name of a secret that can be set from the app.
export const SettableName = SecretName.superRefine((name, ctx) => {
  const reason = ownNameReason(name)
  if (reason) ctx.addIssue({ code: 'custom', message: reason })
})

// The longest value. A token or a private key fits well inside it.
export const SECRET_VALUE_MAX_BYTES = 4096

// A value long enough for the scrubber to find, which ignores anything shorter,
// and one it can find: it replaces text only after making it well formed and
// taking out NULs, so a value with either could never match.
export const SecretValue = z.string()
  .min(MIN_SECRET_LENGTH, `a value is at least ${String(MIN_SECRET_LENGTH)} characters, since the scrubber ignores anything shorter`)
  .refine((value) => new TextEncoder().encode(value).length <= SECRET_VALUE_MAX_BYTES, `a value is at most ${String(SECRET_VALUE_MAX_BYTES)} bytes`)
  .refine((value) => !value.includes('\u0000'), 'a value cannot hold a NUL character')
  .refine((value) => value.isWellFormed(), 'a value must be well-formed text')
export type SecretValue = z.infer<typeof SecretValue>

export const SetSecretBody = z.object({ value: SecretValue })
