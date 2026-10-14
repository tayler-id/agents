# Where the durability work stands

The design is in `docs/design/durability.md`. This note says what is proven, what is left, and how to pick the work up.

## A regression for Tayler to decide

A daemon built before this branch breaks against its API, and a new daemon breaks against an old API. "A regression for Tayler to decide" in the design doc has the failure modes, what a run of main's daemon against this branch showed, and the rollout order that avoids them. Keeping the old requeue route answering during a transition is not built.

## Setup

- Worktree `.claude/worktrees/agent-a9a4a2cfdabcacc5b`, branch `worktree-agent-a9a4a2cfdabcacc5b`, rebased onto main at `94cd4b1`.
- `.env` and `.env.test` are copies of main's. Packages come from `npm ci` in the worktree.
- Run Node from `~/.local/node/bin`. Never start the API without `AGENTS_STREAMS_DIR`, or it opens the live system's streams folder, and give it an `AGENTS_PEOPLE_SOCKET` in a folder only you can write.
- Checks: `test/step18a.ts` to `test/step18l.ts`, helpers in `test/crash.ts`, teams prefixed `dur-`. People reach each check's API through `servePeople` from `test/people.ts`, which the check closes when it ends. The helpers never import product code, so the checks also run against main.
- Ports: 8040 and 8046 to 8059. 8041 to 8045 are held by another workstream's leftover API and login proxies. Checks that share ports run one after the other, since a stopped API can take 5 seconds to let go of its port. step18d's API is on 7701, so it takes `~/.agents-app/checks/run.lock` itself and waits up to 20 minutes for it.
- step7 and step8 also use 7701 but don't take the lock, so take it around them. Never build or tag `agents-box:latest`, which the live server starts boxes from. Since `94cd4b1` step7 builds and removes its own tag.
- After any run that builds an image, step18d included, run `docker image prune -f`. The colima disk filled once with untagged images from rebuilds.
- Migration: `0010_durability.sql`, applied to `agents_test`.
- To run a check against main, `git archive` main into a folder under `~/.agents-app/checks/` (colima mounts only the home folder, which step18d needs), copy in `test/crash.ts`, `test/step18*.ts` and `test/fake-claude.ts`, copy `.env` and `.env.test`, link `node_modules`, run the check there, and remove the folder after.
- Break tests: break one file, run its check and watch it fail, restore the file byte for byte and compare its hash, run the check and watch it pass. Nothing else may run from the worktree meanwhile.

## Proven

The branch runs are on the rebase onto `360c16e`, on 2026-10-13. Main then moved to `94cd4b1`, which changes only `docs/decisions.md` and `test/step7.ts`, and the branch is rebased onto it. The main runs are on `360c16e`, whose product code `94cd4b1` keeps as it was.

| Check | On the branch | On main | Break test, red then green |
|---|---|---|---|
| step18a, real Claude killed mid-reply | passes, a 28-line poem after a kill 295 characters in | times out waiting for the resumed turn | the daemon skips resuming |
| step18b, a tool acts before its result is saved, only the daemon dies, an interrupt during an outage, SIGTERM mid-turn | passes, 33 assertions | times out waiting for the resumed turn | the continuation drops in-flight calls; recovery ignores a waiting interrupt; shutdown stops a busy session |
| step18c, an approval waits through a restart | passes, 18 | times out waiting for the resumed turn | a new request can't take over an ended ask |
| step18d, a box replaced on the same volume | passes, 14 | never shows the session lost | the daemon skips resuming |
| step18e, clients and the app in a browser, for a DM and a task | passes, 20 | never shows the session lost | the watchdog does nothing; the task page has no lost line and shows the continuation |
| step18f, a restart for a new setup fails | passes, 7 | shows the session idle | the restart's detach removed |
| step18g, real Claude folds a follow-up into the running turn | passes, 7 | the same process keeps answering | a result ends only the first message |
| step18h, an approval never outlives its turn | passes, 12 | the card stays open, and a late allow gets 200 | a kept decision does not expire with its turn |
| step18i, the one writer, a dropped transaction, the watchdog threshold | passes, 11 | can't load, with no `shared/lifecycle.ts` | the status filter removed; the all-or-nothing count removed; the connection listener removed, and the process dies; the threshold's minimum lowered |
| step18j, approvals across two restarts | passes, 8 | no resumed session | an answer counts as delivered only while its command is claimed or done; a denial offered as allowed |
| step18k, an answer during recovery | passes, 4 | Postgres aborts the answer with "deadlock detected" | the session lock removed |
| step18l, a turn that stops its machine every time | passes, 10 | no resumed session | the cap out of reach |

step18d failed once in 5 runs after the rebase onto `360c16e`, on its last assertion: the replaced box still showed `stale` right after the resumed turn ended, and its new container's heartbeat never reached the record in that run. The cause is not found. The check now waits up to 20 seconds, one heartbeat and a margin, for the box to show online, and passed in the break test's green run.

Main's checks pass on the branch rebased onto `94cd4b1`: step1, step2, step3, step4a, step4b, step4c, step4d, step5, step6, step6b, step7, step8, step9, step9b, step10, step10b, step12, step12b and step19. step9b failed once with its people port 7981 taken by another process, and passed when run again. step12c passed as a copy that builds `agents-box:dur-12c`, since it builds a fixed `agents-box:onboard-check` tag that another workstream uses. step2b checks the live server's ports and was not run.

Main's daemon at `360c16e`, run against this branch's API with the fake Claude, looped on the requeue route while its machine showed online, and, already running when the API restarted onto this branch, failed its message with the 400. This branch's daemon looped on recover against main's API.

## Not done

- The gaps in `docs/design/durability.md` under "Not covered": tool commands that outlive a killed Claude on the Mac, lines lost between Claude and the record, a missing conversation, and a session whose machine is gone for good.
- No check covers a fence that can't stop the last run's Claude, or a resumed session the daemon can't read.
- Box images must be rebuilt when this lands, in the order the design doc gives.

## Decisions waiting on Tayler

- Whether this lands with the rollout order, or with the old requeue route kept answering during a transition.
