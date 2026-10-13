// What a task's agent added, changed or deleted in each repo, against the base
// branch, and the task's pull requests. Each file opens beside the task.

import { useMemo, useState, type ReactNode, type SyntheticEvent } from 'react'
import { act, api, messageOf, repoName, useParsedSnapshot, useSnapshot, type Artifact, type Repo, type Task } from './data.ts'
import { CHANGE_LIMITS, FileChangeRow, PushRow, UnlistedChangeRow } from '../../shared/work.ts'

const STATUS_WORDS = { added: 'added', modified: 'changed', deleted: 'deleted' } as const

const lines = (n: number, what: string) => `${n} ${n === 1 ? 'line' : 'lines'} ${what}`

type Group = { repoId: string; name: string; files: FileChangeRow[]; unlisted: UnlistedChangeRow | undefined }

export function Changes({ taskId, openId, onOpen, children }: {
  taskId: string; openId: string | null; onOpen: (changeId: string) => void
  // What goes with the list, such as the task's pull requests, which stay when nothing differs any more.
  children?: (changed: boolean) => ReactNode
}) {
  const { rows: files, error } = useParsedSnapshot(FileChangeRow, 'file_changes', { task: taskId }, 3000)
  const { rows: unlisted, error: unreadList } = useParsedSnapshot(UnlistedChangeRow, 'unlisted_changes', { task: taskId }, 3000)
  const { rows: repos } = useSnapshot<Repo>('repos', {}, 30000)
  const groups = useMemo(() => {
    const repoIds = new Set([...files.map((f) => f.repo_id), ...unlisted.map((u) => u.repo_id)])
    return [...repoIds].map((repoId): Group => {
      const repo = repos.find((r) => r.id === repoId)
      return {
        repoId, name: repo ? repoName(repo.remote_url) : 'a repo', unlisted: unlisted.find((u) => u.repo_id === repoId),
        files: files.filter((f) => f.repo_id === repoId).sort((a, b) => a.path.localeCompare(b.path)),
      }
    }).sort((a, b) => a.name.localeCompare(b.name))
  }, [files, unlisted, repos])
  const failed = error ?? unreadList
  if (failed) return <><p className="error small" role="alert">{failed}</p>{children?.(false)}</>
  if (!groups.length) return children?.(false) ?? null
  // A repo whose changes can't be listed may still have some, so its group counts as changed.
  return (
    <section className="changes" aria-label="Changes">
      <h2 className="kicker section">Changes <span className="muted">· {files.length} {files.length === 1 ? 'file' : 'files'}{unlisted.length ? ' listed' : ''}</span></h2>
      {groups.map((group) => (
        <div key={group.repoId} className="change-group">
          <h3 className="repo-name small">{group.name}</h3>
          {group.unlisted?.kind === 'too_many' && (
            <p className="muted small">More than {CHANGE_LIMITS.files.toLocaleString('en-US')} files changed, too many to list.</p>
          )}
          {group.unlisted?.kind === 'unreadable' && (
            <p className="error small">Couldn't read the changes: {group.unlisted.reason}{group.files.length ? ' The list is the last one read.' : ''}</p>
          )}
          {!!group.files.length && (
            <ul className="list" aria-label={`Changes in ${group.name}`}>
              {group.files.map((file) => (
                <li key={file.id}>
                  <button type="button" className={`row change${file.id === openId ? ' selected' : ''}`} aria-current={file.id === openId ? 'true' : undefined}
                    onClick={() => onOpen(file.id)}>
                    <span className="path">{file.path}</span>
                    <span className="muted small">
                      {STATUS_WORDS[file.status]}
                      {file.preview === 'text' && (
                        <>
                          <span aria-hidden="true"> +{file.additions} −{file.deletions}</span>
                          <span className="sr-only">, {lines(file.additions, 'added')}, {lines(file.deletions, 'removed')}</span>
                        </>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {children?.(true)}
    </section>
  )
}

// Opening the task's pull requests: the push, then one pull request per repo with
// commits past its base. Asking again pushes the new work to the same ones, whose
// title and description stay as they were, so the form only offers them for a new one.
export function PullRequests({ task, working, links, changed }: { task: Task; working: boolean; links: Artifact[]; changed: boolean }) {
  const { rows: pushes, error: unread } = useParsedSnapshot(PushRow, 'pushes', { task: task.id }, 2000)
  const latest = [...pushes].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  const [title, setTitle] = useState(task.title)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pushing = latest?.status === 'pushing'
  if (!changed && !links.length) return null
  const open = async (event?: SyntheticEvent) => {
    event?.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.openPullRequests(task.id, { title: title.trim(), body })
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="pull-requests" aria-label="Pull requests">
      {links.map((link) => (
        <p key={link.id} className="pull-request">
          <a href={link.url ?? undefined} target="_blank" rel="noreferrer">{link.title}</a> <span className="muted small">{link.state}</span>
        </p>
      ))}
      {pushing && <p className="muted small" role="status">Pushing the branch and opening the pull request…</p>}
      {latest?.status === 'failed' && <p className="error small" role="alert">{latest.error}</p>}
      {unread && <p className="error small" role="alert">{unread}</p>}
      {changed && <form className="form" onSubmit={act(open)} aria-label="Open a pull request">
        {!links.length && (
          <details className="add">
            <summary className="small">Title and description</summary>
            <label htmlFor={`pr-title-${task.id}`}>Title</label>
            <input id={`pr-title-${task.id}`} value={title} onChange={(e) => setTitle(e.target.value)} />
            <label htmlFor={`pr-body-${task.id}`}>Description</label>
            <textarea id={`pr-body-${task.id}`} rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
          </details>
        )}
        <div className="actions">
          <button type="submit" className="primary" disabled={working || pushing || busy || !title.trim()}>
            {links.length ? 'Update pull request' : latest?.status === 'failed' ? 'Try again' : 'Open pull request'}
          </button>
          {working && <p className="muted small">The agent is working. Open the pull request when its turn ends.</p>}
          {error && <p className="error small" role="alert">{error}</p>}
        </div>
      </form>}
    </section>
  )
}
