import { useMemo, useState, type SyntheticEvent } from 'react'
import { go } from './App.tsx'
import { runLabel } from './Run.tsx'
import { ProposalView } from './Proposal.tsx'
import {
  act, api, clock, duration, money, repoName, useSnapshot, type Pipeline, type PipelineVersion, type Proposal, type Repo, type Run, type Task,
} from './data.ts'

type Stats = { runs: number; done: number; stopped: number; cost: number; seconds: number; finished: number }

// A pipeline: what it does, each version with how its runs went, its recent
// runs, and a way to start one by hand.
export function PipelineView({ pipelineId }: { pipelineId: string }) {
  const { rows: pipelines } = useSnapshot<Pipeline>('pipelines', {}, 10000)
  const { rows: versions } = useSnapshot<PipelineVersion>('pipeline_versions', {}, 10000)
  const { rows: runs } = useSnapshot<Run>('runs', {}, 4000)
  const { rows: tasks } = useSnapshot<Task>('tasks', {}, 4000)
  const { rows: proposals } = useSnapshot<Proposal>('proposals', {}, 4000)
  const pipeline = pipelines.find((p) => p.id === pipelineId)
  const own = versions.filter((v) => v.pipeline_id === pipelineId).sort((a, b) => b.created_at.localeCompare(a.created_at))
  const ownIds = new Set(own.map((v) => v.id))
  // Replays score proposals. They count toward no version's record and show with their proposal's run.
  const ownRuns = runs.filter((r) => ownIds.has(r.pipeline_version_id) && !r.replay_of).sort((a, b) => b.created_at.localeCompare(a.created_at))
  const changes = proposals.filter((p) => p.pipeline_id === pipelineId && p.status !== 'failed').sort((a, b) => b.created_at.localeCompare(a.created_at))
  const title = (run: Run) => tasks.find((t) => t.id === run.task_id)?.title ?? run.trigger_payload.report?.title ?? 'Run'

  const stats = useMemo(() => {
    const out = new Map<string, Stats>()
    for (const run of ownRuns) {
      const s = out.get(run.pipeline_version_id) ?? { runs: 0, done: 0, stopped: 0, cost: 0, seconds: 0, finished: 0 }
      s.runs++
      if (run.status === 'done') s.done++
      if (run.status === 'failed') s.stopped++
      if (run.ended_at) {
        s.finished++
        s.cost += Number(run.cost_usd ?? 0)
        s.seconds += run.metrics.durationSec ?? 0
      }
      out.set(run.pipeline_version_id, s)
    }
    return out
  }, [ownRuns])

  if (!pipeline) return <section className="page"><p className="muted">Loading the pipeline…</p></section>
  const current = own.find((v) => v.id === pipeline.current_version_id)
  return (
    <section className="page" aria-label="Pipeline">
      <header className="page-head">
        <div>
          <p className="kicker">Pipeline</p>
          <h1>{pipeline.name}</h1>
          <p className="muted small">{pipeline.description}</p>
        </div>
        {pipeline.conversation_id && <button type="button" className="ghost" onClick={() => go({ conversation: pipeline.conversation_id })}>Room</button>}
      </header>
      <div className="page-body">
        <StartRun pipeline={pipeline} disabled={!current} />

        {!!changes.length && (
          <>
            <h2 className="kicker section">Proposed changes</h2>
            {changes.slice(0, 5).map((proposal) => <ProposalView key={proposal.id} proposal={proposal} showRun />)}
          </>
        )}

        <h2 className="kicker section">Versions</h2>
        <table className="versions">
          <thead>
            <tr><th scope="col">Version</th><th scope="col">Added</th><th scope="col">Runs</th><th scope="col">Done</th><th scope="col">Stopped</th><th scope="col">Avg cost</th><th scope="col">Avg time</th></tr>
          </thead>
          <tbody>
            {own.map((v) => {
              const s = stats.get(v.id)
              return (
                <tr key={v.id} className={v.id === pipeline.current_version_id ? 'current' : undefined}>
                  <th scope="row"><code>{v.git_sha.slice(0, 8)}</code>{v.id === pipeline.current_version_id && <span className="small"> current</span>}{v.error && <span className="error small"> broken</span>}</th>
                  <td>{clock(v.created_at)}</td>
                  <td>{s?.runs ?? 0}</td>
                  <td>{s?.done ?? 0}</td>
                  <td>{s?.stopped ?? 0}</td>
                  <td>{s?.finished ? money(s.cost / s.finished) : ''}</td>
                  <td>{s?.finished ? duration(Math.round(s.seconds / s.finished)) : ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {own.filter((v) => v.error).slice(0, 1).map((v) => <p key={v.id} className="error small">Version {v.git_sha.slice(0, 8)} does not load: {v.error}</p>)}

        <h2 className="kicker section">Runs</h2>
        <ul className="run-list" aria-label="Runs of this pipeline">
          {ownRuns.slice(0, 30).map((run) => (
            <li key={run.id}>
              <button type="button" className="row" onClick={() => go({ run: run.id })}>
                <span><span className={`dot ${run.status}`} aria-hidden="true" />{title(run)}</span>
                <span className="muted small">{runLabel(run.status)}{run.stage ? ` · ${run.stage}` : ''} · {clock(run.created_at)}</span>
              </button>
            </li>
          ))}
          {!ownRuns.length && <li className="muted small empty">No runs yet</li>}
        </ul>

        {current && (
          <details className="source">
            <summary className="small">The pipeline file, {pipeline.path} at {current.git_sha.slice(0, 8)}</summary>
            <pre>{current.source}</pre>
          </details>
        )}
      </div>
    </section>
  )
}

function StartRun({ pipeline, disabled }: { pipeline: Pipeline; disabled: boolean }) {
  const { rows: repos } = useSnapshot<Repo>('repos', {}, 30000)
  const choices = repos.filter((r) => !r.remote_url.endsWith('/pipelines.git'))
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [repo, setRepo] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const repoId = repo || choices[0]?.id
      if (!repoId) throw new Error('Pick a repo first.')
      const { runId } = await api.startRun(pipeline.id, title.trim(), body.trim(), repoId)
      go({ run: runId })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="start-run" onSubmit={act(submit)} aria-label="Start a run">
      <h2 className="kicker">Start a run</h2>
      <label htmlFor="run-title">What should it work on?</label>
      <input id="run-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A one-line description" />
      <label htmlFor="run-body">Details</label>
      <textarea id="run-body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Steps, what you expected, what happened" />
      <label htmlFor="run-repo">Repo</label>
      <select id="run-repo" value={repo} onChange={(e) => setRepo(e.target.value)}>
        {choices.map((r) => <option key={r.id} value={r.id}>{repoName(r.remote_url)}</option>)}
      </select>
      <div className="actions">
        <button className="primary" type="submit" disabled={disabled || busy || !title.trim() || !choices.length}>Start</button>
        {error && <p className="error small" role="alert">{error}</p>}
      </div>
    </form>
  )
}
