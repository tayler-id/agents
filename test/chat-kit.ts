// What the attachment, reaction and message-action checks share: a team with an
// admin and two members, an agent on a machine, a DM, a team room, a private
// room, a team task and a private task, an API on ports of its own, and a person's
// upload of a file.

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { must } from './must.ts'
import { asPerson, startApi, type Answer } from './onboarding-kit.ts'

export type Ports = { machines: number; people: number; streams: number }

// A 1x1 PNG, and the smallest bytes each other image type is recognised by, with the size they show.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
export const JPEG_640x480 = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9])
export const GIF_30x20 = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([30, 0, 20, 0, 0, 0, 0]), Buffer.from(';')])
export const WEBP_100x50 = Buffer.concat([
  Buffer.from('RIFF'), Buffer.from([30, 0, 0, 0]), Buffer.from('WEBPVP8X'), Buffer.from([10, 0, 0, 0, 0, 0, 0, 0, 99, 0, 0, 49, 0, 0]),
])

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export async function chatSetup(name: string, ports: Ports) {
  const id = randomBytes(4).toString('hex')
  const team = `${name}-${id}`
  const logins = { alice: `alice-${id}@local`, bob: `bob-${id}@local`, carol: `carol-${id}@local` }
  const home = realpathSync(mkdtempSync(join(tmpdir(), `agents-${name}-`)))
  const filesDir = join(home, 'attachments')
  mkdirSync(filesDir)
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows
  // The first row, which the check expects to exist.
  const q1 = async (sql: string, params: unknown[] = []) => must((await q(sql, params))[0], `a row for ${sql.slice(0, 60)}`)

  const teamId = (await q1('insert into teams (name) values ($1) returning id', [team])).id as string
  const person = async (login: string, role: 'admin' | 'member') =>
    must(await q1('insert into people (team_id, login, role) values ($1, $2, $3) returning id', [teamId, login, role]), login).id as string
  const people = { alice: await person(logins.alice, 'admin'), bob: await person(logins.bob, 'member'), carol: await person(logins.carol, 'member') }
  const token = `machine_${randomBytes(24).toString('base64url')}`
  const instanceId = must(await q1(
    `insert into instances (team_id, name, kind, token_sha256, owner_id) values ($1, 'mac', 'mac', $2, $3) returning id`,
    [teamId, sha256(token), people.alice]), 'the machine').id as string
  const agentId = must(await q1(
    `insert into agents (team_id, name, home_instance_id, visibility) values ($1, 'scout', $2, 'team') returning id`, [teamId, instanceId]), 'the agent').id as string

  const conversation = async (kind: 'dm' | 'room', visibility: 'team' | 'private', members: string[], withAgent: boolean) => {
    const row = must(await q1(
      `insert into conversations (team_id, kind, name, agent_id, visibility) values ($1, $2, $3, $4, $5) returning id`,
      [teamId, kind, kind === 'room' ? `room-${visibility}-${randomBytes(2).toString('hex')}` : null, kind === 'dm' ? agentId : null, visibility]), 'the conversation')
    for (const member of members) {
      await q('insert into conversation_members (team_id, conversation_id, person_id) values ($1, $2, $3)', [teamId, row.id, member])
    }
    if (withAgent) await q('insert into conversation_members (team_id, conversation_id, agent_id) values ($1, $2, $3)', [teamId, row.id, agentId])
    return row.id as string
  }
  const conversations = {
    dm: await conversation('dm', 'private', [people.alice], true),
    teamRoom: await conversation('room', 'team', [people.alice], true),
    privateRoom: await conversation('room', 'private', [people.alice], false),
  }

  const task = async (title: string, visibility: 'team' | 'private') => {
    const row = must(await q1(
      `insert into tasks (team_id, slug, title, owner_id, agent_id, visibility) values ($1, $2, $3, $4, $5, $6) returning id`,
      [teamId, `${title}-${randomBytes(2).toString('hex')}`, title, people.alice, agentId, visibility]), 'the task')
    const session = must(await q1(
      `insert into sessions (team_id, task_id, instance_id, agent_id, started_by, status) values ($1, $2, $3, $4, $5, 'idle') returning id`,
      [teamId, row.id, instanceId, agentId, people.alice]), 'the task session')
    return { taskId: row.id as string, sessionId: session.id as string }
  }
  const tasks = { team: await task('shared-task', 'team'), private: await task('private-task', 'private') }

  const api = await startApi(ports, {
    AGENTS_RUNNER: 'off', AGENTS_RUNNER_TEAMS: team, AGENTS_ATTACHMENTS_DIR: filesDir, AGENTS_ATTACHMENT_SWEEP_SECONDS: '1',
  }, join(home, 'streams'))
  const MACHINES = `http://127.0.0.1:${ports.machines}`
  const PEOPLE = `http://127.0.0.1:${ports.people}`
  for (let tries = 0; tries < 80; tries++) {
    if ((await fetch(`${MACHINES}/v1/health`).catch(() => null))?.ok) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  // A person's request, as tailscale serve passes it.
  const as = (login: string, method: string, path: string, body?: unknown) => asPerson(PEOPLE, login, method, path, body)

  // A file upload: the bytes as the body, under the file's own type, with its name in a header.
  const upload = async (login: string, path: string, bytes: Buffer, fileName: string, type = 'application/octet-stream'): Promise<Answer & { headers: Headers }> => {
    const res = await fetch(PEOPLE + path, {
      method: 'POST', headers: { 'tailscale-user-login': login, 'x-file-name': encodeURIComponent(fileName), 'content-type': type }, body: new Uint8Array(bytes),
    })
    const text = await res.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      // The check reads `text`.
    }
    return { status: res.status, json, text, headers: res.headers }
  }
  // A download: the status, headers and bytes.
  const download = async (login: string, path: string) => {
    const res = await fetch(PEOPLE + path, { headers: { 'tailscale-user-login': login } })
    return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) }
  }

  // Sends a person's post to a DM.
  const send = (login: string, conversationId: string, body: Record<string, unknown>) => as(login, 'POST', `/v1/conversations/${conversationId}/messages`, body)

  const stop = async () => {
    await api.stop()
    await db.end()
  }
  return { id, team, teamId, logins, people, token, instanceId, agentId, conversations, tasks, home, filesDir, db, q, q1, api, MACHINES, PEOPLE, as, upload, download, send, stop }
}
export type ChatSetup = Awaited<ReturnType<typeof chatSetup>>
