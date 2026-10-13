# Verification framework: where the work stands

`shared/evidence.ts` is commit `b729f4d8659ec943176ec1e1899deb322b12ab62`, alone in its commit, for the framework branch to take. If this branch is rebased again, the id changes; `git log --format=%H -1 -- shared/evidence.ts` finds it.

A note for whoever picks this up, kept current with each commit. The design is in `verification.md` beside this file. Branch `worktree-agent-ae995231ee16af626`, in the worktree `.claude/worktrees/agent-ae995231ee16af626`, rebased onto main at `deec329`. Nothing is merged to main.

## Done, with commits

- `35fc535` Forge sets up repos in an org other than the team's (`server/forge.ts`, `ensureOrg`), so a verify instance's repos live in their own org and `down` deletes the org whole.
- `90899e7` First `bin/agentsctl` (a link to `ctl/main.ts`) and `ctl/`.
- `5999df4` (wip) The Driver interface (`ctl/driver.ts`) with Playwright behind it (`ctl/playwright.ts`), one output envelope and exit codes (`ctl/output.ts`), the map runner, checker and guard (`ctl/map.ts`), visual compare and baseline (`ctl/visual.ts`, `ctl/png.ts`), the skill and its twelve feature files (`.claude/skills/verify-agents/`), the pipeline design (`docs/design/verification.md`) and `test/step17.ts`.
- `591f868` Feature map fixes from the first full sweep, and `8e8f1ef` three driver checks that now say what is wrong (both listed under the sweep below).
- `b729f4d` `shared/evidence.ts`: the evidence manifest, the feature map, the verdict ladder.

Since the rebase the worktree has its own `node_modules` from `npm ci`, and `npm run typecheck`, `npm run lint` and `node test/names.ts` pass.

What the CLI does today, each driven live on an instance at least once: `up`, `doctor`, `down`, `list`, `evidence`, `browser` and `desktop` ops (goto, click, fill, select, check, press, type, wait, text, count, snapshot, screenshot, console, network, trace, record, overflow, a11y, focus, tab-to, reset), `api`, `db` (read-only), `seed`, `secret`, `machine read`, `visual shot|compare|baseline`, `map list|check|guard|run`, plus `--json`, `--dry-run`, `--full` and a dashboard with no arguments.

Not built or not proven yet: `test/step17.ts` has never run; `test/step17-breaks.ts` does not exist, so no subcommand's check has been seen failing; there are no visual baselines; `map guard` has not been run against a base that has the map; no step tagged (real Claude) has run.

## The last full sweep

Instance `m5`, `map run all --keep-going`, without `--visual`. Report in `.scratch/verify/evidence/m5-20261013T172318Z/map/` (scratch, not committed).

- live-ui-verified, every step: getting-in 6/6, agents 13/13, documents 8/8, secrets 5/5, machines 6/6, journeys 2/2.
- tasks 6/7 and conversations 13/16, where the interrupt steps wait for real Claude.
- sessions 7/10, pipelines 11/13, proposals 3/6, approvals 0/8.

Fixed since, where the map or the driver was at fault, and not yet rerun live: approvals' preconditions no longer block the whole file; proposals expect their kickers in capitals, as shown; the record search expects fixer's room post, since search leaves out the asking session's own conversation; Running now waits for the run to load before choosing it; `doctor` compares Electric's agents with the database and names any it lacks; `browser select` names a missing choice and what the box offers; `browser network` reports requests the page cancelled itself apart from failures. Each known product bug is noted, dated, in its feature file's gotchas, and its step stays as the proof of a fix.

## In progress

The coordinator's review findings are done:

1. `shared/evidence.ts`, committed alone (id at the top of this note).
2. agentsctl writes and reads evidence only through it (`08450d8`). `visual shot` lists each capture in the run's `evidence.json` and copies it to `.scratch/verify/evidence.json`; `visual compare` and `baseline` read captures from the manifest and check each sha256; each feature file carries its map entry, `map export` writes `features.json`, and `map check` fails when they differ (seen failing, then passing once restored). Engines, widths and verdicts come from the shared module; the flag is `--width`, and `visual baseline` takes `--view`.
3. `docs/design/verification.md` claims only what was built and run, by the evidence folders' action logs, and lists what is not done.

Next is the shared CLI library (next steps, 1).

## Product bugs found

Each needs two reproductions through the real UI, each recorded, and a second agent confirming the video. I can't start agents, so the second look is open.

1. A working agent that cannot restart does not say why. writer's session runs, a plugin needing a missing secret is added, the next message restarts the session, and the "no value for NOTES_TOKEN" notice never shows. Reproduced twice with recordings in `.scratch/verify/evidence/m1-20261013T165556Z/videos/001-*.webm` and `002-*.webm`.
2. improve cannot be started from the app on a repo named `pipelines`. `StartRun` in `app/src/Pipeline.tsx` drops every repo whose URL ends `/pipelines.git`, for every pipeline, though pipeline files can live in any repo (`server/pipelines.ts`) and improve's study stage works in `./<repo>/pipelines`. `test/step9b.ts` names its repo `pipes9b-<id>`, so it never meets the filter. Seen once in the sweep; record two reproductions.
3. Session details shows the model a session started on, not the one it runs on. `sessions.model` is written once at insert (`server/record.ts`, `conversationSession`), while each message's command carries the agent's current model. Change fixer to sonnet and message it, and the panel still says haiku while the command says sonnet. Seen once; record two reproductions.
4. Accessibility, serious. The pipeline file's `<pre>` on a pipeline's page scrolls but cannot take keyboard focus (axe `scrollable-region-focusable`).
5. Found by reading, not reproduced. `act()` in `app/src/data.ts` dispatches an `app-error` event that nothing listens for, on main too, so an action button that fails says nothing. Its comment says an alert banner shows the error.
6. Minor. The `main` landmark is labelled "Conversation" on the home, New task, New room and New agent views.
7. Minor race. Choosing a stage's session in Running now in the first moment after the page loads opens the run's task, not the run, because the sidebar's runs have not loaded yet.

## Environment trouble seen

At 17:34:11 UTC on 2026-10-13 the shared test Electric (`agents-electric-test-1`) logged `emfile` (too many open files) and its shape writers exited. Shapes made before that stop updating: `doctor` on `m5` fails its Electric check, since the agents shape lacks agents the database holds. New shapes are still created. I did not restart the container, since other agents share it. A fresh instance gets fresh shapes, but heavy parallel use may trip it again.

## Next steps, in order

1. The shared CLI library, from the coordinator's GitHub CLI evaluation, with no GitHub logic in it, for agents-git to import later. It holds the output envelope, exit codes 0 to 3, error types, a zod command definition that generates help and rejects unknown flags (exit 2, listing the valid ones), a dispatcher, the renderer, the guard against suggesting the command just run, and a helper marking outside text as untrusted. Its rules: an empty result is never confused with a failed read; lists carry totals ("30 of 847") and say when empty, with `--fields` for more; long text is cut with its full size stated and `--full`; results go to stdout; an `ok:` line is built from a re-read of the new state; `already: true` is the one spelling. Ship a conformance check any CLI can run, and use it in step17.
2. `bin/agentsctl down --instance m5`, then `up --pipelines` on a new name and rerun sessions, approvals, proposals and pipelines with `map run <feature>`.
3. Run `test/step17.ts` until green.
4. Write `test/step17-breaks.ts`. For each subcommand, apply one break (scripted, asserting its anchor appears exactly once), run step17, confirm the targeted check fails, restore byte for byte, confirm green. Record which check went red for each.
5. A real Claude instance (`up --claude real --pipelines`) for the `(real Claude)` steps in approvals, conversations and tasks.
6. Visual baselines: a fresh `up --pipelines`, `map run all --visual --keep-going`, look at the captures, capture again to measure noise, then `visual baseline --reason "..."` into `.claude/skills/verify-agents/baselines/` and `visual compare`.
7. `map guard --base main` once the map is on main, seen failing when a step's expectation is dropped.
8. Docs: a README section on running and driving the app with agentsctl, an entry in `docs/what-each-part-does.md`, and a build-log section with the sweep's verdicts, the bugs, the breaks and the baseline size.
9. `npm run typecheck`, `npm run lint`, `node test/names.ts`, then small commits.

## What a fresh agent must know

- Read `AGENTS.md` first. It binds this work.
- Run Node from `~/.local/node/bin` (`export PATH="$HOME/.local/node/bin:$PATH"`). The `node` in `/usr/local/bin` is a launcher that can't load native packages.
- The worktree has its own `node_modules` from `npm ci`. Never install through a link to main's.
- Never touch the live system: no launchd `com.agents.*`, never the `agents` database (agentsctl refuses anything but `.env.test`'s database ending `_test`), ports 8020 to 8039 only, teams named `verify-*`, never restart shared Docker containers.
- Before any check that uses port 7701, take the lock with `mkdir ~/.agents-app/checks/run.lock`, and `rmdir` it after. Never `npm run check`.
- Tayler's desktop app runs on this Mac. agentsctl's Electron uses its own `--user-data-dir` and HOME, so the two never share state.
- Never name the projects, companies or people this work learned from. `node test/names.ts` checks it.
- This branch changes `tsconfig.json` and `eslint.config.js` (adding `ctl`) and adds `.claude/skills/verify-agents/`. `AGENTS.md` says changes there need Tayler's approval.

## Open questions for Tayler

- Should known product bugs stay as failing steps in the feature map (my choice, so a fix is proven when the step passes), or move to a known-bugs list that the runner skips?
- The test Electric ran out of file handles under seven agents at once. Raise its limit, or give each agent its own Electric?
- Running the pipelines on a box needs Postgres, Electric and three browsers in the box image. Is that wanted, or should the live stage stay on the server Mac?
- Approve the `tsconfig.json`, `eslint.config.js` and `.claude/skills/verify-agents/` changes?
