import { useState, type ReactNode } from 'react'
import { go } from './App.tsx'
import {
  act, api, clock, useSnapshot, type Agent, type Instance, type Me, type Memory, type Person, type Plugin, type Routine, type Skill, type Template,
} from './data.ts'
import { Markdown } from './Markdown.tsx'
import { CopyAgent } from './CopyAgent.tsx'
import { Hooks } from './Hooks.tsx'
import { useSubmit } from './useSubmit.ts'
import { machinesFor, startMachine } from './machines.ts'

// One agent's setup: who it is, its skills, plugins, routines and hooks, and what
// it remembers. Anyone on the team can change it, except its hooks, which only its
// owner or a team admin changes.
export function AgentPage({ agentId, me }: { agentId: string; me: Me }) {
  const { rows: agents } = useSnapshot<Agent>('agents', {}, 4000)
  const { rows: skills } = useSnapshot<Skill>('skills', {}, 4000)
  const { rows: plugins } = useSnapshot<Plugin>('plugins', {}, 4000)
  const { rows: routines } = useSnapshot<Routine>('routines', {}, 4000)
  const { rows: memories } = useSnapshot<Memory>('memories', {}, 6000)
  const { rows: people } = useSnapshot<Person>('people', {}, 30000)
  const agent = agents.find((a) => a.id === agentId)
  const [notice, setNotice] = useState('')
  const [copying, setCopying] = useState(false)
  if (!agent) return <section className="page"><p className="muted">Loading the agent…</p></section>

  const own = <T extends { agent_id: string | null }>(rows: T[]) => rows.filter((r) => r.agent_id === agentId)
  const login = (id: string | null) => people.find((p) => p.id === id)?.login ?? 'someone'
  const teamMemories = own(memories).filter((m) => m.scope === 'team').length
  const template = async () => {
    const { version } = await api.saveTemplate(agentId, agent.name)
    setNotice(`Saved as the template "${agent.name}", version ${version}.`)
  }
  return (
    <section className="page" aria-label="Agent">
      <header className="page-head">
        <div>
          <p className="kicker">Agent</p>
          <h1>{agent.name}</h1>
          <p className="muted small">{agent.title ?? 'No title yet'}{agent.model ? ` · ${agent.model}` : ''}</p>
          {agent.copied_from_agent_id && <p className="muted small">Copied from {agents.find((a) => a.id === agent.copied_from_agent_id)?.name ?? 'an agent that is gone'}</p>}
        </div>
        <div className="head-actions">
          <button type="button" className="ghost" onClick={act(async () => go({ conversation: (await api.openDm(agent.name)).conversationId }))}>Message</button>
          <button type="button" className="ghost" aria-expanded={copying} aria-controls="copy-agent" onClick={() => { setCopying(!copying) }}>Copy</button>
          <button type="button" className="ghost" onClick={act(template)}>Save as template</button>
        </div>
      </header>
      <div className="page-body">
        {notice && <p className="note-line" role="status">{notice}</p>}
        {copying && <CopyAgent agent={agent} me={me} teamMemories={teamMemories} />}
        <Profile agent={agent} />

        <h2 className="kicker section">Skills</h2>
        <Items rows={own(skills)} empty="No skills yet" render={(s) => <><strong>{s.name}</strong> <span className="muted small">{s.description}</span></>}
          onRemove={(s) => api.removeItem(agentId, 'skills', s.name)} />
        <SkillForm agentId={agentId} />

        <h2 className="kicker section">Plugins</h2>
        <Items rows={own(plugins)} empty="No plugins yet" render={(p) => <>
          <strong>{p.name}</strong> <span className="muted small">{p.kind === 'stdio' ? `${p.config.command} ${(p.config.args ?? []).join(' ')}` : p.config.url}</span>
          {Object.values({ ...p.config.env, ...p.config.headers }).length > 0 && (
            <span className="muted small"> · needs {Object.values({ ...p.config.env, ...p.config.headers }).map((r) => r.secret).join(', ')} on its machine</span>
          )}
        </>} onRemove={(p) => api.removeItem(agentId, 'plugins', p.name)} />
        <PluginForm agentId={agentId} />

        <h2 className="kicker section">Routines</h2>
        <Items rows={own(routines)} empty="No routines yet" render={(r) => <>
          <strong>{r.name}</strong> <span className="muted small"><code>{r.trigger_config.schedule}</code>{r.enabled ? '' : ' · paused'}{r.last_fired_at ? ` · last ran ${clock(r.last_fired_at)}` : ''}</span>
          {' '}<button type="button" className="link small" onClick={act(async () => go({ conversation: (await api.runRoutine(r.id)).conversationId }))}>Run now</button>
        </>} onRemove={(r) => api.removeItem(agentId, 'routines', r.name)} />
        <RoutineForm agentId={agentId} />

        <Hooks agent={agent} me={me} />

        <h2 className="kicker section">What it remembers</h2>
        <ul className="memories" aria-label="Memory">
          {own(memories).sort((a, b) => (a.kind === b.kind ? (b.log_date ?? '').localeCompare(a.log_date ?? '') : a.kind === 'profile' ? -1 : 1)).map((m) => (
            <li key={m.id}>
              <p className="small muted">{m.kind === 'profile' ? 'About' : `Notes from ${m.log_date} on`} {m.scope === 'team' ? 'the team' : login(m.person_id)}</p>
              <Markdown text={m.content} />
            </li>
          ))}
          {!own(memories).length && <li className="muted small empty">Nothing yet. The agent writes here with its update_memory tool.</li>}
        </ul>
      </div>
    </section>
  )
}

function Items<T extends { id: string }>({ rows, render, onRemove, empty }: { rows: T[]; render: (row: T) => ReactNode; onRemove: (row: T) => Promise<unknown>; empty: string }) {
  return (
    <ul className="items">
      {rows.map((row) => (
        <li key={row.id}>
          <span>{render(row)}</span>
          <button type="button" className="link small" onClick={act(() => onRemove(row))}>Remove</button>
        </li>
      ))}
      {!rows.length && <li className="muted small empty">{empty}</li>}
    </ul>
  )
}

function Profile({ agent }: { agent: Agent & { role?: string | null; instructions?: string } }) {
  const [title, setTitle] = useState(agent.title ?? '')
  const [model, setModel] = useState(agent.model ?? '')
  const [instructions, setInstructions] = useState(agent.instructions)
  const [saved, setSaved] = useState(false)
  const { submit, error, busy } = useSubmit(async () => {
    await api.updateAgent(agent.id, { title, model, instructions })
    setSaved(true)
  }, () => {})
  return (
    <form className="form" onSubmit={act(submit)} aria-label="Profile">
      <label htmlFor="agent-title">Title</label>
      <input id="agent-title" value={title} onChange={(e) => { setTitle(e.target.value); setSaved(false) }} placeholder="What it does, in a few words" />
      <label htmlFor="agent-model">Model</label>
      <input id="agent-model" value={model} onChange={(e) => { setModel(e.target.value); setSaved(false) }} placeholder="Claude Code's default" />
      <label htmlFor="agent-instructions">Instructions</label>
      <textarea id="agent-instructions" rows={5} value={instructions} onChange={(e) => { setInstructions(e.target.value); setSaved(false) }} />
      <div className="actions">
        <button className="primary" type="submit" disabled={busy}>Save</button>
        {saved && <span className="small" role="status">Saved</span>}
        {error && <p className="error small" role="alert">{error}</p>}
      </div>
    </form>
  )
}

function SkillForm({ agentId }: { agentId: string }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const { submit, error, busy } = useSubmit(() => api.saveItem(agentId, 'skills', { name, description, content }),
    () => { setName(''); setDescription(''); setContent('') })
  return (
    <details className="add">
      <summary className="small">Add a skill</summary>
      <form className="form" onSubmit={act(submit)} aria-label="Add a skill">
        <label htmlFor="skill-name">Name</label>
        <input id="skill-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="release-notes" />
        <label htmlFor="skill-description">When to use it</label>
        <input id="skill-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Writing release notes from merged pull requests" />
        <label htmlFor="skill-content">How to do it</label>
        <textarea id="skill-content" rows={5} value={content} onChange={(e) => setContent(e.target.value)} />
        <div className="actions">
          <button className="primary" type="submit" disabled={busy || !name || !description || !content}>Save skill</button>
          {error && <p className="error small" role="alert">{error}</p>}
        </div>
      </form>
    </details>
  )
}

function PluginForm({ agentId }: { agentId: string }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'stdio' | 'http'>('stdio')
  const [command, setCommand] = useState('')
  const [url, setUrl] = useState('')
  const [secrets, setSecrets] = useState('')
  // Lines like GITHUB_TOKEN=GITHUB_TOKEN: the variable the server reads, and the secret's name.
  const refs = () => Object.fromEntries(secrets.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [key = '', secret = key] = l.split('='); return [key.trim(), { secret: secret.trim() }] }))
  const { submit, error, busy } = useSubmit(() => {
    const [cmd, ...args] = command.trim().split(/\s+/)
    return api.saveItem(agentId, 'plugins', { name, kind, config: kind === 'stdio' ? { command: cmd, args, env: refs() } : { url, headers: refs() } })
  }, () => { setName(''); setCommand(''); setUrl(''); setSecrets('') })
  return (
    <details className="add">
      <summary className="small">Add a plugin</summary>
      <form className="form" onSubmit={act(submit)} aria-label="Add a plugin">
        <label htmlFor="plugin-name">Name</label>
        <input id="plugin-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="github" />
        <label htmlFor="plugin-kind">Kind</label>
        <select id="plugin-kind" value={kind} onChange={(e) => setKind(e.target.value as 'stdio' | 'http')}>
          <option value="stdio">A command the machine runs</option>
          <option value="http">An HTTP server</option>
        </select>
        {kind === 'stdio'
          ? <><label htmlFor="plugin-command">Command</label><input id="plugin-command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-github" /></>
          : <><label htmlFor="plugin-url">URL</label><input id="plugin-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></>}
        <label htmlFor="plugin-secrets">{kind === 'stdio' ? 'Environment' : 'Headers'} from secrets, one per line</label>
        <textarea id="plugin-secrets" rows={2} value={secrets} onChange={(e) => setSecrets(e.target.value)} placeholder="GITHUB_TOKEN=GITHUB_TOKEN" />
        <p className="small muted">Each names a secret. Its value stays on the machine, in its environment or ~/.agents-app/secrets.json.</p>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy || !name || (kind === 'stdio' ? !command : !url)}>Save plugin</button>
          {error && <p className="error small" role="alert">{error}</p>}
        </div>
      </form>
    </details>
  )
}

function RoutineForm({ agentId }: { agentId: string }) {
  const [name, setName] = useState('')
  const [schedule, setSchedule] = useState('0 9 * * 1-5')
  const [prompt, setPrompt] = useState('')
  const { submit, error, busy } = useSubmit(() => api.saveItem(agentId, 'routines', { name, schedule, prompt }),
    () => { setName(''); setPrompt('') })
  return (
    <details className="add">
      <summary className="small">Add a routine</summary>
      <form className="form" onSubmit={act(submit)} aria-label="Add a routine">
        <label htmlFor="routine-name">Name</label>
        <input id="routine-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="morning summary" />
        <label htmlFor="routine-schedule">Schedule (cron: minute hour day month weekday)</label>
        <input id="routine-schedule" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
        <label htmlFor="routine-prompt">What to do</label>
        <textarea id="routine-prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Summarize what the team's agents did yesterday." />
        <div className="actions">
          <button className="primary" type="submit" disabled={busy || !name || !prompt}>Save routine</button>
          {error && <p className="error small" role="alert">{error}</p>}
        </div>
      </form>
    </details>
  )
}

// A new agent, blank or from one of the team's templates. Its machine starts as
// the person's own box, and a teammate's own box is not offered, since agents
// there run on that teammate's Claude account.
export function NewAgent({ me }: { me: Me }) {
  const { rows: instances } = useSnapshot<Instance>('instances', {}, 15000)
  const { rows: templates } = useSnapshot<Template>('templates', {}, 15000)
  const [name, setName] = useState('')
  const [home, setHome] = useState('')
  const [template, setTemplate] = useState('')
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const machines = machinesFor(instances, me)
  const chosen = home || startMachine(machines)
  const { submit, error, busy } = useSubmit(async () => {
    const { agentId } = await api.createAgent({
      name, homeInstanceId: chosen, title, instructions, templateSlug: template || undefined,
    })
    go({ agent: agentId })
  }, () => {})
  return (
    <section className="page" aria-label="New agent">
      <header className="page-head"><div><p className="kicker">New</p><h1>A new agent</h1></div></header>
      <div className="page-body">
        <form className="form" onSubmit={act(submit)} aria-label="New agent">
          <label htmlFor="new-agent-name">Name</label>
          <input id="new-agent-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="reviewer" />
          <label htmlFor="new-agent-home">Its machine</label>
          <select id="new-agent-home" value={chosen ?? ''} onChange={(e) => setHome(e.target.value)}>
            {machines.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <label htmlFor="new-agent-template">Start from</label>
          <select id="new-agent-template" value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="">Nothing, a blank agent</option>
            {templates.map((t) => <option key={t.id} value={t.share_slug}>The template "{t.name}", version {t.version}</option>)}
          </select>
          {!template && <>
            <label htmlFor="new-agent-title">Title</label>
            <input id="new-agent-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Reviews pull requests" />
            <label htmlFor="new-agent-instructions">Instructions</label>
            <textarea id="new-agent-instructions" rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </>}
          <div className="actions">
            <button className="primary" type="submit" disabled={busy || !name || !machines.length}>Create agent</button>
            {error && <p className="error small" role="alert">{error}</p>}
          </div>
        </form>
      </div>
    </section>
  )
}
