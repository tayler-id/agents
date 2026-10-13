// Refinement. A change to a pipeline is scored before anyone sees it: past runs
// of that pipeline are replayed with the change and with the current version, at
// the commits they started from, and the two are compared. A change to an agent's
// instructions or a skill becomes a proposal the shepherd approves. The runner
// calls these from its actions.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type pg from 'pg'
import { maybe, one } from './db.ts'
import { forge, repoPath } from './forge.ts'
import { recordVersion } from './pipelines.ts'
import { NAME } from '../shared/types.ts'

const REPLAYS = Number(process.env.AGENTS_REPLAYS ?? 3)

// A unified diff of two texts, from git.
export function diffText(before: string, after: string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agents-diff-'))
  try {
    writeFileSync(join(dir, 'a'), before)
    writeFileSync(join(dir, 'b'), after)
    execFileSync('git', ['diff', '--no-index', '--no-color', '--unified=3', 'a', 'b'], { cwd: dir, encoding: 'utf8' })
    return ''
  } catch (error) {
    // git exits 1 when the files differ, with the diff on stdout.
    const stdout = (error as { stdout?: unknown }).stdout
    return (typeof stdout === 'string' ? stdout : '')
      .replace(/^diff --git a\/a b\/b\n(index [^\n]*\n)?/, '')
      .replace(/^--- a\/a$/m, `--- a/${name}`).replace(/^\+\+\+ b\/b$/m, `+++ b/${name}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

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
  return { pipelineId: pipeline.id, name, baseVersionId: pipeline.current_version_id, candidateVersionId: versionId,
    diff: diffText(pipeline.source ?? '', file.content, file.path) }
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

export type Score = { replays: number; finished: number; problems: number; stagesRun: number; costUsd: number; durationSec: number }

// How each version did across its replays, once every replay has finished.
export async function scoreReplays(client: pg.PoolClient, proposalId: string, candidate: string, base: string) {
  const { rows } = await client.query<{ pipeline_version_id: string; status: string; metrics: { handoffs?: number; stagesRun?: number; durationSec?: number }; cost_usd: string | null; reminders: number }>(
    `select r.pipeline_version_id, r.status, r.metrics, r.cost_usd,
       (select count(*)::int from events e join run_stages s on s.session_id = e.session_id
        where s.run_id = r.id and e.kind = 'user' and e.text like 'You ended your turn without calling report_result%') as reminders
     from runs r where r.proposal_id = $1`, [proposalId])
  if (rows.some((r) => ['queued', 'running', 'waiting'].includes(r.status))) return null
  const score = (versionId: string): Score => {
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
  const line = (s: Score) => `${s.finished} of ${s.replays} finished, ${s.problems} reminders or hand-offs, ${s.stagesRun} stages run, $${s.costUsd.toFixed(2)}`
  const summary = `Replayed ${cand.replays} past runs with each version. With the change: ${line(cand)}. With the current version: ${line(current)}. `
    + (verdict ? 'The change scored better.' : 'The change did not score better.')
  return { better: verdict, scores: { candidate: cand, current }, summary }
}

// A proposal from a study stage's data: new instructions for an agent, or a
// skill. Returns what it proposed.
export async function proposeInstructions(client: pg.PoolClient, teamId: string, runId: string, summary: string, data: Record<string, unknown>): Promise<string> {
  // The study stage's data is whatever the agent reported, so check each field.
  const agentName = typeof data.agent === 'string' ? data.agent : ''
  if (!agentName) throw new Error('the study did not name an agent')
  const agent = await maybe<{ id: string; instructions: string }>(client,
    'select id, instructions from agents where team_id = $1 and name = $2 and archived_at is null', [teamId, agentName])
  if (!agent) throw new Error(`no agent named ${agentName}`)
  const raw = typeof data.skill === 'object' && data.skill !== null ? data.skill as Record<string, unknown> : {}
  const skill = { name: typeof raw.name === 'string' ? raw.name : '', content: typeof raw.content === 'string' ? raw.content : '' }
  if (skill.name && skill.content) {
    if (!NAME.test(skill.name)) throw new Error(`the study named a skill "${skill.name}", and a skill name is lowercase letters, digits and dashes`)
    const old = await maybe<{ content: string }>(client,
      'select content from skills where team_id = $1 and agent_id = $2 and name = $3', [teamId, agent.id, skill.name])
    await client.query(
      `insert into proposals (team_id, target, agent_id, skill_name, content, diff, summary, status, run_id)
       values ($1, 'skill', $2, $3, $4, $5, $6, 'open', $7)`,
      [teamId, agent.id, skill.name, skill.content, diffText(old?.content ?? '', skill.content, `skills/${skill.name}`), summary, runId])
    return `Proposed the skill ${skill.name} for ${agentName}.`
  }
  if (typeof data.instructions !== 'string' || !data.instructions.trim()) throw new Error('the study gave no new instructions')
  if (data.instructions.trim() === agent.instructions.trim()) throw new Error('the new instructions are the same as the current ones')
  await client.query(
    `insert into proposals (team_id, target, agent_id, content, diff, summary, status, run_id)
     values ($1, 'instructions', $2, $3, $4, $5, 'open', $6)`,
    [teamId, agent.id, data.instructions, diffText(agent.instructions, data.instructions, `${agentName} instructions`), summary, runId])
  return `Proposed new instructions for ${agentName}.`
}

// Applies the run's open proposal for an agent, as the person who approved it.
export async function applyProposal(client: pg.PoolClient, runId: string, decidedBy: string | null) {
  const proposal = await maybe<{ id: string; team_id: string; target: string; agent_id: string; skill_name: string | null; content: string }>(client,
    `select id, team_id, target, agent_id, skill_name, content from proposals where run_id = $1 and status = 'open' and target <> 'pipeline' for update`, [runId])
  if (!proposal) throw new Error('this run has no open proposal to apply')
  if (proposal.target === 'instructions') {
    await client.query('update agents set instructions = $2 where id = $1', [proposal.agent_id, proposal.content])
  } else {
    const { rowCount } = await client.query(
      `update skills set content = $4, updated_at = now() where team_id = $1 and agent_id = $2 and name = $3`,
      [proposal.team_id, proposal.agent_id, proposal.skill_name, proposal.content])
    if (!rowCount) {
      await client.query('insert into skills (team_id, agent_id, name, content) values ($1, $2, $3, $4)',
        [proposal.team_id, proposal.agent_id, proposal.skill_name, proposal.content])
    }
  }
  await client.query(`update proposals set status = 'approved', decided_by = $2, decided_at = now() where id = $1`, [proposal.id, decidedBy])
}
