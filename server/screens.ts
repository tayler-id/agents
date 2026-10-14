// The API's side of agents' computers (docs/design/computers.md). A box
// with a desktop keeps one control connection open to the machine port. When a
// person opens the Screen view on the people port, the API asks the box for a
// tunnel and joins the two, reading what the person sends so that only the one
// who holds the screen can type or click. Who holds it is the open row of
// screen_takeovers, moved only by the handoff state machine in shared/screen.ts.

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
  AGENT_HOLDS, FromBox, handoff, SCREEN_DEAD_MS, SCREEN_GRACE_MS, SCREEN_PING_MS, ScreenClose,
  type HandoffEvent, type ScreenControl, type ToBox, type ToViewer,
} from '../shared/screen.ts'
import { PersonId, ScreenTakeoverId, SessionId, TunnelId } from '../shared/ids.ts'
import { InstanceId } from '../shared/onboarding.ts'
import { parseJson } from '../shared/json.ts'
import { bytesOf } from '../shared/websocket.ts'
import { messageOf } from '../shared/errors.ts'

// A box dials back within a second on a healthy connection. Ten seconds covers a
// box under load without leaving a person looking at nothing.
const TUNNEL_WAIT_MS = 10_000
// How often the API looks for people who hold a screen with no view open.
const SWEEP_MS = 5_000
// A box that showed private work in the last day may still have it on screen,
// in a tab or a terminal, so only people who can see that work may watch.
const PRIVATE_WORK_HOURS = 24
const WORKING = ['starting', 'running', 'needs_approval', 'needs_input']
// A viewer sends keys, clicks and small protocol messages. The largest it may
// send is clipboard text, which the filter caps at 1 MB and then drops.
const VIEWER_MAX_FRAME = 2 * 1024 * 1024
// A box's tunnel carries the screen in chunks of a socket read, 64 KB at most.
const BOX_MAX_FRAME = 16 * 1024 * 1024
const VIEWER_PATH = /^\/v1\/screens\/([0-9a-f-]{36})$/
const TUNNEL_PATH = /^\/v1\/instance\/screen\/tunnels\/([0-9a-f-]{36})$/

type BoxLink = { instanceId: InstanceId; ws: WebSocket }
type Viewer = {
  tunnel: TunnelId; instanceId: InstanceId; person: Person; ws: WebSocket; filter: RfbInputFilter
  box: WebSocket | null
  // Bytes the viewer sent before its box's tunnel arrived.
  early: Uint8Array[]
  waiting: NodeJS.Timeout
}

const boxes = new Map<InstanceId, BoxLink>()
const viewers = new Map<TunnelId, Viewer>()
// Each screen's control as last read from or written to the database. Every
// change goes through this file, which updates both.
const controls = new Map<InstanceId, ScreenControl>()
// When a person's last view of a screen closed, by screen and person.
const lastSeen = new Map<string, number>()
const seenKey = (instanceId: InstanceId, personId: PersonId) => `${instanceId}/${personId}`

const peopleSockets = new WebSocketServer({ noServer: true, maxPayload: VIEWER_MAX_FRAME })
const machineSockets = new WebSocketServer({ noServer: true, maxPayload: BOX_MAX_FRAME })

const holds = (control: ScreenControl, personId: PersonId) => control.holder === 'person' && control.personId === personId

// The open takeover of a screen, as the control it means.
const OpenTakeover = z.object({ person_id: PersonId, login: z.string(), started_at: z.date() })
async function readControl(db: pg.Pool | pg.PoolClient, instanceId: InstanceId): Promise<ScreenControl> {
  const row = await maybe(db,
    `select t.person_id, p.login, t.started_at from screen_takeovers t join people p on p.id = t.person_id
     where t.instance_id = $1 and t.ended_at is null`, [instanceId])
  if (!row) return AGENT_HOLDS
  const open = OpenTakeover.parse(row)
  return { holder: 'person', personId: open.person_id, login: open.login, since: open.started_at.toISOString() }
}

// Reads a screen's control into the cache the first time anyone connects to it.
async function loadControl(instanceId: InstanceId) {
  if (!controls.has(instanceId)) controls.set(instanceId, await readControl(pool, instanceId))
}

function controlOf(instanceId: InstanceId): ScreenControl {
  const control = controls.get(instanceId)
  if (!control) throw new Error(`the control of screen ${instanceId} was never read`)
  return control
}

const send = (ws: WebSocket, message: ToBox | ToViewer) => { ws.send(JSON.stringify(message)) }

// Tells the box and everyone watching, and lets go of what a viewer who lost
// control still holds down.
function applyControl(instanceId: InstanceId, control: ScreenControl) {
  controls.set(instanceId, control)
  const box = boxes.get(instanceId)
  if (box) send(box.ws, { type: 'control', control })
  for (const viewer of viewers.values()) {
    if (viewer.instanceId !== instanceId) continue
    for (const release of viewer.filter.setAllowInput(holds(control, PersonId.parse(viewer.person.id)))) viewer.box?.send(release)
    send(viewer.ws, { type: 'control', control })
  }
}

type Watchable = { id: InstanceId; teamId: string }

// A person may watch or take over a screen of their team's, unless the box ran
// work in the last day that is private and not theirs to see.
async function watchable(person: Person, instanceId: string): Promise<Watchable> {
  const id = InstanceId.safeParse(instanceId)
  if (!id.success) throw new HttpError(404, 'no such screen')
  const instance = await maybe(pool, 'select 1 from instances where id = $1 and team_id = $2 and screen_width is not null', [id.data, person.team_id])
  if (!instance) throw new HttpError(404, 'no such screen')
  const hidden = await one(pool, 'the count of hidden sessions',
    `select count(*)::int as n from sessions s
     where s.team_id = $1 and s.instance_id = $3
       and (s.status = any($4) or s.last_active_at > now() - make_interval(hours => $5))
       and not coalesce(s.conversation_id in (select id from conversations where team_id = $1 and ${VISIBLE_CONVERSATION}), false)
       and not coalesce(s.task_id in (select id from tasks where team_id = $1 and ${VISIBLE_TASK}), false)`,
    [person.team_id, person.id, id.data, WORKING, PRIVATE_WORK_HOURS])
  if (z.object({ n: z.int() }).parse(hidden).n > 0) throw new HttpError(403, "This screen has shown work you can't see.")
  return { id: id.data, teamId: person.team_id }
}

// A notice in each session working on the box, and in the one the person was
// looking at, so the record shows who had the screen and when.
async function noteSessions(client: pg.PoolClient, instanceId: InstanceId, sessionId: SessionId | null, takeoverId: ScreenTakeoverId,
  action: HandoffEvent['kind'], text: string, author: string | null) {
  const sessions = await many(client,
    `select id from sessions where instance_id = $1 and archived_at is null and (status = any($2) or id = $3)`,
    [instanceId, WORKING, sessionId])
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

// Moves control by one event, in one transaction with the takeover row it
// opens or closes, then tells the box and the viewers.
async function move(instanceId: InstanceId, event: HandoffEvent, person: { id: PersonId; login: string }, sessionId: SessionId | null): Promise<ScreenControl> {
  const control = await tx(async (client) => {
    // One change to a screen at a time.
    await client.query('select 1 from instances where id = $1 for update', [instanceId])
    const step = handoff(await readControl(client, instanceId), event)
    if (!step.ok) throw new HttpError(409, step.reason)
    switch (step.change) {
      case 'already_held':
        break
      case 'took_over': {
        const row = await one(client, 'the new takeover',
          `insert into screen_takeovers (team_id, instance_id, person_id, session_id, started_at)
           select team_id, id, $2, $3, $4 from instances where id = $1 returning id`,
          [instanceId, person.id, sessionId, step.control.since])
        await noteSessions(client, instanceId, sessionId, ScreenTakeoverId.parse(row.id), 'take', `${person.login} took over the screen`, person.id)
        break
      }
      case 'handed_back':
      case 'left': {
        const row = await one(client, 'the open takeover',
          `update screen_takeovers set ended_at = now(), ended_by = $2 where instance_id = $1 and ended_at is null returning id`,
          [instanceId, step.change])
        await noteSessions(client, instanceId, sessionId, ScreenTakeoverId.parse(row.id), event.kind, endNotice(event, person.login),
          step.change === 'handed_back' ? person.id : null)
        break
      }
    }
    return step.control
  })
  applyControl(instanceId, control)
  return control
}

export async function takeScreen(person: Person, instanceId: string, sessionId: SessionId | null): Promise<ScreenControl> {
  const screen = await watchable(person, instanceId)
  if (!boxes.has(screen.id)) throw new HttpError(409, 'The box is not connected, so nobody can take over its screen.')
  const id = PersonId.parse(person.id)
  return move(screen.id, { kind: 'take', personId: id, login: person.login, at: new Date().toISOString() }, { id, login: person.login }, sessionId)
}

// Handing back runs no watch rule, so a person cut off from a screen they held
// can still give it back. Only its holder can, as the handoff says, and it must
// be a screen of their team's.
export async function handBackScreen(person: Person, instanceId: string, sessionId: SessionId | null): Promise<ScreenControl> {
  const id = InstanceId.safeParse(instanceId)
  const ours = id.success && await maybe(pool, 'select 1 from instances where id = $1 and team_id = $2', [id.data, person.team_id])
  if (!id.success || !ours) throw new HttpError(404, 'no such screen')
  const personId = PersonId.parse(person.id)
  return move(id.data, { kind: 'hand_back', personId }, { id: personId, login: person.login }, sessionId)
}

// Runs the watch rule again for everyone watching a screen, or every screen,
// since work they can't see may have started on the box after they opened it.
// A viewer who may no longer watch is closed, and a screen they held goes back
// to the agent.
export async function recheckViewers(instanceId: InstanceId | null) {
  for (const viewer of [...viewers.values()]) {
    if (instanceId !== null && viewer.instanceId !== instanceId) continue
    const refused = await watchable(viewer.person, viewer.instanceId).then(() => null, (error: unknown) => {
      if (error instanceof HttpError) return error.message
      throw error
    })
    if (refused === null) continue
    viewer.ws.close(ScreenClose.notAllowed, refused)
    const personId = PersonId.parse(viewer.person.id)
    if (holds(controlOf(viewer.instanceId), personId)) {
      await move(viewer.instanceId, { kind: 'left', personId, why: 'not_allowed' }, { id: personId, login: viewer.person.login }, null)
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
  const Open = z.object({ instance_id: InstanceId, person_id: PersonId, login: z.string() })
  const sweep = async () => {
    const teams = await scopedTeams()
    const open = await many(pool,
      `select t.instance_id, t.person_id, p.login from screen_takeovers t join people p on p.id = t.person_id
       where t.ended_at is null and ($1::uuid[] is null or t.team_id = any($1))`, [teams])
    for (const row of open.map((r) => Open.parse(r))) {
      const watching = [...viewers.values()].some((v) => v.instanceId === row.instance_id && v.person.id === row.person_id)
      const since = lastSeen.get(seenKey(row.instance_id, row.person_id)) ?? started
      if (watching || Date.now() - since < SCREEN_GRACE_MS) continue
      await move(row.instance_id, { kind: 'left', personId: row.person_id, why: 'view_closed' }, { id: row.person_id, login: row.login }, null)
    }
    await recheckViewers(null)
  }
  const timer = setInterval(() => {
    // A failed sweep is tried again on the next tick, so it is logged, not fatal.
    sweep().catch((error: unknown) => { console.error('screen sweep:', messageOf(error)) })
  }, SWEEP_MS)
  return () => { clearInterval(timer) }
}

function linkBox(instanceId: InstanceId, ws: WebSocket) {
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
  ws.on('error', (error) => { console.error(`screen control of ${instanceId}:`, error.message) })
  ws.on('close', () => {
    clearInterval(check)
    if (boxes.get(instanceId)?.ws === ws) boxes.delete(instanceId)
  })
  send(ws, { type: 'control', control: controlOf(instanceId) })
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

function watch(person: Person, screen: Watchable, ws: WebSocket) {
  const control = controlOf(screen.id)
  const box = boxes.get(screen.id)
  if (!box) {
    ws.close(ScreenClose.notConnected, 'The box is not connected. It may be stopped.')
    return
  }
  const tunnel = TunnelId.parse(randomUUID())
  const personId = PersonId.parse(person.id)
  const viewer: Viewer = {
    tunnel, instanceId: screen.id, person, ws, filter: new RfbInputFilter(holds(control, personId)), box: null, early: [],
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
  ws.on('error', (error) => { console.error(`screen viewer ${tunnel}:`, error.message) })
  ws.on('close', () => {
    clearTimeout(viewer.waiting)
    viewers.delete(tunnel)
    viewer.box?.close()
    lastSeen.set(seenKey(screen.id, personId), Date.now())
  })
  send(ws, { type: 'control', control })
  send(box.ws, { type: 'open', tunnel })
}

function joinTunnel(viewer: Viewer, ws: WebSocket) {
  clearTimeout(viewer.waiting)
  viewer.box = ws
  keepAlive(ws)
  for (const bytes of viewer.early.splice(0)) ws.send(bytes)
  ws.on('message', (data) => { viewer.ws.send(bytesOf(data), { binary: true }) })
  ws.on('error', (error) => { console.error(`screen tunnel ${viewer.tunnel}:`, error.message) })
  ws.on('close', () => { viewer.ws.close(ScreenClose.boxClosed, 'The box closed the screen.') })
}

// The tunnel a box dials for one viewer, which must be waiting for it.
function waitingViewer(tunnelId: string, instance: Instance): Viewer {
  const tunnel = TunnelId.safeParse(tunnelId)
  const viewer = tunnel.success ? viewers.get(tunnel.data) : undefined
  if (!viewer || viewer.instanceId !== instance.id || viewer.box) throw new HttpError(404, 'no such tunnel')
  return viewer
}

function refuse(socket: Duplex, status: number, message: string) {
  const body = JSON.stringify({ error: message })
  // HTTP allows an empty reason phrase, for a status Node has no name for.
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nconnection: close\r\ncontent-type: application/json\r\n`
    + `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
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
  const accept = (sockets: WebSocketServer, then: (ws: WebSocket) => void) => {
    socket.off('error', onError)
    sockets.handleUpgrade(req, socket, head, then)
  }
  try {
    checkAudience(side.audience, req)
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (side.audience === 'machines') {
      if (path === '/v1/instance/screen') {
        const instance = await instanceFrom(req)
        const id = InstanceId.parse(instance.id)
        await loadControl(id)
        accept(machineSockets, (ws) => { linkBox(id, ws) })
        return
      }
      const tunnel = TUNNEL_PATH.exec(path)?.[1]
      if (!tunnel) throw new HttpError(404, 'no such route')
      const viewer = waitingViewer(tunnel, await instanceFrom(req))
      accept(machineSockets, (ws) => { joinTunnel(viewer, ws) })
      return
    }
    const screenId = VIEWER_PATH.exec(path)?.[1]
    if (!screenId) throw new HttpError(404, 'no such route')
    // A browser sends its page's origin with every WebSocket it opens. A page on
    // another site, open in a teammate's browser, would otherwise watch and take
    // over as them. Host is no help, since the page picks the host it connects to.
    if (!side.origins.has(req.headers.origin ?? '')) throw new HttpError(403, 'Only the app may open a screen.')
    // A browser can't read the status of a refused upgrade, only a close
    // reason, so a person who may not watch gets the socket closed with why.
    const allowed = await (async () => {
      const person = await personFrom(req)
      const screen = await watchable(person, screenId)
      await loadControl(screen.id)
      return { person, screen }
    })().catch((error: unknown) => {
      if (error instanceof HttpError) return { refused: error.message }
      throw error
    })
    accept(peopleSockets, (ws) => {
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
