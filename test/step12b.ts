// Onboarding in the app, in Chromium, Firefox and WebKit, at desktop and phone
// width. An admin invites someone from the Team page and reads the invite link,
// and the invited person opens the app and is on the team at once. Their box
// cannot start here, since its image does not exist, and they read why. A login
// with no invite sees the waiting screen until an admin adds it with one click,
// then the app opens by itself. Members see the team but none of the admin forms.
// Someone in a room adds a teammate from its People list. Scans for
// accessibility problems and takes screenshots (light, dark, phone).
//   node --env-file=.env --env-file=.env.test test/step12b.ts
//   AGENTS_UI_ENGINES=chromium node --env-file=.env --env-file=.env.test test/step12b.ts

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

// Types an email into the invite form and sends it. If the button never becomes
// clickable, the error says what the field held and what the button was, which
// tells lost typing from a form that was reset.
async function invite(page: Page, email: string) {
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Invite', exact: true }).click({ timeout: 15_000 }).catch(async (error: unknown) => {
    const seen = await page.evaluate(() => ({
      field: document.querySelector<HTMLInputElement>('#invite-email')?.value,
      button: [...document.querySelectorAll('button')].find((b) => b.textContent === 'Invite')?.disabled ? 'disabled' : 'enabled',
      focused: document.activeElement?.id,
    }))
    throw new Error(`the Invite button could not be clicked (${JSON.stringify(seen)}): ${error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)}`)
  })
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
    await invite(admin, invited)
    const said = await visible(admin, '.result', 15, new RegExp(`Invited ${invited.toLowerCase()}`))
    const made = [...tailscale.state.invites.values()].find((i) => i.email === invited.toLowerCase())
    check(said && made?.inviteUrl && await admin.getByLabel('Invite link, to send yourself').inputValue() === made.inviteUrl,
      `${engine}: inviting says who was invited and shows the link Tailscale made`)
    check(await visible(admin, 'ul[aria-label="Invited"] li', 15, new RegExp(invited.toLowerCase())), `${engine}: the invite is listed as open`)
    const doomed = `cancel12b-${engine}-${id}@mail.test`
    await invite(admin, doomed)
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

    // Their box cannot start here, since its image was never built, and they read why.
    check(await visible(newcomer, 'section[aria-label="Getting started"] li', 30, new RegExp(`box-inv12b-${engine}-${id}, could not start`)),
      `${engine}: a newcomer whose box could not start reads that in the welcome steps`)
    await newcomer.getByRole('button', { name: 'Set up your box' }).click()
    check(await visible(newcomer, 'section[aria-label="Your box"] .box-state', 15, /It could not start/)
      && await visible(newcomer, 'section[aria-label="Your box"] p', 15, /Docker said: .*(No such image|Unable to find image)/),
    `${engine}: their box page says the box could not start, and what Docker said`)
    await newcomer.screenshot({ path: join(SHOTS, `${engine}-box-failed-light.png`), fullPage: true })

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

    // The tailnet, from the Tailscale page. Each browser has users and devices of its own.
    const tag = `${engine}-${id}`
    const pending = `pend12b-${tag}@mail.test`
    const loose = `loose12b-${tag}@mail.test`
    const gone = `gone12b-${tag}@mail.test`
    tailscale.user(pending, `Pending ${engine}`, 'member', 'needs-approval')
    const looseUser = tailscale.user(loose, `Loose ${engine}`)
    const goneUser = tailscale.user(gone, `Gone ${engine}`)
    const tablet = tailscale.device(pending, `tablet-${tag}`, 'android', false, false)
    const old = tailscale.device(owner, `old-${tag}`, 'linux', true, false)
    const consoleInvite = {
      id: String(88000 + engines.indexOf(engine)), role: 'member', tailnetId: 1, inviterId: 1,
      email: `console12b-${tag}@mail.test`, inviteUrl: `https://login.tailscale.com/admin/invite/console-${tag}`,
    }
    tailscale.state.invites.set(consoleInvite.id, consoleInvite)
    await admin.getByRole('button', { name: 'Tailscale', exact: true }).click()
    check(await visible(admin, 'section[aria-label="Tailscale"] dl.facts', 15, new RegExp(`ends in ${key.slice(-4)}`))
      && await visible(admin, 'ul[aria-label="Tailnet users"] li', 15, new RegExp(`${pending}.*needs approval.*not on the team`)),
    `${engine}: the Tailscale page shows the key's last four characters and the tailnet's users with their standing`)
    const users = admin.getByRole('list', { name: 'Tailnet users' })
    await users.getByRole('button', { name: `Approve ${pending}` }).click()
    check(await visible(admin, '[role="status"]', 15, new RegExp(`Approved ${pending}`))
      && await visible(admin, 'ul[aria-label="Tailnet users"] li', 15, new RegExp(`${pending}.*active`)), `${engine}: approving a user shows them active`)
    await users.getByRole('button', { name: `Add ${loose} to the team` }).click()
    // " · on the team", since "not on the team" also holds the words.
    check(await visible(admin, '[role="status"]', 15, new RegExp(`Added ${loose} to the team`))
      && await visible(admin, 'ul[aria-label="Tailnet users"] li', 15, new RegExp(`${loose}.* · on the team`)),
    `${engine}: one click adds a tailnet user to the team`)
    await users.getByLabel(`Tailscale role for ${loose}`).selectOption('auditor')
    check(await visible(admin, '[role="status"]', 15, new RegExp(`${loose} is now auditor`))
      && await within(10, async () => tailscale.state.users.get(looseUser.id)?.role === 'auditor'), `${engine}: changing a tailnet role goes to Tailscale`)
    await users.getByRole('button', { name: `Remove ${gone}` }).click()
    await users.getByRole('button', { name: 'Yes, remove' }).click()
    check(await visible(admin, '[role="status"]', 15, new RegExp(`Removed ${gone}`)) && !tailscale.state.users.has(goneUser.id)
      && await within(10, async () => !(await users.locator('li', { hasText: gone }).count())), `${engine}: removing a user asks first, then takes them off the tailnet`)
    const devices = admin.getByRole('list', { name: 'Tailnet devices' })
    await devices.getByRole('button', { name: `Authorize tablet-${tag}` }).click()
    check(await visible(admin, '[role="status"]', 15, new RegExp(`Authorized tablet-${tag}`)) && tailscale.state.devices.get(tablet.nodeId)?.authorized === true,
      `${engine}: authorizing a device goes to Tailscale`)
    await devices.getByRole('button', { name: `Remove old-${tag}` }).click()
    await devices.getByRole('button', { name: 'Yes, remove' }).click()
    check(await within(15, async () => !tailscale.state.devices.has(old.nodeId) && !(await devices.locator('li', { hasText: `old-${tag}` }).count())),
      `${engine}: removing a device asks first, then takes it off the tailnet`)
    const tailnetInvites = admin.getByRole('list', { name: 'Tailnet invites' })
    check(await admin.getByLabel(`Invite link for ${consoleInvite.email}`).inputValue() === consoleInvite.inviteUrl,
      `${engine}: invites made in Tailscale's console are listed with their links`)
    await tailnetInvites.getByRole('button', { name: `Cancel the invite for ${consoleInvite.email}` }).click()
    check(await within(15, async () => !tailscale.state.invites.has(consoleInvite.id) && !(await tailnetInvites.locator('li', { hasText: consoleInvite.email }).count())),
      `${engine}: cancelling a tailnet invite takes it off Tailscale and the list`)
    await admin.screenshot({ path: join(SHOTS, `${engine}-tailscale-light.png`), fullPage: true })
    check(await serious(admin) === 0, `${engine}: the Tailscale page has no serious accessibility problems`)

    // A key close to its expiry is replaced from the page, and admins are warned.
    const shortKey = `tskey-api-k${id}${engine.slice(0, 2)}CNTRL-${randomBytes(12).toString('hex')}`
    tailscale.useKey(shortKey, 5.5)
    await admin.getByText('Replace the key').click()
    await admin.getByLabel('API access token').fill(shortKey)
    await admin.getByRole('button', { name: 'Save key' }).click()
    check(await visible(admin, '[role="note"][aria-label="Tailscale key"]', 15, /expires in 5 days/)
      && await visible(admin, '[role="note"][aria-label="Tailscale key"]', 5, /Settings, then Keys/)
      && await visible(admin, 'section[aria-label="Tailscale"] dl.facts', 5, new RegExp(`ends in ${shortKey.slice(-4)}`)),
    `${engine}: replacing the key from the page works, and a key five days from expiry warns how to make a new one`)
    await admin.reload()
    check(await visible(admin, 'nav .sidebar-note button', 15, /The Tailscale key expires in 5 days/), `${engine}: the sidebar warns admins the key expires soon`)
    await admin.screenshot({ path: join(SHOTS, `${engine}-tailscale-warning-light.png`), fullPage: true })
    await admin.getByRole('button', { name: /^Team/ }).click()
    check(await visible(admin, 'section[aria-label="Team"] [role="note"]', 15, /expires in 5 days/), `${engine}: the Team page shows the warning too`)

    // Members never see the tailnet.
    await memberPage.goto('/#/tailscale')
    check(await visible(memberPage, 'section[aria-label="Tailscale"] p', 15, /Only team admins manage the tailnet/)
      && !(await memberPage.getByRole('button', { name: 'Tailscale', exact: true }).count()) && !(await memberPage.locator('.sidebar-note').count()),
    `${engine}: a member has no Tailscale link, no key warning, and is told the page is for admins`)

    // A room's people. Someone in the room adds a teammate from its head, and a
    // member outside the room sees who is there but no way to add anyone.
    const roomMade = await asPerson(PEOPLE, memberOf(engine), 'POST', '/v1/conversations', { kind: 'room', name: `room12b-${tag}`, people: [], agents: [] })
    const roomId: string = must(roomMade.json?.conversationId, `the room (${roomMade.status} ${roomMade.text})`)
    await memberPage.goto(`/#/c/${roomId}`)
    await memberPage.getByRole('button', { name: 'People' }).click()
    check(await visible(memberPage, 'ul[aria-label="In the room"] li', 15, /^You$/), `${engine}: the People button shows who is in the room`)
    await memberPage.getByLabel('Teammate', { exact: true }).selectOption(invited.toLowerCase())
    await memberPage.getByRole('form', { name: 'Add a teammate' }).getByRole('button', { name: 'Add', exact: true }).click()
    const joined = async () => (await db.query(
      `select 1 from conversation_members m join people p on p.id = m.person_id where m.conversation_id = $1 and p.login = $2`, [roomId, invited.toLowerCase()])).rows.length === 1
    check(await visible(memberPage, 'section[aria-label="People in the room"] [role="status"]', 15, new RegExp(`Added Invited ${engine} to the room`))
      && await visible(memberPage, 'ul[aria-label="In the room"] li', 15, new RegExp(`^Invited ${engine}$`)) && await joined(),
    `${engine}: someone in the room adds a teammate from its People list, and the list shows them`)
    await memberPage.screenshot({ path: join(SHOTS, `${engine}-room-people-light.png`) })
    check(await serious(memberPage) === 0, `${engine}: a room with its People list open has no serious accessibility problems`)
    await stranger.goto(`/#/c/${roomId}`)
    await stranger.getByRole('button', { name: 'People' }).click()
    check(await visible(stranger, 'section[aria-label="People in the room"] p', 15, /People in the room, and admins, can add a teammate/)
      && await visible(stranger, 'ul[aria-label="In the room"] li', 15, new RegExp(`^Invited ${engine}$`))
      && !(await stranger.getByRole('form', { name: 'Add a teammate' }).count()),
    `${engine}: a member outside the room sees who is in it, and no way to add anyone`)

    const dark = await open(owner, { colorScheme: 'dark' })
    await dark.goto('/#/team')
    await visible(dark, 'ul[aria-label="People"] li', 15)
    await dark.screenshot({ path: join(SHOTS, `${engine}-team-dark.png`), fullPage: true })
    await dark.goto('/#/tailscale')
    await visible(dark, 'ul[aria-label="Tailnet users"] li', 15)
    await dark.screenshot({ path: join(SHOTS, `${engine}-tailscale-dark.png`), fullPage: true })
    const phone = await open(owner, phoneOf(engine))
    await phone.goto('/#/team')
    await visible(phone, 'ul[aria-label="People"] li', 15)
    const teamFits = await fits(phone, ['.page-head', '.page-body', '.items', '#invite-email', '#invite-role', 'button.primary'])
    await phone.screenshot({ path: join(SHOTS, `${engine}-team-phone.png`), fullPage: true })
    await phone.goto('/#/tailscale')
    await visible(phone, 'ul[aria-label="Tailnet users"] li', 15)
    const tailscaleFits = await fits(phone, ['.page-head', '.page-body', '.items', '.notice', 'select.compact'])
    await phone.screenshot({ path: join(SHOTS, `${engine}-tailscale-phone.png`), fullPage: true })
    const phoneStranger = await open(`gh12b-phone-${engine}-${id}@github`, phoneOf(engine))
    await visible(phoneStranger, 'main[aria-label="Waiting to join"] h1', 15)
    const waitingFits = await fits(phoneStranger, ['main'])
    await phoneStranger.screenshot({ path: join(SHOTS, `${engine}-waiting-phone.png`) })
    const phoneRoom = await open(memberOf(engine), phoneOf(engine))
    await phoneRoom.goto(`/#/c/${roomId}`)
    await phoneRoom.getByRole('button', { name: 'People' }).click()
    await visible(phoneRoom, '#room-add', 15)
    const roomFits = await fits(phoneRoom, ['.conversation-head', '.room-people', '.names', '#room-add', '.add-line button'])
    await phoneRoom.screenshot({ path: join(SHOTS, `${engine}-room-people-phone.png`) })
    check(teamFits && tailscaleFits && waitingFits && roomFits,
      `${engine}: at phone width the Team page, the Tailscale page, the waiting screen and a room's People list fit without sideways scrolling`)

    // The next browser starts with the long-lived key again.
    tailscale.useKey(key, 60)
    const restored = await asPerson(PEOPLE, owner, 'POST', '/v1/tailscale/key', { key, expires: null })
    if (restored.status !== 200) throw new Error(`could not put the long-lived key back: ${restored.text}`)

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
  tailscale.user(owner, 'Owner 12b', 'owner')
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
