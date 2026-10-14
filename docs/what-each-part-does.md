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
- **Helps later.** Branch rules for agents go in one place. On a repo with a policy it now takes a machine's push only to the task branches of that machine's own workspaces, records any other, and reads only a push's command lines before streaming the pack on. A repo without a policy takes pushes to any branch.

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

- **Solves now.** An agent reads how a pipeline's runs went (the `pipeline_history` tool), changes that pipeline's file once, and reports the steps of those runs the change rests on. Code keeps only the quotes it finds in their steps, from team runs of that pipeline other than replays and its own run. The change is split into hunks citing those findings, and refused before any replay when it cites none from the last 90 days, or repeats a hunk the shepherd turned down, the same change or one on the same evidence. Otherwise it is scored, and only a change that scores better becomes a pull request on the pipelines repo, with both scores and the checked quotes, and reaches the shepherd. Approving merges it, and the merged file becomes the current version. Either way the decision is recorded on every hunk. `test/step20c.ts` and `test/step9.ts` cover it.
- **Helps later.** It can run on a schedule, so pipelines keep getting better while nobody is watching.

### The coach pipeline (`pipelines/coach.ts`, `server/evidence.ts`, `server/hunks.ts`, `server/refine.ts`)

- **Solves now.** Coach learns from corrections people keep making to the agent named in the run's title. Code picks the agent's team sessions with steps nobody has read, never a replay, a private session or a learning pipeline's. A cheap model reads them once and reports findings, and code keeps a finding only when its quote is in a step the reader was shown. A correction counts only in a person's words, never the agent's or a tool's. Corrections group into candidates, counted in code across sessions and people, with people's, pipeline and box sessions counted apart. A candidate needs two sessions, expires after 90 days, and is routed before any text is written: one person's to their profile, one a check could catch to a check, a narrow one to a skill, the rest to the instructions. The writer's change comes as hunks the server computes and checks, each citing findings about one correction, with floors, at most five hunks and a size budget. Replays of the turns behind the change, and of unrelated turns, run with and without it, as many as the run's cap allows, and only a change that wins reaches the shepherd, who keeps or turns down each hunk with a reason. A hunk turned down stays down, reworded or on other findings, until more sessions back it, and the writer sees each one with its reason. `test/step20.ts`, `test/step20a.ts` and `test/step20b.ts` cover each rule. The design is `docs/design/evidence.md`.
- **Not built yet.** Agents has no lint job, so a kept check hunk is listed in the run's note for a person to add.

### Proposals in the app (`app/src/Proposal.tsx`)

- **Solves now.** A proposal shows its summary and the scores of both versions, on the pipeline's page and on the run that proposed it, next to the gate that approves it. Each hunk shows its diff, the quotes it rests on with who said them, and its count of sessions, people's, pipeline and box apart, and of people. At a coach proposal's gate a person keeps or turns down each hunk, with a reason to turn one down, and the hunk then shows who decided and why. A page reads the hunks and names once for all its proposals, and only while it shows one. `test/step20d.ts` drives it in three browsers and at phone width.

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

## Coding standards (`.claude/skills/coding-standards/`, `eslint.config.js`, `test/step0.ts`)

- **Solves now.** A skill that lists the bugs to avoid in this codebase, each with where we know it from (hit here, or documented by the tool makers) and what enforces it. Strict compiler flags and type-aware lint enforce most of them, and `npm run check` stops on any error before the checks run. `test/step0.ts` writes code that breaks each enforced rule and fails if anything gets through.
- **Helps later.** Every new kind of bug found here becomes a rule with its enforcement, so it is caught before a check has to find it.

## The name guard (`test/names.ts`)

- **Solves now.** The product is Agents. The guard fails `npm run check`, before anything else runs, when a file outside the research notes uses the studied app's name, an abbreviation of it, or calls an agent anything but an agent. It found 270 lines before the rename on 2026-10-13 and none after. It reads only regular files, so a worktree that links main's packages can run it.
- **Helps later.** A name can't creep back in through a copied snippet, a new env var or a doc, because the next check run names the file and line.

## Rules for agents (`AGENTS.md`, `CLAUDE.md`)

- **Solves now.** Any agent that opens the repo gets the rules in force today: what to read first, names, keeping off the live system, schema changes, sharing the test database, what done means and how changes land. Claude loads them through `CLAUDE.md`, which imports `AGENTS.md`. Other agent tools read `AGENTS.md` directly. It also holds the coding framework's rules, its hard gates and protected paths, with each gate's enforcement and what is not enforced. It says plainly that the framework does not hold changes to this repo until the repo is registered with its policy.
- **Helps later.** There is one rules file to keep current, and a workspace imports a repo's `AGENTS.md` even when the repo has no `CLAUDE.md`.

## The coding framework

The design is `docs/design/self-improve.md`. None of this holds changes to the Agents repo itself until the repo is registered with its policy.

### Policies (`shared/policy.ts`, `ops/policies/agents.json`, `server/admin.ts set-policy`)

- **Solves now.** A repo's policy is the rules every change to it must pass, as versioned JSON in Postgres. `set-policy` loads one, names the repo's owner, and sets the forge's branch protection to match. A policy may tighten the core's 400-line cap and verdict floors, and the schema refuses one that loosens them.
- **Helps later.** Any repo a team adds gets the same framework by getting a policy, with no code of its own.

### Static gates (`shared/gates/diff.ts`, `shared/gates/code.ts`, `shared/gates/css.ts`, `shared/gates/prose.ts`, `shared/gates/plan.ts`, `shared/gates/glob.ts`, `shared/gates/source.ts`, `server/mirror.ts`)

- **Solves now.** The API keeps a bare copy of each repo and reads a change's diff from it, running no repo code. Pure functions judge the diff against the policy: protected paths, migrations and the data model, docs and the build log, secrets, dependencies, suppressions, size, the CSS and prose lints, languages, type assertions, shell strings, warning comments, the playbook's scope, the approved plan, refused pushes, UI checks and edits to existing checks. They read only the lines a change adds.
- **Helps later.** A lesson that becomes a rule lands here as one more function with its fixtures in `test/step16b.ts`.

### Box and check host gates (`daemon/gates.ts`)

- **Solves now.** In the box, the daemon runs the policy's commands on a clean checkout of the pushed commit with the check configuration from main, then runs each changed check on main's code, where it must fail, and on the change, where it must pass. On the check host it merges the change into the current main and runs the full suite and the same checks on the result. Each result names the daemon's build.
- **Helps later.** Moving the check host into its own VM changes where the daemon runs, not this code.

### The framework's stages (`server/framework.ts`, `pipelines/app-change.ts`)

- **Solves now.** The runner calls these for any run on a repo with a policy: the router, verify, a review on other models with main's rubric, a verifier whose verdict is judged by the commands it ran, the suite with one rerun for a flake, the protected and owner gates, the merge at the judged head, and the deploy. They write evidence, findings, verdicts and decisions, set the forge's statuses, write the pull request for a reviewer who was not there, pass people's decisions to later stages, fail a stage whose machine goes silent, and refuse to merge without a typed proof of every gate. `app-change` is the playbook that strings them together.
- **Helps later.** A team's own playbooks reuse the same stage kinds.

### Builds and attestation (`shared/build.ts`, `server/build.ts`, `shared/attestation.ts`)

- **Solves now.** Each process knows its build: the commit, a hash over the source it runs, and the Node version. Evidence and verdicts record the builds behind them, and the health check answers with the server's. When the suite passes, the runner writes an attestation into the pull request's description and its sha256 as a status on the head commit, which `checkAttestation` verifies.
- **Helps later.** A CI job can accept a pull request from the attestation alone, beside an outside contributor's own gate tool.

### Verification evidence (`shared/verification.ts`)

- **Solves now.** The verification agent's schemas for screenshots, the feature map and the verdict ladder. The framework's gates, the check host and `agentsctl` parse evidence with the same ones.
- **Helps later.** One format for evidence means the gate can read whatever the verifier records.

### Overrules that hold (`shared/findings.ts`)

- **Solves now.** A finding the owner overruled stays overruled when a later round raises the same one: the same rule, the same path and the same body. A reworded finding is a new one, so an overrule never silences a different complaint.
- **Helps later.** The same key can match findings across runs, such as one raised on every change to a file.

### Obligations (`server/obligations.ts`)

- **Solves now.** A run that starts from an issue promises the reporter its outcome, and the runner posts it when the run ends. The promise closes only with proof of the kind it promised, or a person's named waiver with a reason, and a stale or conflicting delivery changes nothing.
- **Helps later.** Any promise made outside Agents, such as a reply owed in another tool, fits the same typed row.

### The deployer (`ops/deploy.ts`)

- **Solves now.** It releases an approved commit from the repo's mirror into a release folder, backs up, migrates unless the runner has failed the deploy meanwhile, switches the `current` link, restarts, and checks the health answer names the new commit. When it does not, it goes back to the release before by itself. It runs as its own process because a deploy restarts the API.
- **Helps later.** Once installed as a launch agent, deploys of Agents itself go through the owner's approval and this rollback.

### The verification skill (`.claude/skills/verify/SKILL.md`, `.claude/skills/verify/features.json`)

- **Solves now.** It tells the verifier how to check each feature, and the feature map lists each feature's paths and checks, which a plan's Keep items must name.
- **Helps later.** The verification agent's skill replaces it once that skill has its own feature map.

### The schema (`server/migrations/0009_self_improve.sql`, `shared/framework.ts`)

- **Solves now.** The tables for policies, evidence, findings, verdicts, decisions, lessons, obligations, refused pushes and deploys, and the shapes the server, the daemon and the checks share, each crossing a boundary as a zod schema.
- **Helps later.** New kinds of evidence add rows, not tables.

### The framework's checks (`test/step16.ts`, `test/step16b.ts`, `test/step16c.ts`, `test/step16d.ts`, `test/step16f.ts`, `test/style.ts`, `test/types-framework.ts`)

- **Solves now.** `step16` takes changes through the whole pipeline with a stand-in for Claude, including runs each gate must stop. `step16b` checks every static gate, the policy floors and the attestation on small fixtures, and runs in a box. `step16c` deploys to a stand-in server and rolls back a release that cannot start. `step16d` checks obligations. `step16f` checks the git proxy's push reader on pushes built in memory. `STEP16_ONLY` runs some of step16's sections alone, for watching one guard fail. `style` lints the whole repo's CSS and prose, and `types-framework` shows at compile time that no merge proof can be built without each part.
- **Helps later.** Each new gate gets its fixture here before it can be called built.

## The cloud half on AWS

The plan is `docs/aws.md`, and the design with its reasons is `docs/design/aws.md`.

### The machine port's address (`server/api.ts`)

- **Solves now.** `AGENTS_MACHINE_HOST` lists the IP addresses the machine port listens on, checked when the API starts, so the server on AWS can answer boxes on its VPC address and teammates' daemons on the tailnet. The people port stays on loopback. The machine port refuses any Tailscale identity header, not only the login.
- **Helps later.** Teammates' own computers can run daemons against the server.

### Boxes on a box host (`server/boxes.ts`)

- **Solves now.** `AGENTS_BOX_DOCKER_HOST` sends box commands, image builds included, to another host's Docker, such as `ssh://agents@agents-boxes`, without moving the server's own Compose there. A remote box host needs `AGENTS_BOX_API`, or the server refuses to start. One `docker ps` per runner pass reads every box's state, a box keeps its token while its host is unreachable, and tokens never reach the log through a failed `docker run`.
- **Helps later.** Boxes can move to a bigger host, or several, by changing one setting.

### The AWS stack (`ops/aws/stack.ts`, `ops/aws/app.ts`, `ops/aws/config.ts`)

- **Solves now.** One CDK stack in TypeScript describes everything on AWS: the network with no inbound port from the internet, RDS PostgreSQL 17 with logical replication and backups, the server and the box host with IMDSv2 and a hop limit of 1, least-privilege roles, the backup bucket and 14 alarms, all tagged `app=agents`. `npx cdk synth` and `npx cdk diff` are the dry runs.
- **Helps later.** Sizes, zones and the alarm address are settings, so growing the box host is one deploy.

### First boot and services (`ops/aws/bootstrap.ts`, `ops/install-systemd.ts`, `ops/aws/compose.server.yaml`)

- **Solves now.** A few lines of user data install Node and hand over to `bootstrap.ts`, which installs Docker and Tailscale, joins the tailnet with the host's own key, and installs the services. `ops/install-systemd.ts` is the Linux counterpart of the Mac's launch agents.
- **Helps later.** Any Linux machine can run the server or a box host with the same units, with or without AWS.

### Boxes' way out (`ops/aws/box-firewall.ts`)

- **Solves now.** A box is an agent's computer, so its browser and tools reach the public internet over any protocol, and look names up at public resolvers. Inside, it reaches only the server's machine port. The firewall drops what a box sends to the box host, the VPC, RDS, the metadata endpoint, the tailnet, other boxes and every private range, and Docker cannot start without it.
- **Helps later.** What boxes may not reach is one list, `BOX_CLOSED_RANGES`, and one update.

### Secrets on AWS (`ops/aws/secrets.ts`, `ops/aws/fetch-secrets.ts`)

- **Solves now.** Secrets go from this Mac to SSM without touching a command line or the screen, and the server writes them to files with mode 600 at every boot. The database password is generated by RDS and never leaves AWS.
- **Helps later.** A new secret is a name in `SECRET_PARAMETERS`.

### Backups, restore and health (`ops/aws/backup.ts`, `ops/aws/restore.ts`, `ops/aws/health.ts`)

- **Solves now.** Every night the database and the forge go to S3, kept 35 days, beside RDS's own 7 days. A restore refuses while anything is connected. Every minute each host reports what the alarms watch, including whether the API answers and how old the last backup is.
- **Helps later.** The restore is also how a rollback to this Mac works.
- **Not done.** The nightly backup leaves out the boxes' home folders, so losing the box host's disk loses them, and a rollback leaves what boxes did on AWS behind.

### Cutover, updates and teardown (`ops/aws/export.ts`, `ops/aws/update.ts`, `ops/aws/down.ts`)

- **Solves now.** One command moves this Mac's data, every box's home folder and the secrets to AWS at cutover, and refuses while the API or a box is running. The restore puts each box's home back on the box host, so a task resumes in its workspace with the same Claude session. One command on each host moves it to the last deployed commit. One command takes everything down, keeping a final snapshot and the backups unless told otherwise.

### The AWS checks (`test/step11.ts` to `test/step11f.ts`, `test/fake-aws.ts`)

- **Solves now.** They cover the machine port's address, boxes on a real `ssh://` Docker host, what a box can reach through the firewall, the synthesized template, the host scripts against a fake AWS that speaks the real protocols, and a rehearsal of the move on this Mac in which a task resumes on a box restored from the export. None of them needs an AWS account.
