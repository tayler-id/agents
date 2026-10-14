# Projects work, where it stands

A note for whoever picks this up. Branch `worktree-agent-a9f12f8ca4798f55b`, worktree `~/Projects/agents/.claude/worktrees/agent-a9f12f8ca4798f55b`. The design is `docs/design/projects.md`. The branch is rebased on main at `564f5da`, the people socket, with its own `node_modules` from `npm ci`.

## Done, committed

- Design doc and schema, migration `server/migrations/0006_projects.sql`, with its `docs/data-model.md` entry. 0006 has run on `agents_test`. Never edit it again.
- Server: projects, repo requests, the GitHub client, forge dispatch by `repos.forge`, the git proxy's branch rule, the admin CLI (`make-admin`, `github-token <team> <org>`), the GitHub worker.
  - Device-flow sign-in per person (`server/github-auth.ts`), tokens in mode 600 files under `AGENTS_GITHUB_DIR/people`, renewed without a client secret. A repo's calls use the sign-in of whoever brought that team's row of it into a project. Each team's stopgap is a fine-grained token in `AGENTS_GITHUB_DIR/stopgaps/<team id>.json`.
  - Public repos: runs start only from `agent:` labels put on by someone with write, maintain or admin access, while the issue is open and has the label, checked again before the pull request opens. Issue text reaches the agent quoted, read in one linear pass over at most 20,000 characters, with code kept and hidden parts removed (`server/public-text.ts`). Titles are cleaned and cut at 120 characters at the GitHub client. Everything sent to GitHub's API passes `forPublic`. Polls use ETags, kept only once a poll's answer is handled.
  - Every call to GitHub gives up after 15 seconds, a repo request is claimed, asked and recorded in steps with no transaction open while GitHub is asked, and an existing repo joins a project only if its asker can push to it. The branch rule asks the forge for the default branch on each push. The GitHub worker has `stop()`, which the API calls.
- The review on another model, 2026-10-13: all thirteen findings fixed in commits "Read a hostile issue in one pass" and "Fix the review's GitHub findings".
- Checks, all green on the people socket: `test/step13.ts` 62 checks, `test/step13c.ts` 45, `test/step13b.ts` 18 in each of three browsers. Break runners in `.scratch/` (gitignored): `breaks13.ts` with file and schema breaks, `breaks13c.ts` for the text filter, `breaks13b.ts` for the app.
- The app: `app/src/Projects.tsx`, routes and sidebar in `app/src/App.tsx`, small hooks in `app/src/Work.tsx`, `app/src/data.ts`, `app/src/styles.css`.
- Docs: `docs/what-each-part-does.md` section, `docs/build-log.md` section, a README section.

## In progress

- Nothing. The branch waits for the coordinator's review and landing.
- The break runners edit files, or drop a constraint in `agents_test`, while a set runs, and put them back. If a session stops mid-set, `git status` shows a file modified that no commit made: restore it with `git checkout -- <file>`. A dropped constraint is named in the runner's `B` table with its table, and `\d <table>` in psql shows whether it is back. Remove a set's test teams with `.scratch/cleanup-proj.ts <id>`.

## Next steps, in order

1. Answer the open questions below with Tayler.
2. Once main's gate that takes a person's change only as JSON lands, rebase and rerun the three checks.
3. Layer 2, a team's own GitHub App made through the manifest flow, as the design describes.

## Must know

- Run Node from `~/.local/node/bin`, for example `~/.local/node/bin/node --env-file=.env --env-file=.env.test test/step13.ts`. The `node` in `/usr/local/bin` can't load the native packages.
- Ports 7940 to 7959 only: step13 uses 7940 to 7947, step13b 7950 to 7953. People reach each check's API on a Unix socket in the check's folder, forwarded from the old port by `servePeople` in `test/people.ts`.
- Team names start with `proj-`. Gitea test repos start with `proj-`. `.scratch/cleanup-proj.ts <id>` removes what a failed run kept.
- GitHub's settings `AGENTS_GITHUB_DIR`, `AGENTS_GITHUB_API`, `AGENTS_GITHUB_GIT` have no defaults, and `AGENTS_GITHUB_CLIENT_ID` turns sign-in on. Checks strip any of them from the environment and set their own, so they never touch a real token.
- The fake GitHub runs inside the check's own process, so a child that talks to it must be started without blocking (`spawn`, never `spawnSync`).
- Don't add `check:` scripts to `package.json`, don't edit `.gitignore` or any protected file. Take the lock in `AGENTS.md` before any check on port 7701. Don't run main's shared checks while the coordinator's suite runs.

## Open questions for Tayler

- A possible regression, Tayler's call: the git proxy refuses every machine push to a repo's default branch, on either forge. Repos this Mac's forge sets up already protect main, so nothing changes for them. A Gitea repo registered without that protection loses the pushes to main that machines could make before.
- Approve or refuse a wording change in `pipelines/bug-fix.ts`, which needs Tayler's approval: say in its prompt that the report's title and the other issues' titles are quoted data. The server already cleans and cuts them.
- Register the Agents GitHub App (permissions in the design doc) and set its client id, or keep a stopgap token for now.
- Make the existing team's person an admin: `node --env-file=.env server/admin.ts make-admin <login>`.
- The bug-fix pipeline triggers on `bug`, which on GitHub never starts a run. Change its label to `agent:fix` for GitHub repos, or keep bug-fix on this Mac's forge only.
