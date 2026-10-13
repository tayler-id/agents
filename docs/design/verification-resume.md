# Verification framework: where the work stands

`shared/evidence.ts` is commit `b729f4d8659ec943176ec1e1899deb322b12ab62`, alone in its commit, for the framework branch to take. If this branch is rebased again, the id changes; `git log --format=%H -1 -- shared/evidence.ts` finds it.

A note for whoever picks this up, kept current with each commit. The design is in `verification.md` beside this file. Branch `worktree-agent-ae995231ee16af626`, in the worktree `.claude/worktrees/agent-ae995231ee16af626`, rebased onto main at `deec329`. Nothing is merged to main.

## Done, with commits

- `35fc535` Forge sets up repos in an org other than the team's (`server/forge.ts`, `ensureOrg`), so a verify instance's repos live in their own org and `down` deletes the org whole.
- `90899e7`, `5999df4` `bin/agentsctl` (a link to `ctl/main.ts`) and `ctl/`: the Driver interface (`ctl/driver.ts`) with Playwright behind it (`ctl/playwright.ts`), the map runner, checker and guard (`ctl/map.ts`), visual compare and baseline (`ctl/visual.ts`, `ctl/png.ts`), the skill and its twelve feature files (`.claude/skills/verify-agents/`), the pipeline design (`docs/design/verification.md`) and `test/step17.ts`.
- `591f868`, `8e8f1ef` Fixes from the first full sweep, in the map and in the driver (listed under the sweep below).
- `b729f4d` `shared/evidence.ts`: the evidence manifest, the feature map, the verdict ladder.
- `08450d8` agentsctl writes and reads evidence only through it: `evidence.json` per run and at `.scratch/verify/evidence.json`, sha256 checked on read, map entries in each feature file, `features.json` from `map export`, and `map check` failing when they differ.
- `f23592d` The design doc claims only what was built and run.
- `55fae7d` `shared/cli/`, the CLI library (envelope, exit codes, errors, zod command definitions with generated help, unknown flags and commands refused with the valid ones listed, `--fields`, `--dry-run`, cut output with its size stated, untrusted fences, next steps that never repeat the command, and `conformance.ts`). agentsctl is rebuilt on it, one command per browser and desktop operation, writes reading their state back, everything on stdout.
- `a9dd5c9` step17 checks every command family and runs the conformance check. Its first full run passed all 59 checks, with 22 processes found before down and none alive after.
- `71ac854` step17 runs by section (`--only web,visual`), and `test/step17-breaks.ts` holds 43 breaks.
- `db7b32e` README section on agentsctl, an entry in `docs/what-each-part-does.md`, and the skill's description of the library's answers.
- `81c6420` `docs/decisions.md` says where the verification tool and the CLI library stand.
- `9c44775` All 43 breaks turn their check red. The first run of all of them turned 40 red, and the three misses each taught something: the overflow check measured against `window.innerWidth`, which Chromium's phone mode widens to fit content that is too wide, so it now measures against `documentElement.clientWidth`; step17 tried `machine read --missing` only on an absent file, so it now also checks a present one fails; and the stderr break itself was broken, a line starting with a parenthesis that joined the line above. Rerun, all three went red, and a full step17 then passed all 59 checks with every file restored.

`npm run typecheck`, `npm run lint` and `node test/names.ts` pass on each of those commits.

## In progress

A sweep on an instance named `visual`: `map run all --visual --keep-going`, writing to `.scratch/verify/evidence/visual-20261013T204650Z/`. It reruns the features fixed since the first sweep and takes the captures for the baselines. Then, in order:

1. Look at the captures, then a second sweep on a fresh `visual` instance, compared with the first, to measure noise.
2. Two recorded reproductions each of bugs 2 and 3 below, through the UI.
3. A build-log section: the sweeps' verdicts, the bugs, the breaks, the captures and their size. A draft is easy to write from this note.
4. Rebase on main, rerun typecheck, lint, the name guard and step17, update this note, and report.

## The first full sweep

Instance `m5`, `map run all --keep-going`, without `--visual`. Report in `.scratch/verify/evidence/m5-20261013T172318Z/map/` (scratch, not committed).

- live-ui-verified, every step: getting-in 6/6, agents 13/13, documents 8/8, secrets 5/5, machines 6/6, journeys 2/2.
- tasks 6/7 and conversations 13/16, where the interrupt steps wait for real Claude.
- sessions 7/10, pipelines 11/13, proposals 3/6, approvals 0/8.

Fixed since, where the map or the driver was at fault, and not yet rerun live: approvals' preconditions no longer block the whole file; proposals expect their kickers in capitals, as shown; the record search expects fixer's room post, since search leaves out the asking session's own conversation; Running now waits for the run to load before choosing it; `doctor` compares Electric's agents with the database and names any it lacks; `browser select` names a missing choice and what the box offers; `browser network` reports requests the page cancelled itself apart from failures. Each known product bug is noted, dated, in its feature file's gotchas, and its step stays as the proof of a fix.

## Product bugs found

Each needs two reproductions through the real UI, each recorded, and a second agent confirming the video. I can't start agents, so the second look is open.

1. A working agent that cannot restart does not say why. writer's session runs, a plugin needing a missing secret is added, the next message restarts the session, and the "no value for NOTES_TOKEN" notice never shows. Reproduced twice with recordings in `.scratch/verify/evidence/m1-20261013T165556Z/videos/001-*.webm` and `002-*.webm`.
2. improve cannot be started from the app on a repo named `pipelines`. `StartRun` in `app/src/Pipeline.tsx` drops every repo whose URL ends `/pipelines.git`, for every pipeline, though pipeline files can live in any repo (`server/pipelines.ts`) and improve's study stage works in `./<repo>/pipelines`. `test/step9b.ts` names its repo `pipes9b-<id>`, so it never meets the filter. Seen once in the sweep.
3. Session details shows the model a session started on, not the one it runs on. `sessions.model` is written once at insert (`server/record.ts`, `conversationSession`), while each message's command carries the agent's current model. Change fixer to sonnet and message it, and the panel still says haiku while the command says sonnet. Seen once.
4. Accessibility, serious. The pipeline file's `<pre>` on a pipeline's page scrolls but cannot take keyboard focus (axe `scrollable-region-focusable`).
5. Found by reading, not reproduced. `act()` in `app/src/data.ts` dispatches an `app-error` event that nothing listens for, on main too, so an action button that fails says nothing. Its comment says an alert banner shows the error.
6. Minor. The `main` landmark is labelled "Conversation" on the home, New task, New room and New agent views.
7. Minor race. Choosing a stage's session in Running now in the first moment after the page loads opens the run's task, not the run, because the sidebar's runs have not loaded yet.

## Environment trouble seen

The shared test Electric (`agents-electric-test-1`) keeps running out of file handles: `emfile` at 17:34:11 UTC, and 569 times in the half hour to 20:20 UTC on 2026-10-13. Its shape writers exit, and shapes made before that stop updating, so the app and `doctor`'s Electric check see stale rows. New shapes are still made. I did not restart the container, since other agents share it.

## Not done, and why

- No step tagged (real Claude) has run: the four tool approvals and the two interrupts. Tayler's usage was nearly out, so I did not start real Claude sessions.
- No visual baselines are committed. `test/names.ts` reads every file as text, and two of six PNG captures tried happen to hold the studied app's abbreviation in their bytes, so committed baselines would fail the name guard. A binary skip there needs Tayler's approval.
- `map guard` is seen failing against HEAD (a break drops an expectation), not yet against main, which has no map.
- The pipeline files `verify-create.ts` and `verify-maintain.ts` are designed, not written.

## What a fresh agent must know

- Read `AGENTS.md` first. It binds this work.
- Run Node from `~/.local/node/bin` (`export PATH="$HOME/.local/node/bin:$PATH"`), and have `/opt/homebrew/bin` on PATH for `docker`. The `node` in `/usr/local/bin` is a launcher that can't load native packages.
- The worktree has its own `node_modules` from `npm ci`. Never install through a link to main's.
- Never touch the live system: no launchd `com.agents.*`, never the `agents` database (agentsctl refuses anything but `.env.test`'s database ending `_test`), ports 8020 to 8039 only, teams named `verify-*`, never restart shared Docker containers.
- Before any check that uses port 7701, take the lock with `mkdir ~/.agents-app/checks/run.lock`, and `rmdir` it after. step17 uses 8020 to 8039, not 7701. Never `npm run check`.
- Tayler's desktop app runs on this Mac. agentsctl's Electron uses its own `--user-data-dir` and HOME, so the two never share state.
- Never name the projects, companies or people this work learned from. `node test/names.ts` checks it.
- This branch changes `tsconfig.json` and `eslint.config.js` (adding `ctl`) and adds `.claude/skills/verify-agents/`. `AGENTS.md` says changes there need Tayler's approval.

## Open questions for Tayler

- Approve skipping binary files in `test/names.ts` (a file with a NUL byte in its first 8000 bytes, as git decides), so visual baselines can be committed?
- Approve the `tsconfig.json`, `eslint.config.js` and `.claude/skills/verify-agents/` changes?
- Should known product bugs stay as failing steps in the feature map (my choice, so a fix is proven when the step passes), or move to a known-bugs list that the runner skips?
- The test Electric runs out of file handles under several agents at once. Raise its limit, or give each agent its own Electric?
- Running the pipelines on a box needs Postgres, Electric and three browsers in the box image. Is that wanted, or should the live stage stay on the server Mac?
