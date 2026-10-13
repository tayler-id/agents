# What each part does

Each part, the problem it solves now, and what it makes possible later. I update this as each step lands. The goal is in `docs/intent/multiplayer.md`, the data model in `docs/data-model.md`, and the order of work in `docs/build-plan.md`.

## Built

### Postgres (`compose.yaml`)

- **Solves now.** One place that holds every conversation, session and event from every machine. It runs in Docker through colima on the server Mac.
- **Helps later.** Everything else reads from it. The sync engine streams it to the app, agents search it for teammates' work, and pipeline runs and their scores are stored in it.

### Migrations (`server/migrations/`, `server/migrate.ts`)

- **Solves now.** The schema is a numbered list of SQL files. Each file runs once, in order, inside a transaction, and the API applies any new ones when it starts. Changing the schema no longer means wiping the data.
- **Helps later.** Every future change to the model is one new file, applied the same way on any server.

### The tables (`0001_data_model.sql`)

- **Solves now.** The whole agreed model exists as tables, about 34 of them, grouped as people and machines, agents, conversations, work, the record, artifacts, asks and pipelines. Rules that must always hold are written into the database. For example, a session serves a task or a conversation, never both, and a status can only take its agreed values.
- **Helps later.** Later steps fill in tables that are already there, instead of reshaping them.

### The record (`server/record.ts`)

- **Solves now.** Every write goes through this one file, inside one transaction.
  - It numbers each session's events and each conversation's messages, so order holds when people and agents write at once.
  - It skips anything already written, so a retry never adds a duplicate.
  - It scrubs secrets a second time.
  - It links things together. A person's message becomes a post in the conversation, a user event in the agent's session, and a command for the agent's machine. When the agent's turn ends, its last words become its post in the conversation, linked to the event that wrote them.
- **Helps later.** Rooms, tasks, asks and artifacts plug into the same functions, so the numbering and the links stay right everywhere.

### The API (`server/api.ts`)

- **Solves now.** It is the only door into Postgres. People open a DM with an agent and post messages. Machines claim their commands, report them done, and post their sessions' events. It checks who is calling: a machine by its token, a person by their Tailscale login.
- **Helps later.** The app, webhooks and pipelines all write through this door.
- **Survives Postgres restarting.** It waits for Postgres when it starts, replaces connections Postgres drops, and its runner listens again, so restarting colima or the Mac needs nothing from you. `check:step2` drops its connections to prove it.

### Commands (`commands` table)

- **Solves now.** A queue of work for each machine. The daemon waits on it and claims what arrives, and each command records whether it was done.
- **Helps later.** Interrupts, approvals answered from the app, and running a tool on your Mac for an agent on a box all travel the same way. In step 2 the daemon reads its queue through sync, like the app does.

### The daemon (`daemon/agentsd.ts`, `daemon/claude.ts`)

- **Solves now.** It runs on each machine. It claims commands, starts or resumes the agent's Claude session in the agent's own folder with the agent's instructions, and hands it the message. It posts everything Claude prints, both as events and as raw lines. A Claude process keeps the setup it started with, so when the agent's instructions, skills, plugins or model change, the next message restarts the session with the new setup and resumes the same conversation. A session mid-turn finishes first. When the machine cannot start a session, the API fails it with the machine's reason, and the app shows that reason under the agent's name.
- **Helps later.** The same daemon runs inside every box. Task sessions will run in workspaces, with a worktree per repo.

### The harness interface (`daemon/harness.ts`)

- **Solves now.** The daemon talks to "a harness", and Claude's output format stays in one file.
- **Helps later.** Codex can be added by writing one more file.

### The scrubber (`shared/scrub.ts`)

- **Solves now.** It replaces secret values with `[secret:NAME]` before anything is written: events, raw lines, posts and commands. It catches values of environment variables whose names look secret, and known key shapes such as `sk-ant-`, `ghp_` and private keys. The daemon scrubs, then the API scrubs again.
- **Helps later.** Once agents search everyone's work, a leaked key would reach every agent on the team. Scrubbing at the source stops that.

### Search (indexes on `events.text` and `messages.body`)

- **Solves now.** Any word from a session or a conversation can be found with Postgres full-text search. The index sits beside the table rather than in a column, so sync never has to carry it.
- **Helps later.** The team-record tools in step 5 use it so one agent can find a teammate's fix.

### The step 1 check (`test/step1.ts`, `npm run check:step1`)

- **Solves now.** A person DMs a test agent twice through a real Claude session. The check confirms 17 things: the record is complete and in order, it matches Claude's own transcript, the replies come back linked, search finds the work, the commands finished, and no secret survives anywhere. I watched each check fail under a deliberate break, except the turn-order check.
- **Helps later.** Rerun it after any change. It removes its own test team when it passes.

### Tailscale and `tailscale serve`

- **Solves now.** Teammates' machines and future boxes can reach the server Mac privately, without opening it to the internet. Serve tells the API the real login of each caller, so there is no login system to build.
- **Helps later.** The access proxy uses the same login to decide what each person may read. Boxes join as tagged devices that use instance tokens.

### Launch agents (`ops/install-launch-agents.sh`)

- **Solves now.** Colima, Tailscale and the API start on their own after a reboot.
- **Helps later.** Teammates can count on the server being up.

### Live reading: Electric and the sync proxy (`server/sync.ts`)

- **Solves now.** The app and the daemons read Postgres live over plain HTTP. Electric follows Postgres's change log like a read replica and streams new rows. The proxy in front of it picks the table and the filter from who is asking, so a person sees only their team, minus private conversations and tasks they are not in. A client never names its own filter.
- **Helps later.** Every new list in the app is one more named shape. Runs, stages, pipelines, documents and proposals came in phase 2 and 3 this way.
- **Watch for.** Electric 1.8.1 never sends a row that moves into a filter ORing two subqueries. Sessions are therefore two shapes, one for conversations and one for tasks, and `check:step2` fails if a session started after a view opened does not arrive whole. Every live shape holds one of the browser's six connections over plain HTTP, so the sidebar polls instead.

### Live tokens (`server/streams.ts`, `daemon/live.ts`)

- **Solves now.** While an agent types, its words reach every viewer as they come, through a durable stream per session. Tokens never touch Postgres. The finished message lands there as one event. The daemon holds back the last 160 characters so a secret split across chunks is scrubbed before anyone sees it.
- **Helps later.** Any long output, such as a pipeline stage's progress, can stream the same way.

### Two front doors (`server/api.ts`)

- **Solves now.** People use port 7710, which only `tailscale serve` points at, so a person's identity always comes from Tailscale. Machines use 7700 with their tokens, and that port refuses any person's identity. A container on this Mac cannot pose as you.
- **Helps later.** Boxes, the forge's webhooks and other machines all come in through 7700.

### Asks (`asks` table, `server/record.ts`)

- **Solves now.** Anything that waits on a person is an ask: a tool approval, a pipeline's gate, a hand-off. It shows as a card in the conversation or run, and anyone on the team can answer it. "Always" and "never" on a tool approval become standing rules that answer the next one.
- **Helps later.** Forms, drafts and secret requests are more kinds of the same ask.

### The app (`app/`) and the desktop app (`desktop/main.cjs`)

- **Solves now.** One screen for the team: agents, conversations, pipelines, runs, what is running now, and machines. A conversation shows posts, live typing, ask cards and interrupt. A session panel shows every step an agent took. Agent replies and documents render their markdown. The Electron app opens the server's tailnet address.
- **Helps later.** Rooms, memory, skills and routines get their own views in phase 4.

### Team-record tools (`daemon/record-mcp.ts`, `server/teamrecord.ts`)

- **Solves now.** Every agent session can search everything the team's agents have said and done, read any shared session, see recent activity, read a pipeline's run history, and read a teammate agent's profile. Each agent is told to search before it starts work. In the step 5 check a teammate's agent finds a fix made on another machine without being told about it.
- **Helps later.** The improve pipeline reads pipeline history through these same tools to find what to change.

## Phase 2: the factory

### The forge (`compose.yaml`, `ops/forge-setup.ts`, `server/forge.ts`)

- **Solves now.** A local Gitea holds the team's repos, issues and pull requests, so pipelines run end to end without touching GitHub. The setup script makes an admin, a `factory` user that pipelines act as, and two repos: `team/shop`, a small app with a known bug, and `team/pipelines`, the team's pipeline files. Main is protected, so changes land through pull requests. Its webhooks reach the API's machine port.
- **Helps later.** `server/forge.ts` is the only file that talks to the forge. GitHub's API has the same shape for these calls, so moving to GitHub means one new file.

### The git proxy (`server/git.ts`)

- **Solves now.** Machines clone and push through the API with their own instance tokens. The API checks the repo is their team's and adds the factory's credentials, so forge tokens never leave the server Mac. A box holds only its instance token.
- **Helps later.** Branch rules for agents, such as "only push to task branches", go in one place.

### Workspaces (`daemon/workspace.ts`)

- **Solves now.** Each task gets a folder on its machine with a clone of each repo on the task's branch, and a `task` folder beside the clones that never enters git. Checks run in it, pushes go from it, and files an agent writes in the task folder become documents with numbered versions.
- **Helps later.** Phase 3 replays start the same kind of workspace at an old commit.

### Pipelines as code (`pipelines/`, `shared/pipeline.ts`, `server/pipelines.ts`)

- **Solves now.** A pipeline is a TypeScript file in the team's pipelines repo. It names its stages, and for each way a stage can end, where the run goes next. Stages are an agent's turn, a check (a command whose exit code decides), an action on the forge, or a gate that waits on a person. Each version is the file's content, named by git's own blob id for it. A version that does not load is recorded with its error and never becomes current. Merging a change to the file makes the new version current.
- **Helps later.** Proposed improvements are edits to these files, so phase 3 scores and merges them like any code.

### The runner (`server/runner.ts`)

- **Solves now.** It moves each run forward. A run's whole state is in Postgres, one row per try at a stage, so the runner only looks at the latest row and does the next thing. An API restart loses nothing. Each agent stage runs a Claude session in the workspace and ends when the agent calls `report_result`, which the runner reads from the record. An agent that forgets gets one reminder. A stage that loops back reuses its session, so the agent remembers its earlier tries. Every loop has a cap, and when it runs out a person decides: try again or take over. A run stops at its pipeline's spend cap. Webhooks, cron schedules and a person in the app start runs, and a webhook delivered twice starts one run.
- **Helps later.** Replays for scoring are runs with a flag, so they reuse all of this.

### The bug-fix pipeline (`pipelines/bug-fix.ts`)

- **Solves now.** A bug report becomes a reviewed pull request. Triage checks for duplicates and whether the bug is already fixed. The agent writes a failing test, and the runner confirms it fails before any fix. The agent fixes it or writes a plan, the runner confirms the tests pass, opens the pull request and asks the shepherd. Approving merges it, which closes the issue.
- **Helps later.** It is the first pipeline the improve pipeline works on.

### Boxes (`box/Dockerfile`, `server/boxes.ts`, `ops/box-firewall.sh`)

- **Solves now.** A box is a Docker container that runs the daemon, for unattended work. A run on a box pipeline claims one, or makes one while the team is under its limit, and releases it when it ends. A person can claim one too. A box nobody holds stops after 30 idle minutes and starts again for the next run. Its home folder is a volume, so workspaces survive a restart and a rebuild of the image. A firewall in the colima VM lets boxes reach this Mac only on the machine port.
- **Helps later.** Boxes run Claude on your subscription once a token from `claude setup-token` is in `~/.agents-app/box-claude-token`.

### Runs in the app (`app/src/Run.tsx`, `app/src/Pipeline.tsx`, `app/src/Document.tsx`)

- **Solves now.** A pipeline page shows its versions with how their runs went, its runs, and a form to start one. A run page shows each stage live with its outcome and summary, the gate or hand-off card, what the run made (the pull request, documents), and the report. Any stage's session opens beside it.
- **Helps later.** Proposals show on the same pages, with their diff and scores.

### Checks on their own database (`.env.test`, `electric-test` in `compose.yaml`)

- **Solves now.** Every check runs against `agents_test` with its own Electric, so a check's pipeline runs never reach the real server's runner and its rows never mix with your team's record.
- **Helps later.** Checks can run while the real system keeps working.

## Phase 3: refinement

### Replays and scores (`server/refine.ts`)

- **Solves now.** A change to a pipeline is scored before anyone sees it. The runner replays the pipeline's latest finished runs, each from the commit it started at, once with the change and once with the current version. Replays never open pull requests or wait on people. The two versions are compared on runs finished, then reminders and hand-offs, then stages run, then cost.
- **Helps later.** Any measure of a run can join the comparison, such as how often a person rejected the result.

### The improve pipeline (`pipelines/improve.ts`)

- **Solves now.** An agent reads how a pipeline's runs went (the `pipeline_history` tool), changes that pipeline's file once, and the change is scored. Only a change that scores better becomes a pull request on the pipelines repo, with both scores, and reaches the shepherd. Approving merges it, and the merged file becomes the current version.
- **Helps later.** It can run on a schedule, so pipelines keep getting better while nobody is watching.

### The coach pipeline (`pipelines/coach.ts`)

- **Solves now.** An agent reads the team's conversations with another agent, finds a correction people made more than once, and proposes the smallest change that would have prevented it, with a diff. That is new instructions, or a skill when the corrections are about one kind of task. Approving applies it. A proposed skill name that is not lowercase letters, digits and dashes is refused, since the name becomes a folder on each machine.

### Proposals in the app (`app/src/Proposal.tsx`)

- **Solves now.** A proposal shows its summary, the scores of both versions and the diff, on the pipeline's page and on the run that proposed it, next to the gate that approves it.

## Phase 4: the rest of the app

### Rooms (`server/rooms.ts`)

- **Solves now.** Teammates and agents talk together. After a post, each agent in the room takes a turn, one after another, and sees what the agents before it said. An agent with nothing to add replies PASS, which is not posted. A post that mentions `@name` gives only that agent a turn, and a turn that runs past its deadline ends so the next agent can go. An agent whose session fails gives up its turn at once.

### Agents' setup (`server/agents.ts`, `daemon/agentfiles.ts`, `app/src/AgentPage.tsx`)

- **Solves now.** From the app, a person changes an agent's title, model and instructions, and adds skills, plugins and routines. Skills become Claude Code skill files in the session's folder. Plugins are MCP servers whose secrets are named, never stored. The daemon fills them in from its own machine, and a missing one stops the session, which tells the person which secret to set and where. Changes reach a running session on its next message. A template saves an agent's whole setup, and a new agent can start from it.

### Memory (`update_memory` tool, `memories` table)

- **Solves now.** An agent keeps a profile of each person and of the team, and a log for each day. Each new session starts with what it remembers about the people involved.

### Routines (`server/routines.ts`)

- **Solves now.** A routine sends a prompt to its agent's main conversation on a cron schedule, or when someone runs it from the app. The team sees the prompt and the reply.

### Tasks people start (`server/tasks.ts`, `app/src/Work.tsx`)

- **Solves now.** A person starts a task from the app, or from a post in a DM. It gets its own workspace, with a repo if picked, and its own session the person talks to. A task started from a post reports back to that conversation after each turn.

### Comments on documents (`comments` table, `app/src/Document.tsx`)

- **Solves now.** A person comments on a version of a document, quoting the part they mean. Sent to the agent, the comment reaches the session that wrote the document, which revises it into a new version.

## Coding standards (`.claude/skills/coding-standards/`, `eslint.config.js`, `test/step0.ts`)

- **Solves now.** A skill that lists the bugs to avoid in this codebase, each with where we know it from (hit here, or documented by the tool makers) and what enforces it. Strict compiler flags and type-aware lint enforce most of them, and `npm run check` stops on any error before the checks run. `test/step0.ts` writes code that breaks each enforced rule and fails if anything gets through.
- **Helps later.** Every new kind of bug found here becomes a rule with its enforcement, so it is caught before a check has to find it.

## The name guard (`test/names.ts`)

- **Solves now.** The product is Agents. The guard fails `npm run check`, before anything else runs, when a file outside the research notes uses the studied app's name, an abbreviation of it, or calls an agent anything but an agent. It found 270 lines before the rename on 2026-10-13 and none after.
- **Helps later.** A name can't creep back in through a copied snippet, a new env var or a doc, because the next check run names the file and line.
