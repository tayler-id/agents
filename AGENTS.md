# Rules for agents working on Agents

Agents is a multiplayer app where a team and its agents talk, work and share one Postgres record. Tayler owns it. These rules bind every agent that changes this repo, inside Agents' own pipelines or anywhere else.

## What we're building

The goal is `docs/intent/multiplayer.md`. Nothing below is traded away for cost, convenience or safety without Tayler's say:
- People keep using their own coding agents on their own computers, and those sessions land in the shared record.
- Each cloud agent gets its own Docker container with everything it needs: a desktop, a browser on the open web, its tools and computer use. A person can watch it and take over.
- Every session on every machine lands in one Postgres record, and everyone's agents draw on it.
- Pipelines are versioned code, and they change only with a person's approval.
- Agents check their own work, and nothing lands unverified.

A change that takes away something agents or people can do today is a regression. Say so in its first line and in your report, and leave the call to Tayler. Never offer it as one option among others.

## Read first

- `.claude/skills/coding-standards/SKILL.md`, all of it. Reviewers judge every change by its "Types are the spec" and "No shortcuts" sections, and every finding names the rule it breaks.
- `docs/decisions.md`, for every decision and where it stands. When an older doc disagrees with it, `docs/decisions.md` is current.
- `docs/what-each-part-does.md` before changing a part, and `docs/data-model.md` before changing the schema.
- `docs/design/self-improve.md`, the design of the coding framework described under "The coding framework" below.

## Names

- The product is Agents, and the teammates it runs are agents.
- Never use the name of the app we studied or any abbreviation of it. Never name a project, company or person we learned from. Describe the idea in our own words.
- `node test/names.ts` enforces both, and runs first in `npm run check`.

## The live system is off limits

- Don't restart, edit or install the launchd services (`com.agents.*`).
- Don't connect to or migrate the `agents` database. Checks use `agents_test`, through `.env` then `.env.test`.
- Don't change Tailscale settings. Don't remove Docker containers, volumes or images you didn't make.
- Don't publish pipelines to the real forge.
- Never write a secret value to Postgres, a log, the record, a command payload, a browser response or a commit.

## Changing the schema

Describe the change in `docs/data-model.md` first, under "Added while building", then add a new migration. Never edit a migration that exists. Get its number from the coordinator, since branches renumber in landing order.

## Working beside other agents

Agents don't have their own ports, test database or packages yet. Until they do:

- Prefix the teams your checks make with your workstream's name, and delete them when you finish.
- Before a check that uses port 7701, take the lock with `mkdir ~/.agents-app/checks/run.lock`, and `rmdir` it after.
- Install packages in your own copy with `npm ci`. Never install through a link to main's `node_modules`.
- Don't edit `.gitignore`, and don't add check scripts to `package.json`.
- After a check run that builds a Docker image, run `docker image prune -f`. It removes only untagged images no container uses, which nobody needs, so it is the one exception to removing only what you made. Colima's disk filled with them on 2026-10-13 and took the live database down.
- Never build or tag `agents-box:latest`. It is the image the live server starts boxes from. A check that builds a box image uses its own tag and removes it.

## The coding framework

Agents runs a coding agent's change to any repo with a policy through its coding framework. The runner, not the agent, runs every gate, records what it saw as evidence, and never takes an agent's word for a result. The Agents codebase's policy is `ops/policies/agents.json`.

**The framework does not hold changes to this repo yet.** The repo has no remote, so it is not registered in Agents with its policy, and agents working in worktrees land through the coordinator's gates under "How changes land". Don't register it before the judges below run on their own machine. The tables say what the framework enforces for a change made through Agents' `app-change` pipeline on a repo with this policy, and what it does not enforce even there.

Inside an Agents pipeline:

- Don't commit or push. The runner commits and pushes your work and runs every gate itself.
- Never push to any branch but your task branch. On a repo with a policy the git proxy refuses a push to any branch but the task branches of the pushing machine's own workspaces, and the run stops.
- Keep one concern per pull request, at most 400 changed lines without lockfiles.
- A decision a person made in your run stands, and you get each one with your instructions. Work within it. When you can't, name the decision in your report and report ask.
- Log each decision that shapes the change with the `log_decision` tool, with why and what else you weighed.

### Hard gates

A change cannot merge through the runner while any of these fail, and the runner offers no way to overrule them. Tayler, as the forge's admin, can still merge by hand.

| Rule | Enforced by, for a change made through Agents |
|---|---|
| Typecheck and type-aware lint pass | The box runs `tsc` and `eslint` on a fresh checkout of the pushed commit, with the lint and compiler config from main and the workspace's installed packages linked in |
| No accent color in a border, outline, box-shadow or SVG stroke, no gradients, every color from the design tokens | CSS lint on changed lines, and `test/style.ts` |
| No em dash, no banned word, no title-case heading in docs, comments or UI strings | Prose lint on changed lines, and `test/style.ts` |
| The name guard passes | `test/names.ts`, run by the box on the whole checkout. No static gate reads changed lines for names |
| The full check suite passes on the result of merging into main | The check host runs the policy's suite command, `npm run check`, after Tayler approves running it. **Not isolated yet.** Today's check host is a daemon on the server Mac. step16 runs a stand-in suite, the name guard, so the full suite has not run end to end on a check host |
| Every check you add or edit fails on main and passes on your change | The box for checks marked `// runs-in: box`, and the check host for all. A check that cannot load on main, because it imports what your change adds, counts as failing there |
| A change under `app/` includes a Playwright check that names chromium, firefox and webkit and desktop and phone width, with screenshots on the pull request | The static gate requires such a check. **It cannot tell whether the check drives the changed view,** and **screenshots are not enforced** until `agentsctl` lands |
| A new migration changes `docs/data-model.md` in the same pull request, and existing migrations are never edited | Static gate |
| A new source file has an entry in `docs/what-each-part-does.md`, and every change adds to `docs/build-log.md` | Static gate |
| No secret in the diff by the `shared/scrub.ts` patterns, and no `.env` file | Static gate |
| Dependency changes use exact versions, say why in the build log, and go to Tayler | Static gate, then the protected gate |
| No new eslint-disable, ts-ignore, ts-expect-error, skipped or only test, or removed assertion | Static gate. **Subtler loosening of an assertion is not enforced.** Reviewers judge it |
| No new file in a language other than TypeScript outside the allowlist | Static gate |
| No new type assertion except `as const`, no new `exec` or `shell: true`, no new TODO, FIXME or XXX | Static gate on changed lines |
| Your diff fits the playbook the router picked, and your plan's Done means and Keep items name checks and features | Static gate, and the plan lint before anyone reads the plan |
| An edit to an existing check, or to anything under `test/`, never rides along with product code | Static gate. A change to checks alone goes to Tayler |
| An agent that did not write the change gives a verdict at least as strong as the policy asks | The confirm stage, which judges the verdict by the commands the record shows the verifier ran |
| The change merges cleanly into the current main | The merge runs `git merge-tree` first |
| One concern per pull request | **Not enforced** beyond the 400-line cap and the plan's one concern. Reviewers judge it |

### Protected paths

A change touching any of these stops at a gate only Tayler can pass, and the pull request shows each one's diff. The list is `protectedPaths` in `ops/policies/agents.json`:
- the rules agents read: `**/AGENTS.md`, `**/CLAUDE.md`, `.claude/**`
- the lint, compiler and package config: `eslint.config.js`, `**/tsconfig*.json`, `package.json`
- the checks that guard the rules: `test/all.ts`, `test/names.ts`, `test/step0.ts`, `test/style.ts`, `test/step16*.ts`, `test/types-framework.ts`, `test/fake-claude.ts`
- the framework's own code: `shared/gates/**`, `shared/policy.ts`, `shared/framework.ts`, `shared/pipeline.ts`, `shared/scrub.ts`, `shared/attestation.ts`, `shared/build.ts`, `shared/verification.ts`, `shared/findings.ts`, `server/framework.ts`, `server/mirror.ts`, `server/runner.ts`, `server/pipelines.ts`, `server/git.ts`, `server/obligations.ts`, `server/build.ts`, `server/forge.ts`, `server/admin.ts`, `server/tasks.ts`, `daemon/gates.ts`, `daemon/workspace.ts`, `daemon/agentsd.ts`, `pipelines/app-change.ts`
- the schema: `server/migrations/**`
- the sandbox and deploy: `ops/**`, `box/**`, `compose.yaml`

Once `set-policy` registers the repo, the forge holds the same list, so such a pull request cannot merge without Tayler.

### Review and people

- Before any person sees your change, a reviewer on a different model reviews the diff against main's copy of the coding standards and the approved plan, without your session. Fix each blocking finding. Only Tayler can overrule one, by name, and the same finding raised again stays overruled for the rest of the run.
- A finding the reviewer tags as about security, auth, billing, data, migrations or concurrency goes to Tayler. One it does not tag does not.
- A fresh agent on another model checks your plan's Done means and Keep items with main's copy of the verification skill.
- **Review and verdict are advisory until judges run on their own machine.** Today the reviewer and the verifier run on the author's box. Any process holding that box's token could post a judge's report or fake its commands, and they start in the author's folder, which loads the branch's own `CLAUDE.md` and `AGENTS.md`.
- A person approves the plan before you write code. Tayler approves running the suite, the merge, and separately the deploy. The deploy puts the release before back by itself when the health check fails. Migrations stay applied, so each must work with the release before it.

### The sandbox

Changes are made only in a box, under caps on working time and spend per run. A box has no Docker socket and reaches the server only on its machine port. Boxes keep the open web, since each agent's computer browses it. **Not enforced yet.** A box can still reach the metadata endpoint, the private network, the tailnet and other boxes, and it holds its machine token and a Claude token where the agent can read them.

## Before you say done

1. `npm run typecheck`, `npm run lint` and `node test/names.ts` pass, with no rule switched off.
2. The checks for what you changed pass.
3. Every check you added or changed was seen failing. Break what it guards, watch it go red, restore it byte for byte, and watch it go green.
4. Anything that touches the running system has been tried on it, by Tayler or with Tayler's go-ahead.
5. Docs say only what was proven, and name what is not done.

On this Mac, run Node from `~/.local/node/bin`. The `node` in `/usr/local/bin` can't load the native packages.

## How changes land

You work on a branch and never merge. The coordinator lands each branch with a merge commit after three gates:
- its changed checks rerun against main, where they must fail
- the full suite on the merged result
- a review by an agent on a different model

Changes to the protected paths listed under "Protected paths" need Tayler's approval.

## Writing

This covers docs, comments, commit messages, pull requests and UI text.

- Say what a thing does. Use the number, the file, the command.
- No em dashes. A colon introduces a list or an example, never joins two halves of a sentence.
- Sentence case headings. No decorative emoji. Don't bold every name.
- None of these words: `delve`, `crucial`, `landscape`, `pivotal`, `showcase`, `tapestry`, `testament`, `underscore`, `vibrant`, `robust`, `seamless`, `leverage`, `utilize`, `comprehensive`, `intricate`. The prose lint reads the list from `ops/policies/agents.json`.
- No filler or hedging. "In order to" is "to". Active voice, with the actor named.
- No abstract nouns where a concrete word exists, such as substrate, wedge, vector, nexus, bedrock, scaffolding, paradigm, flywheel, north star or endgame.
- Comments only for a reason the code can't show. Refer to Tayler by name or as they.

## UI design

- No accent color on a border, outline, ring or stroke, in any state, selected, active, focused or hovered included. Show selection with a brighter neutral surface, heavier type or a checkmark.
- Don't tint a fill and border it in the same color. Success and error boxes differ by their glyph and word, on a neutral surface with one neutral hairline.
- No color per item, and no gradient from one accent to another. A meter is a flat neutral track with flat segments named in a legend.
- Spend saturated color only on live state, such as running, waiting or recording.
- Avoid a stack of identical cards, each with an icon, a bold title and a grey line, the selected one outlined. Use hairline dividers and let type carry the hierarchy.

## When you finish, report

- What you built and where, and every file you changed.
- Each check you added or changed, and how you saw it fail.
- What you decided and why.
- What Tayler must decide, and the open questions.
- What is not done or not enforced, said plainly.
