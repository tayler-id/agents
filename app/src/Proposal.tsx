import { go } from './App.tsx'
import { clock, duration, money, type Proposal, type Score } from './data.ts'

const STATUS: Record<string, string> = {
  scoring: 'being scored', open: 'waiting for the shepherd', approved: 'approved', rejected: 'turned down', failed: 'could not be scored',
}

// A proposed change: what it changes, why, the diff, and for a pipeline change
// how it scored against the current version on replays of past runs.
export function ProposalView({ proposal, showRun = false }: { proposal: Proposal; showRun?: boolean }) {
  const { candidate, current } = proposal.scores as { candidate?: Score; current?: Score }
  const what = proposal.target === 'pipeline' ? 'pipeline change' : proposal.target === 'skill' ? `skill ${proposal.skill_name}` : 'instructions change'
  return (
    <section className="proposal" aria-label="Proposed change">
      <p className="kicker">Proposed {what} · {STATUS[proposal.status] ?? proposal.status} · {clock(proposal.created_at)}</p>
      {proposal.summary && <p>{proposal.summary}</p>}
      {candidate && current && (
        <table className="versions scores">
          <thead>
            <tr><th scope="col">Version</th><th scope="col">Finished</th><th scope="col">Reminders and hand-offs</th><th scope="col">Stages run</th><th scope="col">Cost</th><th scope="col">Time</th></tr>
          </thead>
          <tbody>
            {([['With the change', candidate], ['Current', current]] as const).map(([label, s]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{s.finished} of {s.replays}</td>
                <td>{s.problems}</td>
                <td>{s.stagesRun}</td>
                <td>{money(s.costUsd)}</td>
                <td>{duration(s.durationSec)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {proposal.diff && (
        <details className="diff" open={proposal.status === 'open'}>
          <summary className="small">The diff</summary>
          <pre aria-label="Diff">{proposal.diff.split('\n').map((line, i) => (
            <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'removed' : undefined}>{line}{'\n'}</span>
          ))}</pre>
        </details>
      )}
      <p className="small">
        {proposal.pull_request && <a href={proposal.pull_request} target="_blank" rel="noreferrer">Pull request</a>}
        {proposal.pull_request && showRun && proposal.run_id && ' · '}
        {showRun && proposal.run_id && <button type="button" className="link" onClick={() => go({ run: proposal.run_id })}>The run that proposed it</button>}
      </p>
    </section>
  )
}
