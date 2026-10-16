// A setup as a file. One button saves an agent's setup, and one reads a file and makes a
// new agent from it. Both take their calls as props. Import shows what the file will run
// before it makes anything, since hooks and plugins run commands on the person's machine.

import { useState } from 'react'
import { z } from 'zod'
import { messageOf } from '../data.ts'
import { carriedBy, type CopyDone } from '../../../shared/recipe.ts'
import { RecipeFile } from '../../../shared/recipe-file.ts'
import { useAttempt } from './attempt.ts'
import './copy.css'

// A browser starts a download from the link after the click returns, so the link is
// freed some time later and not at once.
const FREE_LINK_AFTER_MS = 10_000

function saveFile(fileName: string, text: string) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => { URL.revokeObjectURL(link.href) }, FREE_LINK_AFTER_MS)
}

export function ExportRecipe({ agentName, teamMemories, load }: {
  agentName: string; teamMemories: number; load: (withMemories: boolean) => Promise<RecipeFile>
}) {
  const [withMemories, setWithMemories] = useState(false)
  const [saved, setSaved] = useState('')
  const { busy, problem, attempt } = useAttempt()
  const include = withMemories && teamMemories > 0
  const save = async () => {
    const file = await attempt(() => load(include))
    if (!file) return
    const fileName = `${agentName}.recipe.json`
    saveFile(fileName, JSON.stringify(file, null, 2))
    setSaved(fileName)
  }
  return (
    <div role="group" aria-label="Export as a file">
      <label className="check">
        <input type="checkbox" checked={include} disabled={teamMemories === 0} onChange={(e) => { setWithMemories(e.target.checked) }} />
        With the team's memories ({teamMemories})
      </label>
      <p className="small muted">
        The file holds the agent's title, instructions, skills, plugins, routines and hooks. It holds no secret value and nothing the agent remembers about a person.
        Anyone who has the file can make an agent from it, on any team, so hand it only to people you trust with these.
      </p>
      <button type="button" className="ghost" disabled={busy} onClick={() => { void save() }}>Export as a file</button>
      {saved && <span className="small" role="status"> Saved {saved}</span>}
      {problem && <p className="error small" role="alert">{problem}</p>}
    </div>
  )
}

// The secrets a recipe's plugins name, which the machine must hold.
const secretsOf = (file: RecipeFile) => [...new Set(file.recipe.plugins.flatMap((p) =>
  Object.values(p.kind === 'stdio' ? p.config.env ?? {} : p.config.headers ?? {}).map((ref) => ref.secret)))]

const plural = (n: number, one: string) => `${String(n)} ${one}${n === 1 ? '' : 's'}`

export function ImportRecipe({ make, opened }: { make: (file: RecipeFile) => Promise<CopyDone>; opened: (made: CopyDone) => void }) {
  const [file, setFile] = useState<RecipeFile | null>(null)
  const [unreadable, setUnreadable] = useState('')
  const { busy, problem, attempt } = useAttempt()
  const read = async (picked: File | undefined) => {
    setFile(null)
    setUnreadable('')
    if (!picked) return
    let json: unknown
    try {
      json = JSON.parse(await picked.text())
    } catch (error) {
      setUnreadable(`That file is not JSON. ${messageOf(error)}`)
      return
    }
    const parsed = RecipeFile.safeParse(json)
    if (!parsed.success) {
      setUnreadable(`That file is not a recipe from Agents. ${z.prettifyError(parsed.error)}`)
      return
    }
    setFile(parsed.data)
  }
  const create = async () => {
    if (!file) return
    const made = await attempt(() => make(file))
    if (made) opened(made)
  }
  const secrets = file ? secretsOf(file) : []
  const carried = file ? carriedBy(file.recipe) : null
  return (
    <div role="group" aria-label="Start from a file">
      <label htmlFor="import-file" className="small">Start from a file</label>
      <input id="import-file" type="file" accept=".json,application/json" onChange={(e) => { void read(e.target.files?.[0]) }} />
      {unreadable && <p className="error small" role="alert">{unreadable}</p>}
      {file && carried && (
        <>
          <p>
            {file.name}, from a file. It carries {plural(carried.skills, 'skill')}, {plural(carried.plugins, 'plugin')}, {plural(carried.routines, 'routine')},{' '}
            {plural(carried.hooks, 'hook')} and {String(carried.memories)} team {carried.memories === 1 ? 'memory' : 'memories'}.
          </p>
          <p className="small muted">These run on your machine, as the agent's own. Read them before you make the agent.</p>
          <ul className="items" aria-label="What the file runs">
            {file.recipe.hooks.map((h) => (
              <li key={`hook:${h.name}`}><strong>{h.name}</strong> <span className="muted small">hook, {h.event}</span> <code>{h.command}</code></li>
            ))}
            {file.recipe.plugins.map((p) => (
              <li key={`plugin:${p.name}`}>
                <strong>{p.name}</strong> <span className="muted small">plugin</span>{' '}
                <code>{p.kind === 'stdio' ? [p.config.command, ...(p.config.args ?? [])].join(' ') : p.config.url}</code>
              </li>
            ))}
            {!file.recipe.hooks.length && !file.recipe.plugins.length && <li className="muted small">No hooks or plugins</li>}
          </ul>
          {secrets.length > 0 && <p className="small muted">It needs these secrets on the machine, and the file holds none of their values: {secrets.join(', ')}.</p>}
          <button type="button" className="ghost" disabled={busy} onClick={() => { void create() }}>Make the agent</button>
          {problem && <p className="error small" role="alert">{problem}</p>}
        </>
      )}
    </div>
  )
}
