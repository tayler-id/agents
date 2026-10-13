// Sets up the local forge (Gitea in compose.yaml): an admin, the factory user that
// pipelines act as, the org, and two repos. shop is a small app with a known bug.
// pipelines holds the team's pipeline files. Writes ~/.agents-app/forge.json and adds both
// repos to the team. Safe to rerun.
//   node --env-file=.env ops/forge-setup.ts <team>

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { FORGE_FILE, forgeAdmin, type ForgeConfig } from '../server/forge.ts'
import { pool } from '../server/db.ts'

const ROOT = new URL('..', import.meta.url).pathname
const URL_BASE = process.env.AGENTS_FORGE_URL ?? 'http://127.0.0.1:3001'
const team = process.argv[2]
if (!team) {
  console.error('usage: node --env-file=.env ops/forge-setup.ts <team>')
  process.exit(2)
}

function gitea(...args: string[]): string {
  return execFileSync('docker', ['compose', 'exec', '-T', '-u', 'git', 'forge', 'gitea', ...args], { cwd: ROOT, encoding: 'utf8' }).trim()
}

// Creates a forge user if missing and returns a new token for it.
function user(name: string, admin: boolean, scopes: string): string {
  try {
    gitea('admin', 'user', 'create', '--username', name, '--email', `${name}@forge.local`,
      '--password', randomBytes(18).toString('base64url'), '--must-change-password=false', ...(admin ? ['--admin'] : []))
  } catch (error) {
    if (!String((error as { stderr?: string }).stderr ?? error).includes('already exists')) throw error
  }
  return gitea('admin', 'user', 'generate-access-token', '--username', name,
    '--token-name', `agents-${Date.now()}`, '--scopes', scopes, '--raw')
}

async function works(token: string): Promise<boolean> {
  const res = await fetch(`${URL_BASE}/api/v1/user`, { headers: { authorization: `token ${token}` } }).catch(() => null)
  return Boolean(res?.ok)
}

function files(dir: string, under = dir): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) Object.assign(out, files(path, under))
    else out[relative(under, path)] = readFileSync(path, 'utf8')
  }
  return out
}

try {
  // The forge file is this script's own output from an earlier run.
  let config = existsSync(FORGE_FILE) ? JSON.parse(readFileSync(FORGE_FILE, 'utf8')) as ForgeConfig : null
  if (!config || !(await works(config.adminToken)) || !(await works(config.token))) {
    config = {
      url: URL_BASE,
      hookUrl: `http://host.docker.internal:${process.env.AGENTS_API_PORT ?? 7700}/v1/hooks/forge`,
      org: 'team',
      adminToken: user('agents-admin', true, 'write:admin,write:organization,write:repository,write:issue,write:user'),
      token: user('factory', false, 'write:repository,write:issue,read:user,read:organization'),
      webhookSecret: config?.webhookSecret ?? randomBytes(32).toString('hex'),
    }
    mkdirSync(dirname(FORGE_FILE), { recursive: true, mode: 0o700 })
    writeFileSync(FORGE_FILE, JSON.stringify(config, null, 2), { mode: 0o600 })
  }

  const orgs = await forgeAdmin.call<{ username: string }[]>('GET', '/admin/orgs?limit=50')
  if (!orgs.some((o) => o.username === config.org)) {
    await forgeAdmin.call('POST', '/orgs', { username: config.org, visibility: 'private' })
  }
  const shop = await forgeAdmin.ensureRepo('shop', files(join(ROOT, 'ops/seed/shop')), 'Checkout math for the shop')
  const pipelines = await forgeAdmin.ensureRepo('pipelines', {
    'README.md': '# pipelines\n\nThe team\'s pipelines. Each file in `pipelines/` is one pipeline, named after the file. Merging a change here makes it the current version.\n',
    'shared/pipeline.ts': readFileSync(join(ROOT, 'shared/pipeline.ts'), 'utf8'),
    ...Object.fromEntries(readdirSync(join(ROOT, 'pipelines')).filter((f) => f.endsWith('.ts'))
      .map((f) => [`pipelines/${f}`, readFileSync(join(ROOT, 'pipelines', f), 'utf8')])),
  }, 'The team\'s pipelines')

  const { rows: [found] } = await pool.query<{ id: string }>('select id from teams where name = $1', [team])
  if (!found) throw new Error(`no team ${team}`)
  for (const repo of [shop, pipelines]) {
    const { rowCount } = await pool.query(
      'insert into repos (team_id, remote_url) values ($1, $2) on conflict (team_id, remote_url) do nothing',
      [found.id, `${config.url}/${repo}.git`])
    console.log(`${repo}: ${rowCount ? 'added to' : 'already in'} ${team}`)
  }
  console.log(`forge ready at ${config.url}, config in ${FORGE_FILE}`)
} finally {
  await pool.end()
}
