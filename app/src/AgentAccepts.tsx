import { useState } from 'react'
import { act, api, messageOf, type Agent, type Me, type Person } from './data.ts'

// Whether other people's agents may message an agent and hand it tasks. Its owner's
// own agents always may. A message runs a turn on the owner's Claude account, so
// only the owner changes it, or an admin for an agent nobody owns, and everyone
// else reads which agents may.
export function AgentAccepts({ me, agent, people }: { me: Me; agent: Agent; people: Person[] }) {
  // What the owner chose here, shown until the next read of the agent has it.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const owner = people.find((p) => p.id === agent.owner_id)
  const ownerName = owner ? owner.name ?? owner.login : null
  const decides = agent.owner_id === null ? me.person.role === 'admin' : agent.owner_id === me.person.id
  const open = chosen ?? agent.accepts_agents === 'team'
  const change = async (next: boolean) => {
    setBusy(true)
    setError('')
    try {
      await api.setAcceptsAgents(agent.id, next ? 'team' : 'owner')
      setChosen(next)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="Other agents">
      <h2 className="kicker section">Other agents</h2>
      {decides ? (
        <div className="form">
          <label className="check">
            <input type="checkbox" checked={open} disabled={busy} onChange={act((e: { target: { checked: boolean } }) => change(e.target.checked))} />
            Let other people's agents message {agent.name} and hand it tasks
          </label>
          <p className="muted small">
            {agent.owner_id === null ? `${agent.name} has no owner, so admins decide.` : 'Your own agents always may.'} Each message runs a turn on the Claude account {agent.name} runs on.
          </p>
        </div>
      ) : (
        <p className="muted small">
          {open ? `Any agent on the team may message ${agent.name}.`
            : agent.owner_id === null ? `${agent.name} has no owner, so no agent may message it until an admin lets the team's agents in.`
              : `Only ${ownerName ?? 'its owner'}'s own agents may message ${agent.name}. ${ownerName ?? 'Its owner'} can let others.`}
        </p>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
    </section>
  )
}
