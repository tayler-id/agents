import { useId, useState, type KeyboardEvent } from 'react'
import type { WebmcpOriginList } from '../../shared/webmcp.ts'
import { api, day, messageOf, usePolled } from './data.ts'

// One site on the team's list, as the API sends it.
export type WebmcpSite = WebmcpOriginList['origins'][number]

// How often the list asks again, in case another admin changed it. An admin's own
// change shows at once.
const LIST_POLL_MS = 15_000

// The sites whose pages may give an agent's browser tools, one row each, and a
// field at the foot to list another. It is edited where it stands. Enter or Add
// lists what was typed, and Remove takes a site off. It takes everything as
// props, so a screen can put it in any frame. `sites` is null while the list is
// loading, and `onAdd` and `onRemove` reject with the reason a change was refused.
export function WebmcpSitesList({ sites, onAdd, onRemove }: {
  sites: readonly WebmcpSite[] | null
  onAdd: (origin: string) => Promise<void>
  onRemove: (site: WebmcpSite) => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const hint = useId()
  const change = async (work: () => Promise<string>) => {
    setBusy(true)
    setProblem('')
    setNotice('')
    try {
      setNotice(await work())
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setBusy(false)
    }
  }
  const add = () => {
    const origin = draft.trim()
    if (!origin || busy) return
    void change(async () => {
      await onAdd(origin)
      setDraft('')
      return `Listed ${origin}. Agents use it from their next message.`
    })
  }
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      add()
    }
  }
  return (
    <>
      <ul className="items" aria-label="Sites whose tools agents may use">
        {sites?.map((site) => (
          <li key={site.id}>
            <span><strong>{site.origin}</strong> <span className="muted small">listed by {site.addedBy ?? 'someone since removed'} on {day(site.createdAt)}</span></span>
            <button type="button" className="link small" aria-label={`Remove ${site.origin}`} disabled={busy} onClick={() => {
              void change(async () => {
                await onRemove(site)
                return `Removed ${site.origin}. Agents stop using its tools from their next message.`
              })
            }}>Remove</button>
          </li>
        ))}
        {sites?.length === 0 && <li className="muted small empty">No sites are listed, so agents take no tools from any page.</li>}
      </ul>
      <div className="form inline-form">
        <input aria-label="Add a site" aria-describedby={hint} placeholder="Add a site, such as https://example.com" value={draft} readOnly={busy}
          onChange={(event) => setDraft(event.target.value)} onKeyDown={keys} autoComplete="off" spellCheck={false} />
        <button type="button" className="primary" disabled={busy || !draft.trim()} onClick={add}>Add</button>
      </div>
      <p id={hint} className="small muted">A scheme and a host, with the port if the site uses one, or a star for any port, as in http://127.0.0.1:*</p>
      {notice && <p className="small" role="status">{notice}</p>}
      {problem && <p className="error small" role="alert">{problem}</p>}
    </>
  )
}

// The list as the Team page shows it to an admin: its heading and a line on what it does,
// and the list read from the API, read again every few seconds.
export function WebmcpSites() {
  const { value, error, refresh } = usePolled(api.webmcpOrigins, () => LIST_POLL_MS)
  return (
    <>
      <h2 className="kicker section">Sites whose tools agents may use</h2>
      <p className="small">
        A web page can offer tools to an agent browsing it. Agents take them only from the sites listed here. A tool the page marks
        read-only runs at once, and any other tool asks a person each time.
      </p>
      <WebmcpSitesList sites={value?.origins ?? null}
        onAdd={async (origin) => { await api.addWebmcpOrigin(origin); refresh() }}
        onRemove={async (site) => { await api.removeWebmcpOrigin(site.id); refresh() }} />
      {error && <p className="error small" role="alert">{error}</p>}
    </>
  )
}
