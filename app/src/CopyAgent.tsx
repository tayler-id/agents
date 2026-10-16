import { useState } from 'react'
import { go } from './App.tsx'
import { useSubmit } from './AgentPage.tsx'
import { act, call, useSnapshot, type Agent, type Instance, type Me } from './data.ts'
import { machinesFor, startMachine } from './machines.ts'
import { CopyDone, type Carried } from '../../shared/recipe.ts'

const count = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`

// What a copy got, in a sentence.
export const carriedText = (c: Carried) => [
  count(c.skills, 'skill', 'skills'), count(c.plugins, 'plugin', 'plugins'), count(c.routines, 'routine', 'routines'),
  count(c.hooks, 'hook', 'hooks'), count(c.memories, 'team memory', 'team memories'),
].join(', ')

// Copies an agent: a new agent of the person's own, with this one's setup. Asking for
// the team's memories is a choice, since the copy then starts knowing what the team told this one.
export function CopyAgent({ agent, me, teamMemories }: { agent: Agent; me: Me; teamMemories: number }) {
  const { rows: instances } = useSnapshot<Instance>('instances', {}, 15000)
  const [name, setName] = useState(`${agent.name}-copy`.slice(0, 40))
  const [home, setHome] = useState('')
  const [withMemories, setWithMemories] = useState(false)
  const [done, setDone] = useState<CopyDone | null>(null)
  const machines = machinesFor(instances, me)
  const chosen = home || startMachine(machines)
  const { submit, error, busy } = useSubmit(async () => {
    setDone(await call(CopyDone, 'POST', `/v1/agents/${agent.id}/copy`, { name, homeInstanceId: chosen, memories: withMemories && teamMemories > 0 }))
  }, () => {})
  if (done) {
    return (
      <section id="copy-agent" aria-label="Copy this agent">
        <h2 className="kicker section">Copy this agent</h2>
        <div className="form">
          <p className="note-line" role="status">Copied as {name}. It carries {carriedText(done.carried)}.</p>
          <p className="small muted">It carries nothing the agent remembers about a person, and no secret value. A plugin that needs a secret asks for it on the new machine.</p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => { go({ agent: done.agentId }) }}>Open {name}</button>
            <button type="button" className="ghost" onClick={() => { setDone(null) }}>Copy again</button>
          </div>
        </div>
      </section>
    )
  }
  return (
    <section id="copy-agent">
      <h2 className="kicker section">Copy this agent</h2>
      <form className="form" onSubmit={act(submit)} aria-label="Copy this agent">
        <label htmlFor="copy-name">Name of the copy</label>
        <input id="copy-name" value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="copy-machine">Machine for the copy</label>
        <select id="copy-machine" value={chosen ?? ''} onChange={(e) => setHome(e.target.value)}>
          {machines.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <label className="check">
          <input type="checkbox" checked={withMemories && teamMemories > 0} disabled={teamMemories === 0} onChange={(e) => setWithMemories(e.target.checked)} />
          With the team's memories ({teamMemories})
        </label>
        <p className="small muted">
          The copy gets the agent's title, instructions, skills, plugins, routines and hooks. It never gets what the agent remembers about a person, or a secret value.
        </p>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy || !name || !machines.length}>Copy agent</button>
          {error && <p className="error small" role="alert">{error}</p>}
        </div>
      </form>
    </section>
  )
}
