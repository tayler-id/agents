// Watches step24's and step24b's checks fail. First it runs each check with nothing broken, as a control.
// Then for each break it copies the files the break touches aside, applies its edits (each anchor must be in
// its file exactly once, or nothing is written), runs the check the break names, and confirms that the lines
// it names went red. Last it puts every file back byte for byte and confirms its sha256. A run killed midway
// puts the files back when it next starts. Nothing else may run while it does, since the edits are in the tree.
//   node test/step24-breaks.ts                     the controls, then every break
//   node test/step24-breaks.ts memories-flag       only the breaks named
//   node test/step24-breaks.ts --check             each anchor is there once, and nothing runs

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const ROOT = new URL('..', import.meta.url).pathname
const WORK = join(ROOT, '.scratch', 'verify', 'breaks-24')
const BACKUP = join(WORK, 'backup')
const PENDING = join(WORK, 'pending.json')
// step24 takes under a minute and step24b a few. A break that leaves a daemon waiting is cut off by the
// checks' own limits, which add up to a few minutes.
const RUN_TIMEOUT_MS = 10 * 60 * 1000

type Edit = { file: string; anchor: string; replace: string }
type CheckName = 'step24' | 'step24b'
// `red` holds a piece of each check line the break must turn red.
type Break = { name: string; check: CheckName; why: string; red: string[]; edits: Edit[] }

const AGENTS = 'server/agents.ts'
const TYPES = 'shared/types.ts'
const DAEMON = 'daemon/agentsd.ts'
const CLAUDE = 'daemon/claude.ts'
const FILES = 'daemon/agentfiles.ts'
const HOOKS_UI = 'app/src/Hooks.tsx'
const COPY_UI = 'app/src/CopyAgent.tsx'

const BREAKS: Break[] = [
  // Who may change a hook, and what a hook may be.
  { name: 'hook-owner', check: 'step24', why: 'any teammate changes any agent\'s hooks', red: ['a teammate who does not own the agent cannot add a hook', 'a teammate cannot take one off'],
    edits: [{ file: AGENTS, anchor: '  if (!mayChangeHooks(person, agent)) {', replace: '  if (false) {' }] },
  { name: 'hook-secret', check: 'step24', why: 'a command that holds a key is stored', red: ['a command that holds a secret value is refused'],
    edits: [{ file: AGENTS, anchor: '  if (scrub(hook.command) !== hook.command) {', replace: '  if (false) {' }] },
  { name: 'matcher-any-event', check: 'step24', why: 'a hook for a message may name tools', red: ['a hook needs a known event, a matcher only on a tool event'],
    edits: [{ file: TYPES, anchor: '}).refine((hook) => hook.matcher === null || takesMatcher(hook.event), {', replace: '}).refine((hook) => true || hook.matcher === null || takesMatcher(hook.event), {' }] },
  { name: 'time-limit-zero', check: 'step24', why: 'a hook may have a time limit of nothing', red: ['a hook needs a known event, a matcher only on a tool event'],
    edits: [{ file: TYPES, anchor: 'timeoutSec: z.number().int().min(1).max(HOOK_TIMEOUT_MAX_SEC)', replace: 'timeoutSec: z.number().int().min(0).max(HOOK_TIMEOUT_MAX_SEC)' }] },
  // How hooks reach a session.
  { name: 'shape-hooks', check: 'step24', why: 'teammates cannot read an agent\'s hooks', red: ['teammates read an agent\'s hooks through the agent_hooks shape'],
    edits: [{ file: 'server/sync.ts', anchor: "  agent_hooks: async (p) => ({ table: 'agent_hooks', where: 'agent_id in (select id from agents where team_id = $1)', params: [p.team_id] }),\n", replace: '' }] },
  { name: 'kit-hooks', check: 'step24', why: 'a message carries no hooks', red: ['the daemon wrote the hooks where Claude Code reads them', "a hook's run is in the record"],
    edits: [{ file: 'server/record.ts', anchor: 'hooks: await hooksOf(client, agentId), memory: memory || undefined }', replace: 'memory: memory || undefined }' }] },
  { name: 'write-hooks', check: 'step24', why: 'the daemon does not write the settings file', red: ['the daemon wrote the hooks where Claude Code reads them', "a hook's run is in the record"],
    edits: [{ file: DAEMON, anchor: '  writeHooks(cwd, hooks)\n', replace: '' }] },
  { name: 'matcher-groups', check: 'step24', why: 'the settings file loses each hook\'s matcher', red: ['grouped by event and matcher'],
    edits: [{ file: FILES, anchor: '    const matcher = hook.matcher ?? undefined\n', replace: '    const matcher = undefined\n' }] },
  { name: 'settings-kept', check: 'step24', why: 'an agent with no hooks keeps its old settings file', red: ['an agent with no hooks has no settings file'],
    edits: [{ file: FILES, anchor: '    rmSync(file, { force: true })\n', replace: '' }] },
  { name: 'setup-hooks', check: 'step24', why: 'a running session does not restart for changed hooks', red: ['taking a hook off the agent takes it from the file of the session that was already running'],
    edits: [{ file: DAEMON, anchor: 'p.plugins, p.hooks, p.permissions]', replace: 'p.plugins, p.permissions]' }] },
  // How a hook's run reaches the record.
  { name: 'hook-flag', check: 'step24', why: 'Claude Code is not asked to report hook runs', red: ["a hook's run is in the record", 'a hook that fails is in the record too'],
    edits: [{ file: CLAUDE, anchor: "    if (options.hookEvents) args.push('--include-hook-events')\n", replace: '' }] },
  { name: 'hook-line', check: 'step24', why: 'a hook run is a notice named only by its subtype', red: ["a hook's run is in the record, with what it printed"],
    edits: [{ file: CLAUDE, anchor: "  if (type === 'system' && subtype === 'hook_response') return { events: [hookEvent(clientId, line, rest)], raw }\n", replace: '' }] },
  // What a copy carries, and what it does not.
  { name: 'memories-person', check: 'step24', why: 'a copy carries a log about a person, written as the team\'s', red: ['the copy carries no memory about a person', 'the copy carries the team\'s memories'],
    edits: [{ file: AGENTS, anchor: "from memories where agent_id = $1 and scope = 'team' and content <> '' order by kind desc, log_date`", replace: "from memories where agent_id = $1 and (scope = 'team' or kind = 'log') and content <> '' order by kind desc, log_date`" }] },
  { name: 'memories-flag', check: 'step24', why: 'a copy carries the team\'s memories whether or not they were asked for', red: ["a copy made without the team's memories has none"],
    edits: [{ file: AGENTS, anchor: 'const memories = withMemories ? await teamMemories(client, agentId) : []', replace: 'const memories = await teamMemories(client, agentId)' }] },
  { name: 'memories-never', check: 'step24', why: 'a copy never carries the team\'s memories', red: ["the copy carries the team's memories"],
    edits: [{ file: AGENTS, anchor: 'const memories = withMemories ? await teamMemories(client, agentId) : []', replace: 'const memories: RecipeMemory[] = []' }] },
  { name: 'template-memories', check: 'step24', why: 'a template saves the team\'s memories', red: ['keeps its hooks and none of its memories'],
    edits: [{ file: AGENTS, anchor: 'const recipe = await recipeOf(client, agent.id, false)', replace: 'const recipe = await recipeOf(client, agent.id, true)' }] },
  { name: 'recipe-hooks', check: 'step24', why: 'a recipe leaves the hooks out', red: ["the copy carries the agent's skill, plugin, routine and three hooks", 'keeps its hooks and none of its memories'],
    edits: [{ file: AGENTS, anchor: 'hooks: await hooksOf(client, agentId), memories })', replace: 'hooks: [], memories })' }] },
  { name: 'install-hooks', check: 'step24', why: 'a recipe\'s hooks are not given to the new agent', red: ["the copy carries the agent's skill, plugin, routine and three hooks", 'a new agent started from the template has the hooks'],
    edits: [{ file: AGENTS, anchor: '  for (const hook of recipe.hooks) await saveHook(client, person, agentId, hook)\n', replace: '' }] },
  { name: 'plugin-values', check: 'step24', why: 'a plugin that holds a secret value is copied as it is', red: ['a plugin that holds a secret value is not copied'],
    edits: [
      { file: TYPES, anchor: 'env: z.record(z.string(), SecretRef).optional()', replace: 'env: z.record(z.string(), z.unknown()).optional()' },
      { file: AGENTS, anchor: '  for (const plugin of recipe.plugins) await savePlugin(client, person, agentId, plugin)\n',
        replace: "  for (const plugin of recipe.plugins) await client.query('insert into plugins (agent_id, name, kind, config) values ($1, $2, $3, $4)', [agentId, plugin.name, plugin.kind, JSON.stringify(plugin.config)])\n" },
    ] },
  // Where a copy may go, and what it records.
  { name: 'copy-personal-box', check: 'step24', why: 'a copy may go on a teammate\'s own box', red: ["a copy cannot go on a teammate's own box"],
    edits: [{ file: AGENTS, anchor: 'if (home.personal && home.owner_id !== person.id)', replace: 'if (false)' }] },
  { name: 'copy-name-taken', check: 'step24', why: 'a copy may take another agent\'s name', red: ['a copy needs a name no agent has'],
    edits: [{ file: AGENTS, anchor: '  if (taken) throw new HttpError(409, `there is already an agent named ${agent.name}`)\n', replace: '' }] },
  { name: 'copy-provenance', check: 'step24', why: 'a copy does not record where it came from', red: ["Bob's copy is his own agent on his machine, made from Alice's"],
    edits: [{ file: AGENTS, anchor: 'home.id, person.id, agent.copiedFrom])', replace: 'home.id, person.id, null])' }] },
  // The app.
  { name: 'ui-hooks-gate', check: 'step24b', why: 'the page offers the hook controls to everyone', red: ['a teammate reads the hooks, and is told who changes them'],
    edits: [{ file: HOOKS_UI, anchor: '  const mayChange = mayChangeHooks(me.person, agent)', replace: '  const mayChange = true' }] },
  { name: 'ui-tools-field', check: 'step24b', why: 'every hook form asks which tools it applies to', red: ['a hook for a message takes no tools to match'],
    edits: [{ file: HOOKS_UI, anchor: '        {takesMatcher(event) && (', replace: '        {true && (' }] },
  { name: 'ui-memories-chosen', check: 'step24b', why: 'the copy form starts with the team\'s memories chosen', red: ["memories counted and not chosen"],
    edits: [{ file: COPY_UI, anchor: 'const [withMemories, setWithMemories] = useState(false)', replace: 'const [withMemories, setWithMemories] = useState(true)' }] },
  { name: 'ui-receipt', check: 'step24b', why: 'the receipt leaves out the hooks', red: ['copying says what the copy carries'],
    edits: [{ file: COPY_UI, anchor: "  count(c.hooks, 'hook', 'hooks'), count(c.memories, 'team memory', 'team memories'),", replace: "  count(c.memories, 'team memory', 'team memories'),"}] },
  { name: 'ui-provenance', check: 'step24b', why: 'the copy does not say where it came from', red: ['says which agent it was copied from'],
    edits: [{ file: 'app/src/AgentPage.tsx', anchor: '{agent.copied_from_agent_id && <p className="muted small">Copied from', replace: '{false && <p className="muted small">Copied from' }] },
  { name: 'ui-hook-line', check: 'step24b', why: 'the session panel leaves out a hook\'s run', red: ["the session lists the hook's run"],
    edits: [{ file: 'app/src/Session.tsx', anchor: "new Set<unknown>(['init', 'interrupted', 'screen', 'hook_response'])", replace: "new Set<unknown>(['init', 'interrupted', 'screen'])" }] },
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

function runCheck(name: CheckName): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = name === 'step24b' ? { ...process.env, AGENTS_UI_ENGINES: 'chromium' } : process.env
    const child = spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', `test/${name}.ts`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
    output = await runCheck(b.check)
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
for (const name of [...new Set(chosen.map((b) => b.check))]) {
  const control = redLines(await runCheck(name))
  console.log(`${control.length ? 'FAIL' : 'pass'}  control: ${name} with nothing broken${control.length ? ` has ${String(control.length)} red lines, so no break can be judged` : ' is green'}`)
  if (control.length) process.exit(1)
}
for (const b of chosen) {
  const result = await runBreak(b)
  console.log(`${result.ok ? 'pass' : 'FAIL'}  ${b.name}: ${b.why}. ${result.detail}`)
  if (!result.ok) failed++
}
console.log(`\n${failed ? `${String(failed)} breaks were not seen failing` : `all ${String(chosen.length)} breaks were seen failing, and every file is back as it was`}`)
process.exit(failed ? 1 : 0)
