// Dumping and restoring the database and Docker volumes, shared by the nightly
// backup, the restore and the cutover export. The Postgres tools run from the
// postgres:17 image, so their version always matches the server, on the host's
// network, so they reach RDS from AWS and colima's Postgres from this Mac.
// Connection settings reach them as libpq's environment variables, so a
// password is never in a command line.

import { closeSync, openSync } from 'node:fs'
import pg from 'pg'
import { BOX_LABEL } from '../../shared/boxes.ts'
import { output, run } from './steps.ts'

const POSTGRES_IMAGE = 'postgres:17'
const TOOLS_IMAGE = 'alpine:3.20'

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

// The instances whose box containers are running.
export const runningBoxes = (on: On = {}) =>
  new Set(lines(output('docker', ['ps', '--filter', `label=${BOX_LABEL}`, '--format', `{{.Label "${BOX_LABEL}"}}`], { env: dockerEnv(on) })))
