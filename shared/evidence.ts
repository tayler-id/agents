// The shapes of the evidence coach and improve learn from. Findings are read from
// sessions and checked by code. Gap findings group into candidates. A change is
// made of hunks that cite findings, and the decision on each hunk is the team's
// memory. Replays score a coach change before anyone is asked. The design is
// docs/design/evidence.md.
//
// Each zod schema is the one definition of its shape. What a model reports and
// what a JSON column holds is parsed through them, and the types are inferred.

import { z } from 'zod'
import { PersonId, ProposalId, RunId, SessionId } from './ids.ts'
import type { AgentId } from './ids.ts'

export const FindingId = z.uuid().brand<'FindingId'>()
export type FindingId = z.infer<typeof FindingId>
export const CandidateId = z.uuid().brand<'CandidateId'>()
export type CandidateId = z.infer<typeof CandidateId>
export const HunkId = z.uuid().brand<'HunkId'>()
export type HunkId = z.infer<typeof HunkId>

// Where a session came from. Every count shows the three apart.
export const Source = z.enum(['person', 'pipeline', 'box'])
export type Source = z.infer<typeof Source>
export const FindingKind = z.enum(['followed', 'ignored', 'harm', 'gap'])
export type FindingKind = z.infer<typeof FindingKind>
// Whether a lint rule, type or check could catch a gap, or only text can fix it.
export const Fix = z.enum(['check', 'text'])
export type Fix = z.infer<typeof Fix>
// One of an agent's instructions, named by the start of a hash of its text.
export const RuleHash = z.string().regex(/^[0-9a-f]{12}$/).brand<'RuleHash'>()
export type RuleHash = z.infer<typeof RuleHash>
export type Rule = { hash: RuleHash; text: string }

// A session picked for coach's reader, and the steps it reads. Its occasion is
// the run when it is a pipeline's stage session.
export const Picked = z.object({
  sessionId: SessionId, source: Source, runId: RunId.nullable(),
  fromSeq: z.number().int().positive(), toSeq: z.number().int().positive(),
})
export type Picked = z.infer<typeof Picked>

// What a model reports. Each finding and hunk is parsed on its own, so one bad
// entry is dropped with its reason and the rest go on.

const Step = z.number().int().positive()
const Said = z.string().trim().min(1)

// Coach's reader, one finding.
export const ReadFinding = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['followed', 'ignored', 'harm']), session: z.uuid(), step: Step, quote: z.string(), rule: RuleHash }),
  z.object({
    kind: z.literal('gap'), session: z.uuid(), step: Step, quote: z.string(), correction: Said, fix: Fix,
    // An open candidate this gap repeats, or a label shared by new gaps that are one correction.
    candidate: z.uuid().optional(), same: z.string().trim().min(1).optional(),
    // When the correction applies, if it applies only to one kind of task.
    when: z.string().trim().min(1).optional(),
  }),
])
export type ReadFinding = z.infer<typeof ReadFinding>
export const ReadReport = z.object({
  findings: z.array(z.unknown()),
  // Pairs of open candidates the reader judged to be one correction.
  merges: z.array(z.tuple([z.uuid(), z.uuid()])).optional(),
})

// Improve's study, one finding about a pipeline's run.
export const StudyFinding = z.object({ kind: FindingKind, session: z.uuid(), step: Step, quote: z.string(), note: Said })
export type StudyFinding = z.infer<typeof StudyFinding>
export const StudyReport = z.object({ findings: z.array(z.unknown()) })

const Cites = z.array(z.string())
// Coach's writer, one hunk. Rules are named by their hashes, so the server
// applies each hunk and measures its text itself.
export const WrittenHunk = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), after: RuleHash.optional(), text: Said, findings: Cites }),
  z.object({ op: z.literal('change'), rule: RuleHash, text: Said, findings: Cites }),
  z.object({ op: z.literal('delete'), rule: RuleHash, findings: Cites }),
  z.object({ op: z.literal('skill'), name: z.string(), description: Said, text: Said, findings: Cites }),
  z.object({ op: z.literal('profile'), person: z.string(), text: Said, findings: Cites }),
  z.object({ op: z.literal('check'), text: Said, findings: Cites }),
])
export type WrittenHunk = z.infer<typeof WrittenHunk>
export const WriteReport = z.object({ hunks: z.array(z.unknown()) })

export const Verdict = z.enum(['fixed', 'still', 'ok', 'worse'])
export type Verdict = z.infer<typeof Verdict>
// The judge, one verdict per label it was shown.
export const JudgeReport = z.object({ verdicts: z.record(z.string(), Verdict) })

// Candidates, counted in code from their live findings.

export const Counts = z.object({
  // Distinct occasions: sessions, with a pipeline run's stage sessions counted as one.
  sessions: z.number().int().nonnegative(),
  people: z.number().int().nonnegative(),
  bySource: z.object({ person: z.number().int().nonnegative(), pipeline: z.number().int().nonnegative(), box: z.number().int().nonnegative() }),
})
export type Counts = z.infer<typeof Counts>

// Where a ready candidate goes, decided in code before any text is written.
export type Route =
  | { kind: 'profile'; personId: PersonId; login: string }
  | { kind: 'check' }
  | { kind: 'skill'; trigger: string }
  | { kind: 'instructions' }

export const CandidateStatus = z.enum(['open', 'merged', 'closed'])
export type Candidate = {
  id: CandidateId; agentId: AgentId; correction: string
  findings: FindingId[]; counts: Counts; route: Route
  // Ready once its live findings come from two occasions.
  ready: boolean
}

// Hunks and the decisions on them.

export const HunkTarget = z.enum(['instructions', 'skill', 'profile', 'check', 'pipeline'])
export type HunkTarget = z.infer<typeof HunkTarget>
export const HunkOp = z.enum(['add', 'change', 'delete'])
export type HunkOp = z.infer<typeof HunkOp>
export const HunkDecision = z.enum(['accepted', 'rejected'])
export type HunkDecision = z.infer<typeof HunkDecision>

// A cited finding as it read when the hunk was proposed, for people to judge.
export const Quote = z.object({
  finding: FindingId, kind: FindingKind, session: SessionId, seq: z.number().int(), quote: z.string(),
  source: Source, login: z.string().nullable(),
  // The rule a finding is about, a gap's correction, or what went wrong in a run.
  about: z.string(),
})
export type Quote = z.infer<typeof Quote>

// A row of proposal_hunks, with its times as text.
export const ProposalHunk = z.object({
  id: HunkId, proposal_id: ProposalId, n: z.number().int(),
  target: HunkTarget, op: HunkOp, rule_hash: RuleHash.nullable(),
  skill_name: z.string().nullable(), skill_description: z.string().nullable(), person_id: PersonId.nullable(),
  before: z.string(), after: z.string(), diff: z.string(), content_hash: z.string(),
  finding_ids: z.array(FindingId), occasions: z.number().int(), counts: Counts, evidence: z.array(Quote),
  decision: HunkDecision.nullable(), reason: z.string().nullable(), decided_by: PersonId.nullable(), decided_at: z.string().nullable(),
  created_at: z.string(),
})
export type ProposalHunk = z.infer<typeof ProposalHunk>

// A person keeps or turns down one hunk. Turning one down needs a reason.
export const HunkDecisionBody = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('accept'), reason: z.string().trim().max(2000).optional() }),
  z.object({ decision: z.literal('reject'), reason: z.string().trim().min(1).max(2000) }),
])
export type HunkDecisionBody = z.infer<typeof HunkDecisionBody>

// Scores, in proposals.scores. Improve's replays of runs, or coach's replays of
// turns. Empty until scored.

export const RunScore = z.object({
  replays: z.number().int(), finished: z.number().int(), problems: z.number().int(),
  stagesRun: z.number().int(), costUsd: z.number(), durationSec: z.number(),
})
export type RunScore = z.infer<typeof RunScore>
export const SessionScore = z.object({
  // Cases behind the change, and how many still needed the correction.
  behind: z.number().int(), still: z.number().int(),
  // Unrelated cases, and how many came out worse than the reply the person accepted.
  unrelated: z.number().int(), worse: z.number().int(),
})
export type SessionScore = z.infer<typeof SessionScore>
export const CaseResult = z.object({
  kind: z.enum(['behind', 'unrelated']), session: SessionId, seq: z.number().int(), change: Verdict, current: Verdict,
})
export type CaseResult = z.infer<typeof CaseResult>
export const Scores = z.union([
  z.object({ candidate: RunScore, current: RunScore }),
  z.object({ change: SessionScore, current: SessionScore, cases: z.array(CaseResult) }),
  z.object({}).strict(),
])
export type Scores = z.infer<typeof Scores>
