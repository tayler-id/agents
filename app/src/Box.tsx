import { useState, type ReactNode, type SyntheticEvent } from 'react'
import { ClaudeLoginRow } from '../../shared/onboarding.ts'
import { go } from './App.tsx'
import { act, api, messageOf, parseTime, useSnapshot, useSnapshotOf, type Instance, type Me } from './data.ts'
import { boxState } from './Team.tsx'

// How often the box page looks again while a box starts or a sign-in moves on.
const BOX_POLL_MS = 3000
const LOGIN_POLL_MS = 2000

const longDate = (text: string) => parseTime(text)?.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) ?? text

// The person's own box, and their newest Claude sign-in on it.
function useOwnBox(me: Me) {
  const { rows: instances } = useSnapshot<Instance>('instances', {}, BOX_POLL_MS)
  const { rows: logins, error } = useSnapshotOf(ClaudeLoginRow, 'claude_logins', {}, LOGIN_POLL_MS)
  const box = instances.find((i) => i.personal && i.owner_id === me.person.id) ?? null
  const login = box ? logins.filter((l) => l.instance_id === box.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null : null
  return { box, login, error }
}

// What a newcomer sees in place of the welcome text until their box is ready and
// they are signed in to Claude. Anyone else sees the welcome text.
export function GettingStarted({ me, children }: { me: Me; children: ReactNode }) {
  const { box, login } = useOwnBox(me)
  if (!box || (box.status === 'online' && login?.status === 'signed_in')) return children
  const state = boxState(box)
  return (
    <section className="getting-started" aria-label="Getting started">
      <p className="kicker">Welcome to {me.team.name}</p>
      <h1>A few steps and you are working</h1>
      <ol className="steps">
        <li className="done"><span className="glyph" aria-hidden="true">✓</span><span>You joined the team.</span></li>
        <li className={state === 'ready' ? 'done' : 'now'}>
          <span className="glyph" aria-hidden="true">{state === 'ready' ? '✓' : '·'}</span>
          <span>{state === 'ready' ? `Your box, ${box.name}, is ready.` : state === 'starting' ? `Your box, ${box.name}, is starting.` : `Your box, ${box.name}, could not start.`}</span>
        </li>
        <li className={login?.status === 'signed_in' ? 'done' : ''}>
          <span className="glyph" aria-hidden="true">{login?.status === 'signed_in' ? '✓' : '·'}</span>
          <span>{login?.status === 'signed_in' ? 'You signed in to Claude.' : 'Sign in to your Claude account, so agents on your box run on it.'}</span>
        </li>
        <li><span className="glyph" aria-hidden="true">·</span><span>Make your first agent on your box.</span></li>
      </ol>
      <p><button type="button" className="primary" onClick={() => go({ page: 'box' })}>Set up your box</button></p>
    </section>
  )
}

export function BoxPage({ me }: { me: Me }) {
  const { box, login, error } = useOwnBox(me)
  const [problem, setProblem] = useState('')
  const make = async () => {
    setProblem('')
    try {
      await api.makeBox()
    } catch (e) {
      setProblem(messageOf(e))
    }
  }
  return (
    <section className="page" aria-label="Your box">
      <header className="page-head">
        <div>
          <p className="kicker">Your box</p>
          <h1>{box ? box.name : 'No box yet'}</h1>
          <p className="muted small">A machine of your own where your agents run, on your own Claude account.</p>
        </div>
      </header>
      <div className="page-body">
        {!box && (
          <>
            <p>You joined before boxes were made for everyone who joins.</p>
            <p><button type="button" className="primary" onClick={act(make)}>Make my box</button></p>
          </>
        )}
        {box && <BoxState box={box} />}
        {box && <ClaudeSignIn box={box} login={login} />}
        {box && (
          <>
            <h2 className="kicker section">Agents</h2>
            <p>Agents you make with your box as their machine run here, on your Claude account.{' '}
              <button type="button" className="link" onClick={() => go({ create: 'agent' })}>Make an agent on your box</button></p>
          </>
        )}
        {(problem || error) && <p className="error small" role="alert">{problem || error}</p>}
      </div>
    </section>
  )
}

function BoxState({ box }: { box: Instance }) {
  const state = boxState(box)
  return (
    <>
      <h2 className="kicker section">Box</h2>
      <p className="box-state" role="status">
        <span className={`dot ${state === 'ready' ? 'online' : state === 'starting' ? 'starting' : 'failed'}`} aria-hidden="true" />
        {state === 'ready' ? 'Ready.' : state === 'starting' ? 'Starting. This takes under a minute.' : 'It could not start.'}
      </p>
      {box.start_error && (
        <>
          <p className="small box-reason">Docker said: <code>{box.start_error}</code></p>
          <p className="small muted">The server keeps trying to start it. An admin can look at the server.</p>
        </>
      )}
    </>
  )
}

function ClaudeSignIn({ box, login }: { box: Instance; login: ClaudeLoginRow | null }) {
  const [code, setCode] = useState('')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setProblem('')
    try {
      await action()
    } catch (e) {
      setProblem(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  const start = () => run(() => api.startClaudeLogin())
  const send = async (event: SyntheticEvent) => {
    event.preventDefault()
    if (!login) return
    await run(async () => {
      await api.sendClaudeCode(login.id, code.trim())
      setCode('')
    })
  }
  const cancel = () => (login ? run(() => api.cancelClaudeLogin(login.id)) : Promise.resolve())
  // A sign-in runs on the box, so one that could not start has nothing to run it.
  const stopped = boxState(box) === 'could not start'
  return (
    <>
      <h2 className="kicker section">Claude</h2>
      <div className="sign-in" aria-label="Claude sign-in">
        {(!login || login.status === 'cancelled') && stopped && (
          <p>Agents on your box run on your own Claude account. You can sign in once your box is running.</p>
        )}
        {(!login || login.status === 'cancelled') && !stopped && (
          <>
            <p>Agents on your box run on your own Claude account. Sign in once, and the sign-in lasts a year.</p>
            <p><button type="button" className="primary" disabled={busy} onClick={act(start)}>Sign in to Claude</button></p>
          </>
        )}
        {login?.status === 'starting' && (
          <>
            <p role="status">Getting a sign-in link from your box{box.status === 'online' ? '' : stopped ? ', once it starts' : ', which is still starting'}.</p>
            <p><button type="button" className="link small" onClick={act(cancel)}>Cancel</button></p>
          </>
        )}
        {login?.status === 'waiting_for_code' && (
          <>
            {login.note && <p className="note-line" role="status">{login.note}</p>}
            <ol className="steps">
              <li><span className="glyph" aria-hidden="true">1</span>
                <span><a href={login.url} target="_blank" rel="noreferrer">Open Claude's sign-in page</a> in a new tab.</span></li>
              <li><span className="glyph" aria-hidden="true">2</span><span>Sign in with your Claude account and approve.</span></li>
              <li><span className="glyph" aria-hidden="true">3</span><span>Copy the code the page shows, and paste it here.</span></li>
            </ol>
            <form className="form fitted" onSubmit={act(send)} aria-label="Claude code">
              <label htmlFor="claude-code">Code from Claude's page</label>
              <input id="claude-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} />
              <div className="actions">
                <button type="submit" className="primary" disabled={busy || !code.trim()}>Send code</button>
                <button type="button" className="link small" onClick={act(cancel)}>Cancel</button>
              </div>
            </form>
          </>
        )}
        {login?.status === 'checking' && (
          <>
            <p role="status">Your box is checking the code with Claude.</p>
            <p><button type="button" className="link small" onClick={act(cancel)}>Cancel</button></p>
          </>
        )}
        {login?.status === 'signed_in' && (
          <>
            <p className="note-line" role="status"><span className="glyph" aria-hidden="true">✓</span> Signed in to Claude. Agents on your box run on your account.</p>
            <p className="small muted">The sign-in lasts until {longDate(login.valid_until)}. The token stays on your box.</p>
            <p><button type="button" className="link small" disabled={busy} onClick={act(start)}>Sign in again</button></p>
          </>
        )}
        {login?.status === 'failed' && (
          <>
            <p role="status">The sign-in did not finish. {login.note}</p>
            <p><button type="button" className="primary" disabled={busy} onClick={act(start)}>Try again</button></p>
          </>
        )}
        {problem && <p className="error small" role="alert">{problem}</p>}
      </div>
    </>
  )
}
