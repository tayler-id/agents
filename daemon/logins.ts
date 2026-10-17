// The browser logins every seat on a computer shares. Each seat's browser keeps
// a profile of its own, and every SYNC_MS the daemon reads each running
// browser's cookies over its DevTools port and copies what one browser changed
// into the others, a login or a logout alike, as the agent app we studied does
// between its displays' browsers. A browser that has just started takes the
// shared cookies whole, so one that missed a logout while it was stopped can't
// bring the login back. Seat 1's browser runs whenever the computer does, and
// its profile, the one a box had before seats, keeps the logins across a
// restart, so the shared cookies start from it. A login a site keeps only in a
// page's storage, such as localStorage or IndexedDB, stays in its own seat.

import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { messageOf } from '../shared/errors.ts'
import { FIRST_SEAT, type SeatNumber } from '../shared/seats.ts'
import { browserDevtools, type Devtools } from './devtools.ts'

// How often the browsers' cookies are compared, so a login made in one seat
// works in the others this soon after. The agent app we studied copies as often.
const SYNC_MS = 1_500
// How long one browser may take to give or take its cookies.
const COOKIE_WAIT_MS = 5_000
// A cookie set to expire in the past deletes the cookie with its name, domain and path.
const EXPIRED = 1

// A cookie as Chromium's DevTools give it, with the fields that set it again.
const Cookie = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  // Seconds since 1970, or -1 for a session cookie.
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  session: z.boolean(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
  priority: z.enum(['Low', 'Medium', 'High']),
  sourceScheme: z.enum(['Unset', 'NonSecure', 'Secure']),
  sourcePort: z.int(),
  partitionKey: z.object({ topLevelSite: z.string(), hasCrossSiteAncestor: z.boolean() }).optional(),
})
type Cookie = z.infer<typeof Cookie>
const Cookies = z.object({ cookies: z.array(Cookie) })

// A browser keys a cookie by its name, domain, path and partition.
const keyOf = (cookie: Cookie) => JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey ?? null])

// The cookie as the browser takes it. A session cookie has no expiry.
function param(cookie: Cookie): Record<string, unknown> {
  const { session, expires, ...fields } = cookie
  return session ? fields : { ...fields, expires }
}
const said = (cookie: Cookie) => JSON.stringify(param(cookie))
const sayTheSame = (a: Cookie | undefined, b: Cookie) => a !== undefined && said(a) === said(b)
const deletion = (cookie: Cookie) => ({ ...param(cookie), value: '', expires: EXPIRED })

// A running seat's browser, and how many times it has started.
export type SeatBrowser = { n: SeatNumber; cdpUrl: string; starts: number }
export type SharedLogins = {
  // Resolves once a seat's browser, as of its `starts`-th start, holds the shared logins.
  taken(n: SeatNumber, starts: number): Promise<void>
  stop(): Promise<void>
}

async function readCookies(browser: Devtools): Promise<Map<string, Cookie>> {
  const { cookies } = Cookies.parse(await browser.send('Storage.getCookies', {}))
  return new Map(cookies.map((cookie) => [keyOf(cookie), cookie]))
}

type Read = { seat: SeatBrowser; browser: Devtools; cookies: Map<string, Cookie> }

// `browsers` lists the seats whose browsers are up, and is read again each round.
export function shareLogins(browsers: () => SeatBrowser[]): SharedLogins {
  // The cookies every seat shares. None until seat 1's browser is first read.
  let shared: Map<string, Cookie> | null = null
  // What each browser held when the last round left it, and which of its
  // starts that was. A browser started since takes the shared cookies whole.
  const held = new Map<SeatNumber, { starts: number; cookies: Map<string, Cookie> }>()
  // Cookies a browser would not take, by everything they say, so each is tried
  // and logged once instead of every round.
  const refused = new Set<string>()
  const waiting: { n: SeatNumber; starts: number; resolve: () => void; reject: (error: Error) => void }[] = []
  const stopping = new AbortController()

  // Gives one browser what it lacks of the shared cookies and takes away what
  // they no longer hold. Answers with what the browser holds afterwards.
  async function give({ seat, browser, cookies }: Read, all: Map<string, Cookie>): Promise<Map<string, Cookie>> {
    const after = new Map(cookies)
    const gone = [...cookies].filter(([key]) => !all.has(key))
    const fresh = [...all].filter(([key, cookie]) => !sayTheSame(cookies.get(key), cookie) && !refused.has(said(cookie)))
    if (!gone.length && !fresh.length) return after
    const batch = [...gone.map(([, cookie]) => deletion(cookie)), ...fresh.map(([, cookie]) => param(cookie))]
    // The browser refuses a whole batch for one cookie it can't take, so then
    // each one goes on its own.
    const whole = await browser.send('Storage.setCookies', { cookies: batch }).then(() => true, () => false)
    for (const [key, cookie] of gone) {
      if (!whole) await browser.send('Storage.setCookies', { cookies: [deletion(cookie)] })
      after.delete(key)
    }
    for (const [key, cookie] of fresh) {
      const took = whole || await browser.send('Storage.setCookies', { cookies: [param(cookie)] }).then(() => true, (error: unknown) => {
        refused.add(said(cookie))
        console.error(`logins: seat ${seat.n}'s browser would not take the cookie ${cookie.name} for ${cookie.domain}: ${messageOf(error)}`)
        return false
      })
      if (took) after.set(key, cookie)
    }
    return after
  }

  // Each browser's cookies, or none for one that can't be read now, such as one
  // starting again. It is read in the next round.
  async function readAll(seats: SeatBrowser[]): Promise<Read[]> {
    const read = await Promise.all(seats.map(async (seat): Promise<Read | null> => {
      const signal = AbortSignal.any([AbortSignal.timeout(COOKIE_WAIT_MS), stopping.signal])
      try {
        const browser = await browserDevtools(seat.cdpUrl, signal)
        return await readCookies(browser).then((cookies) => ({ seat, browser, cookies }), (error: unknown) => {
          browser.close()
          throw error
        })
      } catch (error) {
        console.error(`logins: reading seat ${seat.n}'s cookies: ${messageOf(error)}`)
        return null
      }
    }))
    return read.filter((entry) => entry !== null)
  }

  async function round() {
    const seats = browsers()
    for (const n of held.keys()) if (!seats.some((seat) => seat.n === n)) held.delete(n)
    const read = await readAll(seats)
    try {
      if (shared === null) {
        const first = read.find((entry) => entry.seat.n === FIRST_SEAT)
        if (!first) return
        shared = new Map(first.cookies)
        held.set(FIRST_SEAT, { starts: first.seat.starts, cookies: first.cookies })
      }
      const all = shared
      // Each browser that held the shared cookies last round brings in what it changed since.
      for (const { seat, cookies } of read) {
        const before = held.get(seat.n)
        if (before?.starts !== seat.starts) continue
        for (const [key, cookie] of cookies) if (!sayTheSame(before.cookies.get(key), cookie)) all.set(key, cookie)
        for (const key of before.cookies.keys()) if (!cookies.has(key)) all.delete(key)
      }
      for (const entry of read) {
        const after = await give(entry, all).catch((error: unknown) => {
          console.error(`logins: seat ${entry.seat.n}'s browser did not take the shared cookies: ${messageOf(error)}`)
          return null
        })
        // A browser left part way takes the shared cookies whole in the next round.
        if (after) held.set(entry.seat.n, { starts: entry.seat.starts, cookies: after })
        else held.delete(entry.seat.n)
      }
    } finally {
      for (const { browser } of read) browser.close()
    }
    for (const waiter of [...waiting]) {
      if (held.get(waiter.n)?.starts !== waiter.starts) continue
      waiting.splice(waiting.indexOf(waiter), 1)
      waiter.resolve()
    }
  }

  const done = (async () => {
    while (!stopping.signal.aborted) {
      // A round that fails is tried again in the next, so it is logged, not fatal.
      await round().catch((error: unknown) => { console.error(`logins: ${messageOf(error)}`) })
      await sleep(SYNC_MS, undefined, { signal: stopping.signal }).catch((error: unknown) => {
        if (!stopping.signal.aborted) throw error
      })
    }
  })()
  return {
    taken(n, starts) {
      if (held.get(n)?.starts === starts) return Promise.resolve()
      return new Promise((resolve, reject) => { waiting.push({ n, starts, resolve, reject }) })
    },
    async stop() {
      stopping.abort()
      await done
      for (const waiter of waiting.splice(0)) waiter.reject(new Error('the daemon is stopping'))
    },
  }
}
