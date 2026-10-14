import { useEffect, useMemo, useRef, useState, type RefObject, type SyntheticEvent } from 'react'
import {
  act, api, byNumber, clock, imageUrl, messageOf, useSnapshot, type Artifact, type ArtifactVersion, type Comment, type Person,
} from './data.ts'
import { Markdown } from './Markdown.tsx'
import { CodeView, DiffView, Tabs } from './Code.tsx'
import { findQuotes, occurrenceOf } from './quotes.ts'
import { CommentAnchor } from '../../shared/work.ts'

// The browser's highlight API marks text without changing the page. The two names
// pair with ::highlight() rules in styles.css.
const MARKED = 'comment-quote'
const ACTIVE = 'comment-quote-active'
// Room above a quote scrolled into view, so the line before it shows too.
const SCROLL_MARGIN = 48

// Where the text under a point is. Firefox and Chromium have the standard call,
// WebKit only its older one, so the document is read as having either.
function caretAt(x: number, y: number): [Node, number] | null {
  const doc: { caretPositionFromPoint?: (x: number, y: number) => CaretPosition | null; caretRangeFromPoint?: (x: number, y: number) => Range | null } = document
  if (doc.caretPositionFromPoint) {
    const place = doc.caretPositionFromPoint(x, y)
    return place ? [place.offsetNode, place.offset] : null
  }
  const range = doc.caretRangeFromPoint?.(x, y)
  return range ? [range.startContainer, range.startOffset] : null
}

// A document an agent wrote in its task's folder, with every version it saved,
// what changed from the version before, and comments pinned to its lines.
export function DocumentPanel({ artifactId, taskId, onClose }: { artifactId: string; taskId: string | null; onClose: () => void }) {
  const { rows: artifacts } = useSnapshot<Artifact>('artifacts', taskId ? { task: taskId } : null, 4000)
  const { rows: versions } = useSnapshot<ArtifactVersion>('artifact_versions', { artifact: artifactId }, 4000)
  const artifact = artifacts.find((a) => a.id === artifactId)
  const ordered = useMemo(() => [...versions].sort(byNumber((v: ArtifactVersion) => v.version)).reverse(), [versions])
  const [picked, setPicked] = useState<number | null>(null)
  const [tab, setTab] = useState<'file' | 'diff'>('file')
  const shown = ordered.find((v) => v.version === picked) ?? ordered[0]
  const body = useRef<HTMLDivElement>(null)
  return (
    <aside className="panel wide" aria-label="Document">
      <header className="panel-head">
        <div>
          <h2>{artifact?.title ?? 'Document'}</h2>
          <p className="muted small">{artifact?.path} · {ordered.length} version{ordered.length === 1 ? '' : 's'}</p>
        </div>
        <button type="button" className="ghost" onClick={onClose}>Close</button>
      </header>
      {ordered.length > 1 && (
        <div className="versions-pick">
          <label htmlFor="doc-version" className="small muted">Version</label>
          <select id="doc-version" value={shown?.version ?? ''} onChange={(e) => setPicked(Number(e.target.value))}>
            {ordered.map((v) => <option key={v.version} value={v.version}>{v.version} · {clock(v.created_at)}</option>)}
          </select>
        </div>
      )}
      <div className="document" tabIndex={0}>
        {!shown ? <p className="muted small">Loading…</p>
          : shown.blob_id ? <img className="document-image" src={imageUrl(shown)} alt={`${artifact?.title ?? 'Image'}, version ${shown.version}`} />
            : (
              <Tabs label="View" tabs={[['file', 'File'], ['diff', 'Diff']]} value={tab} onChange={setTab}>
                {tab === 'diff' ? <VersionDiff artifactId={artifactId} version={shown.version} path={artifact?.path ?? ''} />
                  : (
                    <div ref={body} className="document-body">
                      {artifact?.path?.endsWith('.md') ? <Markdown text={shown.content} /> : <CodeView path={artifact?.path ?? ''} text={shown.content} />}
                    </div>
                  )}
              </Tabs>
            )}
        {shown && (
          // An image has no lines for a comment to be pinned to.
          <Comments artifactId={artifactId} version={shown.version} canSend={Boolean(artifact?.made_by_session)} body={tab === 'file' && !shown.blob_id ? body : null}
            showVersion={(version) => { setTab('file'); setPicked(version) }} />
        )}
      </div>
    </aside>
  )
}

// What changed in this version from the one before, from the server's git diff.
function VersionDiff({ artifactId, version, path }: { artifactId: string; version: number; path: string }) {
  const [state, setState] = useState<{ version: number; diff: string | null; error: string }>({ version: 0, diff: null, error: '' })
  useEffect(() => {
    if (version < 2) return
    let stopped = false
    api.versionDiff(artifactId, version).then(
      ({ diff }) => { if (!stopped) setState({ version, diff, error: '' }) },
      (error: unknown) => { if (!stopped) setState({ version, diff: null, error: messageOf(error) }) },
    )
    return () => { stopped = true }
  }, [artifactId, version])
  if (version < 2) return <p className="muted small">This is the first version, so there is nothing before it to compare.</p>
  if (state.version !== version) return <p className="muted small">Loading…</p>
  if (state.error) return <p className="error small" role="alert">{state.error}</p>
  return <DiffView diff={state.diff ?? ''} label={`What changed in ${path} in version ${version}`} />
}

type Placed = { comment: Comment; anchor: CommentAnchor | null }

// Comments on a document's versions. A comment's quote is marked where it sits in
// its version, and clicking either one finds the other. Sent to the agent, a
// comment reaches the session that wrote the document, which can revise it.
function Comments({ artifactId, version, canSend, body, showVersion }: {
  artifactId: string; version: number; canSend: boolean; body: RefObject<HTMLDivElement | null> | null; showVersion: (version: number) => void
}) {
  const { rows: comments } = useSnapshot<Comment>('comments', { artifact: artifactId }, 3000)
  const { rows: people } = useSnapshot<Person>('people', {}, 30000)
  const [text, setText] = useState('')
  const [quote, setQuote] = useState('')
  const [occurrence, setOccurrence] = useState<number | undefined>(undefined)
  const [send, setSend] = useState(canSend)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [active, setActive] = useState<string | null>(null)
  const ranges = useRef(new Map<string, Range>())
  const scrollTo = useRef<string | null>(null)
  const items = useRef(new Map<string, HTMLLIElement>())
  const ordered = useMemo<Placed[]>(() => [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((comment) => {
    const anchor = comment.anchor ? CommentAnchor.safeParse(comment.anchor) : null
    return { comment, anchor: anchor?.success ? anchor.data : null }
  }), [comments])

  // Marks each quote of this version in the rendered document, and listens there
  // for a click on marked text. The page itself never changes, so this runs after
  // every render that could move the text.
  useEffect(() => {
    const root = body?.current
    if (!root || !('highlights' in CSS)) return
    const found = new Map<string, Range>()
    for (const { comment, anchor } of ordered) {
      const range = comment.version === version && anchor ? findQuotes(root, anchor.quote)[anchor.occurrence] : undefined
      if (range) found.set(comment.id, range)
    }
    ranges.current = found
    CSS.highlights.set(MARKED, new Highlight(...found.values()))
    const current = active ? found.get(active) : undefined
    if (current) CSS.highlights.set(ACTIVE, new Highlight(current))
    else CSS.highlights.delete(ACTIVE)
    if (current && scrollTo.current === active) {
      scrollTo.current = null
      const box = root.closest('.document')
      if (box) box.scrollTop += current.getBoundingClientRect().top - box.getBoundingClientRect().top - SCROLL_MARGIN
    }
    const pick = (event: globalThis.MouseEvent) => {
      const place = caretAt(event.clientX, event.clientY)
      const hit = place && [...found.entries()].find(([, range]) => range.isPointInRange(...place))
      if (!hit) return
      setActive(hit[0])
      items.current.get(hit[0])?.scrollIntoView({ block: 'nearest' })
    }
    root.addEventListener('click', pick)
    return () => {
      root.removeEventListener('click', pick)
      CSS.highlights.delete(MARKED)
      CSS.highlights.delete(ACTIVE)
    }
  })

  const jump = ({ comment, anchor }: Placed) => {
    setNote('')
    if (!anchor) return
    showVersion(comment.version)
    const root = body?.current
    if (comment.version === version && root && !findQuotes(root, anchor.quote)[anchor.occurrence]) {
      setNote(`"${anchor.quote}" is not in version ${comment.version} any more.`)
    }
    scrollTo.current = comment.id
    setActive(comment.id)
  }

  const quoteSelection = () => {
    const root = body?.current
    const selection = window.getSelection()
    const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null
    if (!root || !range || range.collapsed || !root.contains(range.commonAncestorContainer)) {
      setNote('Select the words you mean in the document first.')
      return
    }
    setNote('')
    setQuote(range.toString().replace(/\s+/g, ' ').trim())
    setOccurrence(occurrenceOf(root, range) ?? undefined)
  }

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault()
    setError('')
    try {
      await api.addComment(artifactId, { version, text: text.trim(), quote: quote.trim() || undefined, occurrence: quote.trim() ? occurrence : undefined, send: send && canSend })
      setText('')
      setQuote('')
      setOccurrence(undefined)
    } catch (e) {
      setError(messageOf(e))
    }
  }
  return (
    <section className="comments" aria-label="Comments">
      <h3 className="kicker">Comments</h3>
      {note && <p className="muted small" role="status">{note}</p>}
      <ul className="plain">
        {ordered.map((placed) => {
          const { comment: c, anchor } = placed
          return (
            <li key={c.id} ref={(el) => { if (el) items.current.set(c.id, el); else items.current.delete(c.id) }}
              className={`comment ${c.status}${c.id === active ? ' active' : ''}`}>
              <p className="small muted">{people.find((p) => p.id === c.author_person)?.login ?? 'someone'} on version {c.version} · {clock(c.created_at)}
                {c.sent_to_session ? ' · sent to the agent' : ''}{c.status !== 'open' ? ` · ${c.status}` : ''}</p>
              {anchor && (
                <button type="button" className="quote" aria-pressed={c.id === active} onClick={() => jump(placed)}>
                  <span className="sr-only">Show in the document: </span>{anchor.quote}
                </button>
              )}
              <p>{c.body}</p>
              {c.status === 'open' && <button type="button" className="link small" onClick={act(() => api.resolveComment(c.id))}>Resolve</button>}
            </li>
          )
        })}
        {!ordered.length && <li className="muted small">No comments yet</li>}
      </ul>
      <form className="form" onSubmit={act(submit)} aria-label="Add a comment">
        <label htmlFor={`quote-${artifactId}`}>Quote (optional)</label>
        <div className="quote-pick">
          <input id={`quote-${artifactId}`} value={quote} onChange={(e) => { setQuote(e.target.value); setOccurrence(undefined) }} placeholder="The part you mean" />
          {body && <button type="button" className="ghost small" onMouseDown={(e) => e.preventDefault()} onClick={quoteSelection}>Use selection</button>}
        </div>
        <label htmlFor={`comment-${artifactId}`}>Comment on version {version}</label>
        <textarea id={`comment-${artifactId}`} rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        {canSend && <label className="check"><input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} /> Send it to the agent to revise</label>}
        <div className="actions">
          <button className="primary" type="submit" disabled={!text.trim()}>Comment</button>
          {error && <p className="error small" role="alert">{error}</p>}
        </div>
      </form>
    </section>
  )
}
