// The command palette. Cmd+K on a Mac, Ctrl+K elsewhere, opens it from
// anywhere, and typing finds agents, conversations, tasks, runs, pipelines and
// documents, beside the actions that make new things. Up and Down move, Enter
// opens, Escape closes. Outside a field, c starts a new task and r a new room.
// Those single keys can be turned off, as WCAG 2.1.4 asks of them.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { go } from './App.tsx'
import {
  api, conversationLabel, messageOf, useSnapshotOf, useSnapshot,
  type Agent, type Conversation, type Me, type Member, type Person, type Pipeline, type Run, type Session, type Task,
} from './data.ts'
import { shortRunLabel } from './Run.tsx'
import { DocumentRow } from '../../shared/work.ts'

const GROUPS = ['Actions', 'Agents', 'Conversations', 'Tasks', 'Runs', 'Pipelines', 'Documents'] as const
type Group = (typeof GROUPS)[number]
type Item = { id: string; group: Group; label: string; hint: string; keys?: string; open: () => void | Promise<void> }
// Enough of each group to choose from without the list running off the screen.
const PER_GROUP = 6
const SINGLE_KEYS = 'agents.single-key-shortcuts'

const onMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent)
export const paletteKey = () => (onMac() ? '⌘K' : 'Ctrl+K')

// Whether the single-key shortcuts are on, as this browser last set them. Storage
// can be missing, as in a private window, and then they are on.
function singleKeysOn(): boolean {
  try {
    return localStorage.getItem(SINGLE_KEYS) !== 'off'
  } catch {
    return true
  }
}

function setSingleKeys(on: boolean) {
  try {
    localStorage.setItem(SINGLE_KEYS, on ? 'on' : 'off')
  } catch {
    // Storage is missing, as in a private window, so the choice lasts until the page reloads.
  }
}

const typingIn = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

// The keys the whole app answers. A chord works anywhere, fields included, since
// it types nothing, except Ctrl+K on a Mac, which a text field uses to delete to
// the end of the line. A single key never fires while someone types or composes.
export function useShortcuts(togglePalette: () => void) {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return
      const chord = onMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (chord && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        togglePalette()
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey || typingIn(event.target) || !singleKeysOn()) return
      if (document.querySelector('dialog[open]')) return
      if (event.key === 'c') {
        event.preventDefault()
        go({ create: 'task' })
      } else if (event.key === 'r') {
        event.preventDefault()
        go({ create: 'room' })
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [togglePalette])
}

// Everything the palette can open. Its lists load when it opens.
function useItems(me: Me): Item[] {
  const { rows: agents } = useSnapshot<Agent>('agents')
  const { rows: conversations } = useSnapshot<Conversation>('conversations')
  const { rows: members } = useSnapshot<Member>('conversation_members')
  const { rows: people } = useSnapshot<Person>('people')
  const { rows: tasks } = useSnapshot<Task>('tasks')
  const { rows: sessions } = useSnapshot<Session>('sessions', { of: 'tasks' })
  const { rows: runs } = useSnapshot<Run>('runs')
  const { rows: pipelines } = useSnapshot<Pipeline>('pipelines')
  const { rows: documents } = useSnapshotOf(DocumentRow, 'documents', {})
  return useMemo(() => {
    const runOf = new Map(runs.map((r) => [r.task_id, r]))
    const titleOf = new Map(tasks.map((t) => [t.id, t.title]))
    const drafts = new Set(sessions.filter((s) => s.status === 'draft' && s.task_id).map((s) => s.task_id))
    const agentName = new Map(agents.map((a) => [a.id, a.name]))
    const login = new Map(people.map((p) => [p.id, p.login]))
    return [
      { id: 'new-task', group: 'Actions', label: 'New task', hint: '', keys: 'C', open: () => go({ create: 'task' }) },
      { id: 'new-room', group: 'Actions', label: 'New room', hint: '', keys: 'R', open: () => go({ create: 'room' }) },
      { id: 'new-agent', group: 'Actions', label: 'New agent', hint: '', open: () => go({ create: 'agent' }) },
      ...agents.map((a): Item => ({
        id: `agent-${a.id}`, group: 'Agents', label: a.name, hint: a.title ?? '',
        open: async () => go({ conversation: (await api.openDm(a.name)).conversationId }),
      })),
      ...conversations.map((c): Item => ({
        id: `conversation-${c.id}`, group: 'Conversations', label: conversationLabel(c, { me, members, agentName, login }),
        hint: c.kind === 'room' ? 'room' : '', open: () => go({ conversation: c.id }),
      })),
      // Replays score proposals and take no messages, so the palette leaves them out.
      ...tasks.filter((t) => !runOf.has(t.id) && t.source !== 'replay').map((t): Item => ({
        id: `task-${t.id}`, group: 'Tasks', label: t.title, hint: drafts.has(t.id) ? 'draft' : '', open: () => go({ task: t.id }),
      })),
      ...runs.filter((r) => !r.replay_of).map((r): Item => ({
        id: `run-${r.id}`, group: 'Runs', label: titleOf.get(r.task_id) ?? r.trigger_payload.report?.title ?? 'A run', hint: shortRunLabel(r.status),
        open: () => go({ run: r.id }),
      })),
      ...pipelines.map((p): Item => ({ id: `pipeline-${p.id}`, group: 'Pipelines', label: p.name, hint: '', open: () => go({ pipeline: p.id }) })),
      ...documents.map((d): Item => {
        const run = runOf.get(d.task_id)
        return {
          id: `document-${d.id}`, group: 'Documents', label: d.title, hint: titleOf.get(d.task_id) ?? '',
          open: () => go(run ? { run: run.id, document: d.id } : { task: d.task_id, document: d.id }),
        }
      }),
    ]
  }, [me, agents, conversations, members, people, tasks, sessions, runs, pipelines, documents])
}

// Items whose label and hint hold every word typed, those starting with it first.
function search(items: Item[], query: string): Item[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const scored = items.flatMap((item) => {
    const label = item.label.toLowerCase()
    const text = `${label} ${item.hint.toLowerCase()} ${item.group.toLowerCase()}`
    if (!words.every((word) => text.includes(word))) return []
    const first = words[0] ?? ''
    return [{ item, score: label.startsWith(first) ? 0 : label.includes(` ${first}`) ? 1 : 2 }]
  })
  return GROUPS.flatMap((group) => scored.filter((s) => s.item.group === group)
    .sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label))
    .slice(0, group === 'Actions' ? undefined : PER_GROUP).map((s) => s.item))
}

export function Palette({ me, onClose }: { me: Me; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState(0)
  const [singleKeys, setSingleKeysShown] = useState(singleKeysOn)
  const items = useItems(me)
  const results = useMemo(() => search(items, query), [items, query])
  const active = Math.min(picked, results.length - 1)

  // A modal dialog keeps focus inside it and makes the page behind it inert. Its
  // closing hands focus back to whatever had it before.
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [])

  const [error, setError] = useState('')
  // Opening never throws: a failure, such as an agent's conversation not opening, shows here.
  const open = async (item: Item) => {
    try {
      await item.open()
      dialog.current?.close()
      document.querySelector<HTMLElement>('main')?.focus()
    } catch (e) {
      setError(messageOf(e))
    }
  }
  const keys = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setPicked((active + step + results.length) % Math.max(results.length, 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const item = results[active]
      if (item) void open(item)
    }
  }
  const optionId = (item: Item) => `palette-${item.id}`
  const current = results[active]
  return (
    <dialog ref={dialog} className="palette" aria-label="Go to" onClose={onClose}>
      <input role="combobox" aria-expanded="true" aria-controls="palette-results" aria-autocomplete="list" aria-label="Go to"
        aria-activedescendant={current ? optionId(current) : undefined} value={query} placeholder="Find an agent, conversation, task, run, pipeline or document"
        onChange={(e) => { setQuery(e.target.value); setPicked(0) }} onKeyDown={keys} />
      <div id="palette-results" role="listbox" aria-label="Results" className="palette-results">
        {GROUPS.map((group) => {
          const own = results.filter((item) => item.group === group)
          if (!own.length) return null
          return (
            <div key={group} role="group" aria-labelledby={`palette-group-${group}`}>
              <div id={`palette-group-${group}`} role="presentation" className="kicker">{group}</div>
              {own.map((item) => (
                <div key={item.id} id={optionId(item)} role="option" aria-selected={item === current} className={`option${item === current ? ' active' : ''}`}
                  onMouseMove={() => setPicked(results.indexOf(item))} onClick={() => { void open(item) }}>
                  <span>{item.label}</span>
                  <span className="muted small">{item.hint}{item.keys && singleKeys ? <kbd>{item.keys}</kbd> : null}</span>
                </div>
              ))}
            </div>
          )
        })}
        {!results.length && <p className="muted small empty">Nothing matches.</p>}
        {error && <p className="error small" role="alert">{error}</p>}
      </div>
      <footer className="palette-foot small muted">
        <span><kbd>↑</kbd> <kbd>↓</kbd> to move, <kbd>Enter</kbd> to open, <kbd>Esc</kbd> to close, <kbd>{paletteKey()}</kbd> from anywhere</span>
        <label className="check">
          <input type="checkbox" checked={singleKeys} onChange={(e) => { setSingleKeys(e.target.checked); setSingleKeysShown(e.target.checked) }} />
          Single-key shortcuts
        </label>
      </footer>
    </dialog>
  )
}
