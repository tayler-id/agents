// Tells an agent's tools whether a file holds a secret this machine keeps. The API
// scrubs with its own environment and fixed patterns, and never sees the secrets
// an agent can reach: this machine's environment, the plugins' secrets.json, its
// owner's Claude token, the login shell's values, and the .env files in the
// agent's folder. Only the daemon knows them, so a tool asks it before sharing a
// file. The socket is in the daemon's run folder, which only this user can open.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { isAbsolute } from 'node:path'
import { MAX_ATTACHMENT_BYTES } from '../shared/attachments.ts'
import { readBody } from '../shared/body.ts'
import { messageOf } from '../shared/errors.ts'
import { secretsIn } from '../shared/secret-scan.ts'
import { listenOnSocket } from '../shared/socket.ts'
import { dotenvFinder, dotenvSecrets, type Secrets } from './secrets.ts'

export const shareGuardPath = (home: string) => join(home, 'run', 'share-guard.sock')

class Refused extends Error {}

// Serves the guard until the signal aborts. Failing to serve is reported, and the daemon goes on: a tool that
// can't reach the guard shares nothing.
export function serveShareGuard({ socket, secrets, signal }: { socket: string; secrets: () => Secrets; signal: AbortSignal }): void {
  const find = dotenvFinder()
  const server = createServer((req, res) => {
    answer(req, res).catch((error: unknown) => { console.error(`share guard: ${messageOf(error)}`) })
  })
  async function answer(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? '/', 'http://guard')
      if (req.method !== 'POST' || url.pathname !== '/scan') throw new Refused('the guard answers POST /scan')
      const root = url.searchParams.get('root') ?? ''
      if (!isAbsolute(root)) throw new Refused('root must be the folder the agent works in')
      const bytes = await readBody(req, MAX_ATTACHMENT_BYTES, () => new Refused('that file is over 25 MB'))
      const names = secretsIn(bytes, [...secrets(), ...dotenvSecrets(find(root))])
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ names }))
    } catch (error) {
      if (!(error instanceof Refused)) throw error
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message }))
    }
  }
  listenOnSocket(server, socket).then(() => {
    if (signal.aborted) server.close()
  }, (error: unknown) => { console.error(`share guard at ${socket}: ${messageOf(error)}. Agents on this machine can't share files.`) })
  signal.addEventListener('abort', () => { server.close() }, { once: true })
}
