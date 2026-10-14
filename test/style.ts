// The design and prose lints over the whole repo, with the rules in this repo's
// policy, ops/policies/agents.json. Fails on an accent color on a border,
// outline, ring or stroke, a gradient, a color that is not a design token, an
// em dash, a banned word, or a title-case heading.
//   node test/style.ts

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { componentFindings, cssFindings, tokensOf } from '../shared/gates/css.ts'
import { matcher } from '../shared/gates/glob.ts'
import { proseFindings } from '../shared/gates/prose.ts'
import { POLICY } from '../shared/policy.ts'

const ROOT = new URL('..', import.meta.url).pathname
const policy = POLICY.parse(JSON.parse(readFileSync(`${ROOT}ops/policies/agents.json`, 'utf8')))
const { css, prose } = policy.lint
const rules = { tokens: tokensOf(readFileSync(`${ROOT}${css.tokens}`, 'utf8')), neutral: new Set(css.neutral) }
const isCss = matcher(css.files)
const exempt = matcher(prose.exempt)

// Only regular files are read. A checkout that links node_modules from
// elsewhere lists the link as untracked, and it is a folder.
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f && !exempt(f) && existsSync(`${ROOT}${f}`) && statSync(`${ROOT}${f}`).isFile())
const findings = files.flatMap((file) => {
  const text = readFileSync(`${ROOT}${file}`, 'utf8')
  return [
    ...proseFindings(file, text, prose),
    ...(isCss(file) ? cssFindings(file, text, rules) : componentFindings(file, text, rules)),
  ]
})
if (findings.length) {
  console.error(findings.map((f) => `${f.path ?? ''}:${f.line ?? ''} ${f.text}`).join('\n'))
  console.error(`\n${findings.length} style findings`)
  process.exit(1)
}
console.log(`no style findings in ${files.length} files`)
