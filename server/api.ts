// The server's one door. Writes go to Postgres through the record module, and
// reads go through the sync proxy to Electric. People reach it through tailscale
// serve, which proxies to a Unix socket and sets Tailscale-User-Login. Machines,
// boxes included, reach it on a loopback port with a bearer token instead.

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, lstat, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { connect, type Server } from 'node:net'
import { userInfo } from 'node:os'
import { dirname, extname, normalize } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { instanceFrom, personFrom } from './auth.ts'
import { fieldOf, optionalText, parseBody, readBody, readJson, text, type Audience, type Params, type Route } from './http.ts'
import { connectedFolders, connectFolder, disconnectFolder, sessionWriter, terminalSession } from './folders.ts'
import { ConnectFolder, DisconnectFolder, TerminalSessionAsk, type FolderList } from '../shared/terminal.ts'
import { maybe, one, pool, tx } from './db.ts'
import { migrate } from './migrate.ts'
import { messageOf } from '../shared/errors.ts'
import { canSeeSession, canSeeTask } from './access.ts'
import {
  answerAsk, appendEvents, claimCommand, HttpError, interruptSession, openDm, saveDocuments, scrub, sendPersonMessage, type Decision,
} from './record.ts'
import { proxyStream, startStreamServer } from './streams.ts'
import { MessageMoveRefused, moveMessages, recoverMachine } from './durability.ts'
import { agentProfile, pipelineHistory, readSession, recentActivity, searchRecord } from './teamrecord.ts'
import { proxyShape } from './sync.ts'
import { GIT_PATH, proxyGit } from './git.ts'
import { forgeHook, pipelineHook } from './hooks.ts'
import { forge, repoPath } from './forge.ts'
import { answerRunAsk, cancelRun, startRun, startRunner, wakeRunner } from './runner.ts'
import { syncPipelines } from './pipelines.ts'
import { createAgent, removeItem, savePlugin, saveRoutine, saveSkill, saveTemplate, updateAgent, writeMemory } from './agents.ts'
import { createRoom } from './rooms.ts'
import { addComment, messageTaskSession, resolveComment, startTask } from './tasks.ts'
import { discardDraft, editDraft, startDraft } from './drafts.ts'
import { saveChanges } from './changes.ts'
import { askForPullRequests } from './pulls.ts'
import { versionDiff } from './versions.ts'
import { ArtifactId, SessionId, TaskId, WorkspaceId } from '../shared/ids.ts'
import { BlockAsk, ChangesPost, HoldAsk, NewComment, NewTask, PriorityAsk, PullRequestAsk, TaskAction, DraftEdit, type WorkspaceSetup } from '../shared/work.ts'
import { block, hold, markDone, prioritize, readyAnswer, reopen, unblock, unhold } from './order.ts'
import { sendRoutine } from './routines.ts'
import { onboardingRoutes } from './onboarding-routes.ts'
import { boxRoutes } from './box-routes.ts'
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

// An agent reads the record from inside one of its sessions, which must be
// running on the calling machine. That session decides what it may see.
async function agentScope(req: IncomingMessage, url: URL) {
  const instance = await instanceFrom(req)
  const sessionId = url.searchParams.get('session') ?? ''
  const { rows } = /^[0-9a-f-]{36}$/.test(sessionId)
    ? await pool.query('select 1 from sessions where id = $1 and instance_id = $2', [sessionId, instance.id])
    : { rows: [] }
  if (!rows[0]) throw new HttpError(403, 'record reads need a session running on this machine')
  return { teamId: instance.team_id, sessionId }
}

const bounded = (value: string | null, fallback: number, max: number) =>
  Math.min(max, Math.max(1, Number(value) || fallback))
const UUID = '([0-9a-f-]{36})'

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

  ['machines', 'POST', /^\/v1\/instance\/heartbeat$/, async (req) => {
    const instance = await instanceFrom(req)
    const body = await readJson(req)
    const status = body.status === 'offline' ? 'offline' : 'online'
    await pool.query('update instances set status = $2, last_seen_at = now() where id = $1', [instance.id, status])
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

  // Files an agent wrote in its task's folder become document versions.
  ['machines', 'POST', new RegExp(`^/v1/sessions/${UUID}/documents$`), async (req, [sessionId]) => {
    const instance = await instanceFrom(req)
    const body = await readJson(req)
    if (!Array.isArray(body.documents)) throw new HttpError(400, 'documents must be a list')
    const documents = body.documents.map((d: unknown, i) => {
      const content = fieldOf(d, 'content')
      return { path: text(fieldOf(d, 'path'), `documents.${i}.path`), content: typeof content === 'string' ? content : '' }
    })
    return { versions: await tx((client) => saveDocuments(client, instance.id, sessionId, documents)) }
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

  // The folders on this Mac whose terminal sessions land in the record. Only the
  // Mac itself connects or disconnects one, so nobody in the app can.
  ['machines', 'GET', /^\/v1\/instance\/folders$/, async (req) => {
    const answer: FolderList = { folders: await connectedFolders(await instanceFrom(req)) }
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
    // A terminal session's prompts are its person's own.
    const seqs = await tx((client) => appendEvents(client, sessionId, batch, writer.kind === 'terminal' ? writer.author : null))
    // A finished turn may be what a pipeline run is waiting on.
    if (batch.events.some((e) => e.kind === 'usage')) void wakeRunner()
    return { seqs }
  }],

  ['people', 'POST', /^\/v1\/conversations$/, async (req) => {
    const person = await personFrom(req)
    const body = await readJson(req)
    if (body.kind === 'room') {
      const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
      return { conversationId: await tx((client) => createRoom(client, person, text(body.name, 'name'), list(body.people), list(body.agents))) }
    }
    if (body.kind !== 'dm') throw new HttpError(400, 'kind must be dm or room')
    const agent = text(body.agent, 'agent')
    return { conversationId: await tx((client) => openDm(client, person, agent)) }
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

  ['people', 'POST', new RegExp(`^/v1/agents/${UUID}/templates$`), async (req, [agentId]) => {
    const person = await personFrom(req)
    const body = await readJson(req)
    return tx((client) => saveTemplate(client, person, agentId, text(body.name, 'name')))
  }],

  // Runs a routine now, as if it had come due.
  ['people', 'POST', new RegExp(`^/v1/routines/${UUID}/run$`), async (req, [routineId]) => {
    const person = await personFrom(req)
    const routine = await maybe(pool,
      'select 1 from routines r join agents a on a.id = r.agent_id where r.id = $1 and a.team_id = $2', [routineId, person.team_id])
    if (!routine) throw new HttpError(404, 'no such routine')
    return { conversationId: await tx((client) => sendRoutine(client, routineId)) }
  }],

  ['people', 'POST', /^\/v1\/tasks$/, async (req) => {
    const person = await personFrom(req)
    const { repoId, ...task } = parsed(NewTask, await readJson(req))
    return tx((client) => startTask(client, person, { ...task, repoIds: repoId ? [repoId, ...task.repoIds] : task.repoIds }))
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

  ['people', 'POST', new RegExp(`^/v1/sessions/${UUID}/messages$`), async (req, [sessionId]) => {
    const person = await personFrom(req)
    const body = await readJson(req)
    await tx((client) => messageTaskSession(client, person, sessionId, text(body.text, 'text')))
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

  ['people', 'POST', new RegExp(`^/v1/pipelines/${UUID}/runs$`), async (req, [pipelineId]) => {
    const person = await personFrom(req)
    const body = await readJson(req)
    const repo = await maybe<{ remote_url: string }>(pool,
      'select remote_url from repos where id = $1 and team_id = $2', [text(body.repoId, 'repoId'), person.team_id])
    if (!repo) throw new HttpError(404, 'no such repo')
    const pipeline = await maybe(pool, 'select 1 from pipelines where id = $1 and team_id = $2', [pipelineId, person.team_id])
    if (!pipeline) throw new HttpError(404, 'no such pipeline')
    const openIssues = (await forge.openIssues(repoPath(repo.remote_url)).catch(() => [])).map((i) => ({ number: i.number, title: i.title }))
    const runId = await tx((client) => startRun(client, {
      pipelineId, trigger: 'manual', repoId: body.repoId as string, openIssues, startedBy: person.id,
      report: { title: text(body.title, 'title'), body: typeof body.body === 'string' ? body.body : '', author: person.login },
    }))
    void wakeRunner()
    return { runId }
  }],

  ['people', 'POST', new RegExp(`^/v1/runs/${UUID}/cancel$`), async (req, [runId]) => {
    const person = await personFrom(req)
    const run = await maybe<{ task_id: string }>(pool, 'select task_id from runs where id = $1 and team_id = $2', [runId, person.team_id])
    if (!run || !(await canSeeTask(person, run.task_id))) throw new HttpError(404, 'no such run')
    await tx((client) => cancelRun(client, runId, person))
    return { ok: true }
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
    const body = await readJson(req)
    const clientId = optionalText(body.clientId, 'clientId') ?? randomUUID()
    return tx((client) => sendPersonMessage(client, person, conversationId, text(body.text, 'text'), clientId))
  }],

  ...onboardingRoutes,
  ...boxRoutes,
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

const handle = (audience: Audience) => async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    if (audience === 'machines' && req.headers['tailscale-user-login']) {
      throw new HttpError(400, 'people connect through Tailscale, not the machine port')
    }
    if (audience === 'people' && req.method !== 'GET' && req.method !== 'HEAD' && !JSON_TYPE.test(req.headers['content-type'] ?? '')) {
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
    const route = routes.find(([who, method, path]) => who === audience && method === req.method && path.test(url.pathname))
    if (!route) throw new HttpError(404, 'no such route')
    const result = await route[3](req, paramsOf(route[2], url.pathname), url)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
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

const hasCode = (error: unknown, code: string) => error instanceof Error && 'code' in error && error.code === code

// Whether something accepts connections on the socket at this path.
function accepts(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = connect(path)
    probe.once('connect', () => { probe.destroy(); resolve(true) })
    probe.once('error', (error) => { if (hasCode(error, 'ECONNREFUSED')) resolve(false); else reject(error) })
  })
}

// An API that stops without closing its socket leaves the file behind, and it
// refuses connections. A socket that accepts them belongs to a running API, and
// taking it over would send people to this one instead, so that stops this one.
async function listenForPeople(server: Server, path: string) {
  // On a new server the folder may not exist yet. Made here, only its owner can open it.
  const folder = dirname(path)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  // Another user who could write to the folder could put their own socket in its place.
  const owner = await stat(folder)
  if (owner.uid !== userInfo().uid || (owner.mode & 0o022) !== 0) {
    throw new Error(`${folder} must belong to this user and be writable by no one else, since the people socket lives in it`)
  }
  const existing = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return null
    throw error
  })
  if (existing && !existing.isSocket()) throw new Error(`${path} is not a socket, so the API will not replace it`)
  if (existing && await accepts(path)) throw new Error(`another API already serves people on ${path}`)
  if (existing) await rm(path)
  // The socket file appears when listen binds, which it does before returning, so
  // the umask keeps it private from its first moment. tailscaled runs as this user.
  const umask = process.umask(0o077)
  try {
    server.listen(path)
  } finally {
    process.umask(umask)
  }
  await once(server, 'listening')
  await chmod(path, 0o600)
}

if (import.meta.main) {
  const people = PeopleSocket.safeParse(process.env.AGENTS_PEOPLE_SOCKET)
  if (!people.success) throw new Error('AGENTS_PEOPLE_SOCKET must be the absolute path of the socket tailscale serve sends people to')
  const applied = await migrateWhenReady()
  if (applied.length) console.log(`applied ${applied.join(', ')}`)
  // handle() catches every error itself, so its promise never rejects.
  const serve = (audience: Audience) => (req: IncomingMessage, res: ServerResponse) => { void handle(audience)(req, res) }
  await listenForPeople(createServer(serve('people')), people.data)
  console.log(`people on ${people.data}`)
  const streams = await startStreamServer()
  // Closing the stream store gives back what its database holds, such as System V
  // semaphores on macOS. An API killed without closing it leaked a set every time.
  const stop = () => {
    setTimeout(() => { console.error('the stream server did not stop in time'); process.exit(1) }, STOP_GRACE_MS).unref()
    streams.stop().then(() => { process.exit(0) }, (error: unknown) => { console.error(`stopping the stream server: ${messageOf(error)}`); process.exit(1) })
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const machines = Number(process.env.AGENTS_API_PORT ?? 7700)
  createServer(serve('machines')).listen(machines, '127.0.0.1', () => { console.log(`machines on 127.0.0.1:${machines}`) })
  if (process.env.AGENTS_RUNNER !== 'off') runner = startRunner()
}
