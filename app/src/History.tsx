// The History page: every session the person may see, newest first, and a search
// across the text of their steps. A row opens the session's replay, and a result
// opens it at the step that matched. The filters and the words searched are in
// the address, so a page can be shared and the browser's Back returns to it.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode, type SyntheticEvent } from 'react'
import { HistoryKind, snippetParts, STEP_LABELS, type HistorySession, type SearchHit } from '../../shared/history.ts'
import { ProjectRow } from '../../shared/projects.ts'
import { clock, day, messageOf, repoName, useSnapshot, useSnapshotOf, type Agent, type Me, type Person, type Repo } from './data.ts'
import {
  actorOf, historyApi, KIND_WORDS, listHash, NO_FILTERS, outcomeWords, placeOf, replaceHash, replayHash, spanWords, stepsWords, titleOf, whenWords,
  type Filters,
} from './history.ts'
import { Replay } from './Replay.tsx'
import './history.css'

// The lists a filter chooses from change when someone joins or an agent is made, which is rare.
const OPTIONS_EVERY_MS = 60_000

const subscribe = (notify: () => void) => {
  window.addEventListener('hashchange', notify)
  return () => { window.removeEventListener('hashchange', notify) }
}
const hashNow = () => window.location.hash

export function HistoryPage({ me }: { me: Me }) {
  const hash = useSyncExternalStore(subscribe, hashNow)
  const place = useMemo(() => placeOf(hash), [hash])
  return place.view === 'replay'
    ? <Replay key={place.sessionId} me={me} sessionId={place.sessionId} at={place.seq} />
    : <Sessions me={me} filters={place.filters} />
}

type Page<T> = { items: T[]; next: string | null }
type Load<T> = (before: string | null) => Promise<Page<T>>

// A list read a page at a time. It starts over when `load` changes, and a page that
// comes back after that is thrown away.
function usePages<T>(load: Load<T>) {
  const [state, setState] = useState<{ source: Load<T> | null; items: T[]; next: string | null; error: string }>({ source: null, items: [], next: null, error: '' })
  const [loadingMore, setLoadingMore] = useState<Load<T> | null>(null)
  useEffect(() => {
    let stale = false
    load(null).then(
      (page) => { if (!stale) setState({ source: load, items: page.items, next: page.next, error: '' }) },
      (error: unknown) => { if (!stale) setState({ source: load, items: [], next: null, error: messageOf(error) }) },
    )
    return () => { stale = true }
  }, [load])
  const current = state.source === load
  const more = () => {
    if (!current || state.next === null) return
    setLoadingMore(load)
    load(state.next).then(
      (page) => { setState((last) => (last.source === load ? { ...last, items: [...last.items, ...page.items], next: page.next } : last)) },
      (error: unknown) => { setState((last) => (last.source === load ? { ...last, error: messageOf(error) } : last)) },
    ).finally(() => { setLoadingMore(null) })
  }
  return {
    items: current ? state.items : [], next: current ? state.next : null, error: current ? state.error : '', ready: current,
    loadingMore: loadingMore === load, more,
  }
}

type Pages<T> = ReturnType<typeof usePages<T>>

// What a list shows around its rows: it is loading, it failed, it is empty, or there is more.
function Feed<T>({ pages, label, empty, children }: { pages: Pages<T>; label: string; empty: string; children: ReactNode }) {
  return (
    <>
      {!pages.ready && <p className="muted" aria-busy="true">Loading…</p>}
      {pages.error && <p className="error small" role="alert">{pages.error}</p>}
      {pages.ready && !pages.error && !pages.items.length && <p className="muted">{empty}</p>}
      <ul className="history-list" aria-label={label}>{children}</ul>
      {pages.next !== null && (
        <button type="button" className="ghost more" onClick={pages.more} disabled={pages.loadingMore}>{pages.loadingMore ? 'Loading…' : 'Show more'}</button>
      )}
    </>
  )
}

function SessionList({ me, filters }: { me: Me; filters: Filters }) {
  const load = useCallback<Load<HistorySession>>(
    (before) => historyApi.sessions(filters, before).then((page) => ({ items: page.sessions, next: page.next })), [filters])
  const pages = usePages(load)
  const filtered = Object.values(filters).some((value) => value !== '')
  return (
    <Feed pages={pages} label="Sessions" empty={filtered ? 'No session matches these filters.' : 'Nothing has been recorded yet.'}>
      {pages.items.map((session) => <li key={session.id}><SessionRow session={session} me={me} /></li>)}
    </Feed>
  )
}

function SearchResults({ me, filters }: { me: Me; filters: Filters }) {
  const load = useCallback<Load<SearchHit>>(
    (before) => historyApi.search(filters, before).then((page) => ({ items: page.hits, next: page.next })), [filters])
  const pages = usePages(load)
  return (
    <>
      <p className="muted small" role="status">Steps that match &ldquo;{filters.q}&rdquo;, newest first.</p>
      <Feed pages={pages} label="Search results" empty="No step matches those words.">
        {pages.items.map((hit) => <li key={`${hit.session.id}:${String(hit.seq)}`}><HitRow hit={hit} me={me} /></li>)}
      </Feed>
    </>
  )
}

function Sessions({ me, filters }: { me: Me; filters: Filters }) {
  const apply = (next: Filters) => { replaceHash(listHash(next)) }
  return (
    <section className="page" aria-label="History">
      <header className="page-head">
        <div>
          <p className="kicker">History</p>
          <h1>Every session you can see</h1>
          <p className="muted small">Newest first, from agents and from terminals. Search reads the text of every step.</p>
        </div>
      </header>
      <div className="page-body">
        <SearchBox key={filters.q} words={filters.q} onSearch={(q) => { apply({ ...filters, q }) }} />
        <FilterBar filters={filters} onChange={apply} />
        {filters.q === '' ? <SessionList me={me} filters={filters} /> : <SearchResults me={me} filters={filters} />}
      </div>
    </section>
  )
}

function SearchBox({ words, onSearch }: { words: string; onSearch: (q: string) => void }) {
  const [text, setText] = useState(words)
  const submit = (event: SyntheticEvent) => {
    event.preventDefault()
    onSearch(text.trim())
  }
  return (
    <form className="history-search" role="search" onSubmit={submit}>
      <input type="search" aria-label="Search the text of steps" placeholder="Search messages, tool calls and results" value={text}
        onChange={(e) => { setText(e.target.value) }} />
      <button type="submit" className="primary">Search</button>
      {words !== '' && <button type="button" className="ghost" onClick={() => { onSearch('') }}>Clear search</button>}
    </form>
  )
}

type Option = { value: string; label: string }

function Select({ label, value, options, anyLabel, onChange }: { label: string; value: string; options: Option[]; anyLabel: string; onChange: (value: string) => void }) {
  // A value the list has not loaded yet still shows, so the filter in the address is never hidden.
  const known = value === '' || options.some((option) => option.value === value)
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => { onChange(e.target.value) }}>
        <option value="">{anyLabel}</option>
        {!known && <option value={value}>Loading…</option>}
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  )
}

const byLabel = (rows: Option[]): Option[] => [...rows].sort((a, b) => a.label.localeCompare(b.label))

function FilterBar({ filters, onChange }: { filters: Filters; onChange: (filters: Filters) => void }) {
  const { rows: agents } = useSnapshot<Agent>('agents', {}, OPTIONS_EVERY_MS)
  const { rows: people } = useSnapshot<Person>('people', {}, OPTIONS_EVERY_MS)
  const { rows: projects } = useSnapshotOf(ProjectRow, 'projects', {}, OPTIONS_EVERY_MS)
  const { rows: repos } = useSnapshot<Repo>('repos', {}, OPTIONS_EVERY_MS)
  const change = (patch: Partial<Filters>) => { onChange({ ...filters, ...patch }) }
  return (
    <div className="history-filters">
      <Select label="Agent" anyLabel="Any agent" value={filters.agent} onChange={(agent) => { change({ agent }) }}
        options={byLabel(agents.map((a) => ({ value: a.id, label: a.name })))} />
      <Select label="Person" anyLabel="Anyone" value={filters.person} onChange={(person) => { change({ person }) }}
        options={byLabel(people.map((p) => ({ value: p.id, label: p.name ?? p.login })))} />
      <Select label="Kind" anyLabel="Any kind" value={filters.kind} onChange={(kind) => { change({ kind: HistoryKind.safeParse(kind).data ?? '' }) }}
        options={Object.entries(KIND_WORDS).map(([value, label]) => ({ value, label }))} />
      <Select label="Project" anyLabel="Any project" value={filters.project} onChange={(project) => { change({ project }) }}
        options={byLabel(projects.map((p) => ({ value: p.id, label: p.name })))} />
      <Select label="Repo" anyLabel="Any repo" value={filters.repo} onChange={(repo) => { change({ repo }) }}
        options={byLabel(repos.map((r) => ({ value: r.id, label: repoName(r.remote_url) })))} />
      <label>
        Day
        <input type="date" value={filters.day} onChange={(e) => { change({ day: e.target.value }) }} />
      </label>
      <button type="button" className="ghost" onClick={() => { onChange({ ...NO_FILTERS, q: filters.q }) }}>Clear filters</button>
    </div>
  )
}

// Who and where, in a line: the agent or terminal, the machine, how long, how many steps and how it ended.
function SessionFacts({ session, me }: { session: HistorySession; me: Me }) {
  const parts = [actorOf(session, me), session.machine, spanWords(session.started_at, session.last_active_at), stepsWords(session.steps), outcomeWords(session)]
  return <span className="muted small">{parts.filter((part) => part !== '').join(' · ')}</span>
}

// A dot marks only a session that is working or waiting now.
const isLive = (session: HistorySession) => ['starting', 'running', 'needs_approval', 'needs_input'].includes(session.status)

function SessionRow({ session, me }: { session: HistorySession; me: Me }) {
  return (
    <a className="history-row" href={replayHash(session.id)}>
      <span className="head">
        <span className="kicker">{KIND_WORDS[session.subject.kind]}{session.private ? ' · Private' : ''}</span>
        <span className="muted small">{isLive(session) && <span className={`dot ${session.status}`} aria-hidden="true" />}{whenWords(session)}</span>
      </span>
      <span className="title">{titleOf(session)}</span>
      {session.asked !== null && <span className="asked muted">&ldquo;{session.asked.replace(/\s+/g, ' ')}&rdquo;</span>}
      <SessionFacts session={session} me={me} />
    </a>
  )
}

// A step that matched, with the words that matched in heavier type.
function HitRow({ hit, me }: { hit: SearchHit; me: Me }) {
  const { session } = hit
  return (
    <a className="history-row" href={replayHash(session.id, hit.seq)}>
      <span className="head">
        <span className="kicker">{STEP_LABELS[hit.kind]}{hit.tool_name ? ` · ${hit.tool_name}` : ''}</span>
        <span className="muted small">{day(hit.created_at)}, {clock(hit.created_at)}</span>
      </span>
      <span className="snippet">
        {snippetParts(hit.snippet).map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
      </span>
      <span className="muted small">{titleOf(session)} · {actorOf(session, me)} · step {hit.seq}</span>
    </a>
  )
}
