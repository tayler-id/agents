// How agentsctl drives a page, whatever drives the browser underneath. The
// Driver type is everything the commands, the skill and the feature map need
// from a browser backend: open, goto, click, fill, press, wait, snapshot,
// screenshot, console, network and trace, plus the reads the checks use. Today
// one backend implements it, on Playwright (ctl/playwright.ts). A second, such
// as one on the Chrome DevTools protocol for performance traces and memory,
// implements the same type and changes nothing above it.
//
// perform() turns one requested operation into Driver calls. It holds the
// rules that are the same for every backend: what an operation waits for,
// what counts as a pass, and what it writes as evidence.

import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Engine, Found, Handle, Op, Target, Viewport } from './protocol.ts'

// One page the session holds: the web app in one engine at one width as one
// person, or the desktop app as one person.
export type PageKey = { target: Target; engine: Engine; viewport: Viewport; login: string }

export type Violation = NonNullable<Found['violations']>[number]
export type Overflow = NonNullable<Found['overflow']>
export type NetworkEntry = NonNullable<Found['network']>[number]

export type Driver = {
  // Opens the key's page if it is not open, on the app's home page.
  open(key: PageKey): Promise<void>
  url(key: PageKey): string
  // `fresh` loads the page from scratch, so every list reads the record as it is now.
  goto(key: PageKey, route: string, timeoutMs: number, fresh: boolean): Promise<void>
  click(key: PageKey, handle: Handle, timeoutMs: number): Promise<void>
  fill(key: PageKey, handle: Handle, value: string, timeoutMs: number): Promise<void>
  select(key: PageKey, handle: Handle, option: { label: string } | { value: string }, timeoutMs: number): Promise<void>
  check(key: PageKey, handle: Handle, on: boolean, timeoutMs: number): Promise<void>
  press(key: PageKey, keyName: string, handle: Handle | undefined, timeoutMs: number): Promise<void>
  type(key: PageKey, text: string): Promise<void>
  wait(key: PageKey, handle: Handle, gone: boolean, timeoutMs: number): Promise<void>
  text(key: PageKey, handle: Handle, timeoutMs: number): Promise<string>
  count(key: PageKey, handle: Handle): Promise<number>
  // The focused element's role and name, as a person using a screen reader hears it.
  focused(key: PageKey): Promise<string>
  // Whether the one element the handle names has the focus.
  isFocused(key: PageKey, handle: Handle): Promise<boolean>
  snapshot(key: PageKey, timeoutMs: number): Promise<string>
  screenshot(key: PageKey, options: { path?: string; fullPage?: boolean; timeoutMs: number }): Promise<Buffer>
  // Page errors and console errors since the last call.
  console(key: PageKey): string[]
  // Requests the page finished or failed since the last call.
  network(key: PageKey): NetworkEntry[]
  // Starts a trace of the page, or stops it and writes it to `path`.
  trace(key: PageKey, action: 'start' | 'stop', path: string): Promise<{ already: boolean }>
  a11y(key: PageKey): Promise<Violation[]>
  overflow(key: PageKey): Promise<Overflow>
  // Waits until the page has no read of the record in flight.
  settle(key: PageKey, timeoutMs: number): Promise<void>
  // Replaces text that changes from run to run, before a visual capture.
  normalize(key: PageKey): Promise<void>
  // Starts a video of the page, which starts it afresh at the same address, or stops it and keeps it at `path`.
  record(key: PageKey, action: 'start' | 'stop', label: string, path: string, timeoutMs: number): Promise<{ already: boolean; file: string | null }>
  close(key: PageKey): Promise<void>
  shutdown(): Promise<void>
}

export function describe(handle: Handle): string {
  return `${handle.role}${handle.name === undefined ? '' : ` "${handle.name}"`}${handle.text === undefined ? '' : ` with text "${handle.text}"`}`
    + (handle.within ? ` in ${handle.within.role}${handle.within.name === undefined ? '' : ` "${handle.within.name}"`}${handle.within.text === undefined ? '' : ` with text "${handle.within.text}"`}` : '')
}

// axe's ratings that fail a check. Moderate and minor findings are reported, never failed on.
const AXE_FAILS = new Set(['serious', 'critical'])
export const failing = (violations: Violation[]) => violations.filter((v) => AXE_FAILS.has(v.impact))

// How often `count --expect` and `text --expect` look again while a list fills in.
const POLL_MS = 250

// The operations on one page. The session handles the rest, which open, close or record pages.
export type PageOp = Exclude<Op, { op: 'ping' | 'visual' | 'record' | 'close' | 'shutdown' }>

export async function perform(driver: Driver, key: PageKey, op: PageOp, timeoutMs: number): Promise<Found> {
  const done = (summary: string, extra: Partial<Found> = {}): Found => ({ url: driver.url(key), summary, pass: true, files: [], ...extra })
  switch (op.op) {
    case 'goto':
      await driver.goto(key, op.route, timeoutMs, false)
      return done(`opened ${op.route}`)
    case 'click':
      await driver.click(key, op.handle, timeoutMs)
      return done(`clicked ${describe(op.handle)}`)
    case 'fill':
      await driver.fill(key, op.handle, op.value, timeoutMs)
      return done(`filled ${describe(op.handle)} with "${op.value}"`)
    case 'select': {
      await driver.select(key, op.handle, op.option, timeoutMs)
      return done(`picked ${'label' in op.option ? `"${op.option.label}"` : `the choice with value ${op.option.value}`} in ${describe(op.handle)}`)
    }
    case 'check':
      await driver.check(key, op.handle, op.on, timeoutMs)
      return done(`${op.on ? 'checked' : 'unchecked'} ${describe(op.handle)}`)
    case 'press':
      await driver.press(key, op.key, op.handle, timeoutMs)
      return done(`pressed ${op.key}${op.handle ? ` in ${describe(op.handle)}` : ''}`, { focus: await driver.focused(key) })
    case 'type':
      await driver.type(key, op.text)
      return done(`typed "${op.text}" into ${await driver.focused(key)}`)
    case 'wait':
      await driver.wait(key, op.handle, op.gone, timeoutMs)
      return done(`${describe(op.handle)} is ${op.gone ? 'gone' : 'there'}`)
    case 'text': {
      const deadline = Date.now() + timeoutMs
      let text = await driver.text(key, op.handle, timeoutMs)
      while (op.holds !== undefined && !text.includes(op.holds) && Date.now() < deadline) {
        await sleep(POLL_MS)
        text = await driver.text(key, op.handle, timeoutMs)
      }
      const pass = op.holds === undefined || text.includes(op.holds)
      return { ...done(pass ? text : `expected ${describe(op.handle)} to hold "${op.holds ?? ''}", and it reads: ${text}`, { text }), pass }
    }
    case 'count': {
      const deadline = Date.now() + timeoutMs
      let count = await driver.count(key, op.handle)
      while (op.equals !== undefined && count !== op.equals && Date.now() < deadline) {
        await sleep(POLL_MS)
        count = await driver.count(key, op.handle)
      }
      const pass = op.equals === undefined || count === op.equals
      return { ...done(pass ? `${String(count)} of ${describe(op.handle)}` : `expected ${String(op.equals)} of ${describe(op.handle)}, and there are ${String(count)}`, { count }), pass }
    }
    case 'snapshot': {
      const yaml = await driver.snapshot(key, timeoutMs)
      writeFileSync(op.path, `${yaml}\n`)
      return done(`wrote the ARIA snapshot to ${op.path}`, { files: [op.path], text: yaml })
    }
    case 'screenshot':
      await driver.screenshot(key, { path: op.path, fullPage: op.full, timeoutMs })
      return done(`wrote a screenshot to ${op.path}`, { files: [op.path] })
    case 'console': {
      const found = driver.console(key)
      return { ...done(found.length ? `${String(found.length)} errors since the last check: ${found.join(' | ')}` : 'no page errors or console errors since the last check'), pass: !found.length, errors: found }
    }
    case 'network': {
      // Requests the page sent since the last look. Any that failed, or answered 400 or more, fails the check.
      const network = driver.network(key)
      writeFileSync(op.path, `${JSON.stringify(network, null, 2)}\n`)
      const failed = network.filter((n) => n.failed !== null || (n.status !== null && n.status >= 400))
      return {
        ...done(`${String(network.length)} requests since the last look, ${String(failed.length)} failed${failed.length ? `: ${failed.map((n) => `${n.method} ${n.url} ${n.failed ?? String(n.status)}`).join(' | ')}` : ''}`, { files: [op.path], network }),
        pass: !failed.length,
      }
    }
    case 'trace': {
      const { already } = await driver.trace(key, op.action, op.path)
      if (op.action === 'start') return done(already ? 'a trace was already running' : 'tracing the page. Drive it, then: trace stop', { already })
      return done(already ? 'no trace was running' : `wrote the trace to ${op.path}`, { already, files: already ? [] : [op.path] })
    }
    case 'overflow': {
      const overflow = await driver.overflow(key)
      const wide = overflow.scrollWidth > overflow.width
      return {
        ...done(wide ? `the page is ${String(overflow.scrollWidth)}px wide in a ${String(overflow.width)}px window: ${overflow.offenders.map((o) => o.element).join(', ')}` : `no sideways scrolling at ${String(overflow.width)}px`),
        pass: !wide, overflow,
      }
    }
    case 'a11y': {
      const violations = await driver.a11y(key)
      return {
        ...done(violations.length ? violations.map((v) => `${v.impact} ${v.id}: ${v.help} (${String(v.nodes)}) ${v.target}`).join('\n') : 'no accessibility violations'),
        pass: !failing(violations).length, violations,
      }
    }
    case 'focus': {
      const focus = await driver.focused(key)
      return done(`focus is on ${focus}`, { focus })
    }
    case 'tab-to': {
      // The element may still be rendering after the step before navigated.
      await driver.wait(key, op.handle, false, timeoutMs)
      const path: string[] = []
      for (let i = 0; i < op.max; i++) {
        await driver.press(key, 'Tab', undefined, timeoutMs)
        path.push(await driver.focused(key))
        if (await driver.isFocused(key, op.handle)) {
          return done(`reached ${describe(op.handle)} in ${String(path.length)} tabs: ${path.join(' > ')}`, { path, focus: path.at(-1) })
        }
      }
      return { ...done(`${describe(op.handle)} was not reached in ${String(op.max)} tabs: ${path.join(' > ')}`), pass: false, path }
    }
  }
}
