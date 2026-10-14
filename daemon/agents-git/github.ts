// submit, and the GitHub side land shares. submit refuses a branch whose new
// commits break a rule a machine can check: the coding framework's static gates
// on the branch's diff, main's name guard and the secret patterns on every new
// commit and its message, personal details, and AGENTS.md's bans on editing
// .gitignore and adding check scripts. Then it copies the commits onto GitHub's
// history, pushes them as the branch, and opens the pull request.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { changes, list, read } from '../../server/mirror.ts'
import type { Finding } from '../../shared/framework.ts'
import { checksOnly, staticGates } from '../../shared/gates/diff.ts'
import { matcher } from '../../shared/gates/glob.ts'
import type { Policy } from '../../shared/policy.ts'
import { PATTERNS } from '../../shared/scrub.ts'
import { aheadOf, commitOf, git, gitRun, mergeBase, moveRefs, run, Sha, short, Tree, uncommitted } from './git.ts'
import { MAIN_BRANCH, withLedger, type CheckRun, type LiveEntry, type Name } from './ledger.ts'
import { failed, findReady, isReport, mainCommit, ok, onBranch, openRepo, plural, policyAt, refused, replace, type Repo, type Report } from './repo.ts'
import { childEnv } from './group.ts'

// The remote that is GitHub.
export const GITHUB = 'origin'
// Every copy on GitHub carries Tayler's no-reply address where the local commit has
// the email git is configured with here.
const GITHUB_EMAIL = '193937077+tayler-id@users.noreply.github.com'
// The local commit GitHub's history starts from and its copy there, and the last
// pair pushed. Set the first pair once with git update-ref, as the design doc shows.
const ROOT = { local: 'refs/mirror/local-root', github: 'refs/mirror/github-root' }
const PUSHED = { local: 'refs/mirror/local-pushed', github: 'refs/mirror/github-pushed' }
const NAME_GUARD = 'test/names.ts'
// The file the name guard reads a commit's message and authors from.
const MESSAGE_FILE = '.agents-git-commit-message'
const NAME_GUARD_TIMEOUT_MS = 60_000
const GH_TIMEOUT_MS = 2 * 60_000
// A refusal lists at most this many problems, as the framework's gates do.
const SHOWN = 40

const PERSON = /^(.*) <([^>]*)> (\d+ [+-]\d{4})$/
const Person = z.string().regex(PERSON, 'an author or committer line').transform((line) => {
  const [, name = '', email = '', date = ''] = PERSON.exec(line) ?? []
  return { name, email, date }
})

// A commit as git stores it, split into the fields a copy needs.
async function commitParts(repo: string, commit: Sha) {
  const raw = await git(repo, ['cat-file', 'commit', commit])
  const split = raw.indexOf('\n\n')
  const fields = new Map<string, string>()
  for (const line of (split === -1 ? raw : raw.slice(0, split)).split('\n')) {
    const key = line.slice(0, Math.max(line.indexOf(' '), 0))
    if (['gpgsig', 'gpgsig-sha256', 'mergetag', 'encoding'].includes(key)) throw new Error(`${short(commit)} has a ${key} header, which a copy would lose`)
    if (key && !fields.has(key)) fields.set(key, line.slice(key.length + 1))
  }
  return {
    tree: Tree.parse(fields.get('tree')),
    author: Person.parse(fields.get('author')),
    committer: Person.parse(fields.get('committer')),
    message: split === -1 ? '' : raw.slice(split + 2),
  }
}

async function configuredEmail(repo: string): Promise<string | null> {
  const ran = await gitRun(repo, ['config', '--get', 'user.email'])
  return ran.code === 0 ? ran.stdout.trim() : null
}

// The local commit GitHub's history starts from, and its copy there.
async function roots(repo: string): Promise<{ from: Sha, onto: Sha }> {
  const from = await commitOf(repo, ROOT.local)
  const onto = await commitOf(repo, ROOT.github)
  if (!from || !onto) throw new Error(`${ROOT.local} and ${ROOT.github} must name the local commit GitHub's history starts from and its copy there`)
  return { from, onto }
}

// The commits a push of tip would put on GitHub, oldest first: everything after the
// last pair pushed, or after the root before any push, whether or not main has it. A
// copy of each goes up with the branch, so each is scanned before anything is pushed.
async function unpublished(repo: string, tip: Sha): Promise<Sha[]> {
  const known = await commitOf(repo, PUSHED.local) ?? (await roots(repo)).from
  return (await git(repo, ['rev-list', '--reverse', `${known}..${tip}`])).split('\n').filter((line) => line !== '').map((id) => Sha.parse(id))
}

// Copies every commit reachable from tips and not from the local root onto
// GitHub's root, as the coordinator's graft script did: the same tree, message and
// dates, parents mapped through the copies, and the configured email swapped for
// the no-reply one. The same commits always give the same copies, so a commit
// copied before comes out as the commit GitHub already has.
async function graft(repo: string, tips: readonly Sha[]): Promise<Map<Sha, Sha>> {
  const { from, onto } = await roots(repo)
  const email = await configuredEmail(repo)
  const swap = (address: string) => (address === email ? GITHUB_EMAIL : address)
  const copies = new Map<Sha, Sha>([[from, onto]])
  for (const row of (await git(repo, ['rev-list', '--reverse', '--topo-order', '--parents', ...tips, `^${from}`])).split('\n').filter((line) => line !== '')) {
    const [commit, ...parents] = row.split(' ').map((id) => Sha.parse(id))
    if (!commit) continue
    const parts = await commitParts(repo, commit)
    const parentArgs = parents.flatMap((parent) => {
      const copy = copies.get(parent)
      if (!copy) throw new Error(`${short(commit)} has parent ${short(parent)}, which is not after ${ROOT.local}`)
      return ['-p', copy]
    })
    const env = {
      GIT_AUTHOR_NAME: parts.author.name, GIT_AUTHOR_EMAIL: swap(parts.author.email), GIT_AUTHOR_DATE: parts.author.date,
      GIT_COMMITTER_NAME: parts.committer.name, GIT_COMMITTER_EMAIL: swap(parts.committer.email), GIT_COMMITTER_DATE: parts.committer.date,
    }
    copies.set(commit, Sha.parse((await git(repo, ['commit-tree', '--no-gpg-sign', parts.tree, ...parentArgs], { env, input: parts.message })).trim()))
  }
  return copies
}

// The copy of commit on GitHub's history, after proving the copies match what
// GitHub already has: the last pair pushed must come out of the rebuild unchanged.
export async function copyOf(repo: string, commit: Sha): Promise<Sha> {
  const pushed = { local: await commitOf(repo, PUSHED.local), github: await commitOf(repo, PUSHED.github) }
  const copies = await graft(repo, pushed.local ? [commit, pushed.local] : [commit])
  if (pushed.local && copies.get(pushed.local) !== pushed.github) throw new Error(`rebuilding ${PUSHED.local} gives ${copies.get(pushed.local) ?? 'nothing'}, not ${PUSHED.github} at ${pushed.github ?? 'nothing'}, so the copies would not match GitHub's history`)
  const copy = copies.get(commit)
  if (!copy) throw new Error(`${short(commit)} is not after ${ROOT.local}`)
  return copy
}

// Main's copy on GitHub, or the problems that stopped the push.
export type Mirrored = { copy: Sha } | { problems: string[] }

// Pushes main's copy to GitHub's main, never forced, and moves the pushed pair. First
// it scans every commit GitHub lacks, since the push publishes all of them, including
// any a person committed straight to main. A scan that finds something pushes nothing.
export async function mirrorMain(repo: string, main: Sha): Promise<Mirrored> {
  const problems = await publicProblems(repo, main, await unpublished(repo, main), [])
  if (problems.length) return { problems }
  const copy = await copyOf(repo, main)
  const pushed = await gitRun(repo, ['push', GITHUB, `${copy}:refs/heads/${MAIN_BRANCH}`])
  if (pushed.code !== 0) throw new Error(`git push to ${GITHUB}'s ${MAIN_BRANCH} exited ${pushed.code}: ${pushed.stderr.trim()}`)
  // Each rebuild is checked against the pair, so a pair with one ref moved would stop every later push.
  await moveRefs(repo, [
    { ref: PUSHED.local, commit: main, expected: await commitOf(repo, PUSHED.local) },
    { ref: PUSHED.github, commit: copy, expected: await commitOf(repo, PUSHED.github) },
  ])
  return { copy }
}

const where = (finding: Finding) => `${finding.path ?? 'the change'}${finding.line === null ? '' : `:${finding.line}`}`
const firstLine = (text: string) => text.split('\n')[0] ?? ''

// What the gates found, what needs Tayler, and the checks the change adds or edits.
export type Judged = { problems: string[], unapproved: string[], checks: string[] }

// What the framework's static gates say about base..tip, judged on main's policy.
// A gate that needs Tayler names its paths, and each must be approved.
export async function gates(repo: Repo, policy: Policy, main: Sha, base: Sha, tip: Sha, approved: ReadonlySet<string>): Promise<Judged> {
  const mirror = { dir: repo.main, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }
  const files = await changes(mirror, base, tip)
  const results = staticGates({
    policy, files,
    baseMigrations: await list(mirror, main, policy.docs.migrations),
    // A repo without the token stylesheet has no tokens, as for the framework's runner.
    tokens: await read(mirror, main, policy.lint.css.tokens) ?? '',
    featureMap: { kind: 'none' }, playbook: null, plan: null, requirePlan: false, refusedPushes: [],
  })
  const problems = results.filter((r) => r.status === 'fail').flatMap((r) => r.findings.map((f) => `${r.gate}: ${where(f)} ${firstLine(f.text)}`))
  const unapproved = results.filter((r) => r.status === 'needs_owner')
    .flatMap((r) => r.findings.filter((f) => f.path === null || !approved.has(f.path)).map((f) => `${where(f)} (${r.gate}: ${firstLine(f.text)})`))
  // AGENTS.md bans these outright, with no approval that lets them through.
  for (const f of files) {
    if (f.path.split('/').at(-1) === '.gitignore') problems.push(`working rules: ${f.path} changed, and agents never edit .gitignore`)
    if (f.path.split('/').at(-1) === 'package.json') {
      const scripts = (text: string | null) => {
        let parsed: unknown = {}
        try {
          parsed = text === null ? {} : JSON.parse(text)
        } catch {
          // The dependencies gate reports a package.json that is not JSON.
          return new Map<string, string>()
        }
        return new Map(Object.entries(z.object({ scripts: z.record(z.string(), z.string()).optional() }).parse(parsed).scripts ?? {}))
      }
      const before = scripts(f.before)
      for (const [key, value] of scripts(f.after)) {
        if (key.startsWith('check') && before.get(key) !== value) problems.push(`working rules: ${f.path} ${before.has(key) ? 'changes' : 'adds'} the check script ${key}, and agents never add check scripts`)
      }
    }
  }
  // As for the framework's runner, a change to checks alone has no checks to see
  // fail, since main's code is the change's code. The check-edits gate sends it to Tayler.
  const isCheck = matcher([policy.checks.pattern])
  const checks = checksOnly(policy, files) ? [] : files.filter((f) => f.status !== 'deleted' && isCheck(f.path)).map((f) => f.path)
  return { problems, unapproved, checks }
}

type Added = { path: string, line: number, text: string }

// A hunk header counts the lines it removes and the lines it adds, and omits a count of 1.
const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

// The file a "+++" header names. A name git quotes is kept as git prints it, so its
// lines are still read, and git ends a name that holds a space with a tab.
function headerPath(row: string): string {
  const name = row.slice('+++ '.length).replace(/\t$/, '')
  return name.startsWith('b/') ? name.slice('b/'.length) : name
}

// Each line a unified diff adds, with its file and line number. A hunk is read by
// the counts in its header, so a line in it is never taken for a file header: a
// file whose line reads "++ /dev/null" shows in the diff as "+++ /dev/null", and
// reading that as a header would drop it and every line after it. The framework's
// hunkAdds reads headers the same way, and returns the numbers without the text.
function addedIn(diff: string): Added[] {
  const out: Added[] = []
  const rows = diff.split('\n')
  let path = ''
  for (let i = 0; i < rows.length;) {
    const row = rows[i++] ?? ''
    const hunk = HUNK.exec(row)
    if (!hunk) {
      // Between hunks, a "+++" row is the header git wrote.
      if (row.startsWith('+++ ')) path = headerPath(row)
      continue
    }
    if (!path) throw new Error('a hunk came before the header that names its file')
    let removed = Number(hunk[1] ?? 1)
    let added = Number(hunk[3] ?? 1)
    let line = Number(hunk[2])
    while (removed > 0 || added > 0) {
      const body = rows[i++]
      if (body === undefined) throw new Error('a hunk ended before its counts did')
      if (body.startsWith('\\')) continue
      if (body.startsWith('-') && removed > 0) removed--
      else if (body.startsWith('+') && added > 0) {
        out.push({ path, line: line++, text: body.slice(1) })
        added--
      } else throw new Error(`a hunk holds a line its counts do not allow: ${JSON.stringify(body.slice(0, 40))}`)
    }
  }
  return out
}

// Each line a commit adds, with its file and line number.
async function addedLines(repo: string, commit: Sha): Promise<Added[]> {
  const diff = await git(repo, ['show', '--format=', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--diff-merges=first-parent', '--src-prefix=a/', '--dst-prefix=b/', commit])
  return addedIn(diff)
}

const secretsIn = (text: string) => PATTERNS.filter(([, pattern]) => text.search(pattern) !== -1).map(([kind]) => kind)
const NO_REPLY = /@users\.noreply\.github\.com$|^noreply@/

// What the scan finds in a text, by kind and never by value, and the email git is configured with.
async function scanner(repo: string) {
  const email = await configuredEmail(repo)
  const personal = [{ kind: 'this Mac\'s home folder', text: homedir() }, ...(email ? [{ kind: 'the email git is configured with here', text: email }] : [])]
  return {
    email,
    found: (text: string) => [...secretsIn(text).map((kind) => `matches the ${kind} secret pattern`), ...personal.filter((detail) => text.includes(detail.text)).map((detail) => `holds ${detail.kind}`)],
  }
}

// Text that goes public without being in a commit: the pull request's message,
// regression line and reviews, and the merge commit's message. at says where the
// text is, such as "review 2".
export type PublicText = { at: string, text: string }

// Secrets, personal details and old names in what would go public: each new commit,
// and the text that becomes the pull request or the merge commit. Each problem says
// where it is and what it is, never the value.
export async function publicProblems(repo: string, main: Sha, commits: readonly Sha[], texts: readonly PublicText[]): Promise<string[]> {
  const scan = await scanner(repo)
  const problems: string[] = []
  const probes: Probe[] = []
  for (const commit of commits) {
    const parts = await commitParts(repo, commit)
    for (const what of scan.found(parts.message)) problems.push(`${short(commit)} its message: ${what}`)
    for (const person of [parts.author, parts.committer]) {
      if (person.email !== scan.email && !NO_REPLY.test(person.email)) problems.push(`${short(commit)} its author or committer: an email that is neither the one configured here nor a no-reply address`)
    }
    for (const added of await addedLines(repo, commit)) {
      for (const what of scan.found(added.text)) problems.push(`${short(commit)} ${added.path}:${added.line}: ${what}`)
    }
    probes.push({ commit, text: `${parts.author.name}\n${parts.committer.name}\n${parts.message}`, textAt: `${short(commit)} its message`, filesAt: short(commit) })
  }
  for (const { at, text } of texts) {
    for (const what of scan.found(text)) problems.push(`${at}: ${what}`)
    probes.push({ commit: main, text, textAt: at, filesAt: null })
  }
  return [...problems, ...await namesIn(repo, main, probes)]
}

// What main's name guard is run on: the files of a commit, and a text in the message file.
type Probe = {
  commit: Sha
  // The text the guard reads from the message file, and what a hit in it is called.
  text: string
  textAt: string
  // What a hit in one of the commit's files is called, or null when only the text matters.
  filesAt: string | null
}

// main's name guard, run on each probe in a throwaway worktree. It is main's copy of
// the guard, never the branch's, which an agent could edit.
async function namesIn(repo: string, main: Sha, probes: readonly Probe[]): Promise<string[]> {
  const first = probes[0]
  if (first === undefined) return []
  const guard = await gitRun(repo, ['show', `${main}:${NAME_GUARD}`])
  if (guard.code !== 0) throw new Error(`main has no ${NAME_GUARD} to run on the commits`)
  const dir = mkdtempSync(join(tmpdir(), 'agents-git-names-'))
  const tree = join(dir, 'tree')
  const problems: string[] = []
  try {
    await git(repo, ['worktree', 'add', '--detach', '--quiet', tree, first.commit])
    for (const probe of probes) {
      await git(tree, ['checkout', '--detach', '--force', '--quiet', probe.commit])
      mkdirSync(dirname(join(tree, NAME_GUARD)), { recursive: true })
      writeFileSync(join(tree, NAME_GUARD), guard.stdout)
      writeFileSync(join(tree, MESSAGE_FILE), probe.text)
      const ran = await run(process.execPath, [NAME_GUARD], tree, NAME_GUARD_TIMEOUT_MS, childEnv())
      const hits = [...`${ran.stdout}\n${ran.stderr}`.matchAll(/^(.+?):(\d+) (.+?): /gm)]
      if (ran.code !== 0 && !hits.length) throw new Error(`main's ${NAME_GUARD} exited ${ran.code} on ${probe.textAt}: ${ran.stderr.trim()}`)
      for (const [, file = '', line = '', what = ''] of hits) {
        if (file === MESSAGE_FILE) problems.push(`${probe.textAt}: uses ${what}`)
        else if (probe.filesAt !== null) problems.push(`${probe.filesAt} ${file}:${line}: uses ${what}`)
      }
      rmSync(join(tree, MESSAGE_FILE))
    }
  } finally {
    await git(repo, ['worktree', 'remove', '--force', tree])
    rmSync(dir, { recursive: true, force: true })
  }
  return problems
}

export function listed(problems: readonly string[]): string[] {
  return [...problems.slice(0, SHOWN).map((p) => `  ${p}`), ...(problems.length > SHOWN ? [`  and ${problems.length - SHOWN} more`] : [])]
}

const Pulls = z.array(z.object({ url: z.url(), number: z.number().int().positive() }))

async function gh(cwd: string, args: readonly string[]): Promise<string> {
  const ran = await run('gh', args, cwd, GH_TIMEOUT_MS, childEnv())
  if (ran.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} exited ${ran.code}: ${ran.stderr.trim()}`)
  return ran.stdout
}

// The pull request's text, all from the ledger. A regression goes first.
function bodyOf(entry: { message: string, reviews: readonly string[], regression: string | null, checks: readonly CheckRun[] }, tip: Sha): string {
  const latest = new Map(entry.checks.filter((c) => c.head === tip).map((c) => [c.step, c]))
  return [
    ...(entry.regression ? [`Regression: ${entry.regression}`, ''] : []),
    entry.message, '',
    'Reviews', ...(entry.reviews.length ? entry.reviews.map((r) => `- ${r}`) : ['- none noted yet']), '',
    `Checks at ${short(tip)}`, ...(latest.size ? [...latest.values()].map((c) => `- ${c.step}: ${c.passed} passed, ${c.failed} failed, ${c.result}`) : ['- none recorded']),
  ].join('\n')
}

// The text of the pull request that comes from the ledger: the message, which is also
// its title, the regression line and each review.
const textsOf = (notes: { message: string, regression: string | null, reviews: readonly string[] }): PublicText[] => [
  { at: 'the pull request message', text: notes.message },
  ...(notes.regression === null ? [] : [{ at: 'the regression line', text: notes.regression }]),
  ...notes.reviews.map((text, i) => ({ at: `review ${i + 1}`, text })),
]

export type Notes = { message: string | undefined, reviews: readonly string[], regression: string | undefined, approve: readonly string[] }

// The ledger's notes with this run's added: a new message or regression replaces
// the old one, and reviews and approvals add to theirs.
export function withNotes(entry: LiveEntry, notes: Notes) {
  return {
    message: notes.message ?? entry.message,
    reviews: [...entry.reviews, ...notes.reviews.filter((r) => !entry.reviews.includes(r))],
    regression: notes.regression ?? entry.regression,
    approved: [...entry.approved, ...notes.approve.filter((p) => !entry.approved.includes(p))],
  }
}

export async function submit(ledgerFile: string, cwd: string, name: Name, notes: Notes): Promise<Report> {
  const plan = await withLedger(ledgerFile, `submit ${name}`, async (ledger) => {
    const repo = await openRepo(cwd)
    const entry = findReady(ledger, repo, name)
    if (isReport(entry)) return entry
    const worktree = onBranch(repo, entry)
    if (isReport(worktree)) return worktree
    if (entry.branch === null) return refused(`submit ${name}: it is on a detached HEAD, and submit pushes a branch`)
    const changed = await uncommitted(entry.path)
    if (changed) return refused(`submit ${name}: it has ${plural(changed, 'uncommitted file')}`, 'commit them, then submit again')
    const main = await mainCommit(repo.main)
    const ahead = await aheadOf(repo.main, worktree.head, main)
    if (!ahead) return refused(`submit ${name}: main already has every commit on it`)
    const merged = withNotes(entry, notes)
    if (merged.message === null) return refused(`submit ${name}: there is no message for the pull request`, `submit ${name} --message <text>`)
    const base = await mergeBase(repo.main, main, worktree.head)
    if (!base) return refused(`submit ${name}: it shares no history with main`)
    return { repo, entry, tip: worktree.head, main, base, merged: { ...merged, message: merged.message }, policy: await policyAt(repo.main, main) }
  })
  if (isReport(plan)) return plan
  const commits = await unpublished(plan.repo.main, plan.tip)
  const judged = await gates(plan.repo, plan.policy, plan.main, plan.base, plan.tip, new Set(plan.merged.approved))
  const problems = [...judged.problems, ...await publicProblems(plan.repo.main, plan.main, commits, textsOf(plan.merged))]
  if (problems.length) return { code: 3, lines: [`refused: submit ${name}: ${plural(problems.length, 'problem')} in what it would publish. Nothing changed.`, ...listed(problems)] }
  if (judged.unapproved.length) return { code: 3, lines: [`refused: submit ${name}: these need Tayler's approval. Nothing changed.`, ...listed(judged.unapproved), `next: once Tayler approves, submit ${name} --approve <path> for each`] }
  const copy = await copyOf(plan.repo.main, plan.tip)
  const pushed = await gitRun(plan.repo.main, ['push', GITHUB, `${copy}:refs/heads/${name}`])
  if (pushed.code !== 0) return failed(`git push of ${short(copy)} to ${GITHUB}'s ${name} exited ${pushed.code}, and nothing was forced`, pushed.stderr.trim())
  const body = bodyOf({ ...plan.merged, checks: plan.entry.checks }, plan.tip)
  const open = Pulls.parse(JSON.parse(await gh(plan.repo.main, ['pr', 'list', '--head', name, '--state', 'open', '--json', 'url,number', '--limit', '1'])))
  let pr: string
  const existing = open[0]
  if (existing) {
    await gh(plan.repo.main, ['pr', 'edit', String(existing.number), '--body', body])
    pr = existing.url
  } else {
    const title = plan.merged.message.split('\n')[0] ?? plan.merged.message
    pr = z.url().parse((await gh(plan.repo.main, ['pr', 'create', '--head', name, '--base', MAIN_BRANCH, '--title', title, '--body', body])).trim().split('\n').at(-1))
  }
  await withLedger(ledgerFile, `submit ${name}`, async (ledger, write) => {
    const entry = ledger.worktrees.find((e) => e.repo === plan.repo.main && e.name === name)
    if (entry?.state !== 'active') throw new Error(`${name} left the ledger while it was submitted`)
    write(replace(ledger, { ...entry, ...plan.merged, submitted: { head: plan.tip, copy, pr, at: new Date().toISOString() } }))
  })
  return ok(`ok: submitted ${name} as ${short(copy)} on ${GITHUB}'s ${name}, ${existing ? 'updating' : 'opening'} ${pr}`)
}

