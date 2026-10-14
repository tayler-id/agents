# Self-improvement: resume note

This note lets a fresh agent pick up the self-improvement work without redoing
any of it. It is dropped from the branch before it lands. Commit 64d79dd
dropped it once, and the third review round brought it back.

Branch `worktree-agent-a1b7e5f238509c562`, two commits on main at `7197f4b`
before this round. Never push it, merge it or rebase it. The coordinator asks
for the rebase once main settles. The evidence branch also edits
`messageTaskSession` in `server/tasks.ts`, so expect a conflict there. The
design is `docs/design/self-improve.md`, and the rules are in `AGENTS.md`.

## The third review round

Each finding gets a fixture or check, seen failing with the fix broken and
green with it restored byte for byte, and its own commit.

Blocking:

1. A script passed the opaque gate by starting with image bytes. An image now needs its extension to name the format its first bytes show. Done.
2. Two files could share one path, since git's output is read as UTF-8. A path holding U+FFFD, or one git lists twice, now fails closed. Done.
3. A person's message to a judge's session started it without its limits. `sendToSession` now refuses a message to any session a review or confirm row lists among its reviewers, with a 409. No column was added: the reviewers list is the mark, and a schema change to `agents_test` was refused by the permission system. Done.
4. `JUDGE_PERMISSIONS` had no check. The fake harness logs `--permission-mode`, and step16 HAPPY checks judges start with none and authors with `acceptEdits`. Done.
5. The obligation backoff overflowed at 31 tries. The exponent stops at 6, step16d seeds 40 tries, and its six second sleep is a wait on a later pass. The rerun on a database built from 0009 alone is not done: step16d needs the test Electric, which reads only `agents_test`, and changing `agents_test`'s schema was refused. A scratch database built from this branch's migrations showed the same 0009 objects as `agents_test`. Done but for that rerun.

Not blocking:

6. The deploy lifecycle: `checking` may end `failed`, `move()` updates only from the status it expects, and a per-repo advisory lock comes before `failStuck`. step16b and step16c check each. Done.
7. Paths and gate names unfenced in the pull request body. Not started.
8. The box-only refusal for a task with two repos, and the `--scrim` token, named in the build log. Not started.

## How to run the checks

- Use `~/.local/node/bin/node`. Typecheck both with `tsc -p .` and `tsc -p app`, then `eslint .` and `node test/names.ts`.
- step16b and step16f need no database: `node test/step16b.ts`.
- step16, step16c and step16d run on `agents_test` through `.env.test`, as `npm run check` does. A scratch database will not do for them: the daemon hears of commands only through the test Electric, which replicates `agents_test` alone. Do not change `agents_test`'s schema by hand. The permission system refuses it.
- `STEP16_ONLY=HAPPY,BOXED` runs only the named sections of step16.
- None of these checks use port 7701. Take `~/.agents-app/checks/run.lock` with `mkdir` before anything that does, and `rmdir` it after.
- `.scratch/seen-failing.ts <spec.json>` breaks a guard with anchored edits, runs its check, restores every file and compares sha256. `.scratch` is ignored by git.

## What a fresh agent must know

- The app's typecheck reads `shared/framework.ts`, which must not import Node modules.
- Never build or tag `agents-box:latest`.
- Never break a source file while a check is running.
- Checks for this work use ports 8002 to 8019 and teams starting `self-`.
- The record cannot store a NUL byte in an event, so an agent that writes one stalls its stage. That is main's to fix, in `server/record.ts`.
