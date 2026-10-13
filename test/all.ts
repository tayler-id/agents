// Runs every step's check, one after another, and reports each result.
//   npm run check            all checks
//   npm run check -- 2 3     only the named steps

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url).pathname
const only = process.argv.slice(2)
const checks = readdirSync(new URL('.', import.meta.url))
  .filter((f) => /^step[0-9a-z]+\.ts$/.test(f))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  .filter((f) => !only.length || only.some((o) => f.startsWith(`step${o}`)))

const results: [string, boolean, number][] = []
for (const file of checks) {
  const started = Date.now()
  console.log(`\n=== ${file}`)
  // .env.test comes last, so checks use their own database and Electric.
  const run = spawnSync(process.execPath, ['--env-file=.env', '--env-file=.env.test', `test/${file}`], { cwd: ROOT, stdio: 'inherit' })
  results.push([file, run.status === 0, Math.round((Date.now() - started) / 1000)])
}

console.log('\n=== summary')
for (const [file, ok, seconds] of results) console.log(`${ok ? 'pass' : 'FAIL'}  ${file} (${seconds}s)`)
const failed = results.filter(([, ok]) => !ok).length
console.log(failed ? `\n${failed} of ${results.length} checks failed` : `\nall ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
