// AWS step 11e: the scripts that run on the AWS hosts, against a fake AWS that
// speaks the real wire protocols (SSM and Secrets Manager's JSON 1.1, CloudWatch's
// JSON 1.0, and S3's REST API, each request signed), with a real Postgres and
// real Docker. The secrets land in files with mode 600 and never in output. The
// nightly backup uploads a dump and the forge's volume, and the restore brings
// both back into a new database and volume, after refusing while anything is
// connected. The health report sends what the alarms watch, and notices a
// stopped API. Every script's dry run makes no AWS call, and the systemd
// installer and the Compose override say what docs/design/aws.md says.
//   node --env-file=.env --env-file=.env.test test/step11e.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseEnv } from 'node:util'
import pg from 'pg'
import { z } from 'zod'
import { BOX_DNS } from '../ops/aws/config.ts'
import { startFakeAws } from './fake-aws.ts'
import { must } from './must.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
// This check owns ports 7913 to 7917: the fake AWS, a test API's machine and stream
// ports, the stand-in for serve that takes people to its socket, and one that
// nothing listens on, for export.ts to find the API stopped.
const AWS_PORT = 7913
const API_PORTS = { machines: 7914, people: 7915, streams: 7916 } as const
const UNUSED_PORT = 7917
const START_MS = 20_000
const BUCKET = 'agents-test-bucket'
const REGION = 'us-east-1'
const SECRET_ARN = `arn:aws:secretsmanager:${REGION}:111111111111:secret:agents-db-AbCdEf`

const id = randomBytes(4).toString('hex')
const work = mkdtempSync(join(tmpdir(), 'agents-step11e-'))
const failures: string[] = []
const children: ChildProcess[] = []
function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

// ---- Running the scripts, against a fake AWS ----

const fake = await startFakeAws(AWS_PORT, BUCKET, REGION)
const { calls, parameters, secrets, objects, metrics, script } = fake
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
// Null when the command fails, as it does for a container or volume that is not there.
const tryDocker = (...args: string[]) => {
  try {
    return docker(...args)
  } catch {
    return null
  }
}
const mode = (file: string) => statSync(file).mode & 0o777
const testUrl = new URL(must(process.env.DATABASE_URL, 'DATABASE_URL'))
const urlFor = (database: string) => { const url = new URL(testUrl); url.pathname = `/${database}`; return url.toString() }
const password = decodeURIComponent(testUrl.password)

const scratch = `aws_step11e_${id}`
const restored = `aws_step11e_${id}_restored`
const forgeVolume = `aws-step11e-${id}-forge`
const forge2 = `aws-step11e-${id}-forge2`
const electricVolume = `aws-step11e-${id}-electric`
const forgeContainer = `aws-step11e-${id}-forge`
const appHome = join(work, 'app-home')
const admin = new pg.Client({ connectionString: testUrl.toString() })

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  await admin.connect()
  mkdirSync(appHome)

  // ---- secrets.ts ----
  const keyFile = join(work, 'tailscale-key')
  const key = `tskey-auth-${randomBytes(12).toString('hex')}`
  writeFileSync(keyFile, `${key}\n`, { mode: 0o600 })
  const dry = await script(['ops/aws/secrets.ts', 'put', 'tailscale-server', '--file', keyFile, '--dry-run'])
  check(dry.status === 0 && calls.length === 0 && !dry.out.includes(key), "secrets.ts's dry run makes no AWS call and never prints the value")
  const put = await script(['ops/aws/secrets.ts', 'put', 'tailscale-server', '--file', keyFile])
  const stored = parameters.get('/agents/tailscale/server')
  check(put.status === 0 && stored?.value === key && stored.type === 'SecureString' && stored.tags.app === 'agents' && !put.out.includes(key),
    'secrets.ts stores the key as a SecureString tagged app=agents, and never prints it')
  const again = await script(['ops/aws/secrets.ts', 'put', 'tailscale-server'], {}, 'tskey-auth-second\n')
  check(again.status === 0 && parameters.get('/agents/tailscale/server')?.value === 'tskey-auth-second' && again.out.includes('replaced'),
    'putting it again from stdin replaces it')

  // ---- fetch-secrets.ts ----
  const dbPassword = 'pa ss+word&more'
  const config = { region: REGION, bucket: BUCKET, databaseSecretArn: SECRET_ARN, serverAddress: '10.40.0.10', boxHostAddress: '10.40.0.20', resolver: '10.40.0.2', machinePort: 7700 }
  parameters.set('/agents/config', { value: JSON.stringify(config), type: 'String', tags: {} })
  parameters.set('/agents/server/hook-secret', { value: 'hook-secret-from-the-mac', type: 'SecureString', tags: {} })
  parameters.set('/agents/server/box-claude-token', { value: 'sk-ant-oat01-boxes', type: 'SecureString', tags: {} })
  parameters.set('/agents/server/forge-json', { value: JSON.stringify({ url: 'http://127.0.0.1:3001', token: 'forge-token' }), type: 'SecureString', tags: {} })
  secrets.set(SECRET_ARN, JSON.stringify({ username: 'agents', password: dbPassword, host: 'agents-db.example.us-east-1.rds.amazonaws.com', port: 5432, dbname: 'agents', engine: 'postgres' }))
  const envFile = join(work, 'server.env')
  const fetchSecrets = () => script(['ops/aws/fetch-secrets.ts', '--to', envFile], { AGENTS_HOME: appHome })
  const first = await fetchSecrets()
  const env = parseEnv(existsSync(envFile) ? readFileSync(envFile, 'utf8') : '')
  const databaseUrl = new URL(env.DATABASE_URL ?? 'missing://')
  check(first.status === 0 && mode(envFile) === 0o600 && decodeURIComponent(databaseUrl.password) === dbPassword
    && databaseUrl.searchParams.get('sslmode') === 'verify-full' && databaseUrl.searchParams.get('sslrootcert') === join(appHome, 'rds-ca.pem'),
  "fetch-secrets.ts writes .env with mode 600, and a DATABASE_URL that checks RDS's certificate and keeps the password whole")
  check(env.AGENTS_HOOK_SECRET === 'hook-secret-from-the-mac' && /^[0-9a-f]{64}$/.test(env.ELECTRIC_SECRET ?? '') && env.AGENTS_MACHINE_HOST === '0.0.0.0'
    && env.AGENTS_BOX_DOCKER_HOST === 'ssh://agents@agents-boxes' && env.AGENTS_BOX_API === 'http://10.40.0.10:7700' && env.AGENTS_BACKUP_BUCKET === BUCKET
    && env.AGENTS_PEOPLE_SOCKET === join(appHome, 'people.sock') && env.AGENTS_PEOPLE_PORT === undefined,
  "it sets the machine port's address, the people socket in the app's home, the box host, where boxes reach the server, and the bucket")
  check(mode(join(appHome, 'forge.json')) === 0o600 && readFileSync(join(appHome, 'box-claude-token'), 'utf8') === 'sk-ant-oat01-boxes\n'
    && mode(join(appHome, 'box-claude-token')) === 0o600, "the forge's config and the Claude token for boxes land in files with mode 600")
  check(![dbPassword, 'hook-secret-from-the-mac', 'sk-ant-oat01-boxes', 'forge-token'].some((value) => first.out.includes(value)), 'fetch-secrets.ts prints no secret')
  parameters.delete('/agents/server/box-claude-token')
  const second = await fetchSecrets()
  check(second.status === 0 && parseEnv(readFileSync(envFile, 'utf8')).ELECTRIC_SECRET === env.ELECTRIC_SECRET && !existsSync(join(appHome, 'box-claude-token')),
    'a second run keeps ELECTRIC_SECRET, and removes the Claude token once its parameter is gone')

  // ---- backup.ts and restore.ts ----
  await admin.query(`create database ${admin.escapeIdentifier(scratch)}`)
  const source = new pg.Client({ connectionString: urlFor(scratch) })
  await source.connect()
  await source.query('create table notes (id int primary key, body text)')
  await source.query('insert into notes values (1, $1)', [`kept ${id}`])
  await source.end()
  docker('volume', 'create', forgeVolume)
  docker('run', '--rm', '-v', `${forgeVolume}:/data`, 'alpine:3.20', 'mkdir', '-p', '/data/gitea')
  execFileSync('docker', ['run', '--rm', '-i', '-v', `${forgeVolume}:/data`, 'alpine:3.20', 'tee', '/data/gitea/hello.txt'], { input: `forge ${id}\n`, stdio: ['pipe', 'ignore', 'inherit'] })
  docker('run', '-d', '--name', forgeContainer, '-v', `${forgeVolume}:/data`, 'alpine:3.20', 'sleep', '600')
  const backupEnv = { DATABASE_URL: urlFor(scratch), AGENTS_BACKUP_BUCKET: BUCKET, AGENTS_FORGE_CONTAINER: forgeContainer, AGENTS_FORGE_VOLUME: forgeVolume, AGENTS_HOME: appHome }
  const callsBefore = calls.length
  const backupDry = await script(['ops/aws/backup.ts', '--dry-run'], backupEnv)
  check(backupDry.status === 0 && calls.length === callsBefore && docker('inspect', '-f', '{{.State.Running}}', forgeContainer) === 'true',
    "backup.ts's dry run makes no AWS call and leaves the forge running")
  const backup = await script(['ops/aws/backup.ts'], backupEnv)
  const dumpKey = [...objects.keys()].find((name) => new RegExp(`^${BUCKET}/backups/[0-9TZ-]+/agents\\.dump$`).test(name))
  const prefix = dumpKey?.slice(`${BUCKET}/`.length).replace(/agents\.dump$/, '') ?? 'none/'
  check(backup.status === 0 && objects.get(`${BUCKET}/${prefix}agents.dump`)?.subarray(0, 5).toString() === 'PGDMP'
    && objects.get(`${BUCKET}/${prefix}forge.tar.gz`)?.[0] === 0x1f, `backup.ts uploads a custom-format dump and a gzip of the forge's volume to ${prefix}`)
  const state = z.object({ lastSuccess: z.string(), location: z.string() }).safeParse(JSON.parse(readFileSync(join(appHome, 'backup-state.json'), 'utf8')))
  check(state.success && state.data.location === `s3://${BUCKET}/${prefix}` && docker('inspect', '-f', '{{.State.Running}}', forgeContainer) === 'true'
    && !backup.out.includes(password), 'it records the time and place of the backup, starts the forge again, and prints no password')

  await admin.query(`create database ${admin.escapeIdentifier(restored)}`)
  docker('volume', 'create', forge2)
  docker('volume', 'create', electricVolume)
  docker('run', '--rm', '-v', `${electricVolume}:/data`, 'alpine:3.20', 'touch', '/data/shape-log')
  const restoreEnv = { DATABASE_URL: urlFor(restored), AGENTS_FORGE_VOLUME: forge2, AGENTS_ELECTRIC_VOLUME: electricVolume }
  const busy = new pg.Client({ connectionString: urlFor(restored), application_name: 'still-connected' })
  await busy.connect()
  const refused = await script(['ops/aws/restore.ts', `s3://${BUCKET}/${prefix}`], restoreEnv)
  await busy.end()
  check(refused.status !== 0 && refused.out.includes('still-connected'), 'restore.ts refuses while a session is connected to the database, and names it')
  docker('run', '-d', '--name', `${forgeContainer}-2`, '-v', `${forge2}:/data`, 'alpine:3.20', 'sleep', '600')
  const inUse = await script(['ops/aws/restore.ts', `s3://${BUCKET}/${prefix}`], restoreEnv)
  docker('rm', '-f', `${forgeContainer}-2`)
  check(inUse.status !== 0 && inUse.out.includes(`${forgeContainer}-2`), "it refuses while a container uses the forge's volume, and names it")
  const restore = await script(['ops/aws/restore.ts', `s3://${BUCKET}/${prefix}`], restoreEnv)
  const back = new pg.Client({ connectionString: urlFor(restored) })
  await back.connect()
  const note = (await back.query<{ body: string }>('select body from notes where id = 1')).rows[0]
  await back.end()
  check(restore.status === 0 && note?.body === `kept ${id}`, 'restore.ts brings the database back whole into the database in DATABASE_URL')
  check(docker('run', '--rm', '-v', `${forge2}:/data`, 'alpine:3.20', 'cat', '/data/gitea/hello.txt') === `forge ${id}`
    && docker('run', '--rm', '-v', `${electricVolume}:/data`, 'alpine:3.20', 'ls', '-A', '/data') === '' && !restore.out.includes(password),
  "it brings the forge's volume back, empties Electric's, and prints no password")

  // ---- health.ts ----
  const peopleSocket = join(work, 'people', 'people.sock')
  await servePeople(API_PORTS.people, peopleSocket)
  const api = spawn(process.execPath, ['server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, AGENTS_RUNNER: 'off', AGENTS_API_PORT: String(API_PORTS.machines), AGENTS_PEOPLE_SOCKET: peopleSocket,
      AGENTS_STREAMS_PORT: String(API_PORTS.streams), AGENTS_STREAMS_DIR: join(work, 'streams') },
  })
  children.push(api)
  // Made now, since an API killed by a signal keeps a null exitCode and has already sent 'exit'.
  const apiExited = new Promise((resolve) => { api.once('exit', resolve) })
  const deadline = Date.now() + START_MS
  while (Date.now() < deadline && !(await fetch(`http://127.0.0.1:${API_PORTS.people}/v1/me`).then(() => true, () => false))) await sleep(250)
  const healthEnv = { AGENTS_API_PORT: String(API_PORTS.machines), AGENTS_PEOPLE_SOCKET: peopleSocket, AGENTS_HOME: appHome }
  const sent = (host: string) => Object.fromEntries(metrics.filter((m) => m.host === host && m.namespace === 'Agents').map((m) => [m.name, m.value]))
  const healthDry = await script(['ops/aws/health.ts', 'server', '--dry-run'], healthEnv)
  check(healthDry.status === 0 && metrics.length === 0 && healthDry.out.includes('ApiUp=1'), "health.ts's dry run measures and prints, and sends nothing")
  const up = await script(['ops/aws/health.ts', 'server'], healthEnv)
  const server = sent('server')
  check(up.status === 0 && server.ApiUp === 1 && server.ElectricUp === 1 && server.ForgeUp === 1,
    'health.ts reports the API, Electric and the forge up, with Host=server, in the Agents namespace')
  check([server.DiskUsedPercent, server.MemoryUsedPercent].every((value) => value !== undefined && value > 0 && value <= 100)
    && server.BackupAgeHours !== undefined && server.BackupAgeHours < 1, 'it reports disk and memory use, and an hour-old-at-most backup')
  metrics.length = 0
  const noPeople = await script(['ops/aws/health.ts', 'server'], { ...healthEnv, AGENTS_PEOPLE_SOCKET: join(work, 'no-api.sock') })
  check(noPeople.status === 0 && sent('server').ApiUp === 0, 'with the machine port up and nothing on the people socket it reports ApiUp=0')
  api.kill('SIGTERM')
  await apiExited
  metrics.length = 0
  const down = await script(['ops/aws/health.ts', 'server'], healthEnv)
  check(down.status === 0 && sent('server').ApiUp === 0, 'with the API stopped it reports ApiUp=0, which raises the alarm')
  metrics.length = 0
  const boxes = await script(['ops/aws/health.ts', 'boxes'])
  check(boxes.status === 0 && Object.keys(sent('boxes')).sort().join(',') === 'DiskUsedPercent,MemoryUsedPercent', 'on the box host it reports disk and memory only')

  // ---- Dry runs that touch nothing ----
  calls.length = 0
  const dryRuns: [string, string[], Record<string, string>][] = [
    ['bootstrap.ts on the server', ['ops/aws/bootstrap.ts', 'server', '--dry-run'], {}],
    ['bootstrap.ts on the box host', ['ops/aws/bootstrap.ts', 'boxes', '--dry-run'], {}],
    // Everything export.ts could touch is the check's own, so even a dry run that acted would harm nothing.
    ['export.ts', ['ops/aws/export.ts', '--dry-run'], {
      DATABASE_URL: urlFor(scratch), AGENTS_HOOK_SECRET: 'unused', AGENTS_FORGE_CONTAINER: forgeContainer, AGENTS_FORGE_VOLUME: forgeVolume,
      AGENTS_HOME: appHome, AGENTS_API_PORT: String(UNUSED_PORT), AGENTS_PEOPLE_SOCKET: join(work, 'no-api.sock'),
    }],
    ['update.ts on the server', ['ops/aws/update.ts', 'server', '--dry-run'], {}],
    ['update.ts on the box host', ['ops/aws/update.ts', 'boxes', '--dry-run'], {}],
    ['down.ts', ['ops/aws/down.ts', '--delete-backups', '--delete-secrets', '--dry-run'], {}],
    ['restore.ts', ['ops/aws/restore.ts', `s3://${BUCKET}/${prefix}`, '--dry-run'], restoreEnv],
    ['fetch-secrets.ts', ['ops/aws/fetch-secrets.ts', '--to', join(work, 'dry.env'), '--dry-run'], { AGENTS_HOME: appHome }],
  ]
  for (const [label, args, extra] of dryRuns) {
    const ran = await script(args, extra)
    check(ran.status === 0 && ran.out.includes('dry run: nothing changed'), `${label} has a dry run that says what it would do`)
  }
  check(calls.length === 0 && !existsSync(join(work, 'dry.env')) && docker('inspect', '-f', '{{.State.Running}}', forgeContainer) === 'true',
    'none of those dry runs called AWS, wrote a file, or stopped the forge')

  // ---- The systemd units and the Compose override ----
  const serverUnits = await script(['ops/install-systemd.ts', 'server', '--aws', '--dry-run'])
  check(serverUnits.status === 0 && serverUnits.out.includes('--env-file=.env --env-file-if-exists=/home/agents/.agents-app/settings.env server/api.ts') && serverUnits.out.includes('Restart=always')
    && serverUnits.out.includes('Environment=AWS_REGION=us-east-1') && serverUnits.out.includes('OnCalendar=*-*-* 03:30:00 UTC')
    && serverUnits.out.includes('compose.server.yaml up -d --wait electric forge') && serverUnits.out.includes('Before=agents-compose.service agents-api.service'),
  'install-systemd.ts plans the API, with settings that fetch-secrets.ts never writes, Compose without Postgres, the secrets before them, and the nightly backup')
  check(serverUnits.out.includes('would run tailscale serve --bg --http=80 unix:/home/agents/.agents-app/people.sock\n'),
    "it points tailscale serve at the API's people socket in the service user's app home")
  const boxUnits =await script(['ops/install-systemd.ts', 'boxes', '--aws', '--dry-run'], { AGENTS_API_ADDRESS: '10.40.0.10' })
  const firewallUnit = boxUnits.out.slice(boxUnits.out.indexOf('agents-box-firewall.service:'), boxUnits.out.indexOf('agents-health.service:'))
  check(boxUnits.status === 0 && firewallUnit.includes('Before=docker.service') && firewallUnit.includes('RequiredBy=docker.service')
    && boxUnits.out.includes('AGENTS_API_ADDRESS=10.40.0.10\nAGENTS_API_PORT=7700\n'),
  "on the box host, Docker requires the firewall, which runs before it with the server's address")
  check(boxUnits.out.includes('agents ALL=(root) NOPASSWD: /usr/bin/systemctl restart agents-box-firewall.service\n')
    && !boxUnits.out.includes('agents-api.service'),
  'the service user may restart the firewall on the box host after an update, and nothing of the server\'s')
  const boxBoot = await script(['ops/aws/bootstrap.ts', 'boxes', '--dry-run'])
  check(boxBoot.out.includes(`"icc":false,"dns":${JSON.stringify(BOX_DNS)}`),
    "on the box host, Docker keeps boxes from each other and gives them the public resolvers")
  const composeEnv = join(work, 'compose.env')
  writeFileSync(composeEnv, 'ELECTRIC_DATABASE_URL=postgres://agents:fake@rds.example:5432/agents?sslmode=require\nELECTRIC_SECRET=fake\nPOSTGRES_PASSWORD=unused-on-aws\n')
  const Compose = z.object({ services: z.object({
    electric: z.object({ environment: z.record(z.string(), z.string().nullable()), depends_on: z.unknown().optional() }),
    forge: z.object({ extra_hosts: z.unknown() }),
  }) })
  const compose = Compose.parse(JSON.parse(execFileSync('docker', ['compose', '--env-file', composeEnv, '-f', 'compose.yaml', '-f', 'ops/aws/compose.server.yaml', 'config', '--format', 'json'],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })))
  check(compose.services.electric.environment.DATABASE_URL === 'postgres://agents:fake@rds.example:5432/agents?sslmode=require'
    && compose.services.electric.depends_on === undefined && JSON.stringify(compose.services.forge.extra_hosts).includes('host.docker.internal')
    && JSON.stringify(compose.services.forge.extra_hosts).includes('host-gateway'),
  'the Compose override points Electric at RDS with no local Postgres to wait for, and gives the forge a way to the host')
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  // Docker things and databases this check made go whatever happened.
  for (const name of [forgeContainer, `${forgeContainer}-2`]) tryDocker('rm', '-f', name)
  for (const name of [forgeVolume, forge2, electricVolume]) tryDocker('volume', 'rm', name)
  for (const name of [scratch, restored]) await admin.query(`drop database if exists ${admin.escapeIdentifier(name)} with (force)`).catch((error: unknown) => {
    console.error(`dropping ${name}: ${error instanceof Error ? error.message : String(error)}`)
  })
  await admin.end().catch((error: unknown) => { console.error(`closing: ${error instanceof Error ? error.message : String(error)}`) })
  await fake.close()
  if (!failures.length) rmSync(work, { recursive: true, force: true })
}

console.log(`\n${failures.length ? `${failures.length} failed (${work} kept)` : 'all passed (databases, volumes and containers removed)'}`)
process.exit(failures.length ? 1 : 0)
