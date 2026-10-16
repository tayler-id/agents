import { useState } from 'react'
import { act, call, useSnapshotOf, type Agent, type Me } from './data.ts'
import { useSubmit } from './useSubmit.ts'
import { Done } from '../../shared/onboarding.ts'
import { HookRow, mayChangeHooks } from '../../shared/recipe.ts'
import { HOOK_EVENTS, HookEvent, takesMatcher } from '../../shared/types.ts'

// What each event means, for the person reading a hook or adding one.
const EVENT_LABELS: Record<HookEvent, string> = {
  SessionStart: 'A session starts',
  UserPromptSubmit: 'A message arrives',
  PreToolUse: 'Before a tool runs',
  PostToolUse: 'After a tool runs',
  Stop: 'The agent finishes a turn',
  SubagentStop: 'A subagent finishes',
}

// The Claude Code hooks an agent runs. Each is a command on the agent's machine,
// so only the agent's owner or a team admin changes them, the rule the server holds.
export function Hooks({ agent, me }: { agent: Agent; me: Me }) {
  const { rows: all, error } = useSnapshotOf(HookRow, 'agent_hooks', {}, 4000)
  const hooks = all.filter((h) => h.agent_id === agent.id)
  const mayChange = mayChangeHooks(me.person, agent)
  return (
    <>
      <h2 className="kicker section">Hooks</h2>
      {error && <p className="error small" role="alert">{error}</p>}
      <ul className="items" aria-label="Hooks">
        {hooks.map((h) => (
          <li key={h.id}>
            <span className="hook">
              <span><strong>{h.name}</strong> <span className="muted small">{EVENT_LABELS[h.event]}{h.matcher ? ` · ${h.matcher}` : ''}</span></span>
              <code>{h.command}</code>
            </span>
            {mayChange && (
              <button type="button" className="link small" onClick={act(() => call(Done, 'POST', `/v1/agents/${agent.id}/hooks/${encodeURIComponent(h.name)}/delete`, {}))}>Remove</button>
            )}
          </li>
        ))}
        {!hooks.length && <li className="muted small empty">No hooks yet</li>}
      </ul>
      {mayChange
        ? <HookForm agentId={agent.id} />
        : <p className="muted small">A hook runs a command on the agent's machine, so only the agent's owner or a team admin changes them.</p>}
    </>
  )
}

function HookForm({ agentId }: { agentId: string }) {
  const [name, setName] = useState('')
  const [event, setEvent] = useState<HookEvent>('UserPromptSubmit')
  const [tools, setTools] = useState('')
  const [command, setCommand] = useState('')
  const [limit, setLimit] = useState('')
  // A limit that is no whole number goes to the server as it was typed, which refuses it, rather than as no limit.
  const timeoutSec = limit.trim() === '' ? null : /^\d+$/.test(limit.trim()) ? Number(limit.trim()) : limit
  const { submit, error, busy } = useSubmit(() => call(Done, 'POST', `/v1/agents/${agentId}/hooks`, {
    name, event, matcher: takesMatcher(event) && tools.trim() ? tools.trim() : null, command, timeoutSec,
  }), () => { setName(''); setTools(''); setCommand(''); setLimit('') })
  return (
    <details className="add">
      <summary className="small">Add a hook</summary>
      <form className="form" onSubmit={act(submit)} aria-label="Add a hook">
        <label htmlFor="hook-name">Name</label>
        <input id="hook-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="note-prompts" />
        <label htmlFor="hook-event">Runs when</label>
        <select id="hook-event" value={event} onChange={(e) => setEvent(HookEvent.parse(e.target.value))}>
          {HOOK_EVENTS.map((e) => <option key={e} value={e}>{EVENT_LABELS[e]}</option>)}
        </select>
        {takesMatcher(event) && (
          <>
            <label htmlFor="hook-tools">Only for these tools (optional)</label>
            <input id="hook-tools" value={tools} onChange={(e) => setTools(e.target.value)} placeholder="Write|Edit" />
          </>
        )}
        <label htmlFor="hook-runs">What it runs</label>
        <textarea id="hook-runs" rows={2} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="echo noted >> task/hook-log.txt" />
        <label htmlFor="hook-limit">Time limit in seconds (optional)</label>
        <input id="hook-limit" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="60" />
        <p className="small muted">It runs on the agent's machine with the event as JSON on its input. Each run, and what it printed, is in the agent's record.</p>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy || !name || !command.trim()}>Save hook</button>
          {error && <p className="error small" role="alert">{error}</p>}
        </div>
      </form>
    </details>
  )
}
