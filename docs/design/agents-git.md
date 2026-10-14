# agents-git

`agents-git` runs the git side of an agent's work on this repo. Tayler's direction is that the rules an agent follows are scripts and CLIs the agent runs, not prose it promises to follow, so each rule below is a command that does it or refuses. Run it from inside the repo with Node from `~/.local/node/bin`:

```
node daemon/agents-git/main.ts <command>
```

The first line of every result says how it went: `ok:`, `preview:`, `refused:` or `failed:`. The exit code says it too: 0 done, 1 failed and safe to retry, 2 a usage error, 3 refused with nothing changed.

## Commands

| Command | What it does | What it refuses |
|---|---|---|
| `start <name> --note <text>` | Makes branch `<name>` from local `main` and a worktree at `<main checkout>-worktrees/<name>`, runs `npm ci` there, and records it. When `npm ci` fails it takes back the worktree and branch. | A name the ledger has, a name that is `main` or `HEAD`, an existing branch, folder or kept ref, a main checkout with uncommitted files |
| `list` | Every worktree, tracked or not, with branch, base, head, commits main lacks, uncommitted files, created time and note. Flags where the ledger and git disagree, and a `node_modules` that links elsewhere. | |
| `adopt <path>` | Tracks a worktree that exists, without changing it. | The main checkout, a folder git has no worktree at, one already tracked, a name that is `main` or `HEAD` |
| `done <name> [--yes]` | Previews, or saves the head as `refs/agents-git/<name>/done`, removes the worktree, deletes the branch once main has it, and marks the entry done. | Uncommitted files the newest save doesn't hold, commits main lacks, a locked worktree, one on another branch, a start still running |
| `prune [--yes]` | Previews, or runs `done` on each worktree that is merged and clean, or whose folder is gone. Leaves out worktrees with no new commits. | Whatever `done` refuses |
| `save <name>` | Stores the worktree's uncommitted and untracked files as a commit at `refs/agents-git/<name>/save-<time>`, built in a copy of the index, so the branch, the files and the index stay as they are. | |
| `sync <name>` | Rebases the branch onto local `main` and records the new base. On a conflict it stops and names the files, and leaves the worktree as git left it. | Uncommitted files, a rebase or merge already part way through |
| `check <name> <step...>` | Runs each `test/step<step>.ts` under the run lock, as the next section says, and records its counts in the ledger. | Uncommitted files, a linked `node_modules`, a missing step, missing env files |
| `submit <name>` | Scans the new commits and the text of the pull request, which is `--message`, `--regression` and each `--review`. Then copies the commits onto GitHub's history, pushes them as branch `<name>` without force, and opens or updates the pull request. | Anything a gate or scan below finds, a protected path Tayler hasn't approved |
| `land <name>` | Runs every landing gate, merges in a throwaway worktree, runs the full suite there, fast-forwards local `main` and mirrors it to GitHub. Restarts nothing. | A branch never submitted or changed since, no review noted, a gate that fails, a changed check that passes on main, a red suite |

### How check runs a step

- It takes `~/.agents-app/checks/run.lock` with `mkdir`, the lock `AGENTS.md` names, and waits for it up to the longest run the policy allows. A return, a thrown error and SIGINT, SIGTERM or SIGHUP all remove it. Only SIGKILL can't.
- It runs `node --env-file=<main>/.env --env-file=<main>/.env.test test/step<step>.ts` in the worktree. agents-git never reads or copies the env files.
- Each step runs in its own process group, under the policy's limit per check, 900 seconds, or `--limit`. Past it the whole group gets SIGTERM, then SIGKILL 5 seconds later, and whatever the step left running is killed when it ends.
- `daemon/agents-git/docker.ts` is the `docker` every step sees, first on its PATH. It passes each call to the real docker, refuses any build, tag or commit that names `agents-box:latest`, stops a build past 20 minutes or `--build-limit`, and notes each build so check runs `docker image prune -f` after the step.
- The log goes to `~/.agents-app/checks/agents-git/<name>/`, and the ledger gets the step, the commit, its pass and FAIL counts, and whether it passed, failed or ran out of time.

### How land lands

1. It refuses a branch that was never submitted, or that changed since, so every commit it lands was scanned. It refuses until a review is noted with `submit --review`.
2. It runs the coding framework's static gates again on main as it is now, so a migration number another branch took since submit is refused. It scans the merge message, the ledger's message with its regression line first, the way submit scans the pull request's text, since the ledger could hold one submit never saw.
3. Under the run lock it makes a worktree of main at `<main checkout>-worktrees/.land-<name>`, links main's `.env` files into it, runs `npm ci`, and runs each check the branch adds or edits on main's code. One that passes there is refused, since it guards nothing yet.
4. It merges the branch there, with the ledger's message, its regression line first, and keeps the merge at `refs/agents-git/<name>/land`. Then it runs the policy's suite, `npm run check`, under the policy's two hours.
5. Only on green, and only if main and the branch haven't moved, it fast-forwards main. The main checkout is where the live app runs from, so its files move with main, as when the coordinator merged there. Nothing running is restarted.
6. It copies main onto GitHub's history and pushes it without force.

## Where things live

- **Worktrees.** `<main checkout>-worktrees/<name>`, named once in `daemon/agents-git/repo.ts`. For this repo that is `~/Projects/agents-worktrees/<name>`.
- **The ledger.** `~/.agents-app/worktrees.json`, mode 0600, read and written under `worktrees.json.lock`, parsed with zod on every read and replaced whole through a rename. A lock left by a process that has exited is cleared.
- **The run lock and logs.** Beside the ledger, in `~/.agents-app/checks/`.
- **Refs.** Everything kept for a worktree is under `refs/agents-git/<name>/`: `done`, `save-<time>` and `land`. A name is used once.
- **The one seam.** `AGENTS_GIT_LEDGER` moves the ledger, and with it the run lock and logs. Only `test/step22.ts` sets it. The worktree folder follows the main checkout, so the check's temp repo needs no second seam.

## GitHub's history

GitHub never receives this Mac's history before `65e378e`. Its history starts at `28f046c`, a copy of that commit, and every later commit is copied onto it. agents-git ports the coordinator's `.scratch/coord/github-graft.py`.

- **Kept.** The same tree, message and dates for each copy, parents mapped through the copies, the configured email swapped for `193937077+tayler-id@users.noreply.github.com`, and a refusal of commits with a `gpgsig`, `mergetag` or `encoding` header. The same commits always give the same copies, so a commit copied before comes out as the one GitHub has, and a pull request's copy becomes part of GitHub's main when its branch lands.
- **Changed.** The swapped email is the one git is configured with, not a written-in address. `commit-tree` runs with `--no-gpg-sign`, so a signing setting can't change a copy. The root pair lives in refs, and every rebuild checks that `refs/mirror/local-pushed` comes out as `refs/mirror/github-pushed` before anything is pushed.
- **Proven.** On a clone of the real repo, the port rebuilt `f643a30` as `daa820c`, the commit GitHub has, in 4.8 seconds for 226 commits.
- **Set up once,** before the first submit. agents-git has not been run on the real repo, so this has not been done:

```
git update-ref refs/mirror/local-root 65e378ee3218c4ab1d445735f359ba62a27fb6f2
git update-ref refs/mirror/github-root 28f046c81e67f40f8d528547fba2d74098c411bf
```

## The rules in AGENTS.md and what enforces them

From `AGENTS.md` on main at `b2aa8b5`.

| Rule | Enforced by | Left as prose, and why |
|---|---|---|
| A change that takes something away says so in its first line | `submit --regression` puts it first in the pull request, and `land` first in the merge message | Whether a change is a regression is a judgment no command can make |
| Read the standards, decisions and parts doc first | | Reading can't be checked |
| Names: the product is Agents, and no studied or reference names | `submit` runs main's `test/names.ts` on every new commit and its message and on the pull request's text, `land` runs it on the merge message, and land's suite runs it again | |
| Don't restart, edit or install the `com.agents.*` services | `land` restarts nothing, and no command runs `launchctl` | An agent's own shell can, until a hook blocks it |
| Checks use `agents_test` through `.env` then `.env.test` | `check` and `land` run every step with main's two files, in that order, by absolute path | Connecting to the live database another way |
| Don't change Tailscale, or remove Docker things you didn't make, or publish pipelines to the real forge | | No command does these, so there is nothing to refuse |
| Never write a secret to a commit | `submit` checks every new commit's added lines and message, and the pull request's message, regression line and reviews, against the `shared/scrub.ts` patterns, and runs the framework's secrets gate on the diff. `land` checks the merge message. A finding names its kind and where it is, never the value | Postgres, logs and the record are the scrubber's, not agents-git's |
| Describe a schema change in `docs/data-model.md`, and never edit a migration | The framework's migrations gate at `submit` and `land` | |
| Get a migration's number from the coordinator, since numbers follow landing order | `land` runs the gate on main as it is then, so a number taken since submit is refused | |
| Prefix your teams and delete them | | Teams live in the test database, which agents-git doesn't read |
| Take `run.lock` before a check on port 7701 | `check` and `land` take it for every step and the suite, wait with a deadline, and release it on exit, error or signal | A step run without agents-git |
| `npm ci` in your own copy, never a link to main's | `start` runs it, `check` refuses a linked `node_modules`, and `list` flags one | |
| Don't edit `.gitignore` or add check scripts | `submit` and `land` refuse either, with no approval that lets it through | |
| `docker image prune -f` after a build | The docker wrapper notes each build, and `check` and `land` prune after the step | |
| Never build or tag `agents-box:latest` | The docker wrapper refuses it | A build that bypasses the PATH |
| Push only your task branch | `submit` pushes only `<name>`, never forced | A raw `git push`, until the hook drafted in the report blocks it |
| One concern per pull request, 400 changed lines | The framework's size gate at `submit` and `land` | One concern is a reviewer's judgment |
| The hard gates in the framework's table | `submit` and `land` run its own `staticGates` on main's policy, and `land` runs the suite | The verdict and the judges, which need the framework's runner |
| Protected paths go to Tayler | `submit` and `land` refuse until each one is named with `--approve`, and the ledger keeps the approval | That Tayler gave it: the coordinator passes the flag |
| A reviewer on a different model reviews first | `land` refuses until `submit --review` notes one | The reviewer's model, which agents-git can't see |
| A person approves the plan, and Tayler the suite, merge and deploy | | The framework's runner holds these, and the coordinator asks Tayler before `land` |
| Typecheck, lint and the name guard pass | `land` runs the policy's suite, which runs all three | An agent's own runs before it says done |
| Every check you add or change was seen failing | `land` runs each changed check on main's code and refuses one that passes | Breaking the code a check guards, which only the author can do |
| Anything that touches the running system was tried on it | | Only Tayler can allow it |
| Docs say only what was proven | The framework's docs gate needs a build-log entry and a parts entry for each new source file | Whether the docs are true |
| Work on a branch and never merge | `land` does every merge, in its own worktree | A raw `git merge`, until the hook drafted in the report blocks it |
| Writing and UI design rules | The framework's prose and CSS gates on the changed lines, at `submit` and `land` | Lines a change doesn't touch, which `test/style.ts` covers |
| Report when you finish | | A report is written for people |

## Not built

- Ports and a test database of each worktree's own, and env files beyond the links `land` makes.
- The Claude Code hooks, which live under `.claude/` and need Tayler's approval. A draft is in the report.
- A batch reader for the graft. Rebuilding from the root takes about 5 seconds now and grows with history.
- A worktree's branch rebased by `sync` after `submit` can't be pushed again, since `submit` never forces. Submit before syncing, or ask Tayler.
