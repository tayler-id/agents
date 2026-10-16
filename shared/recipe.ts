// An agent's setup as a recipe, the part of it that can be copied to another agent
// or saved as a template. Defined once for the server and the app. A recipe holds
// no secret value. A plugin names the secrets it needs, and each machine holds the
// values. It holds no memory about a person either, only the team's.

import { z } from 'zod'
import { AgentHook, AgentPlugin, AgentSkill, HookEvent } from './types.ts'
import { AgentId } from './ids.ts'
import { InstanceId, type TeamRole } from './onboarding.ts'

export const RecipeRoutine = z.object({ name: z.string(), prompt: z.string(), schedule: z.string() })

// What an agent remembers about the team: its one profile, and a log for each day.
export const RecipeMemory = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('profile'), content: z.string() }),
  z.object({ kind: z.literal('log'), date: z.iso.date(), content: z.string() }),
])
export type RecipeMemory = z.infer<typeof RecipeMemory>

export const Recipe = z.object({
  title: z.string().nullable(),
  role: z.string().nullable(),
  instructions: z.string(),
  model: z.string().nullable(),
  skills: z.array(AgentSkill),
  plugins: z.array(AgentPlugin),
  routines: z.array(RecipeRoutine),
  // A recipe saved before hooks and memories existed has neither.
  hooks: z.array(AgentHook).default([]),
  memories: z.array(RecipeMemory).default([]),
}).refine((recipe) => recipe.memories.filter((m) => m.kind === 'profile').length <= 1, {
  path: ['memories'], message: 'a recipe holds at most one team profile',
}).refine((recipe) => {
  const days = recipe.memories.flatMap((m) => (m.kind === 'log' ? [m.date] : []))
  return new Set(days).size === days.length
}, { path: ['memories'], message: 'a recipe holds one log for each day' })
export type Recipe = z.infer<typeof Recipe>

// Asking to copy an agent. `memories` says whether the team's memories come along.
export const CopyAsk = z.object({ name: z.string(), homeInstanceId: InstanceId, memories: z.boolean() })
export type CopyAsk = z.infer<typeof CopyAsk>

// What a new agent got from a recipe, by kind.
export const Carried = z.object({
  skills: z.number().int(), plugins: z.number().int(), routines: z.number().int(), hooks: z.number().int(), memories: z.number().int(),
})
export type Carried = z.infer<typeof Carried>
export const CopyDone = z.object({ agentId: AgentId, carried: Carried })
export type CopyDone = z.infer<typeof CopyDone>

export const carriedBy = (recipe: Recipe): Carried => ({
  skills: recipe.skills.length, plugins: recipe.plugins.length, routines: recipe.routines.length,
  hooks: recipe.hooks.length, memories: recipe.memories.length,
})

// An agent_hooks row as the app reads it through the agent_hooks shape.
export const HookRow = z.object({
  id: z.string(), agent_id: z.string(), name: z.string(), event: HookEvent, matcher: z.string().nullable(), command: z.string(),
  timeout_sec: z.number().nullable(),
})
export type HookRow = z.infer<typeof HookRow>

// A hook runs a command on the agent's machine, as a plugin does, so only the
// agent's owner or a team admin changes one. The server refuses anyone else, and
// the app uses the same rule to leave out the controls that would be refused.
export function mayChangeHooks(person: { id: string; role: TeamRole }, agent: { owner_id: string | null }): boolean {
  return person.role === 'admin' || agent.owner_id === person.id
}
