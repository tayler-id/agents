// The API's end of each daemon's control connection (shared/link.ts). A daemon
// dials /v1/instance/control on the machine port with its token and keeps the
// connection open. The API sends it what must not be stored on the way, such as
// a secret's value, and waits for its answer. Nothing here keeps a frame: a
// value is in memory from the request that carries it until the socket has sent
// it, and no queue holds one for a computer that is away.

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { checkAudience, instanceFrom } from './auth.ts'
import { pool } from './db.ts'
import { HttpError } from './record.ts'
import { takeUpgrade } from './upgrade.ts'
import { FromDaemon, LINK_ANSWER_MS, LINK_DEAD_MS, LINK_MAX_FRAME_BYTES, LINK_PATH, LINK_PING_MS, LINK_UNSUPPORTED, type ToDaemon } from '../shared/link.ts'
import { parseJson } from '../shared/json.ts'
import { InstanceId } from '../shared/onboarding.ts'
import { messageOf } from '../shared/errors.ts'
import { bytesOf } from '../shared/websocket.ts'

// A computer's answer to a frame, which names the frame it answers.
export type Answer = Extract<FromDaemon, { id: string }>

// A frame sent and not yet answered, and how to finish waiting for it.
type Waiting = { settle: (outcome: Answer | HttpError) => void }
export type Link = { ws: WebSocket; waiting: Map<string, Waiting> }

const sockets = new WebSocketServer({ noServer: true, maxPayload: LINK_MAX_FRAME_BYTES })
const links = new Map<InstanceId, Link>()
// What waits for a computer's connection to come up, by computer.
const arrivals = new Map<InstanceId, Set<() => void>>()

// The computer says which secrets it holds. A secret the record says was set on
// it and it no longer holds is not set, so the app does not say it is.
function forgetUnheld(instanceId: InstanceId, held: string[]) {
  pool.query('delete from secret_sets where instance_id = $1 and not (name = any($2))', [instanceId, held])
    .catch((error: unknown) => { console.error(`control connection of ${instanceId}: could not compare the secrets it holds: ${messageOf(error)}`) })
}

function join(instanceId: InstanceId, ws: WebSocket) {
  // A daemon that reconnects replaces its old connection, which may be half open.
  links.get(instanceId)?.ws.terminate()
  const link: Link = { ws, waiting: new Map() }
  links.set(instanceId, link)
  let heard = Date.now()
  const watch = setInterval(() => {
    if (Date.now() - heard > LINK_DEAD_MS) ws.terminate()
    else ws.ping()
  }, LINK_PING_MS)
  ws.on('pong', () => { heard = Date.now() })
  ws.on('message', (data, isBinary) => {
    heard = Date.now()
    const frame = isBinary ? null : parseJson(FromDaemon, bytesOf(data).toString('utf8'))
    if (!frame?.ok) {
      // A frame from a computer holds names and reasons, but is not echoed.
      console.error(`control connection of ${instanceId}: a frame was refused (${frame ? frame.reason : 'not text'})`)
      ws.close(LINK_UNSUPPORTED, 'the control connection carries the frames of shared/link.ts as JSON text')
      return
    }
    if (frame.value.type === 'secrets_held') {
      forgetUnheld(instanceId, frame.value.names)
      return
    }
    // An answer to a frame nobody waits for any more, such as one that timed out, is dropped.
    link.waiting.get(frame.value.id)?.settle(frame.value)
  })
  ws.on('close', () => {
    clearInterval(watch)
    if (links.get(instanceId) === link) links.delete(instanceId)
    for (const waiting of [...link.waiting.values()]) waiting.settle(new HttpError(409, 'The computer closed its connection before it answered.'))
  })
  for (const wake of [...(arrivals.get(instanceId) ?? [])]) wake()
}

// Takes an upgrade to the control path, and says whether it was one. The caller
// passes any other upgrade on.
export function controlUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  if (new URL(req.url ?? '/', 'http://localhost').pathname !== LINK_PATH) return false
  void takeUpgrade(req, socket, head, async (accept) => {
    checkAudience('machines', req)
    const id = InstanceId.parse((await instanceFrom(req)).id)
    accept(sockets, `control connection of ${id}`, (ws) => { join(id, ws) })
  })
  return true
}

// The computer's connection if it is up.
export const linkOf = (instanceId: InstanceId): Link | undefined => links.get(instanceId)

// The computer's connection, waiting up to `ms` for it to come up, or undefined.
export function waitForLink(instanceId: InstanceId, ms: number): Promise<Link | undefined> {
  const present = links.get(instanceId)
  if (present) return Promise.resolve(present)
  return new Promise((resolve) => {
    const waiting = arrivals.get(instanceId) ?? new Set<() => void>()
    arrivals.set(instanceId, waiting)
    const done = (link: Link | undefined) => {
      clearTimeout(timer)
      waiting.delete(wake)
      if (!waiting.size) arrivals.delete(instanceId)
      resolve(link)
    }
    const wake = () => { done(links.get(instanceId)) }
    const timer = setTimeout(() => { done(undefined) }, ms)
    waiting.add(wake)
  })
}

// Sends one frame and waits for the answer that names it. The frame is not kept.
function exchange(link: Link, frame: ToDaemon): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const settle = (outcome: Answer | HttpError) => {
      clearTimeout(timer)
      link.waiting.delete(frame.id)
      if (outcome instanceof HttpError) reject(outcome)
      else resolve(outcome)
    }
    const timer = setTimeout(() => { settle(new HttpError(409, 'The computer did not answer in time. Try again.')) }, LINK_ANSWER_MS)
    link.waiting.set(frame.id, { settle })
    link.ws.send(JSON.stringify(frame), (error) => {
      // The socket closed before the frame went out. Nothing on the computer changed.
      if (error) settle(new HttpError(409, 'The computer closed its connection before it took the request. Try again.'))
    })
  })
}

export const putOnComputer = (link: Link, name: string, value: string) =>
  exchange(link, { type: 'secret_put', id: randomUUID(), name, value })

export const removeFromComputer = (link: Link, name: string) =>
  exchange(link, { type: 'secret_remove', id: randomUUID(), name })
