// agentsctl's commands, defined on the shared CLI library in shared/cli. Each
// command parses its flags with zod, then returns a read, a list, a write with
// the state it read back afterwards, or a failure, and the library words the
// output. runCli is what bin/agentsctl runs, and what `map run` calls for each
// command in the feature map.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { command, dispatch, parseOnly, type Cli, type Command, type Flags, type Result, type Row } from '../shared/cli/command.ts'
import { JSON_VALUE, Refused, UsageError, type JsonValue } from '../shared/cli/output.ts'
import { ENGINE, EVIDENCE_MANIFEST, EVIDENCE_MANIFEST_FILE, FEATURE_MAP, WIDTH } from '../shared/verification.ts'
import { BASELINES_DIR, EVIDENCE_DIR, ROOT, scrubber } from './config.ts'
import { bind, readOnly, withClient, type Rows } from './db.ts'
import { call, Caller, Door, Method } from './api.ts'
import { actions, nextPath, record } from './evidence.ts'
import { doctor, down, list, ready, resolve, up, type DoctorReport } from './instance.ts'
import { isOurs } from './procs.ts'
import { Role, type Found, type Handle, type Op, type SessionReply, type Target } from './protocol.ts'
import { sessionCall, stopSessionServer } from './session-client.ts'
import { addAgent, addBox, addPerson, loginOf, PERSON_RULE, PersonName, seedExtraRepo } from './seed.ts'
import { Harness, InstanceName, readState, saveState, type InstanceState, type ReadyState } from './state.ts'
import { baseline, BaselineReason, compare } from './visual.ts'
import { checkMap, exportMap, guardMap, listMap, runMap } from './map.ts'
import { messageOf } from '../shared/errors.ts'

const INVOKE = 'bin/agentsctl'
// How long a browser step waits for its element by default: long enough for
// Electric to deliver a row and React to render it on a busy laptop.
const DEFAULT_TIMEOUT_S = 15
// How often `db --wait` and `machine read` look again.
const POLL_MS = 500
// How many Tab presses `tab-to` tries before it says the element is out of reach.
const DEFAULT_MAX_TABS = 40
// How many evidence folders the dashboard lists.
const RECENT_EVIDENCE = 5

const run = (line: string, why: string) => `Run \`${INVOKE} ${line}\` ${why}`
const at = (state: { name: string }) => ` --instance ${state.name}`

const GLOBAL: Flags = { instance: { kind: 'string', about: 'the instance to act on; the only one in this checkout by default' } }
const Common = z.object({ instance: InstanceName.optional() })

// A person on the instance: ada (who started it), ben (a teammate), anyone
// added with `seed person <who>`, or a full login.
export function loginFor(state: ReadyState, who: string | undefined): string {
  if (who === undefined) return state.seed.owner.login
  if (who.includes('@')) return who
  const person = PersonName.safeParse(who)
  if (!person.success) throw new UsageError(`${who} is not a person's name. ${PERSON_RULE}.`)
  return loginOf(person.data, state.name)
}

const failed = (error: string, rest: Omit<Extract<Result, { kind: 'failed' }>, 'kind' | 'error' | 'code'>, code: 1 | 3 = 1): Result => ({ kind: 'failed', code, error, ...rest })

// --- Driving the web and desktop app ---

// --role, --name and --text name one element. --within role:name, or --within
// role with --within-text, names the container it is in.
const HANDLE: Flags = {
  role: { kind: 'string', about: 'the ARIA role of the element, such as button or textbox' },
  name: { kind: 'string', about: 'its accessible name, matched whole' },
  text: { kind: 'string', about: 'text inside it' },
  within: { kind: 'string', about: 'its container, as role:name, such as list:Agents, or a role with --within-text' },
  'within-text': { kind: 'string', about: 'text inside the container named by --within <role>' },
}
const PAGE: Flags = {
  engine: { kind: 'string', about: 'chromium, firefox or webkit (chromium by default)' },
  width: { kind: 'string', about: 'desktop or phone (desktop by default)' },
  as: { kind: 'string', about: 'who is signed in: ada, ben, a name given to seed person, or a full login' },
  timeout: { kind: 'string', about: `seconds to wait for the element (${String(DEFAULT_TIMEOUT_S)} by default)` },
}
const READY: Flags = {
  'ready-role': { kind: 'string', about: 'the role of an element to wait for before each capture' },
  'ready-name': { kind: 'string', about: "that element's accessible name" },
  'ready-text': { kind: 'string', about: 'text inside that element' },
}
const DriveArgs = Common.extend({
  role: Role.optional(), name: z.string().optional(), text: z.string().optional(), within: z.string().optional(), 'within-text': z.string().optional(),
  engine: ENGINE.default('chromium'), width: WIDTH.default('desktop'), as: z.string().optional(),
  timeout: z.coerce.number().positive().default(DEFAULT_TIMEOUT_S),
  value: z.string().optional(), option: z.string().optional(), path: z.string().optional(), label: z.string().optional(),
  aria: z.boolean().optional(), gone: z.boolean().optional(), page: z.boolean().optional(),
  expect: z.string().optional(), max: z.coerce.number().int().positive().default(DEFAULT_MAX_TABS),
  'ready-role': Role.optional(), 'ready-name': z.string().optional(), 'ready-text': z.string().optional(),
})
type DriveValues = z.infer<typeof DriveArgs>

function handleOf(values: DriveValues): Handle | undefined {
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

type OpName = Exclude<Op['op'], 'ping' | 'visual' | 'shutdown'> | 'uncheck'
// Where a capture goes: a path, or a label naming the numbered file in the evidence folder.
const CAPTURE: Flags = {
  path: { kind: 'string', about: 'where to save it' },
  label: { kind: 'string', about: 'a name for the file in the evidence folder' },
}
// Each operation: what follows its name, one line of help, its own flags, and
// whether it changes the page (a write, leading with ok:) or reads it. `outside`
// names the page text it prints, which the output fences as untrusted.
const DRIVE: Record<OpName, { args: string; about: string; flags: Flags; writes: boolean; outside: string }> = {
  goto: { args: '<route>', about: 'open a route, such as / or #/a/<agent id>, loading the page afresh', flags: {}, writes: true, outside: 'page text' },
  click: { args: '', about: 'click the element', flags: HANDLE, writes: true, outside: 'page text' },
  fill: { args: '', about: 'replace what the element holds with --value', flags: { ...HANDLE, value: { kind: 'string', about: 'the text to put in' } }, writes: true, outside: 'page text' },
  select: { args: '', about: 'pick a choice in a select box, by --option (its label) or --value', flags: { ...HANDLE, option: { kind: 'string', about: "the choice's label" }, value: { kind: 'string', about: "the choice's value" } }, writes: true, outside: 'page text' },
  check: { args: '', about: 'tick a checkbox', flags: HANDLE, writes: true, outside: 'page text' },
  uncheck: { args: '', about: 'untick a checkbox', flags: HANDLE, writes: true, outside: 'page text' },
  press: { args: '<key>', about: 'press a key, such as Enter or Tab, in the element or on the page', flags: HANDLE, writes: true, outside: 'page focus' },
  type: { args: '<text>', about: 'type text where the keyboard focus is', flags: {}, writes: true, outside: 'page focus' },
  wait: { args: '', about: 'wait until the element is there, or with --gone until it is not', flags: { ...HANDLE, gone: { kind: 'boolean', about: 'wait for it to go' } }, writes: false, outside: 'page text' },
  text: { args: '', about: "print the element's text; with --expect, wait until it holds that text", flags: { ...HANDLE, expect: { kind: 'string', about: 'text it must hold' } }, writes: false, outside: 'page text' },
  count: { args: '', about: 'count the matching elements; with --expect, wait until there are that many', flags: { ...HANDLE, expect: { kind: 'string', about: 'how many there must be' } }, writes: false, outside: 'page text' },
  snapshot: { args: '', about: "save and print the page's ARIA tree", flags: { aria: { kind: 'boolean', about: 'the ARIA tree, which is the one snapshot there is' }, ...CAPTURE }, writes: false, outside: 'page ARIA tree' },
  screenshot: { args: '', about: 'save a screenshot', flags: { page: { kind: 'boolean', about: 'the whole page, not only what shows' }, ...CAPTURE }, writes: false, outside: 'page text' },
  console: { args: '', about: 'list page and console errors since the last look; fails on any', flags: {}, writes: false, outside: 'console messages' },
  network: { args: '', about: 'list requests since the last look; fails on any that failed or answered 400 or more', flags: CAPTURE, writes: false, outside: 'page requests' },
  trace: { args: 'start|stop', about: 'record a Playwright trace from start to stop', flags: CAPTURE, writes: true, outside: 'page text' },
  overflow: { args: '', about: 'fail when the page scrolls sideways, naming what sticks out', flags: {}, writes: false, outside: 'page elements' },
  a11y: { args: '', about: 'run axe on the page; fail on serious or critical violations', flags: {}, writes: false, outside: 'page elements' },
  focus: { args: '', about: 'print what has the keyboard focus', flags: {}, writes: false, outside: 'page text' },
  'tab-to': { args: '', about: 'press Tab until the element has the focus, or fail', flags: { ...HANDLE, max: { kind: 'string', about: `presses to try (${String(DEFAULT_MAX_TABS)} by default)` } }, writes: true, outside: 'page focus' },
  record: { args: 'start|stop', about: 'record a video of the page from start to stop', flags: { label: { kind: 'string', about: 'what the recording shows' } }, writes: true, outside: 'page text' },
  close: { args: '', about: 'close this page', flags: {}, writes: true, outside: 'page text' },
}

// The operation a drive command asks for. Paths for captures are chosen once
// the instance's evidence folder is known.
function opFor(name: OpName, values: DriveValues, word: string, evidence: string | null): Op {
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

// The fields of what an operation found that hold what the page said.
const PAGE_FIELDS = ['outside', 'errors', 'network', 'violations', 'overflow', 'focus', 'path', 'captures'] as const

// What to try after a drive step, by what it did and how it went.
function driveHelp(target: Target, name: OpName | 'visual', found: Found | null, failedShot: string | null): string[] {
  if (!found) {
    return [
      run(`${target} snapshot --aria`, 'to list the roles and names on the page'),
      ...(failedShot ? [`Look at the page as it failed: ${relative(ROOT, failedShot)}`] : []),
      run(`${target} reset`, 'if the page is stuck, then goto the view again'),
    ]
  }
  if (name === 'record') return found.files.length ? [`Watch ${relative(ROOT, found.files[0] ?? '')}, and have an agent that did not drive it confirm what it shows`] : [run(`${target} record stop`, 'when the steps are done')]
  if (name === 'a11y' || name === 'console' || name === 'overflow') return found.pass ? [] : [run(`${target} screenshot`, 'to keep the view as evidence'), 'Report it as a product bug once it reproduces twice through the UI']
  if (name !== 'visual' && DRIVE[name].writes) return [run(`${target} snapshot --aria`, 'to see the result'), run(`${target} screenshot`, 'to keep it as evidence')]
  return []
}

// The route a page is on, read from the page after the operation.
const routeOf = (url: string) => new URL(url).hash || '#/'

// The page's words a failed drive read, fenced, and the data field holding them.
const pageWords = (reply: Extract<SessionReply, { ok: false }>, source: string) => (reply.outside === undefined ? { outside: [], untrusted: [] }
  : { outside: [{ source, text: reply.outside }], untrusted: [{ source, field: 'data.outside' }] })

function driveCommand(target: Target, name: OpName): Command {
  const spec = DRIVE[name]
  return command({
    name: `${target} ${name}`, args: spec.args, about: spec.about, flags: { ...spec.flags, ...PAGE }, schema: DriveArgs,
    prepare: (values, positionals) => {
      const word = positionals.join(' ')
      opFor(name, values, word, null)
      if (target === 'desktop' && values.engine !== 'chromium') throw new UsageError('the desktop app is Electron, so it takes no --engine')
      return async () => {
        const state = ready(values.instance)
        const reply = await sessionCall(state, {
          target, engine: values.engine, width: values.width, login: loginFor(state, values.as), timeoutMs: values.timeout * 1000,
          op: opFor(name, values, word, state.evidence),
        })
        if (!reply.ok) return failed(reply.error, { help: driveHelp(target, name, null, reply.files[0] ?? null), files: reply.files, data: reply, log: state.evidence, ...pageWords(reply, spec.outside) })
        const found = reply.found
        const [firstLine = '', ...more] = found.summary.split('\n')
        const shared = {
          help: driveHelp(target, name, found, null), files: found.files, data: found, log: state.evidence, detail: more.join('\n'),
          outside: found.outside ? [{ source: spec.outside, text: found.outside }] : [],
          untrusted: PAGE_FIELDS.filter((field) => found[field] !== undefined).map((field) => ({ source: spec.outside, field: `data.${field}` })),
        }
        if (!found.pass) return failed(firstLine, shared)
        if (spec.writes) return { kind: 'write', did: firstLine, state: `the page is at ${routeOf(found.url)}`, already: found.already === true, ...shared }
        return { kind: 'read', answer: firstLine, ...shared }
      }
    },
  })
}

// reset closes the whole browser session, for a page stuck in a state no step expects.
const resetCommand = (target: Target): Command => command({
  name: `${target} reset`, args: '', about: 'close the whole browser session; the next command opens a fresh one', flags: {}, schema: Common,
  prepare: (values) => async () => {
    const state = ready(values.instance)
    const closed = await stopSessionServer(state)
    const still = state.processes.filter((p) => p.role === 'session')
    let running = false
    for (const record of still) if (await isOurs(record)) running = true
    if (running) return failed('the browser session is still running after it was told to stop', { help: [run(`down${at(state)}`, 'and up again')], data: { closed }, log: state.evidence })
    return { kind: 'write', did: `${target} reset`, state: 'no browser session runs', already: !closed, help: [run(`${target} goto /`, 'to open a fresh page')], data: { closed }, log: state.evidence }
  },
})

// --- The API and the record ---

const ApiArgs = Common.extend({
  as: Caller.default('person'), login: z.string().optional(), door: Door.optional(), body: z.string().optional(),
  expect: z.coerce.number().int().optional(), 'expect-text': z.string().optional(),
})

const apiCommand = command({
  name: 'api', args: '<GET|POST|HEAD> <path>', about: 'call the API as a person, the machine or a webhook, and keep the answer',
  flags: {
    as: { kind: 'string', about: 'person (by default), machine or webhook' },
    login: { kind: 'string', about: 'which person: ada (by default), ben, or a login' },
    door: { kind: 'string', about: 'people or machines, the port to call' },
    body: { kind: 'string', about: 'a JSON body' },
    expect: { kind: 'string', about: 'the status it must answer (any 2xx by default)' },
    'expect-text': { kind: 'string', about: 'text the answer must hold' },
  },
  schema: ApiArgs,
  prepare: (values, positionals) => {
    const [methodText, path] = positionals
    const method = Method.safeParse(methodText)
    if (!method.success || !path) throw new UsageError('api takes a method and a path: api GET /v1/me')
    if (!path.startsWith('/v1/') && path !== '/') throw new UsageError(`the path must start with /v1/: ${path}`)
    let body: JsonValue | undefined
    if (values.body !== undefined) {
      try {
        body = JSON_VALUE.parse(JSON.parse(values.body))
      } catch (error) {
        throw new UsageError(`--body is not JSON: ${messageOf(error)}`)
      }
    }
    return async () => {
      const state = ready(values.instance)
      const reply = await call(state, { method: method.data, path, as: values.as, login: values.as === 'person' ? loginFor(state, values.login) : undefined, door: values.door, body })
      const file = nextPath(state.evidence, 'api', `${method.data}-${path}`, 'json')
      writeFileSync(file, `${JSON.stringify(scrubber()({ request: { method: method.data, path, as: values.as, body: body ?? null }, reply }), null, 2)}\n`)
      const statusOk = values.expect === undefined ? reply.status >= 200 && reply.status < 300 : reply.status === values.expect
      const shown = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body, null, 2)
      const wanted = values['expect-text']
      const missing = wanted !== undefined && !shown.includes(wanted) && !(typeof reply.body !== 'string' && JSON.stringify(reply.body).includes(wanted))
      const verb = `${method.data} ${path} as ${values.as}`
      const outside = [{ source: 'API answer', text: shown }]
      const untrusted = [{ source: 'API answer', field: 'data.body' }]
      if (!statusOk || missing) {
        const why = !statusOk ? (values.expect === undefined ? 'a 2xx was expected' : `${String(values.expect)} was expected`) : `the answer lacks "${wanted ?? ''}"`
        return failed(`${verb} answered ${String(reply.status)}, and ${why}`, { outside, untrusted, files: [file], data: reply, help: [`Read the answer in ${relative(ROOT, file)}`], log: state.evidence })
      }
      if (method.data === 'POST') {
        return { kind: 'write', did: verb, state: `the API answered ${String(reply.status)}`, already: false, outside, untrusted, files: [file], data: reply, help: [run('db "<select>"', 'to read the side effect back from the record')], log: state.evidence }
      }
      return { kind: 'read', answer: `${verb} answered ${String(reply.status)}`, outside, untrusted, files: [file], data: reply, help: [], log: state.evidence }
    }
  },
})

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
    // The value the row has is the record's, so it stays in the rows printed below the head.
    if (off) return `expected ${column}=${wanted} in every row, and a row has another value`
  }
  if (values.value && (rows.length !== 1 || Object.keys(rows[0] ?? {}).length !== 1)) return `--value needs one row with one column, and there are ${String(rows.length)} rows`
  return null
}

// What db --value may print alone: no spaces, quotes or line breaks, so it can't carry a sentence.
const PLAIN_VALUE = /^[\w.@:/+=-]{1,200}$/

const asRow = (row: Rows[number]): Row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))

const dbCommand = command({
  name: 'db', args: '"<select>"', about: 'read the record with one read-only query; {team}, {owner}, {teammate} and {machine} name the instance\'s rows',
  flags: {
    'expect-rows': { kind: 'string', about: 'how many rows there must be' },
    expect: { kind: 'strings', about: 'column=value every row must have' },
    wait: { kind: 'string', about: 'seconds to keep reading until the expectations hold' },
    value: { kind: 'boolean', about: 'print the one value alone, for use in another command' },
  },
  schema: DbArgs,
  prepare: (values, positionals) => {
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
      writeFileSync(file, `${JSON.stringify(scrubber()({ query: sql, rows }), null, 2)}\n`)
      const untrusted = [{ source: 'record rows', field: 'data.rows' }]
      const shared = { files: [file], data: { rows }, log: state.evidence, untrusted }
      const lines = rows.map((r) => Object.entries(asRow(r)).map(([k, v]) => `${k}=${v}`).join('  ')).join('\n')
      if (problem) {
        return failed(problem, { ...shared, outside: [{ source: 'record rows', text: lines }], help: [values.wait ? 'The record never reached that state. Check the step that should have written it' : 'Add `--wait <seconds>` if the row is still on its way'] })
      }
      // --value prints the one value and nothing else, not even the evidence file,
      // so a shell can put it in another command. It is the one head that holds a
      // value from the record, so it must be plain: an id, a name, a number.
      const first = Object.values(rows[0] ?? {})[0]
      if (values.value) {
        const value = typeof first === 'string' ? first : JSON.stringify(first ?? null)
        if (!PLAIN_VALUE.test(value)) return failed('the value is not plain enough to print alone (an id, a name or a number). Read it without --value', { ...shared, help: [] })
        return { kind: 'read', answer: value, help: [], data: shared.data, log: shared.log, untrusted }
      }
      return { kind: 'list', noun: 'rows', rows: rows.map(asRow), source: 'record rows', help: [], ...shared }
    }
  },
})

// --- Seeding: people, agents, boxes, repos and tasks, made as an admin would ---

const InstructionsArgs = Common.extend({ instructions: z.string().optional() })
const one = <T extends z.ZodType>(schema: T, rows: unknown[]): z.infer<T> | null => (rows.length ? schema.parse(rows[0]) : null)

const seedPerson = command({
  name: 'seed person', args: '<who>', about: 'add a person to the team, who can then open the app with --as <who>', flags: {}, schema: Common,
  prepare: (values, [who]) => {
    if (!who) throw new UsageError('seed person <who>')
    return async () => {
      const state = ready(values.instance)
      const login = loginFor(state, who)
      const { already } = await addPerson(state.team, login)
      const found = await withClient(async (client) => one(z.object({ login: z.string() }), (await client.query(
        'select p.login from people p join teams t on t.id = p.team_id where t.name = $1 and p.login = $2', [state.team, login])).rows))
      if (!found) return failed(`${login} is not on ${state.team} after adding them`, { help: [run(`doctor${at(state)}`, 'to check the instance')], data: { login }, log: state.evidence })
      return { kind: 'write', did: `seed person ${who}`, state: `${found.login} is on ${state.team}`, already, help: [run(`browser goto / --as ${who}`, `to open the app as ${who}`)], data: { login }, log: state.evidence }
    }
  },
})

const seedAgent = command({
  name: 'seed agent', args: '<name>', about: "add an agent that lives on the instance's machine", flags: { instructions: { kind: 'string', about: 'its instructions' } }, schema: InstructionsArgs,
  prepare: (values, [named]) => {
    if (!named) throw new UsageError('seed agent <name>')
    return async () => {
      const state = ready(values.instance)
      const { agentId, already } = await addAgent(state.team, named, values.instructions ?? `You are ${named}.`)
      const latest = readState(state.name)
      if (latest?.phase !== 'ready') throw new Error(`instance ${state.name} stopped while the agent was added`)
      if (!already) saveState({ ...latest, seed: { ...latest.seed, agents: { ...latest.seed.agents, [named]: agentId } } })
      const found = await withClient(async (client) => one(z.object({ machine: z.string() }), (await client.query(
        `select i.name as machine from agents a join instances i on i.id = a.home_instance_id where a.id = $1 and a.archived_at is null`, [agentId])).rows))
      if (!found) return failed(`${named} has no home machine after it was added`, { help: [], data: { agentId }, log: state.evidence })
      return { kind: 'write', did: `seed agent ${named}`, state: `${named} lives on ${found.machine}`, already, help: [run(`browser click --role button --name ${named} --within list:Agents`, 'to open its DM')], data: { agent: named, agentId }, log: state.evidence }
    }
  },
})

const seedBox = command({
  name: 'seed box', args: '<name>', about: 'add a box, with no container until someone claims it', flags: {}, schema: Common,
  prepare: (values, [named]) => {
    if (!named) throw new UsageError('seed box <name>')
    return async () => {
      const state = ready(values.instance)
      const { already } = await addBox(state.team, named, state.seed.owner.login)
      const found = await withClient(async (client) => one(z.object({ status: z.string(), claimed: z.boolean() }), (await client.query(
        `select status, claimed_by is not null as claimed from instances where team_id = $1 and name = $2 and kind = 'box'`, [state.seed.teamId, named])).rows))
      if (!found) return failed(`the box ${named} is not on the team after adding it`, { help: [], data: { box: named }, log: state.evidence })
      return {
        kind: 'write', did: `seed box ${named}`, state: `${named} is ${found.status} and ${found.claimed ? 'claimed' : 'free'}`, already,
        help: [run(`browser click --role button --name Claim --within listitem --within-text "${named} (box)"`, 'to claim it')], data: { box: named }, log: state.evidence,
      }
    }
  },
})

const seedRepo = command({
  name: 'seed repo', args: '<name>', about: "add a repo on the instance's forge org, cloned from the sample shop", flags: {}, schema: Common,
  prepare: (values, [named]) => {
    if (!named) throw new UsageError('seed repo <name>')
    return async () => {
      const state = ready(values.instance)
      const { repo, already } = await seedExtraRepo(state, named)
      const found = await withClient(async (client) => one(z.object({ remote_url: z.string() }), (await client.query('select remote_url from repos where id = $1', [repo.repoId])).rows))
      if (!found) return failed(`${repo.path} is not among the team's repos after adding it`, { help: [], data: repo, log: state.evidence })
      return { kind: 'write', did: `seed repo ${named}`, state: `${repo.path} is a team repo at ${found.remote_url}`, already, help: [run('browser click --role button --name "New task"', 'to start a task on it')], data: repo, log: state.evidence }
    }
  },
})

const seedTask = command({
  name: 'seed task', args: '', about: 'start a task for an agent, as a person does with New task',
  flags: { title: { kind: 'string', about: 'what needs doing' }, agent: { kind: 'string', about: 'the agent (fixer by default)' }, instructions: { kind: 'string', about: 'details for the agent' } },
  schema: InstructionsArgs.extend({ title: z.string(), agent: z.string().default('fixer') }),
  prepare: (values) => async () => {
    const state = ready(values.instance)
    const agentId = state.seed.agents[values.agent]
    if (!agentId) throw new UsageError(`no agent named ${values.agent} on the instance: ${Object.keys(state.seed.agents).join(', ')}`)
    const existing = async () => withClient(async (client) => one(z.object({ id: z.string(), title: z.string() }), (await client.query(
      'select id, title from tasks where team_id = $1 and title = $2 order by created_at desc limit 1', [state.seed.teamId, values.title])).rows))
    const had = await existing()
    if (!had) {
      const reply = await call(state, { method: 'POST', path: '/v1/tasks', as: 'person', body: { title: values.title, instructions: values.instructions ?? '', agentId } })
      if (reply.status < 200 || reply.status >= 300) return failed(`POST /v1/tasks answered ${String(reply.status)}`, { outside: [{ source: 'API answer', text: JSON.stringify(reply.body) }], untrusted: [{ source: 'API answer', field: 'data.body' }], help: [run(`doctor${at(state)}`, 'to check the instance')], data: reply, log: state.evidence })
    }
    const task = await existing()
    if (!task) return failed(`no task titled "${values.title}" after starting it`, { help: [], data: null, log: state.evidence })
    return { kind: 'write', did: `seed task "${values.title}"`, state: `the task is at #/t/${task.id}, for ${values.agent}`, already: had !== null, help: [run(`browser goto "#/t/${task.id}"`, 'to open it')], data: { taskId: task.id }, log: state.evidence }
  },
})

// --- The instance's machine: its secrets and its files ---

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/
const secretsFile = (state: ReadyState) => join(state.scratch, 'daemon', 'secrets.json')
const readSecrets = (file: string) => (existsSync(file) ? z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(file, 'utf8'))) : {})

// A file's text with every secret value the machine holds replaced by [secret:NAME],
// so reading secrets.json, or a file the daemon wrote from it, shows names and no
// value. Each value is masked as it is and as JSON spells it, since secrets.json
// holds a quote or a backslash with an escape.
function maskedFile(state: ReadyState, text: string): string {
  const held = Object.entries(readSecrets(secretsFile(state))).filter(([, value]) => value !== '')
  return scrubber(held.flatMap(([name, value]): [string, string][] => [[name, value], [name, JSON.stringify(value).slice(1, -1)]]))(text)
}

function secretCommand(action: 'set' | 'unset'): Command {
  return command({
    name: `secret ${action}`, args: '<NAME>', about: action === 'set' ? "give the machine a secret's value, where a person keeps it" : "take a secret's value off the machine",
    flags: action === 'set' ? { value: { kind: 'string', about: 'the value, which no log or output repeats', secret: true } } : {},
    schema: Common.extend({ value: z.string().optional() }),
    prepare: (values, [key]) => {
      if (!key || !SECRET_NAME.test(key)) throw new UsageError(`secret ${action} <NAME>, in capitals, such as NOTES_TOKEN`)
      if (action === 'set' && values.value === undefined) throw new UsageError('secret set needs --value')
      return async () => {
        const state = ready(values.instance)
        const file = secretsFile(state)
        const current = readSecrets(file)
        const already = action === 'set' ? current[key] === values.value : !(key in current)
        if (!already) {
          const next = action === 'set' && values.value !== undefined ? { ...current, [key]: values.value } : Object.fromEntries(Object.entries(current).filter(([k]) => k !== key))
          mkdirSync(join(state.scratch, 'daemon'), { recursive: true })
          writeFileSync(file, JSON.stringify(next), { mode: 0o600 })
        }
        const held = key in readSecrets(file)
        if (held !== (action === 'set')) return failed(`the machine ${held ? 'still holds' : 'does not hold'} ${key} after secret ${action}`, { help: [], data: { secret: key }, log: state.evidence })
        return {
          kind: 'write', did: `secret ${action} ${key}`, state: `${held ? 'held' : 'not held'} by the machine ${state.seed.machine.name}`, already,
          help: [`Message an agent whose plugin needs ${key}: it reads the machine's secrets when its next session starts`], data: { secret: key, held }, log: state.evidence,
        }
      }
    },
  })
}

// A file on the instance's machine, read the way a person would look on their
// Mac: an agent's folder (agents/<agent id>), a task's workspace
// (workspaces/<workspace id>), or secrets.json. It waits for the file to appear,
// or with --missing for it to be absent.
const machineRead = command({
  name: 'machine read', args: "<path in the machine's home>", about: "read a file on the instance's machine, waiting for it to appear",
  flags: {
    'expect-text': { kind: 'string', about: 'text the file must hold' },
    missing: { kind: 'boolean', about: 'wait for the file to be absent instead' },
    timeout: { kind: 'string', about: `seconds to wait (${String(DEFAULT_TIMEOUT_S)} by default)` },
  },
  schema: Common.extend({ 'expect-text': z.string().optional(), missing: z.boolean().optional(), timeout: z.coerce.number().positive().default(DEFAULT_TIMEOUT_S) }),
  prepare: (values, [path]) => {
    if (!path) throw new UsageError("machine read <path in the machine's home> [--expect-text <text>] [--missing]")
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Refused(`${path} is outside the machine's home`, ['Give a path inside it, such as agents/<agent id>/first.txt'])
    return async () => {
      const state = ready(values.instance)
      const file = join(state.scratch, 'daemon', path)
      const deadline = Date.now() + values.timeout * 1000
      const look = () => (existsSync(file) ? maskedFile(state, readFileSync(file, 'utf8')) : null)
      const holds = (text: string | null) => (values.missing ? text === null : text !== null && (values['expect-text'] === undefined || text.includes(values['expect-text'])))
      let text = look()
      while (!holds(text) && Date.now() < deadline) {
        await sleep(POLL_MS)
        text = look()
      }
      const shared = { help: [], data: { path, exists: text !== null }, log: state.evidence }
      const outside = text === null ? [] : [{ source: 'file on the machine', text }]
      if (values.missing) return text === null ? { kind: 'read', answer: `${path} is not on the machine`, ...shared } : failed(`${path} is on the machine, and should not be`, { ...shared, outside })
      if (text === null) return failed(`${path} is not on the machine`, shared)
      if (!holds(text)) return failed(`${path} does not hold "${values['expect-text'] ?? ''}"`, { ...shared, outside })
      return { kind: 'read', answer: `${path} holds ${String(text.length)} characters`, outside, ...shared }
    }
  },
})

// --- Visual regression ---

const VisualArgs = Common.extend({ from: z.string().optional(), reason: z.string().optional(), view: z.array(z.string()).optional(), baselines: z.string().optional() })
const FROM: Flags = {
  from: { kind: 'string', about: "a run's evidence folder (the instance's by default)" },
  baselines: { kind: 'string', about: 'a baselines folder (.scratch/verify/baselines by default)' },
}
const fromRoot = (path: string) => (path.startsWith('/') ? path : join(ROOT, path))
const evidenceOf = (values: z.infer<typeof VisualArgs>) => (values.from ? fromRoot(values.from) : resolve(values.instance).evidence)

const visualShot = command({
  name: 'visual shot', args: '<view>', about: 'capture the current view in three engines at two widths, check each, and list them in evidence.json',
  flags: { ...PAGE, ...READY }, schema: DriveArgs,
  prepare: (values, [view]) => {
    if (!view || !/^[a-z0-9][a-z0-9-]*$/.test(view)) throw new UsageError('visual shot needs a view name in lowercase words and dashes, such as conversation-dm')
    const readyHandle = values['ready-role'] ? { role: values['ready-role'], name: values['ready-name'], text: values['ready-text'] } : undefined
    return async () => {
      const state = ready(values.instance)
      const reply = await sessionCall(state, {
        target: 'browser', engine: values.engine, width: values.width, login: loginFor(state, values.as), timeoutMs: values.timeout * 1000,
        op: { op: 'visual', state: view, ready: readyHandle },
      })
      if (!reply.ok) return failed(reply.error, { help: driveHelp('browser', 'visual', null, reply.files[0] ?? null), files: reply.files, data: reply, log: state.evidence, ...pageWords(reply, 'page text') })
      const found = reply.found
      const manifestFile = join(state.evidence, EVIDENCE_MANIFEST_FILE)
      const listed = existsSync(manifestFile) ? EVIDENCE_MANIFEST.parse(JSON.parse(readFileSync(manifestFile, 'utf8'))).shots.filter((s) => s.view === view).length : 0
      const shared = {
        detail: found.summary, help: [run('visual compare', 'to diff the captures against the baselines')], files: found.files, data: found, log: state.evidence,
        outside: found.outside ? [{ source: 'console messages', text: found.outside }] : [],
        untrusted: [{ source: 'console messages', field: 'data.captures' }, ...(found.outside === undefined ? [] : [{ source: 'console messages', field: 'data.outside' }])],
      }
      if (!found.pass) return failed('a capture had a problem', shared)
      return { kind: 'write', did: `visual shot ${view}`, state: `${String(listed)} captures of ${view} in ${relative(ROOT, manifestFile)}, each checked`, already: false, ...shared }
    }
  },
})

const visualCompare = command({
  name: 'visual compare', args: '', about: "diff a run's captures against the baselines, naming each changed region", flags: FROM, schema: VisualArgs,
  prepare: (values) => async () => {
    const evidence = evidenceOf(values)
    const result = compare(evidence, values.baselines === undefined ? BASELINES_DIR : fromRoot(values.baselines))
    const bad = result.results.filter((r) => r.status !== 'same' && r.status !== 'within tolerance')
    const lines = result.results.map((r) => `${bad.includes(r) ? 'FAIL' : 'pass'}  ${r.view} ${r.engine}-${r.width}: ${r.detail}${r.diff ? ` (diff ${relative(ROOT, r.diff)})` : ''}`)
    if (result.notCaptured.length) lines.push(`not captured this run: ${result.notCaptured.join(', ')}`)
    const shared = { detail: lines.join('\n'), files: result.results.flatMap((r) => (r.diff ? [r.diff] : [])), data: result }
    if (!result.results.length) return failed(`no captures in ${relative(ROOT, join(evidence, EVIDENCE_MANIFEST_FILE))}`, { ...shared, help: [run('map run all --visual', 'to take every capture'), run('visual shot <view>', 'for one view')] })
    if (!result.ok) {
      return failed(`${String(bad.length)} of ${String(result.results.length)} captures differ`, {
        ...shared, help: ['Open each diff: red marks what changed', run('visual baseline --reason "<why the view changed on purpose>"', 'only if the change is intended'), 'Otherwise it is a regression: reproduce it and report it'],
      })
    }
    return { kind: 'read', answer: `${String(result.results.length)} captures match their baselines`, help: [], ...shared }
  },
})

const visualBaseline = command({
  name: 'visual baseline', args: '', about: "make a run's captures the baselines, logging why",
  flags: { ...FROM, reason: { kind: 'string', about: 'why the view changed on purpose' }, view: { kind: 'strings', about: 'only this view' } }, schema: VisualArgs,
  prepare: (values) => {
    // Checked before anything is copied, so a refused reason leaves the baselines as they were.
    const parsedReason = BaselineReason.safeParse(values.reason)
    if (!parsedReason.success) throw new UsageError(`visual baseline needs --reason "<why the view changed on purpose>": ${z.prettifyError(parsedReason.error)}`)
    const reason = parsedReason.data
    return async () => {
      const evidence = evidenceOf(values)
      const dir = values.baselines === undefined ? BASELINES_DIR : fromRoot(values.baselines)
      const { update, unchanged } = baseline(evidence, reason, values.view ?? [], dir)
      const after = compare(evidence, dir).results.filter((r) => !values.view?.length || values.view.includes(r.view))
      const matching = after.filter((r) => r.status === 'same').length
      if (matching !== after.length) return failed(`${String(after.length - matching)} baselines still differ from the run's captures after the update`, { help: [], data: { update, unchanged } })
      return {
        kind: 'write', did: 'visual baseline', state: `${String(matching)} baselines match the run's captures`, already: update === null,
        detail: update ? `reason: ${reason}` : '', help: [run('visual compare', 'to confirm the run matches')], files: update?.files ?? [], data: { update, unchanged },
      }
    }
  },
})

// --- The feature map ---

const mapList = command({
  name: 'map list', args: '', about: 'list the features in the map, in sweep order', flags: {}, schema: Common,
  fields: { all: ['id', 'name', 'steps', 'paths', 'checks', 'file'], shown: ['id', 'name', 'steps'] },
  prepare: () => async () => {
    const features = listMap()
    return {
      kind: 'list', noun: 'features', help: [run('map run <feature>', 'to drive one'), run('map run all --visual', 'for the full sweep')], data: features,
      rows: features.map((f) => ({ id: f.id, name: f.entry.name, steps: String(f.steps.length), paths: f.entry.paths.join(','), checks: f.entry.checks.join(','), file: relative(ROOT, f.file) })),
    }
  },
})

const mapCheck = command({
  name: 'map check', args: '', about: 'check every feature file, the index and features.json, without running anything', flags: {}, schema: Common,
  prepare: () => async () => {
    const problems = checkMap((argv) => { parseOnly(CLI, argv) })
    if (problems.length) return failed(`${String(problems.length)} problems`, { detail: problems.join('\n'), help: ['Fix each file named, then check again'], data: { problems } })
    return { kind: 'read', answer: 'every feature file has its map entry and four sections, the index lists each one, every command in it parses, and features.json matches', help: [], data: { problems } }
  },
})

const mapExport = command({
  name: 'map export', args: '', about: "write features.json, the map the framework's gates read, from the feature files' entries", flags: {}, schema: Common,
  prepare: () => async () => {
    const { file, map, already } = exportMap()
    const reread = FEATURE_MAP.parse(JSON.parse(readFileSync(file, 'utf8')))
    return {
      kind: 'write', did: 'map export', state: `${relative(ROOT, file)} lists ${String(reread.features.length)} features`, already,
      help: [run('map check', 'to confirm the map is whole')], files: already ? [] : [file], data: map,
    }
  },
})

const mapGuard = command({
  name: 'map guard', args: '', about: 'fail when the map lost or changed an assertion it had at a base commit',
  flags: { base: { kind: 'string', about: 'the git ref to compare with, such as origin/main' } }, schema: Common.extend({ base: z.string() }),
  prepare: (values) => async () => {
    const removed = await guardMap(values.base)
    if (removed.length) {
      return failed(`${String(removed.length)} assertions were removed or changed since ${values.base}`, {
        detail: removed.join('\n'), data: { base: values.base, removed },
        help: ['A weaker map can hide a regression. Put each assertion back, or name in the pull request the commit that removed its feature'],
      })
    }
    return { kind: 'read', answer: `every assertion the map had at ${values.base} is still there`, help: [], data: { base: values.base, removed } }
  },
})

const mapRun = command({
  name: 'map run', args: '<feature ...|all>', about: 'run feature files as written, giving each step a verdict',
  flags: { visual: { kind: 'boolean', about: 'also take the visual captures' }, 'keep-going': { kind: 'boolean', about: 'run every step even after one fails' } },
  schema: Common.extend({ visual: z.boolean().optional(), 'keep-going': z.boolean().optional() }),
  prepare: (values, positionals) => {
    if (!positionals.length) throw new UsageError('map run takes feature names, or all')
    return async () => {
      const state = ready(values.instance)
      const health = async () => {
        const report = await doctor(state.name)
        return { ok: report.ok, why: report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ') }
      }
      const report = await runMap(state, positionals, { visual: values.visual === true, keepGoing: values['keep-going'] === true }, runCli, health)
      const failing = report.features.filter((f) => f.verdict === 'verifier-failed')
      const blocked = report.features.filter((f) => f.verdict === 'verifier-blocked')
      // Step results quote what the page and the record said.
      const source = 'step results, which quote the page and the record'
      const shared = { outside: [{ source, text: report.text }], untrusted: [{ source, field: 'data.features' }, { source, field: 'data.text' }], files: [report.file], data: report, log: state.evidence }
      if (!report.ok) {
        return failed(`of ${String(report.features.length)} features, ${String(failing.length)} failed and ${String(blocked.length)} could not be checked (blocked)`, {
          ...shared, help: [
            ...(failing.length ? [run('browser record start --label "<what it shows>"', 'and reproduce each failed step twice through the UI before calling it a bug')] : []),
            ...(values['keep-going'] ? [] : [run(`map run ${positionals.join(' ')} --keep-going`, 'to give every step a verdict')]),
            `Read the report: ${relative(ROOT, report.file)}`,
          ],
        })
      }
      return { kind: 'read', answer: `every step of ${positionals.join(', ')} is live-ui-verified`, help: [values.visual ? run('visual compare', 'to diff the captures against the baselines') : run(`map run ${positionals.join(' ')} --visual`, 'to also capture the views'), run(`down${at(state)}`, 'when you are done')], ...shared }
    }
  },
})

// --- The instance itself ---

function upHelp(state: ReadyState): string[] {
  return [
    run(`doctor${at(state)}`, 'to prove it is usable'),
    run('browser goto /', `to open the app as ${state.seed.owner.login}`),
    run(state.pipelines ? 'map run all' : 'map run getting-in', 'to drive the feature map'),
  ]
}

const upCommand = command({
  name: 'up', args: '', about: 'start an isolated Agents on ports 8020 to 8039, against the test database',
  flags: {
    port: { kind: 'string', about: 'the first of its three ports' },
    claude: { kind: 'string', about: 'fake (by default), the scripted harness, or real Claude sessions' },
    pipelines: { kind: 'boolean', about: 'also set up the forge org and the pipelines' },
    'no-build': { kind: 'boolean', about: 'serve the app as last built' },
  },
  schema: Common.extend({ port: z.coerce.number().int().optional(), claude: Harness.default('fake'), pipelines: z.boolean().optional(), 'no-build': z.boolean().optional() }),
  prepare: (values) => async () => {
    const { state, already } = await up({ name: values.instance, port: values.port, harness: values.claude, pipelines: values.pipelines === true, build: values['no-build'] !== true })
    const after = readState(state.name)
    if (after?.phase !== 'ready') return failed(`${state.name} is ${after?.phase ?? 'gone'} after up`, { help: [run(`down${at(state)}`, 'and up again')], data: after })
    const detail = [
      `team: ${after.team}`,
      `people: ${after.seed.owner.login} (ada), ${after.seed.teammate.login} (ben)`,
      `agents: ${Object.keys(after.seed.agents).join(', ')} on the machine ${after.seed.machine.name}`,
      `app: http://127.0.0.1:${String(after.ports.people)}/ (${INVOKE} browser sends the login)`,
      `claude: ${after.harness === 'fake' ? 'the fake harness, test/fake-claude.ts' : 'real Claude sessions'}`,
      `pipelines: ${after.pipelines ? `bug-fix, improve and coach, from the forge org verify-${after.name}` : 'none (up --pipelines adds them)'}`,
      `evidence: ${relative(ROOT, after.evidence)}`,
    ].join('\n')
    return { kind: 'write', did: `up ${after.name}`, state: `ready on ports ${String(after.ports.machines)}-${String(after.ports.streams)}`, already, detail, help: upHelp(after), data: after, log: after.evidence }
  },
})

// What doctor prints: a line per check in the tool's own words, and fenced, the
// words any check read from a server.
export function doctorParts(report: DoctorReport) {
  const source = 'server answer'
  const outside = report.checks.flatMap((c) => (c.outside === undefined ? [] : [{ source, text: `${c.name}: ${c.outside}` }]))
  return {
    detail: report.checks.map((c) => `${c.ok ? 'pass' : 'FAIL'}  ${c.name}: ${c.detail}`).join('\n'),
    outside, untrusted: outside.length ? [{ source, field: 'data.checks' }] : [],
  }
}

const doctorCommand = command({
  name: 'doctor', args: '', about: 'check, without changing anything, that the instance is usable', flags: {}, schema: Common,
  prepare: (values) => async () => {
    const state = resolve(values.instance)
    const report = await doctor(values.instance)
    const failing = report.checks.filter((c) => !c.ok)
    const parts = doctorParts(report)
    if (!report.ok) {
      return failed(`${failing.map((c) => c.name).join(', ')} failed`, { ...parts, help: [`Read the logs in ${relative(ROOT, state.evidence)}`, run(`down${at(state)}`, 'and up again if it does not recover')], data: report, log: state.evidence })
    }
    return { kind: 'read', answer: `${state.name} is usable: ${String(report.checks.length)} checks pass`, ...parts, help: state.phase === 'ready' ? upHelp(state) : [], data: report, log: state.evidence }
  },
})

const downCommand = command({
  name: 'down', args: '', about: 'stop what the instance started and remove its team, keeping its evidence',
  flags: { 'keep-data': { kind: 'boolean', about: 'keep its team, repos and boxes, until down runs again without it' } }, schema: Common.extend({ 'keep-data': z.boolean().optional() }),
  prepare: (values) => async () => {
    const done = await down(values.instance, { keepData: values['keep-data'] === true })
    if (!done) {
      const gone = values.instance ? readState(values.instance) === null : list().length === 0
      if (!gone) return failed('down stopped nothing, and the instance is still in this checkout', { help: [run('list', 'to see what is here')], data: null })
      return { kind: 'write', did: 'down', state: values.instance ? `${values.instance} is not in this checkout` : 'no instance in this checkout', already: true, help: [run('up --pipelines', 'to start an instance')], data: null }
    }
    const { state: stopped, already } = done
    const evidenceKept = existsSync(stopped.evidence)
    const removed = stopped.phase === 'kept' ? [] : [
      stopped.removed.team ? `team ${stopped.team}` : '', ...stopped.removed.repos, ...stopped.removed.containers,
      ...stopped.removed.joinRequests.map((login) => `the join request of ${login}`), stopped.removed.scratch ? 'its scratch folder' : '',
    ].filter(Boolean)
    const detail = [
      stopped.survivors.length ? `still running: ${stopped.survivors.map((s) => `${String(s.pid)} ${s.command}`).join('; ')}` : 'still running: none',
      stopped.phase === 'kept' ? 'kept: its team, repos, boxes and scratch folder, until down runs again without --keep-data' : `removed: ${removed.length ? removed.join(', ') : 'nothing'}`,
    ].join('\n')
    if (stopped.survivors.length || !evidenceKept) {
      return failed(stopped.survivors.length ? `${String(stopped.survivors.length)} processes ${stopped.name} started are still running` : `the evidence folder of ${stopped.name} is missing`, {
        detail, help: ['Stop each survivor by its pid after checking with `ps -ww -p <pid>` that it is the instance\'s'], data: stopped, log: stopped.evidence,
      })
    }
    return {
      kind: 'write', did: `down ${stopped.name}`, state: `nothing it started is running, and its evidence is in ${relative(ROOT, stopped.evidence)}`, already, detail,
      help: [
        ...(stopped.phase === 'kept' ? [run(`down --instance ${stopped.name}`, 'to remove what it kept')] : []),
        run(`visual compare --from ${relative(ROOT, stopped.evidence)}`, 'to diff its captures, if it took any'), run('up --pipelines', 'to start a fresh instance'),
      ], data: stopped, log: stopped.evidence,
    }
  },
})

const listCommand = command({
  name: 'list', args: '', about: 'list the instances in this checkout', flags: {}, schema: Common,
  fields: { all: ['name', 'phase', 'ports', 'claude', 'pipelines', 'evidence'], shown: ['name', 'phase', 'ports'] },
  prepare: () => async () => {
    const states = list()
    return {
      kind: 'list', noun: 'instances', data: states,
      rows: states.map((s) => ({ name: s.name, phase: s.phase, ports: `${String(s.ports.machines)}-${String(s.ports.streams)}`, claude: s.harness, pipelines: String(s.pipelines), evidence: relative(ROOT, s.evidence) })),
      help: states.length ? states.map((s) => run(`doctor${at(s)}`, `to check ${s.name}`)) : [run('up --pipelines', 'to start one')],
    }
  },
})

const evidenceCommand = command({
  name: 'evidence', args: '', about: "list what the instance's run did, from its evidence folder", flags: {}, schema: Common,
  fields: { all: ['at', 'command', 'ok', 'summary'], shown: ['command', 'ok', 'summary'] },
  prepare: (values) => async () => {
    const state = resolve(values.instance)
    if (!existsSync(state.evidence)) return failed(`the evidence folder ${relative(ROOT, state.evidence)} is missing`, { help: [], data: null })
    const done = actions(state.evidence)
    return {
      kind: 'list', noun: 'actions', source: 'action log', detail: `folder: ${relative(ROOT, state.evidence)}`, untrusted: [{ source: 'action log', field: 'data.actions' }],
      rows: done.map((a) => ({ at: a.at, command: a.command, ok: String(a.ok), summary: a.summary.split('\n')[0] ?? '' })),
      help: [], data: { evidence: state.evidence, actions: done },
    }
  },
})

// The dashboard: what runs here, whether it answers, and what to try next.
async function dashboard(): Promise<Result> {
  const states = list()
  const rows: string[] = []
  for (const state of states) {
    const alive = state.processes.filter((p) => p.role !== 'session')
    let running = alive.length > 0
    for (const record of alive) if (!(await isOurs(record))) running = false
    const answers = state.phase === 'ready' && running ? (await call(state, { method: 'GET', path: '/v1/me', as: 'person' }).catch(() => null))?.status === 200 : false
    rows.push(`${state.name},${state.phase},${String(state.ports.machines)}-${String(state.ports.streams)},${state.harness},${state.pipelines ? 'pipelines' : 'no pipelines'},${answers ? 'answers' : running ? 'running, not answering' : 'not running'}`)
  }
  // Folders are named <instance>-<when it started>, so the part after the last dash orders them by time.
  const when = (folder: string) => folder.slice(folder.lastIndexOf('-') + 1)
  const folders = existsSync(EVIDENCE_DIR) ? readdirSync(EVIDENCE_DIR).sort((a, b) => when(b).localeCompare(when(a))) : []
  const recent = folders.slice(0, RECENT_EVIDENCE)
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
    folders.length ? `evidence, ${String(recent.length)} of ${String(folders.length)} folders:\n${evidence.map((e) => `  - ${e}`).join('\n')}` : 'evidence: none yet',
  ].join('\n')
  return { kind: 'read', answer: 'agentsctl: run and drive Agents for verification', detail, help, data: { instances: states, evidence: recent } }
}

// Commands that act on no instance.
const NO_INSTANCE = new Set(['up', 'list', 'map list', 'map check', 'map export', 'map guard', 'visual compare', 'visual baseline'])

// What a command would do, once its arguments have parsed. Runs nothing.
function dryRun(target: Command, argv: string[], values: Record<string, unknown>): Result {
  const shown = argv.filter((a) => a !== '--dry-run' && a !== '--json').map((a) => (/^[\w./:@=-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')
  const named = Common.parse(values).instance
  let where = ''
  let instance: InstanceState | null = null
  if (!NO_INSTANCE.has(target.name)) {
    try {
      instance = resolve(named)
      where = ` It would act on instance ${instance.name}, which is ${instance.phase}.`
    } catch (error) {
      where = ` It would fail: ${messageOf(error)}`
    }
  }
  return { kind: 'read', answer: `dry run: ${INVOKE} ${shown} parses.${where} Nothing ran.`, help: [`Run it without --dry-run: ${INVOKE} ${shown}`], data: { argv, instance: instance?.name ?? null } }
}

const OPS = Object.keys(DRIVE).filter((k): k is OpName => k in DRIVE)

export const CLI: Cli = {
  name: 'agentsctl',
  invoke: INVOKE,
  about: 'run and drive Agents for verification. Run it from the repo root with ~/.local/node/bin first on PATH.',
  global: GLOBAL,
  commands: [
    upCommand, doctorCommand, downCommand, listCommand, evidenceCommand,
    ...OPS.map((op) => driveCommand('browser', op)), resetCommand('browser'),
    ...OPS.map((op) => driveCommand('desktop', op)), resetCommand('desktop'),
    apiCommand, dbCommand, seedPerson, seedAgent, seedBox, seedRepo, seedTask, secretCommand('set'), secretCommand('unset'), machineRead,
    visualShot, visualCompare, visualBaseline, mapList, mapCheck, mapExport, mapGuard, mapRun,
  ],
  dashboard,
  dryRun,
  after: (result, output, argv) => {
    if (result.log) record(result.log, { command: output.command, args: argv, ok: output.ok, summary: output.head, files: output.files })
  },
  failureHelp: [run('doctor', 'to check the instance'), "If this keeps happening, read the logs in the instance's evidence folder"],
  scrub: scrubber,
}

export const runCli = (argv: string[]) => dispatch(CLI, argv)
