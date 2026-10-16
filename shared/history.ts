// History: every session a person may see, a search across the text of their
// steps, and a replay of one session. These shapes are defined once for the
// server and the app. The queries are in server/history.ts, the page in
// app/src/History.tsx and app/src/Replay.tsx.

import { z } from 'zod'
import { AgentId, ConversationId, FolderId, PersonId, RepoId, RunId, SessionId, TaskId } from './ids.ts'
import { ProjectId } from './projects.ts'
import { EVENT_KINDS, SESSION_STATUSES, type EventKind } from './types.ts'

// A time as Postgres writes it, such as 2026-10-12 00:05:12.123+00, which is how
// the shapes send times too. The app's parseTime reads it.
const Time = z.string()

// What a session was started for. A run is a task a pipeline started.
export const HISTORY_KINDS = ['conversation', 'task', 'run', 'terminal'] as const
export const HistoryKind = z.enum(HISTORY_KINDS)
export type HistoryKind = z.infer<typeof HistoryKind>

// The filters of a list and of a search. The day is a pair of instants, since
// only the browser knows where the person's day begins.
export const SessionFilters = z.object({
  agent: AgentId.optional(),
  person: PersonId.optional(),
  kind: HistoryKind.optional(),
  project: ProjectId.optional(),
  repo: RepoId.optional(),
  since: z.iso.datetime().optional(),
  until: z.iso.datetime().optional(),
})
export type SessionFilters = z.infer<typeof SessionFilters>

// Where the next page of a list begins, as the server wrote it: a time as
// Postgres prints it, then the id of the last row shown.
export const Cursor = z.string().regex(/^[0-9TZ :.+-]{19,40}\|[0-9a-f-]{1,36}$/, 'a cursor is the one the server sent')
export type Cursor = z.infer<typeof Cursor>

export const PAGE_DEFAULT = 30
export const PAGE_MAX = 100
const Limit = z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT)

export const HistoryQuery = SessionFilters.extend({ before: Cursor.optional(), limit: Limit })
export type HistoryQuery = z.infer<typeof HistoryQuery>

// The longest search a person may run, enough for a pasted error line.
export const QUERY_MAX = 300
export const SearchQuery = SessionFilters.extend({ q: z.string().trim().min(1).max(QUERY_MAX), before: Cursor.optional(), limit: Limit })
export type SearchQuery = z.infer<typeof SearchQuery>

// What a session was for. The kind decides what the rest says.
export const Subject = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('conversation'), id: ConversationId, conversation: z.enum(['main', 'dm', 'room', 'pr', 'slack_thread']),
    name: z.string().nullable(), people: z.array(z.string()),
  }),
  z.object({ kind: z.literal('task'), id: TaskId, title: z.string() }),
  z.object({ kind: z.literal('run'), id: RunId, task_id: TaskId, title: z.string(), pipeline: z.string(), replay: z.boolean() }),
  z.object({ kind: z.literal('terminal'), id: FolderId, path: z.string(), cwd: z.string() }),
])
export type Subject = z.infer<typeof Subject>

// A session as the list shows it, and as a replay's header does.
export const HistorySession = z.object({
  id: SessionId,
  subject: Subject,
  status: z.enum(SESSION_STATUSES),
  // An agent's session has an agent. A terminal session has none, and its person is the one whose terminal it was.
  agent: z.object({ id: AgentId, name: z.string() }).nullable(),
  person: z.object({ id: PersonId, login: z.string(), name: z.string().nullable() }).nullable(),
  machine: z.string(),
  // The pipeline stage a run's session was, and what it reported.
  stage: z.string().nullable(),
  stage_outcome: z.string().nullable(),
  project: z.object({ id: ProjectId, name: z.string() }).nullable(),
  // Clone URLs of the repos a task works in.
  repos: z.array(z.string()),
  // Shown only to people who may see the session, so it names why a teammate does not.
  private: z.boolean(),
  // What the person first said, in a terminal session or a direct message.
  asked: z.string().nullable(),
  // The number of the session's last step, how many turns it took, and how many steps went wrong.
  steps: z.number().int(),
  turns: z.number().int(),
  errors: z.number().int(),
  started_at: Time,
  last_active_at: Time.nullable(),
})
export type HistorySession = z.infer<typeof HistorySession>

export const HistoryPage = z.object({ sessions: z.array(HistorySession), next: Cursor.nullable() })
export type HistoryPage = z.infer<typeof HistoryPage>

// Marks around the words a search matched, in a snippet. Control characters
// cannot occur in the words themselves, and a page splits on them, so the
// snippet is never read as markup.
export const MARK_START = '\u0001'
export const MARK_END = '\u0002'

export type SnippetPart = { text: string; hit: boolean }
export function snippetParts(snippet: string): SnippetPart[] {
  const [before = '', ...marked] = snippet.split(MARK_START)
  const parts: SnippetPart[] = [{ text: before, hit: false }]
  for (const piece of marked) {
    const end = piece.indexOf(MARK_END)
    parts.push({ text: end < 0 ? piece : piece.slice(0, end), hit: true }, { text: end < 0 ? '' : piece.slice(end + 1), hit: false })
  }
  return parts.filter((part) => part.text !== '')
}

// One step that matched a search, and the session it is in.
export const SearchHit = z.object({
  session: HistorySession,
  seq: z.number().int(),
  kind: z.enum(EVENT_KINDS),
  tool_name: z.string().nullable(),
  snippet: z.string(),
  created_at: Time,
})
export type SearchHit = z.infer<typeof SearchHit>
export const SearchPage = z.object({ hits: z.array(SearchHit), next: Cursor.nullable() })
export type SearchPage = z.infer<typeof SearchPage>

// A session's replay opens on this: the session, its first and last step, and the steps that went wrong.
export const ERRORS_MAX = 1000
export const SessionView = z.object({
  session: HistorySession,
  first_seq: z.number().int().nullable(),
  last_seq: z.number().int().nullable(),
  errors: z.array(z.number().int()),
  errors_total: z.number().int(),
})
export type SessionView = z.infer<typeof SessionView>

// Every kind of step has the same words in the Session panel and in a replay.
export const STEP_LABELS: Record<EventKind, string> = {
  user: 'Message', assistant: 'Reply', thinking: 'Thinking', tool_call: 'Tool', tool_result: 'Result',
  ask: 'Asked', answer: 'Answer', notice: 'Notice', error: 'Error', usage: 'Turn ended',
}

// Claude's notices are bookkeeping. Only these tell a person something, so only
// these are steps, in the Session panel and in a replay.
export const SHOWN_NOTICES = ['init', 'interrupted', 'screen'] as const
export const isShownStep = (kind: string, subtype: unknown): boolean => kind !== 'notice' || SHOWN_NOTICES.some((shown) => shown === subtype)

// One part of a step's content: a labelled field of a tool's input, a block of
// a result, or the whole text of a message.
export const StepBlock = z.object({ label: z.string().nullable(), text: z.string() })
export type StepBlock = z.infer<typeof StepBlock>

export const Step = z.object({
  seq: z.number().int(),
  kind: z.enum(EVENT_KINDS),
  tool_name: z.string().nullable(),
  // Work a subagent did, under the call that started it.
  sub: z.boolean(),
  // An error event, or a tool result that reports an error.
  error: z.boolean(),
  created_at: Time,
  blocks: z.array(StepBlock),
})
export type Step = z.infer<typeof Step>

// The steps of one session from `from` to `to`, in order. Notices that are not
// steps leave gaps in the numbers. `to` is where the range ends even when its
// last numbers hold no step, so the page knows where to ask next.
export const STEPS_SPAN_MAX = 100
export const StepsPage = z.object({ steps: z.array(Step), from: z.number().int(), to: z.number().int() })
export type StepsPage = z.infer<typeof StepsPage>

export const StepsQuery = z.object({
  from: z.coerce.number().int().min(1),
  to: z.coerce.number().int().min(1),
}).refine((range) => range.to >= range.from && range.to - range.from < STEPS_SPAN_MAX, `a range holds at most ${String(STEPS_SPAN_MAX)} numbers`)

// The steps a replay has loaded. They are the shown steps from `from` to `to`
// with none missing, so the page knows whether a neighbour is loaded or must be asked for.
export type Window = { steps: Step[]; from: number; to: number }

// Joins a page onto the window when it touches or overlaps it. A page that is
// somewhere else replaces the window, since a window stays one unbroken range.
export function mergeWindow(window: Window | null, page: Window): Window {
  if (!window || page.from > window.to + 1 || page.to < window.from - 1) return page
  const bySeq = new Map([...window.steps, ...page.steps].map((step) => [step.seq, step]))
  return {
    steps: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
    from: Math.min(window.from, page.from),
    to: Math.max(window.to, page.to),
  }
}

// Keeps the `max` steps nearest `seq` once a window grows past `max`, so a replay
// that runs for an hour keeps a bounded page.
export function trimWindow(window: Window, seq: number, max: number): Window {
  if (window.steps.length <= max) return window
  const at = window.steps.findIndex((step) => step.seq >= seq)
  const middle = at < 0 ? window.steps.length - 1 : at
  const start = Math.max(0, Math.min(middle - Math.floor(max / 2), window.steps.length - max))
  const kept = window.steps.slice(start, start + max)
  const first = kept[0]
  const last = kept.at(-1)
  if (!first || !last) return window
  return { steps: kept, from: start === 0 ? window.from : first.seq, to: start + max >= window.steps.length ? window.to : last.seq }
}

// The step after `seq` in a window, or the one before it.
export const stepAfter = (window: Window, seq: number): Step | undefined => window.steps.find((step) => step.seq > seq)
export const stepBefore = (window: Window, seq: number): Step | undefined => window.steps.findLast((step) => step.seq < seq)

// The first step that went wrong after `seq`, or the last one before it.
export const errorAfter = (errors: readonly number[], seq: number): number | undefined => errors.find((error) => error > seq)
export const errorBefore = (errors: readonly number[], seq: number): number | undefined => errors.findLast((error) => error < seq)

export const SPEEDS = [1, 2, 4, 8] as const
export type Speed = (typeof SPEEDS)[number]
// A step stays on screen as long as the real time before the next one, held
// between these. Steps that came in a burst stay long enough to read, and an
// hour of waiting does not stall the replay.
export const PLAY_MIN_MS = 400
export const PLAY_MAX_MS = 2500
export function playbackDelay(gapMs: number, speed: Speed): number {
  const gap = Number.isFinite(gapMs) ? gapMs : PLAY_MIN_MS
  return Math.round(Math.min(PLAY_MAX_MS, Math.max(PLAY_MIN_MS, gap)) / speed)
}
