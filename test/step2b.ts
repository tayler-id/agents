// Phase 2 groundwork. A container (a box) can reach this Mac only on the machine
// API port. It cannot reach tailscaled's proxy, through which it could reach
// serve as this Mac and so as its owner, nor the stream server or Electric.
// People reach the API on a Unix socket, which no container can reach. A
// container can reach the public web, since each agent's box is its computer
// and browser. Checks the real running server's ports.
//   npm run check:step2b

import { spawnSync } from 'node:child_process'
import { connect } from 'node:net'

const failures: string[] = []
function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

// The HTTP status a container gets, or 0 when it cannot connect at all.
function fromContainer(url: string, headers: string[] = []): number {
  const run = spawnSync('docker', ['run', '--rm', 'curlimages/curl:8.11.1', '-s', '-m', '4', '-o', '/dev/null', '-w', '%{http_code}',
    ...headers.flatMap((h) => ['-H', h]), url], { encoding: 'utf8' })
  return Number(run.stdout.trim()) || 0
}
const mac = (port: number) => `http://host.docker.internal:${port}/v1/me`

// Whether something on this Mac accepts connections on the port. A container
// failing to reach a port proves nothing when nothing listens there.
function listensHere(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { resolve(false) })
  })
}

check(fromContainer(mac(7700)) > 0, 'a container can reach the machine API port')
check(await listensHere(1055) && fromContainer(mac(1055)) === 0,
  "a container cannot reach tailscaled's proxy on 1055, which would let it reach serve as this Mac's owner")
check(await listensHere(4437) && fromContainer(mac(4437)) === 0, 'a container cannot reach the live stream server')
check(await listensHere(3000) && fromContainer(mac(3000)) === 0, 'a container cannot reach Electric')
check(fromContainer('https://example.com/') === 200, "a container can reach the public web, so an agent's browser works")

console.log(failures.length ? `\n${failures.length} failed` : '\nall passed')
process.exit(failures.length ? 1 : 0)
