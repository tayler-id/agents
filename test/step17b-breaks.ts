// Watches step17b's checks fail. First it runs step17b with nothing broken, as a control. Then for each break
// it copies the files the break touches aside, applies its edits (each anchor must be in its file exactly once,
// or nothing is written), runs step17b, and confirms that the checks the break names went red. Last it puts every
// file back byte for byte and confirms its sha256. A run killed midway puts the files back when it next starts.
//   node test/step17b-breaks.ts                     the control, then every break
//   node test/step17b-breaks.ts no-nonce any-host   only the breaks named
//   node test/step17b-breaks.ts --check             each anchor is there once, and nothing runs

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const ROOT = new URL('..', import.meta.url).pathname
const WORK = join(ROOT, '.scratch', 'verify', 'breaks-17b')
const BACKUP = join(WORK, 'backup')
const PENDING = join(WORK, 'pending.json')
// step17b takes under a minute. A break that leaves the preview running or an answer unread is cut off by
// the check's own limits, which add up to a few minutes.
const RUN_TIMEOUT_MS = 10 * 60 * 1000

type Edit = { file: string; anchor: string; replace: string }
// `red` holds a piece of each check line the break must turn red. The breaks that stop the check before the line
// it names name the error it stops on instead.
type Break = { name: string; why: string; red: string[]; edits: Edit[] }

const PREVIEW = 'ctl/preview.ts'
const CLI = 'ctl/cli.ts'
const SEED = 'ctl/seed.ts'
const ORIGIN_RULE = 'const admitted = origin === undefined ? !upgrade : own.has(origin)'

const BREAKS: Break[] = [
  // Who the page is signed in as.
  { name: 'login-is-teammate', why: 'the proxy signs in the teammate, not the person the preview was started for', red: ["/v1/me through the preview answers as the instance's owner", 'chromium opens the preview signed in as'],
    edits: [{ file: PREVIEW, anchor: 'headers: { [LOGIN_HEADER]: login },', replace: 'headers: { [LOGIN_HEADER]: state.seed.teammate.login },' }] },
  { name: 'keeps-caller-names', why: 'an identity header the caller sends goes on to the API', red: ['a person on no team is shown as waiting to join'],
    edits: [{ file: PREVIEW, anchor: 'for (const name of Object.keys(req.headers)) if (name.startsWith(IDENTITY_PREFIX)) delete req.headers[name]', replace: '' }] },
  // The API's origin check, and the preview's own.
  { name: 'keeps-origin', why: "a WebSocket goes to the API with the page's own origin", red: ['a WebSocket through the preview reaches the API'],
    edits: [{ file: PREVIEW, anchor: "proxy.on('proxyReqWs', (proxyReq) => { proxyReq.setHeader('origin', peopleOrigin(state.ports.people)) })", replace: "proxy.on('proxyReqWs', () => {})" }] },
  { name: 'admits-any-origin', why: 'a page of any origin may use the API through the preview', red: ['a page of another origin, or none, gets nothing of the API', "touching the app's Vite config"],
    edits: [{ file: PREVIEW, anchor: ORIGIN_RULE, replace: 'const admitted = true' }] },
  { name: 'admits-no-origin', why: 'a WebSocket with no origin may use the API through the preview', red: ['a page of another origin, or none, gets nothing of the API'],
    edits: [{ file: PREVIEW, anchor: ORIGIN_RULE, replace: 'const admitted = origin === undefined ? true : own.has(origin)' }] },
  // The page's policy.
  { name: 'no-nonce', why: "the page keeps the app's policy as it is, which refuses the dev server's inline script", red: ['the page is the app from source', 'chromium opens the preview', 'a saved component reaches the open page'],
    edits: [{ file: PREVIEW, anchor: 'plugins: [policyPlugin(nonce)],', replace: 'plugins: [],' }] },
  // Who can reach the preview.
  { name: 'any-address', why: 'the preview listens on every address', red: ['the preview listens on 127.0.0.1 only'],
    edits: [{ file: PREVIEW, anchor: "const HOST = '127.0.0.1'", replace: "const HOST = '0.0.0.0'" }] },
  { name: 'cors-on', why: "Vite lets a page on another local port read the preview's files", red: ['no CORS permission'],
    edits: [{ file: PREVIEW, anchor: '        cors: false,\n', replace: '' }] },
  { name: 'any-host', why: 'the preview answers a request that names any host', red: ['a request that names another host'],
    edits: [{ file: PREVIEW, anchor: '        host: HOST,\n        port,\n', replace: '        host: HOST,\n        allowedHosts: true,\n        port,\n' }] },
  { name: 'one-port', why: 'the preview tries one port and no other', red: ['no port from 8200 to 8200'],
    edits: [{ file: PREVIEW, anchor: 'const PORT_TRIES = 100', replace: 'const PORT_TRIES = 1' }] },
  // What Vite does on its own.
  { name: 'restarts', why: "Vite restarts when the app's config is touched, and leaves a second proxy on the server", red: ["touching the app's Vite config does not restart the preview"],
    edits: [{ file: PREVIEW, anchor: '        watch: { ignored: [APP_CONFIG] },\n', replace: '' }] },
  { name: 'log-to-terminal', why: "Vite's messages go to the terminal, not the log", red: ["Vite's messages go to preview.log"],
    edits: [{ file: PREVIEW, anchor: "createLogger('info', { allowClearScreen: false, console: new Console({ stdout: fileSink(log) }) })", replace: "createLogger('info', { allowClearScreen: false })" }] },
  // How it ends.
  { name: 'no-stop', why: 'the preview ends its command and leaves the server listening', red: ['was still running 10 seconds after SIGTERM'],
    edits: [{ file: CLI, anchor: '  await preview.stop()\n', replace: '' }] },
  { name: 'sigterm-ignored', why: 'only Ctrl+C stops the preview cleanly', red: ['SIGTERM stops a preview with exit 0'],
    edits: [{ file: CLI, anchor: "for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, done)", replace: "process.once('SIGINT', done)" }] },
  // What it asks before it starts anything.
  { name: 'stray-word', why: 'a word where a flag belongs starts a preview', red: ['a word where a flag belongs'],
    edits: [{ file: CLI, anchor: 'if (positionals.length) throw new UsageError(', replace: 'if (positionals.length < 0) throw new UsageError(' }] },
  { name: 'late-who', why: 'a name that is not a person is found after the instance is up', red: ['a word where a flag belongs'],
    edits: [{ file: CLI, anchor: "const Who = z.union([PersonName, z.string().includes('@')], { error: PERSON_RULE })", replace: 'const Who = z.string()' }] },
  { name: 'new-instance', why: 'with no instance named, preview makes one even when this checkout has one', red: ['with two instances here and none named', 'with one instance here, started with pipelines'],
    edits: [{ file: CLI, anchor: 'const exists = name ? readState(name) !== null : list().length > 0', replace: 'const exists = name ? readState(name) !== null : false' }] },
  // What it seeds.
  { name: 'seeds-with-no-seed', why: '--no-seed seeds anyway', red: ['--no-seed adds no task'],
    edits: [{ file: CLI, anchor: "const added = values['no-seed'] ? null : await seedSample(state)", replace: 'const added = await seedSample(state)' }] },
  { name: 'seeds-beside-own-work', why: 'a team with a task of its own gets the sample task too', red: ['a team that already has a task gets no sample next to it'],
    edits: [{ file: SEED, anchor: '  if (held.tasks > 0) return []\n', replace: '' }] },
  { name: 'second-repo', why: 'a team that has a repo is told it was given one', red: ['a team with repos and no task gets only the task'],
    edits: [{ file: SEED, anchor: '  if (held.repos === 0) added.push(', replace: '  added.push(' }] },
]

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const Pending = z.array(z.object({ file: z.string(), sha: z.string() }))
const at = (file: string) => join(ROOT, file)

// Puts back the files a run that was killed had changed.
function restorePending() {
  if (!existsSync(PENDING)) return
  for (const { file, sha: wanted } of Pending.parse(JSON.parse(readFileSync(PENDING, 'utf8')))) {
    copyFileSync(join(BACKUP, file), at(file))
    if (sha(readFileSync(at(file))) !== wanted) throw new Error(`${file} did not come back as it was`)
    console.log(`restored ${file}, left changed by a run that was killed`)
  }
  rmSync(PENDING)
}

// What each file the break touches would hold with its edits made. Throws, writing nothing, when an anchor is not there exactly once.
function edited(b: Break): Map<string, string> {
  const files = new Map<string, string>()
  for (const edit of b.edits) {
    const text = files.get(edit.file) ?? readFileSync(at(edit.file), 'utf8')
    const found = text.split(edit.anchor).length - 1
    if (found !== 1) throw new Error(`${b.name}: the anchor ${JSON.stringify(edit.anchor)} is in ${edit.file} ${String(found)} times, not once`)
    files.set(edit.file, text.replace(edit.anchor, () => edit.replace))
  }
  return files
}

function step17b(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', 'test/step17b.ts'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    const timer = setTimeout(() => { child.kill('SIGTERM') }, RUN_TIMEOUT_MS)
    child.once('error', reject)
    child.once('close', () => { clearTimeout(timer); resolve(output) })
  })
}

const redLines = (output: string) => output.split('\n').filter((line) => line.startsWith('FAIL  '))
const lines = (n: number) => `${String(n)} ${n === 1 ? 'line' : 'lines'}`

async function runBreak(b: Break): Promise<{ ok: boolean; detail: string }> {
  const files = edited(b)
  mkdirSync(BACKUP, { recursive: true })
  const before = [...files.keys()].map((file) => ({ file, sha: sha(readFileSync(at(file))) }))
  for (const { file } of before) {
    mkdirSync(dirname(join(BACKUP, file)), { recursive: true })
    copyFileSync(at(file), join(BACKUP, file))
  }
  writeFileSync(PENDING, JSON.stringify(before))
  let output: string
  try {
    for (const [file, text] of files) writeFileSync(at(file), text)
    output = await step17b()
  } finally {
    for (const { file } of before) copyFileSync(join(BACKUP, file), at(file))
  }
  const back = before.filter(({ file, sha: wanted }) => sha(readFileSync(at(file))) !== wanted)
  if (back.length) throw new Error(`${back.map((f) => f.file).join(', ')} did not come back as it was`)
  rmSync(PENDING)
  const fails = redLines(output)
  const missing = b.red.filter((piece) => !fails.some((line) => line.includes(piece)))
  return {
    ok: missing.length === 0 && fails.length > 0,
    detail: missing.length ? `${lines(fails.length)} went red, and none held "${missing.join('" or "')}". Red: ${fails.map((l) => l.slice(0, 120)).join(' | ')}` : `${lines(fails.length)} went red, and the files are back byte for byte`,
  }
}

const args = process.argv.slice(2)
const only = args.filter((a) => !a.startsWith('--'))
const unknown = only.filter((name) => !BREAKS.some((b) => b.name === name))
if (unknown.length) throw new Error(`no break named ${unknown.join(', ')}. They are ${BREAKS.map((b) => b.name).join(', ')}`)
const chosen = BREAKS.filter((b) => !only.length || only.includes(b.name))

if (args.includes('--check')) {
  for (const b of BREAKS) edited(b)
  console.log(`all ${String(BREAKS.length)} breaks find each anchor once`)
  process.exit(0)
}

restorePending()
let failed = 0
const control = redLines(await step17b())
console.log(`${control.length ? 'FAIL' : 'pass'}  control: step17b with nothing broken${control.length ? ` has ${String(control.length)} red lines, so no break can be judged` : ' is green'}`)
if (control.length) process.exit(1)
for (const b of chosen) {
  const result = await runBreak(b)
  console.log(`${result.ok ? 'pass' : 'FAIL'}  ${b.name}: ${b.why}. ${result.detail}`)
  if (!result.ok) failed++
}
console.log(`\n${failed ? `${String(failed)} breaks were not seen failing` : `all ${String(chosen.length)} breaks were seen failing, and every file is back as it was`}`)
process.exit(failed ? 1 : 0)
