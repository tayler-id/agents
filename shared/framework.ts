// The coding framework's shapes, defined once for the server, the daemon and
// the checks. Each one that crosses a boundary is a zod schema, and its type is
// inferred from it. The design is docs/design/self-improve.md.

import { z } from 'zod'
import { SHOT, type FeatureMap, type Verdict } from './verification.ts'

// Ids of the framework's own tables, so one can never stand in for another.
export const POLICY_ID = z.uuid().brand<'PolicyId'>()
export type PolicyId = z.infer<typeof POLICY_ID>
export const FINDING_ID = z.uuid().brand<'FindingId'>()
export type FindingId = z.infer<typeof FINDING_ID>
export const DEPLOY_ID = z.uuid().brand<'DeployId'>()
export type DeployId = z.infer<typeof DEPLOY_ID>

// A git commit, as git prints it.
export const SHA = z.string().regex(/^[0-9a-f]{40}$/)

// The commit statuses the runner sets on the forge, one per kind of gate.
// Branch protection on a repo with a policy requires every one.
export const STATUS = { gates: 'agents/gates', review: 'agents/review', verdict: 'agents/verdict', suite: 'agents/suite' } as const

// How a gate ended. needs_owner passes only once the repo's owner approves it.
export const GATE_STATUSES = ['pass', 'fail', 'needs_owner'] as const
export type GateStatus = (typeof GATE_STATUSES)[number]

// One thing a gate found, located where it can be.
export type Finding = { path: string | null; line: number | null; text: string }

// What one gate decided about one commit. `stops` ends the run at once instead
// of sending the change back to its author.
export type GateResult = { gate: string; status: GateStatus; summary: string; findings: Finding[]; stops: boolean }

// A command a machine runs for a gate: a name for the evidence, an argument
// list, never a shell string, and how long it may take.
export const GATE_COMMAND = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  argv: z.array(z.string().min(1)).min(1),
  timeoutSec: z.number().int().positive(),
})
export type GateCommand = z.infer<typeof GATE_COMMAND>

export const COMMAND_RESULT = z.object({
  name: z.string(),
  argv: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  seconds: z.number(),
  output: z.string(),
})
export type CommandResult = z.infer<typeof COMMAND_RESULT>

// A changed check run on main's code, where it must fail, and on the change,
// where it must pass.
export const SEEN_FAILING = z.object({ file: z.string(), base: COMMAND_RESULT, change: COMMAND_RESULT })
export type SeenFailing = z.infer<typeof SEEN_FAILING>

// The build of the code that produced a result. See shared/build.ts.
export const TOOL_BUILD = z.object({ commit: SHA.nullable(), files: z.string().regex(/^[0-9a-f]{64}$/), node: z.string().min(1) })
export type ToolBuild = z.infer<typeof TOOL_BUILD>
// The sha256 of each file a result read from main, by path, null when main lacks it.
export const INPUTS = z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/).nullable())
export type Inputs = z.infer<typeof INPUTS>
// What an evidence row records of the code and inputs behind it: the
// runner's build, the build of the machine that ran the gate when one did,
// and the inputs from main.
export const EVIDENCE_BUILD = z.object({ runner: TOOL_BUILD, worker: TOOL_BUILD.nullable(), inputs: INPUTS })
export type EvidenceBuild = z.infer<typeof EVIDENCE_BUILD>

// The box's part of verify, run by the daemon in the task's workspace.
export const VERIFY_PAYLOAD = z.object({
  workspaceId: z.uuid(),
  repo: z.string().min(1),
  head: SHA,
  base: SHA,
  overlay: z.array(z.string()),
  commands: z.array(GATE_COMMAND),
  checks: z.array(z.string()),
  checkArgv: z.array(z.string()).min(1),
  checkTimeoutSec: z.number().int().positive(),
})
export type VerifyPayload = z.infer<typeof VERIFY_PAYLOAD>
export const VERIFY_RESULT = z.object({ build: TOOL_BUILD, commands: z.array(COMMAND_RESULT), checks: z.array(SEEN_FAILING) })
export type VerifyResult = z.infer<typeof VERIFY_RESULT>

// The check host's full suite on the result of merging the change into main.
export const SUITE_PAYLOAD = z.object({
  repoId: z.uuid(),
  name: z.string().min(1),
  main: z.string().min(1),
  branch: z.string().min(1),
  head: SHA,
  setup: z.string().nullable(),
  commands: z.array(GATE_COMMAND).min(1),
  checks: z.array(z.string()),
  checkArgv: z.array(z.string()).min(1),
  checkTimeoutSec: z.number().int().positive(),
  // Where agentsctl writes its evidence.json, relative to the checkout.
  evidence: z.string().min(1),
})
export type SuitePayload = z.infer<typeof SUITE_PAYLOAD>
export const SUITE_RESULT = z.discriminatedUnion('merged', [
  z.object({ merged: z.literal(false), build: TOOL_BUILD, main: SHA, conflict: z.string() }),
  z.object({
    merged: z.literal(true), build: TOOL_BUILD, main: SHA, commands: z.array(COMMAND_RESULT), checks: z.array(SEEN_FAILING), shots: z.array(SHOT),
  }),
])
export type SuiteResult = z.infer<typeof SUITE_RESULT>

// Findings about these always go to a person, whatever the author makes of them.
export const SENSITIVE_TOPICS = ['security', 'auth', 'billing', 'data', 'migrations', 'concurrency'] as const

// What a reviewer or a verifier reports, through report_result's data.
export const REVIEW_FINDING = z.object({
  rule: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive().nullable(),
  body: z.string().min(1),
  blocking: z.boolean(),
  topic: z.enum(SENSITIVE_TOPICS).nullable(),
})
export type ReviewFinding = z.infer<typeof REVIEW_FINDING>
export const REVIEW_DATA = z.object({ findings: z.array(REVIEW_FINDING) })
export const REVIEW_OUTCOMES = ['clean', 'blocking'] as const

// Text inside a Markdown fence longer than any run of backticks in it, so
// the text can never end the fence and pass for the page around it.
export function fenced(text: string, language = ''): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${text}\n${fence}`
}

// What a machine reports must answer what it was asked: every command it was
// sent, in order and with the same arguments, after the repo's setup command
// when there is one, and every check once. A result that differs is no
// evidence, and the stage stops on it.
export function resultProblems(
  asked: { commands: readonly GateCommand[]; checks: readonly string[]; setup: string | null },
  got: { commands: readonly CommandResult[]; checks: readonly SeenFailing[] },
): string[] {
  const problems: string[] = []
  const line = (c: { name: string; argv: readonly string[] }) => `${c.name}: ${c.argv.join(' ')}`
  let ran = [...got.commands]
  if (asked.setup !== null) {
    const setup = ran[0]
    if (!setup || line(setup) !== line({ name: 'setup', argv: ['sh', '-c', asked.setup] })) return [`it did not run the repo's setup command first`]
    ran = ran.slice(1)
    // A setup that failed stops the commands after it, which the result shows.
    if (setup.exitCode !== 0 && !ran.length) return problems
  }
  const want = asked.commands.map(line)
  const have = ran.map(line)
  if (want.join('\n') !== have.join('\n')) problems.push(`it ran ${have.join('; ') || 'nothing'}, and was asked to run ${want.join('; ')}`)
  const files = got.checks.map((c) => c.file)
  if ([...files].sort().join('\n') !== [...asked.checks].sort().join('\n') || new Set(files).size !== files.length) {
    problems.push(`it ran the checks ${files.join(', ') || 'none'}, and was asked for ${asked.checks.join(', ') || 'none'}`)
  }
  return problems
}

// A finding's rule as it is compared: without case, extra spacing or a closing period.
export const ruleOf = (rule: string) => rule.trim().replace(/\.$/, '').replace(/\s+/g, ' ').toLowerCase()

// The verdicts that pass, from the ladder in shared/verification.ts, strongest first.
export const PASSING_VERDICTS = ['live-ui-verified', 'unit-test-verified', 'type-check-only'] as const satisfies readonly Verdict[]
export type PassingVerdict = (typeof PASSING_VERDICTS)[number]
export const passingVerdict = (verdict: Verdict): PassingVerdict | null => PASSING_VERDICTS.find((v) => v === verdict) ?? null
// Whether a passing verdict is at least as strong as the floor a policy sets.
export const meets = (verdict: PassingVerdict, floor: PassingVerdict) => PASSING_VERDICTS.indexOf(verdict) <= PASSING_VERDICTS.indexOf(floor)
// What a verifier reports beside its verdict.
export const VERIFIER_DATA = z.object({ findings: z.array(REVIEW_FINDING) })

export type NonEmpty<T> = readonly [T, ...T[]]
export function nonEmpty<T>(items: readonly T[]): NonEmpty<T> | null {
  const [first, ...rest] = items
  return first === undefined ? null : [first, ...rest]
}

// Whether a change may merge. Ready carries its proof, so a merge can only be
// asked for with every part of it in hand. Stale means the suite ran on a main
// that has since moved.
// The verdict a merge rests on: one at or above the policy's floor, or one
// below it that the repo's owner accepted by name.
export type VerdictProof =
  | { kind: 'met'; level: PassingVerdict; model: string }
  | { kind: 'accepted'; verdict: Verdict; model: string; acceptedBy: string }
export type ReadyProof = {
  head: string
  patchId: string
  mergeTree: 'clean'
  gates: 'clean'
  verdict: VerdictProof
  reviews: 'clean'
  suite: { main: string }
  owner: { approvedBy: string }
}
export type Readiness =
  | { kind: 'ready'; proof: ReadyProof }
  | { kind: 'stale'; suiteMain: string; main: string }
  | { kind: 'blocked'; reasons: NonEmpty<string> }

// A decision an agent logs with the log_decision tool.
export const DECISION_INPUT = z.object({
  what: z.string().min(1),
  why: z.string().min(1),
  alternatives: z.array(z.string()).default([]),
})

// The feature map a policy names, as main has it. A map the policy names and
// main lacks is its own case, so no check can mistake it for no map at all.
export type MapOnMain = { kind: 'none' } | { kind: 'missing'; path: string } | { kind: 'found'; map: FeatureMap }

// The playbooks the router picks from. Each has a guide for the agent that
// implements, and the paths a change in it may touch, where that is limited.
export const PLAYBOOK_NAMES = ['change', 'bug', 'docs', 'dependency'] as const
export type PlaybookName = (typeof PLAYBOOK_NAMES)[number]
export type Playbook = { when: string; guide: string; scope: 'any' | 'docs' | 'dependencies' }
export const PLAYBOOKS: Record<PlaybookName, Playbook> = {
  change: {
    when: 'A new feature, or a change to how something works.',
    guide: 'Write the checks your plan names first, and watch each fail. Then change the code until they pass, and keep every Keep item working.',
    scope: 'any',
  },
  bug: {
    when: 'Something that worked, or should work, does not.',
    guide: 'Reproduce the bug with the first check your plan names, and watch it fail for that reason before you change any code. Fix the cause, not the symptom.',
    scope: 'any',
  },
  docs: {
    when: 'Only documents change.',
    guide: 'Change only documents. Any other file fails the run.',
    scope: 'docs',
  },
  dependency: {
    when: 'A dependency is added, removed or moved to another version.',
    guide: 'Change only the manifests, the lockfile and the build log. Pin exact versions, and say in the build log why each one changes.',
    scope: 'dependencies',
  },
}

// A promise made outside Agents closes only with proof that it was kept: the
// comment posted, with its id and address, the pull request, or the commit.
export const OBLIGATION_ID = z.uuid().brand<'ObligationId'>()
export type ObligationId = z.infer<typeof OBLIGATION_ID>
export const DELIVERY = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('comment'), id: z.number().int().positive(), url: z.url() }),
  z.object({ kind: z.literal('pull_request'), number: z.number().int().positive(), url: z.url() }),
  z.object({ kind: z.literal('commit'), sha: SHA }),
])
export type Delivery = z.infer<typeof DELIVERY>
// What says a promise was kept: an event the runner saw, which names the
// obligation's generation it saw, so a stale one is refused.
export type DeliveryEvent = { id: string; generation: number; target: string; delivery: Delivery }

// A deploy's lifecycle. Each status lists the ones it may move to.
export const DEPLOY_STATUSES = ['requested', 'preparing', 'switching', 'checking', 'rolling_back', 'healthy', 'rolled_back', 'failed'] as const
export type DeployStatus = (typeof DEPLOY_STATUSES)[number]
export const DEPLOY_NEXT: Record<DeployStatus, readonly DeployStatus[]> = {
  requested: ['preparing', 'failed'],
  preparing: ['switching', 'failed'],
  switching: ['checking', 'rolling_back', 'failed'],
  checking: ['healthy', 'rolling_back', 'failed'],
  rolling_back: ['rolled_back', 'failed'],
  healthy: [],
  rolled_back: [],
  failed: [],
}
export const DEPLOY_DONE: readonly DeployStatus[] = ['healthy', 'rolled_back', 'failed']
// The statuses of a deploy a deployer is working on.
export const DEPLOY_WORKING: readonly DeployStatus[] = ['preparing', 'switching', 'checking', 'rolling_back']
// A deploy a deployer started and did not finish within this long fails, since
// its deployer stopped partway.
export const DEPLOY_RUN_LIMIT_MIN = 60
// A deploy nobody started within this long fails, rather than going out long
// after the owner approved it.
export const DEPLOY_WAIT_LIMIT_MIN = 30
