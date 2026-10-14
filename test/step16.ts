// The coding framework end to end, with the stand-in for Claude. A copy of this
// repo is the test repo, under a copy of the Agents policy, with a home daemon
// standing in for the box and a second daemon as the check host. The
// app-change pipeline takes one change from a request to a merge, a protected
// change through the gate only the owner can pass, and a run for each rule the
// gates must enforce is stopped by the gate that guards it.
//   node --env-file=.env --env-file=.env.test test/step16.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { forgeAdmin, forgeConfig } from '../server/forge.ts'
import { ADVISORY, ATTESTATION_STATUS, checkAttestation } from '../shared/attestation.ts'
import { must } from './must.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
// Checks of the coding framework use ports 8000 to 8019. A service outside
// Agents holds 8000 on the server Mac, so this one starts at 8002.
const PORT = 8002
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 10}`
const id = randomBytes(4).toString('hex')
const team = `self-${id}`
const [owner, mate] = [`self-owner-${id}@local`, `self-mate-${id}@local`]
const forgeUser = `self-owner-${id}`
const [APP, PIPES, BOXED] = [`self-app-${id}`, `self-pipes-${id}`, `self-box-${id}`]
const { org, url: forgeUrl, token: factoryToken, adminToken } = forgeConfig()
const MODELS = { builder: 'claude-opus-test', reviewer: 'claude-sonnet-test', verifier: 'claude-haiku-test' }
const DASH = String.fromCharCode(0x2014)
const SILENT_SEC = 45
// A script with one NUL byte in a comment, in base64 so no record or command line holds the NUL.
const HIDDEN = Buffer.from(`// ${String.fromCharCode(0)} hidden\nimport { exec } from 'node:child_process'\nexec('ls')\n`).toString('base64')
// STEP16_ONLY=ACCEPT,STOPS runs only the named sections, for watching one
// guard fail with its code broken. Without it every section runs.
const ONLY = process.env.STEP16_ONLY?.split(',').filter(Boolean) ?? []
const runs = (section: string) => !ONLY.length || ONLY.includes(section)

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []
const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step16-')))

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

async function within(seconds: number, test: () => Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(500)
  }
  return false
}

const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', '--env-file=.env.test', ...args], { cwd: ROOT, encoding: 'utf8' })
const all = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows
const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]

async function as(who: string, path: string, body: unknown = {}) {
  return fetch(PEOPLE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': who }, body: JSON.stringify(body) })
}

async function forgeCall(method: string, path: string, body?: unknown, token = adminToken) {
  const res = await fetch(`${forgeUrl}/api/v1${path}`, {
    method, headers: { authorization: `token ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, text, json: text ? JSON.parse(text) : null }
}

const mainSha = async () => (await forgeCall('GET', `/repos/${org}/${APP}/branches/main`)).json.commit.id
const stagesOf = (runId: string) => all('select * from run_stages where run_id = $1 order by n', [runId])
const runOf = (runId: string) => one('select * from runs where id = $1', [runId])
const openAsk = (runId: string, stage: string) => one(`select * from asks where run_id = $1 and status = 'open' and payload->>'stage' = $2`, [runId, stage])
const latestGate = async (runId: string, gate: string) => (await all('select * from evidence where run_id = $1 and gate = $2 order by created_at desc limit 1', [runId, gate]))[0]

async function answer(runId: string, stage: string, who: string, decision: string, message?: string) {
  const ask = await openAsk(runId, stage)
  if (!ask) throw new Error(`run ${runId} has no open ask at ${stage}`)
  return as(who, `/v1/asks/${ask.id}/answer`, { decision, message })
}

async function waitAsk(runId: string, stage: string, seconds = 240) {
  const found = await within(seconds, async () => openAsk(runId, stage))
  if (!found) throw new Error(`run ${runId} never asked at ${stage}: ${(await stagesOf(runId)).map((s: any) => `${s.stage}:${s.status}:${s.outcome ?? ''}`).join(' ')}`)
}

async function waitRow(runId: string, stage: string, test: (row: any) => boolean, seconds = 240) {
  let found: any
  const ok = await within(seconds, async () => {
    found = (await stagesOf(runId)).reverse().find((r: any) => r.stage === stage && test(r))
    return found
  })
  if (!ok) throw new Error(`run ${runId} never reached ${stage}: ${(await stagesOf(runId)).map((s: any) => `${s.stage}:${s.status}:${s.outcome ?? ''}`).join(' ')}`)
  return found
}

// A part a scenario adds: a module, its check that fails on main and passes
// with the module, and the docs every new source file needs.
function part(n: number, name: string) {
  const title = name.charAt(0).toUpperCase() + name.slice(1)
  return {
    check: `test/step${n}.ts`,
    files: {
      [`APP/shared/${name}.ts`]: `// Says the ${name} part is ready, for the framework's check.\nexport function ${name}(): string {\n  return 'ready'\n}\n`,
      [`APP/test/step${n}.ts`]: `// runs-in: box\n// The ${name} part answers that it is ready.\n//   node test/step${n}.ts\n\nimport { ${name} } from '../shared/${name}.ts'\n\nconst ok = ${name}() === 'ready'\nconsole.log(\`\${ok ? 'pass' : 'FAIL'}  ${name} is ready\`)\nprocess.exit(ok ? 0 : 1)\n`,
    },
    docs: (log = `Added the ${name} part, with step ${n}.`, extra = '') => ({
      'APP/docs/what-each-part-does.md': ['# What each part does\n', `# What each part does\n\n### ${title} (\`shared/${name}.ts\`, \`test/step${n}.ts\`${extra})\n\n- **Solves now.** Answers that the ${name} part is ready.\n`],
      'APP/docs/build-log.md': ['# Build log\n', `# Build log\n\n${log}\n`],
    }),
  }
}

const plan = (check: string) => `# Plan\n\n## Concern\n\nOne small part.\n\n## Done means\n\n- The part answers that it is ready (check: ${check})\n\n## Keep\n\n- \`framework\`: every change still goes through the gates\n\n## Files\n\n- The part, its check, and the docs\n\n## Size\n\nAbout 30 lines.\n`
const UNDERSTANDING = '# Understanding\n\n## What the code does now\n\nNothing like this part exists.\n\n## What this change touches\n\nOne new module and its check.\n\n## What could break\n\nNothing else imports it.\n'

const KEYS = {
  route: 'change,bug,docs,dependency',
  understand: 'understood,ask',
  plan: 'planned,ask',
  implement: 'done,ask',
  review: 'clean,blocking',
  confirm: 'live-ui-verified,unit-test-verified,type-check-only,verifier-blocked,verifier-failed',
}

// One scenario's steps for every stage, with the implement steps it changes the repo with.
function scenario(check: string, implement: object[], extra: Record<string, object[]> = {}) {
  return {
    [KEYS.route]: [{ outcome: 'change', summary: 'It changes how something works.' }],
    [KEYS.understand]: [{ outcome: 'understood', write: { 'task/understanding.md': UNDERSTANDING } }],
    [KEYS.plan]: [{ outcome: 'planned', write: { 'task/plan.md': plan(check) } }],
    [KEYS.implement]: implement,
    [KEYS.review]: [{ outcome: 'clean', data: { findings: [] } }],
    [KEYS.confirm]: [{ outcome: 'unit-test-verified', run: [`node APP/${check}`], data: { findings: [] } }],
    ...extra,
  }
}

const tidy = part(91, 'tidy')
const guard = part(92, 'guard')
const SCENARIOS: Record<string, object> = {
  HAPPY: scenario(tidy.check, [
    { outcome: 'done', summary: 'Adds the tidy part.', write: tidy.files, replace: tidy.docs(),
      decide: [{ what: 'Put the tidy part in shared/', why: 'The server and the app both need it.', alternatives: ['server/ only'] }] },
    { outcome: 'done', summary: 'Names the answer.', write: { 'APP/shared/tidy.ts': '// The answer the tidy part gives when it is ready.\nconst READY = \'ready\'\n\n// Says the tidy part is ready, for the framework\'s check.\nexport function tidy(): string {\n  return READY\n}\n' } },
  ], {
    [KEYS.review]: [
      { outcome: 'blocking', data: { findings: [{ rule: 'No magic values', path: 'shared/tidy.ts', line: 3, body: 'Name the answer once.', blocking: true, topic: null }] } },
      { outcome: 'clean', data: { findings: [] } },
    ],
  }),
  PROTECTED: scenario(guard.check, [{ outcome: 'done', summary: 'Adds the guard part and words the lint config.', write: guard.files,
    replace: { ...guard.docs(), 'APP/eslint.config.js': ['// Lint rules for the whole repo.', '// Lint rules for the whole repo, judged by the gates.'] } }]),
  // Product code with a check that never uses it, so the check passes on main.
  SEEN: scenario('test/step93.ts', [{ outcome: 'done', summary: 'Adds the sums part, and a check that does not use it.',
    write: {
      'APP/shared/sums.ts': '// Adds two numbers, for the framework\'s check.\nexport function sum(a: number, b: number): number {\n  return a + b\n}\n',
      'APP/test/step93.ts': '// runs-in: box\n// Two and two make four.\n//   node test/step93.ts\n\nconst ok = [2, 2].reduce((a, b) => a + b, 0) === 4\nconsole.log(`${ok ? \'pass\' : \'FAIL\'}  two and two make four`)\nprocess.exit(ok ? 0 : 1)\n',
    },
    replace: { 'APP/docs/what-each-part-does.md': ['# What each part does\n', '# What each part does\n\n### Sums (`shared/sums.ts`, `test/step93.ts`)\n\n- **Solves now.** Adds two numbers.\n'], 'APP/docs/build-log.md': ['# Build log\n', '# Build log\n\nAdded the sums part, with step 93.\n'] } }]),
}
// The view change edits App.tsx's first line, whatever main's imports are.
const APP_FIRST_LINE = readFileSync(join(ROOT, 'app/src/App.tsx'), 'utf8').split('\n')[0] ?? ''
// A rule each of these runs breaks, on top of a change that is right otherwise.
const STOPS: { name: string; n: number; gate: string; finding: string; extra: (p: ReturnType<typeof part>) => object }[] = [
  { name: 'ledger', n: 94, gate: 'migrations', finding: 'already on main',
    extra: (p) => ({ write: p.files, replace: { ...p.docs(), 'APP/server/migrations/0001_data_model.sql': ['-- The agreed data model.', '-- The agreed data model, as first built.'] } }) },
  { name: 'shade', n: 95, gate: 'css', finding: 'the accent --live in border',
    extra: (p) => ({ write: p.files, replace: { ...p.docs(), 'APP/app/src/styles.css': ['.muted { color: var(--muted); }', '.muted { color: var(--muted); }\n.flagged { border: 1px solid var(--live); }'] } }) },
  { name: 'dash', n: 96, gate: 'prose', finding: 'an em dash',
    extra: (p) => ({ write: p.files, replace: p.docs(`Added the dash part ${DASH} with step 96.`) }) },
  { name: 'extra', n: 97, gate: 'migrations', finding: 'without changing docs/data-model.md',
    extra: (p) => ({ write: { ...p.files, 'APP/server/migrations/0099_extra.sql': 'create table extra (id int);\n' }, replace: p.docs() }) },
  { name: 'notes', n: 98, gate: 'size', finding: 'over the limit of 400',
    extra: (p) => ({ write: { ...p.files, 'APP/docs/notes.md': Array.from({ length: 450 }, (_, i) => `Note ${i}.`).join('\n') }, replace: p.docs() }) },
  { name: 'quiet', n: 99, gate: 'suppressions', finding: 'eslint-disable',
    extra: (p) => ({ write: { ...p.files, 'APP/server/quiet.ts': '// eslint-disable-next-line no-console\nexport const quiet = 1\n' }, replace: p.docs(undefined, ', `server/quiet.ts`') }) },
  { name: 'view', n: 89, gate: 'ui', finding: 'no Playwright check',
    extra: (p) => ({ write: p.files, replace: { ...p.docs(), 'APP/app/src/App.tsx': [APP_FIRST_LINE, `// The app's shell: sidebar, conversation and panel.\n${APP_FIRST_LINE}`] } }) },
  // A check that fails on the change and prints a token. Its output reaches the evidence scrubbed.
  { name: 'leak', n: 82, gate: 'seen_failing:test/step82.ts', finding: '[secret:anthropic]',
    extra: (p) => ({ write: { ...p.files, 'APP/test/step82.ts': "// runs-in: box\n// The leak part answers, then prints a line shaped like a token, which no evidence may keep.\n//   node test/step82.ts\n\nimport { leak } from '../shared/leak.ts'\n\nconsole.log('token sk-' + 'ant-' + 'b'.repeat(30) + ' ' + leak())\nprocess.exit(1)\n" }, replace: p.docs() }) },
  // One NUL byte in a comment makes git call the script binary, which hid it
  // from every other gate. A command writes it, since the record cannot store
  // a NUL in an agent's tool call.
  { name: 'hidden', n: 84, gate: 'opaque', finding: 'binary',
    extra: (p) => ({ write: p.files, replace: p.docs(undefined, ', `server/hidden.ts`'), run: [`node -e "process.stdout.write(Buffer.from(process.argv[1], 'base64'))" ${HIDDEN} > APP/server/hidden.ts`] }) },
]
const titleOf = (name: string) => `STOP${name.toUpperCase()} a change that breaks one rule`
for (const s of STOPS) {
  const p = part(s.n, s.name)
  SCENARIOS[`STOP${s.name.toUpperCase()}`] = scenario(p.check, [{ outcome: 'done', summary: `Adds the ${s.name} part.`, ...s.extra(p) }])
}
const sneak = part(90, 'sneak')
SCENARIOS.PUSHMAIN = scenario(sneak.check, [{
  outcome: 'done', summary: 'Adds the sneak part, and pushes it to main itself.', write: sneak.files, replace: sneak.docs(),
  run: ['cd APP && git add -A && git -c user.name=sneak -c user.email=sneak@local commit -qm sneak && git -c "http.extraHeader=Authorization: Bearer $AGENTS_TOKEN" push origin HEAD:main'],
}])
const twin = part(88, 'twin')
SCENARIOS.SAMEMODEL = scenario(twin.check, [{ outcome: 'done', summary: 'Adds the twin part.', write: twin.files, replace: twin.docs() }])
// A change that turns off a lint rule in its own config and breaks that rule.
// The box must judge it with main's config, where the rule is on.
const loose = part(87, 'loose')
SCENARIOS.WEAKEN = scenario(loose.check, [{
  outcome: 'done', summary: 'Adds the loose part and switches off eqeqeq.',
  write: { ...loose.files, 'APP/server/lenient.ts': '// Whether a value is missing, with a loose comparison.\nexport const missing = (value: unknown) => value == null\n' },
  replace: { ...loose.docs(undefined, ', `server/lenient.ts`'), 'APP/eslint.config.js': ["      eqeqeq: 'error',", "      eqeqeq: 'off',"] },
}])

// A finding about data goes to the owner, who overrules it. When a later
// round raises it again, it stays overruled: the owner's decision holds.
const settled = part(86, 'settled')
const dataFinding = { rule: 'No magic values', path: 'shared/settled.ts', line: 3, body: 'The answer is a bare string.', blocking: true, topic: 'data' }
SCENARIOS.DECIDED = scenario(settled.check, [
  { outcome: 'done', summary: 'Adds the settled part.', write: settled.files, replace: settled.docs() },
  { outcome: 'done', summary: 'The verifier asked for nothing the plan needs. Kept as it is.' },
], {
  [KEYS.review]: [{ outcome: 'blocking', data: { findings: [dataFinding] } }, { outcome: 'blocking', data: { findings: [dataFinding] } }],
  [KEYS.confirm]: [
    { outcome: 'verifier-failed', run: [`node APP/${settled.check}`], data: { findings: [{ rule: 'Done means', path: settled.check, line: null, body: 'Check it once more.', blocking: true, topic: null }] } },
    { outcome: 'unit-test-verified', run: [`node APP/${settled.check}`], data: { findings: [] } },
  ],
})
// A person adds a commit to the task branch while the run waits on the owner.
// The next push would replace it, so main's lease in the daemon stops it.
const leased = part(85, 'leased')
SCENARIOS.LEASE = scenario(leased.check, [{ outcome: 'done', summary: 'Adds the leased part.', write: leased.files, replace: leased.docs() }], {
  [KEYS.review]: [{ outcome: 'blocking', data: { findings: [{ rule: 'No magic values', path: 'shared/leased.ts', line: 3, body: 'Who may read this?', blocking: true, topic: 'security' }] } }],
})

// A change to the UI. Its verifier cannot prove live UI verification until
// screenshots reach the record, so the verdict is blocked. The owner accepts
// it by name, and the change merges with that acceptance as its proof.
SCENARIOS.ACCEPT = scenario('test/step83.ts', [{ outcome: 'done', summary: 'Adds the shown part to the app.',
  write: { 'APP/app/src/shown.ts': "// Says the shown part is ready, for the framework's check.\nexport function shown(): string {\n  return 'ready'\n}\n", 'APP/test/step83.ts': "// The shown part answers that it is ready, in the engines and widths a UI check covers.\n//   node test/step83.ts\n\nimport { chromium, firefox, webkit } from 'playwright'\nimport { shown } from '../app/src/shown.ts'\n\nconst engines = [chromium, firefox, webkit].map((engine) => engine.name())\nconst widths = ['desktop', 'phone']\nconst ok = shown() === 'ready' && engines.length === 3 && widths.length === 2\nconsole.log((ok ? 'pass' : 'FAIL') + '  the shown part is ready')\nprocess.exit(ok ? 0 : 1)\n" },
  replace: {
    'APP/docs/what-each-part-does.md': ['# What each part does\n', '# What each part does\n\n### Shown (`app/src/shown.ts`, `test/step83.ts`)\n\n- **Solves now.** Answers that the shown part is ready.\n'],
    'APP/docs/build-log.md': ['# Build log\n', '# Build log\n\nAdded the shown part, with step 83.\n'],
  },
}], { [KEYS.confirm]: [{ outcome: 'live-ui-verified', run: ['node APP/test/step83.ts'], data: { findings: [] } }] })

// Every text a scenario's step replaces, in the repo's file as it stands. The
// stand-in's replace does nothing when its text is missing, so a scenario
// whose anchor main changed would run without the edit it is about.
const replacesOf = (step: unknown): [string, string][] => {
  if (typeof step !== 'object' || step === null || !('replace' in step) || typeof step.replace !== 'object' || step.replace === null) return []
  return Object.entries(step.replace).flatMap(([path, pair]): [string, string][] => (Array.isArray(pair) && typeof pair[0] === 'string' ? [[path, pair[0]]] : []))
}
for (const [name, stages] of Object.entries(SCENARIOS)) {
  for (const steps of Object.values(stages)) {
    for (const step of Array.isArray(steps) ? steps : []) {
      for (const [path, from] of replacesOf(step)) {
        if (!path.startsWith('APP/')) continue
        const text = readFileSync(join(ROOT, path.slice('APP/'.length)), 'utf8')
        const count = text.split(from).length - 1
        if (count !== 1) throw new Error(`${name} replaces text found ${count} times in ${path.slice('APP/'.length)}: ${JSON.stringify(from.slice(0, 80))}`)
      }
    }
  }
}

// The repo's files as they stand, to copy into the test repo.
function repoFiles(): Record<string, string> {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
  return Object.fromEntries(listed.filter((f) => f && existsSync(join(ROOT, f)) && statSync(join(ROOT, f)).isFile()).map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]))
}

function startApi() {
  const api = spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env, AGENTS_HOME: join(home, 'api'), AGENTS_BOX_TOKEN_FILE: join(home, 'no-box-token'), AGENTS_RUNNER_TEAMS: team,
      // Three missed reports from a daemon that reports every 15 seconds.
      AGENTS_SILENT_MACHINE_SEC: String(SILENT_SEC),
      AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'), AGENTS_STREAMS_PORT: String(PORT + 1), AGENTS_STREAMS_DIR: join(home, 'streams'),
    },
  })
  children.push(api)
  return within(30, () => fetch(`${API}/v1/health`).then((r) => r.ok, () => false))
}

function startDaemon(name: string, token: string) {
  mkdirSync(join(home, name), { recursive: true })
  const daemon = spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: join(home, name), AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json') },
  })
  children.push(daemon)
  return daemon
}

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, owner)
  node('server/admin.ts', 'add-person', team, mate)
  const mac = JSON.parse(node('server/admin.ts', 'add-instance', team, `box-${id}`, 'mac', owner))
  const host = JSON.parse(node('server/admin.ts', 'add-instance', team, `check-${id}`, 'check', owner))
  for (const [name, model] of Object.entries(MODELS)) node('server/admin.ts', 'add-agent', team, name, `box-${id}`, model)
  node('server/admin.ts', 'add-lesson', team, 'NEVER treat a passing check as evidence before you have watched it fail.', 'A kill-switch test passed with its own fix reverted.')
  const { id: teamId } = must(await one('select id from teams where name = $1', [team]), 'the team')

  // The forge: the owner's user, a copy of this repo, and a pipelines repo with app-change on a home machine.
  check((await forgeCall('POST', '/admin/users', { username: forgeUser, email: `${forgeUser}@forge.local`, password: randomBytes(18).toString('base64url'), must_change_password: false })).status === 201,
    'the owner has a user on the forge')
  node('server/admin.ts', 'forge-login', owner, forgeUser)
  await forgeAdmin.ensureRepo(APP, repoFiles(), 'a copy of Agents for step 16', false)
  const appChange = readFileSync(join(ROOT, 'pipelines/app-change.ts'), 'utf8')
  check(appChange.includes("runsOn: 'box'"), 'the real app-change pipeline runs only in a box')
  await forgeAdmin.ensureRepo(PIPES, {
    'shared/pipeline.ts': readFileSync(join(ROOT, 'shared/pipeline.ts'), 'utf8'),
    'pipelines/app-change.ts': appChange.replace("runsOn: 'box'", "runsOn: 'home'"),
  }, 'step 16 pipelines', false)
  await forgeAdmin.ensureRepo(BOXED, { 'README.md': '# boxed\n' }, 'a repo whose policy keeps work in boxes', false)
  const remote = (name: string) => `${forgeUrl}/${org}/${name}.git`
  await db.query('insert into repos (team_id, remote_url, setup_command) values ($1, $2, $3)', [teamId, remote(APP), `ln -s ${ROOT}node_modules node_modules`])
  for (const name of [PIPES, BOXED]) await db.query('insert into repos (team_id, remote_url) values ($1, $2)', [teamId, remote(name)])

  // The Agents policy, run on a Mac standing in for the box, with a suite fast enough for a check.
  const policy = JSON.parse(readFileSync(join(ROOT, 'ops/policies/agents.json'), 'utf8'))
  check(policy.sandbox === 'box', 'the real Agents policy keeps coding work in boxes')
  const testPolicy = {
    ...policy, sandbox: 'any', caps: { ...policy.caps, runsPerHour: 100, concurrent: 20 },
    suite: { ...policy.suite, commands: [{ name: 'names', argv: ['node', 'test/names.ts'], timeoutSec: 120 }] },
  }
  writeFileSync(join(home, 'agents-test.json'), JSON.stringify(testPolicy))
  writeFileSync(join(home, 'agents-boxed.json'), JSON.stringify(policy))
  node('server/admin.ts', 'set-policy', team, remote(APP), join(home, 'agents-test.json'), owner)
  node('server/admin.ts', 'set-policy', team, remote(BOXED), join(home, 'agents-boxed.json'), owner)
  const protection = (await forgeCall('GET', `/repos/${org}/${APP}/branch_protections/main`)).json
  check(protection.enable_push === false && protection.required_approvals === 1 && protection.approvals_whitelist_username.includes(forgeUser)
    && protection.status_check_contexts.length === 4 && protection.protected_file_patterns.includes('eslint.config.js'),
  'set-policy protected main on the forge: no pushes, the owner\'s approval, four gate statuses and the protected files')

  writeFileSync(join(home, 'scenario.json'), JSON.stringify(SCENARIOS).replaceAll('APP/', `${APP}/`).replaceAll('APP &&', `${APP} &&`).replaceAll('node APP', `node ${APP}`))
  // Nothing else may run against a port that some other process answers.
  if (!(await startApi())) throw new Error(`the API did not start on ${API}`)
  await servePeople(PORT + 10, join(home, 'people.sock'))
  check(true, 'the API answers its health check')
  startDaemon('mac', mac.token)
  const checkDaemon = startDaemon('check', host.token)

  const pipeline = await within(60, () => one(`select id, current_version_id from pipelines where team_id = $1 and name = 'app-change' and current_version_id is not null`, [teamId]))
  const appChangeRow = must(await one(`select p.id, v.source from pipelines p join pipeline_versions v on v.id = p.current_version_id where p.team_id = $1 and p.name = 'app-change'`, [teamId]), 'app-change')
  check(pipeline && appChangeRow.source.includes("runsOn: 'home'"),
    'app-change comes from the pipelines repo, never from the app repo, which has a policy')
  const { id: appRepo } = must(await one('select id from repos where team_id = $1 and remote_url = $2', [teamId, remote(APP)]), 'the app repo')
  const start = async (title: string, repoId = appRepo) => {
    const res = await as(mate, `/v1/pipelines/${appChangeRow.id}/runs`, { title, body: 'Asked for in step 16.', repoId })
    if (!res.ok) throw new Error(`starting ${title}: ${res.status} ${await res.text()}`)
    return (await res.json()).runId
  }

  if (runs('HAPPY')) {
    // One change, from the request to the merge.
    const happy = await start('HAPPY add the tidy part')
    await waitAsk(happy, 'approve_plan')
    check((await answer(happy, 'approve_plan', mate, 'approve', ['Approved. Not this one: sk', 'ant', 'c'.repeat(30)].join('-'))).ok, 'a teammate approves the plan before any code exists')
    await waitAsk(happy, 'approve_suite', 400)
    const happyStages = await stagesOf(happy)
    const sequence = happyStages.map((s: any) => `${s.stage}:${s.outcome}`).join(' ')
    check(sequence.startsWith('route:change understand:understood plan:planned approve_plan:approved implement:done verify:passes review:fix implement:done verify:passes review:clean confirm:verified open_pr:done protected:approved'),
      `the change ran the playbook in order, back to the author once for the review: ${sequence}`)
    const routed = await runOf(happy)
    check(routed.playbook === 'change', 'the router\'s pick is the run\'s playbook')
    const verifies = happyStages.filter((s: any) => s.stage === 'verify')
    const head = must(verifies.at(-1)?.data.head, 'the verified head')
    const gates = await all(`select distinct on (gate) gate, status, summary from evidence where run_id = $1 and commit = $2 order by gate, created_at desc`, [happy, head])
    const gate = (name: string) => gates.find((g: any) => g.gate === name)
    check(['protected', 'migrations', 'docs', 'secrets', 'dependencies', 'suppressions', 'size', 'css', 'prose', 'languages', 'assertions', 'shell', 'warnings', 'plan', 'pushes', 'ui', 'check_edits', 'opaque']
      .every((g) => gate(g)?.status === 'pass'), `every static gate passed on the head: ${gates.filter((g: any) => g.status !== 'pass').map((g: any) => g.gate).join(', ') || 'none failed'}`)
    check(['box:typecheck', 'box:typecheck-app', 'box:lint', 'box:style', 'box:names', 'box:enforcement'].every((g) => gate(g)?.status === 'pass'),
      `the box ran typecheck, lint, style, the name guard and the enforcement check on the head: ${gates.filter((g: any) => g.gate.startsWith('box:')).map((g: any) => `${g.gate}=${g.status}`).join(' ')}`)
    check(gate(`seen_failing:${tidy.check}`)?.status === 'pass' && gate(`seen_failing:${tidy.check}`)?.summary.includes('failed on main'),
      `the box watched the new check fail on main's code and pass on the change: ${gate(`seen_failing:${tidy.check}`)?.summary}`)
    const findings = await all('select * from findings where run_id = $1 order by round', [happy])
    check(findings.length === 1 && findings[0].rule === 'No magic values' && findings[0].round === 1 && findings[0].status === 'fixed' && findings[0].model === MODELS.reviewer,
      'the reviewer\'s blocking finding cites a rule from the rubric, and is fixed once a later round no longer reports it')
    const verdict = await one('select * from verdicts where run_id = $1 order by created_at desc limit 1', [happy])
    check(verdict?.verdict === 'unit-test-verified' && verdict.head === head && verdict.patch_id.length >= 40 && JSON.stringify(verdict.ran).includes(tidy.check)
      && verdict.model === MODELS.verifier,
    `a verifier on another model gave a verdict at the head, with the commands the record shows it ran: ${verdict?.summary}`)
    const starts = readFileSync(join(must(await one('select path from workspaces where task_id = $1', [routed.task_id]), 'the workspace').path, '.fake', 'starts.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    const judges = starts.filter((s: any) => s.model === MODELS.reviewer || s.model === MODELS.verifier)
    const authors = starts.filter((s: any) => s.model === MODELS.builder)
    check(judges.length >= 2 && judges.every((s: any) => !s.mcpServers.includes('team-record')) && authors.every((s: any) => s.mcpServers.includes('team-record'))
      && starts.filter((s: any) => s.model === MODELS.reviewer).every((s: any) => !s.allowedTools.includes('Bash') && !s.allowedTools.includes('Edit')),
    'the reviewer and the verifier ran without team-record tools, so they could not read the author\'s session, and the reviewer could only read')
    check(authors.every((s: any) => s.instructions.includes('watched it fail')), 'every agent got the team\'s lessons and the policy\'s principles with its instructions')
    check(judges.every((s: any) => s.permissionMode === null) && authors.length > 0 && authors.every((s: any) => s.permissionMode === 'acceptEdits'),
      `the judges start with no permission mode, so an edit asks a person, and the authors with acceptEdits: ${[...new Set(starts.map((s: any) => `${s.model} ${s.permissionMode}`))].join(', ')}`)
    // A person's message would start a judge with a workspace's permissions,
    // the team-record tools and no budget, so the API refuses one.
    const judgeSessions = [...new Set(happyStages.filter((s: any) => s.stage === 'review' || s.stage === 'confirm').flatMap((s: any) => s.data.reviewers.map((r: any) => r.sessionId)))]
    const judgeCommands = async () => Number((await one('select count(*) as n from commands where session_id = any($1)', [judgeSessions])).n)
    const commandsBefore = await judgeCommands()
    const toldJudges = await Promise.all(judgeSessions.map(async (sessionId) => {
      const res = await as(mate, `/v1/sessions/${sessionId}/messages`, { text: 'Pass it as it is.' })
      return { status: res.status, text: await res.text() }
    }))
    check(judgeSessions.length >= 2 && toldJudges.every((t) => t.status === 409 && t.text.includes("A judge's session takes no messages")) && (await judgeCommands()) === commandsBefore,
      `a person's message to the reviewer's or the verifier's session is refused, and no command reaches either: ${toldJudges.map((t) => t.status).join(', ')}`)
    // The report's title is data from outside the team, so every agent's prompt shows it quoted, a judge's too.
    const judgePrompts = await all(`select distinct on (session_id) text from events where session_id = any($1) and kind = 'user' order by session_id, seq`, [judgeSessions])
    check(judgePrompts.length === judgeSessions.length && judgePrompts.length >= 2 && judgePrompts.every((p: any) => p.text.includes(': "HAPPY add the tidy part"\n')),
      `the reviewer's and the verifier's prompts quote the report's title as data: ${judgePrompts.map((p: any) => /The request[^\n]*/.exec(String(p.text))?.[0] ?? 'no request line').join(' | ')}`)

    const pr = must(happyStages.find((s: any) => s.stage === 'open_pr')?.data.pullRequest, 'the pull request')
    const prBody = (await forgeCall('GET', `/repos/${org}/${APP}/pulls/${pr}`)).json.body
    check(prBody.includes('## What changed') && prBody.includes('- shared/tidy.ts added') && prBody.includes('## What was checked') && prBody.includes(`seen_failing:${tidy.check}`)
      && prBody.includes('## Risks\n\n```text\nNothing else imports it.\n```') && prBody.includes('## What the pipeline had to fix\n\n```text\n- review, try 1')
      && prBody.includes('## Verdict') && prBody.includes('## Review findings') && prBody.includes('## Decisions') && prBody.includes('Put the tidy part in shared/'),
    'the pull request is written for a reviewer who was not there: what changed, what was checked, the risks, what the pipeline sent back, the verdict, the findings and the decisions')
    // A section of the body, without the attestation block written after it.
    const sectionOfBody = (title: string) => ((String(prBody).split(`## ${title}\n\n`)[1] ?? '').split('\n## ')[0] ?? '').replace(/\n*<!-- agents-attestation:v1 [A-Za-z0-9_-]+ -->\s*$/, '').trimEnd()
    const fencedSection = (title: string, holds: string) => /^[^\n]*\n\n(`{3,})text\n[\s\S]*\n\1$/.test(sectionOfBody(title)) && sectionOfBody(title).includes(holds)
    check(fencedSection('Review findings', '- Round 1') && fencedSection('Decisions', 'Put the tidy part in shared/'),
      'the review findings and the decisions sit in fences, since agents wrote them')
    check(fencedSection('What changed', '- shared/tidy.ts added'), 'the changed paths sit in a fence, since an agent chose them')
    check(/\| review:[^|]+ \| pass \(advisory\) \|/.test(prBody) && prBody.includes('| verdict | pass (advisory) |') && prBody.includes('advisory until the judges run on their own machine'),
      'the pull request marks the review and the verdict advisory')
    const builds = await all('select gate, build from evidence where run_id = $1 and commit = $2', [happy, head])
    const hex = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
    check(builds.length > 0 && builds.every((b: any) => hex(b.build.runner.files))
      && builds.filter((b: any) => b.gate.startsWith('box:') || b.gate.startsWith('seen_failing:')).every((b: any) => hex(b.build.worker?.files))
      && hex(builds.find((b: any) => b.gate === 'protected')?.build.inputs['app/src/styles.css']),
    'every piece of evidence names the runner\'s build, the box\'s gates name the box\'s build, and the static gates name the hash of main\'s tokens')
    check(hex(verdict?.build.inputs['.claude/skills/coding-standards/SKILL.md']) && hex(verdict?.build.inputs['.claude/skills/verify/SKILL.md']),
      'the verdict names the runner\'s build and the hashes of main\'s rubric and verification skill it was judged by')
    const decisions = await all('select who, what from decisions where run_id = $1', [happy])
    check(decisions.some((d: any) => d.who === 'agent' && d.what === 'Picked the change playbook') && decisions.some((d: any) => d.who === 'agent' && d.what === 'Put the tidy part in shared/')
      && decisions.some((d: any) => d.who === 'person' && d.what.includes('approve_plan')),
    'the decision log holds the router\'s pick, the agent\'s logged decision and each person\'s answer')
    const planDecision = await one(`select why from decisions where run_id = $1 and who = 'person' and stage = 'approve_plan'`, [happy])
    check(planDecision?.why.includes('[secret:anthropic]') && !planDecision.why.includes('sk-ant-'), 'a token in a person\'s answer is scrubbed from the decision log')
    check(prBody.includes('## The author\'s summary\n\nThe agent that wrote the change wrote this. The runner wrote the rest, and fences what agents and people wrote: the risks, what was sent back, the verdict, the review findings and the decisions.\n\n```text\n'),
      'the agent\'s own text sits in a fence of its own, so it cannot pass for the runner\'s sections')

    const suiteByMate = await answer(happy, 'approve_suite', mate, 'approve')
    check(suiteByMate.status === 403, 'a teammate cannot approve running the suite, since the check host is not isolated yet')
    check((await answer(happy, 'approve_suite', owner, 'approve')).ok, 'the owner approves running the full suite')
    await waitAsk(happy, 'approve_merge', 240)
    const suiteRow = (await stagesOf(happy)).find((s: any) => s.stage === 'suite')
    check(suiteRow?.outcome === 'passes' && (await latestGate(happy, `suite_seen_failing:${tidy.check}`))?.status === 'pass' && (await latestGate(happy, 'suite:names'))?.status === 'pass',
      'the check host ran the suite on the change merged into main, and watched the new check fail on main and pass on the merge')
    const statuses = (await forgeCall('GET', `/repos/${org}/${APP}/commits/${head}/statuses`)).json
    check(['agents/gates', 'agents/review', 'agents/verdict', 'agents/suite'].every((c) => statuses.some((s: any) => s.context === c && s.status === 'success')),
      'the forge has a passing status from the runner for each kind of gate')
    const attestedBody = (await forgeCall('GET', `/repos/${org}/${APP}/pulls/${pr}`)).json.body
    const attestation = checkAttestation(attestedBody, statuses.find((s: any) => s.context === ATTESTATION_STATUS)?.description ?? null, head)
    check(attestation.ok && attestation.attestation.steps.filter((s) => ADVISORY(s.gate)).length >= 2
      && attestation.attestation.steps.filter((s) => ADVISORY(s.gate)).every((s) => s.result === 'advisory'),
    'the attestation marks the review and the verdict advisory')
    check(attestation.ok && attestation.attestation.steps.some((s) => s.gate === 'suite:names') && attestation.attestation.build.checkHost !== null
      && attestation.attestation.build.box !== null && attestation.attestation.pullRequest === pr,
    `once the suite passed, the description carries the attestation and the head commit its digest, which a CI job can check: ${attestation.ok ? 'ok' : attestation.reason}`)
    const early = await forgeCall('POST', `/repos/${org}/${APP}/pulls/${pr}/merge`, { Do: 'merge', head_commit_id: head }, factoryToken)
    check(early.status === 405 && early.text.includes('approvals'), `the forge refuses the merge until the owner approves: ${early.status} ${early.text.slice(0, 80)}`)
    const byMate = await answer(happy, 'approve_merge', mate, 'approve')
    check(byMate.status === 403 && (await byMate.text()).includes(owner), 'a teammate cannot approve the merge')
    check((await answer(happy, 'approve_merge', owner, 'approve')).ok, 'the owner approves the merge with the evidence')
    await waitAsk(happy, 'approve_deploy', 120)
    const merged = (await forgeCall('GET', `/repos/${org}/${APP}/pulls/${pr}`)).json
    const tidyOnMain = await forgeCall('GET', `/repos/${org}/${APP}/contents/shared/tidy.ts?ref=main`)
    const reviews = (await forgeCall('GET', `/repos/${org}/${APP}/pulls/${pr}/reviews`)).json
    check(merged.merged && tidyOnMain.status === 200 && reviews.some((r: any) => r.state === 'APPROVED' && r.user.login === forgeUser),
      'the change merged on the forge, with the owner\'s approval recorded as theirs')
    check((await one('select pull_request from verdicts where run_id = $1 order by created_at desc limit 1', [happy]))?.pull_request === pr, 'the verdict is kept by pull request and head commit')
    check((await answer(happy, 'approve_deploy', owner, 'reject')).ok, 'the owner decides the deploy separately, and holds it')
    check(await within(30, async () => (await runOf(happy))?.status === 'done') && (await runOf(happy))?.note === 'Merged. The owner chose not to deploy it now.',
      `the run ended merged and not deployed: ${(await runOf(happy))?.note}`)
  }

  if (runs('PROTECTED')) {
    // A change to a protected file stops at a gate only the owner can pass.
    const guarded = await start('PROTECTED add the guard part')
    await waitAsk(guarded, 'approve_plan')
    await answer(guarded, 'approve_plan', mate, 'approve')
    await waitAsk(guarded, 'protected', 400)
    const guardedPr = must((await stagesOf(guarded)).find((s: any) => s.stage === 'open_pr')?.data.pullRequest, 'the guarded pull request')
    const guardedBody = (await forgeCall('GET', `/repos/${org}/${APP}/pulls/${guardedPr}`)).json.body
    check(guardedBody.includes('## Needs the owner') && guardedBody.includes('### eslint.config.js') && guardedBody.includes('+// Lint rules for the whole repo, judged by the gates.'),
      'the pull request names the protected file and shows how it changed')
    const lintGate = (await all(`select status from evidence where run_id = $1 and gate like 'box:lint'`, [guarded]))
    check(lintGate.every((g: any) => g.status === 'pass'), 'the box judged the change with main\'s lint config, not the changed one')
    const notOwner = await answer(guarded, 'protected', mate, 'approve')
    check(notOwner.status === 403, 'a teammate cannot pass the protected gate')
    check((await answer(guarded, 'protected', owner, 'approve')).ok, 'the owner passes it')
    await waitAsk(guarded, 'approve_suite', 120)
    await answer(guarded, 'approve_suite', owner, 'approve')
    await waitAsk(guarded, 'approve_merge', 240)
    await answer(guarded, 'approve_merge', owner, 'approve')
    await waitAsk(guarded, 'approve_deploy', 120)
    const guardMerge = (await stagesOf(guarded)).find((s: any) => s.stage === 'merge')
    const lintOnMain = await forgeCall('GET', `/repos/${org}/${APP}/contents/eslint.config.js?ref=main`)
    check(guardMerge?.outcome === 'done' && guardMerge.summary.includes('past the protected file patterns')
      && Buffer.from(lintOnMain.json.content, 'base64').toString().includes('judged by the gates'),
    'the forge merged the protected change only as the owner, past its protected file patterns')
    await answer(guarded, 'approve_deploy', owner, 'reject')
  }

  if (runs('ACCEPT')) {
    // A blocked verdict the owner accepts by name is the proof the merge rests on.
    const accepted = await start('ACCEPT add the shown part to the app')
    await waitAsk(accepted, 'approve_plan')
    await answer(accepted, 'approve_plan', mate, 'approve')
    await waitAsk(accepted, 'confirm', 400)
    const blocked = await one('select verdict, accepted_by from verdicts where run_id = $1 order by created_at desc limit 1', [accepted])
    check(blocked?.verdict === 'verifier-blocked' && blocked.accepted_by === null,
      'a verifier claiming live UI verification with no screenshots in the record gives a blocked verdict, below the UI floor')
    check((await answer(accepted, 'confirm', mate, 'overrule')).status === 403, 'a teammate cannot accept a verdict below the floor')
    check((await answer(accepted, 'confirm', owner, 'overrule')).ok, 'the owner accepts the blocked verdict by name')
    await waitAsk(accepted, 'approve_suite', 300)
    check((await answer(accepted, 'approve_suite', mate, 'approve')).status === 403, 'a teammate cannot approve running the suite on the accepted change')
    await answer(accepted, 'approve_suite', owner, 'approve')
    await waitAsk(accepted, 'approve_merge', 300)
    await answer(accepted, 'approve_merge', owner, 'approve')
    await waitAsk(accepted, 'approve_deploy', 120)
    const acceptedMerge = (await stagesOf(accepted)).find((s: any) => s.stage === 'merge')
    const { id: ownerId } = must(await one('select id from people where login = $1', [owner]), 'the owner')
    check(acceptedMerge?.outcome === 'done' && acceptedMerge.data.proof?.verdict.kind === 'accepted' && acceptedMerge.data.proof.verdict.acceptedBy === ownerId
      && acceptedMerge.summary.includes('verifier-blocked'),
    `the UI change merged with the owner's acceptance of the blocked verdict as its proof: ${acceptedMerge?.summary ?? 'no merge'}`)
    await answer(accepted, 'approve_deploy', owner, 'reject')
  }

  if (runs('DECIDED')) {
    // A person's decision holds for the rest of the run, a push never replaces
    // commits someone added on the forge, and a silent machine leaves the run
    // waiting on a person instead of looking busy.
    const decided = await start('DECIDED add the settled part')
    const leasing = await start('LEASE add the leased part')
    for (const runId of [decided, leasing]) {
      await waitAsk(runId, 'approve_plan')
      await answer(runId, 'approve_plan', mate, 'approve')
    }
    await waitAsk(leasing, 'review', 400)
    const leaseTask = must(await one('select t.slug from tasks t join runs r on r.task_id = t.id where r.id = $1', [leasing]), 'the lease task')
    const leaseBranch = `task/${leaseTask.slug}`
    const handEdit = await forgeCall('POST', `/repos/${org}/${APP}/contents/docs/hand-note.md`,
      { branch: leaseBranch, message: 'A person adds a note', content: Buffer.from('A note added by hand.\n').toString('base64') })
    const handCommit = must(handEdit.json?.commit?.sha, `a commit on ${leaseBranch}: ${handEdit.status} ${handEdit.text.slice(0, 120)}`)
    check((await answer(leasing, 'review', owner, 'overrule')).ok, 'the owner overrules the security finding while a person has added to the branch')
    const leasePr = await waitRow(leasing, 'open_pr', (r) => r.status === 'done', 300)
    const leaseTip = (await forgeCall('GET', `/repos/${org}/${APP}/branches/${leaseBranch}`)).json?.commit?.id
    check(leasePr.outcome === 'failed' && leasePr.summary.includes(`In ${APP}, someone added commits on the forge, ask the agent to merge them.`) && leaseTip === handCommit,
      `a push over a commit someone added on the forge stops with main's refusal, and the commit stays: ${leasePr.summary.split('\n')[0]}`)
    check(await within(30, async () => (await runOf(leasing))?.status === 'waiting'), 'the run then waits on a person')

    await waitAsk(decided, 'review', 400)
    check((await answer(decided, 'review', owner, 'overrule')).ok, 'the owner overrules a finding about data')
    await waitAsk(decided, 'approve_suite', 500)
    const decidedReviews = (await stagesOf(decided)).filter((s: any) => s.stage === 'review')
    const decidedFindings = await all(`select round, status, decided_by from findings where run_id = $1 and stage = 'review' order by round`, [decided])
    check(decidedReviews.length === 2 && decidedReviews[1].outcome === 'clean' && decidedFindings.length === 2
      && decidedFindings.every((f: any) => f.status === 'overruled' && f.decided_by === decidedFindings[0].decided_by),
    `the finding the owner overruled stays overruled when the next round raises it, so it neither blocks nor asks again: ${decidedReviews.map((r: any) => r.outcome).join(', ')}`)
    const decidedWorkspace = must(await one('select w.path from workspaces w join runs r on r.task_id = w.task_id where r.id = $1', [decided]), 'the decided workspace')
    const decidedStarts = readFileSync(join(decidedWorkspace.path, '.fake', 'starts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    check(decidedStarts.some((s: any) => s.model === MODELS.builder && s.instructions.includes('overrule at review')),
      'the author sent back afterwards got the owner\'s decision with its instructions')
    checkDaemon.kill('SIGTERM')
    check(await within(30, async () => (await one('select status from instances where team_id = $1 and name = $2', [teamId, `check-${id}`]))?.status === 'offline'),
      'the check host reports itself offline as it stops')
    check((await answer(decided, 'approve_suite', owner, 'approve')).ok, 'the owner approves the suite while the check host is down')
    const lost = await waitRow(decided, 'suite', (r) => r.status === 'failed', SILENT_SEC + 90)
    check(lost.summary.includes('has not reported') && await within(30, async () => (await runOf(decided))?.status === 'waiting'),
      `the suite fails once its machine has been silent too long, and the run waits on a person: ${lost.summary.split('\n')[0]}`)
    for (const runId of [decided, leasing]) await as(mate, `/v1/runs/${runId}/cancel`)
  }

  if (runs('STOPS')) {
    // A run for each rule the gates must stop, at once.
    const seen = await start('SEEN a check that already passes')
    const stops = new Map<string, string>()
    for (const s of STOPS) stops.set(s.name, await start(titleOf(s.name)))
    const weaken = await start('WEAKEN switch off a lint rule and break it')
    for (const runId of [...stops.values(), weaken]) {
      await waitAsk(runId, 'approve_plan')
      await answer(runId, 'approve_plan', mate, 'approve')
    }

    // Pausing holds a run where it is, and resuming carries on.
    await waitAsk(seen, 'approve_plan')
    check((await as(mate, `/v1/runs/${seen}/pause`, { note: 'Holding for a look.' })).ok, 'a teammate pauses a run')
    await answer(seen, 'approve_plan', mate, 'approve')
    await sleep(4000)
    const paused = await runOf(seen)
    check(paused.status === 'paused' && !(await stagesOf(seen)).some((s: any) => s.stage === 'implement'), 'a paused run does nothing, even with its gate answered')
    check((await as(mate, `/v1/runs/${seen}/resume`)).ok, 'the teammate resumes it')
    await waitRow(seen, 'implement', () => true, 60)
    check(true, 'the resumed run carried on to implement')

    const seenVerify = await waitRow(seen, 'verify', (r) => r.status === 'done', 300)
    const seenGate = await latestGate(seen, 'seen_failing:test/step93.ts')
    check(seenVerify.outcome === 'fails' && seenGate?.status === 'fail' && seenGate.summary.includes('passed on main'),
      `a new check that already passes on main fails the gates: ${seenGate?.summary}`)
    await waitRow(seen, 'implement', (r) => r.attempt === 2, 60)
    check(true, 'that run went back to its author, not forward to a pull request')

    for (const s of STOPS) {
      const runId = must(stops.get(s.name), s.name)
      const verify = await waitRow(runId, 'verify', (r) => r.status === 'done', 300)
      const result = await latestGate(runId, s.gate)
      const findings = JSON.stringify(result?.detail.findings ?? [])
      check(verify.outcome === 'fails' && result?.status === 'fail' && findings.includes(s.finding),
        `${s.gate} stops a change that breaks it (${s.name}): ${findings.slice(0, 160)}`)
      check(!(await stagesOf(runId)).some((r: any) => r.stage === 'open_pr' || r.stage === 'review'), `no reviewer or pull request saw the ${s.name} change`)
    }
    const leaked = JSON.stringify(await all('select summary, detail from evidence where run_id = $1', [must(stops.get('leak'), 'the leak run')]))
    check(leaked.includes('[secret:anthropic]') && !leaked.includes('sk-ant-'), 'a token a check printed reaches the evidence scrubbed')

    const weakened = await waitRow(weaken, 'verify', (r) => r.status === 'done', 300)
    const boxLint = await latestGate(weaken, 'box:lint')
    check(weakened.outcome === 'fails' && boxLint?.status === 'fail' && JSON.stringify(boxLint.detail).includes('eqeqeq')
      && (await latestGate(weaken, 'protected'))?.status === 'needs_owner',
    'a change that switches off a lint rule in its own config is still judged by main\'s config, and its config change needs the owner')

    for (const runId of [seen, ...stops.values(), weaken]) await as(mate, `/v1/runs/${runId}/cancel`)
  }

  if (runs('PUSHMAIN')) {
    // An agent that pushes to main itself. It runs alone, because a refused push
    // stops every governed run on the machine that made it, and here every run shares one machine.
    const before = await mainSha()
    const pushing = await start('PUSHMAIN push the sneak part to main')
    await waitAsk(pushing, 'approve_plan')
    await answer(pushing, 'approve_plan', mate, 'approve')
    const pushed = await within(300, async () => (await runOf(pushing))?.status === 'failed')
    const refused = await all('select refs from refused_pushes where repo_id = $1', [appRepo])
    check(pushed && (await runOf(pushing))?.note === 'Stopped: the run tried to get past the gates.' && refused.some((r: any) => r.refs.includes('refs/heads/main')),
      `a run whose agent pushed to main itself was refused by the git proxy and stopped: ${(await runOf(pushing))?.note}`)
    check((await mainSha()) === before, 'main did not move')
    const clone = join(home, 'direct')
    const factoryAuth = `http.extraHeader=Authorization: Basic ${Buffer.from(`factory:${factoryToken}`).toString('base64')}`
    execFileSync('git', ['-c', factoryAuth, 'clone', '--quiet', `${forgeUrl}/${org}/${APP}.git`, clone])
    execFileSync('git', ['-C', clone, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '--allow-empty', '-qm', 'direct'])
    let direct = ''
    try {
      execFileSync('git', ['-C', clone, '-c', factoryAuth, 'push', 'origin', 'HEAD:main'], { stdio: 'pipe' })
      direct = 'accepted'
    } catch (error) {
      direct = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : String(error)
    }
    check(direct.includes('protected branch'), 'the forge itself refuses a push to main, even with the factory\'s own credentials')

    // Through the proxy as the machine: on the repo with a policy only its own
    // task branches take a push, and a repo without one takes any branch.
    const asMachine = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${mac.token}` }
    const proxied = (repoId: string, ref: string, from: string) => {
      try {
        execFileSync('git', ['-C', from, 'push', `${API}/v1/git/${repoId}.git`, `HEAD:${ref}`], { stdio: 'pipe', env: asMachine })
        return 'accepted'
      } catch (error) {
        return typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : String(error)
      }
    }
    const notOwn = proxied(appRepo, 'refs/heads/task/not-this-machines', clone)
    check(notOwn !== 'accepted' && await one(`select 1 from refused_pushes where repo_id = $1 and 'refs/heads/task/not-this-machines' = any(refs)`, [appRepo])
      && (await forgeCall('GET', `/repos/${org}/${APP}/branches/task/not-this-machines`)).status === 404,
    `the proxy refuses and records a machine's push to a task branch not its own, on the repo with a policy: ${notOwn.split('\n')[0] ?? ''}`)
    const { id: pipesRepo } = must(await one('select id from repos where team_id = $1 and remote_url = $2', [teamId, remote(PIPES)]), 'the pipelines repo')
    const pipes = join(home, 'pipes')
    execFileSync('git', ['-c', factoryAuth, 'clone', '--quiet', `${forgeUrl}/${org}/${PIPES}.git`, pipes])
    execFileSync('git', ['-C', pipes, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '--allow-empty', '-qm', 'a branch of its own'])
    check(proxied(pipesRepo, 'refs/heads/feature/any-name', pipes) === 'accepted'
      && (await forgeCall('GET', `/repos/${org}/${PIPES}/branches/feature/any-name`)).status === 200,
    'a repo without a policy still takes a machine\'s push to any branch through the proxy')
  }

  if (runs('SAMEMODEL')) {
    // A reviewer on the author's own model is no independent review.
    await db.query(`update agents set model = $2 where team_id = $1 and name = 'reviewer'`, [teamId, MODELS.builder])
    const sameModel = await start('SAMEMODEL add the twin part')
    await waitAsk(sameModel, 'approve_plan')
    await answer(sameModel, 'approve_plan', mate, 'approve')
    const review = await waitRow(sameModel, 'review', (r) => r.status === 'failed', 300)
    check(review.summary.includes('cannot be independent') && review.summary.includes('the author\'s model'), `a reviewer on the author's model is refused: ${review.summary}`)
    await as(mate, `/v1/runs/${sameModel}/cancel`)
  }

  if (runs('BOXED')) {
    // A repo whose policy keeps work in boxes takes no run or task on a Mac.
    const { id: boxedRepo } = must(await one('select id from repos where team_id = $1 and remote_url = $2', [teamId, remote(BOXED)]), 'the boxed repo')
    const boxedRun = await start('BOXED a change on a box-only repo', boxedRepo)
    check(await within(30, async () => (await runOf(boxedRun))?.status === 'failed') && (await runOf(boxedRun))?.note.includes('only in a box'),
      `a run that would use a home machine on a box-only repo stops before it starts: ${(await runOf(boxedRun))?.note}`)
    const builder = must(await one(`select id from agents where team_id = $1 and name = 'builder'`, [teamId]), 'the builder')
    const task = await as(mate, '/v1/tasks', { title: 'Work on the boxed repo', instructions: 'x', agentId: builder.id, repoId: boxedRepo })
    check(task.status === 409 && (await task.text()).includes('keeps coding work in boxes'), 'a task on a box-only repo is refused for an agent that lives on a Mac')
    const twoRepos = await as(mate, '/v1/tasks', { title: 'Work on the app and the boxed repo', instructions: 'x', agentId: builder.id, repoIds: [appRepo, boxedRepo] })
    check(twoRepos.status === 409 && (await twoRepos.text()).includes('keeps coding work in boxes'),
      'a task on two repos, one of them box-only, is refused for an agent that lives on a Mac')
  }

  if (runs('CAPPED')) {
    // A repo over its daily spend cap starts no more runs.
    writeFileSync(join(home, 'agents-test.json'), JSON.stringify({ ...testPolicy, caps: { ...testPolicy.caps, repoDailyUsd: 0.01 } }))
    node('server/admin.ts', 'set-policy', team, remote(APP), join(home, 'agents-test.json'), owner)
    const capped = await start('CAPPED one more change today')
    check(await within(30, async () => (await runOf(capped))?.status === 'failed') && (await runOf(capped))?.note.includes('daily cap'),
      `a run over the repo's daily spend cap stops before it starts: ${(await runOf(capped))?.note}`)
  }

} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
    for (const repo of [APP, PIPES, BOXED]) await forgeCall('DELETE', `/repos/${org}/${repo}`)
    await forgeCall('DELETE', `/admin/users/${forgeUser}`)
  }
  await db.end().catch(() => undefined)
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} and the self- forge repos kept, home ${home})` : 'all passed (test team and repos removed)'}`)
process.exit(failures.length ? 1 : 0)
