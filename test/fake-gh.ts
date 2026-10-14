// A stand-in for GitHub's gh CLI, for step22. It answers the pull request commands
// agents-git runs and keeps the pull requests, and every call, in the JSON file
// STEP22_FAKE_GH_STATE names.
//   pr list --head <branch> --state open --json url,number --limit 1
//   pr create --head <branch> --base <base> --title <title> --body <body>
//   pr edit <number> --body <body>

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const file = process.env.STEP22_FAKE_GH_STATE
if (!file) {
  console.error('fake gh: STEP22_FAKE_GH_STATE is not set')
  process.exit(1)
}
type Pull = { number: number, head: string, base: string, title: string, body: string, url: string }
const state: { pulls: Pull[], calls: string[][] } = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { pulls: [], calls: [] }
const argv = process.argv.slice(2)
state.calls.push(argv)
const [group, verb, ...rest] = argv
const { values, positionals } = parseArgs({
  args: rest,
  options: { head: { type: 'string' }, base: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, state: { type: 'string' }, json: { type: 'string' }, limit: { type: 'string' } },
  allowPositionals: true,
})

let out: string
if (group === 'pr' && verb === 'list') {
  out = JSON.stringify(state.pulls.filter((p) => p.head === values.head).map((p) => ({ url: p.url, number: p.number })))
} else if (group === 'pr' && verb === 'create') {
  const number = state.pulls.length + 1
  const pull = { number, head: values.head ?? '', base: values.base ?? '', title: values.title ?? '', body: values.body ?? '', url: `https://github.com/step22/agents/pull/${String(number)}` }
  state.pulls.push(pull)
  out = pull.url
} else if (group === 'pr' && verb === 'edit') {
  const pull = state.pulls.find((p) => String(p.number) === positionals[0])
  if (!pull) {
    console.error(`fake gh: no pull request ${positionals[0] ?? ''}`)
    process.exit(1)
  }
  pull.body = values.body ?? pull.body
  out = pull.url
} else {
  console.error(`fake gh: it does not know gh ${argv.join(' ')}`)
  process.exit(1)
}
writeFileSync(file, JSON.stringify(state, null, 2))
console.log(out)
