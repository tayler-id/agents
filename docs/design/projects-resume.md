# Projects work, where it stands

A note for whoever picks this up. Branch `worktree-agent-a9f12f8ca4798f55b`, worktree `~/Projects/agents/.claude/worktrees/agent-a9f12f8ca4798f55b`. The design is `docs/design/projects.md`.

## Done, committed

- Design doc and schema, migration `server/migrations/0006_projects.sql`, with its `docs/data-model.md` entry. 0006 has run on `agents_test`. Never edit it again.
- Server: projects, repo requests, the GitHub client, forge dispatch by `repos.forge`, the git proxy's branch rule, the admin CLI (`make-admin`, `github-token`), the GitHub worker, and since the coordinator's security and sign-in messages:
  - Device-flow sign-in per person (`server/github-auth.ts`), tokens in mode 600 files under `AGENTS_GITHUB_DIR/people`, renewed without a client secret. A repo's calls use the sign-in of whoever brought it in (`repo_requests.requested_by`). The admin's personal access token is a marked stopgap (`AGENTS_GITHUB_DIR/stopgap.json`).
  - Security rules for public repos, all built: runs start only from `agent:` labels put on by someone with triage access, checked again before the pull request opens; issue text reaches the agent quoted with hidden parts removed (`server/public-text.ts`); everything sent to GitHub passes `forPublic`; polls use ETags; rules and pipelines come from main. A GitHub App of the team's own is designed only, as layer 2 in the design doc.
- `test/step13.ts` and `test/fake-github.ts`: 37 checks, all green. Seen failing so far under `.scratch/breaks13.ts`, sets A, B, C and D, every break red as it should be. One earlier finding: a check for the once key passed under its break, because the run closed the issue before a second poll. The check now forces a second read of the label list, and set F re-tests it.
- The app: `app/src/Projects.tsx` (Repos page, Connect GitHub, New project, project page, a task's project and repos), routes and sidebar in `app/src/App.tsx`, small hooks in `app/src/Work.tsx`, `app/src/data.ts`, `app/src/styles.css`. Typecheck and lint pass. Committed as wip: not yet run in a browser.
- `test/step13b.ts`, the UI check, written, not yet run.
- Docs: `docs/what-each-part-does.md` section, `docs/build-log.md` section without its verification bullet, a README section.

## In progress

- `.scratch/breaks13.ts` (gitignored) runs break sets A to J3 and a final green run, writing to the scratchpad log `breaks13-all.log`. It edits server files while a set runs and restores them byte for byte. If the session stopped mid-set, `git status` shows a server file modified that no commit made: restore it with `git checkout -- <file>`.
- Sets still to see red: E (no polling), F (no once key), G (writes the real home's GitHub folder, run with HOME moved), H (repo calls ignore the person's own sign-in), I (repo calls ignore whoever brought the repo in), J1 (no triage check), J2 (no agent: prefix rule), J3 (label match, ETag, hidden text, outgoing filter, token renewal). Then the green run.

## Next steps, in order

1. Finish the step 13 break sets, then run step 13 green: `node --env-file=.env --env-file=.env.test test/step13.ts` with `~/.local/node/bin` first on PATH.
2. In both checks' `envWith`, put `dirname(process.execPath)` first on the children's PATH, so the fake Claude runs on the same Node as the check.
3. Run `test/step13b.ts` in all three browsers, fix what fails, then see its checks fail with `.scratch/breaks13b.ts` sets U1 to U5 (Chromium only) and run it green in all three. Screenshots go to `test/ui-shots/` with names starting `<engine>-projects-`.
4. Add the verification bullet to the build log with the counts, and list the screenshots.
5. Final: `npm run typecheck`, `npm run lint`, `node test/names.ts` (move the node_modules symlink aside while it runs, since git lists the symlink as a file), both checks, then report.

## Must know

- Ports 7940 to 7959 only. Team names start with `proj-`. Gitea test repos start with `proj-`. `.scratch/cleanup-proj.ts <id>` removes what a failed run kept.
- GitHub's settings `AGENTS_GITHUB_DIR`, `AGENTS_GITHUB_API`, `AGENTS_GITHUB_GIT` have no defaults, and `AGENTS_GITHUB_CLIENT_ID` turns sign-in on. Checks strip any of them from the environment and set their own, so they never touch a real token.
- The fake GitHub runs inside the check's own process, so a child that talks to it must be started without blocking (`spawn`, never `spawnSync`).
- Don't add `check:` scripts to `package.json`, don't edit `.gitignore` or any protected file.

## Open questions for Tayler

- Register the Agents GitHub App (permissions in the design doc) and set its client id, or keep the stopgap token for now.
- Make the existing team's person an admin: `node --env-file=.env server/admin.ts make-admin <login>`.
- The bug-fix pipeline triggers on `bug`, which on GitHub never starts a run. Change its label to `agent:fix` for GitHub repos, or keep bug-fix on this Mac's forge only.
