// Phase 1 step 4, the desktop app. Launches the real Electron app through
// Playwright against a test server, opens a DM, and gets a live reply from a real
// Claude session.
//   npm run check:step4c

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { _electron as electron } from '@playwright/test'
import pg from 'pg'

const ROOT = new URL('..', import.meta.url).pathname
const SHOTS = join(ROOT, 'test', 'ui-shots')
const PORT = 7803
const API = `http://127.0.0.1:${PORT}`
const PEOPLE = `http://127.0.0.1:${PORT + 100}`
const id = randomBytes(4).toString('hex')
const team = `step4c-${id}`
const login = `desk-${id}@local`
const agentName = `desk-agent-${id}`

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
const children: ChildProcess[] = []
const failures: string[] = []

function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

function node(...args: string[]) {
  return execFileSync(process.execPath, ['--env-file=.env', ...args], { cwd: ROOT, encoding: 'utf8' })
}

try {
  mkdirSync(SHOTS, { recursive: true })
  await db.connect()
  node('server/migrate.ts')
  node('server/admin.ts', 'add-team', team, login)
  const { token } = JSON.parse(node('server/admin.ts', 'add-instance', team, `mac-${id}`, 'mac', login))
  const { agentId } = JSON.parse(node('server/admin.ts', 'add-agent', team, agentName, `mac-${id}`, 'haiku', 'Keep replies to one short sentence.'))
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agents-step4c-')))
  mkdirSync(join(home, 'agents', agentId), { recursive: true })

  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'app/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT })
  const env = { ...process.env, AGENTS_RUNNER_TEAMS: team, AGENTS_API_PORT: String(PORT), AGENTS_PEOPLE_PORT: String(PORT + 100), AGENTS_STREAMS_PORT: '7804', AGENTS_STREAMS_DIR: join(home, 'streams') }
  children.push(spawn(process.execPath, ['server/api.ts'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] }))
  for (let i = 0; i < 80 && !(await fetch(API).then(() => true, () => false)); i++) await sleep(250)
  children.push(spawn(process.execPath, ['daemon/agentsd.ts'], {
    cwd: ROOT, env: { ...process.env, AGENTS_API: API, AGENTS_TOKEN: token, AGENTS_HOME: home }, stdio: ['ignore', 'ignore', 'inherit'],
  }))

  const desktop = await electron.launch({
    args: [join(ROOT, 'desktop', 'main.cjs')],
    env: { ...process.env, AGENTS_SERVER: PEOPLE, AGENTS_DEV_LOGIN: login },
  })
  try {
    const window = await desktop.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    check(await window.locator('.team strong', { hasText: team }).waitFor({ timeout: 20000 }).then(() => true, () => false),
      'the desktop app opens on your team')
    check(await desktop.evaluate(({ app }) => app.getName()) === 'Agents', 'the app is named Agents')
    await window.getByRole('list', { name: 'Agents' }).getByRole('button', { name: agentName, exact: true }).click()
    await window.getByRole('textbox', { name: 'Message' }).fill('Say hello in five words or fewer.')
    await window.getByRole('textbox', { name: 'Message' }).press('Enter')
    check(await window.locator('li.message.agent:not(.typing)').first().waitFor({ timeout: 120000 }).then(() => true, () => false),
      "a message sent from the desktop app gets the agent's reply")
    await window.screenshot({ path: join(SHOTS, 'electron.png') })
  } finally {
    await desktop.close()
  }
} catch (error) {
  failures.push((error as Error).message)
  console.error(`FAIL  ${(error as Error).message}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await sleep(1000)
  if (!failures.length) await db.query('delete from teams where name = $1', [team]).catch(() => {})
  await db.end().catch(() => {})
}

console.log(`\n${failures.length ? `${failures.length} failed (team ${team} kept)` : 'all passed (test team removed)'}`)
process.exit(failures.length ? 1 : 0)
