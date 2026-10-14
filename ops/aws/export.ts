// Moves this Mac's data to AWS at cutover, from this Mac signed in with `aws
// configure sso`: the database, the forge's volume, every box's home volume, and
// the secrets the server needs from here (the forge's config, the webhook
// secret, and the Claude token for boxes when there is one). A box's home holds
// its task workspaces and Claude's session files, so without it a task could
// not resume on AWS. It refuses while the API or any box is running, so nothing
// writes while it copies. It leaves the forge stopped, since from now on the
// forge runs on the server. docs/aws.md has the whole cutover.
//   node --env-file=.env ops/aws/export.ts [--dry-run]
// With AGENTS_RUNNER_TEAMS set, only those teams' boxes move, as only those
// teams' boxes are run by such a server. It ends by printing the restore command.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { S3Client } from '@aws-sdk/client-s3'
import { SSMClient } from '@aws-sdk/client-ssm'
import pg from 'pg'
import { z } from 'zod'
import { boxContainer, boxHomeVolume } from '../../shared/boxes.ts'
import { archiveVolume, dumpDatabase, runningBoxes, volumeNames } from './archive.ts'
import { hostConfig, putSecret, upload } from './aws.ts'
import { NODE_DIR, REPO, SERVICE_USER, settingsFrom } from './config.ts'
import { isDryRun, perform, run } from './steps.ts'

const port = z.coerce.number().int().min(1).max(65535)
const Settings = z.object({
  DATABASE_URL: z.url(),
  AGENTS_HOOK_SECRET: z.string().min(1),
  AGENTS_API_PORT: port.default(7700),
  AGENTS_PEOPLE_PORT: port.default(7710),
  AGENTS_HOME: z.string().min(1).default(join(homedir(), '.agents-app')),
  AGENTS_FORGE_CONTAINER: z.string().min(1).default('agents-forge-1'),
  AGENTS_FORGE_VOLUME: z.string().min(1).default('agents_forgedata'),
  // Team names, comma separated, as for the runner. Unset, every team.
  AGENTS_RUNNER_TEAMS: z.string().optional().transform((value) => {
    const names = (value ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '')
    return names.length ? names : null
  }),
})
// How long to wait for the API to answer before deciding it is stopped.
const CONNECT_MS = 1000

const settings = settingsFrom(Settings, 'the export settings')
const database = new URL(settings.DATABASE_URL)
const teams = settings.AGENTS_RUNNER_TEAMS
const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z')
const prefix = `cutover/${stamp}/`
const work = mkdtempSync(join(tmpdir(), 'agents-export-'))
const dump = join(work, 'agents.dump')
const forge = join(work, 'forge.tar.gz')
const boxArchive = (instanceId: string) => join(work, `${instanceId}.tar.gz`)
const forgeFile = join(settings.AGENTS_HOME, 'forge.json')
const tokenFile = join(settings.AGENTS_HOME, 'box-claude-token')
const ssm = new SSMClient({})
let bucket = ''
let boxes: string[] = []
const archived: string[] = []

// Whether something accepts connections on a loopback port.
const listening = (at: number) => new Promise<boolean>((resolve) => {
  const socket = connect({ host: '127.0.0.1', port: at, timeout: CONNECT_MS })
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('timeout', () => { socket.destroy(); resolve(false) })
  socket.once('error', () => { resolve(false) })
})

// The box instances in the database, of the teams named if any.
async function boxesIn(): Promise<string[]> {
  const client = new pg.Client({ connectionString: database.toString() })
  await client.connect()
  try {
    const { rows } = await client.query(
      `select i.id from instances i join teams t on t.id = i.team_id
       where i.kind = 'box' and ($1::text[] is null or t.name = any($1)) order by i.id`, [teams])
    return z.array(z.object({ id: z.uuid() })).parse(rows).map((row) => row.id)
  } finally {
    await client.end()
  }
}

try {
  await perform([
    {
      say: `check that the API on this Mac is stopped (ports ${settings.AGENTS_API_PORT} and ${settings.AGENTS_PEOPLE_PORT})`,
      act: async () => {
        if (await listening(settings.AGENTS_API_PORT) || await listening(settings.AGENTS_PEOPLE_PORT)) {
          throw new Error('the API on this Mac is still running. Stop it first: launchctl bootout gui/$(id -u)/com.agents.api')
        }
      },
    },
    {
      say: `list the boxes${teams ? ` of ${teams.join(', ')}` : ''} in DATABASE_URL, and check that none is running`,
      act: async () => {
        boxes = await boxesIn()
        const running = runningBoxes()
        const busy = boxes.filter((id) => running.has(id)).map(boxContainer)
        if (busy.length) throw new Error(`these boxes are still running: ${busy.join(', ')}. Stop them first: docker stop ${busy.join(' ')}`)
      },
    },
    { say: 'read the backup bucket from /agents/config', act: async () => { bucket = (await hostConfig(ssm)).bucket } },
    { say: 'dump the database in DATABASE_URL', act: () => { dumpDatabase(database, dump) } },
    {
      say: `stop ${settings.AGENTS_FORGE_CONTAINER} for good and archive ${settings.AGENTS_FORGE_VOLUME}`,
      act: () => {
        run('docker', ['stop', settings.AGENTS_FORGE_CONTAINER])
        archiveVolume(settings.AGENTS_FORGE_VOLUME, forge)
      },
    },
    {
      say: 'archive the home volume of each of those boxes',
      act: () => {
        const present = volumeNames()
        for (const id of boxes) {
          // A box that never started has no home yet, and nothing to move.
          if (!present.has(boxHomeVolume(id))) continue
          archiveVolume(boxHomeVolume(id), boxArchive(id))
          archived.push(id)
        }
      },
    },
    {
      say: `upload them to s3://<the bucket>/${prefix}, the boxes' homes under boxes/`,
      act: async () => {
        const s3 = new S3Client({})
        await upload(s3, dump, bucket, `${prefix}agents.dump`)
        await upload(s3, forge, bucket, `${prefix}forge.tar.gz`)
        for (const id of archived) await upload(s3, boxArchive(id), bucket, `${prefix}boxes/${id}.tar.gz`)
      },
    },
    {
      say: `store the forge's config from ${forgeFile}, AGENTS_HOOK_SECRET, and the Claude token for boxes from ${tokenFile} if it exists, in SSM`,
      act: async () => {
        await putSecret(ssm, 'forge-json', readFileSync(forgeFile, 'utf8'))
        await putSecret(ssm, 'hook-secret', settings.AGENTS_HOOK_SECRET)
        if (existsSync(tokenFile)) await putSecret(ssm, 'box-claude-token', readFileSync(tokenFile, 'utf8').trim())
      },
    },
  ], isDryRun())
  if (!isDryRun()) {
    console.log(`\nexported the database, the forge and ${archived.length} of ${boxes.length} boxes' homes to s3://${bucket}/${prefix}. On the server, as in docs/aws.md:`)
    console.log('  sudo systemctl stop agents-api agents-compose')
    console.log('  sudo systemctl restart agents-secrets')
    console.log(`  sudo -iu ${SERVICE_USER} ${NODE_DIR}/bin/node --env-file=${REPO}/.env ${REPO}/ops/aws/restore.ts s3://${bucket}/${prefix}`)
    console.log('  sudo systemctl start agents-compose agents-api')
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
