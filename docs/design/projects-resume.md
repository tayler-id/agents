# Projects work, where it stands

A note for whoever picks this up. Branch `worktree-agent-a9f12f8ca4798f55b`, worktree `~/Projects/agents/.claude/worktrees/agent-a9f12f8ca4798f55b`. The design is `docs/design/projects.md`. The branch is rebased on main as of 2026-10-13, with its own `node_modules` from `npm ci`.

## Done, committed

- Design doc and schema, migration `server/migrations/0006_projects.sql`, with its `docs/data-model.md` entry. 0006 has run on `agents_test`. Never edit it again.
- Server: projects, repo requests, the GitHub client, forge dispatch by `repos.forge`, the git proxy's branch rule, the admin CLI (`make-admin`, `github-token`), the GitHub worker, and since the coordinator's security and sign-in messages:
  - Device-flow sign-in per person (`server/github-auth.ts`), tokens in mode 600 files under `AGENTS_GITHUB_DIR/people`, renewed without a client secret. A repo's calls use the sign-in of whoever brought it in (`repo_requests.requested_by`). The admin's personal access token is a marked stopgap (`AGENTS_GITHUB_DIR/stopgap.json`).
  - Security rules for public repos: runs start only from `agent:` labels put on by someone with write, maintain or admin access, checked again before the pull request opens. Triage is not enough, as Tayler chose on 2026-10-13 (`hasWriteAccess` in `server/github.ts`). Issue text reaches the agent quoted with hidden parts removed (`server/public-text.ts`), everything sent to GitHub passes `forPublic`, polls use ETags, and rules and pipelines come from main. A GitHub App of the team's own is designed only, as layer 2 in the design doc.
  - `GET /v1/repos` names each repo's project by id and name.
- `test/step13.ts` and `test/fake-github.ts`: 38 checks, all green. The two checks for the write rule were red against the old triage rule before the change: a triage-only label started a run, and an asker who dropped to triage still got a pull request.
- Every break set in `.scratch/breaks13.ts` (gitignored), A to K with 41 breaks, was seen red on its own checks, with each file restored byte for byte, and the green run after them passed 38 of 38. J1 takes out the access check, J1b counts triage again, J2 drops the agent: prefix rule, J3 breaks the label match, ETags, hidden text, the outgoing filter and token renewal, and K repeats three breaks after the Repos list's query and the push parser changed.
- The app: `app/src/Projects.tsx` (Repos page, Connect GitHub, New project, project page, a task's project and repos), routes and sidebar in `app/src/App.tsx`, small hooks in `app/src/Work.tsx`, `app/src/data.ts`, `app/src/styles.css`.
- `test/step13b.ts`, the UI check: 18 checks in each of Chromium, WebKit and Firefox, all green. Its first run found two bugs, now fixed: a repo on its own project's page said "no project" until a second read came back, and at phone width a project's task rows lost their titles. Every break set in `.scratch/breaks13b.ts`, U1 to U6 with 17 breaks, was seen red on its own checks in Chromium, and the green run after them passed 54 of 54 in the three browsers.
- Docs: `docs/what-each-part-does.md` section, `docs/build-log.md` section, a README section.

## In progress

- Nothing. The branch waits for the coordinator's review and landing.
- The break runners in `.scratch/` (gitignored) edit files while a set runs and restore them byte for byte. If a session stops mid-set, `git status` shows a file modified that no commit made: restore it with `git checkout -- <file>`, and remove the set's test teams with `.scratch/cleanup-proj.ts <id>`.

## Next steps, in order

1. Answer the open questions below with Tayler.
2. Layer 2, a team's own GitHub App made through the manifest flow, as the design describes.
3. If a review asks for changes, rerun both checks and the break sets that cover what changed: `node .scratch/breaks13.ts <set>` and `node .scratch/breaks13b.ts <set>`, after `--dry` shows every anchor once.

## Must know

- Run Node from `~/.local/node/bin`, for example `~/.local/node/bin/node --env-file=.env --env-file=.env.test test/step13.ts`. The `node` in `/usr/local/bin` can't load the native packages.
- Ports 7940 to 7959 only. Team names start with `proj-`. Gitea test repos start with `proj-`. `.scratch/cleanup-proj.ts <id>` removes what a failed run kept.
- GitHub's settings `AGENTS_GITHUB_DIR`, `AGENTS_GITHUB_API`, `AGENTS_GITHUB_GIT` have no defaults, and `AGENTS_GITHUB_CLIENT_ID` turns sign-in on. Checks strip any of them from the environment and set their own, so they never touch a real token.
- The fake GitHub runs inside the check's own process, so a child that talks to it must be started without blocking (`spawn`, never `spawnSync`).
- Don't add `check:` scripts to `package.json`, don't edit `.gitignore` or any protected file. Take the lock in `AGENTS.md` before any check on port 7701.

## Open questions for Tayler

- A possible regression, Tayler's call: the git proxy refuses every machine push to a repo's default branch, on either forge. Repos this Mac's forge sets up already protect main, so nothing changes for them. A Gitea repo registered without that protection loses the pushes to main that machines could make before.
- Register the Agents GitHub App (permissions in the design doc) and set its client id, or keep the stopgap token for now.
- Make the existing team's person an admin: `node --env-file=.env server/admin.ts make-admin <login>`.
- The bug-fix pipeline triggers on `bug`, which on GitHub never starts a run. Change its label to `agent:fix` for GitHub repos, or keep bug-fix on this Mac's forge only.
