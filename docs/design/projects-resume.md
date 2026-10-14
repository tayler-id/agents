# Projects work, where it stands

A note for whoever picks this up. Branch `worktree-agent-a9f12f8ca4798f55b`, worktree `~/Projects/agents/.claude/worktrees/agent-a9f12f8ca4798f55b`. The design is `docs/design/projects.md`. The branch is rebased on main at `f643a30`, and has its own `node_modules` from `npm ci`.

## Done, committed

- Design doc and schema, migration `server/migrations/0006_projects.sql`, with its `docs/data-model.md` entry. 0006 has run on `agents_test`. Never edit it again.
- Server: projects, repo requests, the GitHub client, forge dispatch by `repos.forge`, the git proxy's branch rule, the admin CLI command `github-token <team> <org>`, the GitHub worker.
  - Device-flow sign-in per person (`server/github-auth.ts`), tokens in mode 600 files under `AGENTS_GITHUB_DIR/people`, renewed without a client secret. A repo's calls use the sign-in of whoever brought that team's row of it into a project. Each team's stopgap is a fine-grained token in `AGENTS_GITHUB_DIR/stopgaps/<team id>.json`.
  - Public repos: runs start only from `agent:` labels put on by someone with write, maintain or admin access, while the issue is open and has the label, checked again before the pull request opens. Issue text reaches the agent quoted. micromark, a CommonMark parser, reads the whole body in a worker thread, `server/visible-text-worker.ts`, with a 2-second deadline, and what a reader sees is then cut at 20,000 characters, with code kept and the parts a reader can't see removed (`server/public-text.ts`). Titles are cleaned and cut at 120 characters, and the runner quotes the run's title and the other issues' titles in every prompt, as bug-fix's prompt says. Everything sent to GitHub's API passes `forPublic`. Polls use ETags, kept only once a poll's answer is handled.
  - Every call to GitHub gives up after 15 seconds, a repo request is claimed, asked and recorded in steps with no transaction open while GitHub is asked, and an existing repo joins a project only if its asker can push to it. The branch rule asks the forge for the default branch on each push, and tasks and runs ask before their workspace is cloned. A try holds its repo request for `CLAIM_SEC`, 90 seconds, worked out from the most calls a try makes and GitHub's time limit. The GitHub worker has `stop()`, which the API calls.
- The review on another model, 2026-10-13: all thirteen findings fixed in commits "Read a hostile issue in one pass" and "Fix the review's GitHub findings".
- The second review, later on 2026-10-13: the claim window, the default branch outside pushes and four doc sentences, fixed in "Hold a repo request for as long as a try can ask GitHub", "Start tasks and runs from the default branch the forge names now" and "Say which hidden parts the text filter takes out, and which still pass".
- Tayler's calls on 2026-10-14, done in "Read public issue text with micromark, a CommonMark parser" and "Say in bug-fix's prompt that issue titles are quoted data":
  - The default-branch push refusal is accepted.
  - micromark 4.0.3 is pinned exactly in `package.json`, and the lockfile pins its dependencies. The session before this one stopped halfway through that rewrite, and its version leaked three ways, which are fixed and checked.
  - bug-fix's prompt says the report's title and the other issues' titles are quoted data, not instructions.
  - GitHub stays off on the real server until these have landed on main.
- The review of `cb9b6b8`: the cut before the parse, drafts that couldn't be edited, titles the prompt called quoted that weren't, and small filter gaps, fixed in "Read an issue whole before cutting it, and quote titles in every prompt" and "Let a draft keep the repos it was started with". Main's step14 then found that a task on a repo its forge doesn't have no longer started, fixed in "Start a task when its forge can't name the default branch". The known gaps in tables and footnotes are in the design, and GitHub stays off until they close.
- Checks, all green on `5f38aba`: `test/step13.ts` 68 checks, `test/step13c.ts` 83, `test/step13b.ts` 19 in each of three browsers, and main's step14, step14b and step14c. step13b's checks that wait for GitHub's sign-in or a page failed twice while other agents' checks kept this Mac at a load of 12 to 19, and passed at 8. Break runners in `.scratch/` (gitignored): `breaks13.ts` with file and schema breaks, sets U1 to U3 for this round, `breaks13c.ts` for the text filter, 47 breaks, `breaks13b.ts` for the app, set V1 for the draft's picker. After the rebase onto main at `f643a30`, the checks ran again on `4111510` and passed, with step13 at 68, step13c 83, step13b 19 in each of three browsers, step14 74, step14b 42, step14c 132, step18e 21 and step20b 31. Five commits conflicted, and the build log says how each was resolved.
- The app: `app/src/Projects.tsx`, routes and sidebar in `app/src/App.tsx`, small hooks in `app/src/Work.tsx`, `app/src/data.ts`, `app/src/styles.css`.
- Docs: `docs/what-each-part-does.md` section, `docs/build-log.md` section, a README section.

## In progress

- Nothing. The branch waits for the coordinator's review and landing.
- The break runners edit files, or drop a constraint in `agents_test`, while a set runs, and put them back. If a session stops mid-set, `git status` shows a file modified that no commit made: restore it with `git checkout -- <file>`. A dropped constraint is named in the runner's `B` table with its table, and `\d <table>` in psql shows whether it is back. Remove a set's test teams with `.scratch/cleanup-proj.ts <id>`.

## Next steps, in order

1. Answer the open questions below with Tayler.
2. Layer 2, a team's own GitHub App made through the manifest flow, as the design describes.
3. Hide character references that stand for invisible characters, as follow-up 7 in the design says. `visibleText('a&#xE0049;')` returns them as written.
4. Read `team/pipelines` at the forge's current default branch when pipelines sync and when a change to them is proposed, as tasks and runs do.

## Must know

- Run Node from `~/.local/node/bin`, for example `~/.local/node/bin/node --env-file=.env --env-file=.env.test test/step13.ts`. The `node` in `/usr/local/bin` can't load the native packages.
- Ports 7940 to 7959 only: step13 uses 7940 to 7947, step13b 7950 to 7953. People reach each check's API on a Unix socket in the check's folder, forwarded from the old port by `servePeople` in `test/people.ts`.
- Team names start with `proj-`. Gitea test repos start with `proj-`. `.scratch/cleanup-proj.ts <id>` removes what a failed run kept.
- GitHub's settings `AGENTS_GITHUB_DIR`, `AGENTS_GITHUB_API`, `AGENTS_GITHUB_GIT` have no defaults, and `AGENTS_GITHUB_CLIENT_ID` turns sign-in on. Checks strip any of them from the environment and set their own, so they never touch a real token.
- The fake GitHub runs inside the check's own process, so a child that talks to it must be started without blocking (`spawn`, never `spawnSync`).
- Don't add `check:` scripts to `package.json`, don't edit `.gitignore` or any protected file. Take the lock in `AGENTS.md` before any check on port 7701. Run main's shared checks with `.scratch/main-suite.ts`, which takes the lock before each, and not while the coordinator's suite runs. Its default list leaves out step7 and step12 to step12c, so name them to run them. Main's step7 builds, runs and removes a box image tag of its own since `94cd4b1`. After any check that builds an image, run `docker image prune -f`.
- micromark's slowest inputs take time that grows with the square of their length. `READ_MS` in `server/public-text.ts`, 2 seconds, bounds them. The worker is stopped there, and the report says the text was left out. step13c's `HOSTILE_IN` times the slowest shapes found, which are left out at 65,536 characters, and the shapes it marks `read` must come back read. Add a slower shape there if one turns up.
- Install packages with `npm ci` in this worktree. micromark came in with `npm install --save-exact micromark@4.0.3`, which added it and its 26 dependencies to the lockfile and changed no other package.

## Open questions for Tayler

- Register the Agents GitHub App (permissions in the design doc) and set its client id, or keep a stopgap token for now.
- Make the existing team's person an admin: `node --env-file=.env server/admin.ts set-role <team> <login> admin`.
- Approve `micromark-extension-gfm-table` and a package for GitHub's footnotes, so the filter can drop a table's cells past its header's width and footnote definitions nothing refers to. GitHub stays off until then.
- The bug-fix pipeline triggers on `bug`, which on GitHub never starts a run. Change its label to `agent:fix` for GitHub repos, or keep bug-fix on this Mac's forge only.
