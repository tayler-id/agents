import { useEffect, useMemo, useState, type SyntheticEvent } from 'react'
import {
  act, api, byNumber, clock, messageOf, useSnapshot, type Artifact, type ArtifactVersion, type Comment, type Person,
} from './data.ts'
import { Markdown } from './Markdown.tsx'
import { CodeView, DiffView, Tabs } from './Code.tsx'

// A document an agent wrote in its task's folder, with every version it saved,
// what changed from the version before, and comments on it.
export function DocumentPanel({ artifactId, taskId, onClose }: { artifactId: string; taskId: string | null; onClose: () => void }) {
  const { rows: artifacts } = useSnapshot<Artifact>('artifacts', taskId ? { task: taskId } : null, 4000)
  const { rows: versions } = useSnapshot<ArtifactVersion>('artifact_versions', { artifact: artifactId }, 4000)
  const artifact = artifacts.find((a) => a.id === artifactId)
  const ordered = useMemo(() => [...versions].sort(byNumber((v: ArtifactVersion) => v.version)).reverse(), [versions])
  const [picked, setPicked] = useState<number | null>(null)
  const [tab, setTab] = useState<'file' | 'diff'>('file')
  const shown = ordered.find((v) => v.version === picked) ?? ordered[0]
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
        {!shown ? <p className="muted small">Loading…</p> : (
          <Tabs label="View" tabs={[['file', 'File'], ['diff', 'Diff']]} value={tab} onChange={setTab}>
            {tab === 'diff' ? <VersionDiff artifactId={artifactId} version={shown.version} path={artifact?.path ?? ''} />
              : (
                <div className="document-body">
                  {artifact?.path?.endsWith('.md') ? <Markdown text={shown.content} /> : <CodeView path={artifact?.path ?? ''} text={shown.content} />}
                </div>
              )}
          </Tabs>
        )}
        {shown && (
          <Comments artifactId={artifactId} version={shown.version} canSend={Boolean(artifact?.made_by_session)} />
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

// Comments on a document's versions. Sent to the agent, a comment reaches the
// session that wrote the document, which can revise it.
function Comments({ artifactId, version, canSend }: { artifactId: string; version: number; canSend: boolean }) {
  const { rows: comments } = useSnapshot<Comment>('comments', { artifact: artifactId }, 3000)
  const { rows: people } = useSnapshot<Person>('people', {}, 30000)
  const [text, setText] = useState('')
  const [quote, setQuote] = useState('')
  const [send, setSend] = useState(canSend)
  const [error, setError] = useState('')
  const ordered = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault()
    setError('')
    try {
      await api.addComment(artifactId, { version, text: text.trim(), quote: quote.trim() || undefined, send: send && canSend })
      setText('')
      setQuote('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <section className="comments" aria-label="Comments">
      <h3 className="kicker">Comments</h3>
      <ul className="plain">
        {ordered.map((c) => (
          <li key={c.id} className={`comment ${c.status}`}>
            <p className="small muted">{people.find((p) => p.id === c.author_person)?.login ?? 'someone'} on version {c.version} · {clock(c.created_at)}
              {c.sent_to_session ? ' · sent to the agent' : ''}{c.status !== 'open' ? ` · ${c.status}` : ''}</p>
            {c.anchor?.quote && <blockquote>{c.anchor.quote}</blockquote>}
            <p>{c.body}</p>
            {c.status === 'open' && <button type="button" className="link small" onClick={act(() => api.resolveComment(c.id))}>Resolve</button>}
          </li>
        ))}
        {!ordered.length && <li className="muted small">No comments yet</li>}
      </ul>
      <form className="form" onSubmit={act(submit)} aria-label="Add a comment">
        <label htmlFor={`quote-${artifactId}`}>Quote (optional)</label>
        <input id={`quote-${artifactId}`} value={quote} onChange={(e) => setQuote(e.target.value)} placeholder="The part you mean" />
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
