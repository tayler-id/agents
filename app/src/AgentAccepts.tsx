import { useState } from 'react'
import { act, api, messageOf, type Agent, type Me, type Person } from './data.ts'

// Whether other people's agents may message an agent and hand it tasks, as one
// row: what it does on the left, and a switch on the right for whoever decides.
// Its owner's own agents always may. A message runs a turn on the owner's Claude
// account, so only the owner decides, or an admin for an agent nobody owns.
export function AgentAccepts({ me, agent, people }: { me: Me; agent: Agent; people: Person[] }) {
  // What the owner chose here, shown at once and until the next read of the agent
  // has it. A choice the server refuses goes back to what it was.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const owner = people.find((p) => p.id === agent.owner_id)
  const ownerName = owner ? owner.name ?? owner.login : null
  const decides = agent.owner_id === null ? me.person.role === 'admin' : agent.owner_id === me.person.id
  const open = chosen ?? agent.accepts_agents === 'team'
  const change = async () => {
    const before = chosen
    setChosen(!open)
    setBusy(true)
    setError('')
    try {
      await api.setAcceptsAgents(agent.id, open ? 'owner' : 'team')
    } catch (e) {
      setChosen(before)
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  const says = open ? `Any agent on the team may message ${agent.name} and hand it tasks.`
    : agent.owner_id === null ? `${agent.name} has no owner, so no agent may message it until an admin lets the team's agents in.`
      : `Only ${ownerName ?? 'its owner'}'s own agents may message ${agent.name} and hand it tasks.`
  return (
    <section className="setting" aria-label="Other agents">
      <div>
        <p id={`accepts-${agent.id}`}><strong>Other people's agents</strong></p>
        <p className="muted small">{says} Each message runs a turn on the Claude account {agent.name} runs on.</p>
      </div>
      {decides && (
        <button type="button" role="switch" aria-checked={open} aria-labelledby={`accepts-${agent.id}`} className="switch" disabled={busy} onClick={act(change)}>
          {open ? 'On' : 'Off'}
        </button>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
    </section>
  )
}
