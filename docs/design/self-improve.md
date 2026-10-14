# The coding framework

On 2026-10-13 Tayler asked for this in these words. "I want to be able to work on this app through this UI, think of it self improving its own code base, but every agent that works on this code base needs to follow strict constraints." After reading the first plan Tayler said "this is not enough constraint" and set the rules below. Then Tayler made the framework part of Agents, a product feature. Every agent doing coding work in Agents runs inside it, on any repo the team works on. The Agents codebase is its first and strictest user.

This document is the design. `AGENTS.md` at the repo root, which `CLAUDE.md` imports, is the short version an agent reads. The schema is in `docs/data-model.md` under "Added while building". Each part gets an entry in `docs/what-each-part-does.md`.

Status words used below:

- **Built** means it exists and a check in `test/step16*.ts` exercises it, failing on a change that breaks the rule and passing on one that keeps it. The guards also seen failing with their own code broken are listed under "How each check was seen failing".
- **Designed** means this document says how it works and nothing enforces it yet.
- **Not enforced yet** means a person has to judge it, and the gap is named.

## What the framework is

A repo gets a **policy**, the rules every change to it must pass. A coding request on that repo runs a **playbook**, a pipeline whose stages come from the framework's stage kinds. The runner, not the agent, runs every gate and writes what it saw as **evidence**. Reviewers on other models write **findings**. Agents and people write **decisions**. Lessons the team learns become **structure**: a gate, a lint rule or a check. A person can **pause** any run and resume it later.

Product data, not this repo's files, holds the policy, so any repo the team adds gets the same framework. A repo without a policy works as before. The Agents codebase's policy is `ops/policies/agents.json`, loaded into Postgres by `server/admin.ts set-policy`.

## How a change moves

The `app-change` playbook (`pipelines/app-change.ts`). Every stage that judges the change is run by the runner from the policy. Nothing below takes the coding agent's word for a result. The review and the verdict rest on the judges' reports, so both are advisory until the judges run on their own machine.

1. **route.** An agent picks the playbook for the request from the ones the policy allows. The choice is a decision in the log. The runner later checks the diff fits the playbook's scope.
2. **understand.** An agent with read-only tools writes `understanding.md`: what the code does now, what this change touches, what could break. The runner checks the document has those sections. Like plan and implement, it can report ask instead, which hands the run to a person.
3. **plan.** An agent writes `plan.md` with the sections Concern, Done means, Keep, Files and Size. Each Done means item names the check that will show it. Each Keep item names a feature from the repo's feature map.
4. **approve_plan.** A person approves the plan before any code is written. Rejecting sends the notes back to the plan.
5. **implement.** An agent changes the code in a box, on the task branch. It never commits or pushes.
6. **verify.** The runner pushes the branch, reads the diff from its own copy of the repo, and runs the static gates. Then the box runs the policy's commands on a clean checkout of the pushed commit, with the check configuration taken from the merge base, main's commit the change started from, and runs every changed check against main and against the change. Failing sends the findings back to implement. A refused push to main stops the run.
7. **review.** One or more reviewers, each on a model other than the author's, review the diff against main's copy of the coding standards and the approved plan, without the author's session. The review is advisory until the reviewers run on their own machine. Each blocking finding cites the rule it breaks. Blocking findings go back to implement. After the round limit, only the repo's owner can overrule them, by name, or stop the run.
8. **confirm.** A fresh agent on another model, not the author, checks each Done means and Keep item using main's copy of the repo's verification skill, and gives a verdict from a fixed ladder. The runner judges the verdict by the commands the record shows it ran. That record comes from the author's box, so the verdict is advisory until the verifier runs on its own machine. Its findings work like a reviewer's.
9. **open_pr.** The runner opens the pull request with a description written for a reviewer who was not there: what changed, what was checked, the risks the understanding named, and what the pipeline had to send back, then the verdict, the findings and the decisions, each in a fence, since agents and people wrote them. It marks the review and the verdict advisory. Commit statuses on the forge say which gates passed.
10. **protected.** If the change touches a protected path or a dependency, the run stops at a gate only the owner can pass. The pull request names each protected file and shows its diff. Otherwise this gate passes by itself and says why.
11. **approve_suite.** A person approves running the full check suite. The suite runs agent-written code with the test database, so it never runs unreviewed.
12. **suite.** The check host merges the branch into the current main, runs the full suite on the result, and runs every changed check against main and against the merge. For a UI change it reads the screenshot manifest `agentsctl` writes, which the runner does not check yet. When the suite passes, the runner writes its attestation into the description and puts its digest on the head commit.
13. **approve_merge.** The owner approves the merge with the evidence bundle. Rejecting sends the notes back to implement.
14. **merge.** The runner merges exactly the approved commit, and only while main is the commit the suite tested. If main moved, the suite runs again.
15. **approve_deploy.** The owner approves deploying, separately from the merge.
16. **deploy.** The deployer installs the merged commit as a new release, restarts the API, checks its health, and rolls back by itself when the check fails.

## The rules and what enforces them

### Hard gates

A change cannot merge while any of these fail. Hard gates have no overrule. The one exception is the verdict, where the owner may accept a weaker one than the policy asks, by name, and the merge records the acceptance as its proof.

| # | Rule | Enforced by | Status |
|---|---|---|---|
| 1a | Typecheck and type-aware lint pass | Box gate: `tsc` and `eslint` on a clean checkout, with `eslint.config.js` and `tsconfig*.json` from the merge base | Built |
| 1b | CSS lint: no accent color in a border, outline, box-shadow or SVG stroke, no gradients, every color from the design tokens | Static gate on the changed lines (`shared/gates/css.ts`), and `test/style.ts` over the whole repo | Built |
| 1c | Prose lint: no em dash, no banned word, no title-case heading, in docs, comments and UI strings | Static gate on the changed lines (`shared/gates/prose.ts`), and `test/style.ts` over the whole repo | Built |
| 1d | The name guard | `test/names.ts`, run by the box on the whole checkout. No static gate reads changed lines for names | Built |
| 2 | The full suite passes on the result of merging into main | `suite` stage on the check host, after the owner approves running it, and the merge refuses unless main is still the commit it tested. The check host's result must hold every command it was sent and every changed check | Built with a stand-in check host, the real host designed. step16 runs a stand-in suite, the name guard, so `npm run check` has not run end to end on a check host |
| 3 | Every check file the change adds or edits fails on main's code and passes on the change | Box gate for checks marked `// runs-in: box`, check host for all of them. A check that cannot load on main, because it imports what the change adds, counts as failing there | Built |
| 4 | A change under `app/` includes a Playwright check that names three engines and two widths, with screenshots on the pull request | Static gate requires such a check. It cannot tell whether the check drives the changed view. The check host reads the screenshot manifest | The static part is built. Screenshots wait on `agentsctl` |
| 5 | A new migration changes `docs/data-model.md` in the same pull request, and an existing migration is never edited | Static gate | Built |
| 6 | A new source file has an entry in `docs/what-each-part-does.md`, and every change adds to `docs/build-log.md` | Static gate | Built |
| 7 | The diff passes a secret scan with the `shared/scrub.ts` patterns, and adds no `.env` file | Static gate | Built |
| 8 | A dependency change uses exact versions, says why in the build log, and goes to a person | Static gate, then the owner's gate | Built |
| 9 | No new eslint-disable, inline eslint config, ts-ignore, ts-expect-error, skipped or only tests, or loosened assertions | Static gate on the changed lines | Built for the markers, inline config and removed assertions. Subtler loosening is judged by the reviewers. Turning inline config off for good, with `noInlineConfig` in the protected `eslint.config.js`, is for Tayler |
| 10 | One concern per pull request, at most 400 changed lines without lockfiles | Static gate for the size, which charges a binary file that is no image at 80 bytes a line. The plan names one concern, and the reviewers judge it | Size built. Stacked pull requests designed |
| 10b | No changed file the gates cannot read, because git calls it binary or it is over 2 MiB, except lockfiles and images whose first bytes and extension name the same format, PNG, JPEG, GIF, WebP or ICO. No path git quotes, no path holding U+FFFD, which is how a name that is not UTF-8 reads, no path two changes share, and no diff whose hunks add another number of lines than git counts | Static gate `opaque`, on a diff the runner reads one file at a time through a literal pathspec, each hunk by its counts. Findings sit on git's lines, counted by LF alone, though TypeScript also ends a line at a lone CR, U+2028 and U+2029. One NUL byte in a comment used to hide a whole script from every other gate | Built |
| 11 | No new file in a language other than TypeScript, outside an allowlist | Static gate | Built |
| 12 | No new type assertion except `as const` | Static gate on the changed lines, from the TypeScript syntax tree | Built for new lines. The whole-repo lint rule is for the standards retrofit |
| 13 | No new TODO, FIXME or XXX comment | Static gate on the changed lines | Built for new lines. `no-warning-comments` for the whole repo is for the retrofit |
| 14 | No new `exec` or `shell: true` | Static gate on the changed lines, from the syntax tree | Built for new lines. The lint ban is for the retrofit |
| 15 | No push to any branch but the run's task branch | On a repo with a policy the git proxy refuses a push to any branch but the task branches of the pushing machine's own workspaces, and records it, the forge's branch protection refuses a push to main too, and verify stops the run. A repo without a policy takes pushes to any branch, as before. The proxy reads only a push's command lines, at most 1 MiB, and streams the pack | Built |
| 16 | The diff fits the playbook the router picked | Static gate | Built for the docs and dependency playbooks. Only the docs playbook has a check |
| 17 | Every Done means item names a check the change adds or edits, and every Keep item names a feature in the map | Static gate on the approved plan, and the plan lint before anyone reads the plan. A feature map the policy names and main lacks fails both | Built |
| 18 | An edit to an existing check never rides along with product code. A change to checks alone, new or edited, goes to the owner, since seen failing cannot judge it, and an edited one needs its reason in the build log | Static gate `check_edits` | Built |
| 19 | A verifier that did not write the change gives a verdict at least as strong as the policy's floor for the kind of change, or the owner accepts a weaker one by name | **Advisory.** The confirm stage, judged by the commands the record shows the verifier ran, and readiness. The verifier runs on the author's box, so its report is not proof | Built, advisory |
| 20 | The change merges into the current main without conflicts | Readiness runs `git merge-tree` on the mirror before the merge | Built. No check makes a conflicting change yet |

Rules 11 to 14 are four of the five checks the coding standards name for the standards retrofit. The fifth, regenerating database row types from the schema and failing when they are stale, is not built here. Until it is, each new table's row type is declared once in `shared/framework.ts`.

### Protected paths

A change touching any of these stops at the `protected` gate, which only the repo's owner can pass, and the pull request shows each one's diff. For the Agents codebase:

the list in `protectedPaths` of `ops/policies/agents.json`, which `AGENTS.md` shows grouped: the rules agents read in any folder (`**/AGENTS.md`, `**/CLAUDE.md`, `.claude/**`), the lint, compiler and package config, the checks that guard the rules and `test/fake-claude.ts`, the framework's own shared, server and daemon code, `pipelines/app-change.ts`, `server/migrations/**`, and `ops/**`, `box/**` and `compose.yaml`. Every file under `test/` also counts as a check when edited, so an edit to a helper never rides along with product code.

These are the instructions agents read, the lint and compiler configuration, the guards and their checks, the gate code, the runner that calls it, the pipeline, the sandbox and the deploy scripts. The forge holds the same list as protected file patterns on main, so a pull request touching one cannot merge without the owner.

Agents can never weaken their own constraints for three more reasons. The static gates run inside the API, which is the code from the last deploy, so a change cannot alter the gates that judge it. The box runs its commands with the check configuration copied from the merge base. And the pipeline file lives in the pipelines repo, which agents working on the app never touch, and the API never loads a pipeline from a repo that has a policy.

### Independent review

| Rule | Enforced by | Status |
|---|---|---|
| A second agent reviews before any person sees the change | The `review` stage comes before `open_pr` | Built |
| The reviewer runs on a different model | The runner refuses to start a reviewer whose model is unset or matches the author's, or another reviewer's | Built |
| The reviewer works without the author's reasoning | A new session of its own, listed among its row's reviewers in the transaction that creates it, so the API refuses a person's message to it with a 409 instead of starting it with a workspace's permissions, the team-record tools and no budget. No team-record tools, read-only tools, and a prompt holding only the plan, the diff, main's copy of the standards and the principles | **Advisory until judges run on their own machine.** They run on the author's box, so any process with that box's token could post a judge's report or fake its commands, and they start in the author's folder, which loads the branch's `CLAUDE.md` and `AGENTS.md`. Not built: a separate instance with its own token, refusing a judge's report from a session on the author's instance, and a clean folder holding main's rules with empty setting sources |
| Each finding cites the rule it breaks | The runner rejects a finding whose rule is not a rule name from the coding standards or the policy | Built |
| Each blocking finding is fixed or overruled by Tayler by name | Findings stay open until a later round no longer reports them. After the round limit, an ask only the owner can answer overrules them, recorded with the owner's name. A finding the owner overruled stays overruled when a later round raises the same one: the same rule, without case, spacing or a closing period, the same path and the same body | Built |
| A finding about security, auth, billing, data, migrations or concurrency always reaches a person | The judge tags the finding's topic, and any tagged finding opens an ask only the owner can answer, whatever the author makes of it | Built |

### Person gates

| Rule | Enforced by | Status |
|---|---|---|
| The plan is approved before code for anything touching schema, API, auth, boxes or UI flows | `approve_plan` comes before `implement` in every `app-change` run, and verify fails when the run has no approved plan | Built, for every change rather than only those areas |
| Tayler approves running the suite | `approve_suite` only the owner can answer, since the check host runs the change's code and is not isolated yet | Built |
| Tayler approves the merge with the evidence bundle | `approve_merge` only the owner can answer. Approving posts the owner's approval on the forge, which branch protection requires. A verdict below the floor merges only with the owner's acceptance by name, which the merge's proof carries | Built |
| Deploy is approved separately and rolls back by itself | `approve_deploy` only the owner can answer, then the deployer's health check and rollback | Built, run against a stand-in target. Never run against the live server |

### The sandbox

| Rule | Enforced by | Status |
|---|---|---|
| Changes are made only in a box | The policy says `sandbox: box`. The runner refuses to begin a run that would use a home machine, and the API refuses a task people start on that repo unless the agent's home is a box | Built |
| A box holds no secret it does not need | A box holds its machine token and a Claude token, which it needs, and the agent inside can read both. The fix is a token per session, scoped to that session | Not enforced yet |
| No Docker socket | `server/boxes.ts` mounts only the box's home volume | Built, read from the code. No check reads a running box's mounts |
| A box reaches the server only on its machine port | The colima firewall, `ops/box-firewall.sh`, lets boxes reach the server Mac only on the machine ports (`check:step2b`). Through them a box can do only what its token allows | Built before this work |
| A box never reaches the metadata endpoint, the private network, the tailnet or other boxes | The firewall guards only the server Mac's own address | Not enforced yet |
| Branch protection on main | Set by API from the policy: no pushes, the owner's approval, the four gate statuses, and the protected file patterns | Built |
| Caps on time and spend | The pipeline's spend cap, lowered by the policy's, the policy's cap on working minutes, and its caps across runs on the repo | Built. Only the repo's daily spend cap has a check |

Boxes keep the open web. Each agent is a teammate with its own computer and a browser on the open web, so the framework never limits where a box can browse. Tayler decided this on 2026-10-13, which rules out an allowlist of outbound destinations. What protects a box instead is the three rows above it: the machine port as its only way to the server, no route to the metadata endpoint, the private network, the tailnet or other boxes, and no secret it does not need.

### Written down, judged by people

`AGENTS.md` holds the writing and UI design rules that no gate checks yet, such as no colon joining two halves of a sentence, and no list of identical cards. The reviewers use them as part of their rubric.

## The framework's own principles

Tayler set eight principles for the framework itself. Each row names what holds it on this branch.

| | Principle | Held by | Status |
|---|---|---|---|
| a | One gate, one meaning. A policy may add checks and tighten the core, never remove, reorder or weaken it. A person may skip a step for one run, by name. No standing rule can. | `POLICY` in `shared/policy.ts` refuses a size cap above 400 or a verdict floor below the core's, and `test/step16b.ts` shows both refused. The static gates, seen failing, review, the verdict, the suite and the owner's merge are not settings. The merge asks for each of them whatever stages the pipeline has, including a review and, for code, an approved plan. A person's skip is an overrule, recorded with their name | Built |
| b | A gate that cannot run completely refuses loudly and says what to fix. It never runs a weaker check in silence. A failed shortcut falls back to the slow, correct path. | A feature map the policy names and main lacks fails the plan lint and the plan gate. A missing verification skill or map fails confirm, and a missing rubric stops review. A judge that cannot be shown independent fails its stage. A verdict claiming live UI verification is recorded as blocked until screenshots reach the record. A failed suite runs once more before it counts, and the same failure twice is real | Built. The missing skill, the missing rubric and the suite's rerun have no check yet |
| c | Never lose work. Every history rewrite is anchored to what the run observed, and fails closed. | The daemon's push, main's lease in `daemon/workspace.ts`, fetches the forge's copy of the task branch and pushes with a lease on that commit, only when this workspace pushed it last or HEAD already holds it. Otherwise it pushes nothing and fails the stage with "someone added commits on the forge, ask the agent to merge them". The merge names the head the gates judged, and the forge refuses it if the branch moved. LEASE in `test/step16.ts` shows a person's commit on the task branch kept, with that refusal, and main's `test/step14.ts` checks the lease | Built |
| d | A person's decision at a gate becomes a fact of the run. Later stages receive it, respect it, and park the run when they cannot. | Each answer is a row in `decisions`, and every later agent gets the run's decisions with its instructions. A finding the owner overruled stays overruled when a later round raises it. Understand, plan and implement can report ask, which hands the run to a person. DECIDED in `test/step16.ts` shows the first two | Built |
| e | Weigh forward-only against sending the change back, pick one, and write the decision down. | "Send back or forward only", below | Decided |
| f | Every verdict records the exact build and configuration that produced it. The pull request is written for a reviewer who was not there. | Evidence rows and verdicts carry the runner's build, the box's or check host's build, and the hash of each input read from main. The description holds What changed, What was checked, Risks and What the pipeline had to fix | Built. The Claude Code version a judge ran is not recorded |
| g | Run state is honest. A run is working, parked waiting on a person, or dead, and a stall never looks alive. | A command left with a machine silent past `AGENTS_SILENT_MACHINE_SEC` fails its stage, which hands the run to a person. An agent with no tool call for the policy's liveness window is replaced by a fresh session, then the stage fails. Every other stage has a time limit | Built for repos with a policy. A repo without one keeps the hour-long stage limit |
| h | A pushed branch is untrusted input. Nothing on it chooses what runs with the owner's credentials. | The policy, the pipeline, the gate code, the check configuration, the design tokens, the rubric, the verification skill and the feature map come from the database, the API's own code or main. Judges get main's rubric and skill in their prompts. The suite's command is the policy's. `package.json`, which says what `npm run check` runs, is protected, so the merge result differs from main there only after the owner passed it. The merge names the head the gates judged | Built |

## Send back or forward only

A failed verify, a review that blocks, a verdict that fails and a failed suite could each end the run, so that a new run starts from the findings. Or they could send the change back to its author in the same run. I picked sending it back, with bounds.

- The author has the context. A new run would pay again for understanding and planning, and a person would approve the same plan twice.
- Every pass runs every gate again from the start, on the new commit. Nothing carries over but the people's decisions, so a loop cannot skip a gate.
- The loops are bounded. Implement runs at most six times, review blocks for at most three rounds before the owner decides, and the suite reruns once for a flake.
- The cost is visible. The pull request lists every send-back under "What the pipeline had to fix".

One case stays forward only. A run the gates stopped for trying to get past them, such as an agent pushing to main, ends and does not loop.

## Policies

A policy is a versioned row in `policies`. A repo points at one version, and every evidence row records the version it was judged by. A policy holds:

- `sandbox` is `box` or `any`.
- `maxRunMinutes` and `maxSpendUsd` are the caps.
- `protectedPaths`, `maxChangedLines`, `lockfiles`, `sourceDirs` and `allowedFiles`, the allowlist of files that may be in a language other than TypeScript.
- `docs` names the data model, parts and build log documents, and the migrations folder.
- `checks` gives the pattern for check files, the marker for ones a box can run, and the command that runs one.
- `box` lists the files copied from the merge base before the box runs, and its commands as argument lists.
- `suite` is the check host's command.
- `ui` lists the paths that count as UI, and the engines and widths a UI check must cover.
- `lint` holds the CSS token file and neutral tokens, the banned words, and the names the name guard refuses.
- `review` says how many reviewers on distinct models, and the round limit.
- `playbooks` lists the playbooks the router may pick.
- `principles` are short rules the agents and reviewers read.
- `verification` names the verification skill and the feature map.

Only the repo's owner, or an admin on the server, changes a policy. An agent has no route to it. A repo without a policy runs pipelines as before, with none of the gates.

## Evidence the runner collects

- **`evidence`** has one row per gate per commit, with pass, fail or needs_owner, a summary, and details such as exit codes, output tails, the findings of a lint, or a protected file's diff. Each row names the builds that produced it: the runner's, the box's or check host's when one ran the gate, and the sha256 of each input read from main, such as the design tokens or the rubric. A build is the commit when there is one, a hash over the source the process runs, and the Node version (`shared/build.ts`). Only server code writes evidence.
- **Commit statuses** on the forge. The runner sets `agents/gates` after verify, `agents/review` after review, `agents/verdict` after confirm, and `agents/suite` after the suite. Branch protection requires all four. After the suite it also sets `agents/attestation`, described below.
- **The pull request description** is written for a reviewer who was not there. It holds the agent's summary, then What changed (each file with its line counts), What was checked (every gate's latest result on the head, with the policy version and the runner's build), Risks (the understanding's "What could break"), What the pipeline had to fix (each send-back, with its first points), the verdict, the review findings and the decision log. The runner writes it again each time the run comes back to open the pull request, so it always describes the head.

The merge checks that the head commit has passing evidence for every gate in the policy, a passing review and verdict, an approved plan for code, an approval from the owner after the suite, a suite run against the current main, and a clean merge into it. Any pipeline merging on a repo with a policy goes through this check, so a pipeline file that skips or drops a stage still cannot merge. The check returns a typed proof, and `test/types-framework.ts` shows at compile time that no proof can be built without each part.

## Static gates

The API keeps a bare copy of each repo under `$AGENTS_HOME/mirrors`, fetched with the factory's credentials. Reading a diff from it runs no repo code. Verify fetches the pushed commit and main, takes their merge base, and reads every changed file before and after. The rules are pure functions in `shared/gates/` over that diff and the policy, so `test/step16b.ts` checks each rule on small fixtures as well.

Lint rules only fail on lines the change adds, so a change is never blocked by an old line it did not touch. `test/style.ts` lints the whole repo in `npm run check`, and the repo passes it today.

## Box gates

The daemon runs the box's part as the command `verify`, from its own code in the box image, never from the workspace. It makes a clean checkout of the pushed commit beside the agent's, copies the policy's check configuration from the merge base over it, links the workspace's `node_modules`, and runs each command as an argument list with a time limit. Then, for each changed check that carries `// runs-in: box`, it runs the check on a checkout of main with only that check file copied in, where it must fail, and on the change, where it must pass. The checkouts are removed after.

## Seen failing, and what it cannot prove

The runner proves that each changed check exits non-zero on main and zero on the change. It cannot prove:

- that the check fails on main for the reason the change addresses. A check that cannot load on main, because it imports a module the change adds, counts as failing.
- that an edited check still covers what it covered before, beyond the gate on removed assertions.
- that a check marked for the box needs nothing a box lacks. A wrong marker makes it fail in the box, which blocks the change, so the mistake is loud.
- anything about checks the change did not touch. Regression for those comes from the full suite and the feature map.
- that the box was untouched. An agent that leaves a process running could change a checkout during the gate. The check host runs everything again on a machine the agent never touched.

## Independent review and fresh verification

A `review` stage starts one session per reviewer, each a new session with no team-record tools and only read-only tools. The prompt holds the approved plan, the diff from the mirror, the principles, the team's lessons, and main's copy of the coding standards as the rubric, starting with its "No shortcuts" section. The reviewer's checkout is the branch under review, which may have edited its own copy of the standards, `AGENTS.md` or `CLAUDE.md`, so the prompt says main's copy wins. A reviewer reports `clean` or `blocking`, with findings that each name a file, a line and the rule they break. The runner parses the findings with a schema and refuses any that cite an unknown rule.

A finding stays open until a later round does not report it. Blocking findings send the change back to implement. When the round limit is reached with findings open, an ask only the owner can answer offers overrule or stop. Overruling records the owner as the person who decided each finding.

`confirm` is the same stage kind with a verifier agent that may run commands. It follows the repo's verification skill to check each Done means and Keep item, and reports findings the same way. Every command it ran, with its output, is in the record and in the evidence.

## The full suite and the check host

The suite needs Docker, the test database and the test Electric, which a box cannot reach. The options:

| Option | Agent code can reach | Cost | Verdict |
|---|---|---|---|
| Run it on the server Mac after a person approves the diff | Everything the server holds: `.env`, the forge's admin token, the Claude token, the live database on the same Postgres | Nothing new to build | Rejected. Review catches most mistakes, and a missed one acts on the live system |
| A second macOS user on the server Mac | Every loopback port, including the people port, which trusts a login header from any local process | A user and a firewall per user | Rejected. Local processes can pose as Tayler |
| A Linux VM on this Mac (a second colima profile) with its own Postgres, Electric and forge, no home folder mounted, and a firewall allowing only the machine port | The machine port, with a check-host token | Porting the suite to Linux. Two Mac-only checks stay with Tayler | Picked as the next step |
| A dedicated machine on the tailnet, Tailscale rules allowing only the machine port | The same | A machine | The long-term home if the VM is too slow |
| Hosted CI, if the repo moves to GitHub | GitHub's runners and the secrets given to them | Minutes, and the real-Claude checks need a token there | Revisit after the repo decision |

**For now the check host is its own instance, kind `check`, and it only ever runs the suite after a person approves running it.** The runner sends it the command `suite`. It clones the repo through the API's git proxy, merges the pushed commit into the current main, runs the policy's suite command on the result, runs every changed check against main and against the merge, and reports. It holds no live secrets. Today the check host is a daemon on this Mac, which is what the checks use. Moving it into the colima VM is the next step, and needs these changes to the suite: `.env.test` and the forge file named by the host's own config instead of `~/.agents-app`, and `check:step2b` and `check:step4c` marked as Mac-only and run by Tayler before a deploy.

## Screenshots and agentsctl

The verification agent is building `agentsctl`, a CLI and TypeScript library for driving Agents. The framework's evidence stages call it rather than driving browsers themselves. What the framework needs from it:

```ts
type Engine = 'chromium' | 'firefox' | 'webkit'
type Width = 'desktop' | 'phone'
type Shot = { view: string; engine: Engine; width: Width; path: string; sha256: string }

up(options: { checkout: string; name: string }): Promise<Instance>       // an isolated Agents from a checkout
down(instance: Instance): Promise<void>
doctor(instance: Instance): Promise<{ ok: boolean; problems: string[] }>
browse(instance: Instance, options: { engine: Engine; width: Width; login: string }): Promise<BrowserSession>
// BrowserSession: open(path), byRole(role, name) to click or fill, screenshot(view) returning a Shot, close()
evidence(instance: Instance): Promise<{ shots: Shot[] }>                  // also written to <out>/evidence.json
diff(shot: Shot, baseline: string): Promise<{ ratio: number; image: string }>
```

The check host reads `evidence.json` after the suite, in that `{ shots }` shape, parsed with `EVIDENCE_MANIFEST` from `shared/verification.ts`. The verification agent owns that file, and the gates and `agentsctl` parse evidence and the feature map with the same schemas. The check host returns the shots with its result. **Not built.** The runner does not yet check that every changed UI check produced a shot for each engine at each width, and does not attach the files to the pull request. Until it does, the static half of rule 4 runs, and the screenshot half is not enforced.

## Deploy

A deploy is a row in `deploys`, written by the runner once the owner approves it, and carried out by the deployer, `ops/deploy.ts`. The deployer is a separate process because a deploy restarts the API, which is where the runner lives. On the server it runs as its own launch agent, `com.agents.deployer`, which this work does not install.

The lifecycle is a typed transition table: requested, preparing, switching, checking, then healthy, rolled back or failed. For each deploy the deployer:

1. Fails any requested row older than 30 minutes, so a stale approval never goes out, then claims the oldest requested row. The runner fails its own deploy on the same rule, so a run never waits on a deployer that is not running.
2. Makes a release folder for the commit from the repo under a `.partial` name, runs the target's install command in it, and renames it into place only once it installed. A failed install removes it.
3. Backs up the database with the target's backup command.
4. Runs the migrations from the release. Migrations must work with the release before them, since rollback does not undo them.
5. Points the `current` link at the release and restarts the API with the target's restart command.
6. Polls `GET /v1/health` until it answers with the new commit, or the time runs out. Each request has a 3 second limit, and an answer that is slow, unreachable or not the health JSON counts as no answer.
7. On failure, points `current` back at the previous release, restarts, and checks that the previous commit answers. The row ends `rolled_back`, or `failed` when the previous release does not come back either, which asks Tayler at once. Any error after the switch also goes back, and ends the row `failed`.

Every subprocess, and every git command against the mirror, has a time limit. Rollback puts the code back, never the migrations.

`GET /v1/health` answers on the machine port once Postgres answers, with the build the process runs, read once at start. The deployer compares the build's commit. The target is a config file parsed at start: the release folder, the repo, and each command as an argument list. `test/step16c.ts` deploys to a target in a temporary folder, with a test API on a test port, and shows a healthy deploy and a rollback. Then a deployer that takes one deploy and exits meets each failure path: an install that fails, a health answer that is not JSON, one that never comes, a switch that throws, and a deploy that waited too long. It never touches launchd or the live database.

## Router and playbooks

A playbook is a pipeline. The router is the first stage of a coding run, a `route` stage, where an agent picks one of the playbooks the policy allows. The built-in playbooks, in `shared/framework.ts`:

- `change` is for a feature or a fix. Done means names new or edited checks.
- `bug` is for a reported bug. The first Done means item is a check that reproduces it.
- `docs` is for changes to documents only. The runner fails a docs run that changes anything else.
- `dependency` is for a dependency change. Only manifests, lockfiles and the build log may change, and the owner's gate always opens.

The chosen playbook's guide is part of the implement prompt. Today every playbook runs the `app-change` stages, and the scope check is what differs. Teams adding their own playbooks, as rows a person edits in the app, is designed.

## Understanding, `Done means` and `Keep`

An agent stage can require a document. The runner waits for the document from the task folder after the agent reports, and fails the stage when the document is missing or lacks a required section. `understand` requires `understanding.md` and `plan` requires `plan.md`.

The plan is pinned when the person approves it. The gate records the plan's version, and verify reads that version, so editing the plan during implement changes nothing. Each Done means line names a check as `(check: test/step91.ts)`. Each Keep line starts with a feature id from the map, as `` `record`: posts keep their order ``.

## Regression through the verification skill and the feature map

Each repo can have a verification skill, a Claude Code skill that says how to check each feature works the way a person uses it, and a feature map, a JSON file listing each feature's id, name, paths and checks. For the Agents codebase they are `.claude/skills/verify/SKILL.md` and `.claude/skills/verify/features.json`, both protected.

Regression uses the map three ways. The plan's Keep items must name features in it. The evidence lists the features whose paths the change touches. And the suite's output is matched against those features' checks, so the pull request says which features were checked and passed. The verifier in `confirm` reads the skill. Driving views like a person waits on `agentsctl`.

## The decision log

`decisions` holds what was decided, why, and the alternatives, by an agent's session or by a person. Agents log decisions with the `log_decision` tool, which every session has. The API reads the tool calls from the record as they arrive, so the log is complete whether the tool's server answered or not. The runner logs each answer a person gives at a gate, the router's choice, and each overrule. The pull request and the run page show the log.

## Principles and lessons becoming structure

Principles are part of a policy. They are short rules, such as "fix the cause, not the symptom", that coding agents and reviewers read.

A lesson is a row in `lessons`: the rule, the incident it came from, the evidence, and what enforces it. A lesson starts as written, which means only people and agents reading it hold it. It becomes enforced when it names the gate, lint rule or check that holds it, which has been seen failing. Every coding session and reviewer gets the team's lessons. The coach pipeline proposing an enforcing check for a lesson that keeps getting broken, as an `app-change` run, is designed.

## Pause and resume

A person pauses a run from the API. The runner stops its agent sessions and leaves it alone. Commands already sent finish, and their results wait. Resuming starts any interrupted agent stage again in the same session, so the agent keeps its context, and the run carries on from its latest row. Answers given to a paused run's asks are kept. Time paused does not count toward the time cap, which counts working minutes.

## Verdicts

A verdict is one word from a fixed ladder, strongest first, defined in `shared/verification.ts`:

- `live-ui-verified`, the verifier drove the changed view and saw it work.
- `unit-test-verified`, the change's checks ran and passed.
- `type-check-only`, only the typecheck applies, as for a change to documents.
- `verifier-blocked`, the verifier could not judge.
- `verifier-failed`, an item does not hold.

The policy sets the weakest passing verdict for code, for documents and for UI, and the core sets a floor no policy goes below. The runner checks the verifier's word against the record. A passing verdict from a verifier the record shows running nothing becomes `verifier-blocked`, and so does `live-ui-verified` until screenshots reach the record. The record of what the verifier ran comes from the author's box, so the verdict stays advisory until the judges run on their own machine. A verdict is kept by pull request and head commit with the change's patch-id. A new head voids it unless the patch-id is the same, so a rebase that changes nothing keeps it. A verifier from the author's model family is allowed, and its verdict says it is a weaker check. A verdict below the floor goes to the owner, who accepts it by name, sends the change back, or stops the run.

## Attestation

When the suite passes, the runner attests to what it checked, so a CI job can accept the pull request without access to the runner. The attestation is a JSON object, version 1, defined in `shared/attestation.ts`. It holds the repo, the pull request, the head, the merge base, the main the suite merged into, the patch-id, the policy's id, name and version, the builds of the runner, the box and the check host, each gate's latest result on the head, and the time.

It lives in two places that must agree:

- The pull request description ends with `<!-- agents-attestation:v1 <base64url JSON> -->`. A person reading the description never sees it, and writing it again replaces it.
- The head commit gets the status `agents/attestation`, whose text is `v1 sha256:<hex>`, the sha256 of the JSON with its keys sorted.

`checkAttestation` is what a CI job runs. It passes only when the block parses as version 1, its digest matches the status, it is for the head the pull request is at, and it shows the static gates, the box gates, a review, the verdict and the suite passed. A new push moves the head, so an old attestation never covers new code. `test/step16b.ts` checks a good attestation and six bad ones, and HAPPY in `test/step16.ts` checks the one the runner wrote.

**Designed, not built.** A CI job accepts either attestation. Contributors from outside the team, who do not run Agents, use an open-source local gate tool that writes its own attestation for the head. The CI job runs that tool's verifier and ours, and passes when either passes for the current head. Where the CI job runs depends on the repo decision below.

**Not enforced.** Anyone with write access to the forge could set the status by hand. The CI job can check that the status's creator is the runner's forge user, which closes that for every account but the runner's. Signing the digest with a key only the runner holds closes it fully, and needs Tayler to decide where the key lives.

## Bug reports

A report goes through `route` like any request. When the router picks `bug`, a read-only `triage` stage reads it first:

- `needs_info` posts the agent's one question to the reporter on the issue and ends the run.
- `duplicate`, `already_fixed` and `not_a_bug` close the issue with the agent's summary.
- `existing_fix` hands the run to a person, who checks the open pull request or merged commit the agent named, seeing the bug twice and the fix twice. No agent writes a competing patch.
- `new` goes to `reproduce`, which writes a check that fails because of the bug. The plan's first Done means item names that check, which verify watches fail on main.

The confirm stage's verifier rereads the original report before the pull request opens, so the fix is judged against what was reported, as well as against the plan. Agents report through `report_result`, and the server writes to the forge, so an issue never gets a comment an agent typed straight to it.

Caps keep reports from running up cost. The policy caps spend a day for the repo, and lower for reports from people outside the team, runs an hour, and runs at once. A run over a spend cap stops before it starts, a run over the hourly or concurrency cap waits its turn, and a cap that stops a run says so once on the issue. CAPPED in `test/step16.ts` shows the daily cap.

**Not enforced.** A UI bug must be seen twice through the real UI, with screenshots, before any fix. The reproduce prompt says so, and nothing checks it until `agentsctl` lands. **Not run end to end.** The triage outcomes, the outsider cap and the cap's one comment have no end-to-end check yet.

## Obligations

When a run starts from an issue on a repo with a policy, Agents owes the reporter its outcome on the issue. An obligation is a typed promise, a row in `obligations` written by `server/obligations.ts`. It holds what is owed, where it goes, by when, and the kind of proof that closes it.

- It closes only with proof of the promised kind, or when a person waives it by name with a reason.
- An event already applied changes nothing.
- A stale event, one for another place, one with the wrong kind of proof, or a new delivery to a kept promise fails closed and changes nothing.
- The API lists what is due and what is overdue. **Not built.** The app does not show them yet.

`test/step16d.ts` shows each of these.

## Holds and task dependencies

**Designed, not wired.** Another agent is building task dependencies. This is how the framework would use them.

- A change over the size limit becomes stacked pull requests. Each part is a task that depends on the one before, its branch starts from that task's branch, and its run starts once the part before it merged.
- An owner-only gate becomes a typed hold on the run: who it waits for, on what, and the evidence they see. Only the person it names releases it, and the run page lists open holds as it lists asks today.
- A run that depends on another run's merge parks as waiting, with the dependency named, so it never looks alive while it waits.

## Folded in from research, and what was left out

Folded in and built: the merge-tree check before the merge, the verdict ladder, the verifier's commands read from the record, a suite command that never comes from the author, the check-edits gate, one rerun for a flaky suite, finding topics a person always sees, readiness as a typed proof with compile-time type tests in `test/types-framework.ts`, the plan lint before anyone reads a plan, and replacing a quiet agent with a fresh session rather than resuming it. The bug-fix pipeline's suite is now the constant `npm test`, where before the agent reported what to run.

Left out, and why:

- A gardener pipeline that tidies the repo on a schedule. Every change it made would need the same gates and the owner's merge, so it adds runs without adding a guarantee.
- Blinded scoring for the improve pipeline. Blinding the scorer to which version it judges matters once a model scores pipelines, and replays score them today.
- Exceptions to a rule with an expiry date. Principle a says no standing rule may skip a gate, and an exception is a standing rule until it expires. A person's one-run overrule covers the real cases.
- A stale-base check that the branch's base is an ancestor of main. The merge-tree check and the suite on the merge result cover it.

## How each check was seen failing

Each guard below was broken with a scripted edit whose anchor matched once, its check was run and failed on the named line, then the file was restored and its sha256 compared with the original before the check ran green again. The end-to-end breaks ran red only, each restored and compared by sha256, and one full run of every framework check afterwards was the green for all of them. A break that left the copied repo failing its own lint was redone, so each went red for its own reason. The script is `.scratch/seen-failing.ts` in the worktree, which git ignores, with the edits in `.scratch/seen-*.json`.

| Guard | How it was broken | The check that went red |
|---|---|---|
| A change to checks alone goes to the owner | The check-edits gate passed any change with no edited check | `test/step16b.ts` "a new check alone goes to the owner" |
| A protected file renamed away needs the owner | The protected gate looked only at the new path | `test/step16b.ts` "renaming a protected file away needs the owner" |
| An existing migration is never edited | The migrations gate dropped that finding | `test/step16b.ts` "editing an existing migration fails" |
| A new migration needs the data model | The condition was inverted | `test/step16b.ts` "a new migration without the data model fails" |
| At most 400 changed lines | The limit was raised by one | `test/step16b.ts` "401 changed lines fail" |
| No new eslint-disable | The suppressions gate dropped eslint-disable findings | `test/step16b.ts` "a new eslint-disable fails" |
| No accent color in a border | The CSS lint skipped `border` | `test/step16b.ts` "an accent border fails" |
| No em dash | The prose lint skipped Markdown | `test/step16b.ts` "an em dash in a doc fails" |
| A new source file has its parts entry | The condition was inverted | `test/step16b.ts` "a new source file with no parts entry fails" |
| A policy cannot loosen the core | The size floor was multiplied by ten | `test/step16b.ts` "a policy cannot raise the size limit past the core" |
| A missing feature map fails the plan | The missing case was skipped | `test/step16b.ts` "a missing feature map is a problem that names the path" |
| The attestation's digest matches its status | The digest comparison was skipped | `test/step16b.ts` "a block that differs from the status digest fails" |
| The attestation is for the head | The head comparison was skipped | `test/step16b.ts` "one for another head fails" |
| The attestation shows every core step | Any gate counted as the verdict | `test/step16b.ts` "one without the verdict fails" |
| Writing the attestation again replaces it | The block was always appended | `test/step16b.ts` "writing it again replaces the block" |
| A section ends at the next heading | The section ran to the end of the document | `test/step16b.ts` "a section runs to the next heading" |
| A stale delivery fails closed | The generation check let any event through | `test/step16d.ts` "a stale delivery fails closed" |
| A delivery to another place fails closed | The target check let any event through | `test/step16d.ts` "a delivery to another place fails closed" |
| A delivery with the wrong proof fails closed | The proof check let any event through | `test/step16d.ts` "a delivery with the wrong kind of proof fails closed" |
| A duplicate event changes nothing | The duplicate check never matched | `test/step16d.ts` stopped with "is already done" where it expected a no-op |
| A kept promise takes no new delivery | Only a waived promise refused one | `test/step16d.ts` "a new delivery to a kept promise fails closed" |
| A closed promise cannot be waived again | The waiver ignored the status | `test/step16d.ts` "a closed promise cannot be waived again" |
| A changed file the gates cannot read fails | The opaque gate read only files git could not call binary | `test/step16b.ts` "a script with a NUL byte, which git calls binary, fails" |
| A push over commits someone added on the forge stops, and the commit stays | Main's lease let the push replace the forge's tip | `test/step16.ts`, DECIDED, "a push over a commit someone added on the forge stops with main's refusal" |
| Every scenario's replace text is in the repo | The view change anchored on the import line main changed | `test/step16.ts` stopped before it started, with "STOPVIEW replaces text found 0 times in app/src/App.tsx" |
| An added line that reads `+++ b/ok.ts` stays its file's line | A `+++ ` line ended the hunk | `test/step16b.ts` "an added line that reads +++ b/ok.ts stays an added line of its own file ()" |
| A path git quotes fails closed | The quote check never matched | `test/step16b.ts` "a path git quotes fails closed (pass)" |
| Two files that come out of git as one path fail closed | Neither the U+FFFD check nor the shared path check ever matched | `test/step16b.ts` "two files that come out of git as one path fail closed (pass)", on a file named with the byte 0xff beside one named with U+FFFD, put in git's index by hand |
| A path holding U+FFFD fails closed | The check looked for U+FFFE | `test/step16b.ts` "a path that holds U+FFFD fails closed on its own" |
| A path git lists for two changes fails closed | The shared path check never matched | `test/step16b.ts` "a path git lists for two changes fails closed on its own" |
| A diff whose hunks and counts disagree fails closed | The count check never fired | `test/step16b.ts` "a file whose hunks add another number of lines than git counts fails closed" |
| A comment after a lone CR is judged on git's line | Comments took TypeScript's line numbers | `test/step16b.ts` "a suppression after a lone CR is judged on git's line (pass)" |
| A binary file fails whatever its name, unless its first bytes show an image | Only scripts failed, as the old extension list had it | `test/step16b.ts` "a file git calls binary fails whatever its name, a Dockerfile here (pass)" |
| An image passes unread only when its extension names the format its first bytes show | Any extension went with an image's first bytes | `test/step16b.ts` "a script that starts with GIF bytes fails, since .ts names no image (pass)", its size fixture, and the same for `server/helper.ts`, which opens with the `GIF89a:` label and holds a NUL byte, read from git |
| Each protected path under `**/` is also named at the root | The policy lacked `AGENTS.md` at the root | `test/step16b.ts` "each protected path under **/ is also named at the root" |
| A gzipped push whose request fails fails its reader | The request's error never reached the unzipping | `test/step16f.ts` "a gzipped push whose request fails partway fails its reader: still waiting" |
| A promise that fails waits before its next try | Every tick tried it again | `test/step16d.ts` "a promise that fails waits before its next try: 5 tries so far" |
| A deployer that starts fails deploys left part done | It never looked for them | `test/step16c.ts` "a deploy left checking by a deployer that stopped fails when the next deployer starts: checking" |
| The runner fails a deploy whose deployer never finished | Its cap was a thousand times longer | `test/step16c.ts` "the runner fails a deploy whose deployer started it and never finished: switching" |
| The pull request fences the review findings and the decisions | The decisions were plain text | `test/step16.ts`, HAPPY, "the review findings and the decisions sit in fences" |
| The pull request and the attestation mark review and verdict advisory | No gate counted as a judge's | `test/step16.ts`, HAPPY, "the pull request marks the review and the verdict advisory" |
| An unreadable file counts toward the size cap by its bytes | The cap charged it nothing | `test/step16b.ts` "counts toward the cap by its bytes" |
| A rules file in any folder is protected | The policy protected only the root `AGENTS.md` | `test/step16b.ts` "a rules file in a folder needs the owner" |
| An edit to a test helper counts as an edit to a check | The policy's `checks.related` was empty | `test/step16b.ts` "editing a test helper together with product code fails" |
| Inline eslint config is a suppression | The inline config pattern never matched | `test/step16b.ts` "inline eslint config turning a rule off fails" |
| An overrule carries only to the same finding | The key left out the body's hash | `test/step16b.ts` "a different body under the same rule and path is a new finding" |
| A fence is longer than any backtick run inside it | Every fence was three backticks | `test/step16b.ts` "one longer than the longest run of backticks inside it" |
| A machine's result answers every command it was asked | Only the number of commands was compared | `test/step16b.ts` "one that ran a command with other arguments is refused" |
| The git proxy reads only a push's command lines | It read until the push ended | `test/step16f.ts` stopped with "a push with more command lines than any task branch needs" on a 5 MiB push |
| Command lines past the limit are refused | The limit was raised a thousandfold | `test/step16f.ts` "command lines that never end are refused" |
| A promise that cannot be delivered holds none of the others up | Its error ended the whole delivery, undoing the rest | `test/step16d.ts` "the runner posted the outcome on the issue" |
| A release that did not install is deleted | The failed install left its `.partial` folder | `test/step16c.ts` "a release that did not install is deleted" |
| A health answer that is not JSON counts as no answer | The health check threw on it | `test/step16c.ts` "a health answer that is not JSON counts as no answer" |
| Each health request has a time limit | The limit was a thousand times longer | `test/step16c.ts` "a health check that never answers times out", the deploy left `checking` |
| An error after the switch ends the deploy | The error was thrown on, stopping the deployer | `test/step16c.ts` "an error after the switch tries to go back", the deploy left `switching` |
| A deploy that waited past its limit fails | The deployer never failed old requests | `test/step16c.ts` "a deploy that waited past its limit fails" |
| A release that failed its health check rolls back by itself | Going back left `current` on the failed release | `test/step16c.ts` "rolled back by itself" |
| A verdict the owner accepted below the floor is proof to merge | Readiness took no acceptance | `STEP16_ONLY=ACCEPT test/step16.ts` stopped with "never asked at approve_deploy", the merge refused |
| Only the owner approves running the suite | The suite gate let anyone answer | `STEP16_ONLY=ACCEPT test/step16.ts` "a teammate cannot approve running the suite" |
| An owner-only ask refuses anyone else | The answer route checked no one | `STEP16_ONLY=ACCEPT test/step16.ts` "a teammate cannot accept a verdict below the floor" |
| The git proxy refuses a push past the gates | Its branch rule refused nothing | `STEP16_ONLY=PUSHMAIN test/step16.ts` "refused by the git proxy and stopped" |
| Judges run without the author's session or team-record tools | Their sessions were not isolated | `STEP16_ONLY=HAPPY test/step16.ts` "ran without team-record tools" |
| A person's message to a judge's session is refused, and no command reaches it | The lookup asked for `sessionID`, which no row's reviewers hold | `STEP16_ONLY=HAPPY test/step16.ts` "a person's message to the reviewer's or the verifier's session is refused, and no command reaches either: 200, 200" |
| The runner attests to the head after the suite | The status went to another context | `STEP16_ONLY=HAPPY test/step16.ts` "the description carries the attestation", no `agents/attestation` status |
| A token in a person's answer is scrubbed from the decision log | The person's decision was stored as given | `STEP16_ONLY=HAPPY test/step16.ts` "scrubbed from the decision log" |
| A token a check prints reaches the evidence scrubbed | All three layers at once: the box, the API storing the result, and the runner's finding. One layer broken alone stays green, since the others still scrub | `STEP16_ONLY=STOPS test/step16.ts` "reaches the evidence scrubbed" |
| A stage whose machine went silent fails | The check never fired | `STEP16_ONLY=DECIDED test/step16.ts` stopped with "never reached suite" |
| An overruled finding stays overruled when raised again | No earlier overrule ever matched | `STEP16_ONLY=DECIDED test/step16.ts` stopped with "never asked at approve_suite", the owner asked again |

**Not seen failing yet.** These pass and stop what they should, and have not been run with their own code broken: the box judging with main's config, decisions reaching later agents' instructions, each scrub layer on its own, readiness asking for a review when a pipeline has none and a plan for code, the runner's half of the push lease, the runner's wait limit on deploys, and pause and resume.

## Every coding agent runs inside it

- Pipeline runs on a repo with a policy run the playbook's stages, and the merge invariant holds for any pipeline.
- A task a person starts on a repo whose policy says `sandbox: box` needs an agent whose home is a box.
- Pull requests from tasks, which another agent is building, should start an `app-change` run at its `verify` stage with the task's branch. Until then, the forge's branch protection keeps any pull request on a policy repo from merging without the three statuses and the owner's approval.
- Each workspace's root gets a `CLAUDE.md` that imports each repo's own `CLAUDE.md`, or its `AGENTS.md` when it has no `CLAUDE.md`, so Claude Code loads the repo's rules at the start of every session.

## What this reuses from other work in progress

- **GitHub as a second forge.** The framework talks to the forge only through `server/forge.ts`: branch protection, statuses, reviews, merges at a given head, and the mirror's fetch. Each has a GitHub equivalent, so the GitHub adapter needs these six calls.
- **The research, plan and implement pipeline, pull requests from tasks, and the diff view.** Their stages can be the framework's stage kinds, their pull requests start at verify, and the diff view can show the evidence beside the diff.
- **Boxes with a desktop and a browser.** Once boxes have a browser, the UI check and the verifier can run in the box for early feedback, through `agentsctl`.
- **agentsctl.** As above.

## Where the app's own repo should live

Today the code is only in `~/Projects/agents`, a git repo with no remote. Tayler decided project repos live on GitHub and pipeline code on this Mac's forge.

| | This Mac's forge | GitHub, private |
|---|---|---|
| Survives the server Mac failing | Only if its Docker volume is backed up | Yes |
| Can be fixed when a deploy breaks the server | No, the forge runs on the server it would fix | Yes |
| Branch protection, owner approval, required statuses | Yes, built here | Yes, through the GitHub adapter |
| Hosted CI as a later check host | No | Yes |
| Secrets leave this Mac | No | The factory's GitHub token lives on the server, scoped to this repo |

**I recommend GitHub, as a private repo.** The app's repo is a project repo under Tayler's own rule, and keeping it off the server it deploys to means a broken deploy can still be fixed.

How it gets there, once Tayler decides:

1. Tayler creates the private repo and a fine-grained token for the factory with access to it alone.
2. The coordinator scans the whole history with the scrub patterns, since `.env` was never committed but a secret in a file could have been.
3. `git remote add origin <url>`, then `git push origin main` from `~/Projects/agents`.
4. `server/admin.ts add-repo` and `set-policy` register it with the `agents` policy and Tayler as owner, which also sets branch protection.
5. `~/Projects/agents` stays Tayler's clone. Agents' changes arrive only as pull requests.

What Tayler must decide:

- GitHub or this Mac's forge.
- The account or organization, and the repo name.
- Who else, if anyone, may approve merges. The policy allows only the owner today.
- Whether the history goes up as it is, or squashed to one commit.

## Not enforced yet

- Review and verdict are advisory. The judges run on the author's box, so any process holding its token could post a judge's report or fake its commands, and they start in the author's folder, which loads the branch's own rules files. Running them on an instance of their own, refusing a judge's report from a session on the author's instance, and a clean folder with main's rules are not built. Don't register a repo with its policy before they are.
- Inline eslint config is caught on changed lines only. `noInlineConfig` in `eslint.config.js`, a protected file, would turn it off for the whole repo, and is for Tayler.
- The box holds its machine token and its Claude token, and the agent can read both.
- A box can reach the metadata endpoint, the private network, the tailnet and other boxes. The firewall guards only the server Mac's own address.
- The reviewer shares the box with the author's transcript files.
- Screenshots in three engines at two widths, until `agentsctl` lands.
- Stacked pull requests for work over the size limit. Today the size gate stops the change, and the agent is told to split it.
- One concern per pull request, beyond the size limit and the plan's single concern, is judged by the reviewers.
- Loosened assertions that keep the number of assertions the same are judged by the reviewers.
- Regenerating database row types from the schema, from the standards retrofit.
- The check host as a separate VM or machine. Today's check host is a daemon on the server Mac.
- The deployer as a launch agent on the server, and its first real deploy, which Tayler starts.
- The framework itself does not hold changes to the Agents repo yet. The repo has no remote, so it is not registered with its policy, and agents working in worktrees land through the coordinator's gates.
- The attestation is unsigned, and the CI job that reads it is not built.
- The Claude Code version a reviewer or verifier ran is not in its build record.
- A judge's checkout is the branch under review, so the `AGENTS.md` and `CLAUDE.md` Claude Code loads for it are the branch's. Its prompt carries main's rubric and says main's wins, which a model can still ignore.
- A UI bug seen twice through the real UI before a fix.
- The runner does not check screenshot coverage or attach screenshots.
- The app does not show obligations that are due or overdue.
- Holds and task dependencies, including stacked pull requests.
