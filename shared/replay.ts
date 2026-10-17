// How a replay moves through a session: which steps it has loaded, which one it
// is on, whether it is playing, and what it must ask the server for next. It is
// one pure function from a state and a move to the next state, so the page only
// runs the requests the state names and shows what the state holds. The steps
// come from server/history.ts in ranges of their numbers.

import type { Step, StepsPage } from './history.ts'

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

// How many step numbers a replay asks for before the step it opens on, and in
// each page after. A range holds at most STEPS_SPAN_MAX numbers, and these add up to fewer.
export const OPEN_BEFORE = 20
export const PAGE = 40
// A replay asks for the next page once fewer steps than this are loaded after the current one.
export const AHEAD = 10
// The most steps a replay keeps, those nearest the current one, so playing for an hour keeps a bounded page.
export const MAX_LOADED = 200

// The steps loaded: every step from `from` to `to`, with none missing. Notices
// that are not steps leave gaps in the numbers, so `from` and `to` are the
// range asked for and need not be steps themselves.
export type Loaded = { steps: Step[]; from: number; to: number }

// A page joined onto the steps loaded when they touch or overlap. A page that is
// somewhere else is of no use to steps that must stay one unbroken range.
export function joinLoaded(loaded: Loaded, page: Loaded): Loaded | null {
  if (page.from > loaded.to + 1 || page.to < loaded.from - 1) return null
  const bySeq = new Map([...loaded.steps, ...page.steps].map((step) => [step.seq, step]))
  return {
    steps: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
    from: Math.min(loaded.from, page.from),
    to: Math.max(loaded.to, page.to),
  }
}

// The `max` steps nearest `seq`, once more are loaded. The range ends where the
// kept steps end, so the page knows the steps beyond are not loaded.
export function trimLoaded(loaded: Loaded, seq: number, max: number): Loaded {
  if (loaded.steps.length <= max) return loaded
  const at = loaded.steps.findIndex((step) => step.seq >= seq)
  const middle = at < 0 ? loaded.steps.length - 1 : at
  const start = Math.max(0, Math.min(middle - Math.floor(max / 2), loaded.steps.length - max))
  const kept = loaded.steps.slice(start, start + max)
  const first = kept[0]
  const last = kept.at(-1)
  if (!first || !last) return loaded
  return { steps: kept, from: start === 0 ? loaded.from : first.seq, to: start + max >= loaded.steps.length ? loaded.to : last.seq }
}

// The step after `seq` among those loaded, or the one before it.
export const stepAfter = (loaded: Loaded, seq: number): Step | undefined => loaded.steps.find((step) => step.seq > seq)
export const stepBefore = (loaded: Loaded, seq: number): Step | undefined => loaded.steps.findLast((step) => step.seq < seq)

// The step nearest `seq`, the later one when two are as near.
export function nearestStep(steps: readonly Step[], seq: number): Step | undefined {
  let best: Step | undefined
  for (const step of steps) {
    const gap = Math.abs(step.seq - seq)
    const bestGap = best ? Math.abs(best.seq - seq) : Infinity
    if (gap < bestGap || (gap === bestGap && best && step.seq > best.seq)) best = step
  }
  return best
}

// The first step that went wrong after `seq`, or the last one before it.
export const errorAfter = (errors: readonly number[], seq: number): number | undefined => errors.find((error) => error > seq)
export const errorBefore = (errors: readonly number[], seq: number): number | undefined => errors.findLast((error) => error < seq)

// A range of step numbers to fetch. `open` replaces the steps loaded, around the step
// the replay is moving to. `after` and `before` add to it.
export type Request = { id: number; kind: 'open' | 'after' | 'before'; from: number; to: number; cursor: number | null }

export type Replay = {
  loaded: Loaded | null
  // The step the replay is on, by its number. Null until the first page arrives, and for a session with no steps.
  cursor: number | null
  playing: boolean
  speed: Speed
  // The range being fetched. One at a time, and a newer `open` replaces it.
  request: Request | null
  ids: number
  // A Next or Previous waiting for the page it needs.
  pending: 1 | -1 | null
  error: string
}

export const START: Replay = { loaded: null, cursor: null, playing: false, speed: 1, request: null, ids: 0, pending: null, error: '' }

// The first and last step the session has, which grow while it runs.
export type Bounds = { first: number | null; last: number | null }

export type Move =
  | { type: 'start'; bounds: Bounds; at: number | null }
  | { type: 'arrived'; id: number; page: StepsPage; bounds: Bounds }
  | { type: 'failed'; id: number; message: string }
  | { type: 'step'; direction: 1 | -1; bounds: Bounds }
  | { type: 'seek'; to: number; bounds: Bounds }
  | { type: 'play'; bounds: Bounds }
  | { type: 'pause' }
  | { type: 'tick'; bounds: Bounds }
  | { type: 'speed'; speed: Speed }
  | { type: 'earlier'; bounds: Bounds }
  | { type: 'later'; bounds: Bounds }

function ask(state: Replay, kind: Request['kind'], from: number, to: number, cursor: number | null): Replay {
  const id = state.ids + 1
  return { ...state, ids: id, request: { id, kind, from, to, cursor }, error: '' }
}

// Opens steps around the one a replay is moving to, in place of those it has. A number past either end of the session is its nearest end.
function around(state: Replay, seq: number, bounds: Bounds): Replay {
  const target = Math.min(Math.max(seq, bounds.first ?? seq), bounds.last ?? seq)
  const from = Math.max(bounds.first ?? 1, target - OPEN_BEFORE)
  return ask(state, 'open', from, from + OPEN_BEFORE + PAGE - 1, target)
}

// Asks for the page after the steps loaded or before them, when there is one and none is under way.
function more(state: Replay, direction: 1 | -1, bounds: Bounds): Replay {
  const { loaded } = state
  if (state.request || !loaded) return state
  if (direction === 1) {
    return bounds.last !== null && loaded.to < bounds.last ? ask(state, 'after', loaded.to + 1, loaded.to + PAGE, null) : state
  }
  return bounds.first !== null && loaded.from > bounds.first ? ask(state, 'before', Math.max(bounds.first, loaded.from - PAGE), loaded.from - 1, null) : state
}

// Asks for the next page while the steps loaded after the current one run low.
function ensureAhead(state: Replay, bounds: Bounds): Replay {
  const { loaded, cursor } = state
  if (state.request || !loaded || cursor === null) return state
  return loaded.steps.filter((step) => step.seq > cursor).length < AHEAD ? more(state, 1, bounds) : state
}

// What follows any change: a Next or Previous that was waiting for a page takes
// its step once it is loaded, and the page after is asked for in good time.
function settle(state: Replay, bounds: Bounds): Replay {
  const { loaded, cursor, pending } = state
  if (pending === null || !loaded || cursor === null) return ensureAhead(state, bounds)
  const step = pending === 1 ? stepAfter(loaded, cursor) : stepBefore(loaded, cursor)
  if (step) return ensureAhead({ ...state, cursor: step.seq, pending: null }, bounds)
  // The page held no step that way, so ask again, unless there is nothing left.
  const asked = more(state, pending, bounds)
  return asked === state && !state.request ? { ...state, pending: null } : asked
}

export function reduce(state: Replay, move: Move): Replay {
  switch (move.type) {
    case 'start': {
      const target = move.at ?? move.bounds.first
      // A session with no steps has nothing to load.
      return target === null ? { ...state, loaded: { steps: [], from: 1, to: 0 } } : around(state, target, move.bounds)
    }
    case 'arrived': {
      const { request } = state
      if (request?.id !== move.id) return state
      const cleared = { ...state, request: null }
      const page: Loaded = { steps: move.page.steps, from: move.page.from, to: move.page.to }
      if (request.kind === 'open') {
        const step = request.cursor === null ? page.steps[0] : nearestStep(page.steps, request.cursor)
        return settle({ ...cleared, loaded: page, cursor: step?.seq ?? null }, move.bounds)
      }
      const joined = state.loaded ? joinLoaded(state.loaded, page) : null
      if (!joined) return cleared
      return settle({ ...cleared, loaded: state.cursor === null ? joined : trimLoaded(joined, state.cursor, MAX_LOADED) }, move.bounds)
    }
    case 'failed':
      return state.request?.id === move.id ? { ...state, request: null, pending: null, playing: false, error: move.message } : state
    case 'step': {
      const { loaded, cursor } = state
      if (!loaded || cursor === null) return state
      const step = move.direction === 1 ? stepAfter(loaded, cursor) : stepBefore(loaded, cursor)
      if (step) return ensureAhead({ ...state, cursor: step.seq, pending: null }, move.bounds)
      const asked = more(state, move.direction, move.bounds)
      // With nothing more that way, and nothing on its way, there is no step to move to.
      return asked === state && !state.request ? state : { ...asked, pending: move.direction }
    }
    case 'seek': {
      const { loaded } = state
      const step = loaded && move.to >= loaded.from && move.to <= loaded.to ? nearestStep(loaded.steps, move.to) : undefined
      if (step) return ensureAhead({ ...state, cursor: step.seq, pending: null }, move.bounds)
      return around({ ...state, pending: null }, move.to, move.bounds)
    }
    case 'play': {
      const { loaded, cursor } = state
      const atEnd = loaded !== null && cursor !== null && !stepAfter(loaded, cursor) && (move.bounds.last === null || loaded.to >= move.bounds.last)
      // Playing from the last step starts the session over.
      if (atEnd) return around({ ...state, playing: true, pending: null }, move.bounds.first ?? 1, move.bounds)
      return ensureAhead({ ...state, playing: true }, move.bounds)
    }
    case 'pause':
      return { ...state, playing: false }
    case 'tick': {
      const { loaded, cursor } = state
      if (!state.playing || !loaded || cursor === null) return state
      const step = stepAfter(loaded, cursor)
      if (step) return ensureAhead({ ...state, cursor: step.seq }, move.bounds)
      // The next page is on its way, and the replay carries on when it comes.
      if (loaded.to < (move.bounds.last ?? 0)) return ensureAhead(state, move.bounds)
      return { ...state, playing: false }
    }
    case 'speed':
      return { ...state, speed: move.speed }
    // Reading on past the loaded steps moves the replay to the edge it reads from, so the
    // steps kept stay the ones nearest the reader, and loads the page beyond.
    case 'earlier': {
      const first = state.loaded?.steps[0]
      return first && !state.request ? more({ ...state, cursor: first.seq, pending: null }, -1, move.bounds) : state
    }
    case 'later': {
      const last = state.loaded?.steps.at(-1)
      return last && !state.request ? ensureAhead({ ...state, cursor: last.seq, pending: null }, move.bounds) : state
    }
  }
}
