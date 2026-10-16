import { useEffect, useState } from 'react'
import { act, api, messageOf, type Ask } from './data.ts'
import type { MeView } from '../../shared/onboarding.ts'
import { NewAgentAsk as Asked, NewAgentQuestion } from '../../shared/team-agents.ts'

// A, B, C, for the choices in order.
const letter = (i: number) => String.fromCharCode('A'.charCodeAt(0) + i)

// An agent asking to make a new agent, as the question the ask carries and a
// lettered choice for each answer. Only the asking agent's owner chooses, since the
// API takes a yes only from them, and everyone else reads whose choice it waits for.
export function NewAgentAsk({ ask }: { ask: Ask }) {
  const [me, setMe] = useState<MeView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    api.me().then(setMe, (e: unknown) => { setError(messageOf(e)) })
  }, [])
  const asked = NewAgentQuestion.safeParse(ask.payload)
  const wanted = Asked.safeParse(ask.payload.input)
  const choose = async (decision: string) => {
    setBusy(true)
    setError('')
    try {
      await api.answer(ask.id, decision)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  if (!asked.success) return <section className="ask-card" aria-label="Asks to make an agent"><p className="error small">This ask did not arrive with its question.</p></section>
  const { question, choices, answerer } = asked.data
  const mine = me?.kind === 'member' && me.person.id === answerer.id
  return (
    <section className="ask-card" aria-label="Asks to make an agent">
      <p className="kicker"><span aria-hidden="true">⏸</span> Asks to make an agent</p>
      <p>{question}</p>
      {wanted.success && wanted.data.title && <p className="muted small">{wanted.data.title}</p>}
      {wanted.success && wanted.data.instructions && <pre className="subject">{wanted.data.instructions}</pre>}
      {mine && (
        <ol className="choices" aria-label="Choices">
          {choices.map((choice, i) => (
            <li key={choice.id}>
              <button type="button" disabled={busy} onClick={act(() => choose(choice.id))}>
                <span className="choice-letter" aria-hidden="true">{letter(i)}</span>{choice.label}
              </button>
            </li>
          ))}
        </ol>
      )}
      {me !== null && !mine && <p className="muted small">Waiting for {answerer.login} to choose.</p>}
      {error && <p className="error small" role="alert">{error}</p>}
    </section>
  )
}
