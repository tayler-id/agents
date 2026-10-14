# Verification as a repo capability

Agents writes code with its agents, and Tayler wants to trust that work without rereading it. The rule this design holds to is that an agent proves a change by driving the running app the way a person does, and keeps the evidence. For that to be one command and not a new conversation each time, every repo a team works on carries a verification skill, a feature map, and a tool that runs and drives the app. Agents' own repo has a first version of all three. This document says how Agents would make and keep them for any repo, as pipelines, and ends with what exists, what was run, and what is not done.

## What a repo carries

Three things, all in the repo, so they change in the same commit as the code they describe.

- **A verification skill**, `.claude/skills/verify-<app>/SKILL.md`, written for an agent reading it cold mid-task. It covers five jobs with exact commands: launch an isolated instance and tell when it is ready, a read-only health check that answers whether the instance is worth driving, drive every surface by stable handles, capture evidence that survives cleanup, and clean up only what the run started.
- **A feature map**, `features/` beside the skill: an index in sweep order and one file per user-facing feature. Each file names its sub-features, every way a person reaches the feature, labelled steps that pair the user's action with exact commands and the result that proves it, and the gotchas that waste a run. A file is runnable: its commands are the proof.
- **A driver**, the tool the skill's commands call. In Agents it is `bin/agentsctl`, with its library in `ctl/`. It owns the instance's lifecycle, a long-lived browser session behind one typed interface (`Driver` in `ctl/driver.ts`), API and database read-backs, evidence, visual baselines, and the map runner.

### The driver's contract

A pipeline, the framework's router and its gates talk to a driver only through its command line, so every repo's driver follows the same contract:

- Commands: `up`, `doctor`, `down`, `browser <op>`, `api`, `db`, `seed`, `visual shot|compare|baseline`, `map list|check|export|run|guard`.
- Evidence: each run's `evidence.json` lists every capture in the shape `EVIDENCE_MANIFEST` in `shared/evidence.ts`, and the map's `features.json` has the shape `FEATURE_MAP` there. The framework's gates read both with those schemas.
- Output: plain text by default, and with `--json` one envelope (`OUTPUT` in `shared/cli/output.ts`) with `ok`, `command`, `head`, `detail`, `outside`, `untrusted`, `already`, `code`, `files`, `help` and `data`. Heads hold only what the driver knows. Text from outside it goes in `outside`, which plain output prints fenced with a marker made fresh for each output, and `untrusted` names the data fields that hold it. A write leads with `ok:` and its resulting state. Every command ends with next steps.
- Exit codes: 0 done, 1 failed and safe to retry once fixed, 2 usage error, 3 refused with nothing changed.
- Every write is safe to rerun and says `already: true` when it changed nothing. `--dry-run` parses a command and names its target without running it.
- `doctor` is read-only and proves the app is usable, not only that a port answers.
- `down` stops processes by recorded start time and command line, never by name, and never removes evidence. `down --keep-data` stops them and keeps what the instance made. The instance then shows as `kept`, `up` refuses its name, and a later `down` removes what it kept.

### Verdicts

Every proof ends in one verdict, strongest first. `live-ui-verified` means it was driven through the running app, with the end state and its side effect observed. `unit-test-verified` means checks that call the code passed, and nothing drove the app. `type-check-only` means only the compiler and lint passed. `verifier-blocked` means the proof could not run, because the environment failed or a prerequisite was missing. `verifier-failed` means the proof ran on a healthy instance and the app did something else. An environment failure is blocked, never a pass, and the runner tells the two apart by running the health check after any failed step. A verdict comes from an agent that did not write the change.

A UI bug counts only when it reproduces twice through the real UI, each time recorded (`browser record start`, `record stop`), and a second agent confirms the video shows the broken state.

## The pipelines

Two pipeline files, in the team's pipelines repo like bug-fix: `verify-create` makes a repo's skill, and `verify-maintain` keeps it true. Both run on a box, since they need a whole instance of the app, browsers and the repo's checkout, and nobody watches them.

### verify-create: interview, generate, prove

1. **interview** (agent). Read the repo, not the person: what a user touches (web, desktop, CLI, API), how the app starts, what it needs (a database, services, ports, secrets), what already drives it (existing end-to-end checks are the best seed), what evidence it can give (screenshots, responses, rows, logs), and whether two copies can run side by side. Ask a person only what the code cannot say. Reports `ready`, or `blocked` with the gap, such as a checkout that does not build.
2. **generate** (agent). Write the driver, the skill and a first feature map: the top user-facing features from routes, menus and docs, each with its steps. The driver follows the contract above. For a web or desktop app it reuses this repo's browser layer (`Driver`), and only the instance lifecycle and seeding are the repo's own.
3. **prove** (check). Run the skill's own instructions once, end to end: `up`, `doctor`, `map run <one feature>`, `down`, then confirm the evidence folder still holds the run's captures and no process the run started is alive. A skill never run is a draft. Fails back to generate, at most twice, then a person takes over.
4. **open_pr** (action), then **shepherd** (gate), then **merge** (action), as in bug-fix.

### verify-maintain: the daily pass

A feature map goes wrong the moment the app changes. The maintenance pass runs every day on a cron trigger, compares every feature file with the source, drives every feature live, and ends in exactly one outcome:

- **clean** means every feature was read against the source and driven live, and nothing needs to change. No branch.
- **changed** means one pull request of proven corrections, confined to the skill's folder.
- **blocked** means coverage could not finish, or a proven fix could not ship safely. It says exactly what blocked it.

Its stages:

1. **index** (check). `bin/agentsctl map check`: the index lists every file, each file has its four sections, and every command parses.
2. **source** (agent, one session per feature, read-only). For each feature file, read the code behind it and report: how the feature works now, its entry points, any drift between the file and the code with file and line, and one recipe for a live check. These agents never drive the app or edit files.
3. **live** (check). `bin/agentsctl up --pipelines`, `doctor`, `map run all --visual --keep-going --json`, `visual compare`, `down`. Three rules hold the whole time: never drive an instance that has not passed doctor since it last surprised anyone, evidence survives every cleanup, and nothing the run started outlives it. The map runner already gives each step its verdict and checks health after any failure.
4. **triage** (agent). Sort every failed step and every drift finding into three kinds. *Doc drift* is a file that describes the app wrongly, and the fix is to the file. A *harness gap* is an app that works but a driver that cannot drive it, and the fix is to the driver, driven again live before it counts. A *product regression* is an app that is broken, and it is reproduced twice with recordings and reported as a bug for the team, outside this pull request. Reports `clean`, `changed` or `blocked`.
5. **guard** (check). `bin/agentsctl map guard --base origin/main` fails when the change removes or loosens any expectation in the map, since a weaker expectation is how a regression gets hidden. A pull request that must drop one (a feature removed on purpose) names the commit that removed it, and the shepherd sees the guard's list.
6. **open_pr**, **shepherd**, **merge**, only on `changed`.

Edit scope is the skill's folder and the driver. The pass never edits product code. A behaviour the map describes that the app no longer has is either drift (fix the map) or a regression (report it), and the guard keeps the second from passing as the first.

## What exists, and what is not done

As of 2026-10-14, on the branch `worktree-agent-ae995231ee16af626`, rebased onto main at `7197f4b`, not merged. Tayler approved the `tsconfig.json` and `eslint.config.js` changes, the skill in `.claude/skills/verify-agents/`, step17 in `npm run check`, skipping binary files in `test/names.ts`, and keeping known product bugs as failing steps in the feature map, on 2026-10-14.

Built, and proven by running it:

- `bin/agentsctl` and `ctl/`, on the CLI library in `shared/cli/`. `test/step17.ts` runs it through its command line on its own instance, in sections: refusals before up makes anything, up, doctor, the dashboard, `--dry-run`, the web app in Chromium, the desktop app, the API, the database, every seed, a claimed box, secrets, `machine read`, list, evidence, the conformance check, visual shot, compare and baseline, map check, export, guard and run, `down --keep-data` and the `down` after it, doctor noticing a stopped daemon, and down. Its last full run, on `1a0542b`, passed all 97 of its checks in about 85 seconds, with nothing it started left running.
- `test/step17-breaks.ts` holds 84 breaks, five of them in the app and two in the feature map. It first runs each set of sections with nothing broken, as a control, and counts a break only when its check passed in the control and failed under the break. All 84 count in one full run on `1a0542b`, which took 29 minutes. 88 of the 106 checks the control runs make have a break, and the other 18 have none.
- The skill, `.claude/skills/verify-agents/`, and its feature map of twelve files, each with its map entry, plus `features.json` built from the entries.
- `shared/evidence.ts`, the schemas for the evidence manifest (`evidence.json`) and the feature map that the framework's gates read. `visual shot` writes the manifest, and `visual compare` and `visual baseline` read captures only through it.
- Full sweeps, `map run all --keep-going` without `--visual`. The first, on instance `m5` on 2026-10-13, found faults in the map and the driver, fixed since. The last full sweep, `map run all --keep-going` on instance `sw4`, ran on `360c16e` with this round's fixes in 4 minutes 39 seconds. Of its 100 steps, 90 passed live, 4 failed on product bugs 1 to 4, and the 6 that need real Claude were blocked. machines passed all 6 steps again on `94cd4b1`, after boxes moved to their own image tag. The failures are product bugs, each noted in its feature file.
- `down` removes the box containers and home volumes of its team by the names the server gives them, which `shared/box-names.ts` holds for both. After each of two sweeps on `360c16e`, whose machines feature claimed a box, it removed that box's container and home volume. An instance's boxes now start from an image tag of its own that nothing builds, so no container runs, and step17 checks the volume removal with a volume it makes under the server's name.
- A capture waits until the page has no read in flight. Chromium never reports a read as ended when its page loads another document while the read is running, and Firefox and WebKit report it aborted. The driver kept such a read for good, so every later capture on that page failed after 15 seconds. That caused the visual timeouts of 2026-10-14, in one session all 20 captures, and probably the one of 2026-10-13. `goto` now drops the old document's reads, and step17 stalls a read in a page, loads the app again and settles.
- `down` removes only the join requests of logins `loginOf` made for the instance (`<name>-<instance>@verify.local`, where a name has no dash). A request from `stranger-y-x` is instance `y-x`'s, and `down` of `x` leaves it.

Not done:

- A full sweep with captures. Main fixed the Firefox console errors in `9482e4e`, and step17's captures of one view pass in all three engines. No sweep of every view has run since, and the noise between two sweeps is not measured.
- Committed visual baselines. Captures write the instance's name as one fixed name, so any instance's compare. `test/names.ts` reads every file as text, and in two of six captures tried, the PNG's bytes happen to spell the studied app's abbreviation. Tayler approved skipping binary files there on 2026-10-14, but the skip is not made, so baselines stay in the ignored `.scratch/verify/baselines/`.
- The stale-lock race in `ctl/ports.ts`. A port lock counts as stale when its instance has no state file, and `up` writes the state file only after `claimPorts` returns. For those few milliseconds a new lock looks stale, so a second `up` removes it and claims the same ports, and the bind test stops it only when the two tests overlap. Only one process can listen on each port, so the two instances' processes fight over them. A test of `claimPorts` in two processes, the second starting up to 12 ms after the first, gave both the same block in 104 of 120 tries. Of 31 pairs of real `up`s started up to 30 ms apart, 24 pinned to `--port 8020`, one pair took the same block, and both failed with exit 1, each on `EADDRINUSE` (a people process and an API). The rest took different blocks or one was refused. It is not fixed.
- No step tagged `(real Claude)` has run: the four tool approvals and the two interrupts.
- A UI bug counts once a second agent confirms its recordings. Three bugs have two recordings each, and nobody has confirmed them yet.
- The onboarding features (invites, Wants to join, the Tailscale page, a box per person, Claude sign-in) have no steps in the map.
- `map guard` is seen failing against HEAD, not yet against main, which has no map.
- The pipeline files `verify-create.ts` and `verify-maintain.ts`. Each stage maps to a command that exists, so the files are mostly prompts and `next` maps.
- Running them on a box. A box would need the app's own services (here Postgres and Electric for the test database) and the three browsers. Today's box image has neither, so the live stage would run on the server Mac.
- The generate stage for a repo that is not Agents. The driver's browser layer, evidence, visual compare and map runner do not depend on Agents. The instance lifecycle and seeding in `ctl/instance.ts` and `ctl/seed.ts` are Agents' own, and are what generate would write for another repo.
