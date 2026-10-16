// Where a person sees an agent's keys. Three small pieces that read nothing and call nothing, so the agent
// panel can place them. The list they show comes from GET /v1/agents/<id>/keys (shared/secrets.ts, AgentKeys),
// the same list for all three, so the Keys row, an app's page and the full list never disagree.
//   KeysRow   the "Keys" row in the agent's Details. Opens the full list, with a red dot when any key is missing.
//   KeysList  the full list, every key the agent holds, with the app each belongs to.
//   AppKeys   one app's keys, hidden until clicked, with a red dot when any of them is missing.
// Each key's control is passed in as `control`, which is a SecretValue in the worked example in Secrets.tsx.

import { useState, type ReactNode } from 'react'
import type { AgentKey } from '../../shared/secrets.ts'
import './Keys.css'

// A red dot, named for a screen reader. The word "missing" is beside it wherever it shows, so greyscale reads the same.
const Dot = () => <span className="key-dot" role="img" aria-label="a key is missing" />

const count = (keys: AgentKey[]) => `${String(keys.length)} ${keys.length === 1 ? 'key' : 'keys'}`

export function KeysRow({ keys, onOpen }: { keys: AgentKey[]; onOpen: () => void }) {
  const missing = keys.filter((k) => k.state === 'missing').length
  return (
    <button type="button" className="keys-row" onClick={onOpen}>
      <span>Keys</span>
      {missing > 0 && <Dot />}
      <span className="keys-count muted small">{missing > 0 ? `${String(missing)} missing` : keys.length ? count(keys) : 'None needed'}</span>
    </button>
  )
}

export function KeysList({ keys, control }: { keys: AgentKey[]; control: (key: AgentKey) => ReactNode }) {
  if (keys.length === 0) return <p className="muted small">No plugin of this agent needs a key.</p>
  return (
    <ul className="key-list">
      {keys.map((key) => (
        <li key={key.name}>
          <div className="key-head">
            <span className="key-name">{key.name}</span>
            {key.state === 'missing' && <><Dot /><span className="small">Missing</span></>}
            <span className="muted small">Used by {key.plugins.join(', ')}</span>
          </div>
          {control(key)}
        </li>
      ))}
    </ul>
  )
}

// `keys` are the ones this app (a plugin) uses, filtered from the agent's list by `plugins.includes(app)`.
export function AppKeys({ keys, control }: { keys: AgentKey[]; control: (key: AgentKey) => ReactNode }) {
  const [open, setOpen] = useState(false)
  if (keys.length === 0) return null
  const missing = keys.some((k) => k.state === 'missing')
  return (
    <div className="app-keys">
      <button type="button" className="link small" aria-expanded={open} onClick={() => { setOpen(!open) }}>
        Keys{missing && <> <Dot /></>}
      </button>
      {open && <KeysList keys={keys} control={control} />}
    </div>
  )
}
