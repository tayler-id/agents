// Moves pipeline runs forward. A run's whole state is in Postgres: the run, and a
// row in run_stages for each try at a stage. The runner looks at a run's latest
// row and does the next thing: start an agent's turn, run a check, act on the
// forge, open a gate, or follow the stage's outcome to the next stage. Any API
// process may run it. A row lock lets one process at a time advance a run, and a
// notification wakes every runner when something a run waits on changes.

import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { many, maybe, one, pool, tx } from './db.ts'
import { appendEvents, appendMessage, HttpError, type Person } from './record.ts'
import { loadSource, loadVersion, outcomesOf, syncPipelines } from './pipelines.ts'
import { forge, repoPath } from './forge.ts'
import { withFolders } from './checkout.ts'
import { checkAsker, currentDefaultBranch, forgeFor, type RepoOnForge, type TeamRepo } from './repos.ts'
import { placeTask } from './projects.ts'
import { boxLoginProblem, claimBox, releaseBox, startClaimedBoxes, stopIdleBoxes } from './boxes.ts'
import {
  advanceSessionReplays, candidateFrom, judgePrompt, learn, proposalOf, proposePipelineChange, scoreReplays, startReplays, startSessionReplays, stopSessionReplays,
  type ActionResult,
} from './refine.ts'
import { expireTurns } from './rooms.ts'
import { finishPushes } from './pulls.ts'
import { WORKSPACE_PERMISSIONS } from './permissions.ts'
import { markLostMachines } from './durability.ts'
import { sendRoutine } from './routines.ts'
import * as framework from './framework.ts'
import { deliverOutcomes, promiseOutcome } from './obligations.ts'
import { lastFire } from '../shared/cron.ts'
import { messageOf } from '../shared/errors.ts'
import { PLAYBOOK_NAMES, PLAYBOOKS } from '../shared/framework.ts'
import type { AgentStage, Next, Pipeline, Report, RouteStage, RunComment, RunContext, Stage } from '../shared/pipeline.ts'
import type { ExecResult, MessagePayload, Permissions, PushPayload, PushResult, SetupWorkspacePayload, StageSpec } from '../shared/types.ts'
import { ProposalId, RunId, TeamId } from '../shared/ids.ts'

const CHANNEL = 'agents_runner'
const TICK_MS = 2000
const SYNC_MS = 5 * 60_000
const STAGE_TIMEOUT_MS = Number(process.env.AGENTS_STAGE_TIMEOUT_MIN ?? 60) * 60_000
const CHECK_TIMEOUT_SEC = 600
const DEFAULT_MAX_ATTEMPTS = 3
const REPORT_TOOL = 'mcp__stage__report_result'
const ACTIVE = ['queued', 'running', 'waiting']
// What an agent reported in report_result's data, parsed rather than trusted.
const REPORTED_DATA = z.record(z.string(), z.unknown())
// Reviewers' sessions, which a review stage keeps in its row's data.
const REVIEWER_SESSIONS = z.object({ reviewers: z.array(z.object({ sessionId: z.string() })) })

// Something a run may be waiting on changed. Every listening runner wakes up.
export const wakeRunner = () => pool.query(`select pg_notify('${CHANNEL}', '')`).then(() => undefined, () => undefined)

// A replay also carries the commit each repo started from in the run it replays.
// `sender` is who asked for a run on GitHub, checked again before its pull request opens.
type Payload = {
  report: Report; repoId: string; openIssues: { number: number; title: string }[]; once?: string; commits?: Record<string, string>; sender?: string
}
export type Run = {
  id: string; team_id: string; pipeline_version_id: string; task_id: string; status: string; trigger: string
  trigger_payload: Payload; started_at: Date | null; created_at: Date; replay_of: string | null; proposal_id: string | null
  playbook: string | null
}
export type Row = {
  id: string; n: number; stage: string; attempt: number; kind: Stage['kind'] | 'handoff'; status: string
  session_id: string | null; from_seq: string | null; command_id: string | null; ask_id: string | null
  outcome: string | null; summary: string | null; data: Record<string, unknown>; started_at: Date | null; ended_at: Date | null
}
export type Task = { id: string; slug: string; title: string; agent_id: string | null; conversation_id: string | null }
export type Workspace = { id: string; instance_id: string; path: string; status: string }
type RepoRef = RepoOnForge & { repoId: string; name: string; default_branch: string; setup_command: string | null }
// A task's repo as the calls to its forge take it.
const onForge = (repo: RepoRef): TeamRepo => ({ ...repo, id: repo.repoId })
type Command = { status: string; error: string | null; result: unknown }
export type AgentRow = { id: string; name: string; harness: 'claude' | 'codex'; model: string | null; instructions: string }
export type SessionRow = { id: string; harness_session_id: string | null; cost_usd: string | null }

export const tail = (text: string, n: number) => (text.length > n ? `…${text.slice(-n)}` : text)
export const branchOf = (run: Run, task: Task) => `${run.replay_of ? 'replay' : 'task'}/${task.slug}`

// Every session a row drove: its own, and a review's reviewers'.
export function rowSessions(row: Row): string[] {
  const reviewers = REVIEWER_SESSIONS.safeParse(row.data)
  return [...new Set([...(row.session_id ? [row.session_id] : []), ...(reviewers.success ? reviewers.data.reviewers.map((r) => r.sessionId) : [])])]
}

export const agentNamed = (client: pg.PoolClient, teamId: string, name: string) => maybe<AgentRow>(client,
  'select id, name, harness, model, instructions from agents where team_id = $1 and name = $2 and archived_at is null', [teamId, name])

// An agent's session for a stage: the one it had, so it remembers, or a new one.
export async function stageSession(client: pg.PoolClient, run: Run, workspace: Workspace, agent: AgentRow, stage: string, earlier: string | null): Promise<SessionRow> {
  if (earlier) return one<SessionRow>(client, `session ${earlier}`, 'select id, harness_session_id, cost_usd from sessions where id = $1', [earlier])
  return one<SessionRow>(client, 'the new stage session',
    `insert into sessions (team_id, task_id, workspace_id, instance_id, agent_id, stage, harness, model)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, harness_session_id, cost_usd`,
    [run.team_id, run.task_id, workspace.id, workspace.instance_id, agent.id, stage, agent.harness, agent.model])
}

// Records a stage's prompt in the session and sends it to the session's
// machine, with what the session may do without asking. On a repo with a
// policy the agent also gets its principles and the team's lessons. Returns
// the prompt's place in the session.
export async function sendPrompt(client: pg.PoolClient, run: Run, workspace: Workspace, agent: AgentRow, session: SessionRow,
  prompt: { text: string; clientId: string; stage: string }, spec: StageSpec, permissions: Permissions): Promise<number> {
  const { text, clientId } = prompt
  const [seq] = await appendEvents(client, session.id, {
    events: [{ clientId, kind: 'user', text, body: { text, runId: run.id, stage: prompt.stage } }],
  })
  if (seq === undefined) throw new Error(`the prompt ${clientId} was not recorded`)
  const guidance = await framework.guidance(client, run)
  const payload: MessagePayload = {
    permissions, text, agentId: agent.id, harness: agent.harness, model: agent.model,
    instructions: guidance ? `${agent.instructions}\n\n${guidance}` : agent.instructions,
    harnessSessionId: session.harness_session_id, workspaceId: workspace.id, stage: spec, maxBudgetUsd: spec.maxBudgetUsd,
  }
  await client.query(
    `insert into commands (team_id, instance_id, session_id, kind, payload, event_id)
     select $1, $2, $3, 'message', $4, id from events where session_id = $3 and seq = $5`,
    [run.team_id, workspace.instance_id, session.id, JSON.stringify(payload), seq])
  return seq
}

// A stage named by a run's row. Rows only ever name stages of their own
// pipeline version, which never changes, so a missing one is a bug.
export function stageOf(pipeline: Pipeline, name: string): Stage {
  const stage = pipeline.stages[name]
  if (!stage) throw new Error(`the pipeline has no stage named ${name}`)
  return stage
}

// What a machine reported for a check. Stored as JSON, so read it with care.
function execResult(value: unknown): ExecResult {
  const r = (value ?? {}) as Partial<ExecResult>
  return {
    exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
    output: typeof r.output === 'string' ? r.output : '',
    timedOut: r.timedOut === true,
  }
}

// Starts a run of a pipeline's current version. Returns null when the same source
// event already started one.
export async function startRun(client: pg.PoolClient, options: {
  pipelineId: string; trigger: string; report: Report; repoId: string; openIssues?: Payload['openIssues']
  once?: string; startedBy?: string; sender?: string
}): Promise<string | null> {
  const pipeline = await maybe<{ team_id: string; name: string; current_version_id: string; conversation_id: string | null; source: string }>(client,
    `select p.team_id, p.name, p.current_version_id, p.conversation_id, v.source
     from pipelines p join pipeline_versions v on v.id = p.current_version_id where p.id = $1`, [options.pipelineId])
  if (!pipeline) throw new HttpError(409, 'this pipeline has no working version')
  if (options.once && await maybe(client, `select 1 from runs where team_id = $1 and trigger_payload->>'once' = $2`, [pipeline.team_id, options.once])) {
    return null
  }
  const { pipeline: definition, error } = await loadSource(pipeline.source)
  if (!definition) throw new HttpError(409, `the current version of ${pipeline.name} does not load: ${error ?? 'no reason given'}`)
  const agent = await maybe<{ id: string }>(client,
    'select id from agents where team_id = $1 and name = $2 and archived_at is null', [pipeline.team_id, definition.agent])
  if (!agent) throw new HttpError(409, `this team has no agent named ${definition.agent}, which ${pipeline.name} needs`)
  if (!await maybe(client, 'select 1 from repos where id = $1 and team_id = $2', [options.repoId, pipeline.team_id])) {
    throw new HttpError(404, 'no such repo on this team')
  }

  const slug = `${pipeline.name}-${randomBytes(3).toString('hex')}`
  const task = await one<{ id: string }>(client, 'the new task',
    `insert into tasks (team_id, slug, title, instructions, owner_id, agent_id, conversation_id, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [pipeline.team_id, slug, options.report.title, options.report.body, options.startedBy ?? null, agent.id,
      pipeline.conversation_id, options.trigger])
  await client.query('insert into task_repos (task_id, repo_id, is_primary) values ($1, $2, true)', [task.id, options.repoId])
  await placeTask(client, task.id)
  const payload: Payload = { report: options.report, repoId: options.repoId, openIssues: options.openIssues ?? [], once: options.once, sender: options.sender }
  const run = await one<{ id: string }>(client, 'the new run',
    `insert into runs (team_id, pipeline_version_id, task_id, trigger, trigger_payload)
     values ($1, $2, $3, $4, $5) returning id`,
    [pipeline.team_id, pipeline.current_version_id, task.id, options.trigger, JSON.stringify(payload)])
  if (pipeline.conversation_id) {
    await appendMessage(client, pipeline.conversation_id, {
      speaker: 'agent', agentId: agent.id, clientId: `run:${run.id}:start`,
      body: `Started a run on "${options.report.title}"${options.report.issue ? ` (issue #${options.report.issue})` : ''}, from ${options.trigger}.`,
    })
  }
  return run.id
}

// Answers a gate or a hand-off. The runner picks the answer up on its next look.
export async function answerRunAsk(client: pg.PoolClient, askId: string, person: Person, decision: string, message?: string) {
  const ask = await maybe<{ status: string; payload: { options?: string[]; only?: string; onlyLogin?: string } }>(client,
    `select status, payload from asks where id = $1 and run_id is not null and team_id = $2 for update`, [askId, person.team_id])
  if (!ask) throw new HttpError(404, 'no such ask')
  if (ask.status !== 'open') throw new HttpError(409, 'this ask is already answered')
  // A gate that only the repo's owner may pass names them.
  if (ask.payload.only !== undefined && ask.payload.only !== person.id) {
    throw new HttpError(403, `only ${ask.payload.onlyLogin ?? 'the repo\'s owner'} can answer this`)
  }
  const options = ask.payload.options ?? []
  if (!options.includes(decision)) throw new HttpError(400, `decision must be one of ${options.join(', ')}`)
  await client.query(
    `update asks set status = 'answered', answer = $2, answered_by = $3, answered_at = now() where id = $1`,
    [askId, JSON.stringify({ decision, message: message ?? null, login: person.login }), person.id])
}

// A person pauses a run. Its agents stop now, and the runner leaves it alone
// until someone resumes it. An agent's turn the pause cuts short is queued to
// start again in the same session, so the agent keeps what it knew. Commands
// already sent to a machine finish, and their results wait.
export async function pauseRun(client: pg.PoolClient, runId: string, person: Person, note: string | undefined) {
  const run = await maybe<Run>(client, 'select * from runs where id = $1 and team_id = $2 for update', [runId, person.team_id])
  if (!run) throw new HttpError(404, 'no such run')
  if (!ACTIVE.includes(run.status)) throw new HttpError(409, `this run is ${run.status}, so it cannot be paused`)
  await client.query(`update runs set status = 'paused', paused_at = now(), paused_by = $2, pause_note = $3 where id = $1`,
    [runId, person.id, note ?? null])
  const latest = (await rowsOf(client, runId)).at(-1)
  const sessions = latest?.status === 'running' ? rowSessions(latest) : []
  if (latest && sessions.length) {
    for (const sessionId of sessions) await signal(client, run, sessionId, 'stop')
    await setRow(client, latest, { status: 'cancelled', summary: `Cut short when ${person.login} paused the run.`, ended: true })
    await addRow(client, run, { stage: latest.stage, kind: latest.kind, attempt: latest.attempt })
  }
  await post(client, run, `pause:${randomBytes(4).toString('hex')}`, `Paused by ${person.login}${note ? `: ${note}` : '.'}`)
}

export async function resumeRun(client: pg.PoolClient, runId: string, person: Person) {
  const run = await maybe<Run>(client, 'select * from runs where id = $1 and team_id = $2 for update', [runId, person.team_id])
  if (!run) throw new HttpError(404, 'no such run')
  if (run.status !== 'paused') throw new HttpError(409, `this run is ${run.status}, not paused`)
  const latest = (await rowsOf(client, runId)).at(-1)
  const status = !run.started_at ? 'queued' : latest?.status === 'waiting' ? 'waiting' : 'running'
  await client.query('update runs set status = $2, paused_at = null where id = $1', [runId, status])
  await post(client, run, `resume:${randomBytes(4).toString('hex')}`, `Resumed by ${person.login}.`)
}

export async function cancelRun(client: pg.PoolClient, runId: string, person: Person) {
  const run = await maybe<Run>(client, `select * from runs where id = $1 and team_id = $2 for update`, [runId, person.team_id])
  if (!run) throw new HttpError(404, 'no such run')
  if (!ACTIVE.includes(run.status) && run.status !== 'paused') throw new HttpError(409, `this run is already ${run.status}`)
  await client.query(
    `update run_stages set status = 'cancelled', ended_at = now() where run_id = $1 and status in ('pending', 'running', 'waiting')`, [runId])
  await client.query(`update asks set status = 'expired' where run_id = $1 and status = 'open'`, [runId])
  await finishRun(client, run, 'cancelled', `Cancelled by ${person.login}.`)
}

export const rowsOf = (client: pg.PoolClient, runId: string) => many<Row>(client, 'select * from run_stages where run_id = $1 order by n', [runId])

export const taskOf = (client: pg.PoolClient, run: Run) =>
  one<Task>(client, `the task of run ${run.id}`, 'select id, slug, title, agent_id, conversation_id from tasks where id = $1', [run.task_id])

export const workspaceOf = (client: pg.PoolClient, run: Run) => maybe<Workspace>(client,
  'select id, instance_id, path, status from workspaces where task_id = $1 order by created_at desc limit 1', [run.task_id])

export async function reposOf(client: pg.PoolClient, run: Run): Promise<RepoRef[]> {
  const rows = await many<Omit<RepoRef, 'name'>>(client,
    `select r.id as "repoId", r.forge, r.remote_url, r.default_branch, r.setup_command from task_repos tr
     join repos r on r.id = tr.repo_id where tr.task_id = $1 order by tr.is_primary desc, r.remote_url`, [run.task_id])
  return withFolders(rows).map(({ folder, ...r }) => ({ ...r, name: folder }))
}

// The run's primary repo. Every run is started with one.
export async function repoOf(client: pg.PoolClient, run: Run): Promise<RepoRef> {
  const [repo] = await reposOf(client, run)
  if (!repo) throw new Error(`run ${run.id} has no repo`)
  return repo
}

// What a run's sessions have cost, its replays of coach's turns among them.
async function runCost(client: pg.PoolClient, runId: string): Promise<number> {
  const { cost } = await one<{ cost: string }>(client, 'the run cost',
    `select coalesce(sum(cost_usd), 0) as cost from sessions
     where id in (select session_id from run_stages where run_id = $1)
        or id in (select r.session_id from session_replays r join proposals p on p.id = r.proposal_id where p.run_id = $1)`, [runId])
  return Number(cost)
}

export async function addRow(client: pg.PoolClient, run: Run, row: Partial<Row> & { stage: string; kind: Row['kind'] }) {
  await client.query(
    `insert into run_stages (team_id, run_id, n, stage, attempt, kind, status, ask_id, summary, data, outcome)
     values ($1, $2, (select coalesce(max(n), 0) + 1 from run_stages where run_id = $2), $3, $4, $5, $6, $7, $8, $9, $10)`,
    [run.team_id, run.id, row.stage, row.attempt ?? 1, row.kind, row.status ?? 'pending', row.ask_id ?? null,
      row.summary ?? null, JSON.stringify(row.data ?? {}), row.outcome ?? null])
}

// The columns a stage row's update may set. Column names come only from this list.
const ROW_FIELDS = ['status', 'outcome', 'summary', 'data', 'session_id', 'from_seq', 'command_id', 'ask_id'] as const
type RowFields = Partial<Pick<Row, (typeof ROW_FIELDS)[number]>> & { ended?: boolean; started?: boolean }

export async function setRow(client: pg.PoolClient, row: Row, fields: RowFields) {
  const keys = ROW_FIELDS.filter((k) => k in fields)
  const sets = keys.map((k, i) => `${k} = $${i + 2}`)
  if (fields.started) sets.push('started_at = now()')
  if (fields.ended) sets.push('ended_at = now()')
  await client.query(`update run_stages set ${sets.join(', ')} where id = $1`,
    [row.id, ...keys.map((k) => (k === 'data' ? JSON.stringify(fields.data) : fields[k]))])
}

// Posts into the pipeline's room as the pipeline's agent. Each post has a fixed
// client id, so redoing a step never posts twice.
export async function post(client: pg.PoolClient, run: Run, key: string, body: string) {
  if (run.replay_of) return
  const task = await taskOf(client, run)
  if (!task.conversation_id || !task.agent_id) return
  await appendMessage(client, task.conversation_id, { speaker: 'agent', agentId: task.agent_id, body, clientId: `run:${run.id}:${key}` })
}

async function shepherd(client: pg.PoolClient, run: Run): Promise<string> {
  const row = await maybe<{ login: string | null }>(client,
    `select p.login from pipeline_versions v join pipelines pl on pl.id = v.pipeline_id
     left join people p on p.id = pl.shepherd_id where v.id = $1`, [run.pipeline_version_id])
  return row?.login ? `@${row.login} ` : ''
}

export async function context(client: pg.PoolClient, run: Run, rows: Row[], current?: Row): Promise<RunContext> {
  const results: RunContext['results'] = {}
  const attempts: RunContext['attempts'] = {}
  for (const r of rows) {
    if (r.kind === 'handoff' || r.id === current?.id || (r.status !== 'done' && r.status !== 'failed')) continue
    attempts[r.stage] = (attempts[r.stage] ?? 0) + 1
    if (r.status === 'done') results[r.stage] = { outcome: r.outcome ?? '', summary: r.summary ?? '', data: r.data }
  }
  const workspace = await workspaceOf(client, run)
  const [repo] = await reposOf(client, run)
  // A comment keeps no author once its person has left the team.
  const comments = await many<RunComment>(client,
    `select a.path, c.version, c.anchor->>'quote' as quote, c.body as text, coalesce(p.login, 'a former teammate') as by
     from comments c join artifacts a on a.id = c.artifact_id left join people p on p.id = c.author_person
     where a.task_id = $1 and c.status = 'open' order by c.created_at, c.id`, [run.task_id])
  const playbook = PLAYBOOK_NAMES.find((name) => name === run.playbook)
  return {
    report: run.trigger_payload.report,
    openIssues: run.trigger_payload.openIssues,
    results, attempts,
    repo: repo?.name ?? '',
    taskFolder: workspace?.path ? `${workspace.path}/task` : 'task',
    comments,
    replay: Boolean(run.replay_of),
    playbook: playbook ? { name: playbook, guide: PLAYBOOKS[playbook].guide } : null,
  }
}

// The run's first step: a machine, a workspace on it, and the first stage.
async function begin(client: pg.PoolClient, run: Run, pipeline: Pipeline): Promise<boolean> {
  const task = await taskOf(client, run)
  const outsideBox = await framework.sandboxProblem(client, run, pipeline)
  if (outsideBox) {
    await finishRun(client, run, 'failed', outsideBox)
    return true
  }
  const capped = await framework.capsCheck(client, run)
  if (capped && 'wait' in capped) {
    await client.query('update runs set note = $2 where id = $1 and note is distinct from $2', [run.id, capped.wait])
    return false
  }
  if (capped) {
    await framework.announceCap(client, run, capped.stop)
    await finishRun(client, run, 'failed', capped.stop)
    return true
  }
  let instanceId: string | null
  if (pipeline.runsOn === 'box') {
    const problem = boxLoginProblem()
    if (problem) {
      await finishRun(client, run, 'failed', problem)
      return true
    }
    try {
      instanceId = await claimBox(client, run.team_id, run.id)
    } catch (error) {
      await finishRun(client, run, 'failed', `Could not get a box: ${messageOf(error).split('\n')[0] ?? ''}`)
      return true
    }
    if (!instanceId) {
      await client.query(`update runs set note = 'Waiting for a free box.' where id = $1 and note is null`, [run.id])
      return false
    }
  } else {
    const agent = await maybe<{ home_instance_id: string | null }>(client, 'select home_instance_id from agents where id = $1', [task.agent_id])
    instanceId = agent?.home_instance_id ?? null
    if (!instanceId) {
      await finishRun(client, run, 'failed', `The agent ${pipeline.agent} has no home machine.`)
      return true
    }
  }
  // A run from an issue on a repo with a policy promises the reporter its outcome there.
  const governed = await framework.policyOf(client, run)
  const { issue, url } = run.trigger_payload.report
  if (governed && issue !== undefined && !run.replay_of) {
    await promiseOutcome(client, {
      teamId: run.team_id, taskId: run.task_id, runId: run.id, repoId: governed.repo.id, remoteUrl: governed.repo.remoteUrl, issue,
      url: url ?? `${governed.repo.remoteUrl.replace(/\.git$/, '')}/issues/${issue}`, minutes: governed.policy.maxRunMinutes,
    })
  }
  const workspace = await one<{ id: string }>(client, 'the new workspace',
    `insert into workspaces (team_id, task_id, instance_id, path) values ($1, $2, $3, '') returning id`,
    [run.team_id, task.id, instanceId])
  // A repo's owner can rename its default branch, or make another branch the
  // default, at any time, so the workspace starts from the one its forge names
  // now. A forge that can't be asked fails this step, which rolls back and is
  // tried again, up to the runner's limit.
  const repos: RepoRef[] = []
  for (const r of await reposOf(client, run)) {
    repos.push({ ...r, default_branch: await currentDefaultBranch({ ...onForge(r), default_branch: r.default_branch }) })
  }
  const payload: SetupWorkspacePayload = {
    workspaceId: workspace.id,
    repos: repos.map((r) => ({
      repoId: r.repoId, name: r.name, branch: branchOf(run, task), base: r.default_branch, setup: r.setup_command,
      commit: run.trigger_payload.commits?.[r.repoId],
    })),
  }
  await client.query(
    `insert into commands (team_id, instance_id, kind, payload) values ($1, $2, 'setup_workspace', $3)`,
    [run.team_id, instanceId, JSON.stringify(payload)])
  await client.query(`update runs set status = 'running', started_at = now(), note = null where id = $1`, [run.id])
  run.status = 'running'
  await addRow(client, run, { stage: pipeline.start, kind: stageOf(pipeline, pipeline.start).kind })
  return true
}

// Has the run's machine commit whatever the agent left and push the task branch. Returns the command.
export async function sendPush(client: pg.PoolClient, run: Run, workspace: Workspace, task: Task, message: string, author: string): Promise<string> {
  const payload: PushPayload = {
    workspaceId: workspace.id, message, author,
    repos: (await reposOf(client, run)).map((r) => ({ repoId: r.repoId, name: r.name, branch: branchOf(run, task), base: r.default_branch })),
  }
  const sent = await one<{ id: string }>(client, 'the new push command',
    `insert into commands (team_id, instance_id, kind, payload) values ($1, $2, 'push', $3) returning id`,
    [run.team_id, workspace.instance_id, JSON.stringify(payload)])
  return sent.id
}

export const REPORT_INSTRUCTION = (outcomes: string[]) => `\n\nWhen you are done, call the report_result tool once. Set outcome to one of: ${
  outcomes.join(', ')}. Put what you found or did in summary, and any details asked for above in data. Then end your turn.`

// Starts the latest row's stage.
async function start(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], row: Row): Promise<boolean> {
  const cost = await runCost(client, run.id)
  const governed = await framework.policyOf(client, run)
  // A repo's policy can lower the pipeline's spend cap, and caps working time.
  const spendCap = Math.min(pipeline.spendCapUsd, governed?.policy.maxSpendUsd ?? Infinity)
  if (cost >= spendCap) {
    await setRow(client, row, { status: 'cancelled', summary: 'Not started: the run reached its spend cap.', ended: true })
    await finishRun(client, run, 'failed', `Stopped at the spend cap: $${cost.toFixed(2)} of $${spendCap.toFixed(2)}.`)
    return true
  }
  const overTime = governed ? framework.timeCapProblem(governed.policy, rows) : null
  if (overTime) {
    await setRow(client, row, { status: 'cancelled', summary: 'Not started: the run reached its time cap.', ended: true })
    await finishRun(client, run, 'failed', overTime)
    return true
  }
  const stage = stageOf(pipeline, row.stage)
  const workspace = await workspaceOf(client, run)
  if (!workspace) return false
  if (workspace.status !== 'ready') {
    const setup = await maybe<{ status: string; error: string | null }>(client,
      `select status, error from commands where kind = 'setup_workspace' and payload->>'workspaceId' = $1
       order by created_at desc limit 1`, [workspace.id])
    if (setup?.status === 'failed') {
      await setRow(client, row, { status: 'failed', summary: `Setting up the workspace failed: ${setup.error ?? 'no reason given'}`, ended: true })
      return true
    }
    return false
  }
  const ctx = await context(client, run, rows, row)

  if (stage.kind === 'agent' || stage.kind === 'route') {
    const agentName = stage.agent ?? pipeline.agent
    const agent = await agentNamed(client, run.team_id, agentName)
    if (!agent) {
      await setRow(client, row, { status: 'failed', summary: `No agent named ${agentName}.`, ended: true })
      return true
    }
    // A stage that runs again goes back to its own session, so the agent
    // remembers, unless its last session went quiet and is being replaced.
    const earlier = row.data.fresh === true ? null : rows.find((r) => r.stage === row.stage && r.session_id)?.session_id ?? null
    // The stage's own model, such as haiku for cheap reading, over the agent's.
    const staged: AgentRow = { ...agent, model: stage.kind === 'agent' ? stage.model ?? agent.model : agent.model }
    const session = await stageSession(client, run, workspace, staged, row.stage, earlier)
    const outcomes = stage.kind === 'route' ? await framework.routeOutcomes(client, run, stage) : outcomesOf(stage)
    // What is left of the run's cap, on top of what this session has spent, since
    // the harness counts its whole session against the budget.
    const maxBudgetUsd = Number(session.cost_usd ?? 0) + spendCap - cost
    const seq = await sendPrompt(client, run, workspace, staged, session,
      { text: stage.prompt(ctx) + REPORT_INSTRUCTION(outcomes), clientId: `stage:${row.id}`, stage: row.stage },
      { outcomes, allow: stage.allow ?? [], maxBudgetUsd, isolated: false }, WORKSPACE_PERMISSIONS)
    await setRow(client, row, { status: 'running', session_id: session.id, from_seq: String(seq), started: true })
    return true
  }
  if (stage.kind === 'verify') return framework.startVerify(client, run, pipeline, row)
  if (stage.kind === 'review') return framework.startReview(client, run, pipeline, rows, row, stage, ctx, workspace, spendCap - cost)
  if (stage.kind === 'confirm') return framework.startConfirm(client, run, pipeline, rows, row, stage, ctx, workspace, spendCap - cost)
  if (stage.kind === 'suite') return framework.startSuite(client, run, pipeline, rows, row)

  if (stage.kind === 'check') {
    const command = stage.command(ctx)
    const sent = await one<{ id: string }>(client, 'the new check command',
      `insert into commands (team_id, instance_id, kind, payload) values ($1, $2, 'exec', $3) returning id`,
      [run.team_id, workspace.instance_id, JSON.stringify({ workspaceId: workspace.id, repo: ctx.repo, command, timeoutSec: CHECK_TIMEOUT_SEC })])
    await setRow(client, row, { status: 'running', command_id: sent.id, data: { command }, started: true })
    return true
  }

  if (stage.kind === 'gate') {
    if (run.replay_of) {
      await setRow(client, row, { status: 'done', outcome: 'approved', summary: 'Approved by itself, since a replay never waits on a person.', started: true, ended: true })
      return true
    }
    // On a repo with a policy, the gate's role says who may answer it, and a
    // protected gate with nothing protected to judge passes by itself.
    const role = governed && stage.role ? await framework.gateRole(client, run, pipeline, rows, stage.role, governed) : null
    if (role?.kind === 'pass') {
      await setRow(client, row, { status: 'done', outcome: 'approved', summary: role.summary, started: true, ended: true })
      return true
    }
    const question = `${stage.question(ctx)}${role?.question ?? ''}`
    const links = await many<{ title: string; url: string }>(client,
      `select title, url from artifacts where task_id = $1 and kind = 'link' order by created_at`, [run.task_id])
    const task = await taskOf(client, run)
    const only = role?.only ? { only: role.only.id, onlyLogin: role.only.login } : {}
    const ask = await one<{ id: string }>(client, 'the new gate',
      `insert into asks (team_id, kind, run_id, conversation_id, payload) values ($1, 'gate', $2, $3, $4) returning id`,
      [run.team_id, run.id, task.conversation_id, JSON.stringify({ question, stage: row.stage, options: ['approve', 'reject'], links, labels: stage.labels ?? null, ...only })])
    await setRow(client, row, { status: 'waiting', ask_id: ask.id, started: true, ...(role ? { data: role.data } : {}) })
    await client.query(`update runs set status = 'waiting' where id = $1`, [run.id])
    await post(client, run, `row:${row.id}`, `${await shepherd(client, run)}${question}${links.map((l) => `\n${l.title}: ${l.url}`).join('')}`)
    return true
  }

  // A replay leaves the forge and the team's agents alone.
  if (run.replay_of) {
    await setRow(client, row, { status: 'done', outcome: 'done', summary: `Skipped ${stage.action}, since a replay changes nothing.`, data: { replay: true }, started: true, ended: true })
    return true
  }
  // Opening a pull request, or scoring a change, first pushes the task branch.
  const task = await taskOf(client, run)
  const repo = await repoOf(client, run)
  if (stage.action === 'open_pull_request' || stage.action === 'score_change') {
    const sent = await sendPush(client, run, workspace, task, stage.title?.(ctx) ?? ctx.report.title, pipeline.agent)
    await setRow(client, row, { status: 'running', command_id: sent, data: { phase: 'push' }, started: true })
    return true
  }
  if (stage.action === 'replay_sessions') return replaySessions(client, run, pipeline, rows, row)
  if (stage.action === 'deploy') return framework.startDeploy(client, run, pipeline, rows, row, governed)
  const action = stage.action
  let result: ActionResult
  try {
    switch (action) {
      case 'ask_reporter': {
        const issue = ctx.report.issue
        if (issue === undefined) throw new Error('the report came from no issue, so there is no reporter to ask')
        await forgeFor(onForge(repo)).comment(repoPath(repo.remote_url), issue, stage.text?.(ctx) ?? '')
        result = { outcome: 'done', summary: `Asked the reporter one question on issue #${issue}.` }
        break
      }
      case 'merge_change':
      case 'merge_pull_request': {
        // On a repo with a policy every merge checks the gates' evidence first,
        // whichever pipeline asks for it.
        if (governed) {
          const merged = await framework.mergeChange(client, run, pipeline, rows, governed)
          // merge_pull_request has no stale outcome, so a suite run on an old main fails it.
          result = { ...merged, outcome: merged.outcome === 'stale' && action === 'merge_pull_request' ? 'failed' : merged.outcome }
          break
        }
        if (action === 'merge_change') throw new Error('merge_change merges only on a repo with a policy')
        const opened = [...rows].reverse().find((r) => r.data.pullRequest !== undefined)
        if (!opened) throw new Error('there is no pull request to merge')
        const number = Number(opened.data.pullRequest)
        const pr = await forgeFor(onForge(repo)).merge(repoPath(repo.remote_url), number)
        if (!pr.merged) throw new Error(`pull request #${number} did not merge`)
        await client.query(`update artifacts set state = 'merged', updated_at = now() where task_id = $1 and url = $2`, [run.task_id, pr.html_url])
        // A merged pipeline change is approved, and its version becomes current now.
        await client.query(
          `update proposals set status = 'approved', decided_by = $2, decided_at = now() where run_id = $1 and status = 'open'`,
          [run.id, await approver(client, run)])
        await syncPipelines([repo.repoId])
        result = { outcome: 'done', summary: `Merged pull request #${number}.` }
        break
      }
      case 'close_issue': {
        const issue = ctx.report.issue
        if (issue) {
          await forgeFor(onForge(repo)).comment(repoPath(repo.remote_url), issue, stage.text?.(ctx) || 'Closed by the pipeline.')
          await forgeFor(onForge(repo)).closeIssue(repoPath(repo.remote_url), issue)
        }
        result = { outcome: 'done', summary: issue ? `Closed issue #${issue}.` : 'There was no issue to close.' }
        break
      }
      case 'pick_sessions':
      case 'record_findings':
      case 'propose_hunks':
      case 'decide_replays':
      case 'settle_hunks':
        result = await learn(client, action, { id: RunId.parse(run.id), teamId: TeamId.parse(run.team_id), report: ctx.report }, rows, pipeline)
        break
    }
  } catch (error) {
    result = { outcome: 'failed', summary: messageOf(error) }
  }
  await setRow(client, row, { status: 'done', outcome: result.outcome, summary: result.summary, data: { ...row.data, ...result.data }, started: true, ended: true })
  return true
}

// Starts the replays that score a coach proposal. A change that writes no text
// has nothing to replay, and goes on unscored. A savepoint keeps a failure from
// leaving half the replays queued for a machine.
async function replaySessions(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], row: Row): Promise<boolean> {
  await client.query('savepoint replays')
  try {
    const proposal = proposalOf(rows, pipeline)
    const started = await startSessionReplays(client, TeamId.parse(run.team_id), proposal, pipeline.spendCapUsd - await runCost(client, run.id))
    if (!started) {
      await client.query(`update proposals set status = 'open' where id = $1 and status = 'scoring'`, [proposal])
      await setRow(client, row, { status: 'done', outcome: 'unscored', summary: 'The change writes no text, so there is nothing to replay.', data: { proposal }, started: true, ended: true })
      return true
    }
    await setRow(client, row, { status: 'running', summary: `Replaying ${started} turns, each with and without the change.`, data: { phase: 'replaying', proposal, replays: started }, started: true })
  } catch (error) {
    await client.query('rollback to savepoint replays')
    await client.query(`update proposals set status = 'failed' where run_id = $1 and status = 'scoring'`, [run.id])
    await setRow(client, row, { status: 'done', outcome: 'failed', summary: messageOf(error), started: true, ended: true })
  }
  return true
}

// Checks on the latest row's stage while it runs.
async function poll(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], row: Row): Promise<boolean> {
  const stage = stageOf(pipeline, row.stage)
  // The suite and a deploy carry their own time limits, from the policy and the deploy target.
  const timed = row.data.phase !== 'scoring' && stage.kind !== 'suite' && !(stage.kind === 'action' && stage.action === 'deploy')
  if (timed && row.started_at && Date.now() - new Date(row.started_at).getTime() > STAGE_TIMEOUT_MS) {
    for (const sessionId of rowSessions(row)) await signal(client, run, sessionId, 'interrupt')
    await setRow(client, row, { status: 'failed', summary: `The stage ran longer than ${STAGE_TIMEOUT_MS / 60_000} minutes.`, ended: true })
    return true
  }

  if (await framework.lostMachine(client, run, row, rowSessions(row))) return true
  // On a repo with a policy, an agent that goes quiet is replaced, not resumed.
  if (stage.kind === 'agent' || stage.kind === 'route' || stage.kind === 'review' || stage.kind === 'confirm') {
    if (await framework.stuck(client, run, rows, row, rowSessions(row))) return true
  }
  if ((stage.kind === 'agent' || stage.kind === 'route') && row.session_id) return pollAgent(client, run, stage, row, row.session_id)
  if (stage.kind === 'verify') return framework.pollVerify(client, run, pipeline, rows, row)
  if (stage.kind === 'review') return framework.pollReview(client, run, rows, row)
  if (stage.kind === 'confirm') return framework.pollConfirm(client, run, pipeline, rows, row)
  if (stage.kind === 'suite') return framework.pollSuite(client, run, pipeline, rows, row)
  if (stage.kind === 'action' && stage.action === 'deploy') return framework.pollDeploy(client, row)

  // Coach's replays: once every one has replied or failed, the judge reads them.
  if (stage.kind === 'action' && stage.action === 'replay_sessions' && row.data.phase === 'replaying') {
    const proposal = ProposalId.parse(row.data.proposal)
    if (await advanceSessionReplays(client, proposal)) return false
    await setRow(client, row, {
      status: 'done', outcome: 'replayed', summary: `Replayed ${String(row.data.replays)} turns, each with and without the change.`,
      data: { ...row.data, prompt: await judgePrompt(client, proposal) }, ended: true,
    })
    return true
  }

  // Scoring waits for every replay of the proposal to finish, then compares.
  if (stage.kind === 'action' && stage.action === 'score_change' && row.data.phase === 'scoring') {
    const proposal = await one<{ id: string; candidate_version_id: string; base_version_id: string }>(client, 'the proposal being scored',
      'select id, candidate_version_id, base_version_id from proposals where id = $1', [row.data.proposal])
    const scored = await scoreReplays(client, proposal.id, proposal.candidate_version_id, proposal.base_version_id)
    if (!scored) return false
    await client.query('update proposals set scores = $2, status = $3 where id = $1',
      [proposal.id, JSON.stringify(scored.scores), scored.better ? 'open' : 'rejected'])
    await setRow(client, row, { status: 'done', outcome: scored.better ? 'better' : 'not_better', summary: scored.summary, data: { ...row.data, scores: scored.scores }, ended: true })
    return true
  }
  if (!row.command_id) return false
  const command = await one<Command>(client, `command ${row.command_id}`, 'select status, error, result from commands where id = $1', [row.command_id])
  if (command.status === 'queued' || command.status === 'claimed') return false

  if (stage.kind === 'check') {
    if (command.status === 'failed') {
      await setRow(client, row, { status: 'failed', summary: `The check could not run: ${command.error ?? 'no reason given'}`, ended: true })
      return true
    }
    const result = execResult(command.result)
    const outcome = result.exitCode === 0 ? 'passes' : 'fails'
    await setRow(client, row, {
      status: 'done', outcome, ended: true, data: { ...row.data, exitCode: result.exitCode, timedOut: result.timedOut },
      summary: `\`${String(row.data.command)}\` exited with ${result.exitCode ?? 'no code'}${result.timedOut ? ' after timing out' : ''}.\n\n${tail(result.output.trim(), 3000)}`,
    })
    return true
  }
  if (stage.kind !== 'action') return false
  if (command.status === 'failed') {
    await setRow(client, row, { status: 'done', outcome: 'failed', summary: `The push failed: ${command.error ?? 'no reason given'}`, ended: true })
    return true
  }
  if (stage.action === 'score_change') return startScoring(client, run, pipeline, rows, row)
  if (stage.action === 'open_pull_request') return openPullRequest(client, run, pipeline, stage, rows, row, command)
  return false
}

// Where an agent's turn stands. A turn ends when a usage event lands after the
// prompt, and the agent reports with report_result. One that forgets gets one
// reminder in the same session.
export type Turn =
  | { state: 'waiting' }
  | { state: 'failed'; reason: string }
  | { state: 'reminded'; fromSeq: string }
  | { state: 'reported'; outcome: string; summary: string; data: Record<string, unknown>; endedAt: Date }

export async function readTurn(client: pg.PoolClient, run: Run, turn: { sessionId: string; fromSeq: string | null; outcomes: string[]; reminded: boolean; key: string; stage: string }): Promise<Turn> {
  const { sessionId, fromSeq, outcomes } = turn
  const session = await one<{ status: string; harness_session_id: string | null }>(client, `session ${sessionId}`,
    'select status, harness_session_id from sessions where id = $1', [sessionId])
  const ended = await maybe<{ seq: string; body: { subtype?: string }; created_at: Date }>(client,
    `select seq, body, created_at from events where session_id = $1 and kind = 'usage' and seq > $2 order by seq limit 1`, [sessionId, fromSeq])
  const sent = await maybe<{ status: string; error: string | null; payload: MessagePayload; instance_id: string }>(client,
    `select status, error, payload, instance_id from commands where session_id = $1 and kind = 'message' order by created_at desc limit 1`, [sessionId])
  if (!ended) {
    if (sent?.status === 'failed' || session.status === 'failed') return { state: 'failed', reason: `The agent's session stopped: ${sent?.error ?? 'it exited with an error'}` }
    return { state: 'waiting' }
  }
  const report = await maybe<{ input: { outcome?: unknown; summary?: unknown; data?: unknown } }>(client,
    `select c.body->'input' as input from events c
     where c.session_id = $1 and c.seq > $2 and c.kind = 'tool_call' and c.tool_name = $3
       and not exists (select 1 from events r where r.session_id = c.session_id and r.kind = 'tool_result'
                       and r.tool_use_id = c.tool_use_id and coalesce((r.body->>'isError')::boolean, false))
     order by c.seq desc limit 1`, [sessionId, fromSeq, REPORT_TOOL])
  const reported = report?.input
  if (reported && typeof reported.outcome === 'string' && outcomes.includes(reported.outcome)) {
    const data = REPORTED_DATA.safeParse(reported.data)
    return {
      state: 'reported', outcome: reported.outcome, summary: typeof reported.summary === 'string' ? reported.summary : '',
      data: data.success ? data.data : {}, endedAt: ended.created_at,
    }
  }
  if (ended.body.subtype && ended.body.subtype !== 'success') return { state: 'failed', reason: `The agent's turn ended early (${ended.body.subtype}).` }
  if (turn.reminded || !sent) return { state: 'failed', reason: 'The agent ended its turn twice without reporting a result.' }
  const text = `You ended your turn without calling report_result. Call it now with one of: ${outcomes.join(', ')}.`
  const [seq] = await appendEvents(client, sessionId, {
    events: [{ clientId: turn.key, kind: 'user', text, body: { text, runId: run.id, stage: turn.stage } }],
  })
  if (seq === undefined) throw new Error(`the reminder for ${turn.stage} was not recorded`)
  await client.query(
    `insert into commands (team_id, instance_id, session_id, kind, payload, event_id)
     select $1, $2, $3, 'message', $4, id from events where session_id = $3 and seq = $5`,
    [run.team_id, sent.instance_id, sessionId, JSON.stringify({ ...sent.payload, text, harnessSessionId: session.harness_session_id }), seq])
  return { state: 'reminded', fromSeq: String(seq) }
}

async function pollAgent(client: pg.PoolClient, run: Run, stage: AgentStage | RouteStage, row: Row, sessionId: string): Promise<boolean> {
  const outcomes = stage.kind === 'route' ? await framework.routeOutcomes(client, run, stage) : outcomesOf(stage)
  const turn = await readTurn(client, run, { sessionId, fromSeq: row.from_seq, outcomes, reminded: row.data.nudged === true, key: `stage:${row.id}:nudge`, stage: row.stage })
  if (turn.state === 'waiting') return false
  if (turn.state === 'failed') {
    await setRow(client, row, { status: 'failed', summary: turn.reason, ended: true })
    return true
  }
  if (turn.state === 'reminded') {
    await setRow(client, row, { from_seq: turn.fromSeq, data: { ...row.data, nudged: true } })
    return true
  }
  // A stage that needs a document is done only once the document arrives, just
  // after the turn. An agent asking a person a question owes no document yet.
  if (stage.kind === 'agent' && stage.document && turn.outcome !== 'ask') {
    const problem = await framework.documentProblem(client, run, stage.document, turn.endedAt)
    if (problem === 'wait') return false
    if (problem) {
      await setRow(client, row, { status: 'failed', summary: problem, ended: true })
      return true
    }
  }
  if (stage.kind === 'route') await framework.routed(client, run, row, turn.outcome, turn.summary, sessionId)
  await setRow(client, row, { status: 'done', outcome: turn.outcome, summary: turn.summary, data: turn.data, ended: true })
  return true
}

// The change is pushed. Take it as a candidate and replay past runs with it.
// A change with no checked evidence behind it, or one repeating a hunk the team
// turned down, is refused before any replay. A savepoint keeps a failure from
// leaving half the replays queued.
async function startScoring(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], row: Row): Promise<boolean> {
  const task = await taskOf(client, run)
  const repo = await repoOf(client, run)
  const study = [...rows].reverse().find((r) => r.kind === 'agent' && r.status === 'done')
  await client.query('savepoint scoring')
  try {
    const candidate = await candidateFrom(client, run.team_id, repo, branchOf(run, task))
    const proposed = await proposePipelineChange(client, { id: RunId.parse(run.id), teamId: TeamId.parse(run.team_id) }, rows, pipeline, candidate, study?.summary ?? '')
    if ('refused' in proposed) {
      await setRow(client, row, { status: 'done', outcome: 'refused', summary: `Refused the change: ${proposed.refused}`, ended: true })
      return true
    }
    const replayed = await startReplays(client, run.team_id, proposed.proposal, candidate.pipelineId, [candidate.candidateVersionId, candidate.baseVersionId])
    if (!replayed) throw new Error(`${candidate.name} has no finished runs to replay yet`)
    await setRow(client, row, { data: { phase: 'scoring', proposal: proposed.proposal, pipeline: candidate.name, replays: replayed } })
  } catch (error) {
    await client.query('rollback to savepoint scoring')
    await setRow(client, row, { status: 'done', outcome: 'failed', summary: messageOf(error), ended: true })
  }
  return true
}

// The push for a pull request finished. Open the pull request, or find the one already open.
async function openPullRequest(client: pg.PoolClient, run: Run, pipeline: Pipeline, stage: Stage & { kind: 'action' }, rows: Row[], row: Row, command: Command): Promise<boolean> {
  const task = await taskOf(client, run)
  const repo = await repoOf(client, run)
  const ctx = await context(client, run, rows, row)
  try {
    await checkAsker(onForge(repo), run.trigger_payload.sender)
    // On a repo with a policy the pull request is the commit the gates judged,
    // and its description is the runner's evidence, with the agent's summary in it.
    const governed = await framework.policyOf(client, run)
    const body = governed
      ? await framework.pullRequestBody(client, run, pipeline, rows, command.result, stage.text?.(ctx) ?? '')
      : stage.text?.(ctx) ?? ''
    const pr = await forgeFor(onForge(repo)).openPullRequest(repoPath(repo.remote_url), branchOf(run, task), repo.default_branch,
      stage.title?.(ctx) ?? ctx.report.title, body)
    // A pull request opened on an earlier pass gets the evidence for this commit.
    if (governed) await forge.describe(repoPath(repo.remote_url), pr.number, body)
    const title = `Pull request #${pr.number}`
    await client.query(`update proposals set pull_request = $2 where run_id = $1 and status = 'open'`, [run.id, pr.html_url])
    // The verdict ledger is kept by pull request and head commit.
    if (governed) await client.query('update verdicts set pull_request = $2 where run_id = $1 and pull_request is null', [run.id, pr.number])
    await client.query(
      `insert into artifacts (team_id, task_id, kind, title, url, state)
       select $1, $2, 'link', $3, $4, 'open' where not exists (select 1 from artifacts where task_id = $2 and url = $4)`,
      [run.team_id, run.task_id, title, pr.html_url])
    const pushed = (command.result as Partial<PushResult> | null)?.pushed ?? []
    await setRow(client, row, {
      status: 'done', outcome: 'done', summary: `Opened ${title}: ${pr.html_url}`, ended: true,
      data: { pullRequest: pr.number, url: pr.html_url, commits: pushed },
    })
  } catch (error) {
    await setRow(client, row, { status: 'done', outcome: 'failed', summary: messageOf(error), ended: true })
  }
  return true
}

// A gate or a hand-off waits for a person's answer.
async function waitForAnswer(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], row: Row): Promise<boolean> {
  const ask = await maybe<{ status: string; answered_by: string | null; answer: { decision: string; message: string | null; login: string } | null }>(client,
    'select status, answered_by, answer from asks where id = $1', [row.ask_id])
  if (ask?.status !== 'answered' || !ask.answer) return false
  const { decision, message, login } = ask.answer
  const said = `${login} said ${decision}${message ? `: ${message}` : ''}`
  await client.query(`update runs set status = 'running' where id = $1`, [run.id])
  run.status = 'running'
  if (ask.answered_by) await framework.personDecided(client, run, row.stage, ask.answered_by, `${decision} at ${row.stage}`, message ?? said)
  if (row.kind === 'review' || row.kind === 'confirm') return framework.answerJudges(client, run, row, decision, login, ask.answered_by)
  if (row.kind === 'gate') {
    await setRow(client, row, { status: 'done', outcome: decision === 'approve' ? 'approved' : 'rejected', summary: said, ended: true })
    return true
  }
  await setRow(client, row, { status: 'done', outcome: decision, summary: `${row.summary ?? ''}\n\n${said}`, ended: true })
  if (decision === 'stop') {
    await finishRun(client, run, 'failed', `Handed off to ${login}.`)
    return true
  }
  // Try the stage once more, past its limit.
  const tries = rows.filter((r) => r.stage === row.stage && r.kind !== 'handoff').length
  await addRow(client, run, { stage: row.stage, kind: stageOf(pipeline, row.stage).kind, attempt: tries + 1, data: { granted: true } })
  return true
}

// Follows a finished stage's outcome to what comes next.
async function follow(client: pg.PoolClient, run: Run, pipeline: Pipeline, rows: Row[], row: Row): Promise<boolean> {
  const stage = stageOf(pipeline, row.stage)
  const next: Next | undefined = stage.next[row.outcome ?? '']
  // Leaving an agent's stage ends its process. Coming back resumes the session.
  if (next !== row.stage) for (const sessionId of rowSessions(row)) await signal(client, run, sessionId, 'stop')
  if (next === undefined) return handoff(client, run, row.stage, `${row.stage} ended as ${row.outcome ?? 'nothing'}, and the pipeline does not say what comes next.`)
  if (typeof next === 'string') {
    const target = stageOf(pipeline, next)
    // A try cut short by a pause does not count.
    const tries = rows.filter((r) => r.stage === next && r.kind !== 'handoff' && r.status !== 'cancelled').length
    const limit = target.kind === 'agent' || target.kind === 'check' ? target.maxAttempts ?? DEFAULT_MAX_ATTEMPTS : Infinity
    if (tries >= limit) return handoff(client, run, next, `${next} has run ${tries} times, its limit.`)
    await addRow(client, run, { stage: next, kind: target.kind, attempt: tries + 1 })
    return true
  }
  if ('done' in next) {
    await finishRun(client, run, next.done === 'succeeded' ? 'done' : 'failed', next.note)
    return true
  }
  return handoff(client, run, row.stage, next.handoff)
}

// A person takes over: they can let the stage try again or stop the run.
async function handoff(client: pg.PoolClient, run: Run, stageName: string, reason: string): Promise<boolean> {
  if (run.replay_of) {
    await addRow(client, run, { stage: stageName, kind: 'handoff', status: 'done', outcome: 'stop', summary: reason })
    await finishRun(client, run, 'failed', `Would have asked a person: ${reason}`)
    return true
  }
  const task = await taskOf(client, run)
  const question = `${reason} Should the pipeline try ${stageName} again, or stop here so a person takes over?`
  const ask = await one<{ id: string }>(client, 'the new hand-off',
    `insert into asks (team_id, kind, run_id, conversation_id, payload) values ($1, 'question', $2, $3, $4) returning id`,
    [run.team_id, run.id, task.conversation_id, JSON.stringify({ question, stage: stageName, options: ['retry', 'stop'], reason })])
  await addRow(client, run, { stage: stageName, kind: 'handoff', status: 'waiting', ask_id: ask.id, summary: reason })
  await client.query(`update runs set status = 'waiting' where id = $1`, [run.id])
  await post(client, run, `handoff:${ask.id}`, `${await shepherd(client, run)}${question}`)
  return true
}

// Who answered the run's latest gate.
async function approver(client: pg.PoolClient, run: Run): Promise<string | null> {
  const ask = await maybe<{ answered_by: string | null }>(client,
    `select answered_by from asks where run_id = $1 and kind = 'gate' and status = 'answered' order by answered_at desc limit 1`, [run.id])
  return ask?.answered_by ?? null
}

export async function signal(client: pg.PoolClient, run: Run, sessionId: string, kind: 'stop' | 'interrupt') {
  await client.query(
    `insert into commands (team_id, instance_id, session_id, kind) select $1, instance_id, id, $3 from sessions where id = $2`,
    [run.team_id, sessionId, kind])
}

export async function finishRun(client: pg.PoolClient, run: Run, status: 'done' | 'failed' | 'cancelled', note: string) {
  const rows = await rowsOf(client, run.id)
  const cost = await runCost(client, run.id)
  const attempts: Record<string, number> = {}
  for (const r of rows) if (r.kind !== 'handoff' && r.status !== 'cancelled') attempts[r.stage] = (attempts[r.stage] ?? 0) + 1
  const metrics = {
    durationSec: run.started_at ? Math.round((Date.now() - new Date(run.started_at).getTime()) / 1000) : 0,
    costUsd: cost,
    stagesRun: Object.values(attempts).reduce((a, b) => a + b, 0),
    attempts,
    handoffs: rows.filter((r) => r.kind === 'handoff').length,
    lastStage: rows.at(-1)?.stage ?? null,
  }
  await client.query(
    `update runs set status = $2, note = $3, ended_at = now(), cost_usd = $4, metrics = $5, stage = $6, paused_at = null where id = $1`,
    [run.id, status, note, cost, JSON.stringify(metrics), metrics.lastStage])
  run.status = status
  for (const sessionId of new Set(rows.flatMap(rowSessions))) {
    await signal(client, run, sessionId, 'stop')
  }
  await releaseBox(client, run.id)
  // A proposal still waiting when its run ends was turned down, or never scored,
  // and replays still scoring it have no reason to go on.
  await client.query(
    `update proposals set status = case when status = 'scoring' then 'failed' else 'rejected' end
     where run_id = $1 and status in ('scoring', 'open')`, [run.id])
  const replays = await many<Run>(client,
    `select * from runs where proposal_id in (select id from proposals where run_id = $1) and status in ('queued', 'running', 'waiting') for update`, [run.id])
  for (const replay of replays) await finishRun(client, replay, 'cancelled', 'The proposal it was scoring was dropped.')
  await stopSessionReplays(client, run.id)
  await post(client, run, 'end', `${status === 'done' ? 'Finished' : status === 'cancelled' ? 'Cancelled' : 'Stopped'}: ${note}`)
}

// One step for a run. Returns whether anything changed, so the caller can take
// the next step at once.
async function step(client: pg.PoolClient, run: Run, pipeline: Pipeline): Promise<boolean> {
  if (run.status === 'queued') return begin(client, run, pipeline)
  const rows = await rowsOf(client, run.id)
  const row = rows.at(-1)
  if (!row) return false
  await client.query('update runs set stage = $2 where id = $1 and stage is distinct from $2', [run.id, row.stage])
  if (row.status === 'pending') return start(client, run, pipeline, rows, row)
  if (row.status === 'running') return poll(client, run, pipeline, rows, row)
  if (row.status === 'waiting') return waitForAnswer(client, run, pipeline, rows, row)
  if (row.status === 'failed') {
    for (const sessionId of rowSessions(row)) await signal(client, run, sessionId, 'stop')
    return handoff(client, run, row.stage, row.summary ?? `${row.stage} failed.`)
  }
  if (row.status === 'done' && row.kind !== 'handoff') return follow(client, run, pipeline, rows, row)
  return false
}

const failures = new Map<string, number>()

async function advance(runId: string) {
  try {
    await tx(async (client) => {
      const run = await maybe<Run>(client, `select * from runs where id = $1 and status in ('queued', 'running', 'waiting') for update skip locked`, [runId])
      if (!run) return
      const pipeline = await loadVersion(client, run.pipeline_version_id)
      for (let i = 0; i < 25 && ACTIVE.includes(run.status); i++) {
        if (!(await step(client, run, pipeline))) break
      }
    })
    failures.delete(runId)
  } catch (error) {
    const count = (failures.get(runId) ?? 0) + 1
    failures.set(runId, count)
    console.error(`run ${runId}:`, messageOf(error))
    // A step that keeps failing would hold the run forever, so stop it and say why.
    if (count >= 5) {
      failures.delete(runId)
      await pool.query(
        `update runs set status = 'failed', note = $2, ended_at = now() where id = $1 and status in ('queued', 'running', 'waiting')`,
        [runId, `The runner kept failing: ${messageOf(error)}`]).catch(() => undefined)
    }
  }
}

// Starts a run for each cron schedule that came due since the last look.
async function fireCron(teamIds: string[] | null) {
  const rows = await many<{ id: string; team_id: string; source: string; checked: Date | null }>(pool,
    `select p.id, p.team_id, v.source, p.cron_checked_at as checked
     from pipelines p join pipeline_versions v on v.id = p.current_version_id
     where $1::uuid[] is null or p.team_id = any($1)`, [teamIds])
  const now = new Date()
  for (const row of rows) {
    const { pipeline } = await loadSource(row.source)
    const crons = (pipeline?.triggers ?? []).filter((t) => t.kind === 'cron')
    if (!crons.length) continue
    for (const trigger of crons) {
      const due = row.checked && lastFire(trigger.schedule, row.checked, now)
      if (!due) continue
      const repo = await maybe<{ id: string }>(pool,
        `select id from repos where team_id = $1 and remote_url like '%/' || $2 || '.git'`, [row.team_id, trigger.repo])
      if (!repo) {
        console.error(`cron for pipeline ${row.id}: no repo ${trigger.repo}`)
        continue
      }
      await tx((client) => startRun(client, {
        pipelineId: row.id, trigger: 'cron', report: { title: trigger.title, body: trigger.body ?? '' },
        repoId: repo.id, once: `cron:${row.id}:${trigger.schedule}:${due.toISOString()}`,
      })).catch((error: unknown) => { console.error(`cron for pipeline ${row.id}:`, messageOf(error)) })
    }
    await pool.query('update pipelines set cron_checked_at = $2 where id = $1', [row.id, now])
  }
}

// Sends each routine whose schedule came due since the last look to its agent.
async function fireRoutines(teamIds: string[] | null) {
  const now = new Date()
  const rows = await many<{ id: string; schedule: string; checked: string | null }>(pool,
    `select r.id, r.trigger_config->>'schedule' as schedule, r.trigger_config->>'checkedAt' as checked
     from routines r join agents a on a.id = r.agent_id
     where r.enabled and r.trigger = 'cron' and a.archived_at is null and ($1::uuid[] is null or a.team_id = any($1))`, [teamIds])
  for (const routine of rows) {
    const due = routine.checked && lastFire(routine.schedule, new Date(routine.checked), now)
    await tx(async (client) => {
      const { rowCount } = await client.query(
        `update routines set trigger_config = trigger_config || jsonb_build_object('checkedAt', $2::text)
         where id = $1 and trigger_config->>'checkedAt' is not distinct from $3`, [routine.id, now.toISOString(), routine.checked])
      // Another server got here first.
      if (!rowCount || !due) return
      await sendRoutine(client, routine.id)
    }).catch((error: unknown) => { console.error(`routine ${routine.id}:`, messageOf(error)) })
  }
}

// The teams this server runs pipelines, routines and boxes for. AGENTS_RUNNER_TEAMS
// names them, comma separated, so a check's server leaves other teams' work alone.
// Unset, it is every team.
export async function scopedTeams(): Promise<string[] | null> {
  const names = process.env.AGENTS_RUNNER_TEAMS?.split(',').map((n) => n.trim()).filter(Boolean)
  if (!names?.length) return null
  return (await many<{ id: string }>(pool, 'select id from teams where name = any($1)', [names])).map((r) => r.id)
}

const logged = (what: string) => (error: unknown) => { console.error(`${what}:`, messageOf(error)) }

export function startRunner() {
  const state = {
    busy: false, again: false, stopped: false, lastSync: 0, lastMinute: -1,
    timer: undefined as NodeJS.Timeout | undefined, relisten: undefined as NodeJS.Timeout | undefined, listener: null as pg.PoolClient | null,
  }
  // Other ticks set `again` while this one awaits. Read through a function, since
  // the compiler assumes a value it just set cannot change across awaits.
  const askedAgain = (): boolean => state.again
  const stopped = (): boolean => state.stopped

  const tick = async () => {
    if (state.busy) {
      state.again = true
      return
    }
    state.busy = true
    try {
      do {
        state.again = false
        const teams = await scopedTeams()
        if (Date.now() - state.lastSync > SYNC_MS) {
          state.lastSync = Date.now()
          await syncPipelines(undefined, teams).catch(logged('pipeline sync'))
        }
        const minute = Math.floor(Date.now() / 60_000)
        if (minute !== state.lastMinute) {
          state.lastMinute = minute
          await fireCron(teams).catch(logged('cron'))
          await fireRoutines(teams).catch(logged('routines'))
          await stopIdleBoxes(teams).catch(logged('idle boxes'))
        }
        await tx((client) => expireTurns(client, teams)).catch(logged('turns'))
        await finishPushes(teams).catch(logged('pull requests'))
        await markLostMachines(teams).catch(logged('lost machines'))
        const rows = await many<{ id: string }>(pool,
          `select id from runs where status in ('queued', 'running', 'waiting') and ($1::uuid[] is null or team_id = any($1))
           order by created_at`, [teams])
        for (const { id } of rows) await advance(id)
        await tx((client) => deliverOutcomes(client, teams)).catch(logged('obligations'))
        await startClaimedBoxes(teams).catch(logged('boxes'))
      } while (askedAgain() && !state.stopped)
    } catch (error) {
      console.error('runner:', messageOf(error))
    } finally {
      state.busy = false
    }
  }
  const wake = () => { void tick() }

  // One connection listens so new work wakes the runner at once. When Postgres
  // drops it, the timer still ticks, and the runner listens again a moment later.
  const listen = async () => {
    if (state.stopped) return
    let client: pg.PoolClient | null = null
    try {
      client = await pool.connect()
      const mine = client
      mine.on('notification', wake)
      mine.on('error', (error) => {
        console.error('runner listen:', error.message)
        if (state.listener === mine) state.listener = null
        mine.release(error)
        if (!state.stopped) state.relisten = setTimeout(() => { void listen() }, 2000)
      })
      await mine.query(`listen ${CHANNEL}`)
      if (stopped()) mine.release()
      else state.listener = mine
    } catch (error) {
      console.error('runner listen:', messageOf(error))
      client?.release(error instanceof Error ? error : true)
      if (!stopped()) state.relisten = setTimeout(() => { void listen() }, 2000)
    }
  }
  void listen()
  const loop = () => {
    if (state.stopped) return
    void tick().finally(() => { state.timer = setTimeout(loop, TICK_MS) })
  }
  loop()
  return {
    wake,
    sync: async (repoIds: string[]) => {
      await syncPipelines(repoIds)
      wake()
    },
    stop() {
      state.stopped = true
      clearTimeout(state.timer)
      clearTimeout(state.relisten)
      state.listener?.release()
      state.listener = null
    },
  }
}
