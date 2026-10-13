// Onboarding in the app, in Chromium, Firefox and WebKit, at desktop and phone
// width. An admin invites someone from the Team page and reads the invite link,
// and the invited person opens the app and is on the team at once. A login with
// no invite sees the waiting screen until an admin adds it with one click, then
// the app opens by itself. Members see the team but none of the admin forms.
// Scans for accessibility problems and takes screenshots (light, dark, phone).
//   npm run check:step12b
//   AGENTS_UI_ENGINES=chromium npm run check:step12b

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, firefox, webkit, type BrowserType, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import pg from 'pg'
import { fakeTailscale } from './fake-tailscale.ts'
import { asPerson, results, ROOT, startApi, within } from './onboarding-kit.ts'
import { must } from './must.ts'

const PORTS = { machines: 7927, people: 7928, streams: 7929 }
const TAILSCALE_PORT = 7930
const SHOTS = join(ROOT, 'test', 'ui-shots')
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

const id = randomBytes(4).toString('hex')
const team = `onboard-12b-${id}`
const owner = `owner12b-${id}@example.com`
const key = `tskey-api-k${id}CNTRL-${randomBytes(16).toString('hex')}`
const home = mkdtempSync(join(tmpdir(), 'agents-step12b-'))
const memberOf = (engine: string) => `mem12b-${engine}-${id}@example.com`
const waitingOf = (engine: string) => `gh12b-${engine}-${id}@github`

const { failures, check } = results()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const tailscale = fakeTailscale({ key, keyExpiresInDays: 60, domain: 'example.com' })
const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
const api = startApi(PORTS, {
  AGENTS_RUNNER_TEAMS: team,
  AGENTS_TAILSCALE_API: tailscale.url(TAILSCALE_PORT),
  AGENTS_TAILSCALE_KEY_FILE: join(home, 'tailscale-api.json'),
  // An image that is never built, so no containers start for the boxes people get here.
  AGENTS_BOX_IMAGE: `agents-box:onboard-absent-${id}`,
  AGENTS_BOX_DOCKER_ARGS: JSON.stringify(['--pull', 'never']),
}, join(home, 'streams'))

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

// The page fits the screen: nothing scrolls sideways, not the page and not
// inside its scrolling body, and the named parts end inside it.
async function fits(page: Page, selectors: string[]) {
  return page.evaluate((list) => document.documentElement.scrollWidth <= window.innerWidth
    && [...document.querySelectorAll('.page-body')].every((body) => body.scrollWidth <= body.clientWidth)
    && list.every((selector) => [...document.querySelectorAll(selector)].every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1)), selectors)
}

async function run(engine: string) {
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const errors: string[] = []
  const open = async (login: string, options: Record<string, unknown> = {}, name?: string) => {
    const context = await browser.newContext({
      baseURL: ORIGINS[engine], viewport: { width: 1280, height: 820 },
      extraHTTPHeaders: { 'tailscale-user-login': login, ...(name ? { 'tailscale-user-name': name } : {}) }, ...options,
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(`${login}: ${error.message}`))
    await page.goto('/')
    return page
  }
  try {
    const invited = `Inv12b-${engine}-${id}@Mail.test`
    const waiting = waitingOf(engine)

    // An admin invites someone from the Team page.
    const admin = await open(owner)
    await admin.getByRole('button', { name: /^Team/ }).click()
    check(await visible(admin, '.page-head h1', 15, new RegExp(team)), `${engine}: the Team link opens the team's page`)
    await admin.getByLabel('Email').fill(invited)
    await admin.getByRole('button', { name: 'Invite', exact: true }).click()
    const said = await visible(admin, '.result', 15, new RegExp(`Invited ${invited.toLowerCase()}`))
    const made = [...tailscale.state.invites.values()].find((i) => i.email === invited.toLowerCase())
    check(said && made?.inviteUrl && await admin.getByLabel('Invite link, to send yourself').inputValue() === made.inviteUrl,
      `${engine}: inviting says who was invited and shows the link Tailscale made`)
    check(await visible(admin, 'ul[aria-label="Invited"] li', 15, new RegExp(invited.toLowerCase())), `${engine}: the invite is listed as open`)
    const doomed = `cancel12b-${engine}-${id}@mail.test`
    await admin.getByLabel('Email').fill(doomed)
    await admin.getByRole('button', { name: 'Invite', exact: true }).click()
    await admin.getByRole('button', { name: `Cancel the invite for ${doomed}` }).click()
    check(await visible(admin, '[role="status"]', 10, /Cancelled the invite/)
      && await within(15, async () => !(await admin.locator('ul[aria-label="Invited"] li', { hasText: doomed }).count())),
    `${engine}: cancelling an invite takes it off the list`)
    await admin.screenshot({ path: join(SHOTS, `${engine}-team-light.png`), fullPage: true })
    check(await serious(admin) === 0, `${engine}: the Team page has no serious accessibility problems`)

    // The invited person opens the app and is on the team at once.
    const newcomer = await open(invited.toLowerCase(), {}, `Invited ${engine}`)
    check(await visible(newcomer, '.team strong', 15, new RegExp(team)), `${engine}: the invited person opens the app straight onto the team`)
    const machines = newcomer.getByRole('list', { name: 'Machines' })
    const ownBox = machines.locator('li', { hasText: new RegExp(`box-inv12b-${engine}-${id}`) }).getByText('yours', { exact: true })
    const listed = await ownBox.waitFor({ timeout: 20_000 }).then(() => true, () => false)
    // Seen, not only present: the label ends inside the sidebar rather than clipped past its edge.
    const inside = listed && await newcomer.evaluate(() => {
      const label = [...document.querySelectorAll('nav [aria-label="Machines"] li span')].find((s) => s.textContent === 'yours')
      const sidebar = document.querySelector('nav.sidebar')
      return Boolean(label && sidebar) && (label?.getBoundingClientRect().right ?? Infinity) <= (sidebar?.getBoundingClientRect().right ?? 0)
    })
    check(inside && !(await machines.getByRole('button', { name: 'Release' }).count()),
      `${engine}: their own box shows in their machines list as theirs, with nothing to release`)
    check(await within(20, async () => (await admin.locator('ul[aria-label="People"] li', { hasText: `Invited ${engine}` }).count()) > 0),
      `${engine}: the admin sees them among the team's people`)

    // A login with no invite waits, and one click lets them in.
    const stranger = await open(waiting, {}, `Waiting ${engine}`)
    check(await visible(stranger, 'main[aria-label="Waiting to join"] h1', 15, /not on a team yet/)
      && await visible(stranger, 'main[aria-label="Waiting to join"] strong', 5, new RegExp(waiting)),
    `${engine}: a login with no invite sees the waiting screen, which names it`)
    await stranger.screenshot({ path: join(SHOTS, `${engine}-waiting-light.png`) })
    check(await serious(stranger) === 0, `${engine}: the waiting screen has no serious accessibility problems`)
    // Logins on no team belong to no team, so the count covers every waiting login on the server.
    const waitingNow = async () => Number((await db.query(`select count(*)::int as n from join_requests where status = 'waiting'`)).rows[0]?.n)
    const counted = await within(25, async () => {
      const n = await waitingNow()
      return admin.locator('nav button', { hasText: `Team · ${n} ${n === 1 ? 'wants' : 'want'} to join` }).count()
    })
    check(counted, `${engine}: the sidebar tells the admin how many want to join`)
    check(await visible(admin, 'ul[aria-label="Wants to join"] li', 15, new RegExp(`Waiting ${engine}`)), `${engine}: the Team page lists them under Wants to join`)
    await admin.getByRole('button', { name: `Add ${waiting}` }).click()
    check(await visible(admin, '[role="status"]', 10, new RegExp(`Added ${waiting}`)), `${engine}: one click adds them`)
    check(await visible(stranger, '.team strong', 20, new RegExp(team)), `${engine}: the waiting screen opens the app by itself once they are added`)

    // A member sees the team, and none of the admin's forms.
    const memberPage = await open(memberOf(engine))
    await memberPage.getByRole('button', { name: /^Team/ }).click()
    check(await visible(memberPage, 'ul[aria-label="People"] li', 15) && !(await memberPage.getByRole('form', { name: 'Invite someone' }).count())
      && !(await memberPage.locator('ul[aria-label="Wants to join"]').count()) && !(await memberPage.locator('ul[aria-label="Invited"]').count()),
    `${engine}: a member sees the team's people but no invites, no waiting list and no invite form`)

    const dark = await open(owner, { colorScheme: 'dark' })
    await dark.goto('/#/team')
    await visible(dark, 'ul[aria-label="People"] li', 15)
    await dark.screenshot({ path: join(SHOTS, `${engine}-team-dark.png`), fullPage: true })
    const phone = await open(owner, phoneOf(engine))
    await phone.goto('/#/team')
    await visible(phone, 'ul[aria-label="People"] li', 15)
    const teamFits = await fits(phone, ['.page-head', '.page-body', '.items', '#invite-email', '#invite-role', 'button.primary'])
    await phone.screenshot({ path: join(SHOTS, `${engine}-team-phone.png`), fullPage: true })
    const phoneStranger = await open(`gh12b-phone-${engine}-${id}@github`, phoneOf(engine))
    await visible(phoneStranger, 'main[aria-label="Waiting to join"] h1', 15)
    const waitingFits = await fits(phoneStranger, ['main'])
    await phoneStranger.screenshot({ path: join(SHOTS, `${engine}-waiting-phone.png`) })
    check(teamFits && waitingFits, `${engine}: at phone width the Team page and the waiting screen fit without sideways scrolling`)

    check(errors.length === 0, `${engine}: no page errors${errors.length ? ` (${errors.join('; ')})` : ''}`)
  } finally {
    await browser.close()
  }
}

try {
  mkdirSync(SHOTS, { recursive: true })
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, owner)
  for (const engine of engines) node('server/admin.ts', 'add-person', team, memberOf(engine))
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  await tailscale.listen(TAILSCALE_PORT)
  await within(20, () => fetch(PEOPLE).then(() => true, () => false))
  const saved = await asPerson(PEOPLE, owner, 'POST', '/v1/tailscale/key', { key, expires: null })
  if (saved.status !== 200) throw new Error(`could not save the Tailscale key: ${saved.text}`)
  for (const engine of engines) await run(engine)
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack ?? ''}`)
} finally {
  api.child.kill('SIGTERM')
  await tailscale.close()
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
    await db.query(`delete from join_requests where login like $1`, [`gh12b-%-${id}@github`]).catch(() => undefined)
    rmSync(home, { recursive: true, force: true })
  }
  await db.end().catch(() => undefined)
}

console.log(`\nscreenshots in test/ui-shots\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test team removed)'}`)
process.exit(failures.length ? 1 : 0)
