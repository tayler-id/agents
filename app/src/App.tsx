import { useCallback, useEffect, useMemo, useState } from 'react'
import { JoinRequestRow, type JoinAnswer } from '../../shared/onboarding.ts'
import { isWorking } from '../../shared/lifecycle.ts'
import {
  act, conversationLabel, messageOf, api, type Agent, type Conversation, type Instance, type Me, type Member, type Person, type Pipeline, type Repo, type Run, type Session, type Task,
  useSnapshot, useSnapshotOf,
} from './data.ts'
import { TeamPage, Waiting } from './Team.tsx'
import { keyWarning, TailscalePage, useTailscaleView } from './Tailscale.tsx'
import { BoxPage, GettingStarted } from './Box.tsx'
import { FilePanel } from './FilePanel.tsx'
import { Palette, paletteKey, useShortcuts } from './Palette.tsx'
import { ReadyLists } from './Order.tsx'
import { ConversationView } from './Conversation.tsx'
import { SessionPanel } from './Session.tsx'
import { RunView, shortRunLabel } from './Run.tsx'
import { PipelineView } from './Pipeline.tsx'
import { DocumentPanel } from './Document.tsx'
import { AgentPage, NewAgent } from './AgentPage.tsx'
import { NewRoom, NewTask, TaskView } from './Work.tsx'
import { NewProject, ProjectPage, ReposView } from './Projects.tsx'
import { ProjectRow } from '../../shared/projects.ts'

// Pages with no id of their own, such as the team and the team's repos.
const PAGES = ['team', 'tailscale', 'box', 'repos'] as const
type Page = (typeof PAGES)[number]

// Where the app is: a conversation, run, task, pipeline, agent, project, page or
// new-thing form in the middle, and maybe a session, a document or a changed file
// beside it. A new task or room can be started inside a project.
type Route = {
  conversation: string | null; run: string | null; task: string | null; pipeline: string | null; agent: string | null; project: string | null
  create: 'agent' | 'room' | 'task' | 'project' | null; inProject: string | null; page: Page | null; session: string | null; document: string | null
  file: string | null
}
const EMPTY: Route = {
  conversation: null, run: null, task: null, pipeline: null, agent: null, project: null, create: null, inProject: null, page: null, session: null, document: null,
  file: null,
}
const KINDS = { c: 'conversation', r: 'run', t: 'task', p: 'pipeline', a: 'agent', project: 'project' } as const
const CREATE = ['agent', 'room', 'task', 'project'] as const
const isCreate = (value: string): value is (typeof CREATE)[number] => CREATE.some((kind) => kind === value)

function readRoute(): Route {
  const [, kind = '', id = '', sub, subId] = window.location.hash.split('/')
  const route = { ...EMPTY }
  if (kind in KINDS) route[KINDS[kind as keyof typeof KINDS]] = id || null
  if (kind === 'n' && isCreate(id)) {
    route.create = id
    route.inProject = sub || null
  }
  // Null when the hash names no page.
  route.page = PAGES.find((page) => page === kind) ?? null
  if (sub === 's') route.session = subId || null
  if (sub === 'd') route.document = subId || null
  if (sub === 'f') route.file = subId || null
  return route
}

export function go(to: Partial<Route>) {
  const r = { ...EMPTY, ...to }
  const side = r.session ? `/s/${r.session}` : r.document ? `/d/${r.document}` : r.file ? `/f/${r.file}` : ''
  const found = Object.entries(KINDS).find(([, key]) => r[key])
  window.location.hash = r.page ? `#/${r.page}`
    : r.create ? `#/n/${r.create}${r.inProject ? `/${r.inProject}` : ''}`
      : found ? `#/${found[0]}/${r[found[1]]}${side}` : '#/'
}

function useRoute(): Route {
  const [route, setRoute] = useState(readRoute)
  useEffect(() => {
    const update = () => setRoute(readRoute())
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  return route
}

export function App() {
  const [me, setMe] = useState<JoinAnswer | null>(null)
  const [error, setError] = useState('')
  // Reading who you are changes nothing. A login on no team then asks to join,
  // which joins it through an invite or puts it under "Wants to join".
  useEffect(() => {
    api.me().then((seen) => (seen.kind === 'member' ? seen : api.join())).then(setMe, (e: unknown) => { setError(messageOf(e)) })
  }, [])

  if (error) {
    return (
      <main className="blocked">
        <h1>Can't open the app</h1>
        <p>{error}</p>
        <p className="muted">The app knows people by their Tailscale login. Open it from a device on the tailnet.</p>
      </main>
    )
  }
  if (!me) return <main className="blocked" aria-busy="true"><p className="muted">Connecting…</p></main>
  if (me.kind === 'waiting') return <Waiting me={me} onJoined={setMe} />
  return <Workspace me={me} />
}

function Workspace({ me }: { me: Me }) {
  const route = useRoute()
  // The menu stays open only on the route it was opened on, so going anywhere closes it.
  const here = window.location.hash
  const [menuOpenOn, setMenuOpenOn] = useState<string | null>(null)
  const menuOpen = menuOpenOn === here
  const setMenuOpen = (open: boolean) => { setMenuOpenOn(open ? here : null) }
  const { rows: runs } = useSnapshot<Run>('runs', {}, 4000)
  const [palette, setPalette] = useState(false)
  const togglePalette = useCallback(() => setPalette((open) => !open), [])
  useShortcuts(togglePalette)
  const side = Boolean(route.session || route.document || route.file)
  // Documents and files hold lines of text, so their panel takes more of the width.
  const wide = Boolean(route.document || route.file)
  const taskOfPanel = route.task ?? runs.find((r) => r.id === route.run)?.task_id ?? null
  const back = () => go({ conversation: route.conversation, run: route.run, task: route.task })
  return (
    <div className={`shell${side ? ' with-panel' : ''}${wide ? ' wide' : ''}${menuOpen ? ' menu-open' : ''}`}>
      <header className="topbar">
        <button type="button" className="ghost" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>Menu</button>
        <span className="topbar-title">{me.team.name}</span>
        <button type="button" className="ghost push" onClick={togglePalette}>Go to</button>
      </header>
      <Sidebar me={me} route={route} runs={runs} openPalette={togglePalette} />
      {palette && <Palette me={me} onClose={() => setPalette(false)} />}
      <main className="main" tabIndex={-1} aria-label={route.page === 'team' ? 'Team' : route.page === 'tailscale' ? 'Tailscale' : route.page === 'box' ? 'Your box'
        : route.page === 'repos' ? 'Repos' : route.run ? 'Run' : route.task ? 'Task' : route.pipeline ? 'Pipeline' : route.agent ? 'Agent'
          : route.project ? 'Project' : 'Conversation'}>
        {route.page === 'team' ? <TeamPage me={me} />
          : route.page === 'tailscale' ? <TailscalePage me={me} />
          : route.page === 'box' ? <BoxPage me={me} />
          : route.page === 'repos' ? <ReposView me={me} />
          : route.conversation ? <ConversationView key={route.conversation} me={me} conversationId={route.conversation} sessionOpen={route.session} />
          : route.run ? <RunView key={route.run} runId={route.run} openSession={route.session} openFile={route.file} />
            : route.task ? <TaskView key={route.task} taskId={route.task} openSession={route.session} openFile={route.file} />
              : route.pipeline ? <PipelineView key={route.pipeline} pipelineId={route.pipeline} />
                : route.agent ? <AgentPage key={route.agent} agentId={route.agent} />
                  : route.project ? <ProjectPage key={route.project} projectId={route.project} />
                    : route.create === 'agent' ? <NewAgent me={me} />
                      : route.create === 'room' ? <NewRoom key={route.inProject} me={me} projectId={route.inProject} />
                        : route.create === 'task' ? <NewTask key={route.inProject} projectId={route.inProject} />
                          : route.create === 'project' ? <NewProject me={me} />
                            : <Welcome me={me} />}
      </main>
      {route.session && (route.conversation || route.run || route.task) && (
        <SessionPanel key={route.session} sessionId={route.session} of={route.conversation ? 'conversations' : 'tasks'} onClose={back} />
      )}
      {route.document && (route.run || route.task) && (
        <DocumentPanel key={route.document} artifactId={route.document} taskId={taskOfPanel} onClose={back} />
      )}
      {route.file && taskOfPanel && <FilePanel key={route.file} changeId={route.file} taskId={taskOfPanel} onClose={back} />}
    </div>
  )
}

// A newcomer sees their first steps here until their box is ready and they are signed in to Claude.
function Welcome({ me }: { me: Me }) {
  return (
    <GettingStarted me={me}>
      <section className="welcome">
        <h1>Pick an agent to talk to</h1>
        <p className="muted">Every conversation, every pipeline run and everything their agents do is shared with your team as it happens.</p>
      </section>
    </GettingStarted>
  )
}

function Sidebar({ me, route, runs, openPalette }: { me: Me; route: Route; runs: Run[]; openPalette: () => void }) {
  const { rows: agents } = useSnapshot<Agent>('agents')
  const { rows: conversations } = useSnapshot<Conversation>('conversations')
  const { rows: members } = useSnapshot<Member>('conversation_members')
  const { rows: people } = useSnapshot<Person>('people')
  const { rows: instances } = useSnapshot<Instance>('instances')
  const { rows: pipelines } = useSnapshot<Pipeline>('pipelines', {}, 10000)
  const { rows: tasks } = useSnapshot<Task>('tasks', {}, 4000)
  const { rows: projects } = useSnapshotOf(ProjectRow, 'projects', {}, 10000)
  const { rows: repos } = useSnapshot<Repo>('repos', {}, 30000)
  // Polled, so the sidebar holds none of the browser's six connections.
  const { rows: conversationSessions } = useSnapshot<Session>('sessions', { of: 'conversations' }, 3000)
  const { rows: taskSessions } = useSnapshot<Session>('sessions', { of: 'tasks' }, 3000)
  const sessions = [...conversationSessions, ...taskSessions]
  // Logins waiting for an admin, and the Tailscale key's expiry, which only admins can read.
  const admin = me.person.role === 'admin'
  const { rows: waitingToJoin } = useSnapshotOf(JoinRequestRow, 'join_requests', admin ? {} : null, 10000)
  const keyAlert = keyWarning(useTailscaleView(admin))
  const [opening, setOpening] = useState('')
  const [boxError, setBoxError] = useState('')

  const agentName = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents])
  const login = useMemo(() => new Map(people.map((p) => [p.id, p.login])), [people])
  const current = conversations.find((c) => c.id === route.conversation)
  const taskTitle = (taskId: string) => tasks.find((t) => t.id === taskId)?.title ?? 'Run'

  const label = (c: Conversation) => conversationLabel(c, { me, members, agentName, login })

  const open = async (agent: Agent) => {
    setOpening(agent.id)
    try {
      go({ conversation: (await api.openDm(agent.name)).conversationId })
    } finally {
      setOpening('')
    }
  }

  const box = async (instance: Instance, action: 'claim' | 'release') => {
    setBoxError('')
    try {
      await (action === 'claim' ? api.claimBox(instance.id) : api.releaseBox(instance.id))
    } catch (e) {
      setBoxError((e as Error).message)
    }
  }

  // A person's own box, in a word or two: yours, or whose. It has no owner once they leave the team.
  const ownerOf = (ownerId: string | null) => {
    if (ownerId === null) return 'no owner'
    if (ownerId === me.person.id) return 'yours'
    const owner = people.find((p) => p.id === ownerId)
    return owner ? owner.name ?? owner.login.split('@')[0] : 'someone'
  }

  // Who holds a machine, and what you can do with it.
  const machineState = (i: Instance) => {
    // A person's own box is never claimed or released.
    if (i.personal) return <span className="muted small">{ownerOf(i.owner_id)}</span>
    if (i.kind !== 'box') return <span className="muted small">{i.status}</span>
    if (i.claimed_by_run) return <span className="muted small">on a run</span>
    if (i.claimed_by === me.person.id) return <button type="button" className="link small" onClick={act(() => box(i, 'release'))}>Release</button>
    if (i.claimed_by) return <span className="muted small">{login.get(i.claimed_by) ?? 'taken'}</span>
    return <button type="button" className="link small" onClick={act(() => box(i, 'claim'))}>Claim</button>
  }

  const running = sessions.filter((s) => isWorking(s.status))
  // A project's rooms, tasks and runs show under it, and only what belongs to no project shows below.
  const projectOf = new Map(tasks.map((t) => [t.id, t.project_id]))
  // Replays score proposals. They show on their proposal's run, not here.
  const newestRuns = runs.filter((r) => !r.replay_of).sort((a, b) => b.created_at.localeCompare(a.created_at))
  const recentRuns = newestRuns.filter((r) => !projectOf.get(r.task_id)).slice(0, 8)
  const runOfSession = (s: Session) => runs.find((r) => r.task_id === s.task_id)
  // Tasks people started, outside pipelines.
  const runTasks = new Set(runs.map((r) => r.task_id))
  const peopleTasks = tasks.filter((t) => !runTasks.has(t.id) && (t.source === 'app' || t.source === 'message'))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const myTasks = peopleTasks.filter((t) => !t.project_id).slice(0, 6)
  const looseConversations = conversations.filter((c) => !c.project_id)
  const drafts = new Set(taskSessions.filter((s) => s.status === 'draft').map((s) => s.task_id))
  return (
    <nav className="sidebar" aria-label="Workspace">
      <div className="team">
        <strong>{me.team.name}</strong>
        <span className="muted small">{me.person.login}</span>
      </div>
      <div className="new-links">
        <button type="button" className={`link small${route.page === 'team' ? ' current' : ''}`} onClick={() => go({ page: 'team' })}>
          Team{waitingToJoin.length ? ` · ${waitingToJoin.length} ${waitingToJoin.length === 1 ? 'wants' : 'want'} to join` : ''}
        </button>
        <button type="button" className={`link small${route.page === 'box' ? ' current' : ''}`} onClick={() => go({ page: 'box' })}>Your box</button>
        {admin && <button type="button" className={`link small${route.page === 'tailscale' ? ' current' : ''}`} onClick={() => go({ page: 'tailscale' })}>Tailscale</button>}
      </div>
      {keyAlert && (
        <p className="sidebar-note small">
          <button type="button" className="link" onClick={() => go({ page: 'tailscale' })}>{keyAlert.short}</button>
        </p>
      )}
      <div className="new-links">
        <button type="button" className="link small" onClick={() => go({ create: 'project' })}>New project</button>
        <button type="button" className="link small" onClick={() => go({ create: 'task' })}>New task</button>
        <button type="button" className="link small" onClick={() => go({ create: 'room' })}>New room</button>
        <button type="button" className="link small" onClick={() => go({ create: 'agent' })}>New agent</button>
        <button type="button" className="link small" onClick={openPalette}>Go to <kbd>{paletteKey()}</kbd></button>
      </div>

      <h2 className="kicker">Projects</h2>
      <ul className="list" aria-label="Projects">
        {projects.map((p) => {
          const rooms = conversations.filter((c) => c.project_id === p.id)
          const work = peopleTasks.filter((t) => t.project_id === p.id).slice(0, 5)
          const projectRuns = newestRuns.filter((r) => projectOf.get(r.task_id) === p.id).slice(0, 5)
          return (
            <li key={p.id}>
              <button type="button" className={`row${p.id === route.project ? ' selected' : ''}`} onClick={() => go({ project: p.id })}>
                <span>{p.name}</span>
              </button>
              <ul className="list nested" aria-label={`In ${p.name}`}>
                {rooms.map((c) => (
                  <li key={c.id}>
                    <button type="button" className={`row${c.id === route.conversation ? ' selected' : ''}`} onClick={() => go({ conversation: c.id })}><span># {c.name ?? 'room'}</span></button>
                  </li>
                ))}
                {work.map((t) => (
                  <li key={t.id}>
                    <button type="button" className={`row${t.id === route.task ? ' selected' : ''}`} onClick={() => go({ task: t.id })}>
                      <span>{t.title}</span>
                      {drafts.has(t.id) && <span className="muted small">draft</span>}
                    </button>
                  </li>
                ))}
                {projectRuns.map((r) => (
                  <li key={r.id}>
                    <button type="button" className={`row${r.id === route.run ? ' selected' : ''}`} onClick={() => go({ run: r.id })}>
                      <span><span className={`dot ${r.status}`} aria-hidden="true" />{taskTitle(r.task_id)}</span>
                      <span className="muted small">{shortRunLabel(r.status)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          )
        })}
        {!projects.length && <li className="muted small empty">No projects yet</li>}
      </ul>

      <h2 className="kicker">Repos</h2>
      {/* No label of its own, unlike the lists around it: a page's Repo picker is
          found by its label, which a list named Repos would match too. */}
      <ul className="list">
        <li>
          <button type="button" className={`row${route.page === 'repos' ? ' selected' : ''}`} onClick={() => go({ page: 'repos' })}>
            <span>All repos</span>
            <span className="muted small">{repos.length}</span>
          </button>
        </li>
      </ul>

      <h2 className="kicker">Agents</h2>
      <ul className="list" aria-label="Agents">
        {agents.map((agent) => (
          <li key={agent.id}>
            <button type="button" className={`row${current?.kind === 'dm' && current.agent_id === agent.id ? ' selected' : ''}`}
              onClick={act(() => open(agent))} disabled={opening === agent.id}>
              <span>{agent.name}</span>
              {agent.title && <span className="muted small">{agent.title}</span>}
            </button>
          </li>
        ))}
        {!agents.length && <li className="muted small empty">No agents yet</li>}
      </ul>

      <h2 className="kicker">Conversations</h2>
      <ul className="list" aria-label="Conversations">
        {[...looseConversations].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((c) => (
          <li key={c.id}>
            <button type="button" className={`row${c.id === route.conversation ? ' selected' : ''}`} onClick={() => go({ conversation: c.id })}>
              <span>{label(c)}</span>
            </button>
          </li>
        ))}
        {!looseConversations.length && <li className="muted small empty">Nothing yet</li>}
      </ul>

      <h2 className="kicker">Tasks</h2>
      <ul className="list" aria-label="Tasks">
        {myTasks.map((t) => (
          <li key={t.id}>
            <button type="button" className={`row${t.id === route.task ? ' selected' : ''}`} onClick={() => go({ task: t.id })}>
              <span>{t.title}</span>
              {drafts.has(t.id) && <span className="muted small">draft</span>}
            </button>
          </li>
        ))}
        {!myTasks.length && <li className="muted small empty">No tasks yet</li>}
      </ul>

      <ReadyLists openTask={route.task} />

      <h2 className="kicker">Pipelines</h2>
      <ul className="list" aria-label="Pipelines">
        {pipelines.map((p) => (
          <li key={p.id}>
            <button type="button" className={`row${p.id === route.pipeline ? ' selected' : ''}`} onClick={() => go({ pipeline: p.id })}>
              <span>{p.name}</span>
            </button>
          </li>
        ))}
        {!pipelines.length && <li className="muted small empty">No pipelines yet</li>}
      </ul>

      <h2 className="kicker">Runs</h2>
      <ul className="list" aria-label="Runs">
        {recentRuns.map((r) => (
          <li key={r.id}>
            <button type="button" className={`row${r.id === route.run ? ' selected' : ''}`} onClick={() => go({ run: r.id })}>
              <span><span className={`dot ${r.status}`} aria-hidden="true" />{taskTitle(r.task_id)}</span>
              <span className="muted small">{shortRunLabel(r.status)}</span>
            </button>
          </li>
        ))}
        {!recentRuns.length && <li className="muted small empty">No runs yet</li>}
      </ul>

      <h2 className="kicker">Running now</h2>
      <ul className="list" aria-label="Running now">
        {running.map((s) => (
          <li key={s.id}>
            <button type="button" className="row" onClick={() => {
              const run = runOfSession(s)
              if (s.conversation_id) go({ conversation: s.conversation_id, session: s.id })
              else if (run) go({ run: run.id, session: s.id })
              else if (s.task_id) go({ task: s.task_id, session: s.id })
            }}>
              <span><span className={`dot ${s.status}`} aria-hidden="true" />{agentName.get(s.agent_id) ?? 'agent'}{s.stage ? ` · ${s.stage}` : ''}</span>
              <span className="muted small">{s.status.replace('_', ' ')}</span>
            </button>
          </li>
        ))}
        {!running.length && <li className="muted small empty">Nothing running</li>}
      </ul>

      <h2 className="kicker">Machines</h2>
      <ul className="list" aria-label="Machines">
        {instances.map((i) => (
          <li key={i.id} className="row static">
            <span><span className={`dot ${i.status}`} aria-hidden="true" />{i.name}{i.kind === 'box' ? ' (box)' : ''}</span>
            {machineState(i)}
          </li>
        ))}
      </ul>
      {boxError && <p className="error small" role="alert">{boxError}</p>}
    </nav>
  )
}
