// The Unix socket the Agents app on this Mac reaches its daemon through, so a
// person connects their folders from the app, with no command to type. It lists
// the folders Claude Code ran in on this Mac and the ones connected here, and
// connects, changes or disconnects one with the folders command's own
// functions. Only this macOS user can open it: it sits in a folder of its own
// with mode 0700, and is 0600 itself. The names of folders that aren't
// connected go to the app on this Mac and nowhere else. desktop/main.cjs is
// its client, and docs/design/local-sessions.md the design.

import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { messageOf } from '../shared/errors.ts'
import {
  AppConnect, DisconnectFolder, insideFolder, type AppConnected, type AppRefusal, type FolderAnswer, type MacFolder, type MacFolders,
} from '../shared/terminal.ts'
import { ApiError, type Api } from './api.ts'
import { connectedFolders, connectFolder, disconnectFolder, FolderRefused } from './folders.ts'
import { claudeFolders } from './transcripts.ts'

// In a folder of its own in the daemon's home. desktop/main.cjs looks for it there.
export const appSocketPath = (home: string) => join(home, 'run', 'app.sock')
// macOS cuts a socket's path at this many bytes, so the app would look for it where it isn't.
const LONGEST_SOCKET_PATH = 103
// The app sends a folder's path and one word, so a body larger than this is a mistake.
const MAX_BODY_BYTES = 64 * 1024

// The system's temporary folders, where tools and checks start Claude Code by
// the hundred, so the app sets them apart. /var/folders holds each macOS user's own.
const TEMPORARY = ['/tmp', '/var/folders', tmpdir()].filter((path) => existsSync(path)).map((path) => realpathSync.native(path))
const temporary = (path: string) => TEMPORARY.some((root) => insideFolder(root, path))

// An ask the socket can't answer as it stands.
class BadAsk extends Error {
  readonly status: 400 | 404 | 413
  constructor(status: 400 | 404 | 413, message: string) {
    super(message)
    this.status = status
  }
}

// Serves the socket until the signal aborts. A socket that can't be served is
// reported, and the rest of the daemon goes on without it.
export function serveAppSocket({ home, api, signal }: { home: string; api: Api; signal: AbortSignal }): void {
  const socket = appSocketPath(home)
  const unserved = (why: string) => { console.error(`app socket ${socket}: ${why}. The Agents app on this Mac can't reach the daemon.`) }
  try {
    if (Buffer.byteLength(socket) > LONGEST_SOCKET_PATH) throw new Error(`its path is longer than the ${LONGEST_SOCKET_PATH} bytes macOS allows`)
    mkdirSync(dirname(socket), { recursive: true, mode: 0o700 })
    // A folder made before with another mode gets this one. One that isn't this user's can't be changed, and stops it here.
    chmodSync(dirname(socket), 0o700)
    // A socket left by a daemon that stopped without closing it.
    rmSync(socket, { force: true })
  } catch (error) {
    unserved(messageOf(error))
    return
  }
  const server = createServer((req, res) => {
    answer(req, res).catch((error: unknown) => { console.error(`app socket: answering ${req.method ?? ''} ${req.url ?? ''}: ${messageOf(error)}`) })
  })
  server.on('error', (error) => { unserved(error.message) })
  server.listen(socket, () => {
    try {
      chmodSync(socket, 0o600)
      console.log(`app socket at ${socket}`)
    } catch (error) {
      unserved(messageOf(error))
      server.close()
    }
  })
  signal.addEventListener('abort', () => { server.close() }, { once: true })

  async function answer(req: IncomingMessage, res: ServerResponse) {
    const [status, body] = await reply(req).then((body): [number, unknown] => [200, body], refusal)
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  }

  async function reply(req: IncomingMessage): Promise<MacFolders | AppConnected | FolderAnswer> {
    const route = `${req.method ?? ''} ${req.url ?? ''}`
    if (route === 'GET /folders') return listFolders(home, api)
    if (route === 'POST /folders/connect') {
      const ask = AppConnect.parse(await readJson(req))
      const { path, ...connected } = await connectFolder(api, ask.path, ask.visibility)
      return connected
    }
    if (route === 'POST /folders/disconnect') {
      const { path, ...answer } = await disconnectFolder(api, DisconnectFolder.parse(await readJson(req)).path)
      return answer
    }
    throw new BadAsk(404, `the daemon has no ${route}`)
  }
}

// This Mac's folders: the ones Claude Code ran in, and the ones connected here,
// each with how many of its sessions in the record the team can't see now,
// newest first. Two used at the same moment go in order of their paths.
async function listFolders(home: string, api: Api): Promise<MacFolders> {
  const { instanceId, folders: connected, hiddenSessions } = await connectedFolders(api)
  // Only a private folder hides sessions from the team. A folder this Mac never connected has none in the record.
  const hidden = (path: string) => hiddenSessions[path] ?? 0
  const rows = new Map<string, MacFolder>()
  for (const used of claudeFolders(realpathSync.native(home))) {
    rows.set(used.path, { path: used.path, temporary: temporary(used.path), usedAt: used.usedAt.toISOString(), folder: null, hiddenSessions: hidden(used.path) })
  }
  for (const folder of connected) {
    const used = rows.get(folder.path)
    rows.set(folder.path, { path: folder.path, temporary: temporary(folder.path), usedAt: used?.usedAt ?? null, folder, hiddenSessions: hidden(folder.path) })
  }
  const newest = (row: MacFolder) => Date.parse(row.folder === null ? row.usedAt : row.usedAt ?? row.folder.connected_at)
  const folders = [...rows.values()].sort((a, b) => newest(b) - newest(a) || a.path.localeCompare(b.path))
  return { instanceId, home: realpathSync.native(homedir()), folders }
}

// What the app is told when nothing changed, with the words it shows.
function refusal(error: unknown): [number, AppRefusal] {
  if (error instanceof BadAsk) return [error.status, { error: error.message }]
  if (error instanceof z.ZodError) return [400, { error: z.prettifyError(error) }]
  if (error instanceof FolderRefused) return [error.kind === 'usage' ? 400 : 409, { error: error.message }]
  // The team's server failed, or Node's fetch could not reach it, which it reports as a TypeError of this message.
  if (error instanceof ApiError || (error instanceof TypeError && error.message === 'fetch failed')) {
    return [502, { error: `The team's server did not answer: ${messageOf(error)}` }]
  }
  console.error(`app socket: ${messageOf(error)}`)
  return [500, { error: messageOf(error) }]
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    // Past the limit the rest is read and dropped, so the answer still reaches the app.
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) reject(new BadAsk(413, `an ask of the daemon is at most ${MAX_BODY_BYTES} bytes`))
      else chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new BadAsk(400, `the ask is not JSON: ${messageOf(error)}`))
      }
    })
    req.on('error', reject)
  })
}
