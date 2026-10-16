// History, the record. A person lists every session they may see, newest first,
// searches the text of steps, and reads one session's steps in the order they
// happened. Private conversations, tasks and folders are left out of the list, the
// search and the replay for anyone they are private from, and the rules are the
// ones the app's other reads use. The replay's moves are checked as plain
// functions, and agents' search_record is shown unchanged. step26b drives the app.
//   node --env-file=.env --env-file=.env.test test/step26.ts

import {
  BIG_END, BIG_RESULT, buildWorld, TEXT_COLUMN, WORDS, type World,
} from './history-kit.ts'
import { snippetParts, MARK_END, MARK_START, STEPS_SPAN_MAX } from '../shared/history.ts'
import type { Row } from '@electric-sql/client'
import type { Step, StepsPage } from '../shared/history.ts'
import { AHEAD, MAX_LOADED, PAGE, OPEN_BEFORE, playbackDelay, reduce, START, type Bounds, type Move, type Replay } from '../shared/replay.ts'

// Ports 8180 to 8182 are this check's: machines, people, streams.
const PORTS = { machines: 8180, people: 8181, streams: 8182 }
const started = Date.now()
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const world: World = await buildWorld('hist', PORTS)
const { sessions, logins, long } = world
const [ava, ben, cleo] = [world.as(logins.ava), world.as(logins.ben), world.as(logins.cleo)]
const idOf = new Map(Object.entries(sessions).map(([name, id]) => [id, name]))
const names = (ids: string[]) => ids.map((id) => idOf.get(id) ?? id)

// Pages of a list or a search, followed to the end.
async function everyPage(person: ReturnType<typeof world.as>, path: string, key: 'sessions' | 'hits', limit: number) {
  const items: any[] = []
  const sizes: number[] = []
  let before: string | null = null
  for (let page = 0; page < 200; page++) {
    const joined: string = `${path}${path.includes('?') ? '&' : '?'}limit=${String(limit)}${before ? `&before=${encodeURIComponent(before)}` : ''}`
    const answer = await person.json(joined)
    if (answer.status !== 200) throw new Error(`${joined}: ${String(answer.status)} ${JSON.stringify(answer.body)}`)
    items.push(...answer.body[key])
    sizes.push(answer.body[key].length)
    before = answer.body.next
    if (before === null) return { items, sizes }
  }
  throw new Error(`${path} never ended`)
}
const listed = async (person: ReturnType<typeof world.as>, query = '') => (await everyPage(person, `/v1/history${query ? `?${query}` : ''}`, 'sessions', 100)).items
const found = async (person: ReturnType<typeof world.as>, query: string) => (await everyPage(person, `/v1/search?${query}`, 'hits', 100)).items
const idsOf = (rows: any[]) => rows.map((row) => row.id as string)
// A row of a shape, by its id.
const idString = (row: Row): string => {
  if (typeof row.id !== 'string') throw new Error('a row of a shape has no id')
  return row.id
}
const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set([...a, ...b]).size === a.length

try {
  // ---- The list
  const everything = ['long', 'privateTerminal', 'terminal', 'run', 'privateTask', 'task', 'privateDm', 'room', 'dm', 'old'] as const
  const avaList = await listed(ava)
  check(JSON.stringify(names(idsOf(avaList))) === JSON.stringify(everything), `Ava's list holds her ten sessions, the one active most recently first (${names(idsOf(avaList)).join(', ')})`)
  const benList = await listed(ben)
  check(JSON.stringify(names(idsOf(benList))) === JSON.stringify(['long', 'bensTerminal', 'terminal', 'run', 'task', 'room', 'dm', 'old']),
    `Ben's list leaves out Ava's private conversation, task and folder, and adds his own folder (${names(idsOf(benList)).join(', ')})`)
  const cleoList = await listed(cleo)
  check(JSON.stringify(names(idsOf(cleoList))) === JSON.stringify(['long', 'terminal', 'run', 'task', 'room', 'dm', 'old']),
    `Cleo's list has the team's sessions and no private one (${names(idsOf(cleoList)).join(', ')})`)

  const row = (name: keyof typeof sessions) => avaList.find((s) => s.id === sessions[name])
  const dm = row('dm')
  check(dm?.subject.kind === 'conversation' && dm.subject.conversation === 'dm' && JSON.stringify(dm.subject.people) === JSON.stringify([logins.ava]),
    'a direct message names the people in it')
  check(dm?.agent.name === 'scout' && dm.person.login === logins.ava && dm.machine.startsWith('ava-mac-') && dm.status === 'idle',
    'a row names its agent, the person who started it, its machine and its status')
  check(dm?.steps === 8 && dm.errors === 2 && dm.asked === 'Find the flaky webhook test, quokka suspects it' && dm.private === false,
    'a row counts its steps and the ones that went wrong, and quotes what was first asked')
  const longRow = row('long')
  check(longRow?.subject.kind === 'terminal' && longRow.subject.path === '/Users/ava/shop' && longRow.subject.cwd === '/Users/ava/shop/tools'
    && longRow.agent === null && longRow.person.login === logins.ava && longRow.steps === long.last && longRow.errors === long.errors.length,
  'a terminal session has a folder, a person and no agent')
  const task = row('task')
  check(task?.subject.kind === 'task' && task.subject.title === 'Fix the checkout total' && task.project.name === 'Launch'
    && JSON.stringify(task.repos) === JSON.stringify(['https://github.com/acme/shop']), 'a task names its project and its repos')
  const runRow = row('run')
  check(runRow?.subject.kind === 'run' && runRow.subject.pipeline === 'bug-fix' && runRow.subject.replay === false && runRow.stage === 'fix' && runRow.stage_outcome === 'fixed',
    'a run names its pipeline, its stage and what the stage reported')
  const room = row('room')
  check(room?.subject.kind === 'conversation' && room.subject.conversation === 'room' && room.subject.name === 'launch' && room.person === null && room.project.name === 'Launch',
    'a room has a name, no one person, and its project')
  check(['privateDm', 'privateTask', 'privateTerminal'].every((name) => row(name as keyof typeof sessions)?.private === true) && !avaList.filter((s) => s.private).some((s) => s.id === sessions.dm),
    'a private session says so, to the people who may see it')
  const old = row('old')
  check(old !== undefined && Date.now() - new Date(old.last_active_at.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).getTime() > 2 * 86_400_000, 'the old session was last active days ago')

  // The sessions the app's own shapes give each person, which are read by rules of their own.
  for (const person of [ava, ben, cleo]) {
    const shapes = (await Promise.all(['conversations', 'tasks', 'folders'].map((of) => world.shapeRows(person.login, 'sessions', { of })))).flat()
    const mine = idsOf(await listed(person))
    check(sameSet(mine, shapes.map(idString)), `${person.login.split('-')[0]}: the list holds the sessions the app's other reads give, and no other (${String(mine.length)})`)
    const verdicts: boolean[] = []
    for (const id of Object.values(sessions)) {
      const res = await fetch(`${world.people}/v1/shape/events?offset=-1&session=${id}`, { headers: { 'tailscale-user-login': person.login } })
      await res.body?.cancel()
      verdicts.push((res.status === 200) === mine.includes(id))
    }
    check(verdicts.every(Boolean), `${person.login.split('-')[0]}: a session is in the list exactly when the app lets them read its steps (${String(verdicts.length)} sessions)`)
  }

  // Filters
  const only = async (person: typeof ava, query: string) => names(idsOf(await listed(person, query)))
  check(JSON.stringify(await only(ava, `agent=${world.ids.scout}`)) === JSON.stringify(['run', 'task', 'room', 'dm']), 'the agent filter keeps scout\'s sessions')
  check(JSON.stringify(await only(ava, `agent=${world.ids.fixer}`)) === JSON.stringify(['privateTask', 'privateDm']), 'the agent filter keeps fixer\'s sessions')
  check(JSON.stringify(await only(ava, `person=${world.ids.ava}`)) === JSON.stringify(['long', 'privateTerminal', 'terminal', 'run', 'privateTask', 'task', 'privateDm', 'dm', 'old']),
    'the person filter keeps the sessions a person started')
  check(JSON.stringify(await only(ben, `person=${world.ids.ben}`)) === JSON.stringify(['bensTerminal']), 'a person\'s own private folder shows to them under the person filter')
  check(JSON.stringify(await only(ava, `person=${world.ids.ben}`)) === '[]', 'and not to Ava, who may not see it')
  check(JSON.stringify(await only(ava, 'kind=terminal')) === JSON.stringify(['long', 'privateTerminal', 'terminal', 'old']), 'the kind filter keeps terminal sessions')
  check(JSON.stringify(await only(ava, 'kind=conversation')) === JSON.stringify(['privateDm', 'room', 'dm']), 'and conversations')
  check(JSON.stringify(await only(ava, 'kind=task')) === JSON.stringify(['privateTask', 'task']), 'and tasks that no pipeline started')
  check(JSON.stringify(await only(ava, 'kind=run')) === JSON.stringify(['run']), 'and runs')
  check(JSON.stringify(await only(ava, `project=${world.ids.project}`)) === JSON.stringify(['task', 'room']), 'the project filter keeps a project\'s task and room')
  check(JSON.stringify(await only(ava, `repo=${world.ids.repo}`)) === JSON.stringify(['task']), 'the repo filter keeps the tasks in a repo')
  check(JSON.stringify(await only(ava, `agent=${world.ids.scout}&kind=conversation`)) === JSON.stringify(['room', 'dm']), 'filters combine')
  const day = (d: Date) => ({ since: new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString(), until: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString() })
  const today = day(new Date())
  const ago = new Date()
  ago.setDate(ago.getDate() - 3)
  const threeDaysAgo = day(ago)
  check((await only(ava, `since=${today.since}&until=${today.until}`)).join() === everything.filter((n) => n !== 'old').join(), 'the day filter keeps the sessions active that day')
  check(JSON.stringify(await only(ava, `since=${threeDaysAgo.since}&until=${threeDaysAgo.until}`)) === JSON.stringify(['old']), 'and the old session shows on its own day')

  // Paging
  const paged = await everyPage(ava, '/v1/history', 'sessions', 3)
  check(JSON.stringify(names(idsOf(paged.items))) === JSON.stringify(everything) && JSON.stringify(paged.sizes) === JSON.stringify([3, 3, 3, 1]),
    `three at a time, the pages join into the whole list with none twice (${paged.sizes.join(', ')})`)

  // ---- Search
  const hitsOf = async (person: typeof ava, words: string, more = '') => await found(person, `q=${encodeURIComponent(words)}${more}`)
  const sessionsOf = (hits: any[]) => [...new Set(hits.map((h) => names([h.session.id])[0]))]
  const zanzibar = await hitsOf(ava, WORDS.terminal)
  check(sessionsOf(zanzibar).sort().join() === 'privateTerminal,terminal' && zanzibar.length === 4, 'Ava finds a word from a terminal session in her team folder and in her private one')
  const benZanzibar = await hitsOf(ben, WORDS.terminal)
  check(sessionsOf(benZanzibar).join() === 'terminal' && benZanzibar.length === 3, 'Ben finds it in the team folder only')
  check(sessionsOf(await hitsOf(cleo, WORDS.terminal)).join() === 'terminal', 'and so does Cleo')
  check((await hitsOf(ben, WORDS.privateTerminal)).length === 0 && (await hitsOf(cleo, WORDS.privateTerminal)).length === 0 && (await hitsOf(ava, WORDS.privateTerminal)).length === 1,
    'a word only in Ava\'s private folder is found by Ava and by no one else')
  check((await hitsOf(ben, WORDS.privateDm)).length === 0 && (await hitsOf(ben, WORDS.privateTask)).length === 0 && (await hitsOf(ava, WORDS.privateDm)).length === 1
    && (await hitsOf(ava, WORDS.privateTask)).length === 1, 'words from a private conversation and a private task are found only by their people')
  check((await hitsOf(ava, WORDS.bensTerminal)).length === 0 && (await hitsOf(ben, WORDS.bensTerminal)).length === 1, 'and Ben\'s private folder is Ben\'s alone')
  const quokka = await hitsOf(ava, WORDS.dm)
  check(quokka.length === 3 && quokka.map((h) => h.kind).sort().join() === 'tool_call,tool_result,user', 'a word is found in a message, a tool call and a result')
  check(quokka.every((h) => h.seq > 0 && h.session.id === sessions.dm && h.snippet.includes(`${MARK_START}${WORDS.dm}${MARK_END}`)), 'each result names its session and step, and marks the words that matched')
  const inScope = async (scope: string, words = WORDS.dm) => (await hitsOf(ava, words, `&scope=${scope}`)).map((h) => h.kind).sort().join()
  check(await inScope('messages') === 'user' && await inScope('tools') === 'tool_call,tool_result' && await inScope('all') === 'tool_call,tool_result,user',
    'a search can read only messages, only tool calls and results, or every step')
  check(await inScope('errors') === 'tool_result' && await inScope('errors', 'room') === 'error' && await inScope('errors', WORDS.all) === '',
    'or only the steps that went wrong: a failed result, an error')
  check((await hitsOf(ben, WORDS.privateDm, '&scope=messages')).length === 0 && (await hitsOf(ben, WORDS.privateTerminal, '&scope=all')).length === 0
    && (await ava.json(`/v1/search?q=a&scope=everything`)).status === 400, 'a scope narrows a search and widens no one\'s access, and a scope that does not exist is refused')
  const bash = quokka.find((h) => h.kind === 'tool_call')
  check(bash?.tool_name === 'Bash' && bash.session.agent.name === 'scout', 'a tool call result names its tool and its agent')
  check(JSON.stringify(zanzibar.map((h) => [h.created_at, h.seq])) === JSON.stringify([...zanzibar].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((h) => [h.created_at, h.seq])),
    'results come newest first')
  check((await hitsOf(ava, 'hook_started')).length === 0 && (await hitsOf(ava, 'hook')).length === 0, 'bookkeeping notices are not steps, so they are not found')
  const init = await hitsOf(ava, 'init')
  check(init.length === 1 && init[0].kind === 'notice' && init[0].session.id === sessions.long, 'a session\'s start notice is a step, so it is found')
  const everyone = await hitsOf(ava, WORDS.all)
  check(sameSet(sessionsOf(everyone).map((n) => sessions[n as keyof typeof sessions]), idsOf(avaList)) && everyone.length === avaList.length,
    'one word every session says is found once in every session the list shows')
  for (const person of [ben, cleo]) {
    const mine = await hitsOf(person, WORDS.all)
    check(sameSet(mine.map((h) => h.session.id), idsOf(await listed(person))), `${person.login.split('-')[0]}: a search finds a word in the sessions of their list and in no other`)
  }
  check(sessionsOf(await hitsOf(ava, WORDS.terminal, '&kind=terminal')).sort().join() === 'privateTerminal,terminal' && (await hitsOf(ava, WORDS.terminal, '&kind=conversation')).length === 0,
    'the kind filter narrows a search')
  check((await hitsOf(ava, WORDS.dm, `&agent=${world.ids.fixer}`)).length === 0 && (await hitsOf(ava, WORDS.dm, `&agent=${world.ids.scout}`)).length === 3, 'and the agent filter')
  check(sessionsOf(await hitsOf(ava, WORDS.old, `&since=${threeDaysAgo.since}&until=${threeDaysAgo.until}`)).join() === 'old' && (await hitsOf(ava, WORDS.old, `&since=${today.since}&until=${today.until}`)).length === 0,
    'and the day, which is the day of the step')
  const marmots = await ava.json(`/v1/search?q=${WORDS.long}&limit=100`)
  const expectedMarmots = Number((await world.db.query(
    `select count(*)::int as n from events where session_id = $1 and kind <> 'usage' and kind <> 'notice' and text ~* $2`, [sessions.long, WORDS.long])).rows[0].n)
  const pagedHits = await everyPage(ava, `/v1/search?q=${WORDS.long}`, 'hits', 7)
  check(pagedHits.items.length === expectedMarmots && new Set(pagedHits.items.map((h: any) => h.seq)).size === expectedMarmots && pagedHits.sizes.slice(0, -1).every((n) => n === 7),
    `seven at a time, a search pages through its ${String(expectedMarmots)} results with none twice`)
  check(pagedHits.items.every((h: any, i: number) => i === 0 || h.seq < pagedHits.items[i - 1].seq), 'in the order the steps happened, last first')
  check(marmots.body.hits.length === 100 && marmots.body.next !== null, 'a page is at most the limit asked for')
  check((await ava.json('/v1/search')).status === 400 && (await ava.json('/v1/search?q=')).status === 400 && (await ava.json(`/v1/search?q=${'x'.repeat(301)}`)).status === 400,
    'a search needs words, and not more than 300 characters of them')
  check((await ava.json(`/v1/search?q=a&limit=0`)).status === 400 && (await ava.json(`/v1/search?q=a&limit=101`)).status === 400 && (await ava.json(`/v1/search?q=a&agent=nobody`)).status === 400
    && (await ava.json(`/v1/search?q=a&before=nonsense`)).status === 400 && (await ava.json(`/v1/history?since=yesterday`)).status === 400, 'a limit, a filter and a cursor that do not fit are refused')
  check((await ava.json('/v1/search?q=the')).body.hits.length === 0, 'words that are all too common to search on find nothing, and are not an error')

  // ---- A session's steps
  const view = await ava.json(`/v1/history/sessions/${sessions.long}`)
  check(view.status === 200 && view.body.first_seq === 1 && view.body.last_seq === long.last && JSON.stringify(view.body.errors) === JSON.stringify(long.errors)
    && view.body.errors_total === long.errors.length, 'a session says which steps it has and which of them went wrong')
  check(view.body.session.id === sessions.long && view.body.session.subject.kind === 'terminal', 'and what it was')
  const whole: Step[] = []
  let at = 1
  let spans = 0
  while (at <= long.last) {
    const to = at + STEPS_SPAN_MAX - 1
    const page: { status: number; body: StepsPage } = await ava.json(`/v1/history/sessions/${sessions.long}/steps?from=${String(at)}&to=${String(to)}`)
    if (page.status !== 200) throw new Error(`steps ${String(at)}..${String(to)}: ${String(page.status)}`)
    whole.push(...page.body.steps)
    spans++
    at = to + 1
  }
  check(whole.length === long.shown && whole.every((s, i) => i === 0 || s.seq > (whole[i - 1]?.seq ?? 0)), `read in ranges of 100, the steps join in order with none twice (${String(whole.length)} steps in ${String(spans)} ranges)`)
  check(long.hidden.every((seq) => !whole.some((s) => s.seq === seq)) && whole.filter((s) => s.kind === 'notice').length === 1, 'bookkeeping is left out of the steps and leaves gaps in the numbers, and the start notice stays')
  check(JSON.stringify(whole.filter((s) => s.error).map((s) => s.seq)) === JSON.stringify(long.errors), 'the steps marked as having gone wrong are the failed results and the error')
  const text = (s: Step | undefined) => s?.blocks.map((b) => (b.label ? `${b.label}: ${b.text}` : b.text)).join('\n')
  check(text(whole[0]) === 'Model haiku\nFolder /work', 'the start notice shows the model and the folder')
  const call = whole.find((s) => s.kind === 'tool_call')
  check(call !== undefined && text(call) === 'command: echo marmot 3\ndescription: call 3' && call.tool_name === 'Bash', 'a tool call shows each field of its input')
  const result = whole.find((s) => s.kind === 'tool_result')
  check(result !== undefined && text(result) === 'marmot output 4' && result.tool_name === 'Bash', 'a result shows its content, named for the call it answers')
  const bigStep = whole.find((s) => s.seq === long.big)
  const stored = Number((await world.db.query('select length(text)::int as n from events where session_id = $1 and seq = $2', [sessions.long, long.big])).rows[0].n)
  check(stored === TEXT_COLUMN && bigStep?.blocks.length === 1 && bigStep.blocks[0]?.text === BIG_RESULT && BIG_RESULT.length > stored && bigStep.blocks[0].text.endsWith(BIG_END),
    `a result is shown whole (${String(BIG_RESULT.length)} characters), though the text column keeps ${String(stored)}`)
  const last = whole.find((s) => s.kind === 'error')
  check(text(last) === 'The long session ended badly.' && last?.error === true, 'an error shows its words')
  const usage = whole.find((s) => s.kind === 'usage')
  const usageText = text(usage) ?? ''
  check(usageText.startsWith('Took 2.6 s\n3 turns of the model\nSession cost so far $0.00') && usageText.endsWith('Ended: completed'), 'a turn that ended says how long it took and what it cost')
  const tooWide = await ava.json(`/v1/history/sessions/${sessions.long}/steps?from=1&to=${String(STEPS_SPAN_MAX + 1)}`)
  check(tooWide.status === 400 && (await ava.json(`/v1/history/sessions/${sessions.long}/steps?from=5&to=4`)).status === 400
    && (await ava.json(`/v1/history/sessions/${sessions.long}/steps?from=0&to=4`)).status === 400, 'a range of more than 100 numbers, a backward one and one from zero are refused')
  const empty = await ava.json(`/v1/history/sessions/${sessions.long}/steps?from=${String(long.last + 50)}&to=${String(long.last + 60)}`)
  check(empty.status === 200 && empty.body.steps.length === 0, 'a range past the end holds no steps')

  // ---- Who may not
  const privates = ['privateDm', 'privateTask', 'privateTerminal'] as const
  const refused = async (person: typeof ava, id: string) => {
    const a = await person.json(`/v1/history/sessions/${id}`)
    const b = await person.json(`/v1/history/sessions/${id}/steps?from=1&to=5`)
    return a.status === 404 && b.status === 404 && a.body.error === 'no such session' && b.body.error === 'no such session'
  }
  check((await Promise.all(privates.map((n) => refused(ben, sessions[n])))).every(Boolean) && (await Promise.all(privates.map((n) => refused(cleo, sessions[n])))).every(Boolean),
    'Ben and Cleo find Ava\'s private sessions nowhere in the replay')
  check(await refused(ava, sessions.bensTerminal) && await refused(cleo, sessions.bensTerminal), 'and Ben\'s private folder is a session Ava and Cleo cannot open')
  check((await Promise.all(privates.map(async (n) => (await ava.json(`/v1/history/sessions/${sessions[n]}`)).status === 200))).every(Boolean), 'while Ava opens all three')
  check(await refused(ava, '00000000-0000-4000-8000-000000000000') && (await ava.json('/v1/history/sessions/not-an-id')).status === 404, 'a session that is not there reads the same')
  check((await fetch(`${world.people}/v1/history`)).status === 401 && (await world.machine(world.tokens.avaMac, 'GET', '/v1/history')).status === 404
    && (await world.machine(world.tokens.avaMac, 'GET', '/v1/search?q=a')).status === 404, 'a request with no person is refused, and machines have no History')

  // ---- Agents' search_record, as before
  const asAgent = async (words: string) => (await world.machine(world.tokens.avaMac, 'GET', `/v1/record/search?session=${sessions.room}&q=${encodeURIComponent(words)}&limit=20`)).body.hits as any[]
  const zanzibarAgent = await asAgent(WORDS.terminal)
  check(sameSet([...new Set(zanzibarAgent.map((h) => h.session_id))] as string[], [sessions.terminal]) && zanzibarAgent.length === 3 && zanzibarAgent.every((h) => h.source === 'event' && h.snippet.includes(`<b>${WORDS.terminal}</b>`)),
    'an agent searching the record finds the terminal session in the team folder, with its words in bold tags')
  const quokkaAgent = await asAgent(WORDS.dm)
  check(quokkaAgent.length === 4 && quokkaAgent.filter((h) => h.source === 'message').length === 1 && quokkaAgent.filter((h) => h.source === 'event').length === 3,
    'and finds a conversation post as well as the steps')
  check((await asAgent(WORDS.privateTerminal)).length === 0 && (await asAgent(WORDS.privateDm)).length === 0 && (await asAgent(WORDS.privateTask)).length === 0,
    'and finds nothing private')

  // ---- How a replay moves, as plain functions
  const bounds: Bounds = { first: 1, last: 499 }
  const stepAt = (seq: number): Step => ({ seq, kind: 'assistant', tool_name: null, sub: false, error: false, created_at: '2026-10-16 10:00:00+00', blocks: [] })
  // Every number but each fourth is a step, as a session with bookkeeping has.
  const serve = (from: number, to: number): StepsPage => ({ steps: Array.from({ length: to - from + 1 }, (_, i) => from + i).filter((n) => n % 4 !== 0 && n <= 500).map(stepAt), from, to })
  let widest = 0
  const drain = (state: Replay): Replay => {
    let now = state
    while (now.request) {
      widest = Math.max(widest, now.request.to - now.request.from + 1)
      now = reduce(now, { type: 'arrived', id: now.request.id, page: serve(now.request.from, now.request.to), bounds })
    }
    return now
  }
  const drive = (state: Replay, move: Move) => drain(reduce(state, move))
  let replay = drive(START, { type: 'start', bounds, at: null })
  check(replay.cursor === 1 && replay.loaded?.from === 1 && replay.loaded.to === OPEN_BEFORE + PAGE, `a replay opens on the first step with ${String(OPEN_BEFORE + PAGE)} numbers loaded`)
  replay = drive(replay, { type: 'step', direction: 1, bounds })
  replay = drive(replay, { type: 'step', direction: 1, bounds })
  replay = drive(replay, { type: 'step', direction: 1, bounds })
  check(replay.cursor === 5, 'stepping forward skips a number that is no step (1, 2, 3, 5)')
  replay = drive(replay, { type: 'step', direction: -1, bounds })
  check(replay.cursor === 3, 'and back')
  replay = drive(replay, { type: 'play', bounds })
  let ticks = 0
  let bounded = true
  let inside = true
  while (replay.playing && ticks < 2000) {
    replay = drive(replay, { type: 'tick', bounds })
    ticks++
    bounded &&= (replay.loaded?.steps.length ?? 0) <= MAX_LOADED
    inside &&= replay.loaded !== null && replay.loaded.steps.some((s) => s.seq === replay.cursor)
  }
  check(!replay.playing && replay.cursor === 499, `playing runs to the last step and stops there (${String(ticks)} ticks)`)
  check(bounded && inside && widest <= STEPS_SPAN_MAX, `along the way it never keeps more than ${String(MAX_LOADED)} steps, always keeps the current one, and never asks for more than ${String(STEPS_SPAN_MAX)} numbers`)
  replay = drive(replay, { type: 'play', bounds })
  check(replay.playing && replay.cursor === 1, 'playing again from the last step starts over')
  replay = drive(replay, { type: 'pause' })
  check(!replay.playing, 'pausing stops it')
  replay = drive(replay, { type: 'seek', to: 250, bounds })
  check(replay.cursor === 250 && replay.loaded !== null && replay.loaded.from <= 250 && replay.loaded.to >= 250, 'seeking far loads steps around the place and lands on it')
  replay = drive(replay, { type: 'seek', to: 252, bounds })
  check(replay.cursor === 251 || replay.cursor === 253, 'seeking a number that is no step lands on a neighbour')
  const before = replay.cursor ?? 0
  for (let i = 0; i < 100; i++) replay = drive(replay, { type: 'step', direction: -1, bounds })
  check((replay.cursor ?? 0) <= before - 100 && replay.loaded !== null && replay.loaded.steps.some((s) => s.seq === replay.cursor), 'stepping back past the first loaded step loads the steps before it')
  const asked = reduce(START, { type: 'start', bounds, at: 100 })
  const second = reduce(asked, { type: 'seek', to: 400, bounds })
  check(asked.request !== null && second.request !== null && asked.request.id !== second.request.id
    && reduce(second, { type: 'arrived', id: asked.request.id, page: serve(asked.request.from, asked.request.to), bounds }) === second, 'an answer to a request a newer one replaced changes nothing')
  const edge = drive(START, { type: 'start', bounds, at: 499 })
  check(drive(edge, { type: 'step', direction: 1, bounds }).cursor === 499, 'there is no step after the last')
  check(drive(START, { type: 'start', bounds: { first: null, last: null }, at: null }).request === null, 'a session with no steps asks for none')
  const lastFetch = drive(START, { type: 'start', bounds, at: 250 })
  const edged = drive(lastFetch, { type: 'later', bounds })
  check((edged.cursor ?? 0) > (lastFetch.loaded?.to ?? 0) - AHEAD && (edged.loaded?.to ?? 0) > (lastFetch.loaded?.to ?? 0), 'reading on past the loaded steps loads the next page')
  check(playbackDelay(0, 1) === 400 && playbackDelay(1000, 1) === 1000 && playbackDelay(600_000, 1) === 2500 && playbackDelay(1000, 4) === 250 && playbackDelay(0, 8) === 50 && playbackDelay(Number.NaN, 2) === 200,
    'a step stays as long as the time before the next, between 0.4 and 2.5 seconds, divided by the speed')
  check(JSON.stringify(snippetParts(`a ${MARK_START}b${MARK_END} c ${MARK_START}d${MARK_END}`)) === JSON.stringify([{ text: 'a ', hit: false }, { text: 'b', hit: true }, { text: ' c ', hit: false }, { text: 'd', hit: true }]),
    'a snippet splits into the words that matched and the words around them')
  check(snippetParts('<b>not markup</b>').length === 1 && snippetParts('<b>not markup</b>')[0]?.hit === false, 'and markup in it stays text')
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack ?? (error as Error).message}`)
} finally {
  await world.stop(failures.length > 0)
}

console.log(`\n${failures.length ? `${String(failures.length)} failed (team ${world.team} kept)` : 'all passed (test team removed)'} in ${String(Math.round((Date.now() - started) / 1000))} s`)
process.exit(failures.length ? 1 : 0)
