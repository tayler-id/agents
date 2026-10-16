// Watches the step 24 checks fail. First it runs each check with nothing broken, as a control.
// Then for each break it copies the files the break touches aside, applies its edits (each anchor must be in
// its file exactly once, or nothing is written), runs the checks the break names, and confirms that the lines
// it names went red. Last it puts every file back byte for byte and confirms its sha256. A run killed midway
// puts the files back when it next starts. Nothing else may run while it does, since the edits are in the tree.
//   node test/step24-breaks.ts                     the controls, then every break
//   node test/step24-breaks.ts memories-flag       only the breaks named
//   node test/step24-breaks.ts --check             each anchor is there once, and nothing runs

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const ROOT = new URL('..', import.meta.url).pathname
const WORK = join(ROOT, '.scratch', 'verify', 'breaks-24')
const BACKUP = join(WORK, 'backup')
const PENDING = join(WORK, 'pending.json')
// Each of the checks takes under a minute, and step24b a few. A break that leaves a daemon waiting is cut off
// by the checks' own limits, which add up to a few minutes.
const RUN_TIMEOUT_MS = 10 * 60 * 1000

type Edit = { file: string; anchor: string; replace: string }
type CheckName = 'step24' | 'step24b' | 'step24c' | 'step24d'
// `checks` are the checks the break is run against, and `red` holds a piece of each check line it must turn red.
type Break = { name: string; checks: CheckName[]; why: string; red: string[]; edits: Edit[] }

const AGENTS = 'server/agents.ts'
const TYPES = 'shared/types.ts'
const RECIPE = 'shared/recipe.ts'
const DAEMON = 'daemon/agentsd.ts'
const CLAUDE = 'daemon/claude.ts'
const FILES = 'daemon/agentfiles.ts'
const PAGE = 'app/src/AgentPage.tsx'
const HOOKS_UI = 'app/src/agent/Hooks.tsx'
const COPY_UI = 'app/src/agent/CreateCopy.tsx'
const CALLS_UI = 'app/src/agent/copies.ts'

const BREAKS: Break[] = [
  // Who may change a hook, and what a hook may be.
  { name: 'hook-owner', checks: ['step24'], why: 'any teammate changes any agent\'s hooks', red: ['a teammate who does not own the agent cannot add a hook', 'a teammate cannot take one off'],
    edits: [{ file: AGENTS, anchor: '  if (!mayChangeHooks(person, agent, null)) {', replace: '  if (false) {' },
      { file: AGENTS, anchor: '  await mustRunOn(client, person, agent.id)\n', replace: '' }] },
  { name: 'hooks-on-teammates-mac', checks: ['step24'], why: "an agent's owner puts hooks on a teammate's Mac", red: ["Bob makes a blank agent on Alice's Mac, as before, but cannot add a hook to it"],
    edits: [{ file: AGENTS, anchor: '  await mustRunOn(client, person, agent.id)\n', replace: '' }] },
  { name: 'recipe-on-teammates-mac', checks: ['step24c'], why: "an import's plugins go on a teammate's Mac", red: ["an import with plugins and no hooks cannot go on a teammate's Mac either"],
    edits: [{ file: AGENTS, anchor: '  if (recipe.hooks.length > 0 || recipe.plugins.length > 0) await mustRunOn(client, person, agentId)\n', replace: '' }] },
  { name: 'admin-no-exception', checks: ['step24'], why: "an admin cannot put hooks or plugins on a teammate's Mac", red: ["an admin may put a copy with hooks and plugins on a teammate's Mac"],
    edits: [{ file: RECIPE, anchor: "  return person.role === 'admin' || machineOwner === null || machineOwner === person.id\n", replace: '  return machineOwner === null || machineOwner === person.id\n' }] },
  { name: 'hook-secret', checks: ['step24'], why: 'a command that holds a key is stored', red: ['a command that holds a secret value is refused'],
    edits: [{ file: AGENTS, anchor: '  if (scrub(hook.command) !== hook.command) {', replace: '  if (false) {' }] },
  { name: 'matcher-any-event', checks: ['step24'], why: 'a hook for a message may name tools', red: ['a hook needs a known event, a matcher only on a tool event'],
    edits: [{ file: TYPES, anchor: '}).refine((hook) => hook.matcher === null || takesMatcher(hook.event), {', replace: '}).refine((hook) => true || hook.matcher === null || takesMatcher(hook.event), {' }] },
  { name: 'time-limit-zero', checks: ['step24'], why: 'a hook may have a time limit of nothing', red: ['a hook needs a known event, a matcher only on a tool event'],
    edits: [{ file: TYPES, anchor: 'timeoutSec: z.number().int().min(1).max(HOOK_TIMEOUT_MAX_SEC)', replace: 'timeoutSec: z.number().int().min(0).max(HOOK_TIMEOUT_MAX_SEC)' }] },
  { name: 'hook-default-name', checks: ['step24'], why: 'a hook sent with no name is named hook, whatever its event', red: ['a hook sent with no name is named after its event'],
    edits: [{ file: AGENTS, anchor: "  const base = typeof event === 'string' ? event.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase() : 'hook'", replace: "  const base = 'hook'" }] },
  { name: 'hook-upsert', checks: ['step24'], why: 'a hook saved under a name the agent has is dropped', red: ['a hook saved under the name of one the agent has changes that one'],
    edits: [{ file: AGENTS, anchor: 'on conflict (agent_id, name) do update set event = excluded.event, matcher = excluded.matcher, command = excluded.command, timeout_sec = excluded.timeout_sec', replace: 'on conflict (agent_id, name) do nothing' }] },
  { name: 'hook-delete-missing', checks: ['step24'], why: 'taking off a hook the agent has not says it worked', red: ['taking off one it has not says so'],
    edits: [{ file: AGENTS, anchor: "  if (!rowCount) throw new HttpError(404, 'no such hook')\n", replace: '' }] },
  // How hooks reach a session.
  { name: 'shape-hooks', checks: ['step24'], why: 'teammates cannot read an agent\'s hooks', red: ['teammates read an agent\'s hooks through the agent_hooks shape'],
    edits: [{ file: 'server/sync.ts', anchor: "  agent_hooks: async (p) => ({ table: 'agent_hooks', where: 'agent_id in (select id from agents where team_id = $1)', params: [p.team_id] }),\n", replace: '' }] },
  { name: 'shape-hooks-team', checks: ['step24'], why: 'a person on another team reads an agent\'s hooks', red: ["a person on another team reads none of the agent's hooks"],
    edits: [{ file: 'server/sync.ts', anchor: "table: 'agent_hooks', where: 'agent_id in (select id from agents where team_id = $1)'", replace: "table: 'agent_hooks', where: 'agent_id in (select id from agents where team_id <> $1)'" }] },
  { name: 'kit-hooks', checks: ['step24', 'step24d'], why: 'a message carries no hooks', red: ['the daemon wrote the hooks where Claude Code reads them', "a hook's run is in the record", "each hook ran under Claude Code's own name"],
    edits: [{ file: 'server/record.ts', anchor: 'hooks: await hooksOf(client, agentId), memory: memory || undefined,', replace: 'memory: memory || undefined,' }] },
  { name: 'write-hooks', checks: ['step24', 'step24d'], why: 'the daemon does not write the settings file', red: ['the daemon wrote the hooks where Claude Code reads them', "a hook's run is in the record", "each hook ran under Claude Code's own name"],
    edits: [{ file: DAEMON, anchor: '  writeHooks(cwd, hooks)\n', replace: '' }] },
  { name: 'matcher-groups', checks: ['step24', 'step24d'], why: 'the settings file loses each hook\'s matcher', red: ['grouped by event and matcher', 'the hook for Bash left nothing in the log', 'with their matchers and time limits'],
    edits: [{ file: FILES, anchor: '    const matcher = hook.matcher ?? undefined\n', replace: '    const matcher = undefined\n' }] },
  { name: 'settings-kept', checks: ['step24'], why: 'an agent with no hooks keeps its old settings file', red: ['an agent with no hooks has no settings file'],
    edits: [{ file: FILES, anchor: '    rmSync(file, { force: true })\n', replace: '' }] },
  { name: 'setup-hooks', checks: ['step24', 'step24d'], why: 'a running session does not restart for changed hooks', red: ['taking a hook off the agent takes it from the file of the session that was already running', 'the restarted session was a resume'],
    edits: [{ file: DAEMON, anchor: 'p.plugins, p.hooks, p.permissions,', replace: 'p.plugins, p.permissions,' }] },
  // How a hook's run reaches the record.
  { name: 'hook-flag', checks: ['step24', 'step24d'], why: 'Claude Code is not asked to report hook runs', red: ["a hook's run is in the record", 'a hook that fails is in the record too', "each hook ran under Claude Code's own name"],
    edits: [{ file: CLAUDE, anchor: "    if (options.hookEvents) args.push('--include-hook-events')\n", replace: '' }] },
  { name: 'hook-line', checks: ['step24', 'step24d'], why: 'a hook run is a notice named only by its subtype', red: ["a hook's run is in the record, with what it printed", 'each run is a notice that says what the hook did and printed'],
    edits: [{ file: CLAUDE, anchor: "  if (type === 'system' && subtype === 'hook_response') return { events: [hookEvent(clientId, line, rest)], raw }\n", replace: '' }] },
  { name: 'timeout-dropped', checks: ['step24', 'step24d'], why: "the settings file loses each hook's time limit", red: ['grouped by event and matcher', 'with their matchers and time limits'],
    edits: [{ file: FILES, anchor: "    group.hooks.push({ type: 'command', command: hook.command, ...(hook.timeoutSec === null ? {} : { timeout: hook.timeoutSec }) })", replace: "    group.hooks.push({ type: 'command', command: hook.command })" }] },
  { name: 'outcome-flattened', checks: ['step24', 'step24d'], why: 'a hook that failed reads as one that finished', red: ['a hook that fails is in the record too', 'a hook that exits 3 is a notice with its exit code'],
    edits: [{ file: CLAUDE, anchor: "  const verdict = outcome === 'success' ? 'finished'", replace: "  const verdict = outcome !== 'cancelled' ? 'finished'" }] },
  // What a copy carries, and what it does not.
  { name: 'memories-person', checks: ['step24'], why: 'a copy carries a log about a person, written as the team\'s', red: ['the copy carries no memory about a person', 'the copy carries the team\'s memories'],
    edits: [{ file: AGENTS, anchor: "from memories where agent_id = $1 and scope = 'team' and content <> '' order by kind desc, log_date`", replace: "from memories where agent_id = $1 and (scope = 'team' or kind = 'log') and content <> '' order by kind desc, log_date`" }] },
  { name: 'memories-flag', checks: ['step24'], why: 'a copy carries the team\'s memories whether or not they were asked for', red: ["a copy made without the team's memories has none"],
    edits: [{ file: AGENTS, anchor: 'const memories = withMemories ? await teamMemories(client, agentId) : []', replace: 'const memories = await teamMemories(client, agentId)' }] },
  { name: 'memories-never', checks: ['step24'], why: 'a copy never carries the team\'s memories', red: ["the copy carries the team's memories"],
    edits: [{ file: AGENTS, anchor: 'const memories = withMemories ? await teamMemories(client, agentId) : []', replace: 'const memories: RecipeMemory[] = []' }] },
  { name: 'template-memories', checks: ['step24'], why: 'a template saves the team\'s memories', red: ['keeps its hooks and none of its memories'],
    edits: [{ file: AGENTS, anchor: 'const recipe = await recipeOf(client, agent.id, false)', replace: 'const recipe = await recipeOf(client, agent.id, true)' }] },
  { name: 'recipe-hooks', checks: ['step24'], why: 'a recipe leaves the hooks out', red: ["the copy carries the agent's skill, plugin, routine and three hooks", 'keeps its hooks and none of its memories'],
    edits: [{ file: AGENTS, anchor: 'hooks: await hooksOf(client, agentId), memories })', replace: 'hooks: [], memories })' }] },
  { name: 'install-hooks', checks: ['step24'], why: 'a recipe\'s hooks are not given to the new agent', red: ["the copy carries the agent's skill, plugin, routine and three hooks", 'a new agent started from the template has the hooks'],
    edits: [{ file: AGENTS, anchor: '  for (const hook of recipe.hooks) await saveHook(client, person, agentId, hook)\n', replace: '' }] },
  { name: 'plugin-values', checks: ['step24'], why: 'a plugin that holds a secret value is copied as it is', red: ['a plugin that holds a secret value is not copied'],
    edits: [
      { file: TYPES, anchor: 'env: z.record(z.string(), SecretRef).optional()', replace: 'env: z.record(z.string(), z.unknown()).optional()' },
      { file: AGENTS, anchor: '  for (const plugin of recipe.plugins) await savePlugin(client, person, agentId, plugin)\n',
        replace: "  for (const plugin of recipe.plugins) await client.query('insert into plugins (agent_id, name, kind, config) values ($1, $2, $3, $4)', [agentId, plugin.name, plugin.kind, JSON.stringify(plugin.config)])\n" },
    ] },
  { name: 'template-default-name', checks: ['step24'], why: 'a template saved with no name is called template', red: ['a template saved with no name is named after the agent'],
    edits: [{ file: AGENTS, anchor: '  const name = given ?? agent.name\n', replace: "  const name = given ?? 'template'\n" }] },
  // Where a copy may go, what it is called, and what it records.
  { name: 'copy-personal-box', checks: ['step24'], why: 'a copy may go on a teammate\'s own box', red: ["a copy cannot go on a teammate's own box"],
    edits: [{ file: AGENTS, anchor: 'if (home.personal && home.owner_id !== agent.ownerId)', replace: 'if (false)' }] },
  { name: 'machine-any-team', checks: ['step24'], why: "a copy may go on another team's machine", red: ["a copy cannot go on another team's machine"],
    edits: [{ file: AGENTS, anchor: "'select id, personal, owner_id from instances where id = $1 and team_id = $2', [agent.homeInstanceId, agent.teamId])", replace: "'select id, personal, owner_id from instances where id = $1 and $2::uuid is not null', [agent.homeInstanceId, agent.teamId])" }] },
  { name: 'copy-name-taken', checks: ['step24'], why: 'a copy may take another agent\'s name', red: ['a copy needs a name no agent has'],
    edits: [{ file: AGENTS, anchor: '  if (taken) throw new HttpError(409, `there is already an agent named ${agent.name}`)\n', replace: '' }] },
  { name: 'copy-provenance', checks: ['step24'], why: 'a copy does not record where it came from', red: ["Bob's copy is his own agent on his machine, made from Alice's"],
    edits: [{ file: AGENTS, anchor: '  if (copiedFrom !== null) {\n', replace: '  if (false) {\n' }] },
  { name: 'copy-avatar', checks: ['step24'], why: 'a copy does not wear the face of the agent it came from', red: ['a copy wears the face of the agent it was copied from'],
    edits: [{ file: AGENTS, anchor: 'copied_from_agent_id = $2, avatar = (select avatar from agents where id = $2) where id = $1', replace: 'copied_from_agent_id = $2 where id = $1' }] },
  { name: 'copy-conversation', checks: ['step24'], why: 'the answer holds some other id for the conversation', red: ["the answer holds Bob's conversation with the copy"],
    edits: [{ file: AGENTS, anchor: 'conversationId: ConversationId.parse(conversationId)', replace: 'conversationId: ConversationId.parse(agentId)' }] },
  // What a copy asked for with nothing else gets.
  { name: 'copy-default-memories', checks: ['step24', 'step24b'], why: 'a copy asked for with nothing else leaves out the team\'s memories', red: ["a copy asked for with nothing else carries the team's memories", 'the copy remembers what the team told the agent'],
    edits: [{ file: RECIPE, anchor: 'memories: z.boolean().default(true) })', replace: 'memories: z.boolean().default(false) })' }] },
  { name: 'copy-memories-coerced', checks: ['step24'], why: 'a copy asked for with a word where a yes or no goes is taken as yes', red: ['a copy asked for with a value of the wrong kind is refused'],
    edits: [{ file: RECIPE, anchor: 'memories: z.boolean().default(true) })', replace: 'memories: z.coerce.boolean().default(true) })' }] },
  { name: 'copy-name-suffix', checks: ['step24'], why: 'a copy is named -clone, not -copy', red: ['a copy asked for with nothing else is named after the agent'],
    edits: [{ file: AGENTS, anchor: "source.name, '-copy')", replace: "source.name, '-clone')" }] },
  { name: 'copy-name-free', checks: ['step24'], why: 'a copy takes the first name even when an agent has it', red: ['the next copy takes the next free name'],
    edits: [{ file: AGENTS, anchor: "    if (!(await maybe(client, 'select 1 from agents where team_id = $1 and name = $2 and archived_at is null', [teamId, name]))) return name\n", replace: '    return name\n' }] },
  { name: 'copy-name-cut', checks: ['step24'], why: 'a copy of an agent with the longest name is named past the limit', red: ['the name of a copy of an agent with the longest name is cut to fit'],
    edits: [{ file: AGENTS, anchor: '`${base.slice(0, NAME_LENGTH - suffix.length)}${suffix}`', replace: '`${base}${suffix}`' }] },
  { name: 'copy-name-lock', checks: ['step24'], why: 'copies asked for together are not named one at a time', red: ['three copies asked for at once get three different names'],
    edits: [
      { file: AGENTS, anchor: '  await lockNames(client, teamId)\n', replace: '' },
      { file: AGENTS, anchor: '  await lockNames(client, person.team_id)\n', replace: '' },
    ] },
  { name: 'copy-machine-personal-first', checks: ['step24'], why: 'a copy goes on the first machine by name, not on the person\'s box', red: ['a person with a box of their own and a Mac gets the box'],
    edits: [{ file: AGENTS, anchor: 'order by personal desc, name limit 1', replace: 'order by name limit 1' }] },
  { name: 'copy-machine-owned', checks: ['step24'], why: 'a person with no machine is given a teammate\'s', red: ['a person with no machine of their own is told to name one'],
    edits: [{ file: AGENTS, anchor: "where team_id = $1 and owner_id = $2 and (personal or kind = 'mac')", replace: "where team_id = $1 and $2::uuid is not null and (personal or kind = 'mac')" }] },
  // The app.
  { name: 'ui-hooks-gate', checks: ['step24b'], why: 'the page offers the hook controls to everyone', red: ['a teammate reads the hooks, and is told who changes them'],
    edits: [{ file: PAGE, anchor: 'canChange={mayChangeHooks(me.person, agent, instances.find((i) => i.id === agent.home_instance_id)?.owner_id ?? null)}', replace: 'canChange={true}' }] },
  { name: 'ui-tools-field', checks: ['step24b'], why: 'every hook line asks which tools it applies to', red: ['takes no tools to match for it'],
    edits: [{ file: HOOKS_UI, anchor: '      {takesMatcher(event) && (', replace: '      {true && (' }] },
  { name: 'ui-default-event', checks: ['step24b'], why: 'the hook line starts on another event than a message', red: ['with a message chosen'],
    edits: [{ file: HOOKS_UI, anchor: "useState<HookEvent>('UserPromptSubmit')", replace: "useState<HookEvent>('Stop')" }] },
  { name: 'ui-chip-pressed', checks: ['step24b'], why: 'no event chip says it is chosen', red: ['with a message chosen', 'choosing a tool event asks which tools'],
    edits: [{ file: HOOKS_UI, anchor: 'aria-pressed={event === e}', replace: 'aria-pressed={false}' }] },
  { name: 'ui-matcher-sent', checks: ['step24b'], why: 'the tools a hook applies to are not sent', red: ['a hook for a tool shows the tools it applies to', 'the hooks are saved with their event and tools'],
    edits: [{ file: HOOKS_UI, anchor: 'matcher: takesMatcher(event) && tools.trim() ? tools.trim() : null', replace: 'matcher: null' }] },
  { name: 'ui-remove', checks: ['step24b'], why: 'Remove does nothing', red: ['Remove takes a hook off the agent'],
    edits: [{ file: HOOKS_UI, anchor: 'onClick={() => { void removal.attempt(() => actions.remove(hook.name)) }}', replace: 'onClick={() => undefined}' }] },
  { name: 'ui-add-refusal', checks: ['step24b'], why: 'the line does not say why a hook was refused', red: ['a command with a secret value is refused, the reason shows in the add line'],
    edits: [{ file: HOOKS_UI, anchor: '      {problem && <p className="error small" role="alert">{problem}</p>}', replace: '      {false && <p className="error small" role="alert">{problem}</p>}' }] },
  { name: 'ui-copy-memories', checks: ['step24b'], why: 'the button asks for a copy without the team\'s memories', red: ['the copy remembers what the team told the agent'],
    edits: [{ file: CALLS_UI, anchor: 'ask: z.input<typeof CopyAsk> = {}', replace: 'ask: z.input<typeof CopyAsk> = { memories: false }' }] },
  { name: 'ui-copy-problem', checks: ['step24b'], why: 'the button does not say why a copy was refused', red: ['a person with no machine of their own is told so beside the button'],
    edits: [{ file: COPY_UI, anchor: '      {problem && (', replace: '      {false && (' }] },
  { name: 'ui-copy-close', checks: ['step24b'], why: 'the note about a refused copy cannot be closed', red: ['Close puts the note away'],
    edits: [{ file: COPY_UI, anchor: '<button type="button" className="link small" onClick={dismiss}>', replace: '<button type="button" className="link small" onClick={() => undefined}>' }] },
  { name: 'ui-copy-opened', checks: ['step24b'], why: 'the copy is made and the person stays where they were', red: ['one tap makes the copy, named after the agent, and opens it'],
    edits: [{ file: COPY_UI, anchor: '    if (made) opened(made)\n', replace: '' }] },
  { name: 'ui-provenance', checks: ['step24b'], why: 'the copy does not say where it came from', red: ['saying which agent it was copied from'],
    edits: [{ file: PAGE, anchor: '{agent.copied_from_agent_id && <p className="muted small">Copied from', replace: '{false && <p className="muted small">Copied from' }] },
  { name: 'ui-hook-added', checks: ['step24b'], why: 'the page does not say what the new hook was named', red: ['the page says what it was named'],
    edits: [{ file: HOOKS_UI, anchor: '        {added && <p className="muted small" role="status">Added {added}.</p>}\n', replace: '' }] },
  { name: 'ui-hook-line', checks: ['step24b'], why: 'the session panel leaves out a hook\'s run', red: ["the session lists the hook's run"],
    edits: [{ file: 'shared/history.ts', anchor: "export const SHOWN_NOTICES = ['init', 'interrupted', 'screen', 'hook_response'] as const", replace: "export const SHOWN_NOTICES = ['init', 'interrupted', 'screen'] as const" }] },
]

// The recipe file's breaks. They go with step24c and the files it checks, and can be left out with them.
BREAKS.push(
  { name: 'export-memories-flag', checks: ['step24c'], why: "an export holds the team's memories whether or not they were asked for", red: ['an export is a recipe file'],
    edits: [{ file: 'server/recipe-files.ts', anchor: 'const recipe = await recipeOf(client, agent.id, withMemories)', replace: 'const recipe = await recipeOf(client, agent.id, true)' }] },
  { name: 'export-unscrubbed', checks: ['step24c'], why: 'a key pasted into a skill leaves the team in a file as it was', red: ['a key someone pasted into a skill leaves the team scrubbed'],
    edits: [{ file: 'server/recipe-files.ts', anchor: 'scrub({ format: RECIPE_FILE_FORMAT, version: 1, name: agent.name, recipe })', replace: '({ format: RECIPE_FILE_FORMAT, version: 1, name: agent.name, recipe })' }] },
  { name: 'import-key-accepted', checks: ['step24c'], why: 'an import takes a file that holds a key', red: ['an import refuses a file that is no recipe, one that holds a key'],
    edits: [{ file: 'server/recipe-files.ts', anchor: 'if (!isDeepStrictEqual(scrub(ask.file), ask.file)) {', replace: 'if (false) {' }] },
  { name: 'import-too-much', checks: ['step24c'], why: 'an import takes a file with any number of hooks', red: ['a file with more than a thousand of a thing is refused'],
    edits: [{ file: 'shared/recipe-file.ts', anchor: '.every((list) => list.length <= MAX_RECIPE_ITEMS)', replace: '.every((list) => list.length >= 0)' }] },
  { name: 'route-memories-flag', checks: ['step24c'], why: 'an export takes any word for whether to carry memories', red: ['memories must be true or false'],
    edits: [{ file: 'server/api.ts', anchor: "    if (memories !== 'true' && memories !== 'false') throw new HttpError(400, 'memories must be true or false')\n", replace: '' }] },
  { name: 'import-default-name', checks: ['step24c'], why: 'an import sent no name takes the file\'s name even when it is taken', red: ['an import sent only the file takes the next free name'],
    edits: [{ file: 'server/recipe-files.ts', anchor: "freeName(client, person.team_id, ask.file.name, '')", replace: 'ask.file.name' }] },
  { name: 'import-default-machine', checks: ['step24c'], why: 'an import sent no machine goes nowhere', red: ['an import sent only the file takes the next free name'],
    edits: [{ file: 'server/recipe-files.ts', anchor: 'ask.homeInstanceId ?? await defaultMachine(client, person)', replace: "ask.homeInstanceId ?? ''" }] },
  { name: 'ui-export-memories-default', checks: ['step24c'], why: "the export starts with the team's memories chosen", red: ["the export counts the team's memories and starts without them"],
    edits: [{ file: 'app/src/agent/RecipeFile.tsx', anchor: 'const [withMemories, setWithMemories] = useState(false)', replace: 'const [withMemories, setWithMemories] = useState(true)' }] },
  { name: 'ui-import-hides-commands', checks: ['step24c'], why: 'the import does not show the commands a file would run', red: ['the page shows each hook and plugin command the file would run'],
    edits: [{ file: 'app/src/agent/RecipeFile.tsx', anchor: '<ul className="items" aria-label="What the file runs">', replace: '<ul hidden className="items" aria-label="What the file runs">' }] },
)

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

function runCheck(name: CheckName): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = name === 'step24b' || name === 'step24c' ? { ...process.env, AGENTS_UI_ENGINES: 'chromium' } : process.env
    const child = spawn(process.execPath, ['--env-file=.env', '--env-file=.env.test', `test/${name}.ts`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
  let output = ''
  try {
    for (const [file, text] of files) writeFileSync(at(file), text)
    for (const check of b.checks) output += `\n${await runCheck(check)}`
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
    detail: missing.length ? `${lines(fails.length)} went red, and none held "${missing.join('" or "')}". Red: ${fails.map((l) => l.slice(0, 120)).join(' | ')}` : `${lines(fails.length)} went red, and the files are back byte for byte`,
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
for (const name of new Set(chosen.flatMap((b) => b.checks))) {
  const control = redLines(await runCheck(name))
  console.log(`${control.length ? 'FAIL' : 'pass'}  control: ${name} with nothing broken${control.length ? ` has ${String(control.length)} red lines, so no break can be judged` : ' is green'}`)
  if (control.length) process.exit(1)
}
for (const b of chosen) {
  const result = await runBreak(b)
  console.log(`${result.ok ? 'pass' : 'FAIL'}  ${b.name}: ${b.why}. ${result.detail}`)
  if (!result.ok) failed++
}
console.log(`\n${failed ? `${String(failed)} breaks were not seen failing` : `all ${String(chosen.length)} breaks were seen failing, and every file is back as it was`}`)
process.exit(failed ? 1 : 0)
