// A recipe as a file one team hands to another, and what an import takes. It is
// apart from recipe.ts so that a team that does not let setups leave can leave this out.

import { z } from 'zod'
import { InstanceId } from './onboarding.ts'
import { Recipe } from './recipe.ts'

// The most of any one thing a file may hold. An agent uses a handful of each, and
// the server writes a row for every one, so a file cannot be the reason it writes thousands.
export const MAX_RECIPE_ITEMS = 1000

export const RECIPE_FILE_FORMAT = 'agents-recipe'

export const RecipeFile = z.object({
  format: z.literal(RECIPE_FILE_FORMAT),
  version: z.literal(1),
  // The agent's name when it was exported, offered as the new agent's.
  name: z.string().max(100),
  recipe: Recipe,
}).refine(({ recipe }) => [recipe.skills, recipe.plugins, recipe.routines, recipe.hooks, recipe.memories].every((list) => list.length <= MAX_RECIPE_ITEMS), {
  path: ['recipe'], message: `a recipe file holds at most ${String(MAX_RECIPE_ITEMS)} of any one thing`,
})
export type RecipeFile = z.infer<typeof RecipeFile>

// Importing a file as a new agent. With no name, it takes the one the file offers, or the next free one.
// With no machine, it goes on the person's own, as a copy does.
export const ImportAsk = z.object({ file: RecipeFile, name: z.string().optional(), homeInstanceId: InstanceId.optional() })
export type ImportAsk = z.infer<typeof ImportAsk>
