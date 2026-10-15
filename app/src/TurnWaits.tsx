import { TurnWaitRow } from '../../shared/turns.ts'
import { clock, useSnapshot, useSnapshotOf, type Agent, type Instance, type Me, type Person } from './data.ts'

// How often an open conversation looks again for turns that wait. A computer
// takes tens of seconds to start, so a line two seconds late is still in time.
const WAITS_POLL_MS = 2000

// What a turn's line says. A machine not read yet is named for what it is to the
// turn, until the next read names it.
function lineOf(turn: TurnWaitRow, machine: Instance | undefined, me: Me, people: Person[]): string {
  if (turn.status === 'running') return `No new step since ${clock(turn.stuck_since)}. It may be stuck.`
  if (!machine) return turn.wait === 'computer_starting' ? 'Starting its computer' : 'Waiting for its machine, which is offline'
  if (turn.wait === 'machine_offline') return `Waiting for ${machine.name}, which is offline`
  if (!machine.personal || !machine.owner_id) return `Starting ${machine.name}`
  if (machine.owner_id === me.person.id) return 'Starting your computer'
  const owner = people.find((p) => p.id === machine.owner_id)
  return owner ? `Starting ${owner.name ?? owner.login}'s computer` : `Starting ${machine.name}`
}

// What a conversation says while an agent's turn waits for its machine, and while
// a running turn has gone quiet. The reply arrives in its place.
export function TurnWaits({ me, conversationId, agents, people }: { me: Me; conversationId: string; agents: Agent[]; people: Person[] }) {
  const { rows: turns, error } = useSnapshotOf(TurnWaitRow, 'turn_waits', { conversation: conversationId }, WAITS_POLL_MS)
  // Machines are read only while a turn waits on one.
  const { rows: machines } = useSnapshot<Instance>('instances', turns.length ? {} : null, WAITS_POLL_MS)
  if (error) return <li className="message waiting error small" role="alert">{error}</li>
  return turns.map((turn) => {
    const machine = machines.find((m) => m.id === turn.instance_id)
    return (
      <li key={turn.id} className="message waiting" data-testid="turn-wait">
        <div className="meta">
          <strong>{agents.find((a) => a.id === turn.agent_id)?.name ?? 'Agent'}</strong>
          <span className="small working"><span className="dot waiting" aria-hidden="true" />{lineOf(turn, machine, me, people)}</span>
        </div>
        {turn.status === 'waiting' && machine?.start_error && <p className="text muted small">It has not started yet. Docker said: {machine.start_error}</p>}
      </li>
    )
  })
}
