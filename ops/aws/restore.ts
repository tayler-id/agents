// Restores a backup, or the export made at cutover, onto the server: the
// database named in DATABASE_URL, the forge's volume, and each box's home volume
// the export holds, on the box host's Docker (AGENTS_BOX_DOCKER_HOST, or this
// machine's when unset). Electric's volume is emptied, so it rebuilds its shapes
// from the restored database.
//   sudo systemctl stop agents-api agents-compose
//   node --env-file=.env ops/aws/restore.ts s3://<bucket>/backups/<time>/ [--dry-run]
//   sudo systemctl start agents-compose agents-api
// It refuses while anything is connected to the database or uses any of the
// volumes, so nothing writes while it works. It drops only that database's
// replication slots, which belong to the Electric that followed the old one.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { S3Client } from '@aws-sdk/client-s3'
import { z } from 'zod'
import { boxHomeVolume } from '../../shared/boxes.ts'
import { databaseOf, emptyVolume, maintenance, restoreDatabase, restoreVolume, usersOf } from './archive.ts'
import { download, listKeys, S3Location } from './aws.ts'
import { settingsFrom } from './config.ts'
import { isDryRun, perform } from './steps.ts'

const Settings = z.object({
  DATABASE_URL: z.url(),
  AGENTS_FORGE_VOLUME: z.string().min(1).default('agents_forgedata'),
  AGENTS_ELECTRIC_VOLUME: z.string().min(1).default('agents_electricdata'),
  AGENTS_BOX_DOCKER_HOST: z.string().min(1).optional(),
})
const settings = settingsFrom(Settings, 'the restore settings')
const location = process.argv.slice(2).find((arg) => arg.startsWith('s3://'))
if (!location) throw new Error('usage: node --env-file=.env ops/aws/restore.ts s3://<bucket>/backups/<time>/ [--dry-run]')
const from = S3Location.parse(location)
const prefix = from.key.endsWith('/') ? from.key : `${from.key}/`
const dryRun = isDryRun()
const database = new URL(settings.DATABASE_URL)
const name = databaseOf(database)
const boxHost = { dockerHost: settings.AGENTS_BOX_DOCKER_HOST }
const work = mkdtempSync(join(tmpdir(), 'agents-restore-'))
const dump = join(work, 'agents.dump')
const forge = join(work, 'forge.tar.gz')
const boxArchive = (instanceId: string) => join(work, `${instanceId}.tar.gz`)
const s3 = new S3Client({})
// The boxes whose homes the export holds, as boxes/<instance id>.tar.gz.
const BoxKey = z.string().transform((key) => key.slice(`${prefix}boxes/`.length).replace(/\.tar\.gz$/, '')).pipe(z.uuid())
let boxes: string[] = []

async function refuseIfBusy() {
  const admin = maintenance(database)
  await admin.connect()
  try {
    const { rows } = await admin.query<{ application_name: string; client_addr: string | null }>(
      'select application_name, client_addr::text from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [name])
    if (rows.length) {
      const who = rows.map((row) => row.application_name || row.client_addr || 'a local session').join(', ')
      throw new Error(`${rows.length} sessions are connected to ${name} (${who}). Stop the API and Electric first.`)
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

try {
  await perform([
    { say: `list the boxes' homes under s3://${from.bucket}/${prefix}boxes/`, act: async () => { boxes = (await listKeys(s3, from.bucket, `${prefix}boxes/`)).map((key) => BoxKey.parse(key)) } },
    { say: `check that nothing uses ${name}, ${settings.AGENTS_FORGE_VOLUME}, ${settings.AGENTS_ELECTRIC_VOLUME} or those boxes' homes`, act: refuseIfBusy },
    {
      say: 'download agents.dump, forge.tar.gz and the boxes\' homes',
      act: async () => {
        await download(s3, from.bucket, `${prefix}agents.dump`, dump)
        await download(s3, from.bucket, `${prefix}forge.tar.gz`, forge)
        for (const id of boxes) await download(s3, from.bucket, `${prefix}boxes/${id}.tar.gz`, boxArchive(id))
      },
    },
    { say: `drop ${name}'s replication slots, then drop and create ${name} on ${database.hostname}`, act: recreateDatabase },
    { say: `restore the dump into ${name}`, act: () => { restoreDatabase(database, dump) } },
    { say: `replace what ${settings.AGENTS_FORGE_VOLUME} holds with the forge archive`, act: () => { restoreVolume(settings.AGENTS_FORGE_VOLUME, forge) } },
    { say: `empty ${settings.AGENTS_ELECTRIC_VOLUME}, so Electric rebuilds its shapes`, act: () => { emptyVolume(settings.AGENTS_ELECTRIC_VOLUME) } },
    {
      say: `put each box's home back in its volume, on ${settings.AGENTS_BOX_DOCKER_HOST ?? "this machine's Docker"}`,
      act: () => { for (const id of boxes) restoreVolume(boxHomeVolume(id), boxArchive(id), boxHost) },
    },
  ], dryRun)
  if (!dryRun) console.log(`restored ${name}, the forge and ${boxes.length} boxes' homes from s3://${from.bucket}/${prefix}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
