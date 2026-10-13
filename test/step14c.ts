// Step 14, the app's other views, in Chromium, Firefox and WebKit at desktop and
// phone width. A person saves a draft and a teammate edits and starts it. Tasks
// wait on each other, one is held and lifted, and Ready and Held follow. The
// palette works by keyboard alone, and single keys never fire in a field. A
// comment pins to the second of two matching lines and jumps to it. A run's page
// shows its changes and a gate whose buttons say what they do. With accessibility
// scans and screenshots to look at.
//   node --env-file=.env --env-file=.env.test test/step14c.ts
//   AGENTS_UI_ENGINES=chromium node --env-file=.env --env-file=.env.test test/step14c.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, firefox, webkit, type BrowserType, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import pg from 'pg'
import { forgeAdmin, forgeConfig } from '../server/forge.ts'
import { must } from './must.ts'

const ROOT = new URL('..', import.meta.url).pathname
const SHOTS = join(ROOT, 'test', 'ui-shots')
// Ports 7960 to 7979 are this step's. This check: machines, people, streams.
const PORT = 7970
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 1}`
const INSECURE = `http://agents.test:${PORT + 1}`
const ORIGINS: Record<string, string> = { chromium: INSECURE, firefox: INSECURE, webkit: PEOPLE }
const LAUNCH: Record<string, Record<string, unknown>> = {
  chromium: { args: ['--host-resolver-rules=MAP agents.test 127.0.0.1'] },
  firefox: { firefoxUserPrefs: { 'network.dns.localDomains': 'agents.test' } },
  webkit: {},
}
const ENGINES: Record<string, BrowserType> = { chromium, webkit, firefox }
const engines = (process.env.AGENTS_UI_ENGINES ?? 'chromium,webkit,firefox').split(',')
const id = randomBytes(4).toString('hex')
const team = `flow-ux-${id}`
const owner = `owner-flowux-${id}@local`
const [REPO, PIPES] = [`flow-ux-${id}`, `flow-uxpipes-${id}`]
const org = forgeConfig().org
const PHRASE = 'Totals never go below zero.'

const REVIEW = `export default {
  description: 'Writes a changelog, then asks before shipping it.',
  agent: 'writer', runsOn: 'home', spendCapUsd: 1,
  triggers: [{ kind: 'manual' }],
  start: 'write',
  stages: {
    write: { kind: 'agent', prompt: (ctx) => 'Write the changelog for ' + ctx.report.title + ' in ./' + ctx.repo, next: { written: 'review' } },
    review: {
      kind: 'gate', question: () => 'Ship the changelog?', labels: { approve: 'Ship it', reject: 'Send back' },
      next: { approved: { done: 'succeeded', note: 'Shipped.' }, rejected: 'write' },
    },
  },
}
`
const SCENARIO = {
  turns: [
    { match: 'Write the notes', write: { 'task/notes.md': `# Notes\n\n${PHRASE}\n\nCheckout keeps totals honest. ${PHRASE}\n` }, reply: 'Wrote the notes.' },
    { match: 'Ready to start', reply: 'Started on it.' },
  ],
  CHANGELOGRUN: { written: [{ outcome: 'written', summary: 'Wrote the changelog.', write: { [`${REPO}/CHANGELOG.md`]: '# Changelog\n\n- TENOFF stops at zero.\n' } }] },
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const node = (...args: string[]) => execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })

async function visible(page: Page, selector: string, seconds: number, text?: RegExp): Promise<boolean> {
  const locator = text ? page.locator(selector, { hasText: text }) : page.locator(selector)
  return locator.first().waitFor({ state: 'visible', timeout: seconds * 1000 }).then(() => true, () => false)
}

async function gone(page: Page, selector: string, seconds: number, text?: RegExp): Promise<boolean> {
  const locator = text ? page.locator(selector, { hasText: text }) : page.locator(selector)
  return locator.first().waitFor({ state: 'hidden', timeout: seconds * 1000 }).then(() => true, () => false)
}

async function serious(page: Page) {
  const axe = await new AxeBuilder({ page }).analyze()
  const found = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  for (const v of found) console.log(`      ${v.id}: ${v.help} (${v.nodes.length}) ${JSON.stringify(v.nodes[0]?.target)}`)
  return found.length
}

// Nothing scrolls sideways, neither the page nor a box inside it, and nothing is cut off at the right edge.
async function noSideScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth
    && [...document.querySelectorAll('.page-head, .page-body, .panel, .document, dialog[open], .palette-results')]
      .every((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= window.innerWidth + 1))
}

async function within(seconds: number, test: () => Promise<unknown>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(400)
  }
  return false
}

const one = async <T>(sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0] as T | undefined

async function call(login: string, path: string, body: unknown = {}) {
  const res = await fetch(PEOPLE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'tailscale-user-login': login }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

async function run(engine: string, ids: { team: string; writer: string; repo: string; pipeline: string }) {
  const alice = `alice-flowux-${engine}-${id}@local`
  const amir = `amir-flowux-${engine}-${id}@local`
  const browser = await must(ENGINES[engine], engine).launch(LAUNCH[engine])
  const errors: string[] = []
  const open = async (login: string, options: Record<string, unknown> = {}) => {
    const context = await browser.newContext({ baseURL: ORIGINS[engine], extraHTTPHeaders: { 'tailscale-user-login': login }, viewport: { width: 1280, height: 820 }, ...options })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(`${login}: ${error.message}`))
    await page.goto('/')
    return page
  }
  const phoneOf = (login: string) => open(login, { viewport: { width: 390, height: 844 }, isMobile: engine !== 'firefox', hasTouch: engine !== 'firefox' })
  try {
    const page = await open(alice)

    // A draft, saved by one person, edited and started by a teammate.
    await page.getByRole('button', { name: 'New task' }).click()
    const form = page.getByRole('form', { name: 'New task' })
    await form.waitFor()
    await form.getByLabel('What needs doing?').fill(`Draft later (${engine})`)
    await form.getByLabel(`${org}/${REPO}`).check()
    await form.getByRole('button', { name: 'Save draft' }).click()
    check(await visible(page, '.page-head .kicker', 15, /Draft task/) && await page.getByRole('form', { name: 'Edit the draft' }).getByLabel(`${org}/${REPO}`).isChecked(),
      `${engine}: Save draft opens the draft, with its repo picked`)
    check(await visible(page, 'nav [aria-label="Tasks"] button', 15, new RegExp(`Draft later \\(${engine}\\)draft`)), `${engine}: the sidebar marks the draft`)
    await page.screenshot({ path: join(SHOTS, `${engine}-draft-light.png`), fullPage: true })
    check(await serious(page) === 0, `${engine}: the draft page has no serious accessibility problems`)
    const draftUrl = page.url()
    const teammate = await open(amir)
    await teammate.goto(draftUrl)
    const edit = teammate.getByRole('form', { name: 'Edit the draft' })
    await edit.waitFor()
    await edit.getByLabel('What needs doing?').fill(`Ready to start (${engine})`)
    await edit.getByRole('button', { name: 'Save draft' }).click()
    check(await visible(teammate, '[role="status"]', 10, /Saved/), `${engine}: a teammate edits the draft and saves it`)
    await edit.getByRole('button', { name: 'Start task' }).click()
    check(await visible(teammate, '.page-head .kicker', 20, /^Task$/) && await visible(teammate, '.task-messages li.message.agent', 60, /Started on it/),
      `${engine}: the teammate starts it, and the agent answers`)
    const draftPhone = await phoneOf(alice)
    const otherDraft = await call(alice, '/v1/tasks', { title: `Phone draft (${engine})`, instructions: '', agentId: ids.writer, repoIds: [ids.repo], draft: true }) as { taskId: string }
    await draftPhone.goto(`/#/t/${otherDraft.taskId}`)
    await visible(draftPhone, 'section[aria-label="Order of work"]', 15)
    check(await noSideScroll(draftPhone), `${engine}: at phone width the draft page fits without sideways scrolling`)
    await draftPhone.screenshot({ path: join(SHOTS, `${engine}-draft-phone.png`), fullPage: true })

    // The order of work: B waits on A, A is held and lifted, then done.
    const a = (await call(alice, '/v1/tasks', { title: `Base work (${engine})`, instructions: '', agentId: ids.writer, draft: true }) as { taskId: string }).taskId
    const b = (await call(alice, '/v1/tasks', { title: `Stacked work (${engine})`, instructions: '', agentId: ids.writer, draft: true }) as { taskId: string }).taskId
    const ready = page.getByRole('list', { name: 'Ready' })
    await page.goto(`/#/t/${b}`)
    const order = page.getByRole('region', { name: 'Order of work' })
    await order.waitFor()
    await visible(page, `section[aria-label="Order of work"] option`, 15, new RegExp(`Base work \\(${engine}\\)`))
    await order.getByLabel('Task to wait on').selectOption({ label: `Base work (${engine})` })
    await order.getByLabel('Why (optional)').fill('Its branch stacks on the base')
    await order.getByRole('button', { name: 'Add' }).click()
    check(await visible(page, 'ul[aria-label="Waits on"] li', 15, /Base work.*not done · Its branch stacks on the base/),
      `${engine}: a task waits on another, with the reason shown`)
    check(await visible(page, 'nav ul[aria-label="Ready"] button', 15, new RegExp(`Base work \\(${engine}\\)`))
      && await gone(page, 'nav ul[aria-label="Ready"] button', 15, new RegExp(`Stacked work \\(${engine}\\)`)),
    `${engine}: Ready lists the base work and not the work waiting on it`)
    await page.goto(`/#/t/${a}`)
    await order.waitFor()
    await order.getByLabel('Waiting on', { exact: true }).selectOption({ label: 'Waiting on a decision' })
    await order.getByLabel('Reason', { exact: true }).fill('Waiting on Tayler')
    await order.getByRole('button', { name: 'Hold', exact: true }).click()
    check(await visible(page, 'nav ul[aria-label="Held"] button', 15, new RegExp(`Base work \\(${engine}\\).*Waiting on a decision: Waiting on Tayler`))
      && await gone(page, 'nav ul[aria-label="Ready"] button', 15, new RegExp(`Base work \\(${engine}\\)`)),
    `${engine}: a held task leaves Ready and shows under Held with its reason`)
    await page.screenshot({ path: join(SHOTS, `${engine}-order-held-light.png`), fullPage: true })
    check(await serious(page) === 0, `${engine}: the task page with its order of work has no serious accessibility problems`)
    await order.getByRole('button', { name: 'Lift hold' }).click()
    check(await visible(page, 'nav ul[aria-label="Ready"] button', 15, new RegExp(`Base work \\(${engine}\\)`)), `${engine}: lifting the hold puts it back in Ready`)
    await order.getByLabel('Priority', { exact: true }).selectOption({ label: '0, most urgent' })
    check(await visible(page, 'section[aria-label="Order of work"] [role="status"]', 10, /Saved/)
      && await visible(page, 'nav ul[aria-label="Ready"] button', 15, new RegExp(`Base work \\(${engine}\\)priority P0`)),
    `${engine}: changing the priority says it saved, and Ready shows it`)
    await order.getByRole('button', { name: 'Mark done' }).click()
    check(await visible(page, 'section[aria-label="Order of work"] button', 15, /Reopen/)
      && await visible(page, 'nav ul[aria-label="Ready"] button', 15, new RegExp(`Stacked work \\(${engine}\\)`)),
    `${engine}: marking the base work done frees the work waiting on it`)
    await ready.waitFor()

    // The palette, by keyboard alone.
    await page.goto('/')
    await page.locator('body').click({ position: { x: 640, y: 400 } })
    // Keys typed before the palette's field has focus reach the page, where c and r are shortcuts.
    const openPalette = async () => {
      await page.keyboard.press('ControlOrMeta+k')
      return within(5, () => page.evaluate(() => document.activeElement?.getAttribute('role') === 'combobox'))
    }
    // The dialog closes at once, and the app lets it go when the close event arrives,
    // a moment later. A Cmd+K before then would close it again.
    const closed = () => page.locator('dialog.palette').waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false)
    const palette = page.getByRole('dialog', { name: 'Go to' })
    check(await openPalette() && await visible(page, 'dialog.palette[open]', 5),
      `${engine}: ${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+K opens the palette with focus in its field`)
    await page.keyboard.type(`stacked work ${engine}`)
    check(await visible(page, '[role="option"][aria-selected="true"]', 10, new RegExp(`Stacked work \\(${engine}\\)`)), `${engine}: typing finds a task, picked first`)
    await page.screenshot({ path: join(SHOTS, `${engine}-palette-light.png`) })
    check(await serious(page) === 0, `${engine}: the open palette has no serious accessibility problems`)
    await page.keyboard.press('Enter')
    check(await closed() && await within(10, async () => page.url().includes(`/t/${b}`)), `${engine}: Enter opens the task and closes the palette`)
    const focused = () => page.evaluate(() => {
      const element = document.activeElement
      return element ? `${element.tagName} ${element.getAttribute('aria-label') ?? ''}` : ''
    })
    const before = await focused()
    const reopened = await openPalette()
    await page.keyboard.type('nothing matches this')
    const empty = await visible(page, 'dialog.palette', 5, /Nothing matches/)
    await page.keyboard.press('Escape')
    check(empty && await closed(), `${engine}: the palette says when nothing matches, and Escape closes it`)
    check(reopened && before.startsWith('MAIN') && await focused() === before, `${engine}: closing the palette gives focus back to where it was (${before})`)
    const third = await openPalette()
    await page.keyboard.type('new room')
    await page.keyboard.press('Enter')
    check(third && await visible(page, 'form[aria-label="New room"]', 10), `${engine}: the palette's actions work from the keyboard`)

    await page.goto(`/#/t/${b}`)
    await page.getByLabel('Why (optional)').waitFor()
    await page.getByLabel('Why (optional)').fill('c')
    await page.keyboard.press('r')
    const stayed = await within(2, async () => page.url().includes(`/t/${b}`)) && (await page.getByLabel('Why (optional)').inputValue()) === 'cr'
    await page.locator('h1').click()
    await page.keyboard.press('c')
    check(stayed && await visible(page, 'form[aria-label="New task"]', 10), `${engine}: single keys type into a field, and outside one c starts a new task`)
    await page.keyboard.press('r')
    check(await visible(page, 'form[aria-label="New room"]', 10), `${engine}: and r starts a new room`)
    await openPalette()
    await palette.getByLabel('Single-key shortcuts').uncheck()
    await page.keyboard.press('Escape')
    await closed()
    await page.locator('h1').click()
    await page.keyboard.press('c')
    check(await within(3, async () => page.url().includes('/n/room')), `${engine}: single-key shortcuts can be turned off`)
    const palettePhone = await phoneOf(alice)
    await palettePhone.getByRole('button', { name: 'Go to', exact: true }).click()
    await visible(palettePhone, 'dialog.palette[open]', 5)
    check(await noSideScroll(palettePhone), `${engine}: at phone width the palette fits, and the top bar opens it`)
    await palettePhone.screenshot({ path: join(SHOTS, `${engine}-palette-phone.png`) })

    // A comment pinned to the second of two matching lines.
    const notes = await call(alice, '/v1/tasks', { title: `Write the notes (${engine})`, instructions: '', agentId: ids.writer }) as { taskId: string }
    await page.goto(`/#/t/${notes.taskId}`)
    await visible(page, '.artifacts button', 60, /notes\.md/)
    await page.getByRole('list', { name: 'Made by this task' }).getByRole('button', { name: 'notes.md' }).click()
    const doc = page.getByRole('complementary', { name: 'Document' })
    await visible(page, 'aside[aria-label="Document"] .document-body p', 15, /Checkout keeps/)
    await page.evaluate((phrase) => {
      const body = document.querySelector('aside[aria-label="Document"] .document-body')
      if (!body) throw new Error('no document body')
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      const hits: [Text, number][] = []
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n instanceof Text && n.data.includes(phrase)) hits.push([n, n.data.indexOf(phrase)])
      const second = hits[1]
      if (!second) throw new Error('the phrase is not there twice')
      const range = document.createRange()
      range.setStart(second[0], second[1])
      range.setEnd(second[0], second[1] + phrase.length)
      getSelection()?.removeAllRanges()
      getSelection()?.addRange(range)
    }, PHRASE)
    await doc.getByRole('button', { name: 'Use selection' }).click()
    check(await doc.getByLabel('Quote (optional)').inputValue() === PHRASE, `${engine}: Use selection fills the quote from the selected words`)
    await doc.getByLabel(/Comment on version/).fill('This line repeats the first.')
    await doc.getByRole('button', { name: 'Comment', exact: true }).click()
    await visible(page, 'aside[aria-label="Document"] .comment .quote', 15)
    const stored = await within(10, async () => (await one<{ occurrence: number }>(
      `select (c.anchor->>'occurrence')::int as occurrence from comments c join artifacts a on a.id = c.artifact_id where a.task_id = $1`, [notes.taskId]))?.occurrence === 1)
    const marked = await within(10, () => page.evaluate(() => {
      const highlights = CSS.highlights.get('comment-quote')
      const [range] = highlights ? [...highlights] : []
      return range instanceof Range && range.toString() === 'Totals never go below zero.' && Boolean(range.startContainer.parentElement?.textContent.includes('Checkout keeps'))
    }))
    check(stored && marked, `${engine}: the comment pins to the second matching line, and the document marks it there`)
    await doc.locator('.comment .quote').first().click()
    const active = await within(10, () => page.evaluate(() => {
      const highlights = CSS.highlights.get('comment-quote-active')
      const [range] = highlights ? [...highlights] : []
      const box = document.querySelector('aside[aria-label="Document"] .document')?.getBoundingClientRect()
      const at = range instanceof Range ? range.getBoundingClientRect() : null
      return Boolean(at && box && at.top >= box.top && at.bottom <= box.bottom && document.querySelector('.comment.active'))
    }))
    check(active, `${engine}: clicking the quote marks it darker in view, and its comment as the current one`)
    await page.screenshot({ path: join(SHOTS, `${engine}-pinned-comment-light.png`) })
    check(await serious(page) === 0, `${engine}: the document with pinned comments has no serious accessibility problems`)
    await doc.getByLabel('Quote (optional)').fill('Words that are nowhere')
    await doc.getByLabel(/Comment on version/).fill('About something gone.')
    await doc.getByRole('button', { name: 'Comment', exact: true }).click()
    await visible(page, 'aside[aria-label="Document"] .comment .quote', 15, /Words that are nowhere/)
    await doc.locator('.comment .quote', { hasText: 'Words that are nowhere' }).click()
    check(await visible(page, 'aside[aria-label="Document"] [role="status"]', 10, /is not in version 1 any more/), `${engine}: a quote that is not in the version says so`)
    const spot = await page.evaluate(() => {
      const highlights = CSS.highlights.get('comment-quote')
      const [range] = highlights ? [...highlights] : []
      const box = range instanceof Range ? range.getBoundingClientRect() : null
      return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null
    })
    if (spot) await page.mouse.click(spot.x, spot.y)
    check(spot && await visible(page, 'aside[aria-label="Document"] .comment.active', 10, /This line repeats the first/),
      `${engine}: clicking marked text in the document makes its comment the current one`)
    const docPhone = await phoneOf(alice)
    await docPhone.goto(page.url())
    await visible(docPhone, 'aside[aria-label="Document"] .comment .quote', 20)
    check(await noSideScroll(docPhone), `${engine}: at phone width the document and its comments fit without sideways scrolling`)
    await docPhone.screenshot({ path: join(SHOTS, `${engine}-pinned-comment-phone.png`) })

    // A pull request stays on its task once nothing differs from the base, as after
    // the agent takes its change back out. The stand-in for Claude can't delete a
    // file, so the check stores the link the runner makes for a pull request.
    await db.query(`insert into artifacts (team_id, task_id, kind, title, url, state) values ($1, $2, 'link', $3, $4, 'open')`,
      [ids.team, notes.taskId, `Pull request #7 on ${org}/${REPO}`, 'http://forge.invalid/pulls/7'])
    await page.goto(`/#/t/${notes.taskId}`)
    check(await visible(page, 'section[aria-label="Pull requests"] a', 15, /Pull request #7/)
      && await page.getByRole('form', { name: 'Open a pull request' }).count() === 0,
    `${engine}: a task's pull request shows when nothing differs from the base, with no form to open another`)

    // A run's page: its changes, and a gate whose buttons say what they do.
    const { runId } = await call(alice, `/v1/pipelines/${ids.pipeline}/runs`, { title: `CHANGELOGRUN (${engine})`, body: '', repoId: ids.repo }) as { runId: string }
    await page.goto(`/#/r/${runId}`)
    check(await visible(page, 'section.ask-card button', 60, /^Ship it$/) && await visible(page, 'section.ask-card button', 5, /^Send back$/),
      `${engine}: the run's gate shows its own button labels`)
    check(await visible(page, 'section[aria-label="Changes"] button', 30, /CHANGELOG\.md/), `${engine}: the run's page lists its changes`)
    await page.getByRole('region', { name: 'Changes' }).getByRole('button', { name: /CHANGELOG\.md/ }).click()
    check(await visible(page, 'aside[aria-label="File"] .markdown h3', 15, /Changelog/), `${engine}: a run's changed file opens beside it`)
    await page.screenshot({ path: join(SHOTS, `${engine}-run-gate-light.png`) })
    check(await serious(page) === 0, `${engine}: the run page with its gate and a file open has no serious accessibility problems`)
    const runPhone = await phoneOf(alice)
    await runPhone.goto(`/#/r/${runId}`)
    await visible(runPhone, 'section.ask-card button', 30, /Ship it/)
    check(await noSideScroll(runPhone), `${engine}: at phone width the run page fits without sideways scrolling`)
    await runPhone.screenshot({ path: join(SHOTS, `${engine}-run-gate-phone.png`), fullPage: true })
    await page.getByRole('button', { name: 'Close' }).click()
    await page.getByRole('button', { name: 'Ship it' }).click()
    check(await visible(page, '.note-line', 60, /Shipped/), `${engine}: the labeled approve button approves the gate`)

    check(errors.length === 0, `${engine}: no page errors${errors.length ? ` (${errors.join('; ')})` : ''}`)
  } finally {
    await browser.close()
  }
}

process.on('SIGTERM', () => {
  for (const child of children) child.kill('SIGTERM')
  process.exit(1)
})

try {
  mkdirSync(SHOTS, { recursive: true })
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, owner)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `flow-mac-${id}`, 'mac', owner)) as { token: string }
  for (const engine of engines) {
    node('server/admin.ts', 'add-person', team, `alice-flowux-${engine}-${id}@local`)
    node('server/admin.ts', 'add-person', team, `amir-flowux-${engine}-${id}@local`)
  }
  const { agentId: writer } = JSON.parse(node('server/admin.ts', 'add-agent', team, 'writer', `flow-mac-${id}`, '', 'You write docs.')) as { agentId: string }
  const seed = (file: string) => readFileSync(join(ROOT, 'ops/seed/shop', file), 'utf8')
  await forgeAdmin.ensureRepo(REPO, { 'checkout.js': seed('checkout.js'), 'package.json': seed('package.json') }, 'step 14c', false)
  await forgeAdmin.ensureRepo(PIPES, { 'shared/pipeline.ts': readFileSync(join(ROOT, 'shared/pipeline.ts'), 'utf8'), 'pipelines/review.ts': REVIEW }, 'step 14c pipelines', false)
  const { id: teamId } = must(await one<{ id: string }>('select id from teams where name = $1', [team]), 'the team')
  const repo = must(await one<{ id: string }>('insert into repos (team_id, remote_url) values ($1, $2) returning id', [teamId, `${forgeConfig().url}/${org}/${REPO}.git`]), 'the repo').id
  await db.query('insert into repos (team_id, remote_url) values ($1, $2)', [teamId, `${forgeConfig().url}/${org}/${PIPES}.git`])

  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step14c-')))
  writeFileSync(join(home, 'scenario.json'), JSON.stringify(SCENARIO))
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  children.push(spawn(process.execPath, ['--env-file=.env', 'server/api.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_PORT: String(PORT + 1), AGENTS_STREAMS_PORT: String(PORT + 2), AGENTS_STREAMS_DIR: join(home, 'streams') },
  }))
  await within(20, () => fetch(API).then(() => true, () => false))
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home, AGENTS_CLAUDE_BIN: join(ROOT, 'test/fake-claude.ts'), AGENTS_FAKE_SCENARIO: join(home, 'scenario.json') },
  }))
  await within(20, async () => (await one<{ status: string }>('select status from instances where name = $1', [`flow-mac-${id}`]))?.status === 'online')
  await within(60, async () => (await one('select 1 from pipelines where team_id = $1 and name = $2 and current_version_id is not null', [teamId, 'review'])))
  const pipeline = must(await one<{ id: string }>('select id from pipelines where team_id = $1 and name = $2', [teamId, 'review']), 'the review pipeline').id
  for (const engine of engines) await run(engine, { team: teamId, writer, repo, pipeline })
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).stack ?? ''}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) {
    await db.query('delete from teams where name = $1', [team]).catch(() => undefined)
    for (const repo of [REPO, PIPES]) await forgeAdmin.call('DELETE', `/repos/${org}/${repo}`).catch(() => undefined)
  }
  await db.end().catch(() => undefined)
}

console.log(`\nscreenshots in test/ui-shots\n${failures.length ? `${failures.length} failed (team ${team} and repos kept)` : 'all passed (test team and repos removed)'}`)
process.exit(failures.length ? 1 : 0)
