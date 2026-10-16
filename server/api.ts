// The server's one door. Writes go to Postgres through the record module, and
// reads go through the sync proxy to Electric. People reach it through tailscale
// serve, which proxies to a Unix socket and sets Tailscale-User-Login. Machines,
// boxes included, send a bearer token to the machine port, which listens on
// loopback unless AGENTS_MACHINE_HOST names other addresses, such as a VPC or
// tailnet address.

import { BUILD } from './build.ts'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, normalize } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type pg from 'pg'
import { z } from 'zod'
import { adminFrom, checkAudience, instanceFrom, personFrom } from './auth.ts'
import { Created, FileAnswer, fieldOf, optionalText, parseBody, pathId, readBody, readJson, text, type Audience, type Params, type Route } from './http.ts'
import { connectedFolders, connectFolder, disconnectFolder, sessionWriter, terminalSession } from './folders.ts'
import { ConnectFolder, DisconnectFolder, TerminalSessionAsk, type FolderList } from '../shared/terminal.ts'
import { maybe, one, pool, tx } from './db.ts'
import { migrate } from './migrate.ts'
import { messageOf } from '../shared/errors.ts'
import { listenOnSocket } from '../shared/socket.ts'
import { MACHINE_PORT, MachineHosts, Port } from '../shared/listen.ts'
import { canSeeSession, canSeeTask } from './access.ts'
import {
  answerAsk, appendEvents, claimCommand, HttpError, interruptSession, openDm, saveDocuments, scrub, sendPersonMessage, type Decision, type Person,
} from './record.ts'
import { proxyStream, startStreamServer } from './streams.ts'
import { agentScope } from './agent-scope.ts'
import { chatRoutes } from './chat-routes.ts'
import { pendingUploads, placeUploads, startAttachmentSweep, withFiles } from './attachments.ts'
import { AttachmentIds, PostBody } from '../shared/attachments.ts'
import { MessageMoveRefused, moveMessages, recoverMachine } from './durability.ts'
import { cancelWaitingTurn } from './scheduler.ts'
import { agentProfile, pipelineHistory, readSession, recentActivity, searchRecord } from './teamrecord.ts'
import { proxyShape } from './sync.ts'
import { GIT_PATH, proxyGit } from './git.ts'
import { forgeHook, pipelineHook } from './hooks.ts'
import { repoPath } from './forge.ts'
import { forgeFor, refreshDefaultBranches, refreshTaskDefaultBranches, reposOverview, type TeamRepo } from './repos.ts'
import { githubStatus, setStopgap, signOut, startSignIn } from './github-auth.ts'
import { startGithubWorker } from './github-worker.ts'
import { addRepoToProject, askGithub, createProject, retryRepoRequest } from './projects.ts'
import { AddRepoBody, NewProjectBody, ProjectId, RepoRequestId, StopgapBody } from '../shared/projects.ts'
import { answerRunAsk, cancelRun, pauseRun, resumeRun, startRun, startRunner, wakeRunner } from './runner.ts'
import { recordDecisions } from './framework.ts'
import { openObligations, waive } from './obligations.ts'
import { syncPipelines } from './pipelines.ts'
import { copyAgent, createAgent, removeHook, removeItem, saveHook, savePlugin, saveRoutine, saveSkill, saveTemplate, setAcceptsAgents, updateAgent, writeMemory } from './agents.ts'
import { callerOf, delegateTask, listAgents, makeAgent, reportBack, sendToAgent } from './team-agents.ts'
import { DelegateTask, ReportBack, SendToAgent, SetAccepts } from '../shared/team-agents.ts'
import { createRoom } from './rooms.ts'
import { decideHunk } from './hunks.ts'
import { HunkDecisionBody, HunkId } from '../shared/evidence.ts'
import { addComment, messageTaskSession, resolveComment, startTask } from './tasks.ts'
import { discardDraft, editDraft, startDraft } from './drafts.ts'
import { saveChanges } from './changes.ts'
import { askForPullRequests } from './pulls.ts'
import { versionDiff } from './versions.ts'
import { ArtifactId, SessionId, TaskId, TurnId, WorkspaceId } from '../shared/ids.ts'
import { BlockAsk, ChangesPost, HoldAsk, NewComment, NewTask, PriorityAsk, PullRequestAsk, TaskAction, DraftEdit, type WorkspaceSetup } from '../shared/work.ts'
import { block, hold, markDone, prioritize, readyAnswer, reopen, unblock, unhold } from './order.ts'
import { sendRoutine } from './routines.ts'
import { onboardingRoutes } from './onboarding-routes.ts'
import { boxRoutes } from './box-routes.ts'
import { AUDIO_POST, voiceRoutes } from './voice.ts'
import { checkSpeechSettings } from './speech.ts'
import { kindOf } from './audio.ts'
import { isVoiceUpgrade, voiceUpgrade } from './voice-chat.ts'
import { secretRoutes } from './secrets.ts'
import { controlUpgrade } from './control.ts'
import { webmcpRoutes } from './webmcp.ts'
import { historyRoutes } from './history-routes.ts'
import { handBackScreen, recheckViewers, screenUpgrades, startScreenSweep, takeScreen } from './screens.ts'
import { InstanceId } from '../shared/onboarding.ts'
import { CopyAsk } from '../shared/recipe.ts'
import { ImportAsk } from '../shared/recipe-file.ts'
import { exportRecipe, importRecipe } from './recipe-files.ts'
import { Heartbeat, ScreenMove, type ScreenMoved } from '../shared/screen.ts'
import { DocumentUploads, ImageMediaType } from '../shared/documents.ts'
import {
  EndedMessages, EVENT_KINDS, SESSION_STATUSES,
  type EventBatch, type EventKind, type NewEvent, type RawLine, type SessionStatus,
} from '../shared/types.ts'

// Outside data through its schema. Data that does not fit is the sender's mistake.
function parsed<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new HttpError(400, z.prettifyError(result.error))
  return result.data
}

// A project a room is started in. Leaving it out starts one outside any project.
function optionalProject(value: unknown): ProjectId | undefined {
  if (value === undefined || value === null) return undefined
  const result = ProjectId.safeParse(value)
  if (!result.success) throw new HttpError(400, 'projectId must be an id')
  return result.data
}

// A machine's batch for a session, holding only the kinds that session takes from a machine.
function parseBatch(raw: Record<string, unknown>, kinds: readonly EventKind[]): EventBatch {
  if (!Array.isArray(raw.events)) throw new HttpError(400, 'events must be an array')
  const events: NewEvent[] = raw.events.map((e, i) => {
    if (!e || typeof e !== 'object') throw new HttpError(400, `events.${i} must be an object`)
    const event = e as Record<string, unknown>
    const kind = event.kind as EventKind
    if (!EVENT_KINDS.includes(kind)) throw new HttpError(400, `events.${i}.kind is not an event kind`)
    if (!kinds.includes(kind)) throw new HttpError(400, `this session takes no ${kind} events from a machine`)
    return {
      clientId: text(event.clientId, `events.${i}.clientId`),
      kind,
      body: event.body ?? null,
      text: typeof event.text === 'string' ? event.text : undefined,
      toolUseId: optionalText(event.toolUseId, `events.${i}.toolUseId`),
      toolName: optionalText(event.toolName, `events.${i}.toolName`),
      parentToolUseId: optionalText(event.parentToolUseId, `events.${i}.parentToolUseId`),
    }
  })
  const rawLines: RawLine[] = Array.isArray(raw.raw)
    ? raw.raw.map((r: unknown, i): RawLine => ({ clientId: text(fieldOf(r, 'clientId'), `raw.${i}.clientId`), line: fieldOf(r, 'line') ?? null }))
    : []
  if (raw.status !== undefined && !SESSION_STATUSES.includes(raw.status as SessionStatus)) {
    throw new HttpError(400, 'status is not a session status')
  }
  const ended = EndedMessages.optional().safeParse(raw.ended)
  if (!ended.success) throw new HttpError(400, 'ended must say whether the messages were answered or their harness exited, and list their command ids')
  return {
    events,
    raw: rawLines,
    status: raw.status as SessionStatus | undefined,
    harnessSessionId: optionalText(raw.harnessSessionId, 'harnessSessionId'),
    ended: ended.data,
  }
}

function paramsOf(path: RegExp, pathname: string): Params {
  const groups = path.exec(pathname)?.slice(1) ?? []
  if (groups.length > 3) throw new Error(`a route captures ${groups.length} parts, and at most 3 are handled`)
  return [groups[0] ?? '', groups[1] ?? '', groups[2] ?? '']
}

const bounded = (value: string | null, fallback: number, max: number) =>
  Math.min(max, Math.max(1, Number(value) || fallback))
const UUID = '([0-9a-f-]{36})'
// What an agent's team-agents tools post: a message, a handed-over task, a task's result, and a new agent.
const TeamAgentAction = z.enum(['messages', 'tasks', 'report', 'agents'])

// A new chat's first post: the words, the files, or both. Neither leaves the chat empty.
const FirstPost = z.object({ text: z.string().nullish(), attachmentIds: AttachmentIds.nullish() })
async function withFirstPost(client: pg.PoolClient, person: Person, conversationId: string, body: Record<string, unknown>): Promise<string> {
  const post = parsed(FirstPost, body)
  if ((post.text ?? '').trim() !== '' || post.attachmentIds) {
    await sendPersonMessage(client, person, conversationId, post.text ?? '', randomUUID(), { attachmentIds: post.attachmentIds ?? [] })
  }
  return conversationId
}

const routes: Route[] = [
  ['machines', 'GET', /^\/v1\/record\/search$/, async (req, _params, url) => {
    const { teamId, sessionId } = await agentScope(req, url)
    return { hits: await searchRecord(teamId, sessionId, url.searchParams.get('q') ?? '', bounded(url.searchParams.get('limit'), 10, 50)) }
  }],

  ['machines', 'GET', new RegExp(`^/v1/record/sessions/${UUID}$`), async (req, [readId], url) => {
    const { teamId, sessionId } = await agentScope(req, url)
    return readSession(teamId, sessionId, readId, Number(url.searchParams.get('from')) || 1, bounded(url.searchParams.get('limit'), 60, 200))
  }],

  ['machines', 'GET', /^\/v1\/record\/pipelines\/([a-z0-9_-]+)\/history$/, async (req, [name], url) => {
    const { teamId } = await agentScope(req, url)
    return { runs: await pipelineHistory(teamId, name, bounded(url.searchParams.get('limit'), 10, 30)) }
  }],

  ['machines', 'GET', /^\/v1\/record\/agents\/([^/]+)$/, async (req, [name], url) => {
    const { teamId } = await agentScope(req, url)
    return agentProfile(teamId, decodeURIComponent(name))
  }],

  // What is ready to start, and what is held, among the team's shared tasks.
  ['machines', 'GET', /^\/v1\/record\/ready$/, async (req, _params, url) => {
    const { teamId } = await agentScope(req, url)
    return readyAnswer(pool, teamId, null)
  }],

  ['machines', 'GET', /^\/v1\/record\/recent$/, async (req, _params, url) => {
    const { teamId, sessionId } = await agentScope(req, url)
    return { sessions: await recentActivity(teamId, sessionId, bounded(url.searchParams.get('hours'), 24, 24 * 14)) }
  }],

  // An agent keeps its memory of a person or the team, from inside one of its sessions.
  ['machines', 'POST', /^\/v1\/record\/memory$/, async (req, _params, url) => {
    const { teamId, sessionId } = await agentScope(req, url)
    const body = await readJson(req)
    const kind = body.kind === 'profile' || body.kind === 'log' ? body.kind : null
    if (!kind) throw new HttpError(400, 'kind must be profile or log')
    const about = text(body.about, 'about')
    const content = text(body.content, 'content')
    await tx(async (client) => {
      const session = await one<{ agent_id: string }>(client, 'the session', 'select agent_id from sessions where id = $1', [sessionId])
      let personId: string | null = null
      if (about !== 'team') {
        const person = await maybe<{ id: string }>(client, 'select id from people where team_id = $1 and login = $2', [teamId, about])
        if (!person) throw new HttpError(404, `no teammate ${about}`)
        personId = person.id
      }
      await writeMemory(client, session.agent_id, teamId, { personId }, kind, scrub(content))
    })
    return { ok: true }
  }],

  // An agent working with its team's other agents, from inside one of its sessions,
  // through its team-agents tools. server/team-agents.ts checks who may do what.
  ['machines', 'GET', /^\/v1\/team-agents$/, async (req, _params, url) => {
    const { teamId, sessionId } = await agentScope(req, url)
    return tx(async (client) => listAgents(client, await callerOf(client, teamId, sessionId)))
  }],

  ['machines', 'POST', /^\/v1\/team-agents\/(messages|tasks|report|agents)$/, async (req, [action], url) => {
    const { teamId, sessionId } = await agentScope(req, url)
    const body = await readJson(req)
    const answer = await tx(async (client) => {
      const caller = await callerOf(client, teamId, sessionId)
      switch (parsed(TeamAgentAction, action)) {
        case 'messages': return sendToAgent(client, caller, parsed(SendToAgent, body))
        case 'tasks': return delegateTask(client, caller, parsed(DelegateTask, body))
        case 'report': return reportBack(client, caller, parsed(ReportBack, body))
        case 'agents': return makeAgent(client, caller, body)
      }
    })
    void wakeRunner()
    return answer
  }],

  ['machines', 'POST', /^\/v1\/instance\/heartbeat$/, async (req) => {
    const instance = await instanceFrom(req)
    const body = Heartbeat.safeParse(await readJson(req))
    if (!body.success) throw new HttpError(400, z.prettifyError(body.error))
    // A daemon going offline takes no more work until it reports in again with recover.
    await pool.query(`update instances set status = $2, last_seen_at = now(), ready = ready and $2::text <> 'offline' where id = $1`,
      [instance.id, body.data.status])
    // A machine with a desktop reports its screen's size, and one without reports null.
    // Daemons from before screens, and a daemon going offline, leave it as it was.
    const { screen } = body.data
    if (screen !== undefined) {
      await pool.query('update instances set screen_width = $2, screen_height = $3 where id = $1',
        [instance.id, screen ? screen.width : null, screen ? screen.height : null])
    }
    return { ok: true }
  }],

  // A daemon that starts up reports in. What it held goes back in the queue,
  // except its unfinished messages, which come back as sessions to resume.
  ['machines', 'POST', /^\/v1\/instance\/recover$/, async (req) => {
    const instance = await instanceFrom(req)
    const recovery = await tx((client) => recoverMachine(client, instance.id))
    void wakeRunner()
    return recovery
  }],

  ['machines', 'POST', new RegExp(`^/v1/instance/commands/${UUID}/claim$`), async (req, [commandId]) => {
    const instance = await instanceFrom(req)
    const command = await claimCommand(pool, instance.id, commandId)
    if (!command) throw new HttpError(409, 'already claimed or not queued')
    return { command }
  }],

  ['machines', 'POST', new RegExp(`^/v1/instance/commands/${UUID}$`), async (req, [commandId]) => {
    const instance = await instanceFrom(req)
    const body = await readJson(req)
    if (body.status !== 'done' && body.status !== 'failed') throw new HttpError(400, 'status must be done or failed')
    await tx(async (client) => {
      const error = scrub(optionalText(body.error, 'error') ?? null)
      const kind = (await maybe<{ kind: string }>(client, 'select kind from commands where id = $1 and instance_id = $2', [commandId, instance.id]))?.kind
      if (kind === 'message') {
        if (body.status === 'done') throw new HttpError(400, 'a message is done when the turn that answers it ends')
        // The machine could not hand the session its message, so the agent never got
        // it. The session fails with the machine's reason, as it does when Claude exits.
        const [message] = await moveMessages(client, [commandId], 'failed', { instanceId: instance.id, error }).catch((refused: unknown) => {
          throw refused instanceof MessageMoveRefused ? new HttpError(404, 'no such claimed command on this instance') : refused
        })
        if (!message) throw new Error(`message ${commandId} moved, and returned no row`)
        const reason = scrub(error ?? 'The machine could not start the session.')
        await appendEvents(client, message.session_id, {
          events: [{ clientId: `command:${commandId}`, kind: 'error', text: reason, body: { commandId, reason } }], status: 'failed',
        })
        return
      }
      const command = await maybe<{ kind: string; payload: { workspaceId?: string; repos?: { repoId: string; branch: string }[] } }>(client,
        `update commands set status = $3, error = $4, result = $5, done_at = now()
         where id = $1 and instance_id = $2 and status = 'claimed' and kind <> 'message' returning kind, payload`,
        [commandId, instance.id, body.status, error, JSON.stringify(scrub(body.result ?? null))])
      if (!command) throw new HttpError(404, 'no such claimed command on this instance')
      // A workspace is ready once its machine has cloned every repo.
      const result = body.result as { path?: string; worktrees?: { repoId: string; baseCommit: string }[] } | null
      if (command.kind === 'setup_workspace' && body.status === 'done' && result?.path) {
        const workspace = await maybe<{ id: string }>(client,
          `update workspaces set status = 'ready', path = $3 where id = $1 and instance_id = $2 returning id`,
          [command.payload.workspaceId, instance.id, result.path])
        for (const tree of workspace ? result.worktrees ?? [] : []) {
          const branch = command.payload.repos?.find((r) => r.repoId === tree.repoId)?.branch ?? ''
          await client.query(
            `insert into worktrees (workspace_id, repo_id, branch, base_commit) values ($1, $2, $3, $4)
             on conflict (workspace_id, repo_id) do update set base_commit = excluded.base_commit`,
            [command.payload.workspaceId, tree.repoId, branch, tree.baseCommit])
        }
      }
    })
    void wakeRunner()
    return { ok: true }
  }],

  // Files an agent wrote in its task's folder become document versions: text,
  // or images such as the screenshots it saved.
  ['machines', 'POST', new RegExp(`^/v1/sessions/${UUID}/documents$`), async (req, [sessionId]) => {
    const instance = await instanceFrom(req)
    const body = DocumentUploads.safeParse(await readJson(req))
    if (!body.success) throw new HttpError(400, z.prettifyError(body.error))
    return { versions: await tx((client) => saveDocuments(client, instance.id, sessionId, body.data.documents)) }
  }],

  // Whether one of the asking machine's workspaces is still being set up: not yet
  // ready, with its setup queued or running, or not yet ended at all.
  ['machines', 'GET', new RegExp(`^/v1/instance/workspaces/${UUID}/setup$`), async (req, [id]) => {
    const instance = await instanceFrom(req)
    const workspaceId = parsed(WorkspaceId, id)
    const found = await maybe<{ setting_up: boolean }>(pool,
      `select w.status = 'creating' and (
         exists (select 1 from commands c where c.kind = 'setup_workspace' and c.payload->>'workspaceId' = w.id::text and c.status in ('queued', 'claimed'))
         or not exists (select 1 from commands c where c.kind = 'setup_workspace' and c.payload->>'workspaceId' = w.id::text and c.status in ('done', 'failed'))
       ) as setting_up
       from workspaces w where w.id = $1 and w.instance_id = $2`, [workspaceId, instance.id])
    if (!found) throw new HttpError(404, 'no such workspace on this machine')
    const answer: WorkspaceSetup = { settingUp: found.setting_up }
    return answer
  }],

  // What differs from the base branch in a workspace's repos, from its machine.
  ['machines', 'POST', new RegExp(`^/v1/workspaces/${UUID}/changes$`), async (req, [id]) => {
    const instance = await instanceFrom(req)
    const workspaceId = parsed(WorkspaceId, id)
    const post = parsed(ChangesPost, await readJson(req))
    return tx((client) => saveChanges(client, instance.id, workspaceId, post))
  }],

  // Whether this API process serves, and the commit it runs. The deployer
  // checks a new release by it, and nothing in it is secret.
  ['machines', 'GET', /^\/v1\/health$/, async () => {
    await pool.query('select 1')
    return { ok: true, commit: BUILD.commit, build: BUILD }
  }],

  // The folders on this Mac whose terminal sessions land in the record, how many
  // sessions each holds, and the Mac's own id. Only the Mac itself connects or
  // disconnects one, from the folders command or from the Agents app on that Mac
  // through its daemon, so no person's request can.
  ['machines', 'GET', /^\/v1\/instance\/folders$/, async (req) => {
    const instance = await instanceFrom(req)
    const answer: FolderList = { instanceId: InstanceId.parse(instance.id), ...await connectedFolders(instance) }
    return answer
  }],

  ['machines', 'POST', /^\/v1\/instance\/folders$/, async (req) => {
    const instance = await instanceFrom(req)
    const ask = await parseBody(req, ConnectFolder)
    return tx((client) => connectFolder(client, instance, ask))
  }],

  ['machines', 'POST', /^\/v1\/instance\/folders\/disconnect$/, async (req) => {
    const instance = await instanceFrom(req)
    const ask = await parseBody(req, DisconnectFolder)
    return tx((client) => disconnectFolder(client, instance, ask))
  }],

  // A Claude Code session the Mac found in one of its connected folders, and the
  // record's session for it, the same one each time it asks.
  ['machines', 'POST', /^\/v1\/instance\/terminal-sessions$/, async (req) => {
    const instance = await instanceFrom(req)
    const ask = await parseBody(req, TerminalSessionAsk)
    return { sessionId: await tx((client) => terminalSession(client, instance, ask)) }
  }],

  ['machines', 'POST', new RegExp(`^/v1/sessions/${UUID}/events$`), async (req, [sessionId]) => {
    const instance = await instanceFrom(req)
    const writer = await sessionWriter(instance, parsed(SessionId, sessionId))
    const batch = parseBatch(await readJson(req), writer.kinds)
    const seqs = await tx(async (client) => {
      // A terminal session's prompts are its person's own.
      const appended = await appendEvents(client, sessionId, batch, writer.kind === 'terminal' ? writer.author : null)
      // The decision log reads log_decision calls from the record, so it is complete whatever the tool's server did.
      await recordDecisions(client, sessionId, batch.events)
      return appended
    })
    // A finished turn may be what a pipeline run is waiting on.
    if (batch.events.some((e) => e.kind === 'usage')) void wakeRunner()
    // A session that starts may be work some of the box's viewers can't see. A
    // failed recheck waits for the screen sweep, which runs it again within seconds.
    if (batch.status !== undefined) {
      recheckViewers(InstanceId.parse(instance.id)).catch((error: unknown) => { console.error(`screen recheck: ${messageOf(error)}`) })
    }
    return { seqs }
  }],

  ['people', 'POST', /^\/v1\/conversations$/, async (req) => {
    const person = await personFrom(req)
    const body = await readJson(req)
    if (body.kind === 'room') {
      const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
      const projectId = optionalProject(body.projectId)
      return { conversationId: await tx(async (client) => {
        const conversationId = await createRoom(client, person, text(body.name, 'name'), list(body.people), list(body.agents), projectId)
        return withFirstPost(client, person, conversationId, body)
      }) }
    }
    if (body.kind !== 'dm') throw new HttpError(400, 'kind must be dm or room')
    const agent = text(body.agent, 'agent')
    return { conversationId: await tx(async (client) => withFirstPost(client, person, await openDm(client, person, agent), body)) }
  }],

  ['people', 'POST', /^\/v1\/agents$/, async (req) => {
    const person = await personFrom(req)
    return { agentId: await tx(async (client) => createAgent(client, person, await readJson(req))) }
  }],

  ['people', 'POST', new RegExp(`^/v1/agents/${UUID}$`), async (req, [agentId]) => {
    const person = await personFrom(req)
    const body = await readJson(req)
    await tx((client) => updateAgent(client, person, agentId, body))
    return { ok: true }
  }],

  ['people', 'POST', new RegExp(`^/v1/agents/${UUID}/(skills|plugins|routines)$`), async (req, [agentId, kind]) => {
    const person = await personFrom(req)
    const body = await readJson(req)
    const save = { skills: saveSkill, plugins: savePlugin, routines: saveRoutine }[kind as 'skills']
    await tx((client) => save(client, person, agentId, body))
    return { ok: true }
  }],

  ['people', 'POST', new RegExp(`^/v1/agents/${UUID}/(skills|plugins|routines)/([^/]+)/delete$`), async (req, [agentId, kind, name]) => {
    const person = await personFrom(req)
    await tx((client) => removeItem(client, person, agentId, kind as 'skills', decodeURIComponent(name)))
    return { ok: true }
  }],

  // Whether agents with another owner may message the agent and hand it tasks. Only its owner says.
  ['people', 'POST', new RegExp(`^/v1/agents/${UUID}/accepts$`), async (req, [agentId]) => {
    const person = await personFrom(req)
    const { agents } = await parseBody(req, SetAccepts)
    return tx((client) => setAcceptsAgents(client, person, agentId, agents))
  }],

  // Hooks run commands on the agent's machine, so they have routes of their own, and an owner's or admin's check.
  ['people', 'POST', new RegExp(`^/v1/agents/${UUID}/hooks$`), async (req, [agentId]) => {
    const person = await personFrom(req)
    const body = await readJson(req)
    return { ok: true, name: await tx((client) => saveHook(client, person, agentId, body)) }
  }],

  ['people', 'POST', new RegExp(`^/v1/agents/${UUID}/hooks/([^/]+)/delete$`), async (req, [agentId, name]) => {
    const person = await personFrom(req)
    await tx((client) => removeHook(client, person, agentId, decodeURIComponent(name)))
    return { ok: true }
  }],

  // An agent's setup as a file, and a new agent from one. Whether setups leave the team waits on Tayler's decision 11.
  ['people', 'GET', new RegExp(`^/v1/agents/${UUID}/recipe$`), async (req, [agentId], url) => {
    const person = await personFrom(req)
    const memories = url.searchParams.get('memories')
    if (memories !== 'true' && memories !== 'false') throw new HttpError(400, 'memories must be true or false')
    return tx((client) => exportRecipe(client, person, agentId, memories === 'true'))
  }],

  ['people', 'POST', /^\/v1\/agents\/import$/, async (req) => {
    const person = await personFrom(req)
    const ask = parsed(ImportAsk, await readJson(req))
    return tx((client) => importRecipe(client, person, ask))
  }],

  // A new agent with the setup of this one, owned by the person who asks.
  ['people', 'POST', new RegExp(`^/v1/agents/${UUID}/copy$`), async (req, [agentId]) => {
    const person = await personFrom(req)
    const ask = parsed(CopyAsk, await readJson(req))
    return tx((client) => copyAgent(client, person, agentId, ask))
  }],

  ['people', 'POST', new RegExp(`^/v1/agents/${UUID}/templates$`), async (req, [agentId]) => {
    const person = await personFrom(req)
    const body = await readJson(req)
    return tx((client) => saveTemplate(client, person, agentId, body.name === undefined ? null : text(body.name, 'name')))
  }],

  // Runs a routine now, as if it had come due.
  ['people', 'POST', new RegExp(`^/v1/routines/${UUID}/run$`), async (req, [routineId]) => {
    const person = await personFrom(req)
    const routine = await maybe(pool,
      'select 1 from routines r join agents a on a.id = r.agent_id where r.id = $1 and a.team_id = $2', [routineId, person.team_id])
    if (!routine) throw new HttpError(404, 'no such routine')
    return { conversationId: await tx((client) => sendRoutine(client, routineId, person.id)) }
  }],

  ['people', 'POST', /^\/v1\/tasks$/, async (req) => {
    const person = await personFrom(req)
    const raw = await readJson(req)
    const { repoId, ...task } = parsed(NewTask, raw)
    const attachmentIds = parsed(AttachmentIds.optional(), raw.attachmentIds)
    if (attachmentIds && task.draft) throw new HttpError(400, 'A draft takes no attachments yet. Attach files when the task starts.')
    const repoIds = repoId ? [repoId, ...task.repoIds] : task.repoIds
    // The workspace is cloned from each repo's default branch, which its owner can rename on the forge.
    if (!task.draft) await refreshDefaultBranches(person.team_id, repoIds)
    return tx(async (client) => {
      // The files are named in the task's instructions, so its first turn reads them, and they sit in the
      // session once it exists.
      const files = attachmentIds ? await pendingUploads(client, person, attachmentIds, {}) : []
      const started = await startTask(client, person, { ...task, repoIds, instructions: withFiles(task.instructions, files) })
      if (files.length) {
        const first = await one<{ id: string }>(client, "the task's first post", `select id from events where session_id = $1 and kind = 'user' order by seq limit 1`, [started.sessionId])
        await placeUploads(client, files.map((f) => f.id), { sessionId: started.sessionId, eventId: first.id })
      }
      return started
    })
  }],

  // The order of work. Each command answers whether there was anything to change.
  ['people', 'GET', /^\/v1\/tasks\/ready$/, async (req) => {
    const person = await personFrom(req)
    return readyAnswer(pool, person.team_id, person.id)
  }],

  ['people', 'POST', new RegExp(`^/v1/tasks/${UUID}/(done|reopen|unhold)$`), async (req, [id, verb]) => {
    const person = await personFrom(req)
    const taskId = parsed(TaskId, id)
    const action = parsed(TaskAction.extract(['done', 'reopen', 'unhold']), verb)
    switch (action) {
      case 'done': return tx((client) => markDone(client, person, taskId))
      case 'reopen': return tx((client) => reopen(client, person, taskId))
      case 'unhold': return tx((client) => unhold(client, person, taskId))
    }
  }],

  ['people', 'POST', new RegExp(`^/v1/tasks/${UUID}/hold$`), async (req, [id]) => {
    const person = await personFrom(req)
    const taskId = parsed(TaskId, id)
    const ask = parsed(HoldAsk, await readJson(req))
    return tx((client) => hold(client, person, taskId, ask))
  }],

  ['people', 'POST', new RegExp(`^/v1/tasks/${UUID}/priority$`), async (req, [id]) => {
    const person = await personFrom(req)
    const taskId = parsed(TaskId, id)
    const { priority } = parsed(PriorityAsk, await readJson(req))
    return tx((client) => prioritize(client, person, taskId, priority))
  }],

  ['people', 'POST', new RegExp(`^/v1/tasks/${UUID}/blockers$`), async (req, [id]) => {
    const person = await personFrom(req)
    const taskId = parsed(TaskId, id)
    const ask = parsed(BlockAsk, await readJson(req))
    return tx((client) => block(client, person, taskId, ask))
  }],

  ['people', 'POST', new RegExp(`^/v1/tasks/${UUID}/blockers/${UUID}/remove$`), async (req, [id, blocker]) => {
    const person = await personFrom(req)
    const taskId = parsed(TaskId, id)
    const blockerId = parsed(TaskId, blocker)
    return tx((client) => unblock(client, person, taskId, blockerId))
  }],

  // Push the task's branches and open a pull request for each repo with commits.
  ['people', 'POST', new RegExp(`^/v1/tasks/${UUID}/pull-requests$`), async (req, [id]) => {
    const person = await personFrom(req)
    const taskId = parsed(TaskId, id)
    const ask = parsed(PullRequestAsk, await readJson(req))
    return tx((client) => askForPullRequests(client, person, taskId, ask))
  }],

  // A draft task: edited, started, or discarded.
  ['people', 'POST', new RegExp(`^/v1/tasks/${UUID}/(edit|start|discard)$`), async (req, [id, verb]) => {
    const person = await personFrom(req)
    const taskId = parsed(TaskId, id)
    const body = await readJson(req)
    const action = parsed(TaskAction.extract(['edit', 'start', 'discard']), verb)
    switch (action) {
      case 'start':
        await refreshTaskDefaultBranches(person.team_id, taskId)
        return tx((client) => startDraft(client, person, taskId))
      case 'discard':
        await tx((client) => discardDraft(client, person, taskId))
        return { ok: true }
      case 'edit': {
        const edit = parsed(DraftEdit, body)
        await tx((client) => editDraft(client, person, taskId, edit))
        return { ok: true }
      }
    }
  }],

  // Projects and their repos. docs/design/projects.md has the whole design.
  ['people', 'POST', /^\/v1\/projects$/, async (req) => {
    const person = await personFrom(req)
    return createProject(person, await parseBody(req, NewProjectBody))
  }],

  ['people', 'POST', new RegExp(`^/v1/projects/${UUID}/repos$`), async (req, [projectId]) => {
    const person = await personFrom(req)
    return addRepoToProject(person, pathId(ProjectId, projectId), await parseBody(req, AddRepoBody))
  }],

  ['people', 'POST', new RegExp(`^/v1/repo-requests/${UUID}/retry$`), async (req, [requestId]) => {
    const person = await personFrom(req)
    await retryRepoRequest(person, pathId(RepoRequestId, requestId))
    return { ok: true }
  }],

  // Every repo of the team, with what its forge says is open on it.
  ['people', 'GET', /^\/v1\/repos$/, async (req) => reposOverview(await personFrom(req))],

  // Whether GitHub is set up, and the person's own sign-in. Never a token.
  ['people', 'GET', /^\/v1\/github$/, async (req) => githubStatus(await personFrom(req))],

  // Signs the person in with GitHub's device flow. The answer has the code they enter on GitHub.
  ['people', 'POST', /^\/v1\/github\/sign-in$/, async (req) => {
    const person = await personFrom(req)
    await askGithub(() => startSignIn(person.id))
    return githubStatus(person)
  }],

  ['people', 'POST', /^\/v1\/github\/sign-out$/, async (req) => {
    const person = await personFrom(req)
    signOut(person.id)
    return githubStatus(person)
  }],

  // The stopgap until people sign in: an admin's fine-grained personal access token for their whole team.
  ['people', 'POST', /^\/v1\/github\/token$/, async (req) => {
    const person = await adminFrom(req)
    const body = await parseBody(req, StopgapBody)
    // setStopgap's refusals are written for the admin to act on.
    await setStopgap(person.team_id, body.token, body.owner).catch((error: unknown) => { throw new HttpError(400, messageOf(error)) })
    return githubStatus(person)
  }],

  ['people', 'POST', new RegExp(`^/v1/sessions/${UUID}/messages$`), async (req, [sessionId]) => {
    const person = await personFrom(req)
    const body = await parseBody(req, PostBody)
    await tx((client) => messageTaskSession(client, person, sessionId, body.text ?? '', body.attachmentIds ?? []))
    return { ok: true }
  }],

  ['people', 'POST', new RegExp(`^/v1/artifacts/${UUID}/comments$`), async (req, [artifactId]) => {
    const person = await personFrom(req)
    const comment = parsed(NewComment, await readJson(req))
    const commentId = await tx((client) => addComment(client, person, artifactId, comment))
    return { commentId }
  }],

  // What changed in a document from the version before this one.
  ['people', 'GET', new RegExp(`^/v1/artifacts/${UUID}/versions/([0-9]{1,9})/diff$`), async (req, [id, n]) => {
    const person = await personFrom(req)
    const artifactId = parsed(ArtifactId, id)
    const version = parsed(z.coerce.number().int().min(2), n)
    return { diff: await versionDiff(person, artifactId, version) }
  }],

  ['people', 'POST', new RegExp(`^/v1/comments/${UUID}/resolve$`), async (req, [commentId]) => {
    const person = await personFrom(req)
    await tx((client) => resolveComment(client, person, commentId))
    return { ok: true }
  }],

  ['people', 'POST', new RegExp(`^/v1/asks/${UUID}/answer$`), async (req, [askId]) => {
    const person = await personFrom(req)
    const body = await readJson(req)
    // A pipeline's gate or hand-off, answered for the run rather than a tool call.
    const runAsk = await maybe<{ task_id: string }>(pool,
      'select r.task_id from asks a join runs r on r.id = a.run_id where a.id = $1 and a.team_id = $2', [askId, person.team_id])
    if (runAsk) {
      if (!(await canSeeTask(person, runAsk.task_id))) throw new HttpError(404, 'no such ask')
      await tx((client) => answerRunAsk(client, askId, person, text(body.decision, 'decision'), optionalText(body.message, 'message')))
      void wakeRunner()
      return { ok: true }
    }
    const ask = await maybe<{ session_id: string }>(pool,
      'select session_id from asks where id = $1 and team_id = $2 and session_id is not null', [askId, person.team_id])
    if (!ask || !(await canSeeSession(person, ask.session_id))) throw new HttpError(404, 'no such ask')
    const decision = body.decision as Decision
    if (!DECISIONS.includes(decision)) throw new HttpError(400, `decision must be one of ${DECISIONS.join(', ')}`)
    await tx((client) => answerAsk(client, askId, person, decision, optionalText(body.message, 'message')))
    return { ok: true }
  }],

  ['people', 'POST', new RegExp(`^/v1/sessions/${UUID}/interrupt$`), async (req, [sessionId]) => {
    const person = await personFrom(req)
    if (!(await canSeeSession(person, sessionId))) throw new HttpError(404, 'no such session')
    await tx((client) => interruptSession(client, sessionId))
    return { ok: true }
  }],

  // A person cancels a turn that waits for its machine, as they could interrupt one that runs.
  ['people', 'POST', new RegExp(`^/v1/turns/${UUID}/cancel$`), async (req, [turnId]) => {
    const person = await personFrom(req)
    const found = await maybe<{ session_id: string | null }>(pool, 'select session_id from turns where id = $1 and team_id = $2', [turnId, person.team_id])
    if (!found?.session_id || !(await canSeeSession(person, found.session_id))) throw new HttpError(404, 'no such turn')
    const result = await tx((client) => cancelWaitingTurn(client, TurnId.parse(turnId)))
    if (result === 'missing') throw new HttpError(404, 'no such turn')
    if (result === 'room') throw new HttpError(409, "A room's turn ends at its deadline.")
    if (result === 'not waiting') throw new HttpError(409, 'The turn is no longer waiting. Interrupt stops one that is running.')
    return { ok: true }
  }],

  ['people', 'POST', new RegExp(`^/v1/pipelines/${UUID}/runs$`), async (req, [pipelineId]) => {
    const person = await personFrom(req)
    const body = await readJson(req)
    const repo = await maybe<TeamRepo>(pool,
      'select id, forge, remote_url from repos where id = $1 and team_id = $2', [text(body.repoId, 'repoId'), person.team_id])
    if (!repo) throw new HttpError(404, 'no such repo')
    const pipeline = await maybe(pool, 'select 1 from pipelines where id = $1 and team_id = $2', [pipelineId, person.team_id])
    if (!pipeline) throw new HttpError(404, 'no such pipeline')
    const openIssues = (await forgeFor(repo).openIssues(repoPath(repo.remote_url)).catch(() => [])).map((i) => ({ number: i.number, title: i.title }))
    const runId = await tx((client) => startRun(client, {
      pipelineId, trigger: 'manual', repoId: body.repoId as string, openIssues, startedBy: person.id,
      report: { title: text(body.title, 'title'), body: typeof body.body === 'string' ? body.body : '', author: person.login },
    }))
    void wakeRunner()
    return { runId }
  }],

  // A person keeps or turns down one hunk of a coach proposal at its gate.
  ['people', 'POST', new RegExp(`^/v1/hunks/${UUID}/decision$`), async (req, [hunkId]) => {
    const person = await personFrom(req)
    const body = HunkDecisionBody.safeParse(await readJson(req))
    if (!body.success) throw new HttpError(400, 'decision must be accept, or reject with a reason')
    const hunk = await maybe<{ task_id: string }>(pool,
      `select r.task_id from proposal_hunks h join proposals p on p.id = h.proposal_id join runs r on r.id = p.run_id
       where h.id = $1 and h.team_id = $2`, [hunkId, person.team_id])
    if (!hunk || !(await canSeeTask(person, hunk.task_id))) throw new HttpError(404, 'no such hunk')
    await tx((client) => decideHunk(client, person, HunkId.parse(hunkId), body.data))
    return { ok: true }
  }],

  // Promises made outside Agents that are still open, due soonest first.
  ['people', 'GET', /^\/v1\/obligations$/, async (req) => {
    const person = await personFrom(req)
    return { obligations: await openObligations(pool, person.team_id) }
  }],

  // A person lets a promise go, by name, with the reason.
  ['people', 'POST', new RegExp(`^/v1/obligations/${UUID}/waive$`), async (req, [obligationId]) => {
    const person = await personFrom(req)
    const body = await readJson(req)
    await tx((client) => waive(client, obligationId, person, text(body.reason, 'reason')))
    return { ok: true }
  }],

  ['people', 'POST', new RegExp(`^/v1/runs/${UUID}/(pause|resume)$`), async (req, [runId, action]) => {
    const person = await personFrom(req)
    const body = await readJson(req)
    const run = await maybe<{ task_id: string }>(pool, 'select task_id from runs where id = $1 and team_id = $2', [runId, person.team_id])
    if (!run || !(await canSeeTask(person, run.task_id))) throw new HttpError(404, 'no such run')
    if (action === 'pause') await tx((client) => pauseRun(client, runId, person, optionalText(body.note, 'note')))
    else await tx((client) => resumeRun(client, runId, person))
    void wakeRunner()
    return { ok: true }
  }],

  ['people', 'POST', new RegExp(`^/v1/runs/${UUID}/cancel$`), async (req, [runId]) => {
    const person = await personFrom(req)
    const run = await maybe<{ task_id: string }>(pool, 'select task_id from runs where id = $1 and team_id = $2', [runId, person.team_id])
    if (!run || !(await canSeeTask(person, run.task_id))) throw new HttpError(404, 'no such run')
    await tx((client) => cancelRun(client, runId, person))
    return { ok: true }
  }],

  // A person takes over a box's screen, or hands it back to the agents. The body
  // names the session they were looking at, for the notice in its record.
  ['people', 'POST', new RegExp(`^/v1/screens/${UUID}/(take|hand-back)$`), async (req, [instanceId, action]) => {
    const person = await personFrom(req)
    const body = ScreenMove.safeParse(await readJson(req))
    if (!body.success) throw new HttpError(400, z.prettifyError(body.error))
    const move = action === 'take' ? takeScreen : handBackScreen
    const moved: ScreenMoved = { control: await move(person, instanceId, body.data.sessionId) }
    return moved
  }],

  // A person keeps a box for themselves, or lets it go back to the pool. A
  // person's own box is never in the pool.
  ['people', 'POST', new RegExp(`^/v1/instances/${UUID}/(claim|release)$`), async (req, [instanceId, action]) => {
    const person = await personFrom(req)
    const { rowCount } = await pool.query(
      action === 'claim'
        ? `update instances set claimed_by = $3, claimed_at = now(), idle_since = null
           where id = $1 and team_id = $2 and kind = 'box' and not personal and claimed_by is null and claimed_by_run is null`
        : `update instances set claimed_by = null, claimed_at = null, idle_since = now()
           where id = $1 and team_id = $2 and kind = 'box' and not personal and claimed_by = $3`,
      [instanceId, person.team_id, person.id])
    if (!rowCount) throw new HttpError(409, action === 'claim' ? 'that box is taken or is not a box' : 'you do not hold that box, or it is your own box, which stays yours')
    return { ok: true }
  }],

  ['people', 'POST', new RegExp(`^/v1/conversations/${UUID}/messages$`), async (req, [conversationId]) => {
    const person = await personFrom(req)
    const body = await parseBody(req, PostBody)
    return tx((client) => sendPersonMessage(client, person, conversationId, body.text ?? '', body.clientId ?? randomUUID(), {
      attachmentIds: body.attachmentIds ?? [], replyToMessageId: body.replyToMessageId ?? undefined,
    }))
  }],

  ...chatRoutes,
  ...onboardingRoutes,
  ...boxRoutes,
  ...voiceRoutes,
  ...secretRoutes,
  ...webmcpRoutes,
  ...historyRoutes,
]

const DECISIONS: Decision[] = ['allow', 'deny', 'always', 'never']
const SHAPE = /^\/v1\/shape\/([a-z_]+)$/
const APP_DIR = new URL('../app/dist/', import.meta.url)
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
}

// The app's built files. Any path that is not a file falls back to index.html.
async function serveApp(res: ServerResponse, pathname: string) {
  const file = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '') || 'index.html'
  const body = await readFile(new URL(file, APP_DIR)).catch(() => null)
  if (body) return void res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body)
  const index = await readFile(new URL('index.html', APP_DIR)).catch(() => null)
  if (!index) return void res.writeHead(404).end('the app is not built: run npm run app:build')
  res.writeHead(200, { 'content-type': TYPES['.html'] }).end(index)
}
const STREAM = new RegExp(`^/v1/streams/sessions/${UUID}$`)
const IMAGE = new RegExp(`^/v1/artifacts/${UUID}/versions/([1-9][0-9]{0,8})/image$`)

// An image document's bytes, for someone who can see its task. A version never
// changes, so the browser may keep it. The type is the one sniffed when it was
// saved, and the browser is told not to guess another.
async function serveImage(req: IncomingMessage, res: ServerResponse, artifactId: string, version: number) {
  const person = await personFrom(req)
  const artifact = await maybe<{ task_id: string }>(pool, 'select task_id from artifacts where id = $1 and team_id = $2', [artifactId, person.team_id])
  if (!artifact || !(await canSeeTask(person, artifact.task_id))) throw new HttpError(404, 'no such image')
  const row = await maybe(pool,
    `select b.media_type, b.data from artifact_versions v join blobs b on b.id = v.blob_id where v.artifact_id = $1 and v.version = $2`,
    [artifactId, version])
  if (!row) throw new HttpError(404, 'no such image')
  const image = z.object({ media_type: ImageMediaType, data: z.instanceof(Buffer) }).parse(row)
  res.writeHead(200, {
    'content-type': image.media_type, 'content-length': image.data.length, 'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'",
  }).end(image.data)
}
const PIPELINE_HOOK = new RegExp(`^/v1/hooks/pipelines/${UUID}$`)
let runner: ReturnType<typeof startRunner> | null = null
const syncNow = async (repoIds: string[]) => { await (runner ? runner.sync(repoIds) : syncPipelines(repoIds)) }

// Webhooks carry their own signatures, so they read the raw body.
async function hook(req: IncomingMessage, url: URL): Promise<unknown> {
  const body = await readBody(req)
  if (url.pathname === '/v1/hooks/forge') return forgeHook(body, req.headers, syncNow)
  const pipelineId = PIPELINE_HOOK.exec(url.pathname)?.[1]
  if (pipelineId) return pipelineHook(pipelineId, body, req.headers)
  throw new HttpError(404, 'no such hook')
}

// A page on any site can make a person's browser post a form here, and serve signs it
// as that person. A post can't carry a JSON content type across sites without a CORS
// preflight, which this API never grants, so people's changes must declare JSON.
const JSON_TYPE = /^application\/json\s*(;|$)/i
// An upload is the file's bytes under the file's own type. A custom header can't cross sites without a
// preflight either, so an upload must carry X-File-Name.
const UPLOAD = new RegExp(`^/v1/((conversations|sessions)/${UUID}/)?attachments$`)

const handle = (audience: Audience) => async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    checkAudience(audience, req)
    const recording = AUDIO_POST.test(url.pathname) && kindOf(req.headers['content-type']) !== null
    if (audience === 'people' && req.method !== 'GET' && req.method !== 'HEAD' && !recording && !JSON_TYPE.test(req.headers['content-type'] ?? '')
      && !(req.method === 'POST' && UPLOAD.test(url.pathname) && req.headers['x-file-name'] !== undefined)) {
      throw new HttpError(415, 'a change must be sent as JSON')
    }
    const shape = req.method === 'GET' ? SHAPE.exec(url.pathname)?.[1] : undefined
    if (shape) return await proxyShape(req, res, shape, url, audience)
    const stream = STREAM.exec(url.pathname)?.[1]
    if (stream) return await proxyStream(req, res, stream, url, audience)
    if (audience === 'machines' && GIT_PATH.test(url.pathname)) return await proxyGit(req, res, url)
    if (audience === 'machines' && req.method === 'POST' && url.pathname.startsWith('/v1/hooks/')) {
      const result = await hook(req, url)
      void wakeRunner()
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
    }
    if (audience === 'people' && req.method === 'GET' && !url.pathname.startsWith('/v1/')) return await serveApp(res, url.pathname)
    const image = audience === 'people' && req.method === 'GET' ? IMAGE.exec(url.pathname) : null
    if (image?.[1] && image[2]) return await serveImage(req, res, image[1], Number(image[2]))
    const route = routes.find(([who, method, path]) => who === audience && method === req.method && path.test(url.pathname))
    if (!route) throw new HttpError(404, 'no such route')
    const result = await route[3](req, paramsOf(route[2], url.pathname), url)
    if (result instanceof FileAnswer) return void res.writeHead(200, { ...result.headers, 'content-length': result.bytes.length }).end(result.bytes)
    const created = result instanceof Created
    res.writeHead(created ? 201 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(created ? result.body : result))
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    if (status === 500) console.error(error)
    const message = error instanceof HttpError ? error.message : 'internal error'
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }))
  }
}

// After a reboot or a colima restart Postgres can take a while to accept
// connections. Wait for it rather than exit, and fail on anything else.
async function migrateWhenReady(): Promise<string[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await migrate()
    } catch (error) {
      const code = (error as { code?: unknown }).code
      const starting = code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === '57P03'
      if (!starting || attempt >= 120) throw error
      if (attempt === 1) console.error(`waiting for Postgres: ${messageOf(error)}`)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
}

// How long a stopping API waits for the stream server to close before it exits anyway.
const STOP_GRACE_MS = 5000

// In userspace mode tailscaled hands a tailnet peer's connection to the same TCP
// port on 127.0.0.1, but never to a socket file. So the one listener that trusts
// Tailscale-User-Login is a socket, which only tailscale serve is pointed at.
const PeopleSocket = z.string().startsWith('/')

// The origins the app's pages are served from, such as
// http://agents-server.<tailnet>.ts.net, separated by commas. Only pages from
// these may open a screen's WebSocket, which carries a person's identity.
const PeopleOrigins = z.string().transform((text) => text.split(',').map((origin) => origin.trim()))
  // Zod runs a refinement even when z.url() has failed, so this one must not throw.
  .pipe(z.array(z.url().refine((url) => URL.canParse(url) && new URL(url).origin === url, 'an origin, such as http://host:port, with no path')).min(1))

// Where machines reach the API: the machine port, on each address in AGENTS_MACHINE_HOST.
const Listen = z.object({
  AGENTS_MACHINE_HOST: MachineHosts,
  AGENTS_API_PORT: Port.default(MACHINE_PORT),
})
const address = (host: string, at: number) => (host.includes(':') ? `[${host}]:${at}` : `${host}:${at}`)

if (import.meta.main) {
  const listen = Listen.safeParse(process.env)
  if (!listen.success) throw new Error(`the API's listen settings are wrong\n${z.prettifyError(listen.error)}`)
  const { AGENTS_MACHINE_HOST: machineHosts, AGENTS_API_PORT: machines } = listen.data
  const people = PeopleSocket.safeParse(process.env.AGENTS_PEOPLE_SOCKET)
  if (!people.success) throw new Error('AGENTS_PEOPLE_SOCKET must be the absolute path of the socket tailscale serve sends people to')
  const origins = PeopleOrigins.safeParse(process.env.AGENTS_PEOPLE_ORIGINS)
  if (!origins.success) throw new Error(`AGENTS_PEOPLE_ORIGINS must list the origins the app is served from, such as http://agents-server.<tailnet>.ts.net: ${z.prettifyError(origins.error)}`)
  checkSpeechSettings()
  const applied = await migrateWhenReady()
  if (applied.length) console.log(`applied ${applied.join(', ')}`)
  // handle() catches every error itself, so its promise never rejects.
  const serve = (audience: Audience) => (req: IncomingMessage, res: ServerResponse) => { void handle(audience)(req, res) }
  // A socket an API that stopped left behind is replaced. One a running API still serves stops this one, since taking it
  // over would send people here instead. tailscaled runs as this user, so the socket's mode 0600 lets it in.
  const peopleOrigins = new Set(origins.data)
  const screens = screenUpgrades({ audience: 'people', origins: peopleOrigins })
  // Screens and voice chat are the two WebSockets people open.
  const peopleUpgrades = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (isVoiceUpgrade(req)) void voiceUpgrade(peopleOrigins, req, socket, head)
    else screens(req, socket, head)
  }
  await listenOnSocket(createServer(serve('people')).on('upgrade', peopleUpgrades), people.data)
  console.log(`people on ${people.data}`)
  const streams = await startStreamServer()
  const stopSweep = startScreenSweep()
  const stopAttachmentSweep = startAttachmentSweep()
  let githubWorker: ReturnType<typeof startGithubWorker> | null = null
  // Closing the stream store gives back what its database holds, such as System V
  // semaphores on macOS. An API killed without closing it leaked a set every time.
  // The GitHub worker finishes the round it is in and starts no other.
  const stop = () => {
    stopSweep()
    stopAttachmentSweep()
    setTimeout(() => { console.error('the API did not stop in time'); process.exit(1) }, STOP_GRACE_MS).unref()
    Promise.all([githubWorker?.stop(), streams.stop()])
      .then(() => { process.exit(0) }, (error: unknown) => { console.error(`stopping the API: ${messageOf(error)}`); process.exit(1) })
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  // A machine's WebSocket is its control connection or one of its screen's.
  const machineScreens = screenUpgrades({ audience: 'machines' })
  const machineUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => { if (!controlUpgrade(req, socket, head)) machineScreens(req, socket, head) }
  for (const host of machineHosts) {
    createServer(serve('machines')).on('upgrade', machineUpgrade)
      .listen(machines, host, () => { console.log(`machines on ${address(host, machines)}`) })
  }
  if (process.env.AGENTS_RUNNER !== 'off') {
    runner = startRunner()
    githubWorker = startGithubWorker()
  }
}
