// The instance daemon. It hears about this machine's commands through sync,
// claims each one from the API, hands each message to its session's harness, and
// posts everything the harness says back to the record, scrubbed. It also sets up
// task workspaces and runs checks and pushes in them. Config comes from AGENTS_API and
// AGENTS_TOKEN, or $AGENTS_HOME/daemon.json. AGENTS_HOME defaults to ~/.agents-app and holds each
// agent's folder and each task's workspace.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { isChangeMessage, Shape, ShapeStream, type Row } from '@electric-sql/client'
import { z } from 'zod'
import { envSecrets, makeScrub } from '../shared/scrub.ts'
import { HEARTBEAT_SEC } from '../shared/lifecycle.ts'
import { messageOf } from '../shared/errors.ts'
import { ClaudeLoginId, LoginCodeReply, OPEN_CLAUDE_LOGIN } from '../shared/onboarding.ts'
import { MessagePayload, Recovery, ResumeTurn, type Command, type EventBatch, type StageSpec } from '../shared/types.ts'
import { LiveStream } from './live.ts'
import { workspaces } from './workspace.ts'
import { changeKey } from './changes.ts'
import { ChangesReply, WorkspaceSetup } from '../shared/work.ts'
import { machineSecrets, pluginServers, writeSkills } from './agentfiles.ts'
import { claude, CLAUDE_BIN } from './claude.ts'
import { ownClaudeToken, saveClaudeToken, signIn, type SignIn } from './claude-login.ts'
import { forgetHarness, rememberHarness, stopLeftHarnesses } from './fence.ts'
import type { HarnessSession } from './harness.ts'

const HOME = process.env.AGENTS_HOME ?? join(homedir(), '.agents-app')
// Each session's MCP config, and the process id of the harness running it.
const SESSIONS_DIR = join(HOME, 'sessions')
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
// Each session's current process. Only it sets the session's status. A process
// the daemon stopped or that exited still has its lines recorded, but no status.
const sessions = new Map<string, HarnessSession>()
// What each running session's process was started with that the agent's page can change.
const setups = new Map<string, string>()
const setupOf = (p: MessagePayload) => JSON.stringify([p.model, p.instructions, p.skills, p.plugins, p.permissions])
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
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 })
  const file = join(SESSIONS_DIR, `${sessionId}.mcp.json`)
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

// A workspace's changes go at most this often while the agent works, since each
// look stages the whole working tree.
const CHANGES_EVERY_MS = 2000
// Scans run this many at once, so a daemon starting with many workspaces does not
// stage them all together. The rest wait their turn.
const SCANS_AT_ONCE = 2
let scanning = 0
const waitingScans: (() => void)[] = []
async function inScanSlot(work: () => Promise<void>) {
  if (scanning < SCANS_AT_ONCE) scanning++
  else await new Promise<void>((resolve) => { waitingScans.push(resolve) })
  try {
    await work()
  } finally {
    // A finished scan hands its slot straight to the next one waiting.
    const next = waitingScans.shift()
    if (next) next()
    else scanning--
  }
}
type Refresh = { busy: boolean; again: boolean; timer: NodeJS.Timeout | null; last: number }
const refreshes = new Map<string, Refresh>()
// For each workspace, the hash of each file the API has, by changeKey.
const sentChanges = new Map<string, Map<string, string>>()

// Sends what differs from the base in a workspace's repos, soon. Calls while a
// send is under way, or due, fold into one more.
function refreshChanges(workspaceId: string) {
  const state = refreshes.get(workspaceId) ?? { busy: false, again: false, timer: null, last: 0 }
  refreshes.set(workspaceId, state)
  if (state.busy) {
    state.again = true
    return
  }
  if (state.timer || stopping) return
  state.timer = setTimeout(() => {
    state.timer = null
    state.busy = true
    state.last = Date.now()
    void inScanSlot(() => sendChanges(workspaceId))
      .catch((error: unknown) => {
        // A workspace the API does not know as this machine's, such as one left
        // from a removed team, has nothing to report.
        if (error instanceof ApiError && error.status === 404) return
        console.error(`changes in ${workspaceId}:`, messageOf(error))
      })
      .finally(() => {
        state.busy = false
        if (state.again) {
          state.again = false
          refreshChanges(workspaceId)
        }
      })
  }, Math.max(0, state.last + CHANGES_EVERY_MS - Date.now()))
}

async function sendChanges(workspaceId: string) {
  const sent = sentChanges.get(workspaceId) ?? new Map<string, string>()
  const repos = await ws.changes(workspaceId, sent)
  if (!repos) return
  const reply = ChangesReply.parse(await api<unknown>('POST', `/v1/workspaces/${workspaceId}/changes`, scrub({ repos })))
  const held = new Map<string, string>()
  for (const repo of repos) {
    if (repo.state === 'listed') for (const file of repo.files) held.set(changeKey(repo.repoId, file.path), file.hash)
    // The API keeps an unreadable repo's last list, so what it holds stays known.
    if (repo.state === 'unreadable') for (const [key, hash] of sent) if (key.startsWith(changeKey(repo.repoId, ''))) held.set(key, hash)
  }
  for (const file of reply.missing) held.delete(changeKey(file.repoId, file.path))
  sentChanges.set(workspaceId, held)
  if (reply.missing.length) refreshChanges(workspaceId)
}

// Files the agent wrote in the task folder become document versions. Sent at the
// end of each turn, only when they changed.
async function sendDocuments(sessionId: string, workspaceId: string) {
  const changed = ws.documents(workspaceId).filter((d) => sentDocuments.get(`${workspaceId}/${d.path}`) !== d.hash)
  if (!changed.length) return
  await api('POST', `/v1/sessions/${sessionId}/documents`, { documents: changed.map(({ path, content }) => ({ path, content: scrub(content) })) })
  for (const d of changed) sentDocuments.set(`${workspaceId}/${d.path}`, d.hash)
}

function startSession(command: Extract<Command, { kind: 'message' }>): HarnessSession {
  // From here the session's process is the one this starts, so a process stopped
  // for this restart can't report the session idle over a start that fails.
  sessions.delete(command.sessionId)
  setups.delete(command.sessionId)
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
    acceptEdits: payload.permissions.workspaceWrites,
    maxBudgetUsd: payload.maxBudgetUsd,
    oauthToken: ownClaudeToken(HOME),
  })
  sessions.set(command.sessionId, session)
  setups.set(command.sessionId, setupOf(payload))
  const { pid } = session
  if (pid !== undefined) rememberHarness(SESSIONS_DIR, command.sessionId, pid)
  const live = new LiveStream({
    url: `${config.api}/v1/streams/sessions/${command.sessionId}`, token: config.token,
    name: `daemon-${command.sessionId}`, scrub, hold: liveHold(),
  })
  void (async () => {
    for await (const { live: deltas, ...batch } of session.updates()) {
      // A process that is no longer the session's current one reports no status.
      if (sessions.get(command.sessionId) !== session) delete batch.status
      if (deltas?.length) live.push(deltas)
      if (batch.events.length || batch.raw?.length || batch.status || batch.harnessSessionId || batch.ended) await post(command.sessionId, batch)
      if (payload.workspaceId && batch.events.some((e) => e.kind === 'usage')) {
        await sendDocuments(command.sessionId, payload.workspaceId).catch((error: unknown) => { console.error('documents:', messageOf(error)) })
      }
      // A tool's result may have changed files, and a turn's end is when people look.
      if (payload.workspaceId && batch.events.some((e) => e.kind === 'tool_result' || e.kind === 'usage')) refreshChanges(payload.workspaceId)
    }
    await live.close()
    if (pid !== undefined) forgetHarness(SESSIONS_DIR, command.sessionId, pid)
    if (sessions.get(command.sessionId) === session) {
      sessions.delete(command.sessionId)
      setups.delete(command.sessionId)
    }
  })()
  return session
}

// Whether the server still has the workspace's setup queued or running for this machine.
const settingUp = (workspaceId: string) => async () =>
  WorkspaceSetup.parse(await api<unknown>('GET', `/v1/instance/workspaces/${workspaceId}/setup`)).settingUp

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
    if (live?.alive) {
      live.send(command.payload.text, [command.id])
      return null
    }
    const { workspaceId } = command.payload
    if (workspaceId) await ws.ready(workspaceId, settingUp(workspaceId))
    startSession(command).send(command.payload.text, [command.id])
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
    // A message is finished by the turn that answers it, which the harness reports.
    if (command.kind !== 'message') await api('POST', `/v1/instance/commands/${command.id}`, { status: 'done', result })
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : String(error))
    console.error(`command ${command.id} failed:`, message)
    await api('POST', `/v1/instance/commands/${command.id}`, { status: 'failed', error: message })
      .catch(() => {})
  }
  // Setting up, a check or a push may have changed what differs from the base.
  if (command.sessionId === null) refreshChanges(command.payload.workspaceId)
}

// A session's commands run one after another, in the order they arrived, while
// sessions run beside each other, so one waiting for its workspace holds up no other.
const sessionQueues = new Map<string, Promise<void>>()
function inOrder(sessionId: string, work: () => Promise<void>) {
  const next = (sessionQueues.get(sessionId) ?? Promise.resolve()).then(work)
  sessionQueues.set(sessionId, next)
  void next.then(() => { if (sessionQueues.get(sessionId) === next) sessionQueues.delete(sessionId) })
}

async function heartbeat() {
  while (!stopping) {
    await api('POST', '/v1/instance/heartbeat', { status: 'online' }).catch((error: unknown) => { console.error(messageOf(error)) })
    await sleep(HEARTBEAT_SEC * 1000)
  }
}

// The API's answer to recover, with each turn to resume read on its own, so a
// turn this daemon can't read fails alone and holds up no other.
const RecoveryAnswer = Recovery.extend({ resumed: z.array(z.unknown()) })
// Enough of a turn to fail it.
const TurnTarget = z.object({ command: z.object({ sessionId: z.uuid() }), covers: z.array(z.uuid()).min(1) })

function failTurn(sessionId: string, covers: string[], why: string) {
  const reason = scrub(why)
  console.error(`session ${sessionId}:`, reason)
  void post(sessionId, { events: [{ clientId: randomUUID(), kind: 'error', text: reason, body: { reason } }], status: 'failed', ended: { how: 'exited', ids: covers, reason } })
}

// Resumes a session the last run cut off, with one message that answers all of
// its unfinished messages. A session that can't start fails them with the reason.
function resume(turn: unknown) {
  const parsed = ResumeTurn.safeParse(turn)
  if (!parsed.success) {
    const target = TurnTarget.safeParse(turn)
    const reason = `This machine could not read the turn to resume: ${z.prettifyError(parsed.error)}`
    if (target.success) failTurn(target.data.command.sessionId, target.data.covers, reason)
    else console.error(scrub(reason))
    return
  }
  const { command, covers } = parsed.data
  console.log(`resuming session ${command.sessionId} for ${covers.length} unfinished messages`)
  try {
    startSession(command).send(command.payload.text, covers)
  } catch (error) {
    failTurn(command.sessionId, covers, messageOf(error))
  }
}

// The machine's queue arrives through sync. Each queued command is claimed, which
// only one claimer can win, then handled in the order it arrived.
async function listen(signal: AbortSignal) {
  // Resuming beside a harness the last run left would put two processes on one
  // conversation, so a daemon that can't stop one exits, and its next start tries again.
  const stopped = await stopLeftHarnesses(SESSIONS_DIR).catch((error: unknown) => {
    console.error('stopping the harnesses the last run left:', messageOf(error))
    process.exit(1)
  })
  if (stopped.length) console.log(`stopped the harnesses the last run left for ${stopped.length} sessions`)
  // The API may not be up yet, after a reboot or a server restart. Keep trying.
  for (let attempt = 0; !stopping; attempt++) {
    try {
      const recovery = RecoveryAnswer.parse(await api<unknown>('POST', '/v1/instance/recover', {}))
      if (recovery.requeued) console.log(`requeued ${recovery.requeued} unfinished commands`)
      if (recovery.ended) console.log(`ended ${recovery.ended} messages a person asked to stop while this machine was down`)
      if (recovery.gaveUp) console.log(`failed ${recovery.gaveUp} messages whose turn kept stopping this machine`)
      for (const turn of recovery.resumed) resume(turn)
      // Workspaces from before this process may have changes the API has not seen.
      for (const workspaceId of ws.ids()) refreshChanges(workspaceId)
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
    if (command.kind === 'message') {
      // The claim's answer is cast, not read. An API of another version can queue a
      // payload this daemon can't use, such as one with no permissions.
      const payload = MessagePayload.safeParse(command.payload)
      if (!payload.success) {
        failTurn(command.sessionId, [command.id], `This machine could not read the message: ${z.prettifyError(payload.error)}`)
        return
      }
      command.payload = payload.data
    }
    // Workspace work can take minutes, so it runs beside the queue rather than
    // holding up messages and interrupts for sessions.
    if (command.sessionId === null) void handle(command)
    else inOrder(command.sessionId, () => handle(command))
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

// A session mid-turn is left as a crash leaves it, for the next start to stop
// its process and resume its messages. The others end cleanly.
async function shutdown() {
  if (stopping) return
  stopping = true
  abort.abort()
  for (const refresh of refreshes.values()) if (refresh.timer) clearTimeout(refresh.timer)
  for (const [id, session] of sessions) {
    if (session.busy) sessions.delete(id)
    else session.stop()
  }
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
