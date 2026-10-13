// A draft task: written now, started later. Anyone on the team can change it,
// start it, or discard it. Starting saves what the form holds first, when the
// person changed it.

import { useState, type SyntheticEvent } from 'react'
import type { z } from 'zod'
import { go } from './App.tsx'
import { act, api, messageOf, useParsedSnapshot, useSnapshot, type Agent, type Person, type Task } from './data.ts'
import { RepoPicker } from './RepoPicker.tsx'
import { TaskOrder } from './Order.tsx'
import { TaskRepoRow, type DraftEdit, type TaskState } from '../../shared/work.ts'

export function DraftView({ task, state }: { task: Task; state: TaskState }) {
  const { rows: repos, loaded, error } = useParsedSnapshot(TaskRepoRow, 'task_repos', { task: task.id }, 15000)
  const { rows: people } = useSnapshot<Person>('people', {}, 30000)
  const author = people.find((p) => p.id === task.owner_id)?.login
  return (
    <section className="page" aria-label="Draft task">
      <header className="page-head">
        <div>
          <p className="kicker">Draft task</p>
          <h1>{task.title}</h1>
          <p className="muted small">{author ? `Written by ${author}. ` : ''}It starts when someone starts it.</p>
        </div>
      </header>
      <div className="page-body">
        {error ? <p className="error small" role="alert">{error}</p>
          : !loaded ? <p className="muted small">Loading the draft…</p>
            : <DraftForm task={task} repoIds={[...repos].sort((a, b) => Number(b.is_primary) - Number(a.is_primary)).map((r) => r.repo_id)} />}
        <TaskOrder task={task} state={state} />
      </div>
    </section>
  )
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((value, i) => value === b[i])

// The form starts from the draft as saved, so it mounts once the draft's repos load.
function DraftForm({ task, repoIds: saved }: { task: Task; repoIds: string[] }) {
  const { rows: agents } = useSnapshot<Agent>('agents', {}, 15000)
  // The draft as this form loaded or last saved it. A save sends it, and the server
  // refuses one when a teammate has changed the draft since.
  const [loaded, setLoaded] = useState<z.input<typeof DraftEdit>['loaded']>(() => (
    { title: task.title, instructions: task.instructions, agentId: task.agent_id, repoIds: saved }))
  const [title, setTitle] = useState(task.title)
  const [instructions, setInstructions] = useState(task.instructions)
  const [agent, setAgent] = useState(task.agent_id ?? '')
  const [repoIds, setRepoIds] = useState(saved)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const agentId = agent || agents[0]?.id
  const fields = () => {
    if (!agentId) throw new Error('Pick an agent first.')
    return { title: title.trim(), instructions: instructions.trim(), agentId, repoIds }
  }
  const run = async (what: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await what()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  const touched = title !== loaded.title || instructions !== loaded.instructions || agentId !== loaded.agentId || !sameList(repoIds, loaded.repoIds)
  const save = (event: SyntheticEvent) => {
    event.preventDefault()
    return run(async () => {
      const saving = fields()
      await api.editDraft(task.id, { ...saving, loaded })
      setLoaded(saving)
      setStatus('Saved.')
    })
  }
  // An untouched form starts the draft as it is now, which may hold a teammate's newer edit.
  const start = () => run(async () => {
    if (touched) await api.editDraft(task.id, { ...fields(), loaded })
    await api.startDraft(task.id)
  })
  const discard = () => run(async () => {
    await api.discardDraft(task.id)
    go({})
  })
  return (
    <form className="form" onSubmit={act(save)} aria-label="Edit the draft">
      <label htmlFor="draft-title">What needs doing?</label>
      <input id="draft-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <label htmlFor="draft-instructions">Details</label>
      <textarea id="draft-instructions" rows={6} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      <label htmlFor="draft-agent">Agent</label>
      <select id="draft-agent" value={agentId ?? ''} onChange={(e) => setAgent(e.target.value)}>
        {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <RepoPicker value={repoIds} onChange={setRepoIds} />
      <div className="actions">
        <button type="button" className="primary" disabled={busy || !title.trim() || !agentId} onClick={act(start)}>Start task</button>
        <button type="submit" disabled={busy || !title.trim() || !agentId}>Save draft</button>
        <button type="button" className="ghost" disabled={busy} onClick={act(discard)}>Discard draft</button>
        {status && <p className="muted small" role="status">{status}</p>}
        {error && <p className="error small" role="alert">{error}</p>}
      </div>
    </form>
  )
}
