// The team's repos as checkboxes, or a project's when given one, with the repos
// in `kept` too, such as a draft's own. A task gets them in the order they were
// ticked, so the first one ticked is its primary repo.

import { repoName, useSnapshot, type Repo } from './data.ts'

export function RepoPicker({ value, onChange, projectId = null, kept = [] }: { value: string[]; onChange: (repoIds: string[]) => void; projectId?: string | null; kept?: string[] }) {
  const { rows: all } = useSnapshot<Repo>('repos', {}, 30000)
  const repos = projectId ? all.filter((r) => r.project_id === projectId || kept.includes(r.id)) : all
  const toggle = (repoId: string) => onChange(value.includes(repoId) ? value.filter((id) => id !== repoId) : [...value, repoId])
  const sorted = [...repos].sort((a, b) => repoName(a.remote_url).localeCompare(repoName(b.remote_url)))
  return (
    <fieldset>
      <legend className="small muted">Repos</legend>
      {sorted.map((repo) => (
        <label key={repo.id} className="check">
          <input type="checkbox" checked={value.includes(repo.id)} onChange={() => toggle(repo.id)} /> {repoName(repo.remote_url)}
          {value[0] === repo.id && value.length > 1 && <span className="muted small">primary</span>}
        </label>
      ))}
      {!repos.length && <p className="muted small">{projectId ? 'The project has no repos yet.' : 'The team has no repos yet.'}</p>}
    </fieldset>
  )
}
