// runs-in: box
// The coding framework's static gates and lints, each on a small change made
// up for it, with this repo's policy. Every rule must fail on its violation
// and pass without it. Needs no database, forge or Docker.
//   node test/step16b.ts

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { checkAttestation, statusText, withAttestation, type Attestation } from '../shared/attestation.ts'
import { findingKey } from '../shared/findings.ts'
import { fenced, resultProblems } from '../shared/framework.ts'
import type { GateResult, GateStatus, MapOnMain } from '../shared/framework.ts'
import { staticGates, type FileChange, type StaticContext } from '../shared/gates/diff.ts'
import { cssFindings, tokensOf } from '../shared/gates/css.ts'
import { proseFindings, titleCase } from '../shared/gates/prose.ts'
import { globRegExp } from '../shared/gates/glob.ts'
import { planProblems, sectionOf } from '../shared/gates/plan.ts'
import { POLICY } from '../shared/policy.ts'

const ROOT = new URL('..', import.meta.url).pathname
const policy = POLICY.parse(JSON.parse(readFileSync(`${ROOT}ops/policies/agents.json`, 'utf8')))
const TOKENS = readFileSync(`${ROOT}app/src/styles.css`, 'utf8')
const failures: string[] = []

function check(ok: boolean, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const range = (n: number) => new Set(Array.from({ length: n }, (_, i) => i + 1))

// A file the change adds, every line of it new.
function added(path: string, after: string): FileChange {
  const lines = after.split('\n').length
  return { path, status: 'added', from: null, added: lines, deleted: 0, addedLines: range(lines), before: null, after, binary: false, bytes: Buffer.byteLength(after), diff: `+${after}` }
}

// A file the change edits by appending lines to it.
function appended(path: string, before: string, extra: string): FileChange {
  const start = before.split('\n').length
  const count = extra.split('\n').length
  const lines = new Set(Array.from({ length: count }, (_, i) => start + i + 1))
  return { path, status: 'modified', from: null, added: count, deleted: 0, addedLines: lines, before, after: `${before}\n${extra}`, binary: false, bytes: Buffer.byteLength(`${before}\n${extra}`), diff: `+${extra}` }
}

// A file the gates cannot read: git calls it binary, or it is over the read limit.
function unread(path: string, bytes: number, binary: boolean): FileChange {
  return { path, status: 'added', from: null, added: 0, deleted: 0, addedLines: new Set(), before: null, after: null, binary, bytes, diff: '' }
}

const BUILD_LOG = appended('docs/build-log.md', '# Build log', 'Added the thing.')

function gate(name: string, files: FileChange[], extra: Partial<StaticContext> = {}): GateResult {
  const ctx: StaticContext = {
    policy, files, baseMigrations: ['0001_data_model.sql', '0009_self_improve.sql'], tokens: TOKENS, featureMap: { kind: 'none' },
    playbook: null, plan: null, requirePlan: false, refusedPushes: [], ...extra,
  }
  const found = staticGates(ctx).find((r) => r.gate === name)
  if (!found) throw new Error(`no gate named ${name}`)
  return found
}

function expect(name: string, files: FileChange[], status: GateStatus, label: string, extra: Partial<StaticContext> = {}) {
  const result = gate(name, files, extra)
  check(result.status === status, `${name}: ${label} (${result.status}${result.findings[0] ? `, ${result.findings[0].text.split('\n')[0] ?? ''}` : ''})`)
  return result
}

// Globs.
check(globRegExp('**/tsconfig*.json').test('app/tsconfig.json') && globRegExp('**/tsconfig*.json').test('tsconfig.json')
  && globRegExp('.claude/**').test('.claude/skills/x/SKILL.md') && !globRegExp('test/step16*.ts').test('test/step1.ts')
  && globRegExp('test/step16*.ts').test('test/step16b.ts') && !globRegExp('ops/**').test('opsx/a.ts'),
'globs match paths the way the policy means them')

// A policy may tighten the core and never loosen it.
const raw = JSON.parse(readFileSync(`${ROOT}ops/policies/agents.json`, 'utf8'))
const parses = (patch: object) => POLICY.safeParse({ ...raw, ...patch }).success
check(parses({ maxChangedLines: 200 }) && parses({ verdict: { ...raw.verdict, docs: 'unit-test-verified' } }), 'policy: a policy can tighten the core')
check(!parses({ maxChangedLines: 1000 }), 'policy: a policy cannot raise the size limit past the core')
check(!parses({ verdict: { ...raw.verdict, code: 'type-check-only' } }) && !parses({ verdict: { ...raw.verdict, ui: 'unit-test-verified' } }),
  'policy: a policy cannot lower the verdict a change needs')

// Protected paths.
const lint = expect('protected', [appended('eslint.config.js', 'export default []', '// looser')], 'needs_owner', 'a change to the lint config needs the owner')
check(lint.findings[0]?.path === 'eslint.config.js' && lint.findings[0].text.includes('+// looser'), 'protected: the finding names the file and shows its diff')
expect('protected', [appended('server/api.ts', 'x', 'y')], 'pass', 'an ordinary file is not protected')
expect('protected', [appended('app/src/AGENTS.md', '# Rules', 'More.')], 'needs_owner', 'a rules file in a folder needs the owner')
expect('protected', [appended('server/migrations/0001_data_model.sql', '-- x', '-- y')], 'needs_owner', 'a migration needs the owner')
expect('protected', [appended('daemon/workspace.ts', 'x', 'y')], 'needs_owner', 'the push lease\'s code needs the owner')
expect('protected', [{ ...added('server/moved.ts', 'x'), status: 'renamed', from: 'server/runner.ts' }], 'needs_owner', 'renaming a protected file away needs the owner')

// Migrations.
expect('migrations', [appended('server/migrations/0001_data_model.sql', 'create table a ();', 'drop table a;'), BUILD_LOG], 'fail', 'editing an existing migration fails')
expect('migrations', [added('server/migrations/0010_more.sql', 'create table b ();'), BUILD_LOG], 'fail', 'a new migration without the data model fails')
expect('migrations', [added('server/migrations/0010_more.sql', 'create table b ();'), appended('docs/data-model.md', '# Data model', '- **b**, new.')], 'pass', 'a new migration with the data model passes')
expect('migrations', [added('server/migrations/0005_early.sql', 'select 1;'), appended('docs/data-model.md', '# Data model', '- x')], 'fail', 'a new migration numbered before main\'s latest fails')

// Docs.
expect('docs', [added('server/thing.ts', 'export const a = 1'), BUILD_LOG], 'fail', 'a new source file with no parts entry fails')
expect('docs', [added('server/thing.ts', 'export const a = 1'), appended('docs/what-each-part-does.md', '# Parts', '### The thing (`server/thing.ts`)'), BUILD_LOG], 'pass', 'a new source file with its entry passes')
expect('docs', [appended('server/api.ts', 'x', 'y')], 'fail', 'a change that adds nothing to the build log fails')

// Secrets.
expect('secrets', [added('server/key.ts', `export const key = 'sk-ant-${'a'.repeat(30)}'`)], 'fail', 'a key in the diff fails')
expect('secrets', [added('.env.local', 'A=1')], 'fail', 'an added .env file fails')
expect('secrets', [added('server/ok.ts', 'export const key = process.env.KEY')], 'pass', 'reading a key from the environment passes')

// Dependencies.
const pkg = '{\n  "dependencies": {\n    "pg": "^8.23.1"\n  }\n}'
const withDep = (version: string) => ({ ...appended('package.json', pkg, ''), after: pkg.replace('"pg": "^8.23.1"', `"pg": "^8.23.1",\n    "left-pad": "${version}"`) })
expect('dependencies', [withDep('^1.3.0'), BUILD_LOG], 'fail', 'a range version and no reason fail')
const owned = expect('dependencies', [withDep('1.3.0'), appended('docs/build-log.md', '# Build log', 'left-pad pads the ids.')], 'needs_owner', 'an exact version with a reason goes to the owner')
check(owned.findings.some((f) => f.text.includes('left-pad')), 'dependencies: the owner sees which package changed')
expect('dependencies', [appended('package-lock.json', '{}', '')], 'fail', 'a lockfile change with no manifest change fails')

// Suppressions, skipped tests and removed assertions.
expect('suppressions', [added('server/a.ts', '// eslint-disable-next-line no-console\nconsole.log(1)')], 'fail', 'a new eslint-disable fails')
expect('suppressions', [added('server/b.ts', '// @ts-expect-error the type is wrong\nconst n: number = "x"')], 'fail', 'a new ts-expect-error fails')
expect('suppressions', [added('server/g.ts', '/* eslint no-console: "off" */\nconsole.log(1)')], 'fail', 'inline eslint config turning a rule off fails')
expect('suppressions', [added('server/h.ts', '/* global window */\nexport const w = 1')], 'fail', 'an inline globals comment fails')
expect('suppressions', [added('server/i.ts', '/* An eslint rule keeps this file tidy. */\nexport const t = 1')], 'pass', 'a comment that only mentions eslint passes')
expect('suppressions', [added('test/x.test.ts', "import test from 'node:test'\ntest.skip('later', () => {})")], 'fail', 'a skipped test fails')
const twoChecks = "check(a === 1, 'one')\ncheck(b === 2, 'two')"
const loosened = { ...appended('test/step50.ts', twoChecks, ''), after: "check(a === 1, 'one')" }
const product = appended('server/api.ts', 'x', 'y')
expect('suppressions', [loosened, product], 'fail', 'removing an assertion beside product code fails')
expect('suppressions', [appended('test/step50.ts', twoChecks, "check(c === 3, 'three')"), product], 'pass', 'adding an assertion passes')

// Edits to existing checks.
expect('check_edits', [loosened, product], 'fail', 'editing a check together with product code fails')
expect('check_edits', [loosened, BUILD_LOG], 'fail', 'editing a check alone with no reason in the build log fails')
const explained = expect('check_edits', [loosened, appended('docs/build-log.md', '# Build log', 'test/step50.ts asserted the old total, which was wrong.')],
  'needs_owner', 'editing a check alone with a reason goes to the owner')
check(explained.findings[0]?.text.includes('removing 1 assertion') === true, 'check_edits: the owner sees the removed assertion')
expect('check_edits', [added('test/step51.ts', "check(true, 'new')"), product], 'pass', 'a new check beside product code passes')
expect('check_edits', [added('test/step52.ts', "check(true, 'new')"), BUILD_LOG], 'needs_owner', 'a new check alone goes to the owner, since seen failing cannot judge it')
expect('check_edits', [appended('test/must.ts', 'export {}', '// helper'), product], 'fail', 'editing a test helper together with product code fails')

// Size.
expect('size', [added('docs/big.md', Array.from({ length: 401 }, (_, i) => `line ${i}`).join('\n'))], 'fail', '401 changed lines fail')
expect('size', [added('docs/ok.md', Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n'))], 'pass', '400 changed lines pass')
expect('size', [added('package-lock.json', Array.from({ length: 900 }, () => '{}').join('\n'))], 'pass', 'lockfile lines do not count')
expect('size', [unread('server/hidden.ts', 40_000, true)], 'fail', 'a script git calls binary counts toward the cap by its bytes')

// Files the gates cannot read.
const hidden = expect('opaque', [unread('server/hidden.ts', 120, true)], 'fail', 'a script with a NUL byte, which git calls binary, fails')
check(hidden.findings[0]?.text.includes('binary') === true, 'opaque: the finding says the file is binary')
expect('opaque', [unread('docs/huge.md', 3 * 1024 * 1024, false)], 'fail', 'a document over the read limit fails')
expect('opaque', [unread('server/migrations/0010_x.sql', 64, true)], 'fail', 'binary SQL fails')
expect('opaque', [unread('ops/policies/x.json', 64, true)], 'fail', 'binary JSON fails')
expect('opaque', [unread('app/src/x.css', 64, true)], 'fail', 'a binary stylesheet fails')
expect('opaque', [unread('docs/evidence/shot.png', 90_000, true)], 'pass', 'an image the gates never read passes')
expect('opaque', [unread('package-lock.json', 3 * 1024 * 1024, false)], 'pass', 'a lockfile over the read limit passes')
expect('opaque', [{ ...unread('server/old.ts', 0, true), status: 'deleted', bytes: null }], 'pass', 'deleting a binary script passes')

// UI changes need a Playwright check in every engine at both widths.
const view = appended('app/src/App.tsx', 'export const a = 1', 'export const b = 2')
expect('ui', [view], 'fail', 'a UI change with no Playwright check fails')
const playwright = "import { chromium, firefox, webkit } from '@playwright/test'\nfor (const width of ['desktop', 'phone']) {}"
expect('ui', [view, added('test/step60.ts', playwright)], 'pass', 'a UI change with a check in three engines at two widths passes')
expect('ui', [view, added('test/step60.ts', playwright.replace(', webkit', ''))], 'fail', 'a check missing an engine fails')

// The design lint.
const css = (rule: string) => [appended('app/src/styles.css', TOKENS, rule)]
expect('css', css('.x { border: 1px solid var(--live); }'), 'fail', 'an accent border fails')
expect('css', css('.x { outline: 2px solid var(--danger); }'), 'fail', 'an accent outline fails')
expect('css', css('.x { box-shadow: 0 0 0 2px var(--waiting); }'), 'fail', 'an accent ring fails')
expect('css', css('.x { border-color: currentColor; }'), 'fail', 'currentColor on a border fails')
expect('css', css('.x { background: linear-gradient(var(--bg), var(--raised)); }'), 'fail', 'a gradient fails')
expect('css', css('.x { color: #ff0000; }'), 'fail', 'a raw color fails')
expect('css', css('.x { color: red; }'), 'fail', 'a named color fails')
expect('css', css('.x { color: var(--brand); }'), 'fail', 'an undefined token fails')
expect('css', css('.x { border-bottom: 1px solid var(--line); color: var(--live); border-radius: var(--r); }'), 'pass', 'a neutral hairline and an accent on text pass')
expect('css', [appended('app/src/View.tsx', 'export const a = 1', 'export const B = () => <div style={{ borderColor: \'var(--live)\' }} />')], 'fail', 'an accent border in an inline style fails')
expect('css', [appended('app/src/Icon.tsx', 'export const a = 1', 'export const I = () => <svg><path stroke="var(--danger)" /></svg>')], 'fail', 'an accent SVG stroke fails')
check(cssFindings('app/src/styles.css', TOKENS, { tokens: tokensOf(TOKENS), neutral: new Set(policy.lint.css.neutral) }).length === 0,
  'css: the real stylesheet passes, with raw colors allowed only where :root defines tokens')

// The prose lint.
const dash = String.fromCharCode(0x2014)
const word = ['rob', 'ust'].join('')
expect('prose', [appended('docs/notes.md', '# Notes', `It works ${dash} mostly.`)], 'fail', 'an em dash in a doc fails')
expect('prose', [appended('server/x.ts', 'export const a = 1', `// A ${word} retry loop.`)], 'fail', 'a banned word in a comment fails')
expect('prose', [appended('app/src/X.tsx', 'export const a = 1', `export const Y = () => <p>Saved ${dash} done</p>`)], 'fail', 'an em dash in a UI string fails')
expect('prose', [appended('docs/notes.md', '# Notes', '## Pull Request Evidence')], 'fail', 'a title-case heading fails')
expect('prose', [appended('docs/notes.md', '# Notes', `## Pull request evidence\n\nThe \`${word}\` word is quoted as code.`)], 'pass', 'sentence case, and a banned word in code, pass')
check(titleCase('## Run The Server', new Set()) !== null && titleCase('## Postgres and Electric on the Mac', new Set(policy.lint.prose.properNouns)) === null
  && titleCase('### Step 1 again: the agreed data model (done)', new Set()) === null,
'prose: title case is told from sentence case with proper nouns')
check(proseFindings('docs/x.md', `\`\`\`\n${dash}\n\`\`\``, policy.lint.prose).length === 0, 'prose: a fenced code block is not prose')

// Files in other languages, type assertions, shell strings and warning comments.
expect('languages', [added('scripts/fix.py', 'print(1)')], 'fail', 'a new Python file fails')
expect('languages', [added('ops/run.sh', 'echo hi')], 'fail', 'a new shell script fails')
expect('languages', [added('docs/x.md', 'x'), added('server/x.ts', 'export {}')], 'pass', 'Markdown and TypeScript pass')
expect('assertions', [added('server/c.ts', 'export const n = JSON.parse("1") as number')], 'fail', 'a new type assertion fails')
expect('assertions', [added('server/c.ts', "export const kinds = ['a', 'b'] as const")], 'pass', 'as const passes')
expect('assertions', [appended('server/c.ts', 'export const n = JSON.parse("1") as number', 'export const m = 2')], 'pass', 'an old assertion on an untouched line passes')
expect('shell', [added('server/d.ts', "import { exec } from 'node:child_process'\nexec('ls')")], 'fail', 'importing exec fails')
expect('shell', [added('server/d.ts', "import { spawn } from 'node:child_process'\nspawn('ls', [], { shell: true })")], 'fail', 'shell: true fails')
expect('shell', [added('server/d.ts', "import { execFile } from 'node:child_process'\nexecFile('ls', ['-l'])\n/x/.exec('y')")], 'pass', 'execFile and a regex exec pass')
expect('warnings', [added('server/e.ts', '// TODO handle the empty case\nexport {}')], 'fail', 'a TODO fails')

// The playbook, the approved plan, and refused pushes.
expect('playbook', [appended('server/api.ts', 'x', 'y')], 'fail', 'a docs playbook that changes code fails', { playbook: 'docs' })
expect('playbook', [appended('README.md', '# Agents', 'More.')], 'pass', 'a docs playbook that changes docs passes', { playbook: 'docs' })
const plan = '# Plan\n\n## Done means\n\n- Totals never go below zero (check: test/step70.ts)\n\n## Keep\n\n- `record`: posts keep their order\n'
const map: MapOnMain = { kind: 'found', map: { features: [{ id: 'record', name: 'The record', paths: ['server/record.ts'], checks: ['test/step1.ts'] }] } }
const lost: MapOnMain = { kind: 'missing', path: '.claude/skills/verify/features.json' }
const step70 = added('test/step70.ts', "check(true, 'x')")
expect('plan', [step70], 'fail', 'code with no approved plan fails', { requirePlan: true })
expect('plan', [step70], 'pass', 'a plan whose checks are in the change passes', { plan, featureMap: map })
expect('plan', [added('test/step71.ts', "check(true, 'x')")], 'fail', 'a Done means check missing from the change fails', { plan, featureMap: map })
expect('plan', [step70], 'fail', 'a Keep item naming no mapped feature fails', { plan: plan.replace('`record`', '`nothing`'), featureMap: map })
expect('plan', [step70], 'fail', 'a feature map the policy names and main lacks fails the plan, never skipping Keep', { plan, featureMap: lost })
check(planProblems(plan, policy.checks.pattern, policy.lint.prose, lost).some((p) => p.includes('not on main')), 'plan lint: a missing feature map is a problem that names the path')
check(planProblems(plan, policy.checks.pattern, policy.lint.prose, map).length === 0, 'plan lint: a plan with checks and mapped features passes')
const sloppy = planProblems(`# Plan\n\n## Done means\n\n- It works ${dash} trust me\n\n## Keep\n\n- everything\n`, policy.checks.pattern, policy.lint.prose, map)
check(sloppy.some((p) => p.includes('names no check')) && sloppy.some((p) => p.includes('no feature')) && sloppy.some((p) => p.includes('em dash')),
  `plan lint: a plan with no check, no mapped feature and an em dash fails before anyone reads it (${sloppy.join('; ')})`)
const pushed = expect('pushes', [], 'fail', 'a refused push fails', { refusedPushes: [{ refs: ['refs/heads/main'] }] })
check(pushed.stops, 'pushes: a refused push stops the run instead of returning the change')

// An overrule carries to a later round only for the same finding: the same
// rule, however it is spaced or ended, the same path and the same body.
const overruledFinding = { rule: 'No magic values', path: 'shared/x.ts', body: 'The answer is a bare string.' }
check(findingKey(overruledFinding) === findingKey({ ...overruledFinding, rule: ' no magic  values. ', body: 'The answer is a bare string.\n' }),
  'overrule key: the same rule, spaced or ended differently, with the same body, is the same finding')
check(findingKey(overruledFinding) !== findingKey({ ...overruledFinding, body: 'The answer is a bare string, and it leaks a token.' }),
  'overrule key: a different body under the same rule and path is a new finding')
check(findingKey(overruledFinding) !== findingKey({ ...overruledFinding, path: 'shared/y.ts' }), 'overrule key: another path is a new finding')

// A machine's result answers exactly what it was asked, or it is no evidence.
const ran = (name: string, argv: string[], exitCode = 0) => ({ name, argv, exitCode, timedOut: false, seconds: 1, output: '' })
const seen = (file: string) => ({ file, base: ran(file, ['node', file], 1), change: ran(file, ['node', file]) })
const askedBox = { commands: [{ name: 'lint', argv: ['node', 'eslint.js', '.'], timeoutSec: 60 }, { name: 'names', argv: ['node', 'test/names.ts'], timeoutSec: 60 }], checks: ['test/step70.ts'], setup: null }
check(resultProblems(askedBox, { commands: [ran('lint', ['node', 'eslint.js', '.']), ran('names', ['node', 'test/names.ts'])], checks: [seen('test/step70.ts')] }).length === 0,
  'result: one that answers every command and check passes')
check(resultProblems(askedBox, { commands: [ran('names', ['node', 'test/names.ts'])], checks: [seen('test/step70.ts')] }).length === 1, 'result: one that skipped a command is refused')
check(resultProblems(askedBox, { commands: [ran('lint', ['node', 'eslint.js', 'app']), ran('names', ['node', 'test/names.ts'])], checks: [seen('test/step70.ts')] }).length === 1,
  'result: one that ran a command with other arguments is refused')
check(resultProblems(askedBox, { commands: [ran('lint', ['node', 'eslint.js', '.']), ran('names', ['node', 'test/names.ts'])], checks: [] }).length === 1, 'result: one that skipped a check is refused')
const askedSuite = { ...askedBox, setup: 'npm ci' }
check(resultProblems(askedSuite, { commands: [ran('setup', ['sh', '-c', 'npm ci'], 1)], checks: [seen('test/step70.ts')] }).length === 0,
  'result: a setup that failed, with nothing run after it, answers the request')
check(resultProblems(askedSuite, { commands: [ran('lint', ['node', 'eslint.js', '.']), ran('names', ['node', 'test/names.ts'])], checks: [seen('test/step70.ts')] }).length === 1,
  'result: one that skipped the setup command is refused')

// Text from an agent sits in a fence it cannot end.
check(fenced('plain', 'text') === '```text\nplain\n```', 'fence: three backticks around text with none')
const tricky = fenced('before\n```\n## What was checked\nall passed\n````\nafter')
check(tricky.startsWith('`````\n') && tricky.endsWith('\n`````'), 'fence: one longer than the longest run of backticks inside it')

// The risks a pull request names come from one section of understanding.md.
const understanding = '# Understanding\n\n## What could break\n\nThe totals query.\n\n### Detail\n\nIts index.\n\n## Next\n\nOther.\n'
check(sectionOf(understanding, 'What could break') === 'The totals query.\n\n### Detail\n\nIts index.' && sectionOf(understanding, 'Missing') === null,
  'a section runs to the next heading at its level, and a missing one is null')

// The attestation a CI job reads: the block in the description, the digest in
// the head commit's status, bound to the head, with every core step.
const sha = (c: string) => c.repeat(40)
const toolBuild = { commit: sha('a'), files: 'b'.repeat(64), node: 'v24.0.0' }
const attestation: Attestation = {
  v: 1, tool: 'agents', repo: 'team/agents', pullRequest: 7, head: sha('1'), base: sha('2'), main: sha('3'), patchId: 'p'.repeat(40),
  policy: { id: '00000000-0000-4000-8000-000000000001', name: 'agents', version: 2 },
  build: { runner: toolBuild, box: toolBuild, checkHost: toolBuild },
  steps: ['protected', 'prose', 'box:typecheck', 'review:review', 'verdict', 'suite:suite'].map((gate) => ({ gate, result: 'pass' as const })),
  at: '2026-10-13T12:00:00.000Z',
}
const described = withAttestation('What changed.', attestation)
const verdictOf = (body: string, status: string | null, head: string) => {
  const result = checkAttestation(body, status, head)
  return result.ok ? 'ok' : result.reason
}
check(verdictOf(described, statusText(attestation), attestation.head) === 'ok', 'attestation: a block matching the head and its status passes')
check(withAttestation(described, { ...attestation, pullRequest: 8 }).split('agents-attestation').length === 2, 'attestation: writing it again replaces the block, never adds a second')
check(verdictOf(described, statusText(attestation), sha('4')).includes('pull request is at'), 'attestation: one for another head fails')
check(verdictOf(described, statusText({ ...attestation, steps: attestation.steps.slice(1) }), attestation.head).includes('does not match'),
  'attestation: a block that differs from the status digest fails')
const thin = { ...attestation, steps: attestation.steps.filter((s) => s.gate !== 'verdict') }
check(verdictOf(withAttestation('x', thin), statusText(thin), thin.head).includes('lacks verdict'), 'attestation: one without the verdict fails')
check(verdictOf(described, null, attestation.head).includes('no agents/attestation status'), 'attestation: a head with no status fails')
check(verdictOf('What changed.', statusText(attestation), attestation.head).includes('no attestation block'), 'attestation: a description with no block fails')
check(verdictOf('<!-- agents-attestation:v1 bm90IGpzb24 -->', statusText(attestation), attestation.head).includes('not JSON'), 'attestation: a block that is not JSON fails')

// The whole repo passes the design and prose lints, which is how npm run check enforces them.
const style = spawnSync(process.execPath, [`${ROOT}test/style.ts`], { encoding: 'utf8' })
check(style.status === 0, `the repo passes the design and prose lints (${(style.status === 0 ? style.stdout : style.stderr).trim().split('\n').at(-1) ?? ''})`)

console.log(`\n${failures.length ? `${failures.length} failed` : 'all passed'}`)
process.exit(failures.length ? 1 : 0)
