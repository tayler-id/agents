# Resume note for the work layer

This note lets a fresh agent pick up the work layer without redoing anything. It changes with each commit on the branch, so it describes the branch as it stands.

## Where the work is

- Branch `worktree-agent-a2fc50836aafd8b34`, in the worktree `/Users/taylerramsay/Projects/agents/.claude/worktrees/agent-a2fc50836aafd8b34`. This agent never pushes it or merges it into main. The coordinator merges.
- The branch was rebased onto main at deec329 on 2026-10-13. The rebase dropped the two commits that changed `.gitignore`, and the step 14 check no longer adds an npm script. The commit hashes below are the ones after that rebase. `git log --oneline main..HEAD` lists the branch.
- The design is `docs/design/workflow.md`, rewritten after building to say only what the code does, with a "Not done" list. The schema is `server/migrations/0007_workflow.sql`, described under "Added while building" in `docs/data-model.md`. The coordinator renumbers the migration at merge.
- `node_modules` is this worktree's own copy, from `npm ci`.

## Done

Each part, with the commits that built it and the commits that check it.

- **Draft tasks.** Save a task without starting it, edit it, start it, discard it. Anyone who can see the task can do all four. Server in `server/drafts.ts`, the app in `app/src/Draft.tsx` and the New task form in `app/src/Work.tsx`. Built in c0cb70c, a3b93e9 and c054432. Checked in df5be9b and `test/step14c.ts`.
- **Tasks over several repos.** `task_repos` rows, kept by `server/checkout.ts`. The daemon clones each repo into its own folder (`cloneAll` in `daemon/workspace.ts`), with twin folder names told apart. Built in c0cb70c and 2b2ba57, with the repo picker in c054432.
- **Changes against the base, per repo.** The daemon lists every created, changed and deleted file against the base with a temporary index, scrubs file contents on the machine, and skips sending a file that hasn't changed (`daemon/changes.ts`). The server keeps them in `file_changes` (`server/changes.ts`). Built in 22f5fed. Checked in df5be9b.
- **Viewer and diff.** The Changes list, and a side panel that renders markdown, shows code with line numbers and highlighting, and has a Diff tab against the base. Task folder documents open in the same kind of panel. `app/src/Changes.tsx`, `FilePanel.tsx`, `Code.tsx`, `highlight.ts`. Built in 7f8eadf. Checked in 73cf4a4 (`test/step14b.ts`).
- **Pull requests from a task.** One button asks for a push of each changed repo. The runner's tick opens the pull request through `forge.openPullRequest` and records it in `pushes` (`server/pulls.ts`). Built in 8ab6686 and 7f8eadf. Checked in 7400a53 and 73cf4a4. de8a980 keeps them on the task once nothing differs from the base, a bug step14c found.
- **Writing without asking.** Task sessions change files in their workspace without an approval. Commands still ask unless the session runs in a box. `server/permissions.ts` and the daemon's flags. Built in 29864c4. Checked in 31189f9.
- **Research, plan and implement pipeline.** `pipelines/research-plan-implement.ts`, with typed stages, named gate buttons and comments in the run context (`shared/pipeline.ts`). Built in 443851d, d05bf04 and 32cae16. Checked end to end with the stand-in for Claude in 96880a1. It has never run with real Claude or on a box.
- **Comments pinned to text.** A comment keeps its quote and which match of it it means (403736f). The app marks the quote in place and jumps to it (492f450, `app/src/quotes.ts`). The diff between two versions of a document (038695e, checked in 534b54b).
- **Command palette and shortcuts.** `app/src/Palette.tsx`. Cmd+K on a Mac, Ctrl+K elsewhere, c for a new task and r for a new room outside fields, with a switch to turn single keys off. Built in 3e5ca46.
- **Order of work.** Blocking edges with a reason, typed holds with an optional end date, priority, done and reopen, and the ready query, which agents read through the `ready_tasks` tool. Shapes in `shared/work.ts`, server in `server/order.ts`, app in `app/src/Order.tsx`. Built in 12eb40f, 1173713, 7d59089 and bbe1c48. Checked in efff9c6.
- **A bug found and fixed.** The daemon could claim a message before its workspace's setup and fail. 186efe6.
- **Our own words.** c45aa96 rewrote every place that named a source.

## Checks

Run each from the worktree with `node --env-file=.env --env-file=.env.test test/<file>`, with `~/.local/node/bin` first on the PATH. Set `AGENTS_UI_ENGINES=chromium` to run a browser check in one engine.

- `test/step14.ts`, ports 7960 to 7962. The server and daemon.
- `test/step14b.ts`, ports 7965 to 7967. The README scenario in three browsers, desktop and phone.
- `test/step14c.ts`, ports 7970 to 7972. Drafts, order of work, palette, pinned comments and a run's gate in three browsers, desktop and phone.

After the rebase all three passed: step14 "all passed (test teams and repos removed)", step14b "all passed (test team and repo removed)", step14c "all passed (test team and repos removed)" with 108 checks.

Every check has been seen failing under breaks and passing again after a byte-for-byte restore. The step14 and step14b breaks are listed in the commit messages of df5be9b, 7400a53, 31189f9, 96880a1, 534b54b, efff9c6 and 73cf4a4. step14c was broken in ten Chromium runs with 44 breaks, described in `docs/build-log.md` under "The work layer". Breaking it found two weak checks (30f3611), a race in the check (594e7f6), a bug in the app (de8a980), and a phone test that measured the page before the draft loaded (de4df0c). 3292e82 made its phone test catch sideways scroll inside a page, and added checks for clicking marked text and for focus after the palette closes.

A failed run keeps its team and Gitea repos. Remove them by deleting the team row named in the last line from `agents_test`, and the `flow-ux-<id>` and `flow-uxpipes-<id>` repos from Gitea.

## Latest results

- step14c, all three engines, after it opens each page at its own address: "all passed (test team and repos removed)", 120 checks.
- step14, after de4df0c: "all passed (test teams and repos removed)", 57 checks.
- step14b, all three engines, after de8a980: "all passed (test team and repo removed)", 36 checks. Nothing it covers changed since.
- Main's step2 (18 checks) and step10 (28 checks) on this branch: "all passed (test teams removed)".
- Main's step10b in Chromium on this branch: "all passed (test team removed)", 23 checks.

## In progress

A review on a different model asked for fixes before merging. The branch is rebased onto main at aad82a8, which keeps the machine token out of failed commands' errors. Each fix gets a check seen failing first:

1. Blocking: scrub `pushes.error`, and prove with a forced failing push and a failed clone that `commands.error`, `pushes.error` and the transcript hold no `machine_`.
2. Box sessions ask before commands again until Tayler decides, and the docs say a box also holds the Claude token.
3. A message waits for its workspace only while the server says its setup is queued or running, and otherwise fails with "workspace … is not set up on this machine". Check the missing-folder case.
4. Pushes use `--force-with-lease` against the commit last pushed. The title and description fields hide once a pull request is open. Fix the label in step14.
5. Start a draft without saving when the form is untouched. Save refuses when the draft changed since the form loaded.
6. The changes scan runs a few workspaces at a time, stops at 20,000 files and shows "too many files", treats a NUL byte as binary, and one repo's failure keeps the others.
7. Scrub a pull request's title and body, and stop prefilling the body with the task's instructions.
8. Break the step14 checks that no recorded break covers (change rows, draft edit and discard, the pull request's author), and fix "each changed repo" in the parts doc.
9. Run typecheck, lint, names, and main's step3, 4a to 4d, 6, 6b, 7 (with the lock), 9 and 9b.

Also worth doing: a timeout on forge calls, an expiry for a stuck push, `sendToSession` out of the import cycle, the script name in step14's header, and this note out of `docs/` at landing.

## Next steps

Work through the list above in order, committing each fix with its check, then report as before.

## Open questions for Tayler

- The pipeline needs an agent named `builder` on a box, and boxes need a Claude token. Tayler adds both and publishes the pipeline, since agents never run `ops/publish-pipelines.ts`.
- Anyone who can see a draft can start it, as anyone can answer an ask. Keep that, or limit it to the author?
- A pull request's state is not read back from the forge after it opens.
- Changes show the current state against the base, not a history of turns.
- Single-key shortcuts are on by default, with a switch in the palette.
- A hold's end date lapses by the database's date, which is UTC.

## What a fresh agent must know

- Read `AGENTS.md` first. It holds the rules in force.
- Put `~/.local/node/bin` first on the PATH. Never install through a link to main's `node_modules`.
- Never run `npm run check`. Never touch the live system: the `com.agents.*` launch agents, the real `agents` database, Tailscale, docker volumes and images, `agents-box:latest`, `ops/publish-pipelines.ts`.
- Before a check on port 7701, take the lock with `mkdir ~/.agents-app/checks/run.lock`, and `rmdir` it after. The step 14 checks don't use that port.
- New checks use ports 7960 to 7979, teams named `flow-*` and Gitea repos named `flow-*`.
- The test database `agents_test` already has migration 0007 applied by hand, including the order-of-work block (`task_blocks`, `task_holds`, `tasks.priority`, `tasks.done_at`). Other agents' migrations (0005, 0006, 0008, 0009) are there too. Report failures on tables this branch didn't create rather than work around them.
- Don't edit `eslint.config.js`, `tsconfig*.json`, `test/names.ts`, `test/step0.ts`, `test/all.ts`, `.gitignore`, `AGENTS.md`, `CLAUDE.md`, `pipelines/app-change.ts`, `ops/` or anything in `.claude/`. Don't add check scripts to `package.json`. Never edit a migration that main already has.
- The sandbox refuses a shell command that mixes git with other commands. Run each git command on its own.
- Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Other agents change `server/forge.ts`, `server/tasks.ts` and `app/src/Work.tsx`. This branch leaves `server/forge.ts` alone and uses only `forge.openPullRequest` and the exported `repoPath`. In `server/tasks.ts` it changed `startTask` (repo ids and the draft flag, with the workspace and session setup moved to `server/launch.ts`), the imports, the `permissions` in `sendToSession`'s payload, and `addComment`'s anchor. In `app/src/Work.tsx` it changed the New task form (repo picker, Save draft), the task view (draft branch, order of work, Changes with the pull requests passed in as a function of whether anything changed, documents only under "Made by this task", done in the header), and the imports.
