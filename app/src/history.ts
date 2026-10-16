// What the History page and the replay share: the calls they make, where they
// are in the address, and the words a session is described with.

import { HistoryKind, HistoryPage, SearchPage, SearchScope, SessionView, StepsPage, type HistorySession, type SessionFilters } from '../../shared/history.ts'
import { placeOf as placeInFolder } from '../../shared/terminal.ts'
import { call, clock, day, parseTime, type Me } from './data.ts'

// The filters of the page, as the address holds them. An empty string is no filter,
// and no scope reads every step.
export type Filters = { q: string; scope: '' | SearchScope; agent: string; person: string; kind: '' | HistoryKind; project: string; repo: string; day: string }
export const NO_FILTERS: Filters = { q: '', scope: '', agent: '', person: '', kind: '', project: '', repo: '', day: '' }

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

// The two instants a day lies between on the clock of the person who picked it.
function dayRange(picked: string): Pick<SessionFilters, 'since' | 'until'> {
  const [, year, month, date] = DAY.exec(picked) ?? []
  if (year === undefined || month === undefined || date === undefined) return {}
  const start = new Date(Number(year), Number(month) - 1, Number(date))
  const end = new Date(Number(year), Number(month) - 1, Number(date) + 1)
  return { since: start.toISOString(), until: end.toISOString() }
}

// The query string of a list or a search. A search needs words, and a list takes none.
function queryOf(filters: Filters, before: string | null, search: boolean): string {
  const params = new URLSearchParams()
  if (search) params.set('q', filters.q)
  if (search && filters.scope) params.set('scope', filters.scope)
  for (const key of ['agent', 'person', 'kind', 'project', 'repo'] as const) {
    if (filters[key]) params.set(key, filters[key])
  }
  for (const [key, value] of Object.entries(dayRange(filters.day))) params.set(key, value)
  if (before) params.set('before', before)
  return params.toString()
}

export const historyApi = {
  sessions: (filters: Filters, before: string | null) => call(HistoryPage, 'GET', `/v1/history?${queryOf(filters, before, false)}`),
  search: (filters: Filters, before: string | null) => call(SearchPage, 'GET', `/v1/search?${queryOf(filters, before, true)}`),
  session: (sessionId: string) => call(SessionView, 'GET', `/v1/history/sessions/${sessionId}`),
  steps: (sessionId: string, from: number, to: number) => call(StepsPage, 'GET', `/v1/history/sessions/${sessionId}/steps?from=${from}&to=${to}`),
}

// Where the History page is, in the address: the list with its filters, or one session's replay at a step.
export type Place = { view: 'list'; filters: Filters } | { view: 'replay'; sessionId: string; seq: number | null }

const SESSION = /^[0-9a-f-]{36}$/

export function placeOf(hash: string): Place {
  const [path = '', query = ''] = hash.split('?')
  const [, , id = '', seq = ''] = path.split('/')
  if (SESSION.test(id)) return { view: 'replay', sessionId: id, seq: /^\d+$/.test(seq) ? Number(seq) : null }
  const params = new URLSearchParams(query)
  const picked = params.get('day') ?? ''
  return {
    view: 'list',
    filters: {
      q: params.get('q') ?? '', scope: SearchScope.safeParse(params.get('scope')).data ?? '', agent: params.get('agent') ?? '', person: params.get('person') ?? '',
      kind: HistoryKind.safeParse(params.get('kind')).data ?? '',
      project: params.get('project') ?? '', repo: params.get('repo') ?? '', day: DAY.test(picked) ? picked : '',
    },
  }
}

export function listHash(filters: Filters): string {
  const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== ''))
  return params.size ? `#/history?${params.toString()}` : '#/history'
}

export const replayHash = (sessionId: string, seq?: number): string => `#/history/${sessionId}${seq === undefined ? '' : `/${String(seq)}`}`

// Moves the address without adding to the browser's history, and tells the app it moved.
export function replaceHash(hash: string) {
  window.history.replaceState(null, '', hash)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

// The words a session's status is described with.
export const STATUS_WORDS: Record<HistorySession['status'], string> = {
  draft: 'Not started', starting: 'Starting', running: 'Working', idle: 'Finished', needs_input: 'Waiting for an answer',
  needs_approval: 'Waiting for approval', limited: 'Stopped at a limit', lost: 'Interrupted', failed: 'Failed',
}

export const KIND_WORDS: Record<HistoryKind, string> = { conversation: 'Conversation', task: 'Task', run: 'Run', terminal: 'Terminal' }

export const SCOPE_WORDS: Record<SearchScope, string> = {
  all: 'Everything', messages: 'Messages', tools: 'Tool calls and results', errors: 'Steps that went wrong',
}

// How many days back the day filter offers.
const DAYS_OFFERED = 14

// A day as the date input writes it, on the person's own clock.
export const dayValue = (date: Date): string =>
  `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

export const dayWords = (value: string, now: Date): string => {
  const [year, month, date] = value.split('-').map(Number)
  if (year === undefined || month === undefined || date === undefined) return value
  const picked = new Date(year, month - 1, date)
  const ago = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - picked.getTime()) / 86_400_000)
  if (ago === 0) return 'Today'
  if (ago === 1) return 'Yesterday'
  return picked.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

// The days a person can pick, the latest first.
export function dayChoices(now: Date): { value: string; label: string }[] {
  return Array.from({ length: DAYS_OFFERED }, (_, ago) => {
    const value = dayValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() - ago))
    return { value, label: dayWords(value, now) }
  })
}

// What a session was for, in a line.
export function titleOf(session: HistorySession): string {
  const { subject } = session
  switch (subject.kind) {
    case 'conversation':
      if (subject.conversation === 'room') return `# ${subject.name ?? 'room'}`
      if (subject.conversation === 'agents') return subject.agents.join(' and ') || 'Two agents'
      if (subject.name !== null) return subject.name
      return subject.conversation === 'dm' ? `Direct message with ${subject.people.join(', ') || 'someone'}` : 'Main conversation'
    case 'task': return subject.title
    case 'run': return subject.replay ? `Replay of a ${subject.pipeline} run: ${subject.title}` : `${subject.pipeline} run: ${subject.title}`
    case 'terminal': return placeInFolder(subject.path, subject.cwd)
  }
}

const nameOf = (person: { login: string; name: string | null }) => person.name ?? person.login.split('@')[0] ?? person.login

// Who did the work: an agent, for the person who started it when one did, or a person at their own terminal.
export function actorOf(session: HistorySession, me: Me): string {
  if (session.agent) return session.person ? `${session.agent.name} for ${nameOf(session.person)}` : session.agent.name
  if (!session.person) return "Someone's terminal"
  return session.person.id === me.person.id ? 'Your terminal' : `${nameOf(session.person)}'s terminal`
}

const plural = (count: number, word: string) => `${String(count)} ${word}${count === 1 ? '' : 's'}`

// How long a session ran, from its first step to its last.
export function spanWords(started: string, ended: string | null): string {
  const from = parseTime(started)
  const to = parseTime(ended)
  if (!from || !to) return ''
  const minutes = Math.round((to.getTime() - from.getTime()) / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${String(minutes)} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${String(hours)} h ${String(minutes % 60)} min`
  return plural(Math.floor(hours / 24), 'day')
}

// How it ended, or where it is: its status, what a pipeline stage reported, and how many steps went wrong.
export function outcomeWords(session: HistorySession): string {
  return [
    STATUS_WORDS[session.status],
    session.stage_outcome === null ? null : `${session.stage ?? 'stage'} ${session.stage_outcome}`,
    session.errors ? plural(session.errors, 'error') : null,
  ].filter((part) => part !== null).join(' · ')
}

export const stepsWords = (count: number): string => plural(count, 'step')

// When a session was last active, or started if it never was.
export function whenWords(session: HistorySession): string {
  const at = session.last_active_at ?? session.started_at
  return `${day(at)}, ${clock(at)}`
}
