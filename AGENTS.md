# Rules for agents working on Agents

Agents is a multiplayer app where a team and its agents talk, work and share one Postgres record. Tayler owns it. These rules bind every agent that changes this repo.

## What we're building

The goal is `docs/intent/multiplayer.md`. Nothing below is traded away for cost, convenience or safety without Tayler's say:
- People keep using their own coding agents on their own computers, and those sessions land in the shared record.
- Each cloud agent gets its own Docker container with everything it needs: a desktop, a browser on the open web, its tools and computer use. A person can watch it and take over.
- Every session on every machine lands in one Postgres record, and everyone's agents draw on it.
- Pipelines are versioned code, and they change only with a person's approval.
- Agents check their own work, and nothing lands unverified.

A change that takes away something agents or people can do today is a regression. Say so in its first line and in your report, and leave the call to Tayler. Never offer it as one option among others.

## Read first

- `.claude/skills/coding-standards/SKILL.md`, all of it. Reviewers judge every change by its "Types are the spec" and "No shortcuts" sections.
- `docs/decisions.md`, for every decision and where it stands. When an older doc disagrees with it, `docs/decisions.md` is current.
- `docs/what-each-part-does.md` before changing a part, and `docs/data-model.md` before changing the schema.

## Names

- The product is Agents, and the teammates it runs are agents.
- Never use the name of the app we studied or any abbreviation of it. Never name a project, company or person we learned from. Describe the idea in our own words.
- `node test/names.ts` enforces both, and runs first in `npm run check`.

## The live system is off limits

- Don't restart, edit or install the launchd services (`com.agents.*`).
- Don't connect to or migrate the `agents` database. Checks use `agents_test`, through `.env` then `.env.test`.
- Don't change Tailscale settings. Don't remove Docker containers, volumes or images you didn't make.
- Never write a secret value to Postgres, a log, a command payload or a commit.

## Changing the schema

Describe the change in `docs/data-model.md` first, then add a new migration. Never edit a migration that exists. Get its number from the coordinator, since branches renumber in landing order.

## Working beside other agents

Agents don't have their own ports, test database or packages yet. Until they do:

- Prefix the teams your checks make with your workstream's name, and delete them when you finish.
- Before a check that uses port 7701, take the lock with `mkdir ~/.agents-app/checks/run.lock`, and `rmdir` it after.
- Install packages in your own copy with `npm ci`. Never install through a link to main's `node_modules`.
- Don't edit `.gitignore`, and don't add check scripts to `package.json`.

## Before you say done

1. `npm run typecheck`, `npm run lint` and `node test/names.ts` pass, with no rule switched off.
2. The checks for what you changed pass.
3. Every check you added or changed was seen failing. Break what it guards, watch it go red, restore it byte for byte, and watch it go green.
4. Docs say only what was proven, and name what is not done.

On this Mac, run Node from `~/.local/node/bin`. The `node` in `/usr/local/bin` can't load the native packages.

## How changes land

You work on a branch and never merge. The coordinator lands each branch with a merge commit after three gates:
- its changed checks rerun against main, where they must fail
- the full suite on the merged result
- a review by an agent on a different model

Changes to these need Tayler's approval: `AGENTS.md`, `CLAUDE.md`, `.claude/`, `eslint.config.js`, `tsconfig*.json`, `test/names.ts`, `test/step0.ts`, `test/all.ts`, `pipelines/app-change.ts` and `ops/`.

## Writing

This covers docs, comments, commit messages and UI text.

- Say what a thing does. Use the number, the file, the command.
- No em dashes. A colon introduces a list or an example, never joins two halves of a sentence.
- Sentence case headings. Comments only for a reason the code can't show.
- Refer to Tayler by name or as they.
