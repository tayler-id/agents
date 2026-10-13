// Phase 1 step 5, and part 1 of the success test: a teammate's agent finds my
// fix on its own. Alice's agent fixes a bug on machine A. Later Amir's agent, on
// machine B, gets the same bug without being told about Alice's work. It must
// search the team record first, find Alice's session, and fix its own copy.
// Private work stays out of the search.
//   npm run check:step5

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = 7807
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 100}`
const MODEL = process.env.AGENTS_STEP5_MODEL ?? 'haiku'
const id = randomBytes(4).toString('hex')
const [team, otherTeam] = [`step5-${id}`, `step5x-${id}`]
const [alice, amir, outsider] = [`alice5-${id}@local`, `amir5-${id}@local`, `out5-${id}@local`]
const CHECKOUT = `// Ships orders. Run: node checkout.js CA
const SHIPPABLE = ['US']
const country = process.argv[2] ?? 'US'
if (!SHIPPABLE.includes(country)) {
  console.error('ERR_FLAMINGO_42: cannot ship to ' + country)
  process.exit(1)
}
console.log('shipping to ' + country)
`

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

async function within(seconds: number, test: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(500)
  }
  return false
}

async function as(login: string, path: string, body: unknown) {
  const res = await fetch(PEOPLE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

// Sends a message and waits for the turn it starts to end. Returns the session id.
async function ask(login: string, agent: string, text: string): Promise<string> {
  const { conversationId } = await as(login, '/v1/conversations', { kind: 'dm', agent })
  const turns = async () => Number((await db.query(
    `select count(*) from events e join sessions s on s.id = e.session_id where s.conversation_id = $1 and e.kind = 'usage'`,
    [conversationId])).rows[0].count)
  const before = await turns()
  await as(login, `/v1/conversations/${conversationId}/messages`, { text })
  if (!(await within(240, async () => (await turns()) > before))) throw new Error(`${agent} did not finish its turn`)
  return (await db.query('select id from sessions where conversation_id = $1', [conversationId])).rows[0].id
}

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, alice)
  node('server/admin.ts', 'add-person', team, amir)
  node('server/admin.ts', 'add-team', otherTeam, outsider)
  const setUp = (machine: string, owner: string, agent: string) => {
    const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${machine}-${id}`, 'mac', owner)) as { token: string }
    const { agentId } = JSON.parse(node('server/admin.ts', 'add-agent', team, agent, `mac-${machine}-${id}`, MODEL,
      'You maintain a small shipping script. Keep replies short.')) as { agentId: string }
    const home = realpathSync(mkdtempSync(join(tmpdir(), `agents-step5${machine}-`)))
    const folder = join(home, 'agents', agentId)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'checkout.js'), CHECKOUT)
    return { token, home, folder }
  }
  const machines = { a: setUp('a', alice, `fixer-a-${id}`), b: setUp('b', amir, `fixer-b-${id}`) }
  // Standing approvals so nobody has to click through the agents' edits.
  await db.query(
    `insert into approval_rules (team_id, tool_name, decision) select id, unnest($2::text[]), 'allow' from teams where name = $1`,
    [team, ['Edit', 'Write', 'Bash', 'MultiEdit']])

  const env = { ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(machines.a.home, 'people.sock'), AGENTS_STREAMS_PORT: '7808', AGENTS_STREAMS_DIR: join(machines.a.home, 'streams') }
  children.push(spawn(process.execPath, ['server/api.ts'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] }))
  await servePeople(PORT + 100, join(machines.a.home, 'people.sock'))
  await within(20, async () => fetch(API).then(() => true, () => false))
  for (const machine of [machines.a, machines.b]) {
    children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
      cwd: ROOT, env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: machine.token, AGENTS_HOME: machine.home },
      stdio: ['ignore', 'ignore', 'inherit'],
    }))
  }

  // Alice's agent fixes the bug on machine A.
  const aliceSession = await ask(alice, `fixer-a-${id}`,
    '`node checkout.js CA` fails with ERR_FLAMINGO_42. Find the cause in checkout.js and fix it so Canadian orders ship, then run it to confirm.')
  check(/['"]CA['"]/.test(readFileSync(join(machines.a.folder, 'checkout.js'), 'utf8')), "Alice's agent fixed the bug on machine A")

  // Private work must not be findable.
  await as(alice, '/v1/conversations', { kind: 'dm', agent: `fixer-a-${id}` })
  const { rows: [secretConversation] } = await db.query(
    `insert into conversations (team_id, kind, agent_id, visibility)
     select t.id, 'dm', a.id, 'private' from teams t join agents a on a.team_id = t.id and a.name = $2 where t.name = $1 returning id`,
    [team, `fixer-a-${id}`])
  await db.query(
    `insert into messages (team_id, conversation_id, seq, speaker, person_id, body, client_id)
     select c.team_id, c.id, 1, 'person', p.id, 'The PRIVATE MANGOSTEEN plan is confidential.', 'test:private'
     from conversations c join people p on p.login = $2 where c.id = $1`, [secretConversation.id, alice])

  // Amir's agent gets the same bug on machine B, with no mention of Alice.
  const amirSession = await ask(amir, `fixer-b-${id}`, 'Canadian orders fail with ERR_FLAMINGO_42 in checkout.js. Please fix it.')
  const { rows: steps } = await db.query(
    `select seq::int, kind, tool_name, coalesce(text, '') as text from events where session_id = $1 order by seq`, [amirSession])
  const search = steps.find((e) => e.kind === 'tool_call' && e.tool_name === 'mcp__team-record__search_record')
  const firstEdit = steps.find((e) => e.kind === 'tool_call' && ['Edit', 'Write', 'MultiEdit'].includes(e.tool_name))
  check(search && (!firstEdit || search.seq < firstEdit.seq), "Amir's agent searched the team record before changing anything")
  const found = steps.some((e) => e.kind === 'tool_result' && e.text.includes(aliceSession))
  check(found, "the search found Alice's session")
  check(/['"]CA['"]/.test(readFileSync(join(machines.b.folder, 'checkout.js'), 'utf8')), "Amir's agent fixed its own copy on machine B")
  const reply = steps.filter((e) => e.kind === 'assistant').map((e) => e.text).join('\n')
  check(/alice|teammate|earlier|already/i.test(reply), "Amir's agent says it built on a teammate's earlier fix")

  // What the record tools may and may not see.
  const tokenB = machines.b.token
  const read = (path: string) => fetch(`${API}${path}`, { headers: { authorization: `Bearer ${tokenB}` } })
  const hidden = await (await read(`/v1/record/search?q=${encodeURIComponent('PRIVATE MANGOSTEEN')}&session=${amirSession}`)).json()
  check(Array.isArray(hidden.hits) && hidden.hits.length === 0, "a private conversation's words never show up in a teammate agent's search")
  const shared = await (await read(`/v1/record/search?q=ERR_FLAMINGO_42&session=${amirSession}`)).json()
  check(shared.hits?.some((h: { session_id: string }) => h.session_id === aliceSession), 'the same search does find shared work')
  const foreign = await read(`/v1/record/search?q=ERR_FLAMINGO_42&session=${aliceSession}`)
  check(foreign.status === 403, "a machine cannot search as a session running on another machine")
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
