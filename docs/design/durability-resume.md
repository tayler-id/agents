# Durability: where the work stands

The design is in `docs/design/durability.md`. This note says what is proven, what is left, and how to pick the work up.

## Setup

- Worktree `.claude/worktrees/agent-a9a4a2cfdabcacc5b`, branch `worktree-agent-a9a4a2cfdabcacc5b`, rebased onto main at `aad82a8`.
- `.env` and `.env.test` are copies of main's. Packages come from `npm ci` in the worktree.
- Run Node from `~/.local/node/bin`. Never start the API without `AGENTS_STREAMS_DIR`, or it opens the live system's streams folder.
- Checks: `test/step18a.ts` to `test/step18g.ts`, helpers in `test/crash.ts`, teams prefixed `dur-`. The helpers never import product code, so the checks also run against main.
- Ports: 8046 to 8059. 8041 to 8045 were held by another workstream's leftover API and login proxies on 2026-10-13. step18a and step18g share 8046 to 8048, and step18e and step18f share 8057 to 8059, so each pair runs one after the other. step18d's API is on 7701, so it takes `~/.agents-app/checks/run.lock` itself and waits up to 20 minutes for it.
- step7 and step8 also use 7701 but don't take the lock, so take it around them. step7 builds `agents-box:latest` from whatever folder runs it. After running it from this branch, rebuild that tag from main with `server/boxes.ts build` in a copy of main, so a live box started later runs main's daemon.
- Migration: `0010_durability.sql`, applied to `agents_test`.
- To run a check against main, `git archive` main into a folder under `~/.agents-app/checks/` (colima mounts only the home folder, which step18d needs), copy in `test/crash.ts`, `test/step18*.ts` and `test/fake-claude.ts`, copy `.env` and `.env.test`, link `node_modules`, run the check there, and remove the folder after.
- Break tests: break one file, run its check and watch it fail, restore the file byte for byte and compare its hash, run the check and watch it pass. Nothing else may run from the worktree meanwhile.

## Proven

The branch runs are on the rebase onto `aad82a8`, on 2026-10-13. The main runs are on `1715371` for step18a, step18c, step18e and step18f, and on `aad82a8` for step18b, step18d and step18g. The two commits differ only in how command errors are scrubbed.

| Check | On the branch | On main | Break test, red then green |
|---|---|---|---|
| step18a, real Claude killed mid-reply | passes, a 43-line poem after a kill 421 characters in | times out waiting for the resumed turn | daemon skips resuming |
| step18b, a tool acts before its result is saved, then only the daemon dies, then an interrupt during an outage | passes, 26 assertions | times out waiting for the resumed turn | continuation drops in-flight calls; recovery ignores a waiting interrupt |
| step18c, an approval waits through a restart | passes | times out, the answer failing with "session is not running on this machine" | a re-request can't take over an ended ask |
| step18d, a box replaced on the same volume | passes | never shows the session lost | daemon skips resuming |
| step18e, connected and reconnecting clients, and the app in a browser | passes | never shows the session lost | watchdog does nothing |
| step18f, a restart for a new setup fails | passes | shows the session idle | restart detach removed |
| step18g, real Claude folds a follow-up into the running turn | passes, a new Claude process after the setup changed | the same process keeps answering | a result ends only the first message |

Main's checks that run the daemon pass on the branch: step1, step3, step4a, step4b, step4c, step4d, step5, step6, step6b, step7, step8, step9, step9b, step10 and step10b.

step2 drops the API's Postgres connections on purpose. It failed in 2 of 4 runs on the branch, each time on an error from a dropped connection that nothing caught, while main passed 3 of 3. The watchdog had held a transaction's connection on every tick. Since `8842d29` it holds none on a tick with nothing to mark, and step2 passed 5 of 5, with step18d and step18e passing again after.

## Not done

- The gaps in `docs/design/durability.md` under "Not covered": tool commands that outlive a killed Claude on the Mac, lines lost between Claude and the record, a missing conversation, a session whose machine is gone for good, and a Postgres restart during a transaction stopping the API.
- Box images must be rebuilt when this lands, since the old daemon calls `/v1/instance/commands/requeue`, which is gone.

## Decisions waiting on Tayler

None.
