// AWS step 11c: what a box can reach on the box host, through its firewall.
// Containers stand in for the AWS network. A box host with NET_ADMIN in its own
// network namespace routes a box to the real internet, and to stand-ins for the
// server, the VPC resolver, the database, the metadata endpoint, a tailnet peer,
// another box, and a peer in each other closed range: private, network testing,
// reserved, and 0.0.0.0/8. Before ops/aws/box-firewall.ts the box reaches all of
// them, the box host at each of its addresses, a loopback one included, and a
// multicast group the box host joined, which shows the probes can tell. After, it
// still opens public websites, looks names up at the public resolvers in BOX_DNS,
// reaches GitHub's SSH port, and reaches the server's machine port, and it reaches
// none of the rest. The box host itself still reaches every other stand-in, and the
// box reaches the other box once it skips the host, so each "cannot reach" is the
// firewall. Running the firewall again changes nothing.
//   node --env-file=.env --env-file=.env.test test/step11c.ts
// The same file runs inside the containers, as `serve` for the stand-ins and
// `probe` for the box, so the check needs no other file. It needs the internet.

import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { connect, createServer, isIP } from 'node:net'
import { z } from 'zod'
import { BOX_DNS } from '../ops/aws/config.ts'

const ROOT = new URL('..', import.meta.url).pathname
// How long a probe waits for an answer on the lab's own network. A dropped packet never gets one.
const PROBE_MS = 3000
// How long a probe that goes out to the internet may take.
const INTERNET_MS = 15_000
// The address the DNS stand-in gives for every name.
const ANSWER = [192, 0, 2, 53]
// A DNS header is 12 bytes. Its fourth byte ends with the response code, and bytes 6 and 7 count the answers.
const DNS_HEADER = 12
const RCODE_MASK = 0x0f

// ---- Inside the containers ----

// A minimal DNS answer: the query's id and question, and one A record.
function dnsAnswer(query: Buffer): Buffer {
  const question = query.subarray(DNS_HEADER)
  const header = Buffer.from([query[0] ?? 0, query[1] ?? 0, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0])
  const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...ANSWER])
  return Buffer.concat([header, question, answer])
}

function dnsQuery(name: string): Buffer {
  const labels = name.split('.').flatMap((label) => [label.length, ...Buffer.from(label)])
  return Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, ...labels, 0, 0, 1, 0, 1])
}

// serve mcast:<group>:<port>:<address>[,<address>...] joins a multicast group on
// the interfaces with those addresses, and answers each datagram sent to it.
function serveMulticast(spec: string) {
  const [, group = '', port = '', addresses = ''] = spec.split(':')
  const socket = createSocket({ type: 'udp4', reuseAddr: true })
  socket.on('message', (_, from) => {
    socket.send('here', from.port, from.address, (error) => { if (error) console.error(`multicast answer to ${from.address}: ${error.message}`) })
  })
  socket.bind(Number(port), () => { for (const address of addresses.split(',')) socket.addMembership(group, address) })
}

// serve tcp:7700,3000 dns:53 listens on those ports on every address. A TCP
// connection is closed as soon as it is accepted. The probe needs only the
// handshake and closes at once, so anything written back could hit a reset.
function serve(specs: string[]) {
  for (const spec of specs) {
    if (spec.startsWith('mcast:')) {
      serveMulticast(spec)
      continue
    }
    const [kind, ports = ''] = spec.split(':')
    for (const port of ports.split(',').map(Number)) {
      if (kind === 'tcp') createServer((socket) => socket.destroy()).listen(port, '0.0.0.0')
      else if (kind === 'dns') {
        const socket = createSocket('udp4')
        socket.on('message', (query, from) => {
          socket.send(dnsAnswer(query), from.port, from.address, (error) => { if (error) console.error(`dns answer to ${from.address}: ${error.message}`) })
        })
        socket.bind(port, '0.0.0.0')
      } else throw new Error(`cannot serve ${spec}`)
    }
  }
}

// What a probe found: a TCP handshake or an HTTP answer, a DNS answer, silence, or a refusal.
const Reach = z.enum(['open', 'answers', 'blocked', 'refused'])
type Reach = z.infer<typeof Reach>
const Reaches = z.record(z.string(), Reach)

// A name is on the internet in this lab, so it gets the internet's time. An address is a stand-in's.
function probeTcp(host: string, port: number): Promise<Reach> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: isIP(host) ? PROBE_MS : INTERNET_MS })
    socket.once('connect', () => { socket.destroy(); resolve('open') })
    socket.once('timeout', () => { socket.destroy(); resolve('blocked') })
    socket.once('error', (error: Error) => {
      // A firewall that drops never sends a refusal, so a refusal means the host answered.
      resolve('code' in error && error.code === 'ECONNREFUSED' ? 'refused' : 'blocked')
    })
  })
}

// A DNS question for one name, over UDP. 'answers' when the server answers it
// with at least one record, 'refused' when it answers with an error.
function probeDns(server: string, name: string): Promise<Reach> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    const query = dnsQuery(name)
    const timer = setTimeout(() => { socket.close(); resolve('blocked') }, INTERNET_MS)
    socket.on('message', (reply) => {
      if (reply.length < DNS_HEADER || reply.readUInt16BE(0) !== query.readUInt16BE(0)) return
      clearTimeout(timer)
      socket.close()
      resolve(((reply[3] ?? RCODE_MASK) & RCODE_MASK) === 0 && reply.readUInt16BE(6) > 0 ? 'answers' : 'refused')
    })
    socket.send(query, 53, server)
  })
}

// A page with Node's own fetch, as a box's tools and browser get one: the name
// looked up through the box's resolvers, then TCP and TLS, straight to the site.
// Any failure, of the lookup, the connection or TLS, means the box could not reach it.
async function probeWeb(url: string): Promise<Reach> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(INTERNET_MS) })
    await res.body?.cancel()
    return 'open'
  } catch {
    return 'blocked'
  }
}

// A datagram to a multicast group. 'answers' when a member of the group replies.
function probeMulticast(group: string, port: number): Promise<Reach> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    const done = (reach: Reach) => { clearTimeout(timer); socket.close(); resolve(reach) }
    const timer = setTimeout(() => { done('blocked') }, PROBE_MS)
    socket.once('message', () => { done('answers') })
    socket.once('error', () => { done('blocked') })
    socket.send('anyone', port, group)
  })
}

// probe tcp:host:port dns:server:name web:url mcast:group:port prints each target's reach as JSON.
async function probe(targets: string[]) {
  const results = await Promise.all(targets.map(async (target): Promise<[string, Reach]> => {
    const [kind = '', ...parts] = target.split(':')
    const arg = parts.join(':')
    const at = arg.lastIndexOf(':')
    if (kind === 'tcp') return [target, await probeTcp(arg.slice(0, at), Number(arg.slice(at + 1)))]
    if (kind === 'dns') return [target, await probeDns(arg.slice(0, at), arg.slice(at + 1))]
    if (kind === 'web') return [target, await probeWeb(arg)]
    if (kind === 'mcast') return [target, await probeMulticast(arg.slice(0, at), Number(arg.slice(at + 1)))]
    throw new Error(`cannot probe ${target}`)
  }))
  console.log(JSON.stringify(Object.fromEntries(results)))
}

// ---- The check, on this Mac ----

const LAB_DOCKERFILE = `FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends iptables iproute2 && rm -rf /var/lib/apt/lists/*
`
// The lab image is named for its Dockerfile, so it is built once and kept.
const LAB = `agents-aws-netlab:${createHash('sha256').update(LAB_DOCKERFILE).digest('hex').slice(0, 12)}`
const SERVER = '10.40.0.10'
const HOST_VPC = '10.40.0.20'
const RESOLVER = '10.40.0.2'
const DATABASE = '10.40.2.5'
// The box host's address on the box network, as the Docker bridge's address is on the real host.
const HOST_BRIDGE = '172.29.111.2'
// An address of the box host's own outside every private range, as a host with a
// public address on an interface would have. A documentation range (RFC 5737), never routed.
const HOST_PUBLIC = '203.0.113.7'
const BOX = '172.29.111.3'
const OTHER_BOX = '172.29.111.4'
const PRIVATE_PEER = '192.168.234.10'
// Peers in three more closed ranges: network testing (198.18.0.0/15), reserved (240.0.0.0/4) and 0.0.0.0/8.
const TESTNET_PEER = '198.18.0.10'
const RESERVED_PEER = '240.0.0.10'
const ZERO_PEER = '0.1.0.10'
// A loopback address of the box host. With route_localnet on, which the lab sets,
// the host answers a box's packets for 127.0.0.0/8 instead of dropping them as martians.
const HOST_LOOPBACK = '127.200.0.1'
// A multicast group the box host joins on the box network, as a discovery service there would.
const GROUP = '239.255.0.1'
const GROUP_PORT = 9999
const NETWORKS = {
  box: '172.29.111.0/24', vpc: '10.40.0.0/16', meta: '169.254.169.0/24', tail: '100.100.100.0/24', private: '192.168.234.0/24',
  testnet: '198.18.0.0/24', reserved: '240.0.0.0/24', zero: '0.1.0.0/24',
} as const
const OTHER_BOX_TARGET = `tcp:${OTHER_BOX}:9`
const [FIRST_DNS, SECOND_DNS] = BOX_DNS
const VERB: Record<Reach, string> = { open: 'reaches', answers: 'gets answers from', refused: 'is refused', blocked: 'cannot reach' }

// What a box reaches at each target, before the firewall, and after.
const TARGETS: Record<string, { label: string; before: Reach; after: Reach }> = {
  [`tcp:${SERVER}:7700`]: { label: "the server's machine port", before: 'open', after: 'open' },
  'web:https://example.com/': { label: 'a public website, example.com', before: 'open', after: 'open' },
  'web:https://registry.npmjs.org/': { label: 'npm', before: 'open', after: 'open' },
  'tcp:github.com:22': { label: "GitHub's SSH port, which git uses", before: 'open', after: 'open' },
  [`dns:${FIRST_DNS}:example.com`]: { label: `the public resolver ${FIRST_DNS}`, before: 'answers', after: 'answers' },
  [`dns:${SECOND_DNS}:example.com`]: { label: `the public resolver ${SECOND_DNS}`, before: 'answers', after: 'answers' },
  [`dns:${RESOLVER}:box.test`]: { label: 'the VPC resolver', before: 'answers', after: 'blocked' },
  [`tcp:${SERVER}:3000`]: { label: 'any other port on the server', before: 'open', after: 'blocked' },
  [`tcp:${DATABASE}:5432`]: { label: 'the database', before: 'open', after: 'blocked' },
  'tcp:169.254.169.254:80': { label: 'the instance metadata endpoint', before: 'open', after: 'blocked' },
  'tcp:100.100.100.100:80': { label: 'a tailnet peer', before: 'open', after: 'blocked' },
  [`tcp:${PRIVATE_PEER}:80`]: { label: 'a private address outside the VPC', before: 'open', after: 'blocked' },
  [`tcp:${TESTNET_PEER}:80`]: { label: 'a network-testing address, in 198.18.0.0/15', before: 'open', after: 'blocked' },
  [`tcp:${RESERVED_PEER}:80`]: { label: 'a reserved address, in 240.0.0.0/4', before: 'open', after: 'blocked' },
  [`tcp:${ZERO_PEER}:80`]: { label: 'an address in 0.0.0.0/8', before: 'open', after: 'blocked' },
  [`mcast:${GROUP}:${String(GROUP_PORT)}`]: { label: 'a multicast group the box host joined', before: 'answers', after: 'blocked' },
  [OTHER_BOX_TARGET]: { label: 'another box', before: 'open', after: 'blocked' },
  [`tcp:${HOST_BRIDGE}:9`]: { label: 'the box host, at its bridge address', before: 'open', after: 'blocked' },
  [`tcp:${HOST_VPC}:9`]: { label: 'the box host, at its VPC address', before: 'open', after: 'blocked' },
  [`tcp:${HOST_PUBLIC}:9`]: { label: 'the box host, at a public address of its own', before: 'open', after: 'blocked' },
  [`tcp:${HOST_LOOPBACK}:9`]: { label: 'the box host, at a loopback address', before: 'open', after: 'blocked' },
}

async function main() {
  const id = randomBytes(4).toString('hex')
  const name = (part: string) => `aws-step11c-${id}-${part}`
  const failures: string[] = []
  const check = (ok: unknown, label: string) => {
    console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
    if (!ok) failures.push(label)
  }
  const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const containers: string[] = []
  const run = (part: string, network: keyof typeof NETWORKS, ip: string, extra: string[], command: string[]) => {
    containers.push(name(part))
    docker('run', '-d', '--name', name(part), '--network', name(network), '--ip', ip, '-v', `${ROOT}:/repo:ro`, '-w', '/repo',
      ...extra, LAB, ...command)
  }
  const serveIn = (part: string, network: keyof typeof NETWORKS, ip: string, ...specs: string[]) =>
    run(part, network, ip, [], ['node', 'test/step11c.ts', 'serve', ...specs])
  const probeFrom = (part: string, targets: string[]) => Reaches.parse(JSON.parse(docker('exec', name(part), 'node', 'test/step11c.ts', 'probe', ...targets)))
  const reach = () => probeFrom('box', Object.keys(TARGETS))
  const firewall = () => docker('exec', '-e', `AGENTS_API_ADDRESS=${SERVER}`, '-e', 'AGENTS_API_PORT=7700', name('host'), 'node', 'ops/aws/box-firewall.ts')
  const rawRules = () => docker('exec', name('host'), 'iptables', '-w', '-t', 'raw', '-S')

  try {
    const labImages = docker('image', 'ls', '--quiet', LAB)
    // On the host's network, so a firewall on Docker's bridge, like the box host's, cannot stop the build's downloads.
    if (labImages === '') execFileSync('docker', ['build', '--network', 'host', '-t', LAB, '-'], { input: LAB_DOCKERFILE, stdio: ['pipe', 'ignore', 'inherit'] })
    for (const [network, subnet] of Object.entries(NETWORKS)) docker('network', 'create', '--subnet', subnet, name(network))

    // The box host: on the box network, the VPC, and the networks of the metadata
    // endpoint, the tailnet and the peers in the other ranges. Its box-facing interface
    // is renamed docker0, as on the real host, and it forwards and masquerades like Docker does there.
    run('host', 'box', HOST_BRIDGE, ['--cap-add', 'NET_ADMIN', '--sysctl', 'net.ipv4.ip_forward=1', '--sysctl', 'net.ipv4.conf.all.route_localnet=1'],
      ['node', 'test/step11c.ts', 'serve', 'tcp:9'])
    docker('network', 'connect', '--ip', HOST_VPC, name('vpc'), name('host'))
    docker('network', 'connect', '--ip', '169.254.169.2', name('meta'), name('host'))
    docker('network', 'connect', '--ip', '100.100.100.2', name('tail'), name('host'))
    docker('network', 'connect', '--ip', '192.168.234.2', name('private'), name('host'))
    docker('network', 'connect', '--ip', '198.18.0.2', name('testnet'), name('host'))
    docker('network', 'connect', '--ip', '240.0.0.2', name('reserved'), name('host'))
    docker('network', 'connect', '--ip', '0.1.0.2', name('zero'), name('host'))
    // Lines of `ip -o -4 addr show` read "2: eth0    inet 172.29.111.2/24 ...".
    const boxFacing = z.string().min(1).parse(docker('exec', name('host'), 'ip', '-o', '-4', 'addr', 'show').split('\n')
      .map((line) => line.split(/\s+/)).find((fields) => fields[3]?.startsWith(`${HOST_BRIDGE}/`))?.[1])
    for (const step of [['link', 'set', boxFacing, 'down'], ['link', 'set', boxFacing, 'name', 'docker0'], ['link', 'set', 'docker0', 'up'],
      ['route', 'replace', 'default', 'via', '10.40.0.1'], ['link', 'add', 'public0', 'type', 'dummy'],
      ['addr', 'add', `${HOST_PUBLIC}/32`, 'dev', 'public0'], ['link', 'set', 'public0', 'up']]) docker('exec', name('host'), 'ip', ...step)
    docker('exec', name('host'), 'iptables', '-w', '-t', 'nat', '-A', 'POSTROUTING', '!', '-o', 'docker0', '-j', 'MASQUERADE')
    // The host sends the box's packets for the other box back out the way they came. It
    // must not tell the box, by an ICMP redirect, to go there directly, past the firewall.
    docker('exec', name('host'), 'iptables', '-w', '-A', 'OUTPUT', '-p', 'icmp', '--icmp-type', 'redirect', '-j', 'DROP')
    // The host joins the group on the box network, where a box sends to it, and on the
    // VPC, where its own probe below goes out by the default route and loops back to it.
    docker('exec', '-d', name('host'), 'node', 'test/step11c.ts', 'serve', `mcast:${GROUP}:${String(GROUP_PORT)}:${HOST_BRIDGE},${HOST_VPC}`)

    serveIn('server', 'vpc', SERVER, 'tcp:7700,3000')
    serveIn('resolver', 'vpc', RESOLVER, 'dns:53')
    serveIn('database', 'vpc', DATABASE, 'tcp:5432')
    serveIn('metadata', 'meta', '169.254.169.254', 'tcp:80')
    serveIn('peer', 'tail', '100.100.100.100', 'tcp:80')
    serveIn('private', 'private', PRIVATE_PEER, 'tcp:80')
    serveIn('other', 'box', OTHER_BOX, 'tcp:9')
    serveIn('testnet', 'testnet', TESTNET_PEER, 'tcp:80')
    serveIn('reserved', 'reserved', RESERVED_PEER, 'tcp:80')
    serveIn('zero', 'zero', ZERO_PEER, 'tcp:80')
    // The box routes everything through the box host, as a container's traffic
    // does, the other box included, as Docker's bridge sends it through the host's
    // firewall. It looks names up at BOX_DNS, as Docker's settings make every box do.
    // It keeps 127.0.0.1 for itself and sends the host's loopback address to the host.
    run('box', 'box', BOX, ['--cap-add', 'NET_ADMIN', '--sysctl', 'net.ipv4.conf.all.route_localnet=1'], ['sleep', 'infinity'])
    docker('exec', name('box'), 'ip', 'route', 'replace', 'default', 'via', HOST_BRIDGE)
    docker('exec', name('box'), 'ip', 'route', 'replace', `${OTHER_BOX}/32`, 'via', HOST_BRIDGE)
    docker('exec', name('box'), 'ip', 'route', 'del', 'local', '127.0.0.0/8', 'dev', 'lo', 'table', 'local')
    docker('exec', name('box'), 'ip', 'route', 'replace', `${HOST_LOOPBACK}/32`, 'via', HOST_BRIDGE)
    execFileSync('docker', ['exec', '-i', name('box'), 'tee', '/etc/resolv.conf'],
      { input: BOX_DNS.map((server) => `nameserver ${server}\n`).join(''), stdio: ['pipe', 'ignore', 'inherit'] })

    const before = reach()
    for (const [target, { label, before: expected }] of Object.entries(TARGETS)) {
      check(before[target] === expected, `before the firewall, a box ${VERB[expected]} ${label} (${before[target] ?? 'no result'})`)
    }

    console.log(firewall())
    const after = reach()
    for (const [target, { label, after: expected }] of Object.entries(TARGETS)) {
      check(after[target] === expected, `with it, a box ${VERB[expected]} ${label} (${after[target] ?? 'no result'})`)
    }

    // The box host's own traffic never passes the boxes' chain. It still reaches
    // every stand-in and address the box cannot, so each "cannot reach" above is
    // the firewall, not a stand-in that stopped answering. The other box is the
    // exception. Its answers to the host come in from the box network, and the
    // firewall drops them on their way to the host's address, as it would on the
    // real host. So the box sends to it directly instead, past the host.
    const blocked = Object.entries(TARGETS).filter(([target, { after: expected }]) => expected === 'blocked' && target !== OTHER_BOX_TARGET)
    const control = probeFrom('host', blocked.map(([target]) => target))
    check(blocked.every(([target, { before: expected }]) => control[target] === expected),
      `the box host itself still reaches everything else the box cannot (${JSON.stringify(control)})`)
    docker('exec', name('box'), 'ip', 'route', 'del', `${OTHER_BOX}/32`)
    const direct = probeFrom('box', [OTHER_BOX_TARGET])[OTHER_BOX_TARGET]
    docker('exec', name('box'), 'ip', 'route', 'replace', `${OTHER_BOX}/32`, 'via', HOST_BRIDGE)
    check(direct === 'open', `the other box still answers the box directly, past the box host (${direct ?? 'no result'})`)

    const rules = rawRules()
    firewall()
    const again = reach()
    check(rawRules() === rules && Object.entries(TARGETS).every(([target, { after: expected }]) => again[target] === expected),
      'running the firewall again leaves the same rules and the same reach')
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
    console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  } finally {
    // Containers and networks go whatever happened. They hold nothing worth keeping.
    for (const container of containers) docker('rm', '-f', container)
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
}

const [mode, ...rest] = process.argv.slice(2)
if (mode === 'serve') serve(rest)
else if (mode === 'probe') await probe(rest)
else await main()
