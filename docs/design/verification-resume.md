# Verification framework: where the work stands

`shared/evidence.ts` is in its own commit, for the framework branch to take. Rebases change its id; `git log --format=%H -1 -- shared/evidence.ts` finds it.

A note for whoever picks this up, kept current with each commit. The design is in `verification.md` beside this file, and `docs/build-log.md` has a section on this work. Branch `worktree-agent-ae995231ee16af626`, in the worktree `.claude/worktrees/agent-ae995231ee16af626`, rebased onto main at `94cd4b1`. Nothing is merged to main.

## For Tayler first

`test/step17.ts` runs in `npm run check` (main's `test/all.ts` runs every `test/step*.ts`). It starts its own instance on ports 8020 to 8039 and takes about a minute.

On main at `94cd4b1` it fails one of its 84 checks, on product bug 7 below: Firefox logs two console errors on every page load since the onboarding merge, so step17's visual capture fails in Firefox. Fix that before this branch lands, or `npm run check` goes red.

## Done

Everything from the first round (agentsctl, the skill and feature map, `shared/evidence.ts`, `shared/cli/`, step17 and its breaks, the docs), and then the code review's fixes, each with a check seen failing first:

1. `db` sends its query as one named statement, so `select 1; commit; update ...` exits 3 and the row stays.
2. `up` refuses with exit 3, before saving any state, when its team or forge org is already there. It records what it made (`made` in the state), and `down` removes only that. The skill no longer names one instance; captures write the instance's name as one fixed name.
3. The API serves people on a socket in the instance's scratch folder, behind `ctl/people.ts`, main's `servePeople` stand-in on the people port. `config()` refuses an inherited `AGENTS_PEOPLE_SOCKET` outside agentsctl's scratch folders.
4. Heads hold only what the tool knows. Outside text goes in `outside` blocks, fenced in plain output with a marker made fresh for each output and cut inside the fence; `untrusted` names the data fields holding it. `db --value` must be a plain value.
5. Should-fix items: checks and breaks for the live-system guards, a `down` check that can fail, a control run per section in the breaks harness, the baseline reason checked before copying, baselines in the ignored `.scratch/verify/baselines/`, the machine token kept out of output and evidence with everything scrubbed, environments from an allowlist by role, `features/agent-setup.md` (was `agents.md`), and docs that claim only what ran.
6. Notes: locks written whole and stale session locks taken over, waits that notice a dead process, fetch and query timeouts, `map run` counting blocked features, one `messageOf` and `hasCode`, no casts in step17, no tailnet name in the map.
7. Main's onboarding, and a sweep on it:
   - A login on no team now asks to join and waits on a page named "Waiting to join". goto takes that page as loaded (it timed out after 15 seconds), and the getting-in step checks it.
   - That request to join is a row of no team, so deleting the team left it. `down` removes the join requests of the instance's own logins, and the two breaks that open the app with a wrong login keep the instance's suffix.
   - doctor read only the agents shape's first answer, the snapshot from when the shape was made, so it reported every agent added after up as missing and blamed Electric. It now reads on to up-to-date, as the app does.
   - The approvals gate merged its fix into the team's shop, so pipelines' gate run found the bug fixed and improve, in proposals, replayed other runs. The gate now runs on its own copy, `gate-shop`, which the fake harness's GATEOFF group edits.
   - The browser session client waits a minute past a step's own timeout, so a 600-second wait no longer races its 10-minute limit.
   - sw4, a sweep instance, claimed a box, and its runner started the container from `agents-box:latest`, which looped "waiting for the API" for two hours until `down` removed it. An instance's boxes now start from `agents-box:verify-<instance>`, with `--pull=never`. Nothing builds that tag, so a claimed box records "No such image" and no container runs.
   - step17 prints the first 8 lines of a failed command's own account, and doctor says why a read failed.

The last full `node test/step17.ts`, on `94cd4b1`, passed 83 of its 84 checks in about a minute, and the one that failed is product bug 7. `test/step17-breaks.ts` holds 67 breaks. All 67 count in one full run on `94cd4b1`: each turned a check red that passed in the control. 73 of the 93 checks the control runs make have a break. `npm run typecheck`, `npm run lint` and `node test/names.ts` pass.

The last full sweep, `map run all --keep-going` on instance `sw4`, ran on `360c16e` with this round's fixes in 4 minutes 39 seconds. Of its 100 steps, 90 passed live, 4 failed on product bugs 1 to 4, and the 6 that need real Claude were blocked. machines passed all 6 steps again on `94cd4b1`, after boxes moved to their own image tag.

## In progress

Nothing is running, and no instance is left.

The colima VM's disk filled at about 21:45 on 2026-10-13, and Postgres logged "No space left on device". The coordinator freed it, and Postgres and both Electrics restarted at 21:49. The test Electric then logged shape consumers crashing and writers removed for making no progress. Every check after that passed except as said here.

One lead stays open: in one control run on 2026-10-13, two of the page's reads hung for 15 seconds during a visual capture. It has not happened in any visual run since. A capture that times out names the reads still in flight.

Never build or tag `agents-box:latest`: the live server starts its boxes from it. agentsctl builds no image, and an instance's boxes use their own tag. After any check that builds an image, run `docker image prune -f`.

## Product bugs found

1. A working agent that cannot restart does not say why. Recorded twice (`.scratch/verify/evidence/m1-20261013T165556Z/videos/001-*.webm`, `002-*.webm`). The old harness process, stopped for the restart, reports `idle` over the failure, because `daemon/agentsd.ts` still holds it when the new start fails.
2. improve cannot be started from the app on a repo named `pipelines` (`StartRun` in `app/src/Pipeline.tsx`). Recorded twice (`.scratch/verify/evidence/repro-20261013T205032Z/videos/001-recording.webm`, `002-recording.webm`).
3. Session details names the model a session started on (`sessions.model` is written once). Recorded twice (same folder, `003-*.webm`, `004-*.webm`, and `screens/`).
4. Accessibility, serious. A pipeline's file scrolls but cannot take keyboard focus.
5. Found by reading, not reproduced. `act()` in `app/src/data.ts` raises `app-error`, which nothing listens for.
6. Minor. The `main` landmark is labelled "Conversation" on non-conversation views; the Agents list has no order of its own; choosing a stage in Running now right after a page load opens the task, not the run.
7. Since main's onboarding merge (`360c16e`), Firefox logs two console errors on every page load. The app now bundles zod, which probes `new Function` as the app's schemas are made, and the app's Content-Security-Policy (`script-src 'self'`) blocks the probe, which Firefox logs. Chromium and WebKit log nothing. Seen in every step17 run since the rebase onto it, and once by hand. `z.config({ jitless: true })`, in a module `app/src/main.tsx` imports first, skips the probe: tried, Firefox logged no error at either width, and the change was taken out again, since this branch does not change product code.

No second agent has watched the recordings.

## Not done, and why

- No step tagged (real Claude) has run, to save Tayler's usage.
- No baselines are committed, until Tayler approves a binary skip in `test/names.ts`.
- A full sweep with captures, and the noise between two. Until bug 7 is fixed, every Firefox capture fails its console check.
- 20 of the 93 checks the control runs make have no break; the breaks harness lists them.
- The onboarding features (invites, Wants to join, the Tailscale page, a box per person, Claude sign-in) have no steps in the map. main's `test/step12.ts`, `step12b.ts` and `step12c.ts` check them.
- The `verify-create` and `verify-maintain` pipeline files.

## What a fresh agent must know

- Read `AGENTS.md` first. It binds this work.
- Run Node from `~/.local/node/bin`, and have `/opt/homebrew/bin` on PATH for `docker`.
- The worktree has its own `node_modules` from `npm ci`. Never install through a link to main's.
- Never touch the live system: no launchd `com.agents.*`, never the `agents` database, ports 8020 to 8039 only, teams named `verify-*`, never restart or prune shared Docker containers, volumes or images.
- Before any check that uses port 7701, take the lock with `mkdir ~/.agents-app/checks/run.lock`, and `rmdir` it after. step17 uses 8020 to 8039.
- While `test/step17-breaks.ts` runs, edit nothing it breaks (`ctl/`, `shared/`, `app/src/`, the feature files): it restores each from its own copy. `--check` finds every anchor once, without running anything.
- `map run all` runs the features in the index's order on one instance, so a feature can change what a later one finds. approvals runs before pipelines and proposals.
- This branch changes `tsconfig.json` and `eslint.config.js` (adding `ctl`) and adds `.claude/skills/verify-agents/`. `AGENTS.md` says changes there need Tayler's approval.

## Open questions for Tayler

- Fix product bug 7 before this branch lands? It is one line in the app.
- Approve skipping binary files in `test/names.ts`, so visual baselines can be committed?
- Approve the `tsconfig.json`, `eslint.config.js` and `.claude/skills/verify-agents/` changes?
- Should known product bugs stay as failing steps in the feature map, or move to a list the runner skips?
