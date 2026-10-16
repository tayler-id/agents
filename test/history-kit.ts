// The team the History checks look at: three people, two Macs, two agents, and ten
// sessions of every kind, some private, with steps that fail and one that is
// long. step26 reads it through the API and step26b through the app. It is built
// the way production builds it: people post to the people port, Macs post to the
// machine port as their daemons do, and the few rows no route makes (a private
// conversation, a run, a repo) are written to the test database directly.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Shape, ShapeStream, type Row } from '@electric-sql/client'
import pg from 'pg'
import { must } from './must.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname

export type Ports = { machines: number; people: number; streams: number }

// One step a machine posts.
export type Posted = { clientId: string; kind: string; text?: string; body: unknown; toolUseId?: string; toolName?: string; parentToolUseId?: string }

// A word that appears in one session only, so a search for it finds that session and no other.
export const WORDS = {
  dm: 'quokka', room: 'wombat', privateDm: 'narwhal', task: 'pangolin', privateTask: 'axolotl', run: 'capybara',
  terminal: 'zanzibar', privateTerminal: 'okapi', bensTerminal: 'tapir', old: 'dodo', long: 'marmot',
  // Every session says this once, so a search for it finds every session the person may see.
  all: 'osprey',
}

// A result far longer than the text column keeps, whose last line is in the body only.
export const BIG_END = 'END-OF-THE-RESULT'
export const BIG_RESULT = `${Array.from({ length: 900 }, (_, i) => `line ${String(i)} of the big output`).join('\n')}\n${BIG_END}`
export const TEXT_COLUMN = 8000

let counter = 0
const step = (kind: string, text: string | undefined, body: unknown, more: Partial<Posted> = {}): Posted =>
  ({ clientId: `kit-${String(++counter)}-${randomBytes(3).toString('hex')}`, kind, text, body, ...more })
export const said = (text: string) => step('assistant', text, { text, model: 'haiku' })
const everyone = () => said(`${WORDS.all} was here`)
export const typed = (text: string) => step('user', text, { text })
export const called = (id: string, name: string, input: Record<string, unknown>) => {
  const subject = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : ''
  return step('tool_call', `${name} ${subject}`, { id, name, input }, { toolUseId: id, toolName: name })
}
export const answered = (id: string, text: string, isError = false) =>
  step('tool_result', text, { toolUseId: id, content: [{ type: 'text', text }], isError }, { toolUseId: id })
export const turnEnded = (cost: number) => step('usage', undefined, { subtype: 'success', duration_ms: 2631, num_turns: 3, total_cost_usd: cost, terminal_reason: 'completed' })
export const failed = (text: string) => step('error', text, { subtype: 'error_max_turns', result: text })
export const bookkeeping = () => step('notice', 'hook_started', { subtype: 'hook_started' })
export const started = () => step('notice', 'init', { subtype: 'init', cwd: '/work', model: 'haiku' })

export type Person = { login: string; get: (path: string) => Promise<Response>; post: (path: string, body: unknown) => Promise<Response>; json: (path: string) => Promise<{ status: number; body: any }> }

export type World = {
  team: string
  ids: { ava: string; ben: string; cleo: string; scout: string; fixer: string; project: string; repo: string; run: string }
  logins: { ava: string; ben: string; cleo: string }
  sessions: Record<'dm' | 'room' | 'privateDm' | 'task' | 'privateTask' | 'run' | 'terminal' | 'privateTerminal' | 'bensTerminal' | 'old' | 'long', string>
  // The long session's shape: its steps' numbers that went wrong, those that are bookkeeping, and the one with the big result.
  long: { errors: number[]; hidden: number[]; last: number; big: number; shown: number }
  tokens: { avaMac: string; benMac: string }
  folders: { shop: string; diary: string; notes: string }
  api: string
  people: string
  db: pg.Client
  as: (login: string) => Person
  machine: (token: string, method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>
  shapeRows: (login: string, name: string, params?: Record<string, string>) => Promise<Row[]>
  stop: (keep: boolean) => Promise<void>
}

const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })

export async function buildWorld(name: string, ports: Ports, options: { buildApp: boolean } = { buildApp: false }): Promise<World> {
  const id = randomBytes(4).toString('hex')
  const team = `${name}-${id}`
  const logins = { ava: `ava-${id}@local`, ben: `ben-${id}@local`, cleo: `cleo-${id}@local` }
  const api = `http://127.0.0.1:${String(ports.machines)}`
  const people = `http://127.0.0.1:${String(ports.people)}`
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
  const children: ChildProcess[] = []
  await db.connect()
  const sql = async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows
  const one = async (text: string, params: unknown[] = []) => must((await sql(text, params))[0], `a row from ${text.slice(0, 40)}`)

  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, logins.ava)
  node('server/admin.ts', 'add-person', team, logins.ben)
  node('server/admin.ts', 'add-person', team, logins.cleo)
  const avaMac = JSON.parse(node('server/admin.ts', 'add-instance', team, `ava-mac-${id}`, 'mac', logins.ava)) as { token: string }
  const benMac = JSON.parse(node('server/admin.ts', 'add-instance', team, `ben-mac-${id}`, 'mac', logins.ben)) as { token: string }
  const scout = JSON.parse(node('server/admin.ts', 'add-agent', team, 'scout', `ava-mac-${id}`, 'haiku', 'Be brief.')) as { agentId: string }
  const fixer = JSON.parse(node('server/admin.ts', 'add-agent', team, 'fixer', `ava-mac-${id}`, 'haiku', 'Be brief.')) as { agentId: string }

  const home = realpathSync(mkdtempSync(join(tmpdir(), `agents-${name}-`)))
  mkdirSync(join(home, 'streams'), { recursive: true })
  if (options.buildApp) {
    execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  }
  const env = {
    ...process.env, AGENTS_RUNNER: 'off', AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(ports.machines),
    AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'), AGENTS_STREAMS_PORT: String(ports.streams), AGENTS_STREAMS_DIR: join(home, 'streams'),
  }
  children.push(spawn(process.execPath, ['server/api.ts'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] }))
  const proxy = await servePeople(ports.people, join(home, 'people.sock'))
  for (let i = 0; i < 120 && !(await fetch(`${api}/v1/health`).then((r) => r.ok, () => false)); i++) await sleep(250)

  const as = (login: string): Person => {
    const headers = { 'tailscale-user-login': login }
    const get = (path: string) => fetch(people + path, { headers })
    return {
      login, get,
      post: (path, body) => fetch(people + path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      json: async (path) => { const res = await get(path); return { status: res.status, body: await res.json().catch(() => null) } },
    }
  }
  const machine = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(api + path, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const must200 = async (res: Response) => {
    if (!res.ok) throw new Error(`${res.url}: ${String(res.status)} ${await res.text()}`)
    return await res.json()
  }
  const machine200 = async (token: string, path: string, body: unknown) => {
    const answer = await machine(token, 'POST', path, body)
    if (answer.status !== 200) throw new Error(`${path}: ${String(answer.status)} ${JSON.stringify(answer.body)}`)
    return answer.body
  }
  const ava = as(logins.ava)
  const teamId = (await one('select id from teams where name = $1', [team])).id as string
  const personId = async (login: string) => (await one('select id from people where login = $1', [login])).id as string
  const sessionOf = async (column: 'conversation_id' | 'task_id', value: string) =>
    (await one(`select id from sessions where ${column} = $1`, [value])).id as string
  // What a machine posts for an agent's session: its steps, and the session idle after its turn.
  const post = (token: string, sessionId: string, events: Posted[]) => machine200(token, `/v1/sessions/${sessionId}/events`, { events, status: 'idle' })

  // 1. A direct message with scout, shared with the team. Its turn has bookkeeping, a failing tool call and an error.
  const dm = (await must200(await ava.post('/v1/conversations', { kind: 'dm', agent: 'scout' }))).conversationId as string
  await must200(await ava.post(`/v1/conversations/${dm}/messages`, { text: `Find the flaky webhook test, ${WORDS.dm} suspects it` }))
  const dmSession = await sessionOf('conversation_id', dm)
  await post(avaMac.token, dmSession, [
    bookkeeping(), called('toolu_dm1', 'Bash', { command: `grep -rn ${WORDS.dm} src`, description: 'look for it' }),
    answered('toolu_dm1', `exit 2: no file mentions ${WORDS.dm}`, true), said('The webhook test is flaky because of a race.'), turnEnded(0.0412), failed('The turn ran out of room.'),
    everyone(),
  ])

  // 2. A room of the team, where scout takes a turn after a post.
  const room = (await must200(await ava.post('/v1/conversations', { kind: 'room', name: 'launch', people: [logins.ben], agents: ['scout'] }))).conversationId as string
  await must200(await ava.post(`/v1/conversations/${room}/messages`, { text: `${WORDS.room} plan for Friday` }))
  const roomSession = await sessionOf('conversation_id', room)
  await post(avaMac.token, roomSession, [said('Friday works.'), turnEnded(0.01), everyone()])

  // 3. A direct message with fixer that only Ava is in.
  const privateDm = (await must200(await ava.post('/v1/conversations', { kind: 'dm', agent: 'fixer' }))).conversationId as string
  await must200(await ava.post(`/v1/conversations/${privateDm}/messages`, { text: `Keep this between us, ${WORDS.privateDm}` }))
  await sql(`update conversations set visibility = 'private' where id = $1`, [privateDm])
  await post(avaMac.token, await sessionOf('conversation_id', privateDm), [said('Understood.'), turnEnded(0.01), everyone()])

  // 4. A task the team can see, in a project, in a repo.
  const startTask = async (title: string, instructions: string, agentId: string) =>
    await must200(await ava.post('/v1/tasks', { title, instructions, agentId, repoIds: [] })) as { taskId: string; sessionId: string }
  const task = await startTask('Fix the checkout total', `Correct the rounding, ${WORDS.task} found it`, scout.agentId)
  const project = (await one(`insert into projects (team_id, name, created_by) values ($1, 'Launch', $2) returning id`, [teamId, await personId(logins.ava)])).id as string
  const repo = (await one(`insert into repos (team_id, remote_url, forge) values ($1, 'https://github.com/acme/shop', 'github') returning id`, [teamId])).id as string
  await sql('insert into task_repos (task_id, repo_id, is_primary) values ($1, $2, true)', [task.taskId, repo])
  await sql('update tasks set project_id = $2 where id = $1', [task.taskId, project])
  await sql('update conversations set project_id = $2 where id = $1', [room, project])
  await post(avaMac.token, task.sessionId, [
    called('toolu_t1', 'Edit', { file_path: 'src/total.ts', old_string: 'Math.floor', new_string: 'Math.round' }), answered('toolu_t1', 'File edited'), said('Rounded now.'), turnEnded(0.02),
    everyone(),
  ])

  // 5. A task only Ava can see.
  const privateTask = await startTask('Plan the surprise', `Secret ${WORDS.privateTask} plans`, fixer.agentId)
  await sql(`update tasks set visibility = 'private' where id = $1`, [privateTask.taskId])
  await post(avaMac.token, privateTask.sessionId, [said('Planned.'), turnEnded(0.01), everyone()])

  // 6. A pipeline run's stage session.
  const runTask = await startTask('bug-fix: crash on save', `The ${WORDS.run} crash`, scout.agentId)
  const pipeline = (await one(`insert into pipelines (team_id, name, path) values ($1, 'bug-fix', 'pipelines/bug-fix.ts') returning id`, [teamId])).id as string
  const version = (await one(`insert into pipeline_versions (pipeline_id, git_sha, source) values ($1, 'abc12345', 'x') returning id`, [pipeline])).id as string
  const run = (await one(`insert into runs (team_id, pipeline_version_id, task_id, trigger, status) values ($1, $2, $3, 'manual', 'done') returning id`, [teamId, version, runTask.taskId])).id as string
  await sql(`update sessions set stage = 'fix' where id = $1`, [runTask.sessionId])
  await sql(`insert into run_stages (team_id, run_id, n, stage, attempt, kind, status, session_id, outcome) values ($1, $2, 1, 'fix', 1, 'agent', 'done', $3, 'fixed')`, [teamId, run, runTask.sessionId])
  await post(avaMac.token, runTask.sessionId, [said('Fixed the crash.'), turnEnded(0.03), everyone()])

  // 7 to 11. Terminal sessions: Ava's team folder, Ava's private folder, Ben's private folder, an old one, and a long one.
  const folder = async (token: string, path: string, visibility: 'team' | 'private') =>
    (await machine200(token, '/v1/instance/folders', { path, visibility })).folder.id as string
  const folders = {
    shop: await folder(avaMac.token, '/Users/ava/shop', 'team'),
    diary: await folder(avaMac.token, '/Users/ava/diary', 'private'),
    notes: await folder(benMac.token, '/Users/ben/notes', 'private'),
  }
  const terminal = async (token: string, folderId: string, cwd: string, events: Posted[]) => {
    const { sessionId } = await machine200(token, '/v1/instance/terminal-sessions', { folderId, harnessSessionId: randomUUID(), cwd }) as { sessionId: string }
    await post(token, sessionId, events)
    return sessionId
  }
  const oldTime = new Date()
  oldTime.setDate(oldTime.getDate() - 3)
  oldTime.setHours(12, 0, 0, 0)
  const old = await terminal(avaMac.token, folders.shop, '/Users/ava/shop', [
    typed(`What did we decide about ${WORDS.old}?`), said(`We kept the ${WORDS.old}.`), turnEnded(0.01), everyone(),
  ])
  await sql(`update events set created_at = $2 where session_id = $1`, [old, oldTime.toISOString()])
  await sql(`update sessions set created_at = $2, last_active_at = $2 where id = $1`, [old, oldTime.toISOString()])
  const terminalSession = await terminal(avaMac.token, folders.shop, '/Users/ava/shop/server', [
    typed(`Why does ${WORDS.terminal} fail on staging?`), called('toolu_x1', 'Read', { file_path: 'server/staging.ts' }),
    answered('toolu_x1', `${WORDS.terminal} is set twice`), said(`${WORDS.terminal} is configured in two files.`), turnEnded(0.02), everyone(),
  ])
  const privateTerminal = await terminal(avaMac.token, folders.diary, '/Users/ava/diary', [
    typed(`Dear diary, ${WORDS.terminal} was lovely, ${WORDS.privateTerminal} too`), said('Noted.'), turnEnded(0.01), everyone(),
  ])
  const bensTerminal = await terminal(benMac.token, folders.notes, '/Users/ben/notes', [typed(`Note to self about ${WORDS.bensTerminal}`), said('Saved.'), turnEnded(0.01), everyone()])

  // 10. A long session. Every fifth step is a tool call and its result is the one after it, every ninth number is bookkeeping,
  // some results fail, one is far longer than the text column keeps, and one step is an error.
  const longEvents: Posted[] = [started()]
  const hidden: number[] = []
  const errors: number[] = []
  let big = 0
  for (let n = 1; longEvents.length < 420; n++) {
    if (longEvents.length % 9 === 8) {
      longEvents.push(bookkeeping())
      hidden.push(longEvents.length)
    }
    const kind = n % 5
    if (kind === 1) longEvents.push(typed(`${WORDS.long} question ${String(n)}`))
    else if (kind === 2) longEvents.push(said(`${WORDS.long} answer ${String(n)}`))
    else if (kind === 3) longEvents.push(called(`toolu_l${String(n)}`, 'Bash', { command: `echo ${WORDS.long} ${String(n)}`, description: `call ${String(n)}` }))
    else if (kind === 4) {
      const wrong = n % 20 === 4
      if (n === 44) {
        longEvents.push(answered(`toolu_l${String(n - 1)}`, BIG_RESULT))
        big = longEvents.length
      } else {
        longEvents.push(answered(`toolu_l${String(n - 1)}`, `${WORDS.long} output ${String(n)}`, wrong))
        if (wrong) errors.push(longEvents.length)
      }
    } else {
      longEvents.push(turnEnded(0.001 * n))
    }
  }
  longEvents.push(failed('The long session ended badly.'))
  errors.push(longEvents.length)
  longEvents.push(everyone())
  const long = await terminal(avaMac.token, folders.shop, '/Users/ava/shop/tools', [])
  for (let from = 0; from < longEvents.length; from += 100) await post(avaMac.token, long, longEvents.slice(from, from + 100))

  const sessions = {
    dm: dmSession, room: roomSession, privateDm: await sessionOf('conversation_id', privateDm), task: task.sessionId, privateTask: privateTask.sessionId,
    run: runTask.sessionId, terminal: terminalSession, privateTerminal, bensTerminal, old, long,
  }
  return {
    team, logins, sessions, folders, api, people, db,
    ids: { ava: await personId(logins.ava), ben: await personId(logins.ben), cleo: await personId(logins.cleo), scout: scout.agentId, fixer: fixer.agentId, project, repo, run },
    long: { errors, hidden, last: longEvents.length, big, shown: longEvents.length - hidden.length },
    tokens: { avaMac: avaMac.token, benMac: benMac.token },
    as, machine,
    shapeRows: async (login, shape, params = {}) => {
      const stream = new ShapeStream<Row>({
        url: `${people}/v1/shape/${shape}${Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : ''}`,
        headers: { 'tailscale-user-login': login }, subscribe: false,
      })
      return await new Shape(stream).rows
    },
    stop: async (keep) => {
      for (const child of children) child.kill('SIGTERM')
      proxy.close()
      await sleep(1000)
      if (!keep) await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
      await db.end().catch(() => undefined)
    },
  }
}
