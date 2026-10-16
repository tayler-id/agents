// The calls behind an agent's hooks and its copy. The components beside this file take
// them as props, so a screen can pass these or its own.

import type { z } from 'zod'
import { call } from '../data.ts'
import { Done } from '../../../shared/onboarding.ts'
import { CopyDone, HookSaved, type CopyAsk, type HookAsk } from '../../../shared/recipe.ts'

// Saves a hook, or changes the one of the same name. The answer names it.
export const saveHook = (agentId: string, ask: HookAsk) => call(HookSaved, 'POST', `/v1/agents/${agentId}/hooks`, ask)

export const removeHook = (agentId: string, name: string) =>
  call(Done, 'POST', `/v1/agents/${agentId}/hooks/${encodeURIComponent(name)}/delete`, {})

// A new agent of the person's own with this agent's setup. With no ask, the server names it, puts it on
// the person's own machine and gives it the team's memories. The answer holds the conversation with it.
export const copyAgent = (agentId: string, ask: z.input<typeof CopyAsk> = {}) => call(CopyDone, 'POST', `/v1/agents/${agentId}/copy`, ask)
