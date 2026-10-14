// Moves this Mac's data to AWS at cutover, from this Mac signed in with `aws
// configure sso`: the database, the forge's volume, every box's home volume, and
// the secrets the server needs from here (the forge's config, the webhook
// secret, and the Claude token for boxes when there is one). A box's home holds
// its task workspaces and Claude's session files, so without it a task could
// not resume on AWS. It refuses while the API or any box is running, so nothing
// writes while it copies. It leaves the forge stopped, since from now on the
// forge runs on the server. It stages the archives under /var/tmp, after
// checking they fit. docs/aws.md has the whole cutover.
//   node --env-file=.env ops/aws/export.ts [--dry-run]
// With AGENTS_RUNNER_TEAMS set, only those teams' boxes move, as only those
// teams' boxes are run by such a server. It ends by printing the commands that
// restore it on the server.

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { S3Client } from '@aws-sdk/client-s3'
import { SSMClient } from '@aws-sdk/client-ssm'
import { z } from 'zod'
import { boxContainer, boxHomeVolume } from '../../shared/boxes.ts'
import { hasCode } from '../../shared/errors.ts'
import { MACHINE_PORT, MachineHosts, Port } from '../../shared/listen.ts'
import { accepts } from '../../shared/socket.ts'
import {
  archiveVolume, boxContainerStates, boxInstances, databaseBytes, dumpDatabase, ensureSpace, isLive, stagingDir, volumeBytes, volumeNames,
} from './archive.ts'
import { hostConfig, putSecret, upload } from './aws.ts'
import { APP_HOME, FORGE_CONTAINER, FORGE_VOLUME, NODE_DIR, REPO, RunnerTeams, SERVICE_USER, SETTINGS_FILE, settingsFrom } from './config.ts'
import { isDryRun, perform, run } from './steps.ts'

const Settings = z.object({
  DATABASE_URL: z.url(),
  AGENTS_HOOK_SECRET: z.string().min(1),
  AGENTS_API_PORT: Port.default(MACHINE_PORT),
  AGENTS_MACHINE_HOST: MachineHosts,
  AGENTS_PEOPLE_SOCKET: z.string().startsWith('/'),
  AGENTS_HOME: z.string().min(1).default(join(homedir(), '.agents-app')),
  AGENTS_FORGE_CONTAINER: z.string().min(1).default(FORGE_CONTAINER),
  AGENTS_FORGE_VOLUME: z.string().min(1).default(FORGE_VOLUME),
  AGENTS_RUNNER_TEAMS: RunnerTeams,
})
// How long the machine port may take to answer. One that has not answered by
// then leaves it unknown whether the API runs.
const CONNECT_MS = 1000

const settings = settingsFrom(Settings, 'the export settings')
const database = new URL(settings.DATABASE_URL)
const teams = settings.AGENTS_RUNNER_TEAMS
const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z')
const prefix = `cutover/${stamp}/`
const forgeFile = join(settings.AGENTS_HOME, 'forge.json')
const tokenFile = join(settings.AGENTS_HOME, 'box-claude-token')
const ssm = new SSMClient({})
let bucket = ''
let boxes: string[] = []
let homes: string[] = []
let work = ''
const staged = (file: string) => join(work, file)
const boxArchive = (instanceId: string) => staged(`${instanceId}.tar.gz`)

// Whether the machine port accepts connections at an address it listens on. Only
// a refusal means stopped. Silence or any other failure leaves it unknown, so the
// export stops rather than copy a database the API may still write to.
const machinePortOpen = (host: string, at: number) => new Promise<boolean>((resolve, reject) => {
  const socket = connect({ host, port: at, timeout: CONNECT_MS })
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('timeout', () => {
    socket.destroy()
    reject(new Error(`${host} port ${String(at)} did not answer in ${String(CONNECT_MS)} ms, so whether the API runs is unknown`))
  })
  socket.once('error', (error) => { if (hasCode(error, 'ECONNREFUSED')) resolve(false); else reject(error) })
})

// Whether the API serves people on its socket. With no socket file it never has
// on this Mac. A file a stopped API left behind refuses connections.
const peopleSocketOpen = async (path: string) => existsSync(path) && await accepts(path)

// The commands that finish the move on the server, as the service user where they read its .env.
const asService = (script: string) =>
  `sudo -iu ${SERVICE_USER} ${NODE_DIR}/bin/node --env-file=${REPO}/.env --env-file-if-exists=${APP_HOME}/${SETTINGS_FILE} ${REPO}/${script}`

try {
  await perform([
    {
      say: `check that the API on this Mac is stopped (port ${String(settings.AGENTS_API_PORT)} on ${settings.AGENTS_MACHINE_HOST.join(', ')}, and ${settings.AGENTS_PEOPLE_SOCKET})`,
      act: async () => {
        const machinePort = await Promise.all(settings.AGENTS_MACHINE_HOST.map((host) => machinePortOpen(host, settings.AGENTS_API_PORT)))
        if (machinePort.includes(true) || await peopleSocketOpen(settings.AGENTS_PEOPLE_SOCKET)) {
          throw new Error('the API on this Mac is still running. Stop it first: launchctl bootout gui/$(id -u)/com.agents.api')
        }
      },
    },
    {
      say: `list the boxes${teams ? ` of ${teams.join(', ')}` : ''} in DATABASE_URL, and check that none is running`,
      act: async () => {
        boxes = await boxInstances(database, teams)
        const states = boxContainerStates()
        const busy = boxes.filter((id) => { const state = states.get(id); return state !== undefined && isLive(state) }).map(boxContainer)
        if (busy.length) throw new Error(`these boxes are still running: ${busy.join(', ')}. Stop them first: docker stop ${busy.join(' ')}`)
      },
    },
    { say: 'read the backup bucket from /agents/config', act: async () => { bucket = (await hostConfig(ssm)).bucket } },
    {
      say: `measure the database, ${settings.AGENTS_FORGE_VOLUME} and the boxes' homes, and check they fit under /var/tmp`,
      act: async () => {
        // A box that never started has no home yet, and nothing to move.
        const present = volumeNames()
        homes = boxes.filter((id) => present.has(boxHomeVolume(id)))
        const bytes = await databaseBytes(database) + volumeBytes(settings.AGENTS_FORGE_VOLUME)
          + homes.reduce((sum, id) => sum + volumeBytes(boxHomeVolume(id)), 0)
        work = stagingDir('agents-export-')
        console.log(ensureSpace(work, bytes))
      },
    },
    { say: 'dump the database in DATABASE_URL', act: () => { dumpDatabase(database, staged('agents.dump')) } },
    {
      say: `stop ${settings.AGENTS_FORGE_CONTAINER} for good and archive ${settings.AGENTS_FORGE_VOLUME}`,
      act: () => {
        run('docker', ['stop', settings.AGENTS_FORGE_CONTAINER])
        archiveVolume(settings.AGENTS_FORGE_VOLUME, staged('forge.tar.gz'))
      },
    },
    { say: 'archive the home volume of each of those boxes', act: () => { for (const id of homes) archiveVolume(boxHomeVolume(id), boxArchive(id)) } },
    {
      say: `upload them to s3://<the bucket>/${prefix}, the boxes' homes under boxes/`,
      act: async () => {
        const s3 = new S3Client({})
        await upload(s3, staged('agents.dump'), bucket, `${prefix}agents.dump`)
        await upload(s3, staged('forge.tar.gz'), bucket, `${prefix}forge.tar.gz`)
        for (const id of homes) await upload(s3, boxArchive(id), bucket, `${prefix}boxes/${id}.tar.gz`)
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
    console.log(`\nexported the database, the forge and ${String(homes.length)} of ${String(boxes.length)} boxes' homes to s3://${bucket}/${prefix}. On the server, as in docs/aws.md:`)
    console.log('  sudo systemctl stop agents-api agents-compose agents-backup.timer')
    console.log('  sudo systemctl restart agents-secrets')
    console.log(`  ${asService('ops/aws/restore.ts')} s3://${bucket}/${prefix}`)
    console.log(`  ${asService('server/boxes.ts')} build`)
    console.log('  sudo systemctl start agents-compose agents-api agents-backup.timer')
  }
} finally {
  if (work) rmSync(work, { recursive: true, force: true })
}
