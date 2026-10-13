// What the browser session does to a page, for the web app and the desktop app
// alike. Elements are found by role and accessible name, the way a person finds
// them, never by coordinates or position. Each operation returns what it found,
// with a one-line summary a person can read.

import { writeFileSync } from 'node:fs'
import { errors, type Locator, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import type { Found, Handle, Op } from './protocol.ts'

export type PageCtx = { page: Page; errors: string[]; timeoutMs: number }

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

export async function screenshot(ctx: Pick<PageCtx, 'page' | 'errors'>, options: { path?: string; fullPage?: boolean; timeout?: number }): Promise<Buffer> {
  const before = ctx.errors.length
  const shot = await ctx.page.screenshot({ ...options, caret: SCREENSHOT_CARET })
  for (let i = ctx.errors.length - 1; i >= before; i--) {
    if (ctx.errors[i]?.includes(SCREENSHOT_STYLE_REFUSED)) ctx.errors.splice(i, 1)
  }
  return shot
}

export function describe(handle: Handle): string {
  return `${handle.role}${handle.name === undefined ? '' : ` "${handle.name}"`}${handle.text === undefined ? '' : ` with text "${handle.text}"`}`
    + (handle.within ? ` in ${handle.within.role} "${handle.within.name}"` : '')
}

export function locate(page: Page, handle: Handle): Locator {
  const scope = handle.within ? page.getByRole(handle.within.role, { name: handle.within.name, exact: true }) : page
  const found = scope.getByRole(handle.role, handle.name === undefined ? {} : { name: handle.name, exact: true })
  return handle.text === undefined ? found : found.filter({ hasText: handle.text })
}

// Playwright's errors carry a page of call log. The first line, with the handle, is what a reader needs.
function explain(error: unknown, handle: Handle | undefined, timeoutMs: number): Error {
  if (error instanceof errors.TimeoutError) {
    return new Error(handle ? `${describe(handle)} was not there within ${String(timeoutMs / 1000)}s` : `timed out after ${String(timeoutMs / 1000)}s`)
  }
  const first = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''
  const strict = /strict mode violation: .* resolved to (\d+) elements/.exec(first)
  if (strict && handle) return new Error(`${strict[1] ?? 'several'} elements match ${describe(handle)}. Narrow it with --within or --text.`)
  return new Error(first)
}

// The app is loaded once it shows the workspace (its sidebar on a wide screen,
// its menu button on a phone) or says it cannot open.
export async function loaded(page: Page, timeoutMs: number) {
  const workspace = page.getByRole('navigation', { name: 'Workspace' })
    .or(page.getByRole('button', { name: 'Menu' }))
    .or(page.getByRole('heading', { name: "Can't open the app" }))
  await workspace.first().waitFor({ state: 'visible', timeout: timeoutMs })
}

async function focusOf(page: Page): Promise<string> {
  const focused = page.locator('*:focus')
  if (!(await focused.count())) return 'nothing (focus is on the page itself)'
  const snapshot = await focused.first().ariaSnapshot()
  return (snapshot.split('\n')[0] ?? '').replace(/^- /, '').replace(/:$/, '')
}

const AXE_FAILS = new Set(['serious', 'critical'])

export async function axe(page: Page): Promise<NonNullable<Found['violations']>> {
  const result = await new AxeBuilder({ page }).analyze()
  return result.violations.map((v) => ({
    // axe leaves impact unset for some best-practice rules. They are reported, never failed on.
    id: v.id, impact: v.impact ?? 'none', help: v.help, nodes: v.nodes.length, target: JSON.stringify(v.nodes[0]?.target ?? []),
  }))
}
export const failsAxe = (violations: NonNullable<Found['violations']>) => violations.filter((v) => AXE_FAILS.has(v.impact))

export async function overflowOf(page: Page): Promise<NonNullable<Found['overflow']>> {
  return page.evaluate(() => {
    const width = window.innerWidth
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
  })
}

// The operations on one page. The session itself handles the rest, which open, close or record pages.
export type PageOp = Exclude<Op, { op: 'ping' | 'visual' | 'record' | 'close' | 'shutdown' }>

export async function perform(ctx: PageCtx, op: PageOp): Promise<Found> {
  const { page, timeoutMs } = ctx
  const handle = 'handle' in op ? op.handle : undefined
  const done = (summary: string, extra: Partial<Found> = {}): Found => ({ url: page.url(), summary, pass: true, files: [], ...extra })
  try {
    switch (op.op) {
      case 'goto': {
        // Relative to the app's address, which the desktop app knows only from the page it opened.
        await page.goto(new URL(op.route.startsWith('#') ? `/${op.route}` : op.route, page.url()).href, { timeout: timeoutMs })
        await loaded(page, timeoutMs)
        return done(`opened ${op.route}`)
      }
      case 'click':
        await locate(page, op.handle).click({ timeout: timeoutMs })
        return done(`clicked ${describe(op.handle)}`)
      case 'fill':
        await locate(page, op.handle).fill(op.value, { timeout: timeoutMs })
        return done(`filled ${describe(op.handle)} with "${op.value}"`)
      case 'select':
        await locate(page, op.handle).selectOption({ label: op.option }, { timeout: timeoutMs })
        return done(`picked "${op.option}" in ${describe(op.handle)}`)
      case 'check':
        await locate(page, op.handle).setChecked(op.on, { timeout: timeoutMs })
        return done(`${op.on ? 'checked' : 'unchecked'} ${describe(op.handle)}`)
      case 'press':
        if (op.handle) await locate(page, op.handle).press(op.key, { timeout: timeoutMs })
        else await page.keyboard.press(op.key)
        return done(`pressed ${op.key}${op.handle ? ` in ${describe(op.handle)}` : ''}`, { focus: await focusOf(page) })
      case 'type':
        await page.keyboard.type(op.text)
        return done(`typed "${op.text}" into ${await focusOf(page)}`)
      case 'wait':
        await locate(page, op.handle).first().waitFor({ state: op.gone ? 'hidden' : 'visible', timeout: timeoutMs })
        return done(`${describe(op.handle)} is ${op.gone ? 'gone' : 'there'}`)
      case 'text': {
        const text = await locate(page, op.handle).innerText({ timeout: timeoutMs })
        return done(text, { text })
      }
      case 'count': {
        const count = await locate(page, op.handle).count()
        return done(`${String(count)} of ${describe(op.handle)}`, { count })
      }
      case 'snapshot': {
        const yaml = await page.locator('body').ariaSnapshot({ timeout: timeoutMs })
        writeFileSync(op.path, `${yaml}\n`)
        return done(`wrote the ARIA snapshot to ${op.path}`, { files: [op.path], text: yaml })
      }
      case 'screenshot':
        await screenshot(ctx, { path: op.path, fullPage: op.full, timeout: timeoutMs })
        return done(`wrote a screenshot to ${op.path}`, { files: [op.path] })
      case 'console': {
        const found = [...ctx.errors]
        return { ...done(found.length ? `${String(found.length)} errors: ${found.join(' | ')}` : 'no page errors or console errors'), pass: !found.length, errors: found }
      }
      case 'overflow': {
        const overflow = await overflowOf(page)
        const wide = overflow.scrollWidth > overflow.width
        return {
          ...done(wide ? `the page is ${String(overflow.scrollWidth)}px wide in a ${String(overflow.width)}px window: ${overflow.offenders.map((o) => o.element).join(', ')}` : `no sideways scrolling at ${String(overflow.width)}px`),
          pass: !wide, overflow,
        }
      }
      case 'a11y': {
        const violations = await axe(page)
        const failing = failsAxe(violations)
        return {
          ...done(violations.length ? violations.map((v) => `${v.impact} ${v.id}: ${v.help} (${String(v.nodes)}) ${v.target}`).join('\n') : 'no accessibility violations'),
          pass: !failing.length, violations,
        }
      }
      case 'focus': {
        const focus = await focusOf(page)
        return done(`focus is on ${focus}`, { focus })
      }
      case 'tab-to': {
        const target = locate(page, op.handle)
        const matches = await target.count()
        if (matches !== 1) throw new Error(`${String(matches)} elements match ${describe(op.handle)}, so there is nothing single to tab to`)
        const path: string[] = []
        for (let i = 0; i < op.max; i++) {
          await page.keyboard.press('Tab')
          path.push(await focusOf(page))
          if (await target.evaluate((el) => el === document.activeElement)) {
            return done(`reached ${describe(op.handle)} in ${String(path.length)} tabs: ${path.join(' > ')}`, { path, focus: path.at(-1) })
          }
        }
        return { ...done(`${describe(op.handle)} was not reached in ${String(op.max)} tabs: ${path.join(' > ')}`), pass: false, path }
      }
    }
  } catch (error) {
    throw explain(error, handle, timeoutMs)
  }
}
