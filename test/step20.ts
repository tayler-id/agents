// Evidence, part 1: findings and candidates, with the server's own code against
// the test database. A finding whose quote is not in the event it cites is
// dropped, and so is one citing a session nobody picked. Each event is read once.
// Learning pipelines' sessions, replays, private and busy sessions are never
// read. Corrections group into candidates, which need two occasions, count people
// apart, expire after 90 days, merge only on the reader's judgement, and are
// routed in code: one person's to their profile, checkable ones to a check,
// narrow ones to a skill, and the rest to the instructions.
//   node --env-file=.env --env-file=.env.test test/step20.ts

import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { candidatesOf, pickSessions, recordFindings, recordStudyFindings, rulesOf } from '../server/evidence.ts'
import { pool, tx } from '../server/db.ts'
import { appendEvents, openDm, sendPersonMessage, type Person } from '../server/record.ts'
import { createRoom } from '../server/rooms.ts'
import { sendToSession, startTask } from '../server/tasks.ts'
import { recordVersion } from '../server/pipelines.ts'
import { AgentId, PipelineId, RunId, TeamId } from '../shared/ids.ts'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
const id = randomBytes(4).toString('hex')
const team = `evd-${id}`
const [aliceLogin, bobLogin, carolLogin] = [`alice-${id}@local`, `bob-${id}@local`, `carol-${id}@local`]
const INSTRUCTIONS = 'You fix bugs in small JavaScript projects.\n\n- Keep replies short.\n- Ask before deleting files.'
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0]

// The step of the latest event in a session whose text contains these words.
async function stepOf(sessionId: string, words: string): Promise<number> {
  const row = await one(`select seq::int from events where session_id = $1 and text like '%' || $2 || '%' order by seq desc limit 1`, [sessionId, words])
  return must(row, `an event saying "${words}"`).seq
}

const agentSays = (sessionId: string, text: string) => tx((client) => appendEvents(client, sessionId, {
  events: [{ clientId: randomUUID(), kind: 'assistant', text, body: { text } }],
}))
// A turn ends with a usage event, which posts the reply in a conversation.
const turnEnds = (sessionId: string) => tx((client) => appendEvents(client, sessionId, {
  events: [{ clientId: randomUUID(), kind: 'usage', body: { subtype: 'success' } }],
}))

const NIGHTLY = `export default {
  description: 'Runs the tests every night.', agent: 'fixer', runsOn: 'home', spendCapUsd: 1,
  triggers: [{ kind: 'manual' }], start: 'tests',
  stages: { tests: { kind: 'agent', prompt: () => 'Run the tests.', next: { passed: { done: 'succeeded', note: 'ok' } } } },
}`
const LEARNER = `export default {
  description: 'Learns from sessions.', agent: 'improver', runsOn: 'home', spendCapUsd: 1,
  triggers: [{ kind: 'manual' }], start: 'read',
  stages: {
    read: { kind: 'agent', prompt: () => 'Read.', next: { read: 'record' } },
    record: { kind: 'action', action: 'record_findings', next: { ready: { done: 'succeeded', note: 'ok' }, waiting: { done: 'succeeded', note: 'ok' }, failed: { handoff: 'no' } } },
  },
}`

try {
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, aliceLogin)
  node('server/admin.ts', 'add-person', team, bobLogin)
  node('server/admin.ts', 'add-person', team, carolLogin)
  node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', aliceLogin)
  node('server/admin.ts', 'add-instance', team, `box-${id}`, 'box', aliceLogin)
  node('server/admin.ts', 'add-agent', team, 'fixer', `mac-${id}`, '', INSTRUCTIONS)
  node('server/admin.ts', 'add-agent', team, 'improver', `mac-${id}`)
  const teamId = TeamId.parse(must(await one('select id from teams where name = $1', [team]), 'the team').id)
  const person = async (login: string): Promise<Person> => ({ ...must(await one('select id, team_id, login from people where login = $1', [login]), login) })
  const [alice, bob, carol] = [await person(aliceLogin), await person(bobLogin), await person(carolLogin)]
  const fixer = AgentId.parse(must(await one(`select id from agents where team_id = $1 and name = 'fixer'`, [teamId]), 'fixer').id)
  const box = must(await one('select id from instances where team_id = $1 and kind = $2', [teamId, 'box']), 'the box').id
  const rules = rulesOf(INSTRUCTIONS)
  const rule = (words: string) => must(rules.find((r) => r.text.includes(words)), `the rule "${words}"`).hash
  check(rules.length === 3 && rules.map((r) => r.text).join('|') === 'You fix bugs in small JavaScript projects.|- Keep replies short.|- Ask before deleting files.'
    && new Set(rules.map((r) => r.hash)).size === 3, `the instructions split into three rules, each with its own hash: ${JSON.stringify(rules)}`)

  // People's DMs. Alice's correction runs over two lines.
  const dm = async (who: Person, ask: string, reply: string, correction: string) => {
    const conversation = await tx((client) => openDm(client, who, 'fixer'))
    await tx((client) => sendPersonMessage(client, who, conversation, ask, randomUUID()))
    const session = must(await one('select id from sessions where conversation_id = $1', [conversation]), 'the DM session').id
    await agentSays(session, reply)
    await turnEnds(session)
    await tx((client) => sendPersonMessage(client, who, conversation, correction, randomUUID()))
    return { conversation, session: String(session) }
  }
  const aliceDm = await dm(alice, 'Write the release note for 1.2', 'Release note: added a color picker.', 'No, write it in British English:\n  colour, not color.')
  const bobDm = await dm(bob, 'Write the release note for 1.3', 'Release note: fixed the color of links.', 'Please use British English, colour not color.')

  // Alice corrects fixer in a room, where the session's prompts carry what people said.
  const room = await tx((client) => createRoom(client, alice, `room-${id}`, [], ['fixer']))
  await tx((client) => sendPersonMessage(client, alice, room, 'Summarize the open bugs', randomUUID()))
  const roomSession = String(must(await one('select id from sessions where conversation_id = $1', [room]), 'the room session').id)
  await agentSays(roomSession, 'There are three open bugs: TENOFF, the cart total, and links.')
  await turnEnds(roomSession)
  await tx((client) => sendPersonMessage(client, alice, room, 'No, keep it to one line next time.', randomUUID()))

  // A pipeline run's stage session, which Bob corrects, and a learning pipeline's run.
  const repo = must(await one(`insert into repos (team_id, remote_url) values ($1, $2) returning id`, [teamId, `http://forge.local/${team}/shop.git`]), 'the repo').id
  const nightly = await recordVersion(teamId, repo, 'nightly', 'pipelines/nightly.ts', NIGHTLY)
  const learner = await recordVersion(teamId, repo, 'learner', 'pipelines/learner.ts', LEARNER)
  const stageSession = async (versionId: string, agent: string, stage: string, source = 'manual') => {
    const task = must(await one(`insert into tasks (team_id, slug, title, agent_id, source) values ($1, $2, 'a run', $3, $4) returning id`,
      [teamId, `run-${randomBytes(3).toString('hex')}`, agent, source]), 'the run task').id
    const run = must(await one(`insert into runs (team_id, pipeline_version_id, task_id, trigger, status) values ($1, $2, $3, $4, 'done') returning id`,
      [teamId, versionId, task, source]), 'the run').id
    const instance = must(await one('select id from instances where team_id = $1 and kind = $2', [teamId, 'mac']), 'the mac').id
    const session = must(await one(`insert into sessions (team_id, task_id, instance_id, agent_id, stage) values ($1, $2, $3, $4, $5) returning id`,
      [teamId, task, instance, agent, stage]), 'the stage session').id
    await pool.query(`insert into run_stages (team_id, run_id, n, stage, attempt, kind, status, session_id) values ($1, $2, 1, $3, 1, 'agent', 'done', $4)`,
      [teamId, run, stage, session])
    await tx((client) => appendEvents(client, session, { events: [{ clientId: randomUUID(), kind: 'user', text: `Run the ${stage} stage.`, body: {} }] }))
    return { run: String(run), session: String(session) }
  }
  const pipelineRun = await stageSession(nightly.versionId, fixer, 'tests')
  await agentSays(pipelineRun.session, 'The tests pass, so I pushed the fix.')
  await tx((client) => sendToSession(client, bob, pipelineRun.session, 'Always run the tests first, before you push anything.'))
  const learnerRun = await stageSession(learner.versionId, fixer, 'read')
  await agentSays(learnerRun.session, 'Please use British English in every reply.')
  const otherRun = await stageSession(learner.versionId, fixer, 'read')
  await agentSays(otherRun.session, 'Please use British English in every reply.')

  // Carol's session on a box.
  const main = must(await one(`insert into conversations (team_id, kind, agent_id) values ($1, 'main', $2) returning id`, [teamId, fixer]), 'main').id
  const boxSession = String(must(await one(`insert into sessions (team_id, conversation_id, instance_id, agent_id) values ($1, $2, $3, $4) returning id`,
    [teamId, main, box, fixer]), 'the box session').id)
  await tx((client) => appendEvents(client, boxSession, { events: [{ clientId: randomUUID(), kind: 'user', text: 'Ship the cart fix', body: {} }] }, carol.id))
  await agentSays(boxSession, 'Shipped the cart fix without running anything.')
  await tx((client) => appendEvents(client, boxSession, { events: [{ clientId: randomUUID(), kind: 'user', text: 'Always run the tests first, please.', body: {} }] }, carol.id))

  // Sessions that must never be read: a replay, a private conversation, one still
  // in use, and one past the 90 days.
  const replay = await stageSession(nightly.versionId, fixer, 'tests', 'replay')
  await agentSays(replay.session, 'Please use British English, colour not color.')
  const hidden = must(await one(`insert into conversations (team_id, kind, agent_id, visibility) values ($1, 'main', $2, 'private') returning id`, [teamId, fixer]), 'private').id
  const mac = must(await one('select id from instances where team_id = $1 and kind = $2', [teamId, 'mac']), 'the mac').id
  const privateSession = String(must(await one(`insert into sessions (team_id, conversation_id, instance_id, agent_id) values ($1, $2, $3, $4) returning id`,
    [teamId, hidden, mac, fixer]), 'the private session').id)
  await tx((client) => appendEvents(client, privateSession, { events: [{ clientId: randomUUID(), kind: 'user', text: 'Please use British English, colour not color.', body: {} }] }, carol.id))
  const busy = await tx((client) => startTask(client, alice, { title: 'Tidy the cart', instructions: 'Make the cart code shorter.', agentId: fixer }))
  await agentSays(busy.sessionId, 'I rewrote the whole cart module in three long paragraphs.')
  await tx((client) => sendToSession(client, alice, busy.sessionId, 'Keep it to one line, please.'))
  const oldDm = await dm(carol, 'Write the release note for 0.9', 'Release note: added color themes.', 'Please use British English, colour not color.')
  await pool.query(`update sessions set last_active_at = now() - interval '100 days' where id = $1`, [oldDm.session])

  // Sessions are read once they have been quiet for half an hour.
  const quiet = [aliceDm.session, bobDm.session, roomSession, pipelineRun.session, learnerRun.session, otherRun.session, boxSession, replay.session, privateSession]
  await pool.query(`update sessions set last_active_at = now() - interval '2 hours' where id = any($1)`, [quiet])

  const first = await pickSessions(pool, teamId, fixer)
  const picked = new Map(first.picked.map((p) => [String(p.sessionId), p]))
  check(picked.size === 5 && [aliceDm.session, bobDm.session, roomSession, pipelineRun.session, boxSession].every((s) => picked.has(s)),
    `pick reads the people's DMs, the room, the pipeline's stage session and the box session: ${first.picked.map((p) => p.sessionId).join(', ')}`)
  check(!picked.has(learnerRun.session) && !picked.has(replay.session), "pick never reads a learning pipeline's session or a replay")
  check(!picked.has(privateSession) && !picked.has(busy.sessionId) && !picked.has(oldDm.session),
    'pick never reads a private session, one still in use, or one past 90 days')
  check(picked.get(aliceDm.session)?.source === 'person' && picked.get(roomSession)?.source === 'person'
    && picked.get(pipelineRun.session)?.source === 'pipeline' && picked.get(boxSession)?.source === 'box',
  "each session's source is person, pipeline or box")
  const aliceStep = await stepOf(aliceDm.session, 'British English')
  check(first.prompt.includes(`session ${aliceDm.session}`) && first.prompt.includes(`${aliceStep}. ${aliceLogin}: No, write it in British English:`)
    && first.prompt.includes(`rule ${rule('Keep replies short')}: - Keep replies short.`),
  'the transcript names each session, numbers each step, and lists the rules by hash')

  // The reader's report, with bad findings among the good ones.
  const runId = RunId.parse(learnerRun.run)
  const report = {
    findings: [
      { kind: 'gap', session: aliceDm.session, step: aliceStep, quote: 'British English: colour, not color', correction: 'Write in British English.', same: 'british-a', fix: 'text' },
      { kind: 'gap', session: bobDm.session, step: await stepOf(bobDm.session, 'Please use British'), quote: 'Please use British English', correction: 'Use British spelling.', same: 'british-b', fix: 'text' },
      { kind: 'gap', session: bobDm.session, step: await stepOf(bobDm.session, 'Please use British'), quote: 'Please use American English', correction: 'Use American spelling.', same: 'american', fix: 'text' },
      { kind: 'gap', session: bobDm.session, step: await stepOf(bobDm.session, 'Please use British'), quote: 'colour', correction: 'Spell colour.', same: 'colour', fix: 'text' },
      { kind: 'gap', session: privateSession, step: 1, quote: 'Please use British English', correction: 'Use British spelling.', same: 'british-b', fix: 'text' },
      { kind: 'gap', session: bobDm.session, step: 999, quote: 'Please use British English', correction: 'Use British spelling.', same: 'british-b', fix: 'text' },
      { kind: 'followed', session: aliceDm.session, step: await stepOf(aliceDm.session, 'color picker'), quote: 'Release note: added a color picker.', rule: rule('Keep replies short') },
      { kind: 'ignored', session: aliceDm.session, step: await stepOf(aliceDm.session, 'color picker'), quote: 'Release note: added a color picker.', rule: 'abcdefabcdef' },
      { kind: 'gap', session: roomSession, step: await stepOf(roomSession, 'keep it to one line'), quote: 'keep it to one line next time', correction: 'Answer in one line.', same: 'one-line', fix: 'text' },
      { kind: 'gap', session: pipelineRun.session, step: await stepOf(pipelineRun.session, 'Always run the tests'), quote: 'Always run the tests first, before you push', correction: 'Run the tests before pushing.', same: 'tests', fix: 'check' },
      { kind: 'gap', session: boxSession, step: await stepOf(boxSession, 'Always run the tests'), quote: 'Always run the tests first, please.', correction: 'Run the tests before shipping.', same: 'tests', fix: 'check' },
      { kind: 'gap', session: bobDm.session, step: 2, correction: 'No quote at all.', same: 'nothing', fix: 'text' },
    ],
  }
  const recorded = await tx((client) => recordFindings(client, { teamId, runId, agentId: fixer, picked: first.picked, report }))
  const reasons = recorded.dropped.map((d) => d.reason)
  check(recorded.kept.length === 6, `six findings are kept: ${recorded.kept.length}`)
  check(reasons.some((r) => r.includes('not in step')) && reasons.filter((r) => r.includes('not in step')).length === 1,
    `a quote that is not in its event is dropped: ${reasons.join(' | ')}`)
  check(reasons.some((r) => r.includes('shorter than 12')), 'a quote shorter than 12 characters is dropped')
  check(reasons.some((r) => r.includes('not one of the sessions read')), 'a finding citing a session nobody picked is dropped')
  check(reasons.some((r) => r.includes('step 999 of session') && r.includes('not among the steps this run read')),
    'a finding citing a step this run did not read is dropped')
  check(reasons.some((r) => r.includes('no rule abcdefabcdef')), 'a finding about a rule the agent does not have is dropped')
  check(reasons.some((r) => r.startsWith('not a finding')), 'a finding missing its quote is dropped')
  check(recorded.dropped.length === 6, `six findings are dropped: ${recorded.dropped.length}`)
  const roomFinding = await one(`select person_id, source from session_findings where session_id = $1`, [roomSession])
  check(roomFinding?.person_id === alice.id && roomFinding.source === 'person', "a correction in a room counts as the person who posted it")
  const pipeFinding = await one(`select person_id, source, occasion from session_findings where session_id = $1`, [pipelineRun.session])
  check(pipeFinding?.person_id === bob.id && pipeFinding.source === 'pipeline' && pipeFinding.occasion === pipelineRun.run,
    "a stage session's finding counts once for its run")

  // Candidates.
  const byCorrection = async (words: string) => (await candidatesOf(pool, fixer)).find((c) => c.correction.includes(words))
  const britA = must(await byCorrection('Write in British English'), 'the British candidate from Alice')
  const britB = must(await byCorrection('Use British spelling'), 'the British candidate from Bob')
  check(!britA.ready && britA.counts.sessions === 1 && !britB.ready,
    `one session never makes a candidate ready: ${JSON.stringify(britA.counts)}`)
  const oneLine = must(await byCorrection('Answer in one line'), 'the one-line candidate')
  check(!oneLine.ready && oneLine.counts.sessions === 1, 'the room correction alone is not ready')
  const tests = must(await byCorrection('Run the tests before pushing'), 'the tests candidate')
  check(tests.ready && tests.counts.sessions === 2 && tests.counts.people === 2
    && tests.counts.bySource.pipeline === 1 && tests.counts.bySource.box === 1 && tests.counts.bySource.person === 0,
  `a pipeline session and a box session from two people make a candidate, counted apart: ${JSON.stringify(tests.counts)}`)
  check(tests.route.kind === 'check', `a correction a check could catch goes to a check: ${JSON.stringify(tests.route)}`)
  check(!(await candidatesOf(pool, fixer)).some((c) => c.correction.includes('American')), 'a dropped finding makes no candidate')

  // Each event is read once. Nothing new means nothing to read.
  const again = await pickSessions(pool, teamId, fixer)
  check(again.picked.length === 0, `a second pick finds nothing new: ${again.picked.map((p) => p.sessionId).join(', ')}`)

  // New events, and the busy task, which has gone quiet.
  await tx((client) => sendPersonMessage(client, alice, aliceDm.conversation, 'For release notes, put the newest change first.', randomUUID()))
  await tx((client) => sendPersonMessage(client, bob, bobDm.conversation, 'Release notes go newest first, always.', randomUUID()))
  await pool.query(`update sessions set last_active_at = now() - interval '2 hours' where id = any($1)`, [[aliceDm.session, bobDm.session, busy.sessionId]])
  const second = await pickSessions(pool, teamId, fixer)
  const secondPicked = new Map(second.picked.map((p) => [String(p.sessionId), p]))
  const aliceRead: number = must(await one('select read_to_seq::int as seq from session_reads where session_id = $1', [aliceDm.session]), "Alice's read").seq
  check(secondPicked.size === 3 && secondPicked.has(busy.sessionId) && secondPicked.get(aliceDm.session)?.fromSeq === aliceRead + 1
    && second.prompt.includes(`candidate ${britA.id}`),
  'the next pick reads only what is new, and lists the open candidates')

  const improver = must(await one(`select id from agents where team_id = $1 and name = 'improver'`, [teamId]), 'improver').id
  const othersCandidate = must(await one(`insert into candidates (team_id, agent_id, correction) values ($1, $2, 'Reply in French.') returning id`,
    [teamId, improver]), "improver's candidate").id
  const report2 = {
    findings: [
      { kind: 'gap', session: aliceDm.session, step: aliceStep, quote: 'British English: colour, not color', correction: 'Write in British English.', candidate: britA.id, fix: 'text' },
      { kind: 'gap', session: bobDm.session, step: await stepOf(bobDm.session, 'newest first'), quote: 'Release notes go newest first', correction: 'Newest first.', candidate: othersCandidate, fix: 'text' },
      { kind: 'gap', session: busy.sessionId, step: await stepOf(busy.sessionId, 'Keep it to one line'), quote: 'Keep it to one line, please.', correction: 'Answer in one line.', candidate: oneLine.id, fix: 'text' },
      { kind: 'gap', session: aliceDm.session, step: await stepOf(aliceDm.session, 'newest change first'), quote: 'put the newest change first', correction: 'List the newest change first in release notes.', same: 'newest', fix: 'text', when: 'writing release notes' },
      { kind: 'gap', session: bobDm.session, step: await stepOf(bobDm.session, 'newest first'), quote: 'Release notes go newest first', correction: 'Newest first.', same: 'newest', fix: 'text', when: 'writing release notes' },
      { kind: 'gap', session: bobDm.session, step: await stepOf(bobDm.session, 'newest first'), quote: 'Release notes go newest first', correction: 'Newest first.', candidate: randomUUID(), fix: 'text' },
    ],
    merges: [[britA.id, britB.id], [britA.id, randomUUID()]],
  }
  const recorded2 = await tx((client) => recordFindings(client, { teamId, runId, agentId: fixer, picked: second.picked, report: report2 }))
  check(recorded2.dropped.filter((d) => d.reason.includes('names no open candidate')).length === 2,
    "a gap naming a candidate that does not exist, or another agent's, is dropped")
  check(recorded2.dropped.some((d) => d.reason.includes('merge')), 'a merge naming a candidate that does not exist is refused')
  check(recorded2.dropped.some((d) => d.reason.includes(`step ${aliceStep} of session ${aliceDm.session} is not among the steps this run read`))
    && second.prompt.includes('(read before, for context only)'),
  'a step read before is shown for context, and a finding citing it is dropped')
  const merged = must(await byCorrection('Write in British English'), 'the merged British candidate')
  check(merged.ready && merged.counts.sessions === 2 && merged.counts.people === 2 && merged.counts.bySource.person === 2
    && !(await candidatesOf(pool, fixer)).some((c) => c.id === britB.id),
  `the reader judged the two British candidates one, and code merged them: ${JSON.stringify(merged.counts)}`)
  check(merged.route.kind === 'instructions', 'a correction from two people with no check or trigger goes to the instructions')
  const oneLineNow = must(await byCorrection('Answer in one line'), 'the one-line candidate')
  check(oneLineNow.ready && oneLineNow.counts.sessions === 2 && oneLineNow.counts.people === 1
    && oneLineNow.route.kind === 'profile' && oneLineNow.route.personId === alice.id,
  `one person's correction in two sessions goes to that person's profile: ${JSON.stringify(oneLineNow)}`)
  const newest = must(await byCorrection('newest change first'), 'the release-notes candidate')
  check(newest.ready && newest.route.kind === 'skill' && newest.route.trigger === 'writing release notes',
    `a narrow correction with a trigger becomes a skill: ${JSON.stringify(newest.route)}`)

  // Findings count for 90 days.
  await pool.query(`update session_findings set seen_at = now() - interval '91 days' where session_id = $1`, [pipelineRun.session])
  const fading = must(await byCorrection('Run the tests before pushing'), 'the tests candidate')
  check(!fading.ready && fading.counts.sessions === 1, 'a finding older than 90 days no longer counts')
  await pool.query(`update session_findings set seen_at = now() - interval '91 days' where session_id = $1`, [boxSession])
  check(!(await byCorrection('Run the tests before pushing')), 'a candidate with no live findings is gone')

  // Improve's study cites a pipeline's runs.
  const nightlyId = PipelineId.parse(nightly.pipelineId)
  const study = {
    findings: [
      { kind: 'ignored', session: pipelineRun.session, step: await stepOf(pipelineRun.session, 'I pushed the fix'), quote: 'The tests pass, so I pushed the fix.', note: 'It pushed before a person asked it to run the tests.' },
      { kind: 'gap', session: otherRun.session, step: await stepOf(otherRun.session, 'British English'), quote: 'Please use British English in every reply.', note: 'A run of another pipeline.' },
      { kind: 'gap', session: replay.session, step: await stepOf(replay.session, 'Please use British'), quote: 'Please use British English', note: 'A replay.' },
      { kind: 'gap', session: pipelineRun.session, step: await stepOf(pipelineRun.session, 'I pushed the fix'), quote: 'The tests failed, so I stopped.', note: 'An invented quote.' },
    ],
  }
  const studied = await tx((client) => recordStudyFindings(client, { teamId, runId, pipelineId: nightlyId, report: study }))
  check(studied.kept.length === 1 && studied.dropped.length === 3
    && studied.dropped.some((d) => d.reason.includes('not a run of nightly')) && studied.dropped.some((d) => d.reason.includes('not in step')),
  `improve's study keeps only quotes found in this pipeline's own runs: ${studied.dropped.map((d) => d.reason).join(' | ')}`)
  const ownRun = RunId.parse(pipelineRun.run)
  const own = await tx((client) => recordStudyFindings(client, { teamId, runId: ownRun, pipelineId: nightlyId, report: { findings: [study.findings[0]] } }))
  check(own.kept.length === 0 && own.dropped.some((d) => d.reason.includes("the study's own")), "a study's own run is not evidence")
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack}`)
} finally {
  if (!failures.length) await pool.query('delete from teams where name = $1', [team]).catch(() => {})
  await pool.end().catch(() => {})
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test team removed)'}`)
process.exit(failures.length ? 1 : 0)
