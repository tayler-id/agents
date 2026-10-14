// Reading code in the side panel: a file with line numbers and highlighting, a
// unified diff with old and new line numbers, and the tabs between them.

import { useId, useMemo, type KeyboardEvent, type ReactNode } from 'react'
import { highlight } from './highlight.ts'

export function CodeView({ path, text }: { path: string; text: string }) {
  const lines = useMemo(() => highlight(path, text), [path, text])
  return (
    <div className="code" role="region" aria-label={`${path}, ${lines.length} lines`} tabIndex={0}>
      {lines.map((tokens, i) => (
        <div key={i} className="code-line">
          <span className="ln" aria-hidden="true">{i + 1}</span>
          <span className="lc">{tokens.map((t, j) => (t.kind === 'plain' ? t.text : <span key={j} className={`tok-${t.kind}`}>{t.text}</span>))}</span>
        </div>
      ))}
    </div>
  )
}

type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'added'; text: string; after: number }
  | { kind: 'removed'; text: string; before: number }
  | { kind: 'same'; text: string; before: number; after: number }

// git's unified diff as rows. The headers before the first hunk say only which
// file it is, except a line that says it is new, deleted or binary.
export function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = []
  let before = 0
  let after = 0
  let inHunk = false
  for (const text of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk?.[1] && hunk[2]) {
      before = Number(hunk[1])
      after = Number(hunk[2])
      inHunk = true
      rows.push({ kind: 'hunk', text })
    } else if (!inHunk) {
      if (/^(new file|deleted file|Binary files)/.test(text)) rows.push({ kind: 'note', text })
    } else if (text.startsWith('+')) {
      rows.push({ kind: 'added', text: text.slice(1), after: after++ })
    } else if (text.startsWith('-')) {
      rows.push({ kind: 'removed', text: text.slice(1), before: before++ })
    } else if (text.startsWith(' ')) {
      rows.push({ kind: 'same', text: text.slice(1), before: before++, after: after++ })
    } else if (text.startsWith('\\')) {
      rows.push({ kind: 'note', text })
    }
  }
  return rows
}

export function DiffView({ diff, label }: { diff: string; label: string }) {
  const rows = useMemo(() => parseDiff(diff), [diff])
  if (!rows.some((r) => r.kind !== 'note')) return <p className="muted small">Nothing changed in the text.</p>
  return (
    <div className="diff-view" role="region" aria-label={label} tabIndex={0}>
      {rows.map((row, i) => {
        if (row.kind === 'hunk' || row.kind === 'note') return <div key={i} className={`diff-line ${row.kind}`}><span className="lc">{row.text}</span></div>
        return (
          <div key={i} className={`diff-line ${row.kind}`}>
            <span className="ln" aria-hidden="true">{row.kind === 'added' ? '' : row.before}</span>
            <span className="ln" aria-hidden="true">{row.kind === 'removed' ? '' : row.after}</span>
            <span className="sign">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ''}<span className="sr-only">{row.kind === 'same' ? '' : ` ${row.kind}: `}</span></span>
            <span className="lc">{row.text}</span>
          </div>
        )
      })}
    </div>
  )
}

// Tabs that Left and Right move between, as the ARIA tabs pattern has them.
export function Tabs<T extends string>({ label, tabs, value, onChange, children }: {
  label: string; tabs: [T, string][]; value: T; onChange: (tab: T) => void; children: ReactNode
}) {
  const id = useId()
  const keys = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const at = tabs.findIndex(([tab]) => tab === value)
    const next = tabs[(at + step + tabs.length) % tabs.length]
    if (!next) return
    onChange(next[0])
    document.getElementById(`${id}-${next[0]}`)?.focus()
  }
  return (
    <>
      <div className="tabs" role="tablist" aria-label={label}>
        {tabs.map(([tab, name]) => (
          <button key={tab} id={`${id}-${tab}`} type="button" role="tab" aria-selected={tab === value} aria-controls={`${id}-panel`}
            tabIndex={tab === value ? 0 : -1} className={tab === value ? 'selected' : undefined} onClick={() => onChange(tab)} onKeyDown={keys}>
            {name}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${value}`} className="tab-panel">{children}</div>
    </>
  )
}
