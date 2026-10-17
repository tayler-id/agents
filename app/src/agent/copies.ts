// The calls behind an agent's hooks and its copy. The components beside this file take
// them as props, so a screen can pass these or its own.

import type { z } from 'zod'
import { call } from '../data.ts'
import { Done } from '../../../shared/onboarding.ts'
import { RecipeFile, type ImportAsk } from '../../../shared/recipe-file.ts'
import { CopyDone, HookSaved, type CopyAsk, type HookAsk } from '../../../shared/recipe.ts'

// Saves a hook, or changes the one of the same name. The answer names it.
export const saveHook = (agentId: string, ask: HookAsk) => call(HookSaved, 'POST', `/v1/agents/${agentId}/hooks`, ask)

export const removeHook = (agentId: string, name: string) =>
  call(Done, 'POST', `/v1/agents/${agentId}/hooks/${encodeURIComponent(name)}/delete`, {})

// A new agent of the person's own with this agent's setup. With no ask, the server names it, puts it on
// the person's own machine and gives it the team's memories. The answer holds the conversation with it.
export const copyAgent = (agentId: string, ask: z.input<typeof CopyAsk> = {}) => call(CopyDone, 'POST', `/v1/agents/${agentId}/copy`, ask)

// An agent's setup as a file, with a plugin's secrets by name, values in known key formats removed, and nothing
// the agent remembers about a person.
// The team's memories are in it only when asked for.
export const recipeFileOf = (agentId: string, memories: boolean) => call(RecipeFile, 'GET', `/v1/agents/${agentId}/recipe?memories=${String(memories)}`)

// A new agent of the person's own from a file. It takes the name the file offers, or the next free one,
// and goes on the person's own machine.
export const importRecipeFile = (file: RecipeFile, ask: Omit<z.input<typeof ImportAsk>, 'file'> = {}) =>
  call(CopyDone, 'POST', '/v1/agents/import', { file, ...ask })
