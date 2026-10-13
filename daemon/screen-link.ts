// The box's outbound connections to the API's machine port for its screen. One
// control connection carries who holds the screen and asks for tunnels, and
// each tunnel joins one person's Screen view to Xvnc's socket. Nothing in the
// box listens for the API. The design is docs/design/computers.md.

import { connect } from 'node:net'
import { pipeline } from 'node:stream'
import WebSocket, { createWebSocketStream } from 'ws'
import { FromBox, SCREEN_DEAD_MS, SCREEN_PING_MS, ToBox, type ScreenControl } from '../shared/screen.ts'
import { parseJson } from '../shared/json.ts'
import { bytesOf } from '../shared/websocket.ts'
import type { TunnelId } from '../shared/ids.ts'

const RECONNECT_FIRST_MS = 1_000
const RECONNECT_MAX_MS = 30_000

export type ScreenLink = { stop(): void }

export function linkScreen(config: { api: string; token: string; vncSocket: string; onControl: (control: ScreenControl) => void }): ScreenLink {
  const base = new URL(config.api)
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  const headers = { authorization: `Bearer ${config.token}` }
  const tunnels = new Set<WebSocket>()
  const state: { control: WebSocket | null; stopping: boolean; reconnectIn: number } = { control: null, stopping: false, reconnectIn: RECONNECT_FIRST_MS }

  function openTunnel(tunnel: TunnelId) {
    const ws = new WebSocket(new URL(`/v1/instance/screen/tunnels/${tunnel}`, base), { headers })
    tunnels.add(ws)
    ws.on('close', () => tunnels.delete(ws))
    ws.on('error', (error) => { console.error(`screen tunnel ${tunnel}:`, error.message) })
    ws.on('open', () => {
      const vnc = connect(config.vncSocket)
      const stream = createWebSocketStream(ws)
      // A viewer closing its tab ends the tunnel, which is the usual way. Either
      // side ending, for any reason, ends both.
      const end = () => { vnc.destroy(); ws.terminate() }
      pipeline(vnc, stream, end)
      pipeline(stream, vnc, end)
    })
  }

  function connectControl() {
    if (state.stopping) return
    const ws = new WebSocket(new URL('/v1/instance/screen', base), { headers })
    state.control = ws
    let heard = Date.now()
    const pinger = setInterval(() => {
      if (Date.now() - heard > SCREEN_DEAD_MS) {
        ws.terminate()
        return
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(FromBox.parse({ type: 'ping' })))
    }, SCREEN_PING_MS)
    ws.on('open', () => { state.reconnectIn = RECONNECT_FIRST_MS })
    ws.on('message', (data, isBinary) => {
      heard = Date.now()
      const message = isBinary ? null : parseJson(ToBox, bytesOf(data).toString('utf8'))
      if (!message?.ok) {
        ws.close(1003, message ? `not understood: ${message.reason}` : 'the control connection carries JSON text only')
        return
      }
      const body = message.value
      switch (body.type) {
        case 'control': config.onControl(body.control); return
        case 'open': openTunnel(body.tunnel); return
        case 'pong': return
      }
    })
    // The API may be restarting or the network away. The box keeps the control it
    // last heard about and tries again, waiting longer each time.
    ws.on('error', (error) => { console.error('screen control:', error.message) })
    ws.on('close', () => {
      clearInterval(pinger)
      if (state.stopping) return
      setTimeout(connectControl, state.reconnectIn)
      state.reconnectIn = Math.min(RECONNECT_MAX_MS, state.reconnectIn * 2)
    })
  }
  connectControl()

  return {
    stop() {
      state.stopping = true
      state.control?.terminate()
      for (const tunnel of tunnels) tunnel.terminate()
    },
  }
}
