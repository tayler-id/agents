// Read-only, against the live server and its tailnet node, like step 2b. In
// userspace mode tailscaled hands a tailnet connection for any port serve does
// not claim to 127.0.0.1 on the same port. So the tailnet policy must let peers
// reach only serve's port and the machine port, serve must send people to the
// API's socket, and no TCP port of the API may take a person's identity. Sends
// only GET requests, naming a login that matches no person.
//   node --env-file=.env --env-file=.env.test test/step19b.ts

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { request, type RequestOptions } from 'node:http'
import { BlockList, isIPv4 } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

// ops/install-launch-agents.sh starts tailscaled with this socket, and with its
// outbound proxy on this port. The proxy is how this Mac reaches the tailnet.
const TAILSCALED = join(homedir(), '.agents-app', 'tailscale', 'tailscaled.sock')
const PROXY = 1055
// The ports a peer may reach: serve, which names the person, and the machine port.
const SERVE = 80
const MACHINES = 7700
const [TCP, ICMP, ICMP6] = [6, 1, 58]
const nobody = `nobody-${randomBytes(4).toString('hex')}@example.invalid`

const failures: string[] = []
function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

function get(options: RequestOptions): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ ...options, method: 'GET' }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'] ?? '', body }) })
    })
    req.on('error', reject)
    req.end()
  })
}

async function localApi<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const reply = await get({ socketPath: TAILSCALED, path: `/localapi/v0/${path}`, headers: { host: 'local-tailscaled.sock' } })
  if (reply.status !== 200) throw new Error(`tailscaled ${path}: ${reply.status} ${reply.body}`)
  return schema.parse(JSON.parse(reply.body))
}

// A GET sent across the tailnet to this node, as a peer would send it.
const overTailnet = (host: string, port: number, path: string, headers: Record<string, string> = {}) =>
  get({ host: '127.0.0.1', port: PROXY, path: `http://${host}:${port}${path}`, headers: { ...headers, host: `${host}:${port}` } })

// What lsof reports as listening for a process: TCP ports, and Unix socket paths.
function listening(pid: number, kind: '-iTCP' | '-U'): string[] {
  const args = ['-a', '-p', String(pid), kind, ...(kind === '-iTCP' ? ['-sTCP:LISTEN'] : []), '-nP', '-Fn']
  return spawnSync('lsof', args, { encoding: 'utf8' }).stdout.split('\n')
    .filter((line) => line.startsWith('n') && !line.startsWith('n->')).map((line) => line.slice(1))
}

const Status = z.object({ Self: z.object({ DNSName: z.string(), TailscaleIPs: z.array(z.string()) }) })
const PacketFilter = z.array(z.object({
  IPProto: z.array(z.number()),
  Dsts: z.array(z.object({ Net: z.string(), Ports: z.object({ First: z.number(), Last: z.number() }) })).nullable(),
}))
const ServeConfig = z.object({
  Web: z.record(z.string(), z.object({ Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() })) })).optional(),
})

try {
  const { Self } = await localApi('status', Status)
  const host = Self.DNSName.replace(/\.$/, '')

  // The packet filter tailscaled enforces before any packet reaches loopback.
  const filter = await localApi('debug-packet-filter-matches', PacketFilter)
  const covers = (net: string, address: string) => {
    const [base = '', bits = ''] = net.split('/')
    const family = isIPv4(base) ? 'ipv4' : 'ipv6'
    if (family !== (isIPv4(address) ? 'ipv4' : 'ipv6')) return false
    const block = new BlockList()
    block.addSubnet(base, Number(bits), family)
    return block.check(address, family)
  }
  for (const address of Self.TailscaleIPs) {
    const allowed = filter.flatMap((match) => (match.Dsts ?? []).filter((dst) => covers(dst.Net, address))
      .flatMap((dst) => match.IPProto.map((proto) => ({ proto, first: dst.Ports.First, last: dst.Ports.Last }))))
    const stray = allowed.filter(({ proto, first, last }) =>
      !(proto === TCP && first === last && (first === SERVE || first === MACHINES)) && proto !== ICMP && proto !== ICMP6)
    const tcpOpen = (port: number) => allowed.some(({ proto, first, last }) => proto === TCP && first <= port && port <= last)
    console.log(`      peers may reach ${address} on ${allowed.map(({ proto, first, last }) => `${proto}:${first}-${last}`).join(', ') || 'nothing'}`)
    check(!stray.length && tcpOpen(SERVE) && tcpOpen(MACHINES),
      `the tailnet policy lets peers reach ${address} only on TCP ${SERVE} and ${MACHINES}`)
  }

  const pid = Number(/"PID" = (\d+);/.exec(spawnSync('launchctl', ['list', 'com.agents.api'], { encoding: 'utf8' }).stdout)?.[1])
  check(pid > 0, 'the live API is running under launchd')
  const ports = listening(pid, '-iTCP').map((name) => Number(name.slice(name.lastIndexOf(':') + 1)))
  const replies = await Promise.all(ports.map(async (port) => [port, await overTailnet(host, port, '/v1/me', { 'tailscale-user-login': nobody })] as const))
  console.log(`      the live API listens on TCP ${replies.map(([port, reply]) => `${port} (${reply.status})`).join(', ')}`)
  check(ports.includes(MACHINES) && replies.every(([, reply]) => reply.status !== 200 && !reply.body.includes(`${nobody} is not on a team`)),
    'a direct tailnet connection to any TCP port of the live API never looks up the login it names')

  const serve = await localApi('serve-config', ServeConfig)
  const target = serve.Web?.[`${host}:${SERVE}`]?.Handlers['/']?.Proxy ?? ''
  check(target.startsWith('unix:') && listening(pid, '-U').includes(target.slice('unix:'.length)),
    `serve sends people to the live API's Unix socket (${target || 'no handler'})`)

  const app = await overTailnet(host, SERVE, '/')
  check(app.status === 200 && app.type.startsWith('text/html'), `through serve, the app loads over the tailnet (${app.status})`)

  const machine = await overTailnet(host, MACHINES, '/v1/record/search')
  check(machine.status === 401 && machine.body.includes('missing instance token'),
    `the machine port still answers over the tailnet and asks for a token (${machine.status})`)
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`)
}

console.log(failures.length ? `\n${failures.length} failed` : '\nall passed')
process.exit(failures.length ? 1 : 0)
