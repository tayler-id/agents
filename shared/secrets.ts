// Secrets set from the app. A secret's name lives in Postgres and its value only
// on the computer that needs it. These are the shapes the API, the daemon and
// the app share, and the app compiles this file, so it reads no Node API. What a
// computer accepts is in secret-rules.ts. The design is "Secrets set from the app"
// in docs/design/target-architecture.md.

import { z } from 'zod'
import { AgentId } from './ids.ts'
import { InstanceId, PersonId, TeamId } from './onboarding.ts'

export const SecretId = z.uuid().brand<'SecretId'>()
export type SecretId = z.infer<typeof SecretId>

// A name in the shape of an environment variable, such as SENTRY_TOKEN. A plugin
// names its secrets this way, and the database checks it too.
export const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/
export const SECRET_NAME_MAX = 128
export const SecretName = z.string().max(SECRET_NAME_MAX).regex(SECRET_NAME)

// What setting or removing a value answers. Names, never the value.
export const SecretStored = z.object({ name: SecretName, computer: z.string(), setAt: z.string() })
export type SecretStored = z.infer<typeof SecretStored>
// `had` is false when the computer held no value, so removing it changed nothing.
export const SecretRemoved = z.object({ name: SecretName, computer: z.string(), had: z.boolean() })
export type SecretRemoved = z.infer<typeof SecretRemoved>

// Whether a person may put a value on a computer. Every agent on a computer can read
// what is put there, so a computer with an owner takes values from that person alone,
// and one with none takes them from anyone on the team. The API decides, and the page
// asks the same question, so it offers no field the API would refuse.
export const mayPutOn = (computerOwner: string | null, person: string): boolean => computerOwner === null || computerOwner === person

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
