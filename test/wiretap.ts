// A pass-through in front of the API that keeps everything that goes through it,
// for checks that a value reached the API once and nowhere else. It records each
// HTTP request the API receives, with its address, headers and body, and each
// answer the API sends, and for a WebSocket the upgrade request and every
// message the client sends, unmasked. A client's frames are masked on the wire,
// so a search of the raw bytes would find nothing in them whatever they held.

import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

export type Heard =
  | { kind: 'request'; method: string; url: string; headers: IncomingHttpHeaders; body: string }
  | { kind: 'response'; url: string; status: number; body: string }
  | { kind: 'upgrade'; url: string; headers: IncomingHttpHeaders }
  // A message the client sent after an upgrade, and the bytes the server sent back.
  | { kind: 'client-message'; url: string; text: string }
  | { kind: 'server-bytes'; url: string; text: string }

// Where the API listens: a port on this machine, or a Unix socket.
export type Target = { port: number } | { socket: string }

export type Tap = { heard: Heard[]; port: number; close: () => Promise<void> }

const connectOptions = (target: Target) => ('port' in target ? { host: '127.0.0.1', port: target.port } : { path: target.socket })

// Calls `onMessage` with the payload of each WebSocket message in the bytes it
// is given, unmasked. A message can arrive over several chunks, and a chunk can
// hold several messages.
function messageReader(onMessage: (text: string) => void): (chunk: Buffer) => void {
  let held = Buffer.alloc(0)
  return (chunk) => {
    held = Buffer.concat([held, chunk])
    for (;;) {
      if (held.length < 2) return
      const masked = ((held[1] ?? 0) & 0x80) !== 0
      let length = (held[1] ?? 0) & 0x7f
      let start = 2
      if (length === 126) {
        if (held.length < 4) return
        length = held.readUInt16BE(2)
        start = 4
      } else if (length === 127) {
        if (held.length < 10) return
        length = Number(held.readBigUInt64BE(2))
        start = 10
      }
      const key = masked ? held.subarray(start, start + 4) : null
      const from = start + (key ? 4 : 0)
      if (held.length < from + length) return
      const payload = Buffer.from(held.subarray(from, from + length))
      if (key) for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (key[i % 4] ?? 0)
      onMessage(payload.toString('utf8'))
      held = held.subarray(from + length)
    }
  }
}

export function tap(port: number, target: Target): Promise<Tap> {
  const heard: Heard[] = []
  const sockets = new Set<Duplex>()
  const server: Server = createServer((req, res) => {
    const url = req.url ?? ''
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      heard.push({ kind: 'request', method: req.method ?? '', url, headers: req.headers, body: body.toString('utf8') })
      const onward = request({ ...connectOptions(target), method: req.method, path: url, headers: req.headers }, (back: IncomingMessage) => {
        const replies: Buffer[] = []
        res.writeHead(back.statusCode ?? 502, back.headers)
        back.on('data', (chunk: Buffer) => { replies.push(chunk); res.write(chunk) })
        back.on('end', () => {
          heard.push({ kind: 'response', url, status: back.statusCode ?? 502, body: Buffer.concat(replies).toString('utf8') })
          res.end()
        })
        back.on('error', () => { res.destroy() })
      })
      onward.on('error', () => { res.writeHead(502).end() })
      res.on('close', () => { onward.destroy() })
      onward.end(body)
    })
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    const url = req.url ?? ''
    heard.push({ kind: 'upgrade', url, headers: req.headers })
    const onward: Socket = connect(connectOptions(target))
    const end = () => { client.destroy(); onward.destroy() }
    // An HTTP server keeps a socket half open after its client ends it, so an end
    // is passed on the way a close is. Without this the API would hear nothing of
    // a daemon that stopped until it next wrote to it.
    for (const side of [client, onward]) for (const event of ['error', 'end', 'close']) side.on(event, end)
    const read = messageReader((text) => { heard.push({ kind: 'client-message', url, text }) })
    const lines = [`${req.method ?? 'GET'} ${url} HTTP/${req.httpVersion}`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i] ?? ''}: ${req.rawHeaders[i + 1] ?? ''}`)
    onward.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length) {
      read(head)
      onward.write(head)
    }
    client.on('data', (chunk: Buffer) => { read(chunk); onward.write(chunk) })
    onward.on('data', (chunk: Buffer) => { heard.push({ kind: 'server-bytes', url, text: chunk.toString('utf8') }); client.write(chunk) })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve({
        heard, port,
        close: () => new Promise<void>((done) => {
          for (const socket of sockets) socket.destroy()
          server.close(() => { done() })
        }),
      })
    })
  })
}
