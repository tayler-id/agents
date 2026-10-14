// Terminal sessions: the Claude Code sessions a person starts in their own
// terminal, in a folder they connected on this Mac. Claude Code writes each
// session's transcript under ~/.claude/projects, in a folder named after the
// path the session started in. This reads the transcripts of the sessions that
// started inside a connected folder after it was connected, and posts them to
// the record. A transcript of any other session is read only as far as the line
// that says where it started, and nothing of it leaves the Mac. The design is
// docs/design/local-sessions.md.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Shape, ShapeStream, type Row } from '@electric-sql/client'
import { z } from 'zod'
import { messageOf } from '../shared/errors.ts'
import { FolderId, SessionId } from '../shared/ids.ts'
import { makeScrub, type Scrub } from '../shared/scrub.ts'
import { FolderRow, insideFolder, TerminalSessionAnswer } from '../shared/terminal.ts'
import { ApiError, postEvents, type Api, type Config } from './api.ts'
import { TranscriptLine, transcriptBatch, withoutFiles } from './claude.ts'
import { dotenvFinder, dotenvSecrets, type Secrets } from './secrets.ts'

// Where Claude Code keeps transcripts. CLAUDE_CONFIG_DIR moves its whole config folder.
const PROJECTS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
// How often the transcripts are read. A line reaches the record about this long
// after Claude Code writes it, and each read lists one folder per connected folder.
const READ_EVERY_MS = 1000
// At most this much of a transcript goes in one post, so a long one read at once
// after a restart goes in parts well under the API's 20 MB limit.
const LINES_PER_POST = 200
const BYTES_PER_POST = 4 * 1024 * 1024
// How far into a transcript its start is looked for. Claude Code writes it within
// the first few lines, and a transcript that has none this far in is passed over.
const START_BYTES = 1024 * 1024

// Claude Code names a session's folder after the path it started in, with every
// character other than a letter or a digit made a dash. Only the folders whose
// names start like a connected folder's are listed. The path each transcript
// gives decides, since a name cannot tell /a/repo-old from a folder inside /a/repo.
const projectName = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-')

// How far each transcript has been sent, so a restart goes on from there. Losing
// this file costs only a reread, since the record skips lines it already has.
const Sent = z.record(z.string(), z.object({
  sessionId: SessionId, folderId: FolderId, cwd: z.string(), offset: z.number().int().min(0), parentToolUseId: z.string().nullable(),
}))
type Sent = z.infer<typeof Sent>
type Tracked = Sent[string]

// A subagent's transcript sits beside a file of facts that names the Agent call that started it.
const SubagentFacts = z.looseObject({ toolUseId: z.string() })

// The first line of a transcript that says where and when its session started.
const Start = z.looseObject({ cwd: z.string(), timestamp: z.string(), sessionId: z.string() })
type Start = z.infer<typeof Start>

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    // Not JSON, so not a line Claude Code finished writing. It makes nothing.
    return undefined
  }
}

// The complete lines from an offset up to a limit, each with the offset just after it.
function linesFrom(file: string, offset: number, limit = Infinity): { text: string; end: number }[] {
  const size = Math.min(statSync(file).size, offset + limit)
  if (size <= offset) return []
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(size - offset)
    readSync(fd, buffer, 0, buffer.length, offset)
    const lines: { text: string; end: number }[] = []
    let from = 0
    for (let at = buffer.indexOf(0x0a); at >= 0; at = buffer.indexOf(0x0a, from)) {
      lines.push({ text: buffer.subarray(from, at).toString('utf8'), end: offset + at + 1 })
      from = at + 1
    }
    return lines
  } finally {
    closeSync(fd)
  }
}

// A transcript's lines in posts of at most LINES_PER_POST lines and about BYTES_PER_POST bytes.
function inParts<T extends { text: string }>(lines: T[]): T[][] {
  const parts: T[][] = []
  let part: T[] = []
  let bytes = 0
  for (const line of lines) {
    if (part.length && (part.length >= LINES_PER_POST || bytes + line.text.length > BYTES_PER_POST)) {
      parts.push(part)
      part = []
      bytes = 0
    }
    part.push(line)
    bytes += line.text.length
  }
  if (part.length) parts.push(part)
  return parts
}

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
    folders = rows.map((row) => FolderRow.parse(row)).sort((a, b) => b.path.length - a.path.length)
    // A disconnected folder's sessions stop at once, and one connected again starts over.
    const connected = new Set<string>(folders.map((f) => f.id))
    for (const [file, tracked] of sent) {
      if (!connected.has(tracked.folderId)) {
        sent.delete(file)
        changed = true
      }
    }
  })

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

  // Sends what a transcript gained since last time.
  async function send(file: string, tracked: Tracked, folder: FolderRow) {
    const lines = linesFrom(file, tracked.offset)
    if (!lines.length) return
    const scrub = scrubFor(folder)
    for (const part of inParts(lines)) {
      const parsed = part.flatMap((line) => {
        const result = TranscriptLine.safeParse(withoutFiles(parseJson(line.text)))
        return result.success ? [result.data] : []
      })
      const batch = transcriptBatch(parsed, tracked.parentToolUseId)
      if (batch.events.length || batch.status) await postEvents(api, tracked.sessionId, scrub(batch))
      const last = part[part.length - 1]
      if (last) tracked.offset = last.end
      changed = true
    }
  }

  // Where and when a transcript's session started, once Claude Code has written that line.
  function startOf(file: string): Start | undefined {
    for (const line of linesFrom(file, 0, START_BYTES)) {
      const start = Start.safeParse(parseJson(line.text))
      if (start.success) return start.data
    }
    if (statSync(file).size > START_BYTES) passed.add(file)
    return undefined
  }

  // Takes a session that started in a connected folder after it was connected,
  // and passes over any other for good.
  async function track(file: string): Promise<Tracked | undefined> {
    const start = startOf(file)
    if (!start) return undefined
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
      const tracked: Tracked = { sessionId, folderId: folder.id, cwd: start.cwd, offset: 0, parentToolUseId: null }
      sent.set(file, tracked)
      changed = true
      return tracked
    } catch (error) {
      // The API refused it for good: it started outside the folder, as the API sees it.
      if (error instanceof ApiError && error.status === 400) passed.add(file)
      // Anything else, such as the API restarting, is tried again on the next read.
      else console.error(`terminal session in ${start.cwd}:`, messageOf(error))
      return undefined
    }
  }

  // A tracked session's subagents, each linked to the Agent call that started it.
  function trackSubagents(file: string, main: Tracked) {
    const dir = join(file.slice(0, -'.jsonl'.length), 'subagents')
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
      const path = join(dir, name)
      const facts = join(dir, `${basename(name, '.jsonl')}.meta.json`)
      if (sent.has(path) || !existsSync(facts)) continue
      const parsed = SubagentFacts.safeParse(parseJson(readFileSync(facts, 'utf8')))
      if (!parsed.success) continue
      sent.set(path, { ...main, offset: 0, parentToolUseId: parsed.data.toolUseId })
      changed = true
    }
  }

  async function readAll() {
    scrubs = new Map()
    const projects = existsSync(PROJECTS) ? readdirSync(PROJECTS) : []
    for (const folder of folders) {
      for (const dir of projects.filter((name) => name.startsWith(projectName(folder.path)))) {
        for (const name of readdirSync(join(PROJECTS, dir)).filter((n) => n.endsWith('.jsonl'))) {
          const file = join(PROJECTS, dir, name)
          if (passed.has(file)) continue
          const tracked = sent.get(file) ?? await track(file)
          if (!tracked || tracked.folderId !== folder.id) continue
          await send(file, tracked, folder)
          trackSubagents(file, tracked)
          const subagents = `${file.slice(0, -'.jsonl'.length)}${sep}`
          for (const [path, sub] of sent) if (path.startsWith(subagents)) await send(path, sub, folder)
        }
      }
    }
    if (changed) saveSent(stateFile, sent)
    changed = false
  }

  while (!signal.aborted) {
    // A transcript Claude Code removes while it is read, as its cleanup does with
    // old ones, fails one read. The next read lists what is there then.
    await readAll().catch((error: unknown) => { console.error('terminal sessions:', messageOf(error)) })
    await sleep(READ_EVERY_MS, undefined, { signal }).catch((error: unknown) => {
      // Aborting the wait is how the daemon stops this loop.
      if (!signal.aborted) throw error
    })
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
