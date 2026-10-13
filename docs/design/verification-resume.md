# Verification framework: where the work stands

A note for whoever picks this up, kept current with each commit. The design is in `verification.md` beside this file. Branch `worktree-agent-ae995231ee16af626`, in the worktree `.claude/worktrees/agent-ae995231ee16af626`. Nothing is merged to main.

## Done, with commits

- `e3a743a` Forge sets up repos in an org other than the team's (`server/forge.ts`, `ensureOrg`), so a verify instance's repos live in their own org and `down` deletes the org whole.
- `f93c574` First `bin/agentsctl` (symlink to `ctl/main.ts`) and `ctl/`.
- `c934ef8` Left `.gitignore` as main has it. agentsctl's state lives under `.scratch/verify`, which main already ignores.
- `0eba4a3` Merged main at `76a15bb` (the name guard).
- `ed37e16` (wip) Everything since: the Driver interface (`ctl/driver.ts`) with Playwright behind it (`ctl/playwright.ts`), one output envelope and exit codes (`ctl/output.ts`), the map runner, checker and guard (`ctl/map.ts`), visual compare and baseline (`ctl/visual.ts`, `ctl/png.ts`), the skill and its twelve feature files (`.claude/skills/verify-agents/`), the pipeline design (`docs/design/verification.md`) and `test/step17.ts`.

What the CLI does today, all driven live on an instance: `up`, `doctor`, `down`, `list`, `evidence`, `browser` and `desktop` ops (goto, click, fill, select, check, press, type, wait, text, count, snapshot, screenshot, console, network, trace, record, overflow, a11y, focus, tab-to, reset), `api`, `db` (read-only), `seed`, `secret`, `machine read`, `visual shot|compare|baseline`, `map list|check|guard|run`, plus `--json`, `--dry-run`, `--full` and a dashboard with no arguments.

## The last full sweep

Instance `m5`, `map run all --keep-going`, without `--visual`. Report in `.scratch/verify/evidence/m5-20261013T172318Z/map/` (scratch, not committed).

- live-ui-verified, every step: getting-in 6/6, agents 13/13, documents 8/8, secrets 5/5, machines 6/6, journeys 2/2.
- tasks 6/7 and conversations 13/16, where the interrupt steps wait for real Claude.
- sessions 7/10, pipelines 11/13, proposals 3/6, approvals 0/8. The causes are below.

## In progress

Fixing what the sweep found. Each failure is sorted as doc drift (fix the feature file), a harness gap (fix `ctl/`), or a product bug (keep the step, report the bug).

Doc drift, not yet fixed in the files:

- `approvals.md` preconditions hold the code span `bin/agentsctl up --claude real`, so the runner marks the whole feature as needing real Claude and blocks all eight steps. Rewrite the precondition without an `up` code span carrying flags (say `--claude real` and `--pipelines` alone); the per-step tags `(real Claude)` and `(pipelines)` already do the blocking.
- `proposals.md` expects "Proposed instructions change · waiting for the shepherd", but the kicker is uppercased by CSS and `innerText` returns "PROPOSED INSTRUCTIONS CHANGE · WAITING FOR THE SHEPHERD". Expect the uppercase text, in all three steps that read the kicker.
- `sessions.md` "An agent searches the team record" expects "checkout total", which is ada's DM post. Search leaves out the asking session's own conversation (`server/teamrecord.ts`), so it can never be there. Expect fixer's room post, "I will take the", and check the DM post is absent.
- `sessions.md` "Running now shows a stage at work" clicked the Running now entry before the sidebar's runs had loaded, and the app opened the run's task, which has no Cancel run button. Wait for the run in `list:Runs` before clicking. A click that early going to the task is a small product race worth a line in the report, not a bug by the bar below.

Harness gaps, not yet fixed in `ctl/`:

- `doctor`'s Electric check says "the agents shape lists ..." even when it fails. Compare the shape with the team's agents in the database and name the missing ones.
- `browser select` reports "combobox ... was not there" when the box is there and the option is not. Say which option is missing and what the box offers.
- `browser network` counts a request the page cancelled itself (`net::ERR_ABORTED`) as failed. `app/src/live.ts` aborts its HEAD poll on purpose when a turn ends. Report cancelled requests apart from failed ones.
- Optional: `api --expect-no-text`, for the search step's absence check.

## Product bugs found

Each needs two reproductions through the real UI, each recorded, and a second agent confirming the video. I can't start agents, so the second look is open.

1. A working agent that cannot restart does not say why. writer's session runs, a plugin needing a missing secret is added, the next message restarts the session, and the "no value for NOTES_TOKEN" notice never shows. Reproduced twice with recordings in `.scratch/verify/evidence/m1-20261013T165556Z/videos/001-*.webm` and `002-*.webm`.
2. improve cannot be started on the pipelines repo from the app. `StartRun` in `app/src/Pipeline.tsx` drops every repo ending `/pipelines.git`, for every pipeline, and improve's study stage works in `./<repo>/pipelines`. Seen once in the sweep; record two reproductions.
3. Session details shows the model a session started on, not the one it runs on. `sessions.model` is written once at insert (`server/record.ts`, `conversationSession`), while each message's command carries the agent's current model. Change fixer to sonnet and message it, and the panel still says haiku while the command says sonnet. Seen once; record two reproductions.
4. Accessibility, serious. The pipeline file's `<pre>` on a pipeline's page scrolls but cannot take keyboard focus (axe `scrollable-region-focusable`).
5. Found by reading, not reproduced. `act()` in `app/src/data.ts` dispatches an `app-error` event that nothing listens for, on main too, so an action button that fails says nothing. Its comment says an alert banner shows the error.
6. Minor. The `main` landmark is labelled "Conversation" on the home, New task, New room and New agent views.

## Environment trouble seen

At 17:34:11 UTC on 2026-10-13 the shared test Electric (`agents-electric-test-1`) logged `emfile` (too many open files) and its shape writers exited. Shapes made before that stop updating: `doctor` on `m5` now fails its Electric check, since the agents shape lacks agents the database holds. New shapes are still created. I did not restart the container, since other agents share it. Report it to Tayler; a fresh instance gets fresh shapes, but heavy parallel use may trip it again.

## Next steps, in order

1. Make the doc and harness fixes above. Typecheck with `env PATH=~/.local/node/bin:/usr/bin:/bin node_modules/.bin/tsc` and lint with `node_modules/.bin/eslint ctl test/step17.ts` on the same PATH.
2. `bin/agentsctl down --instance m5`, then `up --pipelines` on a new name and rerun sessions, approvals, proposals and pipelines with `map run <feature>`.
3. Typecheck, lint and run `test/step17.ts` until green.
4. Write `test/step17-breaks.ts`. For each subcommand, apply one break (scripted, asserting its anchor appears exactly once), run step17, confirm the targeted check fails, restore byte for byte, confirm green. Record which check went red for each.
5. A real Claude instance (`up --claude real --pipelines`) for the `(real Claude)` steps in approvals, conversations and tasks.
6. Visual baselines: a fresh `up --pipelines`, `map run all --visual --keep-going`, look at the captures, capture again to measure noise, then `visual baseline --reason "..."` into `.claude/skills/verify-agents/baselines/` and `visual compare`.
7. `map guard --base main` after the feature files are committed, and seen failing when a step's expectation is dropped.
8. Docs: a README section on running and driving the app with agentsctl, an entry in `docs/what-each-part-does.md`, and a build-log section with the sweep's verdicts, the bugs, the breaks and the baseline size.
9. Run `node test/names.ts` (it trips on the `node_modules` symlink in a worktree; move the link aside for the run and back after), then commit in small commits and merge main again.

## What a fresh agent must know

- Put `~/.local/node/bin` first on PATH. `/usr/local/bin/node` belongs to another app.
- `node_modules` in the worktree is a symlink to main's. Never `npm install` through it, and never commit it.
- Never touch the live system: no launchd `com.agents.*`, never the `agents` database (agentsctl refuses anything but `.env.test`'s database ending `_test`), ports 8020 to 8039 only, teams named `verify-*`, never restart shared Docker containers.
- Before running any existing `test/step*.ts`, take the lock with `mkdir ~/.agents-app/checks/run.lock`, and remove it after. Never `npm run check`.
- Tayler's desktop app runs on this Mac. agentsctl's Electron uses its own `--user-data-dir` and HOME, so the two never share state.
- Never name the projects, companies or people this work learned from, in code, docs or commits. `node test/names.ts` checks it.

## Open questions for Tayler

- Should known product bugs stay as failing steps in the feature map (my choice, so a fix is proven when the step passes), or move to a known-bugs list that the runner skips?
- The test Electric ran out of file handles under seven agents at once. Raise its limit, or give each agent its own Electric?
- Running the pipelines on a box needs Postgres, Electric and three browsers in the box image. Is that wanted, or should the live stage stay on the server Mac?
