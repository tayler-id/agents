// The product is Agents. Fails if any file outside the research notes uses the
// name of the app we studied, an abbreviation of it, or calls an agent a bot.
//   node test/names.ts

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url).pathname
// The teardown and rea's evidence describe the app we studied, so they may name it.
const RESEARCH = /^(research|docs\/evidence)\//
const OLD: [string, RegExp][] = [
  ['the studied app', /grok[\s_-]?bot/i],
  ['its abbreviation', /(?<![A-Za-z0-9])gb(?:[-_.]|d\b|i_)|(?<![A-Z])GB_[A-Z]|(?<![A-Za-z0-9])\.gb(?![A-Za-z0-9])/],
  ['bot for an agent', /\bbots?\b/i],
]

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f && !RESEARCH.test(f) && f !== 'test/names.ts')
const hits: string[] = []
for (const file of files) {
  const lines = readFileSync(`${ROOT}${file}`, 'utf8').split('\n')
  lines.forEach((line, i) => {
    for (const [what, pattern] of OLD) if (pattern.test(line)) hits.push(`${file}:${i + 1} ${what}: ${line.trim().slice(0, 120)}`)
  })
}
if (hits.length) {
  console.error(hits.join('\n'))
  console.error(`\n${hits.length} lines use an old name`)
  process.exit(1)
}
console.log(`no old names in ${files.length} files`)
