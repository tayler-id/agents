// Terminal sessions: the Claude Code sessions a person starts in their own
// terminal, in a folder they connected on this Mac. Claude Code writes each
// session's transcript under ~/.claude/projects, in a folder named after the
// path the session started in. This reads the transcripts of the sessions that
// started inside a connected folder after it was connected, and posts them to
// the record. A transcript of any other session is read only as far as the line
// that says where it started, and nothing of it leaves the Mac. The design is
// docs/design/local-sessions.md.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Shape, ShapeStream, type Row } from '@electric-sql/client'
import { z } from 'zod'
import { messageOf } from '../shared/errors.ts'
import { FolderId, SessionId } from '../shared/ids.ts'
import { makeScrub, type Scrub } from '../shared/scrub.ts'
import { FolderRow, holdsHome, insideFolder, TerminalSessionAnswer } from '../shared/terminal.ts'
import { MAX_BODY_BYTES, type EventBatch, type NewEvent, type RawLine, type SessionStatus } from '../shared/types.ts'
import { ApiError, type Api, type Config } from './api.ts'
import { TranscriptLine, toolTraffic, transcriptBatch, withoutWhatStays } from './claude.ts'
import { dotenvFinder, dotenvSecrets, type Secrets } from './secrets.ts'

// Where Claude Code keeps transcripts. CLAUDE_CONFIG_DIR moves its whole config folder.
const PROJECTS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
// How often the transcripts are read. A line reaches the record about this long
// after Claude Code writes it, and each read lists one folder per connected folder.
const READ_EVERY_MS = 1000
// At most this many lines go in one post, so a long transcript read at once after
// a restart goes in parts, each a short transaction for the API.
const LINES_PER_POST = 200
// A post's lines, encoded as the API reads them, stay under its limit, with room
// for the brackets and the status around them.
const BYTES_PER_POST = MAX_BODY_BYTES - 64 * 1024
// A post the API failed, or that never reached it, is tried again on a later
// read, after 1 s, then 2, 4 and so on up to a minute. Every other session goes
// on meanwhile. After this many failures in a row that the API answered, the
// session is parked until the daemon starts again. A post that never reached the
// API doesn't count, since an API that is down holds every session alike.
const RETRY_FIRST_MS = 1000
const RETRY_MOST_MS = 60_000
const ANSWERED_FAILURES_TO_PARK = 10
// A transcript or folder that fails this many reads in a row is parked until the
// daemon starts again, so one bad file can't stop the others.
const READ_FAILURES_TO_PARK = 3
// How far into a transcript its start is looked for. Claude Code writes it within
// the first few lines, and a transcript that has none this far in is passed over.
const START_BYTES = 1024 * 1024

// Claude Code names a session's folder after the path it started in, with every
// character other than a letter or a digit made a dash. Only the folders whose
// names start like a connected folder's are listed. The path each transcript
// gives decides, since a name cannot tell /a/repo-old from a folder inside /a/repo.
export const projectName = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-')

// How far each transcript has been sent, so a restart goes on from there. Losing
// this file costs only a reread, since the record skips lines it already has.
// `connectedAt` is when the folder was connected as the session was taken, since a
// folder connected again starts over. `inode` and `firstUuid` tell the same file
// from one replaced or cut short, which is read again from its start. `withheld`
// holds the ids of the tool calls, as of the offset, whose results stay on the
// Mac and have not arrived yet, since a result can arrive after a restart.
const Sent = z.record(z.string(), z.object({
  sessionId: SessionId, folderId: FolderId, connectedAt: z.string(), cwd: z.string(), offset: z.number().int().min(0), inode: z.number().int(), firstUuid: z.string().nullable(), parentToolUseId: z.string().nullable(),
  withheld: z.array(z.string()).default([]),
}))
type Sent = z.infer<typeof Sent>
type Tracked = Sent[string]

// A subagent's transcript sits beside a file of facts that names the Agent call that started it.
const SubagentFacts = z.looseObject({ toolUseId: z.string() })

// The first line that carries a uuid. A transcript keeps it for as long as it is
// the same file, so a different one means it was rewritten. It is looked for as
// far in as the start is, since it is usually the same line, and Claude Code's
// first lines run to 100 KB or more.
const HasUuid = z.looseObject({ uuid: z.string() })
function firstUuidOf(file: string): string | null {
  for (const line of readLines(file, 0, START_BYTES)) {
    const found = HasUuid.safeParse(parseJson(line.text))
    if (found.success) return found.data.uuid
  }
  return null
}

// The first line of a transcript that says where and when its session started.
const Start = z.looseObject({ cwd: z.string(), timestamp: z.string(), sessionId: z.string() })
type Start = z.infer<typeof Start>

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch (error) {
    // Not JSON, so not a line Claude Code finished writing. It makes nothing, and the log counts it.
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

// How much of a transcript is read at a time.
const CHUNK_BYTES = 64 * 1024

type FileLine = { text: string; end: number }

// The complete lines of a file from an offset, up to a limit of bytes, each with
// the offset just after it. The file is read a chunk at a time and a line is
// handed over as soon as it is whole, so a long transcript is never held in
// memory, and a caller that stops early leaves the rest unread. A line still
// being written, with no newline yet, is left unread.
function* readLines(file: string, offset: number, limit = Infinity): Generator<FileLine> {
  const fd = openSync(file, 'r')
  try {
    const stop = offset + limit
    // The bytes of the line being read that earlier chunks held.
    let begun: Buffer[] = []
    let at = offset
    while (at < stop) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, stop - at))
      const read = readSync(fd, chunk, 0, chunk.length, at)
      if (read === 0) return
      const bytes = chunk.subarray(0, read)
      let from = 0
      for (let end = bytes.indexOf(0x0a); end >= 0; end = bytes.indexOf(0x0a, from)) {
        const text = Buffer.concat([...begun, bytes.subarray(from, end)]).toString('utf8')
        begun = []
        from = end + 1
        yield { text, end: at + from }
      }
      if (from < read) begun.push(bytes.subarray(from))
      at += read
    }
  } finally {
    closeSync(fd)
  }
}

// Lines on their way to the record in one post, and the offset just after them.
type Part = { events: NewEvent[]; raw: RawLine[]; status?: SessionStatus; lines: number; bytes: number; end: number; unparsed: number }
const emptyPart = (end: number): Part => ({ events: [], raw: [], lines: 0, bytes: 0, end, unparsed: 0 })

// Follows this Mac's connected folders and sends their terminal sessions until
// the signal aborts. Nothing is sent before `ready` says the login shell's
// secrets are known, and nothing at all if they can't be.
export async function followTerminalSessions(options: {
  home: string; config: Config; api: Api; secrets: () => Secrets; ready: Promise<boolean>; signal: AbortSignal
}): Promise<void> {
  const { home, config, api, signal } = options
  if (!await options.ready) return
  const stateFile = join(home, 'terminal-sessions.json')
  const sent = new Map<string, Tracked>(Object.entries(loadSent(stateFile)))
  let changed = false
  // Transcripts of sessions that are not a connected folder's, by path. They are never read again.
  const passed = new Set<string>()
  // Connected folders, deepest first, so a session in a folder inside another belongs to the inner one.
  let folders: FolderRow[] = []
  // The person's home folder, and any folder above it, is never read. It holds every project they have,
  // and the API can't tell where a Mac's home is, so a folder there that something with this machine's
  // token connected would send every session they start under it.
  const userHome = realpathSync.native(homedir())
  const refused = new Set<string>()

  const stream = new ShapeStream<Row>({
    url: `${config.api}/v1/shape/connected_folders`,
    headers: { authorization: `Bearer ${config.token}` },
    signal,
    onError: (error) => {
      if (!signal.aborted) console.error('connected folders sync:', error.message)
      return signal.aborted ? undefined : {}
    },
  })
  new Shape(stream).subscribe(({ rows }) => {
    const connected = rows.map((row) => FolderRow.parse(row))
    for (const folder of connected) {
      if (holdsHome(folder.path, userHome) && !refused.has(folder.id)) {
        refused.add(folder.id)
        console.error(`terminal sessions, ${folder.path}: it is the home folder or holds it, so the daemon reads no session in it`)
      }
    }
    folders = connected.filter((folder) => !holdsHome(folder.path, userHome)).sort((a, b) => b.path.length - a.path.length)
    // A disconnected folder's sessions stop at once. One connected again starts
    // over, so a session taken under its earlier connection stops too, even when
    // this daemon missed the disconnect, as it does when stopped through it.
    const connectedAt = new Map(folders.map((f) => [f.id, Date.parse(f.connected_at)]))
    for (const [file, tracked] of sent) {
      if (connectedAt.get(tracked.folderId) !== Date.parse(tracked.connectedAt)) {
        sent.delete(file)
        changed = true
      }
    }
  })

  // Transcripts and folders parked until the daemon starts again.
  const parked = new Set<string>()
  const readFailures = new Map<string, number>()
  const retries = new Map<string, { tries: number; answered: number; at: number }>()
  function park(path: string, why: string) {
    parked.add(path)
    console.error(`terminal sessions, ${path}: ${why}. It is parked until the daemon starts again.`)
  }

  // Reads one transcript or folder. A failure counts against it alone.
  async function attempt(path: string, work: () => Promise<void>) {
    try {
      await work()
      readFailures.delete(path)
    } catch (error) {
      // Claude Code's cleanup removes old transcripts, so one can go between listing it and reading it.
      if (missing(error)) return
      const failures = (readFailures.get(path) ?? 0) + 1
      readFailures.set(path, failures)
      if (failures >= READ_FAILURES_TO_PARK) park(path, `${messageOf(error)}. It failed ${failures} reads in a row`)
      else console.error(`terminal sessions, ${path}: ${messageOf(error)}`)
    }
  }

  // Posts a part of a transcript, and says whether the record has it.
  async function post(file: string, sessionId: string, batch: EventBatch): Promise<boolean> {
    try {
      await api('POST', `/v1/sessions/${sessionId}/events`, batch)
      retries.delete(file)
      return true
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0
      if (status === 409) {
        // The API says the folder is closed to this session, so the daemon stops sending it.
        // Passing it over for good matters when the Mac's clock runs ahead of the server's,
        // since the session can then look newer than the folder's connection and be taken again.
        sent.delete(file)
        passed.add(file)
        changed = true
        console.error(`terminal session ${sessionId}: its folder was disconnected since it started, so the rest of it stays on the Mac`)
        return false
      }
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        // The offset stays before the refused lines, so a daemon started again, perhaps against a fixed API, sends them.
        park(file, `the API refused a post for session ${sessionId}: ${messageOf(error)}`)
        return false
      }
      // fetch fails with a TypeError when the API can't be reached. Anything else is a bug.
      if (!(error instanceof ApiError) && !(error instanceof TypeError)) throw error
      const last = retries.get(file) ?? { tries: 0, answered: 0, at: 0 }
      const tries = last.tries + 1
      const answered = last.answered + (error instanceof ApiError ? 1 : 0)
      retries.set(file, { tries, answered, at: Date.now() + Math.min(RETRY_MOST_MS, RETRY_FIRST_MS * 2 ** (tries - 1)) })
      if (answered >= ANSWERED_FAILURES_TO_PARK) park(file, `the API failed its posts ${answered} times in a row, the last with ${messageOf(error)}`)
      else if (tries === 1) console.error(`terminal session ${sessionId}: ${messageOf(error)}. It is tried again with backoff, and the other sessions go on.`)
      return false
    }
  }

  // Each connected folder's .env files, found again on every read.
  const finders = new Map<string, (root: string) => string[]>()
  // Each folder's scrubber in the current read, so its .env files are read once a read.
  let scrubs = new Map<string, Scrub>()
  function scrubFor(folder: FolderRow): Scrub {
    const made = scrubs.get(folder.id)
    if (made) return made
    const find = finders.get(folder.path) ?? dotenvFinder()
    finders.set(folder.path, find)
    // A value that is part of the folder's own path is in the record already, as
    // the folder's path, and scrubbing it would put a session's cwd outside the folder.
    const scrub = makeScrub([...options.secrets(), ...dotenvSecrets(find(folder.path))]
      .filter(([, value]) => !folder.path.includes(value))
      .sort((a, b) => b[1].length - a[1].length))
    scrubs.set(folder.id, scrub)
    return scrub
  }

  // Sends what a transcript gained since last time, in posts the API takes. The
  // offset moves past a post's lines only once the record has them.
  async function send(file: string, tracked: Tracked, folder: FolderRow) {
    const retry = retries.get(file)
    if (retry && retry.at > Date.now()) return
    const { ino, size } = statSync(file)
    if (ino === tracked.inode && size === tracked.offset) return
    const first = firstUuidOf(file)
    if (ino !== tracked.inode || size < tracked.offset || (tracked.firstUuid !== null && first !== tracked.firstUuid)) {
      // Cut short or replaced, so it is read again from its start. The record skips the lines it has.
      console.error(`terminal sessions, ${file}: it was cut short or replaced, so it is read again from its start`)
      changed = true
      // A main transcript is taken again, so where and when it started is checked again.
      if (tracked.parentToolUseId === null) {
        sent.delete(file)
        return
      }
      tracked.offset = 0
      tracked.inode = ino
      tracked.withheld = []
    }
    if (first !== tracked.firstUuid) {
      tracked.firstUuid = first
      changed = true
    }
    let scrub: Scrub | undefined
    let part = emptyPart(tracked.offset)
    // The calls whose results stay on the Mac, as of the lines the record has.
    // A post that fails leaves tracked.withheld as it was, with the offset.
    const withheld = new Set(tracked.withheld)
    const flush = async () => {
      const batch: EventBatch = part.status === undefined ? { events: part.events, raw: part.raw } : { events: part.events, raw: part.raw, status: part.status }
      if ((batch.events.length || batch.status) && !await post(file, tracked.sessionId, batch)) return false
      if (part.unparsed) console.error(`terminal sessions, ${file}: ${part.unparsed} line${part.unparsed === 1 ? '' : 's'} did not parse, and were left out`)
      tracked.offset = part.end
      tracked.withheld = [...withheld]
      changed = true
      part = emptyPart(part.end)
      return true
    }
    for (const line of readLines(file, tracked.offset)) {
      scrub ??= scrubFor(folder)
      const value = withoutWhatStays(parseJson(line.text), withheld)
      const parsed = TranscriptLine.safeParse(value)
      const piece = parsed.success ? scrub(transcriptBatch([{ line: parsed.data, value }], tracked.parentToolUseId)) : undefined
      const bytes = piece ? Buffer.byteLength(JSON.stringify(piece.events)) + Buffer.byteLength(JSON.stringify(piece.raw)) : 0
      if (part.lines && (part.lines >= LINES_PER_POST || part.bytes + bytes > BYTES_PER_POST) && !await flush()) return
      if (bytes > BYTES_PER_POST) {
        park(file, `a line of ${Math.round(bytes / 1024 / 1024)} MB is more than one post to the API can hold`)
        return
      }
      if (piece) {
        part.events.push(...piece.events)
        part.raw.push(...piece.raw)
        part.status = piece.status ?? part.status
      } else {
        part.unparsed += 1
      }
      part.lines += 1
      part.bytes += bytes
      part.end = line.end
      // The calls this line makes and answers count for the lines after it. A
      // post that holds the line is what makes them count for the offset.
      if (parsed.success) {
        const { calls, answered } = toolTraffic(parsed.data)
        for (const call of calls) if (leavesFolder(folder.path, parsed.data.cwd ?? tracked.cwd, call.paths)) withheld.add(call.id)
        for (const id of answered) withheld.delete(id)
      }
    }
    if (part.lines) await flush()
  }

  // How far into each transcript the start has been looked for without being found,
  // by the file's inode, so a transcript still being written is searched on from
  // there and not from its first byte on every read.
  const searched = new Map<string, { inode: number; at: number }>()

  // Where and when a transcript's session started, once Claude Code has written that line.
  function startOf(file: string): Start | undefined {
    const { ino, size } = statSync(file)
    const known = searched.get(file)
    let at = known?.inode === ino && known.at <= size ? known.at : 0
    for (const line of readLines(file, at, START_BYTES - at)) {
      at = line.end
      const start = Start.safeParse(parseJson(line.text))
      if (start.success) {
        searched.delete(file)
        return start.data
      }
    }
    // A transcript with no start in its first START_BYTES is passed over for good.
    // Any other is searched on from here when it has grown.
    if (size > START_BYTES) {
      searched.delete(file)
      passed.add(file)
    } else {
      searched.set(file, { inode: ino, at })
    }
    return undefined
  }

  // Takes a session that started in a connected folder after it was connected,
  // and passes over any other for good.
  async function track(file: string): Promise<Tracked | undefined> {
    const start = startOf(file)
    if (!start) return undefined
    // A transcript is named after its session. One whose lines name another, as a
    // copied file's can, would write into that session's record, in another folder.
    if (basename(file, '.jsonl') !== start.sessionId) {
      passed.add(file)
      console.error(`terminal sessions, ${file}: its lines name session ${start.sessionId}, not the one in its name, so it stays on the Mac`)
      return undefined
    }
    const folder = folders.find((f) => insideFolder(f.path, start.cwd))
    // A time that does not parse never counts as after, so such a session stays on the Mac.
    const startedAfter = folder !== undefined && Date.parse(start.timestamp) >= Date.parse(folder.connected_at)
    // The daemon's own sessions run in its home, and reach the record as an agent's.
    if (!folder || !startedAfter || insideFolder(home, start.cwd)) {
      passed.add(file)
      return undefined
    }
    try {
      // A folder's or a session's name can hold a secret too.
      const scrub = scrubFor(folder)
      const { sessionId } = TerminalSessionAnswer.parse(await api('POST', '/v1/instance/terminal-sessions',
        { folderId: folder.id, harnessSessionId: scrub(start.sessionId), cwd: scrub(start.cwd) }))
      const tracked: Tracked = {
        sessionId, folderId: folder.id, connectedAt: folder.connected_at, cwd: start.cwd, offset: 0,
        inode: statSync(file).ino, firstUuid: firstUuidOf(file), parentToolUseId: null, withheld: [],
      }
      sent.set(file, tracked)
      changed = true
      return tracked
    } catch (error) {
      // The API refused it for good: it started outside the folder, or its session
      // id is another folder's session, as the API sees it.
      if (error instanceof ApiError && (error.status === 400 || error.status === 409)) {
        passed.add(file)
        return undefined
      }
      // The API restarting or failing, or out of reach, is tried again on the next
      // read. fetch fails with a TypeError when it can't reach the API. Anything else
      // is a failure of this read, which counts toward parking the transcript.
      if (!(error instanceof ApiError) && !(error instanceof TypeError)) throw error
      console.error(`terminal session in ${start.cwd}:`, messageOf(error))
      return undefined
    }
  }

  // A tracked session's subagents, each linked to the Agent call that started it.
  // It returns the transcripts of all of them, found in the session's own folder,
  // so no other session's entry is looked at.
  function trackSubagents(file: string, main: Tracked): string[] {
    const dir = join(file.slice(0, -'.jsonl'.length), 'subagents')
    if (!existsSync(dir)) return []
    const paths: string[] = []
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
      const path = join(dir, name)
      if (!sent.has(path)) {
        const facts = join(dir, `${basename(name, '.jsonl')}.meta.json`)
        if (!existsSync(facts)) continue
        const parsed = SubagentFacts.safeParse(parseJson(readFileSync(facts, 'utf8')))
        if (!parsed.success) continue
        sent.set(path, { ...main, offset: 0, inode: statSync(path).ino, firstUuid: firstUuidOf(path), parentToolUseId: parsed.data.toolUseId, withheld: [] })
        changed = true
      }
      paths.push(path)
    }
    return paths
  }

  // One transcript, with its subagents, each of those in its own attempt.
  async function readTranscript(file: string, folder: FolderRow) {
    const tracked = sent.get(file) ?? await track(file)
    if (!tracked || tracked.folderId !== folder.id) return
    await send(file, tracked, folder)
    for (const path of trackSubagents(file, tracked)) {
      const sub = sent.get(path)
      if (sub && !parked.has(path)) await attempt(path, () => send(path, sub, folder))
    }
  }

  async function readAll() {
    scrubs = new Map()
    let projects: string[] = []
    await attempt(PROJECTS, async () => { projects = listed(PROJECTS) })
    for (const folder of folders) {
      for (const dir of projects.filter((name) => name.startsWith(projectName(folder.path)))) {
        const path = join(PROJECTS, dir)
        if (parked.has(path)) continue
        let names: string[] = []
        await attempt(path, async () => { names = listed(path).filter((n) => n.endsWith('.jsonl')) })
        for (const name of names) {
          const file = join(path, name)
          if (passed.has(file) || parked.has(file)) continue
          await attempt(file, () => readTranscript(file, folder))
        }
      }
    }
    if (changed) saveSent(stateFile, sent)
    changed = false
  }

  while (!signal.aborted) {
    await readAll()
    await sleep(READ_EVERY_MS, undefined, { signal }).catch((error: unknown) => {
      // Aborting the wait is how the daemon stops this loop.
      if (!signal.aborted) throw error
    })
  }
}

const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT'

// A path that can't be looked up as it stands: it isn't there, part of it isn't a
// folder or is one the daemon may not enter, or its links lead round in a circle.
const unresolvable = (error: unknown) =>
  error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(String(error.code))

// A path with its links followed. Claude names files it is about to create, so a
// part that doesn't exist keeps its spelling, after the nearest folder that does.
function resolved(path: string): string {
  try {
    return realpathSync.native(path)
  } catch (error) {
    if (!unresolvable(error)) throw error
    const parent = dirname(path)
    return parent === path ? path : join(resolved(parent), basename(path))
  }
}

// Whether a tool call names a path outside the connected folder, for a session
// that was in `cwd`. `~` is the home folder, a relative path starts at the cwd,
// and a link inside the folder that leads out leads out.
function leavesFolder(folder: string, cwd: string, paths: string[]): boolean {
  return paths.some((path) => {
    const named = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
    return !insideFolder(folder, resolved(resolve(cwd, named)))
  })
}

// A folder's entries, or none when it doesn't exist yet.
function listed(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
}

function loadSent(file: string): Sent {
  if (!existsSync(file)) return {}
  const parsed = Sent.safeParse(parseJson(readFileSync(file, 'utf8')))
  if (!parsed.success) console.error(`${file} is damaged, so every terminal session is read again: ${parsed.error.message}`)
  return parsed.success ? parsed.data : {}
}

function saveSent(file: string, sent: Map<string, Tracked>) {
  const next = `${file}.next`
  writeFileSync(next, JSON.stringify(Object.fromEntries(sent)), { mode: 0o600 })
  renameSync(next, file)
}
