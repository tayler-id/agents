// The hooks an agent runs. A hook is a command the agent's machine runs when something
// happens in a session, and its run lands in the session's record. Each shows as a row,
// and adding one is a line of choices: when it runs, which tools if it runs around a tool,
// and the command. The rows and the two calls come in as props, and the heading is the
// screen's to draw. Only the agent's owner or a team admin changes hooks, since each runs
// a command, and everyone else reads them.

import { useEffect, useRef, useState } from 'react'
import type { HookAsk, HookRow, HookSaved } from '../../../shared/recipe.ts'
import { HOOK_EVENTS, takesMatcher, type HookEvent } from '../../../shared/types.ts'
import { useAttempt } from './attempt.ts'
import './hooks.css'

export type HookActions = { save: (ask: HookAsk) => Promise<HookSaved>; remove: (name: string) => Promise<unknown> }

// What each event means in plain words. A new event is a type error until it has its words.
const WHEN: Record<HookEvent, string> = {
  SessionStart: 'A session starts',
  UserPromptSubmit: 'A message arrives',
  PreToolUse: 'Before a tool runs',
  PostToolUse: 'After a tool runs',
  Stop: 'A turn ends',
  SubagentStop: 'A subagent finishes',
}

export function Hooks({ agentName, hooks, canChange, actions }: { agentName: string; hooks: readonly HookRow[]; canChange: boolean; actions: HookActions }) {
  const removal = useAttempt()
  return (
    <div className="hooks">
      {hooks.length > 0 && (
        <ul className="hooks-list" aria-label="Hooks">
          {hooks.map((hook) => (
            <li key={hook.id} className="hooks-row">
              <div className="hooks-what">
                <p>
                  <strong>{hook.name}</strong>
                  <span className="muted small"> {WHEN[hook.event]}{hook.matcher ? ` · ${hook.matcher}` : ''}{hook.timeout_sec ? ` · stops after ${String(hook.timeout_sec)} s` : ''}</span>
                </p>
                <code className="hooks-command">{hook.command}</code>
              </div>
              {canChange && (
                <button type="button" className="link small" aria-label={`Remove ${hook.name}`} disabled={removal.busy}
                  onClick={() => { void removal.attempt(() => actions.remove(hook.name)) }}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!hooks.length && <p className="muted small hooks-empty">No hooks yet. A hook runs a command on {agentName}&apos;s machine when something happens in a session.</p>}
      {removal.problem && <p className="error small" role="alert">{removal.problem}</p>}
      {canChange
        ? <AddHook agentName={agentName} save={actions.save} />
        : <p className="muted small">Only {agentName}&apos;s owner or a team admin changes its hooks.</p>}
    </div>
  )
}

function AddHook({ agentName, save }: { agentName: string; save: HookActions['save'] }) {
  const [open, setOpen] = useState(false)
  const [event, setEvent] = useState<HookEvent>('UserPromptSubmit')
  const [tools, setTools] = useState('')
  const [command, setCommand] = useState('')
  // The name the server gave the hook just added, said until the person opens the line again, since the list catches up a few seconds later.
  const [added, setAdded] = useState('')
  const { busy, problem, attempt } = useAttempt()
  const opener = useRef<HTMLButtonElement>(null)
  const commandField = useRef<HTMLInputElement>(null)
  const wasOpen = useRef(false)
  // Focus goes to the command when the line opens, and back to the button that opened it when it closes.
  useEffect(() => {
    if (open) commandField.current?.focus()
    else if (wasOpen.current) opener.current?.focus()
    wasOpen.current = open
  }, [open])

  const add = async () => {
    const saved = await attempt(() => save({ event, command, matcher: takesMatcher(event) && tools.trim() ? tools.trim() : null }))
    if (saved === null) return
    setAdded(saved.name)
    setCommand('')
    setTools('')
    setOpen(false)
  }

  if (!open) {
    return (
      <>
        <button ref={opener} type="button" className="ghost hooks-open" onClick={() => { setAdded(''); setOpen(true) }}>Add a hook</button>
        {added && <p className="muted small" role="status">Added {added}.</p>}
      </>
    )
  }
  return (
    <div className="hooks-add" role="group" aria-label="Add a hook">
      <div className="hooks-when" role="group" aria-label="When it runs">
        {HOOK_EVENTS.map((e) => (
          <button key={e} type="button" className="hooks-chip" aria-pressed={event === e} onClick={() => { setEvent(e) }}>
            {event === e && <span aria-hidden="true">✓ </span>}{WHEN[e]}
          </button>
        ))}
      </div>
      {takesMatcher(event) && (
        <input className="hooks-field" aria-label="Only for these tools (optional)" placeholder="Any tool, or some, such as Write|Edit"
          value={tools} onChange={(e) => { setTools(e.target.value) }} />
      )}
      <input ref={commandField} className="hooks-field" aria-label="Command to run" placeholder="Command to run, such as ./check.sh"
        value={command} onChange={(e) => { setCommand(e.target.value) }}
        onKeyDown={(e) => { if (e.key === 'Enter' && command.trim() && !busy) void add() }} />
      <p className="muted small">It runs on {agentName}&apos;s machine and gets the event as JSON on its input. Each run lands in the session&apos;s record.</p>
      {problem && <p className="error small" role="alert">{problem}</p>}
      <div className="hooks-actions">
        <button type="button" className="primary" disabled={busy || !command.trim()} onClick={() => { void add() }}>Add hook</button>
        <button type="button" className="ghost" disabled={busy} onClick={() => { setOpen(false) }}>Cancel</button>
      </div>
    </div>
  )
}
