# Verification framework: where the work stands

`shared/evidence.ts` is in its own commit, for the framework branch to take. Rebases change its id; `git log --format=%H -1 -- shared/evidence.ts` finds it.

A note for whoever picks this up, kept current with each commit. The design is in `verification.md` beside this file, and `docs/build-log.md` has a section on this work. Branch `worktree-agent-ae995231ee16af626`, in the worktree `.claude/worktrees/agent-ae995231ee16af626`, rebased onto main at `47a2d31`. Nothing is merged to main.

## For Tayler first

`test/step17.ts` now runs in `npm run check` (main's `test/all.ts` runs every `test/step*.ts`). It starts its own instance on ports 8020 to 8039 and takes about a minute.

## Done

Everything from the first round (agentsctl, the skill and feature map, `shared/evidence.ts`, `shared/cli/`, step17 and its breaks, the docs), and then the code review's fixes, each with a check seen failing first:

1. `db` sends its query as one named statement, so `select 1; commit; update ...` exits 3 and the row stays.
2. `up` refuses with exit 3, before saving any state, when its team or forge org is already there. It records what it made (`made` in the state), and `down` removes only that. The skill no longer names one instance; captures write the instance's name as one fixed name.
3. The API serves people on a socket in the instance's scratch folder, behind `ctl/people.ts`, main's `servePeople` stand-in on the people port. `config()` refuses an inherited `AGENTS_PEOPLE_SOCKET` outside agentsctl's scratch folders.
4. Heads hold only what the tool knows. Outside text goes in `outside` blocks, fenced in plain output with a marker made fresh for each output and cut inside the fence; `untrusted` names the data fields holding it. `db --value` must be a plain value.
5. Should-fix items: checks and breaks for the live-system guards, a `down` check that can fail, a control run per section in the breaks harness, the baseline reason checked before copying, baselines in the ignored `.scratch/verify/baselines/`, the machine token kept out of output and evidence with everything scrubbed, environments from an allowlist by role, `features/agent-setup.md` (was `agents.md`), and docs that claim only what ran.
6. Notes: locks written whole and stale session locks taken over, waits that notice a dead process, fetch and query timeouts, `map run` counting blocked features, one `messageOf` and `hasCode`, no casts in step17, no tailnet name in the map.

The last full `node test/step17.ts` passed all 80 checks. The last full `node test/step17-breaks.ts` counted 57 of 61 breaks (a check that passed in the control and failed under the break). `npm run typecheck`, `npm run lint` and `node test/names.ts` pass.

## In progress, and blocked

The colima VM's disk is full (60 GB, 57.8 GB of it Docker images, 36.5 GB reclaimable, none made by this work), so the forge refuses writes with `database or disk is full`. Until someone frees space:

- Instance `s17-919476` is half down: its processes are stopped, and its team, forge org and state file wait for `bin/agentsctl down --instance s17-919476`, which carries on where it stopped.
- Four breaks need a rerun: `node test/step17-breaks.ts db-multi fence manifest compare-threshold`. db-multi's check had a placeholder, which made it a parameterized query either way, and fence's break named a renamed rule; both are fixed. manifest and compare-threshold turned red, but their control run had two of the page's reads hang for 15 seconds. A capture that times out now names the reads still in flight, to find why.
- Then a full `node test/step17.ts`.

Never build or tag `agents-box:latest`. agentsctl doesn't; an instance's API only starts containers from it when a box is claimed.

## Product bugs found

1. A working agent that cannot restart does not say why. Recorded twice (`.scratch/verify/evidence/m1-20261013T165556Z/videos/001-*.webm`, `002-*.webm`). The old harness process, stopped for the restart, reports `idle` over the failure, because `daemon/agentsd.ts` still holds it when the new start fails.
2. improve cannot be started from the app on a repo named `pipelines` (`StartRun` in `app/src/Pipeline.tsx`). Recorded twice (`.scratch/verify/evidence/repro-20261013T205032Z/videos/001-recording.webm`, `002-recording.webm`).
3. Session details names the model a session started on (`sessions.model` is written once). Recorded twice (same folder, `003-*.webm`, `004-*.webm`, and `screens/`).
4. Accessibility, serious. A pipeline's file scrolls but cannot take keyboard focus.
5. Found by reading, not reproduced. `act()` in `app/src/data.ts` raises `app-error`, which nothing listens for.
6. Minor. The `main` landmark is labelled "Conversation" on non-conversation views; the Agents list has no order of its own; choosing a stage in Running now right after a page load opens the task, not the run.

No second agent has watched the recordings.

## Not done, and why

- No step tagged (real Claude) has run, to save Tayler's usage.
- No baselines are committed, until Tayler approves a binary skip in `test/names.ts`.
- A full sweep with captures, and the noise between two.
- `down`'s removal of box containers has never had one to remove.
- 21 of step17's 88 checks have no break; the breaks harness lists them.
- The `verify-create` and `verify-maintain` pipeline files.

## What a fresh agent must know

- Read `AGENTS.md` first. It binds this work.
- Run Node from `~/.local/node/bin`, and have `/opt/homebrew/bin` on PATH for `docker`.
- The worktree has its own `node_modules` from `npm ci`. Never install through a link to main's.
- Never touch the live system: no launchd `com.agents.*`, never the `agents` database, ports 8020 to 8039 only, teams named `verify-*`, never restart or prune shared Docker containers, volumes or images.
- Before any check that uses port 7701, take the lock with `mkdir ~/.agents-app/checks/run.lock`, and `rmdir` it after. step17 uses 8020 to 8039.
- While `test/step17-breaks.ts` runs, edit nothing it breaks (`ctl/`, `shared/`, `app/src/`, the feature files): it restores each from its own copy. `--check` finds every anchor once, without running anything.
- This branch changes `tsconfig.json` and `eslint.config.js` (adding `ctl`) and adds `.claude/skills/verify-agents/`. `AGENTS.md` says changes there need Tayler's approval.

## Open questions for Tayler

- Approve skipping binary files in `test/names.ts`, so visual baselines can be committed?
- Approve the `tsconfig.json`, `eslint.config.js` and `.claude/skills/verify-agents/` changes?
- Free the colima VM's disk, and raise the test Electric's file limit or give each agent its own?
- Should known product bugs stay as failing steps in the feature map, or move to a list the runner skips?
