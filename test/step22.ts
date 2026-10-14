// agents-git, the worktree CLI, run against a repo this check makes in a temp
// folder, never the real one. It drives start, list, adopt, done and prune the way
// the coordinator would, and reads git's refs, the folders and the ledger after each.
// AGENTS_GIT_LEDGER points the ledger into the temp folder. Only this check sets it,
// so ~/.agents-app/worktrees.json is never read or written, and the check confirms
// that at the end. npm ci runs for real: the repo's one dependency is a tarball
// committed beside its lockfile, so it installs offline in under a second, from a
// cache in the temp folder. Uses no ports and no database.
//   node test/step22.ts

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const CLI = join(ROOT, 'daemon/agents-git/main.ts')
// One command, npm ci included, takes about a second here. A minute means it hangs.
const CLI_TIMEOUT_MS = 60_000
// How long a command may take to say it is waiting for the lock, or to finish once freed.
const LOCK_WAIT_LIMIT_MS = 20_000

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'agents-git-')))
const main = join(tmp, 'agents')
const root = `${main}-worktrees`
const elsewhere = join(tmp, 'elsewhere')
const home = join(tmp, 'home')
const ledgerFile = join(home, 'worktrees.json')
const hookRan = join(tmp, 'hook-ran')
const realLedger = join(homedir(), '.agents-app', 'worktrees.json')
const env: NodeJS.ProcessEnv = {
  ...process.env,
  AGENTS_GIT_LEDGER: ledgerFile,
  GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  npm_config_cache: join(tmp, 'npm-cache'),
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
}

const failures: string[] = []
function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

function cli(args: string[], cwd = main) {
  const ran = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS })
  return { code: ran.status, out: ran.stdout, first: ran.stdout.split('\n')[0] ?? '', last: ran.stdout.trimEnd().split('\n').at(-1) ?? '' }
}

// The check's own git runs no hooks, so only agents-git could have run the one below.
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8' }).trim()
}
const commit = (ref: string) => {
  const ran = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: main, env, encoding: 'utf8' })
  return ran.status === 0 ? ran.stdout.trim() : null
}
const short = (sha: string | null) => (sha ?? 'none').slice(0, 7)
const ledger = (): any => JSON.parse(readFileSync(ledgerFile, 'utf8'))
const entry = (name: string): any => ledger().worktrees.find((e: any) => e.name === name)
const registered = (path: string) => git(main, 'worktree', 'list', '--porcelain').split('\n\n').find((block) => block.startsWith(`worktree ${path}\n`))
const fingerprint = (file: string) => (existsSync(file) ? `${createHash('sha256').update(readFileSync(file)).digest('hex')} ${String(statSync(file).mtimeMs)}` : 'absent')
const commitFile = (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-qm', `add ${file}`)
}

const realBefore = fingerprint(realLedger)
const started = new Date().toISOString()
try {
  // A repo with one dependency that installs offline, and an origin whose main is ahead of the local one.
  writeFileSync(join(tmp, 'gitconfig'), '[user]\n\tname = step22\n\temail = step22@example.com\n')
  mkdirSync(join(tmp, 'tiny'))
  writeFileSync(join(tmp, 'tiny', 'package.json'), '{ "name": "tiny", "version": "1.0.0" }\n')
  writeFileSync(join(tmp, 'tiny', 'index.js'), 'export const tiny = 1\n')
  mkdirSync(main)
  git(main, 'init', '-q', '-b', 'main')
  execFileSync('npm', ['pack', '--silent', '--pack-destination', main], { cwd: join(tmp, 'tiny'), env })
  writeFileSync(join(main, 'package.json'), '{ "name": "step22", "private": true, "dependencies": { "tiny": "file:tiny-1.0.0.tgz" } }\n')
  execFileSync('npm', ['install', '--package-lock-only'], { cwd: main, env })
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(main, 'README.md'), 'step22\n')
  git(main, 'add', '-A')
  git(main, 'commit', '-qm', 'start')
  git(tmp, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
  git(main, 'remote', 'add', 'origin', join(tmp, 'origin.git'))
  git(main, 'push', '-q', 'origin', 'main')
  git(tmp, 'clone', '-q', join(tmp, 'origin.git'), 'other')
  commitFile(join(tmp, 'other'), 'theirs.md', 'pushed by someone else\n')
  git(join(tmp, 'other'), 'push', '-q', 'origin', 'main')
  git(main, 'fetch', '-q', 'origin')
  const hook = join(main, '.git', 'hooks', 'post-checkout')
  writeFileSync(hook, `#!/bin/sh\ntouch '${hookRan}'\n`)
  chmodSync(hook, 0o755)
  const localMain = commit('refs/heads/main')
  const originMain = commit('refs/remotes/origin/main')

  let run = cli([])
  check(run.code === 0 && run.first === 'ok: 0 tracked worktrees, 0 not in the ledger, 0 flagged, 0 done', 'with no arguments it lists, and nothing is tracked yet')

  // start
  run = cli(['start', 'alpha', '--note', 'step22 alpha'])
  const alpha = join(root, 'alpha')
  check(run.code === 0 && run.first.startsWith('ok: started alpha') && run.last === alpha, `start alpha prints ok and the worktree's path last (${run.first})`)
  check(commit('refs/heads/alpha') === localMain && localMain !== originMain, 'start makes branch alpha from local main, not from origin')
  check(registered(alpha) === `worktree ${alpha}\nHEAD ${localMain ?? ''}\nbranch refs/heads/alpha`, 'start puts the worktree beside the repo, on branch alpha')
  check(existsSync(join(alpha, 'node_modules', 'tiny', 'package.json')) && lstatSync(join(alpha, 'node_modules')).isDirectory(), "start runs npm ci in the worktree, into a node_modules of its own")
  check(!existsSync(hookRan), "start runs no hook from the repo")
  const a = entry('alpha')
  check(a?.repo === main && a.path === alpha && a.branch === 'alpha' && a.base === localMain && a.origin === 'started' && a.note === 'step22 alpha' && a.state === 'active' && a.createdAt >= started, 'the ledger records alpha: repo, path, branch, base, note and state')
  check((statSync(ledgerFile).mode & 0o777) === 0o600 && readdirSync(home).join(',') === 'worktrees.json', 'the ledger is mode 0600, with no lock or temp file left beside it')
  const firstInode = statSync(ledgerFile).ino

  // start refuses
  run = cli(['start', 'alpha', '--note', 'again'])
  check(run.code === 3 && run.first.includes('the ledger already has alpha'), 'start refuses a name already in the ledger')
  writeFileSync(join(main, 'stray.txt'), 'not committed\n')
  run = cli(['start', 'beta', '--note', 'step22 beta'])
  check(run.code === 3 && run.first.includes('the main checkout has 1 uncommitted file') && !commit('refs/heads/beta') && !existsSync(join(root, 'beta')), 'start refuses while the main checkout has uncommitted files')
  unlinkSync(join(main, 'stray.txt'))
  git(main, 'branch', 'gamma')
  run = cli(['start', 'gamma', '--note', 'step22 gamma'])
  check(run.code === 3 && run.first.includes('branch gamma exists') && !existsSync(join(root, 'gamma')), 'start refuses a branch that exists')
  git(main, 'branch', '-D', 'gamma')
  mkdirSync(join(root, 'delta'))
  run = cli(['start', 'delta', '--note', 'step22 delta'])
  check(run.code === 3 && run.first.includes(`${join(root, 'delta')} exists`) && !commit('refs/heads/delta'), 'start refuses a folder that exists where the worktree would go')
  rmSync(join(root, 'delta'), { recursive: true })
  git(main, 'update-ref', 'refs/agents-git/eta/done', 'refs/heads/main')
  run = cli(['start', 'eta', '--note', 'step22 eta'])
  check(run.code === 3 && run.first.includes('refs/agents-git/eta/done exists') && !commit('refs/heads/eta'), 'start refuses a name whose refs are still kept, so no saved commit is overwritten')
  git(main, 'update-ref', '-d', 'refs/agents-git/eta/done')
  check(cli(['start', '../x', '--note', 'x']).code === 2, 'start refuses a name that is not a plain name, as a usage error')
  run = cli(['start', 'epsilon'])
  check(run.code === 2 && run.first.includes('--note') && !commit('refs/heads/epsilon'), 'start needs an owner note')

  // A start whose npm ci fails takes back what it made, so the name can be used again.
  const lock = readFileSync(join(main, 'package-lock.json'), 'utf8')
  commitFile(main, 'package-lock.json', lock.replace(/("integrity": "sha512-)(.)/, (_, prefix: string, first: string) => `${prefix}${first === 'A' ? 'B' : 'A'}`))
  run = cli(['start', 'broken', '--note', 'step22 broken'])
  check(run.code === 1 && run.first.startsWith('failed: npm ci') && !commit('refs/heads/broken') && !existsSync(join(root, 'broken')) && !entry('broken'), `a start whose npm ci fails leaves no branch, folder or ledger entry (${run.first})`)
  commitFile(main, 'package-lock.json', lock)
  run = cli(['start', 'broken', '--note', 'step22 broken, second try'])
  check(run.code === 0 && entry('broken')?.state === 'active', 'start can run again with the same name once main is fixed')

  // list sees worktrees git has and the ledger doesn't, and adopt brings them in without touching them.
  mkdirSync(elsewhere)
  git(main, 'worktree', 'add', '-q', '-b', 'hand', join(elsewhere, 'hand'), 'main')
  git(main, 'worktree', 'add', '-q', '--detach', join(elsewhere, 'loose'), 'main')
  run = cli(['list'])
  check(run.code === 0 && run.first.includes('2 not in the ledger') && run.out.includes('hand  not in the ledger') && run.out.includes('loose  not in the ledger'), 'list flags worktrees that git has and the ledger does not')
  check(cli(['adopt', main]).first.includes('is the main checkout'), 'adopt refuses the main checkout')
  run = cli(['adopt', elsewhere])
  check(run.code === 3 && run.first.includes('git has no worktree at'), 'adopt refuses a folder that is not a worktree')
  const hand = join(elsewhere, 'hand')
  writeFileSync(join(hand, 'wip.txt'), 'work in progress\n')
  const snapshot = (path: string) => [registered(path), git(path, 'status', '--porcelain=v2', '--branch', '--untracked-files=all'), readFileSync(join(path, '.git'), 'utf8'), git(path, 'stash', 'list')].join('\n')
  const handBefore = snapshot(hand)
  run = cli(['adopt', hand, '--note', 'made by hand'])
  check(run.code === 0 && run.first.startsWith('ok: adopted hand'), `adopt brings a worktree into the ledger (${run.first})`)
  check(snapshot(hand) === handBefore, 'adopt changes nothing in the worktree: branch, HEAD, files, its .git and the lock state')
  const h = entry('hand')
  check(h?.origin === 'adopted' && h.branch === 'hand' && h.base === commit('refs/heads/main') && h.note === 'made by hand' && h.state === 'active', 'the ledger records the adopted worktree with its branch and base')
  check(cli(['adopt', hand]).first.includes('already tracked as hand'), 'adopt refuses a worktree the ledger already tracks')
  run = cli(['adopt', join(elsewhere, 'loose'), '--name', 'loose-one'])
  check(run.code === 0 && entry('loose-one')?.branch === null, 'adopt takes a detached worktree under the name given')
  check(statSync(ledgerFile).ino !== firstInode, 'each write replaces the ledger with a new file, not the same one rewritten')
  unlinkSync(join(hand, 'wip.txt'))

  // list shows each field, and where the ledger and git disagree.
  commitFile(alpha, 'alpha.md', 'alpha work\n')
  writeFileSync(join(alpha, 'draft.md'), 'not committed\n')
  const alphaHead = commit('refs/heads/alpha')
  run = cli(['start', 'gone', '--note', 'step22 gone'])
  rmSync(join(root, 'gone'), { recursive: true })
  const index = git(alpha, 'rev-parse', '--path-format=absolute', '--git-path', 'index')
  const later = new Date(Date.now() + 60_000)
  utimesSync(join(alpha, 'README.md'), later, later)
  const indexBefore = statSync(index).mtimeMs
  run = cli(['list'])
  check(run.code === 0 && run.out.includes([
    'alpha  active  1 commit not in main  1 uncommitted file',
    `  branch alpha  base ${short(localMain)}  head ${short(alphaHead)}`,
    `  path ${alpha}`,
    `  created ${String(a?.createdAt)}  note: step22 alpha`,
  ].join('\n')), 'list shows name, state, commits ahead, uncommitted files, branch, base, head, path, created time and note')
  check(run.out.includes('loose-one  active  no new commits  0 uncommitted files\n  branch (detached)'), 'list shows a detached worktree')
  check(run.out.includes('gone  active  no new commits  no worktree to look in') && run.out.includes('! its folder is gone, and git still lists it'), 'list flags an entry whose folder is gone while git still lists it')
  check(statSync(index).mtimeMs === indexBefore, "list never rewrites the index of a worktree an agent is using")
  git(main, 'worktree', 'prune')
  check(cli(['list']).out.includes('! its folder is gone, and git no longer lists it'), 'list flags an entry git no longer lists at all')

  // done
  const nothingChanged = () => existsSync(alpha) && commit('refs/heads/alpha') === alphaHead && !commit('refs/agents-git/alpha/done')
  run = cli(['done', 'alpha', '--yes'])
  check(run.code === 3 && run.first.includes('1 uncommitted file') && nothingChanged(), 'done refuses a worktree with uncommitted files, and changes nothing')
  check(run.code === 3 && run.first.includes('1 commit not in main') && nothingChanged(), 'done refuses a branch with commits not in main, and changes nothing')
  unlinkSync(join(alpha, 'draft.md'))
  run = cli(['done', 'alpha', '--yes'])
  check(run.code === 3 && run.first === 'refused: done alpha: 1 commit not in main. Nothing changed.' && nothingChanged(), 'a clean worktree whose branch main lacks is still refused, and its branch kept')
  git(main, 'merge', '-q', '--no-ff', 'alpha', '-m', 'merge alpha')
  run = cli(['done', 'alpha'])
  check(run.code === 0 && run.first.startsWith('preview: done alpha would save') && nothingChanged(), 'done without --yes only previews')
  writeFileSync(join(alpha, 'late.md'), 'written after the preview\n')
  run = cli(['done', 'alpha', '--yes'])
  check(run.code === 3 && run.first.includes('1 uncommitted file') && nothingChanged(), 'done --yes checks again instead of trusting the preview')
  unlinkSync(join(alpha, 'late.md'))
  run = cli(['done', 'alpha', '--yes'])
  check(run.code === 0 && run.first.startsWith('ok: alpha is done'), `done --yes finishes a merged, clean worktree (${run.first})`)
  check(commit('refs/agents-git/alpha/done') === alphaHead, "done saves the worktree's last commit as refs/agents-git/alpha/done")
  check(!existsSync(alpha) && !registered(alpha), 'done removes the worktree folder and git forgets it')
  check(commit('refs/heads/alpha') === null, 'done deletes the branch, since main has it')
  const finished = entry('alpha')
  check(finished?.state === 'done' && finished.finalHead === alphaHead && finished.branchDeleted === true && finished.doneAt >= started, 'the ledger marks alpha done, with the time and its final head')
  run = cli(['done', 'alpha', '--yes'])
  check(run.code === 0 && run.first.includes('already done'), 'done on a finished worktree says so and changes nothing')
  git(main, 'worktree', 'lock', '--reason', 'agent at work', hand)
  run = cli(['done', 'hand', '--yes'])
  check(run.code === 3 && run.first.includes('git has it locked (agent at work)') && existsSync(hand) && !commit('refs/agents-git/hand/done'), 'done refuses a worktree git has locked')
  git(main, 'worktree', 'unlock', hand)
  git(hand, 'switch', '-q', '-c', 'hand-two')
  run = cli(['done', 'hand', '--yes'])
  check(run.code === 3 && run.first.includes('it is on branch hand-two, and the ledger says hand') && existsSync(hand), 'done refuses a worktree that moved to another branch')
  git(hand, 'switch', '-q', 'hand')
  git(main, 'branch', '-D', 'hand-two')
  const record = JSON.parse(readFileSync(ledgerFile, 'utf8'))
  const brokenEntry = record.worktrees.find((e: any) => e.name === 'broken')
  const saved = readFileSync(ledgerFile, 'utf8')
  Object.assign(brokenEntry, { state: 'starting', pid: process.pid })
  writeFileSync(ledgerFile, JSON.stringify(record))
  run = cli(['done', 'broken', '--yes'])
  check(run.code === 3 && run.first.includes(`start is still installing its packages as pid ${String(process.pid)}`) && existsSync(join(root, 'broken')), 'done refuses a worktree whose start is still running')
  const gonePid = spawnSync(process.execPath, ['-e', '']).pid
  Object.assign(brokenEntry, { pid: gonePid })
  writeFileSync(ledgerFile, JSON.stringify(record))
  check(cli(['list']).out.includes(`! start stopped before it finished (pid ${String(gonePid)} is gone)`), 'list flags a start that stopped before it finished')
  writeFileSync(ledgerFile, saved)

  // prune
  run = cli(['start', 'beta', '--note', 'step22 beta'])
  const beta = join(root, 'beta')
  commitFile(beta, 'beta.md', 'beta work\n')
  const betaHead = commit('refs/heads/beta')
  run = cli(['start', 'zeta', '--note', 'step22 zeta'])
  const zeta = join(root, 'zeta')
  commitFile(zeta, 'zeta.md', 'zeta work\n')
  git(main, 'merge', '-q', '--no-ff', 'beta', '-m', 'merge beta')
  git(main, 'merge', '-q', '--no-ff', 'zeta', '-m', 'merge zeta')
  git(main, 'worktree', 'lock', '--reason', 'still in use', zeta)
  const goneBranch = commit('refs/heads/gone')
  run = cli(['prune'])
  check(run.code === 0 && run.first === 'preview: prune would finish 2 worktrees' && run.out.includes('  beta  merged and clean') && run.out.includes('  gone  its folder is gone'), 'prune previews merged, clean worktrees and entries whose folder is gone')
  check(run.out.includes('skipped zeta: merged and clean, but git has it locked (still in use)'), 'prune names what it skips and why')
  check(!run.out.includes('broken') && !run.out.includes('loose-one') && !run.out.includes('hand'), 'prune leaves out worktrees with no new commits, which may have just started')
  check(existsSync(beta) && commit('refs/heads/beta') === betaHead && commit('refs/heads/gone') === goneBranch, 'prune without --yes changes nothing')
  run = cli(['prune', '--yes'])
  check(run.code === 0 && run.first === 'ok: prune finished 2 of 2 worktrees', `prune --yes runs done on each (${run.first})`)
  check(!existsSync(beta) && commit('refs/heads/beta') === null && commit('refs/agents-git/beta/done') === betaHead && entry('beta')?.state === 'done', 'prune finished beta: saved, removed, branch deleted, marked done')
  check(commit('refs/heads/gone') === null && commit('refs/agents-git/gone/done') === goneBranch && entry('gone')?.state === 'done', 'prune finished gone from its branch, since its folder was already gone')
  check(existsSync(zeta) && entry('zeta')?.state === 'active' && existsSync(join(root, 'broken')) && entry('broken')?.state === 'active' && existsSync(hand), 'prune leaves the locked worktree and the ones with no new commits alone')
  git(main, 'worktree', 'unlock', zeta)

  // The lock
  const lockFile = `${ledgerFile}.lock`
  writeFileSync(lockFile, JSON.stringify({ pid: gonePid, command: 'step22, long gone', since: new Date().toISOString() }))
  run = cli(['list'])
  check(run.code === 0 && !existsSync(lockFile), 'a lock left by a process that is gone is cleared, and the command runs')
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, command: 'step22, holding it', since: new Date().toISOString() }))
  const waiting = spawn(process.execPath, [CLI, 'done', 'zeta', '--yes'], { cwd: main, env })
  let stderr = ''
  waiting.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const exited = new Promise<number | null>((resolve) => waiting.on('exit', resolve))
  const deadline = Date.now() + LOCK_WAIT_LIMIT_MS
  while (!stderr.includes('waiting for') && Date.now() < deadline && waiting.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 50))
  check(stderr.includes(`held by pid ${String(process.pid)} (step22, holding it)`) && existsSync(zeta), 'a command waits while a live process holds the lock, and says who holds it')
  unlinkSync(lockFile)
  const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('still waiting'), LOCK_WAIT_LIMIT_MS))])
  check(code === 0 && !existsSync(zeta) && entry('zeta')?.state === 'done', 'once the lock is free, the waiting command goes ahead')

  // A ledger it can't parse stops every command.
  const good = readFileSync(ledgerFile, 'utf8')
  writeFileSync(ledgerFile, good.replace('"state": "active"', '"state": "archived"'))
  run = cli(['list'])
  check(run.code === 1 && run.first.startsWith(`failed: ${ledgerFile} is not a ledger agents-git can read`), 'a ledger that does not parse stops the command')
  writeFileSync(ledgerFile, good)

  check(fingerprint(realLedger) === realBefore, `the real ledger at ${realLedger} was not touched`)
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
}

if (!failures.length) rmSync(tmp, { recursive: true, force: true })
console.log(`\n${failures.length ? `${String(failures.length)} failed (repo kept in ${tmp})` : 'all passed (temp repo removed)'}`)
process.exit(failures.length ? 1 : 0)
