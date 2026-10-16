// Where a person sets one secret's value on one computer, in place. The state reads as text, and Set value or
// Replace value opens a masked field. Enter sends the value, Esc puts the field away, and leaving it keeps what
// was typed. Nothing here reads the record or calls the API. The card that holds it passes in what the record
// says and what each button does, so the agent panel can give it its own look.
//
// A value is sent on Enter alone. Other settings save when the person leaves them, but the app never holds a
// value, so it cannot put one back, and a half-pasted value must not replace a good one. A computer that is not
// running is started by the request, which waits for it for up to 90 seconds, and the control says so meanwhile.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { messageOf } from '../../shared/errors.ts'
import './SecretValue.css'

// What the record says about the value on the computer: when the app put it there, and who did. `by` is a
// login, or "you" for the person using this card.
export type SecretHeld = { at: Date; by: string }

type Props = {
  // The secret's name, such as SENTRY_TOKEN, which names each control for a screen reader.
  name: string
  // The computer's name.
  computer: string
  held: SecretHeld | null
  // Why no one here may put a value on the computer, in words, or null. The words show, and no control does.
  blocked: string | null
  // Whether the computer is not running. A request for one starts it first, and the control says so while it waits.
  asleep: boolean
  // Puts a value on the computer and answers with when it took it. Rejects with the reason it did not.
  set: (value: string) => Promise<Date>
  // Takes the value off the computer. Rejects with the reason it did not.
  remove: () => Promise<void>
}

// What this card just did, shown until the record says the same.
type Recent = { kind: 'set'; at: Date } | { kind: 'removed'; was: number | undefined }

const caughtUp = (recent: Recent, held: SecretHeld | null): boolean =>
  recent.kind === 'set' ? held !== null && held.at.getTime() >= recent.at.getTime() : held?.at.getTime() !== recent.was

const day = (at: Date) => at.toLocaleDateString([], { month: 'short', day: 'numeric' })
const clock = (at: Date) => at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export function SecretValue({ name, computer, held, blocked, asleep, set, remove }: Props) {
  const [recent, setRecent] = useState<Recent | null>(null)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  // What a request in flight is for, or null.
  const [doing, setDoing] = useState<'save' | 'remove' | null>(null)
  const [error, setError] = useState('')
  const [asking, setAsking] = useState(false)
  const field = useRef<HTMLInputElement | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  // Set when a key or Cancel puts the field away, so the cursor goes back to the button that opened it.
  const refocus = useRef(false)
  const hint = useId()
  // Once the record says what this card did, the record speaks.
  let current = recent
  if (current && caughtUp(current, held)) {
    setRecent(null)
    current = null
  }
  const shown: SecretHeld | null = current ? (current.kind === 'set' ? { at: current.at, by: 'you' } : null) : held
  const busy = doing !== null

  // The field takes the cursor when it opens, and the button that opened it takes it back when the field is put away.
  useEffect(() => {
    if (editing) {
      field.current?.focus()
    } else if (refocus.current) {
      refocus.current = false
      opener.current?.focus()
    }
  }, [editing])
  const close = () => {
    refocus.current = true
    setText('')
    setError('')
    setEditing(false)
  }
  const run = async (what: 'save' | 'remove', action: () => Promise<void>) => {
    setDoing(what)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setDoing(null)
    }
  }
  const send = () => run('save', async () => {
    const at = await set(text)
    setRecent({ kind: 'set', at })
    close()
  })
  const take = () => run('remove', async () => {
    await remove()
    setRecent({ kind: 'removed', was: held?.at.getTime() })
    setAsking(false)
  })
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (!busy) close()
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (text && !busy) void send()
    }
  }
  // Leaving an empty field puts it away. Leaving one with a value in it leaves it as it is.
  const leave = () => {
    if (!text && !busy) setEditing(false)
  }

  return (
    <div className="secret-value">
      <p className="small" role="status">
        {shown
          ? <><span className="glyph" aria-hidden="true">✓</span> Set on {computer}, {day(shown.at)}, {clock(shown.at)}, by {shown.by}</>
          : `Not set from the app on ${computer}`}
      </p>
      {blocked !== null && <p className="small">{blocked}</p>}
      {busy && asleep && <p className="small" role="status">Starting {computer}'s computer to {doing} the key</p>}
      {blocked === null && (editing
        ? (
          <span className="secret-edit">
            <input
              ref={field} type="password" value={text} placeholder="Paste the value" aria-label={`Value of ${name}`} aria-describedby={hint}
              autoComplete="off" spellCheck={false} data-1p-ignore="true" enterKeyHint="done" readOnly={busy} aria-busy={busy}
              onChange={(e) => { setText(e.target.value); setError('') }} onKeyDown={keys} onBlur={leave}
            />
            <button type="button" className="link small" disabled={busy} onClick={close}>Cancel</button>
            <span id={hint} className="muted small">Enter sets it, Esc cancels</span>
          </span>
        )
        : (
          <span className="secret-actions">
            <button ref={opener} type="button" className="link small" disabled={busy} aria-label={`${shown ? 'Replace' : 'Set'} value of ${name}`} onClick={() => { setEditing(true) }}>
              {shown ? 'Replace value' : 'Set value'}
            </button>
            {shown && !asking && (
              <button type="button" className="link small" disabled={busy} aria-label={`Remove value of ${name}`} onClick={() => { setAsking(true) }}>Remove</button>
            )}
            {shown && asking && (
              <span className="confirm">
                <span className="small">Remove it from {computer}?</span>
                <button type="button" className="link small" disabled={busy} onClick={() => { void take() }}>Yes, remove</button>
                <button type="button" className="link small" onClick={() => { setAsking(false) }}>Keep</button>
              </span>
            )}
          </span>
        ))}
      {error && <p className="error small" role="alert">{error}</p>}
    </div>
  )
}
