// Visual regression. `visual shot` captures a view in every engine at desktop
// and phone width into the run's evidence. `visual compare` diffs those captures
// against the baselines in the skill, and fails on any capture that differs by
// more than the tolerance, naming the region that changed. `visual baseline`
// replaces baselines with a run's captures, and only with a reason, which it
// logs beside them. Comparing never edits a baseline.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Page } from '@playwright/test'
import { z } from 'zod'
import { BASELINES_DIR, ROOT } from './config.ts'
import { decode, diff, encode, type Box } from './png.ts'
import { screenshot } from './drive.ts'
import type { Engine, Viewport } from './protocol.ts'

// A pixel counts as changed when a channel moves by more than this. Below it is
// the jitter of font smoothing between two renders of the same page.
export const CHANNEL_THRESHOLD = 8
// A capture fails when more than this share of its pixels changed.
export const MAX_CHANGED = 0.0002

// Text that changes from run to run while the view stays the same: times rows
// were written, how long things took, and ids made from content. It is replaced
// with a fixed value before each capture, so the layout around it still renders.
type Rule = { why: string; scope: string; pattern: string; replace: string }
export const VOLATILE: Rule[] = [
  { why: 'clock times show when rows were written', scope: 'body', pattern: '\\b(1[0-2]|[1-9]):[0-5]\\d\\s?(AM|PM)\\b', replace: '12:00 PM' },
  { why: 'durations vary with machine load', scope: '.facts dd, table.versions td, table.scores td', pattern: '^(\\d+s|\\d+ min|\\d+ h \\d+ min)$', replace: '1s' },
  { why: 'a pipeline version is named by the blob id of a file that changes with the code', scope: 'table.versions code, .page-head code, details.source summary', pattern: '\\b[0-9a-f]{8}\\b', replace: '00000000' },
  { why: 'memory logs are named by the day they were written', scope: '.memories', pattern: '\\b\\d{4}-\\d{2}-\\d{2}\\b', replace: '2026-01-01' },
]

export async function normalize(page: Page) {
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
  }, VOLATILE)
}

// How often a capture looks again while the page settles, and for how long.
const STEADY_POLL_MS = 300
const STEADY_MS = 15_000

// A screenshot taken once the page has no read in flight and two shots in a row
// come out the same, so a list still loading or a status still changing never
// makes it into a baseline.
export async function steadyShot(ctx: { page: Page; errors: string[]; quiet: () => Promise<void> }, path: string) {
  const { page } = ctx
  await page.mouse.move(0, 0)
  let last: Buffer | null = null
  const deadline = Date.now() + STEADY_MS
  for (;;) {
    await ctx.quiet()
    await normalize(page)
    const shot = await screenshot(ctx, {})
    if (last?.equals(shot)) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, shot)
      return
    }
    if (Date.now() > deadline) throw new Error(`the page was still changing after ${String(STEADY_MS / 1000)}s, so no steady capture of ${path}`)
    last = shot
    await sleep(STEADY_POLL_MS)
  }
}

export const combo = (engine: Engine, viewport: Viewport) => `${engine}-${viewport}`
export const capturePath = (evidence: string, engine: Engine, viewport: Viewport, state: string) => join(evidence, 'visual', combo(engine, viewport), `${state}.png`)
const baselinePath = (name: string, state: string) => join(BASELINES_DIR, name, `${state}.png`)

const Combo = z.string().regex(/^(chromium|firefox|webkit)-(desktop|phone)$/)

// Every capture in a run, as [combo, state].
function captures(evidence: string): [string, string][] {
  const dir = join(evidence, 'visual')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((d) => Combo.safeParse(d).success)
    .flatMap((d) => readdirSync(join(dir, d)).filter((f) => f.endsWith('.png')).map((f): [string, string] => [d, f.slice(0, -4)]))
    .sort((a, b) => `${a[1]}/${a[0]}`.localeCompare(`${b[1]}/${b[0]}`))
}

export const Comparison = z.object({
  state: z.string(), combo: z.string(),
  status: z.enum(['same', 'within tolerance', 'different', 'size changed', 'no baseline']),
  changed: z.number().int(), share: z.number(),
  regions: z.array(z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), pixels: z.number() })),
  diff: z.string().nullable(),
  detail: z.string(),
})
export type Comparison = z.infer<typeof Comparison>
export const CompareResult = z.object({
  ok: z.boolean(), tolerance: z.object({ channel: z.number(), share: z.number() }),
  results: z.array(Comparison), notCaptured: z.array(z.string()),
})
export type CompareResult = z.infer<typeof CompareResult>

const where = (box: Box) => `${String(box.width)}x${String(box.height)} at (${String(box.x)}, ${String(box.y)})`

export function compare(evidence: string): CompareResult {
  const results: Comparison[] = []
  const taken = captures(evidence)
  for (const [name, state] of taken) {
    const base = baselinePath(name, state)
    const runFile = join(evidence, 'visual', name, `${state}.png`)
    const row = { state, combo: name, changed: 0, share: 0, regions: [], diff: null }
    if (!existsSync(base)) {
      results.push({ ...row, status: 'no baseline', detail: `no baseline yet. Add one with: bin/agentsctl visual baseline --reason "<why>"` })
      continue
    }
    const expected = decode(readFileSync(base), relative(ROOT, base))
    const actual = decode(readFileSync(runFile), runFile)
    if (expected.width !== actual.width || expected.height !== actual.height) {
      results.push({ ...row, status: 'size changed', detail: `the baseline is ${String(expected.width)}x${String(expected.height)}, the run ${String(actual.width)}x${String(actual.height)}` })
      continue
    }
    const found = diff(expected, actual, CHANNEL_THRESHOLD)
    const share = found.differing / (actual.width * actual.height)
    if (!found.differing) {
      results.push({ ...row, status: 'same', detail: 'identical' })
      continue
    }
    const diffFile = join(evidence, 'visual-diff', name, `${state}.png`)
    mkdirSync(dirname(diffFile), { recursive: true })
    writeFileSync(diffFile, encode(found.picture))
    const regions = found.regions.slice(0, 5)
    results.push({
      state, combo: name, changed: found.differing, share, regions, diff: diffFile,
      status: share > MAX_CHANGED ? 'different' : 'within tolerance',
      detail: `${String(found.differing)} pixels changed (${(share * 100).toFixed(3)}%), in ${regions.map(where).join('; ')}`,
    })
  }
  const capturedNames = new Set(taken.map(([name, state]) => `${name}/${state}`))
  const notCaptured = existsSync(BASELINES_DIR)
    ? readdirSync(BASELINES_DIR).filter((d) => Combo.safeParse(d).success)
      .flatMap((d) => readdirSync(join(BASELINES_DIR, d)).filter((f) => f.endsWith('.png')).map((f) => `${d}/${f.slice(0, -4)}`))
      .filter((n) => !capturedNames.has(n))
    : []
  const ok = results.length > 0 && results.every((r) => r.status === 'same' || r.status === 'within tolerance')
  return { ok, tolerance: { channel: CHANNEL_THRESHOLD, share: MAX_CHANGED }, results, notCaptured }
}

export const BaselineUpdate = z.object({ at: z.iso.datetime(), reason: z.string().min(10), from: z.string(), files: z.array(z.string()) })
export type BaselineUpdate = z.infer<typeof BaselineUpdate>
export const UPDATES_FILE = join(BASELINES_DIR, 'updates.jsonl')

// Makes a run's captures the baselines, and logs why. A reason is required,
// since a baseline changed to make a run pass would hide the change it shows.
export function baseline(evidence: string, reason: string, only: string[]): BaselineUpdate {
  const picked = captures(evidence).filter(([, state]) => !only.length || only.includes(state))
  if (!picked.length) throw new Error(`no captures in ${evidence}${only.length ? ` for ${only.join(', ')}` : ''}. Capture with bin/agentsctl visual shot first.`)
  const files: string[] = []
  for (const [name, state] of picked) {
    const target = baselinePath(name, state)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(evidence, 'visual', name, `${state}.png`), target)
    files.push(relative(ROOT, target))
  }
  const update = BaselineUpdate.parse({ at: new Date().toISOString(), reason, from: relative(ROOT, evidence), files })
  appendFileSync(UPDATES_FILE, `${JSON.stringify(update)}\n`)
  return update
}
