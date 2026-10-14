// The runner's attestation for a pull request: what it checked on the head
// commit, under which policy, with which builds. It lives in two places that
// must agree. The pull request's description carries the attestation itself,
// in a comment block a person never sees. The head commit carries a status
// whose text is the attestation's sha256. A CI job reads both, and accepts the
// pull request only when the digest matches, the attestation is for the head
// the pull request is at, and every step the core asks for passed. The design
// is in docs/design/self-improve.md, under "Attestation".

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { SHA, TOOL_BUILD } from './framework.ts'

export const ATTESTATION_STATUS = 'agents/attestation'
const BLOCK = /<!-- agents-attestation:v1 ([A-Za-z0-9_-]+) -->/
const STATUS_TEXT = /^v1 sha256:([0-9a-f]{64})$/

// The steps every attestation shows passed, by the evidence gate names they
// cover: the static gates, the box's gates, a review, the verdict and the
// suite on the merge result.
export const REQUIRED_STEPS = [
  { name: 'static gates', matches: (gate: string) => gate === 'protected' },
  { name: 'box gates', matches: (gate: string) => gate.startsWith('box:') },
  { name: 'review', matches: (gate: string) => gate.startsWith('review:') },
  { name: 'verdict', matches: (gate: string) => gate === 'verdict' },
  { name: 'suite', matches: (gate: string) => gate.startsWith('suite:') },
] as const

export const ATTESTATION = z.object({
  v: z.literal(1),
  tool: z.literal('agents'),
  repo: z.string().min(1),
  pullRequest: z.number().int().positive(),
  head: SHA,
  base: SHA,
  // The main the suite merged the change into.
  main: SHA,
  patchId: z.string().min(1),
  policy: z.object({ id: z.uuid(), name: z.string().min(1), version: z.number().int().positive() }),
  build: z.object({ runner: TOOL_BUILD, box: TOOL_BUILD.nullable(), checkHost: TOOL_BUILD.nullable() }),
  // Each gate's latest result on the head. `approved` is a gate that needed
  // the owner, who approved it.
  steps: z.array(z.object({ gate: z.string().min(1), result: z.enum(['pass', 'approved']) })),
  at: z.iso.datetime(),
})
export type Attestation = z.infer<typeof ATTESTATION>

// JSON with object keys sorted, so equal attestations hash the same.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const digestOf = (a: Attestation) => createHash('sha256').update(canonical(a)).digest('hex')
export const statusText = (a: Attestation) => `v1 sha256:${digestOf(a)}`
const blockOf = (a: Attestation) => `<!-- agents-attestation:v1 ${Buffer.from(canonical(a)).toString('base64url')} -->`

// The description with the attestation's block in place of any earlier one.
export function withAttestation(body: string, a: Attestation): string {
  const block = blockOf(a)
  return BLOCK.test(body) ? body.replace(BLOCK, () => block) : `${body.trimEnd()}\n\n${block}\n`
}

export type AttestationCheck = { ok: true; attestation: Attestation } | { ok: false; reason: string }

// What a CI job decides from a pull request's description, the text of the
// head commit's attestation status (null when it has none), and the head.
export function checkAttestation(body: string, status: string | null, head: string): AttestationCheck {
  const encoded = BLOCK.exec(body)?.[1]
  if (!encoded) return { ok: false, reason: 'the description has no attestation block' }
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch (error) {
    return { ok: false, reason: `the attestation block is not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  const parsed = ATTESTATION.safeParse(decoded)
  if (!parsed.success) return { ok: false, reason: `the attestation does not fit version 1: ${parsed.error.message}` }
  const attestation = parsed.data
  const digest = status === null ? undefined : STATUS_TEXT.exec(status)?.[1]
  if (!digest) return { ok: false, reason: `the head commit has no ${ATTESTATION_STATUS} status in the form "v1 sha256:<hex>"` }
  if (digest !== digestOf(attestation)) return { ok: false, reason: 'the attestation in the description does not match the digest on the head commit' }
  if (attestation.head !== head) return { ok: false, reason: `the attestation is for ${attestation.head}, and the pull request is at ${head}` }
  const missing = REQUIRED_STEPS.filter((step) => !attestation.steps.some((s) => step.matches(s.gate))).map((s) => s.name)
  if (missing.length) return { ok: false, reason: `the attestation lacks ${missing.join(', ')}` }
  return { ok: true, attestation }
}
