// A message from the `ws` library as bytes. With its default settings a message
// is one Buffer, but the type also allows an ArrayBuffer or a list of fragments.

import type { RawData } from 'ws'

export const bytesOf = (data: RawData): Buffer =>
  Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
