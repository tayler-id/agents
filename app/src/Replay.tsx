// A session replayed: its steps in the order they happened, on a timeline. A person
// plays it, pauses it, steps through it, jumps to the steps that went wrong, and
// reads each message, each tool call with its input and each result in full. A
// long session is read a page at a time, and the page keeps only the steps near
// the one it is on. shared/replay.ts holds how it moves. This file shows it.

import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react'
import { NO_SUCH_SESSION, STEP_LABELS, type HistorySession, type SessionView, type Step } from '../../shared/history.ts'
import {
  errorAfter, errorBefore, playbackDelay, reduce, SPEEDS, START, stepAfter, type Bounds, type Move,
} from '../../shared/replay.ts'
import { go } from './App.tsx'
import { clock, day, messageOf, parseTime, type Me } from './data.ts'
import { actorOf, historyApi, KIND_WORDS, listHash, NO_FILTERS, outcomeWords, replayHash, spanWords, stepsWords, titleOf, whenWords } from './history.ts'
import { Markdown } from './Markdown.tsx'

// A session that is still working gets new steps, so a replay of it reads the session again this often.
const REFRESH_MS = 5000
// The slider reports every number it passes. A drag across a long session settles this long before the replay asks for the steps it lands on.
const SCRUB_MS = 250
// A block longer than this folds into a line until its step is the current one.
const FOLD_LINES = 12
const FOLD_CHARS = 1200

const isWorking = (session: HistorySession) => ['starting', 'running', 'needs_approval', 'needs_input'].includes(session.status)

// The session the replay is of, read again while it works. A session that cannot be read
// says so, and one that was read keeps its last reading when a later one fails.
function useView(sessionId: string) {
  const [state, setState] = useState<{ id: string; view: SessionView | null; error: string }>({ id: '', view: null, error: '' })
  useEffect(() => {
    let stale = false
    let working = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = () => {
      historyApi.session(sessionId).then(
        (view) => {
          if (stale) return
          setState({ id: sessionId, view, error: '' })
          working = isWorking(view.session)
          if (working) timer = setTimeout(read, REFRESH_MS)
        },
        (error: unknown) => {
          if (stale) return
          setState((last) => ({ id: sessionId, view: last.id === sessionId ? last.view : null, error: messageOf(error) }))
          // A session that was working still is, as far as anyone knows, so it is read again.
          if (working) timer = setTimeout(read, REFRESH_MS)
        },
      )
    }
    read()
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [sessionId])
  return state.id === sessionId ? state : { id: sessionId, view: null, error: '' }
}

export function Replay({ me, sessionId, at }: { me: Me; sessionId: string; at: number | null }) {
  const { view, error } = useView(sessionId)
  if (!view) {
    return (
      <section className="page" aria-label="Replay">
        <p className="muted" aria-busy={!error}>{error === NO_SUCH_SESSION ? 'This session is not one you can see.' : error || 'Loading the session…'}</p>
        {error !== '' && <a className="history-back" href={listHash(NO_FILTERS)}>All history</a>}
      </section>
    )
  }
  return <Player me={me} view={view} error={error} at={at} />
}

// The page to open the session's own conversation, task, run or terminal page.
function subjectLink(session: HistorySession): { label: string; open: () => void } {
  const { subject } = session
  switch (subject.kind) {
    case 'conversation': return { label: 'Open the conversation', open: () => { go({ conversation: subject.id }) } }
    case 'task': return { label: 'Open the task', open: () => { go({ task: subject.id }) } }
    case 'run': return { label: 'Open the run', open: () => { go({ run: subject.id }) } }
    case 'terminal': return { label: 'Open the terminal session', open: () => { go({ terminal: session.id }) } }
  }
}

function Player({ me, view, error, at }: { me: Me; view: SessionView; error: string; at: number | null }) {
  const { session } = view
  const sessionId = session.id
  const bounds = useMemo<Bounds>(() => ({ first: view.first_seq, last: view.last_seq }), [view.first_seq, view.last_seq])
  const [state, dispatch] = useReducer(reduce, START, (initial) => reduce(initial, { type: 'start', bounds, at }))
  const { loaded, cursor, playing, speed, request } = state
  const [scrub, setScrub] = useState<number | null>(null)
  const opened = useRef(false)

  // The range the state asks for. A newer ask, or leaving, drops this one's answer.
  useEffect(() => {
    if (!request) return
    let stale = false
    historyApi.steps(sessionId, request.from, request.to).then(
      (page) => { if (!stale) dispatch({ type: 'arrived', id: request.id, page, bounds }) },
      (failure: unknown) => { if (!stale) dispatch({ type: 'failed', id: request.id, message: messageOf(failure) }) },
    )
    return () => { stale = true }
  }, [request, sessionId, bounds])

  // Playing moves on after the real time between two steps, held to a readable range.
  useEffect(() => {
    if (!playing || cursor === null || !loaded) return
    const current = loaded.steps.find((step) => step.seq === cursor)
    const next = stepAfter(loaded, cursor)
    const gap = current && next ? (parseTime(next.created_at)?.getTime() ?? NaN) - (parseTime(current.created_at)?.getTime() ?? NaN) : 0
    const timer = setTimeout(() => { dispatch({ type: 'tick', bounds }) }, playbackDelay(gap, speed))
    return () => { clearTimeout(timer) }
  }, [playing, speed, cursor, loaded, bounds])

  // The step the replay is on stays in view. The first time, it is in the middle.
  useEffect(() => {
    if (cursor === null) return
    document.getElementById(`step-${String(cursor)}`)?.scrollIntoView({ block: opened.current ? 'nearest' : 'center' })
    opened.current = true
  }, [cursor])

  // The address names the step, so the page can be shared. It waits for a pause, since a browser limits how often a page may change its address.
  useEffect(() => {
    if (cursor === null || playing) return
    try {
      window.history.replaceState(null, '', replayHash(sessionId, cursor))
    } catch {
      // The address is a convenience, and the browser may refuse a change it counts as too frequent.
    }
  }, [cursor, playing, sessionId])

  // A drag over the slider asks for the step it ends on.
  useEffect(() => {
    if (scrub === null) return
    const timer = setTimeout(() => {
      dispatch({ type: 'seek', to: scrub, bounds })
      setScrub(null)
    }, SCRUB_MS)
    return () => { clearTimeout(timer) }
  }, [scrub, bounds])

  const goTo = useCallback((seq: number) => { dispatch({ type: 'seek', to: seq, bounds }) }, [bounds])
  const first = view.first_seq
  const last = view.last_seq
  const shown = scrub ?? cursor
  const previousError = cursor === null ? undefined : errorBefore(view.errors, cursor)
  const nextError = cursor === null ? undefined : errorAfter(view.errors, cursor)
  const current = loaded?.steps.find((step) => step.seq === cursor)
  const link = subjectLink(session)
  const slide = (event: KeyboardEvent) => {
    const keys: Record<string, Move | undefined> = {
      ArrowRight: { type: 'step', direction: 1, bounds }, ArrowLeft: { type: 'step', direction: -1, bounds },
      Home: first === null ? undefined : { type: 'seek', to: first, bounds }, End: last === null ? undefined : { type: 'seek', to: last, bounds },
    }
    const move = keys[event.key]
    if (!move) return
    event.preventDefault()
    dispatch(move)
  }

  return (
    <section className="page" aria-label="Replay">
      <header className="page-head">
        <div>
          <p className="kicker">Replay · {KIND_WORDS[session.subject.kind]}{session.private ? ' · Private' : ''}</p>
          <h1>{titleOf(session)}</h1>
          <p className="muted small">
            {[actorOf(session, me), session.machine, `last active ${whenWords(session)}`, spanWords(session.started_at, session.last_active_at), stepsWords(session.steps), outcomeWords(session)]
              .filter((part) => part !== '').join(' · ')}
          </p>
        </div>
        <div className="head-actions">
          <button type="button" className="ghost" onClick={link.open}>{link.label}</button>
          <a className="history-back" href={listHash(NO_FILTERS)}>All history</a>
        </div>
      </header>
      {error !== '' && <p className="error small replay-note" role="alert">{error}</p>}
      <div className="replay-controls" role="group" aria-label="Replay controls">
        <button type="button" disabled={previousError === undefined} onClick={() => { if (previousError !== undefined) goTo(previousError) }}>Previous error</button>
        <button type="button" disabled={cursor === null} onClick={() => { dispatch({ type: 'step', direction: -1, bounds }) }}>Previous step</button>
        <button type="button" className="primary" disabled={cursor === null} onClick={() => { dispatch(playing ? { type: 'pause' } : { type: 'play', bounds }) }}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" disabled={cursor === null} onClick={() => { dispatch({ type: 'step', direction: 1, bounds }) }}>Next step</button>
        <button type="button" disabled={nextError === undefined} onClick={() => { if (nextError !== undefined) goTo(nextError) }}>Next error</button>
        <label>
          Speed
          <select value={speed} onChange={(e) => { dispatch({ type: 'speed', speed: SPEEDS.find((s) => String(s) === e.target.value) ?? 1 }) }}>
            {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
          </select>
        </label>
      </div>
      <div className="replay-position">
        <p className="muted small" role="status" aria-live={playing ? 'off' : 'polite'}>
          {cursor === null || last === null ? 'No steps yet' : `Step ${String(shown ?? cursor)} of ${String(last)}`}
          {current ? ` · ${day(current.created_at)}, ${clock(current.created_at)}` : ''}
          {view.errors_total ? ` · ${String(view.errors_total)} ${view.errors_total === 1 ? 'step' : 'steps'} went wrong` : ''}
        </p>
        {first !== null && last !== null && cursor !== null && (
          <div className="replay-timeline">
            <input type="range" aria-label="Position in the session" min={first} max={last} value={shown ?? cursor}
              aria-valuetext={`Step ${String(shown ?? cursor)} of ${String(last)}`}
              onChange={(e) => { setScrub(Number(e.target.value)) }} onKeyDown={slide} />
            <div className="replay-ticks">
              {view.errors.map((seq) => (
                <button key={seq} type="button" className="replay-tick" aria-label={`Go to the error at step ${String(seq)}`}
                  style={{ left: `${String(last === first ? 0 : ((seq - first) / (last - first)) * 100)}%` }} onClick={() => { goTo(seq) }} />
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="page-body replay-body">
        {loaded === null && <p className="muted" aria-busy="true">Loading the steps…</p>}
        {state.error !== '' && (
          <p className="error small" role="alert">
            {state.error}{' '}
            <button type="button" className="link" onClick={() => { goTo(cursor ?? at ?? first ?? 1) }}>Try again</button>
          </p>
        )}
        {loaded !== null && !loaded.steps.length && request === null && <p className="muted">This session has no steps yet.</p>}
        {loaded !== null && first !== null && loaded.from > first && (
          <button type="button" className="ghost history-more" disabled={request !== null} onClick={() => { dispatch({ type: 'earlier', bounds }) }}>Show earlier steps</button>
        )}
        <ol className="replay-steps" aria-label="Steps">
          {loaded?.steps.map((step, i) => (
            <StepItem key={step.seq} step={step} stamp={stampOf(step, loaded.steps[i - 1])} current={step.seq === cursor}
              ahead={cursor !== null && step.seq > cursor} onGo={goTo} />
          ))}
        </ol>
        {loaded !== null && last !== null && loaded.to < last && (
          <button type="button" className="ghost history-more" disabled={request !== null} onClick={() => { dispatch({ type: 'later', bounds }) }}>Show later steps</button>
        )}
      </div>
    </section>
  )
}

// A step's time, with its day when it begins a new one.
function stampOf(step: Step, before: Step | undefined): string {
  return before && day(before.created_at) === day(step.created_at) ? clock(step.created_at) : `${day(step.created_at)}, ${clock(step.created_at)}`
}

const StepItem = memo(function StepItem({ step, stamp, current, ahead, onGo }: {
  step: Step; stamp: string; current: boolean; ahead: boolean; onGo: (seq: number) => void
}) {
  const classes = ['replay-step', step.sub ? 'sub' : '', current ? 'current' : '', ahead ? 'ahead' : '', step.error ? 'failed' : ''].filter(Boolean).join(' ')
  return (
    <li id={`step-${String(step.seq)}`} className={classes} data-kind={step.kind} aria-current={current ? 'step' : undefined}>
      <div className="replay-meta">
        <button type="button" className="link small" aria-label={`Go to step ${String(step.seq)}`} onClick={() => { onGo(step.seq) }}>{step.seq}</button>
        <span className="kicker">{STEP_LABELS[step.kind]}{step.tool_name ? ` · ${step.tool_name}` : ''}</span>
        {step.error && <span className="kicker"><span aria-hidden="true">! </span>Went wrong</span>}
        <span className="muted small">{stamp}</span>
      </div>
      {step.blocks.map((block, i) => <Block key={i} step={step} label={block.label} text={block.text} open={current} />)}
    </li>
  )
})

function Block({ step, label, text, open }: { step: Step; label: string | null; text: string; open: boolean }) {
  const long = text.length > FOLD_CHARS || text.split('\n').length > FOLD_LINES
  const body = step.kind === 'assistant' && label === null ? <Markdown text={text} /> : <pre>{text}</pre>
  if (!long || open) {
    return (
      <div className="replay-block">
        {label !== null && <span className="replay-label">{label}</span>}
        {body}
      </div>
    )
  }
  return (
    <details className="replay-block">
      <summary>{label !== null && <span className="replay-label">{label} </span>}{text.slice(0, 160).replace(/\s+/g, ' ')}…</summary>
      {body}
    </details>
  )
}
