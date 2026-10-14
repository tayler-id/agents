// Dumping and restoring the database and Docker volumes, shared by the nightly
// backup, the restore and the cutover export. The Postgres tools run from the
// postgres:17 image, so their version always matches the server, on the host's
// network, so they reach RDS from AWS and colima's Postgres from this Mac.
// Connection settings reach them as libpq's environment variables, so a
// password is never in a command line.

import { closeSync, mkdtempSync, openSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { z } from 'zod'
import { BOX_LABEL, BOX_STATE_FORMAT, BoxLine, type ContainerState } from '../../shared/boxes.ts'
import { hasCode } from '../../shared/errors.ts'
import { output, run } from './steps.ts'

const POSTGRES_IMAGE = 'postgres:17'
const TOOLS_IMAGE = 'alpine:3.20'

// Archives are staged here, on disk on both hosts and on this Mac. /tmp on
// Amazon Linux is memory, too small for a database or a box's home.
const STAGING_ROOT = '/var/tmp'
// The room staging must leave: a tenth more than it measured, and 256 MiB, since
// an archive can come out larger than what it holds.
const SPACE_FACTOR = 1.1
const SPACE_SLACK_BYTES = 256 * 1024 * 1024
const MB = 1024 * 1024

export const stagingDir = (prefix: string) => mkdtempSync(join(STAGING_ROOT, prefix))

// Stops unless the disk under a folder has room for this many bytes, with the
// margin above. Otherwise says how much it is and how much is free.
export function ensureSpace(dir: string, bytes: number): string {
  const disk = statfsSync(dir)
  const free = disk.bavail * disk.bsize
  const said = `${String(Math.ceil(bytes / MB))} MB to stage in ${dir}, with ${String(Math.floor(free / MB))} MB free`
  if (free < Math.ceil(bytes * SPACE_FACTOR) + SPACE_SLACK_BYTES) throw new Error(`not enough room: ${said}`)
  return said
}

// A database's size, as Postgres counts it.
export async function databaseBytes(url: URL): Promise<number> {
  const client = new pg.Client({ connectionString: url.toString() })
  await client.connect()
  try {
    const { rows } = await client.query('select pg_database_size(current_database())::text as bytes')
    return z.coerce.number().int().nonnegative().parse(z.object({ bytes: z.string() }).parse(rows[0]).bytes)
  } finally {
    await client.end()
  }
}

// Postgres's codes for a database, and a table, that does not exist.
const NO_DATABASE = '3D000'
const NO_TABLE = '42P01'

// What a database holds, read before it is replaced. A database that does not
// exist yet, or has no Agents tables yet, holds nothing.
async function readIfThere<T>(url: URL, empty: T, read: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url.toString() })
  try {
    await client.connect()
  } catch (error) {
    if (hasCode(error, NO_DATABASE)) return empty
    throw error
  }
  try {
    return await read(client)
  } catch (error) {
    if (hasCode(error, NO_TABLE)) return empty
    throw error
  } finally {
    await client.end()
  }
}

export const teamsIn = (url: URL) => readIfThere(url, 0, async (client) =>
  z.object({ n: z.number() }).parse((await client.query('select count(*)::int as n from teams')).rows[0]).n)

// The box instances a database holds, of the teams named if any.
export const boxInstances = (url: URL, teams: string[] | null) => readIfThere(url, [], async (client) => {
  const { rows } = await client.query(
    `select i.id from instances i join teams t on t.id = i.team_id
     where i.kind = 'box' and ($1::text[] is null or t.name = any($1)) order by i.id`, [teams])
  return z.array(z.object({ id: z.uuid() })).parse(rows).map((row) => row.id)
})

type Libpq = { env: Record<string, string>; args: string[] }

// libpq's variables for a connection URL, and the `docker run` arguments that pass
// them by name and mount the CA file the URL names, at the same path.
function libpq(url: URL): Libpq {
  const env: Record<string, string> = {
    PGHOST: url.hostname, PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
  }
  const sslmode = url.searchParams.get('sslmode')
  if (sslmode) env.PGSSLMODE = sslmode
  const root = url.searchParams.get('sslrootcert')
  if (root) env.PGSSLROOTCERT = root
  const args = ['--network', 'host', ...(root ? ['-v', `${root}:${root}:ro`] : []), ...Object.keys(env).flatMap((name) => ['-e', name])]
  return { env, args }
}

export const databaseOf = (url: URL) => decodeURIComponent(url.pathname.slice(1))

export function dumpDatabase(url: URL, file: string): void {
  const { env, args } = libpq(url)
  const out = openSync(file, 'w', 0o600)
  try {
    run('docker', ['run', '--rm', ...args, POSTGRES_IMAGE, 'pg_dump', '--format=custom', '--dbname', databaseOf(url)],
      { env: { ...process.env, ...env }, stdio: ['ignore', out, 'inherit'] })
  } finally {
    closeSync(out)
  }
}

export function restoreDatabase(url: URL, file: string): void {
  const { env, args } = libpq(url)
  const input = openSync(file, 'r')
  try {
    run('docker', ['run', '--rm', '-i', ...args, POSTGRES_IMAGE, 'pg_restore', '--no-owner', '--no-privileges', '--exit-on-error',
      '--dbname', databaseOf(url)], { env: { ...process.env, ...env }, stdio: [input, 'inherit', 'inherit'] })
  } finally {
    closeSync(input)
  }
}

// A connection to the same server's maintenance database, to drop and create
// the one in the URL.
export function maintenance(url: URL): pg.Client {
  const other = new URL(url)
  other.pathname = '/postgres'
  return new pg.Client({ connectionString: other.toString() })
}

// Volume work runs on this machine's Docker, or on the Docker host named, as the
// box host's is for boxes' home volumes.
type On = { dockerHost?: string }
const dockerEnv = ({ dockerHost }: On): NodeJS.ProcessEnv => (dockerHost ? { ...process.env, DOCKER_HOST: dockerHost } : process.env)
const lines = (text: string) => text.split('\n').filter((line) => line !== '')

export function archiveVolume(volume: string, file: string, on: On = {}): void {
  const out = openSync(file, 'w', 0o600)
  try {
    run('docker', ['run', '--rm', '-v', `${volume}:/data:ro`, TOOLS_IMAGE, 'tar', '-C', '/data', '-czf', '-', '.'], { stdio: ['ignore', out, 'inherit'], env: dockerEnv(on) })
  } finally {
    closeSync(out)
  }
}

export function emptyVolume(volume: string, on: On = {}): void {
  run('docker', ['run', '--rm', '-v', `${volume}:/data`, TOOLS_IMAGE, 'find', '/data', '-mindepth', '1', '-delete'], { env: dockerEnv(on) })
}

// Replaces what a volume holds with an archive's contents, making the volume if it is missing.
export function restoreVolume(volume: string, file: string, on: On = {}): void {
  emptyVolume(volume, on)
  const input = openSync(file, 'r')
  try {
    run('docker', ['run', '--rm', '-i', '-v', `${volume}:/data`, TOOLS_IMAGE, 'tar', '-C', '/data', '-xzf', '-'], { stdio: [input, 'inherit', 'inherit'], env: dockerEnv(on) })
  } finally {
    closeSync(input)
  }
}

// The running containers that have a volume mounted.
export const usersOf = (volume: string, on: On = {}) =>
  lines(output('docker', ['ps', '--filter', `volume=${volume}`, '--format', '{{.Names}}'], { env: dockerEnv(on) }))

export const volumeNames = (on: On = {}) => new Set(lines(output('docker', ['volume', 'ls', '--format', '{{.Name}}'], { env: dockerEnv(on) })))

// How much a volume holds, from du in a throwaway container.
export function volumeBytes(volume: string, on: On = {}): number {
  const kib = output('docker', ['run', '--rm', '-v', `${volume}:/data:ro`, TOOLS_IMAGE, 'du', '-sk', '/data'], { env: dockerEnv(on) })
  return z.coerce.number().int().nonnegative().parse(kib.split(/\s+/)[0]) * 1024
}

// The states in which a box's container is up, or may be again without being
// started, so it can still write to its home. A created or exited container
// cannot, and the runner starts it with the token it was made with.
const LIVE = new Set<ContainerState>(['running', 'restarting', 'paused', 'removing'])
export const isLive = (state: ContainerState) => LIVE.has(state)

// Every box container's state on a Docker host, by its instance id.
export const boxContainerStates = (on: On = {}) => new Map(lines(output('docker',
  ['ps', '--all', '--filter', `label=${BOX_LABEL}`, '--format', BOX_STATE_FORMAT], { env: dockerEnv(on) })).map((line) => BoxLine.parse(line)))

export function removeContainer(name: string, on: On = {}): void {
  run('docker', ['rm', name], { env: dockerEnv(on) })
}
