// Phase 1 step 4, backend. Asks and interrupt, with a real Claude session. A gated
// tool waits for a person: allow runs it, deny blocks it, always makes a rule
// that answers the next one by itself. An interrupt stops a long answer mid-way.
// Only people who can see the session may answer or interrupt.
//   npm run check:step4a

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { must } from './must.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = 7795
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 100}`
const id = randomBytes(4).toString('hex')
const [team, otherTeam] = [`step4a-${id}`, `step4ax-${id}`]
const [login, outsider] = [`step4a-${id}@local`, `outsider4a-${id}@local`]

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

function node(...args: string[]) {
  return execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
}

async function call(path: string, who: string, body: unknown = {}) {
  return fetch(PEOPLE + path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': who }, body: JSON.stringify(body),
  })
}

async function post(path: string, body: unknown) {
  const res = await call(path, login, body)
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

// Waits for a condition and reports whether it came true, so a check can fail on its own line.
async function within(seconds: number, test: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(300)
  }
  return false
}

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0] as T | undefined

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, login)
  node('server/admin.ts', 'add-team', otherTeam, outsider)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  const { agentId } = JSON.parse(node('server/admin.ts', 'add-agent', team, `doer-${id}`, `mac-${id}`, 'haiku',
    'When asked to run a command, run exactly that command with the Bash tool, once, and nothing else.'))
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step4a-')))
  const folder = join(home, 'agents', agentId)
  mkdirSync(folder, { recursive: true })

  const env = { ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(home, 'people.sock'), AGENTS_STREAMS_PORT: '7796', AGENTS_STREAMS_DIR: join(home, 'streams') }
  children.push(spawn(process.execPath, ['server/api.ts'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] }))
  await servePeople(PORT + 100, join(home, 'people.sock'))
  await within(20, async () => fetch(API).then(() => true, () => false))
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home }, stdio: ['ignore', 'ignore', 'inherit'],
  }))

  const { conversationId } = await post('/v1/conversations', { kind: 'dm', agent: `doer-${id}` })
  const send = (text: string) => post(`/v1/conversations/${conversationId}/messages`, { text })
  const turns = async () => Number((await one<{ n: string }>(
    `select count(*) as n from events e join sessions s on s.id = e.session_id
     where s.conversation_id = $1 and e.kind = 'usage'`, [conversationId]))?.n ?? 0)
  const openAsk = () => one<{ id: string; session_id: string; payload: { toolName: string; input: { command: string } } }>(
    `select a.id, a.session_id, a.payload from asks a join sessions s on s.id = a.session_id
     where s.conversation_id = $1 and a.status = 'open' order by a.created_at desc limit 1`, [conversationId])

  // Allow.
  await send('Run: echo approved > first.txt')
  let ask = (await within(120, async () => Boolean(await openAsk()))) ? await openAsk() : undefined
  const session = ask && await one<{ status: string }>('select status from sessions where id = $1', [ask.session_id])
  check(ask?.payload.toolName === 'Bash' && ask.payload.input.command.includes('first.txt') && session?.status === 'needs_approval'
    && !existsSync(join(folder, 'first.txt')),
  'a gated command waits as an open ask, the session shows needs_approval, and nothing has run yet')

  const strangerAnswer = await call(`/v1/asks/${ask?.id}/answer`, outsider, { decision: 'allow' })
  await strangerAnswer.body?.cancel()
  check(strangerAnswer.status === 404, 'a person from another team cannot answer it')

  await post(`/v1/asks/${ask?.id}/answer`, { decision: 'allow' })
  check(await within(120, async () => (await turns()) >= 1) && existsSync(join(folder, 'first.txt')),
    'allow runs the command, and the turn finishes')
  const answered = await one<{ status: string; answered_by: string | null; author: string | null }>(
    `select a.status, a.answered_by, e.author from asks a
     join events e on e.session_id = a.session_id and e.kind = 'answer' and e.body->>'askId' = a.id::text
     where a.id = $1`, [ask?.id])
  check(answered?.status === 'answered' && answered.answered_by && answered.author === answered.answered_by,
    'the answer is recorded on the ask and in the session, under the person who gave it')

  // Deny.
  await send('Run: echo denied > second.txt')
  ask = (await within(120, async () => Boolean(await openAsk()))) ? await openAsk() : undefined
  await post(`/v1/asks/${ask?.id}/answer`, { decision: 'deny' })
  check(await within(120, async () => (await turns()) >= 2) && !existsSync(join(folder, 'second.txt')),
    'deny blocks the command, and the turn still finishes')

  // Always, then a rule answers the next one with nobody involved.
  await send('Run: echo always > third.txt')
  ask = (await within(120, async () => Boolean(await openAsk()))) ? await openAsk() : undefined
  await post(`/v1/asks/${ask?.id}/answer`, { decision: 'always' })
  const rule = await one<{ pattern: string; decision: string }>(
    `select pattern, decision from approval_rules where agent_id = $1`, [agentId])
  check(rule?.pattern === 'echo ' && rule.decision === 'allow' && await within(120, async () => (await turns()) >= 3)
    && existsSync(join(folder, 'third.txt')),
  'always runs it and leaves a rule for commands that start with echo')

  await send('Run: echo again > fourth.txt')
  const ranAlone = await within(120, async () => (await turns()) >= 4)
  const ruled = await one<{ n: string }>(
    `select count(*) as n from asks a join sessions s on s.id = a.session_id
     where s.conversation_id = $1 and a.answered_by is null and a.answer->>'message' = 'answered by a standing rule'`, [conversationId])
  check(ranAlone && existsSync(join(folder, 'fourth.txt')) && Number(ruled?.n) === 1,
    'the next echo runs without anyone answering, settled by the rule')

  // Interrupt a long answer.
  await send('Write a 2000-word story about a lighthouse keeper. Do not use any tools.')
  const sessionId = must(await one<{ id: string }>('select id from sessions where conversation_id = $1', [conversationId]), 'sessionId').id
  const typing = await within(120, async () => (await fetch(`${PEOPLE}/v1/streams/sessions/${sessionId}`, {
    method: 'HEAD', headers: { 'tailscale-user-login': login },
  })).ok && (await one<{ status: string }>('select status from sessions where id = $1', [sessionId]))?.status === 'running')
  await sleep(3000)
  const strangerStop = await call(`/v1/sessions/${sessionId}/interrupt`, outsider)
  await strangerStop.body?.cancel()
  check(strangerStop.status === 404, 'a person from another team cannot interrupt it')
  const stoppedAt = Date.now()
  await post(`/v1/sessions/${sessionId}/interrupt`, {})
  const ended = await within(60, async () => (await turns()) >= 5)
  const last = await one<{ body: { terminal_reason?: string } }>(
    `select body from events where session_id = $1 and kind = 'usage' order by seq desc limit 1`, [sessionId])
  check(typing && ended && Date.now() - stoppedAt < 30_000 && last?.body.terminal_reason === 'aborted_streaming',
    'an interrupt stops a long answer within seconds')
  check(await within(10, async () => (await one<{ status: string }>('select status from sessions where id = $1', [sessionId]))?.status === 'idle'),
    'after the interrupt the session is idle, ready for the next message')
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) await db.query('delete from teams where name = any($1)', [[team, otherTeam]]).catch(() => {})
  await db.end().catch(() => {})
}

console.log(`\n${failures.length ? `${failures.length} failed (teams ${team}, ${otherTeam} kept)` : 'all passed (test teams removed)'}`)
process.exit(failures.length ? 1 : 0)
