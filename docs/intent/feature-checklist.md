# Feature checklist

Tayler's goal is three things in one product.

- (A) Everything the agent app we studied does, on people's own machines and in the cloud.
- (B) The workflow features of the workflow tool we studied. Research, then plan, then implement, with checkpoints, drafts, approvals and diffs.
- (C) Multiplayer. A team and its agents sharing one record.

Each status below comes from reading the code on 2026-10-14. A table column, enum value or design doc that no code uses does not count as built. I ran no checks and did not touch the running system. 25 of the 47 step checks drive a stand-in for Claude instead of the real thing. Where I know real Claude has not run a feature, the row says so.

The statuses are:

- Live. On main, and in the code the running server loaded. The API and daemon on the server Mac restarted at 13:19 on 2026-10-14, when main was at f643a30. Live means the code runs there. It does not mean a person has used it.
- Merged. On main after that restart. Only the coding framework (b2aa8b5) qualifies.
- Landing. On a branch about to land, not on main. The branches are listed below.
- Partly. A named part exists, and the row says which.
- Not built. No code does it.

The landing branches are the computers, projects, verification, terminal sessions and AWS branches, and agents-git.

Counts. Table A has 65 rows, with 17 Live, 9 Landing, 10 Partly and 29 Not built. Table B has 34 rows, with 21 Live, 4 Merged, 3 Landing, 2 Partly and 4 Not built. Table C has 36 rows, with 13 Live, 3 Landing, 10 Partly and 10 Not built. Many rows in C repeat a row in A, so the areas overlap.

Where the docs and the code disagree is listed after the tables.

## A. What the agent app we studied does

Sources are `research/teardown.md` and `docs/evidence/`.

| Feature | Status | Where it is | What's missing |
|---|---|---|---|
| **Agents** | | | |
| Agents are records you can create as often as you like, from the app | Live | `server/agents.ts` (createAgent, updateAgent), `server/api.ts:319`, `app/src/AgentPage.tsx`, `test/step10.ts` | A person sets name, title, role, instructions, model and home machine. Nothing archives or deletes an agent, since nothing sets `agents.archived_at`. |
| Avatar and voice persona | Not built | none | `agents.avatar` and `agents.voice` are columns in `server/migrations/0001_data_model.sql`. Nothing reads or writes them. |
| Team agents with an owner, managers and an allowed list | Partly | `server/agents.ts` sets `owner_id` | Every agent is open to the whole team, and any teammate can edit it. `agent_managers` and `agents.visibility` are in the schema and nothing reads them. |
| **Computers and seats** | | | |
| One cloud computer for each person, shared by their agents | Live | `server/boxes.ts` (addPersonalBox), `server/onboarding.ts:58`, `server/box-routes.ts`, `box/Dockerfile`, `app/src/Box.tsx` | It is a Docker container in colima on the server Mac, not a microVM. It stops after 30 minutes with nothing to do and starts again when a turn waits for it, which Tayler decided on 2026-10-14 and step 1 of `docs/design/target-architecture.md` built. The image has Node, git and Claude Code, and no desktop. |
| A desktop and a browser inside the box | Landing | computers branch, `box/Dockerfile` (Xvnc, matchbox, Chromium, Playwright), `daemon/desktop.ts` | arm64 only. No real Claude session has used it in a box. No check shows a browser login surviving a rebuild. |
| Computer use, so an agent sees the screen, clicks and types | Landing | computers branch, `daemon/computer-mcp.ts`, `daemon/rfb.ts`, `daemon/screen.ts`, `shared/screen.ts` | Checked with the stand-in for Claude. Whether agents follow the verify-work loop without being told is not shown. |
| Browser tools, and screenshots saved as proof on the task | Landing | computers branch, `daemon/computer-mcp.ts` (save_screenshot, browser tools), `shared/documents.ts`, `server/migrations/0008_computers.sql` | Five browser tools ask a person first. A page that gives no text within 5 seconds blocks every screenshot, which Tayler accepted. A secret drawn outside the page text can still reach an image. |
| A seat for each agent in the box, with its own screen, browser profile and workspace | Partly | `daemon/agentsd.ts:142` gives each agent a folder on its machine, and `daemon/workspace.ts` gives each task a workspace | No screen or browser profile for each agent. On the computers branch every session on a box shares one desktop and one browser, and acts one at a time. |
| A seat table with a cap for each box | Not built | none | Nothing in the code or schema names a seat. |
| A separate microVM for each user | Not built | `server/boxes.ts` starts Docker containers | `AGENTS.md` lists what a box can still reach and read. |
| **Cloud and scale** | | | |
| Parallel coding jobs, each on its own cloud computer | Partly | `server/boxes.ts` (claims or makes a box for each run), `pipelines/bug-fix.ts`, `server/runner.ts` | A pipeline run gets a box. A task a person starts runs on its agent's home machine, beside that agent's other work. The cap is `AGENTS_MAX_BOXES`, 2 by default (`server/boxes.ts:32`). The agent app we studied runs 8 at once on its entry plan. |
| Fast start from warm copies | Not built | none | A stopped box restarts from its image and home volume. There is no pool of ready boxes. `docs/build-plan.md` lists warm pools as phase 4. |
| Box size and limits | Landing | computers branch, `server/boxes.ts` (4 GB, 2 CPUs, 4,096 processes) | Main sets no limits. Bigger boxes and more job boxes are not built. |
| Run on a home server | Live | `compose.yaml`, `ops/install-launch-agents.sh`, `server/api.ts` | One Mac. Boxes and long runs stop when it sleeps. |
| Run in the cloud on AWS | Landing | AWS branch, `ops/aws/` (stack, bootstrap, backup, restore, export), `ops/install-systemd.ts`, `docs/aws.md` | Written, not switched on. Nothing has called AWS and the checks use a fake one. About $217 a month. Deploying waits on Tayler. |
| Thinking runs on the vendor's servers, only tools run in the box | Not built | `daemon/claude.ts` runs Claude Code on the machine | The whole loop runs where the daemon runs, so a box holds a Claude token the agent can read. This is a different design. Decide whether the split is wanted. |
| **Working together** | | | |
| Agents send async messages to other agents | Not built | none | The team-record tools in `daemon/record-mcp.ts` read and remember. None sends a message. Agents only see each other's posts in a room. |
| Agents create agents | Not built | none | `createAgent` is reachable only by a person, through `server/api.ts:319`. |
| Subagents | Partly | `daemon/claude.ts` (parentToolUseId), `server/record.ts:253` | Claude Code's own subagents run inside a session and are recorded under the parent call. Their words stay out of the conversation. There is no child session record, list or limit, and no check. |
| Hand repo work to cloud coding agents | Not built | people and pipelines start box work in `server/tasks.ts` and `server/runner.ts` | An agent has no tool to start a task or a run. |
| **Chat and rooms** | | | |
| Direct chat with an agent, and the agent's own team-visible conversation | Live | `server/record.ts`, `server/api.ts:573`, `app/src/Conversation.tsx`, `test/step1.ts` (real Claude) | Nothing missing for the chat itself. The composer is a separate row. |
| Group chats of agents and people, one agent speaking at a time | Live | `server/rooms.ts`, `app/src/Work.tsx`, `app/src/Conversation.tsx`, `test/step10.ts` | No member cap, where the agent app we studied allows 6 agents, or 3 with people. A turn ends with a reply, PASS or a 180 second deadline. Only people can be added to a room after it is made (`server/onboarding-routes.ts:59`), not agents. |
| Live typing and a stop button | Live | `server/streams.ts`, `daemon/live.ts`, `app/src/live.ts`, `server/api.ts:488` | Nothing missing. The agent app we studied shows no live tokens. |
| Cards that wait on a person | Partly | `app/src/Asks.tsx`, `server/record.ts`, `server/runner.ts:876` | Tool approvals, pipeline gates and hand-off questions work. The asks table also lists form, draft, secret_request, connector_grant and credential_request, and nothing creates them. There is no multiple-choice question from an agent in chat, no form, no email or Slack draft and no secure entry for a secret. |
| Composer with an @ picker, a / skill menu, # pull requests, attachments and dictation | Not built | `server/rooms.ts` reads a typed `@name` | No picker, no skill or pull request menu, no attachments (6 files of 25 MB in the agent app we studied) and no dictation. |
| A chat room for each pull request | Not built | none | `conversations.kind` lists pr and slack_thread. Nothing writes them. |
| **Routines and triggers** | | | |
| Routines on a schedule, and run now | Live | `server/routines.ts`, `server/runner.ts:1006`, `shared/cron.ts`, `app/src/AgentPage.tsx`, `test/step10.ts` | The prompt goes to the agent's main conversation. Only `last_fired_at` is kept, so there is no run history, and nothing pauses routines when the owner is away. |
| Pipelines started on a schedule, a forge issue or a signed webhook | Live | `shared/pipeline.ts:13`, `server/hooks.ts`, `server/runner.ts:977`, `server/api.ts:602` | The forge trigger reads this Mac's Gitea issues and a label. A routine takes no webhook. |
| Triggers from GitHub | Landing | projects branch, `server/github-worker.ts`, `server/hooks.ts` | It polls each minute and starts a run only from an `agent:` label set by someone with write access. Pull request events, review events and CI results start nothing. No webhooks. |
| Triggers from Slack, Linear, Sentry, PagerDuty, Teams or email | Not built | none | `routines.trigger` allows webhook, github, linear, slack and email, but only cron is ever written (`server/agents.ts:156`) or read (`server/runner.ts:1011`). |
| Groups of triggers | Not built | none | |
| **Memory, skills and plugins** | | | |
| Memory for each person and the team, a profile plus dated logs | Live | `daemon/record-mcp.ts` (update_memory), `server/api.ts:159`, `server/agents.ts:193`, `app/src/AgentPage.tsx`, `test/step10.ts` | A session starts with the profiles and the last 4 days of logs. The app shows memory read-only. No recall or sort tools, and no promoting a personal fact to the team. |
| Skills | Live | `server/agents.ts` (saveSkill), `daemon/agentfiles.ts` | Per agent, written as Claude Code skill files. No `/` menu in chat. |
| Plugins and MCP servers | Live | `server/agents.ts` (savePlugin), `daemon/agentfiles.ts` | stdio and http servers, with secret names and no values. A missing secret stops the session and says which. |
| A plugin marketplace | Not built | none | |
| Sign-in for hosted connectors (MCP OAuth) | Not built | none | |
| Secrets that become environment variables on the box | Partly | `server/agents.ts:134`, `daemon/agentfiles.ts`, `daemon/agentsd.ts:263` | Only names reach Postgres. Values live in each machine's environment or in `~/.agents-app/secrets.json`, so a person can't set one from the app and a box can't be given one. |
| Templates, and cloning an agent to the team | Live | `server/agents.ts` (saveTemplate, install), `server/api.ts:345`, `app/src/AgentPage.tsx`, `test/step10.ts`, `test/step10b.ts` | A template carries title, role, instructions, model, skills, plugins and routines, not memories. It is versioned by name and works inside one team. `docs/intent/multiplayer.md` lists this as not built, which is wrong. |
| A marketplace of public templates and share links | Not built | none | `templates.visibility` allows public, but `install` looks up the team's own templates only. |
| **Integrations** | | | |
| A git forge with issues, pull requests and merge | Live | `server/forge.ts`, `server/git.ts`, `ops/forge-setup.ts`, `compose.yaml` | Gitea on the server Mac only. |
| GitHub | Landing | projects branch, `server/github.ts`, `server/github-auth.ts`, `server/github-worker.ts`, `server/projects.ts`, `app/src/Projects.tsx` | Off on the real server until it lands. The Agents GitHub App is not registered and the team's own app is designed only. A GitHub repo can get a policy, but the framework's gates call the Mac's forge. |
| Team agents in Slack | Not built | none | |
| Email inboxes for agents | Not built | none | |
| 1Password | Not built | none | |
| Payments and virtual cards | Not built | none | |
| **Voice and meetings** | | | |
| Voice calls with an agent | Not built | none | `agents.voice` is a column nothing uses. |
| Meetings | Not built | none | |
| Phone calls | Not built | none | |
| **Usage and billing** | | | |
| A weekly pool of usage, then pay per use | Not built | none | Claude runs on subscription logins and a box token. Agents keeps no pool and bills nothing. |
| A usage meter split by source (you, routines, agent to agent, rooms) or by agent | Partly | `server/record.ts:77`, `app/src/Run.tsx`, `app/src/Pipeline.tsx` | Cost for each session and run is stored, and the app shows it on runs and pipeline versions. There is no meter, no split by person, source or agent, and no token types. |
| Spend limits | Partly | `server/runner.ts:421`, `daemon/claude.ts` (`--max-budget-usd`) | A pipeline run stops at its spend cap and each stage gets what is left. Chats, routines and rooms have no limit, and no limit is for a person or an agent. |
| A paused session that resumes when the usage limit resets | Not built | none | The `limited` session status exists and nothing sets it. |
| **Safety and take-over** | | | |
| Approve or deny each tool call, with always and never | Live | `daemon/claude.ts:127`, `server/record.ts:133`, `server/record.ts:191`, `app/src/Asks.tsx` | Rules are for a team, machine, agent, tool and pattern. No team policy caps what members may allow. |
| Approvals that survive a restart | Live | `server/durability.ts`, `server/migrations/0010_durability.sql`, `test/step18c.ts` | A daemon built before this change breaks against the API. Tayler accepted that on 2026-10-14. |
| An admin deny list and team limits on what agents may do | Not built | none | `ops/policies/agents.json` is a repo policy for the coding framework. There is no command parsing, tool ceiling or network setting for agents. |
| A person watches an agent's screen and takes over | Landing | computers branch, `server/screens.ts`, `server/rfb-filter.ts`, `app/src/Screen.tsx`, `shared/screen.ts`, `test/step15.ts` | Latency was measured on the Mac, not over the tailnet. The checks stand in for Tailscale serve. |
| Secrets scrubbed before anything is stored | Live | `shared/scrub.ts`, `server/record.ts`, `daemon/live.ts` | Text only, from environment values and known key shapes. |
| Network limits for boxes | Partly | `ops/box-firewall.sh` | On main a box can reach only ports 7700 and 7701 on the server Mac. It can still reach the metadata address, the private network, the tailnet and other boxes. The AWS branch adds a firewall for the private ranges and drops NET_RAW. |
| Commands in a box run without asking | Not built | `server/permissions.ts` | Tayler decided this on 2026-10-14. Commands still ask on a box, as on a Mac. |
| **Own machine** | | | |
| Agents run on a person's Mac, with approvals in the app | Live | `daemon/agentsd.ts`, `daemon/claude.ts`, `server/admin.ts` (add-instance) | An admin adds a Mac with a command on the server host and hands over a token. A person can't claim their Mac from the app. |
| A cloud agent runs a command on your Mac after approval | Not built | none | `exec` commands (`server/runner.ts:479`) run only pipeline checks inside a workspace. `approval_rules.instance_id` exists, and no tool uses it. |
| Your own terminal sessions in the shared record | Landing | terminal sessions branch, `daemon/transcripts.ts`, `daemon/folders.ts`, `server/folders.ts`, `app/src/Terminal.tsx`, `server/migrations/0013_local_sessions.sql` | Claude Code only, no Codex. No cost for these sessions, no way to tell a closed terminal from a running one, and connected folders are not listed in the app. The branch is 47 commits behind main. |
| A Mac helper for computer use on your own Mac | Not built | computers branch, `docs/design/computers.md` (design only) | Nothing of it is written. |
| The desktop app | Partly | `desktop/main.cjs` (50 lines), the `desktop` script in `package.json` | A window onto the server's address. No packaged, signed download, no updater, and no built-in Mac connection or terminal capture (decided 2026-10-14). |
| Read your Claude Code and Codex setups, copy files to and from the box | Not built | none | The terminal sessions branch reads transcripts, not setups. |

## B. What the workflow tool we studied does

Sources are the "Agents data model" doc (https://claude.ai/artifact/GgdXD8X3Rw7gByVL631xn8) and its section on the workflow tool, `docs/design/workflow.md`, and `research/2026-10-13/`.

| Feature | Status | Where it is | What's missing |
|---|---|---|---|
| **Phases and checkpoints** | | | |
| Research, then plan, then implement, with a person's review after each phase | Partly | `pipelines/research-plan-implement.ts`, `shared/pipeline.ts`, `server/runner.ts`, `test/step14.ts` | The file, the gates and the checks exist. The runner confirms research and plan changed no code, and runs the plan's test command. It has run only with the stand-in for Claude. It is not published to the pipelines repo, it needs an agent named builder on a box, and commands in research and plan wait on a person. |
| A review gate with comments on the text, approve or send back with a note | Live | `app/src/Asks.tsx`, `app/src/Document.tsx`, `app/src/quotes.ts`, `shared/pipeline.ts` (gate stage), `test/step14c.ts` | A loop gets three tries, then a person decides. |
| Approve or deny each tool call | Live | `daemon/claude.ts:127`, `server/record.ts:133`, `app/src/Asks.tsx` | See the same row in A. |
| Edit files in the workspace without asking | Live | `server/permissions.ts`, `daemon/claude.ts:192`, `test/step14.ts` | Commands still ask on a Mac and on a box. Writes in `.git`, in `.claude` and outside the workspace ask. |
| Checkpoints as file snapshots, with a way back to an earlier state | Not built | none | Changes show the current state against the base. Earlier states of an unpushed file are not kept (`docs/design/workflow.md`). |
| **Drafts, order of work and board** | | | |
| Draft tasks, saved now and started later | Live | `server/drafts.ts`, `app/src/Draft.tsx`, `server/api.ts:420`, `test/step14.ts`, `test/step14c.ts` | Anyone who can see a draft can start it. The design lists this as a decision to revisit. |
| Start a task from a message, with progress reported back | Live | `server/tasks.ts`, `server/api.ts:360`, `app/src/Conversation.tsx:96` | Nothing missing. |
| Order of work with priority, blocked-by edges, holds and a ready list | Live | `server/order.ts`, `app/src/Order.tsx`, `daemon/record-mcp.ts` (ready_tasks), `test/step14.ts` | The ready list is a query. Nothing starts ready work by itself. Stacked pull requests do not follow the edges. |
| A board with a column for each phase | Not built | `tasks.phase` is a column only | Nothing sets phase and no view shows columns. The sidebar lists Ready and Held. |
| Tasks over several repos | Live | `server/checkout.ts`, `app/src/RepoPicker.tsx` | Pipelines still start with one repo. |
| A workspace for each task with a clone of each repo | Live | `daemon/workspace.ts`, `server/launch.ts` | One workspace for each task. Parallel attempts at one task, each in its own workspace, are not built. |
| **Diffs, pull requests and review** | | | |
| Every changed file listed with line counts, and a file viewer with a diff tab | Live | `daemon/changes.ts`, `server/changes.ts`, `app/src/Changes.tsx`, `app/src/FilePanel.tsx`, `app/src/Code.tsx`, `test/step14b.ts` | Current state only. A file over 512 K characters, a binary file, or a repo with more than 20,000 changed files is listed without content. |
| Diff between two versions of a document | Live | `server/versions.ts`, `server/api.ts:454`, `app/src/Document.tsx` | Nothing missing. |
| Plans and research as versioned documents, with comments pinned to the text | Live | `app/src/Document.tsx`, `app/src/quotes.ts`, `server/api.ts:446` | A comment reaches the session that wrote the document, which revises it. Nothing missing. |
| Open a pull request from a task | Live | `server/pulls.ts`, `app/src/Changes.tsx`, `server/api.ts:412`, `test/step14.ts` | A pull request merged by hand on the forge still shows open here. Only Gitea has been tried. |
| Pull requests on GitHub | Landing | projects branch, `server/github.ts`, `server/projects.ts` | See GitHub in A. |
| Workflows as versioned files, each stage an agent turn, a check, an action or a gate | Live | `shared/pipeline.ts`, `server/pipelines.ts`, `server/runner.ts`, `app/src/Pipeline.tsx`, `app/src/Run.tsx` | Nothing missing. |
| A bug-fix workflow from an issue to a reviewed pull request | Live | `pipelines/bug-fix.ts`, `server/hooks.ts` | It runs on a box, which needs a Claude token saved on the server. |
| Review of a change by an agent on a different model | Merged | `server/framework.ts` (startReview), `pipelines/app-change.ts` | Only on a repo with a policy, and the Agents repo is not registered. Advisory until judges run on their own machine. |
| A verifier agent that checks the plan's Done means with evidence | Merged | `server/framework.ts` (startConfirm), `shared/verification.ts`, `.claude/skills/verify/` | Main has a 33-line stand-in skill. The verifier runs on the author's box. |
| Gates before a merge, such as protected paths, size, secrets and checks that fail on main | Merged | `shared/gates/`, `daemon/gates.ts`, `ops/policies/agents.json`, `server/admin.ts` (set-policy) | The full suite runs on the server Mac, not an isolated check host. |
| Watch CI and review comments on a pull request, and fix them | Not built | none | `server/forge.ts` posts commit statuses and never reads CI. |
| An agent drives the app to prove a change (agentsctl) | Landing | verification branch, `bin/agentsctl`, `ctl/`, `.claude/skills/verify-agents/`, `test/step17.ts` | No full sweep since the rebase. The pipelines verify-create and verify-maintain are described, and the files do not exist. Six steps that need real Claude have not run. Visual baselines are not committed. |
| Deploy an approved change, and roll back on a failed health check | Merged | `ops/deploy.ts` | Not installed as a launch agent. |
| A worktree manager for agents' parallel branches (agents-git) | Landing | agents-git, `daemon/agents-git/`, `docs/design/agents-git.md` | It works on this repo only, and the app's task workspaces do not use it. Ports and a test database for each worktree, and the Claude Code hooks, are not built. |
| **Where work runs and how people watch** | | | |
| Many daemons on many hosts | Live | `daemon/agentsd.ts`, `server/api.ts` (heartbeat, claim), `server/boxes.ts` | An admin adds a Mac from the server host. |
| One write path, so every message goes through the API | Live | `server/record.ts`, `server/api.ts` | Nothing missing. |
| A sync engine over plain HTTP, with an auth proxy | Live | `server/sync.ts`, `compose.yaml` | Lists poll instead of holding a connection each, because a browser allows six. |
| Live tokens on a durable stream | Live | `server/streams.ts`, `daemon/live.ts`, `app/src/live.ts` | Nothing missing. |
| Open a teammate's session live, from the web or desktop app | Live | `app/src/Session.tsx`, `app/src/Conversation.tsx`, `server/access.ts` | No phone app. A phone needs a browser on the tailnet. |
| Stop a turn, and resume after a crash with approvals kept | Live | `server/durability.ts`, `daemon/fence.ts`, `shared/lifecycle.ts`, `test/step18a.ts` | Several restart paths have no check, and `docs/what-each-part-does.md` lists them. |
| Model, cost, turns and status for each session | Partly | `server/record.ts:77`, `shared/types.ts` | Stored. Only runs show cost. `sessions.started_by_session`, for a parent session, is in the schema and nothing sets it. |
| Command palette | Live | `app/src/Palette.tsx`, `test/step14c.ts` | It finds names and titles, not text. |
| A notice when a checkpoint needs a person | Not built | none | Approval cards and gates show only while the app is open. |

## C. A team and its agents sharing one record

Sources are `docs/intent/multiplayer.md`, including its "Definition of done".

| Feature | Status | Where it is | What's missing |
|---|---|---|---|
| **Team and agents** | | | |
| Every person has agents, and anyone can create one from the app | Live | `server/agents.ts`, `server/api.ts:319`, `app/src/AgentPage.tsx` | See the same row in A. |
| Every person has their own computer in the cloud, on a home server or AWS | Partly | `server/boxes.ts`, `server/onboarding.ts:58`. AWS branch, `ops/aws/` | The home server works. AWS is written and not switched on. |
| Each agent has its own seat, with a screen, a browser and a workspace | Partly | See the seat row in A | Workspaces only on main. Screen and browser are shared for a box on the computers branch. |
| Parallel coding jobs get computers of their own | Partly | `server/boxes.ts` | See the parallel jobs row in A. The cap is 2. |
| Agents create agents, message agents and hand work to them | Not built | none | See Working together in A. |
| Agents work together in rooms | Live | `server/rooms.ts`, `test/step10.ts` | See Chat and rooms in A. |
| A teammate's agent setup can be copied, or started from a template | Live | `server/agents.ts`, `server/api.ts:345`, `test/step10b.ts` | See the templates row in A. |
| Each agent picks its engine and model, such as Claude, Codex or Gemini | Partly | `daemon/harness.ts` (the interface), `agents.model` in `server/agents.ts` | Only Claude runs. `daemon/agentsd.ts:254` throws for any other harness, `createAgent` takes no engine, and there is no Codex or Gemini code. |
| **Building** | | | |
| Tasks, files, diffs and pull requests on the Mac's forge | Live | `server/tasks.ts`, `server/changes.ts`, `server/pulls.ts`, `app/src/Work.tsx`, `app/src/Changes.tsx` | See B. |
| The same on GitHub | Landing | projects branch | See GitHub in A. |
| Reviews and approvals on the team's repos | Partly | `app/src/Asks.tsx`, `pipelines/bug-fix.ts` (shepherd gate), `server/framework.ts` | Pipeline gates ask a person to approve and merge. A pull request from a plain task is reviewed and merged on the forge. Review by another agent runs only on a repo with a policy. |
| Agents load skills and plugins | Live | `daemon/agentfiles.ts` | See A. |
| Agents run hooks | Not built | none | No hook setting for an agent and no hook runner. The daemon starts Claude with `--setting-sources project,local` (`daemon/claude.ts:185`). |
| People keep using Claude Code in their own terminals, and those sessions land in the record | Landing | terminal sessions branch | See the terminal row in A. |
| **The record** | | | |
| Every message, tool call, tool result, error and thought is saved | Live | `server/record.ts`, `daemon/claude.ts`, the events, raw_events and messages tables | Sessions the app starts only. Terminal sessions are on a branch. |
| People search all of it from the app | Not built | `app/src/Palette.tsx` finds names and titles | No search page over events and messages. |
| Agents search it with their record tools | Live | `daemon/record-mcp.ts` (search_record, read_session, recent_activity), `server/teamrecord.ts`, `server/migrations/0001_data_model.sql:286`, `test/step5.ts` | Nothing missing. |
| A plain summary for each session, agent and day | Not built | none | Runs carry stage summaries. Sessions, agents and days carry none. |
| Any step opens in full | Live | `app/src/Session.tsx` | Nothing missing. |
| Secrets are scrubbed before anything is written | Live | `shared/scrub.ts`, `server/record.ts` | Text only. |
| Postgres is the only system of record, and reads sync over plain HTTP | Live | `compose.yaml`, `server/sync.ts`, `server/migrate.ts` | The computers branch adds image bytes to Postgres. |
| Everyone on the team sees everything, with private rooms and tasks | Live | `server/access.ts`, `server/sync.ts` | Access is for a conversation or a task, with members. A session follows the one it serves. Admins stay out of private rooms. |
| **Control and cost** | | | |
| A live usage meter by agent, person, source and token type | Partly | `server/record.ts:77` | See the usage meter row in A. |
| Budgets that stop a runaway agent | Partly | `server/runner.ts:421` | See spend limits in A. |
| People are told when an agent needs approval, gets stuck or finishes, on desktop and phone | Not built | none | The app shows an approval card and an interrupted line, only while it is open. |
| It is clear who can drive whose agents, and what agents may do without asking | Partly | `server/agents.ts:57`, `server/permissions.ts` | Only the owner may make agents on a personal box. Any teammate can still message those agents, start tasks with them and add them to a room. Tayler decided on 2026-10-14 that only the owner drives them, and it is not built. |
| An admin can remove a person and delete their data | Not built | none | The Tailscale page can delete a tailnet user. Nothing removes a person from the team or deletes their rows. Tayler decided on 2026-10-14 that this gets built. |
| **Where the team already works** | | | |
| GitHub | Landing | projects branch | See GitHub in A. |
| Slack | Not built | none | |
| Email | Not built | none | |
| **Joining** | | | |
| A new teammate goes from invite to first message in under 10 minutes | Partly | `server/onboarding.ts`, `server/onboarding-routes.ts`, `app/src/Team.tsx`, `server/tailscale.ts`, `server/claudelogin.ts`, `daemon/claude-login.ts`, `test/step12.ts` | `docs/decisions.md` says the people socket and tailnet policy went live on 2026-10-14, and invites start once an admin saves a Tailscale key. The checks use a stand-in for Tailscale and the real API was never called. No full Claude sign-in has run. The time is not measured. |
| The signed one-download app | Not built | `desktop/main.cjs` (50 lines) | No packaging, signing or updater. Decided 2026-10-14, to start after the branches land. |
| **Pipelines that improve** | | | |
| Pipelines are versioned code, and each run carries its version | Live | `shared/pipeline.ts`, `server/pipelines.ts`, `pipelines/` | Nothing missing. |
| The system proposes pipeline improvements and a person approves them | Live | `pipelines/improve.ts`, `pipelines/coach.ts`, `server/hunks.ts`, `server/refine.ts`, `app/src/Proposal.tsx` | Tayler accepted on 2026-10-14 that coach and improve lost `propose_instructions` and `apply_proposal`. Improve needs checked findings now. |
| **Proof** | | | |
| Every item has a check in `npm run check` or a case in the test plan | Partly | `test/all.ts`, 47 `test/step*.ts` files | No test plan exists. Rows marked Not built have no check. |
| Every item has been tried on the live system with a second person | Not built | none | No record of a trial with a second person. |

## Where the docs and the code disagree

- `docs/intent/multiplayer.md` lists copying agents and templates as not built. Templates are built and checked in `test/step10.ts` and `test/step10b.ts`.
- The same doc lists the coding framework as built and landing, and `docs/decisions.md` says it is not on main. It is merged on main (b2aa8b5), and the running server has not loaded it.
- `docs/decisions.md` is behind three branches. It says agents-git is not built, and the branch has code and `test/step22.ts`. It says the check that breaks each feature is not built, and the verification branch has `test/step17-breaks.ts`. It says the AWS export skips box home volumes, and the AWS branch's `ops/aws/export.ts` includes them.
- `docs/design/onboarding.md` still says nobody should be invited until the people socket's live steps are done. `docs/decisions.md` says they are done.
- `AGENTS.md` says each cloud agent gets its own Docker container with a desktop and a browser. `docs/intent/multiplayer.md` says agents share one computer for each person, each with a seat. Main has neither a desktop nor a seat.
- `docs/intent/multiplayer.md` says each session carries an access list. Access sits on conversations and tasks, and a session follows the one it serves (`server/access.ts`).
- `docs/design/verification.md` describes the pipelines verify-create and verify-maintain. The verification branch has no such files.
- The schema and types hold options that no code carries out. They are `routines.trigger` values other than cron, the codex value of `agents.harness`, `agents.avatar`, `agents.voice`, `agents.visibility`, `agent_managers`, `tasks.phase`, `sessions.started_by_session`, five ask kinds, the pr and slack_thread conversation kinds, the limited and needs_input session statuses, and public templates.
- `docs/design/workflow.md` says the research, plan and implement pipeline has not run for real. The checklist counts it as Partly for that reason.

## Biggest gaps

In order of how central each is to the goal.

1. Agents cannot work with other agents. No tool lets an agent create an agent, message one or start a task or run. Its team-record tools only read and remember.
2. There is no seat for each agent, and the desktop, browser and take-over are not on main. Boxes on main have no screen. On the computers branch all sessions on a box share one desktop.
3. Nobody is told when an agent needs them. There are no notifications on desktop or phone, so approval cards and review gates wait until someone opens the app.
4. The research, plan and implement pipeline has never run with real Claude and is not published. It needs an agent named builder on a box.
5. Only Claude runs. The harness interface is there, `createAgent` cannot pick an engine, and the daemon refuses any other.
6. Spend has no meter and no limit per agent or person. Only pipeline runs have a cap, so a chat, routine or room can spend without one.
7. Work starts only from cron, this Mac's Gitea and a signed webhook. Slack, email, Linear and the rest are not built, and GitHub is on a branch. Voice, meetings, phone calls, 1Password, payments and a plugin marketplace are not started, and Tayler's intent files voice and meetings under later phases.
8. People cannot search the record or read summaries of it. Only agents can search.
9. A person cannot be removed from the team, and "only the owner drives agents on their box" is decided and not enforced.
10. The cloud half and joining are not ready. AWS is switched off, a team gets 2 job boxes by default, and there is no warm start. There is no signed one-download app, an admin adds each Mac by hand, and the invite flow has never run against the real Tailscale API.
