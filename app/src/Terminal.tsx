import { FolderRow, TerminalSessionRow } from '../../shared/terminal.ts'
import { clock, useSnapshot, useSnapshotOf, type Instance, type Me, type Person } from './data.ts'
import { EventList } from './Session.tsx'

// Whose terminal a session ran in: yours, or a teammate's by name. The person
// may have left the team, so a display fallback names no one.
export function terminalOwner(me: Me, people: Person[], personId: string | null): string {
  if (personId === me.person.id) return 'your'
  const person = people.find((p) => p.id === personId)
  return person ? `${person.name ?? person.login.split('@')[0] ?? person.login}'s` : "someone's"
}

// Where a terminal session ran: its folder's name, and the folder inside it the session started in.
export function terminalPlace(folders: FolderRow[], folderId: string, cwd: string): string {
  const folder = folders.find((f) => f.id === folderId)
  if (!folder) return cwd
  return `${folder.path.split('/').pop() ?? folder.path}${cwd.slice(folder.path.length)}`
}

// A Claude Code session a person ran in their own terminal, in a folder they connected.
export function TerminalSessionView({ me, sessionId }: { me: Me; sessionId: string }) {
  const { rows: sessions, loaded } = useSnapshotOf(TerminalSessionRow, 'sessions', { of: 'folders' }, 3000)
  const { rows: folders } = useSnapshotOf(FolderRow, 'connected_folders', {}, 10000)
  const { rows: people } = useSnapshot<Person>('people')
  const { rows: instances } = useSnapshot<Instance>('instances')
  const session = sessions.find((s) => s.id === sessionId)
  if (!session) {
    return <section className="page"><p className="muted">{loaded ? 'This terminal session is not one you can see.' : 'Loading the session…'}</p></section>
  }
  const machine = instances.find((i) => i.id === session.instance_id)
  return (
    <section className="page" aria-label="Terminal session">
      <header className="page-head">
        <div>
          <p className="kicker">From {terminalOwner(me, people, session.started_by)} terminal</p>
          <h1>{terminalPlace(folders, session.folder_id, session.cwd)}</h1>
          <p className="muted small">
            {session.status.replace('_', ' ')} · {machine?.name ?? 'machine'} · {session.turns} {session.turns === 1 ? 'turn' : 'turns'} · started {clock(session.created_at)}
          </p>
        </div>
      </header>
      <div className="page-body">
        <EventList sessionId={sessionId} />
      </div>
    </section>
  )
}
