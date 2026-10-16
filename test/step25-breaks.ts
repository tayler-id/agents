// Watches step25's and step25b's checks fail. First it runs each with nothing broken, as a control. Then for
// each break it copies the files the break touches aside, applies its edits (each anchor must be in its file
// exactly once, or nothing is written), runs the check the break names, and confirms that the check lines the
// break names went red. Last it puts every file back byte for byte and confirms its sha256. A run killed midway
// puts the files back when it next starts.
//   node test/step25-breaks.ts                     the controls, then every break
//   node test/step25-breaks.ts logs-value any-teammate   only the breaks named
//   node test/step25-breaks.ts --check             each anchor is there once, and nothing runs

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const ROOT = new URL('..', import.meta.url).pathname
const WORK = join(ROOT, '.scratch', 'breaks-25')
const BACKUP = join(WORK, 'backup')
const PENDING = join(WORK, 'pending.json')
// step25 takes about a minute. A break that leaves a request waiting is cut off by the check's own limits.
const RUN_TIMEOUT_MS = 10 * 60 * 1000

type Edit = { file: string; anchor: string; replace: string }
// `check` is the step the break is run through. `red` holds a piece of each check line the break must turn red.
type Break = { name: string; check: '25' | '25b'; why: string; red: string[]; edits: Edit[] }

const SECRETS = 'server/secrets.ts'
const CONTROL = 'server/control.ts'
const FILES = 'daemon/agentfiles.ts'
const DAEMON = 'daemon/agentsd.ts'
const LINK = 'daemon/control-link.ts'
const FRAMES = 'shared/link.ts'
const RULES = 'shared/secret-rules.ts'
const PAGE = 'app/src/Secrets.tsx'
const VALUE = 'app/src/SecretValue.tsx'

const BREAKS: Break[] = [
  // What the API keeps and says.
  { name: 'logs-value', check: '25', why: 'the API logs the value it sets', red: ['the value is in no Postgres column, no API or daemon log'],
    edits: [{ file: SECRETS, anchor: '  const answer = await putOnComputer(link, target.name, value)\n', replace: '  console.error(`setting ${target.name} to ${value}`)\n  const answer = await putOnComputer(link, target.name, value)\n' }] },
  { name: 'keeps-value-in-postgres', check: '25', why: "the value is kept in the secret's description", red: ['the value is in no Postgres column'],
    edits: [{ file: SECRETS, anchor: '  const { set_at: setAt } = z.object({ set_at: z.date() }).parse(row)\n', replace: "  await pool.query('update secrets set description = $2 where id = $1', [secretId, value])\n  const { set_at: setAt } = z.object({ set_at: z.date() }).parse(row)\n" }] },
  { name: 'answers-with-value', check: '25', why: 'the answer to setting a value holds the value', red: ['the owner sets SENTRY_TOKEN from the app, and the answer holds its name'],
    edits: [{ file: SECRETS, anchor: 'setAt: setAt.toISOString() }', replace: 'setAt: setAt.toISOString(), value }' }] },
  { name: 'hides-the-secret-sets-shape', check: '25', why: 'the app cannot read where a value is set', red: ['a teammate sees the name, the computer and the time'],
    edits: [{ file: 'server/sync.ts', anchor: "  secret_sets: async (p) => ({ table: 'secret_sets', where: 'team_id = $1', params: [p.team_id] }),\n", replace: '' }] },
  // Who may set a value, and which.
  { name: 'any-teammate', check: '25', why: "a teammate may set a value on someone else's computer", red: ["a teammate cannot set a value on someone else's computer"],
    edits: [{ file: SECRETS, anchor: '  if (!mayPutOn(found.owner_id, person.id)) {', replace: '  if (false) {' }] },
  { name: 'takes-ownerless', check: '25', why: 'a computer with no owner takes a value from any teammate', red: ['a computer with no owner takes no value'],
    edits: [{ file: SECRETS, anchor: '  if (found.owner_id === null) {\n', replace: '  if (false) {\n' },
      { file: 'shared/secrets.ts', anchor: '=> computerOwner !== null && computerOwner === person', replace: '=> computerOwner === null || computerOwner === person' }] },
  { name: 'anyone-may-put', check: '25b', why: "the rule for who may put a value on a computer says yes to everyone, for the API and for the page", red: ['and is told whose computer it is', 'with no field or button to change it'],
    edits: [{ file: 'shared/secrets.ts', anchor: '=> computerOwner !== null && computerOwner === person', replace: '=> true' }] },
  { name: 'shows-controls-to-teammate', check: '25b', why: 'the page offers its buttons to a person the API would refuse', red: ['with no field or button to change it'],
    edits: [{ file: PAGE, anchor: "  if (!mayPutOn(owner, person)) return `", replace: "  if (false) return `" }] },
  { name: 'takes-env-names', check: '25', why: "a value is stored under a name the daemon's environment already sets, where it is never used", red: ["a value for a name the daemon's environment already sets is refused with why"],
    edits: [{ file: DAEMON, anchor: '  if (put && process.env[name] !== undefined) {', replace: '  if (false) {' }] },
  { name: 'records-before-comparison', check: '25', why: 'a set is recorded without waiting for the comparison with what the computer lists', red: ['the set waits for the comparison, and no row is written before it has finished'],
    edits: [{ file: SECRETS, anchor: '  await link.reported\n', replace: '' }] },
  { name: 'drops-every-row', check: '25', why: 'the comparison drops every row, whether or not the computer lists it', red: ['once the comparison has finished the set is recorded, a name the computer lists is kept'],
    edits: [{ file: CONTROL, anchor: "'delete from secret_sets where instance_id = $1 and not (name = any($2))'", replace: "'delete from secret_sets where instance_id = $1 and $2::text[] is not null'" }] },
  { name: 'any-name', check: '25', why: 'a name the computer uses for itself may be set', red: ['a name the computer uses for itself, one the daemon owns and a proxy setting are refused'],
    edits: [{ file: SECRETS, anchor: '  const named = SettableName.safeParse(found.name)\n', replace: '  const named = { success: true as const }\n' }] },
  { name: 'any-owner-of-no-agent', check: '25', why: "a secret that belongs to no agent is sent to a computer anyway", red: ['a secret that belongs to no agent is refused'],
    edits: [{ file: SECRETS, anchor: '  if (!found.agent_id) throw new HttpError(400, ', replace: '  if (false) throw new HttpError(400, ' }] },
  { name: 'short-values', check: '25', why: 'a value under 8 characters is taken', red: ['a value under 8 characters, over 4096 bytes, with a NUL or not text is refused'],
    edits: [{ file: RULES, anchor: '.min(MIN_SECRET_LENGTH, ', replace: '.min(1, ' }] },
  { name: 'long-values', check: '25', why: 'a value over 4096 bytes is taken', red: ['a value under 8 characters, over 4096 bytes, with a NUL or not text is refused'],
    edits: [{ file: RULES, anchor: '.length <= SECRET_VALUE_MAX_BYTES, ', replace: '.length <= 1_000_000, ' }] },
  { name: 'nul-values', check: '25', why: 'a value with a NUL is taken', red: ['a value under 8 characters, over 4096 bytes, with a NUL or not text is refused'],
    edits: [{ file: RULES, anchor: "  .refine((value) => !value.includes('\\u0000'), 'a value cannot hold a NUL character')\n", replace: '' }] },
  // A computer that is away, and what it answers.
  { name: 'never-asks-for-start', check: '25', why: 'a computer that is not running is waited for and never asked to start', red: ['and it asks once for the computer to be started'],
    edits: [{ file: SECRETS, anchor: '  if (!running) await wakeComputer(target)\n', replace: '' }] },
  { name: 'sleeping-box-left-asleep', check: '25', why: "a key for a person's own box that sleeps asks the runner to tick but leaves the box marked asleep, so nothing starts it",
    red: ["a key for a person's own box that is asleep has the runner start the box's container", 'and the box is no longer marked asleep', "the value lands in the box's secrets.json"],
    edits: [{ file: SECRETS, anchor: "  if (target.kind === 'box' && target.personal) await wakeOwnBox(target.instanceId)\n", replace: '' }] },
  { name: 'waits-short-for-stopped', check: '25', why: 'a computer that is not running gets the wait of one reconnecting, not 90 seconds', red: ['a request for a stopped computer waits, then answers 504 with a reason that names the computer'],
    edits: [{ file: SECRETS, anchor: '  const waitMs = running ? LINK_WAIT_MS : WAKE_MS\n', replace: '  const waitMs = LINK_WAIT_MS\n' }] },
  { name: 'answers-409-for-stopped', check: '25', why: 'a stopped computer is refused at once, as before', red: ['a request for a stopped computer waits, then answers 504 with a reason that names the computer', 'it waits the time it is given, and no longer'],
    edits: [{ file: SECRETS, anchor: '  if (!running) await wakeComputer(target)\n', replace: "  if (!running) throw new HttpError(409, `${target.computer} is stopped.`)\n" }] },
  { name: 'keys-always-missing', check: '25', why: "the agent's keys say missing after a value is set", red: ["once set, the agent's keys list SENTRY_TOKEN as set"],
    edits: [{ file: SECRETS, anchor: "state: held ? 'set' : 'missing'", replace: "state: 'missing'" }] },
  { name: 'keys-always-set', check: '25', why: "the agent's keys say set when no value was put", red: ["the agent's keys list SENTRY_TOKEN as missing"],
    edits: [{ file: SECRETS, anchor: "state: held ? 'set' : 'missing'", replace: "state: 'set'" }] },
  { name: 'keys-count-nothing', check: '25', why: 'the count of missing keys is always 0', red: ["the agent's keys list SENTRY_TOKEN as missing", 'the team summary says scout has 1 key and 1 missing'],
    edits: [{ file: SECRETS, anchor: "missing: keys.filter((k) => k.state === 'missing').length }", replace: 'missing: 0 }' }] },
  { name: 'no-wait', check: '25', why: 'a computer whose connection is down is not waited for', red: ["a person who sets a value while the computer's connection is down waits for it to come back"],
    edits: [{ file: SECRETS, anchor: '  const arrived = await waitForLink(target.instanceId, waitMs)\n', replace: '  const arrived = undefined\n' }] },
  { name: 'ignores-refusal', check: '25', why: "a computer's refusal is not told to the person", red: ["a computer's refusal reaches the person with its reason"],
    edits: [{ file: SECRETS, anchor: '  if (answer.type === \'secret_refused\') throw new HttpError(409, `${target.computer} would not take it. ${scrub(answer.reason)}`)\n', replace: '' }] },
  { name: 'records-wrong-answer', check: '25', why: 'any answer is taken for the value being stored', red: ['an answer that is not for the request is refused and nothing is recorded'],
    edits: [{ file: SECRETS, anchor: "  if (answer.type !== 'secret_stored') throw new HttpError(502, ", replace: "  if (false) throw new HttpError(502, " }] },
  { name: 'leaves-request-waiting', check: '25', why: 'a request waits on after its computer closed the connection', red: ['a computer that closes its connection before it answers leaves a refusal'],
    edits: [{ file: CONTROL, anchor: "    for (const waiting of [...link.waiting.values()]) waiting.settle(new HttpError(409, 'The computer closed its connection before it answered.'))\n", replace: '' }] },
  { name: 'waits-forever', check: '25', why: 'a computer that answers nothing is waited on for ever', red: ['a computer that answers nothing is given 10 seconds'],
    edits: [{ file: CONTROL, anchor: "    const timer = setTimeout(() => { settle(new HttpError(409, 'The computer did not answer in time. Try again.')) }, LINK_ANSWER_MS)\n", replace: '    const timer = setTimeout(() => undefined, LINK_ANSWER_MS)\n' }] },
  // The control connection.
  { name: 'control-takes-people', check: '25', why: "the control path takes a person's identity", red: ["the control path refuses a person's identity"],
    edits: [{ file: CONTROL, anchor: "    checkAudience('machines', req)\n", replace: '' }] },
  { name: 'keeps-old-connection', check: '25', why: "a daemon that connects again leaves its earlier connection open", red: ['a daemon that connects again replaces its earlier connection'],
    edits: [{ file: CONTROL, anchor: '  links.get(instanceId)?.ws.terminate()\n', replace: '' }] },
  { name: 'quotes-frame-in-api-log', check: '25', why: "the API's log quotes a frame it cannot read", red: ['a frame the API cannot read closes the connection, and the log says so without quoting it'],
    edits: [{ file: CONTROL, anchor: "(${frame ? frame.reason : 'not text'})`)", replace: "(${frame ? frame.reason : 'not text'}): ${bytesOf(data).toString('utf8')}`)" }] },
  { name: 'keeps-lost-values', check: '25', why: 'the API goes on saying a value is set that its computer lost', red: ['the computer says what it holds when it connects'],
    edits: [{ file: CONTROL, anchor: '      link.reported = forgetUnheld(instanceId, frame.value.names)\n', replace: '' }] },
  { name: 'says-nothing-on-connect', check: '25', why: 'a daemon tells the API nothing when it connects', red: ['the computer says what it holds when it connects'],
    edits: [{ file: LINK, anchor: '      if (hello) ws.send(JSON.stringify(hello))\n', replace: '' }] },
  { name: 'quotes-frame-in-daemon-log', check: '25', why: "the daemon's log quotes a frame it cannot read", red: ['and its log says a frame was refused without quoting it'],
    edits: [{ file: LINK, anchor: "(${frame ? frame.reason : 'not text'})`)", replace: "(${frame ? frame.reason : 'not text'}): ${bytesOf(data).toString('utf8')}`)" }] },
  { name: 'daemon-takes-any-name', check: '25', why: 'a daemon takes a value under a name it uses for itself', red: ['a daemon closes the connection on a frame it cannot read'],
    edits: [{ file: FRAMES, anchor: "z.object({ type: z.literal('secret_put'), id: RequestId, name: SettableName, value: SecretValue }),", replace: "z.object({ type: z.literal('secret_put'), id: RequestId, name: SecretName, value: SecretValue })," }] },
  // What the daemon does with a value.
  { name: 'wide-file', check: '25', why: 'secrets.json is written readable by others', red: ['secrets.json is readable by its owner alone'],
    edits: [{ file: FILES, anchor: "const fd = openSync(temp, 'wx', 0o600)", replace: "const fd = openSync(temp, 'wx', 0o644)" }] },
  { name: 'rewrites-unreadable-file', check: '25', why: 'a secrets file that is not JSON is written over', red: ['a secrets file that is not JSON is refused, not rewritten and not quoted'],
    edits: [{ file: FILES, anchor: '  } catch {\n    throw new SecretsFileError(`${SECRETS_FILE} is not valid JSON, so the daemon left it alone.`)\n  }\n', replace: '  } catch {\n    return {}\n  }\n' }] },
  { name: 'quotes-the-file', check: '25', why: "a refusal quotes Node's error for a file that is not JSON", red: ['a secrets file that is not JSON is refused, not rewritten and not quoted', 'and neither log quotes what was in the file'],
    edits: [{ file: FILES, anchor: '  } catch {\n    throw new SecretsFileError(`${SECRETS_FILE} is not valid JSON, so the daemon left it alone.`)\n  }\n', replace: '  } catch (error) {\n    throw new SecretsFileError(`${SECRETS_FILE} is not valid JSON, so the daemon left it alone. ${error instanceof Error ? error.message : String(error)}`)\n  }\n' }] },
  { name: 'keeps-old-config', check: '25', why: "the plugin's config keeps the value that was replaced", red: ['nothing of the old value is left on the computer'],
    edits: [{ file: DAEMON, anchor: '      forgetValueIn(SESSIONS_DIR, gone)\n', replace: '' }] },
  { name: 'forgets-retired-values', check: '25', why: 'a value that was replaced is no longer scrubbed', red: ['a repeated value is scrubbed whether it is the new one or the one that was replaced', 'a value removed from the computer is still scrubbed'],
    edits: [{ file: DAEMON, anchor: '      if (gone.length >= MIN_SECRET_LENGTH && !retiredSecrets.some(([retired, value]) => retired === name && value === gone)) retiredSecrets.push([name, gone])\n', replace: '' }] },
  { name: 'stale-scrubber', check: '25', why: 'a value just set is not scrubbed until a session starts', red: ['an agent that repeats the value has it replaced by its name'],
    edits: [{ file: DAEMON, anchor: "    secrets = knownSecrets()\n    scrub = makeScrub(secrets)\n    console.log(`secret ${name} ${put ? 'stored' : 'removed'}`)", replace: "    console.log(`secret ${name} ${put ? 'stored' : 'removed'}`)" }] },
  { name: 'keeps-idle-process', check: '25', why: 'an idle session keeps running with the value that was replaced', red: ['the process that held the old value is stopped when the new one is set', 'and the idle process whose plugin held the value is stopped'],
    edits: [{ file: DAEMON, anchor: '        if (session && !session.busy) session.stop()\n        else staleSecrets.add(sessionId)\n', replace: '        staleSecrets.add(sessionId)\n' }] },
  { name: 'never-restarts-a-busy-session', check: '25', why: "a session in a turn keeps the old value after the turn", red: ['and its next message starts a new process'],
    edits: [{ file: DAEMON, anchor: '      && (staleSecrets.has(command.sessionId) || setups.get(command.sessionId) !== setupOf(command.payload))) live.stop()', replace: '      && (setups.get(command.sessionId) !== setupOf(command.payload))) live.stop()' }] },
  // What the computer and the record end up holding.
  { name: 'stores-nothing', check: '25', why: 'the daemon answers that it stored a value and stores nothing', red: ["the computer's secrets.json holds the value, and the one a person put there by hand"],
    edits: [{ file: FILES, anchor: '  } else {\n    entries[name] = value\n  }\n', replace: '  } else {\n    // stores nothing\n  }\n' }] },
  { name: 'keeps-removed-value', check: '25', why: 'the daemon answers that it removed a value and keeps it', red: ['it is gone from secrets.json, and the value put there by hand is not', 'and none is on the computer once removed (secrets.json)'],
    edits: [{ file: FILES, anchor: '    delete entries[name]\n', replace: '' }] },
  { name: 'keeps-row-after-removal', check: '25', why: 'the API keeps saying a removed value is set', red: ['the record no longer says it is set'],
    edits: [{ file: SECRETS, anchor: "  await pool.query('delete from secret_sets where instance_id = $1 and name = $2', [target.instanceId, target.name])\n", replace: '' }] },
  { name: 'records-no-row', check: '25', why: 'the API never records where a value was set', red: ['the record says who set it on that computer, and when', 'a teammate sees the name, the computer and the time, and nothing of the value'],
    edits: [{ file: SECRETS, anchor: "`insert into secret_sets (team_id, instance_id, name, set_by) values ($1, $2, $3, $4)\n     on conflict (instance_id, name) do update set set_by = excluded.set_by, set_at = now()\n     returning set_at`", replace: "`select now() as set_at where $1::uuid is not null and $2::uuid is not null and $3::text is not null and $4::uuid is not null`" }] },
  // The page.
  { name: 'shows-the-value', check: '25b', why: 'the field is not masked', red: ['the value is typed in a masked field'],
    edits: [{ file: VALUE, anchor: 'type="password"', replace: 'type="text"' }] },
  { name: 'keeps-typed-value', check: '25b', why: 'the field keeps the value after it is set', red: ['opened again to replace the value, the field is empty'],
    edits: [{ file: VALUE, anchor: "    setRecent({ kind: 'set', at })\n    close()\n", replace: "    setRecent({ kind: 'set', at })\n    refocus.current = true\n    setEditing(false)\n" }] },
  { name: 'escape-keeps-text', check: '25b', why: 'Esc puts the field away and leaves what was typed in it', red: ['Esc puts the field away'],
    edits: [{ file: VALUE, anchor: '      event.stopPropagation()\n      if (!busy) close()\n', replace: '      event.stopPropagation()\n      refocus.current = true\n      setEditing(false)\n' }] },
  { name: 'cancel-keeps-text', check: '25b', why: 'Cancel puts the field away and leaves what was typed in it', red: ['Cancel does the same'],
    edits: [{ file: VALUE, anchor: 'onClick={close}>Cancel</button>', replace: 'onClick={() => { setEditing(false) }}>Cancel</button>' }] },
  { name: 'echoes-the-value', check: '25b', why: 'the row shows what is typed', red: ['what is typed is not on the page as text'],
    edits: [{ file: VALUE, anchor: ': `Not set from the app on ${computer}`}', replace: ': `Not set from the app on ${computer} (${text})`}' }] },
  { name: 'removes-without-asking', check: '25b', why: 'Remove acts at once', red: ['Remove asks first, in place'],
    edits: [{ file: VALUE, anchor: 'onClick={() => { setAsking(true) }}>Remove</button>', replace: 'onClick={() => { void take() }}>Remove</button>' }] },
  { name: 'blocks-a-stopped-computer', check: '25b', why: 'the page refuses a value for a computer that is stopped, where the request would start it', red: ['a stopped computer offers the control as usual'],
    edits: [{ file: PAGE, anchor: '  const owner = computer.owner_id\n', replace: "  const owner = computer.owner_id\n  if (computer.status === 'offline' && computer.name.startsWith('mac-b')) return `${computer.name} is stopped.`\n" }] },
  { name: 'never-says-starting', check: '25b', why: 'the control does not say that it is starting the computer while it waits', red: ["the page says it is starting"],
    edits: [{ file: VALUE, anchor: `      {busy && asleep && <p className="small" role="status">Starting {computer}'s computer to {doing} the key</p>}\n`, replace: '' }] },
  { name: 'page-never-asleep', check: '25b', why: 'the page tells the control the computer is always running', red: ["the page says it is starting"],
    edits: [{ file: PAGE, anchor: "asleep={computer !== undefined && computer.status !== 'online'}", replace: 'asleep={false}' }] },
  { name: 'leaving-sends', check: '25b', why: 'leaving the field sends what was typed', red: ['and leaving it sends nothing'],
    edits: [{ file: VALUE, anchor: '    if (!text && !busy) setEditing(false)\n', replace: '    if (text) void send()\n    else if (!busy) setEditing(false)\n' }] },
  { name: 'hides-the-error', check: '25b', why: "a computer's refusal is not shown", red: ['a computer that refuses the value says why in the row'],
    edits: [{ file: VALUE, anchor: '      {error && <p className="error small" role="alert">{error}</p>}\n    </div>', replace: '    </div>' }] },
  { name: 'names-nobody', check: '25b', why: 'the row never says who set a value', red: ['opened again, the row names the person who set it'],
    edits: [{ file: VALUE, anchor: ', by {shown.by}</>', replace: '</>' }] },
  { name: 'adds-a-form', check: '25b', why: 'the control is a form', red: ['nothing on the page is a form', 'no page had a form'],
    edits: [
      { file: VALUE, anchor: '    <div className="secret-value">\n', replace: '    <form className="secret-value" onSubmit={(event) => { event.preventDefault() }}>\n' },
      { file: VALUE, anchor: '      {error && <p className="error small" role="alert">{error}</p>}\n    </div>', replace: '      {error && <p className="error small" role="alert">{error}</p>}\n    </form>' },
    ] },
  { name: 'adds-a-style-element', check: '25b', why: 'the control puts a style element on the page', red: ['no page had a form, a style element, an inline style or a policy violation'],
    edits: [{ file: VALUE, anchor: '    <div className="secret-value">\n', replace: '    <div className="secret-value">\n      <style>{\'.secret-value { opacity: 1 }\'}</style>\n' }] },
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

// Runs a check and returns everything it printed. The page check runs in Chromium alone, to keep each break quick.
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

const redLines = (output: string) => output.split('\n').filter((line) => line.startsWith('FAIL  '))
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
    detail: missing.length ? `${lines(fails.length)} went red, and none held "${missing.join('" or "')}". Red: ${fails.map((l) => l.slice(0, 140)).join(' | ')}` : `${lines(fails.length)} went red, and the files are back byte for byte`,
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
