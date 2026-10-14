// agents-git, run against a repo this check builds in a temp folder, never the real
// one. It drives every command the way agents and the coordinator would: start,
// list, adopt, done and prune for worktrees, save and sync for work, check for
// steps, and submit and land for pull requests and main. After each it reads git's
// refs, the folders, the ledger, and what the fakes were asked to do.
// - AGENTS_GIT_LEDGER puts the ledger, the run lock and the logs in the temp folder.
//   Only this check sets it, so nothing under ~/.agents-app is read or written, and
//   the check confirms at the end that the real ledger was not touched.
// - npm ci runs for real. The repo's one dependency is a tarball committed beside
//   its lockfile, so it installs offline from a cache in the temp folder.
// - GitHub is a bare repo in the temp folder named origin. gh is test/fake-gh.ts and
//   docker is test/fake-docker.ts, both first on the PATH, so nothing reaches
//   GitHub or the Mac's Docker.
// Uses no ports and no database.
//   node test/step22.ts

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const CLI = join(ROOT, 'daemon/agents-git/main.ts')
// One command, npm ci and land's suite included, takes seconds here. A minute means it hangs.
const CLI_TIMEOUT_MS = 60_000
// How long a command may take to say it is waiting for a lock, or to finish once freed.
const WAIT_LIMIT_MS = 20_000
const POLL_MS = 50

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'agents-git-')))
const main = join(tmp, 'agents')
const root = `${main}-worktrees`
const elsewhere = join(tmp, 'elsewhere')
const home = join(tmp, 'home')
const ledgerFile = join(home, 'worktrees.json')
const runLock = join(home, 'checks', 'run.lock')
const logs = join(home, 'checks', 'agents-git')
const hookRan = join(tmp, 'hook-ran')
const github = join(tmp, 'github.git')
const ghState = join(tmp, 'gh.json')
const dockerLog = join(tmp, 'docker.log')
const realLedger = join(homedir(), '.agents-app', 'worktrees.json')
const bin = join(tmp, 'bin')
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH ?? ''}`,
  AGENTS_GIT_LEDGER: ledgerFile,
  GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  npm_config_cache: join(tmp, 'npm-cache'),
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
  AGENTS_FAKE_GH_STATE: ghState,
  AGENTS_FAKE_DOCKER_LOG: dockerLog,
  STEP22_RUN_LOCK: runLock,
}

const failures: string[] = []
function check(ok: unknown, label: string) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

function cli(args: string[], extra: Record<string, string> = {}, cwd = main) {
  const ran = spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: CLI_TIMEOUT_MS })
  return { code: ran.status, out: ran.stdout, first: ran.stdout.split('\n')[0] ?? '', last: ran.stdout.trimEnd().split('\n').at(-1) ?? '' }
}

// The check's own git runs no hooks, so only agents-git could have run the one below.
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8' }).trim()
}
const commit = (ref: string, cwd = main) => {
  const ran = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, env, encoding: 'utf8' })
  return ran.status === 0 ? ran.stdout.trim() : null
}
const isAncestor = (a: string, b: string, cwd = main) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd, env }).status === 0
const short = (sha: string | null) => (sha ?? 'none').slice(0, 7)
const ledger = (): any => JSON.parse(readFileSync(ledgerFile, 'utf8'))
const entry = (name: string): any => ledger().worktrees.find((e: any) => e.name === name)
const registered = (path: string) => git(main, 'worktree', 'list', '--porcelain').split('\n\n').find((block) => block.startsWith(`worktree ${path}\n`))
const fingerprint = (file: string) => (existsSync(file) ? `${createHash('sha256').update(readFileSync(file)).digest('hex')} ${String(statSync(file).mtimeMs)}` : 'absent')
const commitFile = (cwd: string, file: string, text: string) => {
  mkdirSync(join(cwd, file, '..'), { recursive: true })
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-qm', `add ${file}`)
}
const gh = (): { pulls: any[], calls: string[][] } => (existsSync(ghState) ? JSON.parse(readFileSync(ghState, 'utf8')) : { pulls: [], calls: [] })
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function until(condition: () => boolean): Promise<boolean> {
  const deadline = Date.now() + WAIT_LIMIT_MS
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  return condition()
}
function launch(args: string[], extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: main, env: { ...env, ...extra } })
  const seen = { stderr: '' }
  child.stderr.on('data', (chunk: Buffer) => { seen.stderr += chunk.toString() })
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
  return { child, seen, exited: () => Promise.race([exited, new Promise<'still running'>((resolve) => setTimeout(() => resolve('still running'), WAIT_LIMIT_MS))]) }
}
const launcher = (name: string, script: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`)
  chmodSync(join(bin, name), 0o755)
}

// Steps of the temp repo. step1 reports what it can see, and hangs with a child when
// asked to. step2 fails while red.md exists. step3 calls docker when asked to.
const STEP1 = `import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
const seen = [
  [process.env.STEP22_FROM_ENV === 'yes' && process.env.STEP22_FROM_ENV_TEST === 'yes', 'env from .env and .env.test'],
  [existsSync(process.env.STEP22_RUN_LOCK ?? ''), 'the run lock is held'],
  [true, 'three'],
]
for (const [ok, label] of seen) console.log((ok ? 'pass' : 'FAIL') + '  ' + label)
if (process.env.STEP22_HANG) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  writeFileSync(process.env.STEP22_PIDS ?? '', process.pid + ' ' + child.pid)
  setInterval(() => {}, 1000)
} else if (seen.some(([ok]) => !ok)) process.exit(1)
`
const STEP2 = `import { existsSync } from 'node:fs'
const red = existsSync('red.md')
console.log((red ? 'FAIL' : 'pass') + '  no red.md in the repo')
process.exit(red ? 1 : 0)
`
const STEP3 = `import { spawnSync } from 'node:child_process'
if (process.env.STEP22_DOCKER) {
  const build = spawnSync('docker', ['build', '-t', 'step22-image', '.'], { encoding: 'utf8' })
  process.stderr.write(build.stderr)
  console.log((build.status === 0 ? 'pass' : 'FAIL') + '  docker build')
  const tag = spawnSync('docker', ['tag', 'step22-image', 'agents-box:latest'], { encoding: 'utf8' })
  console.log((tag.status !== 0 && tag.stderr.includes('agents-box:latest') ? 'pass' : 'FAIL') + '  tagging the live image is refused')
  process.exit(build.status === 0 && tag.status !== 0 ? 0 : 1)
}
console.log('pass  no docker asked for')
`

const realBefore = fingerprint(realLedger)
const started = new Date().toISOString()
try {
  // A repo with one dependency that installs offline, a copy of this repo's policy,
  // name guard and suite runner, three steps, and GitHub as a bare repo whose
  // history starts from its own copy of the first commit, as the real one does.
  writeFileSync(join(tmp, 'gitconfig'), '[user]\n\tname = step22\n\temail = step22@example.com\n')
  mkdirSync(bin)
  launcher('gh', join(ROOT, 'test/fake-gh.ts'))
  launcher('docker', join(ROOT, 'test/fake-docker.ts'))
  mkdirSync(join(tmp, 'tiny'))
  writeFileSync(join(tmp, 'tiny', 'package.json'), '{ "name": "tiny", "version": "1.0.0" }\n')
  writeFileSync(join(tmp, 'tiny', 'index.js'), 'export const tiny = 1\n')
  mkdirSync(main)
  git(main, 'init', '-q', '-b', 'main')
  execFileSync('npm', ['pack', '--silent', '--pack-destination', main], { cwd: join(tmp, 'tiny'), env })
  writeFileSync(join(main, 'package.json'), `${JSON.stringify({ name: 'step22', private: true, type: 'module', scripts: { check: 'node test/names.ts && node test/all.ts' }, dependencies: { tiny: 'file:tiny-1.0.0.tgz' } }, null, 2)}\n`)
  execFileSync('npm', ['install', '--package-lock-only'], { cwd: main, env })
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n.env\n.env.test\n')
  writeFileSync(join(main, 'README.md'), 'step22\n')
  for (const [file, text] of [['docs/build-log.md', '# Build log\n'], ['docs/what-each-part-does.md', '# What each part does\n'], ['docs/data-model.md', '# Data model\n'], ['server/migrations/0001_start.sql', '-- the first migration\n'], ['test/step1.ts', STEP1], ['test/step2.ts', STEP2], ['test/step3.ts', STEP3]] as const) {
    mkdirSync(join(main, file, '..'), { recursive: true })
    writeFileSync(join(main, file), text)
  }
  for (const file of ['ops/policies/agents.json', 'test/names.ts', 'test/all.ts']) {
    mkdirSync(join(main, file, '..'), { recursive: true })
    copyFileSync(join(ROOT, file), join(main, file))
  }
  writeFileSync(join(main, '.env'), 'STEP22_FROM_ENV=yes\n')
  writeFileSync(join(main, '.env.test'), 'STEP22_FROM_ENV_TEST=yes\n')
  git(main, 'add', '-A')
  git(main, 'commit', '-qm', 'start')
  const localRoot = commit('refs/heads/main') ?? ''
  git(tmp, 'init', '-q', '--bare', '-b', 'main', github)
  const githubRoot = execFileSync('git', ['commit-tree', `${localRoot}^{tree}`, '-m', 'start, on GitHub'], {
    cwd: main, encoding: 'utf8',
    env: { ...env, GIT_AUTHOR_NAME: 'step22', GIT_AUTHOR_EMAIL: 'step22@users.noreply.github.com', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_NAME: 'step22', GIT_COMMITTER_EMAIL: 'step22@users.noreply.github.com', GIT_COMMITTER_DATE: '1700000000 +0000' },
  }).trim()
  git(main, 'remote', 'add', 'origin', github)
  git(main, 'push', '-q', 'origin', `${githubRoot}:refs/heads/main`)
  git(main, 'fetch', '-q', 'origin')
  for (const [ref, sha] of [['local-root', localRoot], ['github-root', githubRoot], ['local-pushed', localRoot], ['github-pushed', githubRoot]] as const) git(main, 'update-ref', `refs/mirror/${ref}`, sha)
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
  check(existsSync(join(alpha, 'node_modules', 'tiny', 'package.json')) && lstatSync(join(alpha, 'node_modules')).isDirectory(), 'start runs npm ci in the worktree, into a node_modules of its own')
  check(!existsSync(hookRan), 'start runs no hook from the repo')
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
  // submit pushes a name to GitHub as a branch of that name, so main can't be one.
  const mainBeforeNames = commit('refs/heads/main')
  run = cli(['start', 'main', '--note', 'step22 main'])
  check(run.code === 2 && run.first.includes("a name can't be main or HEAD") && !existsSync(join(root, 'main')) && commit('refs/heads/main') === mainBeforeNames, 'start refuses the name main, as a usage error')
  git(main, 'worktree', 'add', '-q', '-b', 'trunk', join(elsewhere, 'trunk'), 'main')
  run = cli(['adopt', join(elsewhere, 'trunk'), '--name', 'main'])
  check(run.code === 2 && run.first.includes("a name can't be main or HEAD") && !entry('main'), 'adopt refuses to track a worktree as main, which submit would push to GitHub as main')
  git(main, 'worktree', 'remove', join(elsewhere, 'trunk'))
  git(main, 'branch', '-D', 'trunk')
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
  check(statSync(index).mtimeMs === indexBefore, 'list never rewrites the index of a worktree an agent is using')
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

  // The ledger's lock
  const lockFile = `${ledgerFile}.lock`
  writeFileSync(lockFile, JSON.stringify({ pid: gonePid, command: 'step22, long gone', since: new Date().toISOString() }))
  run = cli(['list'])
  check(run.code === 0 && !existsSync(lockFile), 'a lock left by a process that is gone is cleared, and the command runs')
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, command: 'step22, holding it', since: new Date().toISOString() }))
  const waiting = launch(['done', 'zeta', '--yes'])
  await until(() => waiting.seen.stderr.includes('waiting for') || waiting.child.exitCode !== null)
  check(waiting.seen.stderr.includes(`held by pid ${String(process.pid)} (step22, holding it)`) && existsSync(zeta), 'a command waits while a live process holds the lock, and says who holds it')
  unlinkSync(lockFile)
  check(await waiting.exited() === 0 && !existsSync(zeta) && entry('zeta')?.state === 'done', 'once the lock is free, the waiting command goes ahead')

  // A ledger it can't parse stops every command.
  const good = readFileSync(ledgerFile, 'utf8')
  writeFileSync(ledgerFile, good.replace('"state": "active"', '"state": "archived"'))
  run = cli(['list'])
  check(run.code === 1 && run.first.startsWith(`failed: ${ledgerFile} is not a ledger agents-git can read`), 'a ledger that does not parse stops the command')
  writeFileSync(ledgerFile, good)

  // save
  cli(['start', 'kappa', '--note', 'step22 kappa'])
  const kappa = join(root, 'kappa')
  const kappaHead = commit('refs/heads/kappa')
  writeFileSync(join(kappa, 'wip.md'), 'unsaved work\n')
  writeFileSync(join(kappa, 'README.md'), 'step22, edited\n')
  const kappaIndex = git(kappa, 'rev-parse', '--path-format=absolute', '--git-path', 'index')
  // The check's own status must not rewrite the index it compares.
  const look = () => [execFileSync('git', ['status', '--porcelain=v2', '--untracked-files=all'], { cwd: kappa, env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8' }), fingerprint(kappaIndex)].join('\n')
  const kappaBefore = look()
  run = cli(['save', 'kappa'])
  const saves = () => git(main, 'for-each-ref', '--format=%(refname)', 'refs/agents-git/kappa/save-*').split('\n').filter((ref) => ref !== '')
  const firstSave = saves()[0] ?? ''
  check(run.code === 0 && saves().length === 1 && firstSave.startsWith('refs/agents-git/kappa/save-'), `save keeps the uncommitted work in a ref of its own (${run.first})`)
  check(git(main, 'show', `${firstSave}:wip.md`) === 'unsaved work' && git(main, 'show', `${firstSave}:README.md`) === 'step22, edited', 'the save holds both the untracked file and the changed one')
  check(commit('refs/heads/kappa') === kappaHead && look() === kappaBefore, 'save moves no branch and leaves the files and the index as they were')
  run = cli(['save', 'kappa'])
  check(run.code === 0 && run.first.includes('already holds') && saves().length === 1, 'saving the same work twice keeps one save')
  writeFileSync(join(kappa, 'later.md'), 'written after the save\n')
  run = cli(['done', 'kappa', '--yes'])
  check(run.code === 3 && run.first.includes('3 uncommitted files that no save holds') && existsSync(kappa), 'done refuses uncommitted work that the newest save does not hold')
  cli(['save', 'kappa'])
  const newestSave = saves().at(-1) ?? ''
  run = cli(['done', 'kappa', '--yes'])
  check(run.code === 0 && !existsSync(kappa) && saves().length === 2, `done takes a worktree whose uncommitted work the newest save holds (${run.first})`)
  check(git(main, 'show', `${newestSave}:later.md`) === 'written after the save', 'and the saved work outlives the worktree')

  // sync
  cli(['start', 'lambda', '--note', 'step22 lambda'])
  const lambda = join(root, 'lambda')
  commitFile(lambda, 'server/lambda.ts', "export const greeting = () => 'hello from lambda'\n")
  commitFile(lambda, 'test/step4.ts', "import { greeting } from '../server/lambda.ts'\nconst ok = greeting() === 'hello from lambda'\nconsole.log((ok ? 'pass' : 'FAIL') + '  lambda greets')\nprocess.exit(ok ? 0 : 1)\n")
  commitFile(lambda, 'docs/what-each-part-does.md', '# What each part does\n\n## Lambda (`server/lambda.ts`, `test/step4.ts`)\n\nIt greets, and step4 checks the greeting.\n')
  commitFile(lambda, 'docs/build-log.md', '# Build log\n\n## Lambda\n\nAdded a greeting and its check.\n')
  commitFile(main, 'main-moved.md', 'main moved on\n')
  const movedMain = commit('refs/heads/main') ?? ''
  writeFileSync(join(lambda, 'dirty.md'), 'not committed\n')
  run = cli(['sync', 'lambda'])
  check(run.code === 3 && run.first.includes('1 uncommitted file'), 'sync refuses a worktree with uncommitted files')
  unlinkSync(join(lambda, 'dirty.md'))
  run = cli(['sync', 'lambda'])
  check(run.code === 0 && isAncestor(movedMain, 'refs/heads/lambda') && git(main, 'show', 'refs/heads/lambda:server/lambda.ts').includes('hello') && entry('lambda').base === movedMain, `sync rebases the branch onto local main and records the new base (${run.first})`)
  commitFile(lambda, 'README.md', 'lambda says\n')
  commitFile(main, 'README.md', 'main says\n')
  const beforeConflict = commit('refs/heads/lambda')
  run = cli(['sync', 'lambda'])
  check(run.code === 1 && run.first.includes('conflict in README.md') && entry('lambda').base === movedMain, `sync stops on a conflict, names the file, and keeps the old base (${run.first})`)
  check(existsSync(git(lambda, 'rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge')) && commit('refs/heads/lambda') === beforeConflict, 'and leaves the worktree as git left it, part way through the rebase')
  run = cli(['sync', 'lambda'])
  check(run.code === 3 && run.first.includes('part way through a rebase'), 'sync refuses a worktree part way through a rebase')
  git(lambda, 'rebase', '--abort')
  git(lambda, 'reset', '-q', '--hard', 'HEAD~1')
  run = cli(['sync', 'lambda'])
  check(run.code === 0 && entry('lambda').base === commit('refs/heads/main'), 'sync goes through once the conflict is gone')

  // check
  const lambdaHead = commit('refs/heads/lambda')
  run = cli(['check', 'lambda', '1', '2', '4'])
  check(run.code === 0 && run.first === `ok: lambda passed 3 steps at ${short(lambdaHead)}`, `check runs the named steps and says they passed (${run.first})`)
  const runs = entry('lambda').checks
  const one = runs.find((r: any) => r.step === '1')
  check(runs.length === 3 && one?.passed === 3 && one.failed === 0 && one.result === 'pass' && one.head === lambdaHead && existsSync(one.log) && one.log.startsWith(join(logs, 'lambda')), "check records each step's counts, its commit and its log in the ledger")
  const stepLog = one ? readFileSync(one.log, 'utf8') : ''
  check(stepLog.includes("pass  env from .env and .env.test") && !existsSync(join(lambda, '.env')) && !existsSync(join(lambda, '.env.test')), "a step gets main's .env and .env.test, and the worktree holds neither")
  check(stepLog.includes('pass  the run lock is held') && !existsSync(runLock), 'a step runs while check holds the run lock, and check lets go of it after')
  writeFileSync(join(lambda, 'dirty.md'), 'not committed\n')
  run = cli(['check', 'lambda', '1'])
  check(run.code === 3 && run.first.includes('1 uncommitted file'), 'check refuses a worktree with uncommitted files, since a result must belong to a commit')
  unlinkSync(join(lambda, 'dirty.md'))
  run = cli(['check', 'lambda', '9'])
  check(run.code === 3 && run.first.includes('there is no test/step9.ts'), 'check refuses a step that does not exist')
  renameSync(join(lambda, 'node_modules'), join(tmp, 'lambda-modules'))
  symlinkSync(join(tmp, 'lambda-modules'), join(lambda, 'node_modules'))
  run = cli(['check', 'lambda', '1'])
  check(run.code === 3 && run.first.includes('node_modules is a link to another copy') && cli(['list']).out.includes(`! node_modules links to ${join(tmp, 'lambda-modules')}`), "check refuses, and list flags, a worktree whose node_modules links to another copy")
  unlinkSync(join(lambda, 'node_modules'))
  renameSync(join(tmp, 'lambda-modules'), join(lambda, 'node_modules'))
  const pids = join(tmp, 'step1.pids')
  run = cli(['check', 'lambda', '1', '--limit', '1'], { STEP22_HANG: '1', STEP22_PIDS: pids })
  const hung = readFileSync(pids, 'utf8').split(' ').map(Number)
  check(run.code === 1 && run.out.includes('step1  ran past 1s and was stopped') && entry('lambda').checks.at(-1)?.result === 'timeout', 'check stops a step that runs past its limit, and records the timeout')
  check(await until(() => hung.every((pid) => !alive(pid))) && hung.length === 2, 'and stops everything the step started, not only the step')
  unlinkSync(pids)
  mkdirSync(runLock, { recursive: true })
  const queued = launch(['check', 'lambda', '1'])
  await until(() => queued.seen.stderr.includes('waiting for') || queued.child.exitCode !== null)
  const recorded: number = entry('lambda').checks.length
  check(queued.seen.stderr.includes(`waiting for ${runLock}`) && queued.child.exitCode === null, 'check waits while another check holds the run lock')
  rmdirSync(runLock)
  check(await queued.exited() === 0 && entry('lambda').checks.length === recorded + 1, 'and runs once the run lock is free')
  const stopped = launch(['check', 'lambda', '1'], { STEP22_HANG: '1', STEP22_PIDS: pids })
  await until(() => existsSync(pids))
  const running = readFileSync(pids, 'utf8').split(' ').map(Number)
  stopped.child.kill('SIGTERM')
  check(await stopped.exited() !== 'still running' && !existsSync(runLock) && await until(() => running.every((pid) => !alive(pid))), 'a check stopped by a signal lets go of the run lock and stops its step')
  chmodSync(join(logs, 'lambda'), 0o500)
  run = cli(['check', 'lambda', '1'])
  chmodSync(join(logs, 'lambda'), 0o700)
  check(run.code === 1 && run.first.startsWith('failed:') && !existsSync(runLock), 'a check that fails part way lets go of the run lock')
  run = cli(['check', 'lambda', '3'], { STEP22_DOCKER: '1' })
  const dockerCalls = readFileSync(dockerLog, 'utf8')
  check(run.code === 0 && dockerCalls.includes('build -t step22-image .') && !dockerCalls.includes('agents-box'), `check passes docker builds through and refuses to tag agents-box:latest (${run.first})`)
  check(dockerCalls.includes('image prune -f') && run.out.includes('pruned the untagged images its docker build left'), 'check runs docker image prune -f after a step that built an image')
  run = cli(['check', 'lambda', '3', '--build-limit', '1'], { STEP22_DOCKER: '1', AGENTS_FAKE_DOCKER_HANG: '1' })
  const buildLog = entry('lambda').checks.at(-1)?.log
  check(run.code === 1 && buildLog && readFileSync(buildLog, 'utf8').includes('docker build ran past 1 seconds, so it was stopped'), 'check stops a docker build that runs past its limit')

  // submit refuses what breaks the rules, by where it is and what it is, never by its value.
  cli(['start', 'mu', '--note', 'step22 mu'])
  const mu = join(root, 'mu')
  const token = ['gh', 'p_', 'a'.repeat(36)].join('')
  commitFile(mu, 'notes.md', `token ${token}\n`)
  commitFile(mu, 'home.md', `see ${homedir()}/notes\n`)
  commitFile(mu, 'name.md', `the old ${['grokb', 'ot'].join('')}\n`)
  git(mu, 'commit', '-q', '--allow-empty', '-m', 'notes for step22@example.com')
  commitFile(mu, '.gitignore', 'node_modules/\n.env\n.env.test\nextra/\n')
  const pkg = JSON.parse(readFileSync(join(mu, 'package.json'), 'utf8'))
  commitFile(mu, 'package.json', `${JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, 'check:step9': 'node test/step9.ts' } }, null, 2)}\n`)
  // A diff prints a line that reads "++ x" as "+++ x", which looks like a file header.
  commitFile(mu, 'plus.md', `++ ${token}\n`)
  commitFile(mu, 'blind.md', `++ /dev/null\ntoken ${token}\n`)
  // Neither version ends with a newline, so git marks the removed line and the added one.
  commitFile(mu, 'nonl.md', `token ${token}`)
  commitFile(mu, 'nonl.md', `again ${token}`)
  run = cli(['submit', 'mu', '--message', 'mu work'])
  check(run.code === 3 && run.out.includes('notes.md:1: matches the github secret pattern') && !run.out.includes(token), 'submit refuses a commit that adds a secret, and never prints it')
  check(run.out.includes('plus.md:1: matches the github secret pattern'), 'submit reads a line that starts with "++ " as an added line, and does not drop it as a file header')
  check(run.out.includes('blind.md:2: matches the github secret pattern'), 'a line that reads "++ /dev/null" does not blind submit to the lines after it')
  check(run.out.split('nonl.md:1: matches the github secret pattern').length === 3 && !run.out.includes(token), 'submit reads the added line of a file with no newline at the end, in both commits that write one, and never prints the secret')
  check(run.out.includes(`home.md:1: holds this Mac's home folder`), "submit refuses a commit that names this Mac's home folder")
  check(run.out.includes('its message: holds the email git is configured with here'), 'submit refuses a commit message holding the personal email')
  check(run.out.includes('name.md:1: uses the studied app'), "submit runs main's name guard on each new commit")
  check(run.out.includes('.gitignore changed, and agents never edit .gitignore') && run.out.includes('adds the check script check:step9'), 'submit refuses an edit to .gitignore and a new check script')
  check(!git(main, 'ls-remote', github).includes('refs/heads/mu') && gh().calls.length === 0, 'a refused submit pushes nothing and opens no pull request')

  // The pull request's text and the merge message go public too, so they are scanned the same way.
  cli(['start', 'tau', '--note', 'step22 tau'])
  const tau = join(root, 'tau')
  commitFile(tau, 'tau.md', 'tau work\n')
  commitFile(tau, 'docs/build-log.md', '# Build log\n\n## Tau\n\nAdded tau.\n')
  run = cli(['submit', 'tau', '--message', `Add tau ${token} and the old ${['grokb', 'ot'].join('')}`, '--regression', `drops ${homedir()}/notes`, '--review', 'second model: written up by step22@example.com'])
  check(run.code === 3 && run.out.includes('the pull request message: matches the github secret pattern'), 'submit refuses a pull request message that holds a secret')
  check(run.out.includes('the pull request message: uses the studied app'), "submit runs main's name guard on the pull request message")
  check(run.out.includes(`the regression line: holds this Mac's home folder`), "submit refuses a regression line that names this Mac's home folder")
  check(run.out.includes('review 1: holds the email git is configured with here'), 'submit refuses a review that holds the personal email')
  check(!run.out.includes(token) && !run.out.includes(homedir()) && !run.out.includes('step22@example.com'), 'and it names the kind of each finding, never the value')
  check(!git(main, 'ls-remote', github).includes('refs/heads/tau') && gh().calls.length === 0 && entry('tau').message === null && entry('tau').reviews.length === 0, 'a refused pull request text pushes nothing, opens nothing and is kept nowhere')

  // submit, then land, with every gate in the way once.
  run = cli(['land', 'lambda'])
  check(run.code === 3 && run.first.includes('it was never submitted'), 'land refuses a branch that was never submitted, so its commits were never scanned')
  commitFile(lambda, 'AGENTS.md', '# Rules for step22\n')
  commitFile(lambda, 'server/migrations/0002_lambda.sql', '-- lambda\n')
  run = cli(['submit', 'lambda', '--message', 'Add lambda'])
  check(run.code === 3 && run.out.includes('migrations: docs/data-model.md adds server/migrations/0002_lambda.sql without changing docs/data-model.md'), `submit runs the framework's static gates on the branch (${run.first})`)
  commitFile(lambda, 'docs/data-model.md', '# Data model\n\n## Lambda\n\nA lambda table.\n')
  run = cli(['submit', 'lambda', '--message', 'Add lambda'])
  check(run.code === 3 && run.out.includes("these need Tayler's approval") && run.out.includes('AGENTS.md (protected'), 'submit refuses a protected path until Tayler approves it')
  run = cli(['submit', 'lambda', '--message', 'Add lambda', '--approve', 'AGENTS.md', '--approve', 'server/migrations/0002_lambda.sql'])
  const firstCopy = git(main, 'ls-remote', github, 'refs/heads/lambda').split('\t')[0] ?? ''
  const lambdaTip = commit('refs/heads/lambda') ?? ''
  check(run.code === 0 && firstCopy !== '' && git(github, 'rev-parse', `${firstCopy}^{tree}`) === git(main, 'rev-parse', `${lambdaTip}^{tree}`), `submit pushes a copy of the branch to GitHub with the same tree (${run.first})`)
  check(git(github, 'log', '--format=%ae %ce', `refs/heads/main..${firstCopy}`).split('\n').every((line) => line === '193937077+tayler-id@users.noreply.github.com 193937077+tayler-id@users.noreply.github.com'), "the copies carry GitHub's no-reply email, not the one configured here")
  check(isAncestor(git(github, 'rev-parse', 'refs/heads/main'), firstCopy, github), "the copies sit on GitHub's own history")
  const pulls = gh().pulls
  check(pulls.length === 1 && pulls[0].head === 'lambda' && pulls[0].base === 'main' && pulls[0].title === 'Add lambda' && pulls[0].body.split('\n')[0] === 'Add lambda' && pulls[0].body.includes(`Checks at ${short(lambdaTip)}`), 'submit opens one pull request, its text from the ledger')
  const submitted = entry('lambda')
  check(submitted.submitted?.head === lambdaTip && submitted.submitted.copy === firstCopy && submitted.submitted.pr === pulls[0].url && submitted.approved.join() === 'AGENTS.md,server/migrations/0002_lambda.sql' && submitted.message === 'Add lambda', 'the ledger records what was submitted, its copy, the pull request and the approvals')
  run = cli(['land', 'lambda'])
  check(run.code === 3 && run.first.includes('no review is noted'), 'land refuses until a review is noted')
  run = cli(['submit', 'lambda', '--review', 'second model: no blocking findings', '--regression', 'lambda drops the old greeting'])
  const again = gh()
  check(run.code === 0 && git(main, 'ls-remote', github, 'refs/heads/lambda').startsWith(firstCopy) && again.pulls.length === 1 && again.pulls[0].body.split('\n')[0] === 'Regression: lambda drops the old greeting' && again.pulls[0].body.includes('- second model: no blocking findings'), 'submitting again gives the same copy, and updates the one pull request, its regression first')
  commitFile(main, 'server/migrations/0002_other.sql', '-- landed first\n')
  run = cli(['land', 'lambda'])
  check(run.code === 3 && run.out.includes('server/migrations/0002_lambda.sql sorts before 0002_other.sql'), `land runs the gates again on main as it is now, so a migration number taken since is refused (${run.first})`)
  git(lambda, 'mv', 'server/migrations/0002_lambda.sql', 'server/migrations/0003_lambda.sql')
  git(lambda, 'commit', '-qm', 'renumber the lambda migration')
  run = cli(['land', 'lambda'])
  check(run.code === 3 && run.first.includes('its branch changed after it was submitted'), 'land refuses a branch that changed since it was submitted')
  git(main, 'update-ref', 'refs/mirror/github-pushed', firstCopy)
  run = cli(['submit', 'lambda', '--approve', 'server/migrations/0003_lambda.sql'])
  check(run.code === 1 && run.first.includes("would not match GitHub's history") && git(main, 'ls-remote', github, 'refs/heads/lambda').startsWith(firstCopy), `submit pushes nothing when the copies would not match what GitHub already has (${run.first})`)
  git(main, 'update-ref', 'refs/mirror/github-pushed', githubRoot)
  run = cli(['submit', 'lambda', '--approve', 'server/migrations/0003_lambda.sql'])
  check(run.code === 0 && isAncestor(firstCopy, git(main, 'ls-remote', github, 'refs/heads/lambda').split('\t')[0] ?? '', github), `submit pushes the new commit on top of the copy before, never forced (${run.first})`)
  run = cli(['submit', 'tau', '--message', 'Add tau', '--review', 'second model: fine'])
  check(run.code === 0 && gh().pulls.some((p: any) => p.head === 'tau' && p.title === 'Add tau'), `the same branch submits once its text is clean (${run.first})`)

  cli(['start', 'xi', '--note', 'step22 xi'])
  const xi = join(root, 'xi')
  commitFile(xi, 'server/xi.ts', 'export const xi = 1\n')
  commitFile(xi, 'test/step5.ts', "console.log('pass  always')\n")
  commitFile(xi, 'docs/what-each-part-does.md', '# What each part does\n\n## Xi (`server/xi.ts`, `test/step5.ts`)\n\nA number, and a check that passes whatever the code does.\n')
  commitFile(xi, 'docs/build-log.md', '# Build log\n\n## Xi\n\nAdded xi.\n')
  cli(['submit', 'xi', '--message', 'Add xi', '--review', 'second model: fine'])
  run = cli(['land', 'xi'])
  check(run.code === 3 && run.first.includes("test/step5.ts passes on main's code, so it guards nothing yet") && entry('xi').checks.some((r: any) => r.step === 'main: test/step5.ts' && r.result === 'pass'), "land runs each changed check on main's code, and refuses one that passes there")
  const xiCopy = git(main, 'ls-remote', github, 'refs/heads/xi').split('\t')[0] ?? ''
  git(xi, 'commit', '-q', '--amend', '-m', 'add the xi build log, reworded')
  run = cli(['submit', 'xi'])
  check(run.code === 1 && run.first.includes('nothing was forced') && git(main, 'ls-remote', github, 'refs/heads/xi').startsWith(xiCopy), `submit never forces a push over a copy the branch no longer has (${run.first})`)

  cli(['start', 'omicron', '--note', 'step22 omicron'])
  const omicron = join(root, 'omicron')
  commitFile(omicron, 'red.md', 'This file turns step2 red.\n')
  commitFile(omicron, 'docs/build-log.md', '# Build log\n\n## Omicron\n\nAdded red.md.\n')
  cli(['submit', 'omicron', '--message', 'Add omicron', '--review', 'second model: fine'])
  const mainBeforeRed = commit('refs/heads/main')
  const githubBeforeRed = git(github, 'rev-parse', 'refs/heads/main')
  run = cli(['land', 'omicron'])
  const suiteRun = entry('omicron').checks.find((r: any) => r.step === 'suite')
  check(run.code === 3 && run.first.includes('the suite failed on the merge') && suiteRun?.result === 'fail' && suiteRun.failed === 1, `land runs the full suite on the merge, and refuses a red one (${run.first})`)
  check(commit('refs/heads/main') === mainBeforeRed && git(github, 'rev-parse', 'refs/heads/main') === githubBeforeRed && !existsSync(join(root, '.land-omicron')) && !existsSync(runLock), "a red suite leaves main and GitHub's main alone, removes its worktree and lets go of the run lock")

  writeFileSync(join(main, 'stray.txt'), 'not committed\n')
  run = cli(['land', 'lambda'])
  check(run.code === 3 && run.first.includes('the main checkout has 1 uncommitted file'), 'land refuses while the main checkout, where main fast-forwards, has uncommitted files')
  unlinkSync(join(main, 'stray.txt'))
  const mainBefore = commit('refs/heads/main') ?? ''
  const finalTip = commit('refs/heads/lambda') ?? ''
  const finalCopy = git(main, 'ls-remote', github, 'refs/heads/lambda').split('\t')[0] ?? ''
  // submit scanned the message, but a ledger could hold one it never saw.
  const untampered = readFileSync(ledgerFile, 'utf8')
  const tampered = JSON.parse(untampered)
  tampered.worktrees.find((e: any) => e.name === 'lambda').message = `Add lambda ${token}`
  writeFileSync(ledgerFile, `${JSON.stringify(tampered, null, 2)}\n`)
  run = cli(['land', 'lambda'])
  check(run.code === 3 && run.out.includes('the merge message: matches the github secret pattern') && !run.out.includes(token), 'land refuses a merge message that holds a secret, and never prints it')
  check(commit('refs/heads/main') === mainBefore && !commit('refs/agents-git/lambda/land') && !existsSync(join(root, '.land-lambda')) && !existsSync(runLock), 'and it refuses before it makes a worktree or a merge')
  writeFileSync(ledgerFile, untampered)
  // Git's own lock on a ref stops its move after GitHub took the push, as a crash would.
  const pushedPair = [commit('refs/mirror/local-pushed'), commit('refs/mirror/github-pushed')]
  const refLock = join(main, '.git', 'refs', 'mirror', 'github-pushed.lock')
  writeFileSync(refLock, '')
  run = cli(['land', 'lambda'])
  unlinkSync(refLock)
  check(run.code === 1 && run.first.includes('lambda landed on local main') && run.first.includes('mirroring main to GitHub failed'), `land reports a mirror it could not finish, and says to land again (${run.first})`)
  check(commit('refs/mirror/local-pushed') === pushedPair[0] && commit('refs/mirror/github-pushed') === pushedPair[1], 'a pushed pair that cannot move together does not move at all')
  run = cli(['land', 'lambda'])
  const merge = commit('refs/heads/main') ?? ''
  check(run.code === 0 && run.first.startsWith('ok: landed lambda as'), `land lands a branch that passes every gate (${run.first})`)
  check(git(main, 'rev-parse', `${merge}^1`) === mainBefore && git(main, 'rev-parse', `${merge}^2`) === finalTip, 'main is now a merge commit of the old main and the branch')
  check(git(main, 'log', '-1', '--format=%B', merge).startsWith('Regression: lambda drops the old greeting\n\nAdd lambda'), 'the merge message is the ledger message, its regression line first')
  check(git(main, 'reflog', '-1', '--format=%gs', 'refs/heads/main').includes('Fast-forward') && existsSync(join(main, 'server/lambda.ts')) && git(main, 'status', '--porcelain') === '', 'the merge was made elsewhere, and the main checkout only fast-forwarded to it')
  const landed = entry('lambda')
  const suite = landed.checks.find((r: any) => r.step === 'suite' && r.head === merge)
  const seen = landed.checks.find((r: any) => r.step === 'main: test/step4.ts')
  check(seen?.result === 'fail' && seen.head === mainBefore, "land saw lambda's new check fail on main's code first")
  check(suite?.result === 'pass' && suite.passed === 4 && suite.failed === 0 && readFileSync(suite.log, 'utf8').includes('pass  the run lock is held'), 'the suite passed four steps on the merge, under the run lock')
  const githubMain = git(github, 'rev-parse', 'refs/heads/main')
  check(git(github, 'rev-parse', `${githubMain}^{tree}`) === git(main, 'rev-parse', `${merge}^{tree}`) && isAncestor(finalCopy, githubMain, github), "GitHub's main is a copy of the merge, and the pull request's copy is part of it")
  check(commit('refs/mirror/local-pushed') === merge && commit('refs/mirror/github-pushed') === githubMain && landed.landed?.merge === merge && landed.landed.copy === githubMain, 'the mirror refs and the ledger record the pair that was pushed')
  run = cli(['land', 'lambda'])
  check(run.code === 0 && run.first.includes('already landed'), 'land on a landed branch says so and changes nothing')
  run = cli(['done', 'lambda', '--yes'])
  check(run.code === 0 && commit('refs/heads/lambda') === null, 'done finishes the landed worktree')

  // A push publishes every commit GitHub lacks, so the scan covers all of them, not only the branch's own.
  const logWith = (cwd: string, entry: string) => `${readFileSync(join(cwd, 'docs/build-log.md'), 'utf8')}\n## ${entry}\n\nAdded ${entry.toLowerCase()}.\n`
  cli(['start', 'pi', '--note', 'step22 pi'])
  const pi = join(root, 'pi')
  commitFile(pi, 'pi.md', 'pi work\n')
  commitFile(pi, 'docs/build-log.md', logWith(pi, 'Pi'))
  run = cli(['submit', 'pi', '--message', 'Add pi', '--review', 'second model: fine'])
  check(run.code === 0, `pi submits while GitHub lacks nothing but its own commits (${run.first})`)
  commitFile(main, 'leak.md', `token ${token}\n`)
  cli(['start', 'rho', '--note', 'step22 rho'])
  const rho = join(root, 'rho')
  commitFile(rho, 'rho.md', 'rho work\n')
  commitFile(rho, 'docs/build-log.md', logWith(rho, 'Rho'))
  run = cli(['submit', 'rho', '--message', 'Add rho', '--review', 'second model: fine'])
  check(run.code === 3 && run.out.includes('leak.md:1: matches the github secret pattern') && !run.out.includes(token), "submit scans a commit on main that GitHub lacks, since the push publishes it with the branch, and never prints the secret")
  check(!git(main, 'ls-remote', github).includes('refs/heads/rho'), 'and it pushes nothing')
  const githubBeforePi = git(github, 'rev-parse', 'refs/heads/main')
  const pushedBeforePi = commit('refs/mirror/local-pushed')
  run = cli(['land', 'pi'])
  check(run.code === 1 && run.first.includes('landed on local main') && run.first.includes("GitHub's main was left alone") && run.out.includes('leak.md:1: matches the github secret pattern') && !run.out.includes(token), "land scans every commit GitHub lacks before it mirrors main, and stops on a secret one")
  check(git(github, 'rev-parse', 'refs/heads/main') === githubBeforePi && commit('refs/mirror/local-pushed') === pushedBeforePi && entry('pi').landed?.copy === null, "and GitHub's main and the pushed pair stay as they were, with the branch landed on local main")

  check(fingerprint(realLedger) === realBefore, `the real ledger at ${realLedger} was not touched`)
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
}

if (!failures.length) rmSync(tmp, { recursive: true, force: true })
console.log(`\n${failures.length ? `${String(failures.length)} failed (repo kept in ${tmp})` : 'all passed (temp repo removed)'}`)
process.exit(failures.length ? 1 : 0)
