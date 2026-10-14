// Live tokens. Each session has one durable stream that its machine appends
// tokens to while the agent types. People who can see the session read it live.
// Tokens never touch Postgres; the finished message lands there as one event.
// The stream server listens on loopback, and only this proxy talks to it.

import { Readable } from 'node:stream'
import type { ReadableStream as WebReadable } from 'node:stream/web'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DurableStreamTestServer } from '@durable-streams/server'
import { instanceFrom, personFrom } from './auth.ts'
import { pool } from './db.ts'
import type { Audience } from './http.ts'
import { HttpError } from './record.ts'
import { canSeeSession } from './access.ts'

const PORT = Number(process.env.AGENTS_STREAMS_PORT ?? 4437)
const DATA_DIR = process.env.AGENTS_STREAMS_DIR ?? join(homedir(), '.agents-app', 'streams')
const ORIGIN = `http://127.0.0.1:${PORT}`
// Request headers the stream protocol uses. Everything else stays at the proxy.
const FORWARDED = ['content-type', 'stream-ttl', 'stream-expires-at', 'stream-seq', 'stream-closed',
  'producer-id', 'producer-epoch', 'producer-seq', 'if-match', 'last-event-id', 'accept']

export async function startStreamServer() {
  const server = new DurableStreamTestServer({ port: PORT, host: '127.0.0.1', dataDir: DATA_DIR, compression: false })
  await server.start()
  return server
}

// A machine may write its own sessions' streams. A person may read the streams of
// sessions they can see, and nothing else.
export async function proxyStream(req: IncomingMessage, res: ServerResponse, sessionId: string, url: URL, audience: Audience) {
  const reading = req.method === 'GET' || req.method === 'HEAD'
  if (audience === 'machines') {
    const instance = await instanceFrom(req)
    const { rows } = await pool.query('select 1 from sessions where id = $1 and instance_id = $2', [sessionId, instance.id])
    if (!rows[0]) throw new HttpError(404, 'no such session on this instance')
  } else {
    if (!reading) throw new HttpError(403, 'people can only read live streams')
    if (!(await canSeeSession(await personFrom(req), sessionId))) throw new HttpError(404, 'no such session')
  }

  const headers: Record<string, string> = {}
  for (const name of FORWARDED) {
    const value = req.headers[name]
    if (typeof value === 'string') headers[name] = value
  }
  const abort = new AbortController()
  res.on('close', () => abort.abort())
  const upstream = await fetch(`${ORIGIN}/sessions/${sessionId}${url.search}`, {
    method: req.method,
    headers,
    body: reading ? undefined : (Readable.toWeb(req) as ReadableStream),
    duplex: 'half',
    signal: abort.signal,
  } as RequestInit).catch((error: unknown) => {
    if (abort.signal.aborted) return null
    throw error
  })
  if (!upstream) return
  const out: Record<string, string> = {}
  upstream.headers.forEach((value, key) => {
    if (key !== 'content-encoding' && key !== 'content-length' && key !== 'transfer-encoding') out[key] = value
  })
  res.writeHead(upstream.status, out)
  if (upstream.body && req.method !== 'HEAD') {
    Readable.fromWeb(upstream.body as WebReadable).on('error', () => res.end()).pipe(res)
  } else {
    res.end()
  }
}
