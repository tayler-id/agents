import { useMemo } from 'react'
import { isShownStep, STEP_LABELS } from '../../shared/history.ts'
import { byNumber, clock, useRows, useSnapshot, type EventRow, type Instance, type Session } from './data.ts'

const LABELS: Record<string, string> = STEP_LABELS

// Everything one session did, in order, live.
export function EventList({ sessionId }: { sessionId: string }) {
  const { rows: events } = useRows<EventRow>('events', { session: sessionId })
  const sorted = useMemo(() => [...events].sort(byNumber((e: EventRow) => e.seq)), [events])
  return (
    <ol className="events" tabIndex={0} aria-label="Events">
      {sorted.filter((e) => isShownStep(e.kind, e.body.subtype)).map((e) => (
        <li key={String(e.id)} className={`event ${e.kind}${e.parent_tool_use_id ? ' sub' : ''}`}>
          <div className="meta">
            <span className="kicker">{e.body.subtype === 'interrupted' ? 'Interrupted' : e.body.subtype === 'hook_response' ? 'Hook' : LABELS[e.kind] ?? e.kind}{e.tool_name ? ` · ${e.tool_name}` : ''}</span>
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

// A session's state and its events. A session on a machine with a screen can
// open that screen in its place.
export function SessionPanel({ sessionId, of, onClose, onScreen }: {
  sessionId: string; of: 'conversations' | 'tasks'; onClose: () => void; onScreen: (instanceId: string, sessionId: string) => void
}) {
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
        <div className="head-actions">
          {machine && machine.screen_width !== null && <button type="button" className="ghost" onClick={() => onScreen(machine.id, sessionId)}>Screen</button>}
          <button type="button" className="ghost" onClick={onClose}>Close</button>
        </div>
      </header>
      <EventList sessionId={sessionId} />
    </aside>
  )
}
