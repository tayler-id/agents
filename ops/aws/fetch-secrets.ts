// Writes the server's secrets to files at every boot (agents-secrets.service),
// before Compose and the API start: the .env that the API, Electric and the ops
// scripts read, the forge's config, and the Claude token for boxes, each with
// mode 600. The database's password comes from the secret RDS generated, the
// rest from SSM (put there by ops/aws/secrets.ts and ops/aws/export.ts), and the
// facts from /agents/config. ELECTRIC_SECRET is made here once and kept, since
// only this server uses it, and so is AGENTS_HOOK_SECRET until cutover brings the
// Mac's. A file whose secret is gone from SSM is removed.
//   node ops/aws/fetch-secrets.ts --to /home/agents/agents/.env [--dry-run]
// The flag is not --env-file, which node itself reads wherever it appears on the command line.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { SSMClient } from '@aws-sdk/client-ssm'
import { z } from 'zod'
import { hostConfig, readParameter } from './aws.ts'
import { DatabaseSecret, PEOPLE_SOCKET_FILE, SECRET_PARAMETERS, SERVICE_USER, TAILNET, settingsFrom } from './config.ts'
import { isDryRun, perform } from './steps.ts'

const Settings = z.object({ AGENTS_HOME: z.string().min(1).default(join(homedir(), '.agents-app')) })
const settings = settingsFrom(Settings, 'the secrets settings')
const flag = process.argv.indexOf('--to')
const envFile = flag === -1 ? undefined : process.argv[flag + 1]
if (!envFile) throw new Error('usage: node ops/aws/fetch-secrets.ts --to <path to the .env to write> [--dry-run]')
const caFile = join(settings.AGENTS_HOME, 'rds-ca.pem')
const forgeFile = join(settings.AGENTS_HOME, 'forge.json')
const tokenFile = join(settings.AGENTS_HOME, 'box-claude-token')
const peopleSocket = join(settings.AGENTS_HOME, PEOPLE_SOCKET_FILE)
// The values this script keeps from the .env it wrote last time.
const Kept = z.object({ ELECTRIC_SECRET: z.string().min(1).optional(), AGENTS_HOOK_SECRET: z.string().min(1).optional() })
const newSecret = () => randomBytes(32).toString('hex')

// Writes a file whole or not at all, readable by its owner only.
function writePrivate(file: string, content: string) {
  writeFileSync(`${file}.new`, content, { mode: 0o600 })
  renameSync(`${file}.new`, file)
}

function databaseUrl(secret: DatabaseSecret, params: Record<string, string>): string {
  const url = new URL(`postgres://${secret.host}:${secret.port}/${secret.dbname}`)
  url.username = secret.username
  url.password = secret.password
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

// A secret parameter's value as a file, or the file removed when the parameter is gone.
function converge(file: string, value: string | undefined) {
  if (value === undefined) rmSync(file, { force: true })
  else writePrivate(file, value.endsWith('\n') ? value : `${value}\n`)
}

const ssm = new SSMClient({})
const secretsManager = new SecretsManagerClient({})

await perform([{
  say: `read /agents/config, the database's secret and ${Object.values(SECRET_PARAMETERS).filter((name) => name.startsWith('/agents/server/')).join(', ')}; `
    + `write ${envFile}, ${forgeFile} and ${tokenFile}, each with mode 600`,
  act: async () => {
    const config = await hostConfig(ssm)
    const secret = await secretsManager.send(new GetSecretValueCommand({ SecretId: config.databaseSecretArn }))
    const database = DatabaseSecret.parse(JSON.parse(z.string().parse(secret.SecretString)))
    const kept = Kept.parse(existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {})
    const hookSecret = await readParameter(ssm, SECRET_PARAMETERS['hook-secret'])
    const env: Record<string, string> = {
      DATABASE_URL: databaseUrl(database, { sslmode: 'verify-full', sslrootcert: caFile }),
      ELECTRIC_DATABASE_URL: databaseUrl(database, { sslmode: 'require' }),
      ELECTRIC_SECRET: kept.ELECTRIC_SECRET ?? newSecret(),
      AGENTS_HOOK_SECRET: hookSecret ?? kept.AGENTS_HOOK_SECRET ?? newSecret(),
      AGENTS_API_PORT: String(config.machinePort),
      AGENTS_PEOPLE_SOCKET: peopleSocket,
      AGENTS_MACHINE_HOST: '0.0.0.0',
      AGENTS_BOX_DOCKER_HOST: `ssh://${SERVICE_USER}@${TAILNET.boxes}`,
      AGENTS_BOX_API: `http://${config.serverAddress}:${config.machinePort}`,
      AGENTS_BACKUP_BUCKET: config.bucket,
      // compose.yaml fills this in for its local Postgres, which the server does not run.
      POSTGRES_PASSWORD: 'unused-on-aws',
    }
    const lines = Object.entries(env).map(([key, value]) => `${key}=${value}`)
    writePrivate(envFile, ['# Written by ops/aws/fetch-secrets.ts at every boot. Edits here are lost.', ...lines, ''].join('\n'))
    // The forge's config must be a JSON object. Anything else is refused, not written.
    const forgeJson = await readParameter(ssm, SECRET_PARAMETERS['forge-json'])
    converge(forgeFile, forgeJson === undefined ? undefined : JSON.stringify(z.record(z.string(), z.unknown()).parse(JSON.parse(forgeJson)), null, 2))
    converge(tokenFile, await readParameter(ssm, SECRET_PARAMETERS['box-claude-token']))
    console.log(`wrote ${Object.keys(env).length} settings to ${envFile}${existsSync(forgeFile) ? ', the forge config' : ''}${existsSync(tokenFile) ? ', the Claude token for boxes' : ''}`)
  },
}], isDryRun())
