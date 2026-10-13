# Verification framework: where the work stands

`shared/evidence.ts` is commit `3251ec15be215e9b2c86996b9bc53a0a4fa93f57`, alone in its commit, for the framework branch to take. If this branch is rebased again, the id changes; `git log --format=%H -1 -- shared/evidence.ts` finds it.

A note for whoever picks this up, kept current with each commit. The design is in `verification.md` beside this file, and the build log has a section on this work. Branch `worktree-agent-ae995231ee16af626`, in the worktree `.claude/worktrees/agent-ae995231ee16af626`, rebased onto main at `9473ac3`. Nothing is merged to main.

## Done, with commits

- `e2e6929` Forge sets up repos in an org other than the team's (`server/forge.ts`, `ensureOrg`), so a verify instance's repos live in their own org and `down` deletes the org whole.
- `f13813c`, `04e9381` `bin/agentsctl` (a link to `ctl/main.ts`) and `ctl/`: the Driver interface (`ctl/driver.ts`) with Playwright behind it (`ctl/playwright.ts`), the map runner, checker and guard (`ctl/map.ts`), visual compare and baseline (`ctl/visual.ts`, `ctl/png.ts`), the skill and its twelve feature files (`.claude/skills/verify-agents/`), the pipeline design and `test/step17.ts`.
- `ca1a83a`, `aa99d01` Fixes from the first full sweep, in the map and the driver.
- `3251ec1` `shared/evidence.ts`, and `e483901` agentsctl writing and reading evidence only through it.
- `123c4a7` `shared/cli/`, the CLI library, with agentsctl rebuilt on it.
- `7581be9`, `fdc335a` step17 checks every command family and runs the conformance check, by section; `test/step17-breaks.ts` breaks what each check guards.
- `1123bbd` Fixes from the three breaks that missed (the overflow check, `machine read --missing`, a broken break).
- `0315c8a` A stopped video takes the label it was started with.
- `9476098` `db --value` prints the value alone, for a shell; captures hide the scratch folder's random name.
- Docs: `4e30e2a` the design doc, `b8acbc9` the README section and parts entry, `97e762a` `docs/decisions.md`, and the build-log section in the commit with this note.

Proven on the rebased branch: `npm run typecheck`, `npm run lint` and `node test/names.ts` pass, `bin/agentsctl map check` passes, the last full `node test/step17.ts` passed all 60 checks in under a minute, and all 44 breaks in `test/step17-breaks.ts` turned their check red with every file restored byte for byte. The breaks' results are in `.scratch/verify/breaks/results.json` (scratch).

## The sweeps

The first ran on instance `m5` (`.scratch/verify/evidence/m5-20261013T172318Z/map/`). Every step was live-ui-verified for getting-in 6/6, agents 13/13, documents 8/8, secrets 5/5, machines 6/6, journeys 2/2; tasks 6/7 and conversations 13/16, where the interrupt steps wait for real Claude; sessions 7/10, pipelines 11/13, proposals 3/6, approvals 0/8. Those failures were the map's and the driver's fault, now fixed, or product bugs, below.

The second, with captures, ran on instance `visual` (`.scratch/verify/evidence/visual-20261013T204650Z/`). It passed every step of getting-in, 14 of conversations' 16 and 10 of agents' 13, then the shared test Electric stopped sending changes to the agents table and the runner marked every later step `verifier-blocked`. It took 30 captures of five views (1.3 MB), listed in that folder's `evidence.json`.

## Product bugs found

1. A working agent that cannot restart does not say why. Recorded twice (`.scratch/verify/evidence/m1-20261013T165556Z/videos/001-*.webm`, `002-*.webm`), and seen in both sweeps. The record shows the cause. The failed command adds the error event and marks the session failed, then the old harness process, stopped for the restart, reports `idle` and overwrites it, because `daemon/agentsd.ts` still holds it as the session's process when the new one fails to start.
2. improve cannot be started from the app on a repo named `pipelines`. `StartRun` in `app/src/Pipeline.tsx` drops every repo whose URL ends `/pipelines.git`, though that repo held all three pipelines. Recorded twice (`.scratch/verify/evidence/repro-20261013T205032Z/videos/001-recording.webm`, `002-recording.webm`, named before the label fix).
3. Session details names the model a session started on, not the one it runs on. Recorded twice (same folder, `003-*.webm` and `004-*.webm`, with a screenshot in `screens/`): the machine was told sonnet, then opus, and the panel said haiku.
4. Accessibility, serious. A pipeline's file scrolls but cannot take keyboard focus (axe `scrollable-region-focusable`), on bug-fix's and improve's pages.
5. Found by reading, not reproduced. `act()` in `app/src/data.ts` dispatches an `app-error` event that nothing listens for, so a failed action button says nothing.
6. Minor. The `main` landmark is labelled "Conversation" on the home, New task, New room and New agent views. The sidebar's Agents list has no order of its own.
7. Minor race. Choosing a stage's session in Running now in the first moment after the page loads opens the run's task, not the run.

No second agent has watched the recordings. I may not start agents.

## Environment trouble

The shared test Electric (`agents-electric-test-1`) logged `emfile` (too many open files) 3,183 times between 16:45 and 20:44 UTC on 2026-10-13. Since then it sends no new rows of the agents table to any shape, even shapes made later. An agent added at 20:53 was still missing from its team's agents shape at 20:55. Any check that adds an agent and looks for it in the app fails until Electric is restarted, which no agent may do. doctor's Electric check catches it.

## Not done, and why

- No step tagged (real Claude) has run: four tool approvals and two interrupts. Tayler's usage was nearly out.
- No visual baselines are committed. In two of six PNG captures tried, the bytes spell the studied app's abbreviation, so `test/names.ts` would fail. A binary skip there needs Tayler's approval. Noise between two sweeps is unmeasured, since the second sweep was blocked.
- A full sweep with captures, which needs Electric restarted.
- `map guard` is seen failing against HEAD, not yet against main, which has no map.
- The pipeline files `verify-create.ts` and `verify-maintain.ts` are designed, not written.

## Next steps, in order

1. Once Electric is restarted: `bin/agentsctl up --pipelines --instance visual`, `map run all --visual --keep-going`, look at the captures, `down`, then the same again, and `visual compare --from <second run>` against the first to measure noise.
2. Once Tayler approves the binary skip in `test/names.ts`: `visual baseline --from <first run> --reason "..."` and commit the baselines.
3. With real Claude allowed: `up --claude real --pipelines`, then `map run approvals conversations tasks` for the steps tagged (real Claude).
4. A second agent watches the six recordings and confirms each shows the bug.

## What a fresh agent must know

- Read `AGENTS.md` first. It binds this work.
- Run Node from `~/.local/node/bin`, and have `/opt/homebrew/bin` on PATH for `docker`. The `node` in `/usr/local/bin` is a launcher that can't load native packages.
- The worktree has its own `node_modules` from `npm ci`. Never install through a link to main's.
- Never touch the live system: no launchd `com.agents.*`, never the `agents` database (agentsctl refuses anything but `.env.test`'s database ending `_test`), ports 8020 to 8039 only, teams named `verify-*`, never restart shared Docker containers.
- Before any check that uses port 7701, take the lock with `mkdir ~/.agents-app/checks/run.lock`, and `rmdir` it after. step17 uses 8020 to 8039. Never `npm run check`.
- While `test/step17-breaks.ts` runs, edit nothing it breaks (`ctl/`, `shared/cli/`, `app/src/`, the feature files), since it restores each from its own copy. A killed run restores them when it next starts.
- Tayler's desktop app runs on this Mac. agentsctl's Electron uses its own `--user-data-dir` and HOME.
- Never name the projects, companies or people this work learned from. `node test/names.ts` checks it.
- This branch changes `tsconfig.json` and `eslint.config.js` (adding `ctl`) and adds `.claude/skills/verify-agents/`. `AGENTS.md` says changes there need Tayler's approval.

## Open questions for Tayler

- Approve skipping binary files in `test/names.ts` (a file with a NUL byte in its first 8000 bytes, as git decides), so visual baselines can be committed?
- Approve the `tsconfig.json`, `eslint.config.js` and `.claude/skills/verify-agents/` changes?
- Restart the shared test Electric, and raise its open file limit or give each agent its own?
- Should known product bugs stay as failing steps in the feature map (my choice, so a fix is proven when the step passes), or move to a known-bugs list that the runner skips?
- Running the pipelines on a box needs Postgres, Electric and three browsers in the box image. Is that wanted, or should the live stage stay on the server Mac?
