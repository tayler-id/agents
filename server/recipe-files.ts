// Recipes as files. A person exports an agent's setup as a file, and a person on
// another team, or the same one, imports it as a new agent of their own. Apart from
// agents.ts so that a team that does not let setups leave can leave this out.

import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { z } from 'zod'
import { RECIPE_FILE_FORMAT, RecipeFile, type ImportAsk } from '../shared/recipe-file.ts'
import type { CopyDone } from '../shared/recipe.ts'
import { agentFromRecipe, agentOf, defaultMachine, freeName, recipeOf } from './agents.ts'
import { HttpError, scrub, type Person } from './record.ts'

// The file for an agent. What leaves the team is scrubbed, whatever a person once
// pasted into a skill or a log. The team's memories are in it only when asked for.
export async function exportRecipe(client: pg.PoolClient, person: Person, agentId: string, withMemories: boolean): Promise<RecipeFile> {
  const agent = await agentOf(client, person, agentId)
  const recipe = await recipeOf(client, agent.id, withMemories)
  const file = RecipeFile.safeParse(scrub({ format: RECIPE_FILE_FORMAT, version: 1, name: agent.name, recipe }))
  if (!file.success) throw new HttpError(409, `This agent's setup can't be written as a file. ${z.prettifyError(file.error)}`)
  return file.data
}

// A new agent from a file. What enters the record is never a secret value and never text
// Postgres can't hold, such as a NUL character, so a file that has either is refused and
// nothing is made. The scrubber changes both, which is how they are found.
export async function importRecipe(client: pg.PoolClient, person: Person, ask: ImportAsk): Promise<CopyDone> {
  if (!isDeepStrictEqual(scrub(ask.file), ask.file)) {
    throw new HttpError(400, 'The file holds something that looks like a secret value, such as an API key, or text the record cannot store. Take it out and import the file again.')
  }
  return agentFromRecipe(client, person, {
    name: ask.name ?? await freeName(client, person.team_id, ask.file.name, ''),
    homeInstanceId: ask.homeInstanceId ?? await defaultMachine(client, person),
  }, ask.file.recipe, null)
}
