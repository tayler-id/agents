// Installs the systemd services that keep Agents running on a Linux host, the
// counterpart of ops/install-launch-agents.sh on the Mac. Run as root from the
// repo; safe to run again. Units are typed values rendered to unit files.
//   sudo node ops/install-systemd.ts server [--aws] [--dry-run]
//   sudo AGENTS_API_ADDRESS=<server> node ops/install-systemd.ts boxes [--aws] [--dry-run]
//
// server: Electric and the forge through Compose (with Postgres too, except on
//   AWS where it is RDS), the API, this host's daemon when its daemon.json
//   exists, and tailscale serve for the people socket when Tailscale is installed.
// boxes: the box firewall (ops/aws/box-firewall.ts), which Docker requires, so
//   no box runs without it.
// --aws adds the secrets written at boot, the nightly backup and the sudo rules
//   the update and restore steps use (server), and the health timer (both).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { hasCode } from '../shared/errors.ts'
import { MACHINE_PORT, Port } from '../shared/listen.ts'
import { PEOPLE_SOCKET_FILE, Role, SETTINGS_FILE, settingsFrom } from './aws/config.ts'
import { isDryRun, run } from './aws/steps.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const NODE = process.execPath
const UNIT_DIR = '/etc/systemd/system'
const FIREWALL_ENV = '/etc/agents/box-firewall.env'
const SUDOERS = '/etc/sudoers.d/agents'

const Settings = z.object({
  AGENTS_USER: z.string().regex(/^[a-z_][a-z0-9_-]*$/).default('agents'),
})
const AwsSettings = z.object({ AWS_REGION: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/) })
const BoxSettings = z.object({
  AGENTS_API_ADDRESS: z.ipv4(),
  AGENTS_API_PORT: Port.default(MACHINE_PORT),
})

// A unit file: its name and its sections, each a list of directives in order.
type Directive = readonly [string, string]
type UnitFile = { name: string; sections: Record<'Unit' | 'Service' | 'Timer' | 'Install', readonly Directive[] | undefined> }
// What to do with each unit after its file is written.
type Start = 'restart' | 'start' | 'enable only'
type Planned = { file: UnitFile; start: Start }

const render = (file: UnitFile) => Object.entries(file.sections)
  .filter((entry): entry is [string, readonly Directive[]] => entry[1] !== undefined)
  .map(([section, directives]) => [`[${section}]`, ...directives.map(([key, value]) => `${key}=${value}`)].join('\n'))
  .join('\n\n') + '\n'

const role = Role.parse(process.argv[2])
const aws = process.argv.includes('--aws')
const dryRun = isDryRun()
const settings = settingsFrom(Settings, 'the install settings')
const user = settings.AGENTS_USER
const home = `/home/${user}`
// Settings that are not secrets, such as AGENTS_MAX_BOXES. The API reads them after
// .env, so they win. fetch-secrets.ts writes .env at every boot, and never this file.
const settingsFile = join(home, '.agents-app', SETTINGS_FILE)
// Where the API serves people. The service user's .env names the same path, as fetch-secrets.ts writes it.
const peopleSocket = join(home, '.agents-app', PEOPLE_SOCKET_FILE)
const path = `${dirname(NODE)}:/usr/local/bin:/usr/bin:/bin`
const region: Directive[] = aws ? [['Environment', `AWS_REGION=${settingsFrom(AwsSettings, 'the AWS settings').AWS_REGION}`]] : []
const asUser: Directive[] = [['User', user], ['WorkingDirectory', ROOT], ['Environment', `PATH=${path}`], ...region]
const keepRunning: Directive[] = [['Restart', 'always'], ['RestartSec', '5']]
const atBoot: Directive[] = [['WantedBy', 'multi-user.target']]
const oneShot: Directive[] = [['Type', 'oneshot']]

// A service run every so often by a timer. The timer is what starts at boot.
function timed(name: string, description: string, command: string, timer: Directive[]): Planned[] {
  return [
    { file: { name: `${name}.service`, sections: { Unit: [['Description', description]], Service: [...oneShot, ...asUser, ['ExecStart', command]], Timer: undefined, Install: undefined } }, start: 'enable only' },
    { file: { name: `${name}.timer`, sections: { Unit: [['Description', `${description}, on a timer`]], Service: undefined, Timer: timer, Install: [['WantedBy', 'timers.target']] } }, start: 'start' },
  ]
}

function serverUnits(): Planned[] {
  const files = aws ? ['-f', 'compose.yaml', '-f', 'ops/aws/compose.server.yaml'] : []
  const services = aws ? ['electric', 'forge'] : ['postgres', 'electric', 'forge']
  const secrets = aws ? ['agents-secrets.service'] : []
  const units: Planned[] = [
    {
      file: {
        name: 'agents-compose.service',
        sections: {
          Unit: [['Description', `Agents: ${services.join(', ')} in Docker Compose`], ['Requires', 'docker.service'],
            ['After', ['docker.service', 'network-online.target', ...secrets].join(' ')], ['Wants', 'network-online.target']],
          Service: [...oneShot, ['RemainAfterExit', 'yes'], ...asUser,
            ['ExecStart', ['docker', 'compose', ...files, 'up', '-d', '--wait', ...services].join(' ')],
            ['ExecStop', ['docker', 'compose', ...files, 'stop', ...services].join(' ')]],
          Timer: undefined, Install: atBoot,
        },
      },
      start: 'start',
    },
    {
      file: {
        name: 'agents-api.service',
        sections: {
          Unit: [['Description', 'Agents API: the machine and people ports, the runner and the stream server'],
            ['After', ['network-online.target', 'agents-compose.service', 'tailscaled.service', ...secrets].join(' ')], ['Wants', 'agents-compose.service network-online.target']],
          Service: [...asUser, ['ExecStart', `${NODE} --env-file=.env --env-file-if-exists=${settingsFile} server/api.ts`], ...keepRunning],
          Timer: undefined, Install: atBoot,
        },
      },
      start: 'restart',
    },
  ]
  if (existsSync(join(home, '.agents-app', 'daemon.json'))) {
    units.push({
      file: {
        name: 'agents-daemon.service',
        sections: {
          Unit: [['Description', "Agents daemon for this host's own agents"], ['After', 'network-online.target agents-api.service']],
          Service: [...asUser, ['ExecStart', `${NODE} daemon/agentsd.ts`], ...keepRunning], Timer: undefined, Install: atBoot,
        },
      },
      start: 'restart',
    })
  }
  if (!aws) return units
  return [
    {
      file: {
        name: 'agents-secrets.service',
        sections: {
          Unit: [['Description', 'Agents: write the secrets from SSM and Secrets Manager to files'], ['Before', 'agents-compose.service agents-api.service'],
            ['After', 'network-online.target'], ['Wants', 'network-online.target']],
          Service: [...oneShot, ['RemainAfterExit', 'yes'], ...asUser, ['ExecStart', `${NODE} ops/aws/fetch-secrets.ts --to ${join(ROOT, '.env')}`]],
          Timer: undefined, Install: atBoot,
        },
      },
      start: 'restart',
    },
    ...units,
    ...timed('agents-backup', 'Agents: back up the database and the forge to S3', `${NODE} --env-file=.env ops/aws/backup.ts`,
      [['OnCalendar', '*-*-* 03:30:00 UTC'], ['RandomizedDelaySec', '10min'], ['Persistent', 'true']]),
    ...timed('agents-health', 'Agents: report health to CloudWatch', `${NODE} --env-file=.env ops/aws/health.ts server`,
      [['OnBootSec', '2min'], ['OnUnitActiveSec', '1min'], ['AccuracySec', '5s']]),
  ]
}

function boxUnits(): Planned[] {
  const units: Planned[] = [
    {
      file: {
        name: 'agents-box-firewall.service',
        sections: {
          Unit: [['Description', 'Agents box firewall: boxes reach the internet and the machine port, and nothing else private'], ['Before', 'docker.service']],
          Service: [...oneShot, ['RemainAfterExit', 'yes'], ['EnvironmentFile', FIREWALL_ENV], ['ExecStart', `${NODE} ${ROOT}/ops/aws/box-firewall.ts`]],
          Timer: undefined,
          // Docker requires the firewall, so a firewall that fails keeps every box from starting.
          Install: [['WantedBy', 'multi-user.target'], ['RequiredBy', 'docker.service']],
        },
      },
      start: 'restart',
    },
  ]
  if (!aws) return units
  return [...units, ...timed('agents-health', 'Agents: report health to CloudWatch', `${NODE} ops/aws/health.ts boxes`,
    [['OnBootSec', '2min'], ['OnUnitActiveSec', '1min'], ['AccuracySec', '5s']])]
}

// Writes a file when its content differs. In a dry run, says what it would write.
function place(file: string, content: string, mode: number) {
  if (dryRun) {
    console.log(`would write ${file}:\n${content}`)
    return
  }
  mkdirSync(dirname(file), { recursive: true })
  if (!existsSync(file) || readFileSync(file, 'utf8') !== content) writeFileSync(file, content, { mode })
}
const command = (file: string, args: string[]) => {
  if (dryRun) console.log(`would run ${file} ${args.join(' ')}`)
  else run(file, args)
}

const planned = role === 'server' ? serverUnits() : boxUnits()
if (role === 'boxes') {
  const box = settingsFrom(BoxSettings, "the box firewall's settings")
  place(FIREWALL_ENV, Object.entries(box).map(([key, value]) => `${key}=${String(value)}`).join('\n') + '\n', 0o644)
}
// The update and restore steps stop, start and restart these services, as the service user.
const RESTARTS: Record<Role, string[]> = {
  server: ['restart agents-api.service', 'stop agents-api.service agents-compose.service', 'start agents-compose.service agents-api.service', 'restart agents-secrets.service'],
  boxes: ['restart agents-box-firewall.service'],
}
if (aws) {
  const rules = RESTARTS[role].map((rule) => `${user} ALL=(root) NOPASSWD: /usr/bin/systemctl ${rule}`)
  const content = `# Written by ops/install-systemd.ts.\n${rules.join('\n')}\n`
  if (!dryRun) {
    writeFileSync(`${SUDOERS}.new`, content, { mode: 0o440 })
    run('visudo', ['-cf', `${SUDOERS}.new`])
    run('mv', [`${SUDOERS}.new`, SUDOERS])
  } else console.log(`would write ${SUDOERS}, checked with visudo:\n${content}`)
}
for (const { file } of planned) place(join(UNIT_DIR, file.name), render(file), 0o644)
command('systemctl', ['daemon-reload'])
command('systemctl', ['enable', ...planned.map(({ file }) => file.name)])
for (const { file, start } of planned) {
  if (start === 'restart') command('systemctl', ['restart', file.name])
  if (start === 'start') command('systemctl', ['start', file.name])
}
// Whether a program is installed. Not finding it is the one failure expected here.
function installed(program: string): boolean {
  try {
    execFileSync(program, ['version'], { stdio: 'ignore' })
    return true
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  }
}
// tailscale serve keeps this setting itself, across restarts. Serving a socket needs root, which this has.
if (role === 'server' && (dryRun || installed('tailscale'))) {
  command('tailscale', ['serve', '--bg', '--http=80', `unix:${peopleSocket}`])
}
console.log(dryRun ? 'dry run: nothing changed' : `installed ${planned.length} units for the ${role}`)
