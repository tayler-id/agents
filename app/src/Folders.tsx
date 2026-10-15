import { useCallback, useId, useState } from 'react'
import { z } from 'zod'
import {
  AppConnected, AppRefusal, FolderAnswer, FolderRow, holdsHome, insideFolder, MacFolders, type FolderVisibility, type MacFolder,
} from '../../shared/terminal.ts'
import { act, day, messageOf, usePolled, useSnapshot, useSnapshotOf, type Instance, type Me } from './data.ts'

// What desktop/preload.cjs gives the page in the desktop app. A browser has none.
// Every answer is outside data, read through its schema.
type MacBridge = {
  list: () => Promise<unknown>
  connect: (path: string, visibility: FolderVisibility) => Promise<unknown>
  disconnect: (path: string) => Promise<unknown>
}
declare global {
  interface Window { agentsMac?: MacBridge }
}
// The preload runs before the page's code, so this is set from the start or never.
const mac = window.agentsMac ?? null

// What desktop/main.cjs hands back for each ask: the daemon's status and its answer.
const BridgeAnswer = z.object({ status: z.number().int(), body: z.unknown() })

// How often this Mac's folders are read again while the page is open, so a folder Claude Code just ran in shows up.
const LIST_EVERY_MS = 10_000
// How often the record's connected folders are read again.
const CONNECTED_EVERY_MS = 10_000

// Off disconnects a folder, and the other two connect it with who sees its sessions.
type Choice = 'off' | FolderVisibility
const CHOICES: { choice: Choice; label: string }[] = [{ choice: 'off', label: 'Off' }, { choice: 'team', label: 'Team' }, { choice: 'private', label: 'Just me' }]
const chosen = (row: MacFolder): Choice => (row.folder === null ? 'off' : row.folder.visibility)

// One ask of this Mac's daemon. A refusal or a failure throws with the daemon's words.
async function asked<S extends z.ZodType>(schema: S, answer: Promise<unknown>): Promise<z.output<S>> {
  const { status, body } = BridgeAnswer.parse(await answer)
  if (status !== 200) throw new Error(AppRefusal.parse(body).error)
  return schema.parse(body)
}

const nameOf = (path: string) => path.split('/').pop() ?? path
const shortPath = (path: string, home: string) => (insideFolder(home, path) ? `~${path.slice(home.length)}` : path)
const whoSees = (visibility: FolderVisibility) => (visibility === 'team' ? 'the team sees' : 'only you see')
const sessions = (n: number) => `${n} session${n === 1 ? '' : 's'}`

// What the page says after a folder was connected or changed.
function connectedText(name: string, before: Choice, done: AppConnected): string {
  const text = done.already ? `${name} was already connected, and ${whoSees(done.folder.visibility)} its sessions.`
    : before === 'off' ? `Connected ${name}. Claude Code sessions you start in it from now on land in the record, and ${whoSees(done.folder.visibility)} them.`
        + (done.exposed ? ` The team also sees the ${sessions(done.exposed)} already in the record from it.` : '')
      : done.folder.visibility === 'team' ? `The team sees ${name}'s sessions now${done.exposed ? `, and the ${sessions(done.exposed)} already in the record from it` : ''}.`
        : `Only you see ${name}'s sessions now, the ones already in the record too.`
  return [text, ...done.warnings.map((warning) => `Warning: ${warning}`)].join(' ')
}

const disconnectedText = (name: string, done: FolderAnswer) => (done.already ? `${name} was already disconnected.`
  : `Disconnected ${name}. Sessions you start in it from now on stay on this Mac, and the ones already in the record stay there.`)

// Where a person connects the folders whose Claude Code sessions land in the record.
// In the desktop app it lists this Mac's folders, each with its control. In a
// browser it lists the person's connected folders, read only.
export function FoldersPage({ me }: { me: Me }) {
  return (
    <section className="page" aria-label="Terminal folders">
      <header className="page-head">
        <div>
          <p className="kicker">Terminal sessions</p>
          <h1>Terminal folders</h1>
          <p className="muted small">
            Claude Code sessions you start in a connected folder land in the team's record. Team shows them to everyone on the team, and Just me keeps them to you.
          </p>
        </div>
      </header>
      <div className="page-body">
        {mac ? <ThisMac bridge={mac} me={me} /> : <Connected me={me} />}
      </div>
    </section>
  )
}

// What a folder's row last said, after its person chose something on it.
type Said = { path: string; text: string; failed: boolean }
// A folder whose person chose Team while the team can't see some of its sessions in the record, which the page asks about first.
type Asking = { path: string; sessions: number }

function ThisMac({ bridge, me }: { bridge: MacBridge; me: Me }) {
  const read = useCallback(() => asked(MacFolders, bridge.list()), [bridge])
  const { value, error, refresh } = usePolled(read, () => LIST_EVERY_MS)
  const [busy, setBusy] = useState<string | null>(null)
  const [said, setSaid] = useState<Said | null>(null)
  const [asking, setAsking] = useState<Asking | null>(null)

  // A change runs within 5 seconds of the person's click, while the bridge still counts it as theirs. Team asks first
  // whenever it would show the team sessions in the record they can't see now, counted afresh, unless the person
  // just said yes to that.
  const choose = act(async (row: MacFolder, choice: Choice, confirmed: boolean) => {
    const before = chosen(row)
    if (choice === before) return
    const name = nameOf(row.path)
    setBusy(row.path)
    setSaid(null)
    setAsking(null)
    try {
      if (choice === 'team' && !confirmed) {
        const now = (await asked(MacFolders, bridge.list())).folders.find((r) => r.path === row.path)
        if (now && now.hiddenSessions > 0) {
          setAsking({ path: row.path, sessions: now.hiddenSessions })
          return
        }
      }
      const text = choice === 'off'
        ? disconnectedText(name, await asked(FolderAnswer, bridge.disconnect(row.path)))
        : connectedText(name, before, await asked(AppConnected, bridge.connect(row.path, choice)))
      setSaid({ path: row.path, text, failed: false })
    } catch (e) {
      setSaid({ path: row.path, text: messageOf(e), failed: true })
    } finally {
      setBusy(null)
      refresh()
    }
  })

  if (!value) {
    return error
      ? <p className="error small" role="alert">This Mac's folders can't be listed. {error}</p>
      : <p className="muted">Asking this Mac's daemon for its folders…</p>
  }
  const keep = (row: MacFolder) => {
    setAsking(null)
    setSaid({ path: row.path, text: `Nothing changed. Only you see ${nameOf(row.path)}'s sessions.`, failed: false })
  }
  const connected = value.folders.flatMap((row) => (row.folder ? [row.folder] : []))
  const item = (row: MacFolder) => (
    <FolderItem key={row.path} row={row} home={value.home} connected={connected} busy={busy !== null} working={busy === row.path}
      said={said?.path === row.path ? said : null} asking={asking?.path === row.path && chosen(row) !== 'team' ? asking.sessions : null}
      onChoose={(choice) => { choose(row, choice, false) }} onConfirm={() => { choose(row, 'team', true) }} onKeep={() => { keep(row) }} />
  )
  const recent = value.folders.filter((row) => !row.temporary)
  const temporary = value.folders.filter((row) => row.temporary)
  return (
    <>
      <h2 className="kicker section">On this Mac</h2>
      <p className="muted small">Folders where Claude Code ran on this Mac, newest first. Sessions from before a folder was connected stay on this Mac.</p>
      {error && <p className="error small" role="alert">The list may be out of date. {error}</p>}
      {recent.length > 0 && <ul className="folder-list" aria-label="Folders on this Mac">{recent.map(item)}</ul>}
      {!recent.length && <p className="muted">Claude Code hasn't run on this Mac yet. Start a session in a project folder, and the folder shows here.</p>}
      {temporary.length > 0 && (
        <details className="temporary">
          <summary>Temporary folders, {temporary.length}</summary>
          <p className="muted small">Folders in the system's temporary space, where tools and checks start Claude Code.</p>
          <ul className="folder-list" aria-label="Temporary folders on this Mac">{temporary.map(item)}</ul>
        </details>
      )}
      <OtherMachines me={me} instanceId={value.instanceId} />
    </>
  )
}

function FolderItem({ row, home, connected, busy, working, said, asking, onChoose, onConfirm, onKeep }: {
  row: MacFolder; home: string; connected: FolderRow[]; busy: boolean; working: boolean; said: Said | null
  asking: number | null; onChoose: (choice: Choice) => void; onConfirm: () => void; onKeep: () => void
}) {
  const questionId = useId()
  const name = nameOf(row.path)
  const current = chosen(row)
  const isHome = holdsHome(row.path, home)
  // The deepest connected folder this one is inside, whose sessions this one's land with. The home folder's never land.
  const through = row.folder === null
    ? connected.filter((c) => c.path !== row.path && insideFolder(c.path, row.path) && !holdsHome(c.path, home)).sort((a, b) => b.path.length - a.path.length)[0]
    : undefined
  return (
    <li aria-busy={working}>
      <div className="folder-place">
        <strong>{name}</strong>
        <span className="muted small path">
          {shortPath(row.path, home)}{row.usedAt === null ? '' : ` · used ${day(row.usedAt)}`}{row.folder ? ` · connected ${day(row.folder.connected_at)}` : ''}
        </span>
      </div>
      <div className="choice" role="group" aria-label={`Who sees sessions from ${name}`}>
        {CHOICES.map(({ choice, label }) => (
          <button key={choice} type="button" aria-pressed={choice === current} disabled={busy || (isHome && choice !== 'off')}
            onClick={() => { onChoose(choice) }}>{label}</button>
        ))}
      </div>
      {isHome && (
        <p className="folder-note muted small">
          {row.path === home ? 'Your home folder holds every project you have' : 'It holds your home folder, and with it every project you have'}, so it can't be connected. Connect a project inside it.
        </p>
      )}
      {through && <p className="folder-note muted small">Its sessions land through {nameOf(through.path)}, which {whoSees(through.visibility)}.</p>}
      {asking !== null && (
        <div className="folder-note confirm" role="group" aria-labelledby={questionId}>
          <span className="small" id={questionId}>Show the team the {sessions(asking)} already in the record from {name}?</span>
          <button type="button" className="link small" disabled={busy} onClick={onConfirm}>Yes, show the team</button>
          {/* The safe answer takes the focus, so a key press can't show the team by accident. */}
          <button type="button" className="link small" autoFocus onClick={onKeep}>Keep it to me</button>
        </div>
      )}
      {said && <p className={`folder-note small${said.failed ? ' error' : ''}`} role={said.failed ? 'alert' : 'status'}>{said.text}</p>}
    </li>
  )
}

// The person's connected folders, from the record, and the machines they are on.
function useConnected(me: Me) {
  const { rows, error, loaded } = useSnapshotOf(FolderRow, 'connected_folders', {}, CONNECTED_EVERY_MS)
  const { rows: instances } = useSnapshot<Instance>('instances', {}, CONNECTED_EVERY_MS)
  const mine = rows.filter((f) => f.connected_by === me.person.id && f.disconnected_at === null).sort((a, b) => a.path.localeCompare(b.path))
  return { mine, instances, error, loaded }
}

function ConnectedList({ rows, instances, label }: { rows: FolderRow[]; instances: Instance[]; label: string }) {
  return (
    <ul className="folder-list" aria-label={label}>
      {rows.map((f) => (
        <li key={f.id}>
          <div className="folder-place">
            <strong>{nameOf(f.path)}</strong>
            <span className="muted small path">{f.path}</span>
          </div>
          {/* A machine not read yet goes unnamed for a moment. */}
          <span className="small">
            {f.visibility === 'team' ? 'Team' : 'Just me'} · {instances.find((i) => i.id === f.instance_id)?.name ?? 'a machine'} · since {day(f.connected_at)}
          </span>
        </li>
      ))}
    </ul>
  )
}

// In the desktop app, the folders connected on the person's other machines, which only those machines change.
function OtherMachines({ me, instanceId }: { me: Me; instanceId: string }) {
  const { mine, instances } = useConnected(me)
  const elsewhere = mine.filter((f) => f.instance_id !== instanceId)
  if (!elsewhere.length) return null
  return (
    <>
      <h2 className="kicker section">Connected on your other machines</h2>
      <ConnectedList rows={elsewhere} instances={instances} label="Connected on your other machines" />
    </>
  )
}

// In a browser, the person's connected folders, and where to change them.
function Connected({ me }: { me: Me }) {
  const { mine, instances, error, loaded } = useConnected(me)
  return (
    <>
      <h2 className="kicker section">Connected</h2>
      {mine.length > 0 && <ConnectedList rows={mine} instances={instances} label="Your connected folders" />}
      {loaded && !mine.length && <p className="muted">None of your folders are connected yet.</p>}
      {error && <p className="error small" role="alert">{error}</p>}
      <p>To connect a folder, or change who sees its sessions, open the Agents app on the Mac it is on.</p>
    </>
  )
}
