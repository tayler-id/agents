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
// what is put there, so a computer with an owner takes values from that person alone.
// One with no owner, such as a team box, takes none, since any teammate's run may use
// it and read them. The API decides, and the page asks the same question, so it offers
// no field the API would refuse.
export const mayPutOn = (computerOwner: string | null, person: string): boolean => computerOwner !== null && computerOwner === person

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

// Every key an agent's plugins name, for the agent's Keys row and for each app's page. Both views are
// filtered from this one list. `state` is 'set' when the app put a value on the agent's computer and the
// record still says so. It is 'held' when the app did not, and the computer said, when it last connected,
// that its secrets file holds the name, such as a value put there by hand. It is 'missing' otherwise. A
// value only in the daemon's environment reads as missing, since a computer reports its file's names alone.
// `secretId` is the id for the set and remove routes, or null when no secrets row exists yet.
export const AgentKey = z.object({
  secretId: SecretId.nullable(),
  name: SecretName,
  plugins: z.array(z.string()),
  state: z.enum(['set', 'held', 'missing']),
  setAt: z.string().nullable(),
  setBy: z.string().nullable(),
})
export type AgentKey = z.infer<typeof AgentKey>

// `computer` is null when the agent has none. `missing` is the number of keys not set, and the red dot shows when it is above 0.
export const AgentKeys = z.object({
  agentId: AgentId,
  computer: z.string().nullable(),
  keys: z.array(AgentKey),
  missing: z.number().int().nonnegative(),
})
export type AgentKeys = z.infer<typeof AgentKeys>

// The team's agents, each with its count of keys and how many are missing, for a dot on a list.
export const KeySummaries = z.object({
  agents: z.array(z.object({ agentId: AgentId, total: z.number().int().nonnegative(), missing: z.number().int().nonnegative() })),
})
export type KeySummaries = z.infer<typeof KeySummaries>
