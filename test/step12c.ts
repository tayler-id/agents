// Each person's own box and their own Claude sign-in, end to end, in Chromium,
// WebKit and Firefox at desktop and phone width. A person added to the team gets
// a real box container from this branch's image, and the app shows it starting,
// then ready. They sign in to Claude from the app: their box runs the stand-in
// `claude setup-token`, the link reaches their page, the code they paste reaches
// their box once, and the token lands only in the box's home volume, mode 600.
// An agent they make on their box answers on that token. The token is in no
// table, no log and no answer the browser got. A box restarted in the middle of
// a sign-in fails it and says so.
//
// Boxes reach the check's API over the colima VM's own network. On Docker's
// bridge the box firewall lets containers reach only 7700 and 7701, and a check's
// API listens elsewhere. They reach it through a door the check holds shut until
// the newcomer has seen their box starting, so that state lasts however fast
// Docker starts the container.
//   node --env-file=.env --env-file=.env.test test/step12c.ts
//   AGENTS_UI_ENGINES=chromium node --env-file=.env --env-file=.env.test test/step12c.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium, firefox, webkit, type BrowserType, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import pg from 'pg'
import { asPerson, foundInDatabase, results, ROOT, startApi, within } from './onboarding-kit.ts'
import { must } from './must.ts'
import { messageOf } from '../shared/errors.ts'

const PORTS = { machines: 7932, people: 7933, streams: 7934 }
const DOOR_PORT = 7935
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
// Firefox in Playwright has no mobile mode, so it gets the phone's size only.
const phoneOf = (engine: string) => ({ viewport: { width: 390, height: 844 }, isMobile: engine !== 'firefox', hasTouch: engine !== 'firefox' })
const SHOTS = join(ROOT, 'test', 'ui-shots')
// This Mac as the colima VM reaches it, the address ops/box-firewall.sh names.
const MAC_FROM_VM = '192.168.5.2'
// This branch's own box image, never agents-box:latest.
const IMAGE = 'agents-box:onboard-check'

const id = randomBytes(4).toString('hex')
const team = `onboard-12c-${id}`
const owner = `owner12c-${id}@example.com`
// Box mounts come from the colima VM, which sees only the home folder.
const work = join(homedir(), '.agents-app', 'checks', `onboard-12c-${id}`)
const teamToken = `sk-ant-oat01-team12c${randomBytes(30).toString('hex')}`
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

const { failures, check } = results()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const node = (env: Record<string, string>, ...args: string[]) =>
  execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } })
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
// All a box logged. The daemon writes errors to stderr, which docker logs passes on as its own stderr.
function boxLog(container: string): string {
  const out = spawnSync('docker', ['logs', container], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`docker logs ${container} failed: ${out.stderr}`)
  return out.stdout + out.stderr
}

// The boxes' way to the API. Shut, it hangs up on every new connection, and a
// box's daemon keeps trying until it opens.
const door = { open: false }
const through = new Set<Socket>()
const doorway = createServer((socket) => {
  if (!door.open) {
    socket.destroy()
    return
  }
  const upstream = connect(PORTS.machines, '127.0.0.1')
  for (const end of [socket, upstream]) {
    through.add(end)
    end.on('close', () => through.delete(end))
  }
  socket.on('error', () => upstream.destroy())
  upstream.on('error', () => socket.destroy())
  socket.pipe(upstream).pipe(socket)
})
const row = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0]
let api: Awaited<ReturnType<typeof startApi>> | null = null
// Everything the browsers were sent, to show the token was never in it.
const sent: string[] = []

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

async function fits(page: Page, selectors: string[]) {
  return page.evaluate((list) => document.documentElement.scrollWidth <= window.innerWidth
    && [...document.querySelectorAll('.page-body')].every((body) => body.scrollWidth <= body.clientWidth)
    && list.every((selector) => [...document.querySelectorAll(selector)].every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1)), selectors)
}

async function run(engine: string) {
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const errors: string[] = []
  const open = async (login: string, options: Record<string, unknown> = {}) => {
    const context = await browser.newContext({ baseURL: ORIGINS[engine], viewport: { width: 1280, height: 820 }, extraHTTPHeaders: { 'tailscale-user-login': login }, ...options })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(`${login}: ${error.message}`))
    page.on('response', (response) => {
      if (response.url().includes('/v1/')) response.text().then((text) => { sent.push(text) }, () => undefined)
    })
    await page.goto('/')
    return page
  }
  try {
    const login = `dev12c-${engine}-${id}@mail.test`
    door.open = false
    const added = await asPerson(PEOPLE, owner, 'POST', '/v1/team/people', { login, name: `Dev ${engine}` })
    const personId = must(added.json?.personId, `the person added for ${engine}`)
    const box = must(await row('select id, name from instances where owner_id = $1 and personal', [personId]), 'their box')
    const container = `agents-box-${box.id}`

    // Their box starts, and they watch it.
    const page = await open(login)
    check(await visible(page, 'section[aria-label="Getting started"] li', 20, new RegExp(`${box.name}, is starting`)),
      `${engine}: a newcomer sees their box starting in place of the welcome text`)
    door.open = true
    check(await visible(page, 'section[aria-label="Getting started"] li.done', 120, new RegExp(`${box.name}, is ready`)), `${engine}: then they see it ready`)
    await page.screenshot({ path: join(SHOTS, `${engine}-getting-started-light.png`) })
    const env = docker('inspect', '-f', '{{json .Config.Env}}', container)
    check(docker('inspect', '-f', '{{.Config.Image}}', container) === IMAGE
      && docker('inspect', '-f', '{{range .Mounts}}{{.Name}} {{end}}', container).includes(`${container}-home`)
      && env.includes(`CLAUDE_CODE_OAUTH_TOKEN=${teamToken}`),
    `${engine}: their box is a container from the box image, on its own home volume, with the team's Claude token until they sign in`)

    // They sign in to Claude from the app.
    await page.getByRole('button', { name: 'Set up your box' }).click()
    await page.getByRole('button', { name: 'Sign in to Claude' }).click()
    const linked = await visible(page, 'a[href*="/oauth/authorize?"]', 60)
    check(linked, `${engine}: the sign-in link from their box reaches their page`)
    await page.screenshot({ path: join(SHOTS, `${engine}-box-signin-light.png`), fullPage: true })
    check(await serious(page) === 0, `${engine}: the box page has no serious accessibility problems`)
    const href = must(await page.locator('a[href*="/oauth/authorize?"]').first().getAttribute('href'), 'the sign-in link')
    const link = new URL(href)
    check(link.origin === 'https://claude.com' && link.searchParams.get('scope') === 'user:inference', `${engine}: it is a Claude sign-in link for inference only`)
    const code = `code12c${engine}${randomBytes(6).toString('hex')}#${link.searchParams.get('state') ?? ''}`
    await page.getByLabel("Code from Claude's page").fill(code)
    await page.getByRole('button', { name: 'Send code' }).click()
    check(await visible(page, '[aria-label="Claude sign-in"] [role="status"]', 60, /Signed in to Claude/), `${engine}: after their code, the page says they are signed in`)
    const token = docker('exec', container, 'cat', '/home/agent/.agents-app/claude-token')
    check(/^sk-ant-oat01-[A-Za-z0-9_-]{60,}$/.test(token) && docker('exec', container, 'stat', '-c', '%a', '/home/agent/.agents-app/claude-token') === '600',
      `${engine}: the token is in their box's home volume, mode 600`)
    const until = await row(`select valid_until::text as until from claude_logins where person_id = $1 and status = 'signed_in'`, [personId])
    check(until && Math.abs(Date.parse(until.until.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')) - (Date.now() + 365 * 86_400_000)) < 600_000,
      `${engine}: the app knows the sign-in lasts a year`)

    // An agent on their box answers on their token.
    await page.getByRole('button', { name: 'Make an agent on your box' }).click()
    const form = page.getByRole('form', { name: 'New agent' })
    check(await form.getByLabel('Its machine').locator('option:checked').textContent() === box.name, `${engine}: a new agent's machine starts as their own box`)
    await form.getByLabel('Name').fill(`helper-${engine}`)
    await form.getByRole('button', { name: 'Create agent' }).click()
    await page.getByRole('button', { name: 'Message' }).click()
    await page.getByRole('textbox', { name: 'Message' }).fill('Are you on my account?')
    await page.getByRole('textbox', { name: 'Message' }).press('Enter')
    check(await visible(page, 'li.message.agent', 90, /fake reply/), `${engine}: the agent on their box answers`)
    const agent = must(await row('select id from agents where name = $1 and team_id = (select id from teams where name = $2)', [`helper-${engine}`, team]), 'the agent')
    const starts = docker('exec', container, 'cat', `/home/agent/.agents-app/agents/${agent.id}/.fake/starts.jsonl`).split('\n').filter(Boolean)
    check(starts.length > 0 && starts.every((line) => JSON.parse(line).tokenSha === sha(token)), `${engine}: its session ran with their own Claude token`)

    // A box restarted in the middle of a sign-in says so.
    if (engine === engines[0]) {
      const again = await asPerson(PEOPLE, login, 'POST', '/v1/me/claude-login')
      await within(60, async () => (await row('select status from claude_logins where id = $1', [again.json?.loginId]))?.status === 'waiting_for_code')
      docker('restart', container)
      check(await within(90, async () => (await row('select status, note from claude_logins where id = $1', [again.json?.loginId]))?.note === 'The box restarted during the sign-in. Start it again.'),
        `${engine}: a box restarted during a sign-in fails it and says why`)
      await page.getByRole('button', { name: 'Your box' }).click()
      check(await visible(page, '[aria-label="Claude sign-in"] [role="status"]', 20, /box restarted during the sign-in/), `${engine}: the person reads that on their page`)
      check(docker('exec', container, 'cat', '/home/agent/.agents-app/claude-token') === token, `${engine}: the restart kept the box's sign-in`)
    }

    // Their own sign-ins are theirs alone.
    const theirs = await asPerson(PEOPLE, owner, 'GET', `/v1/shape/claude_logins?offset=-1`)
    check(theirs.status === 200 && !theirs.text.includes(personId), `${engine}: nobody else sees their sign-ins`)

    const dark = await open(login, { colorScheme: 'dark' })
    await dark.goto('/#/box')
    await visible(dark, '[aria-label="Claude sign-in"]', 15)
    await dark.screenshot({ path: join(SHOTS, `${engine}-box-dark.png`), fullPage: true })
    const phone = await open(login, phoneOf(engine))
    await phone.goto('/#/box')
    await visible(phone, '[aria-label="Claude sign-in"]', 15)
    const boxFits = await fits(phone, ['.page-head', '.page-body', '.sign-in'])
    await phone.screenshot({ path: join(SHOTS, `${engine}-box-phone.png`), fullPage: true })
    await phone.goto('/')
    const welcomeFits = await fits(phone, ['.getting-started', '.steps'])
    await phone.screenshot({ path: join(SHOTS, `${engine}-getting-started-phone.png`) })
    check(boxFits && welcomeFits, `${engine}: at phone width the box page and the welcome steps fit without sideways scrolling`)

    // The token went nowhere else.
    const inDb = await foundInDatabase(db, token)
    check(inDb.length === 0 && !must(api, 'the API').text().includes(token) && !boxLog(container).includes(token) && !sent.some((text) => text.includes(token)),
      `${engine}: the token is in no table, no API or box log, and no answer a browser got${inDb.length ? ` (found in ${inDb.join(', ')})` : ''}`)
    check(errors.length === 0, `${engine}: no page errors${errors.length ? ` (${errors.join('; ')})` : ''}`)
  } finally {
    await browser.close()
  }
}

try {
  mkdirSync(SHOTS, { recursive: true })
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'scenario.json'), JSON.stringify({ turns: [] }))
  writeFileSync(join(work, 'team-token'), teamToken, { mode: 0o600 })
  await db.connect()
  await new Promise<void>((resolve, reject) => {
    doorway.once('error', reject)
    doorway.listen(DOOR_PORT, '127.0.0.1', resolve)
  })
  node({}, 'server/migrate.ts')
  node({}, 'server/admin.ts', 'add-team', team, owner)
  node({ AGENTS_BOX_IMAGE: IMAGE }, 'server/boxes.ts', 'build')
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  api = await startApi(PORTS, {
    AGENTS_RUNNER_TEAMS: team,
    AGENTS_BOX_IMAGE: IMAGE,
    AGENTS_BOX_API: `http://${MAC_FROM_VM}:${DOOR_PORT}`,
    AGENTS_BOX_TOKEN_FILE: join(work, 'team-token'),
    AGENTS_BOX_DOCKER_ARGS: JSON.stringify([
      '--network', 'host',
      '-v', `${join(ROOT, 'test/fake-claude.ts')}:/opt/fake/fake-claude.ts:ro`,
      '-v', `${join(ROOT, 'test/fake-claude-login.ts')}:/opt/fake/fake-claude-login.ts:ro`,
      '-v', `${join(work, 'scenario.json')}:/opt/fake/scenario.json:ro`,
      '-e', 'AGENTS_CLAUDE_BIN=/opt/fake/fake-claude.ts', '-e', 'AGENTS_FAKE_SCENARIO=/opt/fake/scenario.json',
    ]),
    AGENTS_TAILSCALE_API: undefined,
    AGENTS_TAILSCALE_KEY_FILE: undefined,
  }, join(work, 'streams'))
  await within(20, () => fetch(PEOPLE).then(() => true, () => false))
  for (const engine of engines) await run(engine)
} catch (error) {
  failures.push(messageOf(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : messageOf(error)}`)
} finally {
  await api?.stop()
  doorway.close()
  for (const end of through) end.destroy()
  // Boxes are removed whatever happened, or they would keep calling a closed port.
  const boxes = await db.query<{ id: string }>(`select i.id from instances i join teams t on t.id = i.team_id where t.name = $1 and i.kind = 'box'`, [team]).catch(() => ({ rows: [] }))
  for (const { id: boxId } of boxes.rows) {
    for (const args of [['rm', '-f', `agents-box-${boxId}`], ['volume', 'rm', `agents-box-${boxId}-home`]]) {
      try {
        execFileSync('docker', args, { stdio: 'ignore' })
      } catch {
        // Already gone, or never made.
      }
    }
  }
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
    rmSync(work, { recursive: true, force: true })
  }
  await db.end().catch(() => undefined)
}

console.log(`\nscreenshots in test/ui-shots\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test team and boxes removed)'}`)
process.exit(failures.length ? 1 : 0)
