// The secrets of one agent, read from the record and given to SecretValue, which sets and removes each value.
// This is the wiring the endpoints need, and the only part that reads the record or calls the API.
// `secrets` names what the agent's plugins need, `secret_sets` says where the app put a value, and
// `instances` and `people` say whose computer it is and whether it runs. Nothing in the app mounts it
// yet. The agent panel's card does the same job with its own rows, and test/step25b.ts builds this as a
// page of its own.
//   POST /v1/secrets/<id>/value    { value }  answers { name, computer, setAt }
//   POST /v1/secrets/<id>/remove   {}         answers { name, computer, had }

import { useEffect, useId, useState } from 'react'
import { mayPutOn, SecretRemoved, SecretRow, SecretSetRow, SecretStored } from '../../shared/secrets.ts'
import { api, call, messageOf, parseTime, useSnapshot, useSnapshotOf, type Agent, type Instance, type Me, type Person } from './data.ts'
import { SecretValue, type SecretHeld } from './SecretValue.tsx'
import './Secrets.css'

// How often the lists are read again. A value just set or removed shows at once, from the answer to the
// request, and the lists catch up.
const REFRESH_MS = 2500
const PEOPLE_MS = 30_000

// Who is using the page. Only a member of a team may set a value.
function useMe(): { me: Me | null; problem: string } {
  const [seen, setSeen] = useState<{ me: Me | null; problem: string }>({ me: null, problem: '' })
  useEffect(() => {
    let live = true
    api.me().then(
      (answer) => { if (live) setSeen(answer.kind === 'member' ? { me: answer, problem: '' } : { me: null, problem: 'You have not joined this team yet.' }) },
      (error: unknown) => { if (live) setSeen({ me: null, problem: messageOf(error) }) },
    )
    return () => { live = false }
  }, [])
  return seen
}

// Why a person may not put a value on the agent's computer, in words, or null when they may. A computer that is
// not running is no reason, since the request starts it.
function blockedOf(computer: Instance | undefined, person: string, login: (id: string) => string): string | null {
  if (!computer) return 'This agent has no computer, so a value cannot be set.'
  const owner = computer.owner_id
  if (owner !== null && !mayPutOn(owner, person)) return `${computer.name} is ${login(owner)}'s own computer, so only they can set a value on it.`
  return null
}

export function AgentSecrets({ agentId }: { agentId: string }) {
  const { me, problem } = useMe()
  const { rows: agents } = useSnapshot<Agent>('agents', {}, REFRESH_MS)
  const { rows: secrets, error } = useSnapshotOf(SecretRow, 'secrets', {}, REFRESH_MS)
  const { rows: sets } = useSnapshotOf(SecretSetRow, 'secret_sets', {}, REFRESH_MS)
  const { rows: instances } = useSnapshot<Instance>('instances', {}, REFRESH_MS)
  const { rows: people } = useSnapshot<Person>('people', {}, PEOPLE_MS)
  const heading = useId()
  const agent = agents.find((a) => a.id === agentId)
  const mine = secrets.filter((secret) => secret.scope === 'agent' && secret.agent_id === agentId).sort((a, b) => a.name.localeCompare(b.name))
  const computer = instances.find((instance) => instance.id === agent?.home_instance_id)
  // A person not loaded yet reads as someone.
  const login = (id: string) => people.find((p) => p.id === id)?.login ?? 'someone'
  const trouble = problem || error
  if (!trouble && (!me || !agent || !mine.length)) return null
  return (
    <section aria-labelledby={heading}>
      <h2 className="kicker section" id={heading}>Secrets</h2>
      {trouble && <p className="error small" role="alert">{trouble}</p>}
      {me && !!mine.length && (
        <>
          <p className="muted small">
            {computer ? `A value you set here goes to ${computer.name}, where the agent runs, and nowhere else.` : 'This agent has no computer, so a value cannot be set.'}
            {' '}The app keeps only its name, where it is set and when. A value already in the computer's secrets.json or in its daemon's environment works without being set here.
          </p>
          <ul className="secrets">
            {mine.map((secret) => {
              const row = computer ? sets.find((s) => s.instance_id === computer.id && s.name === secret.name) : undefined
              const at = row ? parseTime(row.set_at) : null
              const held: SecretHeld | null = row && at ? { at, by: row.set_by ? login(row.set_by) : 'someone' } : null
              return (
                <li key={secret.id}>
                  <div className="secret-head">
                    <code className="secret-name">{secret.name}</code>
                    {secret.description && <span className="muted small">{secret.description}</span>}
                  </div>
                  <SecretValue
                    name={secret.name} computer={computer?.name ?? 'its computer'} held={held} blocked={blockedOf(computer, me.person.id, login)} asleep={computer !== undefined && computer.status !== 'online'}
                    set={async (value) => new Date((await call(SecretStored, 'POST', `/v1/secrets/${secret.id}/value`, { value })).setAt)}
                    remove={async () => { await call(SecretRemoved, 'POST', `/v1/secrets/${secret.id}/remove`, {}) }}
                  />
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}
