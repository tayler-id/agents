// The instance daemon. It hears about this machine's commands through sync,
// claims each one from the API, hands each message to its session's harness, and
// posts everything the harness says back to the record, scrubbed. It also sets up
// task workspaces and runs checks and pushes in them. Config comes from AGENTS_API and
// AGENTS_TOKEN, or $AGENTS_HOME/daemon.json. AGENTS_HOME defaults to ~/.agents-app and holds each
// agent's folder and each task's workspace.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { isChangeMessage, Shape, ShapeStream, type Row } from '@electric-sql/client'
import { z } from 'zod'
import { envSecrets, makeScrub, MIN_SECRET_LENGTH } from '../shared/scrub.ts'
import { HEARTBEAT_SEC } from '../shared/lifecycle.ts'
import { messageOf } from '../shared/errors.ts'
import { ClaudeLoginId, LoginCodeReply, OPEN_CLAUDE_LOGIN } from '../shared/onboarding.ts'
import type { FromDaemon, ToDaemon } from '../shared/link.ts'
import { ScreenSizeText, type Heartbeat, type ScreenSize } from '../shared/screen.ts'
import { MessagePayload, OtherCommand, Recovery, ResumeTurn, type Command, type EventBatch, type StageSpec } from '../shared/types.ts'
import { LiveStream } from './live.ts'
import { workspaces, type TaskFile } from './workspace.ts'
import type { DocumentUpload } from '../shared/documents.ts'
import { changeKey } from './changes.ts'
import { ChangesReply, WorkspaceSetup } from '../shared/work.ts'
import { gates } from './gates.ts'
import { changeMachineSecret, forgetValueIn, heldSecretNames, machineSecrets, pluginSecretNames, pluginServers, SecretsFileError, writeHooks, writeSkills } from './agentfiles.ts'
import { linkControl } from './control-link.ts'
import { claude, CLAUDE_BIN } from './claude.ts'
import { ownClaudeToken, saveClaudeToken, signIn, type SignIn } from './claude-login.ts'
import { forgetHarness, rememberHarness, stopLeftHarnesses } from './fence.ts'
import type { HarnessSession } from './harness.ts'
import { startDesktop, type Desktop } from './desktop.ts'
import { startScreenService, type ScreenService } from './screen.ts'
import { linkScreen, type ScreenLink } from './screen-link.ts'
import { COMPUTER_GUIDE, COMPUTER_TOOLS_ALLOWED, VERIFY_SKILL, WEB_GUIDE } from './computer-guide.ts'
import { COMPUTER_SERVER } from '../shared/webmcp.ts'
import { ApiError, HOME, apiClient, loadConfig, postEvents } from './api.ts'
import { followTerminalSessions } from './transcripts.ts'
import { loginShellSecrets } from './secrets.ts'
import { serveAppSocket } from './app-socket.ts'
import { TEAM_AGENT_TOOLS_ALLOWED, TEAM_AGENTS_SERVER } from '../shared/team-agents.ts'

// Each session's MCP config, and the process id of the harness running it.
const SESSIONS_DIR = join(HOME, 'sessions')
const RECORD_MCP = fileURLToPath(new URL('./record-mcp.ts', import.meta.url))
const AGENTS_MCP = fileURLToPath(new URL('./team-agents-mcp.ts', import.meta.url))
const STAGE_MCP = fileURLToPath(new URL('./stage-mcp.ts', import.meta.url))
const COMPUTER_MCP = fileURLToPath(new URL('./computer-mcp.ts', import.meta.url))
// The screen's sockets, outside the home volume, which outlives the container.
const SCREEN_DIR = join(tmpdir(), 'agents-screen')
// Every agent is told about the shared record, so it looks for teammates' work first.
const TEAM_RECORD_GUIDE = "You work on a team. Everything you and your teammates' agents say and do goes into a "
  + 'shared team record. Before you start on a problem, use the team-record tool search_record to look for related '
  + "work, earlier fixes and decisions by teammates, and build on what you find. Say when you used a teammate's work."

const config = loadConfig()
const api = apiClient(config)

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

// What the person's login shell exports, learned once, at start.
let shellSecrets: [string, string][] = []
// Values set again or removed from the app, by name. An agent that read one may
// still repeat it, so it is scrubbed for as long as this daemon runs.
const retiredSecrets: [string, string][] = []
// Secrets this machine holds: its environment's, the plugins' in secrets.json,
// its owner's Claude token and its login shell's. Read again for each new
// session, so a secret added later is scrubbed too.
const knownSecrets = (): [string, string][] => {
  const own = ownToken()
  const signedIn: [string, string][] = own === null ? [] : [['CLAUDE_CODE_OAUTH_TOKEN', own]]
  return [
    ...envSecrets(process.env),
    ...Object.entries(machineSecrets(HOME)).filter(([, value]) => typeof value === 'string' && value.length >= 8),
    ...signedIn,
    ...shellSecrets,
    ...retiredSecrets,
  ].sort((a, b) => b[1].length - a[1].length)
}
let secrets = knownSecrets()
let scrub = makeScrub(secrets)
// Terminal sessions wait for this, and are not sent at all if the shell can't be
// read, since its secrets would reach the record unscrubbed.
const shellRead = loginShellSecrets().then((found) => {
  shellSecrets = found
  secrets = knownSecrets()
  scrub = makeScrub(secrets)
  return true
}, (error: unknown) => {
  console.error(`the login shell's environment: ${messageOf(error)}. Terminal sessions are not sent until the daemon starts again and can read it.`)
  return false
})
// Live text is held back long enough to catch a secret split across chunks.
const liveHold = () => Math.max(160, ...secrets.map(([, value]) => value.length + 16))
// Each session's current process. Only it sets the session's status. A process
// the daemon stopped or that exited still has its lines recorded, but no status.
const sessions = new Map<string, HarnessSession>()
// What each running session's process was started with that the agent's page can change.
const setups = new Map<string, string>()
// The secrets the plugins of each running session take, and the sessions whose
// plugins started with a value that was set again or removed since.
const usedSecrets = new Map<string, string[]>()
const staleSecrets = new Set<string>()
// The sites the team lists for this agent's browser. A server from before this release sends none.
const webmcpOriginsOf = (p: MessagePayload) => p.webmcpOrigins ?? []
const setupOf = (p: MessagePayload) => JSON.stringify([p.model, p.instructions, p.skills, p.plugins, p.hooks, p.permissions, webmcpOriginsOf(p)])
const ws = workspaces(HOME, config.api, config.token)
const checker = gates(HOME, config.api, config.token)
let stopping = false

// A box's image sets AGENTS_DESKTOP to the screen's size, with the browsers and
// Playwright's MCP server beside it. A machine without it, such as a Mac, has no
// desktop for agents.
const DesktopEnv = z.object({
  AGENTS_DESKTOP: ScreenSizeText,
  PLAYWRIGHT_BROWSERS_PATH: z.string().min(1),
  AGENTS_BROWSER_MCP: z.string().min(1),
})
function desktopEnv(): z.infer<typeof DesktopEnv> | null {
  if (process.env.AGENTS_DESKTOP === undefined) return null
  const parsed = DesktopEnv.safeParse(process.env)
  if (!parsed.success) {
    console.error(`agentsd: AGENTS_DESKTOP is set, but ${z.prettifyError(parsed.error)}`)
    process.exit(2)
  }
  return parsed.data
}
const desktopConfig = desktopEnv()
const desktop: Desktop | null = desktopConfig && startDesktop({
  size: desktopConfig.AGENTS_DESKTOP, runDir: SCREEN_DIR, profileDir: join(HOME, 'browser'), browsersPath: desktopConfig.PLAYWRIGHT_BROWSERS_PATH,
})
// Set once the desktop is up: the size the heartbeat reports, the service
// sessions' `computer` servers talk to, what those servers need, and the box's
// link to the API, through which people watch and take over.
type Screen = { size: ScreenSize; service: ScreenService; link: ScreenLink; socket: string; cdpUrl: string; browserMcp: string }
let screen: Screen | null = null
// A box's sessions need its computer, so the daemon takes no work until its
// desktop is up. `ready` gives up when a part of the desktop doesn't come up
// within the desktop's start limit. Then the daemon stops, and the container's
// restart policy starts the box again, so a box never works without its computer.
const desktopUp: Promise<boolean> = desktop && desktopConfig
  ? desktop.ready.then(() => {
    const socket = join(SCREEN_DIR, 'agent.sock')
    const service = startScreenService({ desktop, socketPath: socket, secrets: knownSecrets })
    screen = {
      size: desktop.size, socket, cdpUrl: desktop.cdpUrl, browserMcp: desktopConfig.AGENTS_BROWSER_MCP, service,
      link: linkScreen({ api: config.api, token: config.token, vncSocket: desktop.vncSocket, onControl: (control) => { service.setControl(control) } }),
    }
    console.log(`desktop up at ${desktop.size.width}x${desktop.size.height}`)
    return true
  }, (error: unknown) => {
    console.error(`desktop: ${messageOf(error)}. Stopping, so the box starts again.`)
    void shutdown(1)
    return false
  })
  : Promise.resolve(true)

const post = (sessionId: string, batch: EventBatch) => postEvents(api, sessionId, scrub(batch))

// An agent's conversations run in its own folder on this machine.
function agentHome(agentId: string): string {
  const dir = join(HOME, 'agents', agentId)
  mkdirSync(dir, { recursive: true })
  return dir
}

// The session's MCP config: the team-record tools, acting as this session, and
// for a pipeline stage the report_result tool. Every session but a stage's also
// gets the team-agents tools, since an answer from another agent would come back
// outside the stage. The file holds the machine's token, so only this user can read it.
// On a machine with a screen it adds the `computer` server, and in a task's
// session tells it the task folder, where saved screenshots become documents. It
// also tells it the sites the team lists, whose pages' WebMCP tools the agent may use.
function mcpConfig(
  sessionId: string, stage: StageSpec | undefined, plugins: Record<string, unknown>, computer: Screen | null, taskFolder: string | null,
  webmcpOrigins: readonly string[],
): string {
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 })
  const file = join(SESSIONS_DIR, `${sessionId}.mcp.json`)
  const servers: Record<string, unknown> = { ...plugins }
  if (!stage?.isolated) {
    servers['team-record'] = { command: process.execPath, args: [RECORD_MCP], env: { AGENTS_API: config.api, AGENTS_TOKEN: config.token, AGENTS_SESSION: sessionId } }
  }
  if (stage) servers.stage = { command: process.execPath, args: [STAGE_MCP], env: { AGENTS_STAGE_OUTCOMES: JSON.stringify(stage.outcomes) } }
  else servers[TEAM_AGENTS_SERVER] = { command: process.execPath, args: [AGENTS_MCP], env: { AGENTS_API: config.api, AGENTS_TOKEN: config.token, AGENTS_SESSION: sessionId } }
  if (computer) {
    servers[COMPUTER_SERVER] = {
      command: process.execPath, args: [COMPUTER_MCP],
      env: {
        AGENTS_SCREEN_SOCKET: computer.socket, AGENTS_BROWSER_MCP: computer.browserMcp, AGENTS_BROWSER_CDP: computer.cdpUrl,
        AGENTS_API: config.api, AGENTS_TOKEN: config.token, AGENTS_SESSION: sessionId,
        ...(taskFolder ? { AGENTS_TASK_FOLDER: taskFolder } : {}),
        ...(webmcpOrigins.length ? { AGENTS_WEBMCP_ORIGINS: JSON.stringify(webmcpOrigins) } : {}),
      },
    }
  }
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
  const reply = ChangesReply.parse(await api('POST', `/v1/workspaces/${workspaceId}/changes`, scrub({ repos })))
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
// end of each turn, only when they changed. Text goes in one request, scrubbed,
// and each image in its own, since several could pass the API's request limit.
// Pixels can't be scrubbed, which the standing instructions say.
async function sendDocuments(sessionId: string, workspaceId: string) {
  const changed = ws.documents(workspaceId).filter((d) => sentDocuments.get(`${workspaceId}/${d.path}`) !== d.hash)
  const texts: TaskFile[] = []
  const send = async (files: TaskFile[]) => {
    const documents = files.map((file): DocumentUpload => (file.kind === 'text'
      ? { path: file.path, content: scrub(file.content) }
      : { path: file.path, image: { mediaType: file.mediaType, base64: file.bytes.toString('base64') } }))
    await api('POST', `/v1/sessions/${sessionId}/documents`, { documents })
    for (const file of files) sentDocuments.set(`${workspaceId}/${file.path}`, file.hash)
  }
  for (const file of changed) {
    if (file.kind === 'text') texts.push(file)
    else await send([file])
  }
  if (texts.length) await send(texts)
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
      + `Set it on the agent's page in the app, or in the daemon's environment or in ${join(HOME, 'secrets.json')}.`)
  }
  usedSecrets.set(command.sessionId, pluginSecretNames(payload.plugins ?? []))
  staleSecrets.delete(command.sessionId)
  // A machine with a screen gives every session its computer, the standing
  // instructions to check work on it, and the verify-work skill, unless the agent
  // has a skill of that name itself. An isolated session, such as a judge's, gets
  // none of it, since the runner names the only tools a judge may use.
  const computer = stage?.isolated ? null : screen
  const webmcpOrigins = webmcpOriginsOf(payload)
  const agentSkills = payload.skills ?? []
  const skills = computer && !agentSkills.some((skill) => skill.name === VERIFY_SKILL.name) ? [...agentSkills, VERIFY_SKILL] : payload.skills
  if (skills) writeSkills(cwd, skills)
  // A session sent no hooks runs none, so the file never carries another session's into it.
  const hooks = payload.hooks ?? []
  writeHooks(cwd, hooks)
  // A plugin with the name of a server this session has of its own is overwritten in the config,
  // and its name must not allow the session's own server's tools to run without asking.
  const ownServers = new Set<string>([...(stage?.isolated ? [] : ['team-record']), ...(stage ? ['stage'] : [TEAM_AGENTS_SERVER]), ...(computer ? [COMPUTER_SERVER] : [])])
  const session = claude.start({
    cwd, model: payload.model, resume: payload.harnessSessionId,
    instructions: [TEAM_RECORD_GUIDE, computer ? COMPUTER_GUIDE : '', computer && webmcpOrigins.length ? WEB_GUIDE : '', payload.instructions, payload.memory]
      .filter(Boolean).join('\n\n'),
    mcpConfig: mcpConfig(command.sessionId, stage, plugins.servers, computer, payload.workspaceId ? ws.taskFolder(payload.workspaceId) : null, webmcpOrigins),
    // A judge's session gets no team-record tools, so it cannot read the author's session.
    allowedTools: [
      ...(stage?.isolated ? [] : ['mcp__team-record']), ...Object.keys(plugins.servers).filter((name) => !ownServers.has(name)).map((name) => `mcp__${name}`), ...(stage ? ['mcp__stage', ...stage.allow] : TEAM_AGENT_TOOLS_ALLOWED),
      ...(computer ? COMPUTER_TOOLS_ALLOWED : []),
    ],
    acceptEdits: payload.permissions.workspaceWrites,
    // A server before this release sends a stage's budget only in the stage.
    maxBudgetUsd: payload.maxBudgetUsd ?? stage?.maxBudgetUsd,
    hookEvents: hooks.length > 0,
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
      usedSecrets.delete(command.sessionId)
    }
  })()
  return session
}

// The names of the secrets this computer holds, for the API to match against what
// it believes it set. A secrets file the daemon cannot read says nothing, so the
// API keeps what it has.
function helloSecrets(): FromDaemon | null {
  try {
    return { type: 'secrets_held', names: heldSecretNames(HOME) }
  } catch (error) {
    console.error(`the secrets file was not reported to the API: ${error instanceof SecretsFileError ? error.message : messageOf(error)}`)
    return null
  }
}

// Sets or removes one secret's value at the API's request, and answers. A value
// the daemon cannot take is refused with the reason, which never quotes the
// value or the file. The plugins of a session that started with the value being
// replaced or removed still hold it, so an idle session is stopped, and one in a
// turn is restarted with its next message.
function holdSecret(frame: ToDaemon): FromDaemon {
  const { id, name } = frame
  const put = frame.type === 'secret_put'
  const refused = (reason: string): FromDaemon => {
    console.error(`secret ${name} was refused: ${reason}`)
    return { type: 'secret_refused', id, name, reason: reason.slice(0, 500) }
  }
  // A plugin's secret is read from the daemon's environment before its secrets file, so a value
  // stored under a name the environment holds would be set and never used. Saying so is better.
  if (put && process.env[name] !== undefined) {
    return refused(`This computer's environment already sets ${name}, and it is read before a value set here. Take it out of the daemon's environment first.`)
  }
  try {
    const { had } = changeMachineSecret(HOME, name, put ? frame.value : null, (gone) => {
      // A value the scrubber would ignore, or one it already remembers, is not kept again.
      if (gone.length >= MIN_SECRET_LENGTH && !retiredSecrets.some(([retired, value]) => retired === name && value === gone)) retiredSecrets.push([name, gone])
      forgetValueIn(SESSIONS_DIR, gone)
      for (const [sessionId, names] of usedSecrets) {
        if (!names.includes(name)) continue
        const session = sessions.get(sessionId)
        if (session && !session.busy) session.stop()
        else staleSecrets.add(sessionId)
      }
    })
    secrets = knownSecrets()
    scrub = makeScrub(secrets)
    console.log(`secret ${name} ${put ? 'stored' : 'removed'}`)
    return put ? { type: 'secret_stored', id, name } : { type: 'secret_removed', id, name, had }
  } catch (error) {
    // The daemon's own words for a file it will not touch. Anything else is Node's, scrubbed.
    return refused(error instanceof SecretsFileError ? error.message : `The daemon could not change what this computer holds. ${scrub(messageOf(error))}`)
  }
}

// Whether the server still has the workspace's setup queued or running for this machine.
const settingUp = (workspaceId: string) => async () =>
  WorkspaceSetup.parse(await api('GET', `/v1/instance/workspaces/${workspaceId}/setup`)).settingUp

// Does what a command asks, and returns what the API should record about it. A
// message starts or resumes the session; an answer or an interrupt needs the
// session's process to still be running.
async function apply(command: Command): Promise<unknown> {
  if (command.kind === 'setup_workspace') return ws.setup(command.payload)
  if (command.kind === 'exec') return ws.exec(command.payload)
  if (command.kind === 'push') return ws.push(command.payload)
  if (command.kind === 'verify') return checker.verify(command.payload)
  if (command.kind === 'suite') return checker.suite(command.payload)
  const live = sessions.get(command.sessionId)
  if (command.kind === 'message') {
    // A process keeps the setup it started with. Once the agent's instructions,
    // skills, plugins or model change, the next message restarts the session with
    // the new setup, resuming the same conversation. One mid-turn finishes first.
    if (live?.alive && !live.busy && command.payload.harnessSessionId
      && (staleSecrets.has(command.sessionId) || setups.get(command.sessionId) !== setupOf(command.payload))) live.stop()
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

// Tells the API a command this machine claimed failed, and why.
async function failCommand(commandId: string, why: string) {
  const message = scrub(why)
  console.error(`command ${commandId} failed:`, message)
  await api('POST', `/v1/instance/commands/${commandId}`, { status: 'failed', error: message })
    .catch(() => {})
}

async function handle(command: Command) {
  try {
    const result = await apply(command)
    // A message is finished by the turn that answers it, which the harness reports.
    if (command.kind !== 'message') await api('POST', `/v1/instance/commands/${command.id}`, { status: 'done', result })
  } catch (error) {
    await failCommand(command.id, error instanceof Error ? error.message : String(error))
  }
  // Setting up, a check or a push may have changed what differs from the base.
  // A suite runs in the check host's own clone, outside every workspace.
  if (command.sessionId === null && command.kind !== 'suite') refreshChanges(command.payload.workspaceId)
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
    // The screen's size, once the desktop is up, so the app offers the Screen view.
    const beat: Heartbeat = { status: 'online', screen: screen ? screen.size : null }
    await api('POST', '/v1/instance/heartbeat', beat).catch((error: unknown) => { console.error(messageOf(error)) })
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
      const recovery = RecoveryAnswer.parse(await api('POST', '/v1/instance/recover', {}))
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

// What a claim answers with. A message's payload is read on its own, below. The
// union is on the kind, so a command that doesn't parse names its own fields.
const Claimed = z.object({
  command: z.discriminatedUnion('kind', [z.object({ id: z.string(), kind: z.literal('message'), sessionId: z.string(), payload: z.unknown() }), OtherCommand]),
})

// A message with its payload read. An API of another version can queue a payload
// this daemon can't use, such as one with no permissions, and that turn fails with the reason.
function readMessage(claimed: { id: string; sessionId: string; payload: unknown }): Command | null {
  const payload = MessagePayload.safeParse(claimed.payload)
  if (!payload.success) {
    failTurn(claimed.sessionId, [claimed.id], `This machine could not read the message: ${z.prettifyError(payload.error)}`)
    return null
  }
  return { id: claimed.id, kind: 'message', sessionId: claimed.sessionId, payload: payload.data }
}

async function claimAndHandle(commandId: string) {
  try {
    const answer = Claimed.safeParse(await api('POST', `/v1/instance/commands/${commandId}/claim`, {}))
    if (!answer.success) {
      // The claim made the command this machine's. One it can't read fails with
      // the reason, as one whose work throws does, so no run waits on it.
      await failCommand(commandId, `This machine could not read the command: ${z.prettifyError(answer.error)}`)
      return
    }
    const claimed = answer.data.command
    const command = claimed.kind === 'message' ? readMessage(claimed) : claimed
    if (command === null) return
    // Workspace work can take minutes, so it runs beside the queue rather than
    // holding up messages and interrupts for sessions.
    if (command.sessionId === null) void handle(command)
    else inOrder(command.sessionId, () => handle(command))
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return
    console.error(`claim ${commandId}:`, messageOf(error))
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

// Stops everything and exits with `code`, 0 when asked to stop and 1 when the
// box can't work, so its restart policy starts it again. A session mid-turn is
// left as a crash leaves it, for the next start to stop its process and resume
// its messages. The others end cleanly.
async function shutdown(code: 0 | 1) {
  if (stopping) return
  stopping = true
  // Closing the connection first tells the API the computer is going, so a key set from here waits for it to start again.
  control.stop()
  abort.abort()
  for (const refresh of refreshes.values()) if (refresh.timer) clearTimeout(refresh.timer)
  for (const [id, session] of sessions) {
    if (session.busy) sessions.delete(id)
    else session.stop()
  }
  for (const running of signIns.values()) running.stop()
  const deadline = Date.now() + 10_000
  while (sessions.size && Date.now() < deadline) await sleep(100)
  screen?.link.stop()
  await screen?.service.stop()
  await desktop?.stop()
  await api('POST', '/v1/instance/heartbeat', { status: 'offline' }).catch(() => {})
  process.exit(code)
}

const abort = new AbortController()
// The API's way to this computer for what must not be stored on the way, such as a secret's value.
const control = linkControl({ api: config.api, token: config.token, hold: holdSecret, hello: helloSecrets })
process.on('SIGINT', () => { void shutdown(0) })
process.on('SIGTERM', () => { void shutdown(0) })
console.log(`agentsd connected to ${config.api}`)
void heartbeat()
void desktopUp.then((up) => { if (up) void listen(abort.signal) })
followSignIns(abort.signal)
// The person's own Claude Code sessions in the folders they connected on this Mac.
void followTerminalSessions({ home: HOME, config, api, secrets: knownSecrets, ready: shellRead, signal: abort.signal })
  .catch((error: unknown) => { console.error('terminal sessions stopped:', messageOf(error)) })
// The Agents app on this Mac lists and connects those folders through this socket.
serveAppSocket({ home: HOME, api, signal: abort.signal })
