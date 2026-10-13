// The coding standards are enforced, not just written down. Writes two throwaway
// files that break the standards on purpose, one for the server and one for
// React, runs lint and the compiler on them, and checks that every rule the
// coding-standards skill names as enforced fires. Deletes the files whatever
// happens. Fails if someone weakens the lint config or the compiler flags.
//   npm run check -- 0

import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SERVER = join(ROOT, 'server', '_footguns.ts')
const APP = join(ROOT, 'app', 'src', '_Footguns.tsx')
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

// Each line breaks one rule.
const serverSource = `import { pool } from './db.ts'

type Kind = 'a' | 'b'

export async function footguns(rows: { id: string }[], map: Record<string, string>, input: unknown, kind: Kind) {
  pool.query('select 1')
  const first = rows[0]
  console.log(first.id)
  console.log(map.missing!.length)
  const parsed = JSON.parse('{}')
  console.log(parsed.x)
  console.log(\`\${{ a: 1 }}\`)
  if (input == null) return
  setTimeout(async () => { await pool.query('select 1') }, 1)
  try { await pool.query('select 1') } catch {}
  const loose: any = 1
  console.log(loose)
  switch (kind) {
    case 'a': return
  }
  throw 'a string'
}
`

const appSource = `import { useEffect, useState } from 'react'

export function Footguns({ flag, list }: { flag: boolean; list: string[] }) {
  if (flag) {
    const [a] = useState(0)
    console.log(a)
  }
  const [n, setN] = useState(0)
  useEffect(() => { setN(list.length) }, [])
  return (
    <div>
      {list.map((item) => <span>{item}</span>)}
      <button onClick={async () => { await Promise.resolve() }}>x</button>
      <a href="https://example.com" target="_blank">x</a>
      <div dangerouslySetInnerHTML={{ __html: '<b>x</b>' }} />
      {n}
    </div>
  )
}
`

const RULES = {
  server: {
    '@typescript-eslint/no-floating-promises': 'a promise nobody awaits',
    '@typescript-eslint/no-non-null-assertion': 'a ! non-null assertion',
    '@typescript-eslint/no-unsafe-member-access': 'any from JSON.parse',
    '@typescript-eslint/no-explicit-any': 'an explicit any',
    '@typescript-eslint/restrict-template-expressions': 'an object in a template string',
    eqeqeq: '== instead of ===',
    '@typescript-eslint/no-misused-promises': 'an async callback where a plain one is expected',
    'no-empty': 'an empty catch',
    '@typescript-eslint/only-throw-error': 'throwing a string',
    '@typescript-eslint/switch-exhaustiveness-check': 'a switch that misses a case',
  },
  app: {
    'react-hooks/rules-of-hooks': 'a hook inside a condition',
    'react-hooks/exhaustive-deps': 'an effect missing a dependency',
    'react-hooks/set-state-in-effect': 'state set straight from an effect',
    'react/jsx-key': 'a list without keys',
    'react/button-has-type': 'a button without a type',
    '@typescript-eslint/no-misused-promises': 'an async click handler',
    'react/jsx-no-target-blank': 'a new-tab link without rel',
    'react/no-danger': 'raw HTML',
  },
}

// Lint and the compiler exit non-zero on these files, which is the point.
function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout
    return typeof stdout === 'string' ? stdout : ''
  }
}

try {
  writeFileSync(SERVER, serverSource)
  writeFileSync(APP, appSource)
  const bin = (name: string) => join(ROOT, 'node_modules', '.bin', name)
  const report = JSON.parse(run(bin('eslint'), ['-f', 'json', SERVER, APP]) || '[]') as { filePath: string; messages: { ruleId: string | null }[] }[]
  const fired = (file: string) => new Set(report.find((f) => f.filePath === file)?.messages.map((m) => m.ruleId) ?? [])
  for (const [rule, what] of Object.entries(RULES.server)) check(fired(SERVER).has(rule), `lint catches ${what} (${rule})`)
  for (const [rule, what] of Object.entries(RULES.app)) check(fired(APP).has(rule), `lint catches ${what} in React (${rule})`)
  const tsc = run(bin('tsc'), ['--noEmit', '-p', '.'])
  check(tsc.includes('_footguns.ts') && tsc.includes("'first' is possibly 'undefined'"),
    'the compiler catches reading an array element without checking it (noUncheckedIndexedAccess)')
} finally {
  rmSync(SERVER, { force: true })
  rmSync(APP, { force: true })
}

console.log(`\n${failures.length ? `${failures.length} failed` : 'all passed (throwaway files removed)'}`)
process.exit(failures.length ? 1 : 0)
