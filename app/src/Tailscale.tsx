import { useEffect, useState, type SyntheticEvent } from 'react'
import {
  KEY_WARNING_DAYS, NEW_KEY_HOWTO, TailscaleRole,
  type TailnetDevice, type TailnetInvite, type TailnetUser, type TailscaleView,
} from '../../shared/onboarding.ts'
import { act, api, day, messageOf, type Me } from './data.ts'
import { LinkField } from './LinkField.tsx'

// How often the sidebar and the Team page look again at the Tailscale key, to
// warn admins before it expires. The key changes rarely.
const KEY_POLL_MS = 60_000

// The Tailscale key's status for admins, read again now and then. Null for
// members, who are never told about the key.
export function useTailscaleView(admin: boolean): TailscaleView | null {
  const [view, setView] = useState<TailscaleView | null>(null)
  useEffect(() => {
    if (!admin) return
    let stopped = false
    const load = () => {
      api.tailscale().then((next) => { if (!stopped) setView(next) }, (error: unknown) => {
        // The warning is a reminder. Without it the Tailscale page still says what went wrong.
        console.error('the Tailscale key status:', messageOf(error))
      })
    }
    load()
    const timer = setInterval(load, KEY_POLL_MS)
    return () => { stopped = true; clearInterval(timer) }
  }, [admin])
  return admin ? view : null
}

const keyDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })

// What admins are told about the key from KEY_WARNING_DAYS before it expires,
// or null until then and when its expiry is not known.
export function keyWarning(view: TailscaleView | null): { short: string; full: string } | null {
  if (view?.state !== 'connected' || view.daysLeft === null || view.expires === null || view.daysLeft > KEY_WARNING_DAYS) return null
  if (view.daysLeft < 0) {
    return {
      short: 'The Tailscale key has expired',
      full: `The Tailscale key expired on ${keyDate(view.expires)}. Invites and the Tailscale page stop working until it is replaced.`,
    }
  }
  const days = `${view.daysLeft} ${view.daysLeft === 1 ? 'day' : 'days'}`
  return { short: `The Tailscale key expires in ${days}`, full: `The Tailscale key expires in ${days}, on ${keyDate(view.expires)}.` }
}

export function KeyWarning({ view }: { view: TailscaleView | null }) {
  const warning = keyWarning(view)
  if (!warning) return null
  return (
    <div className="notice" role="note" aria-label="Tailscale key">
      <p className="kicker">Tailscale key</p>
      <p className="note-line">{warning.full}</p>
      <p className="small">{NEW_KEY_HOWTO}</p>
    </div>
  )
}

export function TailscalePage({ me }: { me: Me }) {
  return (
    <section className="page" aria-label="Tailscale">
      <header className="page-head">
        <div>
          <p className="kicker">Tailscale</p>
          <h1>The tailnet</h1>
          <p className="muted small">Its users, devices and invites, as Tailscale has them now.</p>
        </div>
      </header>
      <div className="page-body">
        {me.person.role === 'admin' ? <Tailnet /> : <p>Only team admins manage the tailnet.</p>}
      </div>
    </section>
  )
}

type TailnetNow = { view: TailscaleView; users: TailnetUser[]; devices: TailnetDevice[]; invites: TailnetInvite[] }

// The key's status, and with a key, the tailnet's users, devices and invites.
async function readTailnet(): Promise<TailnetNow> {
  const view = await api.tailscale()
  if (view.state !== 'connected') return { view, users: [], devices: [], invites: [] }
  const [u, d, i] = await Promise.all([api.tailnetUsers(), api.tailnetDevices(), api.tailnetInvites()])
  return { view, users: u.users, devices: d.devices, invites: i.invites }
}

function Tailnet() {
  const [tailnet, setTailnet] = useState<TailnetNow | null>(null)
  // Raised after each change, so the page reads the tailnet again.
  const [reads, setReads] = useState(0)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let stopped = false
    readTailnet().then((now) => { if (!stopped) setTailnet(now) }, (e: unknown) => { if (!stopped) setError(messageOf(e)) })
    return () => { stopped = true }
  }, [reads])
  const readAgain = () => setReads((n) => n + 1)
  // Runs one change, says what happened, and reads the tailnet again.
  const change = (action: () => Promise<unknown>, said: string) => async () => {
    setError('')
    setNotice('')
    try {
      await action()
      setNotice(said)
      readAgain()
    } catch (e) {
      setError(messageOf(e))
    }
  }
  if (!tailnet) return <p className="muted">{error || 'Asking Tailscale…'}</p>
  const { view, users, devices, invites } = tailnet
  return (
    <>
      <KeySection view={view} onChange={readAgain} />
      {notice && <p className="small" role="status">{notice}</p>}
      {error && <p className="error small" role="alert">{error}</p>}
      {view.state === 'connected' && (
        <>
          <h2 className="kicker section">Users</h2>
          <ul className="items tailnet" aria-label="Tailnet users">
            {users.map((u) => <UserRow key={u.id} user={u} change={change} />)}
            {!users.length && <li className="muted small empty">No users.</li>}
          </ul>
          <h2 className="kicker section">Devices</h2>
          <ul className="items tailnet" aria-label="Tailnet devices">
            {devices.map((d) => (
              <li key={d.id}>
                <span>
                  {d.online && <span className="dot online" aria-hidden="true" />}
                  <strong>{d.name}</strong>{' '}
                  <span className="muted small">
                    {d.owner} · {d.os} · {d.online ? 'online now' : d.lastSeen === null ? 'never online' : `last seen ${day(d.lastSeen)}`}
                    {d.authorized ? '' : ' · not authorized'}
                  </span>
                </span>
                <span className="actions">
                  {!d.authorized && <button type="button" className="link small" aria-label={`Authorize ${d.name}`}
                    onClick={act(change(() => api.tailnetDevice(d.id, 'authorize'), `Authorized ${d.name}.`))}>Authorize</button>}
                  <Remove what={d.name} onRemove={change(() => api.tailnetDevice(d.id, 'delete'), `Removed ${d.name} from the tailnet.`)} />
                </span>
              </li>
            ))}
            {!devices.length && <li className="muted small empty">No devices.</li>}
          </ul>
          <h2 className="kicker section">Invites</h2>
          <ul className="items tailnet" aria-label="Tailnet invites">
            {invites.map((i) => (
              <li key={i.id}>
                <span>
                  <strong>{i.email || 'An invite link'}</strong>{' '}
                  <span className="muted small">{i.role} · {i.lastSentAt === null ? 'not emailed' : `sent ${day(i.lastSentAt)}`}</span>
                </span>
                <span className="actions">
                  {i.email && <button type="button" className="link small" aria-label={`Resend the invite to ${i.email}`}
                    onClick={act(change(() => api.tailnetInvite(i.id, 'resend'), `Sent ${i.email} their invite again.`))}>Resend</button>}
                  <button type="button" className="link small" aria-label={`Cancel the invite for ${i.email || 'this link'}`}
                    onClick={act(change(() => api.tailnetInvite(i.id, 'cancel'), `Cancelled the invite for ${i.email || 'that link'}.`))}>Cancel</button>
                </span>
                {i.link !== null && <span className="invite-link"><LinkField label={`Invite link for ${i.email || 'this invite'}`} link={i.link} /></span>}
              </li>
            ))}
            {!invites.length && <li className="muted small empty">No open invites.</li>}
          </ul>
        </>
      )}
    </>
  )
}

type Change = (action: () => Promise<unknown>, said: string) => () => Promise<void>

const ROLES = TailscaleRole.exclude(['owner']).options

function UserRow({ user, change }: { user: TailnetUser; change: Change }) {
  const owner = user.role === 'owner'
  return (
    <li>
      <span>
        <strong>{user.name}</strong>{' '}
        <span className="muted small">
          {user.login} · {user.status.replace(/-/g, ' ')} · {user.team.on === 'this_team' ? `on the team${user.team.role === 'admin' ? ' as an admin' : ''}`
            : user.team.on === 'other_team' ? 'on another team' : 'not on the team'}
        </span>
      </span>
      <span className="actions">
        {user.team.on === 'no_team' && (
          <button type="button" className="link small" aria-label={`Add ${user.login} to the team`}
            onClick={act(change(() => api.addToTeam(user.login, user.name), `Added ${user.login} to the team. Their box is starting.`))}>Add to the team</button>
        )}
        {owner ? <span className="small muted">owner</span> : (
          <>
            <label className="sr-only" htmlFor={`role-${user.id}`}>Tailscale role for {user.login}</label>
            <select id={`role-${user.id}`} className="compact" value={user.role}
              onChange={(e) => { act(change(() => api.tailnetRole(user.id, TailscaleRole.parse(e.target.value)), `${user.login} is now ${e.target.value}.`))() }}>
              {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
            </select>
            {user.status === 'needs-approval' && <button type="button" className="link small" aria-label={`Approve ${user.login}`}
              onClick={act(change(() => api.tailnetUser(user.id, 'approve'), `Approved ${user.login}.`))}>Approve</button>}
            {(user.status === 'active' || user.status === 'idle') && <button type="button" className="link small" aria-label={`Suspend ${user.login}`}
              onClick={act(change(() => api.tailnetUser(user.id, 'suspend'), `Suspended ${user.login}.`))}>Suspend</button>}
            {user.status === 'suspended' && <button type="button" className="link small" aria-label={`Restore ${user.login}`}
              onClick={act(change(() => api.tailnetUser(user.id, 'restore'), `Restored ${user.login}.`))}>Restore</button>}
            <Remove what={user.login} onRemove={change(() => api.tailnetUser(user.id, 'delete'), `Removed ${user.login} from the tailnet.`)} />
          </>
        )}
      </span>
    </li>
  )
}

// Removing asks first, in place.
function Remove({ what, onRemove }: { what: string; onRemove: () => Promise<void> }) {
  const [asking, setAsking] = useState(false)
  if (!asking) return <button type="button" className="link small" aria-label={`Remove ${what}`} onClick={() => setAsking(true)}>Remove</button>
  return (
    <span className="confirm">
      <span className="small">Remove {what} from the tailnet?</span>
      <button type="button" className="link small" onClick={act(async () => { await onRemove(); setAsking(false) })}>Yes, remove</button>
      <button type="button" className="link small" onClick={() => setAsking(false)}>Keep</button>
    </span>
  )
}

function KeySection({ view, onChange }: { view: TailscaleView; onChange: () => void }) {
  if (view.state === 'off') {
    return (
      <>
        <h2 className="kicker section">Key</h2>
        <p>Tailscale is off on this server. To turn it on, set AGENTS_TAILSCALE_API and AGENTS_TAILSCALE_KEY_FILE for the API and restart it.</p>
      </>
    )
  }
  if (view.state === 'no_key') {
    return (
      <>
        <h2 className="kicker section">Key</h2>
        <p>Connect the tailnet with an API access token. {NEW_KEY_HOWTO}</p>
        <KeyForm onSaved={onChange} />
      </>
    )
  }
  return (
    <>
      <h2 className="kicker section">Key</h2>
      <dl className="facts">
        <div><dt>Key</dt><dd>ends in {view.lastFour}</dd></div>
        <div><dt>Expires</dt><dd>{view.expires === null ? 'not known' : `${keyDate(view.expires)}${view.daysLeft !== null && view.daysLeft >= 0 ? `, in ${view.daysLeft} days` : ''}`}</dd></div>
        <div><dt>Saved by</dt><dd>{view.savedBy}, {keyDate(view.savedAt)}</dd></div>
      </dl>
      <KeyWarning view={view} />
      <details className="add">
        <summary className="small">Replace the key</summary>
        <KeyForm onSaved={onChange} />
      </details>
      <Disconnect onChange={onChange} />
    </>
  )
}

function KeyForm({ onSaved }: { onSaved: () => void }) {
  const [key, setKey] = useState('')
  const [expires, setExpires] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.saveTailscaleKey(key.trim(), expires || null)
      onSaved()
      setKey('')
      setExpires('')
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="form fitted" onSubmit={act(submit)} aria-label="Tailscale key">
      <label htmlFor="tailscale-key">API access token</label>
      <input id="tailscale-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="tskey-api-…" />
      <label htmlFor="tailscale-expires">Expires on, if Tailscale does not say</label>
      <input id="tailscale-expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
      <p className="small muted">The key is kept in a file on the server only. This page shows its last four characters.</p>
      <div className="actions">
        <button className="primary" type="submit" disabled={busy || !key.trim()}>Save key</button>
        {error && <p className="error small" role="alert">{error}</p>}
      </div>
    </form>
  )
}

function Disconnect({ onChange }: { onChange: () => void }) {
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState('')
  if (!asking) return <p><button type="button" className="link small" onClick={() => setAsking(true)}>Disconnect Tailscale</button></p>
  return (
    <p className="confirm">
      <span className="small">Remove the key from the server? Invites stop going through Tailscale.</span>
      <button type="button" className="link small" onClick={act(async () => {
        try {
          await api.removeTailscaleKey()
          onChange()
        } catch (e) {
          setError(messageOf(e))
        }
      })}>Yes, disconnect</button>
      <button type="button" className="link small" onClick={() => setAsking(false)}>Keep it</button>
      {error && <span className="error small" role="alert">{error}</span>}
    </p>
  )
}
