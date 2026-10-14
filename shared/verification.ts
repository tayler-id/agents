// What a verification run leaves behind, and the feature map that says what to
// verify. agentsctl writes and reads both through these schemas, and the
// framework's gates read them with the same ones, so the two never drift.

import { z } from 'zod'

// The browser engines and widths a UI check covers.
export const ENGINES = ['chromium', 'firefox', 'webkit'] as const
export const ENGINE = z.enum(ENGINES)
export type Engine = z.infer<typeof ENGINE>
export const WIDTHS = ['desktop', 'phone'] as const
export const WIDTH = z.enum(WIDTHS)
export type Width = z.infer<typeof WIDTH>

export const SHA256 = z.string().regex(/^[0-9a-f]{64}$/)

// One capture of a view: which view, in which engine at which width, the file
// relative to the checkout, and that file's sha256, so a reader can tell the
// file is the one the run took.
export const SHOT = z.object({
  view: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  engine: ENGINE,
  width: WIDTH,
  path: z.string().min(1),
  sha256: SHA256,
})
export type Shot = z.infer<typeof SHOT>

// A run's evidence.json: every capture the run took, one per view, engine and width.
export const EVIDENCE_MANIFEST = z.object({ shots: z.array(SHOT) }).superRefine((manifest, ctx) => {
  const seen = new Set<string>()
  for (const shot of manifest.shots) {
    const key = `${shot.view} ${shot.engine} ${shot.width}`
    if (seen.has(key)) ctx.addIssue({ code: 'custom', message: `two shots of ${key}` })
    seen.add(key)
  }
})
export type EvidenceManifest = z.infer<typeof EVIDENCE_MANIFEST>
export const EVIDENCE_MANIFEST_FILE = 'evidence.json'

// What a verification proved, strongest first. A verdict comes from an agent
// that did not write the change. The first three pass. Blocked means the proof
// could not run, which is neither a pass nor a fail.
export const VERDICTS = ['live-ui-verified', 'unit-test-verified', 'type-check-only', 'verifier-blocked', 'verifier-failed'] as const
export const VERDICT = z.enum(VERDICTS)
export type Verdict = z.infer<typeof VERDICT>

// One user-facing feature in a repo's feature map: the paths it lives in, and
// the checks that show it works.
export const FEATURE_ID = z.string().regex(/^[a-z][a-z0-9-]*$/)
export const FEATURE = z.object({
  id: FEATURE_ID,
  name: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  checks: z.array(z.string().min(1)),
})
export type Feature = z.infer<typeof FEATURE>

// The map the framework's gates read, features.json beside the feature files.
export const FEATURE_MAP = z.object({ features: z.array(FEATURE).min(1) }).superRefine((map, ctx) => {
  const seen = new Set<string>()
  for (const feature of map.features) {
    if (seen.has(feature.id)) ctx.addIssue({ code: 'custom', message: `the feature id ${feature.id} appears twice` })
    seen.add(feature.id)
  }
})
export type FeatureMap = z.infer<typeof FEATURE_MAP>
export const FEATURE_MAP_FILE = 'features.json'

// A feature file is Markdown, and its map entry is the one ```json block between
// its title and its first section. Returns the entry, or throws naming the file
// and what is wrong with it.
export function featureEntryOf(markdown: string, file: string): Feature {
  const firstSection = markdown.search(/^## /m)
  const preamble = firstSection === -1 ? markdown : markdown.slice(0, firstSection)
  const blocks = [...preamble.matchAll(/^```json\n([\s\S]*?)^```$/gm)]
  const [block] = blocks
  if (blocks.length !== 1 || block?.[1] === undefined) {
    throw new Error(`${file} needs one \`\`\`json block between its title and its first section, holding its map entry, and has ${String(blocks.length)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(block[1])
  } catch (error) {
    throw new Error(`${file}: its map entry is not JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const entry = FEATURE.safeParse(parsed)
  if (!entry.success) throw new Error(`${file}: its map entry does not fit the feature map's schema: ${z.prettifyError(entry.error)}`)
  return entry.data
}
