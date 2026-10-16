// Taking a WebSocket upgrade on the API's machine port. What a route does with
// the socket is its own. What every one needs is the same: errors on the socket
// heard from the first moment, a refusal that answers in JSON, and a handover to
// ws only once the caller has checked who is asking.

import { STATUS_CODES, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebSocket, WebSocketServer } from 'ws'
import { HttpError } from './record.ts'

// Hands the socket to ws. `label` says which socket in the log.
export type Accept = (sockets: WebSocketServer, label: string, then: (ws: WebSocket) => void) => void

export function refuse(socket: Duplex, status: number, message: string) {
  const body = JSON.stringify({ error: message })
  // HTTP allows an empty reason phrase, for a status Node has no name for.
  socket.end(`HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? ''}\r\nconnection: close\r\ncontent-type: application/json\r\n`
    + `content-length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`)
}

// Runs `work` for one upgrade. It calls the `accept` it is given to hand over the
// socket, or throws an HttpError to refuse with its status and words. Never rejects.
export async function takeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, work: (accept: Accept) => Promise<void>): Promise<void> {
  // Node takes its own error listener off a socket before it hands over an
  // upgrade, and ws adds one only once it has the socket. A client that resets
  // the connection in between, while the API looks it up or refuses it, would
  // raise an error nobody hears, which stops the API. The socket is already
  // destroyed when this one hears it, so saying so is all there is to do.
  const onError = (error: Error) => { console.error(`upgrade for ${req.url ?? '/'}: ${error.message}`) }
  socket.on('error', onError)
  const accept: Accept = (sockets, label, then) => {
    socket.off('error', onError)
    sockets.handleUpgrade(req, socket, head, (ws) => {
      // ws raises `error` on a socket for a frame that breaks the protocol, and
      // an `error` nobody hears stops the API.
      ws.on('error', (error) => { console.error(`${label}: ${error.message}`) })
      then(ws)
    })
  }
  try {
    await work(accept)
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    if (status === 500) console.error(error)
    refuse(socket, status, error instanceof HttpError ? error.message : 'internal error')
  }
}
