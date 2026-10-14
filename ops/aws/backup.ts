// The nightly backup, on the server (agents-backup.timer): a dump of the database
// and an archive of the forge's volume, uploaded to s3://<bucket>/backups/<time>/.
// The forge stops for the few seconds its volume takes to archive, so its SQLite
// database is copied whole. Both are staged under /var/tmp, after checking they
// fit. On success it records the time, which the health timer reports, so a
// backup that stops working raises an alarm.
//   node --env-file=.env ops/aws/backup.ts [--dry-run]
// RDS keeps its own automated backups as well. Restore with ops/aws/restore.ts.

import { rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { S3Client } from '@aws-sdk/client-s3'
import { z } from 'zod'
import { archiveVolume, databaseBytes, dumpDatabase, ensureSpace, stagingDir, volumeBytes } from './archive.ts'
import { upload } from './aws.ts'
import { BACKUP_STATE, FORGE_CONTAINER, FORGE_VOLUME, settingsFrom, type BackupState } from './config.ts'
import { isDryRun, perform, run } from './steps.ts'

const Settings = z.object({
  DATABASE_URL: z.url(),
  AGENTS_BACKUP_BUCKET: z.string().min(1),
  AGENTS_FORGE_CONTAINER: z.string().min(1).default(FORGE_CONTAINER),
  AGENTS_FORGE_VOLUME: z.string().min(1).default(FORGE_VOLUME),
  AGENTS_HOME: z.string().min(1).default(join(homedir(), '.agents-app')),
})
const backupStateFile = (agentsHome: string) => join(agentsHome, BACKUP_STATE)

const settings = settingsFrom(Settings, 'the backup settings')
const dryRun = isDryRun()
const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z')
const prefix = `backups/${stamp}/`
let work = ''
const staged = (file: string) => join(work, file)
const s3 = new S3Client({})
const database = new URL(settings.DATABASE_URL)

try {
  await perform([
    {
      say: `measure the database and ${settings.AGENTS_FORGE_VOLUME}, and check they fit under /var/tmp`,
      act: async () => {
        const bytes = await databaseBytes(database) + volumeBytes(settings.AGENTS_FORGE_VOLUME)
        work = stagingDir('agents-backup-')
        console.log(ensureSpace(work, bytes))
      },
    },
    { say: `dump the database ${database.pathname.slice(1)} on ${database.hostname}`, act: () => { dumpDatabase(database, staged('agents.dump')) } },
    {
      say: `stop ${settings.AGENTS_FORGE_CONTAINER}, archive ${settings.AGENTS_FORGE_VOLUME}, and start it again`,
      act: () => {
        run('docker', ['stop', settings.AGENTS_FORGE_CONTAINER])
        try {
          archiveVolume(settings.AGENTS_FORGE_VOLUME, staged('forge.tar.gz'))
        } finally {
          run('docker', ['start', settings.AGENTS_FORGE_CONTAINER])
        }
      },
    },
    {
      say: `upload both to s3://${settings.AGENTS_BACKUP_BUCKET}/${prefix}`,
      act: async () => {
        await upload(s3, staged('agents.dump'), settings.AGENTS_BACKUP_BUCKET, `${prefix}agents.dump`)
        await upload(s3, staged('forge.tar.gz'), settings.AGENTS_BACKUP_BUCKET, `${prefix}forge.tar.gz`)
      },
    },
    {
      say: `record the time in ${backupStateFile(settings.AGENTS_HOME)}`,
      act: () => {
        const state: BackupState = { lastSuccess: new Date().toISOString(), location: `s3://${settings.AGENTS_BACKUP_BUCKET}/${prefix}` }
        writeFileSync(backupStateFile(settings.AGENTS_HOME), `${JSON.stringify(state)}\n`, { mode: 0o600 })
      },
    },
  ], dryRun)
  if (!dryRun) console.log(`backed up to s3://${settings.AGENTS_BACKUP_BUCKET}/${prefix}`)
} finally {
  if (work) rmSync(work, { recursive: true, force: true })
}
