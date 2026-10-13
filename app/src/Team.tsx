import { useEffect, useId, useState, type SyntheticEvent } from 'react'
import { InviteRow, JoinRequestRow, TeamRole, type InviteMade, type MeView } from '../../shared/onboarding.ts'
import { act, api, messageOf, parseTime, useSnapshot, useSnapshotOf, type Instance, type Me, type Person } from './data.ts'

// How often a login waiting to join asks again whether it is on a team yet.
const WAITING_POLL_MS = 5000

const day = (text: string | null) => parseTime(text)?.toLocaleDateString([], { month: 'short', day: 'numeric' }) ?? ''

// A login on no team. It asks again every few seconds, so the app opens as soon
// as an admin adds it.
export function Waiting({ me, onJoined }: { me: Extract<MeView, { kind: 'waiting' }>; onJoined: (me: MeView) => void }) {
  const [error, setError] = useState('')
  useEffect(() => {
    const timer = setInterval(() => {
      api.me().then((next) => { if (next.kind === 'member') onJoined(next) }, (e: unknown) => { setError(messageOf(e)) })
    }, WAITING_POLL_MS)
    return () => { clearInterval(timer) }
  }, [onJoined])
  return (
    <main className="blocked" aria-label="Waiting to join">
      <p className="kicker">Waiting to join</p>
      <h1>You are not on a team yet</h1>
      <p>You opened Agents as <strong>{me.login}</strong>. An admin sees you under Wants to join and can add you with one click.</p>
      <p className="muted">This page opens the app by itself once they do.</p>
      <p className="muted small">If someone invited you at a different email, sign in to Tailscale with that account and open the app again.</p>
      {error && <p className="error small" role="alert">{error}</p>}
    </main>
  )
}

// What a person's own box is doing, in a few words.
export function boxState(box: Instance): string {
  if (box.start_error) return 'could not start'
  return box.status === 'online' ? 'ready' : 'starting'
}

export function TeamPage({ me }: { me: Me }) {
  const admin = me.person.role === 'admin'
  const { rows: people } = useSnapshot<Person>('people', {}, 5000)
  const { rows: instances } = useSnapshot<Instance>('instances', {}, 5000)
  const boxOf = (personId: string) => instances.find((i) => i.personal && i.owner_id === personId)
  const sorted = [...people].sort((a, b) => a.login.localeCompare(b.login))
  return (
    <section className="page" aria-label="Team">
      <header className="page-head">
        <div>
          <p className="kicker">Team</p>
          <h1>{me.team.name}</h1>
          <p className="muted small">{people.length} {people.length === 1 ? 'person' : 'people'}</p>
        </div>
      </header>
      <div className="page-body">
        {admin && <InviteForm />}
        {admin && <WantsToJoin />}
        {admin && <Invited />}
        <h2 className="kicker section">People</h2>
        <ul className="items" aria-label="People">
          {sorted.map((p) => {
            const box = boxOf(p.id)
            return (
              <li key={p.id}>
                <span><strong>{p.name ?? p.login}</strong> <span className="muted small">{[p.name ? p.login : '', p.role === 'admin' ? 'admin' : ''].filter(Boolean).join(' · ')}</span></span>
                <span className="muted small">{box ? `${box.name} · ${boxState(box)}` : 'no box'}</span>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

function InviteForm() {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<TeamRole>('member')
  const [made, setMade] = useState<InviteMade | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      setMade(await api.invite(email.trim(), role))
      setEmail('')
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <h2 className="kicker section">Invite someone</h2>
      <form className="form fitted" onSubmit={act(submit)} aria-label="Invite someone">
        <label htmlFor="invite-email">Email</label>
        <input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="sam@example.com" autoComplete="off" />
        <label htmlFor="invite-role">Role on the team</label>
        <select id="invite-role" value={role} onChange={(e) => setRole(TeamRole.parse(e.target.value))} aria-describedby="invite-role-hint">
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <p id="invite-role-hint" className="small muted">Admins invite people, add those waiting to join, and manage the tailnet.</p>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy || !email.trim()}>Invite</button>
          {error && <p className="error small" role="alert">{error}</p>}
        </div>
        {made && <InviteResult made={made} />}
      </form>
    </>
  )
}

// What happened to an invite just made, and its link when Tailscale gave one.
function InviteResult({ made }: { made: InviteMade }) {
  const { invite, link } = made
  const sent = invite.tailscale_invite_id !== null
  return (
    <div className="result" role="status">
      <p className="note-line">Invited {invite.email}.</p>
      {!sent && <p className="small">Tailscale is not connected, so nobody was emailed. They join when they open the app from a device on the tailnet.</p>}
      {sent && <p className="small">Tailscale emailed them an invite to the tailnet. They join this team the first time they open the app.</p>}
      {sent && link === null && <p className="small muted">Their email is in the tailnet's own domain, so they join by signing in to Tailscale. There is no link to send.</p>}
      {link !== null && <LinkField label="Invite link, to send yourself" link={link} />}
    </div>
  )
}

function LinkField({ label, link }: { label: string; link: string }) {
  const id = useId()
  return (
    <>
      <label htmlFor={id} className="small muted">{label}</label>
      <input id={id} className="link-field" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
    </>
  )
}

function WantsToJoin() {
  const { rows, error: shapeError } = useSnapshotOf(JoinRequestRow, 'join_requests', {}, 4000)
  const [added, setAdded] = useState<string[]>([])
  const [error, setError] = useState('')
  const add = async (request: JoinRequestRow) => {
    setError('')
    try {
      await api.addToTeam(request.login, request.name)
      setAdded((list) => [...list, request.login])
    } catch (e) {
      setError(messageOf(e))
    }
  }
  const waiting = rows.filter((r) => !added.includes(r.login))
  return (
    <>
      <h2 className="kicker section">Wants to join</h2>
      <ul className="items" aria-label="Wants to join">
        {waiting.map((r) => (
          <li key={r.id}>
            <span><strong>{r.name ?? r.login}</strong> <span className="muted small">{r.name ? `${r.login} · ` : ''}since {day(r.first_seen_at)}</span></span>
            <button type="button" className="link small" aria-label={`Add ${r.login}`} onClick={act(() => add(r))}>Add</button>
          </li>
        ))}
        {!waiting.length && <li className="muted small empty">Nobody is waiting. Someone who opens the app without an invite shows up here.</li>}
      </ul>
      {added.length > 0 && <p className="small" role="status">Added {added.join(', ')}. Their box is starting.</p>}
      {(error || shapeError) && <p className="error small" role="alert">{error || shapeError}</p>}
    </>
  )
}

function Invited() {
  const { rows, error: shapeError } = useSnapshotOf(InviteRow, 'invites', {}, 4000)
  const [links, setLinks] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const open = rows.filter((r) => r.status === 'open').sort((a, b) => b.created_at.localeCompare(a.created_at))
  const run = (action: () => Promise<string>) => async () => {
    setError('')
    setNotice('')
    try {
      setNotice(await action())
    } catch (e) {
      setError(messageOf(e))
    }
  }
  return (
    <>
      <h2 className="kicker section">Invited</h2>
      <ul className="items invites" aria-label="Invited">
        {open.map((invite) => {
          const link = links[invite.id]
          return (
          <li key={invite.id}>
            <span>
              <strong>{invite.email}</strong>{' '}
              <span className="muted small">
                {invite.role === 'admin' ? 'as an admin · ' : ''}invited {day(invite.created_at)}{invite.tailscale_invite_id === null ? ' · not sent through Tailscale' : ''}
              </span>
            </span>
            <span className="actions">
              {invite.tailscale_invite_id !== null && (
                <button type="button" className="link small" aria-label={`Link for ${invite.email}`} onClick={act(run(async () => {
                  const { link } = await api.inviteLink(invite.id)
                  setLinks((all) => ({ ...all, [invite.id]: link }))
                  return ''
                }))}>Link</button>
              )}
              <button type="button" className="link small" aria-label={`Resend to ${invite.email}`} onClick={act(run(async () => {
                const { link } = await api.resendInvite(invite.id)
                if (link !== null) setLinks((all) => ({ ...all, [invite.id]: link }))
                return `Sent ${invite.email} their invite again.`
              }))}>Resend</button>
              <button type="button" className="link small" aria-label={`Cancel the invite for ${invite.email}`} onClick={act(run(async () => {
                await api.cancelInvite(invite.id)
                return `Cancelled the invite for ${invite.email}.`
              }))}>Cancel</button>
            </span>
            {link && <span className="invite-link"><LinkField label={`Invite link for ${invite.email}`} link={link} /></span>}
          </li>
          )
        })}
        {!open.length && <li className="muted small empty">No open invites.</li>}
      </ul>
      {notice && <p className="small" role="status">{notice}</p>}
      {(error || shapeError) && <p className="error small" role="alert">{error || shapeError}</p>}
    </>
  )
}
