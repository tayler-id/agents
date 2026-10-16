// Watches step26's and step26b's checks fail. First it runs each with nothing broken, as a control. Then for
// each break it copies the files the break touches aside, applies its edits (each anchor must be in its file
// exactly once, or nothing is written), runs the check the break names, and confirms that the check lines the
// break names went red. Last it puts every file back byte for byte and confirms its sha256. A run killed midway
// puts the files back when it next starts. The page check runs in Chromium alone, to keep each break quick.
//   node test/step26-breaks.ts                         the controls, then every break
//   node test/step26-breaks.ts search-without-access   only the breaks named
//   node test/step26-breaks.ts --check                 each anchor is there once, and nothing runs

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const ROOT = new URL('..', import.meta.url).pathname
const WORK = join(ROOT, '.scratch', 'breaks-26')
const BACKUP = join(WORK, 'backup')
const PENDING = join(WORK, 'pending.json')
// step26 takes under a minute and step26b about a minute. A break that leaves something waiting is cut off by the check's own limits.
const RUN_TIMEOUT_MS = 10 * 60 * 1000

type Edit = { file: string; anchor: string; replace: string }
// `check` is the step the break is run through. `red` holds a piece of each check line the break must turn red.
type Break = { name: string; check: '26' | '26b'; why: string; red: string[]; edits: Edit[] }

const ACCESS = 'server/access.ts'
const HISTORY = 'server/history.ts'
const STEPS = 'server/steps.ts'
const RECORD = 'server/teamrecord.ts'
const SHARED = 'shared/history.ts'
const REPLAY = 'shared/replay.ts'
const PAGE = 'app/src/History.tsx'
const PLAYER = 'app/src/Replay.tsx'
const APP = 'app/src/App.tsx'
const CSS = 'app/src/history.css'

const BREAKS: Break[] = [
  // Who may see a session. Each part of the one rule, and each place it is used.
  { name: 'folder-rule-open', check: '26', why: "a private folder's sessions are seen by anyone", red: ["Ben's list leaves out", 'Ben and Cleo find'],
    edits: [{ file: ACCESS, anchor: '  or exists (select 1 from connected_folders where id = s.folder_id and ${VISIBLE_FOLDER}))`', replace: '  or exists (select 1 from connected_folders where id = s.folder_id))`' }] },
  { name: 'conversation-rule-open', check: '26', why: 'a private conversation is seen by anyone', red: ["Ben's list leaves out", 'Ben and Cleo find'],
    edits: [{ file: ACCESS, anchor: '  exists (select 1 from conversations where id = s.conversation_id and ${VISIBLE_CONVERSATION})\n', replace: '  exists (select 1 from conversations where id = s.conversation_id)\n' }] },
  { name: 'task-rule-open', check: '26', why: 'a private task is seen by anyone', red: ["Ben's list leaves out", 'Ben and Cleo find'],
    edits: [{ file: ACCESS, anchor: '  or exists (select 1 from tasks where id = s.task_id and ${VISIBLE_TASK})\n', replace: '  or exists (select 1 from tasks where id = s.task_id)\n' }] },
  { name: 'list-without-access', check: '26', why: 'the list does not ask who may see a session', red: ["Ben's list leaves out", "Cleo's list, an admin's"],
    edits: [{ file: HISTORY, anchor: "`s.status <> 'draft'`, VISIBLE_SESSION, ...ofSession(query, bind),", replace: "`s.status <> 'draft'`, `(${VISIBLE_SESSION} or true)`, ...ofSession(query, bind)," }] },
  { name: 'search-without-access', check: '26', why: 'the search does not ask who may see a session', red: ['Ben finds it in the team folder only', "a word only in Ava's private folder is found by Ava and by no one else"],
    edits: [{ file: HISTORY, anchor: "'e.team_id = $1', 's.archived_at is null', VISIBLE_SESSION, SHOWN_STEP,", replace: "'e.team_id = $1', 's.archived_at is null', `(${VISIBLE_SESSION} or true)`, SHOWN_STEP," }] },
  { name: 'view-without-access', check: '26', why: "a session's header is given to anyone", red: ["Ben and Cleo find Ava's private sessions nowhere in the replay"],
    edits: [{ file: HISTORY, anchor: ' where s.id = $3 and s.team_id = $1 and ${VISIBLE_SESSION}`,', replace: ' where s.id = $3 and s.team_id = $1 and (${VISIBLE_SESSION} or true)`,' }] },
  { name: 'steps-without-access', check: '26', why: "a session's steps are given to anyone", red: ["Ben and Cleo find Ava's private sessions nowhere in the replay"],
    edits: [{ file: HISTORY, anchor: '  if (!(await canSeeSession(person, sessionId))) throw new HttpError(404, NO_SUCH_SESSION)\n', replace: '' }] },
  { name: 'list-other-teams', check: '26', why: "the list holds another team's sessions", red: ["Ava's list holds her ten sessions", 'another team has a list of its own'],
    edits: [{ file: HISTORY, anchor: "'s.team_id = $1', 's.archived_at is null', `s.status <> 'draft'`,", replace: "'(s.team_id = $1 or true)', 's.archived_at is null', `s.status <> 'draft'`," }] },
  { name: 'search-other-teams', check: '26', why: "the search finds another team's steps", red: ['one word every session says is found once in every session the list shows', "a word two teams say is found in a team's own sessions and in no other's"],
    edits: [{ file: HISTORY, anchor: "'e.team_id = $1', 's.archived_at is null', VISIBLE_SESSION,", replace: "'(e.team_id = $1 or true)', 's.archived_at is null', VISIBLE_SESSION," }] },
  { name: 'view-other-teams', check: '26', why: "another team's session header is given", red: ['a person of another team opens none'],
    edits: [{ file: HISTORY, anchor: ' where s.id = $3 and s.team_id = $1 and ${VISIBLE_SESSION}`,', replace: ' where s.id = $3 and (s.team_id = $1 or true) and ${VISIBLE_SESSION}`,' }] },
  { name: 'steps-other-teams', check: '26', why: "another team's steps are given", red: ['a person of another team opens none'],
    edits: [{ file: ACCESS, anchor: 'where s.id = $3 and s.team_id = $1 and ${VISIBLE_SESSION}`', replace: 'where s.id = $3 and (s.team_id = $1 or true) and ${VISIBLE_SESSION}`' }] },
  { name: 'agents-see-private-folders', check: '26', why: "agents' search_record reads a private folder", red: ['and finds nothing private'],
    edits: [{ file: RECORD, anchor: "  or (s.folder_id is not null and f.visibility = 'team'))`", replace: '  or (s.folder_id is not null))`' }] },
  // What a search matches, shared with agents.
  { name: 'every-word-needed', check: '26', why: 'a search needs all its words in one step', red: ['a search finds a step that has any of its words', 'and finds a step that has any of its words'],
    edits: [{ file: RECORD, anchor: "::text, '&', '|')::tsquery", replace: "::text, '&', '&')::tsquery" }] },
  { name: 'markers-are-markup', check: '26', why: 'the words that matched are marked with tags a page would have to read as markup', red: ['each result names its session and step, and marks the words that matched'],
    edits: [{ file: HISTORY, anchor: 'StartSel=${MARK_START}, StopSel=${MARK_END}`', replace: 'StartSel=<b>, StopSel=</b>`' }] },
  { name: 'bookkeeping-found', check: '26', why: 'bookkeeping notices are found by a search', red: ['bookkeeping notices are not steps, so they are not found'],
    edits: [{ file: HISTORY, anchor: 'VISIBLE_SESSION, SHOWN_STEP, OF_SCOPE[query.scope]', replace: 'VISIBLE_SESSION, OF_SCOPE[query.scope]' }] },
  { name: 'scope-ignored', check: '26', why: 'a search reads every step whatever its scope', red: ['a search can read only messages'],
    edits: [{ file: HISTORY, anchor: 'SHOWN_STEP, OF_SCOPE[query.scope], ', replace: 'SHOWN_STEP, ' }] },
  { name: 'messages-scope-wide', check: '26', why: 'reading messages reads tool calls too', red: ['a search can read only messages'],
    edits: [{ file: HISTORY, anchor: "  messages: `e.kind in ('user', 'assistant')`,", replace: '  messages: `true`,' }] },
  { name: 'errors-scope-narrow', check: '26', why: 'the steps that went wrong are only error events', red: ['or only the steps that went wrong', 'the steps marked as having gone wrong'],
    edits: [{ file: HISTORY, anchor: "(e.kind = 'error' or (e.kind = 'tool_result' and e.body->>'isError' = 'true'))", replace: "(e.kind = 'error')" }] },
  // Order and paging.
  { name: 'list-oldest-first', check: '26', why: 'the list puts the oldest first', red: ["Ava's list holds her ten sessions"],
    edits: [{ file: HISTORY, anchor: '     order by ${activeAt} desc, s.id desc\n', replace: '     order by ${activeAt} asc, s.id asc\n' }] },
  { name: 'list-cursor-repeats', check: '26', why: 'a page of the list begins with the last row of the one before', red: ['three at a time, the pages join into the whole list'],
    edits: [{ file: HISTORY, anchor: 'where.push(`(${activeAt}, s.id) < (', replace: 'where.push(`(${activeAt}, s.id) <= (' }] },
  { name: 'search-oldest-first', check: '26', why: 'results come oldest first', red: ['results come newest first', 'in the order the steps happened, last first'],
    edits: [{ file: HISTORY, anchor: '     order by found.created_at desc, found.id desc`, params, query.before)', replace: '     order by found.created_at asc, found.id asc`, params, query.before)' }] },
  { name: 'search-cursor-repeats', check: '26', why: 'a page of results begins with the last result of the one before', red: ['a search pages through its'],
    edits: [{ file: HISTORY, anchor: 'where.push(`(e.created_at, e.id) < (', replace: 'where.push(`(e.created_at, e.id) <= (' }] },
  { name: 'range-drops-its-end', check: '26', why: "a range of steps leaves out its last number", red: ['read in ranges of 100, the steps join in order'],
    edits: [{ file: HISTORY, anchor: 'e.seq between $2 and $3 and ${SHOWN_STEP}', replace: 'e.seq >= $2 and e.seq < $3 and ${SHOWN_STEP}' }] },
  { name: 'bookkeeping-in-steps', check: '26', why: 'a replay shows bookkeeping notices as steps', red: ['bookkeeping is left out of the steps'],
    edits: [{ file: HISTORY, anchor: 'e.seq between $2 and $3 and ${SHOWN_STEP}', replace: 'e.seq between $2 and $3' }] },
  { name: 'more-notices-shown', check: '26', why: 'a hook notice counts as a step', red: ['bookkeeping notices are not steps', 'bookkeeping is left out of the steps'],
    edits: [{ file: SHARED, anchor: "export const SHOWN_NOTICES = ['init', 'interrupted', 'screen'] as const", replace: "export const SHOWN_NOTICES = ['init', 'interrupted', 'screen', 'hook_started'] as const" }] },
  { name: 'drafts-listed', check: '26', why: 'a task saved to start later is listed as a session', red: ['a draft task has a session that has not run'],
    edits: [{ file: HISTORY, anchor: "`s.status <> 'draft'`, ", replace: '' }] },
  { name: 'nonsense-cursor-fails', check: '26', why: 'a cursor that names no time or row is a server failure', red: ['a cursor that fits its pattern and names no time or row is refused'],
    edits: [{ file: HISTORY, anchor: "    if (before !== undefined && NOT_A_CURSOR.some((code) => hasCode(error, code))) throw new HttpError(400, 'before is not a cursor this page gave')\n", replace: '' }] },
  // Filters.
  { name: 'agent-filter-off', check: '26', why: 'the agent filter keeps everything', red: ["the agent filter keeps scout's sessions"],
    edits: [{ file: HISTORY, anchor: '...(filters.agent ? [`s.agent_id = ${bind(filters.agent)}`] : []),', replace: '...(filters.agent ? [] : []),' }] },
  { name: 'person-filter-off', check: '26', why: 'the person filter keeps everything', red: ['the person filter keeps the sessions a person started'],
    edits: [{ file: HISTORY, anchor: '...(filters.person ? [`s.started_by = ${bind(filters.person)}`] : []),', replace: '...(filters.person ? [] : []),' }] },
  { name: 'tasks-include-runs', check: '26', why: 'the task kind includes runs', red: ['and tasks that no pipeline started'],
    edits: [{ file: HISTORY, anchor: "  task: 's.task_id is not null and run.id is null',", replace: "  task: 's.task_id is not null'," }] },
  { name: 'project-filter-off', check: '26', why: 'the project filter keeps everything', red: ["the project filter keeps a project's task and room"],
    edits: [{ file: HISTORY, anchor: '...(filters.project ? [`pr.id = ${bind(filters.project)}`] : []),', replace: '...(filters.project ? [] : []),' }] },
  { name: 'repo-filter-off', check: '26', why: 'the repo filter keeps everything', red: ['the repo filter keeps the tasks in a repo'],
    edits: [{ file: HISTORY, anchor: 'tr.repo_id = ${bind(filters.repo)})`] : []),', replace: 'tr.repo_id = ${bind(filters.repo)} or true)`] : []),' }] },
  { name: 'day-start-ignored', check: '26', why: 'the day filter has no start', red: ['the day filter keeps the sessions active that day'],
    edits: [{ file: HISTORY, anchor: '    ...(query.since ? [`${activeAt} >= ${bind(query.since)}::timestamptz`] : []),\n', replace: '' }] },
  { name: 'day-end-ignored', check: '26', why: 'the day filter has no end', red: ['and the old session shows on its own day'],
    edits: [{ file: HISTORY, anchor: '    ...(query.until ? [`s.created_at < ${bind(query.until)}::timestamptz`] : []),\n', replace: '' }] },
  { name: 'search-day-ignored', check: '26', why: 'a search ignores the day', red: ['and the day, which is the day of the step'],
    edits: [{ file: HISTORY, anchor: '    ...(query.since ? [`e.created_at >= ${bind(query.since)}::timestamptz`] : []),\n', replace: '' }] },
  // What a replay shows.
  { name: 'result-cut-to-text', check: '26', why: 'a result shows the text column, which is cut', red: ['a result is shown whole'],
    edits: [{ file: STEPS, anchor: "    case 'tool_result': {\n      const blocks = resultBlocks(fields.content)\n      return blocks.length ? blocks : own()\n    }", replace: "    case 'tool_result':\n      return own()" }] },
  { name: 'call-input-hidden', check: '26', why: 'a tool call shows its summary and not its input', red: ['a tool call shows each field of its input'],
    edits: [{ file: STEPS, anchor: "    case 'tool_call':\n    case 'ask': {", replace: "    case 'tool_call':\n      return own()\n    case 'ask': {" }] },
  { name: 'errors-not-flagged', check: '26', why: 'a failed result is not marked as having gone wrong', red: ['the steps marked as having gone wrong'],
    edits: [{ file: HISTORY, anchor: "e.parent_tool_use_id is not null as sub, ${ERROR_STEP} as error,", replace: "e.parent_tool_use_id is not null as sub, (e.kind = 'error') as error," }] },
  // How a replay moves.
  { name: 'never-trims', check: '26', why: 'the steps a replay keeps grow without end', red: ['along the way it never keeps more than 200 steps'],
    edits: [{ file: REPLAY, anchor: '  if (loaded.steps.length <= max) return loaded\n', replace: '  return loaded\n' }] },
  { name: 'no-prefetch', check: '26', why: 'a replay never asks for the next page before it needs it', red: ['playing runs to the last step and stops there'],
    edits: [{ file: REPLAY, anchor: 'export const AHEAD = 10', replace: 'export const AHEAD = 0' }] },
  { name: 'pages-too-wide', check: '26', why: 'a page asks for more step numbers than the server answers', red: ['along the way it never keeps more than 200 steps'],
    edits: [{ file: REPLAY, anchor: 'export const PAGE = 40', replace: 'export const PAGE = 120' }] },
  { name: 'next-stays', check: '26', why: 'the next step is the current one', red: ['stepping forward skips a number that is no step'],
    edits: [{ file: REPLAY, anchor: 'loaded.steps.find((step) => step.seq > seq)', replace: 'loaded.steps.find((step) => step.seq >= seq)' }] },
  { name: 'end-is-the-end', check: '26', why: 'playing from the last step stays on it', red: ['playing again from the last step starts over'],
    edits: [{ file: REPLAY, anchor: '      if (atEnd) return around(', replace: '      if (false) return around(' }] },
  { name: 'stale-answer-taken', check: '26', why: 'an answer to a request a newer one replaced is used', red: ['an answer to a request a newer one replaced changes nothing'],
    edits: [{ file: REPLAY, anchor: '      if (request?.id !== move.id) return state\n', replace: '      if (request === null) return state\n' }] },
  { name: 'past-the-end-asked-for', check: '26', why: 'a number past the end of a session is asked for as it is', red: ['a number past either end of a session is its nearest end'],
    edits: [{ file: REPLAY, anchor: '  const target = Math.min(Math.max(seq, bounds.first ?? seq), bounds.last ?? seq)\n', replace: '  const target = seq\n' }] },
  { name: 'pause-does-not-stop', check: '26', why: 'pausing leaves it playing', red: ['pausing stops it'],
    edits: [{ file: REPLAY, anchor: "    case 'pause':\n      return { ...state, playing: false }", replace: "    case 'pause':\n      return state" }] },
  { name: 'short-delays', check: '26', why: 'a step may stay less than the least', red: ['a step stays as long as the time before the next'],
    edits: [{ file: REPLAY, anchor: 'export const PLAY_MIN_MS = 400', replace: 'export const PLAY_MIN_MS = 100' }] },
  { name: 'speed-ignored', check: '26', why: 'the speed does not change how long a step stays', red: ['a step stays as long as the time before the next'],
    edits: [{ file: REPLAY, anchor: 'PLAY_MAX_MS, Math.max(PLAY_MIN_MS, gap)) / speed)', replace: 'PLAY_MAX_MS, Math.max(PLAY_MIN_MS, gap)) / 1)' }] },
  { name: 'snippet-keeps-end', check: '26', why: 'a snippet keeps the text after the words that matched in them', red: ['a snippet splits into the words that matched'],
    edits: [{ file: SHARED, anchor: 'parts.push({ text: end < 0 ? piece : piece.slice(0, end), hit: true }', replace: 'parts.push({ text: piece, hit: true }' }] },
  // The page.
  { name: 'no-sidebar-link', check: '26b', why: 'the sidebar has no link to History', red: ['Workspace'],
    edits: [{ file: APP, anchor: "        <button type=\"button\" className={`link small${route.page === 'history' ? ' current' : ''}`} onClick={() => go({ page: 'history' })}>History</button>\n", replace: '' }] },
  { name: 'sidebar-never-current', check: '26b', why: 'the sidebar does not mark History as the page', red: ['the sidebar marks History as the page'],
    edits: [{ file: APP, anchor: "route.page === 'history' ? ' current' : ''", replace: "''" }] },
  { name: 'no-private-mark', check: '26b', why: 'a private session does not say so', red: ['a private session says so to Ava', 'marked private'],
    edits: [{ file: PAGE, anchor: "{KIND_WORDS[session.subject.kind]}{session.private ? ' · Private' : ''}", replace: '{KIND_WORDS[session.subject.kind]}' }] },
  { name: 'day-choice-ignored', check: '26b', why: 'choosing a day changes nothing', red: ['choosing a day keeps the sessions active on it'],
    edits: [{ file: PAGE, anchor: 'onChange={(picked) => { change({ day: picked }) }}', replace: 'onChange={() => { change({}) }}' }] },
  { name: 'scope-choice-ignored', check: '26b', why: 'choosing what to search changes nothing', red: ['choosing to search messages leaves out the tool result'],
    edits: [{ file: PAGE, anchor: 'search(filters.q, SearchScope.safeParse(scope).data ?? \'\')', replace: "search(filters.q, '')" }] },
  { name: 'steps-not-marked-current', check: '26b', why: 'the step a replay is on is not marked', red: ['a result opens the replay at the step that matched', 'a replay opens on the first step'],
    edits: [{ file: PLAYER, anchor: "aria-current={current ? 'step' : undefined}", replace: 'aria-current={undefined}' }] },
  { name: 'replay-ignores-new-step', check: '26b', why: "an address that names another step of the open session does not move the replay", red: ['the step it opens on shows its result in full'],
    edits: [{ file: PAGE, anchor: 'key={`${place.sessionId}/${String(place.seq)}`}', replace: 'key={place.sessionId}' }] },
  { name: 'address-not-kept', check: '26b', why: 'the address does not name the step a replay is paused on', red: ['once paused, the address names the step'],
    edits: [{ file: PLAYER, anchor: "      window.history.replaceState(null, '', replayHash(sessionId, cursor))\n", replace: '' }] },
  { name: 'marks-do-nothing', check: '26b', why: 'a mark under the slider goes nowhere', red: ['a mark under the slider jumps to its error'],
    edits: [{ file: PLAYER, anchor: 'onClick={() => { goTo(seq) }} />', replace: 'onClick={() => undefined} />' }] },
  { name: 'results-never-fold', check: '26b', why: 'a long result is always shown whole', red: ['once the replay moves on, a long result folds to a line'],
    edits: [{ file: PLAYER, anchor: '  if (!long || open) {', replace: '  if (true) {' }] },
  { name: 'errors-not-said', check: '26b', why: 'a step that went wrong does not say so', red: ['it says the step went wrong'],
    edits: [{ file: PLAYER, anchor: '        {step.error && <span className="kicker"><span aria-hidden="true">! </span>Went wrong</span>}\n', replace: '' }] },
  { name: 'working-not-followed', check: '26b', why: 'a replay of a working session is never read again', red: ['and learns of the steps taken after it opened'],
    edits: [{ file: PLAYER, anchor: '          working = isWorking(view.session)\n          if (working) timer = setTimeout(read, REFRESH_MS)\n', replace: '          working = isWorking(view.session)\n' }] },
  { name: 'failed-read-ends-following', check: '26b', why: 'a replay of a working session stops reading it after one read fails', red: ['even when a read of the session fails on the way'],
    edits: [{ file: PLAYER, anchor: '          // A session that was working still is, as far as anyone knows, so it is read again.\n          if (working) timer = setTimeout(read, REFRESH_MS)\n', replace: '' }] },
  { name: 'empty-says-nothing', check: '26b', why: 'a session with no steps says nothing', red: ['a session with no steps yet says so'],
    edits: [{ file: PLAYER, anchor: '        {loaded !== null && !loaded.steps.length && request === null && <p className="muted">This session has no steps yet.</p>}\n', replace: '' }] },
  { name: 'style-element', check: '26b', why: 'the page adds a style element', red: ['the page has no style element', 'no page errors, no refused scripts or styles'],
    edits: [{ file: PLAYER, anchor: '    <section className="page" aria-label="Replay">\n      <header className="page-head">', replace: '    <section className="page" aria-label="Replay">\n      <style>{\'.replay-step { color: inherit }\'}</style>\n      <header className="page-head">' }] },
  { name: 'controls-do-not-wrap', check: '26b', why: "a phone's screen is crossed by the controls", red: ['or on a replay with a long result in view'],
    edits: [{ file: CSS, anchor: '.replay-controls { display: flex; flex-wrap: wrap;', replace: '.replay-controls { display: flex; flex-wrap: nowrap;' }] },
]

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const Pending = z.array(z.object({ file: z.string(), sha: z.string() }))
const at = (file: string) => join(ROOT, file)

// Puts back the files a run that was killed had changed.
function restorePending() {
  if (!existsSync(PENDING)) return
  for (const { file, sha: wanted } of Pending.parse(JSON.parse(readFileSync(PENDING, 'utf8')))) {
    copyFileSync(join(BACKUP, file), at(file))
    if (sha(readFileSync(at(file))) !== wanted) throw new Error(`${file} did not come back as it was`)
    console.log(`restored ${file}, left changed by a run that was killed`)
  }
  rmSync(PENDING)
}

// What each file the break touches would hold with its edits made. Throws, writing nothing, when an anchor is not there exactly once.
function edited(b: Break): Map<string, string> {
  const files = new Map<string, string>()
  for (const edit of b.edits) {
    const text = files.get(edit.file) ?? readFileSync(at(edit.file), 'utf8')
    const found = text.split(edit.anchor).length - 1
    if (found !== 1) throw new Error(`${b.name}: the anchor ${JSON.stringify(edit.anchor)} is in ${edit.file} ${String(found)} times, not once`)
    files.set(edit.file, text.replace(edit.anchor, () => edit.replace))
  }
  return files
}

// Runs a check and returns everything it printed.
function run(check: Break['check']): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', `test/step${check}.ts`], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AGENTS_UI_ENGINES: 'chromium' },
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    const timer = setTimeout(() => { child.kill('SIGTERM') }, RUN_TIMEOUT_MS)
    child.once('error', reject)
    child.once('close', () => { clearTimeout(timer); resolve(output) })
  })
}

// A check that threw prints FAIL and then its stack, so the lines after it belong to the failure.
const redLines = (output: string) => {
  const found = output.split('\n')
  return found.flatMap((line, i) => (line.startsWith('FAIL  ') ? [[line, ...found.slice(i + 1, i + 6)].join(' ')] : []))
}
const lines = (n: number) => `${String(n)} ${n === 1 ? 'line' : 'lines'}`

async function runBreak(b: Break): Promise<{ ok: boolean; detail: string }> {
  const files = edited(b)
  mkdirSync(BACKUP, { recursive: true })
  const before = [...files.keys()].map((file) => ({ file, sha: sha(readFileSync(at(file))) }))
  for (const { file } of before) {
    mkdirSync(dirname(join(BACKUP, file)), { recursive: true })
    copyFileSync(at(file), join(BACKUP, file))
  }
  writeFileSync(PENDING, JSON.stringify(before))
  let output: string
  try {
    for (const [file, text] of files) writeFileSync(at(file), text)
    output = await run(b.check)
  } finally {
    for (const { file } of before) copyFileSync(join(BACKUP, file), at(file))
  }
  const back = before.filter(({ file, sha: wanted }) => sha(readFileSync(at(file))) !== wanted)
  if (back.length) throw new Error(`${back.map((f) => f.file).join(', ')} did not come back as it was`)
  rmSync(PENDING)
  const fails = redLines(output)
  const missing = b.red.filter((piece) => !fails.some((line) => line.includes(piece)))
  return {
    ok: missing.length === 0 && fails.length > 0,
    detail: missing.length
      ? `${lines(fails.length)} went red, and none held "${missing.join('" or "')}". Red: ${fails.map((l) => l.slice(0, 140)).join(' | ')}`
      : `${lines(fails.length)} went red, and the files are back byte for byte`,
  }
}

const args = process.argv.slice(2)
const only = args.filter((a) => !a.startsWith('--'))
const unknown = only.filter((name) => !BREAKS.some((b) => b.name === name))
if (unknown.length) throw new Error(`no break named ${unknown.join(', ')}. They are ${BREAKS.map((b) => b.name).join(', ')}`)
const chosen = BREAKS.filter((b) => !only.length || only.includes(b.name))

if (args.includes('--check')) {
  for (const b of BREAKS) edited(b)
  console.log(`all ${String(BREAKS.length)} breaks find each anchor once`)
  process.exit(0)
}

restorePending()
let failed = 0
for (const check of [...new Set(chosen.map((b) => b.check))]) {
  const control = redLines(await run(check))
  console.log(`${control.length ? 'FAIL' : 'pass'}  control: step${check} with nothing broken${control.length ? ` has ${String(control.length)} red lines, so no break can be judged` : ' is green'}`)
  if (control.length) process.exit(1)
}
for (const b of chosen) {
  const result = await runBreak(b)
  console.log(`${result.ok ? 'pass' : 'FAIL'}  ${b.name} (step${b.check}): ${b.why}. ${result.detail}`)
  if (!result.ok) failed++
}
console.log(`\n${failed ? `${String(failed)} breaks were not seen failing` : `all ${String(chosen.length)} breaks were seen failing, and every file is back as it was`}`)
process.exit(failed ? 1 : 0)
