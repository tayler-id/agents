// Unix sockets only this user can open: the API's people socket and the daemon's
// app socket listen with `listenOnSocket`, and `accepts` tells a running server's
// socket from one a stopped server left behind.

import { once } from 'node:events'
import { chmod, lstat, mkdir, rm, stat } from 'node:fs/promises'
import { connect, type Server } from 'node:net'
import { userInfo } from 'node:os'
import { dirname } from 'node:path'
import { hasCode } from './errors.ts'

// macOS cuts a Unix socket's path at this many bytes, so a server would listen where no client looks for it.
export const LONGEST_SOCKET_PATH = 103

// Why a socket can't be served at this path, or null when it can.
export const socketPathProblem = (path: string): string | null =>
  (Buffer.byteLength(path) > LONGEST_SOCKET_PATH ? `its path is longer than the ${String(LONGEST_SOCKET_PATH)} bytes macOS allows` : null)

// Whether something accepts connections on the Unix socket at this path. A
// socket file left by a server that stopped refuses them. Any other failure, such
// as a missing file, is the caller's to handle.
export function accepts(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = connect(path)
    probe.once('connect', () => { probe.destroy(); resolve(true) })
    probe.once('error', (error) => { if (hasCode(error, 'ECONNREFUSED')) resolve(false); else reject(error) })
  })
}

// Listens on a socket at `path` that only this user can open. A server that
// stops without closing its socket leaves the file behind, and it refuses
// connections, so it is replaced. A socket that accepts them belongs to a running
// server, and taking it over would send that server's clients here, so that
// stops this one, and so does anything at the path that isn't a socket. A path
// macOS would cut is refused before anything is made.
export async function listenOnSocket(server: Server, path: string): Promise<void> {
  const problem = socketPathProblem(path)
  if (problem) throw new Error(problem)
  // The folder may not exist yet. Made here, only its owner can open it.
  const folder = dirname(path)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  // Another user who could write to the folder could put their own socket in its place.
  const owner = await stat(folder)
  if (owner.uid !== userInfo().uid || (owner.mode & 0o022) !== 0) {
    throw new Error(`${folder} must belong to this user and be writable by no one else, since the socket ${path} is in it`)
  }
  const existing = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return null
    throw error
  })
  if (existing && !existing.isSocket()) throw new Error(`${path} is not a socket, so it is left as it is`)
  if (existing && await accepts(path)) throw new Error(`a running server already accepts connections on ${path}`)
  if (existing) await rm(path)
  // The socket file appears when listen binds, which it does before returning, so
  // the umask keeps it private from its first moment.
  const umask = process.umask(0o077)
  try {
    server.listen(path)
  } finally {
    process.umask(umask)
  }
  await once(server, 'listening')
  await chmod(path, 0o600)
}
