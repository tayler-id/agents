// A seat's screen on a box, live, beside the work it runs. Anyone who may watch
// sees it; one person at a time can take over its keyboard and mouse, which
// pauses that seat's agent, and hand it back. The screen arrives over a
// WebSocket that tailscale serve passes to the API. The design is
// docs/design/computers.md.

import { useEffect, useRef, useState } from 'react'
import RFB, { type RfbChannel } from '@novnc/novnc'
import { handoff, ScreenClose, ScreenMoved, ToViewer, type ScreenControl } from '../../shared/screen.ts'
import { PersonId } from '../../shared/ids.ts'
import { parseJson } from '../../shared/json.ts'
import { FIRST_SEAT, SeatRow } from '../../shared/seats.ts'
import { act, call, messageOf, useRows, useSnapshot, useSnapshotOf, type Instance, type Me, type Session } from './data.ts'

// Which screen to show: a seat by its number, or the seat a session runs on.
export type ScreenTarget = { seat: number } | { session: string; of: 'conversations' | 'tasks' }

// Takes over a seat's screen or hands it back, and resolves with who holds it now.
const moveScreen = async (instanceId: string, seat: number, action: 'take' | 'hand-back', sessionId: string | null) =>
  (await call(ScreenMoved, 'POST', `/v1/screens/${instanceId}/seats/${seat}/${action}`, { sessionId })).control

// The view's connection to the screen.
type Link = { phase: 'connecting' } | { phase: 'live' } | { phase: 'closed'; reason: string }

// A WebSocket that hands the screen's binary frames to noVNC, and keeps for the
// view the text frames that say who holds the screen.
class ScreenChannel implements RfbChannel {
  binaryType: BinaryType = 'arraybuffer'
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private readonly socket: WebSocket

  constructor(url: string, onControl: (control: ScreenControl) => void, onClosed: (reason: string) => void) {
    this.socket = new WebSocket(url)
    this.socket.binaryType = 'arraybuffer'
    this.socket.onopen = (event) => { this.onopen?.(event) }
    this.socket.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string') {
        this.onmessage?.(event)
        return
      }
      const message = parseJson(ToViewer, event.data)
      if (message.ok) onControl(message.value.control)
      else this.socket.close(ScreenClose.unreadable, 'the app could not read who holds the screen')
    }
    this.socket.onclose = (event) => {
      // The API closes with a sentence for the person. Anything else is the network.
      onClosed(event.reason || 'The connection to the screen dropped.')
      this.onclose?.(event)
    }
    this.socket.onerror = (event) => { this.onerror?.(event) }
  }

  get protocol() { return this.socket.protocol }
  get readyState() { return this.socket.readyState }
  send(data: ArrayBufferLike | ArrayBufferView) { this.socket.send(data) }
  close() { this.socket.close() }
}

type PanelProps = { me: Me; instanceId: string; target: ScreenTarget; onClose: () => void }

export function ScreenPanel({ me, instanceId, target, onClose }: PanelProps) {
  if ('seat' in target) return <SeatScreen me={me} instanceId={instanceId} seat={target.seat} sessionId={null} onClose={onClose} />
  return <SessionScreen me={me} instanceId={instanceId} sessionId={target.session} of={target.of} onClose={onClose} />
}

// The screen of the seat a session runs on. A box session with no seat ran on
// seat 1, as every session on a box did before seats.
function SessionScreen({ me, instanceId, sessionId, of, onClose }: {
  me: Me; instanceId: string; sessionId: string; of: 'conversations' | 'tasks'; onClose: () => void
}) {
  const { rows: sessions, loading } = useRows<Session>('sessions', { of })
  const { rows: seats, loaded } = useSnapshotOf(SeatRow, 'seats')
  const session = sessions.find((s) => s.id === sessionId)
  const seat = session?.seat_id === null ? FIRST_SEAT : seats.find((s) => s.id === session?.seat_id)?.n
  if (seat === undefined) {
    const waiting = loading || !loaded || session !== undefined
    return (
      <aside className="panel screen-panel" aria-label="Screen">
        <p className="muted small screen-status" role="status">{waiting ? 'Finding the seat this session runs on…' : 'This session is not one you can see.'}</p>
      </aside>
    )
  }
  return <SeatScreen key={seat} me={me} instanceId={instanceId} seat={seat} sessionId={sessionId} onClose={onClose} />
}

function SeatScreen({ me, instanceId, seat, sessionId, onClose }: { me: Me; instanceId: string; seat: number; sessionId: string | null; onClose: () => void }) {
  // Reconnecting mounts a fresh live view.
  const [attempt, setAttempt] = useState(0)
  return <LiveScreen key={attempt} me={me} instanceId={instanceId} seat={seat} sessionId={sessionId} onClose={onClose} onReconnect={() => setAttempt((n) => n + 1)} />
}

function LiveScreen({ me, instanceId, seat, sessionId, onClose, onReconnect }: {
  me: Me; instanceId: string; seat: number; sessionId: string | null; onClose: () => void; onReconnect: () => void
}) {
  const { rows: instances } = useSnapshot<Instance>('instances')
  const instance = instances.find((i) => i.id === instanceId)
  const target = useRef<HTMLDivElement>(null)
  const client = useRef<RFB | null>(null)
  const [link, setLink] = useState<Link>({ phase: 'connecting' })
  const [control, setControl] = useState<ScreenControl | null>(null)
  const [error, setError] = useState('')
  const mine = PersonId.parse(me.person.id)
  const holding = control?.holder === 'person' && control.personId === mine

  useEffect(() => {
    const element = target.current
    if (!element) return
    const url = `${window.location.origin.replace(/^http/, 'ws')}/v1/screens/${instanceId}/seats/${seat}`
    const channel = new ScreenChannel(url, setControl, (reason) => { setLink({ phase: 'closed', reason }) })
    const rfb = new RFB(element, channel, { shared: true })
    rfb.scaleViewport = true
    rfb.resizeSession = false
    rfb.viewOnly = true
    rfb.background = 'transparent'
    rfb.addEventListener('connect', () => { setLink({ phase: 'live' }) })
    client.current = rfb
    return () => {
      client.current = null
      rfb.disconnect()
    }
  }, [instanceId, seat])

  // Only the person holding the screen sends input. The API drops anyone else's.
  useEffect(() => {
    const rfb = client.current
    if (!rfb) return
    rfb.viewOnly = !holding
    if (holding) rfb.focus()
  }, [holding, link])

  // The state machine the server runs decides which action this person has.
  const take = control && handoff(control, { kind: 'take', personId: mine, login: me.person.login, at: new Date().toISOString() })
  const canTake = take?.ok === true && take.change === 'took_over'
  const canHandBack = control !== null && handoff(control, { kind: 'hand_back', personId: mine }).ok
  const move = async (action: 'take' | 'hand-back') => {
    setError('')
    try {
      setControl(await moveScreen(instanceId, seat, action, sessionId))
    } catch (e) {
      setError(messageOf(e))
    }
  }

  const name = `${instance?.name ?? 'Box'}, seat ${seat}`
  const who = !control ? 'Connecting…'
    : control.holder === 'agent' ? 'The agent has the screen.'
      : holding ? 'You have the screen. Your keys and clicks go to the box.' : `${control.login} has the screen.`
  return (
    <aside className="panel screen-panel" aria-label="Screen">
      <header className="panel-head">
        <div>
          <h2>Screen</h2>
          <p className="muted small">{name}{instance?.screen_width ? ` · ${instance.screen_width} × ${instance.screen_height}` : ''}</p>
        </div>
        <div className="head-actions">
          {link.phase === 'live' && canTake && <button type="button" className="primary" onClick={act(() => move('take'))}>Take over</button>}
          {link.phase === 'live' && canHandBack && <button type="button" onClick={act(() => move('hand-back'))}>Hand back</button>}
          <button type="button" className="ghost" onClick={onClose}>Close</button>
        </div>
      </header>
      {link.phase === 'closed'
        ? (
          <div className="screen-status" role="status">
            <p>{link.reason}</p>
            <button type="button" className="link small" onClick={onReconnect}>Reconnect</button>
          </div>
        )
        : (
          <p className={`screen-status small${holding ? ' holding' : ''}`} role="status">
            <span className={`dot ${link.phase === 'live' ? 'online' : 'offline'}`} aria-hidden="true" />
            {link.phase === 'live' ? who : 'Connecting…'}
          </p>
        )}
      {error && <p className="error small screen-error" role="alert">{error}</p>}
      <div className="screen" ref={target} role="region" aria-label={`The screen of ${name}`} />
    </aside>
  )
}
