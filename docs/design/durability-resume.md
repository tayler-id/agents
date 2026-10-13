# Durability: where the work stands

The design is in `docs/design/durability.md`. This note says what is done, what is blocked, and how to pick the work up.

## Blocked: the Mac is out of System V semaphores

Since about 17:20 on 2026-10-13, every API a check starts with a fresh streams folder aborts at once with SIGABRT, exit code 134, and prints nothing. Every check that starts an API fails with "timed out waiting for the API", on any branch.

- The stream server keeps its metadata in LMDB, which on this Mac takes a System V semaphore set of 3 for each new database. `semget` for 3 now fails with "No space left on device".
- `ipcs -s -b` shows 87,379 semaphores in use, against the system limit `kern.sysv.semmns` of 87,381. 4,961 sets of 17 hold 84,337 of them. Sets of 17 are PostgreSQL's allocation, so these come from Postgres servers run directly on the Mac, outside Docker. Two run now, both for other projects of Tayler's, one since September and one since 2026-10-10. 1,014 sets of 3 hold the other 3,042. Those are LMDB's, most likely from stream servers killed without closing their database, since the API has no handler for SIGTERM. Agents' check APIs are probably among them, mine included, but nothing records which process made a set.
- The sets' creation times span every hour of the clock, so they have built up over days since the Mac last started.
- The live API is not affected while it runs, since its database already has its set. It would fail the same way if it restarted with a new streams folder.

Freeing semaphores needs a call from Tayler or the coordinator, since the sets belong to other projects, other agents' running checks and the live services. The ways out:
- restart the Mac, which clears every set but restarts the live services and colima;
- remove the sets whose processes are gone, with `ipcrm -s`, after working out which those are;
- raise `kern.sysv.semmns` and `kern.sysv.semmni` with `sudo sysctl`, until the next restart.

On Agents' side, `server/api.ts` has no SIGTERM handler, so every check that stops its API with SIGTERM leaks the stream server's set of 3. `DurableStreamTestServer` has `stop()`, which should close the database, but that is untested. Fixing it belongs in its own change.

## Setup

- Worktree `.claude/worktrees/agent-a9a4a2cfdabcacc5b`, branch `worktree-agent-a9a4a2cfdabcacc5b`, from main at `deec329`. Main has moved on with docs, the test Electric's file limit and step2b, and none of it touches this branch's files.
- `.env` and `.env.test` are copies of main's. Packages come from `npm ci` in the worktree.
- Run Node from `~/.local/node/bin`. Never start the API without `AGENTS_STREAMS_DIR`, or it opens the live system's streams folder.
- Checks: `test/step18a.ts` to `test/step18g.ts`, helpers in `test/crash.ts`, teams prefixed `dur-`. The helpers never import product code, so the checks also run against main.
- Ports: 8046 to 8059. 8041 to 8045 are held by another workstream's leftover API and login proxies, started 13:20 on 2026-10-13. step18a and step18g share 8046 to 8048, and step18e and step18f share 8057 to 8059, so each pair runs one after the other. step18d's API is on 7701, so it takes `~/.agents-app/checks/run.lock` first and waits up to 20 minutes for it.
- Migration: `0010_durability.sql`, applied to `agents_test`.
- To run a check against main, `git archive` main into a folder under `~/.agents-app/checks/` (colima mounts only the home folder, which step18d needs), copy in `test/crash.ts`, `test/step18*.ts` and `test/fake-claude.ts`, copy `.env` and `.env.test`, link `node_modules`, run the check there, and remove the folder after.
- Break tests: break one file, run its check and watch it fail, restore the file byte for byte and compare its hash, run the check and watch it pass.

## Done and proven

- The design, with ten facts measured on Claude Code 2.1.296.
- A message stays claimed until the turn that answers it ends (`d2e2398`). step1 and step6 passed.
- Recovery (`cd1d2ec`). step18a passed with real Claude, step18b with the fake.
- A failed restart leaves its session failed (`98db384`), from the coordinator's bug report. step18f passed.
- Approvals across a restart, with migration 0010 (`9ef1fe9`). step18c passed.
- The watchdog and the app's interrupted line (`57b0532`). step18e passed, in a browser.
- On main at `1715371`, before the semaphores ran out: step18a, step18b, step18c and step18e failed by timing out or never seeing the session lost, and step18f failed with the session idle.
- Break tests, red when broken and green when restored: step18f on the restart detach, step18b on the continuation's in-flight calls, step18c on the takeover of an ended ask.

## Not done

1. step18d, the box replacement, has never run on the branch or on main. Each attempt waited out the lock, and now its API can't start either.
2. step18e's break test went red on the watchdog break, but its restored run hit the semaphore failure. step18a's break test failed in both halves on the same failure, so it proved nothing. Both need rerunning.
3. step18b's third part, an interrupt while the machine is down, and step18g, a follow-up folded into the running turn, have not run on the branch or on main (`976258d`).
4. The other checks that run the daemon have not run since the approvals and watchdog changes: step3, step4a to step4d, step5, step6b, step7, step8, step9, step9b, step10 and step10b. step1 and step6 last passed after `d2e2398`.
5. The `.scratch/` folder in the worktree holds two helper scripts, `locks.ts` and `dur-teams.ts`, which list advisory locks and this workstream's leftover teams.

## Decisions waiting on Tayler

- How to free the System V semaphores, above.
