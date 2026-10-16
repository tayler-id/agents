// The coding framework's stages, for runs on a repo with a policy. The runner
// calls these from its own stages. They judge a change by the repo's policy,
// write what they saw as evidence, and never take an agent's word for a result.
// The design is docs/design/self-improve.md.

import { createHash } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { BUILD } from './build.ts'
import { many, maybe, one } from './db.ts'
import { scrub } from './record.ts'
import { failUntakenMessage, moveMessages } from './durability.ts'
import { cancelWaitingTurns, signalSession } from './scheduler.ts'
import type { SessionId } from '../shared/ids.ts'
import { JUDGE_PERMISSIONS } from './permissions.ts'
import { forge, repoPath } from './forge.ts'
import { changes, commitOf, diffText, list, mergeBase, mergeTree, mirror, patchId, read, type Mirror } from './mirror.ts'
import {
  addRow, agentNamed, branchOf, finishRun, post, readTurn, REPORT_INSTRUCTION, sendPrompt, sendPush, setRow,
  stageOf, stageSession, tail, taskOf, workspaceOf, type AgentRow, type Row, type Run, type Workspace,
} from './runner.ts'
import {
  DECISION_INPUT, DEPLOY_DONE, DEPLOY_RUN_LIMIT_MIN, DEPLOY_WAIT_LIMIT_MIN, DEPLOY_WORKING, EVIDENCE_BUILD, fenced, INPUTS, resultProblems, ruleOf, STATUS, meets, nonEmpty, PLAYBOOK_NAMES, passingVerdict, POLICY_ID, REVIEW_DATA, REVIEW_OUTCOMES, SHA,
  SUITE_PAYLOAD, SUITE_RESULT, tableCell, VERIFIER_DATA, VERIFY_PAYLOAD, VERIFY_RESULT,
  type CommandResult, type EvidenceBuild, type Finding, type GateResult, type Inputs, type MapOnMain, type PassingVerdict, type PolicyId, type Readiness,
  type ReviewFinding, type SeenFailing, type SuitePayload, type ToolBuild, type VerdictProof, type VerifyPayload,
} from '../shared/framework.ts'
import { ADVISORY, ATTESTATION_STATUS, statusText, withAttestation, type Attestation } from '../shared/attestation.ts'
import { findingKey } from '../shared/findings.ts'
import { FEATURE_MAP, VERDICT, VERDICTS, type Verdict } from '../shared/verification.ts'
import { checksOnly, staticGates, type FileChange } from '../shared/gates/diff.ts'
import { matcher } from '../shared/gates/glob.ts'
import { headingsOf, planProblems, ruleNames, sectionOf } from '../shared/gates/plan.ts'
import { POLICY, type Policy } from '../shared/policy.ts'
import type { ConfirmStage, GateRole, Pipeline, ReviewStage, RouteStage, RunContext } from '../shared/pipeline.ts'
import type { NewEvent } from '../shared/types.ts'

// Documents reach the server just after the turn that wrote them ends. A stage
// that needs one waits this long for it before failing.
const DOCUMENT_WAIT_MS = 60_000
// A reviewer reads the diff in its prompt, cut at this many characters.
const REVIEW_DIFF_LIMIT = 60_000
// Output kept from each command in the evidence and in summaries.
const OUTPUT_TAIL = 3000
// The task document a plan stage writes, which the plan gate pins.
export const PLAN_DOCUMENT = 'plan.md'
// A machine silent this long holds no live work. Daemons report every 15
// seconds, and a box takes well under the default to start.
const SILENT_MACHINE_MS = Number(process.env.AGENTS_SILENT_MACHINE_SEC ?? 300) * 1000
// The points of each send-back the pull request lists.
const SENT_BACK_POINTS = 5

export type Governed = {
  policyId: PolicyId
  policy: Policy
  owner: { id: string; login: string; forgeLogin: string | null }
  repo: { id: string; remoteUrl: string; defaultBranch: string; setup: string | null; name: string }
}

// The policy of the run's primary repo, with its owner, or null for a repo without one.
export async function policyOf(client: pg.PoolClient, run: Run): Promise<Governed | null> {
  const row = await maybe<{
    policy_id: string | null; rules: unknown; owner_id: string | null; login: string | null; forge_login: string | null
    repo_id: string; remote_url: string; default_branch: string; setup_command: string | null
  }>(client,
    `select r.policy_id, p.rules, o.id as owner_id, o.login, o.forge_login, r.id as repo_id, r.remote_url, r.default_branch, r.setup_command
     from task_repos tr join repos r on r.id = tr.repo_id
     left join policies p on p.id = r.policy_id left join people o on o.id = r.owner_id
     where tr.task_id = $1 order by tr.is_primary desc limit 1`, [run.task_id])
  if (!row?.policy_id) return null
  if (!row.owner_id || !row.login) throw new Error(`repo ${row.repo_id} has a policy and no owner`)
  return {
    policyId: POLICY_ID.parse(row.policy_id),
    policy: POLICY.parse(row.rules),
    owner: { id: row.owner_id, login: row.login, forgeLogin: row.forge_login },
    repo: { id: row.repo_id, remoteUrl: row.remote_url, defaultBranch: row.default_branch, setup: row.setup_command, name: repoPath(row.remote_url).split('/')[1] ?? row.repo_id },
  }
}

async function governedRun(client: pg.PoolClient, run: Run): Promise<Governed> {
  const governed = await policyOf(client, run)
  if (!governed) throw new Error('this stage runs only on a repo with a policy')
  return governed
}

export async function sandboxProblem(client: pg.PoolClient, run: Run, pipeline: Pipeline): Promise<string | null> {
  const governed = await policyOf(client, run)
  if (governed?.policy.sandbox !== 'box' || pipeline.runsOn === 'box') return null
  return 'This repo\'s policy runs coding work only in a box, and this pipeline runs on the agent\'s home machine.'
}

// The policy's limits across runs on the repo. A run over a spend cap stops
// before it starts, and one over the hourly or concurrent limit waits its turn.
export async function capsCheck(client: pg.PoolClient, run: Run): Promise<{ stop: string } | { wait: string } | null> {
  const governed = await policyOf(client, run)
  if (!governed) return null
  const { caps } = governed.policy
  const repoRuns = `select r.id, r.status, r.started_at, r.created_at, r.trigger_payload from runs r
    join task_repos tr on tr.task_id = r.task_id and tr.is_primary where tr.repo_id = $1 and r.id <> $2 and r.replay_of is null`
  const busy = await one<{ n: number }>(client, 'the active runs',
    `select count(*)::int as n from (${repoRuns}) x where status in ('running', 'waiting')`, [governed.repo.id, run.id])
  if (busy.n >= caps.concurrent) return { wait: `Waiting: ${busy.n} runs are already working on this repo, its policy's limit.` }
  const recent = await one<{ n: number }>(client, 'the runs this hour',
    `select count(*)::int as n from (${repoRuns}) x where started_at > now() - interval '1 hour'`, [governed.repo.id, run.id])
  if (recent.n >= caps.runsPerHour) return { wait: `Waiting: ${recent.n} runs started on this repo in the last hour, its policy's limit.` }
  const spent = (author: string | null) => one<{ usd: string }>(client, 'the spend today',
    `select coalesce(sum(s.cost_usd), 0) as usd from sessions s where s.id in (
       select rs.session_id from run_stages rs join (${repoRuns}) x on x.id = rs.run_id
       where x.created_at >= date_trunc('day', now()) and ($3::text is null or x.trigger_payload->'report'->>'author' = $3))`,
    [governed.repo.id, run.id, author])
  const today = Number((await spent(null)).usd)
  if (today >= caps.repoDailyUsd) return { stop: `Stopped before starting: runs on this repo spent $${today.toFixed(2)} today, its policy's daily cap of $${caps.repoDailyUsd.toFixed(2)}.` }
  const author = run.trigger_payload.report.author ?? null
  if (author !== null && !(await maybe(client, 'select 1 from people where team_id = $1 and (login = $2 or forge_login = $2)', [run.team_id, author]))) {
    const theirs = Number((await spent(author)).usd)
    if (theirs >= caps.outsiderDailyUsd) {
      return { stop: `Stopped before starting: reports from ${author}, who is outside the team, used $${theirs.toFixed(2)} today, the daily cap of $${caps.outsiderDailyUsd.toFixed(2)} for one outside author.` }
    }
  }
  return null
}

// A cap that stops a run says so once, on the report's issue.
export async function announceCap(client: pg.PoolClient, run: Run, reason: string) {
  const governed = await policyOf(client, run)
  const issue = run.trigger_payload.report.issue
  if (governed && issue !== undefined) await forge.comment(repoPath(governed.repo.remoteUrl), issue, reason)
}

// Minutes the run spent working: every stage but the ones waiting on a person.
export function timeCapProblem(policy: Policy, rows: Row[]): string | null {
  const now = Date.now()
  const minutes = rows.reduce((total, r) => {
    if (r.kind === 'gate' || r.kind === 'handoff' || !r.started_at) return total
    const until = typeof r.data.workedUntil === 'string' ? Date.parse(r.data.workedUntil) : r.ended_at?.getTime() ?? now
    return total + (until - r.started_at.getTime()) / 60_000
  }, 0)
  return minutes >= policy.maxRunMinutes ? `Stopped at the time cap: ${Math.round(minutes)} of ${policy.maxRunMinutes} working minutes.` : null
}

const lessonsOf = (client: pg.PoolClient, run: Run, repoId: string) => many<{ rule: string }>(client,
  `select rule from lessons where team_id = $1 and (repo_id is null or repo_id = $2) and status <> 'retired' order by created_at`, [run.team_id, repoId])

// What every coding agent on a repo with a policy reads with its instructions.
export async function guidance(client: pg.PoolClient, run: Run): Promise<string> {
  const governed = await policyOf(client, run)
  if (!governed) return ''
  const lessons = await lessonsOf(client, run, governed.repo.id)
  // What people decided at this run's gates is a fact every later stage gets.
  const decided = await many<{ stage: string | null; what: string; why: string; login: string | null }>(client,
    `select d.stage, d.what, d.why, p.login from decisions d left join people p on p.id = d.person_id
     where d.run_id = $1 and d.who = 'person' order by d.created_at`, [run.id])
  return [
    `This repo runs under the coding framework with the policy of its owner, ${governed.owner.login}. The runner runs every gate itself and never takes an agent's word for a result.`,
    'Principles:', ...governed.policy.principles.map((p) => `- ${p.name}. ${p.text}`),
    ...(lessons.length ? ['Lessons the team learned, each from a real mistake:', ...lessons.map((l) => `- ${l.rule}`)] : []),
    ...(decided.length ? [
      'What people decided in this run. Each one stands: work within it. When your work cannot, stop, name the decision in your report, and report ask when your stage offers it, so a person decides again.',
      ...decided.map((d) => `- ${d.login ?? 'A person'} at ${d.stage ?? 'the task'}: ${d.what}. ${d.why}`),
    ] : []),
    'Log each decision that shapes your work with the log_decision tool, when you have it, with why and what else you weighed.',
  ].join('\n')
}

// The playbooks a route stage may pick: those it names that the policy allows.
export async function routeOutcomes(client: pg.PoolClient, run: Run, stage: RouteStage): Promise<string[]> {
  const governed = await policyOf(client, run)
  const named = Object.keys(stage.next)
  const allowed = governed ? named.filter((n) => governed.policy.playbooks.some((p) => p === n)) : named
  if (!allowed.length) throw new Error('the repo\'s policy allows none of the playbooks this route stage names')
  return allowed
}

export async function routed(client: pg.PoolClient, run: Run, row: Row, playbook: string, why: string, sessionId: string) {
  await client.query('update runs set playbook = $2 where id = $1', [run.id, playbook])
  run.playbook = playbook
  await client.query(
    `insert into decisions (team_id, task_id, run_id, stage, who, session_id, what, why) values ($1, $2, $3, $4, 'agent', $5, $6, $7)`,
    [run.team_id, run.task_id, run.id, row.stage, sessionId, `Picked the ${playbook} playbook`, scrub(why) || 'The router gave no reason.'])
}

const DECISION_TOOL = /__log_decision$/
const TOOL_INPUT = z.object({ input: z.unknown() })

// Decisions an agent logged with log_decision, read from its session's events
// as they arrive. A call whose input does not parse is one the tool refused,
// and it records nothing.
export async function recordDecisions(client: pg.PoolClient, sessionId: string, events: readonly NewEvent[]) {
  const calls = events.filter((e) => e.kind === 'tool_call' && e.toolName !== undefined && DECISION_TOOL.test(e.toolName))
  if (!calls.length) return
  const session = await one<{ team_id: string; task_id: string | null; stage: string | null }>(client, `session ${sessionId}`,
    'select team_id, task_id, stage from sessions where id = $1', [sessionId])
  if (!session.task_id) return
  const run = await maybe<{ run_id: string }>(client, 'select run_id from run_stages where session_id = $1 order by n desc limit 1', [sessionId])
  for (const call of calls) {
    const input = DECISION_INPUT.safeParse(TOOL_INPUT.safeParse(call.body).data?.input)
    if (!input.success) continue
    const event = await one<{ id: string }>(client, 'the decision\'s event', 'select id from events where session_id = $1 and client_id = $2', [sessionId, call.clientId])
    await client.query(
      `insert into decisions (team_id, task_id, run_id, stage, who, session_id, event_id, what, why, alternatives)
       values ($1, $2, $3, $4, 'agent', $5, $6, $7, $8, $9) on conflict (event_id) where event_id is not null do nothing`,
      [session.team_id, session.task_id, run?.run_id ?? null, session.stage, sessionId, event.id, scrub(input.data.what), scrub(input.data.why),
        JSON.stringify(scrub(input.data.alternatives))])
  }
}

export async function personDecided(client: pg.PoolClient, run: Run, stage: string, personId: string, what: string, why: string) {
  await client.query(
    `insert into decisions (team_id, task_id, run_id, stage, who, person_id, what, why) values ($1, $2, $3, $4, 'person', $5, $6, $7)`,
    [run.team_id, run.task_id, run.id, stage, personId, scrub(what), scrub(why)])
}

async function mainMirror(governed: Governed): Promise<{ m: Mirror; main: string }> {
  const m = await mirror(governed.repo.id, governed.repo.remoteUrl, [governed.repo.defaultBranch])
  return { m, main: await commitOf(m, governed.repo.defaultBranch) }
}

async function featureMapAt(m: Mirror, commit: string, policy: Policy): Promise<MapOnMain> {
  if (!policy.verification) return { kind: 'none' }
  const path = policy.verification.features
  const text = await read(m, commit, path)
  return text === null ? { kind: 'missing', path } : { kind: 'found', map: FEATURE_MAP.parse(JSON.parse(text)) }
}

// Whether a stage's required document is in the task folder with its headings,
// and for a plan whether it passes the plan lint: null when it does, 'wait'
// while it may still arrive, or why the stage fails.
export async function documentProblem(client: pg.PoolClient, run: Run, document: { path: string; headings: string[]; plan: boolean }, endedAt: Date): Promise<string | null> {
  const found = await maybe<{ content: string }>(client,
    `select v.content from artifacts a join artifact_versions v on v.artifact_id = a.id and v.version = a.current_version
     where a.task_id = $1 and a.kind = 'document' and a.path = $2`, [run.task_id, document.path])
  const have = found ? headingsOf(found.content) : new Set<string>()
  const missing = document.headings.filter((h) => !have.has(h.toLowerCase()))
  const governed = document.plan && found && !missing.length ? await policyOf(client, run) : null
  const lint = governed && found
    ? planProblems(found.content, governed.policy.checks.pattern, governed.policy.lint.prose,
      await featureMapAt((await mainMirror(governed)).m, governed.repo.defaultBranch, governed.policy))
    : []
  if (found && !missing.length && !lint.length) return null
  if (Date.now() - endedAt.getTime() < DOCUMENT_WAIT_MS) return 'wait'
  if (!found) return `The stage needs task/${document.path}, and the agent left none.`
  if (missing.length) return `The stage needs task/${document.path} with the sections ${document.headings.join(', ')}, and it lacks ${missing.join(', ')}.`
  return `task/${document.path} fails the plan lint:\n${lint.map((p) => `- ${p}`).join('\n')}`
}

const roleOf = (pipeline: Pipeline, stage: string): GateRole | null => {
  const found = pipeline.stages[stage]
  return found?.kind === 'gate' ? found.role ?? null : null
}

// What the latest passing verify judged: the commit, the base, and what it found.
const VERIFIED = z.object({
  head: SHA, base: SHA, main: SHA, patchId: z.string(), checks: z.array(z.string()), ui: z.boolean(), docsOnly: z.boolean(),
  needsOwner: z.array(z.object({ gate: z.string(), path: z.string().nullable(), text: z.string() })),
})
type Verified = z.infer<typeof VERIFIED>

function verified(pipeline: Pipeline, rows: Row[]): Verified | null {
  const row = [...rows].reverse().find((r) => stageOf(pipeline, r.stage).kind === 'verify' && r.status === 'done' && r.outcome === 'passes')
  return row ? VERIFIED.parse(row.data) : null
}

// The plan a person approved: the version of the plan the plan gate recorded when it opened.
const PINNED_PLAN = z.object({ plan: z.object({ artifactId: z.uuid(), version: z.number().int() }) })
async function approvedPlan(client: pg.PoolClient, pipeline: Pipeline, rows: Row[]): Promise<string | null> {
  const gate = [...rows].reverse().find((r) => roleOf(pipeline, r.stage) === 'plan' && r.outcome === 'approved')
  const pinned = PINNED_PLAN.safeParse(gate?.data)
  if (!pinned.success) return null
  const version = await maybe<{ content: string }>(client,
    'select content from artifact_versions where artifact_id = $1 and version = $2', [pinned.data.plan.artifactId, pinned.data.plan.version])
  return version?.content ?? null
}

type RoleSetup =
  | { kind: 'pass'; summary: string }
  | { kind: 'ask'; only: { id: string; login: string } | null; question: string; data: Record<string, unknown> }

// What a gate's role means on a repo with a policy.
export async function gateRole(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], role: GateRole, governed: Governed): Promise<RoleSetup> {
  const owner = { id: governed.owner.id, login: governed.owner.login }
  const onlyOwner = ` Only ${owner.login} can answer this.`
  switch (role) {
    case 'plan': {
      const plan = await maybe<{ id: string; current_version: number }>(client,
        `select id, current_version from artifacts where task_id = $1 and kind = 'document' and path = $2`, [run.task_id, PLAN_DOCUMENT])
      return plan
        ? { kind: 'ask', only: null, question: '', data: { plan: { artifactId: plan.id, version: plan.current_version } } }
        : { kind: 'ask', only: null, question: ` There is no ${PLAN_DOCUMENT} in the task folder yet.`, data: {} }
    }
    case 'protected': {
      const judged = verified(pipeline, rows)
      const owned = judged?.needsOwner ?? []
      if (judged && !owned.length) return { kind: 'pass', summary: 'Passed by itself: the change touches no protected path, no dependency and no existing check.' }
      const listed = owned.map((f) => `\n- ${f.path ?? f.gate}: ${f.text}`).join('')
      return { kind: 'ask', only: owner, question: `\n\nThis change touches what only ${owner.login} may approve:${listed}\nThe pull request shows each diff.${onlyOwner}`, data: {} }
    }
    case 'suite':
      // The check host runs the change's code, and it is not isolated yet, so
      // only the owner lets it.
      return { kind: 'ask', only: owner, question: ` The check host will run the change's code with the test database, merged into main.${onlyOwner}`, data: {} }
    case 'merge':
    case 'deploy':
      return { kind: 'ask', only: owner, question: onlyOwner, data: {} }
  }
}

// Each row names the builds that produced it: the runner's, the machine's that
// ran the gate when one did, and a hash of each input read from main.
type Source = { worker: ToolBuild | null; inputs: Inputs }

async function recordEvidence(client: pg.PoolClient, run: Run, row: Row, governed: Governed, commit: string, base: string, results: GateResult[], source: Source) {
  const build: EvidenceBuild = { runner: BUILD, ...source }
  for (const r of results) {
    await client.query(
      `insert into evidence (team_id, run_id, run_stage_id, policy_id, commit, base, gate, status, summary, detail, build)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [run.team_id, run.id, row.id, governed.policyId, commit, base, r.gate, r.status, r.summary, JSON.stringify({ findings: r.findings }), JSON.stringify(build)])
  }
}

// A hash of each file read from a commit, by its path, with null for one missing.
async function inputsAt(m: Mirror, commit: string, paths: string[]): Promise<Inputs> {
  const out: Inputs = {}
  for (const path of paths) {
    const text = await read(m, commit, path)
    out[path] = text === null ? null : sha256(text)
  }
  return out
}

const short = (sha: string) => sha.slice(0, 10)
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

// What failed, for the agent sent back to fix it and for people reading the run.
function failureSummary(commit: string, failed: GateResult[]): string {
  return [`The gates failed on ${short(commit)}:`, ...failed.flatMap((r) => [
    `- ${r.gate}: ${r.summary}`,
    ...r.findings.map((f) => `  - ${f.path ? `${f.path}${f.line ? `:${f.line}` : ''} ` : ''}${f.text}`),
  ]), 'Fix these and report again. The runner runs every gate again.'].join('\n')
}

function commandResult(gate: string, c: CommandResult): GateResult {
  const ok = c.exitCode === 0
  return {
    gate, status: ok ? 'pass' : 'fail', stops: false,
    summary: `${c.argv.join(' ')} exited with ${c.exitCode ?? 'no code'}${c.timedOut ? ' after timing out' : ''} in ${c.seconds}s.`,
    findings: ok ? [] : [{ path: null, line: null, text: tail(scrub(c.output.trim()), OUTPUT_TAIL) }],
  }
}

function seenFailingResult(gate: string, s: SeenFailing): GateResult {
  const result = (summary: string, findings: Finding[] = []): GateResult => ({ gate: `${gate}:${s.file}`, status: findings.length ? 'fail' : 'pass', summary, findings, stops: false })
  if (s.base.exitCode === 0) {
    return result(`${s.file} passed on main's code, so it does not show what the change does.`, [{ path: s.file, line: null, text: 'passes before the change' }])
  }
  if (s.change.exitCode !== 0) {
    return result(`${s.file} fails on the change, exit ${s.change.exitCode ?? 'none'}.`, [{ path: s.file, line: null, text: tail(scrub(s.change.output.trim()), OUTPUT_TAIL) }])
  }
  return result(`${s.file} failed on main (exit ${s.base.exitCode ?? 'none'}${s.base.timedOut ? ', timed out' : ''}) and passes on the change.`)
}

const PUSHED = z.object({ pushed: z.array(z.object({ repoId: z.string(), commit: SHA })) })
const VERIFY_PHASE = z.object({ phase: z.enum(['push', 'box']) })

async function setStatus(governed: Governed, commit: string, context: string, ok: boolean, description: string) {
  await forge.setStatus(repoPath(governed.repo.remoteUrl), commit, context, ok ? 'success' : 'failure', description)
}

// Verify starts by pushing the task branch, so the gates judge exactly what a
// pull request would hold.
export async function startVerify(client: pg.PoolClient, run: Run, pipeline: Pipeline, row: Row): Promise<boolean> {
  await governedRun(client, run)
  const workspace = await workspaceOf(client, run)
  if (!workspace) throw new Error('verify started before the run had a workspace')
  const task = await taskOf(client, run)
  const sent = await sendPush(client, run, workspace, task, task.title, pipeline.agent)
  await setRow(client, row, { status: 'running', command_id: sent, data: { phase: 'push' }, started: true })
  return true
}

async function pendingCommand(client: pg.PoolClient, row: Row) {
  if (!row.command_id) return null
  const command = await one<{ status: string; error: string | null; result: unknown; payload: unknown }>(client, `command ${row.command_id}`,
    'select status, error, result, payload from commands where id = $1', [row.command_id])
  return command.status === 'queued' || command.status === 'claimed' ? null : command
}

export async function pollVerify(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], row: Row): Promise<boolean> {
  const governed = await governedRun(client, run)
  const command = await pendingCommand(client, row)
  if (!command) return false
  const { phase } = VERIFY_PHASE.parse(row.data)
  if (command.status === 'failed') {
    await setRow(client, row, { status: 'failed', summary: `The ${phase === 'push' ? 'push' : 'box\'s gates'} could not run: ${command.error ?? 'no reason given'}`, ended: true })
    return true
  }
  const { policy, repo } = governed
  if (phase === 'push') {
    const head = PUSHED.parse(command.result).pushed.find((p) => p.repoId === repo.id)?.commit
    if (!head) throw new Error('the push reported no commit for the repo')
    const task = await taskOf(client, run)
    const branch = branchOf(run, task)
    const m = await mirror(repo.id, repo.remoteUrl, [repo.defaultBranch, branch])
    const tip = await commitOf(m, branch)
    if (tip !== head) throw new Error(`${branch} is at ${tip} on the forge, not the pushed ${head}`)
    const main = await commitOf(m, repo.defaultBranch)
    const base = await mergeBase(m, main, head)
    const files = await changes(m, base, head)
    const refused = await many<{ refs: string[] }>(client,
      `select refs from refused_pushes where repo_id = $1 and created_at >= $3
       and instance_id in (select instance_id from workspaces where task_id = $2)`, [repo.id, run.task_id, run.started_at])
    const results = staticGates({
      policy, files,
      baseMigrations: await list(m, main, policy.docs.migrations),
      tokens: await read(m, main, policy.lint.css.tokens) ?? '',
      featureMap: await featureMapAt(m, main, policy),
      playbook: PLAYBOOK_NAMES.find((p) => p === run.playbook) ?? null,
      plan: await approvedPlan(client, pipeline, rows),
      // Code needs a plan a person approved, whether or not the pipeline asks for one.
      requirePlan: run.playbook !== 'docs',
      refusedPushes: refused,
    })
    const inputs = await inputsAt(m, main, [policy.lint.css.tokens, ...(policy.verification ? [policy.verification.features] : [])])
    await recordEvidence(client, run, row, governed, head, base, results, { worker: null, inputs })
    const judged: Verified = {
      head, base, main, patchId: await patchId(m, base, head),
      // Seen failing cannot apply to a change to checks alone, which goes to the owner instead.
      checks: checksOnly(policy, files) ? [] : files.filter((f) => f.status !== 'deleted' && matcher([policy.checks.pattern])(f.path)).map((f) => f.path),
      ui: policy.ui !== null && files.some((f) => matcher(policy.ui?.paths ?? [])(f.path)),
      docsOnly: files.every((f) => f.path.endsWith('.md')),
      needsOwner: results.filter((r) => r.status === 'needs_owner')
        .flatMap((r) => r.findings.map((f) => ({ gate: r.gate, path: f.path, text: f.text.split('\n')[0] ?? '' }))),
    }
    // A verdict holds for this head only if it judged the same patch.
    await client.query('update verdicts set voided_at = now() where run_id = $1 and voided_at is null and patch_id <> $2', [run.id, judged.patchId])
    const failed = results.filter((r) => r.status === 'fail')
    if (failed.length) {
      await setStatus(governed, head, STATUS.gates, false, `${failed.map((r) => r.gate).join(', ')} failed`)
      await setRow(client, row, {
        status: 'done', outcome: failed.some((r) => r.stops) ? 'stopped' : 'fails', summary: failureSummary(head, failed),
        data: { phase: 'static', ...judged }, ended: true,
      })
      return true
    }
    const workspace = await workspaceOf(client, run)
    if (!workspace) throw new Error('the run lost its workspace')
    const boxChecks = judged.checks.filter((path) => (files.find((f) => f.path === path)?.after ?? '').includes(policy.checks.boxMarker))
    const payload: VerifyPayload = {
      workspaceId: workspace.id, repo: repo.name, head, base, overlay: policy.box.overlay, commands: policy.box.commands,
      checks: boxChecks, checkArgv: policy.checks.argv, checkTimeoutSec: policy.checks.timeoutSec,
    }
    const sent = await one<{ id: string }>(client, 'the box gates command',
      `insert into commands (team_id, instance_id, kind, payload) values ($1, $2, 'verify', $3) returning id`,
      [run.team_id, workspace.instance_id, JSON.stringify(payload)])
    await setRow(client, row, { command_id: sent.id, data: { phase: 'box', ...judged } })
    return true
  }
  const judged = VERIFIED.parse(row.data)
  const result = VERIFY_RESULT.parse(command.result)
  const asked = VERIFY_PAYLOAD.parse(command.payload)
  const mismatch = resultProblems({ commands: asked.commands, checks: asked.checks, setup: null }, result)
  if (mismatch.length) {
    await setRow(client, row, { status: 'failed', summary: `The box's result does not answer what it was asked, so it is no evidence: ${mismatch.join('; ')}.`, ended: true })
    return true
  }
  const results = [...result.commands.map((c) => commandResult(`box:${c.name}`, c)), ...result.checks.map((s) => seenFailingResult('seen_failing', s))]
  await recordEvidence(client, run, row, governed, judged.head, judged.base, results, { worker: result.build, inputs: {} })
  const failed = results.filter((r) => r.status === 'fail')
  await setStatus(governed, judged.head, STATUS.gates, !failed.length, failed.length ? `${failed.map((r) => r.gate).join(', ')} failed` : 'Every gate passed.')
  await setRow(client, row, {
    status: 'done', outcome: failed.length ? 'fails' : 'passes', ended: true,
    summary: failed.length ? failureSummary(judged.head, failed) : `Every gate passed on ${short(judged.head)}, with ${result.checks.length} changed checks seen failing on main.`,
  })
  return true
}

// What a review or confirm row keeps: its round, the commit, and each
// reviewer's session and report.
const REPORTED_FINDING = z.object({
  rule: z.string(), path: z.string(), line: z.number().nullable(), body: z.string(), blocking: z.boolean(), topic: z.string().nullable(),
})
const REVIEWER = z.object({
  agent: z.string(), agentId: z.string(), model: z.string(), sessionId: z.string(), fromSeq: z.string(), reminded: z.boolean(),
  report: z.object({ outcome: z.string(), findings: z.array(REPORTED_FINDING), ran: z.array(z.string()) }).nullable(),
})
const REVIEW_STATE = z.object({
  round: z.number().int(), head: SHA, base: SHA, rules: z.array(z.string()), reviewers: z.array(REVIEWER), inputs: INPUTS,
})
type ReviewState = z.infer<typeof REVIEW_STATE>
type Reviewer = z.infer<typeof REVIEWER>

const family = (model: string) => model.split(/[-_]/)[0] ?? model

// Whether the judges can be independent of the author: each on a model of its own.
function modelProblems(author: AgentRow | undefined, authorName: string, judges: (AgentRow | undefined)[], names: string[], wanted: number): string[] {
  const problems: string[] = []
  if (!author) problems.push(`there is no agent named ${authorName}, the author`)
  else if (!author.model) problems.push(`${author.name}, the author, has no model set, so no judge can be shown to differ from it`)
  names.forEach((name, i) => {
    const judge = judges[i]
    if (!judge) problems.push(`there is no agent named ${name}`)
    else if (!judge.model) problems.push(`${name} has no model set`)
    else if (judge.model === author?.model) problems.push(`${name} runs on ${judge.model}, the author's model`)
  })
  const models = judges.flatMap((r) => (r?.model ? [r.model] : []))
  if (new Set(models).size !== models.length) problems.push('two judges run on the same model')
  if (names.length < wanted) problems.push(`the policy wants ${wanted}, and the stage names ${names.length}`)
  return problems
}

// Starts each judge's turn in a session of its own, with no team-record tools,
// so it cannot read the author's session. The row's reviewers, written in the
// transaction that creates each session, mark it a judge's, and sendToSession
// refuses a person's message to it.
async function startJudges(client: pg.PoolClient, run: Run, rows: Row[], row: Row, workspace: Workspace, budget: number,
  judges: AgentRow[], prompt: string, outcomes: string[], allow: string[], state: Omit<ReviewState, 'reviewers'>) {
  const earlier = rows.filter((r) => r.stage === row.stage).flatMap((r) => REVIEW_STATE.safeParse(r.data).data?.reviewers ?? [])
  const reviewers: Reviewer[] = []
  for (const judge of judges) {
    if (!judge.model) throw new Error(`${judge.name} lost its model after it was checked`)
    // A judge replaced for going quiet starts in a fresh session.
    const before = row.data.fresh === true ? null : earlier.find((r) => r.agent === judge.name)?.sessionId ?? null
    const session = await stageSession(client, run, workspace, judge, row.stage, before)
    // A judge never edits the change it judges, so an edit asks a person.
    const seq = await sendPrompt(client, run, workspace, judge, session,
      { text: prompt + REPORT_INSTRUCTION(outcomes), clientId: `stage:${row.id}:${judge.name}`, stage: row.stage },
      { outcomes, allow, maxBudgetUsd: Number(session.cost_usd ?? 0) + budget, isolated: true }, JUDGE_PERMISSIONS)
    reviewers.push({ agent: judge.name, agentId: judge.id, model: judge.model, sessionId: session.id, fromSeq: String(seq), reminded: false, report: null })
  }
  const first = reviewers[0]
  await setRow(client, row, { status: 'running', session_id: first?.sessionId ?? null, from_seq: first?.fromSeq ?? null, data: { ...state, reviewers }, started: true })
}

async function judgeContext(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], governed: Governed) {
  const judged = verified(pipeline, rows)
  if (!judged) throw new Error('a judge started with no change that passed verify')
  const { m } = await mainMirror(governed)
  const diff = await diffText(m, judged.base, judged.head)
  // The rules come from main. The judge's checkout is the branch under
  // review, and the change may have edited its copy of them.
  const rubric = await read(m, judged.main, governed.policy.review.rubric)
  if (rubric === null) throw new Error(`the rubric ${governed.policy.review.rubric} is not on main`)
  const verification = governed.policy.verification
  const skill = verification ? await read(m, judged.main, verification.skill) : null
  const features = verification ? await read(m, judged.main, verification.features) : null
  const inputs: Inputs = { [governed.policy.review.rubric]: sha256(rubric) }
  if (verification) {
    inputs[verification.skill] = skill === null ? null : sha256(skill)
    inputs[verification.features] = features === null ? null : sha256(features)
  }
  return {
    judged, rubric, skill, features, inputs,
    diff: diff.length > REVIEW_DIFF_LIMIT ? `${diff.slice(0, REVIEW_DIFF_LIMIT)}\n(cut at ${REVIEW_DIFF_LIMIT} characters, read the rest in ./${governed.repo.name})` : diff,
    rules: [...ruleNames(rubric), ...governed.policy.principles.map((p) => p.name), 'Done means', 'Keep'],
    lessons: await lessonsOf(client, run, governed.repo.id),
    plan: await approvedPlan(client, pipeline, rows),
  }
}

export async function startReview(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], row: Row, stage: ReviewStage, ctx: RunContext, workspace: Workspace, budget: number): Promise<boolean> {
  const governed = await governedRun(client, run)
  const author = await agentNamed(client, run.team_id, stage.author)
  const reviewers = await Promise.all(stage.reviewers.map((name) => agentNamed(client, run.team_id, name)))
  const problems = modelProblems(author, stage.author, reviewers, stage.reviewers, governed.policy.review.reviewers)
  if (problems.length) {
    await setRow(client, row, { status: 'failed', summary: `The review cannot be independent: ${problems.join('; ')}.`, started: true, ended: true })
    return true
  }
  const { judged, diff, rules, lessons, plan, rubric, inputs } = await judgeContext(client, run, pipeline, rows, governed)
  const round = rows.filter((r) => r.stage === row.stage && r.status === 'done').length + 1
  const prompt = [
    `You review a change to ${governed.repo.name} on your own, on a model other than its author's. You have not seen the author's session or reasoning, and you only read.`,
    stage.prompt(ctx),
    `The plan a person approved:\n\n${plan ?? '(no plan)'}`,
    `Judge the change by the rubric below, main's copy of ${governed.policy.review.rubric}, starting with its "No shortcuts" section. ./${governed.repo.name} is the branch under review. Where its copy of the rubric, AGENTS.md or CLAUDE.md differs from main's, main's wins. Every finding names the rule it breaks, using one of these names exactly:\n${rules.map((r) => `- ${r}`).join('\n')}\n\n<rubric>\n${rubric}\n</rubric>`,
    `The policy's principles:\n${governed.policy.principles.map((p) => `- ${p.name}. ${p.text}`).join('\n')}`,
    ...(lessons.length ? [`The team's lessons:\n${lessons.map((l) => `- ${l.rule}`).join('\n')}`] : []),
    `The diff from main to ${short(judged.head)}:\n\n\`\`\`diff\n${diff}\n\`\`\``,
    'Report clean when nothing must change, or blocking when something must. Put every finding in data.findings as { rule, path, line, body, blocking, topic }, with line null when it has none. Set topic to security, auth, billing, data, migrations or concurrency when the finding is about one of them, and null otherwise. A person always sees those.',
  ].join('\n\n')
  const judges = reviewers.flatMap((r) => (r ? [r] : []))
  await startJudges(client, run, rows, row, workspace, budget, judges, prompt, [...REVIEW_OUTCOMES], stage.allow, { round, head: judged.head, base: judged.base, rules, inputs })
  return true
}

const TOOL_RUNS = z.object({ command: z.string() })

// The commands a session ran since `fromSeq`, read from the record. A verifier
// lists what it ran, and this is the list the runner trusts.
async function commandsRan(client: pg.PoolClient, sessionId: string, fromSeq: string): Promise<string[]> {
  const calls = await many<{ input: unknown; failed: boolean | null }>(client,
    `select c.body->'input' as input, (select coalesce((r.body->>'isError')::boolean, false) from events r
       where r.session_id = c.session_id and r.kind = 'tool_result' and r.tool_use_id = c.tool_use_id limit 1) as failed
     from events c where c.session_id = $1 and c.seq > $2 and c.kind = 'tool_call' and c.tool_name = 'Bash' order by c.seq`, [sessionId, fromSeq])
  return calls.flatMap((c) => {
    const input = TOOL_RUNS.safeParse(c.input)
    return input.success && c.failed === false ? [input.data.command] : []
  })
}

// Reads each judge's turn. Returns the reports once every judge has one, or
// whether the row changed while some are still out.
async function judgeReports(client: pg.PoolClient, run: Run, row: Row, state: ReviewState, outcomes: readonly string[],
  parse: (data: Record<string, unknown>) => { findings: ReviewFinding[] } | string): Promise<{ done: true } | { done: false; changed: boolean } | { failed: string }> {
  let changed = false
  for (const reviewer of state.reviewers) {
    if (reviewer.report) continue
    const turn = await readTurn(client, run, {
      sessionId: reviewer.sessionId, fromSeq: reviewer.fromSeq, outcomes: [...outcomes], reminded: reviewer.reminded,
      key: `stage:${row.id}:${reviewer.agent}:nudge`, stage: row.stage,
    })
    if (turn.state === 'waiting') continue
    if (turn.state === 'failed') return { failed: `${reviewer.agent}: ${turn.reason}` }
    changed = true
    if (turn.state === 'reminded') {
      reviewer.fromSeq = turn.fromSeq
      reviewer.reminded = true
      continue
    }
    const parsed = parse(turn.data)
    if (typeof parsed === 'string') return { failed: `${reviewer.agent} ${parsed}` }
    const unknown = parsed.findings.filter((f) => !state.rules.some((r) => ruleOf(r) === ruleOf(f.rule)))
    if (unknown.length) return { failed: `${reviewer.agent} cited rules that are not in the rubric: ${unknown.map((f) => `"${f.rule}"`).join(', ')}.` }
    reviewer.report = { outcome: turn.outcome, findings: parsed.findings, ran: await commandsRan(client, reviewer.sessionId, reviewer.fromSeq) }
  }
  return state.reviewers.every((r) => r.report) ? { done: true } : { done: false, changed }
}

// Records a round's findings. Earlier rounds' open findings are fixed unless
// repeated. A finding a person overruled earlier in the run stays overruled
// when a judge raises it again, since their decision is a fact of the run, and
// it is returned as decided so it neither blocks nor asks again.
async function recordFindings(client: pg.PoolClient, run: Run, row: Row, state: ReviewState) {
  const raised = state.reviewers.flatMap((reviewer) => (reviewer.report?.findings ?? []).map((finding) => ({ reviewer, finding })))
  const open = await many<{ id: string; agent_id: string | null; rule: string; path: string | null }>(client,
    `select id, agent_id, rule, path from findings where run_id = $1 and stage = $2 and status = 'open'`, [run.id, row.stage])
  for (const old of open) {
    const repeated = raised.some(({ reviewer, finding }) => reviewer.agentId === old.agent_id && ruleOf(finding.rule) === ruleOf(old.rule) && finding.path === old.path)
    await client.query('update findings set status = $2 where id = $1', [old.id, repeated ? 'repeated' : 'fixed'])
  }
  const overruled = await many<{ rule: string; path: string | null; body: string; decided_by: string | null; decided_at: Date }>(client,
    `select rule, path, body, decided_by, decided_at from findings where run_id = $1 and status = 'overruled' order by decided_at`, [run.id])
  const found = []
  for (const { reviewer, finding } of raised) {
    const rule = finding.rule.trim().replace(/\.$/, '')
    const prior = overruled.find((o) => findingKey(o) === findingKey(finding))
    await client.query(
      `insert into findings (team_id, run_id, run_stage_id, stage, round, commit, agent_id, model, rule, path, line, body, blocking, topic, status, decided_by, decided_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [run.team_id, run.id, row.id, row.stage, state.round, state.head, reviewer.agentId, reviewer.model,
        rule, finding.path, finding.line, finding.body, finding.blocking, finding.topic,
        prior ? 'overruled' : 'open', prior?.decided_by ?? null, prior?.decided_at ?? null])
    found.push({ reviewer, finding, decided: prior !== undefined })
  }
  return found
}

const listFindings = (items: { reviewer: { agent: string }; finding: { rule: string; path: string; line: number | null; body: string; topic: string | null }; decided?: boolean }[]) =>
  items.map(({ reviewer, finding, decided }) => `- ${finding.path}${finding.line ? `:${finding.line}` : ''} breaks "${finding.rule}"${finding.topic ? ` (${finding.topic})` : ''} (${reviewer.agent}${decided ? ', overruled earlier in this run' : ''}): ${finding.body}`).join('\n')

// Asks the owner to decide what judges left open. Only they can answer.
async function askOwner(client: pg.PoolClient, run: Run, row: Row, governed: Governed, question: string, options: string[], data: Record<string, unknown>) {
  const task = await taskOf(client, run)
  const full = `${question} Only ${governed.owner.login} can answer this.`
  const ask = await one<{ id: string }>(client, 'the owner\'s ask',
    `insert into asks (team_id, kind, run_id, conversation_id, payload) values ($1, 'question', $2, $3, $4) returning id`,
    [run.team_id, run.id, task.conversation_id, JSON.stringify({ question: full, stage: row.stage, options, only: governed.owner.id, onlyLogin: governed.owner.login })])
  await setRow(client, row, { status: 'waiting', ask_id: ask.id, data })
  await client.query(`update runs set status = 'waiting' where id = $1`, [run.id])
  await post(client, run, `owner:${ask.id}`, `@${governed.owner.login} ${full}`)
}

export async function pollReview(client: pg.PoolClient, run: Run, rows: Row[], row: Row): Promise<boolean> {
  const governed = await governedRun(client, run)
  const state = REVIEW_STATE.parse(row.data)
  const read = await judgeReports(client, run, row, state, REVIEW_OUTCOMES, (data) => {
    const parsed = REVIEW_DATA.safeParse(data)
    return parsed.success ? parsed.data : `reported findings in a shape the runner cannot read: ${parsed.error.message}`
  })
  if ('failed' in read) {
    await setRow(client, row, { status: 'failed', summary: read.failed, ended: true })
    return true
  }
  if (!read.done) {
    if (read.changed) await setRow(client, row, { data: state })
    return read.changed
  }
  const found = await recordFindings(client, run, row, state)
  const blocking = found.filter(({ finding, decided }) => finding.blocking && !decided)
  const sensitive = found.filter(({ finding, decided }) => finding.topic !== null && !decided)
  const data = { ...state, workedUntil: new Date().toISOString() }
  const gate = `review:${row.stage}`
  if (blocking.length) {
    await recordEvidence(client, run, row, governed, state.head, state.base, [{
      gate, status: 'fail', stops: false, summary: `${blocking.length} blocking findings in round ${state.round}.`,
      findings: blocking.map(({ finding }) => ({ path: finding.path, line: finding.line, text: `${finding.rule}: ${finding.body}` })),
    }], { worker: null, inputs: state.inputs })
    await setStatus(governed, state.head, STATUS.review, false, `${row.stage} found ${blocking.length} blocking findings`)
  }
  // Findings about security, auth, billing, data, migrations or concurrency go
  // to a person whatever else happens, as do findings left at the last round.
  if (sensitive.length || (blocking.length && state.round >= governed.policy.review.rounds)) {
    const about = sensitive.length ? sensitive : blocking
    const why = sensitive.length ? 'These findings touch areas a person always decides' : `After ${state.round} rounds the reviewers still block`
    await askOwner(client, run, row, governed, `${why}:\n${listFindings(about)}\nSend the change back to fix them, overrule them, or stop the run?`,
      ['fix', 'overrule', 'stop'], { ...data, phase: 'owner' })
    return true
  }
  if (blocking.length) {
    await setRow(client, row, { status: 'done', outcome: 'fix', summary: `The reviewers block on:\n${listFindings(blocking)}\nFix each one, or say in your report why it is wrong. The reviewers judge it again.`, data, ended: true })
    return true
  }
  await recordEvidence(client, run, row, governed, state.head, state.base, [{ gate, status: 'pass', stops: false, summary: `${state.reviewers.length} reviewers found nothing blocking in round ${state.round}.`, findings: [] }], { worker: null, inputs: state.inputs })
  await setStatus(governed, state.head, STATUS.review, true, `${row.stage} passed`)
  await setRow(client, row, { status: 'done', outcome: 'clean', summary: found.length ? `Nothing blocks. Notes:\n${listFindings(found)}` : 'Nothing blocks.', data, ended: true })
  return true
}

// A verifier checks the plan's Done means and Keep items, and its verdict is
// recorded with the commands the record shows it ran.
export async function startConfirm(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], row: Row, stage: ConfirmStage, ctx: RunContext, workspace: Workspace, budget: number): Promise<boolean> {
  const governed = await governedRun(client, run)
  const author = await agentNamed(client, run.team_id, stage.author)
  const verifier = await agentNamed(client, run.team_id, stage.verifier)
  const problems = modelProblems(author, stage.author, [verifier], [stage.verifier], 1)
  if (problems.length || !verifier) {
    await setRow(client, row, { status: 'failed', summary: `The verifier cannot be independent: ${problems.join('; ')}.`, started: true, ended: true })
    return true
  }
  const { judged, rules, plan, skill, features, inputs } = await judgeContext(client, run, pipeline, rows, governed)
  const verification = governed.policy.verification
  // A verifier without the skill or map the policy names would judge less than
  // the policy asks, so the stage stops and says what to fix.
  const lacking = verification ? [skill === null ? verification.skill : null, features === null ? verification.features : null].filter((p) => p !== null) : []
  if (lacking.length) {
    await setRow(client, row, { status: 'failed', summary: `The policy names ${lacking.join(' and ')}, which main lacks, so no verifier can check the Keep items. Add them to main, or take them out of the policy.`, started: true, ended: true })
    return true
  }
  const floor = floorFor(governed.policy, judged)
  const sameFamily = author?.model && verifier.model && family(author.model) === family(verifier.model)
  const prompt = [
    `You verify a change to ${governed.repo.name} at ${short(judged.head)}. You did not write it and have not seen how it was written. Never edit ./${governed.repo.name}: any edit after the gates ran stops the run. Run the code to see each item hold, and list what you ran.`,
    stage.prompt(ctx),
    `The plan a person approved:\n\n${plan ?? '(no plan)'}`,
    ...(verification ? [`Follow the repo's verification skill and use its feature map for the Keep items. Both are main's copies, below. ./${governed.repo.name} is the branch under review, and where its copies differ, main's win.\n\n<skill path="${verification.skill}">\n${skill ?? ''}\n</skill>\n\n<features path="${verification.features}">\n${features ?? ''}\n</features>`] : []),
    `Report one verdict: live-ui-verified when you drove the changed view and saw it work, unit-test-verified when its checks ran and passed, type-check-only when only the typecheck applies, verifier-blocked when you could not judge, or verifier-failed when an item does not hold. This change needs at least ${floor}. Put each problem in data.findings as { rule, path, line, body, blocking, topic }, citing "Done means", "Keep" or a rule from the rubric:\n${rules.map((r) => `- ${r}`).join('\n')}`,
  ].join('\n\n')
  const round = rows.filter((r) => r.stage === row.stage && r.status === 'done').length + 1
  await startJudges(client, run, rows, row, workspace, budget, [verifier], prompt, [...VERDICTS], stage.allow, { round, head: judged.head, base: judged.base, rules, inputs })
  if (sameFamily) await client.query(`update run_stages set data = data || '{"sameFamily": true}' where id = $1`, [row.id])
  return true
}

function floorFor(policy: Policy, judged: Verified): PassingVerdict {
  return judged.ui ? policy.verdict.ui : judged.docsOnly ? policy.verdict.docs : policy.verdict.code
}

export async function pollConfirm(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], row: Row): Promise<boolean> {
  const governed = await governedRun(client, run)
  const state = REVIEW_STATE.parse(row.data)
  const read = await judgeReports(client, run, row, state, VERDICTS, (data) => {
    const parsed = VERIFIER_DATA.safeParse(data)
    return parsed.success ? parsed.data : `reported a verdict in a shape the runner cannot read: ${parsed.error.message}`
  })
  if ('failed' in read) {
    await setRow(client, row, { status: 'failed', summary: read.failed, ended: true })
    return true
  }
  if (!read.done) {
    if (read.changed) await setRow(client, row, { data: state })
    return read.changed
  }
  const verifier = state.reviewers[0]
  const report = verifier?.report
  if (!verifier || !report) throw new Error('the verifier reported nothing')
  const judged = verified(pipeline, rows)
  if (!judged) throw new Error('the verifier judged a change that never passed verify')
  // The runner judges the claim by what the verifier ran, not by what it says.
  const claimed = VERDICTS.find((v) => v === report.outcome) ?? 'verifier-blocked'
  const passing = passingVerdict(claimed)
  const verdict: Verdict = passing && !report.ran.length ? 'verifier-blocked'
    : claimed === 'live-ui-verified' ? 'verifier-blocked'
      : claimed
  const note = verdict !== claimed
    ? claimed === 'live-ui-verified' ? ' It claimed live UI verification, and no screenshots reach the record until agentsctl lands.' : ` It claimed ${claimed} and ran nothing.`
    : ''
  const floor = floorFor(governed.policy, judged)
  const level = passingVerdict(verdict)
  const weaker = row.data.sameFamily === true ? ' The verifier is from the author\'s model family, a weaker check than another family would give.' : ''
  const summary = `${verifier.agent} on ${verifier.model}: ${verdict}.${note}${weaker} It ran ${report.ran.length ? report.ran.map((c) => `\`${c}\``).join(', ') : 'nothing'}.`
  const opened = [...rows].reverse().find((r) => typeof r.data.pullRequest === 'number')
  await client.query(
    `insert into verdicts (team_id, run_id, run_stage_id, repo_id, pull_request, head, base, patch_id, verdict, agent_id, model, ran, summary, build)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [run.team_id, run.id, row.id, governed.repo.id, typeof opened?.data.pullRequest === 'number' ? opened.data.pullRequest : null,
      judged.head, judged.base, judged.patchId, verdict, verifier.agentId, verifier.model, JSON.stringify(report.ran), summary,
      JSON.stringify({ runner: BUILD, worker: null, inputs: state.inputs } satisfies EvidenceBuild)])
  const found = await recordFindings(client, run, row, state)
  const data = { ...state, workedUntil: new Date().toISOString() }
  const ok = level !== null && meets(level, floor)
  await recordEvidence(client, run, row, governed, judged.head, judged.base, [{
    gate: 'verdict', status: ok ? 'pass' : 'fail', stops: false, summary,
    findings: found.map(({ finding }) => ({ path: finding.path, line: finding.line, text: `${finding.rule}: ${finding.body}` })),
  }], { worker: null, inputs: state.inputs })
  await setStatus(governed, judged.head, STATUS.verdict, ok, `${verdict}, needs ${floor}`)
  if (ok) {
    await setRow(client, row, { status: 'done', outcome: 'verified', summary, data, ended: true })
    return true
  }
  if (verdict === 'verifier-failed') {
    await setRow(client, row, { status: 'done', outcome: 'fix', summary: `${summary}\n${listFindings(found)}`, data, ended: true })
    return true
  }
  await askOwner(client, run, row, governed, `${summary} The change needs ${floor}. Accept this verdict, send the change back, or stop the run?`,
    ['overrule', 'fix', 'stop'], { ...data, phase: 'owner' })
  return true
}

// The owner's answer to a review's or a verifier's open question.
export async function answerJudges(client: pg.PoolClient, run: Run, row: Row, decision: string, login: string, personId: string | null): Promise<boolean> {
  const governed = await governedRun(client, run)
  const state = REVIEW_STATE.parse(row.data)
  if (decision === 'stop') {
    await setRow(client, row, { status: 'done', outcome: 'stopped', summary: `${login} stopped the run at ${row.stage}.`, ended: true })
    await finishRun(client, run, 'failed', `Stopped by ${login} at ${row.stage}.`)
    return true
  }
  if (decision === 'fix') {
    await setRow(client, row, { status: 'done', outcome: 'fix', summary: `${login} sent the change back to fix what the ${row.kind === 'confirm' ? 'verifier' : 'reviewers'} found.`, ended: true })
    return true
  }
  const { rowCount } = await client.query(
    `update findings set status = 'overruled', decided_by = $3, decided_at = now()
     where run_id = $1 and stage = $2 and status = 'open'`, [run.id, row.stage, personId])
  if (row.kind === 'confirm') {
    await client.query('update verdicts set accepted_by = $2, accepted_at = now() where run_stage_id = $1 and voided_at is null', [row.id, personId])
  }
  const gate = row.kind === 'confirm' ? 'verdict' : `review:${row.stage}`
  const summary = `${login} overruled ${rowCount ?? 0} findings${row.kind === 'confirm' ? ' and accepted the verdict' : ''}.`
  await recordEvidence(client, run, row, governed, state.head, state.base, [{ gate, status: 'pass', stops: false, summary, findings: [] }], { worker: null, inputs: state.inputs })
  await setStatus(governed, state.head, row.kind === 'confirm' ? STATUS.verdict : STATUS.review, true, summary)
  await setRow(client, row, { status: 'done', outcome: 'overruled', summary, ended: true })
  return true
}

const SUITE_STATE = z.object({ head: SHA, firstFailure: z.array(z.string()).optional() })

async function sendSuite(client: pg.PoolClient, run: Run, governed: Governed, judged: Verified, hostId: string): Promise<string> {
  const task = await taskOf(client, run)
  const { policy, repo } = governed
  const payload: SuitePayload = {
    repoId: repo.id, name: repo.name, main: repo.defaultBranch, branch: branchOf(run, task), head: judged.head, setup: repo.setup,
    commands: policy.suite.commands, checks: judged.checks, checkArgv: policy.checks.argv, checkTimeoutSec: policy.checks.timeoutSec,
    evidence: policy.suite.evidence,
  }
  const sent = await one<{ id: string }>(client, 'the suite command',
    `insert into commands (team_id, instance_id, kind, payload) values ($1, $2, 'suite', $3) returning id`, [run.team_id, hostId, JSON.stringify(payload)])
  return sent.id
}

export async function startSuite(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], row: Row): Promise<boolean> {
  const governed = await governedRun(client, run)
  const judged = verified(pipeline, rows)
  if (!judged) throw new Error('the suite started with no change that passed verify')
  const host = await maybe<{ id: string }>(client,
    `select id from instances where team_id = $1 and kind = 'check' order by status = 'online' desc, last_seen_at desc nulls last limit 1`, [run.team_id])
  if (!host) {
    await setRow(client, row, { status: 'failed', summary: 'The team has no check host to run the suite on.', started: true, ended: true })
    return true
  }
  const sent = await sendSuite(client, run, governed, judged, host.id)
  await setRow(client, row, { status: 'running', command_id: sent, data: { head: judged.head, host: host.id }, started: true })
  return true
}

export async function pollSuite(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], row: Row): Promise<boolean> {
  const governed = await governedRun(client, run)
  const command = await pendingCommand(client, row)
  if (!command) return false
  if (command.status === 'failed') {
    await setRow(client, row, { status: 'failed', summary: `The check host could not run the suite: ${command.error ?? 'no reason given'}`, ended: true })
    return true
  }
  const state = SUITE_STATE.parse(row.data)
  const result = SUITE_RESULT.parse(command.result)
  const asked = SUITE_PAYLOAD.parse(command.payload)
  const mismatch = result.merged ? resultProblems(asked, result) : []
  if (mismatch.length) {
    await setRow(client, row, { status: 'failed', summary: `The check host's result does not answer what it was asked, so it is no evidence: ${mismatch.join('; ')}.`, ended: true })
    return true
  }
  const results: GateResult[] = result.merged
    ? [...result.commands.map((c) => commandResult(`suite:${c.name}`, c)), ...result.checks.map((s) => seenFailingResult('suite_seen_failing', s))]
    : [{ gate: 'suite:merge', status: 'fail', stops: false, summary: `The change does not merge into main at ${short(result.main)}.`, findings: [{ path: null, line: null, text: tail(scrub(result.conflict), OUTPUT_TAIL) }] }]
  const failing = results.filter((r) => r.status === 'fail').map((r) => r.gate).sort()
  // A failure gets one fresh run. The same failure twice is real.
  if (failing.length && result.merged && !state.firstFailure) {
    const judged = verified(pipeline, rows)
    const host = z.object({ host: z.string() }).parse(row.data).host
    if (!judged) throw new Error('the suite lost the change it was testing')
    await recordEvidence(client, run, row, governed, state.head, result.main, results.map((r) => ({ ...r, gate: `${r.gate}:first-run` })), { worker: result.build, inputs: {} })
    const sent = await sendSuite(client, run, governed, judged, host)
    await setRow(client, row, { command_id: sent, data: { ...row.data, firstFailure: failing } })
    return true
  }
  if (!failing.length && state.firstFailure) {
    results.push({ gate: 'suite:flake', status: 'pass', stops: false, summary: `The first run failed ${state.firstFailure.join(', ')} and a fresh run passed, so that failure was a flake.`, findings: [] })
  }
  await recordEvidence(client, run, row, governed, state.head, result.main, results, { worker: result.build, inputs: {} })
  await setStatus(governed, state.head, STATUS.suite, !failing.length, failing.length ? `failed on main ${short(result.main)}` : `passed on main ${short(result.main)}`)
  const summary = failing.length
    ? failureSummary(state.head, results.filter((r) => r.status === 'fail'))
    : `The full suite passed on ${short(state.head)} merged into main at ${short(result.main)}, with ${result.merged ? result.checks.length : 0} changed checks seen failing on main.`
  const opened = [...rows].reverse().find((r) => typeof r.data.pullRequest === 'number')
  const number = typeof opened?.data.pullRequest === 'number' ? opened.data.pullRequest : null
  const judged = verified(pipeline, rows)
  const unattested = !failing.length && number !== null && judged ? await attest(client, run, pipeline, rows, governed, judged, number, result.main, result.build) : null
  const note = unattested ? ` The runner did not attest to it, because ${unattested}.` : ''
  if (number !== null) await forge.comment(repoPath(governed.repo.remoteUrl), number, `The check host:\n\n${summary}${note}`)
  await setRow(client, row, { status: 'done', outcome: failing.length ? 'fails' : 'passes', summary: `${summary}${note}`, data: { ...row.data, main: result.main }, ended: true })
  return true
}

// The owner who approved a gate of this role after a moment, or null.
async function ownerApproval(client: pg.PoolClient, pipeline: Pipeline, rows: Row[], governed: Governed, role: GateRole, after: Date): Promise<string | null> {
  for (const r of [...rows].reverse()) {
    if (roleOf(pipeline, r.stage) !== role || r.outcome !== 'approved' || !r.ask_id || !r.ended_at || r.ended_at.getTime() < after.getTime()) continue
    const ask = await maybe<{ answered_by: string | null }>(client, 'select answered_by from asks where id = $1', [r.ask_id])
    if (ask?.answered_by === governed.owner.id) return ask.answered_by
  }
  return null
}

// Once the suite passes, the runner attests to what it checked on the head:
// the attestation goes in the pull request's description, and its digest in a
// status on the head commit. It attests only to a record with no failed gate
// and every owner-only gate approved, and returns why when it does not.
async function attest(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], governed: Governed, judged: Verified, number: number, main: string, checkHost: ToolBuild): Promise<string | null> {
  const evidence = await many<{ gate: string; status: string; created_at: Date; build: unknown }>(client,
    `select distinct on (gate) gate, status, created_at, build from evidence where run_id = $1 and commit = $2 order by gate, created_at desc`, [run.id, judged.head])
  const steps: Attestation['steps'] = []
  for (const e of evidence.filter((row) => !row.gate.endsWith(':first-run'))) {
    if (e.status === 'pass') steps.push({ gate: e.gate, result: ADVISORY(e.gate) ? 'advisory' : 'pass' })
    else if (e.status === 'needs_owner' && await ownerApproval(client, pipeline, rows, governed, 'protected', e.created_at)) steps.push({ gate: e.gate, result: 'approved' })
    else return `${e.gate} is ${e.status}`
  }
  const box = evidence.find((e) => e.gate.startsWith('box:'))
  const policy = await one<{ name: string; version: number }>(client, 'the policy', 'select name, version from policies where id = $1', [governed.policyId])
  const attestation: Attestation = {
    v: 1, tool: 'agents', repo: repoPath(governed.repo.remoteUrl), pullRequest: number,
    head: judged.head, base: judged.base, main, patchId: judged.patchId,
    policy: { id: governed.policyId, name: policy.name, version: policy.version },
    build: { runner: BUILD, box: box ? EVIDENCE_BUILD.parse(box.build).worker : null, checkHost },
    steps, at: new Date().toISOString(),
  }
  const repo = repoPath(governed.repo.remoteUrl)
  const pull = await forge.pull(repo, number)
  if (pull.head.sha !== judged.head) return `the pull request moved to ${short(pull.head.sha)}`
  await forge.describe(repo, number, withAttestation(pull.body ?? '', attestation))
  await forge.setStatus(repo, judged.head, ATTESTATION_STATUS, 'success', statusText(attestation))
  return null
}

// Whether the change may merge, with its proof when it may. Any pipeline
// merging on a repo with a policy goes through this.
async function readiness(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], judged: Verified, governed: Governed, number: number): Promise<Readiness> {
  const reasons: string[] = []
  const head = judged.head
  const evidence = await many<{ gate: string; status: string; created_at: Date }>(client,
    `select distinct on (gate) gate, status, created_at from evidence where run_id = $1 and commit = $2 order by gate, created_at desc`, [run.id, head])
  const ownerApproved = (role: GateRole, after: Date) => ownerApproval(client, pipeline, rows, governed, role, after)
  for (const e of evidence) {
    if (e.status === 'fail' && !e.gate.endsWith(':first-run')) reasons.push(`${e.gate} failed`)
    if (e.status === 'needs_owner' && !(await ownerApproved('protected', e.created_at))) reasons.push(`${e.gate} needs ${governed.owner.login}, who has not approved it`)
  }
  const has = (prefix: string) => evidence.some((e) => e.gate.startsWith(prefix))
  if (!has('protected')) reasons.push('the static gates have not judged this commit')
  if (!has('box:')) reasons.push('the box has not run its gates on this commit')
  // A pipeline can add stages but not drop the core ones: the gates above,
  // a review, the verdict, the suite and the owner's merge are asked of every
  // change, whatever stages the pipeline has.
  const reviews = Object.keys(pipeline.stages).filter((n) => stageOf(pipeline, n).kind === 'review')
  if (!reviews.length) reasons.push('the pipeline has no review stage, and every change to a repo with a policy needs one')
  for (const name of reviews) {
    if (!evidence.some((e) => e.gate === `review:${name}` && e.status === 'pass')) reasons.push(`${name} has not passed this commit`)
  }
  const verdict = await maybe<{ verdict: string; model: string; accepted_by: string | null }>(client,
    `select verdict, model, accepted_by from verdicts where run_id = $1 and voided_at is null and (head = $2 or patch_id = $3) order by created_at desc limit 1`,
    [run.id, head, judged.patchId])
  const floor = floorFor(governed.policy, judged)
  const given = verdict ? VERDICT.parse(verdict.verdict) : null
  const level = given ? passingVerdict(given) : null
  const verdictProof: VerdictProof | null = !verdict || !given ? null
    : level !== null && meets(level, floor) ? { kind: 'met', level, model: verdict.model }
      : verdict.accepted_by === governed.owner.id ? { kind: 'accepted', verdict: given, model: verdict.model, acceptedBy: verdict.accepted_by }
        : null
  if (!verdict) reasons.push('no agent that did not write the change has given a verdict on it')
  else if (!verdictProof) reasons.push(`the verdict is ${verdict.verdict}, below the ${floor} the change needs, and ${governed.owner.login} has not accepted it`)
  const suite = [...rows].reverse().find((r) => stageOf(pipeline, r.stage).kind === 'suite' && r.outcome === 'passes' && r.data.head === head)
  const suiteMain = suite ? SHA.safeParse(suite.data.main) : null
  if (!suite?.ended_at || !suiteMain?.success) reasons.push('the full suite has not passed on this commit')
  const approvedBy = suite?.ended_at ? await ownerApproved('merge', suite.ended_at) : null
  if (!approvedBy) reasons.push(`${governed.owner.login} has not approved the merge since the suite passed`)
  const { m, main } = await mainMirror(governed)
  const pull = await forge.pull(repoPath(governed.repo.remoteUrl), number)
  if (pull.head.sha !== head) reasons.push(`the pull request is at ${short(pull.head.sha)}, and the gates judged ${short(head)}`)
  await mirror(governed.repo.id, governed.repo.remoteUrl, [governed.repo.defaultBranch, pull.head.ref])
  const merges = await mergeTree(m, main, head)
  if (!merges.clean) reasons.push(`the change conflicts with main at ${short(main)} in ${merges.files.join(', ')}`)
  const blocked = nonEmpty(reasons)
  if (blocked) return { kind: 'blocked', reasons: blocked }
  if (!suiteMain?.success || !approvedBy || !verdictProof) throw new Error('readiness found no reason to block and no proof to merge')
  if (suiteMain.data !== main) return { kind: 'stale', suiteMain: suiteMain.data, main }
  return {
    kind: 'ready',
    proof: {
      head, patchId: judged.patchId, mergeTree: 'clean', gates: 'clean', verdict: verdictProof,
      reviews: 'clean', suite: { main: suiteMain.data }, owner: { approvedBy },
    },
  }
}

export async function mergeChange(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], governed: Governed): Promise<{ outcome: 'done' | 'stale' | 'failed'; summary: string; data: Record<string, unknown> }> {
  const repo = repoPath(governed.repo.remoteUrl)
  const opened = [...rows].reverse().find((r) => typeof r.data.pullRequest === 'number')
  const number = opened?.data.pullRequest
  if (typeof number !== 'number') return { outcome: 'failed', summary: 'There is no pull request to merge.', data: {} }
  const judged = verified(pipeline, rows)
  if (!judged) return { outcome: 'failed', summary: 'No commit has passed verify.', data: {} }
  const pull = await forge.pull(repo, number)
  if (pull.merged) return { outcome: 'done', summary: `Pull request #${number} was already merged.`, data: { pullRequest: number, head: judged.head, merged: pull.merge_commit_sha } }
  const ready = await readiness(client, run, pipeline, rows, judged, governed, number)
  if (ready.kind === 'blocked') return { outcome: 'failed', summary: `Not merged, because ${ready.reasons.join('; ')}.`, data: {} }
  if (ready.kind === 'stale') return { outcome: 'stale', summary: `main moved from ${short(ready.suiteMain)} to ${short(ready.main)} since the suite ran, so the merge result is untested.`, data: {} }
  const { proof } = ready
  const forgeLogin = governed.owner.forgeLogin
  if (!forgeLogin) return { outcome: 'failed', summary: `${governed.owner.login} has no forge login, so their approval cannot reach the forge.`, data: {} }
  await forge.approveAs(repo, number, forgeLogin, proof.head, `Approved in Agents by ${governed.owner.login}, with the runner's evidence in the description.`)
  const forced = judged.needsOwner.some((f) => f.gate === 'protected')
  const merged = await forge.mergeAt(repo, number, proof.head, forced ? { login: forgeLogin, force: true } : null)
  if (!merged.merged) return { outcome: 'failed', summary: `Pull request #${number} did not merge.`, data: {} }
  await client.query(`update artifacts set state = 'merged', updated_at = now() where task_id = $1 and url = $2`, [run.task_id, merged.html_url])
  return {
    outcome: 'done', data: { pullRequest: number, head: proof.head, merged: merged.merge_commit_sha, proof },
    summary: `Merged pull request #${number} at ${short(proof.head)}, with ${proof.verdict.kind === 'met' ? `${proof.verdict.level} from ${proof.verdict.model}` : `${proof.verdict.verdict} from ${proof.verdict.model}, which ${governed.owner.login} accepted`} and the suite passed on main at ${short(proof.suite.main)}${forced ? `, as ${governed.owner.login} past the protected file patterns` : ''}.`,
  }
}

const DEPLOY_STATE = z.object({ deploy: z.uuid() })

export async function startDeploy(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], row: Row, governed: Governed | null): Promise<boolean> {
  const fail = async (summary: string) => {
    await setRow(client, row, { status: 'done', outcome: 'failed', summary, started: true, ended: true })
    return true
  }
  if (!governed) return fail('A deploy runs only on a repo with a policy.')
  const merge = [...rows].reverse().find((r) => typeof r.data.merged === 'string')
  const gate = [...rows].reverse().find((r) => roleOf(pipeline, r.stage) === 'deploy' && r.outcome === 'approved')
  const ask = gate?.ask_id ? await maybe<{ answered_by: string | null }>(client, 'select answered_by from asks where id = $1', [gate.ask_id]) : undefined
  if (!gate?.ended_at || ask?.answered_by !== governed.owner.id) return fail(`${governed.owner.login} has not approved this deploy.`)
  if (merge?.ended_at && gate.ended_at.getTime() < merge.ended_at.getTime()) return fail('The deploy was approved before the merge it would release.')
  const commit = typeof merge?.data.merged === 'string' ? merge.data.merged : (await mainMirror(governed)).main
  const previous = await maybe<{ commit: string }>(client,
    `select commit from deploys where repo_id = $1 and status = 'healthy' order by ended_at desc limit 1`, [governed.repo.id])
  const deploy = await one<{ id: string }>(client, 'the new deploy',
    `insert into deploys (team_id, repo_id, run_id, commit, previous_commit, approved_by) values ($1, $2, $3, $4, $5, $6) returning id`,
    [run.team_id, governed.repo.id, run.id, commit, previous?.commit ?? null, governed.owner.id])
  await setRow(client, row, { status: 'running', data: { deploy: deploy.id }, started: true })
  return true
}

// Fails a deploy no deployer started within the wait limit, or one a deployer
// started and did not finish within the run limit, so a run never waits on a
// deployer that is not running or that stopped partway.
export async function expireDeploy(client: pg.ClientBase, deploy: string) {
  await client.query(
    `update deploys set status = 'failed', ended_at = now(), note = case when status = 'requested' then $2 else $3 end
     where id = $1 and ((status = 'requested' and created_at < now() - make_interval(mins => $4))
       or (status = any($5) and started_at < now() - make_interval(mins => $6)))`,
    [deploy, `No deployer started it within ${DEPLOY_WAIT_LIMIT_MIN} minutes, so it never went out. Approve a new deploy.`,
      `A deployer started it and did not finish within ${DEPLOY_RUN_LIMIT_MIN} minutes. A person must check which release the server runs.`,
      DEPLOY_WAIT_LIMIT_MIN, [...DEPLOY_WORKING], DEPLOY_RUN_LIMIT_MIN])
}

export async function pollDeploy(client: pg.PoolClient, row: Row): Promise<boolean> {
  const { deploy } = DEPLOY_STATE.parse(row.data)
  await expireDeploy(client, deploy)
  const found = await one<{ status: string; commit: string; note: string | null; log: string }>(client, `deploy ${deploy}`,
    'select status, commit, note, log from deploys where id = $1', [deploy])
  const status = DEPLOY_DONE.find((s) => s === found.status)
  if (!status) return false
  const outcome = status === 'healthy' ? 'done' : status
  const summary = `${status === 'healthy' ? `Released ${short(found.commit)}, and it answered its health check.` : found.note ?? status}\n\n${tail(found.log.trim(), OUTPUT_TAIL)}`
  await setRow(client, row, { status: 'done', outcome, summary, ended: true })
  return true
}

// An agent with no tool call or finished turn for the policy's liveness window
// is stuck. It is replaced by a fresh session rather than resumed, up to the
// policy's limit, then the stage fails and a person decides.
export async function stuck(client: pg.PoolClient, run: Run, rows: Row[], row: Row, sessions: SessionId[]): Promise<boolean> {
  const governed = await policyOf(client, run)
  if (!governed || !row.started_at || !sessions.length) return false
  const { minutes, replacements } = governed.policy.liveness
  const last = await one<{ at: Date | null }>(client, 'the stage\'s latest activity',
    `select max(created_at) as at from events where session_id = any($1) and kind in ('user', 'tool_call', 'tool_result', 'usage')`, [sessions])
  const since = Math.max(row.started_at.getTime(), last.at?.getTime() ?? 0)
  if (Date.now() - since < minutes * 60_000) return false
  for (const sessionId of sessions) await signalSession(client, sessionId, 'stop')
  const replaced = rows.filter((r) => r.stage === row.stage && r.data.replaced === true).length
  if (replaced >= replacements) {
    await setRow(client, row, { status: 'failed', summary: `No tool call or finished turn for ${minutes} minutes, after ${replaced} fresh sessions.`, ended: true })
    return true
  }
  await setRow(client, row, { status: 'cancelled', summary: `No tool call or finished turn for ${minutes} minutes, so a fresh session replaces this one.`, data: { ...row.data, replaced: true }, ended: true })
  await addRow(client, run, { stage: row.stage, kind: row.kind, attempt: row.attempt, data: { fresh: true } })
  return true
}

// A command, or a turn waiting for a box, left with a machine that stopped
// reporting can never finish. On a repo with a policy the stage fails at once and
// the run waits on a person, so a stall never shows as work in progress. A message
// ends through the one writer of messages, with its turn, and a waiting turn is
// cancelled, so nothing is sent to the machine when it comes back.
export async function lostMachine(client: pg.PoolClient, run: Run, row: Row, sessions: SessionId[]): Promise<boolean> {
  if (!(await policyOf(client, run))) return false
  const held = await maybe<{ what: 'command' | 'turn'; id: string; kind: string | null; held_status: string; name: string; status: string; last_seen_at: Date | null; since: Date }>(client,
    `select h.what, h.id, h.kind, h.status as held_status, i.name, i.status, i.last_seen_at, h.since
     from (
       select 'command' as what, c.id, c.kind, c.status, c.instance_id, c.created_at as since from commands c
       where (c.id = $1 or c.session_id = any($2)) and c.status in ('queued', 'claimed')
       union all
       select 'turn', t.id, null::text, t.status, t.instance_id, t.requested_at from turns t
       where t.session_id = any($2) and t.status = 'waiting'
     ) h join instances i on i.id = h.instance_id
     order by h.since limit 1`, [row.command_id, sessions])
  if (!held || Date.now() - held.since.getTime() < SILENT_MACHINE_MS) return false
  const seen = held.last_seen_at
  const silent = held.status === 'offline' || seen === null || Date.now() - seen.getTime() > SILENT_MACHINE_MS
  if (!silent) return false
  const when = seen ? `has not reported since ${seen.toISOString()}` : 'has never reported'
  const error = `${held.name} ${when}`
  if (held.what === 'turn') {
    for (const sessionId of sessions) await cancelWaitingTurns(client, sessionId)
  } else if (held.kind === 'message') {
    if (held.held_status === 'claimed') await moveMessages(client, [held.id], 'failed', { error })
    else await failUntakenMessage(client, held.id, error)
  } else {
    await client.query(`update commands set status = 'failed', error = $2, done_at = now() where id = $1 and status in ('queued', 'claimed') and kind <> 'message'`,
      [held.id, error])
  }
  await setRow(client, row, { status: 'failed', summary: `${held.name} ${when}, so what it holds for ${row.stage} cannot finish. Bring the machine back and let the stage try again, or stop the run.`, ended: true })
  return true
}

// What the pipeline sent back before the change passed: each failed verify,
// each review or verdict that asked for a fix, and each failed suite.
function sentBack(rows: Row[]): string[] {
  return rows.filter((r) => r.status === 'done' && (
    ((r.kind === 'verify' || r.kind === 'suite') && r.outcome === 'fails') || ((r.kind === 'review' || r.kind === 'confirm') && r.outcome === 'fix')))
    .map((r) => {
      const lines = (r.summary ?? '').split('\n')
      const points = lines.filter((l) => l.startsWith('- ')).slice(0, SENT_BACK_POINTS)
      return [`- ${r.stage}, try ${r.attempt}: ${lines[0] ?? ''}`, ...points.map((p) => `  ${p}`)].join('\n')
    })
}

// The pull request's description, for a reviewer who was not there: the
// agent's summary, what changed, what the runner checked and saw, the risks
// the understanding named, what the pipeline had to send back, the verdict,
// the findings, and what people and agents decided.
export async function pullRequestBody(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], push: unknown, agentText: string): Promise<string> {
  const governed = await governedRun(client, run)
  const judged = verified(pipeline, rows)
  const head = PUSHED.parse(push).pushed.find((p) => p.repoId === governed.repo.id)?.commit
  if (!judged || head !== judged.head) {
    throw new Error(`the branch moved after the gates judged it: verify saw ${short(judged?.head ?? 'nothing')}, the pull request would be ${short(head ?? 'nothing')}`)
  }
  const { m } = await mainMirror(governed)
  const files = await changes(m, judged.base, head)
  const understanding = await maybe<{ content: string }>(client,
    `select v.content from artifacts a join artifact_versions v on v.artifact_id = a.id and v.version = a.current_version
     where a.task_id = $1 and a.kind = 'document' and a.path = 'understanding.md'`, [run.task_id])
  const risks = understanding ? sectionOf(understanding.content, 'What could break') : null
  const fixes = sentBack(rows)
  const evidence = await many<{ gate: string; status: string; summary: string; detail: { findings?: Finding[] } }>(client,
    `select distinct on (gate) gate, status, summary, detail from evidence where run_id = $1 and commit = $2 order by gate, created_at desc`, [run.id, head])
  const policy = await one<{ name: string; version: number }>(client, 'the policy', 'select name, version from policies where id = $1', [governed.policyId])
  const findings = await many<{ round: number; model: string; rule: string; path: string | null; line: number | null; body: string; blocking: boolean; status: string; login: string | null }>(client,
    `select f.round, f.model, f.rule, f.path, f.line, f.body, f.blocking, f.status, p.login from findings f left join people p on p.id = f.decided_by
     where f.run_id = $1 order by f.round, f.created_at`, [run.id])
  const verdicts = await many<{ verdict: string; model: string; summary: string; patch_id: string }>(client,
    'select verdict, model, summary, patch_id from verdicts where run_id = $1 and voided_at is null order by created_at', [run.id])
  const decisions = await many<{ stage: string | null; who: string; what: string; why: string }>(client,
    'select stage, who, what, why from decisions where task_id = $1 order by created_at', [run.task_id])
  // What agents and people wrote, scrubbed, in a fence the text cannot end.
  const quoted = (text: string) => fenced(scrub(text), 'text')
  const owned = evidence.filter((e) => e.status === 'needs_owner')
  const added = files.reduce((n, f) => n + f.added, 0)
  const deleted = files.reduce((n, f) => n + f.deleted, 0)
  return [
    '## The author\'s summary',
    'The agent that wrote the change wrote this. The runner wrote the rest, and fences what agents and people wrote: the risks, what was sent back, the verdict, the review findings and the decisions.',
    fenced(scrub(agentText.trim()) || '(none)', 'text'),
    '## What changed',
    `${files.length} files, ${added} lines added and ${deleted} removed, from main at ${short(judged.base)} to ${short(head)}:`,
    quoted(files.map((f) => `- ${f.path} ${f.status}${f.from ? ` from ${f.from}` : ''}, ${f.binary ? 'binary' : `+${f.added} -${f.deleted}`}`).join('\n')),
    '## What was checked',
    `The runner collected all of this under the policy ${policy.name} version ${policy.version}, on patch-id ${short(judged.patchId)}, with its build ${BUILD.commit ? short(BUILD.commit) : 'with no commit'} (source ${short(BUILD.files)}). It ran every gate itself, but the review and the verdict pass on the judges' reports, which are advisory until the judges run on their own machine.`,
    '| Gate | Result | What the runner saw |\n|---|---|---|\n'
      + evidence.map((e) => `| ${tableCell(e.gate)} | ${e.status}${ADVISORY(e.gate) ? ' (advisory)' : ''} | ${tableCell(e.summary)} |`).join('\n'),
    '## Risks',
    risks === null ? 'The run left no understanding.md with a "What could break" section, so nobody named the risks before the code was written.' : quoted(risks),
    '## What the pipeline had to fix',
    fixes.length ? quoted(fixes.join('\n')) : 'Nothing. Every gate, the review and the verdict passed the first time.',
    ...(owned.length ? ['## Needs the owner', ...owned.flatMap((e) => (e.detail.findings ?? []).map((f) => `### ${f.path ?? e.gate}\n\n${fenced(f.text, 'diff')}`))] : []),
    ...(verdicts.length ? ['## Verdict', 'Advisory until the judges run on their own machine. The verifier wrote each summary.', quoted(verdicts.map((v) => `- ${v.verdict} by ${v.model}. ${v.summary}`).join('\n'))] : []),
    ...(findings.length ? ['## Review findings', 'Advisory until the judges run on their own machine. The reviewers wrote each finding.', quoted(findings.map((f) => `- Round ${f.round}, ${f.model}, ${f.blocking ? 'blocking' : 'note'}, ${f.status}${f.login ? ` by ${f.login}` : ''}: ${f.path ?? ''}${f.line ? `:${f.line}` : ''} breaks "${f.rule}". ${f.body}`).join('\n'))] : []),
    ...(decisions.length ? ['## Decisions', 'Each in the words of the person or agent who made it.', quoted(decisions.map((d) => `- ${d.who === 'person' ? 'A person' : 'An agent'} at ${d.stage ?? 'the task'}: ${d.what}. ${d.why}`).join('\n'))] : []),
  ].join('\n\n')
}

export type { FileChange }
