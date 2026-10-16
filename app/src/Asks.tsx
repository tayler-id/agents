import { useState } from 'react'
import {
  act, api, type Ask,
} from './data.ts'
import { NewAgentAsk } from './NewAgentAsk.tsx'
import { CREATE_AGENT_TOOL } from '../../shared/team-agents.ts'

const OPTION_LABELS: Record<string, string> = {
  approve: 'Approve', reject: 'Reject', retry: 'Try again', stop: 'Stop, I will take over',
}

// Anything waiting on a person. A tool approval offers allow and deny; a
// pipeline's gate or hand-off offers its own options, with an optional note. An
// agent asking to make an agent has a card of its own, for its owner.
export function AskCard({ ask }: { ask: Ask }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const answer = async (decision: string) => {
    setBusy(true)
    setError('')
    try {
      await api.answer(ask.id, decision, note.trim() || undefined)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (ask.kind === 'tool_approval' && ask.payload.toolName === CREATE_AGENT_TOOL) return <NewAgentAsk ask={ask} />
  if (ask.kind === 'tool_approval') {
    const input = ask.payload.input ?? {}
    const subject = [input.command, input.file_path, input.path].find((v): v is string => typeof v === 'string') ?? ''
    return (
      <section className="ask-card" aria-label="Needs approval">
        <p className="kicker"><span aria-hidden="true">⏸</span> Needs approval</p>
        <p><strong>{ask.payload.toolName}</strong>{ask.payload.description ? ` · ${ask.payload.description}` : ''}</p>
        {subject && <pre className="subject">{subject}</pre>}
        <div className="actions">
          <button type="button" className="primary" disabled={busy} onClick={act(() => answer('allow'))}>Allow once</button>
          <button type="button" disabled={busy} onClick={act(() => answer('always'))}>Always allow</button>
          <button type="button" disabled={busy} onClick={act(() => answer('deny'))}>Deny</button>
          <button type="button" className="ghost" disabled={busy} onClick={act(() => answer('never'))}>Never</button>
        </div>
        {error && <p className="error small" role="alert">{error}</p>}
      </section>
    )
  }

  const options = ask.payload.options ?? []
  // A gate may name its buttons for what they do, such as Send back.
  const { labels } = ask.payload
  const labelOf = (option: string) => ((option === 'approve' || option === 'reject') && labels ? labels[option] : OPTION_LABELS[option] ?? option)
  return (
    <section className="ask-card" aria-label={ask.kind === 'gate' ? 'Needs a decision' : 'Needs a person'}>
      <p className="kicker"><span aria-hidden="true">⏸</span> {ask.kind === 'gate' ? 'Needs a decision' : 'Needs a person'}</p>
      <p>{ask.payload.question}</p>
      {!!ask.payload.links?.length && (
        <ul className="plain">
          {ask.payload.links.map((link) => (
            <li key={link.url}><a href={link.url} target="_blank" rel="noreferrer">{link.title}</a></li>
          ))}
        </ul>
      )}
      <label className="sr-only" htmlFor={`note-${ask.id}`}>Note</label>
      <input id={`note-${ask.id}`} className="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (optional)" />
      <div className="actions">
        {options.map((option, i) => (
          <button type="button" key={option} className={i === 0 ? 'primary' : undefined} disabled={busy} onClick={act(() => answer(option))}>
            {labelOf(option)}
          </button>
        ))}
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
    </section>
  )
}
