// The box host's firewall. A box is an agent's computer, with a browser, so it
// reaches the public internet over any protocol, as boxes on this Mac do. It
// holds a Claude token and runs code agents write, so it reaches nothing
// private: not this host at any of its addresses, and none of BOX_CLOSED_RANGES
// (ops/aws/config.ts), which hold the VPC, RDS, the instance metadata endpoint,
// the tailnet and other boxes. The one exception is the server's machine port.
// Boxes look names up at public resolvers (BOX_DNS), never the VPC's. IPv6 from
// boxes is dropped, the metadata endpoint's fd00:ec2::254 with it, since boxes
// have no IPv6 address and the VPC has no IPv6 route.
//
// It runs as root at boot, before Docker starts, and Docker requires it, so a box
// never runs unfiltered. The rules sit in the raw table's PREROUTING chain, which
// runs before routing, so one set covers traffic to other hosts and to this host.
// Docker and Tailscale both put rules at the top of the filter table's FORWARD
// chain, where a rule of ours could end up behind Tailscale's accept for the
// tailnet. Neither touches the raw table. Safe to run again.
//   node ops/aws/box-firewall.ts [--dry-run]
// Settings, from the environment (on the box host, /etc/agents/box-firewall.env):
//   AGENTS_API_ADDRESS    the server's private address, such as 10.40.0.10
//   AGENTS_API_PORT       the machine port, 7700 unless set

import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import { MACHINE_PORT, Port } from '../../shared/listen.ts'
import { BOX_CLOSED_RANGES, settingsFrom } from './config.ts'

const CHAIN = 'AGENTS-BOXES'
// Docker's default bridge, where boxes run, and any network a box might be put on.
const BRIDGES = ['docker0', 'br-+']

const Settings = z.object({
  AGENTS_API_ADDRESS: z.ipv4(),
  AGENTS_API_PORT: Port.default(MACHINE_PORT),
})
type Settings = z.infer<typeof Settings>

// The chain's rules, in order. The first that matches decides. RETURN lets the
// packet go on through the host's usual rules, and so does reaching the end, so
// whatever no rule drops goes out to the internet.
function rules(settings: Settings): string[][] {
  return [
    ['-d', `${settings.AGENTS_API_ADDRESS}/32`, '-p', 'tcp', '-m', 'tcp', '--dport', String(settings.AGENTS_API_PORT), '-j', 'RETURN'],
    ['-m', 'addrtype', '--dst-type', 'LOCAL', '-j', 'DROP'],
    ...BOX_CLOSED_RANGES.map((range) => ['-d', range, '-j', 'DROP']),
  ]
}

// iptables-restore input that creates the chain, or empties one that exists, and
// fills it in one transaction, so a rerun never leaves boxes without rules.
const restoreInput = (chainRules: string[][]) =>
  ['*raw', `:${CHAIN} - [0:0]`, ...chainRules.map((rule) => ['-A', CHAIN, ...rule].join(' ')), 'COMMIT', ''].join('\n')

type Family = { tool: 'iptables' | 'ip6tables'; chainRules: string[][] }

// Whether a rule is there. iptables -C exits 1 when it is not, and anything else is a real failure.
function present(tool: Family['tool'], rule: string[]): boolean {
  try {
    execFileSync(tool, ['-w', '-t', 'raw', '-C', ...rule], { stdio: 'ignore' })
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 1) return false
    throw error
  }
}

function apply(family: Family, dryRun: boolean) {
  const input = restoreInput(family.chainRules)
  if (dryRun) console.log(`would run ${family.tool}-restore -w --noflush with:\n${input}`)
  else execFileSync(`${family.tool}-restore`, ['-w', '--noflush'], { input, stdio: ['pipe', 'inherit', 'inherit'] })
  for (const bridge of BRIDGES) {
    const jump = ['PREROUTING', '-i', bridge, '-j', CHAIN]
    if (dryRun) console.log(`would add, unless present: ${family.tool} -w -t raw -I ${jump.join(' ')}`)
    else if (!present(family.tool, jump)) execFileSync(family.tool, ['-w', '-t', 'raw', '-I', 'PREROUTING', '1', ...jump.slice(1)])
  }
}

const dryRun = process.argv.includes('--dry-run')
const settings = settingsFrom(Settings, "the box firewall's settings")
apply({ tool: 'iptables', chainRules: rules(settings) }, dryRun)
apply({ tool: 'ip6tables', chainRules: [['-j', 'DROP']] }, dryRun)
console.log(dryRun ? 'dry run: nothing changed'
  : `box firewall applied: boxes reach the internet and ${settings.AGENTS_API_ADDRESS}:${String(settings.AGENTS_API_PORT)}, and nothing else private`)
