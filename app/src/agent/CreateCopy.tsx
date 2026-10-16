// One button that copies an agent. The copy is the person's own, with the same setup and
// the team's memories, and a conversation of its own. The server picks its name and its
// machine, so there is nothing to fill in. A refusal is said in a note at the foot of the
// window, since the button's own place may have no room for it, and it stays until closed.

import type { CopyDone } from '../../../shared/recipe.ts'
import { useAttempt } from './attempt.ts'
import './copy.css'

export function CreateCopy({ create, opened }: { create: () => Promise<CopyDone>; opened: (copy: CopyDone) => void }) {
  const { busy, problem, attempt, dismiss } = useAttempt()
  const copy = async () => {
    const made = await attempt(create)
    if (made) opened(made)
  }
  return (
    <>
      <button type="button" className="ghost" disabled={busy} onClick={() => { void copy() }}>Create a copy</button>
      {problem && (
        <div className="copy-problem" role="alert">
          <span className="error small">{problem}</span>
          <button type="button" className="link small" onClick={dismiss}>Close</button>
        </div>
      )}
    </>
  )
}
