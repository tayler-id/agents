// The image the firewall checks run their stand-ins in: Node, iptables and
// iproute2. It is named for its Dockerfile, so it is built once and kept.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const LAB_DOCKERFILE = `FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends iptables iproute2 && rm -rf /var/lib/apt/lists/*
`
export const LAB = `agents-aws-netlab:${createHash('sha256').update(LAB_DOCKERFILE).digest('hex').slice(0, 12)}`

// Builds the image unless it is there, on the host's network, so a firewall on
// Docker's bridge, like the box host's, cannot stop the build's downloads.
export function ensureLab(): void {
  if (execFileSync('docker', ['image', 'ls', '--quiet', LAB], { encoding: 'utf8' }).trim() !== '') return
  execFileSync('docker', ['build', '--network', 'host', '-t', LAB, '-'], { input: LAB_DOCKERFILE, stdio: ['pipe', 'ignore', 'inherit'] })
}
