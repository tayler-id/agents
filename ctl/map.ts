// The feature map, run as written. Each feature file's "Driving it with
// agentsctl" section is a list of labelled steps, and each step's commands are
// the `bin/agentsctl ...` code spans in it, in order. `map run` runs them against
// an instance and reports each step, so the map a person reads is the map that
// was proven. `map check` reads the files without running anything: the four
// sections are there, the index lists every file, and every command parses.
//
// Commands are written as shell commands an agent could paste, in a small
// subset: plain words, single and double quotes, backslash escapes, and
// "$(bin/agentsctl ...)" to use one command's output in another. No other shell
// is involved; the words go straight to agentsctl.

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { featureEntryOf, FEATURE_MAP, FEATURE_MAP_FILE, VERDICT, type Feature as MapEntry, type FeatureMap, type Verdict } from '../shared/evidence.ts'
import { FEATURES_DIR, ROOT } from './config.ts'
import { nextPath } from './evidence.ts'
import type { Output } from '../shared/cli/output.ts'
import type { ReadyState } from './state.ts'

const exec = promisify(execFile)

export const SECTIONS = ['Sub-features', 'How to get to it (user POV)', 'Driving it with agentsctl', 'Gotchas'] as const
const AGENTSCTL = 'bin/agentsctl'
// A substitution's place in a command that is only being parsed, shaped like the ids most of them print.
const STAND_IN = '00000000-0000-0000-0000-000000000000'
// The step label that marks a step needing a real Claude session.
const REAL = '(real Claude)'
// The step label that marks a step needing the pipelines on the forge.
const PIPELINES = '(pipelines)'

type Part = { kind: 'text'; text: string } | { kind: 'sub'; words: Word[] }
type Word = Part[]

// Splits one command into words, keeping each "$(...)" as a command of its own.
export function tokenize(line: string): Word[] {
  const [words, end] = read(line, 0, false)
  if (end !== line.length) throw new Error(`unexpected ) at ${String(end)} in: ${line}`)
  return words
}

// Adds text to the word being read, joining it to text already at its end.
function withText(word: Word | null, text: string): Word {
  const parts = word ?? []
  const last = parts.at(-1)
  return last?.kind === 'text' ? [...parts.slice(0, -1), { kind: 'text', text: last.text + text }] : [...parts, { kind: 'text', text }]
}

function read(line: string, start: number, inSub: boolean): [Word[], number] {
  const words: Word[] = []
  let word: Word | null = null
  let i = start
  while (i < line.length) {
    const c = line.charAt(i)
    if (inSub && c === ')') {
      if (word) words.push(word)
      return [words, i + 1]
    }
    if (/\s/.test(c)) {
      if (word) words.push(word)
      word = null
      i++
    } else if (c === "'") {
      const close = line.indexOf("'", i + 1)
      if (close < 0) throw new Error(`a single quote is not closed in: ${line}`)
      word = withText(word, line.slice(i + 1, close))
      i = close + 1
    } else if (c === '"') {
      i++
      word = word ?? []
      for (;;) {
        if (i >= line.length) throw new Error(`a double quote is not closed in: ${line}`)
        const d = line.charAt(i)
        if (d === '"') {
          i++
          break
        }
        if (d === '\\' && '"\\$`'.includes(line.charAt(i + 1))) {
          word = withText(word, line.charAt(i + 1))
          i += 2
        } else if (d === '$' && line.charAt(i + 1) === '(') {
          const [inner, after] = read(line, i + 2, true)
          word = [...word, { kind: 'sub', words: inner }]
          i = after
        } else {
          word = withText(word, d)
          i++
        }
      }
    } else if (c === '$' && line.charAt(i + 1) === '(') {
      const [inner, after] = read(line, i + 2, true)
      word = [...(word ?? []), { kind: 'sub', words: inner }]
      i = after
    } else if (c === '\\') {
      word = withText(word, line.charAt(i + 1))
      i += 2
    } else {
      word = withText(word, c)
      i++
    }
  }
  if (inSub) throw new Error(`a $( is not closed in: ${line}`)
  if (word) words.push(word)
  return [words, i]
}

// A word's text, with each substitution replaced by what `fill` gives for it.
async function expand(word: Word, fill: (words: Word[]) => Promise<string>): Promise<string> {
  let out = ''
  for (const part of word) out += part.kind === 'text' ? part.text : await fill(part.words)
  return out
}

export type Step = { label: string; real: boolean; pipelines: boolean; commands: string[] }
// A feature file read as text, before its map entry.
export type FeatureFile = {
  file: string; title: string; sections: string[]
  subFeatures: string[]; needs: { pipelines: boolean; real: boolean }; preconditions: string[]; steps: Step[]
}
// A feature file with its map entry, which names it.
export type Feature = FeatureFile & { id: string; entry: MapEntry }

const codeSpans = (text: string) => [...text.matchAll(/`([^`]+)`/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]))

export const readFeature = (file: string): Feature => parseFeature(readFileSync(file, 'utf8'), file)

export function parseFeature(text: string, file: string): Feature {
  const entry = featureEntryOf(text, file)
  return { ...parseFeatureFile(text, file), id: entry.id, entry }
}

export function parseFeatureFile(text: string, file: string): FeatureFile {
  const lines = text.split('\n')
  const title = lines.find((l) => l.startsWith('# '))?.slice(2).trim() ?? ''
  const sections = lines.filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim())
  const body = (heading: string) => {
    const at = lines.findIndex((l) => l === `## ${heading}`)
    if (at < 0) return []
    const next = lines.findIndex((l, i) => i > at && l.startsWith('## '))
    return lines.slice(at + 1, next < 0 ? undefined : next)
  }
  // A bullet and its indented continuation lines, as one string.
  const bullets = (part: string[]) => {
    const out: string[] = []
    for (const line of part) {
      if (line.startsWith('- ')) out.push(line.slice(2))
      else if (line.startsWith('  ') && out.length) out[out.length - 1] = `${out.at(-1) ?? ''} ${line.trim()}`
    }
    return out
  }
  const driving = body('Driving it with agentsctl')
  const all = bullets(driving)
  const steps = all.filter((b) => b.startsWith('**')).map((b): Step => {
    const label = /^\*\*(.+?)\*\*/.exec(b)?.[1] ?? ''
    return {
      label: label.replace(/\.$/, ''), real: label.includes(REAL), pipelines: label.includes(PIPELINES),
      commands: codeSpans(b).filter((c) => c.startsWith(`${AGENTSCTL} `)),
    }
  })
  const preconditions = all.filter((b) => !b.startsWith('**'))
  const ups = preconditions.flatMap(codeSpans).filter((c) => c.startsWith(`${AGENTSCTL} up`))
  return {
    file, title, sections,
    subFeatures: bullets(body('Sub-features')),
    needs: { pipelines: ups.some((c) => c.includes('--pipelines')), real: ups.some((c) => c.includes('--claude real')) },
    preconditions, steps,
  }
}

// The features in the order the index lists them.
export function listMap(): Feature[] {
  const index = readFileSync(join(FEATURES_DIR, 'README.md'), 'utf8')
  return [...index.matchAll(/\]\(\.\/([a-z0-9-]+\.md)\)/g)].flatMap((m) => (m[1] ? [readFeature(join(FEATURES_DIR, m[1]))] : []))
}

export function checkMap(parseCommand: (argv: string[]) => void): string[] {
  const problems: string[] = []
  const indexFile = join(FEATURES_DIR, 'README.md')
  if (!existsSync(indexFile)) return [`${relative(ROOT, indexFile)} is missing`]
  const listed = new Set([...readFileSync(indexFile, 'utf8').matchAll(/\]\(\.\/([a-z0-9-]+\.md)\)/g)].flatMap((m) => (m[1] ? [m[1]] : [])))
  const present = new Set(readdirSync(FEATURES_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md'))
  for (const f of present) if (!listed.has(f)) problems.push(`${f} is not in the index`)
  for (const f of listed) if (!present.has(f)) problems.push(`the index lists ${f}, which does not exist`)
  const parsesAs = (words: Word[], where: string) => {
    const argv = words.map((w) => w.map((p) => (p.kind === 'text' ? p.text : STAND_IN)).join(''))
    for (const w of words) for (const p of w) if (p.kind === 'sub') parsesAs(p.words, where)
    if (argv[0] !== AGENTSCTL) {
      problems.push(`${where}: a substituted command must be ${AGENTSCTL}`)
      return
    }
    try {
      parseCommand(argv.slice(1))
    } catch (error) {
      problems.push(`${where}: ${argv.join(' ')}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''}`)
    }
  }
  const entries = new Map<string, MapEntry>()
  for (const f of [...present].sort()) {
    const text = readFileSync(join(FEATURES_DIR, f), 'utf8')
    const feature = parseFeatureFile(text, f)
    if (!feature.title) problems.push(`${f} has no # title`)
    try {
      const entry = featureEntryOf(text, f)
      const stem = f.replace(/\.md$/, '')
      if (entry.id !== stem) problems.push(`${f}: its map entry's id is ${entry.id}, and it must be ${stem}, the file's name`)
      if (entry.name !== feature.title) problems.push(`${f}: its map entry's name is "${entry.name}", and it must be the title, "${feature.title}"`)
      for (const path of [...entry.paths, ...entry.checks]) if (!existsSync(join(ROOT, path))) problems.push(`${f}: its map entry names ${path}, which does not exist`)
      entries.set(f, entry)
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
    if (feature.sections.join('|') !== SECTIONS.join('|')) problems.push(`${f} has sections ${feature.sections.join(', ')}; it needs exactly ${SECTIONS.join(', ')}`)
    if (!feature.subFeatures.length) problems.push(`${f} lists no sub-features`)
    if (!feature.preconditions.length) problems.push(`${f} has no preconditions`)
    if (!feature.steps.length) problems.push(`${f} has no labelled steps`)
    for (const step of feature.steps) {
      const where = `${f}, "${step.label}"`
      if (!step.commands.length) problems.push(`${where} has no ${AGENTSCTL} command`)
      for (const command of step.commands) {
        let words: Word[]
        try {
          words = tokenize(command)
        } catch (error) {
          problems.push(`${where}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        const verb = words[1]?.map((p) => (p.kind === 'text' ? p.text : '')).join('')
        if (verb === 'up' || verb === 'down' || verb === 'map') problems.push(`${where}: a step never runs ${verb}; the run manages the instance`)
        parsesAs(words, where)
      }
    }
  }
  // features.json must be the entries, in the index's order, as map export writes them.
  const inOrder = [...listed].flatMap((f) => entries.get(f) ?? [])
  const mapFile = join(FEATURES_DIR, FEATURE_MAP_FILE)
  if (!existsSync(mapFile)) problems.push(`${relative(ROOT, mapFile)} is missing. Run bin/agentsctl map export`)
  else if (inOrder.length === listed.size && readFileSync(mapFile, 'utf8') !== mapText({ features: inOrder })) {
    problems.push(`${relative(ROOT, mapFile)} differs from the feature files' map entries. Run bin/agentsctl map export`)
  }
  return problems
}

// features.json as map export writes it, so a check can compare it byte for byte.
const mapText = (map: FeatureMap) => `${JSON.stringify(FEATURE_MAP.parse(map), null, 2)}\n`

// Writes features.json from the feature files' map entries, in the index's order.
export function exportMap(): { file: string; map: FeatureMap; already: boolean } {
  const map = FEATURE_MAP.parse({ features: listMap().map((f) => f.entry) })
  const file = join(FEATURES_DIR, FEATURE_MAP_FILE)
  const text = mapText(map)
  const already = existsSync(file) && readFileSync(file, 'utf8') === text
  if (!already) writeFileSync(file, text)
  return { file, map, already }
}

// A step's verdict on the ladder in shared/evidence.ts, or `not run` when an earlier step
// failed and this one depends on what that one left.
// The commands in a step that assert something: they wait for a state, compare
// text or a count, check a view, or read a side effect back. Editing the map
// can drop or change one of these, which is how a regression would hide, so the
// guard lists every one a change removed, or changed, which reads as removed.
const ASSERTS = /^bin\/agentsctl (?:(?:browser|desktop) (?:wait|text|count|a11y|console|network|overflow)|machine read|visual shot)\b|^bin\/agentsctl (?:db|api) .*--expect/

function assertions(text: string, file: string): string[] {
  return parseFeatureFile(text, file).steps.flatMap((step) => step.commands.filter((c) => ASSERTS.test(c)).map((c) => `"${step.label}": ${c}`))
}

// Every assertion the feature map had at `base` that it no longer has, by file.
export async function guardMap(base: string): Promise<string[]> {
  const relativeDir = relative(ROOT, FEATURES_DIR)
  const show = async (path: string): Promise<string | null> => {
    try {
      return (await exec('git', ['show', `${base}:${path}`], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 })).stdout
    } catch (error) {
      // git exits 128 when the path is not in that commit: a file the change adds.
      if (error instanceof Error && 'code' in error && error.code === 128) return null
      throw error
    }
  }
  const listed = (await exec('git', ['ls-tree', '--name-only', base, `${relativeDir}/`], { cwd: ROOT })).stdout.split('\n').filter((f) => f.endsWith('.md') && !f.endsWith('README.md'))
  const removed: string[] = []
  for (const path of listed) {
    const before = await show(path)
    if (before === null) continue
    const name = path.split('/').at(-1) ?? path
    const now = existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), 'utf8') : null
    if (now === null) {
      removed.push(`${name} was deleted, with all ${String(assertions(before, name).length)} of its assertions`)
      continue
    }
    const kept = new Set(assertions(now, name))
    for (const a of assertions(before, name)) if (!kept.has(a)) removed.push(`${name}, ${a}`)
  }
  return removed
}

export const StepReport = z.object({
  label: z.string(),
  verdict: z.enum(['live-ui-verified', 'verifier-failed', 'verifier-blocked', 'not run']),
  reason: z.string(),
  commands: z.array(z.object({ command: z.string(), ok: z.boolean(), skipped: z.boolean(), summary: z.string() })),
})
export type StepReport = z.infer<typeof StepReport>
export const FeatureReport = z.object({
  id: z.string(), title: z.string(), verdict: VERDICT, verified: z.number().int(), steps: z.array(StepReport),
})
export type FeatureReport = z.infer<typeof FeatureReport>
export const MapReport = z.object({
  ok: z.boolean(), instance: z.string(), harness: z.string(), pipelines: z.boolean(), visual: z.boolean(),
  features: z.array(FeatureReport), file: z.string(), text: z.string(),
})
export type MapReport = z.infer<typeof MapReport>

type Run = (argv: string[]) => Promise<{ code: number; output: Output }>
// Whether the instance is healthy, and if not, why: the doctor's failing checks.
type Health = () => Promise<{ ok: boolean; why: string }>

// A feature is verified live only when every step was. One failed step fails it,
// and otherwise any step that could not run leaves it blocked.
function verdictOf(steps: StepReport[]): Verdict {
  if (steps.some((s) => s.verdict === 'verifier-failed')) return 'verifier-failed'
  return steps.every((s) => s.verdict === 'live-ui-verified') ? 'live-ui-verified' : 'verifier-blocked'
}

export async function runMap(state: ReadyState, targets: string[], options: { visual: boolean; keepGoing: boolean }, run: Run, health: Health): Promise<MapReport> {
  const all = listMap()
  const unknown = targets.filter((t) => t !== 'all' && !all.some((f) => f.id === t))
  if (unknown.length) throw new Error(`no feature named ${unknown.join(', ')}. The map has: ${all.map((f) => f.id).join(', ')}`)
  const features = targets.includes('all') ? all : all.filter((f) => targets.includes(f.id))
  const withInstance = (argv: string[]) => (argv.includes('--instance') ? argv : [...argv, '--instance', state.name])
  const fill = async (words: Word[]): Promise<string> => {
    const argv = await Promise.all(words.map((w) => expand(w, fill)))
    if (argv[0] !== AGENTSCTL) throw new Error(`a substituted command must be ${AGENTSCTL}: ${argv.join(' ')}`)
    const { code, output } = await run(withInstance(argv.slice(1)))
    if (code !== 0) throw new Error(`${argv.join(' ')} failed: ${output.head}`)
    return output.head.trim()
  }
  const reports: FeatureReport[] = []
  // Set once the instance itself stopped being healthy. Nothing after that can be judged.
  let broken: string | null = null
  for (const feature of features) {
    const steps: StepReport[] = []
    const blocked = feature.needs.pipelines && !state.pipelines
      ? `needs an instance started with: ${AGENTSCTL} up --pipelines`
      : feature.needs.real && state.harness !== 'real' ? `needs an instance started with: ${AGENTSCTL} up --claude real` : null
    let stopped = false
    for (const step of feature.steps) {
      const unrun = broken ?? blocked
      if (unrun) {
        steps.push({ label: step.label, verdict: 'verifier-blocked', reason: unrun, commands: [] })
        continue
      }
      if (step.pipelines && !state.pipelines) {
        steps.push({ label: step.label, verdict: 'verifier-blocked', reason: `needs an instance started with: ${AGENTSCTL} up --pipelines`, commands: [] })
        continue
      }
      if (step.real !== (state.harness === 'real')) {
        steps.push({
          label: step.label, verdict: 'verifier-blocked', commands: [],
          reason: step.real ? `needs a real Claude session: ${AGENTSCTL} up --claude real` : 'follows the fake harness\'s scripted replies, so it runs on an instance without --claude real',
        })
        continue
      }
      if (stopped) {
        steps.push({ label: step.label, verdict: 'not run', reason: 'an earlier step failed', commands: [] })
        continue
      }
      const commands: StepReport['commands'] = []
      let failure: string | null = null
      for (const command of step.commands) {
        try {
          const argv = await Promise.all(tokenize(command).map((w) => expand(w, fill)))
          if (argv[1] === 'visual' && argv[2] === 'shot' && !options.visual) {
            commands.push({ command, ok: true, skipped: true, summary: 'skipped: map run --visual takes visual captures' })
            continue
          }
          const { code, output } = await run(withInstance(argv.slice(1)))
          commands.push({ command, ok: code === 0, skipped: false, summary: [output.head, output.detail].filter(Boolean).join('\n') })
          if (code !== 0) {
            failure = `${command}: ${output.head}`
            break
          }
        } catch (error) {
          failure = `${command}: ${error instanceof Error ? error.message : String(error)}`
          commands.push({ command, ok: false, skipped: false, summary: failure })
          break
        }
      }
      if (failure) {
        // A failure counts against the app only on a healthy instance. Otherwise the run is blocked.
        const healthy = await health()
        if (!healthy.ok) broken = `the instance stopped being healthy: ${healthy.why}`
        steps.push({
          label: step.label, verdict: healthy.ok ? 'verifier-failed' : 'verifier-blocked', commands,
          reason: healthy.ok ? failure : `the instance stopped being healthy (${healthy.why}) after: ${failure}`,
        })
        if (!options.keepGoing) stopped = true
      } else {
        steps.push({ label: step.label, verdict: 'live-ui-verified', reason: '', commands })
      }
    }
    reports.push({ id: feature.id, title: feature.title, verdict: verdictOf(steps), verified: steps.filter((s) => s.verdict === 'live-ui-verified').length, steps })
  }
  const text = reports.map((f) => [
    `${f.verdict.padEnd(17)} ${f.id} (${String(f.verified)} of ${String(f.steps.length)} steps verified live)`,
    ...f.steps.map((s) => `    ${s.verdict.padEnd(17)} ${s.label}${s.reason ? `: ${s.reason.split('\n')[0] ?? ''}` : ''}`),
  ].join('\n')).join('\n')
  const file = nextPath(state.evidence, 'map', features.map((f) => f.id).join('-').slice(0, 60), 'json')
  const ok = reports.every((f) => f.verdict === 'live-ui-verified')
  const report: MapReport = { ok, instance: state.name, harness: state.harness, pipelines: state.pipelines, visual: options.visual, features: reports, file, text }
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
  return report
}
