// Evidence: what a run did and what it found, kept in the instance's evidence
// folder under .scratch/verify/evidence, which `down` never removes. Every agentsctl
// command adds a line to actions.jsonl saying what it did and how it went, and
// commands that capture something (a screenshot, an ARIA snapshot, a response,
// rows) write it beside that log under a numbered name, so the folder reads in
// the order things happened.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

export const Action = z.object({
  at: z.iso.datetime(),
  command: z.string(),
  args: z.array(z.string()),
  ok: z.boolean(),
  summary: z.string(),
  files: z.array(z.string()),
})
export type Action = z.infer<typeof Action>

export const ACTIONS_FILE = 'actions.jsonl'

export function record(evidence: string, action: Omit<Action, 'at'>) {
  mkdirSync(evidence, { recursive: true })
  appendFileSync(join(evidence, ACTIONS_FILE), `${JSON.stringify(Action.parse({ ...action, at: new Date().toISOString() }))}\n`)
}

export function actions(evidence: string): Action[] {
  const file = join(evidence, ACTIONS_FILE)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => Action.parse(JSON.parse(line)))
}

// A name for the next capture in a folder: 001-label.ext, 002-..., in the order taken.
export function nextPath(evidence: string, folder: string, label: string, ext: string): string {
  const dir = join(evidence, folder)
  mkdirSync(dir, { recursive: true })
  const n = readdirSync(dir).length + 1
  const safe = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || folder
  return join(dir, `${String(n).padStart(3, '0')}-${safe}.${ext}`)
}
