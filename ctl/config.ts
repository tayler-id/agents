// What agentsctl runs against, read once when it starts. It loads the repo's
// .env and then .env.test, later over earlier, with the real environment over
// both, the same order the checks use. It refuses to go on unless the database
// and Electric are the ones .env.test names, so an instance never touches the
// live system's data.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { z } from 'zod'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))

// Where instance state and evidence live, inside the checkout so each worktree
// keeps its own. Git ignores the folder.
export const VERIFY_DIR = join(ROOT, '.verify')
export const INSTANCES_DIR = join(VERIFY_DIR, 'instances')
export const EVIDENCE_DIR = join(VERIFY_DIR, 'evidence')
export const SKILL_DIR = join(ROOT, '.claude', 'skills', 'verify-agents')
export const FEATURES_DIR = join(SKILL_DIR, 'features')
export const BASELINES_DIR = join(SKILL_DIR, 'baselines')

// The ports instances take, clear of the live API (7700, 7710, its streams on
// 4437), the checks (7700 to 7999), Electric (3000, 3002) and the forge (3001).
export const PORT_RANGE = { first: 8020, last: 8039 } as const
// The live system's ports. Nothing agentsctl starts or drives may use them.
export const LIVE_PORTS: readonly number[] = [7700, 7701, 7710, 4437, 3000]

const FileEnv = z.record(z.string(), z.string())

function readEnvFile(name: string): Record<string, string> {
  const path = join(ROOT, name)
  if (!existsSync(path)) throw new Error(`${name} is missing from ${ROOT}. Copy it from the main checkout.`)
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

let loaded: Config | null = null

export function config(): Config {
  if (loaded) return loaded
  const testFile = readEnvFile('.env.test')
  const merged = { ...readEnvFile('.env'), ...testFile }
  const real = FileEnv.parse(Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)))
  const env = { ...merged, ...real }
  const parsed = Config.safeParse(env)
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')
    throw new Error(`agentsctl needs ${missing}, from .env, .env.test or the environment`)
  }
  for (const key of ['DATABASE_URL', 'ELECTRIC_URL'] as const) {
    const fromTest = testFile[key]
    if (!fromTest) throw new Error(`.env.test must set ${key}, so agentsctl runs against the test database and its Electric`)
    if (parsed.data[key] !== fromTest) {
      throw new Error(`${key} is ${redact(parsed.data[key])} but .env.test says ${redact(fromTest)}. Unset ${key} in your shell: agentsctl only runs against the test system.`)
    }
  }
  const database = new URL(parsed.data.DATABASE_URL).pathname.slice(1)
  if (!database.endsWith('_test')) throw new Error(`the database ${database} is not a test database (its name must end in _test)`)
  loaded = { ...parsed.data, env }
  return loaded
}

// The environment for the processes an instance starts: this one's, with the
// test database and Electric, and the Node that runs agentsctl first on the PATH,
// since another program on this Mac answers to `node` in /usr/local/bin.
export function childEnv(extra: Record<string, string>): Record<string, string> {
  const { env, DATABASE_URL, ELECTRIC_URL, ELECTRIC_SECRET, AGENTS_HOOK_SECRET } = config()
  const path = env.PATH
  if (!path) throw new Error('PATH is not set, so the processes an instance starts could not find git or claude')
  return {
    ...env,
    PATH: `${dirname(process.execPath)}:${path}`,
    DATABASE_URL, ELECTRIC_URL, ELECTRIC_SECRET, AGENTS_HOOK_SECRET,
    ...extra,
  }
}
