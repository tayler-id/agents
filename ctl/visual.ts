// Visual regression. `visual shot` captures a view in every engine at both
// widths into the run's evidence, and lists each capture in the run's
// evidence.json. `visual compare` diffs the captures that manifest lists against
// the baselines in the skill, and fails on any that differs by more than the
// tolerance, naming the region that changed. `visual baseline` replaces
// baselines with a run's captures, and only with a reason, which it logs beside
// them. Comparing never edits a baseline.

import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { ENGINE, ENGINES, EVIDENCE_MANIFEST, EVIDENCE_MANIFEST_FILE, WIDTH, WIDTHS, type Engine, type EvidenceManifest, type Shot, type Width } from '../shared/evidence.ts'
import { BASELINES_DIR, LATEST_MANIFEST, ROOT } from './config.ts'
import { decode, diff, encode, type Box } from './png.ts'
import { failing, type Driver, type PageKey } from './driver.ts'
import { CliError, EXIT } from './output.ts'
import type { Capture, Handle } from './protocol.ts'

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

// How often a capture looks again while the page settles, and for how long.
const STEADY_POLL_MS = 300
const STEADY_MS = 15_000

// A screenshot taken once the page has no read in flight and two shots in a row
// come out the same, so a list still loading or a status still changing never
// makes it into a baseline.
export async function steadyShot(driver: Driver, key: PageKey, path: string, timeoutMs: number) {
  let last: Buffer | null = null
  const deadline = Date.now() + STEADY_MS
  for (;;) {
    await driver.settle(key, timeoutMs)
    await driver.normalize(key)
    const shot = await driver.screenshot(key, { timeoutMs })
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

// Captures one view, at the route the given page is on, in every engine at both
// widths, checks each capture (accessibility, sideways scrolling at phone width,
// and errors in the console since that page's last check), and lists every
// capture in the run's evidence.json. Each page loads afresh, so every list
// reads the record as it is now.
export async function captureViews(driver: Driver, from: PageKey, view: string, ready: Handle | undefined, evidence: string, timeoutMs: number): Promise<Capture[]> {
  const route = new URL(driver.url(from)).hash || '#/'
  const captures: Capture[] = []
  for (const engine of ENGINES) {
    for (const width of WIDTHS) {
      const key: PageKey = { ...from, target: 'browser', engine, width }
      await driver.open(key)
      await driver.goto(key, route, timeoutMs, true)
      if (ready) await driver.wait(key, ready, false, timeoutMs)
      const file = capturePath(evidence, engine, width, view)
      await steadyShot(driver, key, file, timeoutMs)
      const measured = width === 'phone' ? await driver.overflow(key) : null
      const overflow = measured !== null && measured.scrollWidth > measured.width
      captures.push({ engine, width, file, violations: failing(await driver.a11y(key)), overflow, errors: driver.console(key) })
    }
  }
  recordShots(evidence, view, captures)
  return captures
}

export const combo = (engine: Engine, width: Width) => `${engine}-${width}`
export const capturePath = (evidence: string, engine: Engine, width: Width, view: string) => join(evidence, 'visual', combo(engine, width), `${view}.png`)
const baselinePath = (dir: string, engine: Engine, width: Width, view: string) => join(dir, combo(engine, width), `${view}.png`)
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

// Writes a manifest whole, through a temporary file, so a reader never sees half of one.
function writeManifest(path: string, manifest: EvidenceManifest) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(EVIDENCE_MANIFEST.parse(manifest), null, 2)}\n`)
  renameSync(temporary, path)
}

const manifestPath = (evidence: string) => join(evidence, EVIDENCE_MANIFEST_FILE)

function readManifest(evidence: string): EvidenceManifest {
  const path = manifestPath(evidence)
  if (!existsSync(path)) return { shots: [] }
  return EVIDENCE_MANIFEST.parse(JSON.parse(readFileSync(path, 'utf8')))
}

// Lists a view's captures in the run's evidence.json, replacing any earlier
// capture of the same view, engine and width, and copies the manifest to the
// one path the check host reads after a suite.
function recordShots(evidence: string, view: string, captures: Capture[]) {
  const fresh: Shot[] = captures.map((c) => ({ view, engine: c.engine, width: c.width, path: relative(ROOT, c.file), sha256: sha256(c.file) }))
  const replaced = new Set(fresh.map((s) => `${s.engine} ${s.width}`))
  const kept = readManifest(evidence).shots.filter((s) => s.view !== view || !replaced.has(`${s.engine} ${s.width}`))
  const manifest = { shots: [...kept, ...fresh] }
  writeManifest(manifestPath(evidence), manifest)
  writeManifest(LATEST_MANIFEST, manifest)
}

// The run's captures, from its evidence.json. A file that is gone, or no longer
// has the sha256 the manifest recorded, stops the read: it is not the capture
// the run took.
function shotsOf(evidence: string): Shot[] {
  const shots = readManifest(evidence).shots
  for (const shot of shots) {
    const file = join(ROOT, shot.path)
    if (!existsSync(file)) throw new CliError(EXIT.failed, `${shot.path} is in ${relative(ROOT, manifestPath(evidence))} and missing from disk`)
    if (sha256(file) !== shot.sha256) throw new CliError(EXIT.failed, `${shot.path} changed after the run took it: its sha256 is not the one ${relative(ROOT, manifestPath(evidence))} recorded`)
  }
  return [...shots].sort((a, b) => `${a.view}/${combo(a.engine, a.width)}`.localeCompare(`${b.view}/${combo(b.engine, b.width)}`))
}

export const Comparison = z.object({
  view: z.string(), engine: ENGINE, width: WIDTH,
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
const COMBOS = new Set(ENGINES.flatMap((engine) => WIDTHS.map((width) => combo(engine, width))))

// `baselines` is the skill's folder, or another for a check that must leave the skill's baselines alone.
export function compare(evidence: string, baselines = BASELINES_DIR): CompareResult {
  const results: Comparison[] = []
  const shots = shotsOf(evidence)
  for (const shot of shots) {
    const base = baselinePath(baselines, shot.engine, shot.width, shot.view)
    const row = { view: shot.view, engine: shot.engine, width: shot.width, changed: 0, share: 0, regions: [], diff: null }
    if (!existsSync(base)) {
      results.push({ ...row, status: 'no baseline', detail: `no baseline yet. Add one with: bin/agentsctl visual baseline --reason "<why>"` })
      continue
    }
    const expected = decode(readFileSync(base), relative(ROOT, base))
    const actual = decode(readFileSync(join(ROOT, shot.path)), shot.path)
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
    const diffFile = join(evidence, 'visual-diff', combo(shot.engine, shot.width), `${shot.view}.png`)
    mkdirSync(dirname(diffFile), { recursive: true })
    writeFileSync(diffFile, encode(found.picture))
    const regions = found.regions.slice(0, 5)
    results.push({
      ...row, changed: found.differing, share, regions, diff: diffFile,
      status: share > MAX_CHANGED ? 'different' : 'within tolerance',
      detail: `${String(found.differing)} pixels changed (${(share * 100).toFixed(3)}%), in ${regions.map(where).join('; ')}`,
    })
  }
  const taken = new Set(shots.map((s) => `${combo(s.engine, s.width)}/${s.view}`))
  const notCaptured = existsSync(baselines)
    ? readdirSync(baselines).filter((d) => COMBOS.has(d))
      .flatMap((d) => readdirSync(join(baselines, d)).filter((f) => f.endsWith('.png')).map((f) => `${d}/${f.slice(0, -4)}`))
      .filter((n) => !taken.has(n))
    : []
  const ok = results.length > 0 && results.every((r) => r.status === 'same' || r.status === 'within tolerance')
  return { ok, tolerance: { channel: CHANNEL_THRESHOLD, share: MAX_CHANGED }, results, notCaptured }
}

export const BaselineUpdate = z.object({ at: z.iso.datetime(), reason: z.string().min(10), from: z.string(), files: z.array(z.string()) })
export type BaselineUpdate = z.infer<typeof BaselineUpdate>
export const UPDATES_FILE = 'updates.jsonl'

// Makes a run's captures the baselines, and logs why. A reason is required,
// since a baseline changed to make a run pass would hide the change it shows.
// Captures that match their baseline byte for byte are left alone, and when
// all of them match, nothing is written or logged.
export function baseline(evidence: string, reason: string, only: string[], baselines = BASELINES_DIR): { update: BaselineUpdate | null; unchanged: number } {
  const picked = shotsOf(evidence).filter((s) => !only.length || only.includes(s.view))
  if (!picked.length) {
    throw new CliError(EXIT.failed, `no captures in ${relative(ROOT, manifestPath(evidence))}${only.length ? ` for ${only.join(', ')}` : ''}`, [
      'Run `bin/agentsctl visual shot <view>` on a view, or `bin/agentsctl map run all --visual`, first',
    ])
  }
  const files: string[] = []
  let unchanged = 0
  for (const shot of picked) {
    const source = join(ROOT, shot.path)
    const target = baselinePath(baselines, shot.engine, shot.width, shot.view)
    if (existsSync(target) && readFileSync(target).equals(readFileSync(source))) {
      unchanged++
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    files.push(relative(ROOT, target))
  }
  if (!files.length) return { update: null, unchanged }
  const update = BaselineUpdate.parse({ at: new Date().toISOString(), reason, from: relative(ROOT, evidence), files })
  appendFileSync(join(baselines, UPDATES_FILE), `${JSON.stringify(update)}\n`)
  return { update, unchanged }
}
