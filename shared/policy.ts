// A repo's policy: the rules every change to it must pass. It is stored as JSON
// in the policies table, and parsed here before anything reads it.

import { z } from 'zod'
import { ENGINE, WIDTH } from './verification.ts'
import { GATE_COMMAND, meets, PASSING_VERDICTS, PLAYBOOK_NAMES } from './framework.ts'

const paths = z.array(z.string().min(1))

// The core every policy keeps. A policy may add checks and tighten these, and
// never loosen them. The static gates, seen failing, review, the verdict, the
// suite and the owner's merge are not settings at all, so no policy can drop them.
export const CORE = {
  maxChangedLines: 400,
  verdict: { code: 'unit-test-verified', docs: 'type-check-only', ui: 'live-ui-verified' },
} as const

const SHAPE = z.object({
  // `box` means coding agents for this repo run only in a box.
  sandbox: z.enum(['box', 'any']),
  // Caps per run, on minutes spent working (not waiting on people) and on spend.
  maxRunMinutes: z.number().int().positive(),
  maxSpendUsd: z.number().positive(),
  // A change touching any of these stops at the owner's gate.
  protectedPaths: paths.min(1),
  maxChangedLines: z.number().int().positive(),
  lockfiles: paths,
  // A new file under these needs an entry in the parts document.
  sourceDirs: paths,
  // Files that may be in a language other than TypeScript.
  allowedFiles: paths,
  docs: z.object({ dataModel: z.string().min(1), parts: z.string().min(1), buildLog: z.string().min(1), migrations: z.string().min(1) }),
  // Check files, the marker on the ones a box can run, and how to run one, with
  // {file} standing for its path.
  checks: z.object({
    pattern: z.string().min(1),
    // Files the checks rely on, such as their helpers. Editing one counts as
    // editing a check.
    related: paths,
    boxMarker: z.string().min(1),
    argv: z.array(z.string().min(1)).min(1),
    timeoutSec: z.number().int().positive(),
  }),
  // What the box runs on the change, with the overlay files taken from main.
  box: z.object({ overlay: paths, commands: z.array(GATE_COMMAND).min(1) }),
  // What the check host runs on the result of merging into main.
  suite: z.object({ commands: z.array(GATE_COMMAND).min(1), evidence: z.string().min(1) }),
  // A change under these paths needs a Playwright check covering each engine and width.
  ui: z.object({ paths: paths.min(1), engines: z.array(ENGINE).min(1), widths: z.array(WIDTH).min(1) }).nullable(),
  lint: z.object({
    // The stylesheet whose :root defines the design tokens, and the tokens that
    // are neutral. Every other token is an accent.
    css: z.object({ files: paths, tokens: z.string().min(1), neutral: z.array(z.string().min(1)).min(1) }),
    prose: z.object({ banned: z.array(z.string().min(1)), properNouns: z.array(z.string().min(1)), exempt: paths }),
  }),
  dependencies: z.object({ manifests: paths }),
  // How many reviewers on distinct models, how many rounds before the owner
  // decides, and the document whose bold rule names a finding must cite.
  review: z.object({ reviewers: z.number().int().min(1), rounds: z.number().int().min(1), rubric: z.string().min(1) }),
  // The weakest verdict a change may merge with: for code, for a change to
  // documents only, and for a change to the UI.
  verdict: z.object({ code: z.enum(PASSING_VERDICTS), docs: z.enum(PASSING_VERDICTS), ui: z.enum(PASSING_VERDICTS) }),
  // An agent with no tool call or finished turn for this long is replaced by a
  // fresh session, at most this many times in a stage, before a person decides.
  liveness: z.object({ minutes: z.number().int().positive(), replacements: z.number().int().min(0) }),
  // Limits across runs on the repo. Spend a day for the repo, and less for
  // reports from someone outside the team, stops a run before it starts. Runs
  // an hour and runs at once make a run wait its turn. A cap that stops a run
  // says so once, on the report's issue.
  caps: z.object({
    repoDailyUsd: z.number().positive(),
    outsiderDailyUsd: z.number().positive(),
    runsPerHour: z.number().int().positive(),
    concurrent: z.number().int().positive(),
  }),
  playbooks: z.array(z.enum(PLAYBOOK_NAMES)).min(1),
  principles: z.array(z.object({ name: z.string().min(1), text: z.string().min(1) })),
  verification: z.object({ skill: z.string().min(1), features: z.string().min(1) }).nullable(),
})

export const POLICY = SHAPE.superRefine((policy, ctx) => {
  if (policy.maxChangedLines > CORE.maxChangedLines) {
    ctx.addIssue({ code: 'custom', path: ['maxChangedLines'], message: `may not exceed the core's ${CORE.maxChangedLines}` })
  }
  for (const kind of ['code', 'docs', 'ui'] as const) {
    if (!meets(policy.verdict[kind], CORE.verdict[kind])) {
      ctx.addIssue({ code: 'custom', path: ['verdict', kind], message: `may not be weaker than the core's ${CORE.verdict[kind]}` })
    }
  }
})

export type Policy = z.infer<typeof POLICY>
