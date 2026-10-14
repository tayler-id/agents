// Restores a backup, or the export made at cutover, onto the server: the
// database named in DATABASE_URL, the forge's volume, and each box's home volume
// the export holds, on the box host's Docker (AGENTS_BOX_DOCKER_HOST, or this
// machine's when unset). Electric's volume is emptied, so it rebuilds its shapes
// from the restored database. A stopped container of a restored box holds a
// token the restored database does not know, so it is removed, and the runner
// starts that box again with a new token.
//   sudo systemctl stop agents-api agents-compose agents-backup.timer
//   node --env-file=.env ops/aws/restore.ts s3://<bucket>/backups/<time>/ [--replace <database>] [--dry-run]
//   sudo systemctl start agents-compose agents-api agents-backup.timer
// It refuses to replace a database that holds teams, whose work may be newer
// than the export, unless --replace names that database. It refuses while
// anything is connected to the database or uses one of the volumes, and while a
// box of the export or of the database runs, so nothing writes while it works.
// It drops only that database's replication slots, which belong to the Electric
// that followed the old one. With AGENTS_RUNNER_TEAMS set, only those teams'
// boxes are checked and removed, as only those run under such a server.

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { S3Client } from '@aws-sdk/client-s3'
import { z } from 'zod'
import { boxContainer, boxHomeVolume } from '../../shared/boxes.ts'
import {
  boxContainerStates, boxInstances, databaseOf, emptyVolume, ensureSpace, isLive, maintenance, removeContainer, restoreDatabase, restoreVolume,
  stagingDir, teamsIn, usersOf,
} from './archive.ts'
import { download, listObjects, S3Location, type S3Object } from './aws.ts'
import { ELECTRIC_VOLUME, FORGE_VOLUME, RunnerTeams, settingsFrom } from './config.ts'
import { isDryRun, perform } from './steps.ts'

const Settings = z.object({
  DATABASE_URL: z.url(),
  AGENTS_FORGE_VOLUME: z.string().min(1).default(FORGE_VOLUME),
  AGENTS_ELECTRIC_VOLUME: z.string().min(1).default(ELECTRIC_VOLUME),
  AGENTS_BOX_DOCKER_HOST: z.string().min(1).optional(),
  AGENTS_RUNNER_TEAMS: RunnerTeams,
})
const settings = settingsFrom(Settings, 'the restore settings')
const usage = 'usage: node --env-file=.env ops/aws/restore.ts s3://<bucket>/backups/<time>/ [--replace <database>] [--dry-run]'
const args = process.argv.slice(2)
const location = args.find((arg) => arg.startsWith('s3://'))
if (!location) throw new Error(usage)
const from = S3Location.parse(location)
const prefix = from.key.endsWith('/') ? from.key : `${from.key}/`
const replaceAt = args.indexOf('--replace')
const replace = replaceAt === -1 ? undefined : args[replaceAt + 1]
if (replaceAt !== -1 && (replace === undefined || replace.startsWith('-') || replace.startsWith('s3://'))) throw new Error(usage)
const dryRun = isDryRun()
const database = new URL(settings.DATABASE_URL)
const name = databaseOf(database)
if (replace !== undefined && replace !== name) throw new Error(`--replace names ${replace}, but DATABASE_URL names ${name}, so nothing was changed`)
const teams = settings.AGENTS_RUNNER_TEAMS
const boxHost = { dockerHost: settings.AGENTS_BOX_DOCKER_HOST }
const s3 = new S3Client({})
// When the export was taken, from the last part of its prefix, as export.ts and backup.ts name it.
const STAMP = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\/$/
const stamp = STAMP.exec(prefix)
const takenAt = stamp ? `${stamp[1] ?? ''} ${stamp[2] ?? ''}:${stamp[3] ?? ''}:${stamp[4] ?? ''} UTC` : 'a time its name does not give'
// The boxes whose homes the export holds, as boxes/<instance id>.tar.gz.
const BoxKey = z.string().transform((key) => key.slice(`${prefix}boxes/`.length).replace(/\.tar\.gz$/, '')).pipe(z.uuid())
let held: S3Object[] = []
let boxes: string[] = []
let work = ''
const staged = (key: string) => join(work, key.slice(prefix.length).replaceAll('/', '_'))

async function refuseIfNewer() {
  const count = await teamsIn(database)
  if (count > 0 && replace !== name) {
    throw new Error(`${name} holds ${count === 1 ? 'a team' : `${String(count)} teams`}, whose work may be newer than this export, taken at ${takenAt}. `
      + `To replace it anyway, run this again with --replace ${name}.`)
  }
}

async function refuseIfBusy() {
  const admin = maintenance(database)
  await admin.connect()
  try {
    const { rows } = await admin.query<{ application_name: string; client_addr: string | null }>(
      'select application_name, client_addr::text from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [name])
    if (rows.length) {
      const who = rows.map((row) => row.application_name || row.client_addr || 'a local session').join(', ')
      throw new Error(`${String(rows.length)} sessions are connected to ${name} (${who}). Stop the API and Electric first.`)
    }
  } finally {
    await admin.end()
  }
  for (const volume of [settings.AGENTS_FORGE_VOLUME, settings.AGENTS_ELECTRIC_VOLUME]) {
    const users = usersOf(volume)
    if (users.length) throw new Error(`${volume} is in use by ${users.join(', ')}. Stop the forge and Electric first.`)
  }
  for (const id of boxes) {
    const users = usersOf(boxHomeVolume(id), boxHost)
    if (users.length) throw new Error(`${boxHomeVolume(id)} is in use by ${users.join(', ')}. Stop the boxes first.`)
  }
  // A box of the export, or of the database it replaces, that runs could write
  // to its home, and would keep a token the restored database may not know.
  const known = new Set([...boxes, ...await boxInstances(database, teams)])
  const live = [...boxContainerStates(boxHost)].filter(([id, state]) => known.has(id) && isLive(state)).map(([id]) => boxContainer(id))
  if (live.length) throw new Error(`these boxes are still running: ${live.join(', ')}. Stop them first: docker stop ${live.join(' ')}`)
}

// Removes the stopped containers of the restored boxes, which hold tokens the
// restored database no longer knows, and says how many it removed.
async function removeStoppedBoxes(): Promise<number> {
  const restored = new Set(await boxInstances(database, teams))
  const stopped = [...boxContainerStates(boxHost)].filter(([id, state]) => restored.has(id) && !isLive(state)).map(([id]) => boxContainer(id))
  for (const container of stopped) removeContainer(container, boxHost)
  return stopped.length
}

async function recreateDatabase() {
  const admin = maintenance(database)
  await admin.connect()
  try {
    const { rows } = await admin.query<{ slot_name: string }>(
      `select pg_drop_replication_slot(slot_name), slot_name from pg_replication_slots where database = $1`, [name])
    if (rows.length) console.log(`dropped replication slots ${rows.map((row) => row.slot_name).join(', ')}`)
    // A database name cannot be a parameter, so it is quoted as an identifier.
    const quoted = admin.escapeIdentifier(name)
    await admin.query(`drop database if exists ${quoted}`)
    await admin.query(`create database ${quoted}`)
  } finally {
    await admin.end()
  }
}

let removed = 0
try {
  await perform([
    {
      say: `list s3://${from.bucket}/${prefix}, taken at ${takenAt}, and the boxes' homes under boxes/`,
      act: async () => {
        held = await listObjects(s3, from.bucket, prefix)
        // Checked before anything changes, since the database is dropped before the dump is read.
        const missing = ['agents.dump', 'forge.tar.gz'].filter((file) => !held.some((object) => object.key === `${prefix}${file}`))
        if (missing.length) throw new Error(`s3://${from.bucket}/${prefix} has no ${missing.join(' or ')}, so it is not a whole backup or export`)
        boxes = held.filter((object) => object.key.startsWith(`${prefix}boxes/`)).map((object) => BoxKey.parse(object.key))
      },
    },
    { say: `check that ${name} holds no teams, or that --replace names it`, act: refuseIfNewer },
    { say: `check that nothing uses ${name}, ${settings.AGENTS_FORGE_VOLUME}, ${settings.AGENTS_ELECTRIC_VOLUME}, those homes, or those boxes`, act: refuseIfBusy },
    {
      say: `check there is room under /var/tmp, and download agents.dump, forge.tar.gz and the boxes' homes there`,
      act: async () => {
        work = stagingDir('agents-restore-')
        console.log(ensureSpace(work, held.reduce((sum, object) => sum + object.size, 0)))
        for (const object of held) await download(s3, from.bucket, object.key, staged(object.key))
      },
    },
    { say: `drop ${name}'s replication slots, then drop and create ${name} on ${database.hostname}`, act: recreateDatabase },
    { say: `restore the dump into ${name}`, act: () => { restoreDatabase(database, staged(`${prefix}agents.dump`)) } },
    { say: `replace what ${settings.AGENTS_FORGE_VOLUME} holds with the forge archive`, act: () => { restoreVolume(settings.AGENTS_FORGE_VOLUME, staged(`${prefix}forge.tar.gz`)) } },
    { say: `empty ${settings.AGENTS_ELECTRIC_VOLUME}, so Electric rebuilds its shapes`, act: () => { emptyVolume(settings.AGENTS_ELECTRIC_VOLUME) } },
    {
      say: `put each box's home back in its volume, on ${settings.AGENTS_BOX_DOCKER_HOST ?? "this machine's Docker"}`,
      act: () => { for (const id of boxes) restoreVolume(boxHomeVolume(id), staged(`${prefix}boxes/${id}.tar.gz`), boxHost) },
    },
    { say: 'remove the stopped containers of the restored boxes, whose tokens the restored database does not know', act: async () => { removed = await removeStoppedBoxes() } },
  ], dryRun)
  if (!dryRun) {
    const containers = removed === 0 ? 'no stopped box containers' : removed === 1 ? 'one stopped box container' : `${String(removed)} stopped box containers`
    console.log(`restored ${name}, the forge and ${String(boxes.length)} boxes' homes from s3://${from.bucket}/${prefix}, taken at ${takenAt}, `
      + `and removed ${containers}`)
  }
} finally {
  if (work) rmSync(work, { recursive: true, force: true })
}
