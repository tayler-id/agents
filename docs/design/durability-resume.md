# Durability: where the work stands

The design is in `docs/design/durability.md`. This note says what is done, what is next, and how to pick the work up.

## Setup

- Worktree `.claude/worktrees/agent-a9a4a2cfdabcacc5b`, branch `worktree-agent-a9a4a2cfdabcacc5b`, from main at `deec329`.
- `.env` and `.env.test` are copies of main's. Packages come from `npm ci` in the worktree.
- Run Node from `~/.local/node/bin`.
- Checks: `test/step18a.ts` to `test/step18e.ts`, teams prefixed `dur-`, ports 8040 to 8059. Check 4 also uses 7701, so take `~/.agents-app/checks/run.lock` first.
- Migration: `0010_durability.sql`.

## Done

- The design doc, with the seven facts measured on Claude Code 2.1.296.

## Next

1. The five checks, each seen failing on main.
2. Migration 0010 and the turn lifecycle in `shared/lifecycle.ts`.
3. The server ends turns, and the daemon runs one turn at a time per session.
4. Recovery: fencing, the recover endpoint and the continuation.
5. Approvals across a restart.
6. The watchdog and the app's interrupted line.
7. The box check.

## Decisions waiting on Tayler

None yet.
