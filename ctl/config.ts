// What agentsctl runs against, read once when it starts. It loads the repo's
// .env and then .env.test, later over earlier, with the real environment over
// both, the same order the checks use. It refuses to go on unless the database
// and Electric are the ones .env.test names, so an instance never touches the
// live system's data.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { z } from 'zod'
import { ENGINES, EVIDENCE_MANIFEST_FILE, type Engine } from '../shared/verification.ts'
import { envSecrets, makeScrub, type Scrub } from '../shared/scrub.ts'
import { Refused } from '../shared/cli/output.ts'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))

// Where instance state and evidence live: in the checkout's .scratch folder,
// which git and lint already ignore, so each worktree keeps its own.
export const VERIFY_DIR = join(ROOT, '.scratch', 'verify')
export const INSTANCES_DIR = join(VERIFY_DIR, 'instances')
export const EVIDENCE_DIR = join(VERIFY_DIR, 'evidence')
export const SKILL_DIR = join(ROOT, '.claude', 'skills', 'verify-agents')
export const FEATURES_DIR = join(SKILL_DIR, 'features')
// Baselines stay in the ignored scratch folder until the name guard skips image
// files: it reads every tracked file as text, and a PNG's bytes can spell a
// banned name. --baselines points anywhere else, such as the skill's folder.
export const BASELINES_DIR = join(VERIFY_DIR, 'baselines')
// The latest run's evidence.json, at the one path the check host reads after a suite.
export const LATEST_MANIFEST = join(VERIFY_DIR, EVIDENCE_MANIFEST_FILE)

// The ports instances take, clear of the live API (7700, 7710, its streams on
// 4437), the checks (7700 to 7999), Electric (3000, 3002) and the forge (3001).
export const PORT_RANGE = { first: 8020, last: 8039 } as const
// The live system's ports. Nothing agentsctl starts or drives may use them.
export const LIVE_PORTS: readonly number[] = [7700, 7701, 7710, 4437, 3000]

// Over the tailnet the app is plain HTTP on a name that is not localhost, so
// browsers withhold secure-page APIs such as crypto.randomUUID. Chromium,
// Firefox and the desktop app reach an instance by a made-up name to match.
// WebKit cannot map a name, so it uses the loopback address.
export const INSECURE_HOST = 'agents.test'
const LOOPBACK_HOST = '127.0.0.1'
// The origin the pages of a browser's engine come from on an instance's people port.
export const pageOrigin = (engine: Engine, peoplePort: number) =>
  `http://${engine === 'webkit' ? LOOPBACK_HOST : INSECURE_HOST}:${String(peoplePort)}`
// Every origin an instance's pages come from. Its API opens a screen's WebSocket only for these.
export const pageOrigins = (peoplePort: number): string[] => [...new Set(ENGINES.map((engine) => pageOrigin(engine, peoplePort)))]

const FileEnv = z.record(z.string(), z.string())

// An instance's scratch folders are made under the temporary folder with this
// prefix. Its people socket lives in its own, never anywhere else.
export const SCRATCH_PREFIX = 'agentsctl-'
const SCRATCH_ROOTS = [...new Set([tmpdir(), realpathSync(tmpdir())])].map((root) => join(root, SCRATCH_PREFIX))
export const inScratch = (path: string) => SCRATCH_ROOTS.some((root) => resolve(path).startsWith(root))

function readEnvFile(name: string): Record<string, string> {
  const path = join(ROOT, name)
  if (!existsSync(path)) throw new Refused(`${name} is missing from ${ROOT}`, [`Copy it from the main checkout: cp ~/Projects/agents/${name} ${ROOT}`])
  return FileEnv.parse(parseEnv(readFileSync(path, 'utf8')))
}

// The values agentsctl needs. Each one stops it with a message naming the value when it is missing.
const Config = z.object({
  DATABASE_URL: z.url(),
  ELECTRIC_URL: z.url(),
  ELECTRIC_SECRET: z.string().min(1),
  AGENTS_HOOK_SECRET: z.string().min(1),
})
export type Config = z.infer<typeof Config> & { env: Record<string, string> }

// Shows a database URL without its password.
export const redact = (url: string) => {
  const parsed = new URL(url)
  return `${parsed.protocol}//${parsed.hostname}:${parsed.port}${parsed.pathname}`
}

// Where a value in agentsctl's environment was set: the shell, over .env.test, over .env.
export function whereSet(key: string, layers: { shell: Record<string, string>; test: Record<string, string>; base: Record<string, string> }): 'your shell' | '.env.test' | '.env' {
  if (key in layers.shell) return 'your shell'
  if (key in layers.test) return '.env.test'
  return '.env'
}

let loaded: Config | null = null

export function config(): Config {
  if (loaded) return loaded
  const testFile = readEnvFile('.env.test')
  const baseFile = readEnvFile('.env')
  const merged = { ...baseFile, ...testFile }
  const real = FileEnv.parse(Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)))
  const env = { ...merged, ...real }
  const parsed = Config.safeParse(env)
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')
    throw new Refused(`agentsctl needs ${missing}, from .env, .env.test or the environment`)
  }
  for (const key of ['DATABASE_URL', 'ELECTRIC_URL'] as const) {
    const fromTest = testFile[key]
    if (!fromTest) throw new Refused(`.env.test must set ${key}, so agentsctl runs against the test database and its Electric`)
    if (parsed.data[key] !== fromTest) {
      throw new Refused(`${key} is ${redact(parsed.data[key])} but .env.test says ${redact(fromTest)}. Unset ${key} in your shell: agentsctl only runs against the test system.`)
    }
  }
  const database = new URL(parsed.data.DATABASE_URL).pathname.slice(1)
  if (!database.endsWith('_test')) throw new Refused(`the database ${database} is not a test database (its name must end in _test)`)
  // A people socket from the shell or the env files could be the live one. An
  // instance makes its own in its scratch folder, so any other is refused.
  const socket = env.AGENTS_PEOPLE_SOCKET
  if (socket && !inScratch(socket)) {
    throw new Refused(`AGENTS_PEOPLE_SOCKET is ${socket}, outside agentsctl's scratch folders, and could be the live server's`, [
      `Unset AGENTS_PEOPLE_SOCKET in ${whereSet('AGENTS_PEOPLE_SOCKET', { shell: real, test: testFile, base: baseFile })}: each instance makes its own socket in its scratch folder`,
    ])
  }
  loaded = { ...parsed.data, env }
  return loaded
}

// Takes the secrets in the env files and the shell out of anything agentsctl
// prints or keeps, along with what shared/scrub.ts knows by pattern, such as a
// machine's token, and any `held` [name, value] pairs the caller adds. Before
// the config has loaded, only the patterns and `held` apply.
export const scrubber = (held: [string, string][] = []): Scrub =>
  makeScrub([...(loaded ? envSecrets(loaded.env) : []), ...held].sort((a, b) => b[1].length - a[1].length))

// Who a process agentsctl starts is: each gets only the environment it needs.
export type ChildRole = 'api' | 'admin' | 'daemon' | 'people' | 'session' | 'build'
// What every process may see from this one's environment: where home is, who
// runs it, and the locale. Nothing else is passed on, whatever the shell or the
// env files hold.
const PASSED = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL'] as const
// Only the API and the admin script talk to the database. The daemon, and the
// sessions it starts, never see its URL or the secrets.
const SECRETS: Record<ChildRole, readonly ('DATABASE_URL' | 'ELECTRIC_URL' | 'ELECTRIC_SECRET' | 'AGENTS_HOOK_SECRET')[]> = {
  api: ['DATABASE_URL', 'ELECTRIC_URL', 'ELECTRIC_SECRET', 'AGENTS_HOOK_SECRET'],
  admin: ['DATABASE_URL'],
  daemon: [], people: [], session: [], build: [],
}

// The environment for a process an instance starts, with the Node that runs
// agentsctl first on the PATH, since another program on this Mac answers to
// `node` in /usr/local/bin.
export function childEnv(role: ChildRole, extra: Record<string, string>): Record<string, string> {
  const loaded = config()
  const path = loaded.env.PATH
  if (!path) throw new Error('PATH is not set, so the processes an instance starts could not find git or claude')
  const passed = Object.fromEntries(PASSED.flatMap((key) => {
    const value = loaded.env[key]
    return value === undefined ? [] : [[key, value]]
  }))
  const secrets = Object.fromEntries(SECRETS[role].map((key) => [key, loaded[key]]))
  return { ...passed, PATH: `${dirname(process.execPath)}:${path}`, ...secrets, ...extra }
}
