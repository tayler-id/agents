// Refinement. A change reaches the shepherd only after replays show it helps.
// Improve's change to a pipeline is scored on past runs of that pipeline,
// replayed with the change and with the current version at the commits they
// started from. Coach's change to an agent is scored on the turns behind it, and a
// few unrelated ones, replayed with and without it, and judged without knowing
// which is which. The runner calls these from its actions. The design of coach's
// is docs/design/evidence.md.

import { randomBytes, randomInt } from 'node:crypto'
import { basename } from 'node:path'
import type pg from 'pg'
import { z } from 'zod'
import { many, maybe, one } from './db.ts'
import { diffText } from './diff.ts'
import { forge, repoPath } from './forge.ts'
import { recordVersion } from './pipelines.ts'
import { agentKit, appendEvents } from './record.ts'
import { memoryBlock } from './agents.ts'
import { nameIn, pickSessions, recordFindings, recordStudyFindings, sentence } from './evidence.ts'
import { editInstructions, insertHunks, planPipelineHunks, proposeHunks, settleHunks, writePrompt } from './hunks.ts'
import { FindingId, JudgeReport, Picked, RuleHash, type RunScore, type SessionScore, type Verdict } from '../shared/evidence.ts'
import { AgentId, PipelineId, ProposalId, type RunId, type TeamId } from '../shared/ids.ts'
import type { Pipeline, Report, Stage } from '../shared/pipeline.ts'
import type { AgentSkill, MessagePayload } from '../shared/types.ts'

const REPLAYS = Number(process.env.AGENTS_REPLAYS ?? 3)

type Repo = { repoId: string; remote_url: string; default_branch: string }

// The one pipeline file a branch changed, as a candidate version of that
// pipeline. Recorded without becoming current.
export async function candidateFrom(client: pg.PoolClient, teamId: string, repo: Repo, branch: string) {
  const path = repoPath(repo.remote_url)
  const [before, after] = await Promise.all([forge.files(path, 'pipelines', repo.default_branch), forge.files(path, 'pipelines', branch)])
  const shas = new Map(before.map((f) => [f.path, f.sha]))
  const changed = after.filter((f) => f.path.endsWith('.ts') && shas.get(f.path) !== f.sha)
  const [file, ...more] = changed
  if (!file || more.length) throw new Error(`the change must touch exactly one pipeline file, and it touched ${changed.length}`)
  const name = basename(file.path, '.ts')
  const pipeline = await maybe<{ id: string; current_version_id: string | null; source: string | null }>(client,
    `select p.id, p.current_version_id, v.source from pipelines p left join pipeline_versions v on v.id = p.current_version_id
     where p.team_id = $1 and p.name = $2`, [teamId, name])
  if (!pipeline?.current_version_id) throw new Error(`there is no current version of ${name} to compare with`)
  const { versionId, error } = await recordVersion(teamId, repo.repoId, name, file.path, file.content, false)
  if (error) throw new Error(`the changed ${file.path} does not load: ${error}`)
  const source = pipeline.source ?? ''
  return { pipelineId: PipelineId.parse(pipeline.id), name, baseVersionId: pipeline.current_version_id, candidateVersionId: versionId,
    path: file.path, before: source, after: file.content, diff: diffText(source, file.content, file.path) }
}

// Improve's change as a proposal waiting to be scored, its hunks citing the
// findings the run's record stage kept. Returns why it is refused instead.
export async function proposePipelineChange(client: pg.PoolClient, run: { id: RunId; teamId: TeamId }, rows: StageRow[], pipeline: Pipeline,
  candidate: Awaited<ReturnType<typeof candidateFrom>>, summary: string): Promise<{ refused: string } | { proposal: ProposalId }> {
  const recorded = lastAction(rows, pipeline, 'record_findings')
  const findings = recorded ? Recorded.parse(recorded.data).kept : []
  const planned = await planPipelineHunks(client, { pipelineId: candidate.pipelineId, before: candidate.before, after: candidate.after, path: candidate.path, findings })
  if ('refused' in planned) return planned
  const proposal = ProposalId.parse((await one<{ id: string }>(client, 'the new proposal',
    `insert into proposals (team_id, target, pipeline_id, base_version_id, candidate_version_id, diff, summary, status, run_id)
     values ($1, 'pipeline', $2, $3, $4, $5, $6, 'scoring', $7) returning id`,
    [run.teamId, candidate.pipelineId, candidate.baseVersionId, candidate.candidateVersionId, candidate.diff, summary, run.id])).id)
  await insertHunks(client, run.teamId, proposal, planned.hunks)
  return { proposal }
}

// Starts replays of the pipeline's latest finished runs, each once with the
// candidate and once with the current version. Returns how many runs it replays.
export async function startReplays(client: pg.PoolClient, teamId: string, proposalId: string, pipelineId: string, versions: string[]): Promise<number> {
  const { rows: cases } = await client.query<{ id: string; task_id: string; trigger_payload: { report: unknown; repoId: string } }>(
    `select r.id, r.task_id, r.trigger_payload from runs r join pipeline_versions v on v.id = r.pipeline_version_id
     where r.team_id = $1 and v.pipeline_id = $2 and r.replay_of is null and r.status in ('done', 'failed')
       and exists (select 1 from workspaces w join worktrees t on t.workspace_id = w.id where w.task_id = r.task_id and t.base_commit is not null)
     order by r.created_at desc limit $3`, [teamId, pipelineId, REPLAYS])
  for (const past of cases) {
    const { rows: commits } = await client.query<{ repo_id: string; base_commit: string }>(
      `select t.repo_id, t.base_commit from worktrees t join workspaces w on w.id = t.workspace_id
       where w.task_id = $1 order by w.created_at limit 10`, [past.task_id])
    const original = await one<{ title: string; instructions: string; agent_id: string | null; conversation_id: string | null }>(client, 'the replayed task',
      'select title, instructions, agent_id, conversation_id from tasks where id = $1', [past.task_id])
    for (const versionId of versions) {
      const task = await one<{ id: string }>(client, 'the replay task',
        `insert into tasks (team_id, slug, title, instructions, agent_id, source)
         values ($1, 'replay-' || substr(md5(random()::text), 1, 8), $2, $3, $4, 'replay') returning id`,
        [teamId, original.title, original.instructions, original.agent_id])
      for (const { repo_id } of commits) {
        await client.query('insert into task_repos (task_id, repo_id, is_primary) values ($1, $2, $3) on conflict do nothing',
          [task.id, repo_id, repo_id === past.trigger_payload.repoId])
      }
      await client.query(
        `insert into runs (team_id, pipeline_version_id, task_id, trigger, trigger_payload, replay_of, proposal_id)
         values ($1, $2, $3, 'replay', $4, $5, $6)`,
        [teamId, versionId, task.id, JSON.stringify({ ...past.trigger_payload, openIssues: [], commits: Object.fromEntries(commits.map((c) => [c.repo_id, c.base_commit])) }),
          past.id, proposalId])
    }
  }
  return cases.length
}

// How each version did across its replays, once every replay has finished.
export async function scoreReplays(client: pg.PoolClient, proposalId: string, candidate: string, base: string) {
  const { rows } = await client.query<{ pipeline_version_id: string; status: string; metrics: { handoffs?: number; stagesRun?: number; durationSec?: number }; cost_usd: string | null; reminders: number }>(
    `select r.pipeline_version_id, r.status, r.metrics, r.cost_usd,
       (select count(*)::int from events e join run_stages s on s.session_id = e.session_id
        where s.run_id = r.id and e.kind = 'user' and e.text like 'You ended your turn without calling report_result%') as reminders
     from runs r where r.proposal_id = $1`, [proposalId])
  if (rows.some((r) => ['queued', 'running', 'waiting'].includes(r.status))) return null
  const score = (versionId: string): RunScore => {
    const own = rows.filter((r) => r.pipeline_version_id === versionId)
    return {
      replays: own.length,
      finished: own.filter((r) => r.status === 'done').length,
      problems: own.reduce((n, r) => n + (r.metrics.handoffs ?? 0) + r.reminders, 0),
      stagesRun: own.reduce((n, r) => n + (r.metrics.stagesRun ?? 0), 0),
      costUsd: Number(own.reduce((n, r) => n + Number(r.cost_usd ?? 0), 0).toFixed(4)),
      durationSec: own.reduce((n, r) => n + (r.metrics.durationSec ?? 0), 0),
    }
  }
  const [cand, current] = [score(candidate), score(base)]
  // Compared in order: more replays finished, then fewer reminders and hand-offs,
  // then fewer stages run, then at least a tenth less spent. The first difference decides.
  const verdict = cand.finished !== current.finished ? cand.finished > current.finished
    : cand.problems !== current.problems ? cand.problems < current.problems
      : cand.stagesRun !== current.stagesRun ? cand.stagesRun < current.stagesRun
        : cand.costUsd < current.costUsd * 0.9
  const line = (s: RunScore) => `${s.finished} of ${s.replays} finished, ${s.problems} reminders or hand-offs, ${s.stagesRun} stages run, $${s.costUsd.toFixed(2)}`
  const summary = `Replayed ${cand.replays} past runs with each version. With the change: ${line(cand)}. With the current version: ${line(current)}. `
    + (verdict ? 'The change scored better.' : 'The change did not score better.')
  return { better: verdict, scores: { candidate: cand, current }, summary }
}

// Coach's actions. Each reads what earlier stages left in their rows.

export type StageRow = { stage: string; kind: string; status: string; summary: string | null; data: Record<string, unknown> }
export type ActionResult = { outcome: string; summary: string; data?: Record<string, unknown> }

const PickData = z.object({ agentId: AgentId, agentName: z.string(), picked: z.array(Picked), prompt: z.string() })
const ProposalData = z.object({ proposal: ProposalId })
const Recorded = z.object({ kept: z.array(FindingId) })

// The latest row of a stage that finished, picked by what the stage is.
function latest(rows: StageRow[], pipeline: Pipeline, is: (stage: Stage) => boolean): StageRow | undefined {
  return [...rows].reverse().find((r) => {
    const stage = pipeline.stages[r.stage]
    return r.status === 'done' && r.kind !== 'handoff' && stage !== undefined && is(stage)
  })
}
const lastAgent = (rows: StageRow[], pipeline: Pipeline) => latest(rows, pipeline, (s) => s.kind === 'agent')
const lastAction = (rows: StageRow[], pipeline: Pipeline, action: string) => latest(rows, pipeline, (s) => s.kind === 'action' && s.action === action)

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`this run has no ${what} to go on`)
  return value
}

// The agent named in the report, and its sessions with events nobody has read.
async function pick(client: pg.PoolClient, teamId: TeamId, report: Report): Promise<ActionResult> {
  const agents = await many<{ id: string; name: string }>(client, 'select id, name from agents where team_id = $1 and archived_at is null', [teamId])
  const name = nameIn(report, agents.map((a) => a.name), 'agent')
  const agentId = AgentId.parse(must(agents.find((a) => a.name === name), `agent ${name}`).id)
  const { picked, prompt } = await pickSessions(client, teamId, agentId)
  const data = { agentId, agentName: name, picked, prompt }
  if (!picked.length) return { outcome: 'none', summary: `${name} has no sessions with anything new to read.`, data }
  const counts = (source: string) => picked.filter((p) => p.source === source).length
  return {
    outcome: 'picked', data,
    summary: `Picked ${picked.length} session${picked.length === 1 ? '' : 's'} of ${name} to read: ${counts('person')} people's, ${counts('pipeline')} pipeline, ${counts('box')} box.`,
  }
}

// Coach: the reader's findings about the agent picked. Improve: the study's
// findings about the pipeline named in the report.
async function record(client: pg.PoolClient, teamId: TeamId, runId: RunId, report: Report, rows: StageRow[], pipeline: Pipeline): Promise<ActionResult> {
  const reader = must(lastAgent(rows, pipeline), 'report of findings')
  const picked = lastAction(rows, pipeline, 'pick_sessions')
  if (picked) {
    const { agentId, picked: sessions } = PickData.parse(picked.data)
    const recorded = await recordFindings(client, { teamId, runId, agentId, picked: sessions, report: reader.data })
    return {
      outcome: recorded.ready ? 'ready' : 'waiting', summary: recorded.summary,
      data: { agentId, kept: recorded.kept, dropped: recorded.dropped.length, prompt: recorded.ready ? await writePrompt(client, agentId) : '' },
    }
  }
  const pipelines = await many<{ id: string; name: string }>(client, 'select id, name from pipelines where team_id = $1', [teamId])
  const name = nameIn(report, pipelines.map((p) => p.name), 'pipeline')
  const pipelineId = PipelineId.parse(must(pipelines.find((p) => p.name === name), `pipeline ${name}`).id)
  const recorded = await recordStudyFindings(client, { teamId, runId, pipelineId, report: reader.data })
  return { outcome: recorded.ready ? 'ready' : 'waiting', summary: recorded.summary, data: { pipelineId, kept: recorded.kept } }
}

async function propose(client: pg.PoolClient, teamId: TeamId, runId: RunId, rows: StageRow[], pipeline: Pipeline): Promise<ActionResult> {
  const { agentId } = PickData.parse(must(lastAction(rows, pipeline, 'pick_sessions'), 'picked agent').data)
  const writer = must(lastAgent(rows, pipeline), 'report of hunks')
  const proposed = await proposeHunks(client, { teamId, runId, agentId, report: writer.data, summary: writer.summary ?? '' })
  return { outcome: proposed.proposalId ? 'proposed' : 'refused', summary: proposed.summary, data: { proposal: proposed.proposalId } }
}

// What the latest proposal stage left: the proposal this run is scoring.
export const proposalOf = (rows: StageRow[], pipeline: Pipeline) =>
  ProposalData.parse(must(lastAction(rows, pipeline, 'propose_hunks'), 'proposal').data).proposal

// Runs one of coach's actions that finishes at once. replay_sessions runs for a
// while, so the runner starts and polls it with startSessionReplays and
// advanceSessionReplays.
export async function learn(client: pg.PoolClient, action: 'pick_sessions' | 'record_findings' | 'propose_hunks' | 'decide_replays' | 'settle_hunks',
  run: { id: RunId; teamId: TeamId; report: Report }, rows: StageRow[], pipeline: Pipeline): Promise<ActionResult> {
  switch (action) {
    case 'pick_sessions': return pick(client, run.teamId, run.report)
    case 'record_findings': return record(client, run.teamId, run.id, run.report, rows, pipeline)
    case 'propose_hunks': return propose(client, run.teamId, run.id, rows, pipeline)
    case 'decide_replays': {
      const judge = must(lastAgent(rows, pipeline), 'verdicts')
      const decided = await decideReplays(client, proposalOf(rows, pipeline), judge.data)
      return { outcome: decided.better ? 'better' : 'not_better', summary: decided.summary, data: { scores: decided.scores } }
    }
    case 'settle_hunks': {
      const settled = await settleHunks(client, run.id)
      return { outcome: settled.applied ? 'applied' : 'declined', summary: settled.summary }
    }
  }
}

// Coach's replays. A case is one turn of a session: one behind the change,
// replayed up to the turn before the correction, or an unrelated one. Each runs
// twice, with the current setup and with the change, under a shuffled label.

// The most cases behind a change, and unrelated ones, replayed for one proposal.
const BEHIND_CASES = 4
const UNRELATED_CASES = 2
// What one replayed turn may spend and take. It answers one message.
const REPLAY_BUDGET_USD = 0.5
const REPLAY_MINUTES = 15
// Steps of the conversation shown before the message a replay answers.
const HISTORY_STEPS = 40

type Variant = { instructions: string; skills: AgentSkill[]; profiles: Map<string, string> }
type Case = { kind: 'behind'; findingId: string; sessionId: string; upto: number } | { kind: 'unrelated'; sessionId: string; upto: number }

// The conversation before a step, and the step itself as the message to answer.
async function replayPrompt(client: pg.PoolClient, sessionId: string, upto: number): Promise<{ text: string; people: string[] }> {
  const steps = await many<{ seq: number; kind: string; author: string | null; login: string | null; text: string | null }>(client,
    `select e.seq::int, e.kind, e.author, p.login, e.text from events e left join people p on p.id = e.author
     where e.session_id = $1 and e.seq <= $2 and (e.kind = 'user' or (e.kind = 'assistant' and e.parent_tool_use_id is null))
       and coalesce(e.text, '') <> '' order by e.seq`, [sessionId, upto])
  const said = (s: (typeof steps)[number]) => `${s.kind === 'assistant' ? 'you' : s.login ?? 'prompt'}: ${(s.text ?? '').trim()}`
  const last = steps.at(-1)
  if (last?.seq !== upto) throw new Error(`session ${sessionId} has no message at step ${upto} to replay`)
  const before = steps.slice(0, -1).slice(-HISTORY_STEPS)
  return {
    people: [...new Set(steps.flatMap((s) => (s.author ? [s.author] : [])))],
    text: [
      'You are picking up a conversation where it was.',
      ...(before.length ? ['Here is what was said before, oldest first:', '', ...before.map(said), ''] : []),
      'Reply to this last message as you would have:', '', said(last),
    ].join('\n'),
  }
}

// Starts the proposal's replays on the agent's home machine. Returns how many it
// started. None when the change writes no text, since a check changes nothing a
// replay could show.
export async function startSessionReplays(client: pg.PoolClient, teamId: TeamId, proposalId: ProposalId): Promise<number> {
  const proposal = await one<{ agent_id: string }>(client, `proposal ${proposalId}`, 'select agent_id from proposals where id = $1', [proposalId])
  const agentId = AgentId.parse(proposal.agent_id)
  const agent = await one<{ home_instance_id: string | null; harness: 'claude' | 'codex'; model: string | null; instructions: string }>(client, `agent ${agentId}`,
    'select home_instance_id, harness, model, instructions from agents where id = $1', [agentId])
  if (!agent.home_instance_id) throw new Error('the agent has no home machine to replay on')
  const hunks = await many<{ target: string; op: string; rule_hash: string | null; skill_name: string | null; skill_description: string | null
    person_id: string | null; after: string; finding_ids: string[] }>(client,
    `select target, op, rule_hash, skill_name, skill_description, person_id, after, finding_ids from proposal_hunks
     where proposal_id = $1 and target in ('instructions', 'skill', 'profile') order by n`, [proposalId])
  if (!hunks.length) return 0

  const edits = hunks.filter((h) => h.target === 'instructions').map((h) => {
    const rule = h.rule_hash === null ? null : RuleHash.parse(h.rule_hash)
    if (h.op === 'add') return { op: 'add' as const, after: rule, text: h.after }
    if (!rule) throw new Error(`a ${h.op} hunk names no rule`)
    return h.op === 'change' ? { op: 'change' as const, rule, text: h.after } : { op: 'delete' as const, rule }
  })
  const profiles = new Map<string, string>()
  for (const h of hunks.filter((x) => x.target === 'profile' && x.person_id)) {
    const personId = must(h.person_id ?? undefined, 'person')
    const stored = await maybe<{ content: string }>(client,
      `select content from memories where agent_id = $1 and scope = 'person' and person_id = $2 and kind = 'profile'`, [agentId, personId])
    const old = profiles.get(personId) ?? stored?.content ?? ''
    profiles.set(personId, old ? `${old}\n${h.after}` : h.after)
  }
  const change = (skills: AgentSkill[]): Variant => {
    const changed = new Map(skills.map((s) => [s.name, s]))
    for (const h of hunks.filter((x) => x.target === 'skill')) {
      const name = must(h.skill_name ?? undefined, 'skill name')
      changed.set(name, { name, description: h.skill_description ?? '', content: h.after })
    }
    return { instructions: editInstructions(agent.instructions, edits), skills: [...changed.values()], profiles }
  }

  // Cases behind the change: the turn before each finding the text hunks cite.
  const cases: Case[] = []
  for (const findingId of [...new Set(hunks.flatMap((h) => h.finding_ids))]) {
    if (cases.length >= BEHIND_CASES) break
    const finding = await one<{ session_id: string; seq: number }>(client, `finding ${findingId}`,
      'select session_id, seq::int from session_findings where id = $1', [findingId])
    const turn = await maybe<{ seq: number }>(client,
      `select seq::int from events where session_id = $1 and seq < $2 and kind = 'user' and coalesce(text, '') <> '' order by seq desc limit 1`,
      [finding.session_id, finding.seq])
    if (!turn || cases.some((c) => c.sessionId === finding.session_id && c.upto === turn.seq)) continue
    cases.push({ kind: 'behind', findingId, sessionId: finding.session_id, upto: turn.seq })
  }
  // Unrelated cases: recent sessions of people with the agent, at the last
  // message a person sent that the agent answered.
  const unrelated = await many<{ id: string; upto: number | null }>(client,
    `select s.id, (select max(u.seq)::int from events u where u.session_id = s.id and u.kind = 'user' and u.author is not null
        and exists (select 1 from events a where a.session_id = s.id and a.kind = 'assistant' and a.parent_tool_use_id is null and a.seq > u.seq)) as upto
     from sessions s left join conversations c on c.id = s.conversation_id left join tasks t on t.id = s.task_id
     where s.agent_id = $1 and s.stage is null and coalesce(c.visibility, t.visibility) = 'team' and t.source is distinct from 'replay'
       and s.id <> all($2::uuid[]) order by s.last_active_at desc, s.id limit 20`, [agentId, cases.map((c) => c.sessionId)])
  for (const s of unrelated.filter((u) => u.upto !== null).slice(0, UNRELATED_CASES)) {
    cases.push({ kind: 'unrelated', sessionId: s.id, upto: must(s.upto ?? undefined, 'step') })
  }

  // Each case with each version, under labels in a shuffled order.
  const runs = cases.flatMap((c) => (['change', 'current'] as const).map((variant) => ({ c, variant })))
  for (let i = runs.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    const [a, b] = [runs[i], runs[j]]
    if (a && b) [runs[i], runs[j]] = [b, a]
  }
  for (const [n, { c, variant }] of runs.entries()) {
    const { text, people } = await replayPrompt(client, c.sessionId, c.upto)
    const kit = await agentKit(client, agentId, people)
    const skills = must(kit.skills, "the agent's skills")
    const setup = variant === 'current' ? { instructions: agent.instructions, skills, profiles: new Map<string, string>() } : change(skills)
    const memory = setup.profiles.size ? await memoryBlock(client, agentId, people, setup.profiles) : kit.memory
    const task = await one<{ id: string }>(client, 'the replay task',
      `insert into tasks (team_id, slug, title, agent_id, source) values ($1, $2, $3, $4, 'replay') returning id`,
      [teamId, `replay-${randomBytes(4).toString('hex')}`, `Replay of a turn, ${variant === 'change' ? 'with' : 'without'} a proposed change`, agentId])
    const workspace = await one<{ id: string }>(client, 'the replay workspace',
      `insert into workspaces (team_id, task_id, instance_id, path) values ($1, $2, $3, '') returning id`, [teamId, task.id, agent.home_instance_id])
    await client.query(`insert into commands (team_id, instance_id, kind, payload) values ($1, $2, 'setup_workspace', $3)`,
      [teamId, agent.home_instance_id, JSON.stringify({ workspaceId: workspace.id, repos: [] })])
    const session = await one<{ id: string }>(client, 'the replay session',
      `insert into sessions (team_id, task_id, workspace_id, instance_id, agent_id, harness, model)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`, [teamId, task.id, workspace.id, agent.home_instance_id, agentId, agent.harness, agent.model])
    await client.query(
      `insert into session_replays (team_id, proposal_id, kind, variant, source_session_id, upto_seq, finding_id, label, task_id, session_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [teamId, proposalId, c.kind, variant, c.sessionId, c.upto, c.kind === 'behind' ? c.findingId : null, `R${n + 1}`, task.id, session.id])
    const [seq] = await appendEvents(client, session.id, { events: [{ clientId: 'replay', kind: 'user', text, body: { text } }] })
    if (seq === undefined) throw new Error('the replay prompt was not recorded')
    const payload: MessagePayload = {
      text, agentId, harness: agent.harness, model: agent.model, instructions: setup.instructions, harnessSessionId: null,
      workspaceId: workspace.id, skills: setup.skills, plugins: [], memory, maxBudgetUsd: REPLAY_BUDGET_USD,
    }
    await client.query(
      `insert into commands (team_id, instance_id, session_id, kind, payload, event_id)
       select $1, $2, $3, 'message', $4, id from events where session_id = $3 and seq = $5`,
      [teamId, agent.home_instance_id, session.id, JSON.stringify(payload), seq])
  }
  return runs.length
}

const stopSession = (client: pg.PoolClient, sessionId: string, kind: 'stop' | 'interrupt') => client.query(
  `insert into commands (team_id, instance_id, session_id, kind) select team_id, instance_id, id, $2 from sessions where id = $1`, [sessionId, kind])

// Takes each replay's reply once its turn ends, and fails one whose session
// failed or that ran past its time. Returns how many are still running.
export async function advanceSessionReplays(client: pg.PoolClient, proposalId: ProposalId): Promise<number> {
  const running = await many<{ id: string; session_id: string; late: boolean; failed: boolean; ended: boolean; reply: string | null }>(client,
    `select r.id, r.session_id, r.created_at < now() - make_interval(mins => $2) as late,
       s.status = 'failed' or exists (select 1 from commands c where c.session_id = s.id and c.kind = 'message' and c.status = 'failed') as failed,
       exists (select 1 from events e where e.session_id = s.id and e.kind = 'usage') as ended,
       (select body->>'text' from events e where e.session_id = s.id and e.kind = 'assistant' and e.parent_tool_use_id is null
          and coalesce(body->>'text', '') <> '' order by e.seq desc limit 1) as reply
     from session_replays r join sessions s on s.id = r.session_id where r.proposal_id = $1 and r.status = 'running' for update of r`,
    [proposalId, REPLAY_MINUTES])
  let left = running.length
  for (const r of running) {
    const done = r.ended && r.reply !== null
    if (!done && !r.failed && !r.ended && !r.late) continue
    await client.query(`update session_replays set status = $2, reply = $3, replied_at = now() where id = $1`,
      [r.id, done ? 'replied' : 'failed', done ? r.reply : null])
    if (r.late) await stopSession(client, r.session_id, 'interrupt')
    await stopSession(client, r.session_id, 'stop')
    left--
  }
  return left
}

// Stops the replays of a run's proposals, when the run ends before they do.
export async function stopSessionReplays(client: pg.PoolClient, runId: string) {
  const running = await many<{ id: string; session_id: string }>(client,
    `update session_replays set status = 'failed' where status = 'running' and proposal_id in (select id from proposals where run_id = $1)
     returning id, session_id`, [runId])
  for (const r of running) await stopSession(client, r.session_id, 'stop')
}

type ReplayRow = {
  label: string; kind: 'behind' | 'unrelated'; variant: 'change' | 'current'; status: string; reply: string | null
  source_session_id: string; upto: number; message: string | null; quote: string | null; finding_kind: string | null; about: string | null; accepted: string | null
}

const replayRows = (client: pg.PoolClient, proposalId: ProposalId) => many<ReplayRow>(client,
  `select r.label, r.kind, r.variant, r.status, r.reply, r.source_session_id, r.upto_seq::int as upto,
     (select text from events where session_id = r.source_session_id and seq = r.upto_seq) as message,
     f.quote, f.kind as finding_kind, coalesce(f.note, f.rule_text) as about,
     (select body->>'text' from events where session_id = r.source_session_id and seq > r.upto_seq and kind = 'assistant'
        and parent_tool_use_id is null and coalesce(body->>'text', '') <> '' order by seq limit 1) as accepted
   from session_replays r left join session_findings f on f.id = r.finding_id
   where r.proposal_id = $1 order by length(r.label), r.label`, [proposalId])

// What the judge reads: each replayed reply under its label, with what went wrong
// before, or the reply the person accepted, and never which version wrote it.
export async function judgePrompt(client: pg.PoolClient, proposalId: ProposalId): Promise<string> {
  return (await replayRows(client, proposalId)).map((r) => [
    `replay ${r.label} · ${r.kind === 'behind' ? 'a correction' : 'went fine before'}`,
    `The message: ${(r.message ?? '').trim()}`,
    r.kind === 'behind'
      ? `What went wrong before: "${r.quote ?? ''}" (${r.finding_kind ?? 'gap'}: ${r.about ?? ''})`
      : `The reply the person accepted: ${(r.accepted ?? '').trim()}`,
    'The reply:',
    (r.reply ?? '(no reply came)').trim(),
  ].join('\n')).join('\n\n')
}

// Scores both versions from the judge's verdicts, and keeps the proposal for the
// shepherd only when the change wins: fewer turns behind it still need the
// correction, and no more unrelated turns get worse. A replay that never replied
// counts against its version. Every reply must be judged.
export async function decideReplays(client: pg.PoolClient, proposalId: ProposalId, report: unknown) {
  const parsed = JudgeReport.safeParse(report)
  if (!parsed.success) throw new Error(`the judge's report is not a set of verdicts: ${z.prettifyError(parsed.error).split('\n')[0] ?? ''}`)
  const rows = await replayRows(client, proposalId)
  const unjudged: string[] = []
  const verdicts = new Map<string, Verdict>()
  for (const r of rows) {
    const given = parsed.data.verdicts[r.label]
    const fits = r.kind === 'behind' ? given === 'fixed' || given === 'still' : given === 'ok' || given === 'worse'
    if (r.status !== 'replied') verdicts.set(r.label, r.kind === 'behind' ? 'still' : 'worse')
    else if (given && fits) verdicts.set(r.label, given)
    else unjudged.push(r.label)
  }
  for (const [label, verdict] of verdicts) {
    await client.query('update session_replays set verdict = $3 where proposal_id = $1 and label = $2', [proposalId, label, verdict])
  }
  const score = (variant: 'change' | 'current'): SessionScore => {
    const own = rows.filter((r) => r.variant === variant)
    return {
      behind: own.filter((r) => r.kind === 'behind').length, still: own.filter((r) => verdicts.get(r.label) === 'still').length,
      unrelated: own.filter((r) => r.kind === 'unrelated').length, worse: own.filter((r) => verdicts.get(r.label) === 'worse').length,
    }
  }
  const [withChange, current] = [score('change'), score('current')]
  const cases = [...new Map(rows.map((r) => [`${r.source_session_id}:${String(r.upto)}`, r])).values()].map((r) => {
    // A case the judge left out shows as the verdict that counts against it.
    const of = (variant: 'change' | 'current') => verdicts.get(rows.find((x) => x.variant === variant && x.source_session_id === r.source_session_id && x.upto === r.upto)?.label ?? '')
      ?? (r.kind === 'behind' ? 'still' : 'worse')
    return { kind: r.kind, session: r.source_session_id, seq: r.upto, change: of('change'), current: of('current') }
  })
  const better = !unjudged.length && withChange.still < current.still && withChange.worse <= current.worse
  const scores = { change: withChange, current, cases }
  await client.query('update proposals set scores = $2, status = $3 where id = $1', [proposalId, JSON.stringify(scores), better ? 'open' : 'rejected'])
  const line = (s: SessionScore) => `${s.still} of ${s.behind} turns behind it still needed the correction, and ${s.worse} of ${s.unrelated} other turns got worse`
  return {
    better, scores,
    summary: unjudged.length ? sentence(`The judge left ${unjudged.join(', ')} unjudged, so the change was not shown to win`)
      : `With the change, ${line(withChange)}. Without it, ${line(current)}. ${better ? 'The change wins.' : 'The change does not win.'}`,
  }
}
