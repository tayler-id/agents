// The instance daemon. It hears about this machine's commands through sync,
// claims each one from the API, hands each message to its session's harness, and
// posts everything the harness says back to the record, scrubbed. It also sets up
// task workspaces and runs checks and pushes in them. Config comes from AGENTS_API and
// AGENTS_TOKEN, or $AGENTS_HOME/daemon.json. AGENTS_HOME defaults to ~/.agents-app and holds each
// agent's folder and each task's workspace.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { isChangeMessage, Shape, ShapeStream, type Row } from '@electric-sql/client'
import { z } from 'zod'
import { envSecrets, makeScrub } from '../shared/scrub.ts'
import { messageOf } from '../shared/errors.ts'
import { ClaudeLoginId, LoginCodeReply, OPEN_CLAUDE_LOGIN } from '../shared/onboarding.ts'
import type { Command, EventBatch, MessagePayload, StageSpec } from '../shared/types.ts'
import { LiveStream } from './live.ts'
import { workspaces } from './workspace.ts'
import { machineSecrets, pluginServers, writeSkills } from './agentfiles.ts'
import { claude, CLAUDE_BIN } from './claude.ts'
import { ownClaudeToken, saveClaudeToken, signIn, type SignIn } from './claude-login.ts'
import type { HarnessSession } from './harness.ts'

const HEARTBEAT_MS = 15_000
const HOME = process.env.AGENTS_HOME ?? join(homedir(), '.agents-app')
const RECORD_MCP = fileURLToPath(new URL('./record-mcp.ts', import.meta.url))
const STAGE_MCP = fileURLToPath(new URL('./stage-mcp.ts', import.meta.url))
// Every agent is told about the shared record, so it looks for teammates' work first.
const TEAM_RECORD_GUIDE = "You work on a team. Everything you and your teammates' agents say and do goes into a "
  + 'shared team record. Before you start on a problem, use the team-record tool search_record to look for related '
  + "work, earlier fixes and decisions by teammates, and build on what you find. Say when you used a teammate's work."

function loadConfig(): { api: string; token: string } {
  let file: unknown = {}
  try {
    file = JSON.parse(readFileSync(join(HOME, 'daemon.json'), 'utf8'))
  } catch {
    // No daemon.json: the environment must give the token.
  }
  const fromFile = (key: string) => {
    const value = typeof file === 'object' && file !== null ? (file as Record<string, unknown>)[key] : undefined
    return typeof value === 'string' ? value : undefined
  }
  const api = process.env.AGENTS_API ?? fromFile('api') ?? 'http://127.0.0.1:7700'
  const token = process.env.AGENTS_TOKEN ?? fromFile('token')
  if (!token) throw new Error(`set AGENTS_TOKEN or add a token to ${join(HOME, 'daemon.json')}`)
  return { api, token }
}

const config = loadConfig()

// The Claude token this box's owner signed in with from the app, if any.
// Damaged, it is reported and left out, so the daemon stays up and its owner
// can sign in again.
function ownToken(): string | null {
  try {
    return ownClaudeToken(HOME)
  } catch (error) {
    console.error(`the saved Claude sign-in: ${messageOf(error)}`)
    return null
  }
}

// Secrets this machine holds: its environment's, the plugins' in secrets.json,
// and its owner's Claude token. Read again for each new session, so a secret
// added later is scrubbed too.
const knownSecrets = (): [string, string][] => {
  const own = ownToken()
  const signedIn: [string, string][] = own === null ? [] : [['CLAUDE_CODE_OAUTH_TOKEN', own]]
  return [
    ...envSecrets(process.env),
    ...Object.entries(machineSecrets(HOME)).filter(([, value]) => typeof value === 'string' && value.length >= 8),
    ...signedIn,
  ].sort((a, b) => b[1].length - a[1].length)
}
let secrets = knownSecrets()
let scrub = makeScrub(secrets)
// Live text is held back long enough to catch a secret split across chunks.
const liveHold = () => Math.max(160, ...secrets.map(([, value]) => value.length + 16))
const sessions = new Map<string, HarnessSession>()
// What each running session's process was started with that the agent's page can change.
const setups = new Map<string, string>()
const setupOf = (p: MessagePayload) => JSON.stringify([p.model, p.instructions, p.skills, p.plugins])
const ws = workspaces(HOME, config.api, config.token)
let stopping = false

class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function api<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(config.api + path, {
    method,
    signal,
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = typeof json === 'object' && json !== null && 'error' in json && typeof json.error === 'string' ? json.error : ''
    throw new ApiError(res.status, `${method} ${path}: ${res.status} ${error}`)
  }
  // The API's answers are this repo's own types.
  return json as T
}

// Retries until the API takes the batch. Posts are idempotent by client id. A 4xx
// other than 408 or 429 means the batch itself is wrong, so it is logged and dropped.
async function post(sessionId: string, batch: EventBatch) {
  for (let attempt = 0; ; attempt++) {
    try {
      await api('POST', `/v1/sessions/${sessionId}/events`, scrub(batch))
      return
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        console.error(`dropped a batch for ${sessionId}:`, (error as Error).message)
        return
      }
      await sleep(Math.min(30_000, 500 * 2 ** attempt))
    }
  }
}

// An agent's conversations run in its own folder on this machine.
function agentHome(agentId: string): string {
  const dir = join(HOME, 'agents', agentId)
  mkdirSync(dir, { recursive: true })
  return dir
}

// The session's MCP config: the team-record tools, acting as this session, and
// for a pipeline stage the report_result tool. The file holds the machine's
// token, so only this user can read it.
function mcpConfig(sessionId: string, stage: StageSpec | undefined, plugins: Record<string, unknown>): string {
  const dir = join(HOME, 'sessions')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${sessionId}.mcp.json`)
  const servers: Record<string, unknown> = {
    ...plugins,
    'team-record': { command: process.execPath, args: [RECORD_MCP], env: { AGENTS_API: config.api, AGENTS_TOKEN: config.token, AGENTS_SESSION: sessionId } },
  }
  if (stage) servers.stage = { command: process.execPath, args: [STAGE_MCP], env: { AGENTS_STAGE_OUTCOMES: JSON.stringify(stage.outcomes) } }
  writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 })
  return file
}

// Documents already sent from task folders, by workspace and path, with their hashes.
const sentDocuments = new Map<string, string>()

// Files the agent wrote in the task folder become document versions. Sent at the
// end of each turn, only when they changed.
async function sendDocuments(sessionId: string, workspaceId: string) {
  const changed = ws.documents(workspaceId).filter((d) => sentDocuments.get(`${workspaceId}/${d.path}`) !== d.hash)
  if (!changed.length) return
  await api('POST', `/v1/sessions/${sessionId}/documents`, { documents: changed.map(({ path, content }) => ({ path, content: scrub(content) })) })
  for (const d of changed) sentDocuments.set(`${workspaceId}/${d.path}`, d.hash)
}

function startSession(command: Extract<Command, { kind: 'message' }>): HarnessSession {
  const { payload } = command
  if (payload.harness !== 'claude') throw new Error(`no ${payload.harness} harness on this machine`)
  const cwd = payload.workspaceId ? ws.dir(payload.workspaceId) : agentHome(payload.agentId)
  if (!existsSync(cwd)) throw new Error(`workspace ${payload.workspaceId} is not set up on this machine`)
  const { stage } = payload
  secrets = knownSecrets()
  scrub = makeScrub(secrets)
  const plugins = pluginServers(payload.plugins ?? [], machineSecrets(HOME))
  if (plugins.missing.length) {
    throw new Error(`this machine has no value for ${[...new Set(plugins.missing)].join(', ')}, which the agent's plugins need. `
      + `Set it in the daemon's environment or in ${join(HOME, 'secrets.json')}.`)
  }
  if (payload.skills) writeSkills(cwd, payload.skills)
  const session = claude.start({
    cwd, model: payload.model, resume: payload.harnessSessionId,
    instructions: [TEAM_RECORD_GUIDE, payload.instructions, payload.memory].filter(Boolean).join('\n\n'),
    mcpConfig: mcpConfig(command.sessionId, stage, plugins.servers),
    allowedTools: ['mcp__team-record', ...Object.keys(plugins.servers).map((name) => `mcp__${name}`), ...(stage ? ['mcp__stage', ...stage.allow] : [])],
    maxBudgetUsd: stage?.maxBudgetUsd,
    oauthToken: ownClaudeToken(HOME),
  })
  sessions.set(command.sessionId, session)
  setups.set(command.sessionId, setupOf(payload))
  const live = new LiveStream({
    url: `${config.api}/v1/streams/sessions/${command.sessionId}`, token: config.token,
    name: `daemon-${command.sessionId}`, scrub, hold: liveHold(),
  })
  void (async () => {
    for await (const { live: deltas, ...batch } of session.updates()) {
      // Once a restart has replaced this process, the session's status is the new one's to report.
      if (sessions.get(command.sessionId) !== session) delete batch.status
      if (deltas?.length) live.push(deltas)
      if (batch.events.length || batch.raw?.length || batch.status || batch.harnessSessionId) await post(command.sessionId, batch)
      if (payload.workspaceId && batch.events.some((e) => e.kind === 'usage')) {
        await sendDocuments(command.sessionId, payload.workspaceId).catch((error: unknown) => { console.error('documents:', messageOf(error)) })
      }
    }
    await live.close()
    if (sessions.get(command.sessionId) === session) {
      sessions.delete(command.sessionId)
      setups.delete(command.sessionId)
    }
  })()
  return session
}

// Does what a command asks, and returns what the API should record about it. A
// message starts or resumes the session; an answer or an interrupt needs the
// session's process to still be running.
async function apply(command: Command): Promise<unknown> {
  if (command.kind === 'setup_workspace') return ws.setup(command.payload)
  if (command.kind === 'exec') return ws.exec(command.payload)
  if (command.kind === 'push') return ws.push(command.payload)
  const live = sessions.get(command.sessionId)
  if (command.kind === 'message') {
    // A process keeps the setup it started with. Once the agent's instructions,
    // skills, plugins or model change, the next message restarts the session with
    // the new setup, resuming the same conversation. One mid-turn finishes first.
    if (live?.alive && !live.busy && command.payload.harnessSessionId && setups.get(command.sessionId) !== setupOf(command.payload)) live.stop()
    ;(live?.alive ? live : startSession(command)).send(command.payload.text)
    return null
  }
  if (command.kind === 'stop') {
    live?.stop()
    return null
  }
  if (!live?.alive) throw new Error(`session ${command.sessionId} is not running on this machine`)
  if (command.kind === 'answer') live.answer(command.payload)
  else live.interrupt()
  return null
}

async function handle(command: Command) {
  try {
    const result = await apply(command)
    await api('POST', `/v1/instance/commands/${command.id}`, { status: 'done', result })
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : String(error))
    console.error(`command ${command.id} failed:`, message)
    await api('POST', `/v1/instance/commands/${command.id}`, { status: 'failed', error: message })
      .catch(() => {})
  }
}

async function heartbeat() {
  while (!stopping) {
    await api('POST', '/v1/instance/heartbeat', { status: 'online' }).catch((error: unknown) => { console.error(messageOf(error)) })
    await sleep(HEARTBEAT_MS)
  }
}

// The machine's queue arrives through sync. Each queued command is claimed, which
// only one claimer can win, then handled in the order it arrived.
async function listen(signal: AbortSignal) {
  // The API may not be up yet, after a reboot or a server restart. Keep trying.
  for (let attempt = 0; !stopping; attempt++) {
    try {
      const { requeued } = await api<{ requeued: number }>('POST', '/v1/instance/commands/requeue', {})
      if (requeued) console.log(`requeued ${requeued} unfinished commands`)
      break
    } catch (error) {
      console.error('waiting for the API:', (error as Error).message)
      await sleep(Math.min(15_000, 500 * 2 ** attempt))
    }
  }
  const stream = new ShapeStream<{ id: string }>({
    url: `${config.api}/v1/shape/commands`,
    headers: { authorization: `Bearer ${config.token}` },
    signal,
    onError: (error) => {
      if (!stopping) console.error('command sync:', error.message)
      return stopping ? undefined : {}
    },
  })
  let queue = Promise.resolve()
  stream.subscribe((messages) => {
    for (const message of messages) {
      if (isChangeMessage(message) && message.headers.operation === 'insert') {
        const commandId = message.value.id
        queue = queue.then(() => claimAndHandle(commandId))
      }
    }
  })
}

async function claimAndHandle(commandId: string) {
  try {
    const { command } = await api<{ command: Command }>('POST', `/v1/instance/commands/${commandId}/claim`, {})
    // Workspace work can take minutes, so it runs beside the queue rather than
    // holding up messages and interrupts for sessions.
    if (command.sessionId === null) void handle(command)
    else await handle(command)
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return
    console.error(`claim ${commandId}:`, (error as Error).message)
  }
}

// Claude sign-ins asked of this box while they are open, and the ones whose end
// was already reported, so a late copy of a row does not report it twice.
const OpenSignIn = z.object({ id: ClaudeLoginId, status: z.enum(OPEN_CLAUDE_LOGIN) })
const signIns = new Map<ClaudeLoginId, SignIn>()
const codeAsked = new Set<ClaudeLoginId>()
const finished = new Set<ClaudeLoginId>()
// The API may be restarting. A report is tried this many times before it is given up.
const REPORT_TRIES = 6

async function reportSignIn(loginId: ClaudeLoginId, what: 'link' | 'done' | 'failed', body: unknown) {
  for (let attempt = 0; ; attempt++) {
    try {
      await api('POST', `/v1/instance/claude-logins/${loginId}/${what}`, body)
      return
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0
      // The API refused the report itself, such as for a sign-in the person cancelled meanwhile.
      if ((status >= 400 && status < 500) || attempt + 1 >= REPORT_TRIES) {
        console.error(`sign-in ${loginId} ${what}:`, messageOf(error))
        return
      }
      await sleep(Math.min(15_000, 500 * 2 ** attempt))
    }
  }
}

function beginSignIn(loginId: ClaudeLoginId) {
  let running: SignIn
  try {
    running = signIn(CLAUDE_BIN, HOME)
  } catch (error) {
    finished.add(loginId)
    void reportSignIn(loginId, 'failed', { reason: messageOf(error) })
    return
  }
  signIns.set(loginId, running)
  // A link that never comes rejects `done` too, which reports why.
  running.link.then((url) => reportSignIn(loginId, 'link', { url }), () => undefined)
  running.done.then(async ({ token, validDays }) => {
    saveClaudeToken(HOME, token)
    secrets = knownSecrets()
    scrub = makeScrub(secrets)
    // A session keeps the login it started with, so idle ones stop and their next message starts with this one.
    for (const session of sessions.values()) if (!session.busy) session.stop()
    await reportSignIn(loginId, 'done', { validDays })
  }, async (error: unknown) => {
    await reportSignIn(loginId, 'failed', { reason: scrub(messageOf(error)) })
  }).finally(() => {
    finished.add(loginId)
    signIns.delete(loginId)
    codeAsked.delete(loginId)
  }).catch((error: unknown) => { console.error(`sign-in ${loginId}:`, messageOf(error)) })
}

// The person sent their code. The API hands it over once.
async function passCode(loginId: ClaudeLoginId, running: SignIn) {
  try {
    running.enterCode(LoginCodeReply.parse(await api('POST', `/v1/instance/claude-logins/${loginId}/code`, {})).code)
  } catch (error) {
    // 410: the API restarted and lost the code, and asked the person to paste it again.
    if (error instanceof ApiError && error.status === 410) {
      codeAsked.delete(loginId)
      return
    }
    running.stop()
    await reportSignIn(loginId, 'failed', { reason: messageOf(error) })
  }
}

// Brings this box's sign-ins in line with the open ones the API has for it.
function settleSignIns(rows: unknown[]) {
  const open = rows.map((row) => OpenSignIn.parse(row)).filter((row) => !finished.has(row.id))
  for (const { id, status } of open) {
    const running = signIns.get(id)
    if (!running && status === 'starting') beginSignIn(id)
    else if (!running) {
      // Its CLI was in a process that is gone.
      finished.add(id)
      void reportSignIn(id, 'failed', { reason: 'The box restarted during the sign-in. Start it again.' })
    } else if (status === 'waiting_for_code') codeAsked.delete(id)
    else if (status === 'checking' && !codeAsked.has(id)) {
      codeAsked.add(id)
      void passCode(id, running)
    }
  }
  // Cancelled by the person, or started again.
  for (const [id, running] of signIns) {
    if (!open.some((row) => row.id === id)) {
      running.stop()
      signIns.delete(id)
    }
  }
}

function followSignIns(signal: AbortSignal) {
  const stream = new ShapeStream<Row>({
    url: `${config.api}/v1/shape/claude_logins`,
    headers: { authorization: `Bearer ${config.token}` },
    signal,
    onError: (error) => {
      if (!stopping) console.error('sign-in sync:', error.message)
      return stopping ? undefined : {}
    },
  })
  new Shape(stream).subscribe(({ rows }) => { settleSignIns(rows) })
}

async function shutdown() {
  if (stopping) return
  stopping = true
  abort.abort()
  for (const session of sessions.values()) session.stop()
  for (const running of signIns.values()) running.stop()
  const deadline = Date.now() + 10_000
  while (sessions.size && Date.now() < deadline) await sleep(100)
  await api('POST', '/v1/instance/heartbeat', { status: 'offline' }).catch(() => {})
  process.exit(0)
}

const abort = new AbortController()
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
console.log(`agentsd connected to ${config.api}`)
void heartbeat()
void listen(abort.signal)
followSignIns(abort.signal)
