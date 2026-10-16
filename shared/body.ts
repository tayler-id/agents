// A request's body, read whole, for the API and the daemon's app socket. A body
// larger than `limit` bytes fails with the error `tooLarge` makes, as soon as it
// passes the limit, so no more of it is held.

import type { IncomingMessage } from 'node:http'

export async function readBody(req: IncomingMessage, limit: number, tooLarge: () => Error): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk)) throw new Error('a request body arrived as something other than bytes')
    size += chunk.length
    if (size > limit) throw tooLarge()
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
