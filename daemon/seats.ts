// The computer's seats, inside the daemon. A seat is a display, a window
// manager with its dock, a browser and a screen service of its own
// (daemon/desktop.ts, daemon/dock.ts, daemon/screen.ts), numbered as its row in
// the `seats` table: display :n, its browser's DevTools port 9221 + n, its own
// sockets and its own browser profile, whose logins every seat shares
// (daemon/logins.ts). Every seat's dock opens the one whiteboard the daemon
// serves (daemon/whiteboard.ts). Seat 1 runs whenever the computer runs, and
// every other seat while an agent holds it. The daemon follows the computer's
// seat rows, starts and stops seats to match, closes a seat's pages and windows
// when another agent takes it, and tells the API once a seat is up for its
// agent. The design is "Seats" in docs/design/target-architecture.md.

import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { messageOf } from '../shared/errors.ts'
import type { AgentId } from '../shared/ids.ts'
import { AGENT_HOLDS, type ScreenControl, type ScreenSize } from '../shared/screen.ts'
import { FIRST_SEAT, type SeatNumber, type SeatRow } from '../shared/seats.ts'
import { startDesktop, type Desktop } from './desktop.ts'
import { closePages } from './devtools.ts'
import { shareLogins } from './logins.ts'
import { startScreenService, type ScreenService } from './screen.ts'
import { serveWhiteboard, WHITEBOARD_URL } from './whiteboard.ts'

// Seat n's browser listens for DevTools on this plus n, so seat 1 keeps
// Chrome's usual 9222, the port a box's one browser had before seats.
const DEVTOOLS_PORT_BASE = 9221
// How long a session waits for its seat: the desktop's own start limit of 30
// seconds, with time for the seat's row to reach this machine and for the
// seat to take the shared logins.
const SEAT_WAIT_MS = 45_000
// How long a seat whose desktop came up waits to take the shared logins before
// it goes to work without them. A round of copying takes 1.5 s and a few reads.
const LOGINS_WAIT_MS = 10_000
// A seat other than seat 1 that doesn't come up stops, and starts again this long after.
const SEAT_RETRY_MS = 5_000
const POLL_MS = 100
// A report the API didn't take is sent again after this, doubling up to the most.
const REPORT_FIRST_MS = 500
const REPORT_MAX_MS = 15_000

// What a session on a seat is given: the seat's screen service, its browser,
// and Playwright's MCP server, which drives that browser.
export type SeatComputer = { n: SeatNumber; socket: string; cdpUrl: string; browserMcp: string }

export type SeatsConfig = {
  size: ScreenSize
  // Where the seats' sockets go, readable only by this user.
  runDir: string
  // The computer's home folder, a volume that outlives the container, which
  // holds each seat's browser profile.
  home: string
  // Playwright's browsers folder, which holds the one Chromium every seat runs.
  browsersPath: string
  // The whiteboard's files (box/Dockerfile).
  whiteboard: string
  // Playwright's MCP server, which every session's `computer` server starts.
  browserMcp: string
  // The computer's secrets by name, read again on each use.
  secrets: () => [name: string, value: string][]
  // Tells the API a seat is up for the agent it was started for.
  reportUp: (n: SeatNumber, agentId: AgentId) => Promise<void>
}

export type Seats = {
  // Resolves once seat 1 is up, and rejects when its desktop can't come up.
  firstUp: Promise<void>
  // The computer's seat rows, each time they change.
  follow(rows: SeatRow[]): void
  // Seat n's computer once it is up, for a session that runs on it.
  computer(n: SeatNumber): Promise<SeatComputer>
  // Who holds a seat's screen, as the API last said.
  setControl(n: SeatNumber, control: ScreenControl): void
  // A running seat's Xvnc socket, for a person's Screen view, or null.
  vncSocket(n: SeatNumber): string | null
  stop(): Promise<void>
}

type Seat = {
  n: SeatNumber
  desktop: Desktop
  socket: string
  service: ScreenService | null
  // Resolves once the desktop is up and the browser holds the shared logins.
  up: Promise<void>
  desktopUp: boolean
  working: boolean
  stopped: boolean
  // The agent the seat was started for, or null when none holds it. Seat 1
  // starts before the seat rows arrive, and has none known until they do.
  holder: AgentId | null | 'unknown'
  // The agent whose start this seat has reported, or is reporting.
  reported: AgentId | null
  // Resolves once the pages the last agent left are closed.
  cleared: Promise<void>
}

// Seat 1 keeps the profile a box's one browser had before seats, with the logins made in it.
const profileOf = (home: string, n: SeatNumber) => (n === FIRST_SEAT ? join(home, 'browser') : join(home, 'seats', String(n), 'browser'))

export function startSeats(config: SeatsConfig): Seats {
  const running = new Map<SeatNumber, Seat>()
  // Seats still stopping. One starts again only once its last stop has finished,
  // so two displays or two browsers never contend for one number and port.
  const stopping = new Map<SeatNumber, Promise<void>>()
  const rows = new Map<SeatNumber, SeatRow>()
  const controls = new Map<SeatNumber, ScreenControl>()
  // Set by stop() while reports wait, so read through a function.
  const state: { stopped: boolean; retry: NodeJS.Timeout | null } = { stopped: false, retry: null }
  const stopped = () => state.stopped
  const logins = shareLogins(() => [...running.values()]
    .filter((seat) => seat.desktopUp && !seat.stopped)
    .map((seat) => ({ n: seat.n, cdpUrl: seat.desktop.cdpUrl, starts: seat.desktop.browserStarts() })))

  function stopSeat(seat: Seat): Promise<void> {
    seat.stopped = true
    if (running.get(seat.n) === seat) running.delete(seat.n)
    const done = (async () => {
      await seat.service?.stop()
      await seat.desktop.stop()
    })().finally(() => { if (stopping.get(seat.n) === done) stopping.delete(seat.n) })
    stopping.set(seat.n, done)
    return done
  }

  function startSeat(n: SeatNumber, holder: Seat['holder']): Seat {
    const dir = join(config.runDir, `seat-${n}`)
    const desktop = startDesktop({
      size: config.size, display: n, cdpPort: DEVTOOLS_PORT_BASE + n, runDir: dir, profileDir: profileOf(config.home, n), browsersPath: config.browsersPath,
      whiteboardUrl: WHITEBOARD_URL,
    })
    const seat: Seat = {
      n, desktop, socket: join(dir, 'agent.sock'), service: null, up: Promise.resolve(), desktopUp: false, working: false, stopped: false,
      holder, reported: null, cleared: Promise.resolve(),
    }
    seat.up = (async () => {
      await desktop.ready
      if (seat.stopped) return
      seat.desktopUp = true
      seat.service = startScreenService({ desktop, socketPath: seat.socket, secrets: config.secrets })
      seat.service.setControl(controls.get(n) ?? AGENT_HOLDS)
      const starts = desktop.browserStarts()
      const took = await Promise.race([logins.taken(n, starts).then(() => true), sleep(LOGINS_WAIT_MS, false, { ref: false })])
      if (!took) console.error(`seat ${n}: its browser did not take the shared logins within ${LOGINS_WAIT_MS / 1000}s, so it works without them until it does`)
      seat.working = true
    })()
    // Seat 1's failure stops the daemon, through firstUp. Any other seat stops and starts again.
    if (n !== FIRST_SEAT) {
      seat.up.catch((error: unknown) => {
        if (seat.stopped) return
        console.error(`seat ${n}: ${messageOf(error)}. Stopping it, to start again in ${SEAT_RETRY_MS / 1000}s.`)
        stopSeat(seat).then(() => {
          if (stopped()) return
          if (state.retry) clearTimeout(state.retry)
          state.retry = setTimeout(settle, SEAT_RETRY_MS)
        }, (stopError: unknown) => { console.error(`seat ${n}: stopping it: ${messageOf(stopError)}`) })
      })
    }
    running.set(n, seat)
    return seat
  }

  // Tells the API the seat is up for its agent, once its pages are clear,
  // trying again while the seat still holds that agent.
  function report(seat: Seat, agentId: AgentId) {
    seat.reported = agentId
    void (async () => {
      await seat.up
      await seat.cleared
      for (let wait = REPORT_FIRST_MS; !stopped() && !seat.stopped && seat.holder === agentId; wait = Math.min(REPORT_MAX_MS, wait * 2)) {
        try {
          await config.reportUp(seat.n, agentId)
          return
        } catch (error) {
          console.error(`seat ${seat.n}: telling the API it is up: ${messageOf(error)}`)
          await sleep(wait)
        }
      }
    })().catch((error: unknown) => {
      // The seat didn't come up. It starts again, as a new seat that reports for itself.
      console.error(`seat ${seat.n}: not reported up: ${messageOf(error)}`)
    })
  }

  // Brings the running seats in line with the rows.
  function settle() {
    if (stopped()) return
    for (const seat of [...running.values()]) {
      const row = rows.get(seat.n)
      if (seat.n !== FIRST_SEAT && (row === undefined || row.agent_id === null)) {
        stopSeat(seat).catch((error: unknown) => { console.error(`seat ${seat.n}: stopping it: ${messageOf(error)}`) })
      }
    }
    for (const row of rows.values()) {
      const previous = stopping.get(row.n)
      if (!running.has(row.n) && row.agent_id !== null && previous) {
        // The seat starts once its last stop finishes, from the rows as they are then.
        void previous.then(settle, settle)
        continue
      }
      const seat = running.get(row.n) ?? (row.agent_id === null ? null : startSeat(row.n, row.agent_id))
      if (!seat) continue
      if (seat.holder === 'unknown') seat.holder = row.agent_id
      else if (seat.holder !== row.agent_id) {
        // Another agent took the seat, or the last one let it go.
        seat.holder = row.agent_id
        seat.reported = null
        seat.cleared = seat.up.then(() => Promise.all([closePages(seat.desktop.cdpUrl), seat.desktop.closeWindows()])).then(() => undefined, (error: unknown) => {
          console.error(`seat ${seat.n}: closing the pages and windows the last agent had open: ${messageOf(error)}`)
        })
      }
      if (row.status === 'starting' && seat.reported !== row.agent_id) report(seat, row.agent_id)
    }
  }

  // One whiteboard serves every seat. A box whose loopback already has one,
  // which only happens to boxes on the host's network, as step 12c runs them,
  // goes on without its own.
  const whiteboard = serveWhiteboard(config.whiteboard).catch((error: unknown) => {
    console.error(`the whiteboard did not start: ${messageOf(error)}`)
    return null
  })
  const first = startSeat(FIRST_SEAT, 'unknown')
  return {
    firstUp: first.up,
    follow(next) {
      rows.clear()
      for (const row of next) rows.set(row.n, row)
      settle()
    },
    async computer(n) {
      const deadline = Date.now() + SEAT_WAIT_MS
      for (;;) {
        const seat = running.get(n)
        if (seat?.working) {
          await seat.cleared
          return { n, socket: seat.socket, cdpUrl: seat.desktop.cdpUrl, browserMcp: config.browserMcp }
        }
        if (Date.now() > deadline) {
          throw new Error(seat ? `seat ${n} did not come up within ${SEAT_WAIT_MS / 1000}s` : `seat ${n} is not running on this computer`)
        }
        await sleep(POLL_MS)
      }
    },
    setControl(n, control) {
      controls.set(n, control)
      running.get(n)?.service?.setControl(control)
    },
    vncSocket(n) {
      const seat = running.get(n)
      return seat?.desktopUp ? seat.desktop.vncSocket : null
    },
    async stop() {
      state.stopped = true
      if (state.retry) clearTimeout(state.retry)
      await logins.stop()
      await Promise.all([...[...running.values()].map(stopSeat), ...stopping.values()])
      await (await whiteboard)?.stop()
    },
  }
}
