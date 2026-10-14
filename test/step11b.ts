// AWS step 11b: boxes on a box host reached over SSH. Colima's VM stands in for
// the box host. Docker commands reach it as ssh://colima, through Lima's own SSH
// config, while the server's DOCKER_HOST points at a socket that does not exist,
// as on the AWS server, where box commands must never go to the server's Docker.
// The box image builds there, a box starts there with its settings, the runner
// starts it again after it stops and replaces it after it is removed, all over SSH.
//   node --env-file=.env --env-file=.env.test test/step11b.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { z } from 'zod'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
// This check owns ports 7909 to 7911.
const MACHINES = 7909
const PEOPLE = 7910
const STREAMS = 7911
// Lima writes this SSH config for colima's VM. `ssh -F` with it reaches the VM as `colima`.
const COLIMA_SSH_CONFIG = join(homedir(), '.colima', 'ssh_config')
// The runner ticks every two seconds. A stopped or removed box is back within a few.
const RUNNER_MS = 30_000
const START_MS = 20_000
// Where the boxes are told the server is. A documentation address (RFC 5737),
// so a box's calls go nowhere. This check never needs a box to come online.
const BOX_API = 'http://192.0.2.10:7700'
// A build's progress output, cached or not, fits in this.
const BUILD_OUTPUT_BYTES = 64 * 1024 * 1024

const id = randomBytes(4).toString('hex')
const team = `aws-${id}`
const login = `aws-${id}@local`
const image = `agents-box:aws-step11b-${id}`
const work = mkdtempSync(join(tmpdir(), 'agents-step11b-'))
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const failures: string[] = []
const children: ChildProcess[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

// The Docker CLI finds `ssh` on the PATH and passes no config of its own, so a
// wrapper first on the PATH adds Lima's config. That is the only way in.
const bin = join(work, 'bin')
mkdirSync(bin)
writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F '${COLIMA_SSH_CONFIG}' "$@"\n`)
chmodSync(join(bin, 'ssh'), 0o755)
const claudeTokenFile = join(work, 'box-claude-token')
const claudeToken = `sk-ant-oat01-${randomBytes(24).toString('base64url')}`
writeFileSync(claudeTokenFile, `${claudeToken}\n`, { mode: 0o600 })

// The server's settings: its own Docker is unreachable, its boxes are on the box host.
const serverEnv: NodeJS.ProcessEnv = {
  ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`,
  DOCKER_HOST: `unix://${join(work, 'no-docker.sock')}`, AGENTS_BOX_DOCKER_HOST: 'ssh://colima',
  AGENTS_BOX_API: BOX_API, AGENTS_BOX_IMAGE: image, AGENTS_BOX_TOKEN_FILE: claudeTokenFile,
  AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(MACHINES), AGENTS_PEOPLE_PORT: String(PEOPLE),
  AGENTS_STREAMS_PORT: String(STREAMS), AGENTS_STREAMS_DIR: join(work, 'streams'),
}
delete serverEnv.AGENTS_BOX_DOCKER_ARGS
delete serverEnv.AGENTS_MACHINE_HOST

const boxes = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', 'server/boxes.ts', ...args],
  { cwd: ROOT, encoding: 'utf8', env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: BUILD_OUTPUT_BYTES })
// The check itself looks at the box host through colima's usual context, never over SSH.
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
// Null when the command fails, as it does for a container, volume or image that is not there.
const tryDocker = (...args: string[]) => {
  try {
    return docker(...args)
  } catch {
    return null
  }
}

const Container = z.object({
  Id: z.string(),
  State: z.object({ Running: z.boolean() }),
  Config: z.object({ Image: z.string(), Env: z.array(z.string()), Labels: z.record(z.string(), z.string()) }),
  Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string() })),
})
type Container = z.infer<typeof Container>
const inspect = (name: string): Container | null => {
  const out = tryDocker('container', 'inspect', name)
  return out === null ? null : must(z.array(Container).parse(JSON.parse(out))[0], `the container ${name}`)
}
const envOf = (container: Container, name: string) => container.Config.Env.find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1)
const tokenOf = async (boxId: string) =>
  must((await db.query<{ token_sha256: string }>('select token_sha256 from instances where id = $1', [boxId])).rows[0], 'the box').token_sha256

async function within(ms: number, test: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(500)
  }
  return false
}

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

let boxId = ''
try {
  if (!existsSync(COLIMA_SSH_CONFIG)) throw new Error(`no ${COLIMA_SSH_CONFIG}: colima must be running`)
  await db.connect()
  execFileSync(process.execPath, ['--env-file=.env', 'server/migrate.ts'], { cwd: ROOT })
  execFileSync(process.execPath, ['--env-file=.env', 'server/admin.ts', 'add-team', team, login], { cwd: ROOT })

  const built = boxes('build')
  check(built.includes(`built ${image} on ssh://colima`) && tryDocker('image', 'inspect', '--format', '{{.Id}}', image) !== null,
    'the box image builds on the box host over SSH while the server\'s own Docker is unreachable')

  const created = z.object({ instanceId: z.uuid() }).parse(JSON.parse(boxes('create', team, `box-${id}`)))
  boxId = created.instanceId
  const container = `agents-box-${boxId}`
  const first = must(inspect(container), 'the new box container')
  const token = must(envOf(first, 'AGENTS_TOKEN'), 'the box token in the container')
  check(first.State.Running && first.Config.Image === image && first.Config.Labels['agents.instance'] === boxId,
    'a new box runs on the box host from the image built there, labelled with its instance')
  check(first.Mounts.some((m) => m.Type === 'volume' && m.Name === `${container}-home` && m.Destination === '/home/agent'),
    "the box's home folder is a volume on the box host")
  check(envOf(first, 'AGENTS_API') === BOX_API, `the box reaches the server at AGENTS_BOX_API (${BOX_API})`)
  check(sha256(token) === await tokenOf(boxId) && envOf(first, 'CLAUDE_CODE_OAUTH_TOKEN') === claudeToken,
    'both tokens reached the container through the Docker CLI\'s environment, and the server keeps the box token\'s hash')

  // A person holds the box, so the server's runner keeps it running.
  await db.query(`update instances set claimed_by = (select id from people where login = $2), claimed_at = now() where id = $1`, [boxId, login])
  const api = spawn(process.execPath, ['--env-file=.env', 'server/api.ts'], { cwd: ROOT, env: serverEnv, stdio: ['ignore', 'ignore', 'pipe'] })
  children.push(api)
  let log = ''
  api.stderr.on('data', (chunk: Buffer) => { log += chunk.toString() })
  check(await within(START_MS, async () => (await fetch(`http://127.0.0.1:${MACHINES}`).then(() => true, () => false))),
    'the server starts with its boxes on the box host')

  docker('stop', container)
  check(await within(RUNNER_MS, () => inspect(container)?.State.Running === true) && inspect(container)?.Id === first.Id
    && sha256(token) === await tokenOf(boxId),
  'a held box that stops is started again over SSH, the same container with the same token')

  docker('rm', '-f', container)
  const replaced = await within(RUNNER_MS, () => { const now = inspect(container); return now !== null && now.Id !== first.Id && now.State.Running })
  const second = inspect(container)
  const newToken = second ? envOf(second, 'AGENTS_TOKEN') : undefined
  check(replaced && newToken !== undefined && newToken !== token && sha256(newToken) === await tokenOf(boxId)
    && second?.Mounts.some((m) => m.Name === `${container}-home`),
  'a held box whose container is gone gets a new one over SSH, with a new token and the same home volume')
  check(!log.includes(claudeToken) && !log.includes(token), 'the server\'s log holds no token')
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  await sleep(1000)
  // Containers, volumes and the image this check made go whatever happened.
  if (boxId) {
    tryDocker('rm', '-f', `agents-box-${boxId}`)
    tryDocker('volume', 'rm', `agents-box-${boxId}-home`)
  }
  tryDocker('image', 'rm', image)
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team])
    rmSync(work, { recursive: true, force: true })
  }
  await db.end()
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} and ${work} kept)` : 'all passed (test team, box, volume and image removed)'}`)
process.exit(failures.length ? 1 : 0)
