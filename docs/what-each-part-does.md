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
- **Survives Postgres restarting.** It waits for Postgres when it starts, replaces connections Postgres drops, and its runner listens again, so restarting colima or the Mac needs nothing from you. `check:step2` drops its connections to prove it. A connection Postgres drops in the middle of a transaction fails that transaction and leaves the pool, and the process keeps running. `test/step18i.ts` drops one inside `tx` in `server/db.ts`. Every connection the server takes from the pool, for a transaction or for the migrations, comes through `withConnection` there and listens the same way, except the runner's listening connection, which has its own listener.

### Commands (`commands` table)

- **Solves now.** A queue of work for each machine. The daemon waits on it and claims what arrives, and each command records whether it was done. A `message` command stays claimed until the turn that answers it ends, so a machine that dies mid-turn leaves its unfinished messages marked.
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
- **Watch for.** Tailscale runs in userspace mode here, and in that mode a tailnet connection to any port serve does not claim reaches the same port on this Mac's loopback. Every loopback service is a tailnet service unless the tailnet policy says otherwise, so the policy must let peers reach the server only on TCP 80 and 7700. The policy on 2026-10-13 still allows everything. `test/live-tailnet.ts` reads the filter the server enforces, and fails until the policy changes. No real peer has been tried, since no other device is on the tailnet.

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

- **Solves now.** People reach the API only on a Unix socket, `AGENTS_PEOPLE_SOCKET`, which only `tailscale serve` points at. Tailscale in userspace mode hands a tailnet peer's connection for any port to the same port on this Mac's loopback, so a TCP people port would let any peer name anyone. A socket file is out of its reach, so a direct connection can never name a person. Tailscale's own proxy on 1055 still needs the tailnet policy to keep peers off it, since through it a peer would reach serve as this Mac and be taken for its owner. Machines use 7700 with their tokens, and that port refuses any person's identity. A container on this Mac cannot pose as you. `docs/design/people-port.md` has the reasons, `test/step19.ts` proves the API's side, and `test/live-tailnet.ts` checks the live server.
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

## Onboarding

The design, with what is not done, is in `docs/design/onboarding.md`. Nobody should be invited until the live steps in `docs/design/people-port.md` are done. Until the live API serves people only on its socket and the tailnet policy is in place, a tailnet device can send its own login header, and joining by invite trusts that header.

### Admins (`people.role`, `server/admin.ts`)

- **Solves now.** A person on a team is an admin or a member. Only admins invite, add people who ask to join, and use the Tailscale page, and the API answers members 403 there. `admin.ts add-team` makes the team's first login its admin, and `admin.ts set-role` changes a role. Migration 0005 made the earliest person of each team with no admin an admin.
- **Helps later.** Anything else only some people should do checks the same role.

### Invites and joining (`server/onboarding.ts`, `app/src/Team.tsx`)

- **Solves now.** An admin types an email on the Team page. With Tailscale connected, the invite goes through Tailscale's API, which emails the person, and the admin sees the link to send it themselves. The person is on the team from their first visit, with nothing to do. The app reads `/v1/me`, which writes nothing, then asks to join with a JSON post. A login nobody invited sees a waiting screen naming it, admins see it under Wants to join with a count in the sidebar, and one click adds it. The waiting screen opens the app by itself once they are added. Invites can be resent and cancelled.
- **Helps later.** Growing the team takes no terminal on the server, and the tailnet and the team stay in step.
- **Not done.** Removing someone from the team. Checked only against a stand-in Tailscale.

### The Tailscale key and page (`server/tailscale.ts`, `app/src/Tailscale.tsx`)

- **Solves now.** An admin pastes a Tailscale API access token in the app. The server checks it with Tailscale and keeps it in a file of its own, mode 600. It never reaches Postgres, a log or a browser, which sees only its last four characters and when it expires. The Tailscale page lists the tailnet's users, devices and invites, read from Tailscale each time. From it an admin approves, suspends, restores or removes a user, changes their role, adds them to the team, authorizes or removes a device, and resends or cancels an invite. From 14 days before the key expires, the sidebar, the Team page and the Tailscale page say how to make a new one.
- **Helps later.** Tayler manages the tailnet without leaving the app.
- **Not done.** The real Tailscale API has not been called. The checks use `test/fake-tailscale.ts`, built from Tailscale's published API spec. Without `AGENTS_TAILSCALE_API` and `AGENTS_TAILSCALE_KEY_FILE` in `.env`, Tailscale is off.

### A box for each person (`server/boxes.ts`, `app/src/Box.tsx`)

- **Solves now.** Joining makes the person a box, named after their login, and the runner starts its container as it does for any box someone holds. Runs never claim it, the box limit doesn't count it, and it never stops for being idle. It never gets the team's Claude token. When Docker can't start it, the box keeps what Docker said on stderr, never the error's message, which repeats the command line with the box's token. A newcomer sees steps in place of the welcome text until their box is ready and they are signed in to Claude, and the Your box page shows the box's state. A new agent's machine defaults to the person's own box, and only the owner can make agents on it.
- **Helps later.** Each person's agents run on their own computer and their own Claude account, so one person's work doesn't slow or bill another's.
- **Not done.** Personal boxes run all the time. Boxes on the real server get the new daemon only after `server/boxes.ts build` and recreating them.

### The Claude sign-in relay (`server/claudelogin.ts`, `server/box-routes.ts`, `daemon/claude-login.ts`)

- **Solves now.** A person signs in to their own Claude account from the app, without a terminal. Their box runs `claude setup-token` under `script`, which gives it a terminal, and posts the sign-in link, which reaches only its owner's page. The code they paste goes to their box once and is gone from the server after that, or after ten minutes. The box saves the token in its home volume, mode 600, and starts its Claude sessions with it. The token stays on the box, where its agents and the tools their plugins run can read it. Teammates can message those agents and add them to rooms, and those turns use the owner's account. A box that restarts during a sign-in fails it and says so.
- **Helps later.** The same relay can sign a box in to anything else that needs a browser once.
- **Not done.** No full sign-in has run against the real CLI. The checks use `test/fake-claude-login.ts`. The real CLI was run in a box only to read its link and its answer to a bad code. The token lasts a year and nothing renews it.

### Adding someone to a room (`server/rooms.ts`, `app/src/Conversation.tsx`)

- **Solves now.** A room's People button lists who is in it, and someone in the room, or an admin, adds a teammate from there. A private room takes no one from outside it, admins included. The room's agents then name that teammate among the room's people on their turns, with what they remember about them.
- **Helps later.** Rooms can be built around a piece of work and filled as people join it.

### The onboarding checks (`test/step12.ts`, `test/step12b.ts`, `test/step12c.ts`)

- **Solves now.** step12 drives all of it through the API against the stand-in Tailscale, including the sign-in relay with the check acting as the box. step12b drives the Team page, the waiting screen, the Tailscale page, a box that could not start and a room's People list in Chromium, Firefox and WebKit at desktop and phone width. step12c starts real box containers from a test-tagged image, and a newcomer watches their box start, signs in through it with the stand-in Claude, and gets an answer from an agent running on their token.
- **Helps later.** Every later change to joining, boxes or sign-ins runs against the same three.

## The work layer

The design, with what is not done, is `docs/design/workflow.md`.

### Draft tasks (`server/drafts.ts`, `app/src/Draft.tsx`)

- **Solves now.** A person saves a task without starting it. Teammates see it in the sidebar marked draft, and anyone who can see it can change it, start it or discard it. Starting a draft gives it a workspace and sends its agent the first message, the same as a task started at once.
- **Helps later.** Work gets written down when it comes up and started when there is room for it, in the order the ready list gives.

### Order of work (`server/order.ts`, `app/src/Order.tsx`, the `ready_tasks` tool)

- **Solves now.** A task can wait on other tasks, with a reason, and can be held with a kind, a one-line reason and an optional end date. The sidebar's Ready lists the drafts that nothing blocks or holds, most urgent and then oldest first, and Held lists the held ones with why. Agents read the same list through `ready_tasks`. Every command says when it changed nothing, so running one twice is safe.
- **Helps later.** Stacked pull requests can follow the edges, and "waiting on Tayler" becomes a hold that shows where work stopped and why.

### Tasks over several repos (`server/checkout.ts`, `app/src/RepoPicker.tsx`)

- **Solves now.** A task picks one or more repos. The workspace clones each into a folder named after it, adding the owner when two share a name, and the first message names every folder.
- **Helps later.** A change to a service and its client is one task, with a pull request in each repo.

### Changes (`daemon/changes.ts`, `server/changes.ts`, `app/src/Changes.tsx`)

- **Solves now.** Every file the agent added, changed or deleted in each repo shows on the task, and on a run's page, with its line counts against the base branch. A repo with more than 20,000 changed files says so instead of listing them, and one git cannot read shows git's error and its last list. The daemon works them out on its own machine and scrubs them before they leave it, so the browser never reads a machine's files.
- **Helps later.** A person or a reviewing agent sees the whole change before any pull request exists.

### The file viewer (`app/src/FilePanel.tsx`, `app/src/Code.tsx`, `app/src/highlight.ts`)

- **Solves now.** A changed file or a task's document opens beside the task. Markdown renders, code has line numbers and highlighting in weight and tone, and a Diff tab shows the change against the base, or a document's change from its previous version.
- **Helps later.** Other kinds of files agents make can open in the same panel.

### Pull requests from a task (`server/pulls.ts`, the `pushes` table)

- **Solves now.** Open pull request pushes the task branch of every task repo and opens a pull request for each one with commits past its base, in the agent's name. A push never overwrites commits someone else added on the forge. It says so, and goes through once the agent merges them. They show on the task, and stay there once nothing differs. Asking again opens no second pull request.
- **Helps later.** Any forge behind `forge.openPullRequest` works the same way. Only Gitea has been tried.

### Writing without asking (`server/permissions.ts`)

- **Solves now.** A task's session creates, edits and deletes files in its own workspace without asking. Commands still ask, on a Mac and on a box. Conversations ask as before.
- **Helps later.** If Tayler decides boxes may run commands without asking, it is one place to change.

### The research, plan and implement pipeline (`pipelines/research-plan-implement.ts`)

- **Solves now.** The agent researches and writes `research.md`, then plans in `plan.md`, then changes the code, and a person approves or sends back each phase. Comments pinned to a document reach the agent when it is sent back. The runner checks that research and planning changed no code, and runs the plan's test command. It has run only with the stand-in for Claude, in step 14.
- **Helps later.** Hard changes get a reviewed plan before any code, and the plan's test proves the change.

### Comments pinned to text (`app/src/quotes.ts`, `comments.anchor.occurrence`)

- **Solves now.** A comment's quote is marked where it sits in the document, and the comment keeps which match it means when the words appear twice. Clicking either finds the other, and a quote that is gone says so.
- **Helps later.** Review of an agent's plan or research happens on the lines themselves.

### The command palette (`app/src/Palette.tsx`)

- **Solves now.** Cmd+K on a Mac, Ctrl+K elsewhere, opens a search over agents, conversations, tasks, runs, pipelines and documents, beside the actions New task, New room and New agent. Outside a field, c starts a new task and r a new room, and single keys can be turned off. step14c finds a task and runs an action by keyboard alone.
- **Helps later.** New actions join the palette without new buttons.

### The step 14 checks (`test/step14.ts`, `test/step14b.ts`, `test/step14c.ts`)

- **Solves now.** step14 drives the API, daemon, forge and runner with the stand-in for Claude. step14b is Tayler's README task in three browsers at desktop and phone width. step14c covers drafts, the order of work, the palette, pinned comments and a run's gate the same way. All but 16 of step14's checks, which the build log names, were seen failing with what they guard broken.
- **Helps later.** A change that breaks any of these parts fails a named check.

## Durability

The design is `docs/design/durability.md`.

**A regression for Tayler to decide.** A daemon built before this branch breaks against it. An old daemon that starts retries the removed requeue route forever while its machine shows online, and one already running gets 400 when it reports a message done, so its session and any pipeline stage in it are marked failed while its Claude keeps working. A new daemon against an old API retries `/v1/instance/recover` the same way. Rolled out in this order, no old daemon reaches the new API: rebuild the box image with `server/boxes.ts build`, recreate every box's container, stopped boxes included, and check that each runs the new image, then restart the Mac's daemon, then the API. The branch lands without a transition, and Tayler can overrule that. The design doc has the details, including when to do the box steps.

### Messages finish with their turn (`daemon/claude.ts`, `server/durability.ts`, `shared/lifecycle.ts`)

- **Solves now.** Claude prints each message back when a turn takes it in, and the turn's result says which messages it answered. The server marks those done in the same transaction that records the turn's end, and marks a message failed when its Claude exits first. A follow-up a person sends mid-turn still joins that turn. The daemon's busy flag no longer sticks after Claude answers two messages with one result. `test/step18g.ts`.
- **Helps later.** `moveMessages` moves a message only along the table in `shared/lifecycle.ts`, which has no move back to the queue, and throws otherwise, so a path that changes a message's status through it can't run a turn twice. Nothing but review keeps a new path from writing the status directly. `test/step18i.ts` checks the refusals.

### Restart and resume (`daemon/fence.ts`, `POST /v1/instance/recover`)

- **Solves now.** A daemon that starts stops any Claude its last run left, then reports in. Every session it had unfinished messages in is marked interrupted in the record and resumed in the same Claude conversation, told which tool calls may or may not have run and every message it had not answered. In `test/step18a.ts` real Claude killed mid-poem finishes the poem. In `test/step18b.ts` a line appended before the crash stays written once, and a daemon stopped with SIGTERM mid-turn leaves the turn for its next start to resume. A turn resumed three times that stops its machine a fourth time fails with the reason instead, `test/step18l.ts`. The daemon parses what recover returns, each session on its own, and a claimed message's payload the same way, so a message an older API queued without `permissions` fails with the reason, `test/step18l.ts`.
- **Helps later.** Another engine with durable sessions can run behind `daemon/harness.ts` against the same checks.
- **Not done.** No check covers a fence that can't stop the last run's Claude, or a resumed session the daemon can't read. A daemon killed during a task's first clone can resume the turn in a half-cloned tree while the requeued setup runs beside it. No check holds a `setup_workspace`, `exec` or `push` command across a restart, for the requeue in `recoverMachine`.

### Approvals across a restart (`asks.request_ended_at`, `server/durability.ts`)

- **Solves now.** An approval card stays answerable while its machine is down and after it restarts. When the resumed session asks again for the same tool and input, the same card takes the request, and an answer already given reaches it, `test/step18c.ts`. A denial given while the machine is down reaches the resumed session as a denial, and a decision that may already have reached Claude is never offered again, however often the machine restarts, `test/step18j.ts`. A card left open when its turn ends expires, and so does a decision the resumed session never asked for, and an allow an interrupt left undelivered is never offered to a later turn, `test/step18h.ts`. A batch sent again closes no card, `test/step18i.ts`. A person's answer takes the session's lock before the ask's, as recovery does, so the two can't deadlock, `test/step18k.ts`.

### The machine watchdog (`markLostMachines` in `server/durability.ts`)

- **Solves now.** A machine silent for `AGENTS_MACHINE_LOST_SEC`, 45 seconds by default, shows as stale, and its working sessions as lost, with the reason in the record. The app shows an interrupted line with an Interrupt button in place of an agent typing forever, in a DM and on a task's page. `test/step18e.ts` checks it in a browser, and checks that a connected and a reconnecting client read what the record holds. An API given less than two heartbeats refuses to start, `test/step18i.ts`.

### A restart for a new setup (`startSession` in `daemon/agentsd.ts`)

- **Solves now.** When an agent's new setup can't start, such as a plugin's missing secret, its session shows failed with the reason, and the old process's exit no longer sets it idle. `test/step18f.ts`.

## Terminal sessions

The design, with what is not done and the calls waiting on Tayler, is `docs/design/local-sessions.md`.

### Connected folders (`daemon/folders.ts`, `server/folders.ts`, the `connected_folders` table)

- **Solves now.** A person connects a folder on their Mac once, with `node daemon/folders.ts connect`, and every Claude Code session they start in it, or in a folder inside it, from their own terminal lands in the record. Only the Mac connects or disconnects its folders, with its machine token, so nobody in the app can make another person's sessions leave their Mac. The team sees a folder's sessions, and `--private` keeps them to the person who connected it. Only `--team` widens a private folder again.
- **Helps later.** The app can list a Mac's folders and disconnect one through the same rows.

### The transcript reader (`daemon/transcripts.ts`, `transcriptBatch` in `daemon/claude.ts`)

- **Solves now.** The daemon reads the transcripts Claude Code writes under `~/.claude/projects` for the sessions that started in a connected folder after it was connected. It posts each prompt, reply, thinking block, tool call and result, with a subagent's work under the Agent call that started it. It scrubs them as it scrubs an app session, adds the values in the folder's `.env` files, and leaves images on the Mac. A session started anywhere else is read only as far as the line that says where it started, and nothing of it leaves the Mac. A restart goes on where the last one stopped.
- **Helps later.** Codex keeps transcripts too, so its terminal sessions need one more reader, not a new path into the record.

### Terminal sessions in the app (`app/src/Terminal.tsx`)

- **Solves now.** The sidebar's From terminals lists recent terminal sessions by folder and whose terminal they ran in, and Running now marks a live one as terminal. Each opens on its own page, `#/l/<session id>`, with every event. Agents' `search_record` finds them like any session the team shares.
- **Helps later.** A teammate's Claude finds a fix made in a terminal, which is where most fixes are made today.

### The step 21 check (`test/step21.ts`)

- **Solves now.** It runs the real `claude` CLI with `haiku`, headless, through the real daemon, API and Electric. It connects a folder and runs sessions in it, in a folder inside it, beside it, before it was connected and after it was disconnected, and in a private folder. Then it checks what the record holds and what it doesn't, the scrubbing, the picture that stayed on the Mac, the subagent, what each person sees in the API and in Chromium, a daemon restart, and what the API refuses.
- **Helps later.** A Claude Code release that changes its transcripts fails this check instead of going quiet.

## Coding standards (`.claude/skills/coding-standards/`, `eslint.config.js`, `test/step0.ts`)

- **Solves now.** A skill that lists the bugs to avoid in this codebase, each with where we know it from (hit here, or documented by the tool makers) and what enforces it. Strict compiler flags and type-aware lint enforce most of them, and `npm run check` stops on any error before the checks run. `test/step0.ts` writes code that breaks each enforced rule and fails if anything gets through.
- **Helps later.** Every new kind of bug found here becomes a rule with its enforcement, so it is caught before a check has to find it.

## The name guard (`test/names.ts`)

- **Solves now.** The product is Agents. The guard fails `npm run check`, before anything else runs, when a file outside the research notes uses the studied app's name, an abbreviation of it, or calls an agent anything but an agent. It found 270 lines before the rename on 2026-10-13 and none after. It reads only regular files, so a worktree that links main's packages can run it.
- **Helps later.** A name can't creep back in through a copied snippet, a new env var or a doc, because the next check run names the file and line.

## Rules for agents (`AGENTS.md`, `CLAUDE.md`)

- **Solves now.** Any agent that opens the repo gets the rules in force today: what to read first, names, keeping off the live system, schema changes, sharing the test database, what done means and how changes land. Claude loads them through `CLAUDE.md`, which imports `AGENTS.md`. Other agent tools read `AGENTS.md` directly.
- **Helps later.** The framework's fuller rules merge into the same file, so there is one rules file to keep current.
