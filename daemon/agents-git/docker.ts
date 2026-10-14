// The docker every check sees. check and land put it first on the PATH of each step
// and suite they run, and it hands each call to the real docker with three rules
// on top. It refuses to build or tag agents-box:latest, the image the live server
// starts boxes from. It stops a build that runs past its limit. And it notes each
// build, so agents-git runs docker image prune -f when the step ends.
//   AGENTS_GIT_DOCKER            the real docker
//   AGENTS_GIT_BUILDS            the file each build adds a line to
//   AGENTS_GIT_BUILD_LIMIT_SEC   how long one build may run

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { constants } from 'node:os'
import { z } from 'zod'

const env = z.object({
  AGENTS_GIT_DOCKER: z.string().startsWith('/'),
  AGENTS_GIT_BUILDS: z.string().startsWith('/'),
  AGENTS_GIT_BUILD_LIMIT_SEC: z.coerce.number().int().positive(),
}).parse(process.env)
const argv = process.argv.slice(2)

// docker's own options that take a value. They come before its command.
const VALUED = new Set(['--context', '-c', '--host', '-H', '--config', '--log-level', '-l'])
// Commands that hold the real command one word further on.
const GROUPS = new Set(['buildx', 'image', 'builder', 'container'])
const BUILDS = new Set(['build', 'buildx build', 'image build', 'builder build'])
const TAGS = new Set(['tag', 'image tag', 'commit', 'container commit'])
// agents-box with no tag is agents-box:latest, and a registry in front still names it.
const LIVE_IMAGE = /^(?:[^/\s]+\/)*agents-box(?::latest)?$/

// The command's words, past docker's own options, and where its arguments start.
function command(): { name: string, from: number } {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (VALUED.has(arg)) i++
    else if (!arg.startsWith('-')) {
      const next = argv[i + 1]
      return GROUPS.has(arg) && next !== undefined ? { name: `${arg} ${next}`, from: i + 2 } : { name: arg, from: i + 1 }
    }
  }
  return { name: '', from: argv.length }
}

// The images a build names with -t or --tag, or the image a tag or commit makes.
function namedImages(name: string, args: string[]): string[] {
  if (BUILDS.has(name)) {
    return args.flatMap((arg, i) => {
      if (arg === '-t' || arg === '--tag') return [args[i + 1] ?? '']
      if (arg.startsWith('--tag=')) return [arg.slice('--tag='.length)]
      if (arg.startsWith('-t') && arg.length > 2) return [arg.slice(2)]
      return []
    })
  }
  if (TAGS.has(name)) return args.filter((arg) => !arg.startsWith('-')).slice(1, 2)
  return []
}

function pass(limitSec: number | null) {
  const child = spawn(env.AGENTS_GIT_DOCKER, argv, { stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal))
  let stopped = false
  const timer = limitSec === null ? null : setTimeout(() => {
    stopped = true
    child.kill('SIGTERM')
  }, limitSec * 1000)
  child.on('exit', (code, signal) => {
    if (timer) clearTimeout(timer)
    if (stopped) console.error(`agents-git: docker build ran past ${limitSec ?? 0} seconds, so it was stopped`)
    // A timeout's exit code, as the timeout command uses.
    process.exitCode = stopped ? 124 : code ?? 128 + (signal ? constants.signals[signal] : 0)
  })
}

const { name, from } = command()
const live = namedImages(name, argv.slice(from)).find((image) => LIVE_IMAGE.test(image))
if (live !== undefined) {
  console.error(`agents-git: no check may build or tag ${live}, the image the live server starts boxes from. Give the image a tag of its own.`)
  process.exitCode = 1
} else if (BUILDS.has(name)) {
  appendFileSync(env.AGENTS_GIT_BUILDS, `${new Date().toISOString()} docker ${argv.join(' ')}\n`)
  pass(env.AGENTS_GIT_BUILD_LIMIT_SEC)
} else {
  pass(null)
}
