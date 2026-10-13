# Verification as a repo capability

Agents writes code with its agents, and Tayler wants to trust that work without rereading it. The rule this design holds to: an agent proves a change by driving the running app the way a person does, and keeps the evidence. For that to be one command and not a new conversation each time, every repo a team works on carries a verification skill, a feature map, and a tool that runs and drives the app. Agents' own repo has them now. This document says how Agents makes and keeps them for any repo, as pipelines, and what of that exists and has been proven.

## What a repo carries

Three things, all in the repo, so they change in the same commit as the code they describe.

- **A verification skill**, `.claude/skills/verify-<app>/SKILL.md`, written for an agent reading it cold mid-task. It covers five jobs with exact commands: launch an isolated instance and tell when it is ready, a read-only health check that answers whether the instance is worth driving, drive every surface by stable handles, capture evidence that survives cleanup, and clean up only what the run started.
- **A feature map**, `features/` beside the skill: an index in sweep order and one file per user-facing feature. Each file names its sub-features, every way a person reaches the feature, labelled steps that pair the user's action with exact commands and the result that proves it, and the gotchas that waste a run. A file is runnable: its commands are the proof.
- **A driver**, the tool the skill's commands call. In Agents it is `bin/agentsctl`, with its library in `ctl/`. It owns the instance's lifecycle, a long-lived browser session behind one typed interface (`Driver` in `ctl/driver.ts`), API and database read-backs, evidence, visual baselines, and the map runner.

### The driver's contract

A pipeline, the framework's router and its gates talk to a driver only through its command line, so every repo's driver follows the same contract:

- Commands: `up`, `doctor`, `down`, `browser <op>`, `api`, `db`, `seed`, `visual shot|compare|baseline`, `map list|check|run|guard`.
- Output: plain text by default, and with `--json` one envelope (`Output` in `ctl/output.ts`) with `ok`, `head`, `detail`, `already`, `code`, `files`, `help` and `data`. A write leads with `ok:` and its resulting state. Every command ends with next steps.
- Exit codes: 0 done, 1 failed and safe to retry once fixed, 2 usage error, 3 refused with nothing changed.
- Every write is safe to rerun and says `already: true` when it changed nothing. `--dry-run` parses a command and names its target without running it.
- `doctor` is read-only and proves the app is usable, not only that a port answers.
- `down` stops processes by recorded start time and command line, never by name, and never removes evidence.

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

Edit scope is the skill's folder and the driver. The pass never edits product code: a behaviour the map describes that the app no longer has is either drift (fix the map) or a regression (report it), and the guard keeps the second from passing as the first.

## What exists, and what was proven

Built in this repo and proven by running it:

- Agents' own skill, `.claude/skills/verify-agents/`, with a feature map of twelve files covering every section of the user guide, and baselines for its key views.
- `bin/agentsctl` and `ctl/`, the driver, following the contract above. `test/step17.ts` runs the skill's launch, health check, a drive and cleanup through the command line, and fails if evidence goes missing or a process outlives the run. Each subcommand's check was seen failing under a break (`test/step17-breaks.ts`).
- `map run`, which runs a feature file as written and gives each step a verdict, and `map check`, the index stage above.
- `map guard`, the guard stage above.
- The live stage's commands, run by hand: a full sweep on a fresh instance with visual captures, recorded in the build log with every step's verdict.

Designed here and not built yet:

- The pipeline files `verify-create.ts` and `verify-maintain.ts`. Each stage maps to a command that exists, so the files are mostly prompts and `next` maps, and the router and gates can run the commands directly in the meantime.
- Running them on a box. A box would need the app's own services (here Postgres and Electric for the test database) and the three browsers. Today's box image has neither, and boxes reach only the live API's port, so the live stage runs on the server Mac until the box image grows them.
- The generate stage for a repo that is not Agents. The driver's browser layer, evidence, visual compare and map runner are repo-independent. The instance lifecycle and seeding in `ctl/instance.ts` and `ctl/seed.ts` are Agents' own and are what generate writes for another repo.
