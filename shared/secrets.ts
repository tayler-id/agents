// Secrets set from the app. A secret's name lives in Postgres and its value only
// on the computer that needs it. These are the shapes the API, the daemon and
// the app share. The design is "Secrets set from the app" in
// docs/design/target-architecture.md.

import { z } from 'zod'
import { AgentId } from './ids.ts'
import { InstanceId, PersonId, TeamId } from './onboarding.ts'
import { MIN_SECRET_LENGTH } from './scrub.ts'

export const SecretId = z.uuid().brand<'SecretId'>()
export type SecretId = z.infer<typeof SecretId>

// A name in the shape of an environment variable, such as SENTRY_TOKEN. A plugin
// names its secrets this way, and the database checks it too.
export const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/
export const SECRET_NAME_MAX = 128
export const SecretName = z.string().max(SECRET_NAME_MAX).regex(SECRET_NAME)

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

// What setting or removing a value answers. Names, never the value.
export const SecretStored = z.object({ name: SecretName, computer: z.string(), setAt: z.string() })
export type SecretStored = z.infer<typeof SecretStored>
// `had` is false when the computer held no value, so removing it changed nothing.
export const SecretRemoved = z.object({ name: SecretName, computer: z.string(), had: z.boolean() })
export type SecretRemoved = z.infer<typeof SecretRemoved>

// A timestamp as Postgres writes it in text, which is how Electric sends it.
const Time = z.string().min(1)

// The rows the app reads, through the `secrets` and `secret_sets` shapes. The
// first holds the names agents' plugins need, the second where a name was set.
export const SecretRow = z.object({
  id: SecretId,
  team_id: TeamId,
  scope: z.enum(['person', 'team', 'agent']),
  agent_id: AgentId.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  stored_in: z.string(),
})
export type SecretRow = z.infer<typeof SecretRow>

export const SecretSetRow = z.object({
  id: z.uuid(),
  team_id: TeamId,
  instance_id: InstanceId,
  name: z.string(),
  set_by: PersonId.nullable(),
  set_at: Time,
})
export type SecretSetRow = z.infer<typeof SecretSetRow>
