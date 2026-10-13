// Machines clone and push through the API, as themselves. The API checks that the
// repo is their team's and forwards to the forge with the factory's credentials,
// so forge tokens never leave the server.

import { Readable } from 'node:stream'
import type { ReadableStream as WebReadable } from 'node:stream/web'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { instanceFrom } from './auth.ts'
import { maybe, pool } from './db.ts'
import { gitUpstream } from './forge.ts'
import { HttpError } from './record.ts'

export const GIT_PATH = /^\/v1\/git\/([0-9a-f-]{36})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/
const FORWARDED = ['content-type', 'accept', 'content-encoding', 'git-protocol']
const DROPPED = ['content-encoding', 'content-length', 'transfer-encoding', 'www-authenticate', 'set-cookie']

export async function proxyGit(req: IncomingMessage, res: ServerResponse, url: URL) {
  const instance = await instanceFrom(req)
  const [, repoId, rest] = GIT_PATH.exec(url.pathname) ?? []
  if (!repoId || !rest) throw new HttpError(404, 'no such git path')
  const repo = await maybe<{ remote_url: string }>(pool,
    'select remote_url from repos where id = $1 and team_id = $2', [repoId, instance.team_id])
  if (!repo) throw new HttpError(404, 'no such repo')
  const upstream = gitUpstream(repo.remote_url)
  const headers: Record<string, string> = { authorization: upstream.authorization }
  for (const name of FORWARDED) {
    const value = req.headers[name]
    if (typeof value === 'string') headers[name] = value
  }
  const response = await fetch(`${upstream.url}/${rest}${url.search}`, {
    method: req.method,
    headers,
    body: req.method === 'GET' ? undefined : (Readable.toWeb(req) as ReadableStream),
    duplex: 'half',
  } as RequestInit)
  const out: Record<string, string> = {}
  response.headers.forEach((value, key) => { if (!DROPPED.includes(key)) out[key] = value })
  res.writeHead(response.status, out)
  if (response.body) Readable.fromWeb(response.body as WebReadable).on('error', () => res.end()).pipe(res)
  else res.end()
}
