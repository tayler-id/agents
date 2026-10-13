// An instance's lifecycle: `up` starts an isolated API, daemon and app on the
// test database, `doctor` says whether it is worth driving, and `down` stops
// exactly what `up` and later commands started, then removes the instance's team
// and forge repos. Evidence survives `down`.

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import { z } from 'zod'
import { childEnv, config, EVIDENCE_DIR, LIVE_PORTS, redact, ROOT } from './config.ts'
import { withClient } from './db.ts'
import { call } from './api.ts'
import { claimPorts, releasePorts } from './ports.ts'
import { owned, spawnRecorded, stop, isOurs, type Owned } from './procs.ts'
import { removeForge, seedForge, seedTeam, writeScenario } from './seed.ts'
import { stopSessionServer } from './session-client.ts'
import {
  InstanceName, listStates, ProcessRecord, readState, saveState, stateFile, toFailed, toReady, toStopped, toStopping,
  type Harness, type InstanceState, type ReadyState, type StartingState, type StoppedState,
} from './state.ts'

const run = promisify(execFile)

// How long the API may take to answer after it starts: it applies migrations first.
const API_READY_MS = 60_000
// The daemon heartbeats as soon as it starts, then every 15 seconds.
const DAEMON_HEARTBEAT_MS = 15_000
const DAEMON_ONLINE_MS = 30_000
// The daemon stops its agents' sessions on SIGTERM and waits up to 10 seconds for them.
const STOP_GRACE_MS = 20_000
// Two replays per proposal keep an improve run to a few minutes.
const REPLAYS = 2
const LOOK_MS = 250
// The daemon claims a command as soon as sync delivers it, within a second or two.
const STUCK_COMMAND_S = 30
// How long doctor's browser waits for the app to show its workspace.
const USABLE_MS = 15_000

const Me = z.object({ person: z.object({ id: z.string(), login: z.string() }), team: z.object({ id: z.string(), name: z.string() }) })

async function until<T>(what: string, ms: number, look: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const found = await look()
    if (found !== null) return found
    if (Date.now() > deadline) throw new Error(`${what} within ${String(ms / 1000)} seconds`)
    await sleep(LOOK_MS)
  }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

export type UpOptions = { name?: InstanceName; port?: number; harness: Harness; pipelines: boolean; build: boolean }

export async function up(options: UpOptions): Promise<ReadyState> {
  config()
  const name = options.name ?? InstanceName.parse(`v${randomBytes(3).toString('hex')}`)
  const existing = readState(name)
  if (existing) throw new Error(`instance ${name} already exists (${existing.phase}). Stop it with: bin/agentsctl down --instance ${name}`)
  const ports = await claimPorts(name, options.port)
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), `agentsctl-${name}-`)))
  const evidence = join(EVIDENCE_DIR, `${name}-${stamp()}`)
  mkdirSync(evidence, { recursive: true })
  let state: StartingState = {
    phase: 'starting', name, team: `verify-${name}`, ports, scratch, evidence, harness: options.harness, pipelines: options.pipelines,
    createdAt: new Date().toISOString(), processes: [], forgeRepos: [],
  }
  saveState(state)
  try {
    const seed = await seedTeam(name, state.team)
    state = { ...state, seed }
    saveState(state)
    if (options.pipelines) {
      // Before the API starts, so its runner reads the pipelines when it first syncs.
      state = { ...state, forgeRepos: await seedForge(name, seed.teamId) }
      saveState(state)
    }
    if (options.build) await run(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
    if (!existsSync(join(ROOT, 'app', 'dist', 'index.html'))) throw new Error('the app is not built. Run up without --no-build.')

    const api = await spawnRecorded('api', [process.execPath, join(ROOT, 'server', 'api.ts')], {
      cwd: ROOT, log: join(evidence, 'api.log'),
      env: childEnv({
        AGENTS_RUNNER_TEAMS: state.team,
        AGENTS_API_PORT: String(ports.machines), AGENTS_PEOPLE_PORT: String(ports.people), AGENTS_STREAMS_PORT: String(ports.streams),
        AGENTS_STREAMS_DIR: join(scratch, 'streams'), AGENTS_HOME: join(scratch, 'server'),
        // Boxes an instance starts never get the team's Claude token.
        AGENTS_BOX_TOKEN_FILE: join(scratch, 'no-box-claude-token'),
        AGENTS_REPLAYS: String(REPLAYS),
      }),
    })
    state = { ...state, processes: [...state.processes, api] }
    saveState(state)
    const ready = toReady(state, seed)
    await until(`the API did not answer /v1/me for ${seed.owner.login} (see ${api.log})`, API_READY_MS, async () => {
      const reply = await call(ready, { method: 'GET', path: '/v1/me', as: 'person' }).catch(() => null)
      const me = reply?.status === 200 ? Me.safeParse(reply.body) : null
      return me?.success && me.data.team.name === state.team ? true : null
    })

    const daemonEnv = childEnv({ AGENTS_API: `http://127.0.0.1:${String(ports.machines)}`, AGENTS_TOKEN: seed.machine.token, AGENTS_HOME: join(scratch, 'daemon') })
    if (options.harness === 'fake') {
      writeScenario(join(scratch, 'scenario.json'))
      daemonEnv.AGENTS_CLAUDE_BIN = join(ROOT, 'test', 'fake-claude.ts')
      daemonEnv.AGENTS_FAKE_SCENARIO = join(scratch, 'scenario.json')
    } else {
      // A real session runs `claude` from the PATH, whatever the shell had set for checks.
      delete daemonEnv.AGENTS_CLAUDE_BIN
      delete daemonEnv.AGENTS_FAKE_SCENARIO
    }
    const daemon = await spawnRecorded('daemon', [process.execPath, join(ROOT, 'daemon', 'agentsd.ts')], { cwd: ROOT, env: daemonEnv, log: join(evidence, 'daemon.log') })
    state = { ...state, processes: [...state.processes, daemon] }
    saveState(state)
    await until(`the daemon did not come online (see ${daemon.log})`, DAEMON_ONLINE_MS, async () => (await machineStatus(seed.machine.id)).status === 'online' ? true : null)

    const done = toReady(state, seed)
    saveState(done)
    return done
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    saveState(toFailed(state, message))
    await down(name, { keepData: false })
    throw new Error(`up failed and was undone: ${message}. Evidence is in ${evidence}`)
  }
}

const MachineRow = z.object({ status: z.string(), last_seen_at: z.date().nullable() })

async function machineStatus(machineId: string) {
  return withClient(async (client) => {
    const row = MachineRow.parse((await client.query('select status, last_seen_at from instances where id = $1', [machineId])).rows[0])
    return { status: row.status, seenMsAgo: row.last_seen_at ? Date.now() - row.last_seen_at.getTime() : null }
  })
}

// The instance a command means: the one named, or the only one this checkout has running.
export function resolve(name: InstanceName | undefined): InstanceState {
  if (name) {
    const state = readState(name)
    if (!state) throw new Error(`no instance named ${name} in this checkout. Start one with: bin/agentsctl up --instance ${name}`)
    return state
  }
  const live = listStates().filter((s) => s.phase !== 'stopped')
  const [only] = live
  if (only && live.length === 1) return only
  if (!live.length) throw new Error('no instance is running in this checkout. Start one with: bin/agentsctl up')
  throw new Error(`several instances are running (${live.map((s) => s.name).join(', ')}). Say which with --instance.`)
}

export function ready(name: InstanceName | undefined): ReadyState {
  const state = resolve(name)
  if (state.phase !== 'ready') throw new Error(`instance ${state.name} is ${state.phase}, not ready. Run bin/agentsctl doctor --instance ${state.name}`)
  return state
}

export const Check = z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })
export type Check = z.infer<typeof Check>

async function listener(port: number): Promise<number | null> {
  try {
    const out = (await run('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-t'])).stdout.trim()
    return out ? Number(out.split('\n')[0]) : null
  } catch (error) {
    // lsof exits 1 when nothing listens there.
    if (error instanceof Error && 'code' in error && error.code === 1) return null
    throw error
  }
}

function newest(dir: string): number {
  return Math.max(...readdirSync(dir, { withFileTypes: true }).map((e) => {
    const path = join(dir, e.name)
    return e.isDirectory() ? newest(path) : statSync(path).mtimeMs
  }))
}

// Ready means usable, not only that a port answers: the app renders in a browser
// as the instance's owner, with its team and agents in the sidebar. A browser of
// its own, closed again, so doctor starts nothing that outlives it.
async function appUsable(state: ReadyState): Promise<{ ok: boolean; detail: string }> {
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ baseURL: `http://127.0.0.1:${String(state.ports.people)}`, extraHTTPHeaders: { 'tailscale-user-login': state.seed.owner.login } })
    const page = await context.newPage()
    await page.goto('/')
    const sidebar = page.getByRole('navigation', { name: 'Workspace' })
    await sidebar.waitFor({ timeout: USABLE_MS })
    // The sidebar's lists load after the sidebar shows, so each agent gets the same time to appear.
    const agents = page.getByRole('list', { name: 'Agents' })
    const missing: string[] = []
    for (const name of Object.keys(state.seed.agents)) {
      const shown = await agents.getByRole('button', { name, exact: true }).waitFor({ timeout: USABLE_MS }).then(() => true, () => false)
      if (!shown) missing.push(name)
    }
    const text = await sidebar.innerText()
    const ok = text.includes(state.team) && !missing.length
    return { ok, detail: ok ? `the app opens for ${state.seed.owner.login} on ${state.team}, with ${Object.keys(state.seed.agents).join(', ')} in the sidebar` : `the app opened, but ${missing.length ? `the sidebar lacks ${missing.join(', ')}` : `shows no ${state.team}`}` }
  } catch (error) {
    return { ok: false, detail: `the app did not render its workspace: ${(error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''}` }
  } finally {
    await browser.close()
  }
}

// Read-only: answers whether this instance is worth driving. Changes nothing.
export async function doctor(name: InstanceName | undefined): Promise<{ instance: string; ok: boolean; checks: Check[] }> {
  const state = resolve(name)
  const checks: Check[] = []
  const add = (check: string, ok: boolean, detail: string) => { checks.push({ name: check, ok, detail }) }
  add('phase', state.phase === 'ready', `the instance is ${state.phase}${state.phase === 'failed' ? `: ${state.error}` : ''}`)
  try {
    const { DATABASE_URL } = config()
    add('test database', true, `${redact(DATABASE_URL)}, the database .env.test names`)
  } catch (error) {
    add('test database', false, error instanceof Error ? error.message : String(error))
  }
  const livePort = Object.values(state.ports).find((p) => LIVE_PORTS.includes(p))
  add('not live', livePort === undefined, livePort === undefined ? `ports ${Object.values(state.ports).join(', ')} are the instance's own` : `port ${String(livePort)} is the live system's`)
  for (const record of state.processes) {
    const ours = await isOurs(record)
    add(`${record.role} process`, ours, ours ? `pid ${String(record.pid)} is running ${record.argv.slice(1).join(' ')}` : `pid ${String(record.pid)} is gone, or is another program now. Its log is ${record.log}`)
  }
  const api = state.processes.find((p) => p.role === 'api')
  for (const [door, port] of [['machine door', state.ports.machines], ['people door', state.ports.people], ['stream server', state.ports.streams]] as const) {
    const pid = await listener(port)
    add(door, pid !== null && pid === api?.pid, pid === null ? `nothing listens on ${String(port)}` : pid === api?.pid ? `the API (pid ${String(pid)}) listens on ${String(port)}` : `pid ${String(pid)} listens on ${String(port)}, not the instance's API`)
  }
  if (state.phase === 'ready') {
    const me = await call(state, { method: 'GET', path: '/v1/me', as: 'person' }).catch((error: unknown) => ({ status: 0, body: error instanceof Error ? error.message : String(error) }))
    const parsed = Me.safeParse(me.body)
    add('people door answers', parsed.success && parsed.data.team.name === state.team, parsed.success ? `${parsed.data.person.login} is on ${parsed.data.team.name}` : `GET /v1/me answered ${String(me.status)}: ${JSON.stringify(me.body)}`)
    const shape = await call(state, { method: 'GET', path: '/v1/shape/agents?offset=-1', as: 'person' }).catch(() => ({ status: 0, body: null }))
    const agents = JSON.stringify(shape.body)
    const seeded = Object.keys(state.seed.agents)
    add('Electric', shape.status === 200 && seeded.every((a) => agents.includes(`"name":"${a}"`)), shape.status === 200 ? `the agents shape lists ${seeded.join(', ')}` : `the agents shape answered ${String(shape.status)}`)
    const commands = await call(state, { method: 'GET', path: '/v1/shape/commands?offset=-1', as: 'machine' }).catch(() => ({ status: 0, body: null }))
    add('machine token', commands.status === 200, commands.status === 200 ? "the machine's token reads its command queue" : `the command queue answered ${String(commands.status)}`)
    const machine = await machineStatus(state.seed.machine.id)
    const fresh = machine.status === 'online' && machine.seenMsAgo !== null && machine.seenMsAgo < 2 * DAEMON_HEARTBEAT_MS + 5_000
    add('daemon online', fresh, `the machine ${state.seed.machine.name} is ${machine.status}${machine.seenMsAgo === null ? '' : `, seen ${String(Math.round(machine.seenMsAgo / 1000))}s ago`}`)
    const stuck = await withClient(async (client) => z.object({ n: z.number() }).parse((await client.query(
      `select count(*)::int as n from commands where instance_id = $1 and status = 'queued' and created_at < now() - make_interval(secs => $2)`,
      [state.seed.machine.id, STUCK_COMMAND_S])).rows[0]).n)
    add('daemon takes commands', stuck === 0, stuck ? `${String(stuck)} commands have waited more than ${String(STUCK_COMMAND_S)}s for the machine. Its log is ${state.processes.find((p) => p.role === 'daemon')?.log ?? 'missing'}` : 'nothing waits on the machine')
    const page = await call(state, { method: 'GET', path: '/', as: 'person' }).catch(() => ({ status: 0, body: '' }))
    add('app served', page.status === 200 && JSON.stringify(page.body).includes('<title>Agents</title>'), `GET / answered ${String(page.status)}`)
    const usable = await appUsable(state)
    add('app usable', usable.ok, usable.detail)
    const built = join(ROOT, 'app', 'dist', 'index.html')
    const stale = existsSync(built) && newest(join(ROOT, 'app', 'src')) > statSync(built).mtimeMs
    add('app build', existsSync(built) && !stale, stale ? 'app/src changed after the last build. Run bin/agentsctl down, then up (which builds), to see your change.' : 'app/dist is newer than app/src')
    add('harness', state.harness === 'real' || existsSync(join(state.scratch, 'scenario.json')), state.harness === 'fake' ? 'the fake Claude harness, following its scenario' : 'real Claude sessions')
  }
  return { instance: state.name, ok: checks.every((c) => c.ok), checks }
}

const docker = async (...args: string[]) => (await run('docker', args)).stdout.trim()
async function dockerHas(kind: 'container' | 'volume', name: string): Promise<boolean> {
  try {
    await docker(kind, 'inspect', name)
    return true
  } catch (error) {
    // docker exits 1 when there is no such container or volume.
    if (error instanceof Error && 'code' in error && error.code === 1) return false
    throw error
  }
}

// Stops what the instance started and removes what it made, leaving its evidence.
export async function down(name: InstanceName | undefined, options: { keepData: boolean }): Promise<StoppedState> {
  const state = resolve(name)
  if (state.phase === 'stopped') throw new Error(`instance ${state.name} is already stopped`)
  const stopping = state.phase === 'stopping' ? state : toStopping(state)
  saveState(stopping)
  // The browsers and desktop apps the session opened, recorded in case the session itself died first.
  const childrenFile = join(stopping.scratch, 'session-children.json')
  const children = existsSync(childrenFile) ? z.array(ProcessRecord).parse(JSON.parse(readFileSync(childrenFile, 'utf8'))) : []
  const found: Owned[] = await owned([...stopping.processes, ...children])
  if (stopping.processes.some((p) => p.role === 'session')) await stopSessionServer(stopping)
  // The daemon first, so it can say it is going offline while the API still listens.
  const order: ProcessRecord['role'][] = ['session', 'daemon', 'api']
  for (const role of order) {
    const record = stopping.processes.find((p) => p.role === role)
    if (record && await isOurs(record)) await stop(found.filter((p) => p.pid === record.pid), STOP_GRACE_MS)
  }
  const survivors = await stop(found, STOP_GRACE_MS)
  const removed: StoppedState['removed'] = { team: false, repos: [], containers: [], scratch: false }
  if (!options.keepData) {
    const seed = stopping.seed
    if (seed) {
      const boxes = await withClient(async (client) => z.array(z.object({ id: z.string() }))
        .parse((await client.query(`select id from instances where team_id = $1 and kind = 'box'`, [seed.teamId])).rows))
      for (const box of boxes) {
        // The names server/boxes.ts gives a box's container and its home volume.
        for (const [kind, thing] of [['container', `agents-box-${box.id}`], ['volume', `agents-box-${box.id}-home`]] as const) {
          if (!(await dockerHas(kind, thing))) continue
          await docker(kind === 'container' ? 'rm' : 'volume', ...(kind === 'container' ? ['-f', thing] : ['rm', thing]))
          removed.containers.push(thing)
        }
      }
    }
    if (stopping.pipelines || stopping.forgeRepos.length) removed.repos = await removeForge(stopping.name)
    const team = stopping.team
    removed.team = await withClient(async (client) => {
      const { rowCount } = await client.query('delete from teams where name = $1', [team])
      return rowCount !== null && rowCount > 0
    })
    rmSync(stopping.scratch, { recursive: true, force: true })
    removed.scratch = true
  }
  releasePorts(stopping.ports, stopping.name)
  const stopped = toStopped(stopping, { survivors: survivors.map((s) => ({ pid: s.pid, command: s.command })), removed })
  // The final state goes with the evidence, and the instance leaves this checkout's list.
  saveState(stopped)
  mkdirSync(stopping.evidence, { recursive: true })
  renameSync(stateFile(stopping.name), join(stopping.evidence, 'instance.json'))
  return stopped
}

export function list(): InstanceState[] {
  return listStates()
}
