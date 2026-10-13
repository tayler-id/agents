// Evidence, part 3: coach end to end, with the API, a daemon and the stand-in for
// Claude. Two people correct fixer the same way in their DMs. Coach reads each
// session once, keeps only the quotes it finds, proposes a hunk citing them, and
// replays the turns behind it with and without the change. Only because the
// change wins does the shepherd see it. The shepherd turns the hunk down with a
// reason, and the next run's same hunk is held back without asking anyone. A
// third person's correction lifts it, and approving applies it. A change that
// loses its replays never reaches the shepherd. A replay reads nothing from the
// team record, never waits on a person, and never counts as evidence.
//   node --env-file=.env --env-file=.env.test test/step20b.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { forgeAdmin, forgeConfig } from '../server/forge.ts'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = 8080
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const id = randomBytes(4).toString('hex')
const team = `evd-b-${id}`
const [aliceLogin, bobLogin, carolLogin] = [`alice-${id}@local`, `bob-${id}@local`, `carol-${id}@local`]
const org = forgeConfig().org
const PIPES = `pipes20b-${id}`
const INSTRUCTIONS = 'You fix bugs in small JavaScript projects.\n\n- Keep replies short.\n- Ask before deleting files.'
const BRITISH = '- Write in British English.'

const read = (findings: unknown[]) => [{ outcome: 'read', summary: 'Read the sessions.', findings }]
const judged = (fixedIf: string) => [{ outcome: 'judged', summary: 'Judged each reply.', verdicts: { fixedIf } }]
const british = { match: 'No, use British English', kind: 'gap', correction: 'Write in British English.', same: 'british', fix: 'text' }
const writeBritish = [{ outcome: 'changed', summary: 'Two people asked for British English in separate sessions.', hunks: [
  { op: 'add', text: BRITISH, cite: ['British'] },
  { op: 'delete', rule: 'Ask before deleting', cite: [] },
] }]
const SCENARIO = {
  turns: [
    { match: 'ticket number', reply: 'Noted.' },
    { match: 'release note', reply: 'Release note: added a color picker.', replyIf: { 'Write in British English': 'Release note: added a colour picker.' } },
    { match: 'summary', reply: 'Summary: two fixes.' },
  ],
  CoachOne: {
    read: read([
      british,
      { ...british, match: 'Please use British English' },
      { ...british, match: 'Please use British English', quote: 'Please use American English', same: 'american' },
    ]),
    'changed,nothing': writeBritish,
    judged: judged('colour'),
  },
  CoachTwo: { read: read([british]), 'changed,nothing': writeBritish, judged: judged('colour') },
  CoachThree: {
    read: read([{ match: 'Use British English, please', kind: 'gap', correction: 'Write in British English.', candidate: 'Write in British English', fix: 'text' }]),
    'changed,nothing': writeBritish,
    judged: judged('colour'),
  },
  CoachFour: {
    read: read([
      { match: 'Mention the ticket number in every note', kind: 'gap', correction: 'Mention the ticket number.', same: 'ticket', fix: 'text' },
      { match: 'Always mention the ticket number', kind: 'gap', correction: 'Mention the ticket number.', same: 'ticket', fix: 'text' },
    ]),
    'changed,nothing': [{ outcome: 'changed', summary: 'Two people asked for the ticket number.', hunks: [{ op: 'add', text: '- Mention the ticket number.', cite: ['ticket'] }] }],
    judged: judged('ticket'),
  },
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })

async function within(seconds: number, test: () => Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(500)
  }
  return false
}

const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T | undefined
const all = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[]

async function call(login: string, path: string, body: unknown = {}) {
  const res = await fetch(PEOPLE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}
async function post(login: string, path: string, body: unknown = {}) {
  const { status, json } = await call(login, path, body)
  if (status !== 200) throw new Error(`${path}: ${status} ${JSON.stringify(json)}`)
  return json
}

const runOf = (runId: string) => one<{ status: string; note: string | null }>('select status, note from runs where id = $1', [runId])
const openAsk = (runId: string) => one<{ id: string; kind: string; payload: any }>(`select id, kind, payload from asks where run_id = $1 and status = 'open'`, [runId])
const stageRow = (runId: string, stage: string) => one<{ outcome: string; summary: string; data: any }>(
  `select outcome, summary, data from run_stages where run_id = $1 and stage = $2 order by n desc limit 1`, [runId, stage])
const settled = async (runId: string) => within(300, async () => ['done', 'failed'].includes((await runOf(runId))?.status ?? '') || (await openAsk(runId)) !== undefined)

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, aliceLogin)
  node('server/admin.ts', 'add-person', team, bobLogin)
  node('server/admin.ts', 'add-person', team, carolLogin)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', aliceLogin))
  node('server/admin.ts', 'add-agent', team, 'fixer', `mac-${id}`, '', INSTRUCTIONS)
  node('server/admin.ts', 'add-agent', team, 'improver', `mac-${id}`)
  const { id: teamId } = must(await one<{ id: string }>('select id from teams where name = $1', [team]), 'teamId')
  const fixer = must(await one<{ id: string }>(`select id from agents where team_id = $1 and name = 'fixer'`, [teamId]), 'fixer').id

  await forgeAdmin.ensureRepo(PIPES, {
    'shared/pipeline.ts': readFileSync(join(ROOT, 'shared/pipeline.ts'), 'utf8'),
    'pipelines/coach.ts': readFileSync(join(ROOT, 'pipelines/coach.ts'), 'utf8'),
  }, 'step 20b pipelines', false)
  await db.query('insert into repos (team_id, remote_url) values ($1, $2)', [teamId, `${forgeConfig().url}/${org}/${PIPES}.git`])
  const repoId = must(await one<{ id: string }>('select id from repos where team_id = $1', [teamId]), 'the repo').id

  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step20b-')))
  writeFileSync(join(home, 'scenario.json'), JSON.stringify(SCENARIO))
  children.push(spawn(process.execPath, ['--env-file=.env', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_PORT: String(PORT + 1), AGENTS_STREAMS_PORT: String(PORT + 2), AGENTS_STREAMS_DIR: join(home, 'streams') },
  }))
  await within(20, () => fetch(API).then(() => true, () => false))
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home, AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json') },
  }))
  await within(60, async () => (await one('select 1 from pipelines where team_id = $1 and name = $2 and current_version_id is not null', [teamId, 'coach'])) !== undefined)
  const coach = must(await one<{ id: string }>(`select id from pipelines where team_id = $1 and name = 'coach'`, [teamId]), 'the coach pipeline').id

  // People's DMs with fixer. Each message waits for fixer's reply.
  const dms = new Map<string, string>()
  const say = async (login: string, text: string) => {
    const conversation = dms.get(login) ?? (await post(login, '/v1/conversations', { kind: 'dm', agent: 'fixer' })).conversationId
    dms.set(login, conversation)
    const replies = async () => Number((await one<{ n: number }>(`select count(*)::int as n from messages where conversation_id = $1 and speaker = 'agent'`, [conversation]))?.n)
    const before = await replies()
    await post(login, `/v1/conversations/${conversation}/messages`, { text, clientId: randomUUID() })
    if (!await within(60, async () => await replies() > before)) throw new Error(`fixer never answered "${text}"`)
  }
  // Sessions are read once they have been quiet for half an hour.
  const quiet = () => db.query(`update sessions set last_active_at = now() - interval '2 hours' where agent_id = $1`, [fixer])
  const startCoach = async (title: string) => {
    await quiet()
    const { runId } = await post(aliceLogin, `/v1/pipelines/${coach}/runs`, { title, body: 'Look at the last week.', repoId })
    if (!await settled(runId)) throw new Error(`${title} never finished or reached its gate`)
    return String(runId)
  }

  await say(aliceLogin, 'Write the release note for 1.2')
  await say(aliceLogin, 'No, use British English: colour, not color.')
  await say(bobLogin, 'Write the release note for 1.3')
  await say(bobLogin, 'Please use British English, colour not color.')
  await say(carolLogin, 'Write a summary of today')

  // The first run: two people's corrections become one candidate and one hunk.
  const first = await startCoach('CoachOne fixer')
  check((await stageRow(first, 'pick'))?.summary.includes("Picked 3 sessions of fixer to read: 3 people's"), `coach picked the three DMs: ${(await stageRow(first, 'pick'))?.summary}`)
  const recorded = await stageRow(first, 'record')
  check(recorded?.outcome === 'ready' && recorded.summary.includes('Kept 2 findings and dropped 1') && recorded.summary.includes('the quote is not in step'),
    `code kept the two real quotes and dropped the invented one: ${recorded?.summary}`)
  check(recorded?.summary.includes("Ready: Write in British English. 2 sessions (2 people's, 0 pipeline, 0 box), 2 people"),
    'the candidate shows its sessions and its people, counted apart')
  const proposal = must(await one<{ id: string; status: string; target: string; scores: any }>('select id, status, target, scores from proposals where run_id = $1', [first]), 'the first proposal')
  const hunks = await all<{ id: string; target: string; op: string; after: string; evidence: any[]; counts: any; decision: string | null }>(
    'select * from proposal_hunks where proposal_id = $1 order by n', [proposal.id])
  check(hunks.length === 1 && hunks[0]?.after === BRITISH && hunks[0].evidence.length === 2 && hunks[0].counts.people === 2,
    'the proposal holds one hunk, citing both quotes')
  check((await stageRow(first, 'propose'))?.summary.includes('Refused a hunk: it cites no findings'), 'the hunk citing nothing was refused')
  const replays = await all<{ kind: string; variant: string; status: string; verdict: string; session_id: string; task_id: string }>(
    'select kind, variant, status, verdict, session_id, task_id from session_replays where proposal_id = $1', [proposal.id])
  check(replays.length === 6 && replays.every((r) => r.status === 'replied')
    && replays.filter((r) => r.kind === 'behind').length === 4 && replays.filter((r) => r.kind === 'unrelated').length === 2,
  `the two turns behind the change and one unrelated turn were each replayed with and without it: ${replays.length}`)
  const prompts = await all<{ text: string }>(`select e.text from session_replays r join events e on e.session_id = r.session_id and e.kind = 'user'
    where r.proposal_id = $1 and r.kind = 'behind'`, [proposal.id])
  check(prompts.length === 4 && prompts.every((p) => !p.text.includes('British English') && /: Write the release note for 1\.[23]$/.test(p.text)),
    `each replay ends at the turn before the correction, and never shows the correction: ${JSON.stringify(prompts.map((p) => p.text.slice(-60)))}`)
  check(replays.filter((r) => r.kind === 'behind' && r.variant === 'change').every((r) => r.verdict === 'fixed')
    && replays.filter((r) => r.kind === 'behind' && r.variant === 'current').every((r) => r.verdict === 'still')
    && replays.filter((r) => r.kind === 'unrelated').every((r) => r.verdict === 'ok'),
  'with the change the corrections were no longer needed, and the unrelated turn was no worse')
  const scored = must(await one<{ status: string; scores: any }>('select status, scores from proposals where id = $1', [proposal.id]), 'the scored proposal')
  check(scored.status === 'open' && scored.scores.change.still === 0 && scored.scores.current.still === 2 && scored.scores.change.worse === 0,
    `both scores are on the proposal: ${JSON.stringify(scored.scores)}`)
  const gate = await openAsk(first)
  check(gate?.kind === 'gate' && gate.payload.question.includes('With the change, 0 of 2'), `only then did the shepherd see it: ${gate?.payload.question}`)

  // Replays read nothing from the record, never wait on a person, and are replays.
  const replay = must(replays[0], 'a replay')
  check((await one('select source from tasks where id = $1', [replay.task_id]))?.source === 'replay', "a replay runs as a replay task")
  const search = await fetch(`${API}/v1/record/search?session=${replay.session_id}&q=British`, { headers: { authorization: `Bearer ${token}` } })
  check(search.status === 403, `a replay cannot read the team record: ${search.status}`)
  const asked = await fetch(`${API}/v1/sessions/${replay.session_id}/events`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ clientId: `ask:${randomUUID()}`, kind: 'ask', toolName: 'Bash', text: 'Bash rm -rf build', body: { requestId: randomUUID(), toolName: 'Bash', input: { command: 'rm -rf build' } } }] }),
  })
  const ask = await one<{ status: string; answer: any }>(`select status, answer from asks where session_id = $1`, [replay.session_id])
  check(asked.status === 200 && ask?.status === 'answered' && ask.answer.decision === 'deny', `a replay's request for a tool is denied, not put to a person: ${JSON.stringify(ask)}`)

  // The shepherd turns the hunk down, with a reason, and approves nothing else.
  const hunkId = must(hunks[0], 'the hunk').id
  check((await call(aliceLogin, `/v1/hunks/${hunkId}/decision`, { decision: 'reject' })).status === 400, 'turning a hunk down needs a reason')
  await post(aliceLogin, `/v1/hunks/${hunkId}/decision`, { decision: 'reject', reason: 'We write American English.' })
  await post(carolLogin, `/v1/asks/${must(gate, 'the gate').id}/answer`, { decision: 'approve' })
  await within(60, async () => (await runOf(first))?.status !== 'waiting' && (await runOf(first))?.status !== 'running')
  const turnedDown = await one<{ decision: string; reason: string; login: string }>(
    'select h.decision, h.reason, p.login from proposal_hunks h join people p on p.id = h.decided_by where h.id = $1', [hunkId])
  check((await runOf(first))?.note === 'The shepherd kept the agent as it is.' && turnedDown?.decision === 'rejected'
    && turnedDown.reason === 'We write American English.' && turnedDown.login === aliceLogin,
  'the hunk is turned down with who and why, and nothing is applied')
  check((await one<{ instructions: string }>('select instructions from agents where id = $1', [fixer]))?.instructions === INSTRUCTIONS, "fixer's instructions are unchanged")
  const spent = await one<{ run: string; replays: string }>(`select r.cost_usd::text as run,
      (select sum(s.cost_usd)::text from session_replays x join sessions s on s.id = x.session_id where x.proposal_id = $2) as replays
    from runs r where r.id = $1`, [first, proposal.id])
  check(Number(spent?.replays) > 0 && Number(spent?.run) > Number(spent?.replays), `the run's spend counts its replays: ${JSON.stringify(spent)}`)

  // The next run proposes the same hunk on the same evidence. It is held back, and nobody is asked.
  await say(bobLogin, 'Thanks for the notes.')
  const second = await startCoach('CoachTwo fixer')
  check((await runOf(second))?.note === 'Every hunk broke a rule for changes, so nobody was asked.' && !(await one('select 1 from asks where run_id = $1', [second])),
    `the same hunk on the same evidence never reaches the shepherd again: ${(await runOf(second))?.note}`)
  check((await stageRow(second, 'propose'))?.summary.includes('We write American English.'), 'the run says who turned it down and why')
  check((await stageRow(second, 'pick'))?.summary.includes('Picked 1 session'), 'the second run read only what was new')

  // A third person makes the same correction. With more behind it, the hunk is proposed again, wins, and is applied.
  await say(carolLogin, 'Write the release note for 2.0')
  await say(carolLogin, 'Use British English, please: colour.')
  const third = await startCoach('CoachThree fixer')
  const thirdGate = await openAsk(third)
  const thirdHunk = await one<{ occasions: number; counts: any }>(
    'select h.occasions, h.counts from proposal_hunks h join proposals p on p.id = h.proposal_id where p.run_id = $1', [third])
  check(thirdGate?.kind === 'gate' && thirdHunk?.occasions === 3 && thirdHunk.counts.people === 3,
    `with a third person behind it the hunk reached the shepherd again: ${JSON.stringify(thirdHunk)}`)
  if (thirdGate) await post(bobLogin, `/v1/asks/${thirdGate.id}/answer`, { decision: 'approve', message: 'Three of us asked.' })
  await within(60, async () => (await runOf(third))?.status === 'done')
  const instructions = must(await one<{ instructions: string }>('select instructions from agents where id = $1', [fixer]), 'fixer').instructions
  check((await runOf(third))?.note === 'The kept hunks are applied.' && instructions === `${INSTRUCTIONS}\n${BRITISH}`,
    `approving applied the hunk to fixer's instructions: ${JSON.stringify(instructions)}`)
  check((await one<{ status: string }>(`select status from candidates where agent_id = $1 and correction = 'Write in British English.'`, [fixer]))?.status === 'closed',
    'its candidate is closed')

  // A change that does not help on replays never reaches the shepherd.
  await say(aliceLogin, 'Write the release note for 3.0')
  await say(aliceLogin, 'Mention the ticket number in every note.')
  await say(bobLogin, 'Write the release note for 3.1')
  await say(bobLogin, 'Always mention the ticket number, please.')
  const fourth = await startCoach('CoachFour fixer')
  const lost = await one<{ status: string; scores: any }>('select status, scores from proposals where run_id = $1', [fourth])
  check((await runOf(fourth))?.note === 'The change did not win on replays, so nobody was asked.' && !(await one('select 1 from asks where run_id = $1', [fourth]))
    && lost?.status === 'rejected' && lost.scores.change.still === lost.scores.change.behind && lost.scores.current.still === lost.scores.current.behind,
  `a change that loses its replays never reaches the shepherd, and both scores are kept: ${JSON.stringify(lost?.scores)}`)

  // Replays never count as evidence.
  const fromReplays = await one<{ n: number }>(`select count(*)::int as n from session_findings f join sessions s on s.id = f.session_id
    join tasks t on t.id = s.task_id where f.team_id = $1 and t.source = 'replay'`, [teamId])
  const replayReads = await one<{ n: number }>(`select count(*)::int as n from session_reads r join sessions s on s.id = r.session_id
    join tasks t on t.id = s.task_id where r.team_id = $1 and t.source = 'replay'`, [teamId])
  check(fromReplays?.n === 0 && replayReads?.n === 0, 'no replay was ever read as evidence')
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch(() => {})
    await forgeAdmin.call('DELETE', `/repos/${org}/${PIPES}`).catch(() => {})
  }
  await db.end().catch(() => {})
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} and repo kept)` : 'all passed (test team and repo removed)'}`)
process.exit(failures.length ? 1 : 0)
