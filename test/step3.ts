// Phase 1 step 3. Live tokens. While an agent types, its tokens stream to anyone
// who can see the session, before the finished message reaches Postgres. Two
// viewers see the same tokens, the tokens add up to the finished message, and no
// secret leaks through the stream, even one split across chunks.
//   npm run check:step3

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { stream } from '@durable-streams/client'
import pg from 'pg'
import { makeScrub } from '../shared/scrub.ts'
import type { LiveDelta } from '../shared/types.ts'
import { LiveScrubber, LiveStream } from '../daemon/live.ts'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = 7792
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 100}`
const id = randomBytes(4).toString('hex')
const [team, otherTeam] = [`step3-${id}`, `step3x-${id}`]
const [login, outsider] = [`step3-${id}@local`, `outsider-${id}@local`]
const envSecret = randomBytes(18).toString('base64url')

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const aborts: AbortController[] = []
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

function node(...args: string[]) {
  return execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
}

function run(script: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] })
  children.push(child)
  return child
}

async function person(path: string, body: unknown) {
  const res = await fetch(PEOPLE + path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

async function until(label: string, seconds: number, test: () => Promise<boolean>) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${label}`)
}

// The scrubber alone: a secret split across chunks must never appear in what it releases.
function splitSecretCheck() {
  const secret = 'gbtest_' + randomBytes(12).toString('hex')
  const scrubber = new LiveScrubber(makeScrub([['AGENTS_SPLIT_SECRET', secret]]), 160)
  const full = `The deploy password is ${secret}, and here is a longer tail of ordinary words. `.repeat(3)
  const chunks: LiveDelta[] = []
  for (let i = 0; i < full.length; i += 5) chunks.push({ m: 'msg', b: 0, k: 'text', d: full.slice(i, i + 5), p: null })
  chunks.push({ m: 'msg', b: 0, k: 'text', d: '', p: null, end: true })
  const released = chunks.flatMap((chunk) => scrubber.push([chunk]))
  const text = released.map((d) => d.d).join('')
  check(!text.includes(secret.slice(0, 16)) && !text.includes(secret.slice(-16)),
    'a secret split across chunks never leaves the scrubber, in part or whole')
  check(text === makeScrub([['AGENTS_SPLIT_SECRET', secret]])(full), 'what the scrubber releases adds up to the scrubbed text')
}

try {
  splitSecretCheck()
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, login)
  node('server/admin.ts', 'add-team', otherTeam, outsider)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  const { agentId } = JSON.parse(node('server/admin.ts', 'add-agent', team, `poet-${id}`, `mac-${id}`, 'haiku'))

  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step3-')))
  mkdirSync(join(home, 'agents', agentId), { recursive: true })
  writeFileSync(join(home, 'agents', agentId, 'notes.txt'), `Deploy password: ${envSecret}\n`)

  run('server/api.ts', { AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_PORT: String(PORT + 100), AGENTS_STREAMS_PORT: '7793', AGENTS_STREAMS_DIR: join(home, 'streams') })
  await until('api', 20, async () => fetch(API).then(() => true, () => false))
  run('daemon/agentsd.ts', { AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home, AGENTS_TEST_SECRET: envSecret })
  await until('instance online', 20, async () =>
    (await db.query(`select 1 from instances where name = $1 and status = 'online'`, [`mac-${id}`])).rows.length > 0)

  const { conversationId } = await person('/v1/conversations', { kind: 'dm', agent: `poet-${id}` })
  await person(`/v1/conversations/${conversationId}/messages`, {
    text: 'Read notes.txt and quote its line exactly. Then write a sixteen-line poem about lighthouses.',
  })
  const { rows: [{ id: sessionId }] } = await db.query('select id from sessions where conversation_id = $1', [conversationId])
  const url = `${PEOPLE}/v1/streams/sessions/${sessionId}`
  const asMe = { 'tailscale-user-login': login }

  // Viewer A joins as soon as the stream exists and watches live.
  await until('stream exists', 120, async () => (await fetch(url, { method: 'HEAD', headers: asMe })).ok)
  const live: { item: LiveDelta; at: number }[] = []
  const abortA = new AbortController()
  aborts.push(abortA)
  const viewerA = await stream<LiveDelta>({ url, headers: asMe, offset: '-1', live: true, signal: abortA.signal })
  viewerA.subscribeJson(async (batch) => { for (const item of batch.items) live.push({ item, at: Date.now() }) })

  await until('turn end', 240, async () =>
    (await db.query(`select 1 from events where session_id = $1 and kind = 'usage'`, [sessionId])).rows.length > 0)
  await sleep(1500)

  // Viewer B arrives after the turn and catches up.
  const viewerB = await stream<LiveDelta>({ url, headers: asMe, offset: '-1', live: false })
  const caughtUp = await viewerB.json()
  check(live.length > 10 && JSON.stringify(live.map((l) => l.item)) === JSON.stringify(caughtUp),
    `two viewers see the same ${live.length} token chunks in the same order`)

  const { rows: texts } = await db.query(
    `select body->>'messageId' as m, body->>'text' as text, created_at from events
     where session_id = $1 and kind = 'assistant' and parent_tool_use_id is null order by seq`, [sessionId])
  const poem = must(texts.at(-1), 'poem')
  const streamed = caughtUp.filter((d) => d.m === poem.m && d.k === 'text').map((d) => d.d).join('')
  const finished = texts.filter((t) => t.m === poem.m).map((t) => t.text).join('')
  check(streamed.length > 0 && streamed === finished, "the streamed tokens add up to the agent's finished message")
  const firstToken = live.find((l) => l.item.m === poem.m)
  check(firstToken && firstToken.at < new Date(poem.created_at).getTime(),
    'tokens reached the viewer before the finished message reached Postgres')

  const streamText = caughtUp.map((d) => d.d).join('')
  check(streamText.includes('[secret:AGENTS_TEST_SECRET]') && !streamText.includes(envSecret),
    'the quoted secret reaches viewers only as [secret:AGENTS_TEST_SECRET]')

  const outsiderRead = await fetch(url, { headers: { 'tailscale-user-login': outsider } })
  await outsiderRead.body?.cancel()
  check(outsiderRead.status === 404, 'a person from another team cannot read the stream')
  const personWrite = await fetch(url, { method: 'POST', headers: { ...asMe, 'content-type': 'application/json' }, body: '[{"d":"forged"}]' })
  await personWrite.body?.cancel()
  check(personWrite.status === 403, 'a person cannot write into a live stream')

  // The session's process can be replaced, after a restart or a change to its agent.
  // Text from the new process still reaches viewers.
  const replacement = new LiveStream({ url: `${API}/v1/streams/sessions/${sessionId}`, token, name: `daemon-${sessionId}`, scrub: makeScrub(), hold: 0 })
  replacement.push([{ m: 'm-replacement', b: 0, k: 'text', d: 'from the new process', p: null, end: true }])
  await replacement.close()
  const afterReplace = await (await stream<LiveDelta>({ url, headers: asMe, offset: '-1', live: false })).json()
  check(afterReplace.some((d) => d.d === 'from the new process'), "after a session's process is replaced, its new text still reaches viewers")
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  for (const abort of aborts) abort.abort()
  for (const child of children) child.kill('SIGTERM')
  if (!failures.length) await db.query('delete from teams where name = any($1)', [[team, otherTeam]]).catch(() => {})
  await db.end().catch(() => {})
}

console.log(`\n${failures.length ? `${failures.length} failed (teams ${team}, ${otherTeam} kept)` : 'all passed (test teams removed)'}`)
process.exit(failures.length ? 1 : 0)
