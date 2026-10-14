# Terminal sessions work, where it stands

A note for whoever picks this up, kept current with each commit on the branch. The design is [local-sessions.md](local-sessions.md).

- Branch `worktree-agent-ae6bff17618001d52`, worktree `.claude/worktrees/agent-ae6bff17618001d52`, from main at a98d843.
- The worktree has its own `node_modules` from `npm ci`, and `.env` and `.env.test` copied from main.
- Migration number 0013, given by the coordinator.
- The check is `test/step21.ts`, on ports 8100 to 8119, with teams named `local-<id>`.

## Done

- The design, from prototypes of hooks and of transcript reading against the real CLI. The prototype scripts are in this session's scratchpad under `ls/`, not in the repo.

## Next

1. Migration 0013 and its entry in `docs/data-model.md`.
2. The API: folders, terminal sessions, events from a terminal session, the shapes, who sees what.
3. The daemon: `daemon/api.ts` taken out of `agentsd.ts`, `daemon/transcripts.ts`, `daemon/folders.ts`, and the mapping in `daemon/claude.ts`.
4. The app: the sidebar's "From terminals" and the session's page.
5. `test/step21.ts`, then break each line and watch it go red.

## How to work here

- `export PATH="$HOME/.local/node/bin:$PATH"` first.
- Run the check with `node --env-file=.env --env-file=.env.test test/step21.ts`. It needs the test Postgres and the test Electric on 3002, and it runs the real `claude` with `haiku`, so it spends a little of the subscription.
- Never touch port 7701 without `mkdir ~/.agents-app/checks/run.lock` first. This work's check doesn't use it.
