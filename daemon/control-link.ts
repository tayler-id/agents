// The daemon's control connection to the API's machine port. The API sends what
// must not be stored on the way, such as a secret's value, and the daemon
// answers on the same connection. The daemon dials out and nothing on the
// computer listens for the API. The connection comes back after the API
// restarts or the network drops. The design is "Secrets set from the app" in
// docs/design/target-architecture.md.

import WebSocket from 'ws'
import { LINK_DEAD_MS, LINK_MAX_FRAME_BYTES, LINK_PATH, LINK_PING_MS, LINK_RECONNECT_FIRST_MS, LINK_RECONNECT_MAX_MS, LINK_UNSUPPORTED, ToDaemon, type FromDaemon } from '../shared/link.ts'
import { parseJson } from '../shared/json.ts'
import { bytesOf } from '../shared/websocket.ts'

export type ControlLink = { stop(): void }

// Answers one frame. A frame the daemon cannot act on is answered with a refusal
// that says why, never one that quotes the frame.
export type Hold = (frame: ToDaemon) => FromDaemon

// `hello` is what the daemon tells the API each time the connection opens, or
// null when it has nothing to say.
export function linkControl(config: { api: string; token: string; hold: Hold; hello: () => FromDaemon | null }): ControlLink {
  const url = new URL(LINK_PATH, config.api)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const state: { socket: WebSocket | null; stopping: boolean; reconnectIn: number; failed: boolean } =
    { socket: null, stopping: false, reconnectIn: LINK_RECONNECT_FIRST_MS, failed: false }

  function connect() {
    if (state.stopping) return
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${config.token}` }, maxPayload: LINK_MAX_FRAME_BYTES })
    state.socket = ws
    let heard = Date.now()
    // The API pings, and the socket answers on its own. Hearing nothing for
    // LINK_DEAD_MS means the API is gone, so this one is dropped and made again.
    const watch = setInterval(() => { if (Date.now() - heard > LINK_DEAD_MS) ws.terminate() }, LINK_PING_MS)
    ws.on('open', () => {
      heard = Date.now()
      state.reconnectIn = LINK_RECONNECT_FIRST_MS
      if (state.failed) console.log('control connection to the API is back')
      state.failed = false
      const hello = config.hello()
      if (hello) ws.send(JSON.stringify(hello))
    })
    ws.on('ping', () => { heard = Date.now() })
    ws.on('message', (data, isBinary) => {
      heard = Date.now()
      const frame = isBinary ? null : parseJson(ToDaemon, bytesOf(data).toString('utf8'))
      if (!frame?.ok) {
        // The frame may hold a secret's value, so only why it was refused is logged.
        console.error(`control connection: a frame was refused (${frame ? frame.reason : 'not text'})`)
        ws.close(LINK_UNSUPPORTED, 'the control connection carries the frames of shared/link.ts as JSON text')
        return
      }
      ws.send(JSON.stringify(config.hold(frame.value)))
    })
    // The API may be restarting or the network away. The error is logged once per
    // outage, and the connection is tried again, waiting longer each time.
    ws.on('error', (error) => {
      if (!state.failed) console.error(`control connection to the API failed: ${error.message}. The daemon keeps trying.`)
      state.failed = true
    })
    ws.on('close', () => {
      clearInterval(watch)
      if (state.stopping) return
      setTimeout(connect, state.reconnectIn)
      state.reconnectIn = Math.min(LINK_RECONNECT_MAX_MS, state.reconnectIn * 2)
    })
  }
  connect()

  return {
    stop() {
      state.stopping = true
      state.socket?.terminate()
    },
  }
}
