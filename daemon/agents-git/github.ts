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
import { aheadOf, commitOf, git, gitRun, mergeBase, moveRef, run, Sha, short, Tree, uncommitted } from './git.ts'
import { withLedger, type CheckRun, type LiveEntry, type Name } from './ledger.ts'
import { failed, findReady, isReport, mainCommit, ok, onBranch, openRepo, plural, policyAt, refused, replace, type Repo, type Report } from './repo.ts'
import { childEnv } from './worktrees.ts'

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

// Copies every commit reachable from tips and not from the local root onto
// GitHub's root, as the coordinator's graft script did: the same tree, message and
// dates, parents mapped through the copies, and the configured email swapped for
// the no-reply one. The same commits always give the same copies, so a commit
// copied before comes out as the commit GitHub already has.
async function graft(repo: string, tips: readonly Sha[]): Promise<Map<Sha, Sha>> {
  const from = await commitOf(repo, ROOT.local)
  const onto = await commitOf(repo, ROOT.github)
  if (!from || !onto) throw new Error(`${ROOT.local} and ${ROOT.github} must name the local commit GitHub's history starts from and its copy there`)
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

// Pushes main's copy to GitHub's main, never forced, and moves the pushed pair.
export async function mirrorMain(repo: string, main: Sha): Promise<Sha> {
  const copy = await copyOf(repo, main)
  const pushed = await gitRun(repo, ['push', GITHUB, `${copy}:refs/heads/main`])
  if (pushed.code !== 0) throw new Error(`git push to ${GITHUB}'s main exited ${pushed.code}: ${pushed.stderr.trim()}`)
  await moveRef(repo, PUSHED.local, main, await commitOf(repo, PUSHED.local))
  await moveRef(repo, PUSHED.github, copy, await commitOf(repo, PUSHED.github))
  return copy
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

// Each line a commit adds, with its file and line number.
async function addedLines(repo: string, commit: Sha): Promise<{ path: string, line: number, text: string }[]> {
  const diff = await git(repo, ['show', '--format=', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--diff-merges=first-parent', commit])
  const out: { path: string, line: number, text: string }[] = []
  let path = ''
  let line = 0
  for (const row of diff.split('\n')) {
    // A name git quotes is kept as git prints it, so its lines are still read.
    if (row.startsWith('+++ ')) path = row.startsWith('+++ b/') ? row.slice('+++ b/'.length) : row === '+++ /dev/null' ? '' : row.slice('+++ '.length)
    else if (row.startsWith('@@')) line = Number(/\+(\d+)/.exec(row)?.[1] ?? '0')
    else if (row.startsWith('+') && path) out.push({ path, line: line++, text: row.slice(1) })
  }
  return out
}

const secretsIn = (text: string) => PATTERNS.filter(([, pattern]) => text.search(pattern) !== -1).map(([kind]) => kind)
const NO_REPLY = /@users\.noreply\.github\.com$|^noreply@/

// Secrets, personal details and old names in each new commit, by where they are
// and what they are, never by the value.
export async function commitProblems(repo: string, main: Sha, commits: readonly Sha[]): Promise<string[]> {
  const email = await configuredEmail(repo)
  const personal = [{ kind: 'this Mac\'s home folder', text: homedir() }, ...(email ? [{ kind: 'the email git is configured with here', text: email }] : [])]
  const problems: string[] = []
  const look = (commit: Sha, at: string, text: string) => {
    for (const kind of secretsIn(text)) problems.push(`${short(commit)} ${at}: matches the ${kind} secret pattern`)
    for (const detail of personal) if (text.includes(detail.text)) problems.push(`${short(commit)} ${at}: holds ${detail.kind}`)
  }
  for (const commit of commits) {
    const parts = await commitParts(repo, commit)
    look(commit, 'its message', parts.message)
    for (const person of [parts.author, parts.committer]) {
      if (person.email !== email && !NO_REPLY.test(person.email)) problems.push(`${short(commit)} its author or committer: an email that is neither the one configured here nor a no-reply address`)
    }
    for (const added of await addedLines(repo, commit)) look(commit, `${added.path}:${added.line}`, added.text)
  }
  return [...problems, ...await namesIn(repo, main, commits)]
}

// main's name guard, run on each new commit's files and message in a throwaway
// worktree. It is main's copy of the guard, never the branch's, which an agent could edit.
async function namesIn(repo: string, main: Sha, commits: readonly Sha[]): Promise<string[]> {
  const first = commits[0]
  if (first === undefined) return []
  const guard = await gitRun(repo, ['show', `${main}:${NAME_GUARD}`])
  if (guard.code !== 0) throw new Error(`main has no ${NAME_GUARD} to run on the commits`)
  const dir = mkdtempSync(join(tmpdir(), 'agents-git-names-'))
  const tree = join(dir, 'tree')
  const problems: string[] = []
  try {
    await git(repo, ['worktree', 'add', '--detach', '--quiet', tree, first])
    for (const commit of commits) {
      await git(tree, ['checkout', '--detach', '--force', '--quiet', commit])
      const parts = await commitParts(repo, commit)
      mkdirSync(dirname(join(tree, NAME_GUARD)), { recursive: true })
      writeFileSync(join(tree, NAME_GUARD), guard.stdout)
      writeFileSync(join(tree, MESSAGE_FILE), `${parts.author.name}\n${parts.committer.name}\n${parts.message}`)
      const ran = await run(process.execPath, [NAME_GUARD], tree, NAME_GUARD_TIMEOUT_MS, childEnv())
      const hits = [...`${ran.stdout}\n${ran.stderr}`.matchAll(/^(.+?):(\d+) (.+?): /gm)]
      if (ran.code !== 0 && !hits.length) throw new Error(`main's ${NAME_GUARD} exited ${ran.code} on ${short(commit)}: ${ran.stderr.trim()}`)
      for (const [, file = '', line = '', what = ''] of hits) problems.push(`${short(commit)} ${file === MESSAGE_FILE ? 'its message' : `${file}:${line}`}: uses ${what}`)
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
  const commits = (await git(plan.repo.main, ['rev-list', '--reverse', `${plan.main}..${plan.tip}`])).split('\n').filter((line) => line !== '').map((id) => Sha.parse(id))
  const judged = await gates(plan.repo, plan.policy, plan.main, plan.base, plan.tip, new Set(plan.merged.approved))
  const problems = [...judged.problems, ...await commitProblems(plan.repo.main, plan.main, commits)]
  if (problems.length) return { code: 3, lines: [`refused: submit ${name}: ${plural(problems.length, 'problem')} in its ${plural(commits.length, 'new commit')}. Nothing changed.`, ...listed(problems)] }
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
    pr = z.url().parse((await gh(plan.repo.main, ['pr', 'create', '--head', name, '--base', 'main', '--title', title, '--body', body])).trim().split('\n').at(-1))
  }
  await withLedger(ledgerFile, `submit ${name}`, async (ledger, write) => {
    const entry = ledger.worktrees.find((e) => e.repo === plan.repo.main && e.name === name)
    if (entry?.state !== 'active') throw new Error(`${name} left the ledger while it was submitted`)
    write(replace(ledger, { ...entry, ...plan.merged, submitted: { head: plan.tip, copy, pr, at: new Date().toISOString() } }))
  })
  return ok(`ok: submitted ${name} as ${short(copy)} on ${GITHUB}'s ${name}, ${existing ? 'updating' : 'opening'} ${pr}`)
}

