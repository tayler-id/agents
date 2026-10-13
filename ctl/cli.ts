// agentsctl's command line. Each command parses its arguments with zod first,
// then runs, so `map check` and `--dry-run` can parse a command without running
// it. Output follows output.ts: a write leads with `ok:`, a read with its
// answer, a failure with `error:` and its exit code, and each ends with next
// steps. runCli is what bin/agentsctl runs, and what `map run` calls for each
// command in the feature map.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { BASELINES_DIR, EVIDENCE_DIR, ROOT } from './config.ts'
import { bind, readOnly, withClient, type Rows } from './db.ts'
import { call, Caller, Door, Method } from './api.ts'
import { actions, nextPath, record } from './evidence.ts'
import { doctor, down, list, ready, resolve, up } from './instance.ts'
import { isOurs } from './procs.ts'
import { ENGINE, WIDTH } from '../shared/evidence.ts'
import { Role, type Found, type Handle, type Op, type Target } from './protocol.ts'
import { sessionCall, stopSessionServer } from './session-client.ts'
import { addAgent, addBox, addPerson, AGENTS, seedExtraRepo } from './seed.ts'
import { Harness, InstanceName, readState, saveState, type InstanceState, type ReadyState } from './state.ts'
import { baseline, compare } from './visual.ts'
import { checkMap, exportMap, guardMap, listMap, runMap } from './map.ts'
import { CliError, EXIT, Json, Refused, UsageError, type Output } from './output.ts'

type Result = {
  ok: boolean
  head: string
  detail?: string
  help: string[]
  already?: boolean
  files: string[]
  data: unknown
  evidence?: string
  // The exit code of a result that is not ok: failed (1) by default.
  code?: typeof EXIT.failed | typeof EXIT.refused
}
type Options = NonNullable<Parameters<typeof parseArgs>[0]>['options']
// A command: parse checks the arguments and returns what runs it, touching nothing.
type Command = { parse: (args: string[]) => () => Promise<Result> }

// How long a browser step waits for its element by default: long enough for
// Electric to deliver a row and React to render it on a busy laptop.
const DEFAULT_TIMEOUT_S = 15
// How often `db --wait` and `machine read` look again.
const POLL_MS = 500
// How many Tab presses `tab-to` tries before it says the element is out of reach.
const DEFAULT_MAX_TABS = 40
// How many evidence folders the dashboard lists.
const RECENT_EVIDENCE = 5

const run = (command: string, why: string) => `Run \`bin/agentsctl ${command}\` ${why}`
const at = (state: { name: string }) => ` --instance ${state.name}`

const COMMON: Options = { instance: { type: 'string' }, json: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, full: { type: 'boolean' } }
const Common = z.object({ instance: InstanceName.optional(), json: z.boolean().optional(), 'dry-run': z.boolean().optional(), full: z.boolean().optional() })

function parse<S extends z.ZodType>(args: string[], options: Options, schema: S): { values: z.infer<S>; positionals: string[] } {
  let parsed
  try {
    parsed = parseArgs({ args, options: { ...COMMON, ...options }, allowPositionals: true, strict: true })
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const values = schema.safeParse(parsed.values)
  if (!values.success) throw new UsageError(z.prettifyError(values.error))
  return { values: values.data, positionals: parsed.positionals }
}

const toJson = (value: unknown): Json => Json.parse(JSON.parse(JSON.stringify(value ?? null)))

// A person on the instance: ada (who started it), ben (a teammate), anyone
// added with `seed person <who>`, or a full login.
export function loginFor(state: ReadyState, who: string | undefined): string {
  if (who === undefined) return state.seed.owner.login
  if (who.includes('@')) return who
  return `${who}-${state.name}@verify.local`
}

// --role, --name and --text name one element. --within role:name, or --within
// role with --within-text, names the container it is in.
const HANDLE_OPTIONS: Options = {
  role: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' }, within: { type: 'string' }, 'within-text': { type: 'string' },
}
const HandleArgs = z.object({
  role: Role.optional(), name: z.string().optional(), text: z.string().optional(), within: z.string().optional(), 'within-text': z.string().optional(),
})
function handleOf(values: z.infer<typeof HandleArgs>): Handle | undefined {
  if (!values.role) return undefined
  const spec = values.within
  if (spec === undefined) {
    if (values['within-text'] !== undefined) throw new UsageError('--within-text needs --within <role>, such as --within listitem')
    return { role: values.role, name: values.name, text: values.text }
  }
  const colon = spec.indexOf(':')
  const role = Role.safeParse(colon < 0 ? spec : spec.slice(0, colon))
  if (!role.success) throw new UsageError(`--within ${spec}: the part before the colon is not an ARIA role. It is role:name, such as list:Agents, or a role with --within-text`)
  return { role: values.role, name: values.name, text: values.text, within: { role: role.data, name: colon < 0 ? undefined : spec.slice(colon + 1), text: values['within-text'] } }
}

const DriveArgs = Common.extend({
  ...HandleArgs.shape,
  engine: ENGINE.default('chromium'), width: WIDTH.default('desktop'), as: z.string().optional(),
  timeout: z.coerce.number().positive().default(DEFAULT_TIMEOUT_S),
  value: z.string().optional(), option: z.string().optional(), path: z.string().optional(), label: z.string().optional(),
  aria: z.boolean().optional(), gone: z.boolean().optional(), page: z.boolean().optional(),
  expect: z.string().optional(), max: z.coerce.number().int().positive().default(DEFAULT_MAX_TABS),
  'ready-role': Role.optional(), 'ready-name': z.string().optional(), 'ready-text': z.string().optional(),
})
const DRIVE_OPTIONS: Options = {
  ...HANDLE_OPTIONS, engine: { type: 'string' }, width: { type: 'string' }, as: { type: 'string' }, timeout: { type: 'string' },
  value: { type: 'string' }, option: { type: 'string' }, path: { type: 'string' }, label: { type: 'string' },
  aria: { type: 'boolean' }, gone: { type: 'boolean' }, page: { type: 'boolean' }, expect: { type: 'string' }, max: { type: 'string' },
  'ready-role': { type: 'string' }, 'ready-name': { type: 'string' }, 'ready-text': { type: 'string' },
}

const DRIVE_OPS = ['goto', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'type', 'wait', 'text', 'count', 'snapshot', 'screenshot',
  'console', 'network', 'trace', 'overflow', 'a11y', 'focus', 'tab-to', 'record', 'close', 'reset'] as const
const DriveOp = z.enum(DRIVE_OPS)
type DriveOp = z.infer<typeof DriveOp>
type Values = z.infer<typeof DriveArgs>
// Operations that change the page or the app, which lead with ok:. The rest read.
const ACTS = new Set<DriveOp>(['goto', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'type', 'tab-to', 'trace', 'record', 'close'])

// The operation a drive command asks for, built from its arguments. Paths for
// captures are chosen later, once the instance's evidence folder is known.
function opFor(name: Exclude<DriveOp, 'reset'>, values: Values, word: string, evidence: string | null): Op {
  const handle = handleOf(values)
  const need = (): Handle => {
    if (!handle) throw new UsageError(`${name} needs an element: --role, with --name or --text`)
    return handle
  }
  const label = values.label ?? `${name}${handle?.name ? `-${handle.name}` : ''}`
  const capture = (folder: string, ext: string) => values.path ?? (evidence === null ? `${folder}/${label}.${ext}` : nextPath(evidence, folder, label, ext))
  switch (name) {
    case 'goto': return { op: 'goto', route: word || '/' }
    case 'click': return { op: 'click', handle: need() }
    case 'fill':
      if (values.value === undefined) throw new UsageError('fill needs --value')
      return { op: 'fill', handle: need(), value: values.value }
    case 'select':
      if (values.option !== undefined) return { op: 'select', handle: need(), option: { label: values.option } }
      if (values.value !== undefined) return { op: 'select', handle: need(), option: { value: values.value } }
      throw new UsageError('select needs --option, the label of the choice, or --value, its value')
    case 'check': return { op: 'check', handle: need(), on: true }
    case 'uncheck': return { op: 'check', handle: need(), on: false }
    case 'press':
      if (!word) throw new UsageError('press needs a key, such as Enter or Tab')
      return { op: 'press', key: word, handle }
    case 'type': return { op: 'type', text: word }
    case 'wait': return { op: 'wait', handle: need(), gone: values.gone === true }
    case 'text': return { op: 'text', handle: need(), holds: values.expect }
    case 'count': {
      if (values.expect === undefined) return { op: 'count', handle: need() }
      const equals = z.coerce.number().int().nonnegative().safeParse(values.expect)
      if (!equals.success) throw new UsageError('count --expect takes a number')
      return { op: 'count', handle: need(), equals: equals.data }
    }
    case 'snapshot': return { op: 'snapshot', path: capture('aria', 'yml') }
    case 'screenshot': return { op: 'screenshot', path: capture('screens', 'png'), full: values.page === true }
    case 'console': return { op: 'console' }
    case 'network': return { op: 'network', path: capture('network', 'json') }
    case 'trace':
      if (word !== 'start' && word !== 'stop') throw new UsageError('trace start, then drive the page, then trace stop')
      return { op: 'trace', action: word, path: capture('traces', 'zip') }
    case 'overflow': return { op: 'overflow' }
    case 'a11y': return { op: 'a11y' }
    case 'focus': return { op: 'focus' }
    case 'tab-to': return { op: 'tab-to', handle: need(), max: values.max }
    case 'record':
      if (word !== 'start' && word !== 'stop') throw new UsageError('record start --label "<what it shows>", then record stop')
      return { op: 'record', action: word, label: values.label ?? 'recording' }
    case 'close': return { op: 'close' }
  }
}

// What to try after a drive step, by what it did and how it went.
function driveHelp(target: Target, name: DriveOp, found: Found | null, failedShot: string | null): string[] {
  if (!found) {
    return [
      run(`${target} snapshot --aria`, 'to list the roles and names on the page'),
      ...(failedShot ? [`Look at the page as it failed: ${relative(ROOT, failedShot)}`] : []),
      run(`${target} reset`, 'if the page is stuck, then goto the view again'),
    ]
  }
  if (name === 'record') return found.files.length ? [`Watch ${relative(ROOT, found.files[0] ?? '')}, and have an agent that did not drive it confirm what it shows`] : [run(`${target} record stop`, 'when the steps are done')]
  if (name === 'a11y' || name === 'console' || name === 'overflow') return found.pass ? [] : [run(`${target} screenshot`, 'to keep the view as evidence'), 'Report it as a product bug once it reproduces twice through the UI']
  if (ACTS.has(name)) return [run(`${target} snapshot --aria`, 'to see the result'), run(`${target} screenshot`, 'to keep it as evidence')]
  return []
}

const driveCommand = (target: Target): Command => ({
  parse: (args) => {
    const [first, ...rest] = args
    const parsedName = DriveOp.safeParse(first)
    if (!parsedName.success) throw new UsageError(`${target} takes one of: ${DRIVE_OPS.join(', ')}`)
    const { values, positionals } = parse(rest, DRIVE_OPTIONS, DriveArgs)
    // reset closes the whole browser session, for a page stuck in a state no step expects.
    if (parsedName.data === 'reset') {
      return async () => {
        const state = ready(values.instance)
        const closed = await stopSessionServer(state)
        return {
          ok: true, head: closed ? `ok: ${target} reset -> the browser session is closed` : `ok: ${target} reset -> no browser session was running`,
          already: !closed, help: [run(`${target} goto /`, 'to open a fresh page')], files: [], data: { closed }, evidence: state.evidence,
        }
      }
    }
    const name = parsedName.data
    const word = positionals.join(' ')
    opFor(name, values, word, null)
    if (values.expect !== undefined && name !== 'text' && name !== 'count') throw new UsageError('--expect goes with text or count')
    if (target === 'desktop' && values.engine !== 'chromium') throw new UsageError('the desktop app is Electron, so it takes no --engine')
    return async () => {
      const state = ready(values.instance)
      const reply = await sessionCall(state, {
        target, engine: values.engine, width: values.width, login: loginFor(state, values.as), timeoutMs: values.timeout * 1000,
        op: opFor(name, values, word, state.evidence),
      })
      if (!reply.ok) {
        return { ok: false, head: `error: ${target} ${name}: ${reply.error}`, help: driveHelp(target, name, null, reply.files[0] ?? null), files: reply.files, data: reply, evidence: state.evidence }
      }
      const found = reply.found
      const [firstLine = '', ...more] = found.summary.split('\n')
      const head = !found.pass ? `error: ${target} ${name}: ${firstLine}` : ACTS.has(name) ? `ok: ${firstLine}` : firstLine
      return { ok: found.pass, head, detail: more.join('\n'), already: found.already, help: driveHelp(target, name, found, null), files: found.files, data: found, evidence: state.evidence }
    }
  },
})

const ApiArgs = Common.extend({
  as: Caller.default('person'), login: z.string().optional(), door: Door.optional(), body: z.string().optional(),
  expect: z.coerce.number().int().optional(), 'expect-text': z.string().optional(),
})

const apiCommand: Command = {
  parse: (args) => {
    const { values, positionals } = parse(args, {
      as: { type: 'string' }, login: { type: 'string' }, door: { type: 'string' }, body: { type: 'string' }, expect: { type: 'string' }, 'expect-text': { type: 'string' },
    }, ApiArgs)
    const [methodText, path] = positionals
    const method = Method.safeParse(methodText)
    if (!method.success || !path) throw new UsageError('api takes a method and a path: api GET /v1/me')
    if (!path.startsWith('/v1/') && path !== '/') throw new UsageError(`the path must start with /v1/: ${path}`)
    let body: Json | undefined
    if (values.body !== undefined) {
      try {
        body = Json.parse(JSON.parse(values.body))
      } catch (error) {
        throw new UsageError(`--body is not JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return async () => {
      const state = ready(values.instance)
      const reply = await call(state, { method: method.data, path, as: values.as, login: values.as === 'person' ? loginFor(state, values.login) : undefined, door: values.door, body })
      const file = nextPath(state.evidence, 'api', `${method.data}-${path}`, 'json')
      writeFileSync(file, `${JSON.stringify({ request: { method: method.data, path, as: values.as, body: body ?? null }, reply }, null, 2)}\n`)
      const statusOk = values.expect === undefined ? reply.status >= 200 && reply.status < 300 : reply.status === values.expect
      const bodyText = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
      const wanted = values['expect-text']
      const missing = wanted !== undefined && !bodyText.includes(wanted) ? wanted : null
      const ok = statusOk && missing === null
      const why = !statusOk ? (values.expect === undefined ? ', and a 2xx was expected' : `, and ${String(values.expect)} was expected`) : missing === null ? '' : `, without "${missing}" in the answer`
      const shown = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body, null, 2)
      const verb = `${method.data} ${path} as ${values.as}`
      return {
        ok, head: ok ? `${method.data === 'POST' ? 'ok: ' : ''}${verb} -> ${String(reply.status)}` : `error: ${verb} -> ${String(reply.status)}${why}`,
        detail: shown, files: [file], data: reply, evidence: state.evidence,
        help: ok && method.data === 'POST' ? [run('db "<select>"', 'to read the side effect back from the record')] : ok ? [] : [`Read the answer in ${relative(ROOT, file)}`],
      }
    }
  },
}

const DbArgs = Common.extend({
  'expect-rows': z.coerce.number().int().nonnegative().optional(), expect: z.array(z.string().regex(/^[a-z_]+=/, '--expect is column=value')).optional(),
  wait: z.coerce.number().nonnegative().default(0), value: z.boolean().optional(),
})

function checkRows(rows: Rows, values: z.infer<typeof DbArgs>): string | null {
  if (values['expect-rows'] !== undefined && rows.length !== values['expect-rows']) return `expected ${String(values['expect-rows'])} rows, and there are ${String(rows.length)}`
  for (const pair of values.expect ?? []) {
    const equals = pair.indexOf('=')
    const [column, wanted] = [pair.slice(0, equals), pair.slice(equals + 1)]
    if (!rows.length) return `expected ${column}=${wanted}, and there are no rows`
    const off = rows.find((row) => {
      const value = row[column]
      return (typeof value === 'string' ? value : JSON.stringify(value)) !== wanted
    })
    if (off) return `expected ${column}=${wanted} in every row, and one has ${JSON.stringify(off[column] ?? null)}`
  }
  if (values.value && (rows.length !== 1 || Object.keys(rows[0] ?? {}).length !== 1)) return `--value needs one row with one column, and there are ${String(rows.length)} rows`
  return null
}

const table = (rows: Rows) => rows.length
  ? rows.map((row) => Object.entries(row).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  ')).join('\n')
  : '(no rows)'

const dbCommand: Command = {
  parse: (args) => {
    const { values, positionals } = parse(args, { 'expect-rows': { type: 'string' }, expect: { type: 'string', multiple: true }, wait: { type: 'string' }, value: { type: 'boolean' } }, DbArgs)
    const sql = positionals.join(' ')
    if (!sql.trim()) throw new UsageError('db takes one read-only query in quotes')
    return async () => {
      const state = ready(values.instance)
      const { text, values: params } = bind(sql, state.seed)
      const deadline = Date.now() + values.wait * 1000
      let rows = await readOnly(text, params)
      let problem = checkRows(rows, values)
      while (problem && Date.now() < deadline) {
        await sleep(POLL_MS)
        rows = await readOnly(text, params)
        problem = checkRows(rows, values)
      }
      const file = nextPath(state.evidence, 'db', sql.slice(0, 40), 'json')
      writeFileSync(file, `${JSON.stringify({ query: sql, rows }, null, 2)}\n`)
      const first = Object.values(rows[0] ?? {})[0]
      // --value prints the one value and nothing else, so a shell can use it in another command.
      if (values.value && !problem) return { ok: true, head: typeof first === 'string' ? first : JSON.stringify(first ?? null), help: [], files: [], data: { rows }, evidence: state.evidence }
      return {
        ok: problem === null, head: problem ? `error: db: ${problem}` : `${String(rows.length)} rows`, detail: table(rows), files: [file], data: { rows }, evidence: state.evidence,
        help: problem ? [values.wait ? 'The record never reached that state. Check the step that should have written it' : 'Add `--wait <seconds>` if the row is still on its way'] : [],
      }
    }
  },
}

const SeedArgs = Common.extend({ instructions: z.string().optional(), title: z.string().optional(), agent: z.string().optional() })
const SeedKind = z.enum(['person', 'agent', 'box', 'repo', 'task'])

const seedCommand: Command = {
  parse: (args) => {
    const [first, ...rest] = args
    const kind = SeedKind.safeParse(first)
    if (!kind.success) throw new UsageError(`seed takes ${SeedKind.options.join(', ')}. An instance starts with agents ${Object.keys(AGENTS).join(', ')} and people ada and ben`)
    const { values, positionals } = parse(rest, { instructions: { type: 'string' }, title: { type: 'string' }, agent: { type: 'string' } }, SeedArgs)
    const [what] = positionals
    const required = (value: string | undefined, usage: string): string => {
      if (value === undefined) throw new UsageError(usage)
      return value
    }
    const named = kind.data === 'task' ? '' : required(what, `seed ${kind.data} <name>`)
    const title = kind.data === 'task' ? required(values.title, 'seed task --title <what needs doing> [--agent fixer]') : ''
    return async () => {
      const state = ready(values.instance)
      const done = (already: boolean, head: string, help: string[], data: unknown): Result => ({ ok: true, head, already, help, files: [], data, evidence: state.evidence })
      switch (kind.data) {
        case 'person': {
          const login = loginFor(state, named)
          const { already } = await addPerson(state.team, login)
          return done(already, `ok: seed person ${named} -> ${login} is on ${state.team}`, [run(`browser goto / --as ${named}`, `to open the app as ${named}`)], { login })
        }
        case 'agent': {
          const { agentId, already } = await addAgent(state.team, named, values.instructions ?? `You are ${named}.`)
          const latest = readState(state.name)
          if (latest?.phase !== 'ready') throw new Error(`instance ${state.name} stopped while the agent was added`)
          if (!already) saveState({ ...latest, seed: { ...latest.seed, agents: { ...latest.seed.agents, [named]: agentId } } })
          return done(already, `ok: seed agent ${named} -> it lives on ${state.seed.machine.name}`, [run(`browser click --role button --name ${named} --within list:Agents`, 'to open its DM')], { agent: named, agentId })
        }
        case 'box': {
          const { already } = await addBox(state.team, named, state.seed.owner.login)
          return done(already, `ok: seed box ${named} -> free, with no container until someone claims it`, [run(`browser click --role button --name Claim --within listitem --within-text "${named} (box)"`, 'to claim it')], { box: named })
        }
        case 'repo': {
          const { repo, already } = await seedExtraRepo(state, named)
          return done(already, `ok: seed repo ${named} -> ${repo.path} is on the forge`, [run('browser click --role button --name "New task"', 'to start a task on it')], repo)
        }
        case 'task': {
          const agentName = values.agent ?? 'fixer'
          const agentId = state.seed.agents[agentName]
          if (!agentId) throw new UsageError(`no agent named ${agentName} on the instance: ${Object.keys(state.seed.agents).join(', ')}`)
          const had = await withClient(async (client) => z.array(z.object({ id: z.string() })).parse((await client.query(
            'select id from tasks where team_id = $1 and title = $2 order by created_at desc limit 1', [state.seed.teamId, title])).rows))
          const [existingTask] = had
          if (existingTask) return done(true, `ok: seed task "${title}" -> #/t/${existingTask.id}`, [run(`browser goto "#/t/${existingTask.id}"`, 'to open it')], { taskId: existingTask.id })
          const reply = await call(state, { method: 'POST', path: '/v1/tasks', as: 'person', body: { title, instructions: values.instructions ?? '', agentId } })
          const task = z.object({ taskId: z.string(), sessionId: z.string() }).safeParse(reply.body)
          if (!task.success) return { ok: false, head: `error: seed task: POST /v1/tasks answered ${String(reply.status)}`, detail: JSON.stringify(reply.body), help: [run(`doctor${at(state)}`, 'to check the instance')], files: [], data: reply, evidence: state.evidence }
          return done(false, `ok: seed task "${title}" -> started for ${agentName} at #/t/${task.data.taskId}`, [run(`browser goto "#/t/${task.data.taskId}"`, 'to open it')], task.data)
        }
      }
    }
  },
}

// A secret on the instance's machine, where a person keeps it: the daemon's secrets.json.
const secretCommand: Command = {
  parse: (args) => {
    const [action, ...rest] = args
    const { values, positionals } = parse(rest, { value: { type: 'string' } }, Common.extend({ value: z.string().optional() }))
    const [key] = positionals
    if ((action !== 'set' && action !== 'unset') || !key || !/^[A-Z][A-Z0-9_]*$/.test(key)) throw new UsageError('secret set <NAME> --value <value>, or secret unset <NAME>')
    if (action === 'set' && values.value === undefined) throw new UsageError('secret set needs --value')
    return async () => {
      const state = ready(values.instance)
      const dir = join(state.scratch, 'daemon')
      const file = join(dir, 'secrets.json')
      const current = existsSync(file) ? z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(file, 'utf8'))) : {}
      const already = action === 'set' ? current[key] === values.value : !(key in current)
      if (!already) {
        const next = action === 'set' && values.value !== undefined ? { ...current, [key]: values.value } : Object.fromEntries(Object.entries(current).filter(([k]) => k !== key))
        mkdirSync(dir, { recursive: true })
        writeFileSync(file, JSON.stringify(next), { mode: 0o600 })
      }
      return {
        ok: true, head: `ok: secret ${action} ${key} -> ${action === 'set' ? 'held' : 'not held'} by the machine ${state.seed.machine.name}`, already,
        help: [`Message an agent whose plugin needs ${key}: it reads the machine's secrets when its next session starts`], files: [], data: { secret: key, set: action === 'set' }, evidence: state.evidence,
      }
    }
  },
}

// A file on the instance's machine, read back the way a person would look on
// their Mac: an agent's folder (agents/<agent id>), a task's workspace
// (workspaces/<workspace id>), or secrets.json. It waits for the file to appear,
// or with --missing for it to be absent.
const MachineArgs = Common.extend({ 'expect-text': z.string().optional(), missing: z.boolean().optional(), timeout: z.coerce.number().positive().default(DEFAULT_TIMEOUT_S) })

const machineCommand: Command = {
  parse: (args) => {
    const [action, ...rest] = args
    const { values, positionals } = parse(rest, { 'expect-text': { type: 'string' }, missing: { type: 'boolean' }, timeout: { type: 'string' } }, MachineArgs)
    const [path] = positionals
    if (action !== 'read' || !path) throw new UsageError('machine read <path in the machine\'s home> [--expect-text <text>] [--missing]')
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Refused(`${path} is outside the machine's home`, ['Give a path inside it, such as agents/<agent id>/first.txt'])
    return async () => {
      const state = ready(values.instance)
      const file = join(state.scratch, 'daemon', path)
      const deadline = Date.now() + values.timeout * 1000
      const look = (): { ok: boolean; head: string; text: string | null } => {
        const text = existsSync(file) ? readFileSync(file, 'utf8') : null
        if (values.missing) return { ok: text === null, head: text === null ? `${path} is not on the machine` : `error: machine read: ${path} is on the machine, and should not be`, text }
        if (text === null) return { ok: false, head: `error: machine read: ${path} is not on the machine`, text }
        const wanted = values['expect-text']
        return wanted === undefined || text.includes(wanted) ? { ok: true, head: `${path} holds ${String(text.length)} characters`, text } : { ok: false, head: `error: machine read: ${path} does not hold "${wanted}"`, text }
      }
      let seen = look()
      while (!seen.ok && Date.now() < deadline) {
        await sleep(POLL_MS)
        seen = look()
      }
      return { ok: seen.ok, head: seen.head, detail: seen.text ?? '', help: [], files: [], data: { path, exists: seen.text !== null, text: seen.text }, evidence: state.evidence }
    }
  },
}

const VisualArgs = Common.extend({ from: z.string().optional(), reason: z.string().optional(), view: z.array(z.string()).optional(), baselines: z.string().optional() })

const visualCommand: Command = {
  parse: (args) => {
    const [action, ...rest] = args
    if (action === 'shot') {
      const { values, positionals } = parse(rest, DRIVE_OPTIONS, DriveArgs)
      const [stateName] = positionals
      if (!stateName || !/^[a-z0-9-]+$/.test(stateName)) throw new UsageError('visual shot needs a state name in lowercase words and dashes, such as conversation-dm')
      const readyHandle = values['ready-role'] ? { role: values['ready-role'], name: values['ready-name'], text: values['ready-text'] } : undefined
      return async () => {
        const state = ready(values.instance)
        const reply = await sessionCall(state, {
          target: 'browser', engine: values.engine, width: values.width, login: loginFor(state, values.as), timeoutMs: values.timeout * 1000,
          op: { op: 'visual', state: stateName, ready: readyHandle },
        })
        if (!reply.ok) return { ok: false, head: `error: visual shot ${stateName}: ${reply.error}`, help: driveHelp('browser', 'screenshot', null, reply.files[0] ?? null), files: reply.files, data: reply, evidence: state.evidence }
        const found = reply.found
        return {
          ok: found.pass, head: found.pass ? `ok: visual shot ${stateName} -> ${String(found.files.length)} captures, each checked` : `error: visual shot ${stateName}: a capture had a problem`,
          detail: found.summary, help: [run('visual compare', 'to diff the captures against the baselines')], files: found.files, data: found, evidence: state.evidence,
        }
      }
    }
    const { values } = parse(rest, { from: { type: 'string' }, reason: { type: 'string' }, view: { type: 'string', multiple: true }, baselines: { type: 'string' } }, VisualArgs)
    // Another baselines folder, for a check that must leave the skill's alone.
    const baselines = values.baselines === undefined ? BASELINES_DIR : values.baselines.startsWith('/') ? values.baselines : join(ROOT, values.baselines)
    const evidenceOf = () => (values.from ? (values.from.startsWith('/') ? values.from : join(ROOT, values.from)) : resolve(values.instance).evidence)
    if (action === 'compare') {
      return async () => {
        const evidence = evidenceOf()
        const result = compare(evidence, baselines)
        const bad = result.results.filter((r) => r.status !== 'same' && r.status !== 'within tolerance')
        const lines = result.results.map((r) => `${bad.includes(r) ? 'FAIL' : 'pass'}  ${r.view} ${r.engine}-${r.width}: ${r.detail}${r.diff ? ` (diff ${relative(ROOT, r.diff)})` : ''}`)
        if (result.notCaptured.length) lines.push(`not captured this run: ${result.notCaptured.join(', ')}`)
        const head = !result.results.length ? `error: visual compare: no captures in ${relative(ROOT, evidence)}`
          : result.ok ? `${String(result.results.length)} captures match their baselines` : `error: visual compare: ${String(bad.length)} of ${String(result.results.length)} captures differ`
        const help = !result.results.length ? [run('map run all --visual', 'to take every capture'), run('visual shot <view>', 'for one view')]
          : result.ok ? [] : ['Open each diff: red marks what changed', run('visual baseline --reason "<why the view changed on purpose>"', 'only if the change is intended'), 'Otherwise it is a regression: reproduce it and report it']
        return { ok: result.ok, head, detail: lines.join('\n'), help, files: result.results.flatMap((r) => (r.diff ? [r.diff] : [])), data: result, evidence }
      }
    }
    if (action === 'baseline') {
      const reason = values.reason
      if (!reason) throw new UsageError('visual baseline needs --reason "<why the view changed on purpose>"')
      return async () => {
        const evidence = evidenceOf()
        const { update, unchanged } = baseline(evidence, reason, values.view ?? [], baselines)
        const files = update?.files ?? []
        return {
          ok: true, already: update === null,
          head: update ? `ok: visual baseline -> ${String(files.length)} baselines replaced, ${String(unchanged)} already matched` : `ok: visual baseline -> all ${String(unchanged)} captures already match`,
          detail: update ? `reason: ${reason}` : '', help: [run('visual compare', 'to confirm the run now matches')], files, data: { update, unchanged }, evidence,
        }
      }
    }
    throw new UsageError('visual takes shot, compare or baseline')
  },
}

const mapCommand: Command = {
  parse: (args) => {
    const [action, ...rest] = args
    const { values, positionals } = parse(rest, { visual: { type: 'boolean' }, 'keep-going': { type: 'boolean' }, base: { type: 'string' } },
      Common.extend({ visual: z.boolean().optional(), 'keep-going': z.boolean().optional(), base: z.string().optional() }))
    if (action === 'list') {
      return async () => {
        const features = listMap()
        return {
          ok: true, head: `${String(features.length)} features`, detail: features.map((f) => `${f.id}  ${f.title}  (${String(f.steps.length)} steps)`).join('\n'),
          help: [run('map run <feature>', 'to drive one'), run('map run all --visual', 'for the full sweep')], files: [], data: features,
        }
      }
    }
    if (action === 'export') {
      return async () => {
        const { file, map, already } = exportMap()
        return {
          ok: true, already, head: `ok: map export -> ${relative(ROOT, file)} lists ${String(map.features.length)} features`,
          help: [run('map check', 'to confirm the map is whole')], files: already ? [] : [file], data: map,
        }
      }
    }
    if (action === 'check') {
      return async () => {
        const problems = checkMap((argv) => { parseCommand(argv) })
        return {
          ok: !problems.length, head: problems.length ? `error: map check: ${String(problems.length)} problems` : 'every feature file has its four sections, the index lists each one, and every command in it parses',
          detail: problems.join('\n'), help: problems.length ? ['Fix each file named, then run `bin/agentsctl map check` again'] : [], files: [], data: { problems },
        }
      }
    }
    if (action === 'guard') {
      const base = values.base
      if (!base) throw new UsageError('map guard --base <git ref>, such as origin/main')
      return async () => {
        const removed = await guardMap(base)
        return {
          ok: !removed.length, head: removed.length ? `error: map guard: ${String(removed.length)} assertions were removed or changed since ${base}` : `every assertion the map had at ${base} is still there`,
          detail: removed.join('\n'), files: [], data: { base, removed },
          help: removed.length ? ['A weaker map can hide a regression. Put each assertion back, or name in the pull request the commit that removed its feature'] : [],
        }
      }
    }
    if (action === 'run') {
      if (!positionals.length) throw new UsageError('map run takes feature names, or all')
      return async () => {
        const state = ready(values.instance)
        const health = async () => {
          const report = await doctor(state.name)
          return { ok: report.ok, why: report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ') }
        }
        const report = await runMap(state, positionals, { visual: values.visual === true, keepGoing: values['keep-going'] === true }, runCli, health)
        const failed = report.features.filter((f) => f.verdict === 'verifier-failed')
        const help = report.ok
          ? [values.visual ? run('visual compare', 'to diff the captures against the baselines') : run(`map run ${positionals.join(' ')} --visual`, 'to also capture the views'), run(`down${at(state)}`, 'when you are done')]
          : [
            ...(failed.length ? [run('browser record start --label "<what it shows>"', 'and reproduce each failed step twice through the UI before calling it a bug')] : []),
            ...(values['keep-going'] ? [] : [run(`map run ${positionals.join(' ')} --keep-going`, 'to give every step a verdict')]),
            `Read the report: ${relative(ROOT, report.file)}`,
          ]
        return { ok: report.ok, head: report.ok ? `ok: map run -> every step live-ui-verified` : `error: map run: ${String(failed.length)} features failed`, detail: report.text, help, files: [report.file], data: report, evidence: state.evidence }
      }
    }
    throw new UsageError('map takes list, check, export, guard or run')
  },
}

function upHelp(state: ReadyState): string[] {
  return [
    run(`doctor${at(state)}`, 'to prove it is usable'),
    run('browser goto /', `to open the app as ${state.seed.owner.login}`),
    run(state.pipelines ? 'map run all' : 'map run getting-in', 'to drive the feature map'),
  ]
}

// The dashboard: what runs here, whether it answers, and what to try next.
async function dashboard(): Promise<Result> {
  const states = list()
  const rows: string[] = []
  for (const state of states) {
    const alive = state.processes.filter((p) => p.role !== 'session')
    let up = alive.length > 0
    for (const record of alive) if (!(await isOurs(record))) up = false
    const answers = state.phase === 'ready' && up ? (await call(state, { method: 'GET', path: '/v1/me', as: 'person' }).catch(() => null))?.status === 200 : false
    rows.push(`${state.name},${state.phase},${String(state.ports.machines)}-${String(state.ports.streams)},${state.harness},${state.pipelines ? 'pipelines' : 'no pipelines'},${answers ? 'answers' : up ? 'running, not answering' : 'not running'}`)
  }
  // Folders are named <instance>-<when it started>, so the part after the last dash orders them by time.
  const when = (folder: string) => folder.slice(folder.lastIndexOf('-') + 1)
  const recent = existsSync(EVIDENCE_DIR) ? readdirSync(EVIDENCE_DIR).sort((a, b) => when(b).localeCompare(when(a))).slice(0, RECENT_EVIDENCE) : []
  const evidence = recent.map((folder) => {
    const done = actions(join(EVIDENCE_DIR, folder))
    return `${relative(ROOT, join(EVIDENCE_DIR, folder))} (${String(done.length)} actions, ${String(done.filter((a) => !a.ok).length)} failed)`
  })
  const [first] = states
  const help = !first ? [run('up --pipelines', 'to start an instance with everything'), run('help', 'for every command')]
    : first.phase === 'ready' ? [run(`doctor${states.length > 1 ? at(first) : ''}`, 'to check it is usable'), run('map list', 'to pick a feature to drive'), run('help', 'for every command')]
      : [run(`down${at(first)}`, `to clear ${first.name}, which is ${first.phase}`)]
  const detail = [
    rows.length ? `instances[${String(rows.length)}]{name,phase,ports,claude,forge,health}:\n${rows.map((r) => `  ${r}`).join('\n')}` : 'instances: none in this checkout',
    evidence.length ? `evidence[${String(evidence.length)}]:\n${evidence.map((e) => `  - ${e}`).join('\n')}` : '',
  ].filter(Boolean).join('\n')
  return { ok: true, head: 'agentsctl: run and drive Agents for verification', detail, help, files: [], data: { instances: states, evidence: recent } }
}

const COMMANDS: Record<string, Command> = {
  up: {
    parse: (args) => {
      const { values } = parse(args, { port: { type: 'string' }, claude: { type: 'string' }, pipelines: { type: 'boolean' }, 'no-build': { type: 'boolean' } },
        Common.extend({ port: z.coerce.number().int().optional(), claude: Harness.default('fake'), pipelines: z.boolean().optional(), 'no-build': z.boolean().optional() }))
      return async () => {
        const { state, already } = await up({ name: values.instance, port: values.port, harness: values.claude, pipelines: values.pipelines === true, build: values['no-build'] !== true })
        const detail = [
          `team: ${state.team}`,
          `people: ${state.seed.owner.login} (ada), ${state.seed.teammate.login} (ben)`,
          `agents: ${Object.keys(state.seed.agents).join(', ')} on the machine ${state.seed.machine.name}`,
          `app: http://127.0.0.1:${String(state.ports.people)}/ (bin/agentsctl browser sends the login)`,
          `claude: ${state.harness === 'fake' ? 'the fake harness, test/fake-claude.ts' : 'real Claude sessions'}`,
          `pipelines: ${state.pipelines ? `bug-fix, improve and coach, from the forge org verify-${state.name}` : 'none (up --pipelines adds them)'}`,
          `evidence: ${relative(ROOT, state.evidence)}`,
        ].join('\n')
        return { ok: true, head: `ok: up ${state.name} -> ready on ports ${String(state.ports.machines)}-${String(state.ports.streams)}`, already, detail, help: upHelp(state), files: [], data: state, evidence: state.evidence }
      }
    },
  },
  doctor: {
    parse: (args) => {
      const { values } = parse(args, {}, Common)
      return async () => {
        const state = resolve(values.instance)
        const report = await doctor(values.instance)
        const failing = report.checks.filter((c) => !c.ok)
        const help = failing.length
          ? [`Read the logs in ${relative(ROOT, state.evidence)}`, run(`down${at(state)}`, 'and up again if it does not recover')]
          : state.phase === 'ready' ? upHelp(state).slice(1) : []
        return {
          ok: report.ok, head: report.ok ? `${state.name} is usable: ${String(report.checks.length)} checks pass` : `error: doctor: ${failing.map((c) => c.name).join(', ')} failed`,
          detail: report.checks.map((c) => `${c.ok ? 'pass' : 'FAIL'}  ${c.name}: ${c.detail}`).join('\n'), help, files: [], data: report, evidence: state.evidence,
        }
      }
    },
  },
  down: {
    parse: (args) => {
      const { values } = parse(args, { 'keep-data': { type: 'boolean' } }, Common.extend({ 'keep-data': z.boolean().optional() }))
      return async () => {
        const stopped = await down(values.instance, { keepData: values['keep-data'] === true })
        if (!stopped) return { ok: true, already: true, head: `ok: down${values.instance ? ` ${values.instance}` : ''} -> nothing was running`, help: [run('up --pipelines', 'to start an instance')], files: [], data: null }
        const kept = existsSync(stopped.evidence)
        const removed = [stopped.removed.team ? `team ${stopped.team}` : '', ...stopped.removed.repos, ...stopped.removed.containers, stopped.removed.scratch ? 'its scratch folder' : ''].filter(Boolean)
        const ok = !stopped.survivors.length && kept
        const head = ok ? `ok: down ${stopped.name} -> stopped, evidence kept in ${relative(ROOT, stopped.evidence)}`
          : `error: down ${stopped.name}: ${stopped.survivors.length ? `${String(stopped.survivors.length)} processes it started are still running` : 'its evidence folder is missing'}`
        const detail = [
          stopped.survivors.length ? `still running: ${stopped.survivors.map((s) => `${String(s.pid)} ${s.command}`).join('; ')}` : 'still running: none',
          `removed: ${removed.length ? removed.join(', ') : 'nothing (--keep-data)'}`,
        ].join('\n')
        const help = ok ? [run(`visual compare --from ${relative(ROOT, stopped.evidence)}`, 'to diff its captures, if it took any'), run('up --pipelines', 'to start a fresh instance')]
          : [`Stop each survivor by its pid after checking with \`ps -ww -p <pid>\` that it is the instance's`]
        return { ok, head, detail, help, files: [], data: stopped, evidence: stopped.evidence }
      }
    },
  },
  list: {
    parse: (args) => {
      parse(args, {}, Common)
      return async () => {
        const states = list()
        return {
          ok: true, head: `${String(states.length)} instances in this checkout`,
          detail: states.map((s) => `${s.name}  ${s.phase}  ports ${String(s.ports.machines)}-${String(s.ports.streams)}  ${relative(ROOT, s.evidence)}`).join('\n'),
          help: states.length ? states.map((s) => run(`doctor${at(s)}`, `to check ${s.name}`)) : [run('up --pipelines', 'to start one')], files: [], data: states,
        }
      }
    },
  },
  evidence: {
    parse: (args) => {
      const { values } = parse(args, {}, Common)
      return async () => {
        const state = resolve(values.instance)
        const done = actions(state.evidence)
        const failed = done.filter((a) => !a.ok)
        return {
          ok: true, head: `${relative(ROOT, state.evidence)}: ${String(done.length)} actions, ${String(failed.length)} failed`,
          detail: failed.map((a) => `${a.command}: ${a.summary}`).join('\n'), help: [], files: [], data: { evidence: state.evidence, actions: done },
        }
      }
    },
  },
  browser: driveCommand('browser'),
  desktop: driveCommand('desktop'),
  api: apiCommand,
  db: dbCommand,
  seed: seedCommand,
  secret: secretCommand,
  machine: machineCommand,
  visual: visualCommand,
  map: mapCommand,
}

export const USAGE = `agentsctl: run and drive Agents for verification. Run from the repo root with ~/.local/node/bin first on PATH.

  bin/agentsctl                       a dashboard: instances, their health, recent evidence, what to try next
  bin/agentsctl up [--instance <name>] [--port <first>] [--claude fake|real] [--pipelines] [--no-build]
  bin/agentsctl doctor | down [--keep-data] | list | evidence
  bin/agentsctl browser <op> [--engine chromium|firefox|webkit] [--width desktop|phone] [--as ada|ben|<who>] [--timeout <s>]
      ops: goto <route> | click | fill --value | select --option|--value | check | uncheck | press <key> | type <text>
           wait [--gone] | text [--expect] | count [--expect] | snapshot --aria | screenshot [--page]
           console | network | trace start|stop | overflow | a11y | focus | tab-to | record start --label <what it shows> | record stop | close
           reset (closes the whole browser session; the next command opens a fresh one)
      elements: --role <role> --name <accessible name> [--text <text inside>] [--within <role>:<name> | --within <role> --within-text <text>]
  bin/agentsctl desktop <op> (the same ops, in the Electron app)
  bin/agentsctl api <GET|POST|HEAD> <path> [--as person|machine|webhook] [--login ada|ben] [--door people|machines] [--body <json>] [--expect <status>] [--expect-text <text>]
  bin/agentsctl db "<select>" [--expect-rows <n>] [--expect <column>=<value>] [--wait <seconds>] [--value]
  bin/agentsctl seed person <who> | agent <name> | box <name> | repo <name> | task --title <title> [--agent <name>]
  bin/agentsctl secret set <NAME> --value <value> | secret unset <NAME>
  bin/agentsctl machine read <path in the machine's home> [--expect-text <text>] [--missing]
  bin/agentsctl visual shot <view> [--ready-role <role> --ready-name <name>] | compare [--from <dir>] [--baselines <dir>] | baseline --reason <why> [--from <dir>] [--baselines <dir>]
  bin/agentsctl map list | check | export | guard --base <git ref> | run <feature ...|all> [--visual] [--keep-going]

Every command takes --instance <name> (the only running one by default), --json for one typed envelope,
--full to show long output whole, and --dry-run, which checks the command line and the instance and runs nothing.
A write leads with "ok:", rerunning one that changed nothing says "already: true", and each command ends with next steps.
Exit codes: 0 done, 1 failed and safe to retry once fixed, 2 usage error, 3 refused with nothing changed.`

// Parses a command line into what runs it, or throws a UsageError naming what is wrong.
export function parseCommand(argv: string[]): () => Promise<Result> {
  const [name, ...rest] = argv
  if (name === undefined || (name.startsWith('--') && !argv.some((a) => !a.startsWith('--')))) return dashboard
  if (name === 'help' || name === '--help') return async () => ({ ok: true, head: USAGE, help: [], files: [], data: null })
  const command = COMMANDS[name]
  if (!command) throw new UsageError(`no command ${name}`)
  return command.parse(rest)
}

// Commands with a second word, such as `browser click`.
const TWO_WORDS = new Set(['browser', 'desktop', 'seed', 'secret', 'machine', 'visual', 'map'])
// Commands that start no instance and need none.
const NO_INSTANCE = new Set(['help', 'up', 'list', 'map list', 'map check', 'map export', 'visual compare', 'visual baseline'])

// What a command would do, once its arguments have parsed. Runs nothing.
function dryRun(argv: string[], command: string): Output {
  const named = argv[argv.indexOf('--instance') + 1]
  const shown = argv.filter((a) => a !== '--dry-run' && a !== '--json').map((a) => (/^[\w./:@=-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')
  let target = ''
  let ready: InstanceState | null = null
  if (!NO_INSTANCE.has(command)) {
    try {
      ready = resolve(argv.includes('--instance') && named !== undefined ? InstanceName.parse(named) : undefined)
      target = ` It would act on instance ${ready.name}, which is ${ready.phase}.`
    } catch (error) {
      target = ` It would fail: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return {
    ok: true, command, head: `dry run: bin/agentsctl ${shown} parses.${target} Nothing ran.`, detail: '', already: false, code: EXIT.done,
    files: [], help: [`Run it without --dry-run: bin/agentsctl ${shown}`], data: { argv, instance: ready?.name ?? null },
  }
}

export async function runCli(argv: string[]): Promise<{ code: number; output: Output; json: boolean; full: boolean }> {
  const json = argv.includes('--json')
  const full = argv.includes('--full')
  const [first, second] = argv
  const command = first === undefined || first.startsWith('--') ? 'dashboard' : TWO_WORDS.has(first) && second !== undefined && !second.startsWith('--') ? `${first} ${second}` : first
  try {
    const runIt = parseCommand(argv)
    if (argv.includes('--dry-run')) return { code: EXIT.done, output: dryRun(argv, command), json, full }
    const result = await runIt()
    const code = result.ok ? EXIT.done : result.code ?? EXIT.failed
    const output: Output = {
      ok: result.ok, command, head: result.head, detail: result.detail ?? '', already: result.already === true, code,
      files: result.files, help: result.help, data: toJson(result.data),
    }
    if (result.evidence) record(result.evidence, { command, args: argv, ok: result.ok, summary: result.head, files: result.files })
    return { code, output, json, full }
  } catch (error) {
    const known = error instanceof CliError
    const code = known ? error.code : EXIT.failed
    const message = error instanceof Error ? error.message : String(error)
    const help = known ? error.help : [run('doctor', 'to check the instance'), 'If this keeps happening, read the logs in the instance\'s evidence folder']
    return { code, output: { ok: false, command, head: `error: ${command}: ${message}`, detail: '', already: false, code, files: [], help, data: null }, json, full }
  }
}
