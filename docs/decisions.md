# Decisions

Every decision about how Agents is built and how work on it happens, newest group first. Each entry says what it is for, how it works, how it is built, and where it stands. Parts still being built live on agent branches until they merge, and their design docs in `docs/design/` hold the detail.

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
- **Implementation.** `docs/design/self-improve.md` and the repo-level `CLAUDE.md`, on the framework agent's branch. Each repo gets a versioned policy: sandbox, caps, protected paths and the size limit.
- **Status.** Being built. It still has to decide between forward-only runs and sending failures back to implement, and write down why.

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
- **Status.** Being built. A Chrome DevTools-based driver is under evaluation for performance traces and memory.

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
- **Implementation.** `agentsctl` now, and `agents-git` when it starts. A shared library for these conventions is under evaluation.
- **Status.** In progress.

### Parallel agents, worktrees and landing

- **Purpose.** Many agents work at once without colliding, and nothing lands unverified.
- **How it works.**
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
- **Implementation.** Today, by hand, by the coordinator. Next comes `agents-git`, a TypeScript CLI for these jobs:
  - starting a task's branch and worktree
  - saving work to refs that survive removal
  - syncing, running checks, submitting and landing
  - a ledger of what landed
  - cleanup that previews by default
  
  Claude Code hooks route agents through it.
- **Status.** Decided. `agents-git` starts after the first branches merge.

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
  - Our public repo uses the App, because Tayler cannot approve his own pull requests.
- **Implementation.** On the projects agent's branch. Its personal-token file is a stopgap.
- **Status.** Being built.

### Agents on GitHub

- **Purpose.** Pull requests get reviewed, and labeled bugs get fixed with evidence, safely on a public repo.
- **How it works.**
  - A reviewer agent runs automatically on teammates' pull requests, and on outside ones only when a maintainer asks.
    - One agent finds problems, and a second verifies each against the code.
    - It posts one comment-only review sorted into act on, consider, noted and dismissed. Each finding cites a rule, and dismissals give their reason.
  - A bug-fix agent starts only when a maintainer applies a label, after the server confirms that person has write access.
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
- **Implementation.** Dependencies, Ready and holds are on the workflow agent's branch. Obligations are on the framework agent's branch.
- **Status.** Being built.

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
- **Implementation.** On the workflow agent's branch. Its acceptance check is Tayler's README task.
- **Status.** Being built.

### Inviting the team

- **Purpose.** Adding a developer takes one step in the app, and they arrive with their own computer.
- **How it works.**
  - An admin invites by email through the Tailscale API, and the person joins on their first visit.
  - A Tailscale admin page shows users, devices and invites.
  - Each new person gets their own box, and signs in to their own Claude account from the app.
  - People can be added to existing rooms.
  - The Tailscale key lives only on the server and needs renewing every 90 days at most.
- **Implementation.** On the onboarding agent's branch.
- **Status.** Being built.

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

- **Purpose.** Every agent has its own computer and checks its own work by looking at it.
- **How it works.**
  - Boxes get a desktop, a browser, browser control and computer use.
  - A Screen view in the app shows the live display, and a person can take over and hand back.
  - Agents verify each change with tests and in the browser, and attach screenshots to the task.
  - Documents can hold images.
  - A helper that lets agents use a Mac is designed but not built.
- **Implementation.** On the agent computers branch.
- **Status.** Being built.

### The cloud half moves to AWS

- **Purpose.** Boxes and long-running work keep going when this Mac sleeps.
- **How it works.**
  - Postgres moves to RDS.
  - One server instance runs the API, Electric and the forge.
  - One instance hosts boxes.
  - Nothing has a public port. Everything goes through the tailnet.
  - Boxes may reach only the Claude API, the package registries and the server, never the metadata endpoint.
  - The cutover takes about 10 minutes, and the Mac's stack stays as the rollback.
- **Implementation.** The AWS stack is written in the CDK in TypeScript, on the AWS agent's branch.
- **Status.** Ready to run once Tayler sets up AWS access.

### Under evaluation

- **A Chrome DevTools-based browser driver,** for the verifier's performance and memory evidence.
- **A GitHub CLI wrapper,** and a written spec for agent-facing CLIs. These may shape our own GitHub commands and the shared CLI library.
- **A tool that trains instruction files from examples.** Compared with our coach and improve pipelines.

Each gets an entry here once decided.
