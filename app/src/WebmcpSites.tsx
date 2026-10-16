import { useState, type SyntheticEvent } from 'react'
import { act, api, day, messageOf, usePolled } from './data.ts'

// How often the list asks again, in case another admin changed it. An admin's own
// change shows at once.
const LIST_POLL_MS = 15_000

// An admin's list of the sites whose pages may give an agent's browser tools. A
// site that is not here gives an agent none, and the team's agents follow a
// change on their next message.
export function WebmcpSites() {
  const { value, error: readError, refresh } = usePolled(api.webmcpOrigins, () => LIST_POLL_MS)
  const [origin, setOrigin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const change = async (work: () => Promise<string>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      setNotice(await work())
      refresh()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  const add = async (event: SyntheticEvent) => {
    event.preventDefault()
    await change(async () => {
      await api.addWebmcpOrigin(origin.trim())
      setOrigin('')
      return `Listed ${origin.trim()}. Agents use it from their next message.`
    })
  }
  const sites = value?.origins ?? []
  return (
    <>
      <h2 className="kicker section">Sites whose tools agents may use</h2>
      <p className="small">
        A web page can offer tools to an agent browsing it. Agents take them only from the sites listed here. A tool the page marks
        read-only runs at once, and any other tool asks a person each time.
      </p>
      <ul className="items" aria-label="Sites whose tools agents may use">
        {sites.map((site) => (
          <li key={site.id}>
            <span><strong>{site.origin}</strong> <span className="muted small">listed by {site.addedBy ?? 'someone since removed'} on {day(site.createdAt)}</span></span>
            <button type="button" className="link small" aria-label={`Remove ${site.origin}`} disabled={busy} onClick={act(() => change(async () => {
              await api.removeWebmcpOrigin(site.id)
              return `Removed ${site.origin}. Agents stop using its tools from their next message.`
            }))}>Remove</button>
          </li>
        ))}
        {value && !sites.length && <li className="muted small empty">No sites are listed, so agents take no tools from any page.</li>}
      </ul>
      <form className="form fitted" onSubmit={act(add)} aria-label="List a site">
        <label htmlFor="webmcp-origin">Site</label>
        <input id="webmcp-origin" type="text" inputMode="url" value={origin} onChange={(e) => setOrigin(e.target.value)}
          placeholder="https://example.com" autoComplete="off" spellCheck={false} aria-describedby="webmcp-origin-hint" />
        <p id="webmcp-origin-hint" className="small muted">
          A scheme and a host, with the port if the site uses one, or a star for any port, as in http://127.0.0.1:*
        </p>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy || !origin.trim()}>List site</button>
        </div>
      </form>
      {notice && <p className="small" role="status">{notice}</p>}
      {(error || readError) && <p className="error small" role="alert">{error || readError}</p>}
    </>
  )
}
