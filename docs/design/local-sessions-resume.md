# Terminal sessions work, where it stands

A note for whoever picks this up, kept current with each commit on the branch. The design is [local-sessions.md](local-sessions.md).

- Branch `worktree-agent-ae6bff17618001d52`, worktree `.claude/worktrees/agent-ae6bff17618001d52`, from main at a98d843.
- The worktree has its own `node_modules` from `npm ci`, and `.env` and `.env.test` copied from main.
- Migration 0013, applied to `agents_test`. Never edit it. The coordinator renumbers it at landing.
- The check is `test/step21.ts`, on ports 8100 to 8102, with teams named `local-<id>`.

## Done

The branch's commits, oldest first, by subject:

1. The design, from prototypes of hooks and of transcript reading against the real CLI.
2. Migration 0013 and its entry in `docs/data-model.md`.
3. The API: connected folders, terminal sessions, events from a terminal session, the shapes, and who sees what.
4. The daemon: `daemon/api.ts` taken out of `agentsd.ts`, `daemon/transcripts.ts`, `daemon/folders.ts`, and the mapping in `daemon/claude.ts`.
5. The app: the sidebar's From terminals and Running now, and a terminal session's page.
6. `test/step21.ts`, which passed all 49 lines with the real CLI. Its first run found that headless prompts are marked `sdk`, not `human`, and the fix is in the same commit.

## Under way

- Breaking what step21 guards, a group of breaks per run. The runner and its results are in this session's scratchpad, `ls/breaks.ts` and `ls/breaks-result.json`, not in the repo. Each anchor must occur once before a file is written, and each file is put back and compared by sha256.
- An interactive session typed through `expect`, through the real API and daemon, by hand: `ls/interactive-e2e.ts` in the scratchpad.

## After that

- The build log's entry, and the numbers from the breaks in the design doc and `docs/what-each-part-does.md`.
- Remove the `local-` teams that red runs kept, the `agents-step21-` folders in the temp folder, and the check's transcript folders under `~/.claude/projects`.

## How to work here

- `export PATH="$HOME/.local/node/bin:$PATH"` first.
- Run the check with `node --env-file=.env --env-file=.env.test test/step21.ts`. It needs the test Postgres and the test Electric on 3002, builds the app, and runs the real `claude` with `haiku` about ten times, so it spends a little of the subscription. It takes about three minutes.
- Never touch port 7701 without `mkdir ~/.agents-app/checks/run.lock` first. This work's check doesn't use it.
