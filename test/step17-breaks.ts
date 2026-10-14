// Watches step17's checks fail. First it runs each set of sections a break
// needs with nothing broken, as a control. Then for every break: copy the files
// it touches aside, apply its edits (each anchor must appear exactly once, or
// nothing is written), run step17 on the sections that hold the check, confirm
// that check printed FAIL where the control printed pass, then put every file
// back byte for byte and confirm its sha256. A run killed midway puts the files
// back when it next starts. It ends by listing the checks no break covers.
//   node test/step17-breaks.ts                 every break
//   node test/step17-breaks.ts up-again dry-run  only the breaks named
//   node test/step17-breaks.ts --check           each anchor is there once, and nothing runs

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const ROOT = new URL('..', import.meta.url).pathname
const WORK = join(ROOT, '.scratch', 'verify', 'breaks')
const BACKUP = join(WORK, 'backup')
const PENDING = join(WORK, 'pending.json')
const RESULTS = join(WORK, 'results.json')
// A step17 run of a few sections takes a minute or two; the slowest, visual, under five.
const RUN_TIMEOUT_MS = 10 * 60 * 1000

type Edit = { file: string; anchor: string; replace: string }
type Break = { name: string; why: string; sections: string; red: string; edits: Edit[] }

const BREAKS: Break[] = [
  // What up and down may touch.
  { name: 'refuse-team', why: 'up goes on when its team is already there', sections: 'refuse', red: 'up refuses with exit 3 and no state when its team is already there',
    edits: [{ file: 'ctl/instance.ts', anchor: 'if (await teamTaken(team)) throw new Refused(', replace: "if (team === 'never') throw new Refused(" }] },
  { name: 'refuse-org', why: 'up --pipelines goes on when its forge org is already there', sections: 'refuse', red: 'up --pipelines refuses with exit 3 and no state when its forge org is already there',
    edits: [{ file: 'ctl/instance.ts', anchor: 'if (options.pipelines && await orgTaken(orgOf(name))) throw new Refused(', replace: "if (options.pipelines && name === 'never') throw new Refused(" }] },
  { name: 'made-team', why: "down removes the team whether or not its up made it", sections: 'refuse', red: 'down removes only what its up made',
    edits: [{ file: 'ctl/instance.ts', anchor: 'removed.team = stopping.made.team && await withClient(', replace: 'removed.team = await withClient(' }] },
  { name: 'socket-guard', why: 'config lets an inherited people socket through', sections: 'refuse', red: 'up refuses with exit 3 a people socket it inherits from outside its scratch folder',
    edits: [{ file: 'ctl/config.ts', anchor: 'if (socket && !inScratch(socket)) {', replace: "if (socket === 'never') {" }] },
  { name: 'live-database', why: 'config takes any database', sections: 'refuse', red: 'up refuses with exit 3 a DATABASE_URL naming the live database',
    edits: [
      { file: 'ctl/config.ts', anchor: 'if (parsed.data[key] !== fromTest) {', replace: "if (parsed.data[key] === 'never') {" },
      { file: 'ctl/config.ts', anchor: "if (!database.endsWith('_test')) throw", replace: "if (database === 'never') throw" },
    ] },
  { name: 'live-port', why: 'up takes a block that holds a live port', sections: 'refuse', red: 'up refuses with exit 3 a port block that holds a live port',
    edits: [{ file: 'ctl/ports.ts', anchor: 'if (ports.some((p) => LIVE_PORTS.includes(p))) throw new Refused(', replace: 'if (ports.some((p) => p < 0)) throw new Refused(' }] },
  { name: 'env-allowlist', why: 'every process gets the database URL and the secrets', sections: 'refuse', red: "the daemon and the browser session get no database URL or secret",
    edits: [{ file: 'ctl/config.ts', anchor: 'const secrets = Object.fromEntries(SECRETS[role].map((key) => [key, loaded[key]]))', replace: 'const secrets = Object.fromEntries(SECRETS.api.map((key) => [key, loaded[key]]))' }] },
  { name: 'token-scrub', why: 'nothing scrubs what agentsctl prints', sections: 'api', red: "up's output leaves out the machine's token",
    edits: [{ file: 'ctl/cli.ts', anchor: '  scrub: scrubber,\n}', replace: '}' }] },
  { name: 'evidence-token', why: 'down copies the final state with its token into the evidence', sections: 'api', red: "the evidence keeps no copy of the machine's token",
    edits: [{ file: 'ctl/instance.ts', anchor: 'JSON.stringify(scrubber()(stopped), null, 2)', replace: 'JSON.stringify(stopped, null, 2)' }] },
  { name: 'secret-mask', why: "secret set's value is logged", sections: 'seed', red: "the action log keeps no secret's value",
    edits: [{ file: 'ctl/cli.ts', anchor: "about: 'the value, which no log or output repeats', secret: true }", replace: "about: 'the value, which no log or output repeats' }" }] },

  // The instance's lifecycle.
  { name: 'up-again', why: 'up starts another instance instead of reporting the one it has', sections: 'api', red: 'up again changes nothing and says already: true',
    edits: [{ file: 'ctl/instance.ts', anchor: 'return { state: existing, already: true }', replace: 'return { state: existing, already: false }' }] },
  { name: 'doctor-process', why: "doctor stops checking the instance's processes", sections: 'sick', red: 'doctor fails once the daemon stops, and names it',
    edits: [{ file: 'ctl/instance.ts', anchor: 'add(`${record.role} process`, ours,', replace: 'add(`${record.role} process`, true,' }] },
  { name: 'down-api', why: 'down leaves the API running and does not count it', sections: 'api', red: 'down stops every process the run started',
    edits: [
      { file: 'ctl/instance.ts', anchor: "const order: ProcessRecord['role'][] = ['session', 'daemon', 'api', 'people']", replace: "const order: ProcessRecord['role'][] = ['session', 'daemon', 'people']" },
      { file: 'ctl/instance.ts', anchor: 'const survivors = await stop(found, STOP_GRACE_MS)', replace: "const survivors = await stop(found.filter((p) => !p.command.includes('server/api.ts')), STOP_GRACE_MS)" },
    ] },
  { name: 'down-evidence', why: "down deletes the instance's final state instead of keeping it with the evidence", sections: 'api', red: 'down keeps the evidence',
    edits: [{ file: 'ctl/instance.ts', anchor: "  writeFileSync(join(stopping.evidence, 'instance.json'), `${JSON.stringify(scrubber()(stopped), null, 2)}\\n`)\n", replace: '' }] },
  { name: 'dashboard', why: 'the dashboard stops saying an instance answers', sections: 'api', red: 'agentsctl alone shows the instance, ready and answering',
    edits: [{ file: 'ctl/cli.ts', anchor: "${answers ? 'answers' : running", replace: "${answers ? 'silent' : running" }] },
  { name: 'dry-run', why: '--dry-run runs the command', sections: 'api', red: '--dry-run parses a drive, names the instance, and runs nothing',
    edits: [{ file: 'shared/cli/command.ts', anchor: 'const result = dry && cli.dryRun ? cli.dryRun(command, shownArgv, own) : await run()', replace: 'const result = await run()' }] },

  // Driving the web app, and what it checks. Three breaks are in the app itself.
  { name: 'app-enter', why: 'the app stops sending a message on Enter', sections: 'web', red: 'browser drives a DM by role and name, and the reply arrives',
    edits: [{ file: 'app/src/Conversation.tsx', anchor: "if (event.key === 'Enter' && !event.shiftKey) void submit(event)", replace: "if (event.key === 'Return' && !event.shiftKey) void submit(event)" }] },
  { name: 'db-value', why: 'db --value also lists its evidence file', sections: 'web', red: 'db --value prints the value alone',
    edits: [{ file: 'ctl/cli.ts', anchor: 'help: [], data: shared.data, log: shared.log, untrusted }', replace: 'help: [], ...shared }' }] },
  { name: 'db-multi', why: 'db sends its query as simple text, which runs every statement in it', sections: 'web', red: 'db refuses a second statement after a commit',
    edits: [{ file: 'ctl/db.ts', anchor: 'client.query<Record<string, unknown>>({ name: READ_STATEMENT, text: sql, values })', replace: 'client.query<Record<string, unknown>>(sql, values)' }] },
  { name: 'head-text', why: "browser text puts the page's text in its head", sections: 'web', red: 'one line of page text is fenced, and the head says only what the tool knows',
    edits: [{ file: 'ctl/driver.ts', anchor: "return { ...done(pass ? holds : `${holds}, without \"${op.holds ?? ''}\"`, { outside: text }), pass }", replace: 'return { ...done(pass ? text : holds, { outside: text }), pass }' }] },
  { name: 'json-outside', why: '--json drops the outside blocks', sections: 'web', red: '--json keeps page text out of the head, in outside blocks',
    edits: [{ file: 'shared/cli/command.ts', anchor: 'outside: [...list.outside, ...(result.outside ?? [])].filter((block) => block.text.length > 0),', replace: 'outside: [],' }] },
  { name: 'list-fence', why: "a list's outside rows print bare", sections: 'web', red: 'a 100-row list shows 30 rows inside a fence that still closes',
    edits: [{ file: 'shared/cli/command.ts', anchor: 'if (result.source) return { own: more, outside: lines ? [{ source: result.source, text: lines }] : [] }', replace: "if (result.source) return { own: [lines, more].join('\\n'), outside: [] }" }] },
  { name: 'db-write', why: 'db stops reading in a read-only transaction', sections: 'web', red: 'db refuses a write with exit 3',
    edits: [{ file: 'ctl/db.ts', anchor: "await client.query('begin transaction read only')", replace: "await client.query('begin')" }] },
  { name: 'snapshot', why: 'snapshot saves an empty tree', sections: 'web', red: 'snapshot --aria writes the page tree',
    edits: [{ file: 'ctl/playwright.ts', anchor: "(page) => page.locator('body').ariaSnapshot({ timeout: timeoutMs })", replace: "() => Promise.resolve('')" }] },
  { name: 'screenshot', why: 'the desktop page is a pixel narrower than it should be', sections: 'web', red: 'screenshot writes a PNG of the 1280x820 page',
    edits: [{ file: 'ctl/playwright.ts', anchor: 'desktop: { width: 1280, height: 820 }', replace: 'desktop: { width: 1279, height: 820 }' }] },
  { name: 'app-console', why: 'the app logs an error as it starts', sections: 'web', red: 'console finds no page error or console error from the app',
    edits: [{ file: 'app/src/main.tsx', anchor: 'createRoot(root).render(<StrictMode><App /></StrictMode>)', replace: "console.error('step 17 break: an error the app logs')\ncreateRoot(root).render(<StrictMode><App /></StrictMode>)" }] },
  { name: 'app-overflow', why: 'the page is wider than a phone', sections: 'web', red: 'overflow finds no sideways scrolling at phone width',
    edits: [{ file: 'app/src/styles.css', anchor: 'html, body, #root { height: 100%; margin: 0; }', replace: 'html, body, #root { height: 100%; margin: 0; }\nbody { min-width: 600px; }' }] },
  { name: 'app-a11y', why: 'the sidebar shows an image with no text alternative', sections: 'web', red: 'a11y finds no serious or critical violation on the DM',
    edits: [{ file: 'app/src/App.tsx', anchor: '<strong>{me.team.name}</strong>', replace: '<strong>{me.team.name}</strong><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />' }] },
  { name: 'network', why: 'network forgets the requests it saw', sections: 'web', red: 'network lists the requests of a fresh load of the agent page',
    edits: [{ file: 'ctl/playwright.ts', anchor: 'network: (key) => held(key).network.splice(0),', replace: 'network: (key) => { held(key).network.splice(0); return [] },' }] },
  { name: 'trace', why: 'trace stop saves nothing', sections: 'web', red: 'trace start, then stop, writes a trace of the page',
    edits: [{ file: 'ctl/playwright.ts', anchor: 'await holder.context.tracing.stop({ path })', replace: 'await holder.context.tracing.stop()' }] },
  { name: 'record', why: 'record stop saves no video', sections: 'web', red: 'record start, then stop, keeps a video of the steps',
    edits: [{ file: 'ctl/playwright.ts', anchor: '      await video.saveAs(path)\n', replace: '' }] },

  // The desktop app, the API, seeds and the machine.
  { name: 'desktop-login', why: 'the desktop app opens as someone on no team', sections: 'desktop', red: 'desktop opens the team in the Electron app',
    edits: [{ file: 'ctl/playwright.ts', anchor: 'AGENTS_DEV_LOGIN: key.login', replace: "AGENTS_DEV_LOGIN: 'nobody@verify.local'" }] },
  { name: 'api-person', why: 'api calls as someone on no team', sections: 'api', red: 'api calls as a person, and the machine door refuses a person with 400',
    edits: [{ file: 'ctl/cli.ts', anchor: "login: values.as === 'person' ? loginFor(state, values.login) : undefined", replace: "login: values.as === 'person' ? 'nobody@verify.local' : undefined" }] },
  { name: 'seed-person', why: 'seeding a person who is there says it added them', sections: 'seed', red: 'seed person adds cy, who can open the app, and seeding again says already: true',
    edits: [{ file: 'ctl/seed.ts', anchor: "  if (found) return { already: true }\n  await admin('add-person', team, login)", replace: "  if (found) return { already: false }\n  await admin('add-person', team, login)" }] },
  { name: 'seed-box', why: 'seed box says what it meant to leave, not what the record holds', sections: 'seed', red: 'seed adds an agent, a box and a task',
    edits: [{ file: 'ctl/cli.ts', anchor: 'claimed_by is not null as claimed', replace: 'true as claimed' }] },
  { name: 'secret-unset', why: 'secret unset leaves the value on the machine', sections: 'seed', red: 'secret set and unset change what the machine holds',
    edits: [{ file: 'ctl/cli.ts', anchor: '.filter(([k]) => k !== key)', replace: '.filter(() => true)' }] },
  { name: 'machine-missing', why: 'machine read --missing passes whether the file is there or not', sections: 'seed', red: 'secret set and unset change what the machine holds',
    edits: [{ file: 'ctl/cli.ts', anchor: 'if (values.missing) return text === null ?', replace: 'if (values.missing) return true ?' }] },
  { name: 'list', why: 'list shows each instance under the wrong name', sections: 'seed', red: 'list counts the instances in this checkout and shows this one',
    edits: [{ file: 'ctl/cli.ts', anchor: 'name: s.name, phase: s.phase', replace: 'name: s.phase, phase: s.phase' }] },
  { name: 'evidence', why: "evidence prints the actions' summaries without fencing them", sections: 'seed', red: "evidence counts the run's actions and fences their summaries as untrusted",
    edits: [{ file: 'ctl/cli.ts', anchor: "kind: 'list', noun: 'actions', source: 'action log', detail:", replace: "kind: 'list', noun: 'actions', detail:" }] },

  // The rules every CLI of ours keeps.
  { name: 'stderr', why: 'plain failures go to stderr', sections: 'conformance', red: 'a failure prints on stdout, with nothing on stderr',
    // A statement, not a line starting with a parenthesis, which would join the line above.
    edits: [{ file: 'ctl/main.ts', anchor: 'process.stdout.write(`${json ? JSON.stringify(output) : render(output, full)}\\n`)', replace: 'const stream = json || output.ok ? process.stdout : process.stderr\nstream.write(`${json ? JSON.stringify(output) : render(output, full)}\\n`)' }] },
  { name: 'exit-code', why: 'every command exits 0', sections: 'conformance', red: '--json prints one envelope whose code is the exit code (failingRead)',
    edits: [{ file: 'ctl/main.ts', anchor: 'process.exitCode = code', replace: 'process.exitCode = 0' }] },
  { name: 'unknown-flag', why: 'unknown flags are let through', sections: 'conformance', red: 'an unknown flag exits 2 and lists the valid flags',
    edits: [{ file: 'shared/cli/command.ts', anchor: 'parseArgs({ args, options, allowPositionals: true, strict: true })', replace: 'parseArgs({ args, options, allowPositionals: true, strict: false })' }] },
  { name: 'unknown-command', why: 'an unknown command does not list the commands', sections: 'conformance', red: 'an unknown command exits 2 and lists the commands',
    edits: [{ file: 'shared/cli/command.ts', anchor: "`not a command. Commands: ${[...new Set(cli.commands.map((c) => c.name.split(' ')[0]))].join(', ')}`", replace: '`not a command.`' }] },
  { name: 'help', why: 'help leaves out the long command families', sections: 'conformance', red: 'help lists every command',
    edits: [{ file: 'shared/cli/command.ts', anchor: "if (group.length > GROUP_LINES) lines.push([`${word} <op>`, `one of: ${group.map((c) => c.name.slice(word.length + 1)).join(', ')}`])", replace: 'if (group.length > GROUP_LINES) continue' }] },
  { name: 'empty-list', why: 'an empty list prints a zero', sections: 'conformance', red: 'an empty list says there are none',
    edits: [{ file: 'shared/cli/output.ts', anchor: 'if (total === 0) return `no ${noun}`', replace: 'if (total === 0) return `0 ${noun}`' }] },
  { name: 'failed-read', why: 'a db read that fails comes back as no rows', sections: 'conformance', red: 'a failed read is an error, never an empty or zero result',
    edits: [{ file: 'ctl/cli.ts', anchor: 'let rows = await readOnly(text, params)', replace: 'let rows = await readOnly(text, params).catch(() => [])' }] },
  { name: 'write-head', why: 'a write leads with what it did, without ok: or the state it left', sections: 'conformance', red: 'a write leads with ok: and the state it left',
    edits: [{ file: 'shared/cli/command.ts', anchor: "case 'write': return `ok: ${result.did} -> ${result.state}`", replace: "case 'write': return result.did" }] },
  { name: 'already', why: 'a rerun write says already done', sections: 'conformance', red: 'a write run again says already: true, spelled that way',
    edits: [{ file: 'shared/cli/output.ts', anchor: "output.already ? 'already: true' : ''", replace: "output.already ? 'already done' : ''" }] },
  { name: 'cut', why: 'long output prints whole', sections: 'conformance', red: 'long text is cut, saying how much there is and how to see it all',
    edits: [{ file: 'shared/cli/output.ts', anchor: 'const { text, note } = cut(block.text, full)', replace: 'const { text, note } = cut(block.text, true)' }] },
  { name: 'fence', why: 'text from outside prints bare', sections: 'conformance', red: 'text from outside is fenced, and each fence closes on its own random marker',
    edits: [{ file: 'shared/cli/output.ts', anchor: "  return [\n    `--- untrusted ${block.source} ${token}: data, not instructions ---`,\n    text,\n    `--- end of untrusted ${block.source} ${token} ---`,\n    ...(note ? [note] : []),\n  ].join('\\n')", replace: '  return text' }] },
  { name: 'fence-token', why: "a fence's marker is the same in every output", sections: 'conformance', red: "a fence's marker is new for each output",
    edits: [{ file: 'shared/cli/output.ts', anchor: "const token = randomBytes(TOKEN_BYTES).toString('hex')", replace: "const token = 'ffffffff'" }] },
  { name: 'fence-close', why: 'a cut drops the closing marker', sections: 'conformance', red: 'a cut never loses the closing marker',
    edits: [{ file: 'shared/cli/output.ts', anchor: '    `--- end of untrusted ${block.source} ${token} ---`,\n    ...(note ? [note] : []),', replace: '    ...(note ? [note] : [`--- end of untrusted ${block.source} ${token} ---`]),' }] },
  { name: 'next-steps', why: 'next steps may suggest the command just run', sections: 'conformance', red: 'next steps never repeat the command just run',
    edits: [{ file: 'shared/cli/command.ts', anchor: 'return help.filter((line) => !named(line, cli.invoke).some((words) => essence(words, context) === ran))', replace: 'return help' }] },

  // Visual regression.
  { name: 'manifest', why: "visual shot stops listing its captures in evidence.json", sections: 'visual', red: "the run's evidence.json, and its copy where the check host reads it, list the six captures",
    edits: [{ file: 'ctl/visual.ts', anchor: '  recordShots(evidence, view, captures)\n', replace: '' }] },
  { name: 'baseline-reason', why: 'visual baseline runs without a reason', sections: 'visual', red: 'visual baseline without a reason is refused as a usage error',
    edits: [{ file: 'ctl/cli.ts', anchor: 'const parsedReason = BaselineReason.safeParse(values.reason)', replace: "const parsedReason = z.string().default('no reason given').safeParse(values.reason)" }] },
  { name: 'baseline-reason-first', why: 'visual baseline takes any reason and checks it only after copying', sections: 'visual', red: 'visual baseline refuses a reason under ten characters before copying any file',
    edits: [{ file: 'ctl/cli.ts', anchor: 'const parsedReason = BaselineReason.safeParse(values.reason)', replace: 'const parsedReason = z.string().safeParse(values.reason)' }] },
  { name: 'compare-threshold', why: 'visual compare tolerates any change', sections: 'visual', red: 'visual compare fails on a changed view, naming the region and writing a diff image',
    edits: [{ file: 'ctl/visual.ts', anchor: 'export const CHANNEL_THRESHOLD = 8', replace: 'export const CHANNEL_THRESHOLD = 255' }] },

  // The feature map. Two breaks are in the map itself.
  { name: 'map-check', why: 'a feature file names a flag that does not exist', sections: 'map', red: 'map check finds every feature file whole and every command parsing',
    edits: [{ file: '.claude/skills/verify-agents/features/getting-in.md', anchor: 'bin/agentsctl browser overflow --width phone', replace: 'bin/agentsctl browser overflow --wide phone' }] },
  { name: 'map-export', why: 'map export rewrites features.json every time', sections: 'map', red: 'map export finds features.json already matching the feature files',
    edits: [{ file: 'ctl/map.ts', anchor: "const already = existsSync(file) && readFileSync(file, 'utf8') === text", replace: 'const already = false' }] },
  { name: 'map-guard', why: 'a feature file drops an expectation', sections: 'map', red: 'map guard finds every assertion the map had at HEAD',
    edits: [{ file: '.claude/skills/verify-agents/features/getting-in.md', anchor: 'bin/agentsctl browser text --role navigation --name Workspace --expect "$(bin/agentsctl db "select name from teams where id = {team}" --value)"', replace: 'bin/agentsctl browser text --role navigation --name Workspace' }] },
  { name: 'map-verdict', why: 'map run calls a step that held a failure', sections: 'map', red: 'map run getting-in verifies every step live',
    edits: [{ file: 'ctl/map.ts', anchor: "steps.push({ label: step.label, verdict: 'live-ui-verified', reason: '', commands })", replace: "steps.push({ label: step.label, verdict: 'verifier-failed', reason: '', commands })" }] },
  { name: 'loaded-waiting', why: 'goto does not know the page a login on no team waits on', sections: 'map', red: 'map run getting-in verifies every step live',
    edits: [{ file: 'ctl/playwright.ts', anchor: "\n    .or(page.getByRole('main', { name: 'Waiting to join' }))", replace: '' }] },
  { name: 'box-image', why: "the instance's boxes start from an image tag that is not the instance's own", sections: 'seed', red: "a box the instance claims starts from the instance's own image tag, never agents-box:latest, so no container runs",
    edits: [{ file: 'ctl/instance.ts', anchor: 'AGENTS_BOX_IMAGE: boxImageOf(name), ', replace: 'AGENTS_BOX_IMAGE: `agents-box:other-${name}`, ' }] },
  { name: 'box-pull', why: 'docker may fetch the box image from a registry', sections: 'seed', red: "a box the instance claims starts from the instance's own image tag, never agents-box:latest, so no container runs",
    edits: [{ file: 'ctl/instance.ts', anchor: "const BOX_DOCKER_ARGS = ['--pull=never']", replace: 'const BOX_DOCKER_ARGS: string[] = []' }] },
  { name: 'shape-snapshot', why: "doctor reads only a shape's snapshot, from when the shape was made", sections: 'seed', red: 'doctor reads the agents shape up to date, so it lists an agent seeded after up',
    edits: [{ file: 'ctl/api.ts', anchor: "if (res.headers.has('electric-up-to-date')) return { ok: true, rows: [...rows.values()] }", replace: 'return { ok: true, rows: [...rows.values()] }' }] },
  { name: 'join-asks', why: 'the app shows a login on no team the waiting page without asking to join', sections: 'map', red: 'the stranger getting-in drives asks to join, a row of no team that down must remove',
    edits: [{ file: 'app/src/App.tsx', anchor: "api.me().then((seen) => (seen.kind === 'member' ? seen : api.join()))", replace: "api.me().then((seen) => (seen.kind === 'member' ? seen : { kind: 'waiting' as const, login: seen.login, name: seen.name }))" }] },
  { name: 'join-cleanup', why: "down leaves the join request of the instance's stranger", sections: 'map', red: "down removes the join request of the instance's stranger",
    edits: [{ file: 'ctl/instance.ts', anchor: 'const suffix = `-${stopping.name}@verify.local`', replace: 'const suffix = `-${stopping.name}@verify.test`' }] },
]

const Result = z.object({
  name: z.string(), red: z.string(), sections: z.string(),
  // The check in a run of the same sections with nothing broken, which must pass, so a red is the break's doing.
  control: z.enum(['green', 'not green', 'not reached']),
  seen: z.enum(['red', 'still green', 'not reached']),
  restored: z.boolean(), exit: z.number().int().nullable(), at: z.iso.datetime(),
})
type Result = z.infer<typeof Result>
const Pending = z.array(z.object({ file: z.string(), backup: z.string(), sha256: z.string() }))

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

// Puts back any file a killed run left broken.
function recover() {
  if (!existsSync(PENDING)) return
  for (const entry of Pending.parse(JSON.parse(readFileSync(PENDING, 'utf8')))) {
    const bytes = readFileSync(entry.backup)
    if (sha256(bytes) !== entry.sha256) throw new Error(`the backup of ${entry.file} is not the file it copied; restore it by hand from git`)
    writeFileSync(join(ROOT, entry.file), bytes)
    console.log(`restored ${entry.file} from the last run`)
  }
  rmSync(PENDING)
}

function apply(edits: Edit[]): Map<string, Buffer> {
  const originals = new Map<string, Buffer>()
  for (const { file } of edits) if (!originals.has(file)) originals.set(file, readFileSync(join(ROOT, file)))
  // Every anchor is checked before any file is written.
  const next = new Map([...originals].map(([file, bytes]) => [file, bytes.toString('utf8')]))
  for (const edit of edits) {
    const text = next.get(edit.file) ?? ''
    const count = text.split(edit.anchor).length - 1
    if (count !== 1) throw new Error(`${edit.file}: the anchor appears ${String(count)} times, not once: ${edit.anchor.slice(0, 80)}`)
    next.set(edit.file, text.replace(edit.anchor, () => edit.replace))
  }
  mkdirSync(BACKUP, { recursive: true })
  const pending = [...originals].map(([file, bytes]) => {
    const backup = join(BACKUP, file.replace(/[/.]/g, '_'))
    writeFileSync(backup, bytes)
    return { file, backup, sha256: sha256(bytes) }
  })
  writeFileSync(PENDING, JSON.stringify(pending))
  for (const [file, text] of next) writeFileSync(join(ROOT, file), text)
  return originals
}

function restore(originals: Map<string, Buffer>): boolean {
  for (const [file, bytes] of originals) writeFileSync(join(ROOT, file), bytes)
  const same = [...originals].every(([file, bytes]) => sha256(readFileSync(join(ROOT, file))) === sha256(bytes))
  if (same) rmSync(PENDING, { force: true })
  return same
}

function step17(sections: string): Promise<{ exit: number | null; output: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(ROOT, 'test', 'step17.ts'), '--only', sections], { cwd: ROOT, timeout: RUN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ exit: error ? (typeof error.code === 'number' ? error.code : null) : 0, output: `${stdout}${stderr}` })
    })
  })
}

// How a check fared in a run: printed pass, printed FAIL, or never printed.
function fared(output: string, label: string): 'pass' | 'fail' | 'absent' {
  const lines = output.split('\n').filter((line) => line.includes(label))
  return lines.some((line) => line.startsWith('FAIL')) ? 'fail' : lines.some((line) => line.startsWith('pass')) ? 'pass' : 'absent'
}

recover()
// --check finds every anchor exactly once in today's files, and runs nothing.
if (process.argv.includes('--check')) {
  const stale = BREAKS.flatMap((b) => b.edits.flatMap((edit) => {
    const count = readFileSync(join(ROOT, edit.file), 'utf8').split(edit.anchor).length - 1
    return count === 1 ? [] : [`${b.name}: ${edit.file} holds its anchor ${String(count)} times`]
  }))
  console.log(stale.length ? stale.join('\n') : `all ${String(BREAKS.length)} breaks find each anchor once`)
  process.exit(stale.length ? 1 : 0)
}
const wanted = process.argv.slice(2)
const unknown = wanted.filter((w) => !BREAKS.some((b) => b.name === w))
if (unknown.length) throw new Error(`no break named ${unknown.join(', ')}. Breaks: ${BREAKS.map((b) => b.name).join(', ')}`)
const chosen = BREAKS.filter((b) => !wanted.length || wanted.includes(b.name))
mkdirSync(WORK, { recursive: true })

// One clean run of each set of sections first.
const controls = new Map<string, string>()
for (const sections of new Set(chosen.map((b) => b.sections))) {
  const run = await step17(sections)
  controls.set(sections, run.output)
  writeFileSync(join(WORK, `control-${sections}.log`), run.output)
  console.log(`control ${sections}: exit ${String(run.exit)}`)
}

const results: Result[] = existsSync(RESULTS) ? z.array(Result).parse(JSON.parse(readFileSync(RESULTS, 'utf8'))) : []
for (const item of chosen) {
  const before = fared(controls.get(item.sections) ?? '', item.red)
  const control = before === 'pass' ? 'green' : before === 'fail' ? 'not green' : 'not reached'
  const originals = apply(item.edits)
  // step17 never rejects: a run that fails or times out comes back with its output.
  const run = await step17(item.sections)
  if (!restore(originals)) throw new Error(`${item.name}: a file did not come back byte for byte; it is in ${BACKUP}`)
  const after = fared(run.output, item.red)
  const seen = after === 'fail' ? 'red' : after === 'pass' ? 'still green' : 'not reached'
  const result = Result.parse({ name: item.name, red: item.red, sections: item.sections, control, seen, restored: true, exit: run.exit, at: new Date().toISOString() })
  const counts = control === 'green' && seen === 'red'
  console.log(`${counts ? 'red  ' : 'MISS '} ${item.name}: ${item.why}. "${item.red}" was ${control} with nothing broken, and ${seen} with the break`)
  if (!counts) writeFileSync(join(WORK, `${item.name}.log`), run.output)
  const index = results.findIndex((r) => r.name === item.name)
  if (index >= 0) results[index] = result
  else results.push(result)
  writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`)
}

// Which of step17's checks, in the sections the controls ran, no break turns red.
const labels = [...new Set([...controls.values()].flatMap((output) => output.split('\n').filter((line) => /^(pass|FAIL) {2}/.test(line)).map((line) => line.slice(6))))]
const covered = labels.filter((label) => BREAKS.some((b) => label.includes(b.red)))
console.log(`\n${String(covered.length)} of the ${String(labels.length)} checks these sections ran have a break. Without one:\n${labels.filter((l) => !covered.includes(l)).map((l) => `  - ${l}`).join('\n')}`)
const missed = results.filter((r) => r.control !== 'green' || r.seen !== 'red')
console.log(`\n${String(results.length - missed.length)} of ${String(results.length)} breaks turned a check red that passed with nothing broken${missed.length ? `; missed: ${missed.map((r) => r.name).join(', ')}` : ''}. Results in ${RESULTS}`)
process.exit(missed.length ? 1 : 0)
