// Terminal sessions. A person connects a folder on their Mac, and the Claude Code
// sessions they start in it from their own terminal land in the record: each
// prompt, reply, tool call and result, scrubbed of secrets, shown in the app
// beside the app's own sessions and marked as from their terminal. A session in
// a folder beside it, one started before the folder was connected, and one
// started after it was disconnected stay on the Mac. A private folder's sessions
// are its person's alone. Runs the real claude CLI with haiku, headless, through
// the real daemon, API and Electric.
//   node --env-file=.env --env-file=.env.test test/step21.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { crc32, deflateSync } from 'node:zlib'
import { chromium, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import pg from 'pg'
import { makeScrub } from '../shared/scrub.ts'
import { PARENT_SESSION_ENV } from '../daemon/claude.ts'
import { must } from './must.ts'
import { servePeople } from './people.ts'

const ROOT = new URL('..', import.meta.url).pathname
// Ports 8100 to 8119 are this step's: machines, people, streams.
const PORT = 8100
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const STREAMS_PORT = PORT + 2
// The app on a plain-HTTP name, as the tailnet serves it, so a browser API that needs a secure page fails here too.
const INSECURE = `http://agents.test:${PORT + 1}`
const id = randomBytes(4).toString('hex')
const team = `local-${id}`
const otherTeam = `local-${id}-x`
const owner = `local-owner-${id}@local`
const ownerName = `local-owner-${id}`
const mate = `local-mate-${id}@local`
const stranger = `local-stranger-${id}@local`
const envSecret = randomBytes(18).toString('base64url')
const githubToken = `ghp_${randomBytes(27).toString('hex').slice(0, 36)}`
const dotenvSecret = randomBytes(18).toString('base64url')
const WORD = 'pelican'
const PROMPT = 'Read notes.txt with the Read tool, then reply with only the word it tells you to remember.'
const SECOND = 'Read logo.png with the Read tool, then reply with only its main color in one word.'
const THIRD = 'Reply with only the word kestrel.'
const SUBAGENT_PROMPT = 'Use the Agent tool to start one subagent. Tell it to read plan.txt with the Read tool and report the word that file says to remember. Then reply with only that word.'
// What Claude Code calls the tool that starts a subagent, now and in earlier versions.
const SUBAGENT_TOOLS = ['Agent', 'Task']

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []
// The person's terminal is not inside another Claude Code session, even when this check runs from one.
const TERMINAL_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !PARENT_SESSION_ENV.includes(name)))

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })

function run(script: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] })
  children.push(child)
  return child
}

async function until(label: string, seconds: number, test: () => Promise<boolean>) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const count = async (sql: string, params: unknown[]) => Number((await db.query(sql, params)).rows[0].count)

// The folders command, as the person runs it on their Mac, from a folder of their own.
// Its home is a folder that doesn't exist, so it never reads the live daemon's config.
function folders(token: string, cwd: string, ...args: string[]): { code: number; out: string } {
  const env = { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: join(tmpdir(), `agents-step21-${id}-none`) }
  try {
    return { code: 0, out: execFileSync(process.execPath, [join(ROOT, 'daemon', 'folders.ts'), ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string }
    return { code: failed.status, out: failed.stdout + failed.stderr }
  }
}

// A headless Claude Code session in a folder, started the way a person starts one
// in their terminal, where PWD is the folder as they typed it.
function claude(cwd: string, prompt: string, resume?: string): Promise<{ session: string; result: string }> {
  const args = ['-p', '--model', 'haiku', '--output-format', 'json', ...(resume ? ['--resume', resume] : []), prompt]
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env: { ...TERMINAL_ENV, PWD: cwd }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d })
    child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d })
    child.on('error', reject)
    child.on('close', (code) => {
      try {
        const answer = JSON.parse(out) as { session_id: string; result: string }
        resolve({ session: answer.session_id, result: answer.result })
      } catch {
        reject(new Error(`claude in ${cwd} exited ${String(code)}: ${err.slice(-400)}${out.slice(-400)}`))
      }
    })
  })
}

// Claude Code's own transcript of a session: its tool calls and its replies.
function transcriptOf(session: string) {
  const projects = join(homedir(), '.claude', 'projects')
  const dir = readdirSync(projects).find((d) => existsSync(join(projects, d, `${session}.jsonl`)))
  if (!dir) throw new Error(`no transcript for ${session}`)
  const toolUseIds = new Set<string>()
  const texts = new Set<string>()
  for (const raw of readFileSync(join(projects, dir, `${session}.jsonl`), 'utf8').split('\n')) {
    if (!raw) continue
    const line = JSON.parse(raw)
    if (line.isSidechain || line.type !== 'assistant' || !Array.isArray(line.message?.content)) continue
    for (const block of line.message.content) {
      if (block.type === 'tool_use') toolUseIds.add(block.id)
      if (block.type === 'text' && block.text) texts.add(block.text)
    }
  }
  return { dir: join(projects, dir), toolUseIds, texts }
}

async function machine(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(API + path, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

// What a person's sessions shape holds, read once, as the app reads it.
async function shapeRows(login: string, query: string): Promise<{ status: number; ids: string[] }> {
  const res = await fetch(`${PEOPLE}/v1/shape/${query}${query.includes('?') ? '&' : '?'}offset=-1`, { headers: { 'tailscale-user-login': login } })
  if (!res.ok) return { status: res.status, ids: [] }
  const messages = await res.json() as { value?: { id?: string } }[]
  return { status: res.status, ids: messages.flatMap((m) => (m.value?.id ? [m.value.id] : [])) }
}

// A small solid red PNG, made here so the check carries no image file.
function redPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const side = 32
  const header = Buffer.alloc(13)
  header.writeUInt32BE(side, 0)
  header.writeUInt32BE(side, 4)
  // 8 bits per channel, truecolor. The other three bytes, compression, filter and interlace, stay 0.
  header.writeUInt8(8, 8)
  header.writeUInt8(2, 9)
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: side }, () => Buffer.from([220, 30, 30])))])
  const pixels = deflateSync(Buffer.concat(Array.from({ length: side }, () => row)))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))])
}

const visible = (page: Page, selector: string, seconds: number, text?: RegExp) =>
  (text ? page.locator(selector, { hasText: text }) : page.locator(selector)).first()
    .waitFor({ state: 'visible', timeout: seconds * 1000 }).then(() => true, () => false)

const made: string[] = []
try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, owner)
  node('server/admin.ts', 'add-person', team, mate)
  node('server/admin.ts', 'add-team', otherTeam, stranger)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', owner)) as { token: string }
  const { token: boxToken } = JSON.parse(node('server/admin.ts', 'add-instance', team, `box-${id}`, 'box', owner)) as { token: string }
  const { rows: [ownerRow] } = await db.query('select id, team_id from people where login = $1', [owner])

  // The folders as the person's shell names them. On macOS the temp folder is a
  // link, /var to /private/var, so this also proves a link in the path is resolved.
  const root = mkdtempSync(join(tmpdir(), 'agents-step21-'))
  made.push(root)
  const real = realpathSync(root)
  if (real === root) throw new Error(`${root} is no link, so this check cannot show that the folder is stored with links resolved`)
  const [shop, beside, diary, home] = ['shop', 'shop-old', 'diary', 'home'].map((name) => join(root, name))
  for (const dir of [shop, beside, diary, home]) mkdirSync(must(dir, 'a folder'))
  writeFileSync(join(must(shop, 'shop'), 'notes.txt'),
    `Deploy password: ${envSecret}\nBackup token: ${githubToken}\nStripe key: ${dotenvSecret}\nThe word to remember is ${WORD}.\n`)
  writeFileSync(join(must(shop, 'shop'), '.env'), `STRIPE_SECRET_KEY=${dotenvSecret}\n`)
  writeFileSync(join(must(shop, 'shop'), 'logo.png'), redPng())
  mkdirSync(join(must(shop, 'shop'), 'sub'))
  writeFileSync(join(must(shop, 'shop'), 'sub', 'plan.txt'), 'The word to remember is tern.\n')

  run('server/api.ts', {
    AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_SOCKET: join(real, 'home', 'people.sock'),
    AGENTS_STREAMS_PORT: String(STREAMS_PORT), AGENTS_STREAMS_DIR: join(real, 'home', 'streams'),
  })
  await servePeople(PORT + 1, join(real, 'home', 'people.sock'))
  await until('the API', 30, async () => fetch(API).then(() => true, () => false))
  const daemonEnv = { AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: must(home, 'home'), AGENTS_TEST_SECRET: envSecret }
  let daemon = run('daemon/agentsd.ts', daemonEnv)
  await until('the Mac online', 30, async () => (await count(`select count(*) from instances where name = $1 and status = 'online'`, [`mac-${id}`])) === 1)

  // Before the folder is connected.
  const early = await claude(must(shop, 'shop'), 'Reply with only the word early.')

  // Connecting, by the path as the shell names it, then again from inside the folder, and what the command refuses.
  const connected = folders(token, root, 'connect', must(shop, 'shop'))
  const realShop = join(real, 'shop')
  check(connected.code === 0 && connected.out.startsWith(`ok: connected ${realShop}.`) && connected.out.includes('the team sees'),
    `connect says ok and names the folder with its link resolved: ${connected.out.split('\n')[0] ?? ''}`)
  const again = folders(token, must(shop, 'shop'), 'connect', '--json')
  const againJson = JSON.parse(again.out) as { ok: boolean; already: boolean; folder: { path: string; visibility: string } }
  check(again.code === 0 && againJson.ok && againJson.already && againJson.folder.path === realShop, 'connecting again changes nothing and says already')
  const privately = folders(token, must(diary, 'diary'), 'connect', '--private', '--json')
  check(privately.code === 0 && (JSON.parse(privately.out) as { folder: { visibility: string } }).folder.visibility === 'private', 'a second folder connects as private')
  check(folders(token, root, 'connect', join(root, 'nowhere')).code === 2, 'a folder that does not exist is a usage error, exit 2')
  check(folders(boxToken, root, 'connect', must(beside, 'beside')).code === 3, 'a box cannot connect a folder, refused with exit 3')
  const listed = folders(token, root)
  check(listed.code === 0 && listed.out.includes(realShop) && listed.out.includes(join(real, 'diary')) && !listed.out.includes('shop-old'),
    'the list shows the two connected folders and not the one beside them')
  const { rows: [shopFolder] } = await db.query('select id, connected_by from connected_folders where path = $1', [realShop])
  check(shopFolder?.connected_by === ownerRow.id, "the folder is the Mac owner's")

  // Terminal sessions at once: two turns in the folder, one in a folder inside it, one beside it, one in the private folder.
  const [first, subRun, besideRun, diaryRun] = await Promise.all([
    claude(must(shop, 'shop'), PROMPT),
    claude(join(must(shop, 'shop'), 'sub'), SUBAGENT_PROMPT),
    claude(must(beside, 'beside'), 'Reply with only the word osprey.'),
    claude(must(diary, 'diary'), 'Reply with only the word wren.'),
  ])
  const second = await claude(must(shop, 'shop'), SECOND, first.session)
  // What the CLI does, which the rest of the check counts on.
  if (second.session !== first.session) throw new Error(`claude --resume made a new session, ${second.session}, so there is no second turn to look for`)

  const sessionOf = async (harness: string) => (await db.query('select * from sessions where harness_session_id = $1', [harness])).rows[0]
  const turnsEnded = async (sessionId: string) => count(`select count(*) from events where session_id = $1 and kind = 'usage'`, [sessionId])
  await until('both turns in the record', 60, async () => {
    const s = await sessionOf(first.session)
    return Boolean(s) && (await turnsEnded(s.id)) === 2
  })
  await until("the private folder's session in the record", 60, async () => Boolean(await sessionOf(diaryRun.session)))
  await until('the session with a subagent in the record', 60, async () => {
    const s = await sessionOf(subRun.session)
    return Boolean(s) && (await turnsEnded(s.id)) >= 1
  })
  const session = await sessionOf(first.session)
  const diarySession = await sessionOf(diaryRun.session)

  check(session.folder_id === shopFolder.id && session.agent_id === null && session.task_id === null && session.conversation_id === null
    && session.started_by === ownerRow.id && session.cwd === realShop && session.team_id === ownerRow.team_id,
  "the session serves the folder, with no agent, task or conversation, and is the owner's")
  check(session.status === 'idle' && session.turns === 2, `it ended idle after 2 turns (${String(session.status)}, ${String(session.turns)})`)

  const { rows: events } = await db.query(
    `select seq::int, kind, author, tool_use_id, tool_name, text, body, body::text as raw from events where session_id = $1 order by seq`, [session.id])
  const of = (kind: string) => events.filter((e) => e.kind === kind)
  check(events.length > 0 && events.every((e, i) => e.seq === i + 1), `${events.length} events with seqs 1..${events.length} and no gaps`)
  check(of('user').map((e) => e.text).join('|') === `${PROMPT}|${SECOND}` && of('user').every((e) => e.author === ownerRow.id),
    "both prompts are user events, authored by the folder's person")
  check(events.filter((e) => e.kind !== 'user').every((e) => e.author === null), 'nothing Claude wrote carries an author')
  const [end1, user2, end2] = [of('usage')[0], of('user')[1], of('usage')[1]]
  check(end1 && user2 && end2 && end1.seq < user2.seq && user2.seq < end2.seq, 'turn one ends before the second prompt, which comes before turn two ends')
  const calls = of('tool_call')
  const resultIds = new Set(of('tool_result').map((e) => e.tool_use_id))
  check(calls.some((e) => e.tool_name === 'Read') && calls.every((e) => e.tool_use_id && resultIds.has(e.tool_use_id)),
    `every tool call (${calls.length}) has its result, linked by tool_use_id`)
  check(of('assistant').some((e) => String(e.text).toLowerCase().includes(WORD)), `the reply with "${WORD}" is in the record`)

  const truth = transcriptOf(first.session)
  const scrub = makeScrub([['AGENTS_TEST_SECRET', envSecret], ['STRIPE_SECRET_KEY', dotenvSecret]])
  const recordedCalls = new Set(calls.map((e) => e.tool_use_id))
  const recordedTexts = new Set(of('assistant').map((e) => e.body.text))
  check(truth.toolUseIds.size > 0 && [...truth.toolUseIds].every((i) => recordedCalls.has(i)),
    `all ${truth.toolUseIds.size} tool calls in Claude's transcript are in the record`)
  check(truth.texts.size > 0 && [...truth.texts].every((t) => recordedTexts.has(scrub(t))),
    `all ${truth.texts.size} assistant texts in Claude's transcript are in the record`)

  // The picture Claude read stays on the Mac. PNG data starts iVBORw0KGgo in base64, and JPEG data /9j/.
  const pictures = await count(
    `select (select count(*) from events where session_id = $1 and (body::text like '%iVBORw0KGgo%' or body::text like '%/9j/%'))
          + (select count(*) from raw_events where session_id = $1 and (line::text like '%iVBORw0KGgo%' or line::text like '%/9j/%')) as count`, [session.id])
  check(pictures === 0 && of('tool_result').some((e) => e.raw.includes('Images stay on the Mac.')),
    'the picture Claude read reached the record as a note that it stayed on the Mac, with none of its bytes')

  // A session started in a folder inside the connected one, whose agent hands work to a subagent.
  const nested = await sessionOf(subRun.session)
  const { rows: nestedEvents } = await db.query(
    'select kind, tool_name, tool_use_id, parent_tool_use_id, author from events where session_id = $1 order by seq', [nested.id])
  const agentCalls = new Set(nestedEvents.filter((e) => e.kind === 'tool_call' && !e.parent_tool_use_id && SUBAGENT_TOOLS.includes(e.tool_name)).map((e) => e.tool_use_id))
  const subagentEvents = nestedEvents.filter((e) => e.parent_tool_use_id && agentCalls.has(e.parent_tool_use_id))
  check(nested.cwd === join(realShop, 'sub') && nested.folder_id === shopFolder.id, 'a session started in a folder inside the connected one belongs to it')
  check(agentCalls.size > 0 && subagentEvents.some((e) => e.kind === 'tool_call' && e.tool_name === 'Read'),
    `the subagent's own Read is in the record, under the Agent call that started it (${subagentEvents.length} events)`)
  check(nestedEvents.filter((e) => e.kind === 'user').length === 1, "the subagent's orders are not taken for the person's prompt")

  const leaks = await count(
    `select (select count(*) from events where team_id = $1 and (body::text like any($2) or coalesce(text, '') like any($2)))
          + (select count(*) from raw_events r join sessions s on s.id = r.session_id where s.team_id = $1 and r.line::text like any($2))
       as count`, [ownerRow.team_id, [`%${envSecret}%`, `%${githubToken}%`, `%${dotenvSecret}%`]])
  check(leaks === 0, "no event or raw line holds the daemon's secret, the GitHub token or the .env value")
  check(of('tool_result').some((e) => e.raw.includes('[secret:AGENTS_TEST_SECRET]') && e.raw.includes('[secret:github]') && e.raw.includes('[secret:STRIPE_SECRET_KEY]')),
    'notes.txt reached the record with all three secrets replaced, the .env one by its name')
  check(await count('select count(*) from raw_events where session_id = $1', [session.id]) > 0, "Claude's transcript lines are kept as raw lines")

  // What stays on the Mac.
  const strays = await count('select count(*) from sessions where harness_session_id = any($1)', [[early.session, besideRun.session]])
  check(strays === 0, 'no session was made for the one started before connecting, or the one in the folder beside it')
  const strayWords = await count(
    `select (select count(*) from events where text ilike any($1)) + (select count(*) from raw_events where line::text ilike any($1)) as count`,
    [['%Reply with only the word early%', '%Reply with only the word osprey%']])
  check(strayWords === 0, 'nothing of those two sessions is anywhere in the record')

  // Who sees what.
  const forMate = await shapeRows(mate, 'sessions?of=folders')
  const forOwner = await shapeRows(owner, 'sessions?of=folders')
  const forStranger = await shapeRows(stranger, 'sessions?of=folders')
  check(forMate.ids.includes(session.id) && !forMate.ids.includes(diarySession.id), 'a teammate sees the folder session and not the private one')
  check(forOwner.ids.includes(session.id) && forOwner.ids.includes(diarySession.id), 'the owner sees both')
  check(forStranger.status === 200 && !forStranger.ids.includes(session.id), 'someone on another team sees neither')
  check((await shapeRows(mate, `events?session=${String(diarySession.id)}`)).status === 404 && (await shapeRows(stranger, `events?session=${String(session.id)}`)).status === 404,
    "the private session's events are refused to the teammate, and the team's to the other team")
  const search = await machine(token, 'GET', `/v1/record/search?session=${String(diarySession.id)}&q=${WORD}`)
  const hits = (search.body as { hits?: { session_id: string }[] } | null)?.hits ?? []
  check(search.status === 200 && hits.some((h) => h.session_id === session.id), "an agent's search_record finds the terminal session's work")
  const wrenSearch = await machine(token, 'GET', `/v1/record/search?session=${String(session.id)}&q=wren`)
  check(!((wrenSearch.body as { hits?: { session_id: string }[] } | null)?.hits ?? []).some((h) => h.session_id === diarySession.id),
    "search_record leaves the private folder's session out")

  // What the API refuses from a machine.
  const outside = await machine(token, 'POST', '/v1/instance/terminal-sessions', { folderId: shopFolder.id, harnessSessionId: `x-${id}`, cwd: join(real, 'shop-old') })
  check(outside.status === 400, 'a session that started beside the folder is refused')
  const ask = await machine(token, 'POST', `/v1/sessions/${String(session.id)}/events`,
    { events: [{ clientId: `ask-${id}`, kind: 'ask', body: { requestId: 'r' } }] })
  check(ask.status === 400, 'a terminal session takes no asks from the machine')

  // The app, as the teammate and as the owner.
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP agents.test 127.0.0.1'] })
  try {
    const open = async (login: string, width: number) => {
      const context = await browser.newContext({ baseURL: INSECURE, extraHTTPHeaders: { 'tailscale-user-login': login }, viewport: { width, height: 820 } })
      const page = await context.newPage()
      await page.goto('/')
      return page
    }
    const page = await open(mate, 1280)
    const list = page.getByRole('list', { name: 'From terminals' })
    const row = list.getByRole('button', { name: new RegExp(`^shop\\s*${ownerName}'s terminal$`) })
    check(await row.waitFor({ timeout: 30000 }).then(() => true, () => false), `the teammate's sidebar lists shop under From terminals, as ${ownerName}'s terminal`)
    check(await list.getByRole('button', { name: /diary/ }).count() === 0, "the teammate's sidebar has no private session")
    await row.click()
    check(await visible(page, '.page-head .kicker', 15, new RegExp(`^From ${ownerName}'s terminal$`)), 'its page says whose terminal it ran in')
    check(await visible(page, '.page-head h1', 5, /^shop$/), 'and names the folder')
    check(await visible(page, '.events li', 15, new RegExp(PROMPT.slice(0, 30))), 'the prompt is on the page')
    check(await visible(page, '.events li', 5, /Tool · Read/) && await visible(page, '.events li', 5, new RegExp(WORD, 'i')),
      'so are the Read call and the reply')
    check(page.url().endsWith(`#/l/${String(session.id)}`), 'the page has its own address')
    const axe = await new AxeBuilder({ page }).analyze()
    check(!axe.violations.some((v) => v.impact === 'serious' || v.impact === 'critical'), 'the page has no serious accessibility problems')
    const phone = await open(mate, 390)
    await phone.goto(`/#/l/${String(session.id)}`)
    check(await visible(phone, '.page-head h1', 15, /^shop$/)
      && await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'at phone width the page fits without scrolling sideways')
    const own = await open(owner, 1280)
    const ownList = own.getByRole('list', { name: 'From terminals' })
    check(await ownList.getByRole('button', { name: /^diary\s*your terminal$/ }).waitFor({ timeout: 30000 }).then(() => true, () => false)
      && await ownList.getByRole('button', { name: /^shop\s*your terminal$/ }).count() === 1, "the owner's sidebar lists both, as your terminal")
  } finally {
    await browser.close()
  }

  // A restart goes on from where it was, with nothing twice.
  daemon.kill('SIGTERM')
  await until('the daemon to stop', 30, async () => daemon.exitCode !== null)
  const before = await count('select count(*) from events where session_id = $1', [session.id])
  daemon = run('daemon/agentsd.ts', daemonEnv)
  await claude(must(shop, 'shop'), THIRD, first.session)
  await until('the third turn in the record', 60, async () => (await turnsEnded(session.id)) === 3)
  const after = await db.query('select seq::int, client_id from events where session_id = $1 order by seq', [session.id])
  check(after.rows.length > before && after.rows.every((e, i) => e.seq === i + 1) && new Set(after.rows.map((e) => e.client_id)).size === after.rows.length,
    `after a restart the third turn landed, ${after.rows.length - before} new events, none twice`)

  // Disconnecting stops the folder's sessions. The private folder's next session proves the daemon read after it.
  const gone = folders(token, must(shop, 'shop'), 'disconnect')
  check(gone.code === 0 && gone.out.startsWith(`ok: disconnected ${realShop}.`), 'disconnect says ok')
  check(folders(token, must(shop, 'shop'), 'disconnect').out.includes('already: true'), 'disconnecting again says already')
  const late = await claude(must(shop, 'shop'), 'Reply with only the word plover.')
  const sentinel = await claude(must(diary, 'diary'), 'Reply with only the word finch.')
  await until('the session after the disconnect in the private folder', 60, async () => Boolean(await sessionOf(sentinel.session)))
  check(!(await sessionOf(late.session)), 'a session started after the disconnect stays on the Mac')
  const refused = await machine(token, 'POST', `/v1/sessions/${String(session.id)}/events`, { events: [{ clientId: `late-${id}`, kind: 'notice', body: {} }] })
  check(refused.status === 409, "the API refuses the disconnected folder's events")

  for (const run of [first, subRun, besideRun, diaryRun]) made.push(transcriptOf(run.session).dir)
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  if (!failures.length) {
    await db.query('delete from teams where name = any($1)', [[team, otherTeam]])
      .catch((error: unknown) => { console.error(`removing the test teams: ${(error as Error).message}`) })
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  }
  await db.end()
}

console.log(`\n${failures.length ? `${failures.length} failed (test teams ${team} and ${otherTeam} kept for inspection)` : 'all passed (test teams removed)'}`)
process.exit(failures.length ? 1 : 0)
