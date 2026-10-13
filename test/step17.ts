// Step 17, the verification tool. Runs bin/agentsctl the way the verify-agents
// skill tells an agent to: up, doctor, drive the web app, the desktop app, the
// API and the database, capture evidence, compare visual captures, run a
// feature of the map, and down. Every subcommand has a check, and the run fails
// if any evidence is missing after down or any process it started outlives it.
//   node --env-file=.env --env-file=.env.test test/step17.ts

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { EVIDENCE_MANIFEST, EVIDENCE_MANIFEST_FILE } from '../shared/evidence.ts'
import { Output } from '../ctl/output.ts'
import { decode } from '../ctl/png.ts'
import { isOurs, owned, stop, type Owned } from '../ctl/procs.ts'
import { InstanceState, ProcessRecord, stateFile, type InstanceName } from '../ctl/state.ts'
import { MapReport } from '../ctl/map.ts'
import { CompareResult } from '../ctl/visual.ts'
import { Found } from '../ctl/protocol.ts'
import { Rows } from '../ctl/db.ts'

const ROOT = new URL('..', import.meta.url).pathname
const exec = promisify(execFile)
const name = `s17-${randomBytes(3).toString('hex')}`
const failures: string[] = []
// Processes that must stop with down, gathered just before it.
let started: Owned[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

// One agentsctl command, as an agent runs it, read through the shared envelope.
async function ctl(args: string[], options: { instance?: boolean } = {}): Promise<{ code: number; out: Output }> {
  const argv = [join(ROOT, 'ctl', 'main.ts'), ...args, ...(options.instance === false ? [] : ['--instance', name]), '--json']
  const result = await exec(process.execPath, argv, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).then(
    (r) => ({ code: 0, stdout: r.stdout }),
    (error: unknown) => {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'number' ? error.code : -1
      const stdout = error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
      return { code, stdout }
    })
  const out = Output.safeParse(JSON.parse(result.stdout || 'null'))
  if (!out.success) throw new Error(`agentsctl ${args.join(' ')} printed no envelope (exit ${String(result.code)}): ${result.stdout.slice(0, 500)}`)
  if (!out.data.ok) console.log(`      ${args.slice(0, 2).join(' ')}: ${out.data.head}`)
  return { code: result.code, out: out.data }
}

const evidenceOf = () => {
  const state = InstanceState.parse(JSON.parse(readFileSync(stateFile(name as InstanceName), 'utf8')))
  return state
}

try {
  // Launch, idempotent, and refusing to replace a different instance.
  const up = await ctl(['up', '--pipelines'])
  const ready = InstanceState.safeParse(up.out.data)
  const state = ready.success && ready.data.phase === 'ready' ? ready.data : null
  check(up.code === 0 && state && state.team === `verify-${name}` && state.ports.machines >= 8020 && state.ports.streams <= 8039 && up.out.head.startsWith(`ok: up ${name} -> ready`),
    'up starts an instance on its own ports in 8020-8039, with a team of its own, and says it is ready')
  if (!state) throw new Error('up did not start an instance, so nothing else can run')
  const again = await ctl(['up', '--pipelines'])
  check(again.code === 0 && again.out.already, 'up again changes nothing and says already: true')
  const other = await ctl(['up', '--claude', 'real'])
  check(other.code === 3 && !other.out.ok && other.out.help.some((h) => h.includes(`down --instance ${name}`)), 'up with other flags on the same name is refused with exit 3, and says to run down first')

  // Doctor, and the dashboard.
  const doctor = await ctl(['doctor'])
  check(doctor.code === 0 && doctor.out.head.includes('is usable') && doctor.out.detail.includes('pass  app usable'), 'doctor passes every check, ending with the app rendering as its owner')
  const dashboard = await ctl([], { instance: false })
  check(dashboard.code === 0 && dashboard.out.detail.includes(`${name},ready`) && dashboard.out.detail.includes('answers'), 'agentsctl alone shows the instance, ready and answering')

  // A dry run parses and acts on nothing.
  const actionsBefore = readFileSync(join(state.evidence, 'actions.jsonl'), 'utf8').split('\n').length
  const dry = await ctl(['browser', 'click', '--role', 'button', '--name', 'New room', '--dry-run'])
  const actionsAfter = readFileSync(join(state.evidence, 'actions.jsonl'), 'utf8').split('\n').length
  check(dry.code === 0 && dry.out.head.startsWith('dry run') && actionsAfter === actionsBefore, '--dry-run parses a drive, names the instance, and runs nothing')

  // The web app, by role and name, with the side effect read back.
  await ctl(['browser', 'goto', '/'])
  await ctl(['browser', 'click', '--role', 'button', '--name', 'fixer', '--within', 'list:Agents'])
  await ctl(['browser', 'fill', '--role', 'textbox', '--name', 'Message', '--value', 'Step 17 says hello'])
  await ctl(['browser', 'press', 'Enter', '--role', 'textbox', '--name', 'Message'])
  const replied = await ctl(['browser', 'wait', '--role', 'listitem', '--text', 'fake reply', '--within', 'list:Messages', '--timeout', '30'])
  check(replied.code === 0 && replied.out.ok, 'browser drives a DM by role and name, and the reply arrives')
  const rows = await ctl(['db', "select m.speaker, m.body from messages m join conversations c on c.id = m.conversation_id where c.team_id = {team} order by m.seq desc limit 1", '--wait', '15', '--expect', 'speaker=agent'])
  const latest = Rows.safeParse(z.object({ rows: z.unknown() }).safeParse(rows.out.data).data?.rows)
  check(rows.code === 0 && latest.success && latest.data[0]?.body === 'fake reply', 'db reads the reply back from the record')
  const write = await ctl(['db', 'update teams set name = name where id = {team}'])
  check(write.code === 3 && !write.out.ok, 'db refuses a write with exit 3')

  // Captures and checks of the view.
  const snapshot = Found.safeParse((await ctl(['browser', 'snapshot', '--aria', '--label', 'dm'])).out.data)
  const snapshotFile = snapshot.success ? snapshot.data.files[0] : undefined
  check(snapshotFile && existsSync(snapshotFile) && readFileSync(snapshotFile, 'utf8').includes('heading "fixer"'), 'snapshot --aria writes the page tree, with the conversation\'s heading')
  const shot = Found.safeParse((await ctl(['browser', 'screenshot', '--label', 'dm'])).out.data)
  const shotFile = shot.success ? shot.data.files[0] : undefined
  const image = shotFile && existsSync(shotFile) ? decode(readFileSync(shotFile)) : null
  check(image && image.width === 1280 && image.height === 820, 'screenshot writes a PNG of the 1280x820 page')
  check((await ctl(['browser', 'console'])).out.ok, 'console finds no page error or console error from the app')
  await ctl(['browser', 'goto', '/', '--width', 'phone'])
  check((await ctl(['browser', 'overflow', '--width', 'phone'])).out.ok, 'overflow finds no sideways scrolling at phone width')
  check((await ctl(['browser', 'a11y'])).out.ok, 'a11y finds no serious or critical violation on the DM')
  await ctl(['browser', 'network'])
  await ctl(['browser', 'click', '--role', 'button', '--name', 'Agent setup'])
  await ctl(['browser', 'wait', '--role', 'heading', '--name', 'fixer', '--within', 'region:Agent'])
  await ctl(['browser', 'goto', '#/a/' + ((await ctl(['db', "select id from agents where team_id = {team} and name = 'fixer'", '--value'])).out.head)])
  const network = await ctl(['browser', 'network'])
  const requests = Found.safeParse(network.out.data)
  check(network.out.ok && requests.success && (requests.data.network ?? []).length > 0, 'network lists the requests of a fresh load of the agent page, and none failed')
  await ctl(['browser', 'trace', 'start'])
  await ctl(['browser', 'goto', '/'])
  const trace = Found.safeParse((await ctl(['browser', 'trace', 'stop'])).out.data)
  const traceFile = trace.success ? trace.data.files[0] : undefined
  check(traceFile && existsSync(traceFile) && readFileSync(traceFile).length > 1000, 'trace start, then stop, writes a trace of the page')
  await ctl(['browser', 'record', 'start', '--label', 'step 17'])
  await ctl(['browser', 'click', '--role', 'button', '--name', 'writer', '--within', 'list:Agents'])
  const video = Found.safeParse((await ctl(['browser', 'record', 'stop'])).out.data)
  const videoFile = video.success ? video.data.files[0] : undefined
  check(videoFile && existsSync(videoFile) && readFileSync(videoFile).length > 1000, 'record start, then stop, keeps a video of the steps')

  // The desktop app, the API and seeds.
  await ctl(['desktop', 'goto', '/'])
  check((await ctl(['desktop', 'text', '--role', 'navigation', '--name', 'Workspace', '--expect', state.team])).out.ok, 'desktop opens the team in the Electron app')
  const me = await ctl(['api', 'GET', '/v1/me'])
  const door = await ctl(['api', 'GET', '/v1/me', '--door', 'machines', '--expect', '400', '--expect-text', 'people connect through Tailscale'])
  check(me.out.ok && JSON.stringify(me.out.data).includes(state.team) && door.out.ok, 'api calls as a person, and the machine door refuses a person with 400')
  check((await ctl(['api', 'GET', '/v1/shape/commands?offset=-1', '--as', 'machine'])).out.ok, 'api as the machine reads its command queue with its token')
  const seeded = await ctl(['seed', 'person', 'cy'])
  const reseeded = await ctl(['seed', 'person', 'cy'])
  await ctl(['browser', 'goto', '/', '--as', 'cy'])
  const cy = await ctl(['browser', 'text', '--role', 'navigation', '--name', 'Workspace', '--as', 'cy', '--expect', `cy-${name}@verify.local`])
  check(seeded.out.ok && !seeded.out.already && reseeded.out.already && cy.out.ok, 'seed person adds cy, who can open the app, and seeding again says already: true')

  // Visual regression, against a baselines folder of the check's own.
  const baselines = mkdtempSync(join(tmpdir(), 'step17-baselines-'))
  await ctl(['browser', 'goto', '/'])
  await ctl(['browser', 'click', '--role', 'button', '--name', 'fixer', '--within', 'list:Agents'])
  const capture = await ctl(['visual', 'shot', 'dm', '--ready-role', 'listitem', '--ready-text', 'fake reply'])
  const captured = Found.safeParse(capture.out.data)
  check(capture.out.ok && captured.success && captured.data.files.length === 6 && captured.data.files.every((f) => existsSync(f)), 'visual shot captures the view in three engines at two widths, each checked')
  const manifests = [join(state.evidence, EVIDENCE_MANIFEST_FILE), join(ROOT, '.scratch', 'verify', EVIDENCE_MANIFEST_FILE)].map((file) => EVIDENCE_MANIFEST.safeParse(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null))
  check(manifests.every((m) => m.success && m.data.shots.filter((s) => s.view === 'dm').length === 6
    && m.data.shots.every((s) => createHash('sha256').update(readFileSync(join(ROOT, s.path))).digest('hex') === s.sha256)),
    'the run\'s evidence.json, and its copy where the check host reads it, list the six captures with each file\'s sha256')
  const noReason = await ctl(['visual', 'baseline', '--baselines', baselines])
  check(noReason.code === 2, 'visual baseline without a reason is refused as a usage error')
  await ctl(['visual', 'baseline', '--reason', 'step 17 makes its own baselines', '--baselines', baselines])
  const same = CompareResult.safeParse((await ctl(['visual', 'compare', '--baselines', baselines])).out.data)
  check(same.success && same.data.ok && same.data.results.length === 6 && same.data.results.every((r) => r.status === 'same'), 'visual compare passes a capture against the baseline it just made')
  await ctl(['browser', 'fill', '--role', 'textbox', '--name', 'Message', '--value', 'A change the baseline does not have'])
  await ctl(['browser', 'press', 'Enter', '--role', 'textbox', '--name', 'Message'])
  await ctl(['browser', 'wait', '--role', 'listitem', '--text', 'A change the baseline does not have', '--within', 'list:Messages'])
  await ctl(['db', "select m.speaker from messages m join conversations c on c.id = m.conversation_id where c.team_id = {team} order by m.seq desc limit 1", '--wait', '15', '--expect', 'speaker=agent'])
  await ctl(['visual', 'shot', 'dm', '--ready-role', 'listitem', '--ready-text', 'A change the baseline does not have'])
  const changed = await ctl(['visual', 'compare', '--baselines', baselines])
  const diff = CompareResult.safeParse(changed.out.data)
  const desktopDiff = diff.success ? diff.data.results.find((r) => r.engine === 'chromium' && r.width === 'desktop') : undefined
  check(changed.code === 1 && desktopDiff?.status === 'different' && desktopDiff.regions.length > 0 && desktopDiff.diff && existsSync(desktopDiff.diff),
    'visual compare fails on a changed view, naming the region and writing a diff image')
  rmSync(baselines, { recursive: true, force: true })

  // The feature map.
  check((await ctl(['map', 'check'], { instance: false })).out.ok, 'map check finds every feature file whole and every command parsing')
  const mapRun = MapReport.safeParse((await ctl(['map', 'run', 'getting-in'])).out.data)
  check(mapRun.success && mapRun.data.features[0]?.verdict === 'live-ui-verified' && mapRun.data.features[0].steps.every((s) => s.verdict === 'live-ui-verified'),
    'map run getting-in verifies every step live')

  // Doctor notices a stopped daemon.
  const current = evidenceOf()
  const daemon = current.processes.find((p) => p.role === 'daemon')
  if (daemon) await stop([{ pid: daemon.pid, started: daemon.started, command: daemon.argv.join(' ') }], 20_000)
  const sick = await ctl(['doctor'])
  check(sick.code === 1 && sick.out.head.includes('daemon process'), 'doctor fails once the daemon stops, and names it')

  // Down: nothing it started survives, and the evidence stays.
  const latestState = evidenceOf()
  const childrenFile = join(latestState.scratch, 'session-children.json')
  const children = existsSync(childrenFile) ? z.array(ProcessRecord).parse(JSON.parse(readFileSync(childrenFile, 'utf8'))) : []
  started = await owned([...latestState.processes, ...children])
  const down = await ctl(['down'])
  let alive = 0
  for (const p of started) if (await isOurs({ pid: p.pid, started: p.started, argv: [p.command] })) alive++
  check(down.code === 0 && started.length >= 3 && alive === 0, `down stops every process the run started (${String(started.length)} found before, ${String(alive)} alive after)`)
  const evidence = latestState.evidence
  const kept = ['actions.jsonl', 'api.log', 'daemon.log', 'session.log', 'instance.json'].every((f) => existsSync(join(evidence, f)))
    && ['aria', 'screens', 'videos', 'traces', 'visual', 'visual-diff', 'map'].every((d) => existsSync(join(evidence, d)) && readdirSync(join(evidence, d)).length > 0)
  check(kept, 'down keeps the evidence: the action log, logs, final state, captures, video, trace and map report')
  const team = await ctl(['db', `select count(*)::int as n from teams where name = 'verify-${name}'`])
  check(!existsSync(stateFile(name as InstanceName)) && team.code === 1, 'down removes the instance from this checkout and its team from the database')
  const downAgain = await ctl(['down'])
  check(downAgain.code === 0 && downAgain.out.already, 'down again changes nothing and says already: true')
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  // Whatever happened, leave nothing running: down, then any process it missed, checked by start time.
  if (existsSync(stateFile(name as InstanceName))) await ctl(['down'])
  const survivors = []
  for (const p of started) if (await isOurs({ pid: p.pid, started: p.started, argv: [p.command] })) survivors.push(p)
  if (survivors.length) await stop(survivors, 10_000)
}

console.log(`\n${failures.length ? `${String(failures.length)} failed` : 'all passed (the instance is down and its team removed)'}`)
process.exit(failures.length ? 1 : 0)
