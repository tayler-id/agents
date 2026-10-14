// Runs inside a box during the step 15 check. It opens a page in Chromium,
// Firefox and WebKit at once with the box's own Playwright, the way agents'
// checks do, keeps them open a few seconds, and prints how long each took to
// load. The check measures the box's memory meanwhile.
//   node box-browsers.ts <path to the playwright package> <url>

import { setTimeout as sleep } from 'node:timers/promises'

// Long enough for docker stats to sample all three engines open at once.
const HOLD_MS = 4000
const [playwrightPath, url] = process.argv.slice(2)
if (!playwrightPath || !url) throw new Error('usage: box-browsers.ts <playwright package> <url>')
// The box's global Playwright, which this repo's own node_modules can't resolve.
const playwright = await import(`${playwrightPath}/index.mjs`)
const results = await Promise.all(['chromium', 'firefox', 'webkit'].map(async (name) => {
  const started = Date.now()
  const browser = await playwright[name].launch()
  const page = await browser.newPage()
  await page.goto(url)
  await page.screenshot()
  const loaded = Date.now() - started
  const title = await page.title()
  await sleep(HOLD_MS)
  await browser.close()
  return `${name} loaded in ${loaded} ms "${title}"`
}))
console.log(results.join('\n'))
