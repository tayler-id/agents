// How the app reads and writes. Reads are live shapes through the server's
// proxy; writes are plain calls to the API. Who you are comes from the
// connection (Tailscale), so no request carries an identity of its own.

import { useEffect, useMemo, useState } from 'react'
import { Shape, ShapeStream, type Row } from '@electric-sql/client'
import { z } from 'zod'
import { Done, InviteLink, InviteMade, InviteResent, MeView, PersonAdded, type MemberView, type TeamRole } from '../../shared/onboarding.ts'

export type Me = MemberView

export type Person = Row & { id: string; login: string; name: string | null; role: TeamRole }
export type Agent = Row & {
  id: string; name: string; title: string | null; role: string | null; model: string | null; home_instance_id: string | null; instructions: string
}
export type Instance = Row & {
  id: string; name: string; kind: string; status: 'online' | 'stale' | 'offline'; last_seen_at: string | null
  claimed_by: string | null; claimed_by_run: string | null
  // A person's own box belongs to its owner for good. start_error says why its container did not start.
  owner_id: string | null; personal: boolean; start_error: string | null
}
export type Conversation = Row & { id: string; kind: string; name: string | null; agent_id: string | null; visibility: string; source: string | null; created_at: string }
export type Member = Row & { conversation_id: string; person_id: string | null; agent_id: string | null }
export type Message = Row & {
  id: string; conversation_id: string; seq: bigint; speaker: 'person' | 'agent'; person_id: string | null
  agent_id: string | null; body: string; session_id: string | null; task_id: string | null; client_id: string; created_at: string
}
export type Session = Row & {
  id: string; conversation_id: string | null; task_id: string | null; instance_id: string; agent_id: string; stage: string | null
  status: string; model: string | null; turns: number; harness_session_id: string | null; created_at: string; last_active_at: string | null
}
export type EventRow = Row & {
  id: bigint; session_id: string; seq: bigint; kind: string; text: string | null; tool_name: string | null
  parent_tool_use_id: string | null; body: Record<string, unknown>; created_at: string
}
export type Ask = Row & {
  id: string; session_id: string | null; run_id: string | null; conversation_id: string | null; kind: string; status: string
  payload: {
    toolName?: string; input?: Record<string, unknown>; description?: string
    // A pipeline's gate or hand-off.
    question?: string; options?: string[]; stage?: string; links?: { title: string; url: string }[]
  }
  created_at: string
}
export type Repo = Row & { id: string; remote_url: string; default_branch: string }
export type Pipeline = Row & {
  id: string; name: string; description: string; path: string; current_version_id: string | null
  conversation_id: string | null; shepherd_id: string | null
}
export type PipelineVersion = Row & { id: string; pipeline_id: string; git_sha: string; source: string; error: string | null; created_at: string }
export type Task = Row & { id: string; slug: string; title: string; instructions: string; agent_id: string | null; conversation_id: string | null; source: string | null; created_at: string }
export type Run = Row & {
  id: string; pipeline_version_id: string; task_id: string; trigger: string; status: string; stage: string | null
  note: string | null; cost_usd: string | null; created_at: string; started_at: string | null; ended_at: string | null
  metrics: { durationSec?: number; costUsd?: number; stagesRun?: number; handoffs?: number; attempts?: Record<string, number> }
  trigger_payload: { report?: { title: string; body: string; issue?: number; url?: string; author?: string } }
  replay_of: string | null; proposal_id: string | null
}
export type RunStage = Row & {
  id: string; run_id: string; n: number; stage: string; attempt: number; kind: string; status: string
  session_id: string | null; outcome: string | null; summary: string | null; data: Record<string, unknown>
  started_at: string | null; ended_at: string | null; created_at: string
}
export type Artifact = Row & {
  id: string; task_id: string; kind: 'document' | 'link'; path: string | null; title: string; url: string | null
  state: string | null; current_version: number | null; made_by_session: string | null; updated_at: string
}
export type Score = { replays: number; finished: number; problems: number; stagesRun: number; costUsd: number; durationSec: number }
export type Proposal = Row & {
  id: string; target: 'pipeline' | 'instructions' | 'skill'; pipeline_id: string | null; agent_id: string | null; skill_name: string | null
  base_version_id: string | null; candidate_version_id: string | null; run_id: string | null; diff: string; summary: string
  scores: { candidate?: Score; current?: Score } | Record<string, never>; status: string; pull_request: string | null
  decided_by: string | null; decided_at: string | null; created_at: string
}
export type Skill = Row & { id: string; agent_id: string | null; name: string; description: string; content: string; updated_at: string }
export type Plugin = Row & { id: string; agent_id: string; name: string; kind: 'stdio' | 'http'; config: { command?: string; args?: string[]; env?: Record<string, { secret: string }>; url?: string; headers?: Record<string, { secret: string }> } }
export type Routine = Row & { id: string; agent_id: string; name: string; prompt: string; trigger: string; trigger_config: { schedule?: string }; enabled: boolean; last_fired_at: string | null }
export type Memory = Row & { id: string; agent_id: string; scope: 'person' | 'team'; person_id: string | null; kind: 'profile' | 'log'; log_date: string | null; content: string; updated_at: string }
export type Template = Row & { id: string; name: string; version: number; share_slug: string; recipe: { title: string | null; instructions: string; skills: unknown[]; plugins: unknown[]; routines: unknown[] }; created_at: string }
export type Turn = Row & { id: string; conversation_id: string; agent_id: string; requested_at: string; started_at: string | null; outcome: string | null; finished_at: string | null }
export type Comment = Row & { id: string; artifact_id: string; version: number; anchor: { quote?: string } | null; author_person: string | null; body: string; status: string; sent_to_session: string | null; created_at: string }
export type ArtifactVersion = Row & { artifact_id: string; version: number; content: string; author_session: string | null; created_at: string }

const origin = () => window.location.origin

// A random id. crypto.randomUUID only exists on HTTPS and localhost, and the app
// is often reached over plain HTTP inside the tailnet.
export function newId(): string {
  const b = [...crypto.getRandomValues(new Uint8Array(16))]
  // Version 4 and the variant bits, as in RFC 9562.
  const hex = b.map((x, i) => (i === 6 ? (x & 0x0f) | 0x40 : i === 8 ? (x & 0x3f) | 0x80 : x).toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const shapeUrl = (name: string, args: Record<string, string>) => {
  const query = new URLSearchParams(args).toString()
  return `${origin()}/v1/shape/${name}${query ? `?${query}` : ''}`
}

// Browsers keep at most six HTTP/1.1 connections to one server, and every live
// shape holds one open. So only what must update at once is live: the open
// conversation's messages, session status, open asks, the open run's stages, the
// working session's events, plus its token stream. Lists that change rarely use
// useSnapshot. Views that show the same shape share one stream, and the stream
// closes soon after the last of them goes, so a view you left holds no connection.
type Live = { shape: Shape<Row>; abort: AbortController; views: number; closing?: ReturnType<typeof setTimeout> }
const live = new Map<string, Live>()

function openLive(url: string): Live {
  const found = live.get(url)
  if (found) {
    clearTimeout(found.closing)
    found.views++
    return found
  }
  const abort = new AbortController()
  const entry: Live = { shape: new Shape(new ShapeStream<Row>({ url, signal: abort.signal })), abort, views: 1 }
  live.set(url, entry)
  return entry
}

function closeLive(url: string) {
  const entry = live.get(url)
  if (!entry || --entry.views > 0) return
  // A view that unmounts and mounts again straight away keeps its stream.
  entry.closing = setTimeout(() => {
    if (entry.views > 0) return
    entry.abort.abort()
    live.delete(url)
  }, 1500)
}

export function useRows<T extends Row>(name: string, args: Record<string, string> = {}) {
  const url = shapeUrl(name, args)
  const [state, setState] = useState<{ url: string; rows: T[]; loading: boolean }>({ url, rows: [], loading: true })
  useEffect(() => {
    const entry = openLive(url)
    const show = () => setState({ url, rows: entry.shape.currentRows as T[], loading: entry.shape.isLoading() })
    show()
    const unsubscribe = entry.shape.subscribe(show)
    return () => {
      unsubscribe()
      closeLive(url)
    }
  }, [url])
  return { rows: state.url === url ? state.rows : [], loading: state.url !== url || state.loading }
}

// A shape read once and read again every few seconds, holding no connection open.
// Null args mean there is nothing to read yet.
export function useSnapshot<T extends Row>(name: string, args: Record<string, string> | null = {}, everyMs = 5000) {
  const url = args ? shapeUrl(name, args) : null
  // Rows are kept with the URL they came from, so a view never shows another shape's rows.
  const [state, setState] = useState<{ url: string | null; rows: T[] }>({ url, rows: [] })
  useEffect(() => {
    if (!url) return
    let stopped = false
    const load = async () => {
      const shape = new Shape(new ShapeStream<T>({ url, subscribe: false }))
      const next = await shape.rows.catch(() => null)
      if (!stopped && next) setState({ url, rows: next })
    }
    void load()
    const timer = setInterval(load, everyMs)
    return () => { stopped = true; clearInterval(timer) }
  }, [url, everyMs])
  return { rows: url && state.url === url ? state.rows : [] }
}

// A snapshot whose rows are read through their schema. Rows that do not fit
// are not shown, and `error` says why.
export function useSnapshotOf<S extends z.ZodType>(schema: S, name: string, args: Record<string, string> | null = {}, everyMs = 5000) {
  const { rows } = useSnapshot<Row>(name, args, everyMs)
  return useMemo(() => {
    const parsed = z.array(schema).safeParse(rows)
    return parsed.success
      ? { rows: parsed.data, error: null }
      : { rows: [], error: `The ${name} the server sent did not fit this page: ${z.prettifyError(parsed.error)}` }
  }, [schema, rows, name])
}

// The message of anything thrown.
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// Runs an async action from a click or a form. If it fails, the app's alert
// banner says why: an error is never lost in a promise nobody waits for.
export function act<A extends unknown[]>(action: (...args: A) => Promise<unknown>): (...args: A) => void {
  return (...args) => {
    action(...args).catch((error: unknown) => {
      window.dispatchEvent(new CustomEvent('app-error', { detail: messageOf(error) }))
    })
  }
}

async function send(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method,
    // The API refuses a person's change that isn't declared JSON, so every change says so.
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = typeof json === 'object' && json !== null && 'error' in json && typeof json.error === 'string' ? json.error : null
    throw new Error(error ?? `request failed with ${res.status}`)
  }
  return json
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // The API's answers are this repo's own types.
  return await send(method, path, body) as T
}

// A call whose answer is read through its schema.
async function call<S extends z.ZodType>(schema: S, method: string, path: string, body?: unknown): Promise<z.output<S>> {
  const parsed = schema.safeParse(await send(method, path, body))
  if (!parsed.success) throw new Error(`The server's answer to ${path} did not fit this app: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

export const api = {
  me: () => call(MeView, 'GET', '/v1/me'),
  invite: (email: string, role: TeamRole) => call(InviteMade, 'POST', '/v1/invites', { email, role }),
  resendInvite: (inviteId: string) => call(InviteResent, 'POST', `/v1/invites/${inviteId}/resend`, {}),
  cancelInvite: (inviteId: string) => call(Done, 'POST', `/v1/invites/${inviteId}/cancel`, {}),
  inviteLink: (inviteId: string) => call(InviteLink, 'GET', `/v1/invites/${inviteId}/link`),
  addToTeam: (login: string, name: string | null) => call(PersonAdded, 'POST', '/v1/team/people', { login, name }),
  openDm: (agent: string) => request<{ conversationId: string }>('POST', '/v1/conversations', { kind: 'dm', agent }),
  send: (conversationId: string, text: string, clientId: string) =>
    request('POST', `/v1/conversations/${conversationId}/messages`, { text, clientId }),
  answer: (askId: string, decision: string, message?: string) =>
    request('POST', `/v1/asks/${askId}/answer`, { decision, message }),
  interrupt: (sessionId: string) => request('POST', `/v1/sessions/${sessionId}/interrupt`, {}),
  startRun: (pipelineId: string, title: string, body: string, repoId: string) =>
    request<{ runId: string }>('POST', `/v1/pipelines/${pipelineId}/runs`, { title, body, repoId }),
  cancelRun: (runId: string) => request('POST', `/v1/runs/${runId}/cancel`, {}),
  claimBox: (instanceId: string) => request('POST', `/v1/instances/${instanceId}/claim`, {}),
  createAgent: (body: Record<string, unknown>) => request<{ agentId: string }>('POST', '/v1/agents', body),
  updateAgent: (agentId: string, body: Record<string, unknown>) => request('POST', `/v1/agents/${agentId}`, body),
  saveItem: (agentId: string, kind: 'skills' | 'plugins' | 'routines', body: Record<string, unknown>) =>
    request('POST', `/v1/agents/${agentId}/${kind}`, body),
  removeItem: (agentId: string, kind: 'skills' | 'plugins' | 'routines', name: string) =>
    request('POST', `/v1/agents/${agentId}/${kind}/${encodeURIComponent(name)}/delete`, {}),
  saveTemplate: (agentId: string, name: string) => request<{ slug: string; version: number }>('POST', `/v1/agents/${agentId}/templates`, { name }),
  createRoom: (name: string, people: string[], agents: string[]) =>
    request<{ conversationId: string }>('POST', '/v1/conversations', { kind: 'room', name, people, agents }),
  startTask: (body: { title: string; instructions: string; agentId: string; repoId?: string; conversationId?: string; messageId?: string }) =>
    request<{ taskId: string; sessionId: string }>('POST', '/v1/tasks', body),
  messageSession: (sessionId: string, text: string) => request('POST', `/v1/sessions/${sessionId}/messages`, { text }),
  addComment: (artifactId: string, body: { version: number; text: string; quote?: string; send: boolean }) =>
    request<{ commentId: string }>('POST', `/v1/artifacts/${artifactId}/comments`, body),
  resolveComment: (commentId: string) => request('POST', `/v1/comments/${commentId}/resolve`, {}),
  runRoutine: (routineId: string) => request<{ conversationId: string }>('POST', `/v1/routines/${routineId}/run`, {}),
  releaseBox: (instanceId: string) => request('POST', `/v1/instances/${instanceId}/release`, {}),
}

// How long something took, in words a person scans.
export function duration(seconds: number | undefined | null): string {
  if (seconds === undefined || seconds === null) return ''
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

export const money = (usd: number | string | null | undefined) => (usd === null || usd === undefined ? '' : `$${Number(usd).toFixed(2)}`)

// The repo's name, from its clone URL.
export const repoName = (remoteUrl: string) => remoteUrl.replace(/\.git$/, '').split('/').slice(-2).join('/')

export const byNumber = <T,>(pick: (row: T) => bigint | number | string) => (a: T, b: T) => Number(pick(a)) - Number(pick(b))

// Postgres sends times like 2026-10-12 00:05:12.123+00. Browsers only parse the
// offset written in full, as +00:00, so it is filled in before parsing.
export function parseTime(text: string | null): Date | null {
  if (!text) return null
  const date = new Date(text.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'))
  return Number.isNaN(date.getTime()) ? null : date
}

export function clock(text: string | null): string {
  return parseTime(text)?.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) ?? ''
}
