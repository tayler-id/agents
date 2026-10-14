# Agents feature map

What a person can do in Agents, one file per feature, each with the commands that prove it on a running instance. Agents read it to decide what to drive and what counts as proof. People read it as the regression checklist. `bin/agentsctl map run <feature>` runs a file's commands exactly as written, so the map you read is the map that was proven.

## Baseline preconditions

- An instance started in this checkout with `bin/agentsctl up --pipelines`, which every feature can use. A file says when it needs more.
- `bin/agentsctl doctor` passes before the first drive, and again after anything surprising.
- The instance is fresh. Run each file once per instance: a second run can trip over what the first made, such as two rooms named launch. Start a new instance with `bin/agentsctl down` and `up` for a clean run.
- Never point any of this at the live server. agentsctl refuses to, and a page opened outside it has no identity.

## Driving conventions

- Find elements by ARIA role and accessible name, the way a person does. When a container has no name, such as a list item, use `--within <role> --within-text <text inside>`.
- `bin/agentsctl browser snapshot --aria` lists the roles and names on the current page. Run it before guessing a handle.
- People: `--as ada` is the person who started the instance, `--as ben` a teammate, and `--as <who>` anyone added with `bin/agentsctl seed person <who>`. A login on no team is `--as stranger`.
- Database checks name the instance's rows with `{team}`, `{owner}`, `{teammate}` and `{machine}`, and read the newest matching rows.
- `"$(bin/agentsctl db "<select>" --value)"` puts one value, such as an id, into another command. It is the only shell feature a step uses.
- An agent's reply or a pipeline stage takes time. Wait on what a person would see, with a `--timeout` long enough for it. Never sleep.
- Steps run in order and build on each other. A step whose label ends `(real Claude)` needs `bin/agentsctl up --claude real`, and one ending `(pipelines)` needs `--pipelines`.

## Proof and verdicts

- A proof drives the user's path and observes the end state a person would see, plus the side effect in the record: a row, a file on the machine, a message sent.
- `bin/agentsctl map run` gives each step a verdict: `live-ui-verified` when it ran and held, `verifier-failed` when it ran on a healthy instance and the app did something else, and `verifier-blocked` when it could not run. An unhealthy instance or a missing prerequisite is blocked, never a pass.
- A failed step is a lead, not yet a bug. Reproduce it twice through the real UI with `bin/agentsctl browser record start` and `record stop`, and have a second agent, one that did not write the change, confirm the video shows the broken state.
- Report a path you could not reach with its concrete prerequisite and the command you tried. Never report it as verified through another path.
- A known product bug stays in its feature as a failing step. The feature's Gotchas note the bug with the date it was seen, and the step turns green when the bug is fixed. The map is never edited to hide a bug, and `bin/agentsctl map guard` fails a change that removes or loosens an expectation. Tayler decided this on 2026-10-14.

## Full sweep

Run the files top to bottom on one fresh instance: `bin/agentsctl map run all --visual` drives every step, takes the visual captures, and checks each captured view for accessibility, console errors and sideways scrolling. Then `bin/agentsctl visual compare`. The order matters: later files use the pipeline runs and agents earlier ones leave behind.

## Features

- [Getting in](./getting-in.md): who you are comes from Tailscale. A login on no team asks to join and waits, the machine door refuses people, and the desktop app opens the same team.
- [Conversations](./conversations.md): DMs with one agent, rooms where agents take turns, @mentions, and the notice an agent leaves when it cannot start.
- [Agent setup](./agent-setup.md): a new agent, its title, model and instructions, skills, plugins, routines, memory, and templates.
- [Tasks](./tasks.md): a new task, a DM post made a task, telling the agent more, a task on a repo, and interrupting the agent.
- [Documents and comments](./documents.md): documents a task writes, their versions, and comments that reach the agent that wrote them.
- [Sessions and the record](./sessions.md): session details, Running now, and the team record agents search.
- [Approvals and asks](./approvals.md): tool approvals, a pipeline's gate, and hand-offs to a person.
- [Pipelines](./pipelines.md): the pipeline page, starting a run from the app or a webhook, the run page, the bug-fix paths, cancelling, and the pipeline's room.
- [Proposals](./proposals.md): changes the coach and improve pipelines propose, with their scores and diffs, approved at a gate.
- [Secrets](./secrets.md): plugins name secrets, values stay on the machine, a missing one stops the agent, and a value never reaches the record.
- [Machines and boxes](./machines.md): the machines list, and claiming and releasing a box.
- [Journeys](./journeys.md): flows across surfaces, such as a teammate watching an agent work, and the desktop and web apps showing the same conversation live.

## Entry contract

Each file starts with a `#` title, a paragraph on what a person can do, and its map entry: one json code block holding its `id` (the file's name), its `name` (the title), the `paths` it lives in and the `checks` that show it works, in the shape `FEATURE` in `shared/evidence.ts` defines. Then exactly four sections, in this order:

1. `Sub-features`: short ids, one line each.
2. `How to get to it (user POV)`: every way a person reaches it.
3. `Driving it with agentsctl`: `Preconditions:`, then labelled steps. Each step pairs the user's action with the exact commands and the result that proves it.
4. `Gotchas`: what wastes a run or makes a result lie.

`features.json` beside the files holds every map entry in this index's order. The framework's gates read it, and `bin/agentsctl map export` writes it from the entries.

`bin/agentsctl map check` fails when a file breaks this contract, when the index and the files disagree, when a command does not parse, when an entry names a path that does not exist, or when `features.json` differs from the entries.
