// AWS step 11g: the firewall in colima's VM on this Mac, ops/box-firewall.sh,
// checked in a copy of the VM's network made of containers, since the live VM
// runs the live system.
//
// A container with NET_ADMIN stands in for the VM. Its box-facing interface is
// renamed docker0, it forwards and masquerades as Docker does, its FORWARD chain
// jumps to DOCKER-USER as Docker's does, it publishes a port of the box with
// DNAT, and it answers DNS, as the VM's forwarder answers boxes. Beside it stand
// this Mac, with the live API's machine port, the checks' one and the people
// port, a peer on a private network, and a service on Compose's network.
//
// Before the script a box reaches all of them. After, it still opens public
// websites, gets DNS answers from the VM and reaches the Mac's two machine
// ports, and reaches nothing else. A client on the private network still opens a
// connection to the port published from the box, the VM still opens one to the
// box, and the VM still reaches everything the box cannot. A Compose service
// keeps all it reached except the Mac's other ports. A second run changes
// nothing, and the script's ranges are BOX_CLOSED_RANGES.
//   node --env-file=.env --env-file=.env.test test/step11g.ts
// The stand-ins run test/step11c.ts's serve and probe. The check needs the
// internet. It does not cover traffic between two boxes on docker0.

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { BOX_CLOSED_RANGES, BOX_DNS } from '../ops/aws/config.ts'
import { ensureLab, LAB } from './netlab.ts'

const ROOT = new URL('..', import.meta.url).pathname
const SCRIPT = readFileSync(new URL('../ops/box-firewall.sh', import.meta.url), 'utf8')
// The address the script names for this Mac as colima's VM sees it.
const SCRIPT_MAC = '192.168.5.2'
// The copy has addresses of its own, since the real VM routes colima's 192.168.5.0/24.
const VM = '192.168.77.1'
const MAC = '192.168.77.2'
// The way out of the VM's network, to the internet.
const LIMA_GATEWAY = '192.168.77.254'
const VM_ON_BOXES = '172.29.114.2'
const BOX = '172.29.114.3'
const CORP_PEER = '10.77.0.10'
const VM_ON_CORP = '10.77.0.2'
const VM_ON_COMPOSE = '172.31.77.2'
const COMPOSE_SERVICE = '172.31.77.10'
const COMPOSE_CLIENT = '172.31.77.20'
// The port the VM publishes for the box's port 9, as Docker publishes a port.
const PUBLISHED = 8080
const NETWORKS = { lima: '192.168.77.0/24', boxes: '172.29.114.0/24', corp: '10.77.0.0/24', compose: '172.31.77.0/24' } as const
const Reach = z.enum(['open', 'answers', 'blocked', 'refused'])
type Reach = z.infer<typeof Reach>
const Reaches = z.record(z.string(), Reach)
const [FIRST_DNS] = BOX_DNS

type Source = 'box' | 'compose'
type Stage = 'before' | 'after'
// What a source reaches at each target, before the script, and after.
const TARGETS: Record<Source, Record<string, { label: string } & Record<Stage, Reach>>> = {
  box: {
    'web:https://example.com/': { label: 'a public website, example.com', before: 'open', after: 'open' },
    [`dns:${VM}:box.test`]: { label: "the VM's DNS forwarder", before: 'answers', after: 'answers' },
    [`tcp:${MAC}:7700`]: { label: "this Mac's machine port", before: 'open', after: 'open' },
    [`tcp:${MAC}:7701`]: { label: "this Mac's port for checks' APIs", before: 'open', after: 'open' },
    [`tcp:${MAC}:7710`]: { label: 'another port on this Mac', before: 'open', after: 'blocked' },
    [`tcp:${VM}:9`]: { label: 'another port on the VM', before: 'open', after: 'blocked' },
    [`tcp:${CORP_PEER}:80`]: { label: 'a peer on a private network', before: 'open', after: 'blocked' },
    [`tcp:${COMPOSE_SERVICE}:5432`]: { label: 'a service on another Docker network, as Compose runs Postgres', before: 'open', after: 'blocked' },
  },
  compose: {
    'web:https://example.com/': { label: 'a public website, example.com', before: 'open', after: 'open' },
    [`tcp:${MAC}:7700`]: { label: "this Mac's machine port", before: 'open', after: 'open' },
    [`tcp:${MAC}:7710`]: { label: 'another port on this Mac', before: 'open', after: 'blocked' },
    [`tcp:${CORP_PEER}:80`]: { label: 'a peer on a private network', before: 'open', after: 'open' },
  },
}
const WHO: Record<Source, string> = { box: 'a box', compose: 'a Compose service' }
const WHEN: Record<Stage, string> = { before: 'before the script', after: 'with it' }
const VERB: Record<Reach, string> = { open: 'reaches', answers: 'gets answers from', blocked: 'cannot reach', refused: 'is refused by' }

// The script's text for the copy: the address it names for the Mac, swapped for
// the copy's. It must appear once, so nothing else changes.
function scriptForCopy(): string {
  const found = SCRIPT.split(SCRIPT_MAC).length - 1
  if (found !== 1) throw new Error(`ops/box-firewall.sh names ${SCRIPT_MAC} ${String(found)} times, and this check swaps exactly one`)
  return SCRIPT.replace(SCRIPT_MAC, MAC)
}

// The ranges the script drops, read from its RANGES line.
function scriptRanges(): string[] {
  const line = SCRIPT.split('\n').find((text) => text.startsWith('RANGES='))
  return (line ?? '').slice('RANGES='.length).replace(/'/g, '').split(' ').filter((range) => range !== '')
}

const id = randomBytes(4).toString('hex')
const name = (part: string) => `aws-step11g-${id}-${part}`
const failures: string[] = []
const check = (ok: unknown, label: string) => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const containers: string[] = []
const run = (part: string, network: keyof typeof NETWORKS, ip: string, extra: string[], command: string[]) => {
  containers.push(name(part))
  docker('run', '-d', '--name', name(part), '--network', name(network), '--ip', ip, '-v', `${ROOT}:/repo:ro`, '-w', '/repo', ...extra, LAB, ...command)
}
const serveIn = (part: string, network: keyof typeof NETWORKS, ip: string, spec: string) => run(part, network, ip, [], ['node', 'test/step11c.ts', 'serve', spec])
const probeFrom = (part: string, targets: string[]) => Reaches.parse(JSON.parse(docker('exec', name(part), 'node', 'test/step11c.ts', 'probe', ...targets)))
const vmExec = (...args: string[]) => docker('exec', name('vm'), ...args)
// The script goes in on standard input, as the live steps send it into colima's VM.
const firewall = () => execFileSync('docker', ['exec', '-i', name('vm'), 'sh', '-s'], { input: scriptForCopy(), stdio: ['pipe', 'ignore', 'inherit'] })
const rules = () => ['DOCKER-USER', 'AGENTS-BOXES', 'AGENTS-BOXES-IN', 'INPUT'].map((chain) => vmExec('iptables', '-w', '-S', chain)).join('\n')
// A container that routes everything through the VM, as one on a Docker bridge does, and looks names up at the public resolver.
const routeThrough = (part: string, gateway: string) => {
  docker('exec', name(part), 'ip', 'route', 'replace', 'default', 'via', gateway)
  execFileSync('docker', ['exec', '-i', name(part), 'tee', '/etc/resolv.conf'], { input: `nameserver ${FIRST_DNS}\n`, stdio: ['pipe', 'ignore', 'inherit'] })
}

try {
  check(JSON.stringify(scriptRanges()) === JSON.stringify(BOX_CLOSED_RANGES), "the script drops the box host's ranges, BOX_CLOSED_RANGES, no more and no fewer")
  ensureLab()
  docker('network', 'create', '--subnet', NETWORKS.lima, '--gateway', LIMA_GATEWAY, name('lima'))
  for (const network of ['boxes', 'corp', 'compose'] as const) docker('network', 'create', '--subnet', NETWORKS[network], name(network))

  // The VM: on its own network, where the Mac is, and on the boxes', a private
  // network's and Compose's. It serves a port of its own and answers DNS.
  run('vm', 'lima', VM, ['--cap-add', 'NET_ADMIN', '--sysctl', 'net.ipv4.ip_forward=1'], ['node', 'test/step11c.ts', 'serve', 'tcp:9', 'dns:53'])
  docker('network', 'connect', '--ip', VM_ON_BOXES, name('boxes'), name('vm'))
  docker('network', 'connect', '--ip', VM_ON_CORP, name('corp'), name('vm'))
  docker('network', 'connect', '--ip', VM_ON_COMPOSE, name('compose'), name('vm'))
  // Lines of `ip -o -4 addr show` read "3: eth1    inet 172.29.114.2/24 ...".
  const boxFacing = z.string().min(1).parse(vmExec('ip', '-o', '-4', 'addr', 'show').split('\n')
    .map((line) => line.split(/\s+/)).find((fields) => fields[3]?.startsWith(`${VM_ON_BOXES}/`))?.[1])
  // Attaching the boxes' network moved the VM's default route onto it, and taking that link down drops
  // the route. The default goes out the VM's own network again, as colima's does.
  for (const step of [['link', 'set', boxFacing, 'down'], ['link', 'set', boxFacing, 'name', 'docker0'], ['link', 'set', 'docker0', 'up'],
    ['route', 'replace', 'default', 'via', LIMA_GATEWAY]]) vmExec('ip', ...step)
  // As Docker does on the VM: masquerade what leaves the bridge, and send forwarded packets through DOCKER-USER.
  vmExec('iptables', '-w', '-t', 'nat', '-A', 'POSTROUTING', '!', '-o', 'docker0', '-j', 'MASQUERADE')
  vmExec('iptables', '-w', '-N', 'DOCKER-USER')
  vmExec('iptables', '-w', '-A', 'FORWARD', '-j', 'DOCKER-USER')
  vmExec('iptables', '-w', '-A', 'OUTPUT', '-p', 'icmp', '--icmp-type', 'redirect', '-j', 'DROP')
  // As Docker publishes a port: connections to the VM's port are sent on to the box's.
  vmExec('iptables', '-w', '-t', 'nat', '-A', 'PREROUTING', '-p', 'tcp', '--dport', String(PUBLISHED), '-j', 'DNAT', '--to-destination', `${BOX}:9`)

  serveIn('mac', 'lima', MAC, 'tcp:7700,7701,7710')
  serveIn('corp', 'corp', CORP_PEER, 'tcp:80')
  serveIn('compose', 'compose', COMPOSE_SERVICE, 'tcp:5432')
  // The box serves a port, for the VM to reach as a published port's traffic would.
  run('box', 'boxes', BOX, ['--cap-add', 'NET_ADMIN'], ['node', 'test/step11c.ts', 'serve', 'tcp:9'])
  routeThrough('box', VM_ON_BOXES)
  run('client', 'compose', COMPOSE_CLIENT, ['--cap-add', 'NET_ADMIN'], ['sleep', 'infinity'])
  routeThrough('client', VM_ON_COMPOSE)

  const reach = (source: Source) => probeFrom(source === 'box' ? 'box' : 'client', Object.keys(TARGETS[source]))
  const vmToBox = () => probeFrom('vm', [`tcp:${BOX}:9`])[`tcp:${BOX}:9`]
  const published = `tcp:${VM_ON_CORP}:${String(PUBLISHED)}`
  const publishedFromPeer = () => probeFrom('corp', [published])[published]
  const compare = (stage: Stage) => {
    for (const source of ['box', 'compose'] as const) {
      const found = reach(source)
      for (const [target, { label, [stage]: expected }] of Object.entries(TARGETS[source])) {
        check(found[target] === expected, `${WHEN[stage]}, ${WHO[source]} ${VERB[expected]} ${label} (${found[target] ?? 'no result'})`)
      }
    }
    check(vmToBox() === 'open', `${WHEN[stage]}, the VM opens a connection to the box`)
    check(publishedFromPeer() === 'open', `${WHEN[stage]}, a client on the private network opens a connection to a port published from the box, and the box's answers come back`)
  }

  compare('before')
  firewall()
  compare('after')
  const shut = Object.entries(TARGETS.box).filter(([, { after }]) => after === 'blocked').map(([target]) => target)
  const control = probeFrom('vm', shut)
  check(shut.every((target) => control[target] === 'open'), `the VM itself still reaches everything the box cannot (${JSON.stringify(control)})`)

  const ruleSet = rules()
  firewall()
  check(rules() === ruleSet, 'running the script again leaves the same rules')
  for (const source of ['box', 'compose'] as const) {
    const again = reach(source)
    check(Object.entries(TARGETS[source]).every(([target, { after }]) => again[target] === after), `after the second run, ${WHO[source]} reaches the same as after the first`)
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  // Containers and networks go whatever happened. They hold nothing worth keeping.
  for (const container of containers) {
    try {
      docker('rm', '-f', container)
    } catch (error) {
      console.error(`removing container ${container}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const network of Object.keys(NETWORKS)) {
    try {
      docker('network', 'rm', name(network))
    } catch (error) {
      console.error(`removing network ${name(network)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
console.log(`\n${failures.length ? `${failures.length} failed` : 'all passed (containers and networks removed)'}`)
process.exit(failures.length ? 1 : 0)
