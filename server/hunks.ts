// A change is made of hunks. Coach's writer names operations on an agent's rules,
// skills, profiles and checks, and the server applies each one, so the text and
// diff of every hunk are measured by code. Each hunk cites findings. Code refuses
// one that cites none, rests on fewer than two occasions, sends a candidate
// anywhere but where code routed it, or repeats a hunk the team turned down. The
// decision on each hunk is the team's memory. docs/design/evidence.md.

import { createHash } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { many, maybe, one, type Db } from './db.ts'
import { diffHunks, diffText } from './diff.ts'
import { candidatesOf, countsLine, countsOf, EVIDENCE_DAYS, FLOOR, routeLine, ruleTallies, sentence, unitsOf, type Dropped, type Unit } from './evidence.ts'
import { writeMemory } from './agents.ts'
import { HttpError, type Person } from './record.ts'
import {
  CandidateId, FindingId, FindingKind, Quote, RuleHash, Source, WriteReport, WrittenHunk,
  type Counts, type HunkDecisionBody, type HunkId, type HunkOp, type HunkTarget,
} from '../shared/evidence.ts'
import { AgentId, PersonId, ProposalId, type PipelineId, type RunId, type TeamId } from '../shared/ids.ts'
import { NAME } from '../shared/types.ts'

// At most five hunks in one change, as decided.
export const MAX_HUNKS = 5
// The always-loaded text, the instructions plus every skill description, stays
// under this many tokens, or shrinks when it is already over, as decided.
export const BUDGET_TOKENS = 5000
// Near enough for a budget, and the same on every machine.
const CHARS_PER_TOKEN = 4

export const contentHash = (text: string) => createHash('sha256').update(text).digest('hex')
export const tokensOf = (texts: string[]) => Math.ceil(texts.reduce((n, t) => n + t.length, 0) / CHARS_PER_TOKEN)

type Edit = { op: 'add'; after: RuleHash | null; text: string } | { op: 'change'; rule: RuleHash; text: string } | { op: 'delete'; rule: RuleHash }

function unitNamed(units: Unit[], hash: RuleHash): Unit {
  const found = units.filter((u) => u.hash === hash)
  const [unit] = found
  if (!unit || found.length > 1) throw new Error(`the instructions have ${found.length} rules with the hash ${hash}`)
  return unit
}

// Applies edits to instructions, by rule. Throws when a rule an edit names is not
// there exactly once. A new rule takes the spacing around the rule it follows.
export function editInstructions(text: string, edits: Edit[]): string {
  const units = unitsOf(text)
  const splices = edits.map((edit, order) => {
    if (edit.op === 'change') {
      const unit = unitNamed(units, edit.rule)
      return { from: unit.start, to: unit.end, insert: edit.text.trim(), order }
    }
    if (edit.op === 'delete') {
      const unit = unitNamed(units, edit.rule)
      const i = units.indexOf(unit)
      const [next, prev] = [units[i + 1], units[i - 1]]
      if (next) return { from: unit.start, to: next.start, insert: '', order }
      return prev ? { from: prev.end, to: unit.end, insert: '', order } : { from: unit.start, to: unit.end, insert: '', order }
    }
    const anchor = edit.after ? unitNamed(units, edit.after) : units.at(-1)
    if (!anchor) return { from: text.length, to: text.length, insert: edit.text.trim(), order }
    const i = units.indexOf(anchor)
    const [next, prev] = [units[i + 1], units[i - 1]]
    const gap = next ? text.slice(anchor.end, next.start) : prev ? text.slice(prev.end, anchor.start) : '\n\n'
    return { from: anchor.end, to: anchor.end, insert: `${gap}${edit.text.trim()}`, order }
  })
  // From the end backwards, so each splice's offsets still hold. Two at one place keep their order.
  splices.sort((a, b) => b.from - a.from || b.order - a.order)
  return splices.reduce((out, s) => `${out.slice(0, s.from)}${s.insert}${out.slice(s.to)}`, text)
}

// Text ending in a newline, so a diff never shows a last line removed and added
// again just because a line now follows it.
const ended = (text: string) => (text && !text.endsWith('\n') ? `${text}\n` : text)

// A skill as the file its agent's machine writes.
export const skillFile = (name: string, description: string, content: string) =>
  content ? `---\nname: ${name}\ndescription: ${description}\n---\n\n${content.trim()}\n` : ''

type LiveFinding = {
  id: FindingId; kind: FindingKind; rule_hash: string | null; rule_text: string | null; candidate_id: string | null
  occasion: string; source: Source; person_id: string | null; login: string | null; quote: string; seq: number; session_id: string; note: string | null
}

type Subject = { agentId: AgentId } | { pipelineId: PipelineId }

async function liveFindings(db: Db, subject: Subject): Promise<Map<string, LiveFinding>> {
  const rows = await many<Omit<LiveFinding, 'id' | 'kind' | 'source'> & { id: string; kind: string; source: string }>(db,
    `select f.id, f.kind, f.rule_hash, f.rule_text, f.candidate_id, f.occasion, f.source, f.person_id, p.login, f.quote, f.seq::int,
       f.session_id, f.note
     from session_findings f left join people p on p.id = f.person_id
     where ${'agentId' in subject ? 'f.agent_id' : 'f.pipeline_id'} = $1 and f.seen_at > now() - make_interval(days => $2)`,
    ['agentId' in subject ? subject.agentId : subject.pipelineId, EVIDENCE_DAYS])
  return new Map(rows.map((r) => [r.id, { ...r, id: FindingId.parse(r.id), kind: FindingKind.parse(r.kind), source: Source.parse(r.source) }]))
}

const quoteOf = (f: LiveFinding): Quote => Quote.parse({
  finding: f.id, kind: f.kind, session: f.session_id, seq: f.seq, quote: f.quote, source: f.source, login: f.login,
  about: f.rule_text ?? f.note ?? '',
})

// What a hunk changes, as stored.
type Planned = {
  target: HunkTarget; op: HunkOp; ruleHash: RuleHash | null; skill: { name: string; description: string } | null
  personId: PersonId | null; edit: Edit | null; before: string; after: string; diff: string
  findings: LiveFinding[]; candidates: CandidateId[]; counts: Counts
}

// The hunk the team turned down that this one repeats, as a reason, or null. A
// hunk repeats one when it has the same scope, target and content hash, shares a
// finding with it, and no more occasions back it.
export async function turnedDown(db: Db, scope: Subject, hunk: {
  target: HunkTarget; skillName: string | null; personId: PersonId | null; contentHash: string; findingIds: string[]; occasions: number
}): Promise<string | null> {
  const found = await maybe<{ reason: string; at: string; login: string | null; occasions: number }>(db,
    `select h.reason, to_char(h.decided_at, 'YYYY-MM-DD') as at, p.login, h.occasions from proposal_hunks h
     join proposals pr on pr.id = h.proposal_id left join people p on p.id = h.decided_by
     where ${'agentId' in scope ? 'pr.agent_id' : 'pr.pipeline_id'} = $1 and h.decision = 'rejected' and h.target = $2
       and h.skill_name is not distinct from $3 and h.person_id is not distinct from $4 and h.content_hash = $5
       and h.finding_ids && $6::uuid[] and h.occasions >= $7
     order by h.decided_at desc limit 1`,
    ['agentId' in scope ? scope.agentId : scope.pipelineId, hunk.target, hunk.skillName, hunk.personId, hunk.contentHash, hunk.findingIds, hunk.occasions])
  return found ? `${found.login ?? 'someone'} turned down this hunk on ${found.at} with ${found.occasions} occasions behind it, `
    + `and no more back it now: ${found.reason}` : null
}

// Checks one hunk the writer reported and works out what it changes. Returns why
// it is refused, or the planned hunk.
async function plan(client: pg.PoolClient, context: {
  teamId: TeamId; agentId: AgentId; agentName: string; instructions: string; units: Unit[]
  skills: Map<string, { description: string; content: string }>; live: Map<string, LiveFinding>
  ready: Map<string, Awaited<ReturnType<typeof candidatesOf>>[number]>; touched: Set<string>; anchored: Set<string>
}, raw: unknown): Promise<string | Planned> {
  const parsed = WrittenHunk.safeParse(raw)
  if (!parsed.success) return `not a hunk: ${z.prettifyError(parsed.error).split('\n').slice(0, 2).join(' ')}`
  const hunk = parsed.data
  if (!hunk.findings.length) return 'it cites no findings'
  const findings: LiveFinding[] = []
  for (const id of hunk.findings) {
    const finding = context.live.get(id)
    if (!finding) return `it cites ${id}, which is not live evidence about ${context.agentName}`
    findings.push(finding)
  }
  const counts = countsOf(findings.map((f) => ({ occasion: f.occasion, source: f.source, personId: f.person_id })))
  const target: HunkTarget = hunk.op === 'skill' ? 'skill' : hunk.op === 'profile' ? 'profile' : hunk.op === 'check' ? 'check' : 'instructions'

  // What each kind of hunk may rest on, and how much of it.
  if (hunk.op === 'delete') {
    if (!findings.every((f) => f.kind === 'harm' && f.rule_hash === hunk.rule)) return 'deleting a rule cites only harm findings about that rule'
    if (findings.length < FLOOR || counts.sessions < FLOOR) return `deleting a rule needs ${FLOOR} harm findings about it, from ${FLOOR} occasions`
  } else {
    const fits = (f: LiveFinding) => f.kind === 'gap' || (hunk.op === 'change' && (f.kind === 'ignored' || f.kind === 'harm') && f.rule_hash === hunk.rule)
    if (!findings.every(fits)) {
      return hunk.op === 'change' ? 'changing a rule cites gaps, or ignored or harm findings about that rule' : `a ${hunk.op} hunk cites only gaps`
    }
    if (counts.sessions < FLOOR) return `it rests on ${counts.sessions} occasion${counts.sessions === 1 ? '' : 's'}, and a change needs ${FLOOR}`
  }

  // Routing before text: every candidate it cites must be ready and routed here.
  const candidates = [...new Set(findings.flatMap((f) => (f.candidate_id ? [f.candidate_id] : [])))]
  let routedPerson: PersonId | null = null
  for (const id of candidates) {
    const candidate = context.ready.get(id)
    if (!candidate) return `it cites a correction that is not a ready candidate: ${id}`
    const route = candidate.route
    const allowed = route.kind === 'instructions' ? hunk.op === 'add' || hunk.op === 'change' : hunk.op === route.kind
    if (!allowed) return `candidate ${id} goes to ${routeLine(route)}, not to ${hunk.op === 'add' ? 'an' : 'a'} ${hunk.op} hunk`
    if (route.kind === 'profile') routedPerson = route.personId
  }

  // A rule one hunk changes or deletes is not touched or followed by another, so
  // every hunk applies on its own.
  const named = hunk.op === 'add' ? hunk.after : hunk.op === 'change' || hunk.op === 'delete' ? hunk.rule : undefined
  if (named) {
    const matches = context.units.filter((u) => u.hash === named).length
    if (matches !== 1) return `the instructions have ${matches} rules with the hash ${named}`
    if (context.touched.has(named) || (hunk.op !== 'add' && context.anchored.has(named))) return `another hunk already uses rule ${named}`
    if (hunk.op === 'add') context.anchored.add(named)
  }

  const name = `${context.agentName} instructions`
  switch (hunk.op) {
    case 'add':
    case 'change':
    case 'delete': {
      const edit: Edit = hunk.op === 'add' ? { op: 'add', after: hunk.after ?? null, text: hunk.text }
        : hunk.op === 'change' ? { op: 'change', rule: hunk.rule, text: hunk.text } : { op: 'delete', rule: hunk.rule }
      const ruleHash = hunk.op === 'add' ? hunk.after ?? null : hunk.rule
      const before = hunk.op === 'add' ? '' : unitNamed(context.units, hunk.rule).text
      if (hunk.op !== 'add') context.touched.add(hunk.rule)
      return {
        target, op: hunk.op, ruleHash, skill: null, personId: null, edit, before, after: hunk.op === 'delete' ? '' : hunk.text.trim(),
        diff: diffText(ended(context.instructions), ended(editInstructions(context.instructions, [edit])), name), findings, candidates: candidates.map(asCandidate), counts,
      }
    }
    case 'skill': {
      if (!NAME.test(hunk.name)) return `a skill's name is lowercase letters, digits and dashes, and "${hunk.name}" is not`
      const old = context.skills.get(hunk.name)
      return {
        target, op: old ? 'change' : 'add', ruleHash: null, skill: { name: hunk.name, description: hunk.description.trim() }, personId: null, edit: null,
        before: old?.content ?? '', after: hunk.text.trim(), findings, candidates: candidates.map(asCandidate), counts,
        diff: diffText(old ? skillFile(hunk.name, old.description, old.content) : '', skillFile(hunk.name, hunk.description.trim(), hunk.text), `skills/${hunk.name}/SKILL.md`),
      }
    }
    case 'profile': {
      const person = await maybe<{ id: string }>(client, 'select id from people where team_id = $1 and login = $2', [context.teamId, hunk.person])
      if (!person) return `there is no teammate ${hunk.person}`
      if (routedPerson !== person.id) return `only ${hunk.person}'s own corrections go to their profile`
      const profile = await maybe<{ content: string }>(client,
        `select content from memories where agent_id = $1 and scope = 'person' and person_id = $2 and kind = 'profile'`, [context.agentId, person.id])
      const old = profile?.content ?? ''
      return {
        target, op: 'add', ruleHash: null, skill: null, personId: PersonId.parse(person.id), edit: null, before: '', after: hunk.text.trim(),
        diff: diffText(ended(old), ended(old ? `${old}\n${hunk.text.trim()}` : hunk.text.trim()), `${hunk.person} profile`), findings, candidates: candidates.map(asCandidate), counts,
      }
    }
    case 'check':
      return { target, op: 'add', ruleHash: null, skill: null, personId: null, edit: null, before: '', after: hunk.text.trim(), diff: '', findings, candidates: candidates.map(asCandidate), counts }
  }
}

const asCandidate = (id: string): CandidateId => CandidateId.parse(id)

// The always-loaded text after some hunks: the instructions plus every skill description.
function loadedAfter(instructions: string, skills: Map<string, { description: string }>, hunks: Pick<Planned, 'edit' | 'skill'>[]): number {
  const edits = hunks.flatMap((h) => (h.edit ? [h.edit] : []))
  const descriptions = new Map([...skills].map(([name, s]) => [name, s.description]))
  for (const h of hunks) if (h.skill) descriptions.set(h.skill.name, h.skill.description)
  return tokensOf([editInstructions(instructions, edits), ...descriptions.values()])
}

const budgetProblem = (before: number, after: number) => (before <= BUDGET_TOKENS
  ? after > BUDGET_TOKENS ? `it would bring the always-loaded text to ${after} tokens, over the budget of ${BUDGET_TOKENS}` : null
  : after > before ? `the always-loaded text is already ${before} tokens, over the budget of ${BUDGET_TOKENS}, and it would grow to ${after}` : null)

export type Proposed = { proposalId: ProposalId | null; kept: number; refused: Dropped[]; summary: string }

// Turns the writer's hunks into a proposal waiting to be scored, refusing every
// hunk that breaks a rule for changes. None is proposed when more than five come.
export async function proposeHunks(client: pg.PoolClient, input: {
  teamId: TeamId; runId: RunId; agentId: AgentId; report: unknown; summary: string
}): Promise<Proposed> {
  const report = WriteReport.safeParse(input.report)
  if (!report.success) throw new Error(`the writer's report is not a list of hunks: ${z.prettifyError(report.error).split('\n')[0] ?? ''}`)
  const agent = await one<{ name: string; instructions: string }>(client, `agent ${input.agentId}`,
    'select name, instructions from agents where id = $1 for update', [input.agentId])
  if (report.data.hunks.length > MAX_HUNKS) {
    const reason = `the writer sent ${report.data.hunks.length} hunks, and a change has at most ${MAX_HUNKS}`
    return { proposalId: null, kept: 0, refused: [{ finding: report.data.hunks, reason }], summary: `Refused the whole change: ${reason}.` }
  }
  const skills = new Map((await many<{ name: string; description: string; content: string }>(client,
    'select name, description, content from skills where agent_id = $1', [input.agentId])).map((s) => [s.name, s]))
  const context = {
    teamId: input.teamId, agentId: input.agentId, agentName: agent.name, instructions: agent.instructions, units: unitsOf(agent.instructions),
    skills, live: await liveFindings(client, { agentId: input.agentId }),
    ready: new Map((await candidatesOf(client, input.agentId)).filter((c) => c.ready).map((c) => [String(c.id), c])), touched: new Set<string>(), anchored: new Set<string>(),
  }
  const refused: Dropped[] = []
  const planned: Planned[] = []
  for (const raw of report.data.hunks) {
    const result = await plan(client, context, raw)
    if (typeof result === 'string') {
      refused.push({ finding: raw, reason: result })
      continue
    }
    const memory = await turnedDown(client, { agentId: input.agentId }, {
      target: result.target, skillName: result.skill?.name ?? null, personId: result.personId, contentHash: contentHash(result.before),
      findingIds: result.findings.map((f) => f.id), occasions: result.counts.sessions,
    })
    if (memory) refused.push({ finding: raw, reason: memory })
    else planned.push(result)
  }
  const sizeBefore = loadedAfter(agent.instructions, skills, [])
  const budget = budgetProblem(sizeBefore, loadedAfter(agent.instructions, skills, planned))
  if (budget) {
    return { proposalId: null, kept: 0, refused: [...refused, { finding: planned.length, reason: budget }], summary: `Refused the whole change: ${budget}.` }
  }
  const lines = refused.map((r) => `- Refused a hunk: ${sentence(r.reason)}`)
  if (!planned.length) return { proposalId: null, kept: 0, refused, summary: ['Refused every hunk.', ...lines].join('\n') }

  const proposal = await one<{ id: string }>(client, 'the new proposal',
    `insert into proposals (team_id, target, agent_id, diff, summary, status, run_id) values ($1, 'agent', $2, $3, $4, 'scoring', $5) returning id`,
    [input.teamId, input.agentId, planned.map((h) => h.diff || `check: ${h.after}`).join('\n\n'), input.summary, input.runId])
  await insertHunks(client, input.teamId, ProposalId.parse(proposal.id), planned)
  const kept = planned.map((h, i) => `- Hunk ${i + 1}, ${h.op} to ${h.target}: ${countsLine(h.counts)}.`)
  return {
    proposalId: ProposalId.parse(proposal.id), kept: planned.length, refused,
    summary: [`Proposed ${planned.length} hunk${planned.length === 1 ? '' : 's'}, refused ${refused.length}.`, ...kept, ...lines].join('\n'),
  }
}

export async function insertHunks(client: pg.PoolClient, teamId: TeamId, proposalId: ProposalId, planned: Planned[]) {
  for (const [n, h] of planned.entries()) {
    await client.query(
      `insert into proposal_hunks (team_id, proposal_id, n, target, op, rule_hash, skill_name, skill_description, person_id,
         before, after, diff, content_hash, finding_ids, occasions, counts, evidence)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [teamId, proposalId, n + 1, h.target, h.op, h.ruleHash, h.skill?.name ?? null, h.skill?.description ?? null, h.personId,
        h.before, h.after, h.diff, contentHash(h.before), h.findings.map((f) => f.id), h.counts.sessions, JSON.stringify(h.counts),
        JSON.stringify(h.findings.map(quoteOf))])
  }
}

// Improve's change to a pipeline file, split into the hunks the diff shows. The
// change was scored whole, so every hunk cites every finding the study kept.
// Returns why the change is refused: it cites no checked finding, or one of its
// hunks repeats one the team turned down on the same evidence.
export async function planPipelineHunks(client: pg.PoolClient, input: {
  pipelineId: PipelineId; before: string; after: string; path: string; findings: FindingId[]
}): Promise<{ refused: string } | { hunks: Planned[] }> {
  const live = await liveFindings(client, { pipelineId: input.pipelineId })
  const findings = input.findings.flatMap((id) => live.get(id) ?? [])
  if (!findings.length) return { refused: 'the study cited no checked findings, so the change rests on nothing' }
  const counts = countsOf(findings.map((f) => ({ occasion: f.occasion, source: f.source, personId: f.person_id })))
  const hunks: Planned[] = []
  for (const h of diffHunks(input.before, input.after, input.path)) {
    const op: HunkOp = !h.removed ? 'add' : !h.added ? 'delete' : 'change'
    const memory = await turnedDown(client, { pipelineId: input.pipelineId }, {
      target: 'pipeline', skillName: null, personId: null, contentHash: contentHash(h.before), findingIds: findings.map((f) => f.id), occasions: counts.sessions,
    })
    if (memory) return { refused: memory }
    hunks.push({ target: 'pipeline', op, ruleHash: null, skill: null, personId: null, edit: null, before: h.before, after: h.after, diff: h.diff, findings, candidates: [], counts })
  }
  return hunks.length ? { hunks } : { refused: 'the change leaves the file as it was' }
}

// A person keeps or turns down one hunk of a coach proposal at its gate. A
// pipeline change is kept or turned down whole, since it was scored whole.
export async function decideHunk(client: pg.PoolClient, person: Person, hunkId: HunkId, body: HunkDecisionBody) {
  const hunk = await maybe<{ status: string; target: string; run_id: string | null }>(client,
    `select p.status, p.target, p.run_id from proposal_hunks h join proposals p on p.id = h.proposal_id
     where h.id = $1 and h.team_id = $2 for update of h`, [hunkId, person.team_id])
  if (!hunk) throw new HttpError(404, 'no such hunk')
  if (hunk.target !== 'agent') throw new HttpError(409, 'a pipeline change is kept or turned down whole, at its gate')
  if (hunk.status !== 'open' || !await maybe(client, `select 1 from asks where run_id = $1 and kind = 'gate' and status = 'open'`, [hunk.run_id])) {
    throw new HttpError(409, 'this proposal is not waiting at its gate')
  }
  const kept = body.decision === 'accept'
  await client.query(
    `update proposal_hunks set decision = $2, reason = $3, decided_by = $4, decided_at = now() where id = $1`,
    [hunkId, kept ? 'accepted' : 'rejected', body.reason || `${kept ? 'Kept' : 'Turned down'} by ${person.login}.`, person.id])
}

const GateAnswer = z.object({ decision: z.enum(['approve', 'reject']), message: z.string().nullable(), login: z.string() })

type StoredHunk = {
  id: string; target: string; op: string; rule_hash: string | null; skill_name: string | null; skill_description: string | null
  person_id: string | null; before: string; after: string; content_hash: string; finding_ids: string[]; decision: string | null
}

// Settles the run's proposal after its gate. Approving keeps every hunk not
// turned down. Rejecting turns down every hunk. Each decision is recorded with
// who and why, and a coach proposal's kept hunks are applied.
export async function settleHunks(client: pg.PoolClient, runId: RunId): Promise<{ applied: boolean; summary: string }> {
  const proposal = await maybe<{ id: string; target: string; agent_id: string | null; team_id: string; status: string }>(client,
    `select id, target, agent_id, team_id, status from proposals where run_id = $1 order by created_at desc limit 1 for update`, [runId])
  if (!proposal) throw new Error('this run has no proposal to settle')
  const ask = await one<{ answer: unknown; answered_by: string | null }>(client, "the run's answered gate",
    `select answer, answered_by from asks where run_id = $1 and kind = 'gate' and status = 'answered' order by answered_at desc limit 1`, [runId])
  const gate = GateAnswer.parse(ask.answer)
  const approved = gate.decision === 'approve'
  const reason = gate.message?.trim() || `${approved ? 'Kept' : 'Turned down'} at the gate by ${gate.login}.`
  await client.query(
    `update proposal_hunks set decision = $2, reason = $3, decided_by = $4, decided_at = now()
     where proposal_id = $1 and (decision is null or ($2 = 'rejected' and decision = 'accepted'))`,
    [proposal.id, approved ? 'accepted' : 'rejected', reason, ask.answered_by])
  const hunks = await many<StoredHunk>(client,
    `select id, target, op, rule_hash, skill_name, skill_description, person_id, before, after, content_hash, finding_ids, decision
     from proposal_hunks where proposal_id = $1 order by n`, [proposal.id])
  const kept = hunks.filter((h) => h.decision === 'accepted')
  const checks: string[] = []
  if (proposal.target === 'agent' && kept.length) {
    checks.push(...await applyAgentHunks(client, proposal.team_id, AgentId.parse(proposal.agent_id), kept))
  }
  await client.query(
    `update proposals set status = $2, decided_by = $3, decided_at = now() where id = $1 and status in ('open', 'approved')`,
    [proposal.id, kept.length ? 'approved' : 'rejected', ask.answered_by])
  const summary = [`Kept ${kept.length} of ${hunks.length} hunk${hunks.length === 1 ? '' : 's'}.`,
    ...hunks.filter((h) => h.decision === 'rejected').map((h) => `- Turned down hunk ${h.target} ${h.op}.`),
    ...checks.map((c) => `- A check to add: ${c}`)].join('\n')
  return { applied: kept.length > 0, summary }
}

// Writes the kept hunks to the agent's instructions, skills and profiles, once
// each still applies and the budget still holds, and closes their candidates.
// Returns the checks to add.
async function applyAgentHunks(client: pg.PoolClient, teamId: string, agentId: AgentId, kept: StoredHunk[]): Promise<string[]> {
  const agent = await one<{ instructions: string }>(client, `agent ${agentId}`, 'select instructions from agents where id = $1 for update', [agentId])
  const skills = new Map((await many<{ name: string; description: string; content: string }>(client,
    'select name, description, content from skills where agent_id = $1 for update', [agentId])).map((s) => [s.name, s]))
  const edits: Edit[] = []
  for (const h of kept.filter((k) => k.target === 'instructions')) {
    const rule = h.rule_hash === null ? null : RuleHash.parse(h.rule_hash)
    if (h.op === 'add') edits.push({ op: 'add', after: rule, text: h.after })
    else if (rule && h.op === 'change') edits.push({ op: 'change', rule, text: h.after })
    else if (rule) edits.push({ op: 'delete', rule })
  }
  let instructions: string
  try {
    instructions = editInstructions(agent.instructions, edits)
  } catch (error) {
    throw new Error(`the instructions changed after this proposal, so it no longer applies: ${error instanceof Error ? error.message : String(error)}`)
  }
  const skillHunks = kept.filter((h) => h.target === 'skill')
  for (const h of skillHunks) {
    const name = h.skill_name ?? ''
    const old = skills.get(name)
    if (contentHash(old?.content ?? '') !== h.content_hash) throw new Error(`the skill ${name} changed after this proposal, so it no longer applies`)
  }
  const descriptions = new Map([...skills].map(([name, s]) => [name, s.description]))
  for (const h of skillHunks) descriptions.set(h.skill_name ?? '', h.skill_description ?? '')
  const problem = budgetProblem(tokensOf([agent.instructions, ...[...skills.values()].map((s) => s.description)]), tokensOf([instructions, ...descriptions.values()]))
  if (problem) throw new Error(`the hunks kept break the size budget: ${problem}`)

  await client.query('update agents set instructions = $2 where id = $1', [agentId, instructions])
  for (const h of skillHunks) {
    const values = [teamId, agentId, h.skill_name, h.skill_description, h.after]
    const { rowCount } = await client.query(
      'update skills set description = $4, content = $5, updated_at = now() where team_id = $1 and agent_id = $2 and name = $3', values)
    if (!rowCount) await client.query('insert into skills (team_id, agent_id, name, description, content) values ($1, $2, $3, $4, $5)', values)
  }
  for (const h of kept.filter((k) => k.target === 'profile')) {
    const personId = PersonId.parse(h.person_id)
    const profile = await maybe<{ content: string }>(client,
      `select content from memories where agent_id = $1 and scope = 'person' and person_id = $2 and kind = 'profile'`, [agentId, personId])
    await writeMemory(client, agentId, teamId, { personId }, 'profile', profile?.content ? `${profile.content}\n${h.after}` : h.after)
  }
  await client.query(
    `update candidates set status = 'closed' where status = 'open' and id in
       (select candidate_id from session_findings where id = any($1) and candidate_id is not null)`,
    [kept.flatMap((h) => h.finding_ids)])
  return kept.filter((h) => h.target === 'check').map((h) => h.after)
}

// The writer's view: the agent's rules with what readers found about each, its
// skills, the ready candidates with their findings and routes, and the limits.
export async function writePrompt(db: Db, agentId: AgentId): Promise<string> {
  const agent = await one<{ name: string; instructions: string }>(db, `agent ${agentId}`, 'select name, instructions from agents where id = $1', [agentId])
  const skills = await many<{ name: string; description: string }>(db, 'select name, description from skills where agent_id = $1 order by name', [agentId])
  const tallies = await ruleTallies(db, agentId)
  const live = await liveFindings(db, { agentId })
  const finding = (id: FindingId) => {
    const f = live.get(id)
    return f ? `  finding ${f.id} · ${f.kind} · session ${f.session_id} step ${f.seq} · ${f.login ?? f.source} · "${f.quote}"` : ''
  }
  const ready = (await candidatesOf(db, agentId)).filter((c) => c.ready)
  const lines = [`The rules of ${agent.name}, each named by its hash, with the occasions readers found it followed, ignored or causing harm:`]
  for (const rule of unitsOf(agent.instructions)) {
    const count = (kind: FindingKind) => tallies.find((t) => t.rule === rule.hash && t.kind === kind)?.occasions ?? 0
    lines.push(`rule ${rule.hash}: ${rule.text}`, `  followed ${count('followed')}, ignored ${count('ignored')}, harm ${count('harm')}`)
    for (const t of tallies.filter((x) => x.rule === rule.hash && x.kind !== 'followed')) lines.push(...t.findings.map(finding))
  }
  lines.push('', 'Skills, each loaded when its description fits the task:', ...(skills.length ? skills.map((s) => `skill ${s.name}: ${s.description}`) : ['none']))
  lines.push('', 'Ready candidates, corrections no rule covers, each with where code routed it:')
  for (const c of ready) lines.push(`candidate ${c.id} · ${countsLine(c.counts)} · goes to ${routeLine(c.route)}: ${c.correction}`, ...c.findings.map(finding))
  if (!ready.length) lines.push('none')
  const size = tokensOf([agent.instructions, ...skills.map((s) => s.description)])
  lines.push('', `The always-loaded text, the rules plus every skill description, is ${size} of ${BUDGET_TOKENS} tokens.`)
  lines.push('', `Rules for a change, enforced in code: at most ${MAX_HUNKS} hunks. Every hunk cites finding ids. An add, change, skill, profile or check hunk `
    + `needs findings from ${FLOOR} occasions. Deleting a rule needs ${FLOOR} harm findings about it. A hunk citing a candidate goes where the candidate is routed: `
    + 'add or change for the instructions, skill, profile, or check. The always-loaded text stays within its budget.')
  return lines.join('\n')
}
