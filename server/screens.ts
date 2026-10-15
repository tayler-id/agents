// The API's side of agents' computers (docs/design/computers.md). Each seat of a
// box has a screen of its own. A box with a desktop keeps one control
// connection open to the machine port. When a person opens a seat's Screen view
// through the people socket, the API asks the box for a tunnel to that seat and
// joins the two, reading what the person sends so that only the one who holds
// that seat's screen can type or click. The open row of screen_takeovers for a
// seat records who holds its screen, and only the handoff state machine in
// shared/screen.ts moves it.

import { randomUUID } from 'node:crypto'
import { STATUS_CODES, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type pg from 'pg'
import { WebSocketServer, type WebSocket } from 'ws'
import { z } from 'zod'
import { checkAudience, instanceFrom, personFrom, type Instance } from './auth.ts'
import { many, maybe, one, pool, tx } from './db.ts'
import { appendEvents, HttpError, type Person } from './record.ts'
import { VISIBLE_CONVERSATION, VISIBLE_TASK } from './access.ts'
import { scopedTeams } from './runner.ts'
import { RfbFilterError, RfbInputFilter } from './rfb-filter.ts'
import {
  AGENT_HOLDS, FromBox, handoff, SCREEN_DEAD_MS, SCREEN_GRACE_MS, SCREEN_PING_MS, SCREEN_SWEEP_MS, ScreenClose,
  type HandoffEvent, type ScreenControl, type ToBox, type ToViewer,
} from '../shared/screen.ts'
import { PersonId, ScreenTakeoverId, SeatId, SessionId, TunnelId } from '../shared/ids.ts'
import { InstanceId } from '../shared/onboarding.ts'
import { FIRST_SEAT, SeatInPath, SeatNumber } from '../shared/seats.ts'
import { parseJson } from '../shared/json.ts'
import { WORKING } from '../shared/lifecycle.ts'
import { bytesOf } from '../shared/websocket.ts'
import { messageOf } from '../shared/errors.ts'

// A box dials back within a second on a healthy connection. Ten seconds covers a
// box under load without leaving a person looking at nothing.
const TUNNEL_WAIT_MS = 10_000
// A seat that showed private work in the last day may still have it on screen,
// in a tab or a terminal, so only people who can see that work may watch.
const PRIVATE_WORK_HOURS = 24
// A viewer sends keys, clicks and small protocol messages. The largest it may
// send is clipboard text, which the filter caps at 1 MB and then drops.
const VIEWER_MAX_FRAME = 2 * 1024 * 1024
// A box's tunnel carries the screen in chunks of a socket read, 64 KB at most.
const BOX_MAX_FRAME = 16 * 1024 * 1024
// A screen named without a seat is the box's first seat, the one screen a box
// had before seats.
const VIEWER_PATH = /^\/v1\/screens\/([0-9a-f-]{36})(?:\/seats\/([0-9]+))?$/
const TUNNEL_PATH = /^\/v1\/instance\/screen\/tunnels\/([0-9a-f-]{36})$/

// One seat's screen: the box it is on, its number there, and its row.
type Screen = { instanceId: InstanceId; n: SeatNumber; seatId: SeatId }
type BoxLink = { instanceId: InstanceId; ws: WebSocket }
type Viewer = {
  tunnel: TunnelId; screen: Screen; person: Person; ws: WebSocket; filter: RfbInputFilter
  box: WebSocket | null
  // Bytes the viewer sent before its box's tunnel arrived.
  early: Uint8Array[]
  waiting: NodeJS.Timeout
}

const boxes = new Map<InstanceId, BoxLink>()
const viewers = new Map<TunnelId, Viewer>()
// Each seat's screen control as last read from or written to the database.
// Every change goes through this file, which updates both.
const controls = new Map<SeatId, ScreenControl>()
// When a person's last view of a seat's screen closed, by seat and person.
const lastSeen = new Map<string, number>()
const seenKey = (seatId: SeatId, personId: PersonId) => `${seatId}/${personId}`

const peopleSockets = new WebSocketServer({ noServer: true, maxPayload: VIEWER_MAX_FRAME })
const machineSockets = new WebSocketServer({ noServer: true, maxPayload: BOX_MAX_FRAME })

const holds = (control: ScreenControl, personId: PersonId) => control.holder === 'person' && control.personId === personId

const ScreenRow = z.object({ seat_id: SeatId, n: SeatNumber })

// The screens of a box's seats.
async function screensOf(instanceId: InstanceId): Promise<Screen[]> {
  return (await many(pool, 'select id as seat_id, n from seats where instance_id = $1 order by n', [instanceId]))
    .map((row) => ScreenRow.parse(row)).map(({ seat_id: seatId, n }) => ({ instanceId, n, seatId }))
}

// The open takeover of a seat's screen, as the control it means.
const OpenTakeover = z.object({ person_id: PersonId, login: z.string(), started_at: z.date() })
async function readControl(db: pg.Pool | pg.PoolClient, seatId: SeatId): Promise<ScreenControl> {
  const row = await maybe(db,
    `select t.person_id, p.login, t.started_at from screen_takeovers t join people p on p.id = t.person_id
     where t.seat_id = $1 and t.ended_at is null`, [seatId])
  if (!row) return AGENT_HOLDS
  const open = OpenTakeover.parse(row)
  return { holder: 'person', personId: open.person_id, login: open.login, since: open.started_at.toISOString() }
}

// Reads a seat's screen control into the cache the first time anyone connects to it.
async function loadControl(seatId: SeatId) {
  if (!controls.has(seatId)) controls.set(seatId, await readControl(pool, seatId))
}

function controlOf(seatId: SeatId): ScreenControl {
  const control = controls.get(seatId)
  if (!control) throw new Error(`the control of seat ${seatId}'s screen was never read`)
  return control
}

const send = (ws: WebSocket, message: ToBox | ToViewer) => { ws.send(JSON.stringify(message)) }

// Tells the box and everyone watching the seat, and lets go of what a viewer
// who lost control still holds down.
function applyControl(screen: Screen, control: ScreenControl) {
  controls.set(screen.seatId, control)
  const box = boxes.get(screen.instanceId)
  if (box) send(box.ws, { type: 'control', seat: screen.n, control })
  for (const viewer of viewers.values()) {
    if (viewer.screen.seatId !== screen.seatId) continue
    for (const release of viewer.filter.setAllowInput(holds(control, PersonId.parse(viewer.person.id)))) viewer.box?.send(release)
    send(viewer.ws, { type: 'control', control })
  }
}

const SeatOfBox = z.object({ id: SeatId, status: z.enum(['free', 'starting', 'ready']) })

// A person may watch or take over a seat's screen on a box of their team's,
// unless the seat ran work in the last day that is private and not theirs to
// see. A box session with no seat ran on seat 1. A seat other than the first
// runs only while an agent holds it.
async function watchable(person: Person, instanceId: string, n: SeatNumber): Promise<Screen> {
  const id = InstanceId.safeParse(instanceId)
  if (!id.success) throw new HttpError(404, 'no such screen')
  const found = await maybe(pool,
    `select s.id, s.status from seats s join instances i on i.id = s.instance_id
     where s.instance_id = $1 and s.n = $2 and i.team_id = $3 and i.screen_width is not null`, [id.data, n, person.team_id])
  if (!found) throw new HttpError(404, 'no such screen')
  const seat = SeatOfBox.parse(found)
  if (n !== FIRST_SEAT && seat.status === 'free') throw new HttpError(409, `Seat ${n} is free, so its screen is off.`)
  const hidden = await one(pool, 'the count of hidden sessions',
    `select count(*)::int as n from sessions s
     where s.team_id = $1 and s.instance_id = $3 and (s.seat_id = $6 or (s.seat_id is null and $7::int = $8::int))
       and (s.status = any($4) or s.last_active_at > now() - make_interval(hours => $5))
       and not coalesce(s.conversation_id in (select id from conversations where team_id = $1 and ${VISIBLE_CONVERSATION}), false)
       and not coalesce(s.task_id in (select id from tasks where team_id = $1 and ${VISIBLE_TASK}), false)`,
    [person.team_id, person.id, id.data, WORKING, PRIVATE_WORK_HOURS, seat.id, n, FIRST_SEAT])
  if (z.object({ n: z.int() }).parse(hidden).n > 0) throw new HttpError(403, "This screen has shown work you can't see.")
  return { instanceId: id.data, n, seatId: seat.id }
}

// A notice in each session working on the seat, and in the one the person was
// looking at, so the record shows who had the screen and when.
async function noteSessions(client: pg.PoolClient, screen: Screen, sessionId: SessionId | null, takeoverId: ScreenTakeoverId,
  action: HandoffEvent['kind'], text: string, author: string | null) {
  const sessions = await many(client,
    `select id from sessions where instance_id = $1 and archived_at is null
       and ((status = any($2) and (seat_id = $4 or (seat_id is null and $5::int = $6::int))) or id = $3)`,
    [screen.instanceId, WORKING, sessionId, screen.seatId, screen.n, FIRST_SEAT])
  for (const session of sessions) {
    await appendEvents(client, SessionId.parse(session.id), {
      events: [{ clientId: `screen:${takeoverId}:${action}`, kind: 'notice', text, body: { subtype: 'screen', action, takeoverId } }],
    }, author)
  }
}

// The notice in the record when a person's hold on a screen ends.
function endNotice(event: HandoffEvent, login: string): string {
  switch (event.kind) {
    case 'take': throw new Error('taking over starts a hold, it never ends one')
    case 'hand_back': return `${login} handed the screen back`
    case 'left': switch (event.why) {
      case 'view_closed': return `The screen went back to the agent after ${login} closed the Screen view`
      case 'not_allowed': return `The screen went back to the agent because ${login} may no longer watch it`
    }
  }
}

// Moves a seat's screen control by one event, in one transaction with the
// takeover row it opens or closes, then tells the box and the viewers.
async function move(screen: Screen, event: HandoffEvent, person: { id: PersonId; login: string }, sessionId: SessionId | null): Promise<ScreenControl> {
  const control = await tx(async (client) => {
    // One change to a seat's screen at a time.
    await client.query('select 1 from seats where id = $1 for update', [screen.seatId])
    const step = handoff(await readControl(client, screen.seatId), event)
    if (!step.ok) throw new HttpError(409, step.reason)
    switch (step.change) {
      case 'already_held':
        break
      case 'took_over': {
        const row = await one(client, 'the new takeover',
          `insert into screen_takeovers (team_id, instance_id, seat_id, person_id, session_id, started_at)
           select team_id, instance_id, id, $2, $3, $4 from seats where id = $1 returning id`,
          [screen.seatId, person.id, sessionId, step.control.since])
        await noteSessions(client, screen, sessionId, ScreenTakeoverId.parse(row.id), 'take', `${person.login} took over the screen`, person.id)
        break
      }
      case 'handed_back':
      case 'left': {
        const row = await one(client, 'the open takeover',
          `update screen_takeovers set ended_at = now(), ended_by = $2 where seat_id = $1 and ended_at is null returning id`,
          [screen.seatId, step.change])
        await noteSessions(client, screen, sessionId, ScreenTakeoverId.parse(row.id), event.kind, endNotice(event, person.login),
          step.change === 'handed_back' ? person.id : null)
        break
      }
    }
    return step.control
  })
  applyControl(screen, control)
  return control
}

export async function takeScreen(person: Person, instanceId: string, n: SeatNumber, sessionId: SessionId | null): Promise<ScreenControl> {
  const screen = await watchable(person, instanceId, n)
  if (!boxes.has(screen.instanceId)) throw new HttpError(409, 'The box is not connected, so nobody can take over its screen.')
  const id = PersonId.parse(person.id)
  return move(screen, { kind: 'take', personId: id, login: person.login, at: new Date().toISOString() }, { id, login: person.login }, sessionId)
}

// Handing back runs no watch rule, so a person cut off from a screen they held
// can still give it back. Only its holder can, as the handoff says, and it must
// be a seat on a box of their team's.
export async function handBackScreen(person: Person, instanceId: string, n: SeatNumber, sessionId: SessionId | null): Promise<ScreenControl> {
  const id = InstanceId.safeParse(instanceId)
  const ours = id.success && await maybe(pool,
    'select s.id from seats s join instances i on i.id = s.instance_id where s.instance_id = $1 and s.n = $2 and i.team_id = $3', [id.data, n, person.team_id])
  if (!id.success || !ours) throw new HttpError(404, 'no such screen')
  const personId = PersonId.parse(person.id)
  const screen: Screen = { instanceId: id.data, n, seatId: z.object({ id: SeatId }).parse(ours).id }
  return move(screen, { kind: 'hand_back', personId }, { id: personId, login: person.login }, sessionId)
}

// Runs the watch rule again for everyone watching a box's screens, or every
// screen, since work they can't see may have started on a seat after they
// opened it. A viewer who may no longer watch is closed, and a screen they held
// goes back to the agent.
export async function recheckViewers(instanceId: InstanceId | null) {
  for (const viewer of [...viewers.values()]) {
    if (instanceId !== null && viewer.screen.instanceId !== instanceId) continue
    const refused = await watchable(viewer.person, viewer.screen.instanceId, viewer.screen.n).then(() => null, (error: unknown) => {
      if (error instanceof HttpError) return error.message
      throw error
    })
    if (refused === null) continue
    viewer.ws.close(ScreenClose.notAllowed, refused)
    const personId = PersonId.parse(viewer.person.id)
    if (holds(controlOf(viewer.screen.seatId), personId)) {
      await move(viewer.screen, { kind: 'left', personId, why: 'not_allowed' }, { id: personId, login: viewer.person.login }, null)
    }
  }
}

// Gives screens back to the agents when the person holding one has had no view
// of it open for SCREEN_GRACE_MS, so a closed tab never strands an agent, and
// runs the watch rule again for everyone watching.
export function startScreenSweep(): () => void {
  // A screen nobody has opened since this server started counts from the start,
  // so a holder gets the same grace to come back after a restart.
  const started = Date.now()
  const Open = z.object({ instance_id: InstanceId, seat_id: SeatId, n: SeatNumber, person_id: PersonId, login: z.string() })
  const sweep = async () => {
    const teams = await scopedTeams()
    const open = await many(pool,
      `select t.instance_id, t.seat_id, s.n, t.person_id, p.login from screen_takeovers t
       join seats s on s.id = t.seat_id join people p on p.id = t.person_id
       where t.ended_at is null and ($1::uuid[] is null or t.team_id = any($1))`, [teams])
    for (const row of open.map((r) => Open.parse(r))) {
      const watching = [...viewers.values()].some((v) => v.screen.seatId === row.seat_id && v.person.id === row.person_id)
      const since = lastSeen.get(seenKey(row.seat_id, row.person_id)) ?? started
      if (watching || Date.now() - since < SCREEN_GRACE_MS) continue
      const screen: Screen = { instanceId: row.instance_id, n: row.n, seatId: row.seat_id }
      await move(screen, { kind: 'left', personId: row.person_id, why: 'view_closed' }, { id: row.person_id, login: row.login }, null)
    }
    await recheckViewers(null)
  }
  const timer = setInterval(() => {
    // A failed sweep is tried again on the next tick, so it is logged, not fatal.
    sweep().catch((error: unknown) => { console.error('screen sweep:', messageOf(error)) })
  }, SCREEN_SWEEP_MS)
  return () => { clearInterval(timer) }
}

function linkBox(instanceId: InstanceId, screens: Screen[], ws: WebSocket) {
  // A box that reconnects replaces its old connection.
  boxes.get(instanceId)?.ws.terminate()
  boxes.set(instanceId, { instanceId, ws })
  let heard = Date.now()
  const check = setInterval(() => { if (Date.now() - heard > SCREEN_DEAD_MS) ws.terminate() }, SCREEN_PING_MS)
  ws.on('message', (data, isBinary) => {
    heard = Date.now()
    const message = isBinary ? null : parseJson(FromBox, bytesOf(data).toString('utf8'))
    if (!message?.ok) {
      ws.close(ScreenClose.unsupported, 'the control connection carries pings as JSON text only')
      return
    }
    send(ws, { type: 'pong' })
  })
  ws.on('close', () => {
    clearInterval(check)
    if (boxes.get(instanceId)?.ws === ws) boxes.delete(instanceId)
  })
  for (const screen of screens) send(ws, { type: 'control', seat: screen.n, control: controlOf(screen.seatId) })
}

// Pings a viewer or a tunnel, and drops it once it stops answering. A laptop that
// sleeps or a box that hangs leaves its connection open with nobody behind it,
// and a holder's dead view would keep the screen from going back to the agent.
// Browsers and the box's WebSocket answer pings on their own.
function keepAlive(ws: WebSocket) {
  let answered = Date.now()
  ws.on('pong', () => { answered = Date.now() })
  const timer = setInterval(() => {
    if (Date.now() - answered > SCREEN_DEAD_MS) ws.terminate()
    else ws.ping()
  }, SCREEN_PING_MS)
  ws.on('close', () => { clearInterval(timer) })
}

function watch(person: Person, screen: Screen, ws: WebSocket) {
  const control = controlOf(screen.seatId)
  const box = boxes.get(screen.instanceId)
  if (!box) {
    ws.close(ScreenClose.notConnected, 'The box is not connected. It may be stopped.')
    return
  }
  const tunnel = TunnelId.parse(randomUUID())
  const personId = PersonId.parse(person.id)
  const viewer: Viewer = {
    tunnel, screen, person, ws, filter: new RfbInputFilter(holds(control, personId)), box: null, early: [],
    waiting: setTimeout(() => { ws.close(ScreenClose.boxSilent, 'The box did not answer. Try again in a moment.') }, TUNNEL_WAIT_MS),
  }
  viewers.set(tunnel, viewer)
  keepAlive(ws)
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      ws.close(ScreenClose.badInput, 'The screen takes binary frames only.')
      return
    }
    try {
      for (const bytes of viewer.filter.push(bytesOf(data))) {
        if (viewer.box) viewer.box.send(bytes)
        else viewer.early.push(bytes)
      }
    } catch (error) {
      if (!(error instanceof RfbFilterError)) console.error('screen viewer:', messageOf(error))
      ws.close(ScreenClose.badInput, error instanceof RfbFilterError ? `The screen can't take ${error.message}.` : 'The screen failed.')
    }
  })
  ws.on('close', () => {
    clearTimeout(viewer.waiting)
    viewers.delete(tunnel)
    viewer.box?.close()
    lastSeen.set(seenKey(screen.seatId, personId), Date.now())
  })
  send(ws, { type: 'control', control })
  send(box.ws, { type: 'open', seat: screen.n, tunnel })
}

function joinTunnel(viewer: Viewer, ws: WebSocket) {
  clearTimeout(viewer.waiting)
  viewer.box = ws
  keepAlive(ws)
  for (const bytes of viewer.early.splice(0)) ws.send(bytes)
  ws.on('message', (data) => { viewer.ws.send(bytesOf(data), { binary: true }) })
  ws.on('close', () => { viewer.ws.close(ScreenClose.boxClosed, 'The box closed the screen.') })
}

// The tunnel a box dials for one viewer, which must be waiting for it.
function waitingViewer(tunnelId: string, instance: Instance): Viewer {
  const tunnel = TunnelId.safeParse(tunnelId)
  const viewer = tunnel.success ? viewers.get(tunnel.data) : undefined
  if (!viewer || viewer.screen.instanceId !== instance.id || viewer.box) throw new HttpError(404, 'no such tunnel')
  return viewer
}

function refuse(socket: Duplex, status: number, message: string) {
  const body = JSON.stringify({ error: message })
  // HTTP allows an empty reason phrase, for a status Node has no name for.
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nconnection: close\r\ncontent-type: application/json\r\n`
    + `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

// The seat a screen's path names. A path that names none means the first seat.
export function seatInPath(text: string | undefined): SeatNumber {
  if (text === undefined || text === '') return FIRST_SEAT
  const seat = SeatInPath.safeParse(text)
  if (!seat.success) throw new HttpError(404, 'no such screen')
  return seat.data
}

// Which listener an upgrade came in on. People's carries the origins the app's
// pages are served from, which the API reads from AGENTS_PEOPLE_ORIGINS.
export type UpgradeSide = { audience: 'machines' } | { audience: 'people'; origins: ReadonlySet<string> }

async function upgrade(side: UpgradeSide, req: IncomingMessage, socket: Duplex, head: Buffer) {
  // Node takes its own error listener off a socket before it hands over an
  // upgrade, and ws adds one only once it has the socket. A client that resets
  // the connection in between, while the API looks it up or refuses it, would
  // raise an error nobody hears, which stops the API. The socket is already
  // destroyed when this one hears it, so saying so is all there is to do.
  const onError = (error: Error) => { console.error(`screen upgrade for ${req.url ?? '/'}: ${error.message}`) }
  socket.on('error', onError)
  // ws raises `error` on a socket for a frame that breaks the protocol, such as
  // a client's frame without a mask, and an `error` nobody hears stops the API.
  // So every screen socket, refused ones included, hears its errors before
  // anything else is done with it. `label` says which socket in the log.
  const accept = (sockets: WebSocketServer, label: string, then: (ws: WebSocket) => void) => {
    socket.off('error', onError)
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', (error) => { console.error(`${label}: ${error.message}`) })
      then(ws)
    })
  }
  try {
    checkAudience(side.audience, req)
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (side.audience === 'machines') {
      if (path === '/v1/instance/screen') {
        const instance = await instanceFrom(req)
        const id = InstanceId.parse(instance.id)
        const screens = await screensOf(id)
        for (const screen of screens) await loadControl(screen.seatId)
        accept(machineSockets, `screen control of ${id}`, (ws) => { linkBox(id, screens, ws) })
        return
      }
      const tunnel = TUNNEL_PATH.exec(path)?.[1]
      if (!tunnel) throw new HttpError(404, 'no such route')
      const viewer = waitingViewer(tunnel, await instanceFrom(req))
      accept(machineSockets, `screen tunnel ${viewer.tunnel}`, (ws) => { joinTunnel(viewer, ws) })
      return
    }
    const named = VIEWER_PATH.exec(path)
    const screenId = named?.[1]
    if (!named || !screenId) throw new HttpError(404, 'no such route')
    const n = seatInPath(named[2])
    // A browser sends its page's origin with every WebSocket it opens. A page on
    // another site, open in a teammate's browser, would otherwise watch and take
    // over as them. Host is no help, since the page picks the host it connects to.
    const origin = req.headers.origin
    if (origin === undefined || !side.origins.has(origin)) {
      console.error(origin === undefined
        ? `screen view of ${screenId} refused: it sent no origin, and AGENTS_PEOPLE_ORIGINS lists the ones allowed`
        : `screen view of ${screenId} refused: origin ${origin} is not in AGENTS_PEOPLE_ORIGINS`)
      throw new HttpError(403, 'Only the app may open a screen.')
    }
    // A browser can't read the status of a refused upgrade, only a close
    // reason, so a person who may not watch gets the socket closed with why.
    const allowed = await (async () => {
      const person = await personFrom(req)
      const screen = await watchable(person, screenId, n)
      await loadControl(screen.seatId)
      return { person, screen }
    })().catch((error: unknown) => {
      if (error instanceof HttpError) return { refused: error.message }
      throw error
    })
    accept(peopleSockets, `screen view of ${screenId}`, (ws) => {
      if ('refused' in allowed) ws.close(ScreenClose.notAllowed, allowed.refused)
      else watch(allowed.person, allowed.screen, ws)
    })
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    if (status === 500) console.error(error)
    refuse(socket, status, error instanceof HttpError ? error.message : 'internal error')
  }
}

// Each HTTP server's upgrade listener. Upgrades are WebSockets, and only screens use them.
export const screenUpgrades = (side: UpgradeSide) => (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  void upgrade(side, req, socket, head)
}
