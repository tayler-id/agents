// The real path, run by hand: the desktop app with your own config, over
// Tailscale, against the real server, daemon and agent. It leaves one DM with
// the agent in your team.
//   node --env-file=.env test/real.ts [agent name] [message]

import { join } from 'node:path'
import { _electron as electron } from '@playwright/test'

const ROOT = new URL('..', import.meta.url).pathname
const agent = process.argv[2] ?? 'assistant'
const message = process.argv[3] ?? 'Reply with the single word: ready'
const failures: string[] = []
const check = (ok: unknown, label: string) => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const env = Object.fromEntries(Object.entries(process.env)
  .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'AGENTS_SERVER' && entry[0] !== 'AGENTS_DEV_LOGIN'))
const desktop = await electron.launch({ args: [join(ROOT, 'desktop', 'main.cjs')], env })
try {
  const window = await desktop.firstWindow()
  const login = await window.locator('.team .muted').first().textContent({ timeout: 30000 }).catch(() => null)
  check(login && login.includes('@'), `the app knows you over Tailscale (${login ?? 'no login'})`)
  await window.getByRole('list', { name: 'Agents' }).getByRole('button', { name: agent, exact: true }).click()
  const before = await window.locator('li.message.agent:not(.typing)').count()
  await window.getByRole('textbox', { name: 'Message' }).fill(message)
  await window.getByRole('textbox', { name: 'Message' }).press('Enter')
  const replied = await window.waitForFunction((n) => document.querySelectorAll('li.message.agent:not(.typing)').length > n, before, { timeout: 180000 })
    .then(() => true, () => false)
  check(replied, `${agent} answered through your Mac's daemon`)
  await window.screenshot({ path: join(ROOT, 'test', 'ui-shots', 'real-path.png') })

  // The factory and setup views, read only.
  const pipelines = window.getByRole('list', { name: 'Pipelines' })
  const pipeline = pipelines.getByRole('button').first()
  check(await pipeline.waitFor({ timeout: 30000 }).then(() => true, () => false), "your team's pipelines are listed")
  await pipeline.click()
  check(await window.locator('table.versions tbody tr.current').first().waitFor({ timeout: 30000 }).then(() => true, () => false),
    'a pipeline page shows its current version')
  await window.screenshot({ path: join(ROOT, 'test', 'ui-shots', 'real-pipeline.png') })
  await window.getByRole('list', { name: 'Agents' }).getByRole('button', { name: agent, exact: true }).click()
  await window.getByRole('button', { name: 'Agent setup' }).click()
  check(await window.locator('.page-head h1', { hasText: agent }).waitFor({ timeout: 30000 }).then(() => true, () => false),
    `${agent}'s setup page opens`)
  await window.screenshot({ path: join(ROOT, 'test', 'ui-shots', 'real-agent.png') })
  const machines = await window.getByRole('list', { name: 'Machines' }).innerText()
  check(/online/.test(machines), `the machines list shows a machine online: ${machines.replace(/\s+/g, ' ')}`)
} finally {
  await desktop.close()
}
console.log(failures.length ? `\n${failures.length} failed` : '\nthe real path works')
process.exit(failures.length ? 1 : 0)
