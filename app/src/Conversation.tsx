import { useEffect, useMemo, useRef, useState, type SyntheticEvent, type KeyboardEvent } from 'react'
import { go } from './App.tsx'
import {
  act, messageOf, api, byNumber, clock, newId, useRows, useSnapshot, type Agent, type Ask, type Conversation, type EventRow, type Me, type Member, type Message, type Person,
  type Session,
} from './data.ts'
import { useLiveText } from './live.ts'
import { AskCard } from './Asks.tsx'
import { Markdown } from './Markdown.tsx'

const WORKING = new Set(['starting', 'running', 'needs_approval', 'needs_input'])
// How often an open People panel looks again for who is in the room.
const MEMBERS_POLL_MS = 3000

type Pending = { clientId: string; text: string }

export function ConversationView({ me, conversationId, sessionOpen }: { me: Me; conversationId: string; sessionOpen: string | null }) {
  const { rows: messages } = useRows<Message>('messages', { conversation: conversationId })
  const { rows: conversations } = useSnapshot<Conversation>('conversations')
  const { rows: sessions } = useRows<Session>('sessions', { of: 'conversations' })
  const { rows: asks } = useRows<Ask>('asks')
  const { rows: agents } = useSnapshot<Agent>('agents')
  const { rows: people } = useSnapshot<Person>('people')
  const [pending, setPending] = useState<Pending[]>([])
  const [peopleOpen, setPeopleOpen] = useState(false)

  const conversation = conversations.find((c) => c.id === conversationId)
  const agent = agents.find((a) => a.id === conversation?.agent_id)
  // In a room several agents have sessions. The one taking its turn is the one to show.
  const ownSessions = sessions.filter((s) => s.conversation_id === conversationId).sort((a, b) => b.created_at.localeCompare(a.created_at))
  const session = ownSessions.find((s) => WORKING.has(s.status)) ?? ownSessions[0]
  // Each agent's newest session. One that failed says why until the agent runs again.
  const newest = new Map<string, Session>()
  for (const s of ownSessions) if (!newest.has(s.agent_id)) newest.set(s.agent_id, s)
  const failed = [...newest.values()].filter((s) => s.status === 'failed')
  // A turn cut off when its machine stopped. It picks up again when the machine is back.
  const lost = [...newest.values()].filter((s) => s.status === 'lost')
  const room = conversation?.kind === 'room'
  const canPost = Boolean(agent) || (room && conversation.source !== 'pipeline')
  const working = Boolean(session && WORKING.has(session.status))
  const openAsks = asks.filter((a) => a.conversation_id === conversationId && a.status === 'open')
  const sorted = useMemo(() => [...messages].sort(byNumber((m: Message) => m.seq)), [messages])
  const synced = new Set(messages.map((m) => m.client_id))
  const waiting = pending.filter((p) => !synced.has(`person:${p.clientId}`))
  // A person's post with no person is a routine's prompt.
  const login = (id: string | null) => (id === null ? 'Routine' : id === me.person.id ? 'You' : people.find((p) => p.id === id)?.login ?? 'Someone')

  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [sorted.length, waiting.length, openAsks.length])

  const send = async (text: string) => {
    const clientId = newId()
    setPending((p) => [...p, { clientId, text }])
    try {
      await api.send(conversationId, text, clientId)
    } catch (error) {
      setPending((p) => p.filter((x) => x.clientId !== clientId))
      throw error
    }
  }

  return (
    <section className="conversation">
      <header className="conversation-head">
        <div>
          <h1>{room ? `# ${conversation.name ?? 'room'}` : agent?.name ?? 'Conversation'}</h1>
          <p className="muted small">
            {conversation?.visibility === 'private' ? 'Private' : 'Shared with your team'}
            {session && <> · <button type="button" className="link" onClick={() => go({ conversation: conversationId, session: sessionOpen ? null : session.id })}>
              {sessionOpen ? 'Hide session' : 'Session details'}</button></>}
          </p>
        </div>
        <div className="head-actions">
          {room && (
            <button type="button" className="ghost" aria-expanded={peopleOpen} aria-controls="room-people" onClick={() => setPeopleOpen((open) => !open)}>
              People
            </button>
          )}
          {agent && conversation?.kind === 'dm' && <button type="button" className="ghost" onClick={() => go({ agent: agent.id })}>Agent setup</button>}
          {session && (working || session.status === 'lost') && <button type="button" className="ghost" onClick={act(() => api.interrupt(session.id))}>Interrupt</button>}
        </div>
      </header>
      {room && peopleOpen && <RoomPeople me={me} conversationId={conversationId} people={people} agents={agents} />}

      <ol className="messages" aria-live="polite" aria-label="Messages" tabIndex={0}>
        {sorted.map((m) => (
          <li key={m.id} className={`message ${m.speaker}`}>
            <div className="meta">
              <strong>{m.speaker === 'agent' ? agents.find((a) => a.id === m.agent_id)?.name ?? 'Agent' : login(m.person_id)}</strong>
              <span className="muted small">{clock(m.created_at)}</span>
            </div>
            {m.speaker === 'agent' ? <div className="text"><Markdown text={m.body} /></div> : <p className="text">{m.body}</p>}
            {m.speaker === 'person' && conversation?.kind === 'dm' && agent && (
              m.task_id
                ? <button type="button" className="link small" onClick={() => go({ task: m.task_id })}>Open its task</button>
                : <button type="button" className="link small" onClick={act(async () => go({ task: (await api.startTask({
                  title: (m.body.split('\n')[0] ?? m.body).slice(0, 120), instructions: m.body, agentId: agent.id, conversationId, messageId: m.id,
                })).taskId }))}>Make it a task</button>
            )}
          </li>
        ))}
        {waiting.map((p) => (
          <li key={p.clientId} className="message person pending">
            <div className="meta"><strong>You</strong><span className="muted small">sending</span></div>
            <p className="text">{p.text}</p>
          </li>
        ))}
        {failed.map((s) => <Stopped key={s.id} session={s} agentName={agents.find((a) => a.id === s.agent_id)?.name ?? 'Agent'} />)}
        {lost.map((s) => <Interrupted key={s.id} session={s} agentName={agents.find((a) => a.id === s.agent_id)?.name ?? 'Agent'} />)}
        {session && working && <Typing session={session} agentName={agents.find((a) => a.id === session.agent_id)?.name ?? 'Agent'} asking={openAsks.length > 0} />}
      </ol>

      {openAsks.map((ask) => <AskCard key={ask.id} ask={ask} />)}
      <div ref={end} />
      <Composer onSend={send} disabled={!canPost} placeholder={room ? 'Post to the room. @name asks one agent.' : 'Message the agent'} />
    </section>
  )
}

const byLogin = (a: Person, b: Person) => a.login.localeCompare(b.login)

// Who is in a room, and adding a teammate to it, which admins and people in the room may do.
function RoomPeople({ me, conversationId, people, agents }: { me: Me; conversationId: string; people: Person[]; agents: Agent[] }) {
  const { rows: members } = useSnapshot<Member>('conversation_members', {}, MEMBERS_POLL_MS)
  // People added from here, shown in the room before the next look at its members.
  const [added, setAdded] = useState<string[]>([])
  const [login, setLogin] = useState('')
  const [said, setSaid] = useState('')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const inRoom = members.filter((m) => m.conversation_id === conversationId)
  const personIds = new Set([...inRoom.flatMap((m) => (m.person_id ? [m.person_id] : [])), ...added])
  const agentIds = new Set(inRoom.flatMap((m) => (m.agent_id ? [m.agent_id] : [])))
  // You first, then everyone else by login.
  const here = people.filter((p) => personIds.has(p.id)).sort((a, b) => Number(b.id === me.person.id) - Number(a.id === me.person.id) || byLogin(a, b))
  const others = people.filter((p) => !personIds.has(p.id)).sort(byLogin)
  const canAdd = me.person.role === 'admin' || personIds.has(me.person.id)
  const chosen = others.find((p) => p.login === login) ?? others[0]
  const add = async (event: SyntheticEvent) => {
    event.preventDefault()
    if (!chosen) return
    setBusy(true)
    setSaid('')
    setProblem('')
    try {
      const { personId } = await api.addRoomMember(conversationId, chosen.login)
      setAdded((ids) => [...ids, personId])
      setSaid(`Added ${chosen.name ?? chosen.login} to the room.`)
    } catch (e) {
      setProblem(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="room-people" id="room-people" aria-label="People in the room">
      <div className="in-room">
        <h2 className="kicker">In the room</h2>
        <ul className="names" aria-label="In the room">
          {here.map((p) => <li key={p.id}>{p.id === me.person.id ? 'You' : p.name ?? p.login}</li>)}
          {agents.filter((a) => agentIds.has(a.id)).map((a) => <li key={a.id} className="muted">{a.name}, an agent</li>)}
        </ul>
      </div>
      {canAdd && chosen && (
        <form className="form fitted" onSubmit={act(add)} aria-label="Add a teammate">
          <label htmlFor="room-add">Teammate</label>
          <div className="add-line">
            <select id="room-add" value={chosen.login} onChange={(e) => setLogin(e.target.value)}>
              {others.map((p) => <option key={p.id} value={p.login}>{p.name ? `${p.name}, ${p.login}` : p.login}</option>)}
            </select>
            <button type="submit" className="primary" disabled={busy}>Add</button>
          </div>
        </form>
      )}
      {canAdd && !chosen && <p className="muted small">Everyone on the team is in the room.</p>}
      {!canAdd && <p className="muted small">People in the room, and admins, can add a teammate.</p>}
      {said && <p className="small" role="status">{said}</p>}
      {problem && <p className="error small" role="alert">{problem}</p>}
    </section>
  )
}

// The agent at work: its newest tool call this turn, and its words as it types them.
function Typing({ session, agentName, asking }: { session: Session; agentName: string; asking: boolean }) {
  const { rows: events } = useRows<EventRow>('events', { session: session.id })
  const live = useLiveText(session.id, true)
  const settled = useMemo(() => new Set(events.filter((e) => e.kind === 'assistant').map((e) => String(e.body.messageId))), [events])
  const ordered = [...events].sort(byNumber((e: EventRow) => e.seq))
  const turnStart = Math.max(0, ...ordered.filter((e) => e.kind === 'user').map((e) => Number(e.seq)))
  const lastCall = ordered.reverse().find((e) => e.kind === 'tool_call' && !e.parent_tool_use_id && Number(e.seq) > turnStart)
  const typing = live && !settled.has(live.messageId) ? live.text : ''
  const status = asking || session.status === 'needs_approval' ? 'waiting for approval' : lastCall?.text ?? (typing ? 'writing' : 'thinking')
  return (
    <li className="message agent typing">
      <div className="meta">
        <strong>{agentName}</strong>
        <span className="small working"><span className="dot running" aria-hidden="true" />{status}</span>
      </div>
      {typing && <p className="text" data-testid="live-text">{typing}</p>}
    </li>
  )
}

// An agent whose session failed, with the reason its machine or Claude gave. Read
// now and then rather than live, since the reason does not change.
function Stopped({ session, agentName }: { session: Session; agentName: string }) {
  const { rows: events } = useSnapshot<EventRow>('events', { session: session.id }, 10000)
  const reason = [...events].sort(byNumber((e: EventRow) => e.seq)).reverse().find((e) => e.kind === 'error')?.text
  return (
    <li className="message stopped">
      <div className="meta"><strong>{agentName}</strong><span className="muted small">stopped</span></div>
      <p className="text">{reason ?? 'Its session failed.'}</p>
    </li>
  )
}

// An agent whose turn was cut off when its machine stopped, with what the record
// says happened. Its machine resumes the turn when it is back, and an interrupt
// sent meanwhile ends the turn instead.
function Interrupted({ session, agentName }: { session: Session; agentName: string }) {
  const { rows: events } = useSnapshot<EventRow>('events', { session: session.id }, 10000)
  const notice = [...events].sort(byNumber((e: EventRow) => e.seq)).reverse().find((e) => e.kind === 'notice' && e.body.subtype === 'interrupted')
  return (
    <li className="message stopped" data-testid="interrupted">
      <div className="meta"><strong>{agentName}</strong><span className="muted small">interrupted</span></div>
      {/* The reason is read every few seconds, so it can arrive after the status. */}
      <p className="text">{notice?.text ?? 'Its machine stopped in the middle of this turn.'} It picks up again when its machine is back.</p>
    </li>
  )
}

function Composer({ onSend, disabled, placeholder }: { onSend: (text: string) => Promise<void>; disabled: boolean; placeholder: string }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const submit = async (event?: SyntheticEvent) => {
    event?.preventDefault()
    const value = text.trim()
    if (!value) return
    setText('')
    setError('')
    await onSend(value).catch((e: unknown) => { setError(messageOf(e)); setText(value) })
  }
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) void submit(event)
  }
  return (
    <form className="composer" onSubmit={act(submit)}>
      <label htmlFor="composer-text" className="sr-only">Message</label>
      <textarea id="composer-text" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={keys}
        placeholder={placeholder} rows={2} disabled={disabled} />
      <button type="submit" className="primary" disabled={disabled || !text.trim()}>Send</button>
      {error && <p className="error small" role="alert">{error}</p>}
    </form>
  )
}
