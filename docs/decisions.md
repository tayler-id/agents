# Decisions

Every decision about how Agents is built and how work on it happens, newest group first. Each entry says what it is for, how it works, how it is built, and where it stands. Parts still being built live on agent branches until they merge, and their design docs in `docs/design/` hold the detail.

## 2026-10-14, Tayler's calls

Tayler went with the coordinator's picks on all of these.

- **Changes that take something away, all accepted.**
  - Machines can't push to a repo's default branch. Work reaches it through a pull request.
  - Durability's daemon and API can't mix with older versions, so they roll out together in the design's order.
  - Coach and improve lose `propose_instructions` and `apply_proposal`, and improve needs checked findings.
  - Boxes are capped at 4 GB, 2 CPUs and 4,096 processes, and a box takes no work until its desktop is up.
  - Boxes run without `NET_RAW`. That removes packet capture and raw scans, not ping.
- **Protected files and packages, approved.**
  - Verification's `tsconfig.json` and `eslint.config.js` changes, `.claude/skills/verify-agents/`, step17 in `npm run check`, and the binary-file skip in `test/names.ts`.
  - `ws`, `@types/ws` and `@novnc/novnc` for the Screen view.
  - A CommonMark parser to close the nine markdown leaks before GitHub is switched on, and the bug-fix prompt line saying issue titles are quoted data.
  - AWS's `ops/` files. Deploying waits until the Mac version settles, and costs about $217 a month.
- **Product calls.**
  - The Claude Code sessions people open in their own terminals get connected, so they land in the record. It is the next workstream after the current branches land.
  - Box sessions run commands without asking. Macs keep asking.
  - Personal boxes stop when idle and wake on a message. Only the owner drives agents on their own box. The app warns before a sign-in token runs out. Removing a person gets built. Admins stay out of private rooms.
  - The browser limits and the 24-hour screen privacy window stay. The daemon refuses to save a screenshot while the page shows a known secret.
  - AWS boxes reach the server over the VPC, not the tailnet. Colima on the Mac drops the same private ranges as the AWS box host.
  - Known product bugs stay as failing steps in the verification feature map.
  - The first build's Docker volumes are deleted, with a backup in `~/.agents-app/backups/first-build-volumes`.
  - The UI gets a design system and a new layout, since the current layout is poor. That work starts after every current branch lands.
  - The desktop app becomes one download, with the Mac connection and terminal-session capture built in. It is signed and notarized with Tayler's Apple Developer ID. Only whoever builds the app needs a developer ID, and teammates download it and open it. This also starts after the current branches land.
  - The coding framework's section in `AGENTS.md`, its deployer `ops/deploy.ts` and this repo's policy `ops/policies/agents.json` are approved. On a repo with a policy, a change that adds a binary file other than a PNG, JPEG, GIF, WebP or ICO image fails the `opaque` gate. Its other options stay off: inline lint config, signed attestations, judges on their own machine, and a wider landing list.
  - A browser page that can't give its text within 5 seconds, such as one held by an open alert, refuses every screenshot until it can.
  - Terminal sessions from a connected folder are seen by the team by default, and `connect --private` keeps them to the person. The daemon leaves out tool results for files outside the connected folder. It also learns the secret values in the person's login shell at start so it can scrub them, and those values never leave the Mac. Sessions from before a folder was connected stay on the Mac. Images stay on the Mac, with a note in the record that one was there.
- **The last merges, at 17:10.** Tayler said to finish the coding and merge all of it, which the coordinator took as the yes it had asked for twice.
  - Verification's `ctl` script in `package.json`.
  - AWS's seven dev packages, at exact versions. `aws-cdk` 2.1145.0, `aws-cdk-lib` 2.273.0 and `constructs` 10.8.1 write and deploy the stack. The `@aws-sdk` clients for CloudWatch, S3, Secrets Manager and SSM, at 3.1150.0, serve the host scripts.
  - This repo's policy keeps its stand-in skill and map in `.claude/skills/verify/` for now. Its plans name parts of the code, such as `framework`, and the verify-agents map names what a person does, such as `conversations`, so switching the policy to it takes a design call. No live repo has a policy yet.

## 2026-10-13, after the code review

### Keep the core

- **Purpose.** A review of the code asked whether the architecture holds. It does, with one gap, which the next entry covers.
- **How it works.** Postgres stays the one shared record. The API owns every write and permission. Electric serves live views. The Durable Streams server that `server/streams.ts` starts serves live text from files on the server, with no cloud service behind it. Pipelines stay versioned code.
- **Implementation.** What is built on main.
- **Status.** Decided.

### Turns survive a machine dying

- **Purpose.** If a machine dies mid-turn, the work resumes or is shown as interrupted. Today the daemon marks a message done as soon as Claude receives it. A crash mid-turn leaves the session showing working forever, and a pending approval can't be answered.
- **How it works.**
  - A turn's command stays claimed until the turn ends.
  - A machine that restarts reports its interrupted sessions as interrupted, then resumes each one.
  - A pending approval survives a restart.
  - The app shows what is true after any crash or reconnect.
- **Implementation.** A durability workstream on its own branch. It is done when five crash tests pass:
  1. killing the machine during the model's output
  2. killing it after a tool acts but before the result is saved
  3. restarting it while an approval waits
  4. replacing a box, with its files and session recovered
  5. reconnecting the app and checking what it shows against the record

  After that, other agent engines with durable sessions can run behind `daemon/harness.ts` against the same five tests. One replaces ours only if it clearly wins.
- **Status.** Decided, being built.

### Only tailscale serve can name a person

- **Purpose.** A person's identity in the app comes from Tailscale, so nothing else can claim it.
- **How it works.**
  - In Tailscale's userspace mode, a tailnet device could reach every port on this Mac and send its own identity header. The API now serves people only on a Unix socket that only this Mac's user can open, and tailscale serve proxies to it.
  - A tailnet policy lets devices reach this Mac only on the app's port 80 and the machines' port 7700. Its tests make Tailscale refuse an edit that reopens any other port.
  - A person's change must be sent as JSON. A page on another site can make the person's browser post a form, which serve would sign as them, but it can't send JSON without a CORS preflight, which this API never grants.
- **Implementation.** `server/api.ts`, `test/step19.ts`, the JSON line in `check:step2`, and `test/live-tailnet.ts` for the live system. The detail is in `docs/design/people-port.md`.
- **Status.** Live since 2026-10-14. Tayler saved the policy, pointed serve at the socket and restarted the API and daemon, and `test/live-tailnet.ts` passed every line.

### Coach and improve learn only from checked evidence

- **Purpose.** Instructions and pipelines change only on evidence from real sessions, checked in code, and a change reaches a person only after replays show it helps.
- **How it works.**
  - A cheap model reads each recent session once and records findings: a rule followed, a rule ignored, a rule that caused harm, or a correction no rule covers. Code drops any finding whose quote isn't in the event it cites.
  - A correction becomes a candidate once two sessions carry it, with people counted separately. Candidates expire after 90 days.
  - A candidate that a lint rule, type or check could catch goes there first. One person's preference goes to their profile. Only what's left changes shared instructions.
  - Changes come as small hunks, each citing its findings. Code requires two sessions for an added rule and two harm findings to delete one, caps the hunks, and holds a size budget.
  - Replays score each change on the sessions behind it and on unrelated ones. Only a change that wins reaches the shepherd.
  - Decisions are per hunk, remembered for the whole team with a reason.
  - Coach's and improve's own sessions and replays never count as evidence.
- **Implementation.** A new workstream on its own branch, from the evaluation in `research/evaluations/instruction-training.md`.
- **Status.** Decided, being built. We don't install or wrap the tool we evaluated.

## 2026-10-13: how agents code on this repo

### The product is Agents, and our docs name only what we use

- **Purpose.** The product has its own identity. Docs, code, comments, UI text and commit messages describe ideas in our own words.
- **How it works.** Nothing we write uses the name of the app we studied, an abbreviation of it, or anything but agent for an agent. Nothing names a project, product, company or person we learned from. A tool we install and run may be named where someone sets it up. The teardown in `research/` and rea's evidence in `docs/evidence/` may name the studied app, and neither is published.
- **Implementation.** `test/names.ts` runs first in `npm run check` and fails on any of those names in a tracked file. It was seen failing on 270 lines before the rename and on 14 reference lines before the scrub.
- **Status.** Enforced on main.

### Types are the spec

- **Purpose.** Code that compiles should be code that cannot hold an impossible state, and every shape is defined once.
- **How it works.**
  - All code is TypeScript, infrastructure included.
  - Every input from outside is parsed by a zod schema, and its type is inferred from that schema.
  - Shapes live once in `shared/`. IDs are branded so they can't be mixed.
  - Lifecycles are typed state machines.
  - Database row types are generated from the schema, never written by hand.
- **Implementation.** The section "Types are the spec" in the coding-standards skill. Each rule names what enforces it today. The rest is enforced by review until the standards retrofit after the current branches merge.
- **Status.** New code follows it now. Existing code is retrofitted after the merge.

### No shortcuts

- **Purpose.** "It works now" is not done. These rules block the ways to get green without getting it right.
- **How it works.** The rules ban:
  - retries, sleeps or fallbacks that hide a failure before its cause is shown
  - changing a check to match broken behavior
  - swallowed errors and silent defaults
  - test-only paths in product code
  - mocking the code under test
  - special cases that only exist to pass a check
  - second copies of logic
  - leftover TODOs and magic numbers
  - speculative options
  - widening a type to silence an error
  - commands built as strings
  - drive-by edits
- **Implementation.** The section "No shortcuts" in the coding-standards skill. Reviewers use it as their rubric, and every finding cites the rule it breaks.
- **Status.** In force. Lint rules for the mechanical ones come with the retrofit.

### The coding framework

- **Purpose.** Any agent changing code in Agents, on this repo or a team's repo, produces work a person can trust without redoing it.
- **How it works.** A run follows these stages:
  1. **Route.** A router picks the playbook for the kind of change.
  2. **Understand.** A read-only pass writes down what the code does now, what the change touches and what could break.
  3. **Plan.** A plan names its concern, what "done" means as checks, the behavior to keep as features from the feature map, the files and the size. Tayler approves the plan before any code is written.
  4. **Implement.** An agent changes the code in a box.
  5. **Verify.** The runner, never the agent, runs the gates.
  6. **Review.** Reviewers on other models review without the author's reasoning.
  7. **Confirm.** A fresh agent checks every promise in the plan with the verification tools.
  8. **Pull request.** It opens with the evidence attached.
  9. **Protected paths.** Changes to protected paths stop at a gate only Tayler can pass.
- **The gate's principles.**
  - A repo may add checks but never remove or weaken them.
  - A gate that can't run fully refuses loudly.
  - Work is never lost.
  - A person's decision becomes a fact every later step must respect.
  - Every verdict records the tool build and configuration that produced it.
  - Run state is honest: working, parked or dead.
  - The pushed branch is untrusted input.
- **Verdicts.** A merge needs three things at the exact head commit:
  - green gates
  - a verdict from an agent that did not write the change
  - a clean merge against current main
- **Grading and the ledger.** Verdicts are graded, from verified in the live UI down to type-checked only. "Couldn't verify" is kept apart from pass and fail. The ledger is keyed by pull request and head commit. After a rebase, a verdict survives only if the patch itself is unchanged.
- **Implementation.** `docs/design/self-improve.md`, with the rules merged into `AGENTS.md`, on the framework agent's branch. Each repo gets a versioned policy with its sandbox, caps, protected paths and size limit.
- **Status.** On main since b2aa8b5, and loaded by the running server since the restart on 2026-10-14. It sends a failure back to its author, with bounds, and the design says why. The gates and the verifier parse evidence with one schema, `shared/verification.ts`, though the runner does not check screenshots yet. It does not hold changes to this repo until the repo is registered with its policy. The design lists what is not enforced.

### Size and time limits per task

- **Purpose.** Small changes are reviewable, and long runs usually mean the task should be split.
- **How it works.**
  - One concern per pull request, at most 400 changed lines not counting lockfiles. Bigger work becomes stacked pull requests.
  - Each run has caps on working time and spend. The current policy says 180 minutes and $25. A cap of about 60 minutes is proposed.
  - Inside a task, work moves in small units that each end in a passing check.
- **Implementation.** The policy file and the diff-size gate in the framework.
- **Status.** Numbers set in the policy. The time cap waits on Tayler.

### Verification tools

- **Purpose.** "Verify it" and "did this break anything else" become something the repo can do, not a new conversation each time.
- **How it works.**
  - A verification skill for Agents covers five jobs: launch an isolated instance, check it is usable, drive it like a user, capture evidence and clean up only what it started.
  - A feature map holds one file per user-facing feature, saying how a user reaches it, how an agent drives it and what end state proves it works.
  - Baseline screenshots in three browser engines at desktop and phone width catch visual regressions by image diff.
  - A UX pass checks accessibility, keyboard-only paths, console errors and phone overflow.
  - A daily maintenance pass compares every feature with the source and drives each one live. It can fix the docs but never hides a product bug.
- **Implementation.** `agentsctl`, a TypeScript CLI and library with these parts:
  - `up`, `doctor` and `down` for instances
  - a long-lived browser session driven by roles and names
  - the desktop app
  - API calls as a person or a machine
  - read-only database queries
  - fixtures, evidence capture, and visual compare and baseline
  
  The browser driver sits behind one interface, so a second driver can slot in.
- **Status.** Merged on 2026-10-14. `test/step17.ts` checks the tool, and runs in `npm run check`. `test/step17-breaks.ts` has a break for 88 of the 106 checks its control runs make, and watches each go red against a control run with nothing broken.
  - **Approved by Tayler on 2026-10-14.** The `tsconfig.json` and `eslint.config.js` changes that add `ctl/`, the skill in `.claude/skills/verify-agents/`, step17 in `npm run check`, skipping binary files in `test/names.ts`, and keeping known product bugs as failing steps in the feature map.
  - **Not done.** The skip is not made, so baseline screenshots are captured but not committed, because the name guard reads PNG bytes as text. The steps that need real Claude have not run. A Chrome DevTools-based driver is under evaluation for performance traces and memory.
  - **Waiting on Tayler.** The framework's policy names its own stand-in skill and map, `.claude/skills/verify/`, and an evidence file, `test/ui-shots/evidence.json`. This branch has its skill and map in `.claude/skills/verify-agents/`, and agentsctl copies the latest manifest to `.scratch/verify/evidence.json`. So the framework's gates read neither this branch's map nor its manifest. Either the policy moves to this branch's paths, or this branch moves to the policy's. Both edit protected files.

### How our CLIs talk to agents

- **Purpose.** Agents read our tools' output cheaply and act on it without guessing.
- **How it works.**
  - Every write starts with one `ok:` line giving the result and the new state.
  - Next steps are suggested for the current state, never the command that just ran.
  - Every command is idempotent and reports `already: true` on a no-op.
  - Errors name what failed and what to run next.
  - Exit codes: 0 done, 1 failed and safe to retry, 2 usage, 3 refused with nothing changed.
  - `--json` works everywhere.
  - With no arguments, a command prints a dashboard.
- **Implementation.** `shared/cli/`, a library with the envelope, exit codes, errors, command definitions that generate help and refuse unknown flags, the dispatcher, and a conformance check any CLI can run. `agentsctl` is built on it, and `agents-git` will be.
- **Status.** In progress.

### Parallel agents, worktrees and landing

- **Purpose.** Many agents work at once without colliding, and nothing lands unverified.
- **How it works once `agents-git` exists.**
  - Each task gets one branch and a fresh worktree outside the repo, with its own ports, test database and copy of its dependencies.
  - Work lands with merge commits, never squashed, so history alone proves what landed.
  - Before landing, the coordinator runs these gates:
    - It checks protected paths.
    - It reruns each changed check against the old code, where it must fail.
    - It renumbers migrations in landing order.
    - It rebuilds the test database.
    - It runs the full suite on the merged result.
    - It gets an independent review.
  - Agents never install packages through a link to main's packages, never edit `.gitignore`, and never add check scripts to `package.json`.
- **How it works today.** None of that isolation is built.
  - The seven branches' worktrees sit inside the repo, under `.claude/worktrees/`.
  - Five of them link main's `node_modules` instead of having their own copy.
  - All seven share the `agents_test` database and the test Electric on port 3002.
  - Agents keep apart by agreement, not tooling. Each uses its own team-name prefix and migration number, and takes a lock folder before checks on port 7701. Two agents running the same check at once still collide on its ports.
  - The coordinator runs the landing gates by hand.
- **Implementation.** `agents-git`, a TypeScript CLI for these jobs:
  - starting a task's branch and worktree
  - saving work to refs that survive removal
  - syncing, running checks, submitting and landing
  - a ledger of what landed
  - cleanup that previews by default
  
  Claude Code hooks route agents through it.
- **Status.** `agents-git` is merged on 2026-10-14, and not yet run on the real repo. `start`, `list`, `adopt`, `done` and `prune` set up, track and finish worktrees beside the repo, and `done` copies the ignored files it would otherwise delete to `~/.agents-app/backups/agents-git/` first. `save` and `sync` keep work safe and on top of main, and `sync` merges main in instead of rebasing once a branch is submitted. `check` runs steps under the run lock with main's env files, time limits and the docker rules. `submit` runs the framework's static gates and main's name guard on every commit a push would publish and on the pull request's text, then pushes copies to GitHub and opens the pull request. `land` runs the landing gates and the suite on the merge, then fast-forwards main and mirrors it. `docs/design/agents-git.md` maps each `AGENTS.md` rule to the command that enforces it, and `test/step22.ts` checks every command on a temp repo. Not built yet:
  - ports and a test database per worktree
  - env file setup beyond the links `land` makes
  - the Claude Code hooks, which need Tayler's approval since they live under `.claude/`
  - the one-time `refs/mirror/local-root` and `refs/mirror/github-root` setup on the real repo, and the last pushed pair, in the design doc

### The repo on GitHub

- **Purpose.** A shared home with CI, branch protection and pull requests.
- **How it works.**
  - The public repo is https://github.com/tayler-id/agents.
  - It started from one commit holding exactly the files of local main at `65e378e`, authored under Tayler's GitHub no-reply address.
  - Local history stays private, and the studied app's evidence is never published.
  - Local work after `65e378e` moves onto the public history with one rebase.
- **Implementation.** A checked export of main's files. Every file was verified clean of personal details, secrets and old names before the push.
- **Status.** Live. Development moves onto it once the current branches merge.

### Strict CI

- **Purpose.** No change reaches main without the same checks a laptop runs, and nothing can skip them.
- **How it works.**
  - CI runs the same command as local development.
  - Required checks have no path filters.
  - Actions are pinned to exact commits, token permissions start at none, and pull request code never runs with secrets.
  - Fast checks run on GitHub's runners. Heavy checks, which need Postgres, Docker and real Claude, run on this Mac and later the AWS server, and post a status tied to the exact commit.
  - Main is protected: pull requests only, required checks, Tayler's approval, and code owners for protected paths.
  - Outside contributors push through a local gate tool, and CI accepts a pull request with either that tool's attestation or the framework's, each bound to the head commit.
- **Implementation.** Not started. It comes after the first merges.
- **Status.** Decided.

### Connecting to GitHub

- **Purpose.** Nobody using Agents has to register anything with GitHub.
- **How it works.**
  - Everyone gets a Connect GitHub button that signs in like `gh auth login`. The token stays on the server, and boxes reach GitHub only through the server's git proxy.
  - Teams that want agents to have their own identity, for repos that require approvals, install the Agents GitHub App with one click.
  - A self-hosted server gets its own App created through GitHub's manifest flow. Its tokens are minted per job, scoped to one repo, and expire within an hour.
  - Our public repo uses the App, because Tayler cannot approve their own pull requests.
- **Implementation.** On the projects agent's branch. Its personal-token file is a stopgap.
- **Status.** Being built.

### Agents on GitHub

- **Purpose.** Pull requests get reviewed, and labeled bugs get fixed with evidence, safely on a public repo.
- **How it works.**
  - A reviewer agent runs automatically on teammates' pull requests, and on outside ones only when a maintainer asks.
    - One agent finds problems, and a second verifies each against the code.
    - It posts one comment-only review sorted into act on, consider, noted and dismissed. Each finding cites a rule, and dismissals give their reason.
  - A bug-fix agent starts only when a maintainer applies a label, after the server confirms that person has write, maintain or admin access. Tayler chose write over triage on 2026-10-13.
    - Triage is read-only.
    - A UI bug must be reproduced twice through the real UI.
    - Before the pull request opens, a fresh agent rereads the issue and checks that the diff fixes it.
    - If an open pull request or a merged commit already fixes the bug, it verifies that fix instead of writing a competing one.
    - The pull request is a draft, with failing-then-passing tests and screenshots or video.
  - Issue and comment text is data: hidden text is stripped, and only comments from people with write access reach a model.
  - Agents return structured findings, and the server does every write, after checking each line against the diff.
  - Spend caps apply per run, per repo per day and per outside author.
- **Implementation.** Not started. It comes after the projects branch merges with its security fixes.
- **Status.** Decided.

### Tasks: dependencies, ready work, holds and promises

- **Purpose.** Stacked work and waiting work stay visible and typed, instead of buried in descriptions.
- **How it works.**
  - Tasks can be blocked by other tasks.
  - A Ready list shows queued work that is unblocked and not held.
  - A hold has a kind (waiting on a person, external, load, parked or future), a reason and an optional end date.
  - A reply an agent promises on an outside channel is tracked as an obligation. It closes only with proof of delivery, or when a person waives it by name.
- **Implementation.** Dependencies, Ready and holds are on main, merged as 7197f4b with migration 0007. Obligations are on the framework agent's branch.
- **Status.** Dependencies, Ready and holds went live on 2026-10-14. Obligations are being built.

### Files, diffs and pull requests in the app

- **Purpose.** Everything an agent writes can be seen and judged in the app.
- **How it works.**
  - A task lists every file its agent changed in each repo.
  - Any file opens in a side panel, rendered or with line numbers, with a Diff tab against the base branch.
  - A task can open a pull request.
  - Tasks can span several repos. Drafts can be written now and started later.
  - A research, plan and implement pipeline has a person's review between stages.
  - Cmd+K jumps anywhere.
  - Comments are pinned to the text they quote.
  - Writes inside a task's own folder no longer ask for approval.
- **Implementation.** On main, merged as 7197f4b with migration 0007. Its acceptance check is Tayler's README task.
- **Status.** Merged and live on 2026-10-14, and the full suite passed on the merge.

### Inviting the team

- **Purpose.** Adding a developer takes one step in the app, and they arrive with their own computer.
- **How it works.**
  - An admin invites by email through the Tailscale API, and the person joins on their first visit.
  - A Tailscale admin page shows users, devices and invites.
  - Each new person gets their own box, and signs in to their own Claude account from the app.
  - People can be added to existing rooms.
  - The Tailscale key lives only on the server and needs renewing every 90 days at most.
- **Implementation.** `server/onboarding.ts`, `server/tailscale.ts`, `server/claudelogin.ts`, `daemon/claude-login.ts`, the Team, Tailscale and Your box pages, and migration 0005. Checked by step12, 12b and 12c.
- **Status.** Live since 2026-10-14, when the restart applied migration 0005. The people socket's live steps are done and `test/live-tailnet.ts` passed, so invites can start once a Tailscale key is saved. Removing a person from the team isn't built.

### Projects and repos

- **Purpose.** A new project starts with its own shared repo and stays separate from other work.
- **How it works.**
  - New project creates a GitHub repo, a room and a project page.
  - Tasks, runs and rooms belong to a project.
  - Every repo is shared by the whole team.
  - Pipeline code stays on this Mac's Gitea forge.
  - A Repos view shows every repo, where it lives, and its branches and pull requests.
  - Repos are polled for changes, since GitHub can't reach the tailnet.
- **Implementation.** On the projects agent's branch.
- **Status.** Being built.

### Agent computers

- **Purpose.** Tayler asked for every agent to have its own computer and to check its own work by looking at it.
- **How it works.**
  - Boxes get a desktop, a browser, browser control and computer use. The sessions on one box share its computer, so an agent has one to itself only when it has a box to itself.
  - A Screen view in the app shows the live display, and a person can take over and hand back. Only the app's own pages may open it, from the origins in `AGENTS_PEOPLE_ORIGINS`, which the API needs to start.
  - Each box runs within 4 GB of memory, 2 CPUs and 4,096 processes.
  - Agents verify each change with tests and in the browser, and attach screenshots to the task. A session the coding framework marks isolated, such as a judge's, gets no computer, since the runner names the only tools a judge may use.
  - Documents can hold images.
  - A helper that lets agents use a Mac is designed but not built.
- **Implementation.** On the agent computers branch, designed in `docs/design/computers.md`. Its checks, `test/step15.ts` and `test/step15b.ts`, run a real box with the stand-in for Claude, and both pass on its last commit. `docs/build-log.md` records what they proved.
- **Status.** Live since the restart on 2026-10-14. No real Claude session has used the computer in a box yet, and nothing is tried over the tailnet. Tayler made every call it waited on, on 2026-10-14, as "2026-10-14, Tayler's calls" records:
  - The 24-hour window stays, in which a box that ran private work can be watched only by people who can see that work.
  - The browser limits stay: the standing instruction never to type passwords or act on real accounts without a person, and the approval before five browser tools.
  - The box limits are accepted, though they take something away. A box running three browser engines at once used 2.5 CPUs before the 2-CPU limit, and boxes had no limits before.
  - A box whose desktop can't come up takes no work, where before it worked without its computer. Accepted too.
  - `ws`, `@types/ws` and `@novnc/novnc` are approved for the Screen view.
  - The daemon refuses to save a screenshot while a page in the box's browser shows a known secret value. It can't cover a secret shown outside the page.
  - A page that can't give its text within 5 seconds, such as one an open alert holds, refuses every screenshot until it can. That takes away saving proof of a dialog, which an agent could do before.

### The cloud half moves to AWS

- **Purpose.** Boxes and long-running work keep going when this Mac sleeps.
- **How it works.**
  - Postgres moves to RDS.
  - One server instance runs the API, Electric and the forge.
  - One instance hosts boxes.
  - Nothing has a public port. Everything goes through the tailnet, except boxes reaching the server's machine port inside the VPC, which Tayler approved on 2026-10-14.
  - Boxes reach the web like any computer, so every agent has its own browser. They never reach the metadata endpoint, the private network, the tailnet or other boxes, and they reach the server only on its machine port.
  - The cutover takes the app down for the export, the restore and a build of the box image. It has not been timed, so the plan allows an hour, and the Mac's stack stays as the rollback.
- **Implementation.** The AWS stack is written in the CDK in TypeScript, on the AWS agent's branch.
- **Status.** Merged on 2026-10-14, and not yet run on AWS. Its export moves Postgres, the forge, the secrets and every box's home volume, and a rehearsal on this Mac, `test/step11f.ts`, resumes a task on a box restored from the export. The nightly backup does not cover the boxes' homes yet. Boxes reach the web as above, and the allowlist that blocked browsing is gone. On 2026-10-14 Tayler approved the `ops/` files, box-to-server traffic inside the VPC, dropping `NET_RAW` from boxes, colima on this Mac dropping the box host's private ranges, and the cost, about $217 a month once it runs, $119 of it the box host running all day. Boxes now run without `NET_RAW`, checked by `test/step11b.ts`. Colima's script and `test/step11g.ts` are written and were tried in a throwaway copy of the VM, and the live steps in `docs/aws.md` wait for Tayler. Nothing is deployed until the Mac version settles.

### Where agents think, and seats on a person's computer

- **Purpose.** A person's agents work at the same time on that person's computer, each with its own screen and browser, and the server decides where and when each turn runs.
- **Decided by Tayler on 2026-10-15,** from the decisions in `docs/design/target-architecture.md`.
  - Agents keep thinking inside each engine's own CLI on their computer, as today. The server places each turn and starts the computer first. Tayler asked to plan for moving thinking to the server later, so the turn queue and the choice of place keep that open. This is decision 1, option (a), with (b) planned.
  - A person's computer has 8 GB of memory and 4 CPUs, and holds 4 seats. This is decision 2, option (b).
  - Seats share one Unix user and the person's logins, as in the agent app we studied. There, each extra display's browser links its cookies and saved logins to the first one's, and a script copies cookies between them every 1.5 seconds (`docs/evidence/box/box-chrome-session.md`). Logging in once logs in every agent on the computer. One agent can read another's files and secrets on the same computer. The walls stay between people, since each person has their own computer. This is decision 3, option (a), with shared logins added.
- **What it changes.** `AGENTS.md` says each cloud agent gets its own Docker container. With seats, a person's agents share one computer with a seat each, so that line needs Tayler's edit.
- **Status.** Step 1, one entry point for every turn, is being built on branch `door`. Seats are step 2.

### Connectors, MCP apps and WebMCP

- **Purpose.** Agents reach Jira, Confluence, Slack and other sources through connectors, answer with visuals and components through MCP apps, and use WebMCP. The design is in `docs/design/target-architecture.md`, "Connectors, MCP apps and WebMCP", with decisions 13 to 20 and build steps 16 to 22.
- **Decided by Tayler on 2026-10-15.**
  - The app gets HTTPS on its tailnet name, since Slack's sign-in returns only to an HTTPS address and WebMCP works only on HTTPS pages. The server's tailnet name then appears in public certificate logs. Turning it on changes Tailscale settings and the live API's origins, so it happens with Tayler at build step 18. This is decision 15, option (a).
  - The regression is accepted. Only admins add team connectors, only an agent's owner or manager adds its servers, and a Mac's owner approves the exact command before a server runs on that Mac. Today any teammate can add a server to any agent. This is decision 17, option (a).
- **The design's picks, which Tayler let stand on 2026-10-15.** Hosted connectors are called from the server's gateway, so no connector token reaches a computer (13). An agent acts as the person whose turn it is, and team accounts are for service accounts only (14). Read-only tools are on and other tools ask (16). MCP apps are off for each connector until a manager turns them on (18). The app offers reads, opening a page and two writes the person confirms as WebMCP tools, never approvals or secrets (19). An agent's browser takes tools from no site until the team lists its origins (20).
- **Status.** Designed. Building starts after seats, with secrets from the app first.

### Agents working together and parallel coding computers come next

- **Purpose.** Tayler called both "super important" on 2026-10-16. Agents message other agents, hand them work and create new ones, and parallel coding work gets computers of its own.
- **Decided by Tayler on 2026-10-16,** from the decisions in `docs/design/target-architecture.md`.
  - Both are built right after step 1 and seats, before the usage meter and budgets, with hard limits until budgets land. An agent chain stops after 4 hops, and at most 8 coding computers run at once for a team.
  - An agent messages its owner's other agents freely, and another person's agent only when that person allows it. Every new agent asks its owner first. This is decision 7, option (b), with the hop limit and no dollar cap until budgets land.
  - Coding computers start warm. A few per team are kept ready with the repo's packages installed, and each is thrown away after one job. This is decision 4, option (a).
  - A coding computer uses the Claude sign-in of the person whose agent started the job, and team pipelines use the team's account. This is decision 5, option (b).
- **Status.** Agents working together is being built. Coding computers start once seats are joined to step 1.

### Every agent has its own desktop, with no setup

- **Purpose.** Tayler, 2026-10-16: "every agent just has a desktop I ask the agent to do something on it and it should work". A person never sets up a computer for an agent.
- **What that means.**
  - Every person's computer exists by itself. It is made when they join, and now for everyone already on the team. No one presses "Make my box".
  - A computer signs in to Claude by itself. Until a person signs in their own account, their computer uses the team's account in `~/.agents-app/box-claude-token`, which is Tayler's today. Teammates who join later get their own sign-in through the one download.
  - Every agent works on its own seat on its person's computer, with no step to put it there. Agents whose home is a Mac move to their person's computer. A Mac keeps the person's own terminal sessions, and later the Mac helper.
  - Each agent's panel shows its computer: a Computer tab with a live view, Open for full screen, and Watching and Take control, as in the agent app we studied.
  - The desktop is a real one, with a dock holding a browser, a terminal and a whiteboard, and normal windows.
- **Status.** Seats are built. Joining them to step 1 comes next, with these defaults, and so do the agent's Computer tab and the desktop.

### How teammates get the app and sign in

- **Decided by Tayler on 2026-10-16.**
  - The Agents app for Mac lives in the menu bar, like Slack or Tailscale. Closing its window keeps it in the menu bar, still saving terminal sessions, and it opens at login as an ordinary Login Item the person can turn off. Quitting it from the menu bar stops it, and the app says what stops with it. There is no separate background helper.
  - Teammates download the app from the team's own server, through a page the invite links to, reachable only on the tailnet.
  - Tailscale invites are on for the live server. Its settings live only in the live API's launchd file, so no check reaches the real tailnet.
- **The coordinator's picks.** The machine token sits in a 0600 file, since a Keychain item would prompt the background daemon. The bundle id is `com.taylerramsay.agents`.
- **How a teammate joins.** An admin invites their email in the app, and Tailscale emails them. They install Tailscale and sign in, then open the invite link. Tailscale tells the app who they are, so there is no password, and they are on the team. From that page they download the app, signed with Tayler's Developer ID, and open it. It finds the server and sets up their Mac. Their cloud computer already exists, and it signs in to Claude through the team's account until they sign in their own.
- **Status.** The download is being built.

### The coding framework builds Agents itself, after seats

- **Decided by Tayler on 2026-10-16.**
  - Right after seats land, building Agents moves onto the coding framework. Its reviewers run on their own machine, its verification points at the real checklist in `.claude/skills/verify-agents/`, and this repo is registered with its policy. From then on the runner runs every gate and records the evidence, and changes go through the app.
  - Until then, the coordinator lands by hand, and every file a landing touches that matches `protectedPaths` in `ops/policies/agents.json` stops for Tayler's approval. That's the policy's list, not only the shorter one in `AGENTS.md`.
  - Tayler approved the four protected files in the landing of step 1, the folder switches and the shape fix: `daemon/agentsd.ts`, `server/runner.ts`, `server/framework.ts` and `server/migrations/0014_door.sql`.
- **Status.** Seats are being built. The framework move comes next.

### Voice: talking to agents, not only typing

- **Decided by Tayler on 2026-10-16:** "voice is going to be important we need to be able to talk to the agents through voice not just type transcription is improtatn". This changes decision 12 from "not now" to building voice in the app. Meetings and phone calls stay later.
- **What it means.**
  - Dictation. The microphone in the message box turns speech into text the person can edit before sending.
  - Voice chat. A person talks with an agent. Their speech becomes the agent's turn, and the agent's reply is spoken back as it streams, sentence by sentence. Talking over the agent stops it. The conversation is saved in the record as text, like any other.
  - Agents keep thinking in Claude Code, as decision 1 says. Voice turns speech into turns and replies into speech, and no separate voice model answers for the agent.
- **The coordinator's pick, which Tayler can change.** Speech runs locally on the server Mac, using the stack Tayler chose for their own voice setup on 2026-09-12: Parakeet for speech to text and Qwen3-TTS for text to speech, with no cloud account. On AWS it runs on the server host.
- **Status.** Next in line after chat attachments, as agents free up.

### Meetings, calendars and calls

- **Decided by Tayler on 2026-10-16.** Meetings and calls are important. Meetings in the app come first, before agents join outside calls.
- **The plan.**
  - Google Calendar and Microsoft 365 connect through sign-in, as connectors. Agents see upcoming meetings, prepare for them and join them.
  - Meetings in the app are rooms with audio, video and screen sharing, run on the team's own server (LiveKit, open source, self-hosted). People and agents join. An agent hears through speech to text, thinks in Claude Code, and speaks through text to speech, using the voice pieces. It can share its own desktop.
  - Each person's audio is transcribed separately, so the transcript knows who said what. It is saved in the record like any conversation.
  - An agent turns the transcript into decisions, action items and a requirements document, and each action item becomes a task with a person's yes, linked to the moment it was said.
  - Joining Google Meet, Teams or Zoom from an agent's own browser comes after meetings in the app. Phone calls come after that.
- **Order.** Voice, then calendars with the connectors, then meetings in the app, then outside calls, then phone.
- **Status.** Designed at this level. Each piece gets its own design section before it is built.

### Under evaluation

- **A Chrome DevTools-based browser driver,** for the verifier's performance and memory evidence.
- **A GitHub CLI wrapper,** and a written spec for agent-facing CLIs. These may shape our own GitHub commands and the shared CLI library.

Each gets an entry here once decided.
