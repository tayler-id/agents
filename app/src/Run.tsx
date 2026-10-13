import { useMemo, useState } from 'react'
import { go } from './App.tsx'
import { AskCard } from './Asks.tsx'
import { ProposalView } from './Proposal.tsx'
import { Markdown } from './Markdown.tsx'
import {
  act, api, byNumber, clock, duration, money, useRows, useSnapshot, type Artifact, type Ask, type Pipeline, type PipelineVersion, type Proposal, type Run, type RunStage, type Task,
} from './data.ts'

const ACTIVE = new Set(['queued', 'running', 'waiting'])
const KIND_LABELS: Record<string, string> = { agent: 'Agent', check: 'Check', action: 'Forge', gate: 'Gate', handoff: 'Hand-off' }

export const runLabel = (status: string) => ({ queued: 'queued', running: 'running', waiting: 'waiting on a person', done: 'done', failed: 'stopped', cancelled: 'cancelled' }[status] ?? status)
// The same, short enough for the sidebar.
export const shortRunLabel = (status: string) => (status === 'waiting' ? 'waiting' : runLabel(status))

// One pipeline run: what started it, each stage as it happens, what it made, and
// anything waiting on a person.
export function RunView({ runId, openSession }: { runId: string; openSession: string | null }) {
  const { rows: runs } = useSnapshot<Run>('runs', {}, 3000)
  const { rows: stages } = useRows<RunStage>('run_stages', { run: runId })
  const { rows: asks } = useRows<Ask>('asks')
  const { rows: tasks } = useSnapshot<Task>('tasks')
  const { rows: versions } = useSnapshot<PipelineVersion>('pipeline_versions', {}, 15000)
  const { rows: pipelines } = useSnapshot<Pipeline>('pipelines', {}, 15000)
  const { rows: proposals } = useSnapshot<Proposal>('proposals', {}, 4000)
  const [busy, setBusy] = useState(false)

  const run = runs.find((r) => r.id === runId)
  const task = tasks.find((t) => t.id === run?.task_id)
  const version = versions.find((v) => v.id === run?.pipeline_version_id)
  const pipeline = pipelines.find((p) => p.id === version?.pipeline_id)
  const { rows: artifacts } = useSnapshot<Artifact>('artifacts', task ? { task: task.id } : null, 4000)
  const ordered = useMemo(() => [...stages].sort(byNumber((s: RunStage) => s.n)), [stages])
  const waiting = asks.filter((a) => a.run_id === runId && a.status === 'open')
  const report = run?.trigger_payload.report

  if (!run) return <section className="page"><p className="muted">Loading the run…</p></section>
  const metrics = run.metrics
  return (
    <section className="page" aria-label="Run">
      <header className="page-head">
        <div>
          <p className="kicker">{pipeline?.name ?? 'pipeline'} {run.replay_of ? 'replay' : 'run'}</p>
          <h1>{task?.title ?? report?.title ?? 'Run'}</h1>
          <p className="muted small">
            <span className={`dot ${run.status}`} aria-hidden="true" />{runLabel(run.status)}
            {' · '}from {run.trigger}{report?.issue ? ` (issue #${report.issue})` : ''}
            {' · '}version <code>{version?.git_sha.slice(0, 8) ?? '…'}</code>
            {' · '}started {clock(run.started_at ?? run.created_at)}
          </p>
        </div>
        <div className="head-actions">
          {pipeline && <button type="button" className="ghost" onClick={() => go({ pipeline: pipeline.id })}>Pipeline</button>}
          {ACTIVE.has(run.status) && (
            <button type="button" disabled={busy} onClick={act(async () => { setBusy(true); try { await api.cancelRun(run.id) } finally { setBusy(false) } })}>Cancel run</button>
          )}
        </div>
      </header>

      <div className="page-body">
        {run.note && <p className="note-line">{run.note}</p>}
        {(run.ended_at || metrics.costUsd !== undefined) && (
          <dl className="facts">
            <div><dt>Took</dt><dd>{duration(metrics.durationSec)}</dd></div>
            <div><dt>Cost</dt><dd>{money(run.cost_usd ?? metrics.costUsd)}</dd></div>
            <div><dt>Stages run</dt><dd>{metrics.stagesRun ?? ordered.filter((s) => s.kind !== 'handoff').length}</dd></div>
            <div><dt>Hand-offs</dt><dd>{metrics.handoffs ?? 0}</dd></div>
          </dl>
        )}

        {proposals.filter((p) => p.run_id === runId).map((p) => <ProposalView key={p.id} proposal={p} />)}
        {waiting.map((ask) => <AskCard key={ask.id} ask={ask} />)}

        <h2 className="kicker section">Stages</h2>
        <ol className="stages" aria-label="Stages">
          {ordered.map((s) => (
            <li key={s.id} className={`stage ${s.status}`}>
              <div className="stage-line">
                <span className={`dot ${s.status}`} aria-hidden="true" />
                <strong>{s.stage}</strong>
                {s.attempt > 1 && <span className="muted small">try {s.attempt}</span>}
                <span className="muted small">{KIND_LABELS[s.kind] ?? s.kind}</span>
                <span className="stage-outcome small">{s.outcome ?? s.status}</span>
                <span className="muted small push">{clock(s.started_at ?? s.created_at)}</span>
              </div>
              {s.summary && <Summary text={s.summary} />}
              {s.session_id && (
                <button type="button" className="link small" onClick={() => go({ run: runId, session: openSession === s.session_id ? null : s.session_id })}>
                  {openSession === s.session_id ? 'Hide session' : 'Open session'}
                </button>
              )}
            </li>
          ))}
          {!ordered.length && <li className="muted small empty">Waiting for a machine…</li>}
        </ol>

        {!!artifacts.length && (
          <>
            <h2 className="kicker section">Made by this run</h2>
            <ul className="artifacts" aria-label="Made by this run">
              {[...artifacts].sort((a, b) => a.title.localeCompare(b.title)).map((a) => (
                <li key={a.id}>
                  {a.kind === 'link'
                    ? <a href={a.url ?? '#'} target="_blank" rel="noreferrer">{a.title}</a>
                    : <button type="button" className="link" onClick={() => go({ run: runId, document: a.id })}>{a.title}</button>}
                  <span className="muted small">{a.kind === 'link' ? a.state : `version ${a.current_version}`}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        {report && (
          <>
            <h2 className="kicker section">The report</h2>
            <div className="report">
              <p><strong>{report.title}</strong>{report.author ? <span className="muted small"> · from {report.author}</span> : null}</p>
              {report.body && <p className="pre">{report.body}</p>}
              {report.url && <a className="small" href={report.url} target="_blank" rel="noreferrer">Open on the forge</a>}
            </div>
          </>
        )}
        {run.replay_of && (
          <p className="small muted">A replay of <button type="button" className="link" onClick={() => go({ run: run.replay_of })}>an earlier run</button>, to score a proposed change. Replays never touch the forge or wait on a person.</p>
        )}
        {pipeline?.conversation_id && !run.replay_of && (
          <p className="small muted">Progress posts go to the <button type="button" className="link" onClick={() => go({ conversation: pipeline.conversation_id })}>{pipeline.name} room</button>.</p>
        )}
      </div>
    </section>
  )
}

// Long summaries, such as test output, fold away after a few lines.
function Summary({ text }: { text: string }) {
  const lines = text.split('\n')
  // Agents write markdown. Long summaries are mostly command output, so they stay as written.
  if (lines.length <= 4 && text.length < 400) return <div className="stage-summary"><Markdown text={text} /></div>
  return (
    <details className="stage-summary">
      <summary>{(lines[0] ?? '').slice(0, 160)}</summary>
      <pre>{text}</pre>
    </details>
  )
}
