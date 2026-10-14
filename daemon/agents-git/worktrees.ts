// The worktree commands: start, list, adopt, done and prune. Each reads the facts it
// acts on from git while it holds the ledger's lock, right before it acts, and
// refuses rather than guess when it can't prove one.

import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { messageOf } from '../../shared/errors.ts'
import { aheadOf, commitOf, deleteRef, git, isAncestor, mergeBase, moveRef, run, short, uncommitted, worktreeList, type GitWorktree, type Sha } from './git.ts'
import { alive, Name, withLedger, type Entry, type Ledger, type LiveEntry } from './ledger.ts'

// Worktrees live beside the main checkout, never inside it, in a folder named after
// it: ~/Projects/agents gets ~/Projects/agents-worktrees.
export const worktreeRoot = (main: string) => `${main}-worktrees`
// Every ref agents-git keeps for a worktree sits under this prefix.
export const refsOf = (name: Name) => `refs/agents-git/${name}`
// Where done keeps a worktree's last commit. Removing a worktree deletes its HEAD, the
// only thing that keeps a commit made on a detached HEAD, and gc later deletes the commit.
export const doneRef = (name: Name) => `${refsOf(name)}/done`
const MAIN = 'refs/heads/main'
// npm ci downloads Electron's binary when its cache is cold, which can take minutes.
const NPM_CI_TIMEOUT_MS = 15 * 60_000
// How much of a failed npm ci's output start repeats.
const NPM_TAIL_LINES = 20

export type Report = { code: 0 | 1 | 2 | 3, lines: string[] }
export const ok = (...lines: string[]): Report => ({ code: 0, lines })
export const refused = (reason: string, next?: string): Report => ({ code: 3, lines: [`refused: ${reason}. Nothing changed.`, ...(next === undefined ? [] : [`next: ${next}`])] })
export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

type Repo = { main: string, others: GitWorktree[] }

async function openRepo(cwd: string): Promise<Repo> {
  const [main, ...others] = await worktreeList(cwd)
  if (!main || main.bare) throw new Error(`agents-git needs a repo with a main checkout, and ${cwd} is in a bare one`)
  return { main: main.path, others }
}

async function mainCommit(repo: string): Promise<Sha> {
  const sha = await commitOf(repo, MAIN)
  if (!sha) throw new Error(`${repo} has no local main branch`)
  return sha
}

async function refsUnder(repo: string, prefix: string): Promise<string[]> {
  return (await git(repo, ['for-each-ref', '--format=%(refname)', prefix])).split('\n').filter((ref) => ref !== '')
}

const isLive = (entry: Entry): entry is LiveEntry => entry.state !== 'done'

type Facts = {
  // Git's record of a worktree at the entry's path.
  git: GitWorktree | undefined
  folder: boolean
  // The worktree's commit, else its branch's, else the one done saved.
  head: Sha | null
  // Uncommitted files, or null when git can't reach a worktree to count them in.
  changed: number | null
  // Commits in head that main doesn't have.
  ahead: number | null
  saved: Sha | null
  // done may point its ref at head: the ref doesn't exist, or holds head or an older commit of it.
  savable: boolean
}

async function inspect(repo: Repo, mainSha: Sha, entry: LiveEntry): Promise<Facts> {
  const registered = repo.others.find((w) => w.path === entry.path)
  const saved = await commitOf(repo.main, doneRef(entry.name))
  const head = registered?.head ?? (entry.branch === null ? null : await commitOf(repo.main, `refs/heads/${entry.branch}`)) ?? saved
  return {
    git: registered,
    folder: existsSync(entry.path),
    head,
    changed: registered && !registered.prunable ? await uncommitted(entry.path) : null,
    ahead: head ? await aheadOf(repo.main, head, mainSha) : null,
    saved,
    savable: saved === null || head === null || saved === head || await isAncestor(repo.main, saved, head),
  }
}

// Why done must refuse, if it must.
function blockers(entry: LiveEntry, facts: Facts): string[] {
  const reasons: string[] = []
  if (entry.state === 'starting' && alive(entry.pid)) reasons.push(`start is still installing its packages as pid ${entry.pid}`)
  if (facts.git && facts.git.locked !== null) reasons.push(`git has it locked${facts.git.locked ? ` (${facts.git.locked})` : ''}`)
  if (facts.folder && (!facts.git || facts.git.prunable)) reasons.push(`${entry.path} exists, but git has no worktree there`)
  if (facts.git && !facts.git.prunable && facts.git.branch !== entry.branch) reasons.push(`it is on ${facts.git.branch ? `branch ${facts.git.branch}` : 'a detached HEAD'}, and the ledger says ${entry.branch ?? 'a detached HEAD'}`)
  if (entry.branch === 'main') reasons.push('its branch is main')
  if (facts.changed) reasons.push(plural(facts.changed, 'uncommitted file'))
  if (facts.ahead) reasons.push(`${plural(facts.ahead, 'commit')} not in main`)
  if (!facts.head) reasons.push(`no commit is left to keep: no worktree, no branch and no ${doneRef(entry.name)}`)
  if (!facts.savable && facts.saved) reasons.push(`${doneRef(entry.name)} holds ${short(facts.saved)}, which isn't part of this worktree`)
  return reasons
}

export async function start(ledgerFile: string, cwd: string, name: Name, note: string): Promise<Report> {
  const made = await withLedger(ledgerFile, `start ${name}`, async (ledger, write) => {
    const repo = await openRepo(cwd)
    const root = worktreeRoot(repo.main)
    const path = join(existsSync(root) ? realpathSync(root) : root, name)
    const reasons: string[] = []
    if (ledger.worktrees.some((e) => e.name === name)) reasons.push(`the ledger already has ${name}`)
    const dirty = await uncommitted(repo.main)
    if (dirty) reasons.push(`the main checkout has ${plural(dirty, 'uncommitted file')}`)
    if (await commitOf(repo.main, `refs/heads/${name}`)) reasons.push(`branch ${name} exists`)
    reasons.push(...(await refsUnder(repo.main, refsOf(name))).map((ref) => `${ref} exists`))
    if (existsSync(path)) reasons.push(`${path} exists`)
    if (repo.others.some((w) => w.path === path)) reasons.push(`git still lists a worktree at ${path}`)
    const base = await commitOf(repo.main, MAIN)
    if (!base) reasons.push('there is no local main branch')
    if (reasons.length || !base) return refused(`start ${name}: ${reasons.join('; ')}`)
    mkdirSync(dirname(path), { recursive: true })
    await git(repo.main, ['worktree', 'add', '-b', name, path, base])
    const added = (await worktreeList(repo.main)).find((w) => w.path === path)
    if (added?.branch !== name || added.head !== base) throw new Error(`git worktree add left ${path} on ${added?.branch ?? 'no branch'} at ${added?.head ?? 'no commit'}, not on ${name} at ${base}`)
    const entry: LiveEntry = { name, repo: repo.main, path, branch: name, base, origin: 'started', createdAt: new Date().toISOString(), note, state: 'starting', pid: process.pid }
    write({ ...ledger, worktrees: [...ledger.worktrees, entry] })
    return entry
  })
  if ('code' in made) return made
  const failure = await npmCi(made.path)
  return withLedger(ledgerFile, `start ${name}`, async (ledger, write) => {
    const entry = ledger.worktrees.find((e) => e.name === name)
    if (entry?.state !== 'starting' || entry.pid !== process.pid) throw new Error(`the ledger's entry for ${name} changed while npm ci ran`)
    if (failure === null) {
      write(replace(ledger, { ...tracked(entry), state: 'active' }))
      return ok(`ok: started ${name} on branch ${name} from main ${short(entry.base)}, with its own node_modules`, entry.path)
    }
    // Nothing but npm has run in the worktree yet, so taking it back loses nothing,
    // and start can run again with the same name.
    const repo = await openRepo(cwd)
    const worktree = repo.others.find((w) => w.path === entry.path)
    let kept: string | null = null
    if (worktree?.branch !== name || worktree.head !== entry.base) kept = 'it is no longer on its branch at main'
    else if (await uncommitted(entry.path)) kept = 'it has uncommitted files'
    if (kept) return { code: 1, lines: [`failed: npm ci in ${entry.path} failed, and the worktree stays because ${kept}`, failure, `next: fix it there, or run done ${name} --yes`] }
    await git(repo.main, ['worktree', 'remove', entry.path])
    await deleteRef(repo.main, `refs/heads/${name}`, entry.base)
    write({ ...ledger, worktrees: ledger.worktrees.filter((e) => e !== entry) })
    return { code: 1, lines: [`failed: npm ci in ${entry.path} failed, so start removed the worktree and branch ${name}`, failure, `next: fix what npm reports on main, then run start ${name} again`] }
  })
}

// Returns why the install failed, or null when it worked.
async function npmCi(path: string): Promise<string | null> {
  // npm's script starts node from the PATH, so the node running agents-git goes first.
  const node = dirname(process.execPath)
  const env = { ...process.env, PATH: process.env.PATH ? `${node}:${process.env.PATH}` : node }
  try {
    const ran = await run('npm', ['ci'], path, NPM_CI_TIMEOUT_MS, env)
    if (ran.code === 0) return null
    return [`npm ci exited ${ran.code}:`, ...`${ran.stdout}\n${ran.stderr}`.split('\n').filter((line) => line.trim() !== '').slice(-NPM_TAIL_LINES)].join('\n')
  } catch (error) {
    return messageOf(error)
  }
}

function replace(ledger: Ledger, entry: Entry): Ledger {
  return { ...ledger, worktrees: ledger.worktrees.map((e) => (e.repo === entry.repo && e.name === entry.name ? entry : e)) }
}

export async function list(ledgerFile: string, cwd: string): Promise<Report> {
  return withLedger(ledgerFile, 'list', async (ledger) => {
    const repo = await openRepo(cwd)
    const mainSha = await mainCommit(repo.main)
    const mine = ledger.worktrees.filter((e) => e.repo === repo.main)
    const live = mine.filter(isLive)
    const lines: string[] = []
    let flagged = 0
    for (const entry of live) {
      const facts = await inspect(repo, mainSha, entry)
      const flags = flagsOf(entry, facts)
      if (flags.length) flagged++
      lines.push(...describe(entry, facts), ...flags.map((flag) => `  ! ${flag}`))
    }
    const untracked = repo.others.filter((w) => !live.some((e) => e.path === w.path))
    for (const w of untracked) {
      lines.push(`${basename(w.path)}  not in the ledger`, `  branch ${w.branch ?? '(detached)'}  head ${w.head ? short(w.head) : 'none'}`, `  path ${w.path}`)
      if (w.locked !== null) lines.push(`  ! locked by git${w.locked ? `: ${w.locked}` : ''}`)
      if (w.prunable) lines.push('  ! its folder is gone, and git still lists it')
    }
    return ok(`ok: ${plural(live.length, 'tracked worktree')}, ${untracked.length} not in the ledger, ${flagged} flagged, ${mine.length - live.length} done`, ...lines)
  })
}

function describe(entry: LiveEntry, facts: Facts): string[] {
  const merged = facts.ahead === null ? 'no commit found'
    : facts.ahead > 0 ? `${plural(facts.ahead, 'commit')} not in main`
      : facts.head === entry.base ? 'no new commits' : 'merged'
  const changed = facts.changed === null ? 'no worktree to look in' : plural(facts.changed, 'uncommitted file')
  return [
    `${entry.name}  ${entry.state}  ${merged}  ${changed}`,
    `  branch ${entry.branch ?? '(detached)'}  base ${short(entry.base)}  head ${facts.head ? short(facts.head) : 'none'}`,
    `  path ${entry.path}`,
    `  ${entry.origin === 'started' ? 'created' : 'adopted'} ${entry.createdAt}  note: ${entry.note ?? 'none'}`,
  ]
}

// Where the ledger and git disagree, and what else a person should look at.
function flagsOf(entry: LiveEntry, facts: Facts): string[] {
  const flags: string[] = []
  if (!facts.folder) flags.push(facts.git ? 'its folder is gone, and git still lists it' : 'its folder is gone, and git no longer lists it')
  else if (!facts.git || facts.git.prunable) flags.push('git has no worktree at this path')
  if (facts.git && facts.git.locked !== null) flags.push(`locked by git${facts.git.locked ? `: ${facts.git.locked}` : ''}`)
  if (facts.git && !facts.git.prunable && facts.git.branch !== entry.branch) flags.push(`git has it on ${facts.git.branch ?? 'a detached HEAD'}, and the ledger says ${entry.branch ?? 'a detached HEAD'}`)
  if (entry.state === 'starting') flags.push(alive(entry.pid) ? `start is installing its packages as pid ${entry.pid}` : `start stopped before it finished (pid ${entry.pid} is gone)`)
  return flags
}

export async function adopt(ledgerFile: string, cwd: string, target: string, name: Name | undefined, note: string | undefined): Promise<Report> {
  return withLedger(ledgerFile, `adopt ${target}`, async (ledger, write) => {
    const repo = await openRepo(cwd)
    if (!existsSync(target)) return refused(`${target} does not exist`)
    const path = realpathSync(target)
    if (path === repo.main) return refused(`${path} is the main checkout`)
    const found = repo.others.find((w) => w.path === path)
    if (!found?.head || found.prunable) return refused(`git has no worktree at ${path}`)
    if (found.branch === 'main') return refused(`${path} has main checked out, and done would delete a branch it finishes`)
    const chosen = Name.safeParse(name ?? basename(path))
    if (!chosen.success) return { code: 2, lines: [`usage: ${basename(path)} can't be a name, so pass --name: ${chosen.error.issues.map((i) => i.message).join('; ')}`] }
    const tracked = ledger.worktrees.find((e) => isLive(e) && e.path === path)
    if (tracked) return refused(`${path} is already tracked as ${tracked.name}`)
    if (ledger.worktrees.some((e) => e.name === chosen.data)) return refused(`the ledger already has ${chosen.data}`, 'pass another --name')
    const refs = await refsUnder(repo.main, refsOf(chosen.data))
    if (refs.length) return refused(`${refs.join(', ')} exists`, 'pass another --name')
    const base = await mergeBase(repo.main, found.head, await mainCommit(repo.main))
    if (!base) return refused(`${path} shares no history with main`)
    write({ ...ledger, worktrees: [...ledger.worktrees, { name: chosen.data, repo: repo.main, path, branch: found.branch, base, origin: 'adopted', createdAt: new Date().toISOString(), note: note ?? null, state: 'active' }] })
    return ok(`ok: adopted ${chosen.data} at ${path}, on ${found.branch ? `branch ${found.branch}` : 'a detached HEAD'} at ${short(found.head)}`)
  })
}

export async function done(ledgerFile: string, cwd: string, name: Name, yes: boolean): Promise<Report> {
  return withLedger(ledgerFile, `done ${name}`, async (ledger, write) => {
    const repo = await openRepo(cwd)
    const entry = ledger.worktrees.find((e) => e.repo === repo.main && e.name === name)
    if (!entry) return refused(`the ledger has no worktree named ${name} in ${repo.main}`)
    if (entry.state === 'done') return ok(`ok: ${name} was already done at ${entry.doneAt}, at ${short(entry.finalHead)}`)
    const facts = await inspect(repo, await mainCommit(repo.main), entry)
    const reasons = blockers(entry, facts)
    if (reasons.length || !facts.head) return refused(`done ${name}: ${reasons.join('; ')}`)
    const head = facts.head
    const branch = entry.branch !== null && await commitOf(repo.main, `refs/heads/${entry.branch}`) ? entry.branch : null
    const plan = [`save ${short(head)} as ${doneRef(name)}`, facts.git ? `remove ${entry.path}` : `drop ${entry.path}, which git no longer lists`, branch ? `delete branch ${branch} if main has it` : 'leave branches alone']
    if (!yes) return { code: 0, lines: [`preview: done ${name} would ${plan.join(', ')}`, `next: done ${name} --yes`] }
    if (facts.saved !== head) await moveRef(repo.main, doneRef(name), head, facts.saved)
    if (facts.git) await git(repo.main, ['worktree', 'remove', entry.path])
    const kept = branch === null ? null : await deleteIfMerged(repo.main, branch)
    write(replace(ledger, { ...tracked(entry), state: 'done', doneAt: new Date().toISOString(), finalHead: head, branchDeleted: branch !== null && kept === null }))
    const left = branch === null ? 'no branch to delete' : kept === null ? `deleted branch ${branch}` : `kept branch ${branch}, since ${kept}`
    return ok(`ok: ${name} is done. Saved ${short(head)} as ${doneRef(name)}, removed the worktree, ${left}`)
  })
}

// The last look before a branch goes: it still exists, no worktree has it checked
// out, and main has every commit on it. update-ref then deletes it only if it still
// points at the commit checked, under git's own lock. Returns why it was kept, or
// null when it was deleted.
async function deleteIfMerged(repo: string, branch: string): Promise<string | null> {
  const ref = `refs/heads/${branch}`
  const tip = await commitOf(repo, ref)
  if (!tip) return 'it is already gone'
  if ((await worktreeList(repo)).some((w) => w.branch === branch)) return 'another worktree has it checked out'
  if (!(await isAncestor(repo, tip, MAIN))) return 'main lacks some of its commits'
  await deleteRef(repo, ref, tip)
  return null
}

// The fields every state shares.
function tracked(entry: LiveEntry) {
  if (entry.state === 'active') {
    const { state, ...rest } = entry
    return rest
  }
  const { state, pid, ...rest } = entry
  return rest
}

export async function prune(ledgerFile: string, cwd: string, yes: boolean): Promise<Report> {
  const rows = await withLedger(ledgerFile, 'prune', async (ledger) => {
    const repo = await openRepo(cwd)
    const mainSha = await mainCommit(repo.main)
    const found: { name: Name, why: string, reasons: string[] }[] = []
    for (const entry of ledger.worktrees) {
      if (entry.repo !== repo.main || !isLive(entry)) continue
      const facts = await inspect(repo, mainSha, entry)
      // A worktree with no new commits may be one an agent has just started in.
      const why = !facts.folder ? 'its folder is gone' : facts.changed === 0 && facts.ahead === 0 && facts.head !== entry.base ? 'merged and clean' : null
      if (why) found.push({ name: entry.name, why, reasons: blockers(entry, facts) })
    }
    return found
  })
  const ready = rows.filter((row) => !row.reasons.length)
  const skipped = rows.filter((row) => row.reasons.length).map((row) => `skipped ${row.name}: ${row.why}, but ${row.reasons.join('; ')}`)
  if (!yes) return ok(`preview: prune would finish ${plural(ready.length, 'worktree')}`, ...ready.map((row) => `  ${row.name}  ${row.why}`), ...skipped, ...(ready.length ? ['next: prune --yes'] : []))
  const codes: Report['code'][] = []
  const lines: string[] = []
  for (const row of ready) {
    // done checks every fact again under the lock, since any of them may have changed.
    const report = await done(ledgerFile, cwd, row.name, true).catch((error: unknown): Report => ({ code: 1, lines: [`failed: done ${row.name}: ${messageOf(error)}`] }))
    codes.push(report.code)
    lines.push(...report.lines)
  }
  const finished = codes.filter((code) => code === 0).length
  const code = codes.includes(1) ? 1 : codes.includes(3) ? 3 : 0
  return { code, lines: [`${code === 0 ? 'ok' : code === 1 ? 'failed' : 'refused'}: prune finished ${finished} of ${plural(ready.length, 'worktree')}`, ...lines, ...skipped] }
}
