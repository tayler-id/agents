// The browser backend agentsctl uses today: Playwright, driving Chromium,
// Firefox and WebKit for the web app and Electron for the desktop app. It
// implements the Driver type in driver.ts, and nothing outside this file and
// the session that creates it knows Playwright is underneath.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  _electron as electron, chromium, errors, firefox, webkit,
  type Browser, type BrowserContext, type ElectronApplication, type Locator, type Page, type Request,
} from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import { childEnv, ROOT } from './config.ts'
import { describe, type Driver, type NetworkEntry, type PageKey } from './driver.ts'
import type { Engine, Width } from '../shared/evidence.ts'
import type { Handle } from './protocol.ts'
import type { ReadyState } from './state.ts'
import { instanceRules, VOLATILE } from './visual.ts'
import { messageOf } from '../shared/errors.ts'

const SIZES: Record<Width, { width: number; height: number }> = { desktop: { width: 1280, height: 820 }, phone: { width: 390, height: 844 } }
// Over the tailnet the app is plain HTTP on a name that is not localhost, so
// browsers withhold secure-page APIs such as crypto.randomUUID. Chromium and
// Firefox reach the instance by a made-up name to match. WebKit cannot map a
// name, so it uses the loopback address.
const INSECURE_HOST = 'agents.test'
const LAUNCH: Record<Engine, Parameters<typeof chromium.launch>[0]> = {
  chromium: { args: [`--host-resolver-rules=MAP ${INSECURE_HOST} 127.0.0.1`] },
  firefox: { firefoxUserPrefs: { 'network.dns.localDomains': INSECURE_HOST } },
  webkit: {},
}
const TYPES = { chromium, firefox, webkit }
// Electron takes longer than a browser page to open its first window.
const DESKTOP_START_MS = 30_000
// How often settle() looks for reads still in flight.
const SETTLE_POLL_MS = 100
// Hiding the caret, or stopping animations, makes Playwright add a stylesheet to
// the page. Screenshots leave the page as it is: the app has no animations, and
// captures blur the focused field first.
const SCREENSHOT_CARET = 'initial'
// In WebKit every screenshot still adds <style>body {}</style> for a moment, to
// sync animations (inPagePrepareForScreenshots in Playwright 1.64), and the app's
// Content-Security-Policy refuses it with this console error. The app did not
// cause it, so an error with this message that arrives during our own screenshot
// is dropped. One at any other time is kept.
const SCREENSHOT_STYLE_REFUSED = "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive"

type Recording = { label: string; dir: string }
type Holder = {
  page: Page; context: BrowserContext; app: ElectronApplication | null
  errors: string[]; reads: Set<Request>; network: NetworkEntry[]; recording: Recording | null; tracing: boolean
}

// A read of a shape that answers at once. Live reads (live=true) wait for changes, so they never count.
const isRead = (url: string) => url.includes('/v1/shape/') && !url.includes('live=true')

export function locate(page: Page, handle: Handle): Locator {
  const { within } = handle
  const container = within ? page.getByRole(within.role, within.name === undefined ? {} : { name: within.name, exact: true }) : null
  const scope = container && within?.text !== undefined ? container.filter({ hasText: within.text }) : container ?? page
  const found = scope.getByRole(handle.role, handle.name === undefined ? {} : { name: handle.name, exact: true })
  return handle.text === undefined ? found : found.filter({ hasText: handle.text })
}

// Playwright's errors carry a page of call log. The first line, with the handle, is what a reader needs.
function explain(error: unknown, handle: Handle | undefined, timeoutMs: number): Error {
  if (error instanceof errors.TimeoutError) {
    return new Error(handle ? `${describe(handle)} was not there within ${String(timeoutMs / 1000)}s` : `timed out after ${String(timeoutMs / 1000)}s`)
  }
  const first = (messageOf(error)).split('\n')[0] ?? ''
  const strict = /strict mode violation: .* resolved to (\d+) elements/.exec(first)
  if (strict && handle) return new Error(`${strict[1] ?? 'several'} elements match ${describe(handle)}. Narrow it with --within or --text.`)
  return new Error(first)
}

// The app is loaded once it shows the workspace (its sidebar on a wide screen,
// its menu button on a phone) or says it cannot open.
async function loaded(page: Page, timeoutMs: number) {
  const workspace = page.getByRole('navigation', { name: 'Workspace' })
    .or(page.getByRole('button', { name: 'Menu' }))
    .or(page.getByRole('heading', { name: "Can't open the app" }))
  await workspace.first().waitFor({ state: 'visible', timeout: timeoutMs })
}

const keyOf = (key: PageKey) => (key.target === 'desktop' ? `desktop|${key.width}|${key.login}` : `browser|${key.engine}|${key.width}|${key.login}`)

// `launched` runs after each browser or app starts, so the session can record its processes.
export function playwrightDriver(state: ReadyState, launched: () => Promise<void>): Driver {
  const browsers = new Map<Engine, Browser>()
  const holders = new Map<string, Holder>()
  const origin = (engine: Engine) => `http://${engine === 'webkit' ? '127.0.0.1' : INSECURE_HOST}:${String(state.ports.people)}`

  const watch = (holder: Holder) => {
    const { page } = holder
    page.on('pageerror', (error) => { holder.errors.push(`page error: ${error.message}`) })
    page.on('console', (message) => {
      // The browser logs each failed request as a console error. Those are
      // requests, so network() reports them with their status, and console()
      // keeps to what the app's own code logs and throws.
      if (message.type() !== 'error' || message.text().startsWith('Failed to load resource')) return
      const where = message.location().url
      holder.errors.push(`console: ${message.text()}${where ? ` (${where})` : ''}`)
    })
    page.on('request', (r) => { if (isRead(r.url())) holder.reads.add(r) })
    page.on('requestfinished', (r) => {
      holder.reads.delete(r)
      void r.response().then((response) => {
        holder.network.push({ method: r.method(), url: r.url(), status: response?.status() ?? null, failed: null, ms: Math.round(r.timing().responseEnd) })
      }, (error: unknown) => {
        holder.network.push({ method: r.method(), url: r.url(), status: null, failed: messageOf(error), ms: Math.round(r.timing().responseEnd) })
      })
    })
    page.on('requestfailed', (r) => {
      holder.reads.delete(r)
      holder.network.push({ method: r.method(), url: r.url(), status: null, failed: r.failure()?.errorText ?? 'failed', ms: Math.round(r.timing().responseEnd) })
    })
  }

  const openBrowser = async (key: PageKey, recording: Recording | null): Promise<Holder> => {
    let browser = browsers.get(key.engine)
    if (!browser) {
      browser = await TYPES[key.engine].launch(LAUNCH[key.engine])
      browsers.set(key.engine, browser)
      await launched()
    }
    // Firefox has no mobile mode, so its phone view is only the narrow window.
    const mobile = key.width === 'phone' && key.engine !== 'firefox'
    const context = await browser.newContext({
      baseURL: origin(key.engine), extraHTTPHeaders: { 'tailscale-user-login': key.login }, viewport: SIZES[key.width],
      isMobile: mobile, hasTouch: mobile, locale: 'en-US', timezoneId: 'UTC',
      ...(recording ? { recordVideo: { dir: recording.dir, size: SIZES[key.width] } } : {}),
    })
    const holder: Holder = { page: await context.newPage(), context, app: null, errors: [], reads: new Set(), network: [], recording, tracing: false }
    watch(holder)
    await holder.page.goto('/')
    return holder
  }

  // The desktop app, one per login, each with a home folder of its own so it reads
  // no app.json and shares no browser profile with the desktop app a person runs.
  const openDesktop = async (key: PageKey, recording: Recording | null): Promise<Holder> => {
    const home = join(state.scratch, 'desktop', key.login.replace(/[^a-z0-9]+/gi, '-'))
    mkdirSync(home, { recursive: true })
    const app = await electron.launch({
      args: [`--host-resolver-rules=MAP ${INSECURE_HOST} 127.0.0.1`, `--user-data-dir=${join(home, 'profile')}`, join(ROOT, 'desktop', 'main.cjs')],
      cwd: ROOT,
      env: childEnv('session', { HOME: home, AGENTS_SERVER: origin('chromium'), AGENTS_DEV_LOGIN: key.login, AGENTS_PROXY: '' }),
      ...(recording ? { recordVideo: { dir: recording.dir, size: SIZES[key.width] } } : {}),
    })
    await launched()
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }, s) => { BrowserWindow.getAllWindows()[0]?.setContentSize(s.width, s.height) }, SIZES[key.width])
    const holder: Holder = { page, context: app.context(), app, errors: [], reads: new Set(), network: [], recording, tracing: false }
    watch(holder)
    await loaded(page, DESKTOP_START_MS)
    return holder
  }

  const open = async (key: PageKey, recording: Recording | null = null): Promise<Holder> => {
    const found = holders.get(keyOf(key))
    if (found && !found.page.isClosed()) return found
    const holder = key.target === 'desktop' ? await openDesktop(key, recording) : await openBrowser(key, recording)
    holders.set(keyOf(key), holder)
    return holder
  }

  const held = (key: PageKey): Holder => {
    const holder = holders.get(keyOf(key))
    if (!holder) throw new Error('that page is not open')
    return holder
  }

  const closeHolder = async (key: PageKey) => {
    const holder = holders.get(keyOf(key))
    if (!holder) return
    holders.delete(keyOf(key))
    if (holder.app) await holder.app.close()
    else await holder.context.close()
  }

  // Runs an action on one element, with the error a reader can act on.
  const act = async <T>(key: PageKey, handle: Handle | undefined, timeoutMs: number, action: (page: Page) => Promise<T>): Promise<T> => {
    const { page } = await open(key)
    try {
      return await action(page)
    } catch (error) {
      throw explain(error, handle, timeoutMs)
    }
  }

  const focusedOf = async (page: Page): Promise<string> => {
    const focused = page.locator('*:focus')
    if (!(await focused.count())) return 'nothing (focus is on the page itself)'
    const snapshot = await focused.first().ariaSnapshot()
    return (snapshot.split('\n')[0] ?? '').replace(/^- /, '').replace(/:$/, '')
  }

  const shoot = async (holder: Holder, options: { path?: string; fullPage?: boolean; timeout?: number }): Promise<Buffer> => {
    const before = holder.errors.length
    const shot = await holder.page.screenshot({ ...options, caret: SCREENSHOT_CARET })
    for (let i = holder.errors.length - 1; i >= before; i--) {
      if (holder.errors[i]?.includes(SCREENSHOT_STYLE_REFUSED)) holder.errors.splice(i, 1)
    }
    return shot
  }

  return {
    open: async (key) => { await open(key) },
    url: (key) => holders.get(keyOf(key))?.page.url() ?? '',
    goto: (key, route, timeoutMs, fresh) => act(key, undefined, timeoutMs, async (page) => {
      // Relative to the app's address, which the desktop app knows only from the page it opened.
      const target = new URL(route.startsWith('#') ? `/${route}` : route, page.url()).href
      if (fresh) await page.goto('about:blank')
      await page.goto(target, { timeout: timeoutMs })
      await loaded(page, timeoutMs)
    }),
    click: (key, handle, timeoutMs) => act(key, handle, timeoutMs, (page) => locate(page, handle).click({ timeout: timeoutMs })),
    fill: (key, handle, value, timeoutMs) => act(key, handle, timeoutMs, (page) => locate(page, handle).fill(value, { timeout: timeoutMs })),
    // Waits for the box, then for the choice, so a missing choice is named as
    // such, with what the box offers, and never reported as a missing box.
    select: (key, handle, option, timeoutMs) => act(key, handle, timeoutMs, async (page) => {
      const box = locate(page, handle)
      await box.waitFor({ state: 'visible', timeout: timeoutMs })
      const deadline = Date.now() + timeoutMs
      const wanted = 'label' in option ? `"${option.label}"` : `with value ${option.value}`
      for (;;) {
        const offered = await box.locator('option').evaluateAll((els) => els.map((el) => ({ label: el.textContent.trim(), value: el.getAttribute('value') ?? '' })))
        if (offered.some((o) => ('label' in option ? o.label === option.label : o.value === option.value))) break
        if (Date.now() > deadline) throw new Error(`${describe(handle)} has no choice ${wanted}. It offers: ${offered.map((o) => o.label).join(', ') || 'nothing'}`)
        await sleep(SETTLE_POLL_MS)
      }
      await box.selectOption(option, { timeout: timeoutMs })
    }),
    check: (key, handle, on, timeoutMs) => act(key, handle, timeoutMs, (page) => locate(page, handle).setChecked(on, { timeout: timeoutMs })),
    press: (key, keyName, handle, timeoutMs) => act(key, handle, timeoutMs, (page) => (handle ? locate(page, handle).press(keyName, { timeout: timeoutMs }) : page.keyboard.press(keyName))),
    type: (key, text) => act(key, undefined, 0, (page) => page.keyboard.type(text)),
    wait: (key, handle, gone, timeoutMs) => act(key, handle, timeoutMs, (page) => locate(page, handle).first().waitFor({ state: gone ? 'hidden' : 'visible', timeout: timeoutMs })),
    text: (key, handle, timeoutMs) => act(key, handle, timeoutMs, (page) => locate(page, handle).innerText({ timeout: timeoutMs })),
    count: (key, handle) => act(key, handle, 0, (page) => locate(page, handle).count()),
    focused: async (key) => focusedOf((await open(key)).page),
    isFocused: (key, handle) => act(key, handle, 0, async (page) => {
      const target = locate(page, handle)
      const matches = await target.count()
      if (matches !== 1) throw new Error(`${String(matches)} elements match ${describe(handle)}, so there is nothing single to focus`)
      return target.evaluate((el) => el === document.activeElement)
    }),
    snapshot: (key, timeoutMs) => act(key, undefined, timeoutMs, (page) => page.locator('body').ariaSnapshot({ timeout: timeoutMs })),
    screenshot: async (key, options) => shoot(await open(key), { path: options.path, fullPage: options.fullPage, timeout: options.timeoutMs }),
    console: (key) => held(key).errors.splice(0),
    network: (key) => held(key).network.splice(0),
    trace: async (key, action, path) => {
      const holder = await open(key)
      if (action === 'start') {
        if (holder.tracing) return { already: true }
        await holder.context.tracing.start({ screenshots: true, snapshots: true })
        holder.tracing = true
        return { already: false }
      }
      if (!holder.tracing) return { already: true }
      await holder.context.tracing.stop({ path })
      holder.tracing = false
      return { already: false }
    },
    a11y: async (key) => {
      const result = await new AxeBuilder({ page: (await open(key)).page }).analyze()
      return result.violations.map((v) => ({
        // axe leaves impact unset for some best-practice rules. They are reported, never failed on.
        id: v.id, impact: v.impact ?? 'none', help: v.help, nodes: v.nodes.length, target: JSON.stringify(v.nodes[0]?.target ?? []),
      }))
    },
    // Measured against the layout width, not window.innerWidth: Chromium's phone
    // mode widens innerWidth to fit content that is too wide, so it never overflows.
    overflow: async (key) => (await open(key)).page.evaluate(() => {
      const width = document.documentElement.clientWidth
      const scrollWidth = document.documentElement.scrollWidth
      const offenders: { element: string; right: number }[] = []
      if (scrollWidth > width) {
        for (const el of Array.from(document.body.querySelectorAll('*'))) {
          const right = el.getBoundingClientRect().right
          if (right <= width + 1) continue
          const classes = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''
          offenders.push({ element: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${classes}`, right: Math.round(right) })
          if (offenders.length >= 10) break
        }
      }
      return { width, scrollWidth, offenders }
    }),
    settle: async (key, timeoutMs) => {
      const holder = await open(key)
      const deadline = Date.now() + timeoutMs
      while (holder.reads.size) {
        if (Date.now() > deadline) {
          const stuck = [...holder.reads].map((r) => new URL(r.url()).pathname + new URL(r.url()).search.replace(/(handle|cursor)=[^&]*/g, '$1=…'))
          throw new Error(`the page still had ${String(holder.reads.size)} reads in flight after ${String(timeoutMs / 1000)}s: ${stuck.join(' | ')}`)
        }
        await sleep(SETTLE_POLL_MS)
      }
    },
    normalize: async (key) => {
      const { page } = await open(key)
      await page.mouse.move(0, 0)
      await page.evaluate((rules) => {
        for (const rule of rules) {
          const pattern = new RegExp(rule.pattern, 'g')
          for (const root of Array.from(document.querySelectorAll(rule.scope))) {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const text = node.textContent ?? ''
              const next = text.replace(pattern, rule.replace)
              if (next !== text) node.textContent = next
            }
          }
        }
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      }, [...VOLATILE, ...instanceRules(state.name)])
    },
    record: async (key, action, label, name, timeoutMs) => {
      const holder = await open(key)
      const url = holder.page.url()
      if (action === 'start') {
        if (holder.recording) return { already: true, file: null }
        await closeHolder(key)
        // A video is set up when a page opens, so recording starts a fresh page at the same address.
        const fresh = await open(key, { label, dir: join(state.scratch, 'video', String(Date.now())) })
        await fresh.page.goto(url, { timeout: timeoutMs })
        await loaded(fresh.page, timeoutMs)
        return { already: false, file: null }
      }
      const video = holder.page.video()
      if (!holder.recording || !video) return { already: true, file: null }
      const path = name(holder.recording.label)
      // Closing the page finishes its video.
      await closeHolder(key)
      await video.saveAs(path)
      const back = await open(key)
      await back.page.goto(url, { timeout: timeoutMs })
      return { already: false, file: path }
    },
    close: closeHolder,
    shutdown: async () => {
      for (const [id, holder] of [...holders]) {
        holders.delete(id)
        // A recording nobody stopped is still evidence, so it is kept beside the run's other evidence.
        const video = holder.recording ? holder.page.video() : null
        if (holder.app) await holder.app.close()
        else await holder.context.close()
        if (video && holder.recording) {
          mkdirSync(join(state.evidence, 'videos'), { recursive: true })
          await video.saveAs(join(state.evidence, 'videos', `unstopped-${holder.recording.label.replace(/[^a-z0-9]+/gi, '-')}.webm`))
        }
      }
      for (const browser of browsers.values()) await browser.close()
    },
  }
}
