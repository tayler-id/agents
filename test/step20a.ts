// Evidence, part 2: hunks and the decisions on them, with the server's own code
// against the test database. The server computes each hunk from the writer's
// operation. A hunk citing no findings is refused, and so is one resting on a
// single occasion, a deletion without two harm findings, one sending a
// candidate anywhere but its route, and two hunks on one rule. More than five
// hunks, or a change over the size budget, is refused whole. A person keeps or
// turns down each hunk with a reason, settling applies the kept ones, and a
// hunk the team turned down stays down until more occasions back it.
//   node --env-file=.env --env-file=.env.test test/step20a.ts

import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { pickSessions, recordFindings, rulesOf } from '../server/evidence.ts'
import { BUDGET_TOKENS, decideHunk, proposeHunks, settleHunks } from '../server/hunks.ts'
import { answerRunAsk } from '../server/runner.ts'
import { startSessionReplays } from '../server/refine.ts'
import { pool, tx } from '../server/db.ts'
import { appendEvents, type Person } from '../server/record.ts'
import { recordVersion } from '../server/pipelines.ts'
import { HunkDecisionBody, HunkId } from '../shared/evidence.ts'
import { AgentId, ProposalId, RunId, TeamId } from '../shared/ids.ts'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
const id = randomBytes(4).toString('hex')
const team = `evd-a-${id}`
const [aliceLogin, bobLogin, carolLogin] = [`alice-${id}@local`, `bob-${id}@local`, `carol-${id}@local`]
const INSTRUCTIONS = 'You fix bugs in small JavaScript projects.\n\n- Keep replies short.\n- Ask before deleting files.'
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0]
const all = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

const LEARNER = `export default {
  description: 'Learns.', agent: 'improver', runsOn: 'home', spendCapUsd: 1, triggers: [{ kind: 'manual' }], start: 'read',
  stages: { read: { kind: 'agent', prompt: () => 'Read.', next: { read: { done: 'succeeded', note: 'ok' } } } },
}`

try {
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, aliceLogin)
  node('server/admin.ts', 'add-person', team, bobLogin)
  node('server/admin.ts', 'add-person', team, carolLogin)
  node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', aliceLogin)
  node('server/admin.ts', 'add-agent', team, 'fixer', `mac-${id}`, '', INSTRUCTIONS)
  node('server/admin.ts', 'add-agent', team, 'improver', `mac-${id}`)
  const teamId = TeamId.parse(must(await one('select id from teams where name = $1', [team]), 'the team').id)
  const person = async (login: string): Promise<Person> => ({ ...must(await one('select id, team_id, login from people where login = $1', [login]), login) })
  const [alice, bob, carol] = [await person(aliceLogin), await person(bobLogin), await person(carolLogin)]
  const fixer = AgentId.parse(must(await one(`select id from agents where team_id = $1 and name = 'fixer'`, [teamId]), 'fixer').id)
  const mac = must(await one('select id from instances where team_id = $1', [teamId]), 'the mac').id
  const rule = (words: string) => must(rulesOf(INSTRUCTIONS).find((r) => r.text.includes(words)), words).hash
  const [keepShort, askFirst] = [rule('Keep replies short'), rule('Ask before deleting')]

  // Each run proposes, so each gets its own run of a learning pipeline.
  const learner = await recordVersion(teamId, null, 'learner', 'pipelines/learner.ts', LEARNER)
  const newRun = async () => {
    const task = must(await one(`insert into tasks (team_id, slug, title, source) values ($1, $2, 'coach', 'manual') returning id`,
      [teamId, `coach-${randomBytes(3).toString('hex')}`]), 'task').id
    return RunId.parse(must(await one(`insert into runs (team_id, pipeline_version_id, task_id, trigger, status) values ($1, $2, $3, 'manual', 'running') returning id`,
      [teamId, learner.versionId, task]), 'run').id)
  }

  // A session of one person with fixer, in its own conversation: what the
  // person said and what the agent said, in order.
  type Said = [who: 'person' | 'agent', text: string]
  const session = async (who: Person, lines: Said[]) => {
    const conversation = must(await one(`insert into conversations (team_id, kind, agent_id) values ($1, 'main', $2) returning id`, [teamId, fixer]), 'conversation').id
    const sid = String(must(await one('insert into sessions (team_id, conversation_id, instance_id, agent_id) values ($1, $2, $3, $4) returning id',
      [teamId, conversation, mac, fixer]), 'session').id)
    for (const [speaker, text] of lines) {
      await tx((client) => appendEvents(client, sid, { events: [{ clientId: randomUUID(), kind: speaker === 'person' ? 'user' : 'assistant', text, body: { text } }] },
        speaker === 'person' ? who.id : null))
    }
    await pool.query(`update sessions set last_active_at = now() - interval '2 hours' where id = $1`, [sid])
    return sid
  }
  const step = async (sid: string, words: string): Promise<number> =>
    must(await one(`select seq::int from events where session_id = $1 and text like '%' || $2 || '%' order by seq limit 1`, [sid, words]), words).seq

  const s1 = await session(alice, [['person', 'Write the release note'], ['agent', 'Here is a long release note with five paragraphs about colour and color.'],
    ['person', 'Use British English, please, always.'], ['person', 'Keep it to one line, I said.'], ['person', 'Add a changelog line too.']])
  const s2 = await session(alice, [['person', 'Write the notes for 1.4'], ['agent', 'Notes: oldest change first.'],
    ['person', 'Keep it to one line next time please.'], ['person', 'Put the newest change first in release notes.']])
  const s3 = await session(bob, [['person', 'Ship it'], ['agent', 'I asked before deleting the build cache, so the build failed overnight.'],
    ['person', 'Use British English in everything you write.'], ['person', 'Run the tests before you ship, every time.'],
    ['agent', 'Here is another very long answer that goes on for many lines.']])
  const s4 = await session(carol, [['person', 'Clean up'], ['agent', 'I asked before deleting the temp folder and the deploy timed out.'],
    ['person', 'Run the tests before shipping anything.'], ['person', 'Newest change first in the release notes, please.']])
  const s5 = await session(carol, [['person', 'Summarize'], ['agent', 'Short: done.'], ['person', 'No emoji in summaries, thanks.'],
    ['person', 'Add a changelog line for this.']])

  const runA = await newRun()
  const picked = await pickSessions(pool, teamId, fixer)
  const gap = async (sid: string, words: string, correction: string, same: string, extra: Record<string, string> = {}) =>
    ({ kind: 'gap', session: sid, step: await step(sid, words), quote: words, correction, same, fix: 'text', ...extra })
  const ruled = async (kind: string, sid: string, words: string, hash: string) => ({ kind, session: sid, step: await step(sid, words), quote: words, rule: hash })
  const recorded = await tx(async (client) => recordFindings(client, {
    teamId, runId: runA, agentId: fixer, picked: picked.picked, report: {
      findings: [
        await gap(s1, 'Use British English, please', 'Write in British English.', 'british'),
        await gap(s3, 'Use British English in everything', 'Write in British English.', 'british'),
        await gap(s1, 'Keep it to one line, I said', 'Answer in one line.', 'one-line'),
        await gap(s2, 'Keep it to one line next time', 'Answer in one line.', 'one-line'),
        await gap(s3, 'Run the tests before you ship', 'Run the tests before shipping.', 'tests', { fix: 'check' }),
        await gap(s4, 'Run the tests before shipping', 'Run the tests before shipping.', 'tests', { fix: 'check' }),
        await gap(s2, 'Put the newest change first', 'Newest change first.', 'newest', { when: 'writing release notes' }),
        await gap(s4, 'Newest change first in the release notes', 'Newest change first.', 'newest', { when: 'writing release notes' }),
        await gap(s5, 'No emoji in summaries', 'No emoji.', 'emoji'),
        await gap(s1, 'Add a changelog line too', 'Add a changelog line.', 'changelog'),
        await gap(s5, 'Add a changelog line for this', 'Add a changelog line.', 'changelog'),
        await ruled('harm', s3, 'I asked before deleting the build cache', askFirst),
        await ruled('harm', s4, 'I asked before deleting the temp folder', askFirst),
        await ruled('harm', s5, 'Short: done.', keepShort),
        await ruled('ignored', s1, 'a long release note with five paragraphs', keepShort),
        await ruled('ignored', s3, 'another very long answer', keepShort),
      ],
    },
  }))
  check(recorded.kept.length === 16 && !recorded.dropped.length, `the evidence is recorded: ${recorded.kept.length} kept, ${recorded.dropped.map((d) => d.reason).join(' | ')}`)
  const findingsOf = async (sid: string, kind: string) => (await all(`select id from session_findings where session_id = $1 and kind = $2 order by seq`, [sid, kind])).map((r) => String(r.id))
  const fid = async (sid: string, words: string) => String(must(await one(`select id from session_findings where session_id = $1 and quote like '%' || $2 || '%'`, [sid, words]), words).id)
  const british = [await fid(s1, 'British'), await fid(s3, 'British')]
  const oneLine = [await fid(s1, 'one line'), await fid(s2, 'one line')]
  const tests = [await fid(s3, 'Run the tests'), await fid(s4, 'Run the tests')]
  const newest = [await fid(s2, 'newest'), await fid(s4, 'Newest')]
  const changelog = [await fid(s1, 'changelog'), await fid(s5, 'changelog')]
  const harmAsk = [...await findingsOf(s3, 'harm'), ...await findingsOf(s4, 'harm')]
  const harmShort = await findingsOf(s5, 'harm')
  const ignoredShort = [...await findingsOf(s1, 'ignored'), ...await findingsOf(s3, 'ignored')]
  const propose = async (hunks: unknown[]) => tx(async (client) => proposeHunks(client, { teamId, runId: await newRun(), agentId: fixer, report: { hunks }, summary: 'The writer said why.' }))
  const hunksOf = async (proposalId: string | null) => all(`select * from proposal_hunks where proposal_id = $1 order by n`, [proposalId])

  // More than five hunks is refused whole.
  const six = await propose(Array.from({ length: 6 }, (_, i) => ({ op: 'add', text: `- Rule ${i}.`, findings: british })))
  check(six.proposalId === null && six.refused.some((r) => r.reason.includes('at most 5')), `six hunks are refused whole: ${six.summary}`)

  // Citations, floors and the server's own diffs.
  const b = await propose([
    { op: 'add', text: '- Write in British English.', findings: [] },
    { op: 'add', text: '- Write in British English.', findings: [british[0]] },
    { op: 'add', text: '- Write in British English.', findings: british },
    { op: 'delete', rule: keepShort, findings: harmShort },
    { op: 'delete', rule: askFirst, findings: harmAsk },
  ])
  const reasons = b.refused.map((r) => r.reason)
  check(reasons.includes('it cites no findings'), `a hunk citing no findings is refused: ${reasons.join(' | ')}`)
  check(reasons.some((r) => r.includes('rests on 1 occasion')), 'an added rule resting on one occasion is refused')
  check(reasons.some((r) => r.includes('deleting a rule needs 2 harm findings')), 'deleting a rule needs two harm findings about it')
  const bHunks = await hunksOf(b.proposalId)
  const added = bHunks.find((h) => h.op === 'add')
  const deleted = bHunks.find((h) => h.op === 'delete')
  check(b.proposalId && bHunks.length === 2 && added?.after === '- Write in British English.' && added.before === '' && added.diff.includes('+- Write in British English.')
    && !added.diff.includes('-- Ask before deleting files.') && added.diff.split('\n').filter((l: string) => /^\+(?!\+\+)/.test(l)).length === 1
    && added.content_hash === sha256('') && added.occasions === 2 && added.counts.people === 2,
  `the server computed the added rule's hunk, citing two occasions from two people: ${JSON.stringify(added?.diff)}`)
  check(deleted?.before === '- Ask before deleting files.' && deleted.after === '' && deleted.diff.includes('-- Ask before deleting files.')
    && deleted.content_hash === sha256('- Ask before deleting files.') && deleted.evidence.length === 2 && deleted.evidence[0].quote.includes('asked before deleting'),
  'the server computed the deletion, and the hunk carries the quotes it rests on')
  check((await one('select status, target from proposals where id = $1', [b.proposalId]))?.status === 'scoring', 'the proposal waits to be scored before anyone sees it')

  // Routing: each candidate's hunk goes where code routed it.
  const c = await propose([
    { op: 'add', text: '- Answer in one line.', findings: oneLine },
    { op: 'profile', person: aliceLogin, text: 'Wants answers in one line.', findings: oneLine },
    { op: 'add', text: '- Run the tests before shipping.', findings: tests },
    { op: 'check', text: 'A check that fails a push when the tests did not run.', findings: tests },
    { op: 'skill', name: 'release-notes', description: 'Use when writing release notes.', text: 'Put the newest change first.', findings: newest },
  ])
  const cReasons = c.refused.map((r) => r.reason)
  check(cReasons.some((r) => r.includes(`goes to ${aliceLogin}'s profile`)), `one person's correction never becomes shared text: ${cReasons.join(' | ')}`)
  check(cReasons.some((r) => r.includes('goes to a check')), 'a correction a check could catch never becomes text')
  const cHunks = await hunksOf(c.proposalId)
  check(cHunks.length === 3 && cHunks.some((h) => h.target === 'profile' && h.person_id === alice.id)
    && cHunks.some((h) => h.target === 'check' && h.diff === '') && cHunks.some((h) => h.target === 'skill' && h.op === 'add' && h.skill_name === 'release-notes'),
  'the profile, the check and the skill each go where they were routed')
  const d = await propose([
    { op: 'add', text: '- Newest first.', findings: newest },
    { op: 'profile', person: bobLogin, text: 'Wants one line.', findings: oneLine },
    { op: 'change', rule: keepShort, text: '- Keep replies short: one paragraph at most.', findings: ignoredShort },
    { op: 'add', after: keepShort, text: '- Say when you are done.', findings: british },
    { op: 'skill', name: 'Release Notes', description: 'Notes.', text: 'Newest first.', findings: newest },
  ])
  const dReasons = d.refused.map((r) => r.reason)
  check(dReasons.some((r) => r.includes('goes to a skill for writing release notes')), `a narrow correction never becomes a rule: ${dReasons.join(' | ')}`)
  check(dReasons.some((r) => r.includes(`only ${bobLogin}'s own corrections`)), "one person's correction never goes to another's profile")
  check(dReasons.some((r) => r.includes('another hunk already uses rule')), 'two hunks on one rule are refused')
  check(dReasons.some((r) => r.includes('lowercase letters, digits and dashes')), "a skill named like a path or a title is refused")
  const changed = (await hunksOf(d.proposalId)).find((h) => h.op === 'change')
  check(changed?.before === '- Keep replies short.' && changed.after === '- Keep replies short: one paragraph at most.'
    && changed.diff.includes('-- Keep replies short.') && changed.diff.includes('+- Keep replies short: one paragraph at most.'),
  'a rule ignored in two sessions can be reworded, and the server computed the change')
  const e = await propose([{ op: 'change', rule: keepShort, text: '- Keep replies to three lines.', findings: ignoredShort }])
  const stranger = await propose([
    { op: 'add', text: '- Anything.', findings: [randomUUID(), british[0]] },
    { op: 'delete', rule: keepShort, findings: ignoredShort },
    { op: 'skill', name: '../../escape', description: 'Anything.', text: 'Anything.', findings: newest },
  ])
  check(stranger.refused.some((r) => r.reason.includes('"../../escape" is not')), "a skill's name never reaches outside its folder")
  check(stranger.proposalId === null && stranger.refused.some((r) => r.reason.includes('not live evidence')), 'a hunk citing a finding that is not live evidence is refused')
  check(stranger.refused.some((r) => r.reason.includes('deleting a rule cites only harm findings about that rule')), 'a rule ignored is reworded, never deleted')

  // The size budget.
  const huge = `- ${'Explain every step in detail. '.repeat(Math.ceil((BUDGET_TOKENS * 4) / 30))}`
  const over = await propose([{ op: 'add', text: huge, findings: british }])
  check(over.proposalId === null && over.refused.some((r) => r.reason.includes(`over the budget of ${BUDGET_TOKENS}`)), `a change over the size budget is refused: ${over.summary.slice(0, 160)}`)
  await pool.query('update agents set instructions = $2 where id = $1', [fixer, `${INSTRUCTIONS}\n\n${huge}`])
  const shrink = await propose([{ op: 'delete', rule: askFirst, findings: harmAsk }])
  const grow = await propose([{ op: 'add', text: '- One more rule.', findings: british }])
  check(shrink.proposalId && grow.proposalId === null && grow.refused.some((r) => r.reason.includes('already')),
    'once over the budget, a change may shrink the text but not grow it')
  await pool.query('update agents set instructions = $2 where id = $1', [fixer, INSTRUCTIONS])

  // Deciding each hunk at the gate, and settling.
  const atGate = async (proposalId: string | null) => {
    const row = must(await one('select run_id from proposals where id = $1', [proposalId]), 'the proposal')
    await pool.query(`update proposals set status = 'open' where id = $1`, [proposalId])
    const ask = must(await one(`insert into asks (team_id, kind, run_id, payload) values ($1, 'gate', $2, $3) returning id`,
      [teamId, row.run_id, JSON.stringify({ question: 'Apply?', options: ['approve', 'reject'] })]), 'the gate').id
    return { runId: RunId.parse(row.run_id), ask: String(ask) }
  }
  const gateB = await atGate(b.proposalId)
  const [addHunk, deleteHunk] = [HunkId.parse(must(added, 'the add').id), HunkId.parse(must(deleted, 'the delete').id)]
  check(!HunkDecisionBody.safeParse({ decision: 'reject' }).success && !HunkDecisionBody.safeParse({ decision: 'reject', reason: '  ' }).success,
    'turning a hunk down needs a reason')
  await tx((client) => decideHunk(client, alice, addHunk, { decision: 'reject', reason: 'We write American English here.' }))
  await tx((client) => decideHunk(client, bob, deleteHunk, { decision: 'accept' }))
  await tx((client) => answerRunAsk(client, gateB.ask, carol, 'approve'))
  const settled = await tx((client) => settleHunks(client, gateB.runId))
  const afterB = await hunksOf(b.proposalId)
  const instructions = must(await one('select instructions from agents where id = $1', [fixer]), 'fixer').instructions
  check(settled.applied && !instructions.includes('Ask before deleting') && !instructions.includes('British') && instructions.includes('- Keep replies short.'),
    `approving applied the kept hunk and not the one turned down: ${JSON.stringify(instructions)}`)
  check(afterB.find((h) => h.op === 'add')?.decision === 'rejected' && afterB.find((h) => h.op === 'add')?.reason === 'We write American English here.'
    && afterB.find((h) => h.op === 'add')?.decided_by === alice.id && afterB.find((h) => h.op === 'delete')?.decision === 'accepted'
    && afterB.find((h) => h.op === 'delete')?.decided_by === bob.id,
  'each decision is kept with who made it and why')
  const status = await one('select status, decided_by from proposals where id = $1', [b.proposalId])
  check(status?.status === 'approved' && status.decided_by === carol.id, 'the proposal records who approved it')
  const britishClosed = await one(`select count(*)::int as n from session_findings f join candidates c on c.id = f.candidate_id
    where f.id = any($1) and c.status = 'closed'`, [british])
  check(britishClosed?.n === 0, "a turned-down hunk's candidate stays open")

  // A rejected hunk stays rejected, even reworded, until more occasions back it.
  const again = await propose([{ op: 'add', text: '- Use British spelling everywhere.', findings: british }])
  check(again.proposalId === null && again.refused.some((r) => r.reason.includes('We write American English here.') && r.reason.includes(aliceLogin)),
    `a hunk the team turned down is refused, reworded, with the reason: ${again.summary}`)
  const unrelated = await propose([{ op: 'add', text: '- Add a changelog line for every change.', findings: changelog }])
  check(unrelated.proposalId !== null, `a different correction is not held back by that decision: ${unrelated.summary}`)
  const s6 = await session(carol, [['person', 'Draft the email'], ['agent', 'Draft: color scheme updated.'], ['person', 'Use British English: colour.']])
  const runB = await newRun()
  const more = await pickSessions(pool, teamId, fixer)
  await tx(async (client) => recordFindings(client, {
    teamId, runId: runB, agentId: fixer, picked: more.picked,
    report: { findings: [{ ...await gap(s6, 'Use British English: colour', 'Write in British English.', 'x'), same: undefined, candidate: must(await one('select candidate_id from session_findings where id = $1', [british[0]]), 'british').candidate_id }] },
  }))
  const third = await propose([{ op: 'add', text: '- Use British spelling everywhere.', findings: [...british, await fid(s6, 'British')] }])
  check(third.proposalId !== null, `with a third occasion behind it, the hunk is proposed again: ${third.summary}`)

  // A replay stage a person retries after a hand-off starts the replays over, once.
  const thirdId = ProposalId.parse(third.proposalId)
  const firstStart = await tx((client) => startSessionReplays(client, teamId, thirdId))
  const firstSessions = (await all('select session_id from session_replays where proposal_id = $1', [thirdId])).map((r) => String(r.session_id))
  const secondStart = await tx((client) => startSessionReplays(client, teamId, thirdId))
  const replays = await all('select session_id from session_replays where proposal_id = $1', [thirdId])
  const stopped = await one(`select count(*)::int as n from commands where kind = 'stop' and session_id = any($1)`, [firstSessions])
  check(firstStart > 0 && secondStart === firstStart && replays.length === firstStart && !replays.some((r) => firstSessions.includes(String(r.session_id)))
    && stopped?.n === firstStart,
  `a retried replay stage starts the replays over once, and stops the earlier ones: ${firstStart} then ${secondStart}, ${replays.length} rows, ${String(stopped?.n)} stopped`)

  // Settling turns everything down when the gate is rejected, and refuses a
  // change whose rule moved on after it was proposed.
  const gateD = await atGate(d.proposalId)
  const dHunk = HunkId.parse(must((await hunksOf(d.proposalId))[0], "D's hunk").id)
  await tx((client) => decideHunk(client, alice, dHunk, { decision: 'accept' }))
  await tx((client) => answerRunAsk(client, gateD.ask, bob, 'reject', 'Not now.'))
  await tx((client) => settleHunks(client, gateD.runId))
  const afterD = await hunksOf(d.proposalId)
  check(afterD.every((h) => h.decision === 'rejected' && h.reason === 'Not now.' && h.decided_by === bob.id)
    && (await one('select status from proposals where id = $1', [d.proposalId]))?.status === 'rejected',
  'rejecting at the gate turns down every hunk, with the gate\'s reason')
  const gateE = await atGate(e.proposalId)
  await pool.query('update agents set instructions = $2 where id = $1', [fixer, 'You fix bugs in small JavaScript projects.\n\n- Keep replies very short.'])
  await tx((client) => answerRunAsk(client, gateE.ask, alice, 'approve'))
  const moved = await tx((client) => settleHunks(client, gateE.runId)).then(() => '', (error: unknown) => (error as Error).message)
  check(moved.includes('the instructions changed after this proposal'), `a kept hunk whose rule changed since is not applied: ${moved}`)
  check((await one('select instructions from agents where id = $1', [fixer]))?.instructions.includes('very short'), 'and the instructions are left as they were')

  // Kept hunks for a profile, a check and a skill.
  await pool.query('update agents set instructions = $2 where id = $1', [fixer, INSTRUCTIONS])
  const gateC = await atGate(c.proposalId)
  await tx((client) => answerRunAsk(client, gateC.ask, alice, 'approve', 'Good.'))
  const settledC = await tx((client) => settleHunks(client, gateC.runId))
  const profile = await one(`select content from memories where agent_id = $1 and person_id = $2 and kind = 'profile'`, [fixer, alice.id])
  const skill = await one(`select description, content from skills where agent_id = $1 and name = 'release-notes'`, [fixer])
  check(profile?.content === 'Wants answers in one line.' && skill?.description === 'Use when writing release notes.' && skill.content === 'Put the newest change first.'
    && settledC.summary.includes('A check to add: A check that fails a push'),
  `kept hunks wrote Alice's profile and the skill, and list the check to add: ${settledC.summary}`)
  const closed = await all(`select distinct c.status from candidates c join session_findings f on f.candidate_id = c.id where f.id = any($1)`, [[...oneLine, ...tests, ...newest]])
  check(closed.length === 1 && closed[0]?.status === 'closed', "the kept hunks' candidates are closed")
  const settledHunk = HunkId.parse(must((await hunksOf(c.proposalId))[0], 'a hunk').id)
  const late = await tx((client) => decideHunk(client, alice, settledHunk, { decision: 'accept' }))
    .then(() => 'decided', (error: unknown) => (error as Error).message)
  check(late.includes('not waiting at its gate'), `a hunk cannot be decided once its proposal has settled: ${late}`)
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack}`)
} finally {
  if (!failures.length) await pool.query('delete from teams where name = $1', [team]).catch(() => {})
  await pool.end().catch(() => {})
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test team removed)'}`)
process.exit(failures.length ? 1 : 0)
