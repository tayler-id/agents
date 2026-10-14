// An instance's people door. The API serves people only on a Unix socket, as
// tailscale serve reaches it on the server, and this process stands in for
// serve: it listens on the instance's people port and passes each connection to
// the socket, using the checks' own stand-in. The caller sets
// Tailscale-User-Login on each request, as it plays the person.
//   node ctl/people.ts <port> <socket>

import { z } from 'zod'
import { servePeople } from '../test/people.ts'

const [port, socket] = z.tuple([z.coerce.number().int().min(1).max(65535), z.string().startsWith('/')]).parse(process.argv.slice(2))
await servePeople(port, socket)
console.log(`people on 127.0.0.1:${String(port)}, passed to ${socket}`)
