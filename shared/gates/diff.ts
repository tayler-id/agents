// The static gates: what can be judged from a change's files alone, before any
// of its code runs. The runner reads the change from its own copy of the repo
// and calls these with the repo's policy. Each gate returns one result, and
// the lint gates judge only the lines the change adds.

import type { Finding, GateResult, MapOnMain, PlaybookName } from '../framework.ts'
import { PLAYBOOKS } from '../framework.ts'
import type { Policy } from '../policy.ts'
import { PATTERNS } from '../scrub.ts'
import { assertionCount, codeFindings } from './code.ts'
import { componentFindings, cssFindings, tokensOf } from './css.ts'
import { matcher } from './glob.ts'
import { planItems, planProblems } from './plan.ts'
import { proseFindings } from './prose.ts'
import { extensionOf, isScript } from './source.ts'

export type FileChange = {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  // The old path of a renamed file.
  from: string | null
  added: number
  deleted: number
  addedLines: ReadonlySet<number>
  // Null when the file is binary or over the read limit, and before or after
  // when it did not exist then.
  before: string | null
  after: string | null
  binary: boolean
  // The file's size after the change, or null when the change deletes it.
  bytes: number | null
  // The file's unified diff, shown for a protected file.
  diff: string
}

export type StaticContext = {
  policy: Policy
  files: FileChange[]
  // Migration file names on main.
  baseMigrations: string[]
  // The token stylesheet as it is on main.
  tokens: string
  featureMap: MapOnMain
  playbook: PlaybookName | null
  // The plan a person approved, when the run has one, and whether it must.
  plan: string | null
  requirePlan: boolean
  // Pushes the git proxy refused from the run's machine since the run began.
  refusedPushes: { refs: string[] }[]
}

// A protected file's diff is shown in full up to this many characters.
const DIFF_LIMIT = 6000
// A gate lists at most this many findings, and says how many more there were.
const FINDINGS_LIMIT = 40
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const
const SCRIPT_OR_SHELL = (path: string) => isScript(path) || extensionOf(path) === '.sh'
// The kinds of file the gates read: scripts, documents, stylesheets, SQL and
// JSON, and the config the other gates also read.
const JUDGED = /\.(ts|tsx|js|cjs|mjs|jsx|sh|md|css|sql|json|ya?ml|html)$/i
// A file the gates cannot read counts toward the size cap at this many bytes a line.
const BYTES_PER_LINE = 80
const TYPESCRIPT = new Set(['.ts', '.tsx'])
// The checks and what they rely on. An edit to any of them is an edit to a check.
const checkFiles = (policy: Policy) => matcher([policy.checks.pattern, ...policy.checks.related, '**/*.test.ts', '**/*.test.js'])

function result(gate: string, findings: Finding[], passed: string, failed: string, options: { owner?: boolean; stops?: boolean } = {}): GateResult {
  const shown = findings.slice(0, FINDINGS_LIMIT)
  if (findings.length > FINDINGS_LIMIT) shown.push({ path: null, line: null, text: `and ${findings.length - FINDINGS_LIMIT} more` })
  if (!findings.length) return { gate, status: 'pass', summary: passed, findings: [], stops: false }
  return { gate, status: options.owner ? 'needs_owner' : 'fail', summary: failed, findings: shown, stops: options.stops ?? false }
}

const present = (files: FileChange[]) => files.filter((f) => f.status !== 'deleted' && !f.binary && f.after !== null)
const onAdded = (file: FileChange, findings: Finding[]) => findings.filter((f) => f.line !== null && file.addedLines.has(f.line))

// The text of the lines a change added to a file.
function addedText(file: FileChange): string {
  const lines = (file.after ?? '').split('\n')
  return [...file.addedLines].map((n) => lines[n - 1] ?? '').join('\n')
}

const changed = (files: FileChange[], path: string) => files.find((f) => f.path === path && f.added > 0)

function protectedFiles({ policy, files }: StaticContext): GateResult {
  const isProtected = matcher(policy.protectedPaths)
  const touched = files.filter((f) => isProtected(f.path) || (f.from !== null && isProtected(f.from)))
  const findings = touched.map((f) => ({
    path: f.path, line: null,
    text: `${f.status}${f.from ? ` from ${f.from}` : ''}\n${f.diff.length > DIFF_LIMIT ? `${f.diff.slice(0, DIFF_LIMIT)}\n(diff cut at ${DIFF_LIMIT} characters)` : f.diff}`,
  }))
  return result('protected', findings, 'No protected path changed.', `${touched.length} protected file${touched.length === 1 ? '' : 's'} changed, so only the repo's owner can pass this.`, { owner: true })
}

function migrations({ policy, files, baseMigrations }: StaticContext): GateResult {
  const dir = `${policy.docs.migrations}/`
  const inDir = (path: string | null) => path !== null && path.startsWith(dir)
  const findings: Finding[] = []
  for (const f of files.filter((file) => file.status !== 'added' && (inDir(file.path) || inDir(file.from)))) {
    findings.push({ path: f.from ?? f.path, line: null, text: `${f.status} a migration that is already on main` })
  }
  const added = files.filter((f) => f.status === 'added' && inDir(f.path))
  if (added.length && !changed(files, policy.docs.dataModel)) {
    findings.push({ path: policy.docs.dataModel, line: null, text: `adds ${added.map((f) => f.path).join(', ')} without changing ${policy.docs.dataModel}` })
  }
  const latest = [...baseMigrations].sort().at(-1)
  for (const f of added) {
    const name = f.path.slice(dir.length)
    if (latest !== undefined && name <= latest) findings.push({ path: f.path, line: null, text: `sorts before ${latest}, which is already on main` })
  }
  return result('migrations', findings, 'No migration edited, and each new one comes with the data model.', 'The migrations break the rules for changing the schema.')
}

function docs({ policy, files }: StaticContext): GateResult {
  const isSource = matcher(policy.sourceDirs)
  const findings: Finding[] = []
  const parts = files.find((f) => f.path === policy.docs.parts)
  const partsText = parts ? addedText(parts) : ''
  for (const f of files.filter((file) => (file.status === 'added' || file.status === 'renamed') && isSource(file.path) && SCRIPT_OR_SHELL(file.path))) {
    const name = f.path.split('/').at(-1) ?? f.path
    if (!partsText.includes(f.path) && !partsText.includes(name)) findings.push({ path: f.path, line: null, text: `a new source file with no entry in ${policy.docs.parts}` })
  }
  if (!changed(files, policy.docs.buildLog)) findings.push({ path: policy.docs.buildLog, line: null, text: `the change adds nothing to ${policy.docs.buildLog}` })
  return result('docs', findings, 'Each new source file has an entry, and the build log has the change.', 'The docs are missing what this change needs.')
}

function secrets({ files }: StaticContext): GateResult {
  const patterns = PATTERNS.map(([name, pattern]) => [name, new RegExp(pattern.source, pattern.flags.replace('g', ''))] as const)
  const findings: Finding[] = []
  for (const f of files) {
    if (/(^|\/)\.env(\.[^/]*)?$/.test(f.path) && f.status !== 'deleted') findings.push({ path: f.path, line: null, text: 'an .env file' })
  }
  for (const f of present(files)) {
    const lines = (f.after ?? '').split('\n')
    for (const n of f.addedLines) {
      for (const [name, pattern] of patterns) {
        if (pattern.test(lines[n - 1] ?? '')) findings.push({ path: f.path, line: n, text: `matches the ${name} secret pattern` })
      }
    }
  }
  return result('secrets', findings, 'No secret or .env file in the diff.', 'The diff holds what looks like a secret.')
}

type Dependencies = Map<string, string>

function dependenciesOf(json: string | null): Dependencies | null {
  if (json === null) return new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  const out: Dependencies = new Map()
  if (typeof parsed !== 'object' || parsed === null) return out
  for (const section of DEPENDENCY_SECTIONS) {
    const entries: unknown = Object.entries(parsed).find(([key]) => key === section)?.[1]
    if (typeof entries !== 'object' || entries === null) continue
    for (const [name, version] of Object.entries(entries)) out.set(`${section}/${name}`, typeof version === 'string' ? version : JSON.stringify(version))
  }
  return out
}

function dependencies({ policy, files }: StaticContext): GateResult {
  const findings: Finding[] = []
  const owner: Finding[] = []
  const buildLog = files.find((f) => f.path === policy.docs.buildLog)
  const reasons = buildLog ? addedText(buildLog) : ''
  let moved = false
  for (const f of files.filter((file) => policy.dependencies.manifests.includes(file.path))) {
    const before = dependenciesOf(f.before)
    const after = dependenciesOf(f.after)
    if (before === null || after === null) {
      findings.push({ path: f.path, line: null, text: 'is not valid JSON' })
      continue
    }
    for (const [key, version] of after) {
      if (before.get(key) === version) continue
      const name = key.slice(key.indexOf('/') + 1)
      moved = true
      owner.push({ path: f.path, line: null, text: `${name} ${before.has(key) ? `from ${before.get(key) ?? ''} ` : ''}to ${version}` })
      if (!EXACT_VERSION.test(version)) findings.push({ path: f.path, line: null, text: `${name}@${version} is not an exact version` })
      if (!reasons.includes(name)) findings.push({ path: policy.docs.buildLog, line: null, text: `says nothing about why ${name} changes` })
    }
    for (const key of before.keys()) {
      if (after.has(key)) continue
      moved = true
      owner.push({ path: f.path, line: null, text: `removes ${key.slice(key.indexOf('/') + 1)}` })
    }
  }
  const isLock = matcher(policy.lockfiles)
  if (!moved && files.some((f) => isLock(f.path))) findings.push({ path: null, line: null, text: 'the lockfile changed, and no manifest dependency did' })
  if (findings.length) return result('dependencies', findings, '', 'The dependency change breaks the rules.')
  return result('dependencies', owner, 'No dependency changed.', 'Dependencies changed, so they go to the repo\'s owner.', { owner: true })
}

// New suppressions and skipped tests always fail. Removed assertions fail when
// product code changes too. In a change to checks alone the owner judges them.
function suppressions({ policy, files }: StaticContext): GateResult {
  const isCheck = checkFiles(policy)
  const findings: Finding[] = []
  for (const f of present(files)) findings.push(...codeFindings(f.path, f.after ?? '', f.addedLines).suppressions)
  if (!checksOnly(policy, files)) {
    for (const f of files.filter((file) => isCheck(file.path) && file.before !== null)) {
      const lost = assertionCount(f.path, f.before ?? '') - (f.after === null ? 0 : assertionCount(f.path, f.after))
      if (lost > 0) findings.push({ path: f.path, line: null, text: `removes ${lost} assertion${lost === 1 ? '' : 's'}` })
    }
  }
  return result('suppressions', findings, 'No new suppression, skipped test or removed assertion.', 'The change suppresses or loosens a check.')
}

// A kind of file the gates judge that they could not read, because git calls
// it binary or it is over the read limit, as a lockfile never is.
const unread = (policy: Policy, f: FileChange) => f.status !== 'deleted' && JUDGED.test(f.path) && !matcher(policy.lockfiles)(f.path) && (f.binary || f.after === null)

// No rule could see inside such a file, so a script with one NUL byte in a
// comment would pass them all. It fails here instead.
function opaque({ policy, files }: StaticContext): GateResult {
  const findings = files.filter((f) => unread(policy, f)).map((f) => ({
    path: f.path, line: null,
    text: f.binary ? `git reads it as binary (${f.bytes ?? 0} bytes), so no gate can read it` : `${f.bytes ?? 0} bytes, over what the gates read`,
  }))
  return result('opaque', findings, 'Every changed script, document, stylesheet, SQL and JSON file is text the gates read.', 'A changed file is hidden from the gates.')
}

function size({ policy, files }: StaticContext): GateResult {
  const isLock = matcher(policy.lockfiles)
  const read = files.filter((f) => !isLock(f.path) && !f.binary).reduce((n, f) => n + f.added + f.deleted, 0)
  const total = read + files.filter((f) => unread(policy, f)).reduce((n, f) => n + Math.ceil((f.bytes ?? 0) / BYTES_PER_LINE), 0)
  const findings = total > policy.maxChangedLines
    ? [{ path: null, line: null, text: `${total} changed lines, over the limit of ${policy.maxChangedLines}. Split the work into stacked pull requests.` }]
    : []
  return result('size', findings, `${total} changed lines, within the limit of ${policy.maxChangedLines}.`, 'The change is too big for one pull request.')
}

const WIDTH_PATTERNS = { desktop: /\bdesktop\b|\bwidth:\s*(?:1[0-9]{3}|[2-9][0-9]{3})\b/, phone: /\bphone\b|\bwidth:\s*(?:3[0-9]{2}|4[0-7][0-9]|480)\b/ } as const

function ui({ policy, files }: StaticContext): GateResult {
  if (policy.ui === null) return result('ui', [], 'This repo has no UI rule.', '')
  const { engines, widths } = policy.ui
  const isUi = matcher(policy.ui.paths)
  const isCheck = matcher([policy.checks.pattern])
  const touched = files.filter((f) => f.status !== 'deleted' && isUi(f.path))
  if (!touched.length) return result('ui', [], 'No UI file changed.', '')
  const covers = (text: string) => /from ['"](?:@playwright\/test|playwright|agentsctl)/.test(text)
    && engines.every((e) => text.includes(e)) && widths.every((w) => WIDTH_PATTERNS[w].test(text))
  const checks = present(files).filter((f) => isCheck(f.path) && covers(f.after ?? ''))
  const findings = checks.length ? [] : [{
    path: touched[0]?.path ?? null, line: null,
    text: `changes the UI with no Playwright check that covers ${engines.join(', ')} at ${widths.join(' and ')} width`,
  }]
  return result('ui', findings, `UI changed, and ${checks.map((c) => c.path).join(', ')} drives it.`, 'A UI change needs its Playwright check.')
}

function css({ policy, files, tokens }: StaticContext): GateResult {
  const tokenFile = files.find((f) => f.path === policy.lint.css.tokens && f.after !== null)
  const rules = { tokens: tokensOf(tokenFile?.after ?? tokens), neutral: new Set(policy.lint.css.neutral) }
  const isCss = matcher(policy.lint.css.files)
  const findings = present(files).flatMap((f) => onAdded(f, isCss(f.path)
    ? cssFindings(f.path, f.after ?? '', rules)
    : componentFindings(f.path, f.after ?? '', rules)))
  return result('css', findings, 'Every new color is a design token, and no accent touches a line.', 'The change breaks the design rules.')
}

function prose({ policy, files }: StaticContext): GateResult {
  const exempt = matcher(policy.lint.prose.exempt)
  const findings = present(files).filter((f) => !exempt(f.path)).flatMap((f) => onAdded(f, proseFindings(f.path, f.after ?? '', policy.lint.prose)))
  return result('prose', findings, 'The new prose follows the writing rules.', 'The new prose breaks the writing rules.')
}

function languages({ policy, files }: StaticContext): GateResult {
  const allowed = matcher(policy.allowedFiles)
  const findings = files
    .filter((f) => (f.status === 'added' || f.status === 'renamed') && !TYPESCRIPT.has(extensionOf(f.path)) && !allowed(f.path))
    .map((f) => ({ path: f.path, line: null, text: 'a new file in a language other than TypeScript, outside the allowlist' }))
  return result('languages', findings, 'Every new file is TypeScript or on the allowlist.', 'The change adds files in another language.')
}

function code({ files }: StaticContext): GateResult[] {
  const found = present(files).map((f) => codeFindings(f.path, f.after ?? '', f.addedLines))
  return [
    result('assertions', found.flatMap((f) => f.assertions), 'No new type assertion but as const.', 'The change adds type assertions.'),
    result('shell', found.flatMap((f) => f.shell), 'No new exec or shell: true.', 'The change runs shell strings.'),
    result('warnings', found.flatMap((f) => f.warnings), 'No new TODO, FIXME or XXX.', 'The change leaves warning comments.'),
  ]
}

function playbook({ policy, files, playbook: name }: StaticContext): GateResult {
  if (name === null) return result('playbook', [], 'The run picked no playbook.', '')
  const scope = PLAYBOOKS[name].scope
  const fits = scope === 'any' ? () => true
    : scope === 'docs' ? matcher(['**/*.md'])
      : matcher([...policy.dependencies.manifests, ...policy.lockfiles, policy.docs.buildLog])
  const findings = files.filter((f) => !fits(f.path)).map((f) => ({ path: f.path, line: null, text: `outside the ${name} playbook` }))
  return result('playbook', findings, `The change fits the ${name} playbook.`, `The change does not fit the ${name} playbook.`)
}

function plan({ policy, files, plan: text, requirePlan, featureMap }: StaticContext): GateResult {
  if (text === null) {
    const findings = requirePlan ? [{ path: null, line: null, text: 'the run has no plan a person approved' }] : []
    return result('plan', findings, 'This playbook has no plan.', 'Code was written without an approved plan.')
  }
  const isCheck = matcher([policy.checks.pattern])
  const touchedChecks = new Set(present(files).filter((f) => isCheck(f.path)).map((f) => f.path))
  const items = planItems(text)
  const findings: Finding[] = planProblems(text, policy.checks.pattern, policy.lint.prose, featureMap).map((problem) => ({ path: null, line: null, text: problem }))
  items.done.forEach((item, i) => {
    if (item.check !== null && isCheck(item.check) && !touchedChecks.has(item.check)) {
      findings.push({ path: item.check, line: null, text: `Done means item ${i + 1} names a check this change does not add or edit` })
    }
  })
  return result('plan', findings, `The approved plan's ${items.done.length} Done means items each name a changed check.`, 'The change does not match its approved plan.')
}

// An edit to an existing check never rides along with product code. A change
// to checks alone goes to the owner, with the reason in the build log.
function checkEdits({ policy, files }: StaticContext): GateResult {
  const isCheck = checkFiles(policy)
  const edited = files.filter((f) => f.status !== 'added' && isCheck(f.from ?? f.path))
  const alone = checksOnly(policy, files)
  if (!edited.length && !alone) return result('check_edits', [], 'No existing check changed.', '')
  if (!alone) {
    return result('check_edits', edited.map((f) => ({ path: f.path, line: null, text: `${f.status} with product code in the same change` })), '',
      'An existing check changed together with product code. Change a check in its own change, with the reason in the build log.')
  }
  // The change touches checks and documents alone, so main's code is the
  // change's code and seen failing cannot judge a check, new or edited. The
  // owner judges each one instead.
  const buildLog = files.find((f) => f.path === policy.docs.buildLog)
  const reasons = buildLog ? addedText(buildLog) : ''
  const unexplained = edited.filter((f) => !reasons.includes(f.path))
  if (unexplained.length) {
    return result('check_edits', unexplained.map((f) => ({ path: f.path, line: null, text: `changes a check with no reason in ${policy.docs.buildLog}` })), '',
      'A change to checks alone must say why in the build log.')
  }
  return result('check_edits', files.filter((f) => isCheck(f.from ?? f.path)).map((f) => {
    if (f.status === 'added') return { path: f.path, line: null, text: 'added in a change to checks alone, so seen failing cannot judge it' }
    const lost = (f.before === null ? 0 : assertionCount(f.path, f.before)) - (f.after === null ? 0 : assertionCount(f.path, f.after))
    return { path: f.path, line: null, text: `${f.status}${lost > 0 ? `, removing ${lost} assertion${lost === 1 ? '' : 's'}` : ''}` }
  }), '', 'Checks changed on their own, so the owner judges them.', { owner: true })
}

// Whether a change touches only checks and documents, where seen failing cannot apply.
export function checksOnly(policy: Policy, files: readonly FileChange[]): boolean {
  const isCheck = checkFiles(policy)
  const isDoc = matcher(['**/*.md'])
  return files.some((f) => isCheck(f.from ?? f.path)) && files.every((f) => isCheck(f.from ?? f.path) || isDoc(f.path))
}

function pushes({ refusedPushes }: StaticContext): GateResult {
  const findings = refusedPushes.map((p) => ({ path: null, line: null, text: `a push to ${p.refs.join(', ')} was refused` }))
  return result('pushes', findings, 'Nothing was pushed but the task branch.', 'The run\'s machine tried to push past the gates.', { stops: true })
}

export function staticGates(ctx: StaticContext): GateResult[] {
  return [
    pushes(ctx), protectedFiles(ctx), checkEdits(ctx), plan(ctx), playbook(ctx), opaque(ctx), size(ctx), migrations(ctx), docs(ctx), secrets(ctx),
    dependencies(ctx), suppressions(ctx), languages(ctx), ...code(ctx), css(ctx), prose(ctx), ui(ctx),
  ]
}
