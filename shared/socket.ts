// Whether something accepts connections on the Unix socket at this path. A
// socket file left by an API that stopped refuses them. Any other failure, such
// as a missing file, is the caller's to handle.

import { connect } from 'node:net'
import { hasCode } from './errors.ts'

export function accepts(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = connect(path)
    probe.once('connect', () => { probe.destroy(); resolve(true) })
    probe.once('error', (error) => { if (hasCode(error, 'ECONNREFUSED')) resolve(false); else reject(error) })
  })
}
