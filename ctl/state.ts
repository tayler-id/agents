// An instance's state file, and its lifecycle as a typed state machine:
//
//   starting ──> ready ──> stopping ──> stopped
//       │                     ^
//       └──> failed ──────────┘
//
// A file can also sit in `starting` when `up` died part way, so `starting` may go
// straight to `stopping`. `down --keep-data` ends in `kept`, not `stopped`: the
// processes are gone and the team, forge repos and scratch folder stay. A later
// `down` takes `kept` back through `stopping`, which removes them.
//
// Each transition is a function whose parameter type is the phases it may leave,
// so the compiler refuses any other move, and writing a file checks the phase
// already on disk allows the move, so two commands racing on one instance cannot
// both act on it.

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { INSTANCES_DIR } from './config.ts'

export const InstanceName = z.string().regex(/^[a-z][a-z0-9-]{1,23}$/, 'an instance name is 2 to 24 lowercase letters, digits and dashes, starting with a letter').brand<'InstanceName'>()
export type InstanceName = z.infer<typeof InstanceName>
export const TeamId = z.uuid().brand<'TeamId'>()
export const PersonId = z.uuid().brand<'PersonId'>()
export const AgentId = z.uuid().brand<'AgentId'>()
export const InstanceId = z.uuid().brand<'InstanceId'>()
export const RepoId = z.uuid().brand<'RepoId'>()

export const Ports = z.object({ machines: z.number().int(), people: z.number().int(), streams: z.number().int() })
export type Ports = z.infer<typeof Ports>

export const Harness = z.enum(['fake', 'real'])
export type Harness = z.infer<typeof Harness>

// A process the instance started, with what tells it apart from a later process
// that reuses its pid: when it started, as ps prints it, and its command line.
export const ProcessRole = z.enum(['api', 'people', 'daemon', 'session'])
export type ProcessRole = z.infer<typeof ProcessRole>
export const ProcessRecord = z.object({
  role: ProcessRole, pid: z.number().int().positive(), started: z.string().min(1), argv: z.array(z.string()).min(1), log: z.string(),
})
export type ProcessRecord = z.infer<typeof ProcessRecord>

const Person = z.object({ id: PersonId, login: z.string() })
export const Seed = z.object({
  teamId: TeamId,
  owner: Person,
  teammate: Person,
  machine: z.object({ id: InstanceId, name: z.string(), token: z.string().startsWith('machine_') }),
  agents: z.record(z.string(), AgentId),
})
export type Seed = z.infer<typeof Seed>

// A repo the instance made on the shared forge, removed again by `down`.
export const ForgeRepo = z.object({ path: z.string().regex(/^[^/]+\/[^/]+$/), repoId: RepoId, role: z.enum(['shop', 'pipelines', 'extra']) })
export type ForgeRepo = z.infer<typeof ForgeRepo>

const Common = z.object({
  name: InstanceName,
  team: z.string().startsWith('verify-'),
  ports: Ports,
  // Folders for the daemon's home, the stream server and the browsers, removed by `down`.
  scratch: z.string(),
  // Where proof goes. `down` never removes it.
  evidence: z.string(),
  harness: Harness,
  pipelines: z.boolean(),
  createdAt: z.iso.datetime(),
  processes: z.array(ProcessRecord),
  forgeRepos: z.array(ForgeRepo),
  // What this instance made, and so may remove: its team and its forge org.
  // Another checkout's instance of the same name may own them otherwise.
  made: z.object({ team: z.boolean(), org: z.boolean() }),
})

const Starting = Common.extend({ phase: z.literal('starting'), seed: Seed.optional() })
const Ready = Common.extend({ phase: z.literal('ready'), seed: Seed, readyAt: z.iso.datetime() })
const Failed = Common.extend({ phase: z.literal('failed'), seed: Seed.optional(), error: z.string() })
const Stopping = Common.extend({ phase: z.literal('stopping'), seed: Seed.optional(), left: z.enum(['starting', 'ready', 'failed', 'kept']) })
export const Survivor = z.object({ pid: z.number().int(), command: z.string() })
const Stopped = Common.extend({
  phase: z.literal('stopped'), seed: Seed.optional(), stoppedAt: z.iso.datetime(),
  survivors: z.array(Survivor),
  removed: z.object({ team: z.boolean(), repos: z.array(z.string()), containers: z.array(z.string()), joinRequests: z.array(z.string()), scratch: z.boolean() }),
})
// Stopped by down --keep-data: nothing the instance made is removed.
const Kept = Common.extend({ phase: z.literal('kept'), seed: Seed.optional(), keptAt: z.iso.datetime(), survivors: z.array(Survivor) })

export const InstanceState = z.discriminatedUnion('phase', [Starting, Ready, Failed, Stopping, Stopped, Kept])
export type InstanceState = z.infer<typeof InstanceState>
export type StartingState = z.infer<typeof Starting>
export type ReadyState = z.infer<typeof Ready>
export type FailedState = z.infer<typeof Failed>
export type StoppingState = z.infer<typeof Stopping>
export type StoppedState = z.infer<typeof Stopped>
export type KeptState = z.infer<typeof Kept>
export type Phase = InstanceState['phase']

// Which phase may follow which. The transition functions below are typed to
// match, and `save` checks it against the file on disk.
export const NEXT = {
  starting: ['starting', 'ready', 'failed', 'stopping'],
  ready: ['ready', 'stopping'],
  failed: ['stopping'],
  stopping: ['stopping', 'stopped', 'kept'],
  kept: ['stopping'],
  stopped: [],
} as const satisfies Record<Phase, readonly Phase[]>

export const toReady = (state: StartingState, seed: Seed): ReadyState =>
  ({ ...state, phase: 'ready', seed, readyAt: new Date().toISOString() })
export const toFailed = (state: StartingState, error: string): FailedState => ({ ...state, phase: 'failed', error })
export const toStopping = (state: StartingState | ReadyState | FailedState | KeptState): StoppingState => ({ ...state, phase: 'stopping', left: state.phase })
export const toStopped = (state: StoppingState, outcome: Pick<StoppedState, 'survivors' | 'removed'>): StoppedState =>
  ({ ...state, ...outcome, phase: 'stopped', stoppedAt: new Date().toISOString() })
export const toKept = (state: StoppingState, outcome: Pick<KeptState, 'survivors'>): KeptState =>
  ({ ...state, ...outcome, phase: 'kept', keptAt: new Date().toISOString() })

export const stateFile = (name: InstanceName) => join(INSTANCES_DIR, `${name}.json`)

export function readState(name: InstanceName): InstanceState | null {
  const file = stateFile(name)
  if (!existsSync(file)) return null
  const parsed = InstanceState.safeParse(JSON.parse(readFileSync(file, 'utf8')))
  if (!parsed.success) throw new Error(`the state file ${file} does not parse: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

// Writes the state through a temporary file and a rename, so a reader never sees
// half a file, after checking the move from the phase on disk is allowed.
export function saveState(state: InstanceState, path = stateFile(state.name)) {
  mkdirSync(INSTANCES_DIR, { recursive: true })
  const current = path === stateFile(state.name) ? readState(state.name) : null
  if (current) {
    const allowed: readonly Phase[] = NEXT[current.phase]
    if (!allowed.includes(state.phase)) {
      throw new Error(`instance ${state.name} is ${current.phase} on disk, and cannot become ${state.phase}`)
    }
  }
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(InstanceState.parse(state), null, 2)}\n`)
  renameSync(temporary, path)
}

export function listStates(): InstanceState[] {
  if (!existsSync(INSTANCES_DIR)) return []
  return readdirSync(INSTANCES_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => readState(InstanceName.parse(f.slice(0, -'.json'.length))))
    .filter((s): s is InstanceState => s !== null)
}
