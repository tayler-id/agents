// First boot on an AWS host, as root, after user data has installed Node and
// cloned the deployed commit: everything else. Docker and its plugins, Tailscale
// joined with the host's own auth key, and the services. On the box host the
// firewall is installed before Docker first starts, so no box ever runs without
// it. Each step looks before it acts, so running it again converges.
//   node ops/aws/bootstrap.ts server|boxes [--dry-run]

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { SSMClient } from '@aws-sdk/client-ssm'
import pg from 'pg'
import { z } from 'zod'
import { hostConfig, readParameter } from './aws.ts'
import {
  APP_HOME, BOX_DNS, DOCKER_PLUGINS, HOME, NODE_DIR, RDS_CA_FILE_NAME, REPO, Role, SECRET_PARAMETERS, SERVICE_USER, TAILNET, type HostConfig,
} from './config.ts'
import { isDryRun, output, perform, run, type Step } from './steps.ts'

const PLUGIN_DIR = '/usr/local/lib/docker/cli-plugins'
// So `sudo -iu agents node ...` finds Node, as docs/aws.md writes it.
const PROFILE = '/etc/profile.d/agents-node.sh'
const TAILSCALE_REPO = 'https://pkgs.tailscale.com/stable/amazon-linux/2023/tailscale.repo'
// Docker's settings. Container logs rotate, so they cannot fill the disk. On the
// box host, containers cannot talk to each other, and boxes look names up at
// public resolvers, since the firewall keeps them from the VPC's.
const DAEMON_JSON = '/etc/docker/daemon.json'
const logs = { 'log-driver': 'local', 'log-opts': { 'max-size': '10m', 'max-file': '3' } }
const DOCKER_SETTINGS: Record<Role, object> = {
  server: { ...logs, 'live-restore': true },
  boxes: { ...logs, 'live-restore': true, icc: false, dns: BOX_DNS },
}
// The server reaches the box host's Docker over Tailscale SSH, through one
// shared connection per ten minutes rather than one per command.
const SSH_CONFIG = `Host ${TAILNET.boxes}
  User ${SERVICE_USER}
  BatchMode yes
  StrictHostKeyChecking accept-new
  ControlMaster auto
  ControlPath ~/.ssh/control-%C
  ControlPersist 10m
  ServerAliveInterval 15
  ServerAliveCountMax 3
`
const TailscaleStatus = z.object({ BackendState: z.string() })

const role = Role.parse(process.argv[2])
const dryRun = isDryRun()
const ssm = new SSMClient({})
let config: HostConfig | undefined
const facts = (): HostConfig => {
  if (!config) throw new Error('the host config was not read first')
  return config
}
const asAgents = (args: string[]) => { run('sudo', ['-u', SERVICE_USER, '-H', ...args], { cwd: REPO }) }
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

// Writes a file when its content differs, with a mode and, for the service user's files, its ownership.
function place(file: string, content: string, mode: number, owner?: string) {
  if (!existsSync(file) || readFileSync(file, 'utf8') !== content) writeFileSync(file, content, { mode })
  chmodSync(file, mode)
  if (owner) run('chown', [`${owner}:${owner}`, file])
}

async function installPlugins() {
  mkdirSync(PLUGIN_DIR, { recursive: true })
  for (const plugin of DOCKER_PLUGINS) {
    const file = join(PLUGIN_DIR, plugin.name)
    if (existsSync(file) && sha256(readFileSync(file)) === plugin.sha256) continue
    const res = await fetch(plugin.url)
    if (!res.ok) throw new Error(`${plugin.url}: ${res.status}`)
    const body = Buffer.from(await res.arrayBuffer())
    if (sha256(body) !== plugin.sha256) throw new Error(`${plugin.url} does not match its pinned SHA-256`)
    writeFileSync(file, body, { mode: 0o755 })
  }
}

async function joinTailnet(hostname: string, tag: string, keyName: 'tailscale-server' | 'tailscale-boxes') {
  if (!existsSync('/etc/yum.repos.d/tailscale.repo')) run('dnf', ['config-manager', '--add-repo', TAILSCALE_REPO])
  run('dnf', ['install', '-y', 'tailscale'])
  run('systemctl', ['enable', '--now', 'tailscaled'])
  const status = TailscaleStatus.parse(JSON.parse(output('tailscale', ['status', '--json'])))
  if (status.BackendState === 'Running') return
  const key = await readParameter(ssm, SECRET_PARAMETERS[keyName])
  if (key === undefined) throw new Error(`there is no ${SECRET_PARAMETERS[keyName]}: store the auth key with ops/aws/secrets.ts put ${keyName}`)
  // The key goes to tailscale in a file only root can read, never on its command line.
  const dir = mkdtempSync(join(tmpdir(), 'agents-tailscale-'))
  try {
    writeFileSync(join(dir, 'key'), key, { mode: 0o600 })
    run('tailscale', ['up', `--auth-key=file:${join(dir, 'key')}`, `--hostname=${hostname}`, `--advertise-tags=${tag}`, '--ssh'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function rdsCertificates() {
  const region = facts().region
  const res = await fetch(`https://truststore.pki.rds.amazonaws.com/${region}/${region}-bundle.pem`)
  const body = await res.text()
  if (!res.ok || !body.includes('BEGIN CERTIFICATE')) throw new Error(`no RDS certificate bundle for ${region}: ${res.status}`)
  mkdirSync(APP_HOME, { recursive: true })
  run('chown', [`${SERVICE_USER}:${SERVICE_USER}`, APP_HOME])
  place(join(APP_HOME, RDS_CA_FILE_NAME), body, 0o644, SERVICE_USER)
}

// Electric reads the database's change log through a replication slot, which on
// RDS takes the rds_replication role. Granting it again changes nothing.
async function grantReplication() {
  const env = z.object({ DATABASE_URL: z.url() }).parse(parseEnv(readFileSync(join(REPO, '.env'), 'utf8')))
  const client = new pg.Client({ connectionString: env.DATABASE_URL })
  await client.connect()
  try {
    await client.query(`grant rds_replication to ${client.escapeIdentifier(decodeURIComponent(new URL(env.DATABASE_URL).username))}`)
  } finally {
    await client.end()
  }
}

function installServices(extraEnv: Record<string, string>) {
  run(process.execPath, ['ops/install-systemd.ts', role, '--aws'], { cwd: REPO, env: { ...process.env, AWS_REGION: facts().region, ...extraEnv } })
}

const shared: Step[] = [
  { say: 'read /agents/config', act: async () => { config = await hostConfig(ssm) } },
  { say: `put ${NODE_DIR}/bin on login shells' PATH`, act: () => { place(PROFILE, `export PATH=${NODE_DIR}/bin:$PATH\n`, 0o644) } },
  {
    // The JavaScript SDK takes the region from the environment or this file, never from the instance.
    say: `give ${SERVICE_USER} the AWS region, for the scripts run by hand`,
    act: () => {
      mkdirSync(join(HOME, '.aws'), { recursive: true, mode: 0o700 })
      run('chown', [`${SERVICE_USER}:${SERVICE_USER}`, join(HOME, '.aws')])
      place(join(HOME, '.aws', 'config'), `[default]\nregion = ${facts().region}\n`, 0o600, SERVICE_USER)
    },
  },
  { say: `install Docker${role === 'boxes' ? ' and iptables' : ''}`, act: () => { run('dnf', ['install', '-y', 'docker', ...(role === 'boxes' ? ['iptables-nft'] : [])]) } },
  { say: 'install the Compose and Buildx plugins, each checked against its pinned SHA-256', act: installPlugins },
  { say: `write ${DAEMON_JSON}: ${JSON.stringify(DOCKER_SETTINGS[role])}`, act: () => { place(DAEMON_JSON, `${JSON.stringify(DOCKER_SETTINGS[role], null, 2)}\n`, 0o644) } },
]

const server: Step[] = [
  ...shared,
  { say: 'start Docker', act: () => { run('systemctl', ['enable', '--now', 'docker']) } },
  { say: `let ${SERVICE_USER} use Docker`, act: () => { run('usermod', ['-aG', 'docker', SERVICE_USER]) } },
  { say: `join the tailnet as ${TAILNET.serverAtFirst} with ${TAILNET.serverTag} and Tailscale SSH`, act: () => joinTailnet(TAILNET.serverAtFirst, TAILNET.serverTag, 'tailscale-server') },
  {
    say: `let ${SERVICE_USER} reach the box host's Docker over SSH`,
    act: () => {
      mkdirSync(join(HOME, '.ssh'), { recursive: true, mode: 0o700 })
      run('chown', [`${SERVICE_USER}:${SERVICE_USER}`, join(HOME, '.ssh')])
      place(join(HOME, '.ssh', 'config'), SSH_CONFIG, 0o600, SERVICE_USER)
    },
  },
  { say: "download RDS's certificate bundle, so the API checks the database's certificate", act: rdsCertificates },
  { say: 'write the secrets to files', act: () => { asAgents([process.execPath, 'ops/aws/fetch-secrets.ts', '--to', join(REPO, '.env')]) } },
  { say: "let the database's user stream changes to Electric (RDS's rds_replication role)", act: grantReplication },
  { say: 'build the app', act: () => { asAgents([join(process.execPath, '..', 'npm'), 'run', 'app:build']) } },
  { say: 'install and start the services', act: () => { installServices({}) } },
  { say: 'take the first backup', act: () => { run('systemctl', ['start', 'agents-backup.service']) } },
]

const boxes: Step[] = [
  ...shared,
  {
    say: 'install the firewall and the health timer, before Docker first starts',
    act: () => { installServices({ AGENTS_API_ADDRESS: facts().serverAddress, AGENTS_API_PORT: String(facts().machinePort) }) },
  },
  { say: 'start Docker at every boot, after the firewall', act: () => { run('systemctl', ['enable', '--now', 'docker']) } },
  { say: `let ${SERVICE_USER} use Docker, as the server does over SSH`, act: () => { run('usermod', ['-aG', 'docker', SERVICE_USER]) } },
  { say: `join the tailnet as ${TAILNET.boxes} with ${TAILNET.boxesTag} and Tailscale SSH`, act: () => joinTailnet(TAILNET.boxes, TAILNET.boxesTag, 'tailscale-boxes') },
]

await perform(role === 'server' ? server : boxes, dryRun)
if (!dryRun) console.log(`${role} is ready`)
