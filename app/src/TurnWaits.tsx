import { TurnWaitRow, turnLine } from '../../shared/turns.ts'
import { act, api, clock, useSnapshot, useSnapshotOf, type Agent, type Instance, type Me, type Person } from './data.ts'

// How often an open conversation looks again for turns that wait. A computer
// takes tens of seconds to start, so a line two seconds late is still in time.
const WAITS_POLL_MS = 2000

// What a conversation or a task says while an agent's turn waits for its machine,
// and while a running turn has gone quiet, with a way to cancel a turn that waits.
// The reply arrives in its place.
export function TurnWaits({ me, of, agents, people }: { me: Me; of: { conversation: string } | { task: string }; agents: Agent[]; people: Person[] }) {
  const { rows: turns, error } = useSnapshotOf(TurnWaitRow, 'turn_waits', of, WAITS_POLL_MS)
  // Machines are read only while a turn waits on one.
  const { rows: machines } = useSnapshot<Instance>('instances', turns.length ? {} : null, WAITS_POLL_MS)
  if (error) return <li className="message waiting error small" role="alert">{error}</li>
  return turns.map((turn) => {
    const machine = machines.find((m) => m.id === turn.instance_id)
    return (
      <li key={turn.id} className="message waiting" data-testid="turn-wait">
        <div className="meta">
          <strong>{agents.find((a) => a.id === turn.agent_id)?.name ?? 'Agent'}</strong>
          <span className="small working"><span className="dot waiting" aria-hidden="true" />{turnLine(turn, machine, me.person.id, people.find((p) => p.id === machine?.owner_id), (time) => clock(time))}</span>
          {turn.status === 'waiting' && turn.source !== 'room' && <button type="button" className="link small" onClick={act(() => api.cancelTurn(turn.id))}>Cancel</button>}
        </div>
        {turn.status === 'waiting' && machine?.start_error && <p className="text muted small">It has not started yet. Docker said: {machine.start_error}</p>}
      </li>
    )
  })
}
