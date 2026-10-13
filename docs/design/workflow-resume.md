# Resume note for the work layer

This note lets a fresh agent pick up the work layer without redoing anything. It changes with each commit on the branch, so it describes the branch as it stands.

## Where the work is

- Branch `worktree-agent-a2fc50836aafd8b34`, in the worktree `/Users/taylerramsay/Projects/agents/.claude/worktrees/agent-a2fc50836aafd8b34`. It is never pushed or merged into main by this agent. The coordinator merges.
- The design is `docs/design/workflow.md`. The schema is `server/migrations/0007_workflow.sql`, described under "Added while building" in `docs/data-model.md`. The coordinator renumbers the migration at merge.
- The last commit before this note is 7abd3ac. `git log --oneline main..HEAD` lists the branch.

## Done

Each part, with the commits that built it and the commits that check it.

- **Draft tasks.** Save a task without starting it, edit it, start it, discard it. Anyone who can see the task can do all four. Server in `server/drafts.ts`, the app in `app/src/Draft.tsx` and the New task form in `app/src/Work.tsx`. Built in efa606f, 759705a and 178571e. Checked in 6956d87 and `test/step14c.ts`.
- **Tasks over several repos.** `task_repos` rows, kept by `server/checkout.ts`. The daemon clones each repo into its own folder (`cloneAll` in `daemon/workspace.ts`), with twin folder names told apart. Built in efa606f and 973b0c3, with the repo picker in 178571e.
- **Changes against the base, per repo.** The daemon lists every created, changed and deleted file against the base branch with a temporary index, scrubs file contents on the machine, and skips sending when nothing changed (`daemon/changes.ts`). The server keeps them in `file_changes` (`server/changes.ts`). Built in ebbee26. Checked in 6956d87.
- **Viewer and diff.** The Changes list, a side panel that renders markdown, shows code with line numbers and highlighting, and has a Diff tab against the base. Task folder documents open in the same panel. `app/src/Changes.tsx`, `FilePanel.tsx`, `Code.tsx`, `highlight.ts`. Built in 4f2e1cc. Checked in 402224b (`test/step14b.ts`).
- **Pull requests from a task.** One button asks for a push of each changed repo, the runner's tick opens the pull request through `forge.openPullRequest` and records it in `pushes` (`server/pulls.ts`). Built in 6e6258b and 4f2e1cc. Checked in 43eb55b and 402224b.
- **Writing without asking.** Task sessions change files in their workspace without an approval. Commands still ask unless the session runs in a box. `server/permissions.ts` and the daemon's flags. Built in dedc784. Checked in 5a28bbd.
- **Research, plan and implement pipeline.** `pipelines/research-plan-implement.ts`, with typed stages, named gate buttons and comments in the run context (`shared/pipeline.ts`). Built in 79df27e, 00ef180 and 4b84418. Checked end to end with the fake Claude in b7595d0.
- **Comments pinned to text.** A comment keeps its quote and which match of it it means (9fbf4ec). The app marks the quote in place and jumps to it (ff120ef, `app/src/quotes.ts`). The diff between two versions of a document (b36bfbd, checked in 73c2013).
- **Command palette and shortcuts.** `app/src/Palette.tsx`. Cmd+K on a Mac, Ctrl+K elsewhere, c for a new task and r for a new room outside fields, with a switch to turn single keys off. Built in 704f07b.
- **Order of work.** Blocking edges with a reason, typed holds with an optional end date, priority, done and reopen, and the ready query, which agents read through the `ready_tasks` tool. Shapes in `shared/work.ts`, server in `server/order.ts`, app in `app/src/Order.tsx`. Built in 196de54, a8e5b22, 88daf28 and ad111f8. Checked in 9a8c201.
- **Our own words.** 6e509d9 rewrote every place that named a source.

## Checks

Run each from the worktree with `node --env-file=.env --env-file=.env.test test/<file>`. Set `AGENTS_UI_ENGINES=chromium` to run the browser checks in one engine.

- `test/step14.ts`, ports 7960 to 7962. The server and daemon: drafts, several repos, changes, pull requests, order of work, writing without asking, the pipeline end to end, comment anchors, documents.
- `test/step14b.ts`, ports 7965 to 7967. The README scenario in three browsers, desktop and phone.
- `test/step14c.ts`, ports 7970 to 7972. Drafts, order of work, palette, pinned comments and a run's gate in three browsers, desktop and phone.

step14 and step14b have been seen failing under breaks and passing again after a byte-for-byte restore. The breaks are listed in the commit messages of 6956d87, 43eb55b, 5a28bbd, b7595d0, 73c2013, 9a8c201 and 402224b. step14c passes in all three engines but has not been seen failing yet.

## In progress

Breaking step14c to see each check fail. The plan, each group in one Chromium run, restoring with `git checkout -- <file>` after each:

1. Remove the draft marker in the sidebar (`app/src/App.tsx`), hide an edge's reason (`Order.tsx`), drop `typingIn(event.target)` from the shortcut guard (`Palette.tsx`), store occurrence 0 for every quote (`Document.tsx`), ignore gate labels (`Asks.tsx`), and unlabel the hold's date field (`Order.tsx`).
2. Hide the Held list (`Order.tsx`), ignore the single-key switch (`Palette.tsx`), skip the darker mark on the clicked quote and the "is not in version" note (`Document.tsx`), widen the palette past a phone (`styles.css`), and remove Changes from the run page (`Run.tsx`).
3. Make Cmd+K answer another key (`Palette.tsx`).
4. Make Save draft start the task (`Work.tsx`).

Each break should turn its own check red and nothing else. A failed run keeps its team and Gitea repos. Remove them by deleting the team row named in the last line from `agents_test` and the two `flow-ux-<id>` and `flow-uxpipes-<id>` repos from Gitea.

## Next steps

1. Finish the step14c breaks above, restore, run step14c in all three engines, and amend nothing. Record the breaks in a commit message or the build log.
2. Bring `docs/design/workflow.md` up to date with what changed while building. The edit route is `POST /v1/tasks/:id/edit`, `file_changes` keeps a `preview` column, the shapes live in `shared/work.ts`, `task_repos`, `task_blocks`, `task_holds` and `documents` are shapes, the version diff is `GET /v1/artifacts/:id/versions/:n/diff`, a claimed message waits for its workspace's setup, a quote that is gone says so, and the task lifecycle is one transition table.
3. Add entries to `docs/what-each-part-does.md` in the "Solves now / Helps later" form for each new part listed under Done.
4. Add a section to `docs/build-log.md`: what was built, how it was checked, the breaks, the bug found (the daemon claimed a message before its workspace was set up, fixed in ed9fae5), and decisions to revisit.
5. Run `npm run typecheck`, `npm run lint`, the name guard (`test/names.ts`), step14, step14b and step14c in three engines. Paste their final lines into the report.
6. Report to the coordinator.

## Open questions for Tayler

- The pipeline needs an agent named `builder` on a box, and boxes need a Claude token. Tayler adds both and publishes the pipeline himself, since agents never run `ops/publish-pipelines.ts`.
- Anyone who can see a draft can start it, as anyone can answer an ask. Keep that, or limit it to the author?
- A pull request's state is not read back from the forge after it opens.
- Changes show the current state against the base, not a history of turns.
- Single-key shortcuts are on by default, with a switch in the palette.
- A hold's end date lapses on the server's date, in UTC.

## What a fresh agent must know

- Put `~/.local/node/bin` first on the PATH. `node_modules` is a symlink to `~/Projects/agents/node_modules`, so never run `npm install` or `npm ci` here.
- Never run `npm run check`. Never touch the live system: the `com.agents.*` launch agents, the real `agents` database, Tailscale, docker volumes and images, `agents-box:latest`, `ops/publish-pipelines.ts`.
- Before running a check that main already had, take the lock with `mkdir ~/.agents-app/checks/run.lock`, wait and retry for up to 30 minutes, and always `rmdir` it after. The step 14 checks do not need it.
- New checks use ports 7960 to 7979, teams named `flow-*` and Gitea repos named `flow-*`.
- The test database `agents_test` already has migration 0007 applied by hand, including the order-of-work block (`task_blocks`, `task_holds`, `tasks.priority`, `tasks.done_at`). Other agents' migrations (0005, 0006, 0008, 0009) are there too. Report failures on tables this branch did not create rather than work around them.
- Do not edit `eslint.config.js`, `tsconfig*.json`, `test/names.ts`, `test/step0.ts`, `test/all.ts`, `.gitignore`, `CLAUDE.md` or anything in `.claude/`. Do not add `check:stepN` scripts. Never edit a migration that main already has.
- The sandbox refuses a shell command that mixes git with other commands. Run each git command on its own.
- Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Other agents change `server/forge.ts`, `server/tasks.ts` and `app/src/Work.tsx`. This branch leaves `server/forge.ts` alone and calls it only through `forge.openPullRequest` and `forge.repoPath`. In `server/tasks.ts` it changed `startTask` (repo ids and the draft flag, with the workspace and session setup moved to `server/launch.ts`), the imports, the `permissions` in `sendToSession`'s payload, and `addComment`'s anchor. In `app/src/Work.tsx` it changed the New task form (repo picker, Save draft), the task view (draft branch, order of work, Changes and pull requests, documents only under "Made by this task", done in the header), and the imports.
