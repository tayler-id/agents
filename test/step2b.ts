// Phase 2 groundwork. A container (a box) can reach this Mac only on the machine
// API port: never the people port, where it could pose as a person, nor the
// stream server or Electric. Checks the real running server's ports.
//   npm run check:step2b

import { spawnSync } from 'node:child_process'

const failures: string[] = []
function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

// The HTTP status a container gets, or 0 when it cannot connect at all.
function fromContainer(port: number, headers: string[] = []): number {
  const run = spawnSync('docker', ['run', '--rm', 'curlimages/curl:8.11.1', '-s', '-m', '4', '-o', '/dev/null', '-w', '%{http_code}',
    ...headers.flatMap((h) => ['-H', h]), `http://host.docker.internal:${port}/v1/me`], { encoding: 'utf8' })
  return Number(run.stdout.trim()) || 0
}

check(fromContainer(7700) > 0, 'a container can reach the machine API port')
check(fromContainer(7710, ['Tailscale-User-Login: someone@example.com']) === 0, 'a container cannot reach the people port to pose as someone')
check(fromContainer(4437) === 0, 'a container cannot reach the live stream server')
check(fromContainer(3000) === 0, 'a container cannot reach Electric')

console.log(failures.length ? `\n${failures.length} failed` : '\nall passed')
process.exit(failures.length ? 1 : 0)
