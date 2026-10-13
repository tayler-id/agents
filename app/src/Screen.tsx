// A box's screen, live, beside the work it runs. Anyone who may watch sees it;
// one person at a time can take over its keyboard and mouse, which pauses the
// agent's use of it, and hand it back. The screen arrives over a WebSocket on
// the people port. The design is docs/design/computers.md.

import { useEffect, useRef, useState } from 'react'
import RFB, { type RfbChannel } from '@novnc/novnc'
import { handoff, ScreenMoved, ToViewer, type ScreenControl } from '../../shared/screen.ts'
import { PersonId } from '../../shared/ids.ts'
import { parseJson } from '../../shared/json.ts'
import { act, call, messageOf, useSnapshot, type Instance, type Me } from './data.ts'

// Takes over a box's screen or hands it back, and resolves with who holds it now.
const moveScreen = async (instanceId: string, action: 'take' | 'hand-back', sessionId: string | null) =>
  (await call(ScreenMoved, 'POST', `/v1/screens/${instanceId}/${action}`, { sessionId })).control

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
      else this.socket.close(4000, 'the app could not read who holds the screen')
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

export function ScreenPanel({ me, instanceId, sessionId, onClose }: { me: Me; instanceId: string; sessionId: string | null; onClose: () => void }) {
  // Reconnecting mounts a fresh live view.
  const [attempt, setAttempt] = useState(0)
  return <LiveScreen key={attempt} me={me} instanceId={instanceId} sessionId={sessionId} onClose={onClose} onReconnect={() => setAttempt((n) => n + 1)} />
}

function LiveScreen({ me, instanceId, sessionId, onClose, onReconnect }: {
  me: Me; instanceId: string; sessionId: string | null; onClose: () => void; onReconnect: () => void
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
    const url = `${window.location.origin.replace(/^http/, 'ws')}/v1/screens/${instanceId}`
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
  }, [instanceId])

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
      setControl(await moveScreen(instanceId, action, sessionId))
    } catch (e) {
      setError(messageOf(e))
    }
  }

  const who = !control ? 'Connecting…'
    : control.holder === 'agent' ? 'The agent has the screen.'
      : holding ? 'You have the screen. Your keys and clicks go to the box.' : `${control.login} has the screen.`
  return (
    <aside className="panel screen-panel" aria-label="Screen">
      <header className="panel-head">
        <div>
          <h2>Screen</h2>
          <p className="muted small">{instance?.name ?? 'Box'}{instance?.screen_width ? ` · ${instance.screen_width} × ${instance.screen_height}` : ''}</p>
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
      <div className="screen" ref={target} role="region" aria-label={`The screen of ${instance?.name ?? 'the box'}`} />
    </aside>
  )
}
