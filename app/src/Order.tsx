// The order of work in the app: Ready and Held in the sidebar, and on a task's
// page its priority, the tasks it waits on and why, the tasks waiting on it, its
// hold, and Mark done or Reopen. Every command says when it changed nothing.

import { useEffect, useState, type SyntheticEvent } from 'react'
import { go } from './App.tsx'
import { act, api, messageOf, useParsedSnapshot, useSnapshot, type Task } from './data.ts'
import {
  DEFAULT_PRIORITY, HOLD_KINDS, HoldKind, PRIORITIES, TaskBlockRow, TaskHoldRow, type Outcome, type ReadyAnswer, type TaskState,
} from '../../shared/work.ts'
import { TaskId } from '../../shared/ids.ts'

// The sidebar and a task's page both read the ready query, which changes as people work.
const READY_EVERY_MS = 4000

export const HOLD_LABELS: Record<HoldKind, string> = {
  decision: 'Waiting on a decision',
  external: 'Waiting on someone outside the team',
  load: 'Waiting for room to work on it',
  parked: 'Parked',
  future: 'Later',
}

const PRIORITY_LABELS: Record<(typeof PRIORITIES)[number], string> = {
  0: '0, most urgent', 1: '1', 2: '2', 3: '3', 4: '4, least urgent',
}

// The ready query, read again every few seconds, and at once on reload(). Its last
// good answer stays while a read fails, and the failure says why.
export function useReady(): { answer: ReadyAnswer | null; error: string; reload: () => void } {
  const [state, setState] = useState<{ answer: ReadyAnswer | null; error: string }>({ answer: null, error: '' })
  const [asked, setAsked] = useState(0)
  useEffect(() => {
    let stopped = false
    const load = async () => {
      try {
        const answer = await api.ready()
        if (!stopped) setState({ answer, error: '' })
      } catch (e) {
        if (!stopped) setState((last) => ({ answer: last.answer, error: messageOf(e) }))
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, READY_EVERY_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [asked])
  return { ...state, reload: () => { setAsked((n) => n + 1) } }
}

export function ReadyLists({ openTask }: { openTask: string | null }) {
  const { answer, error } = useReady()
  return (
    <>
      <h2 className="kicker">Ready</h2>
      <ul className="list" aria-label="Ready">
        {answer?.ready.map((t) => (
          <li key={t.id}>
            <button type="button" className={`row${t.id === openTask ? ' selected' : ''}`} onClick={() => go({ task: t.id })}>
              <span>{t.title}</span>
              {t.priority !== DEFAULT_PRIORITY && <span className="muted small"><span className="sr-only">priority </span>P{t.priority}</span>}
            </button>
          </li>
        ))}
        {answer && !answer.ready.length && <li className="muted small empty">Nothing ready</li>}
        {error && <li className="error small" role="alert">{error}</li>}
      </ul>
      {!!answer?.held.length && (
        <>
          <h2 className="kicker">Held</h2>
          <ul className="list" aria-label="Held">
            {answer.held.map((t) => (
              <li key={t.id}>
                <button type="button" className={`row stacked${t.id === openTask ? ' selected' : ''}`} onClick={() => go({ task: t.id })}>
                  <span>{t.title}</span>
                  <span className="muted small">{HOLD_LABELS[t.kind]}: {t.reason}{t.until ? `, until ${t.until}` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

const said = (outcome: Outcome) => (outcome.already ? 'Nothing to change.' : 'Saved.')

// A task's place in the order of work.
export function TaskOrder({ task, state }: { task: Task; state: TaskState }) {
  const { rows: tasks } = useSnapshot<Task>('tasks', {}, 4000)
  const { rows: waitsOn, error: unreadWaits } = useParsedSnapshot(TaskBlockRow, 'task_blocks', { task: task.id }, 2000)
  const { rows: blocks, error: unreadBlocks } = useParsedSnapshot(TaskBlockRow, 'task_blocks', { blocker: task.id }, 2000)
  const { rows: holds, error: unreadHold } = useParsedSnapshot(TaskHoldRow, 'task_holds', { task: task.id }, 2000)
  const { answer, reload } = useReady()
  const [blocker, setBlocker] = useState('')
  const [why, setWhy] = useState('')
  const [kind, setKind] = useState<HoldKind>('decision')
  const [reason, setReason] = useState('')
  const [until, setUntil] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  // An edge can reach a private task this person cannot see, so its title stays unknown.
  const titleOf = (taskId: string) => tasks.find((t) => t.id === taskId)?.title ?? 'a task you cannot see'
  const hold = holds[0]
  // The server's date decides when a hold lapses, so the ready query says whether it is current.
  // A hold with no end date never lapses. One with a date lapses by the server's
  // date, which the ready query reports.
  const lapsed = hold?.until !== undefined && hold.until !== null && answer !== null && !answer.held.some((t) => t.id === task.id)
  const open = state === 'queued' || state === 'active'
  const run = async (command: () => Promise<Outcome>) => {
    setNote('')
    setError('')
    try {
      setNote(said(await command()))
      reload()
    } catch (e) {
      setError(messageOf(e))
    }
  }
  const addBlocker = (event: SyntheticEvent) => {
    event.preventDefault()
    return run(async () => {
      const outcome = await api.block(task.id, { blockerId: TaskId.parse(blocker), reason: why.trim() || null })
      setBlocker('')
      setWhy('')
      return outcome
    })
  }
  const holdIt = (event: SyntheticEvent) => {
    event.preventDefault()
    return run(() => api.hold(task.id, { kind, reason: reason.trim(), until: until || null }))
  }
  const others = tasks.filter((t) => t.id !== task.id && !t.done_at && !waitsOn.some((w) => w.blocker_id === t.id))
  const unread = unreadWaits ?? unreadBlocks ?? unreadHold
  return (
    <section className="order" aria-label="Order of work">
      <h2 className="kicker section">Order</h2>
      {unread && <p className="error small" role="alert">{unread}</p>}
      <div className="order-line">
        <label htmlFor={`priority-${task.id}`} className="small muted">Priority</label>
        <select id={`priority-${task.id}`} value={task.priority} disabled={!open}
          onChange={(e) => { void run(() => api.prioritize(task.id, Number(e.target.value))) }}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
        </select>
        {state === 'done'
          ? <button type="button" onClick={act(() => run(() => api.reopen(task.id)))}>Reopen</button>
          : <button type="button" onClick={act(() => run(() => api.markDone(task.id)))}>Mark done</button>}
        {note && <span className="muted small" role="status">{note}</span>}
      </div>
      {error && <p className="error small" role="alert">{error}</p>}

      <h3 className="small">Waits on</h3>
      <ul className="plain order-list" aria-label="Waits on">
        {waitsOn.map((edge) => {
          const done = Boolean(tasks.find((t) => t.id === edge.blocker_id)?.done_at)
          return (
            <li key={edge.blocker_id}>
              <button type="button" className="link" onClick={() => go({ task: edge.blocker_id })}>{titleOf(edge.blocker_id)}</button>
              <span className="muted small">{done ? 'done' : 'not done'}{edge.reason ? ` · ${edge.reason}` : ''}</span>
              <button type="button" className="link small" onClick={act(() => run(() => api.unblock(task.id, edge.blocker_id)))}>Remove</button>
            </li>
          )
        })}
        {!waitsOn.length && <li className="muted small">Nothing</li>}
      </ul>
      {open && (
        <form className="form inline-form" onSubmit={act(addBlocker)} aria-label="Wait on another task">
          <label htmlFor={`blocker-${task.id}`} className="sr-only">Task to wait on</label>
          <select id={`blocker-${task.id}`} value={blocker} onChange={(e) => setBlocker(e.target.value)}>
            <option value="">Wait on…</option>
            {others.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
          <label htmlFor={`why-${task.id}`} className="sr-only">Why (optional)</label>
          <input id={`why-${task.id}`} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why (optional)" />
          <button type="submit" disabled={!blocker}>Add</button>
        </form>
      )}
      {!!blocks.length && (
        <p className="small muted">Waiting on this: {blocks.map((edge) => titleOf(edge.blocked_id)).join(', ')}</p>
      )}

      <h3 className="small">Hold</h3>
      {hold && (
        <p className="hold-line">
          <span>{HOLD_LABELS[hold.kind]}: {hold.reason}{hold.until ? `, until ${hold.until}` : ''}</span>
          {lapsed && <span className="muted small">lapsed</span>}
          <button type="button" className="link small" onClick={act(() => run(() => api.unhold(task.id)))}>Lift hold</button>
        </p>
      )}
      {open && (!hold || lapsed) && (
        <form className="form inline-form" onSubmit={act(holdIt)} aria-label="Hold this task">
          <label htmlFor={`kind-${task.id}`} className="sr-only">Waiting on</label>
          <select id={`kind-${task.id}`} value={kind} onChange={(e) => setKind(HoldKind.parse(e.target.value))}>
            {HOLD_KINDS.map((k) => <option key={k} value={k}>{HOLD_LABELS[k]}</option>)}
          </select>
          <label htmlFor={`reason-${task.id}`} className="sr-only">Reason</label>
          <input id={`reason-${task.id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why, in one line" />
          <label htmlFor={`until-${task.id}`} className="sr-only">Until (optional)</label>
          <input id={`until-${task.id}`} type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          <button type="submit" disabled={!reason.trim()}>Hold</button>
        </form>
      )}
      {!hold && !open && <p className="muted small">No hold.</p>}
    </section>
  )
}
