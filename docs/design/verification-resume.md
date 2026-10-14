# Verification framework: where the work stands

The framework took the evidence and feature map schemas as `shared/verification.ts` on main, byte for byte what this branch first wrote as `shared/evidence.ts`. This branch holds no copy. `shared/evidence.ts` on main is coach's findings, hunks and replay scores, and nothing here imports it.

A note for whoever picks this up, kept current with each commit. The design is in `verification.md` beside this file, and `docs/build-log.md` has a section on this work. Branch `worktree-agent-ae995231ee16af626`, in the worktree `.claude/worktrees/agent-ae995231ee16af626`, rebased onto main at `b2aa8b5`. Nothing is merged to main.

## Decided by Tayler on 2026-10-14

- The `tsconfig.json` and `eslint.config.js` changes that add `ctl` are approved.
- `.claude/skills/verify-agents/` is approved.
- `test/step17.ts` runs in `npm run check` (main's `test/all.ts` runs every `test/step*.ts`). It starts its own instance on ports 8020 to 8039 and takes about 85 seconds.
- Skipping binary files in `test/names.ts` is approved. The skip is not made, so no baselines are committed.
- Known product bugs stay as failing steps in the feature map.

Product bug 7 below, the Firefox console errors, is fixed on main by `9482e4e`. In the five full runs after the stalled-read fix below, step17's captures pass their Firefox console check, so landing this branch no longer turns `npm run check` red on it.

## Done

Everything from the first round (agentsctl, the skill and feature map, the evidence schemas, `shared/cli/`, step17 and its breaks, the docs), then two rounds of review fixes, each with a check seen failing first.

The first review:

1. `db` sends its query as one named statement, so `select 1; commit; update ...` exits 3 and the row stays.
2. `up` refuses with exit 3, before saving any state, when its team or forge org is already there. It records what it made (`made` in the state), and `down` removes only that. The skill no longer names one instance; captures write the instance's name as one fixed name.
3. The API serves people on a socket in the instance's scratch folder, behind `ctl/people.ts`, main's `servePeople` stand-in on the people port. `config()` refuses an `AGENTS_PEOPLE_SOCKET` outside agentsctl's scratch folders, and says whether the shell, `.env.test` or `.env` set it.
4. Heads hold only what the tool knows. Outside text goes in `outside` blocks, fenced in plain output with a marker made fresh for each output and cut inside the fence; `untrusted` names the data fields holding it. `db --value` must be a plain value.
5. Should-fix items: checks and breaks for the live-system guards, a `down` check that can fail, a control run per section in the breaks harness, the baseline reason checked before copying, baselines in the ignored `.scratch/verify/baselines/`, the machine token kept out of output and evidence with everything scrubbed, environments from an allowlist by role, `features/agent-setup.md` (was `agents.md`), and docs that claim only what ran.
6. Notes: locks written whole and stale session locks taken over, waits that notice a dead process, fetch and query timeouts, `map run` counting blocked features, one `messageOf`, no casts in step17, no tailnet name in the map.
7. Main's onboarding, and a sweep on it:
   - A login on no team now asks to join and waits on a page named "Waiting to join". goto takes that page as loaded (it timed out after 15 seconds), and the getting-in step checks it.
   - That request to join is a row of no team, so deleting the team left it. `down` removes join requests, now only those of logins `loginOf` makes for the instance.
   - doctor read only the agents shape's first answer, the snapshot from when the shape was made, so it reported every agent added after up as missing and blamed Electric. It now reads on to up-to-date, as the app does.
   - The approvals gate merged its fix into the team's shop, so pipelines' gate run found the bug fixed and improve, in proposals, replayed other runs. The gate now runs on its own copy, `gate-shop`, which the fake harness's GATEOFF group edits.
   - The browser session client waits a minute past a step's own timeout, so a 600-second wait no longer races its 10-minute limit.
   - sw4, a sweep instance, claimed a box, and its runner started the container from `agents-box:latest`, which looped "waiting for the API" for two hours until `down` removed it. An instance's boxes now start from `agents-box:verify-<instance>`, with `--pull=never`. Nothing builds that tag, so a claimed box records "No such image" and no container runs.
   - step17 prints the first 8 lines of a failed command's own account, and doctor says why a read failed.

The second review:

8. `down` deleted every join request whose login ended with `-<instance>@verify.local`, so `down visual` removed `stranger-my-visual`. It now removes the logins `loginOf` makes for the instance (`isLoginOf` in `ctl/seed.ts`), and a person's name has no dash, so `--as stranger-y` is refused with exit 2. step17 leaves a `stranger-y-<instance>` request and checks `down` did not touch it.
9. Three heads carried outside text. A failed `db --expect` named the row's value, `browser select` with a missing choice listed the page's options, and doctor's "people door answers" embedded the server's reply. Each is in `outside` now (`PageError` in `ctl/driver.ts` carries the page's words, and `Check.outside` in `ctl/instance.ts` the server's). `visual shot` lists `data.outside` as untrusted.
10. `machine read` printed the machine's secret values for `secrets.json`. It now prints `[secret:NAME]` for each value the machine holds, as typed and as `secrets.json` spells it with JSON escapes.
11. `down --keep-data` left the name refused for good. The instance is now in a `kept` phase (`ctl/state.ts`). `up` refuses the name and names `down --instance <name>`, and that `down` removes what was kept. `--keep-data` again says `already: true`.
12. One definition each: `hasCode` in `shared/errors.ts` (`server/api.ts` imports it), the pipeline hook secret in `shared/pipeline-hooks.ts`, and the box container and volume names in `shared/box-names.ts`. `ensureOrg` moved into step17, its only caller, and left `server/forge.ts`.
13. Breaks for the team removal check (`team-removal`) and the forged marker check (`fixed-markers`, which restores fixed markers). Each fix above has a check in step17 and a break in `test/step17-breaks.ts`.

Found while proving it:

14. The visual captures timed out in two of the first five full step17 runs of this round: "the page still had 1 reads in flight after 15s". Chromium reports no end for a read that is in flight when its page loads another document, where Firefox and WebKit report it aborted. A page whose fetch never answers, sent to `about:blank`, shows it in all three. The driver kept the read in its set, so `settle()` waited on it for good. `visual shot` reloads the page it was driven on, so a first message to a new session left one behind, and in one session all 20 captures failed. `goto` now drops the old document's reads before it leaves it, and step17 has a check (a page that stalls a read, then the app again) with a break (`stale-reads`). After the fix five full runs passed all 97 checks, and the first messages that failed before passed.

The last full `node test/step17.ts`, on `1a0542b`, passed all 97 of its checks in about 85 seconds. `test/step17-breaks.ts` holds 84 breaks. All 84 turned a check red that passed in its control, in one full run on `1a0542b` that took 29 minutes. 88 of the 106 checks the control runs make have a break, and the other 18 have none. `npm run typecheck`, `npm run lint` and `node test/names.ts` pass.

The last full sweep, `map run all --keep-going` on instance `sw4`, ran on `360c16e` with an earlier round's fixes in 4 minutes 39 seconds. Of its 100 steps, 90 passed live, 4 failed on product bugs 1 to 4, and the 6 that need real Claude were blocked. machines passed all 6 steps again on `94cd4b1`, after boxes moved to their own image tag. No sweep has run since.

## In progress

Nothing is running, and no instance is left.

One lead stays open:

- The stale-lock race in `ctl/ports.ts`. A port lock counts as stale when its instance has no state file, and `up` writes the state file only after `claimPorts` returns. For those few milliseconds a new lock looks stale, so a second `up` removes it and claims the same ports, and the bind test stops it only when the two tests overlap. Only one process can listen on each port, so the two instances' processes fight over them. A test of `claimPorts` in two processes, the second starting up to 12 ms after the first, gave both the same block in 104 of 120 tries. Of 31 pairs of real `up`s started up to 30 ms apart, 24 pinned to `--port 8020`, one pair took the same block, and both failed with exit 1, each on `EADDRINUSE` (a people process and an API). The rest took different blocks or one was refused. It is not fixed. A fix is to call a lock stale only when the process that wrote it is gone as well.

Never build or tag `agents-box:latest`: the live server starts its boxes from it. agentsctl builds no image, and an instance's boxes use their own tag. After any check that builds an image, run `docker image prune -f`.

## Product bugs found

1. A working agent that cannot restart does not say why. Recorded twice (`.scratch/verify/evidence/m1-20261013T165556Z/videos/001-*.webm`, `002-*.webm`). The old harness process, stopped for the restart, reports `idle` over the failure, because `daemon/agentsd.ts` still holds it when the new start fails.
2. improve cannot be started from the app on a repo named `pipelines` (`StartRun` in `app/src/Pipeline.tsx`). Recorded twice (`.scratch/verify/evidence/repro-20261013T205032Z/videos/001-recording.webm`, `002-recording.webm`).
3. Session details names the model a session started on (`sessions.model` is written once). Recorded twice (same folder, `003-*.webm`, `004-*.webm`, and `screens/`).
4. Accessibility, serious. A pipeline's file scrolls but cannot take keyboard focus.
5. Found by reading, not reproduced. `act()` in `app/src/data.ts` raises `app-error`, which nothing listens for.
6. Minor. The `main` landmark is labelled "Conversation" on non-conversation views; the Agents list has no order of its own; choosing a stage in Running now right after a page load opens the task, not the run.
7. Fixed. From main's onboarding merge (`360c16e`) until `9482e4e`, Firefox logged two console errors on every page load, because zod probed `new Function` and the app's Content-Security-Policy (`script-src 'self'`) blocks that. `app/src/zod-config.ts` turns the probe off. Step17 found it, and its Firefox captures pass again.

No second agent has watched the recordings.

## Not done, and why

- No step tagged (real Claude) has run, to save Tayler's usage.
- No baselines are committed. Tayler approved skipping binary files in `test/names.ts`, but the skip is not made. A full sweep with captures, twice, to measure the noise between two, comes after it.
- A full sweep with captures. Step17's captures of one view pass in all three engines, and no sweep of every view has run since main's fix.
- 18 of the checks the control runs make have no break; the breaks harness lists them.
- The onboarding features (invites, Wants to join, the Tailscale page, a box per person, Claude sign-in) have no steps in the map. main's `test/step12.ts`, `step12b.ts` and `step12c.ts` check them.
- The `verify-create` and `verify-maintain` pipeline files.

## What a fresh agent must know

- Read `AGENTS.md` first. It binds this work.
- Run Node from `~/.local/node/bin`, and have `/opt/homebrew/bin` on PATH for `docker`.
- The worktree has its own `node_modules` from `npm ci`. Never install through a link to main's.
- Never touch the live system: no launchd `com.agents.*`, never the `agents` database, ports 8020 to 8039 only, teams named `verify-*`, never restart or prune shared Docker containers, volumes or images.
- Before any check that uses port 7701, take the lock with `mkdir ~/.agents-app/checks/run.lock`, and `rmdir` it after. step17 uses 8020 to 8039.
- While `test/step17-breaks.ts` runs, edit nothing it breaks (`ctl/`, `shared/`, `app/src/`, `features/getting-in.md`) or `test/step17.ts`: it restores each file from its own copy. `--check` finds every anchor once, without running anything. A run killed midway leaves one break applied until the next `node test/step17-breaks.ts`, even `--check`, restores it, so read `git diff` before trusting the tree.
- `map run all` runs the features in the index's order on one instance, so a feature can change what a later one finds. approvals runs before pipelines and proposals.
- `down --keep-data` leaves the instance `kept`. `list` shows it, `up` refuses its name, and `bin/agentsctl down --instance <name>` removes what it kept.
- Beside `ctl/`, the branch changes four server files by a few lines each. `server/forge.ts` lets `ensureRepo` take the org it makes a repo in, and `server/api.ts`, `server/boxes.ts` and `server/hooks.ts` each import a definition from `shared/` in place of a copy. `shared/` gains `cli/`, `box-names.ts`, `pipeline-hooks.ts` and `hasCode` in `errors.ts`, the only copy of `hasCode`.
- Tayler approved this branch's `tsconfig.json`, `eslint.config.js` and `.claude/skills/verify-agents/` changes. A new change to those files, to `.claude/` or to `test/names.ts` needs approval again.

## Open questions for Tayler

None.
