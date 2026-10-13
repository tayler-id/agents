import { useMemo, useState, type SyntheticEvent } from 'react'
import { go } from './App.tsx'
import { AskCard } from './Asks.tsx'
import {
  act, api, byNumber, clock, repoName, useRows, useSnapshot, type Agent, type Artifact, type Ask, type EventRow, type Person, type Repo, type Session, type Task,
} from './data.ts'
import { Markdown } from './Markdown.tsx'

// A group conversation with teammates and agents.
export function NewRoom({ me }: { me: { person: { id: string } } }) {
  const { rows: people } = useSnapshot<Person>('people', {}, 15000)
  const { rows: agents } = useSnapshot<Agent>('agents', {}, 15000)
  const [name, setName] = useState('')
  const [who, setWho] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const toggle = (key: string) => setWho((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault()
    try {
      const { conversationId } = await api.createRoom(name.trim(),
        people.filter((p) => who.has(`p:${p.id}`)).map((p) => p.login), agents.filter((a) => who.has(`a:${a.id}`)).map((a) => a.name))
      go({ conversation: conversationId })
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <section className="page" aria-label="New room">
      <header className="page-head"><div><p className="kicker">New</p><h1>A room</h1><p className="muted small">Teammates and agents talk together. Each agent takes a turn after a post, or only the ones a post mentions with @name.</p></div></header>
      <div className="page-body">
        <form className="form" onSubmit={act(submit)} aria-label="New room">
          <label htmlFor="room-name">Name</label>
          <input id="room-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="launch" />
          <fieldset>
            <legend className="small muted">Teammates</legend>
            {people.filter((p) => p.id !== me.person.id).map((p) => (
              <label key={p.id} className="check"><input type="checkbox" checked={who.has(`p:${p.id}`)} onChange={() => toggle(`p:${p.id}`)} /> {p.login}</label>
            ))}
          </fieldset>
          <fieldset>
            <legend className="small muted">Agents</legend>
            {agents.map((a) => (
              <label key={a.id} className="check"><input type="checkbox" checked={who.has(`a:${a.id}`)} onChange={() => toggle(`a:${a.id}`)} /> {a.name}</label>
            ))}
          </fieldset>
          <div className="actions">
            <button className="primary" type="submit" disabled={!name.trim()}>Create room</button>
            {error && <p className="error small" role="alert">{error}</p>}
          </div>
        </form>
      </div>
    </section>
  )
}

// Work for an agent outside any pipeline: it gets a workspace, with a repo if you pick one.
export function NewTask() {
  const { rows: agents } = useSnapshot<Agent>('agents', {}, 15000)
  const { rows: repos } = useSnapshot<Repo>('repos', {}, 30000)
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [agent, setAgent] = useState('')
  const [repo, setRepo] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      const agentId = agent || agents[0]?.id
      if (!agentId) throw new Error('Pick an agent first.')
      const { taskId } = await api.startTask({ title: title.trim(), instructions: instructions.trim(), agentId, repoId: repo || undefined })
      go({ task: taskId })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <section className="page" aria-label="New task">
      <header className="page-head"><div><p className="kicker">New</p><h1>A task</h1></div></header>
      <div className="page-body">
        <form className="form" onSubmit={act(submit)} aria-label="New task">
          <label htmlFor="task-title">What needs doing?</label>
          <input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Write the release notes for 1.4" />
          <label htmlFor="task-instructions">Details</label>
          <textarea id="task-instructions" rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          <label htmlFor="task-agent">Agent</label>
          <select id="task-agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <label htmlFor="task-repo">Repo</label>
          <select id="task-repo" value={repo} onChange={(e) => setRepo(e.target.value)}>
            <option value="">None</option>
            {repos.map((r) => <option key={r.id} value={r.id}>{repoName(r.remote_url)}</option>)}
          </select>
          <div className="actions">
            <button className="primary" type="submit" disabled={busy || !title.trim() || !agents.length}>Start task</button>
            {error && <p className="error small" role="alert">{error}</p>}
          </div>
        </form>
      </div>
    </section>
  )
}

const WORKING = new Set(['starting', 'running', 'needs_approval', 'needs_input'])

// A task a person started: the agent's work as a conversation, what it made, and a way to talk to it.
export function TaskView({ taskId, openSession }: { taskId: string; openSession: string | null }) {
  const { rows: tasks } = useSnapshot<Task>('tasks', {}, 4000)
  const { rows: sessions } = useRows<Session>('sessions', { of: 'tasks' })
  const { rows: asks } = useRows<Ask>('asks')
  const { rows: agents } = useSnapshot<Agent>('agents', {}, 15000)
  const { rows: artifacts } = useSnapshot<Artifact>('artifacts', { task: taskId }, 4000)
  const task = tasks.find((t) => t.id === taskId)
  const session = sessions.filter((s) => s.task_id === taskId).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  if (!task) return <section className="page"><p className="muted">Loading the task…</p></section>
  const agent = agents.find((a) => a.id === task.agent_id)
  const send = async (event: SyntheticEvent) => {
    event.preventDefault()
    if (!session || !text.trim()) return
    try {
      await api.messageSession(session.id, text.trim())
      setText('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <section className="page" aria-label="Task">
      <header className="page-head">
        <div>
          <p className="kicker">Task</p>
          <h1>{task.title}</h1>
          <p className="muted small">{agent?.name ?? 'agent'}{session ? ` · ${session.status.replace('_', ' ')}` : ''}</p>
        </div>
        <div className="head-actions">
          {session && <button type="button" className="ghost" onClick={() => go({ task: taskId, session: openSession ? null : session.id })}>{openSession ? 'Hide session' : 'Session details'}</button>}
          {session && WORKING.has(session.status) && <button type="button" className="ghost" onClick={act(() => api.interrupt(session.id))}>Interrupt</button>}
        </div>
      </header>
      <div className="page-body">
        {session ? <Transcript session={session} agentName={agent?.name ?? 'Agent'} /> : <p className="muted small">Starting…</p>}
        {asks.filter((a) => a.session_id === session?.id && a.status === 'open').map((a) => <AskCard key={a.id} ask={a} />)}
        {!!artifacts.length && (
          <>
            <h2 className="kicker section">Made by this task</h2>
            <ul className="artifacts" aria-label="Made by this task">
              {artifacts.map((a) => (
                <li key={a.id}>
                  {a.kind === 'link'
                    ? <a href={a.url ?? '#'} target="_blank" rel="noreferrer">{a.title}</a>
                    : <button type="button" className="link" onClick={() => go({ task: taskId, document: a.id })}>{a.title}</button>}
                  <span className="muted small">{a.kind === 'link' ? a.state : `version ${a.current_version}`}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <form className="composer inline" onSubmit={act(send)}>
          <label htmlFor="task-message" className="sr-only">Message</label>
          <textarea id="task-message" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Tell the agent more" />
          <button type="submit" className="primary" disabled={!session || !text.trim()}>Send</button>
          {error && <p className="error small" role="alert">{error}</p>}
        </form>
      </div>
    </section>
  )
}

// What was asked of the task's agent and what it said back, live.
function Transcript({ session, agentName }: { session: Session; agentName: string }) {
  const { rows: events } = useRows<EventRow>('events', { session: session.id })
  const said = useMemo(() => [...events].sort(byNumber((e: EventRow) => e.seq))
    .filter((e) => (e.kind === 'user' || e.kind === 'error' || (e.kind === 'assistant' && !e.parent_tool_use_id)) && e.text), [events])
  return (
    <ol className="messages task-messages" aria-label="Messages">
      {said.map((e) => (
        <li key={String(e.id)} className={`message ${e.kind === 'user' ? 'person' : e.kind === 'error' ? 'stopped' : 'agent'}`}>
          <div className="meta">
            <strong>{e.kind === 'user' ? 'Request' : agentName}</strong>
            <span className="muted small">{e.kind === 'error' ? `stopped ${clock(e.created_at)}` : clock(e.created_at)}</span>
          </div>
          {e.kind === 'error' ? <p className="text">{e.text}</p> : <div className="text"><Markdown text={e.text ?? ''} /></div>}
        </li>
      ))}
      {WORKING.has(session.status) && <li className="message agent typing"><span className="small working"><span className="dot running" aria-hidden="true" />working</span></li>}
    </ol>
  )
}
