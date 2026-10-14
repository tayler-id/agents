import { useMemo } from 'react'
import { byNumber, clock, useRows, useSnapshot, type EventRow, type Instance, type Session } from './data.ts'

const LABELS: Record<string, string> = {
  user: 'Message', assistant: 'Reply', thinking: 'Thinking', tool_call: 'Tool', tool_result: 'Result',
  ask: 'Asked', answer: 'Answer', notice: 'Notice', error: 'Error', usage: 'Turn ended',
}

// Everything one session did, in order, live.
export function EventList({ sessionId }: { sessionId: string }) {
  const { rows: events } = useRows<EventRow>('events', { session: sessionId })
  const sorted = useMemo(() => [...events].sort(byNumber((e: EventRow) => e.seq)), [events])
  return (
    <ol className="events" tabIndex={0} aria-label="Events">
      {sorted.filter((e) => e.kind !== 'notice' || e.body.subtype === 'init' || e.body.subtype === 'interrupted').map((e) => (
        <li key={String(e.id)} className={`event ${e.kind}${e.parent_tool_use_id ? ' sub' : ''}`}>
          <div className="meta">
            <span className="kicker">{e.body.subtype === 'interrupted' ? 'Interrupted' : LABELS[e.kind] ?? e.kind}{e.tool_name ? ` · ${e.tool_name}` : ''}</span>
            <span className="muted small">{clock(e.created_at)}</span>
          </div>
          {e.text && (e.text.length > 280
            ? <details><summary>{e.text.slice(0, 200)}…</summary><pre>{e.text}</pre></details>
            : <pre>{e.text}</pre>)}
        </li>
      ))}
    </ol>
  )
}

export function SessionPanel({ sessionId, of, onClose }: { sessionId: string; of: 'conversations' | 'tasks'; onClose: () => void }) {
  const { rows: sessions } = useRows<Session>('sessions', { of })
  const { rows: instances } = useSnapshot<Instance>('instances')
  const session = sessions.find((s) => s.id === sessionId)
  const machine = instances.find((i) => i.id === session?.instance_id)

  return (
    <aside className="panel" aria-label="Session details">
      <header className="panel-head">
        <div>
          <h2>Session</h2>
          {session && (
            <p className="muted small">
              {session.status.replace('_', ' ')} · {session.model ?? 'default model'} · {machine?.name ?? 'machine'} · {session.turns} turns
            </p>
          )}
        </div>
        <button type="button" className="ghost" onClick={onClose}>Close</button>
      </header>
      <EventList sessionId={sessionId} />
    </aside>
  )
}
