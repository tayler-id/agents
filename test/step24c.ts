// Recipe files, step 7's last part and the part that waits on Tayler's call on decision 11,
// whether templates leave the team. A person on one team exports an agent's setup as a
// file, and a person on another team imports it as an agent of their own. The file holds
// the skills, plugins, routines and hooks, the team's memories only when asked for, and
// no memory about a person and no secret value. Import refuses a file that is not a
// recipe, one that holds a key, and one whose plugin holds a value. In Chromium, WebKit and
// Firefox at desktop and phone width, the export downloads the file and the import form
// shows each command the file would run before it makes the agent.
//   node --env-file=.env --env-file=.env.test test/step24c.ts
//   AGENTS_UI_ENGINES=chromium node --env-file=.env --env-file=.env.test test/step24c.ts

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { chromium, firefox, webkit, type BrowserType, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import pg from 'pg'
import { RecipeFile } from '../shared/recipe-file.ts'
import { asPerson, results, ROOT, startApi, within } from './onboarding-kit.ts'
import { must } from './must.ts'

const SHOTS = join(ROOT, 'test', 'ui-shots')
const PORTS = { machines: 7897, people: 7997, streams: 7898 }
const PEOPLE = `http://127.0.0.1:${PORTS.people}`
const INSECURE = `http://agents.test:${PORTS.people}`
const ORIGINS: Record<string, string> = { chromium: INSECURE, firefox: INSECURE, webkit: PEOPLE }
const LAUNCH: Record<string, Record<string, unknown>> = {
  chromium: { args: ['--host-resolver-rules=MAP agents.test 127.0.0.1'] },
  firefox: { firefoxUserPrefs: { 'network.dns.localDomains': 'agents.test' } },
  webkit: {},
}
const ENGINES: Record<string, BrowserType> = { chromium, webkit, firefox }
const engines = (process.env.AGENTS_UI_ENGINES ?? 'chromium,webkit,firefox').split(',')
const id = randomBytes(4).toString('hex')
const [teamA, teamB] = [`step24c-${id}`, `step24cx-${id}`]
const [alice, dana] = [`alice24c-${id}@local`, `dana24c-${id}@local`]
const TEAM_NOTE = `TEAMNOTE-${id}`
const ABOUT_ALICE = `ABOUTALICE-${id}`
// Shaped like a GitHub token, so the scrubber knows it. A skill that holds one must not leave the team in a file.
const KEY = `ghp_${randomBytes(18).toString('hex')}`

const { failures, check } = results()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
const row = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]
const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows
const same = isDeepStrictEqual
const as = (who: string, method: string, path: string, body?: unknown) => asPerson(PEOPLE, who, method, path, body)

// The parts of an agent's setup, as rows.
const setupOf = async (agentId: string) => ({
  skills: await rows('select name, description, content from skills where agent_id = $1 order by name', [agentId]),
  plugins: await rows('select name, kind, config from plugins where agent_id = $1 order by name', [agentId]),
  routines: await rows(`select name, prompt, trigger_config->>'schedule' as schedule from routines where agent_id = $1 order by name`, [agentId]),
  hooks: await rows('select name, event, matcher, command, timeout_sec as "timeoutSec" from agent_hooks where agent_id = $1 order by name', [agentId]),
  memories: await rows(`select kind, log_date::text as day, content from memories where agent_id = $1 and scope = 'team' order by kind desc`, [agentId]),
})

// Alice's agent, made through the API as her, with memories about the team and about her.
async function makeSource(who: string, name: string, machine: string) {
  const made = await as(who, 'POST', '/v1/agents', { name, homeInstanceId: machine, title: 'Writes release notes', instructions: 'You write release notes.' })
  const agentId = must(made.json?.agentId, 'the agent')
  const setup = (path: string, body: unknown) => as(who, 'POST', `/v1/agents/${agentId}/${path}`, body)
  await setup('skills', { name: 'release-style', description: 'Writing release notes', content: 'One line for each merged pull request.' })
  await setup('skills', { name: 'has-a-key', description: 'A skill someone pasted a key into', content: `Use ${KEY} to publish.` })
  await setup('plugins', { name: 'lucky', kind: 'stdio', config: { command: 'node', args: ['lucky.js'], env: { LUCKY: { secret: 'LUCKY_TOKEN' } } } })
  await setup('routines', { name: 'weekly', schedule: '0 9 * * 5', prompt: 'Draft the release notes.' })
  await setup('hooks', { name: 'note-prompts', event: 'UserPromptSubmit', command: 'mkdir -p task && echo noted >> task/hook-log.txt' })
  await setup('hooks', { name: 'stamp-writes', event: 'PostToolUse', matcher: 'Write', command: 'echo wrote >> task/hook-log.txt', timeoutSec: 20 })
  const person = must(await row('select id, team_id from people where login = $1', [who]), 'the person')
  await db.query(
    `insert into memories (team_id, agent_id, scope, person_id, kind, log_date, content) values
     ($1, $2, 'team', null, 'profile', null, $3), ($1, $2, 'team', null, 'log', current_date, $4), ($1, $2, 'person', $5, 'profile', null, $6)`,
    [person.team_id, agentId, `${TEAM_NOTE} release notes go out on Fridays.`, `${TEAM_NOTE} shipped the checkout fix.`, person.id, `${ABOUT_ALICE} prefers terse notes.`])
  return agentId
}

async function visible(page: Page, selector: string, seconds: number, text?: RegExp): Promise<boolean> {
  const locator = text ? page.locator(selector, { hasText: text }) : page.locator(selector)
  return locator.first().waitFor({ state: 'visible', timeout: seconds * 1000 }).then(() => true, () => false)
}

async function serious(page: Page) {
  const axe = await new AxeBuilder({ page }).analyze()
  const found = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  for (const v of found) console.log(`      ${v.id}: ${v.help} (${v.nodes.length}) ${JSON.stringify(v.nodes[0]?.target)}`)
  return found.length
}

async function noSideScroll(page: Page, selectors: string[]) {
  return page.evaluate((list) => document.documentElement.scrollWidth <= window.innerWidth
    && list.every((selector) => {
      const el = document.querySelector(selector)
      return !el || el.getBoundingClientRect().right <= window.innerWidth + 1
    }), selectors)
}

async function run(engine: string, machineA: string, folder: string) {
  const name = `notes${engine}`
  const source = await makeSource(alice, name, machineA)
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const errors: string[] = []
  const open = async (login: string, options: Record<string, unknown> = {}) => {
    const context = await browser.newContext({ baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': login }, viewport: { width: 1280, height: 820 }, acceptDownloads: true, ...options })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    return page
  }
  try {
    // Alice exports from the agent's page.
    const page = await open(alice)
    await page.goto(`/#/a/${source}`)
    const form = page.getByRole('group', { name: 'Export as a file' })
    check(!await form.getByLabel(/With the team's memories \(2\)/).isChecked(), `${engine}: the export counts the team's memories and starts without them`)
    await form.getByLabel(/With the team's memories/).check()
    const [download] = await Promise.all([page.waitForEvent('download'), form.getByRole('button', { name: 'Export as a file' }).click()])
    const path = join(folder, `${engine}-${download.suggestedFilename()}`)
    await download.saveAs(path)
    const saved = RecipeFile.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    check(download.suggestedFilename() === `${name}.recipe.json` && saved.success && saved.data.recipe.hooks.length === 2 && saved.data.recipe.memories.length === 2
      && saved.data.recipe.skills.some((skill) => skill.content === 'Use [secret:github] to publish.'),
      `${engine}: the export downloads a recipe file with the hooks and the team's memories, and a key a skill held scrubbed`)
    check(await visible(page, '[role="status"]', 10, new RegExp(`Saved ${name}\\.recipe\\.json`)), `${engine}: the export says what it saved`)
    check(!readFileSync(path, 'utf8').includes(ABOUT_ALICE) && !readFileSync(path, 'utf8').includes(KEY), `${engine}: the file holds nothing the agent remembers about a person, and no key`)
    await page.screenshot({ path: join(SHOTS, `${engine}-export-light.png`) })
    check(await serious(page) === 0, `${engine}: the agent page with the export has no serious accessibility problems`)

    // Dana, on another team, imports it from New agent.
    const danaPage = await open(dana)
    await danaPage.goto('/#/n/agent')
    const importForm = danaPage.getByRole('group', { name: 'Start from a file' })
    await importForm.getByLabel('Recipe file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('this is not a recipe') })
    check(await visible(danaPage, '[role="alert"]', 10, /That file is not JSON/), `${engine}: a file that is not JSON is refused in the page`)
    await importForm.getByLabel('Recipe file').setInputFiles({ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'something-else' })) })
    check(await visible(danaPage, '[role="alert"]', 10, /not a recipe from Agents/), `${engine}: a JSON file that is not a recipe is refused in the page`)
    await importForm.getByLabel('Recipe file').setInputFiles(path)
    check(await visible(danaPage, 'ul.items[aria-label="What the file runs"] li', 15, /note-prompts.*mkdir -p task/s)
      && await visible(danaPage, 'ul.items[aria-label="What the file runs"] li', 5, /lucky.*node lucky\.js/s)
      && await visible(danaPage, 'p', 5, /LUCKY_TOKEN/),
    `${engine}: the page shows each hook and plugin command the file would run, and the secret it names, before it makes anything`)
    // It asks for no name and no machine, since the server names the agent from the file and puts it on Dana's own machine.
    check(await visible(danaPage, 'p', 10, new RegExp(`^${name}, from a file`)) && await importForm.getByRole('textbox').count() === 0 && await importForm.getByRole('combobox').count() === 0,
      `${engine}: the import shows the file's name and asks for no name or machine`)
    await danaPage.screenshot({ path: join(SHOTS, `${engine}-import-light.png`), fullPage: true })
    check(await serious(danaPage) === 0, `${engine}: the New agent page with the import open has no serious accessibility problems`)
    const phone = await open(dana, { viewport: { width: 390, height: 844 }, isMobile: engine !== 'firefox', hasTouch: engine !== 'firefox' })
    await phone.goto('/#/n/agent')
    await phone.getByRole('group', { name: 'Start from a file' }).getByLabel('Recipe file').setInputFiles(path)
    await visible(phone, 'ul.items[aria-label="What the file runs"] li', 15, /note-prompts/)
    await phone.screenshot({ path: join(SHOTS, `${engine}-import-phone.png`), fullPage: true })
    check(await noSideScroll(phone, ['.page-head', '.page-body', '.items']), `${engine}: at phone width the import, with the file's commands shown, fits without sideways scrolling`)
    await importForm.getByRole('button', { name: 'Make the agent' }).click()
    // The agent takes the name the file offers, or the next free one.
    const nameShown = await visible(danaPage, '.page-head h1', 20, new RegExp(`^${name}(-\\d+)?$`)) ? (await danaPage.locator('.page-head h1').first().textContent()) ?? '' : ''
    check(nameShown !== '' && await visible(danaPage, 'div.hooks li.hooks-row', 15, /stamp-writes.*After a tool runs · Write/s)
      && await visible(danaPage, 'ul.memories li', 10, new RegExp(TEAM_NOTE)), `${engine}: Make the agent opens the new agent, with its hooks and the team's memories`)
    const made = await row(`select a.id, a.owner_id, a.copied_from_agent_id, p.id as person from agents a join people p on p.login = $2
      where a.team_id = (select id from teams where name = $1) and a.name = $3`, [teamB, dana, nameShown])
    const asImported = await setupOf(must(made?.id, 'the imported agent'))
    const asSource = await setupOf(source)
    // The skill with the key is the one difference, since the file held it scrubbed.
    const names = (setup: Awaited<ReturnType<typeof setupOf>>) => setup.skills.map((skill) => skill.name)
    check(made.owner_id === made.person && made.copied_from_agent_id === null && same({ ...asImported, skills: names(asImported) }, { ...asSource, skills: names(asSource) }),
      `${engine}: the imported agent is Dana's, records no source, and has the setup the file held`)
    check(errors.length === 0, `${engine}: no page errors${errors.length ? ` (${errors.join('; ')})` : ''}`)
  } finally {
    await browser.close()
  }
}

let api: Awaited<ReturnType<typeof startApi>> | null = null
try {
  mkdirSync(SHOTS, { recursive: true })
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', teamA, alice)
  node('server/admin.ts', 'add-team', teamB, dana)
  node('server/admin.ts', 'add-instance', teamA, `mac-a-${id}`, 'mac', alice)
  node('server/admin.ts', 'add-instance', teamB, `mac-b-${id}`, 'mac', dana)
  const idOf = async (name: string) => must(await row('select id from instances where name = $1', [name]), name).id
  const [machineA, machineB] = [await idOf(`mac-a-${id}`), await idOf(`mac-b-${id}`)]
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step24c-')))
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  api = await startApi(PORTS, { AGENTS_RUNNER_TEAMS: `${teamA},${teamB}` }, join(folder, 'streams'))
  check(await within(20, () => fetch(`http://127.0.0.1:${PORTS.machines}`).then(() => true, () => false)), 'the API starts')

  // Through the API.
  const source = await makeSource(alice, 'release-notes', machineA)
  const lean = await as(alice, 'GET', `/v1/agents/${source}/recipe?memories=false`)
  const full = await as(alice, 'GET', `/v1/agents/${source}/recipe?memories=true`)
  const leanFile = RecipeFile.safeParse(lean.json)
  const fullFile = RecipeFile.safeParse(full.json)
  check(lean.status === 200 && leanFile.success && lean.json?.format === 'agents-recipe' && lean.json.version === 1 && leanFile.data.name === 'release-notes'
    && leanFile.data.recipe.hooks.length === 2 && leanFile.data.recipe.memories.length === 0 && leanFile.data.recipe.plugins[0]?.name === 'lucky',
  'an export is a recipe file: its format and version, the agent\'s name, the setup, hooks and plugin included, and no memories unless asked')
  check(full.status === 200 && fullFile.success && fullFile.data.recipe.memories.length === 2 && !full.text.includes(ABOUT_ALICE),
    "with the team's memories asked for, an export holds the profile and the dated log, and nothing about a person")
  check(!lean.text.includes(KEY) && lean.text.includes('[secret:github]') && !full.text.includes(KEY),
    'a key someone pasted into a skill leaves the team scrubbed, not as it was')
  const outsiderExport = await as(dana, 'GET', `/v1/agents/${source}/recipe?memories=false`)
  const badFlag = await as(alice, 'GET', `/v1/agents/${source}/recipe?memories=maybe`)
  check(outsiderExport.status === 404 && badFlag.status === 400, 'a person on another team cannot export the agent, and memories must be true or false')

  // The same file, imported by Dana on team B.
  const file = fullFile.success ? fullFile.data : null
  const imported = await as(dana, 'POST', '/v1/agents/import', { file, name: 'release-notes', homeInstanceId: machineB })
  const importedId = imported.json?.agentId
  const theirs = await row('select owner_id, copied_from_agent_id, title, instructions, team_id from agents where id = $1', [importedId])
  const danaRow = await row('select id, team_id from people where login = $1', [dana])
  check(imported.status === 200 && theirs?.owner_id === danaRow.id && theirs.team_id === danaRow.team_id && theirs.copied_from_agent_id === null
    && same(imported.json?.carried, { skills: 2, plugins: 1, routines: 1, hooks: 2, memories: 2 }),
  `a person on another team makes an agent of their own from the file: ${imported.status} ${JSON.stringify(imported.json?.carried)}`)
  const importedSetup = await setupOf(importedId)
  const sourceSetup = await setupOf(source)
  check(same(importedSetup.hooks, sourceSetup.hooks) && same(importedSetup.plugins, sourceSetup.plugins) && same(importedSetup.routines, sourceSetup.routines)
    && same(importedSetup.memories, sourceSetup.memories) && importedSetup.skills.length === 2,
  'the imported agent has the hooks, plugin, routine and team memories the file held')
  check(importedSetup.skills.some((s) => s.name === 'has-a-key' && s.content === 'Use [secret:github] to publish.'), 'the skill with the key arrived scrubbed')
  check(Number((await row(`select count(*)::int as n from memories where agent_id = $1 and scope = 'person'`, [importedId])).n) === 0
    && (await row(`select scope, stored_in from secrets where agent_id = $1 and name = 'LUCKY_TOKEN'`, [importedId]))?.scope === 'agent',
  "the imported agent has no memory about a person, and its plugin's secret is a name on its page")

  // What an import refuses, each leaving nothing behind.
  const made = async (name: string) => (await row('select 1 as there from agents where name = $1 and team_id = $2', [name, danaRow.team_id]))?.there === 1
  const notRecipe = await as(dana, 'POST', '/v1/agents/import', { file: { format: 'something-else' }, name: 'not-a-recipe', homeInstanceId: machineB })
  const withKey = await as(dana, 'POST', '/v1/agents/import', {
    file: file && { ...file, recipe: { ...file.recipe, instructions: `Publish with ${KEY}.` } }, name: 'has-a-key', homeInstanceId: machineB,
  })
  const withValue = await as(dana, 'POST', '/v1/agents/import', {
    file: file && { ...file, recipe: { ...file.recipe, plugins: [{ name: 'leaky', kind: 'stdio', config: { command: 'node', env: { TOKEN: 'a-value-pasted-in' } } }] } }, name: 'has-a-value', homeInstanceId: machineB,
  })
  const withBadSecret = await as(dana, 'POST', '/v1/agents/import', {
    file: file && { ...file, recipe: { ...file.recipe, plugins: [{ name: 'leaky', kind: 'stdio', config: { command: 'node', env: { TOKEN: { secret: 'not a secret name' } } } }] } }, name: 'has-a-bad-secret', homeInstanceId: machineB,
  })
  const taken = await as(dana, 'POST', '/v1/agents/import', { file, name: 'release-notes', homeInstanceId: machineB })
  const theirMachine = await as(dana, 'POST', '/v1/agents/import', { file, name: 'on-alices-machine', homeInstanceId: machineA })
  const tooMany = await as(dana, 'POST', '/v1/agents/import', {
    file: file && { ...file, recipe: { ...file.recipe, hooks: Array.from({ length: 1001 }, (_, i) => ({ name: `h${i}`, event: 'Stop', matcher: null, command: 'true', timeoutSec: null })) } },
    name: 'too-many', homeInstanceId: machineB,
  })
  check(notRecipe.status === 400 && withKey.status === 400 && /secret value/.test(withKey.json?.error) && withValue.status === 400 && withBadSecret.status === 400
    && !(await made('not-a-recipe')) && !(await made('has-a-key')) && !(await made('has-a-value')) && !(await made('has-a-bad-secret')),
  `an import refuses a file that is no recipe, one that holds a key, and a plugin that holds a value or a secret that is no name, and makes nothing: ${[notRecipe, withKey, withValue, withBadSecret].map((a) => a.status).join(' ')}`)
  check(taken.status === 409 && theirMachine.status === 404 && tooMany.status === 400 && !(await made('on-alices-machine')) && !(await made('too-many')),
    `an import needs a free name and a machine of the person's own team, and a file with more than a thousand of a thing is refused: ${taken.status} ${theirMachine.status} ${tooMany.status}`)

  // Sent only the file, an import names the agent from the file's name, the next free one when that is taken, and puts it on the person's own machine.
  const bare = await as(dana, 'POST', '/v1/agents/import', { file })
  const bareRow = await row('select name, home_instance_id from agents where id = $1', [bare.json?.agentId])
  check(bare.status === 200 && bare.json?.name === 'release-notes-2' && bareRow?.name === 'release-notes-2' && bareRow.home_instance_id === machineB,
    `an import sent only the file takes the next free name and Dana's own machine: ${bare.status} ${JSON.stringify(bare.json?.name)}`)

  for (const engine of engines) await run(engine, machineA, folder)
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  await api?.stop()
  await sleep(500)
  if (!failures.length) await db.query('delete from teams where name = any($1)', [[teamA, teamB]]).catch(() => undefined)
  await db.end().catch(() => undefined)
}

console.log(`\nscreenshots in test/ui-shots\n${failures.length ? `${failures.length} failed (teams ${teamA}, ${teamB} kept)` : 'all passed (test teams removed)'}`)
process.exit(failures.length ? 1 : 0)
