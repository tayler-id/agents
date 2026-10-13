// agentsctl's command line. Each command parses its arguments with zod first,
// then runs, so `map check` can parse every command in the feature map without
// running any. Every command prints plain text for a person, or with --json one
// Output envelope for an agent, and exits 1 with a message naming what failed.
// runCli is what bin/agentsctl runs, and what `map run` calls for each command
// in the feature map.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { ROOT } from './config.ts'
import { bind, Json, readOnly, type Rows } from './db.ts'
import { call, Caller, Door, Method } from './api.ts'
import { actions, nextPath, record } from './evidence.ts'
import { doctor, down, list, ready, resolve, up } from './instance.ts'
import { Engine, Role, Viewport, type Found, type Handle, type Op, type Target } from './protocol.ts'
import { sessionCall } from './session-client.ts'
import { addAgent, addBox, addPerson, AGENTS, seedExtraRepo } from './seed.ts'
import { Harness, InstanceName, readState, saveState, type ReadyState } from './state.ts'
import { baseline, compare } from './visual.ts'
import { checkMap, listMap, runMap } from './map.ts'
import { EXIT, UsageError, type Output } from './output.ts'

type Result = { ok: boolean; summary: string; files: string[]; data: unknown; evidence?: string }
type Options = NonNullable<Parameters<typeof parseArgs>[0]>['options']
// A command: parse checks the arguments and returns what run needs, touching nothing.
type Command = { parse: (args: string[]) => () => Promise<Result> }

// How long a browser step waits for its element by default: long enough for
// Electric to deliver a row and React to render it on a busy laptop.
const DEFAULT_TIMEOUT_S = 15
// How often `db --wait` reads again.
const DB_POLL_MS = 500
// How many Tab presses `tab-to` tries before it says the element is out of reach.
const DEFAULT_MAX_TABS = 40

const COMMON: Options = { instance: { type: 'string' }, json: { type: 'boolean' }, 'dry-run': { type: 'boolean' } }
const Common = z.object({ instance: InstanceName.optional(), json: z.boolean().optional(), 'dry-run': z.boolean().optional() })

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

// --role, --name, --text and --within (role:name) together name one element.
const HANDLE_OPTIONS: Options = { role: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' }, within: { type: 'string' } }
const HandleArgs = z.object({ role: Role.optional(), name: z.string().optional(), text: z.string().optional(), within: z.string().optional() })
function handleOf(values: z.infer<typeof HandleArgs>): Handle | undefined {
  if (!values.role) return undefined
  let within: Handle['within']
  if (values.within !== undefined) {
    const at = values.within.indexOf(':')
    const role = Role.safeParse(values.within.slice(0, at))
    if (at < 0 || !role.success) throw new UsageError('--within is role:name, such as list:Agents')
    within = { role: role.data, name: values.within.slice(at + 1) }
  }
  return { role: values.role, name: values.name, text: values.text, within }
}

const DriveArgs = Common.extend({
  ...HandleArgs.shape,
  engine: Engine.default('chromium'), viewport: Viewport.default('desktop'), as: z.string().optional(),
  timeout: z.coerce.number().positive().default(DEFAULT_TIMEOUT_S),
  value: z.string().optional(), option: z.string().optional(), path: z.string().optional(), label: z.string().optional(),
  full: z.boolean().optional(), aria: z.boolean().optional(), gone: z.boolean().optional(),
  expect: z.string().optional(), max: z.coerce.number().int().positive().default(DEFAULT_MAX_TABS),
  'ready-role': Role.optional(), 'ready-name': z.string().optional(), 'ready-text': z.string().optional(),
})
const DRIVE_OPTIONS: Options = {
  ...HANDLE_OPTIONS, engine: { type: 'string' }, viewport: { type: 'string' }, as: { type: 'string' }, timeout: { type: 'string' },
  value: { type: 'string' }, option: { type: 'string' }, path: { type: 'string' }, label: { type: 'string' },
  full: { type: 'boolean' }, aria: { type: 'boolean' }, gone: { type: 'boolean' }, expect: { type: 'string' }, max: { type: 'string' },
  'ready-role': { type: 'string' }, 'ready-name': { type: 'string' }, 'ready-text': { type: 'string' },
}

const DRIVE_OPS = ['goto', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'type', 'wait', 'text', 'count', 'snapshot', 'screenshot',
  'console', 'overflow', 'a11y', 'focus', 'tab-to', 'record', 'close'] as const
const DriveOp = z.enum(DRIVE_OPS)
type DriveOp = z.infer<typeof DriveOp>
type Values = z.infer<typeof DriveArgs>

// The operation a drive command asks for, built from its arguments. Paths for
// captures are chosen later, once the instance's evidence folder is known.
function opFor(name: DriveOp, values: Values, word: string, evidence: string | null): Op {
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
      if (values.option === undefined) throw new UsageError('select needs --option, the label of the choice')
      return { op: 'select', handle: need(), option: values.option }
    case 'check': return { op: 'check', handle: need(), on: true }
    case 'uncheck': return { op: 'check', handle: need(), on: false }
    case 'press':
      if (!word) throw new UsageError('press needs a key, such as Enter or Tab')
      return { op: 'press', key: word, handle }
    case 'type': return { op: 'type', text: word }
    case 'wait': return { op: 'wait', handle: need(), gone: values.gone === true }
    case 'text': return { op: 'text', handle: need() }
    case 'count': return { op: 'count', handle: need() }
    case 'snapshot': return { op: 'snapshot', path: capture('aria', 'yml') }
    case 'screenshot': return { op: 'screenshot', path: capture('screens', 'png'), full: values.full === true }
    case 'console': return { op: 'console' }
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

// `text --expect <words>` passes when the text holds them; `count --expect <n>` when the count is n.
function expectation(name: DriveOp, expect: string | undefined, found: Found): { ok: boolean; why: string } {
  if (expect === undefined) return { ok: true, why: '' }
  if (name === 'text') return { ok: (found.text ?? '').includes(expect), why: `expected the text to hold "${expect}", and it reads: ${found.text ?? ''}` }
  if (name === 'count') return { ok: found.count === Number(expect), why: `expected ${expect}, and there are ${String(found.count)}` }
  throw new UsageError('--expect goes with text or count')
}

const driveCommand = (target: Target): Command => ({
  parse: (args) => {
    const [first, ...rest] = args
    const name = DriveOp.safeParse(first)
    if (!name.success) throw new UsageError(`${target} takes one of: ${DRIVE_OPS.join(', ')}`)
    const { values, positionals } = parse(rest, DRIVE_OPTIONS, DriveArgs)
    const word = positionals.join(' ')
    opFor(name.data, values, word, null)
    if (values.expect !== undefined && name.data !== 'text' && name.data !== 'count') throw new UsageError('--expect goes with text or count')
    if (target === 'desktop' && values.engine !== 'chromium') throw new UsageError('the desktop app is Electron, so it takes no --engine')
    return async () => {
      const state = ready(values.instance)
      const reply = await sessionCall(state, {
        target, engine: values.engine, viewport: values.viewport, login: loginFor(state, values.as), timeoutMs: values.timeout * 1000,
        op: opFor(name.data, values, word, state.evidence),
      })
      if (!reply.ok) {
        const shot = reply.files[0] ? ` The page as it failed: ${relative(ROOT, reply.files[0])}.` : ''
        return { ok: false, summary: `${reply.error}\nnext: list the roles and names on the page with: bin/agentsctl ${target} snapshot --aria.${shot}`, files: reply.files, data: reply, evidence: state.evidence }
      }
      const expected = expectation(name.data, values.expect, reply.found)
      return { ok: reply.found.pass && expected.ok, summary: expected.ok ? reply.found.summary : expected.why, files: reply.found.files, data: reply.found, evidence: state.evidence }
    }
  },
})

const ApiArgs = Common.extend({ as: Caller.default('person'), login: z.string().optional(), door: Door.optional(), body: z.string().optional(), expect: z.coerce.number().int().optional() })

const apiCommand: Command = {
  parse: (args) => {
    const { values, positionals } = parse(args, { as: { type: 'string' }, login: { type: 'string' }, door: { type: 'string' }, body: { type: 'string' }, expect: { type: 'string' } }, ApiArgs)
    const [methodText, path] = positionals
    const method = Method.safeParse(methodText)
    if (!method.success || !path) throw new UsageError('api takes a method and a path: api GET /v1/me')
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
      const ok = values.expect === undefined ? reply.status >= 200 && reply.status < 300 : reply.status === values.expect
      const shown = typeof reply.body === 'string' ? reply.body.slice(0, 2000) : JSON.stringify(reply.body, null, 2)
      return { ok, summary: `${String(reply.status)}${ok ? '' : values.expect === undefined ? ' (expected a 2xx)' : ` (expected ${String(values.expect)})`}\n${shown}`, files: [file], data: reply, evidence: state.evidence }
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
    const at = pair.indexOf('=')
    const [column, wanted] = [pair.slice(0, at), pair.slice(at + 1)]
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
        await sleep(DB_POLL_MS)
        rows = await readOnly(text, params)
        problem = checkRows(rows, values)
      }
      const file = nextPath(state.evidence, 'db', sql.slice(0, 40), 'json')
      writeFileSync(file, `${JSON.stringify({ query: sql, rows }, null, 2)}\n`)
      const first = Object.values(rows[0] ?? {})[0]
      const summary = problem ?? (values.value ? (typeof first === 'string' ? first : JSON.stringify(first ?? null)) : table(rows))
      return { ok: problem === null, summary, files: [file], data: { rows }, evidence: state.evidence }
    }
  },
}

const SeedArgs = Common.extend({ instructions: z.string().optional(), title: z.string().optional(), agent: z.string().optional() })
const SeedKind = z.enum(['person', 'agent', 'box', 'repo', 'task'])

const seedCommand: Command = {
  parse: (args) => {
    const [first, ...rest] = args
    const kind = SeedKind.safeParse(first)
    if (!kind.success) throw new UsageError(`seed takes ${SeedKind.options.join(', ')}. An instance starts with agents ${Object.keys(AGENTS).join(', ')} and people ada and ben.`)
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
      const done = (summary: string, data: unknown): Result => ({ ok: true, summary, files: [], data, evidence: state.evidence })
      switch (kind.data) {
        case 'person': {
          const login = loginFor(state, named)
          await addPerson(state.team, login)
          return done(`${login} is on ${state.team}`, { login })
        }
        case 'agent': {
          const agentId = await addAgent(state.team, named, values.instructions ?? `You are ${named}.`)
          const latest = readState(state.name)
          if (latest?.phase !== 'ready') throw new Error(`instance ${state.name} stopped while the agent was added`)
          saveState({ ...latest, seed: { ...latest.seed, agents: { ...latest.seed.agents, [named]: agentId } } })
          return done(`agent ${named} lives on ${state.seed.machine.name}`, { agent: named, agentId })
        }
        case 'box':
          await addBox(state.team, named, state.seed.owner.login)
          return done(`box ${named} is on ${state.team}, with no container until someone claims it`, { box: named })
        case 'repo': {
          const repo = await seedExtraRepo(state, named)
          return done(`repo ${repo.path} is on the forge`, repo)
        }
        case 'task': {
          const agentName = values.agent ?? 'fixer'
          const agentId = state.seed.agents[agentName]
          if (!agentId) throw new UsageError(`no agent named ${agentName} on the instance: ${Object.keys(state.seed.agents).join(', ')}`)
          const reply = await call(state, { method: 'POST', path: '/v1/tasks', as: 'person', body: { title, instructions: values.instructions ?? '', agentId } })
          const task = z.object({ taskId: z.string(), sessionId: z.string() }).safeParse(reply.body)
          if (!task.success) return { ok: false, summary: `POST /v1/tasks answered ${String(reply.status)}: ${JSON.stringify(reply.body)}`, files: [], data: reply, evidence: state.evidence }
          return done(`task "${title}" started for ${agentName}: #/t/${task.data.taskId}`, task.data)
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
      const next = action === 'set' && values.value !== undefined ? { ...current, [key]: values.value } : Object.fromEntries(Object.entries(current).filter(([k]) => k !== key))
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, JSON.stringify(next), { mode: 0o600 })
      return { ok: true, summary: `${key} is ${action === 'set' ? 'set' : 'gone'} on the machine ${state.seed.machine.name} (${file})`, files: [], data: { secret: key, set: action === 'set' }, evidence: state.evidence }
    }
  },
}

const VisualArgs = Common.extend({ from: z.string().optional(), reason: z.string().optional(), state: z.array(z.string()).optional() })

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
          target: 'browser', engine: values.engine, viewport: values.viewport, login: loginFor(state, values.as), timeoutMs: values.timeout * 1000,
          op: { op: 'visual', state: stateName, ready: readyHandle },
        })
        if (!reply.ok) return { ok: false, summary: reply.error, files: reply.files, data: reply, evidence: state.evidence }
        return { ok: reply.found.pass, summary: reply.found.summary, files: reply.found.files, data: reply.found, evidence: state.evidence }
      }
    }
    const { values } = parse(rest, { from: { type: 'string' }, reason: { type: 'string' }, state: { type: 'string', multiple: true } }, VisualArgs)
    const evidenceOf = () => (values.from ? (values.from.startsWith('/') ? values.from : join(ROOT, values.from)) : resolve(values.instance).evidence)
    if (action === 'compare') {
      return async () => {
        const evidence = evidenceOf()
        const result = compare(evidence)
        const lines = result.results.map((r) => `${r.status === 'same' || r.status === 'within tolerance' ? 'pass' : 'FAIL'}  ${r.state} ${r.combo}: ${r.detail}${r.diff ? `\n      diff: ${relative(ROOT, r.diff)}` : ''}`)
        if (result.notCaptured.length) lines.push(`not captured this run: ${result.notCaptured.join(', ')}`)
        if (!result.results.length) lines.push(`no captures in ${evidence}. Capture with: bin/agentsctl visual shot <state>`)
        return { ok: result.ok, summary: lines.join('\n'), files: result.results.flatMap((r) => (r.diff ? [r.diff] : [])), data: result, evidence }
      }
    }
    if (action === 'baseline') {
      const reason = values.reason
      if (!reason) throw new UsageError('visual baseline needs --reason "<why the view changed on purpose>"')
      return async () => {
        const evidence = evidenceOf()
        const update = baseline(evidence, reason, values.state ?? [])
        return { ok: true, summary: `${String(update.files.length)} baselines updated: ${reason}`, files: update.files, data: update, evidence }
      }
    }
    throw new UsageError('visual takes shot, compare or baseline')
  },
}

const mapCommand: Command = {
  parse: (args) => {
    const [action, ...rest] = args
    const { values, positionals } = parse(rest, { visual: { type: 'boolean' }, 'keep-going': { type: 'boolean' } },
      Common.extend({ visual: z.boolean().optional(), 'keep-going': z.boolean().optional() }))
    if (action === 'list') {
      return async () => {
        const features = listMap()
        return { ok: true, summary: features.map((f) => `${f.id}  ${f.title}  (${String(f.steps.length)} steps)`).join('\n'), files: [], data: features }
      }
    }
    if (action === 'check') {
      return async () => {
        const problems = checkMap((argv) => { parseCommand(argv) })
        return { ok: !problems.length, summary: problems.length ? problems.join('\n') : 'every feature file has its four sections, the index lists each one, and every command in it parses', files: [], data: { problems } }
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
        return { ok: report.ok, summary: report.text, files: [report.file], data: report, evidence: state.evidence }
      }
    }
    throw new UsageError('map takes list, check or run')
  },
}

const COMMANDS: Record<string, Command> = {
  up: {
    parse: (args) => {
      const { values } = parse(args, { port: { type: 'string' }, claude: { type: 'string' }, pipelines: { type: 'boolean' }, 'no-build': { type: 'boolean' } },
        Common.extend({ port: z.coerce.number().int().optional(), claude: Harness.default('fake'), pipelines: z.boolean().optional(), 'no-build': z.boolean().optional() }))
      return async () => {
        const state = await up({ name: values.instance, port: values.port, harness: values.claude, pipelines: values.pipelines === true, build: values['no-build'] !== true })
        const summary = [
          `instance ${state.name} is ready`,
          `  team       ${state.team}: ${state.seed.owner.login} (ada), ${state.seed.teammate.login} (ben)`,
          `  agents     ${Object.keys(state.seed.agents).join(', ')} on the machine ${state.seed.machine.name}`,
          `  app        http://127.0.0.1:${String(state.ports.people)}/ as a person (agentsctl browser sends the login header)`,
          `  machines   http://127.0.0.1:${String(state.ports.machines)}`,
          `  claude     ${state.harness === 'fake' ? 'the fake harness (test/fake-claude.ts)' : 'real Claude sessions'}`,
          `  pipelines  ${state.pipelines ? `bug-fix, improve and coach, from the forge org verify-${state.name}` : 'none (start with --pipelines for them)'}`,
          `  evidence   ${relative(ROOT, state.evidence)}`,
        ].join('\n')
        return { ok: true, summary, files: [], data: state, evidence: state.evidence }
      }
    },
  },
  doctor: {
    parse: (args) => {
      const { values } = parse(args, {}, Common)
      return async () => {
        const report = await doctor(values.instance)
        const summary = report.checks.map((c) => `${c.ok ? 'pass' : 'FAIL'}  ${c.name}: ${c.detail}`).join('\n')
        return { ok: report.ok, summary, files: [], data: report, evidence: resolve(values.instance).evidence }
      }
    },
  },
  down: {
    parse: (args) => {
      const { values } = parse(args, { 'keep-data': { type: 'boolean' } }, Common.extend({ 'keep-data': z.boolean().optional() }))
      return async () => {
        const stopped = await down(values.instance, { keepData: values['keep-data'] === true })
        const kept = existsSync(stopped.evidence)
        const removed = [stopped.removed.team ? `team ${stopped.team}` : '', ...stopped.removed.repos, ...stopped.removed.containers, stopped.removed.scratch ? 'its scratch folder' : ''].filter(Boolean)
        const summary = [
          `instance ${stopped.name} is stopped`,
          stopped.survivors.length ? `  STILL RUNNING: ${stopped.survivors.map((s) => `${String(s.pid)} ${s.command}`).join('; ')}` : '  no process it started is still running',
          `  removed    ${removed.length ? removed.join(', ') : 'nothing (--keep-data)'}`,
          `  evidence   ${relative(ROOT, stopped.evidence)}${kept ? '' : ' IS MISSING'}`,
        ].join('\n')
        return { ok: !stopped.survivors.length && kept, summary, files: [], data: stopped, evidence: stopped.evidence }
      }
    },
  },
  list: {
    parse: (args) => {
      parse(args, {}, Common)
      return async () => {
        const states = list()
        return { ok: true, summary: states.length ? states.map((s) => `${s.name}  ${s.phase}  ports ${String(s.ports.machines)}-${String(s.ports.streams)}  ${relative(ROOT, s.evidence)}`).join('\n') : 'no instances in this checkout', files: [], data: states }
      }
    },
  },
  evidence: {
    parse: (args) => {
      const { values } = parse(args, {}, Common)
      return async () => {
        const state = resolve(values.instance)
        const done = actions(state.evidence)
        return { ok: true, summary: `${relative(ROOT, state.evidence)}: ${String(done.length)} actions, ${String(done.filter((a) => !a.ok).length)} failed`, files: [], data: { evidence: state.evidence, actions: done } }
      }
    },
  },
  browser: driveCommand('browser'),
  desktop: driveCommand('desktop'),
  api: apiCommand,
  db: dbCommand,
  seed: seedCommand,
  secret: secretCommand,
  visual: visualCommand,
  map: mapCommand,
}

export const USAGE = `agentsctl: run and drive Agents for verification. Run from the repo root with ~/.local/node/bin first on PATH.

  bin/agentsctl up [--instance <name>] [--port <first>] [--claude fake|real] [--pipelines] [--no-build]
  bin/agentsctl doctor | down [--keep-data] | list | evidence
  bin/agentsctl browser <op> [--engine chromium|firefox|webkit] [--viewport desktop|phone] [--as ada|ben|<who>] [--timeout <s>]
      ops: goto <route> | click | fill --value | select --option | check | uncheck | press <key> | type <text>
           wait [--gone] | text [--expect] | count [--expect] | snapshot --aria | screenshot [--full]
           console | overflow | a11y | focus | tab-to | record start --label <what it shows> | record stop | close
      elements: --role <role> --name <accessible name> [--text <text inside>] [--within <role>:<name>]
  bin/agentsctl desktop <op> (the same ops, in the Electron app)
  bin/agentsctl api <GET|POST|HEAD> <path> [--as person|machine|webhook] [--login ada|ben] [--door people|machines] [--body <json>] [--expect <status>]
  bin/agentsctl db "<select>" [--expect-rows <n>] [--expect <column>=<value>] [--wait <seconds>] [--value]
  bin/agentsctl seed person <who> | agent <name> | box <name> | repo <name> | task --title <title> [--agent <name>]
  bin/agentsctl secret set <NAME> --value <value> | secret unset <NAME>
  bin/agentsctl visual shot <state> [--ready-role <role> --ready-name <name>] | compare [--from <dir>] | baseline --reason <why> [--from <dir>]
  bin/agentsctl map list | check | run <feature ...|all> [--visual] [--keep-going]

Every command takes --instance <name> (the only running one by default), --json for one JSON
envelope, and --dry-run, which checks the command line and the instance and runs nothing.`

// Parses a command line into what runs it, or throws a UsageError naming what is wrong.
export function parseCommand(argv: string[]): () => Promise<Result> {
  const [name, ...rest] = argv
  if (name === undefined || name === 'help' || name === '--help') return async () => ({ ok: true, summary: USAGE, files: [], data: null })
  const command = COMMANDS[name]
  if (!command) throw new UsageError(`no command ${name}.\n\n${USAGE}`)
  return command.parse(rest)
}

// Commands with a second word, such as `browser click`.
const TWO_WORDS = new Set(['browser', 'desktop', 'seed', 'secret', 'visual', 'map'])
// Commands that start no instance and need none.
const NO_INSTANCE = new Set(['help', 'up', 'list', 'map list', 'map check', 'visual compare', 'visual baseline'])

// What a command would do, once its arguments have parsed. Runs nothing.
function dryRun(argv: string[], command: string): Output {
  const named = argv[argv.indexOf('--instance') + 1]
  const shown = argv.filter((a) => a !== '--dry-run' && a !== '--json').map((a) => (/^[\w./:@=-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')
  let target = ''
  if (!NO_INSTANCE.has(command)) {
    try {
      const state = resolve(argv.includes('--instance') && named !== undefined ? InstanceName.parse(named) : undefined)
      target = ` It would act on instance ${state.name}, which is ${state.phase}.`
    } catch (error) {
      target = ` It would fail: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return { ok: true, command, summary: `dry run: bin/agentsctl ${shown} parses.${target} Nothing ran.`, files: [], data: { argv } }
}

export async function runCli(argv: string[]): Promise<{ code: number; output: Output; json: boolean }> {
  const json = argv.includes('--json')
  const [first, second] = argv
  const command = first === undefined ? 'help' : TWO_WORDS.has(first) && second !== undefined ? `${first} ${second}` : first
  try {
    const run = parseCommand(argv)
    if (argv.includes('--dry-run')) return { code: EXIT.ok, output: dryRun(argv, command), json }
    const result = await run()
    const output: Output = { ok: result.ok, command, summary: result.summary, files: result.files, data: toJson(result.data) }
    if (result.evidence) record(result.evidence, { command, args: argv, ok: result.ok, summary: result.summary.split('\n')[0] ?? '', files: result.files })
    return { code: result.ok ? EXIT.ok : EXIT.failed, output, json }
  } catch (error) {
    const usage = error instanceof UsageError
    const message = error instanceof Error ? error.message : String(error)
    return { code: usage ? EXIT.usage : EXIT.failed, output: { ok: false, command, summary: message, files: [], data: null }, json }
  }
}
