// Phase 2 groundwork. A container (a box) can reach this Mac only on the machine
// API port: never the people port, where it could pose as a person, nor the
// stream server or Electric. It can reach the public web, since each agent's box
// is its computer and browser. Checks the real running server's ports.
//   npm run check:step2b

import { spawnSync } from 'node:child_process'

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

check(fromContainer(mac(7700)) > 0, 'a container can reach the machine API port')
check(fromContainer(mac(7710), ['Tailscale-User-Login: someone@example.com']) === 0, 'a container cannot reach the people port to pose as someone')
check(fromContainer(mac(4437)) === 0, 'a container cannot reach the live stream server')
check(fromContainer(mac(3000)) === 0, 'a container cannot reach Electric')
check(fromContainer('https://example.com/') === 200, "a container can reach the public web, so an agent's browser works")

console.log(failures.length ? `\n${failures.length} failed` : '\nall passed')
process.exit(failures.length ? 1 : 0)
