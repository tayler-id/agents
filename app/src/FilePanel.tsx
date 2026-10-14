// A changed file beside its task: the file as it is now, rendered when it is
// markdown, and its diff against the base branch.

import { useState } from 'react'
import { repoName, useSnapshotOf, useSnapshot, type Repo } from './data.ts'
import { CodeView, DiffView, Tabs } from './Code.tsx'
import { Markdown } from './Markdown.tsx'
import { FileChangeDetail, FileChangeRow } from '../../shared/work.ts'

const NOT_SHOWN = {
  binary: 'A binary file, so there is no text to show.',
  too_large: 'Too large to show here.',
} as const

export function FilePanel({ changeId, taskId, onClose }: { changeId: string; taskId: string; onClose: () => void }) {
  const { rows, error } = useSnapshotOf(FileChangeDetail, 'file_change', { id: changeId }, 3000)
  // The task's list says when the file stops differing, since its own row is then gone.
  const { rows: listed, error: unlisted } = useSnapshotOf(FileChangeRow, 'file_changes', { task: taskId }, 3000)
  const { rows: repos } = useSnapshot<Repo>('repos', {}, 30000)
  const [tab, setTab] = useState<'file' | 'diff'>('file')
  const file = rows[0]
  const repo = repos.find((r) => r.id === file?.repo_id)
  const gone = listed.length > 0 && !listed.some((f) => f.id === changeId)
  return (
    <aside className="panel wide" aria-label="File">
      <header className="panel-head">
        <div>
          <h2>{file?.path ?? 'File'}</h2>
          {file && (
            <p className="muted small">
              {repo ? repoName(repo.remote_url) : 'its repo'} · {file.status}{file.preview === 'text' ? ` · +${file.additions} −${file.deletions}` : ''}
            </p>
          )}
        </div>
        <button type="button" className="ghost" onClick={onClose}>Close</button>
      </header>
      <div className="document">
        {error || unlisted ? <p className="error small" role="alert">{error ?? unlisted}</p>
          : gone ? <p className="muted small">This file no longer differs from the base branch.</p>
            : !file ? <p className="muted small">Loading…</p>
              : (
                <Tabs label="View" tabs={[['file', 'File'], ['diff', 'Diff']]} value={tab} onChange={setTab}>
                  {file.preview !== 'text' ? <p className="muted small">{NOT_SHOWN[file.preview]}</p>
                    : tab === 'diff' ? <DiffView diff={file.diff} label={`The change to ${file.path}`} />
                      : file.content === null ? <p className="muted small">Deleted. The Diff tab shows what it held.</p>
                        : file.path.toLowerCase().endsWith('.md') ? <Markdown text={file.content} />
                          : <CodeView path={file.path} text={file.content} />}
                </Tabs>
              )}
      </div>
    </aside>
  )
}
