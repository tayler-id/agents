import { useMemo, useState } from 'react'
import { go } from './App.tsx'
import { act, api, clock, duration, money, useSnapshot, type Agent, type Hunk, type Person, type Proposal } from './data.ts'
import type { Counts, FindingKind, RunScore, SessionScore } from '../../shared/evidence.ts'

// What every proposal on a page reads: the hunks, and the names of people and
// agents. A page fetches them once, and only while it shows a proposal.
export function useProposalContext(showing: boolean) {
  const args = showing ? {} : null
  const { rows: hunks } = useSnapshot<Hunk>('proposal_hunks', args, 4000)
  const { rows: people } = useSnapshot<Person>('people', args, 30000)
  const { rows: agents } = useSnapshot<Agent>('agents', args, 30000)
  return useMemo(() => ({
    hunksOf: (proposalId: string) => hunks.filter((h) => h.proposal_id === proposalId).sort((a, b) => a.n - b.n),
    login: (id: string | null) => people.find((p) => p.id === id)?.login ?? 'someone',
    agentName: (id: string | null) => agents.find((a) => a.id === id)?.name ?? 'an agent',
  }), [hunks, people, agents])
}
export type ProposalContext = ReturnType<typeof useProposalContext>

const STATUS: Record<string, string> = {
  scoring: 'being scored', open: 'waiting for the shepherd', approved: 'approved', rejected: 'turned down', failed: 'could not be scored',
}
const KIND: Record<FindingKind, string> = { gap: 'a correction no rule covers', ignored: 'a rule ignored', harm: 'a rule that caused harm', followed: 'a rule followed' }

const countsText = (c: Counts) => `${c.sessions} session${c.sessions === 1 ? '' : 's'}: ${c.bySource.person} people's, `
  + `${c.bySource.pipeline} pipeline, ${c.bySource.box} box · ${c.people} ${c.people === 1 ? 'person' : 'people'}`

function Diff({ text, label }: { text: string; label: string }) {
  return (
    <pre aria-label={label}>{text.split('\n').map((line, i) => (
      <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'removed' : undefined}>{line}{'\n'}</span>
    ))}</pre>
  )
}

// A proposed change: what it changes and why, how it scored on replays, and its
// hunks, each with the quotes it rests on and the decision on it. A coach
// proposal at its gate lets a person keep or turn down each hunk.
export function ProposalView({ proposal, context, showRun = false }: { proposal: Proposal; context: ProposalContext; showRun?: boolean }) {
  const hunks = context.hunksOf(proposal.id)
  const { login } = context
  const agent = context.agentName(proposal.agent_id)
  const what = proposal.target === 'pipeline' ? 'pipeline change' : proposal.target === 'skill' ? `skill ${proposal.skill_name ?? ''}`
    : proposal.target === 'agent' ? `change to ${agent}` : 'instructions change'
  const { scores } = proposal
  const deciding = proposal.target === 'agent' && proposal.status === 'open'
  return (
    <section className="proposal" aria-label="Proposed change">
      <p className="kicker">Proposed {what} · {STATUS[proposal.status] ?? proposal.status} · {clock(proposal.created_at)}</p>
      {proposal.summary && <p>{proposal.summary}</p>}
      {'candidate' in scores && <RunScores candidate={scores.candidate} current={scores.current} />}
      {'change' in scores && <SessionScores change={scores.change} current={scores.current} />}
      {hunks.length ? (
        <ol className="hunks" aria-label="Hunks">
          {hunks.map((h) => <HunkView key={h.id} hunk={h} deciding={deciding} login={login} />)}
        </ol>
      ) : proposal.diff && (
        <details className="diff" open={proposal.status === 'open'}>
          <summary className="small">The diff</summary>
          <Diff text={proposal.diff} label="Diff" />
        </details>
      )}
      {deciding && <p className="small muted">Keep or turn down each hunk, then answer the gate. Approving keeps every hunk you have not turned down.</p>}
      <p className="small">
        {proposal.pull_request && <a href={proposal.pull_request} target="_blank" rel="noreferrer">Pull request</a>}
        {proposal.pull_request && showRun && proposal.run_id && ' · '}
        {showRun && proposal.run_id && <button type="button" className="link" onClick={() => go({ run: proposal.run_id })}>The run that proposed it</button>}
      </p>
    </section>
  )
}

function RunScores({ candidate, current }: { candidate: RunScore; current: RunScore }) {
  return (
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
  )
}

function SessionScores({ change, current }: { change: SessionScore; current: SessionScore }) {
  return (
    <table className="versions scores">
      <thead>
        <tr><th scope="col">Version</th><th scope="col">Corrections still needed</th><th scope="col">Other turns worse</th></tr>
      </thead>
      <tbody>
        {([['With the change', change], ['Current', current]] as const).map(([label, s]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{s.still} of {s.behind}</td>
            <td>{s.unrelated ? `${s.worse} of ${s.unrelated}` : 'none replayed'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function hunkTitle(hunk: Hunk, login: (id: string | null) => string): string {
  switch (hunk.target) {
    case 'instructions': return hunk.op === 'add' ? 'Add a rule' : hunk.op === 'change' ? 'Reword a rule' : 'Delete a rule'
    case 'skill': return `${hunk.op === 'add' ? 'Add' : 'Change'} the skill ${hunk.skill_name}`
    case 'profile': return `Add to ${login(hunk.person_id)}'s profile`
    case 'check': return 'Make this a lint rule, type or check'
    case 'pipeline': return hunk.op === 'add' ? 'Add lines' : hunk.op === 'change' ? 'Change lines' : 'Remove lines'
  }
}

function HunkView({ hunk, deciding, login }: { hunk: Hunk; deciding: boolean; login: (id: string | null) => string }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const decide = (decision: 'accept' | 'reject') => act(async () => {
    setBusy(true)
    try {
      await api.decideHunk(hunk.id, decision, reason.trim() || undefined)
      setReason('')
    } finally {
      setBusy(false)
    }
  })
  return (
    <li className="hunk" aria-label={`Hunk ${hunk.n}`}>
      <p className="hunk-head"><strong>{hunk.n}. {hunkTitle(hunk, login)}</strong> <span className="muted small">{countsText(hunk.counts)}</span></p>
      {hunk.target === 'check'
        ? <p className="pre">{hunk.after}</p>
        : <details className="diff" open><summary className="small">The change</summary><Diff text={hunk.diff} label={`Hunk ${hunk.n}`} /></details>}
      <ul className="quotes" aria-label={`What hunk ${hunk.n} rests on`}>
        {hunk.evidence.map((q) => (
          <li key={q.finding}>
            <blockquote>{q.quote}</blockquote>
            <span className="muted small">{q.login ?? `a ${q.source} session`} · step {q.seq} · {KIND[q.kind]}{q.about ? `: ${q.about}` : ''}</span>
          </li>
        ))}
      </ul>
      {hunk.decision && (
        <p className="decision">
          <span aria-hidden="true">{hunk.decision === 'accepted' ? '✓' : '✕'} </span>
          <strong>{hunk.decision === 'accepted' ? 'Kept' : 'Turned down'}</strong> by {login(hunk.decided_by)}: {hunk.reason}
        </p>
      )}
      {deciding && (
        <div className="decide" role="group" aria-label={`Decide hunk ${hunk.n}`}>
          <input aria-label={`Why, for hunk ${hunk.n}`} placeholder="Why, needed to turn it down" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button type="button" disabled={busy} onClick={decide('accept')}>Keep</button>
          <button type="button" disabled={busy || !reason.trim()} onClick={decide('reject')}>Turn down</button>
        </div>
      )}
    </li>
  )
}
