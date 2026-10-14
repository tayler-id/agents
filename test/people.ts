// Stands in for tailscale serve in checks. The API serves people only on a Unix
// socket, and browsers and fetch reach it through this loopback port. Real serve
// sets Tailscale-User-Login from Tailscale. Here the check sets it on each
// request, as it is the one playing the person.

import { connect, createServer, type Server } from 'node:net'

export function servePeople(port: number, socket: string): Promise<Server> {
  const server = createServer((client) => {
    const api = connect(socket)
    // Either side failing ends both. The check sees the failed request.
    const end = () => { client.destroy(); api.destroy() }
    client.on('error', end)
    api.on('error', end)
    client.pipe(api).pipe(client)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server) })
  })
}
