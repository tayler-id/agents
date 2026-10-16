import { useId, useState, type SyntheticEvent } from 'react'
import { mayPutOn, SecretRemoved, SecretRow, SecretSetRow, SecretStored } from '../../shared/secrets.ts'
import { call, clock, day, messageOf, parseTime, useSnapshot, useSnapshotOf, type Agent, type Instance, type Me, type Person } from './data.ts'
import './Secrets.css'

// How often the lists are read again. A value just set or removed shows at once,
// from the answer to the request, and the lists catch up.
const REFRESH_MS = 2500
const PEOPLE_MS = 30_000

// What this page just did to a secret, shown until the lists show it too. A
// value set is shown while the list has no newer one, and one removed while the
// list still has the value it had when it was removed.
type Recent = { kind: 'set'; at: string } | { kind: 'removed'; was: string | null }

type Held = { at: string; by: string | null }

function heldNow(row: SecretSetRow | undefined, recent: Recent | undefined): Held | null {
  const later = (a: string, b: string) => (parseTime(a)?.getTime() ?? 0) > (parseTime(b)?.getTime() ?? 0)
  if (recent?.kind === 'set' && (!row || later(recent.at, row.set_at))) return { at: recent.at, by: null }
  if (recent?.kind === 'removed' && (!row || row.set_at === recent.was)) return null
  return row ? { at: row.set_at, by: row.set_by } : null
}

// The secrets an agent's plugins name. A person sets each one's value here, and it
// goes to the agent's computer and nowhere else. The app keeps the name, where it
// is set and when, never the value. A value put on the computer by hand, or in the
// daemon's environment, works as well, and shows here as not set from the app. An
// agent with no secrets shows nothing. The section sits under the profile, since a
// value is what a stopped agent is waiting for, and the page scrolls inside its body.
export function AgentSecrets({ agent, me }: { agent: Agent; me: Me }) {
  const { rows: secrets, error } = useSnapshotOf(SecretRow, 'secrets', {}, REFRESH_MS)
  const { rows: sets } = useSnapshotOf(SecretSetRow, 'secret_sets', {}, REFRESH_MS)
  const { rows: instances } = useSnapshot<Instance>('instances', {}, REFRESH_MS)
  const { rows: people } = useSnapshot<Person>('people', {}, PEOPLE_MS)
  const [recent, setRecent] = useState<Record<string, Recent>>({})
  const mine = secrets.filter((secret) => secret.scope === 'agent' && secret.agent_id === agent.id).sort((a, b) => a.name.localeCompare(b.name))
  const computer = instances.find((instance) => instance.id === agent.home_instance_id)
  // A person not loaded yet reads as someone.
  const login = (id: string) => people.find((p) => p.id === id)?.login ?? 'someone'
  if (!mine.length && !error) return null
  return (
    <>
      <h2 className="kicker section">Secrets</h2>
      {error && <p className="error small" role="alert">{error}</p>}
      {!!mine.length && (
        <p className="muted small">
          {computer ? `A value you set here goes to ${computer.name}, where the agent runs, and nowhere else.` : 'This agent has no computer, so a value cannot be set.'}
          {' '}The app keeps only its name, where it is set and when. A value already in the computer's secrets.json or in its daemon's environment works without being set here.
        </p>
      )}
      {!!mine.length && (
        <ul className="secrets">
          {mine.map((secret) => {
            const row = computer ? sets.find((s) => s.instance_id === computer.id && s.name === secret.name) : undefined
            return (
              <SecretLine
                key={secret.id} secret={secret} computer={computer} held={heldNow(row, recent[secret.id])} login={login}
                mayPut={computer !== undefined && mayPutOn(computer.owner_id, me.person.id)}
                done={(what) => { setRecent((now) => ({ ...now, [secret.id]: what === 'removed' ? { kind: 'removed', was: row?.set_at ?? null } : { kind: 'set', at: what.at } })) }}
              />
            )
          })}
        </ul>
      )}
    </>
  )
}

function SecretLine({ secret, computer, mayPut, held, login, done }: {
  secret: SecretRow; computer: Instance | undefined; mayPut: boolean; held: Held | null; login: (id: string) => string
  done: (what: 'removed' | { at: string }) => void
}) {
  const field = useId()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [asking, setAsking] = useState(false)
  const stopped = computer?.status === 'offline'
  const silent = computer?.status === 'stale'
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  const set = (event: SyntheticEvent) => {
    event.preventDefault()
    void run(async () => {
      const stored = await call(SecretStored, 'POST', `/v1/secrets/${secret.id}/value`, { value: text })
      setText('')
      done({ at: stored.setAt })
    })
  }
  const remove = () => run(async () => {
    await call(SecretRemoved, 'POST', `/v1/secrets/${secret.id}/remove`, {})
    setAsking(false)
    done('removed')
  })
  const when = held ? `${day(held.at)}, ${clock(held.at)}` : ''
  const where = computer?.name ?? 'its computer'
  return (
    <li>
      <div className="secret-head">
        <code className="secret-name">{secret.name}</code>
        {secret.description && <span className="muted small">{secret.description}</span>}
      </div>
      <p className="small secret-state" role="status">
        {held ? <><span className="glyph" aria-hidden="true">✓</span> Set on {where}, {when}, by {held.by ? login(held.by) : 'you'}</> : `Not set from the app on ${where}`}
      </p>
      {stopped && <p className="small">{where} is stopped, so it can't take a value now. Set it once the computer is running.</p>}
      {silent && <p className="small">{where} has stopped answering the server. A value may not reach it until it is back.</p>}
      {computer && !mayPut && computer.owner_id !== null && (
        <p className="small">{where} is {login(computer.owner_id)}'s own computer, so only they can set a value on it.</p>
      )}
      {computer && mayPut && (
        <form className="secret-form" onSubmit={set} aria-label={`${held ? 'Replace' : 'Set'} ${secret.name}`}>
          <label className="sr-only" htmlFor={field}>Value of {secret.name}</label>
          <input
            id={field} type="password" value={text} onChange={(e) => { setText(e.target.value) }} placeholder="Paste the value"
            autoComplete="off" spellCheck={false} data-1p-ignore="true" disabled={busy || stopped}
          />
          <button type="submit" className="primary" disabled={busy || stopped || !text}>{held ? 'Replace value' : 'Set value'}</button>
          {held && !asking && <button type="button" className="link small" disabled={busy || stopped} onClick={() => { setAsking(true) }}>Remove</button>}
          {held && asking && (
            <span className="confirm">
              <span className="small">Remove it from {where}?</span>
              <button type="button" className="link small" disabled={busy} onClick={() => { void remove() }}>Yes, remove</button>
              <button type="button" className="link small" onClick={() => { setAsking(false) }}>Keep</button>
            </span>
          )}
        </form>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
    </li>
  )
}
