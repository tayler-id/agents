// A draft task: written now, started later. Anyone on the team can change it,
// start it, or discard it. Starting saves what the form holds first.

import { useState, type SyntheticEvent } from 'react'
import { go } from './App.tsx'
import { act, api, messageOf, useParsedSnapshot, useSnapshot, type Agent, type Person, type Task } from './data.ts'
import { RepoPicker } from './RepoPicker.tsx'
import { TaskRepoRow } from '../../shared/work.ts'

export function DraftView({ task }: { task: Task }) {
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
      </div>
    </section>
  )
}

// The form starts from the draft as saved, so it mounts once the draft's repos load.
function DraftForm({ task, repoIds: saved }: { task: Task; repoIds: string[] }) {
  const { rows: agents } = useSnapshot<Agent>('agents', {}, 15000)
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
  const save = (event: SyntheticEvent) => {
    event.preventDefault()
    return run(async () => {
      await api.editDraft(task.id, fields())
      setStatus('Saved.')
    })
  }
  const start = () => run(async () => {
    await api.editDraft(task.id, fields())
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
