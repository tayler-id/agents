import { useEffect, useState } from 'react'
import { act, api, messageOf, useSnapshot, type Agent, type Ask, type Person, type Session } from './data.ts'
import type { MeView } from '../../shared/onboarding.ts'
import { NewAgentAsk as Asked } from '../../shared/team-agents.ts'

// An agent asking to make a new agent. Its owner says yes or no to exactly what it
// asked for, one agent at a time, since the API takes a yes only from them and
// makes the agent only with it. Everyone else reads whose answer it waits for.
export function NewAgentAsk({ ask }: { ask: Ask }) {
  const [me, setMe] = useState<MeView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    api.me().then(setMe, (e: unknown) => { setError(messageOf(e)) })
  }, [])
  // The ask names its session, whose agent asked, and that agent names its owner.
  const { rows: sessions } = useSnapshot<Session>('sessions', { of: ask.conversation_id ? 'conversations' : 'tasks' }, 10000)
  const { rows: agents } = useSnapshot<Agent>('agents', {}, 10000)
  const { rows: people } = useSnapshot<Person>('people', {}, 30000)
  const maker = agents.find((a) => a.id === sessions.find((s) => s.id === ask.session_id)?.agent_id)
  const owner = people.find((p) => p.id === maker?.owner_id)
  const wanted = Asked.safeParse(ask.payload.input)
  const answer = async (decision: 'allow' | 'deny') => {
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
  const mine = me?.kind === 'member' && maker !== undefined && maker.owner_id === me.person.id
  return (
    <section className="ask-card" aria-label="Asks to make an agent">
      <p className="kicker"><span aria-hidden="true">⏸</span> Asks to make an agent</p>
      {wanted.success ? (
        <>
          <p><strong>{maker?.name ?? 'An agent'}</strong> asks to make a new agent, <strong>{wanted.data.name}</strong>, for {owner ? owner.name ?? owner.login : 'its owner'}.</p>
          {wanted.data.title && <p className="muted small">{wanted.data.title}</p>}
          {wanted.data.instructions && <pre className="subject">{wanted.data.instructions}</pre>}
        </>
      ) : <p>An agent asks to make a new agent, and what it sent does not read as one: {wanted.error.issues[0]?.message ?? 'unreadable'}.</p>}
      {mine ? (
        <div className="actions">
          <button type="button" className="primary" disabled={busy} onClick={act(() => answer('allow'))}>Make it</button>
          <button type="button" disabled={busy} onClick={act(() => answer('deny'))}>Don't</button>
        </div>
      ) : <p className="muted small">Waiting for {owner ? owner.name ?? owner.login : "the agent's owner"} to say yes or no.</p>}
      {error && <p className="error small" role="alert">{error}</p>}
    </section>
  )
}
