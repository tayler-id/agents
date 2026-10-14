import { useMemo, useState, type SyntheticEvent } from 'react'
import { go } from './App.tsx'
import { runLabel } from './Run.tsx'
import {
  act, api, clock, messageOf, repoName, usePolled, useSnapshot, useSnapshotOf,
  type Agent, type Artifact, type Conversation, type Me, type Member, type Person, type Pipeline, type Repo, type Run, type Task, type TaskRepo,
} from './data.ts'
import { ProjectRow, RepoId, RepoRequestRow, repoNameFor, type GithubStatus, type RepoView } from '../../shared/projects.ts'

// How often the Repos list and GitHub's status are read again. While a person
// waits to enter a sign-in code, the status is read every two seconds, so the
// page changes soon after they finish on GitHub.
const LIST_MS = 15_000
const WAITING_MS = 2_000

const whereLabel = (forge: RepoView['forge']) => (forge === 'github' ? 'GitHub' : "this Mac's forge")

// GitHub on this server, as the person sees it, with what they can do about it.
export function GithubConnect({ github, refresh }: { github: GithubStatus | null; refresh: () => void }) {
  const [error, setError] = useState('')
  if (!github) return <p className="muted small">Asking the server about GitHub…</p>
  if (github.state === 'off') {
    return <p className="small">GitHub is not set up on this server yet. An admin adds {github.missing.join(', ')} to its .env and restarts the API.</p>
  }
  const signIn = async () => {
    setError('')
    try {
      await api.githubSignIn()
    } catch (e) {
      setError(messageOf(e))
    }
    refresh()
  }
  const { you, stopgap } = github
  const shared = stopgap && <p className="muted small">Until everyone signs in, the team&apos;s stopgap token for {stopgap.owner} acts as {stopgap.login}.</p>
  if (you.state === 'connected') {
    return (
      <div className="github-line">
        <p>Signed in to GitHub as <strong>{you.login}</strong>.</p>
        <button type="button" className="link small" onClick={act(async () => { await api.githubSignOut(); refresh() })}>Sign out</button>
      </div>
    )
  }
  if (you.state === 'waiting') {
    return (
      <div className="device" role="status">
        <p>Enter this code on GitHub&apos;s device page to connect.</p>
        <p className="device-code">{you.userCode}</p>
        <p className="small"><a href={you.verificationUri} target="_blank" rel="noreferrer">Open GitHub&apos;s device page</a>. This page changes when you are done there.</p>
      </div>
    )
  }
  return (
    <div className="github-line">
      {you.state === 'stopped' && <p className="small">{you.reason}</p>}
      {github.signIn
        ? <button type="button" className="primary" onClick={act(signIn)}>Connect GitHub</button>
        : <p className="small">Signing in with GitHub needs the Agents GitHub App&apos;s client id on the server, in AGENTS_GITHUB_CLIENT_ID.</p>}
      {shared}
      {error && <p className="error small" role="alert">{error}</p>}
    </div>
  )
}

// The admin's stopgap: one personal access token for the whole team, until people sign in.
function StopgapForm({ refresh }: { refresh: () => void }) {
  const [owner, setOwner] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault()
    setError('')
    try {
      await api.githubStopgap(owner.trim(), token.trim())
      setToken('')
      refresh()
    } catch (e) {
      setError(messageOf(e))
    }
  }
  return (
    <details className="add">
      <summary className="small">Set the stopgap token</summary>
      <form className="form" onSubmit={act(submit)} aria-label="Stopgap token">
        <p className="muted small">One fine-grained personal access token for the whole team, kept on the server only, until people connect their own GitHub.</p>
        <label htmlFor="stopgap-owner">Organization or account</label>
        <input id="stopgap-owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
        <label htmlFor="stopgap-token">Token</label>
        <input id="stopgap-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        <div className="actions">
          <button className="primary" type="submit" disabled={!owner.trim() || !token.trim()}>Save the token</button>
          {error && <p className="error small" role="alert">{error}</p>}
        </div>
      </form>
    </details>
  )
}

// A person's GitHub status, read often while they are entering a code.
const githubEvery = (latest: GithubStatus | null) => (latest?.state === 'on' && latest.you.state === 'waiting' ? WAITING_MS : LIST_MS)
const listEvery = () => LIST_MS
const useGithub = () => usePolled(api.github, githubEvery)

// Each task branch's task, so a branch links to the work on it.
function useBranchTasks() {
  const { rows: tasks } = useSnapshot<Task>('tasks', {}, 6000)
  const { rows: runs } = useSnapshot<Run>('runs', {}, 6000)
  return useMemo(() => new Map(tasks.map((t) => [`task/${t.slug}`, { task: t, run: runs.find((r) => r.task_id === t.id) }])), [tasks, runs])
}

function RepoList({ repos, empty, label }: { repos: RepoView[]; empty: string; label: string }) {
  const branchTasks = useBranchTasks()
  const openWork = (branch: string) => {
    const found = branchTasks.get(branch)
    if (found?.run) go({ run: found.run.id })
    else if (found) go({ task: found.task.id })
  }
  return (
    <ul className="repo-list" aria-label={label}>
      {repos.map((repo) => {
        const project = repo.project
        return (
          <li key={repo.id}>
            <div className="repo-line">
              <strong className="repo-name">{repo.name}</strong>
              <span className="muted small">{whereLabel(repo.forge)}</span>
              <span className="muted small">
                {project ? <button type="button" className="link" onClick={() => go({ project: project.id })}>{project.name}</button> : 'no project'}
              </span>
              <a className="small push" href={repo.webUrl} target="_blank" rel="noreferrer">Open on {whereLabel(repo.forge)}</a>
            </div>
            {repo.open.read ? (
              <>
                <p className="small">
                  <span className="muted">Open pull requests </span>
                  {repo.open.pullRequests.length ? repo.open.pullRequests.map((pr, i) => (
                    <span key={pr.number}>{i > 0 && ', '}<a href={pr.url} target="_blank" rel="noreferrer">#{pr.number} {pr.title}</a></span>
                  )) : <span className="muted">none</span>}
                </p>
                <p className="small">
                  <span className="muted">Task branches </span>
                  {repo.open.taskBranches.length ? repo.open.taskBranches.map((branch, i) => (
                    <span key={branch}>{i > 0 && ', '}{branchTasks.has(branch)
                      ? <button type="button" className="link" onClick={() => openWork(branch)}>{branch}</button>
                      : <code>{branch}</code>}</span>
                  )) : <span className="muted">none</span>}
                </p>
              </>
            ) : <p className="small">{repo.open.problem}</p>}
          </li>
        )
      })}
      {!repos.length && <li className="muted small empty">{empty}</li>}
    </ul>
  )
}

// Every repo the team works in, where each lives, and how to reach GitHub.
export function ReposView({ me }: { me: Me }) {
  const overview = usePolled(api.repos, listEvery)
  const github = useGithub()
  const isAdmin = me.person.role === 'admin'
  const repos = overview.value?.repos ?? []
  return (
    <section className="page" aria-label="Repos">
      <header className="page-head">
        <div>
          <p className="kicker">Repos</p>
          <h1>{overview.value ? `${repos.length} ${repos.length === 1 ? 'repo' : 'repos'}` : 'Repos'}</h1>
          <p className="muted small">Every repo your team shares is listed here, with where it lives, its project and what is open on it. Repos in the sidebar always brings you back.</p>
        </div>
      </header>
      <div className="page-body">
        <h2 className="kicker section">GitHub</h2>
        <GithubConnect github={github.value} refresh={github.refresh} />
        {isAdmin && github.value?.state === 'on' && <StopgapForm refresh={github.refresh} />}
        <h2 className="kicker section">The team&apos;s repos</h2>
        {overview.error && <p className="error small" role="alert">{overview.error}</p>}
        {overview.value ? <RepoList repos={repos} label="The team's repos" empty="No repos yet. New project makes one." /> : <p className="muted small">Reading each forge…</p>}
      </div>
    </section>
  )
}

// A new project and its GitHub repo. The person names it and picks who works on it.
export function NewProject({ me }: { me: Me }) {
  const { rows: people } = useSnapshot<Person>('people', {}, 15000)
  const { rows: agents } = useSnapshot<Agent>('agents', {}, 15000)
  const github = useGithub()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [owner, setOwner] = useState('')
  const [who, setWho] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const status = github.value
  const signedIn = status?.state === 'on' && status.you.state === 'connected' ? status.you.login : null
  const stopgapOwner = status?.state === 'on' ? status.stopgap?.owner ?? null : null
  // Left empty, the repo goes under the person's own account, or the stopgap's organization.
  const defaultOwner = signedIn ?? stopgapOwner
  const canMake = Boolean(signedIn ?? stopgapOwner)
  const repo = repoNameFor(name)
  const toggle = (key: string) => setWho((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { projectId } = await api.createProject({
        name: name.trim(), description: description.trim(), owner: owner.trim() || undefined,
        people: people.filter((p) => who.has(`p:${p.id}`)).map((p) => p.login), agents: agents.filter((a) => who.has(`a:${a.id}`)).map((a) => a.name),
      })
      go({ project: projectId })
    } catch (e) {
      setError(messageOf(e))
      setBusy(false)
    }
  }
  return (
    <section className="page" aria-label="New project">
      <header className="page-head"><div><p className="kicker">New</p><h1>A project</h1><p className="muted small">A project gets its own GitHub repo, with a README as its first commit, and a room for the people and agents on it. The whole team sees it.</p></div></header>
      <div className="page-body">
        {!canMake && <GithubConnect github={status} refresh={github.refresh} />}
        <form className="form" onSubmit={act(submit)} aria-label="New project">
          <label htmlFor="project-name">Name</label>
          <input id="project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Billing" />
          <label htmlFor="project-description">What it is for</label>
          <input id="project-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Invoices and payments for the shop" />
          <label htmlFor="project-owner">GitHub organization or account</label>
          <input id="project-owner" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder={defaultOwner ?? ''} />
          <p className="muted small" aria-live="polite">
            {repo && (owner.trim() || defaultOwner) ? <>The repo: <code>{owner.trim() || defaultOwner}/{repo}</code> on GitHub.</> : 'The repo is named after the project.'}
          </p>
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
            <button className="primary" type="submit" disabled={busy || !name.trim() || !canMake}>Create project</button>
            {error && <p className="error small" role="alert">{error}</p>}
          </div>
        </form>
      </div>
    </section>
  )
}

// The project a new task or room starts in.
export function InProject({ projectId }: { projectId: string }) {
  const { rows: projects } = useSnapshotOf(ProjectRow, 'projects', {}, 15000)
  const project = projects.find((p) => p.id === projectId)
  return <p className="muted small">{project ? <>In <button type="button" className="link" onClick={() => go({ project: project.id })}>{project.name}</button>, with its repos.</> : 'In a project.'}</p>
}

// The repos a task works in, by name, and the project it belongs to.
export function TaskPlace({ task }: { task: Task }) {
  const { rows: taskRepos } = useSnapshot<TaskRepo>('task_repos', {}, 6000)
  const { rows: repos } = useSnapshot<Repo>('repos', {}, 15000)
  const { rows: projects } = useSnapshotOf(ProjectRow, 'projects', {}, 15000)
  const project = projects.find((p) => p.id === task.project_id)
  const names = taskRepos.filter((t) => t.task_id === task.id).flatMap((t) => repos.filter((r) => r.id === t.repo_id).map((r) => repoName(r.remote_url)))
  return (
    <p className="muted small task-place">
      {project ? <>In <button type="button" className="link" onClick={() => go({ project: project.id })}>{project.name}</button>. </> : null}
      {names.length ? <>Works in <span className="repo-names">{names.join(', ')}</span>.</> : 'No repo.'}
    </p>
  )
}

function RepoRequests({ projectId }: { projectId: string }) {
  const { rows: requests, error } = useSnapshotOf(RepoRequestRow, 'repo_requests', {}, 3000)
  const open = requests.filter((r) => r.project_id === projectId && r.status !== 'done')
  if (error) return <p className="error small" role="alert">{error}</p>
  if (!open.length) return null
  return (
    <ul className="plain" aria-label="Repos being made">
      {open.map((r) => (
        <li key={r.id} className="small request">
          {r.status === 'creating'
            ? <span>Making <code>{r.owner}/{r.name}</code> on GitHub…</span>
            : <span><code>{r.owner}/{r.name}</code> was not made. {r.error} <button type="button" className="link" onClick={act(() => api.retryRepo(r.id))}>Try again</button></span>}
        </li>
      ))}
    </ul>
  )
}

function AddRepo({ projectId, repos }: { projectId: string; repos: Repo[] }) {
  const [name, setName] = useState('')
  const [repoId, setRepoId] = useState('')
  const [error, setError] = useState('')
  // The pipelines repo holds the team's pipelines, which belong to no project.
  const free = repos.filter((r) => !r.project_id && !r.remote_url.endsWith('/pipelines.git'))
  const add = async (body: Parameters<typeof api.addRepo>[1]) => {
    setError('')
    try {
      await api.addRepo(projectId, body)
      setName('')
      setRepoId('')
    } catch (e) {
      setError(messageOf(e))
    }
  }
  return (
    <details className="add">
      <summary className="small">Add a repo</summary>
      <form className="form" aria-label="Add a GitHub repo" onSubmit={act(async (event: SyntheticEvent) => { event.preventDefault(); await add({ name: name.trim() }) })}>
        <label htmlFor="add-repo-name">A repo on GitHub, made if it doesn&apos;t exist</label>
        <input id="add-repo-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="billing-api" />
        <div className="actions"><button type="submit" disabled={!name.trim()}>Add it</button></div>
      </form>
      {!!free.length && (
        <form className="form" aria-label="Add a team repo" onSubmit={act(async (event: SyntheticEvent) => { event.preventDefault(); if (repoId) await add({ repoId: RepoId.parse(repoId) }) })}>
          <label htmlFor="add-repo-existing">Or one of the team&apos;s repos with no project</label>
          <select id="add-repo-existing" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
            <option value="">Pick a repo</option>
            {free.map((r) => <option key={r.id} value={r.id}>{repoName(r.remote_url)}</option>)}
          </select>
          <div className="actions"><button type="submit" disabled={!repoId}>Move it here</button></div>
        </form>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
    </details>
  )
}

function StartProjectRun({ repos }: { repos: Repo[] }) {
  const { rows: pipelines } = useSnapshot<Pipeline>('pipelines', {}, 15000)
  const [pipeline, setPipeline] = useState('')
  const [repo, setRepo] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState('')
  const usable = pipelines.filter((p) => p.current_version_id)
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault()
    setError('')
    try {
      const pipelineId = pipeline || usable[0]?.id
      const repoId = repo || repos[0]?.id
      if (!pipelineId || !repoId) throw new Error('Pick a pipeline and a repo first.')
      const { runId } = await api.startRun(pipelineId, title.trim(), body.trim(), repoId)
      go({ run: runId })
    } catch (e) {
      setError(messageOf(e))
    }
  }
  return (
    <form className="start-run" onSubmit={act(submit)} aria-label="Start a run in this project">
      <h2 className="kicker">Start a run</h2>
      <label htmlFor="project-run-pipeline">Pipeline</label>
      <select id="project-run-pipeline" value={pipeline} onChange={(e) => setPipeline(e.target.value)}>
        {usable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <label htmlFor="project-run-repo">Repo</label>
      <select id="project-run-repo" value={repo} onChange={(e) => setRepo(e.target.value)}>
        {repos.map((r) => <option key={r.id} value={r.id}>{repoName(r.remote_url)}</option>)}
      </select>
      <label htmlFor="project-run-title">What should it work on?</label>
      <input id="project-run-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A one-line description" />
      <label htmlFor="project-run-body">Details</label>
      <textarea id="project-run-body" rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="actions">
        <button className="primary" type="submit" disabled={!title.trim() || !usable.length || !repos.length}>Start</button>
        {error && <p className="error small" role="alert">{error}</p>}
      </div>
    </form>
  )
}

// One project: its repos, who is on it, and everything made in it.
export function ProjectPage({ projectId }: { projectId: string }) {
  const { rows: projects, error: projectsError } = useSnapshotOf(ProjectRow, 'projects', {}, 10000)
  const { rows: repos } = useSnapshot<Repo>('repos', {}, 6000)
  const { rows: tasks } = useSnapshot<Task>('tasks', {}, 4000)
  const { rows: runs } = useSnapshot<Run>('runs', {}, 4000)
  const { rows: conversations } = useSnapshot<Conversation>('conversations', {}, 6000)
  const { rows: members } = useSnapshot<Member>('conversation_members', {}, 10000)
  const { rows: people } = useSnapshot<Person>('people', {}, 30000)
  const { rows: agents } = useSnapshot<Agent>('agents', {}, 30000)
  const { rows: documents } = useSnapshot<Artifact>('project_artifacts', { project: projectId }, 6000)
  const { rows: taskRepos } = useSnapshot<TaskRepo>('task_repos', {}, 6000)
  const overview = usePolled(api.repos, listEvery)
  const project = projects.find((p) => p.id === projectId)
  if (!project) {
    return <section className="page">{projectsError ? <p className="error" role="alert">{projectsError}</p> : <p className="muted">Loading the project…</p>}</section>
  }
  const reposOf = (t: Task) => taskRepos.filter((tr) => tr.task_id === t.id)
    .flatMap((tr) => repos.filter((r) => r.id === tr.repo_id).map((r) => repoName(r.remote_url)))

  const ownRepos = repos.filter((r) => r.project_id === projectId)
  const views = (overview.value?.repos ?? []).filter((r) => r.project?.id === projectId)
  const ownTasks = tasks.filter((t) => t.project_id === projectId).sort((a, b) => b.created_at.localeCompare(a.created_at))
  const runOf = (t: Task) => runs.find((r) => r.task_id === t.id)
  const rooms = conversations.filter((c) => c.project_id === projectId)
  const inRoom = members.filter((m) => m.conversation_id === project.conversation_id)
  const names = [
    ...inRoom.flatMap((m) => people.filter((p) => p.id === m.person_id).map((p) => p.login)),
    ...inRoom.flatMap((m) => agents.filter((a) => a.id === m.agent_id).map((a) => a.name)),
  ]
  return (
    <section className="page" aria-label="Project">
      <header className="page-head">
        <div>
          <p className="kicker">Project</p>
          <h1>{project.name}</h1>
          <p className="muted small">{project.description || 'No description yet'} · started {clock(project.created_at)}</p>
        </div>
        <div className="head-actions">
          {project.conversation_id && <button type="button" className="ghost" onClick={() => go({ conversation: project.conversation_id })}>Room</button>}
          <button type="button" className="ghost" onClick={() => go({ create: 'task', inProject: projectId })}>New task</button>
          <button type="button" className="ghost" onClick={() => go({ create: 'room', inProject: projectId })}>New room</button>
        </div>
      </header>
      <div className="page-body">
        <h2 className="kicker section">Repos</h2>
        {overview.value ? <RepoList repos={views} label="The project's repos" empty="No repo yet." /> : <p className="muted small">Reading each forge…</p>}
        <RepoRequests projectId={projectId} />
        <AddRepo projectId={projectId} repos={repos} />

        <h2 className="kicker section">People and agents</h2>
        <p className="small">{names.length ? names.join(', ') : 'Nobody yet'}</p>

        <h2 className="kicker section">Tasks and runs</h2>
        <ul className="run-list" aria-label="Tasks and runs of this project">
          {ownTasks.map((t) => {
            const run = runOf(t)
            return (
              <li key={t.id}>
                <button type="button" className="row stacked" onClick={() => go(run ? { run: run.id } : { task: t.id })}>
                  <span>{run && <span className={`dot ${run.status}`} aria-hidden="true" />}{t.title}</span>
                  <span className="muted small">{reposOf(t).join(', ') || 'no repo'} · {run ? runLabel(run.status) : 'task'} · {clock(t.created_at)}</span>
                </button>
              </li>
            )
          })}
          {!ownTasks.length && <li className="muted small empty">No tasks or runs yet</li>}
        </ul>
        <StartProjectRun repos={ownRepos} />

        <h2 className="kicker section">Documents</h2>
        <ul className="artifacts" aria-label="Documents of this project">
          {documents.map((a) => (
            <li key={a.id}>
              {a.kind === 'link'
                ? <a href={a.url ?? '#'} target="_blank" rel="noreferrer">{a.title}</a>
                : <button type="button" className="link" onClick={() => go({ task: a.task_id, document: a.id })}>{a.title}</button>}
              <span className="muted small">{a.kind === 'link' ? a.state : `version ${a.current_version}`}</span>
            </li>
          ))}
          {!documents.length && <li className="muted small empty">No documents yet</li>}
        </ul>

        <h2 className="kicker section">Rooms</h2>
        <ul className="plain" aria-label="Rooms of this project">
          {rooms.map((c) => (
            <li key={c.id}><button type="button" className="row" onClick={() => go({ conversation: c.id })}><span># {c.name ?? 'room'}</span></button></li>
          ))}
        </ul>
      </div>
    </section>
  )
}
