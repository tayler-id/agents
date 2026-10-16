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
  - It links things together. A person's message becomes a post in the conversation, a user event in the agent's session, and a turn, which the scheduler hands to the agent's machine as a command. When the agent's turn ends, its last words become its post in the conversation, linked to the event that wrote them.
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

### Live reading: Electric and the sync proxy (`server/sync.ts`, `test/step2c.ts`)

- **Solves now.** The app and the daemons read Postgres live over plain HTTP. Electric follows Postgres's change log like a read replica and streams new rows. The proxy in front of it picks the table and the filter from who is asking, so a person sees only their team, minus private conversations and tasks they are not in. A client never names its own filter.
- **What a client's read may carry.** The proxy passes on `offset`, `handle`, `live` and `cursor` and drops every other key. A read with a subset key gets 400, because Electric lets a subset's filter name a column the shape hides. A shape that lists its `columns` also sends them as `queryable_columns`, so Electric would refuse such a filter itself. `test/step2c.ts` checks the refusal through the instances shape, and that live reads, their cursor and the 409 for a replaced shape still work.
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

### The app (`app/`) and the desktop app (`desktop/main.cjs`, `desktop/preload.cjs`)

- **Solves now.** One screen for the team: agents, conversations, pipelines, runs, what is running now, and machines. A conversation shows posts, live typing, ask cards and interrupt. A session panel shows every step an agent took. Agent replies and documents render their markdown. The Electron app opens the server's tailnet address, and its preload gives the server's page three calls to the Mac's daemon, for the Terminal folders page.
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
- **Helps later.** Branch rules for agents go in one place. On a repo with a policy it now takes a machine's push only to the task branches of that machine's own workspaces, records any other, and reads only a push's command lines before streaming the pack on. A repo without a policy takes pushes to any branch but its default one, by the branch rule below.

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

### Boxes (`box/Dockerfile`, `server/boxes.ts`, `shared/boxes.ts`, `ops/box-firewall.sh`)

- **Solves now.** A box is a Docker container that runs the daemon, for unattended work. A run on a box pipeline claims one, or makes one while the team is under its limit, and releases it when it ends. A person can claim one too. A box nobody holds stops after 30 idle minutes and starts again for the next run. Its home folder is a volume, so workspaces survive a restart and a rebuild of the image. A firewall in the colima VM lets boxes reach this Mac only on the machine port. `shared/boxes.ts` names a box's container, its home volume and the label that ties it to its instance, for the server that starts them, the AWS cutover scripts that move their home folders, and agentsctl's `down` that removes an instance's. Changing a name leaves the containers and volumes already made under the old one.
- **Helps later.** Boxes run Claude on your subscription once a token from `claude setup-token` is in `~/.agents-app/box-claude-token`.
- **Fenced in.** Boxes run without `NET_RAW`, so a box cannot put raw frames on the shared bridge or capture packets. `ops/box-firewall.sh` keeps every container off this Mac except on the machine ports. It also keeps boxes off every private range and off the VM except for DNS, as the box host does on AWS. The script and its check are written. The live VM does not have that part until Tayler runs the live steps in `docs/aws.md`.

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

- **Solves now.** A routine sends a prompt to its agent's main conversation on a cron schedule, or when someone runs it from the app. The team sees the prompt and the reply. Each firing is a turn with the routine's id and whoever ran it, so the turns table keeps every firing. No page shows that history yet.

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

- **Solves now.** Joining makes the person a box, named after their login, and the runner starts its container as it does for any box someone holds. Migration 0024 made one for everyone already on a team. Runs never claim it, and the box limit doesn't count it. It gets the team's Claude token from `~/.agents-app/box-claude-token`, as pool boxes do, so its agents work before its owner signs in to Claude, and on the owner's own token once they have. It goes to sleep after `AGENTS_BOX_IDLE_MIN`, 30 minutes by default, with nothing to do, and wakes when a turn waits for it, a command is queued for it, its owner starts a Claude sign-in, or a person holds its screen. The Your box page and the welcome steps say it is asleep, and the Team page lists it so. When Docker can't start it, the box keeps what Docker said on stderr, never the error's message, which repeats the command line with the box's token. A newcomer sees steps in place of the welcome text until their box is ready and they are signed in to Claude, and the Your box page shows the box's state. A new agent's machine defaults to the person's own box, and only the owner can make agents on it.
- **Helps later.** Each person's agents run on their own computer and their own Claude account, so one person's work doesn't slow or bill another's.
- **Not done.** Boxes on the real server get the new daemon only after `server/boxes.ts build` and recreating them. A person can watch an asleep box's screen only once something wakes it, since the Screen view does not wake it.

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

## Agent computers

The design is `docs/design/computers.md`.

### The box's computer (`box/Dockerfile`, `daemon/desktop.ts`)

- **Solves now.** Every box has a desktop, made of TigerVNC's Xvnc as its 1280x800 display and VNC server, JWM as the window manager with a dock along the bottom, and Chromium kept open with its profile in the home volume. The daemon starts all three, restarts any that exits, and clears the locks a killed box or a home volume from another host leaves behind, so the screen comes back after an idle stop, after a crash, and on a recreated box. The desktop's programs see none of the daemon's tokens. The daemon takes no work until seat 1's desktop is up, and stops so the box starts again when it can't come up. Each agent at work on a box has a seat with a desktop of its own, as "Seats" below says. The image also carries Playwright 1.64.0's Chromium, Firefox and WebKit, so agents run checks in all three engines without a download. A box runs within the size its row gives, which for a person's computer is 8 GiB of memory and 4 CPUs, and for any other box 4 GiB and 2 CPUs, with 4,096 threads for each seat.
- **Helps later.** Each person's own box, which onboarding added, and the AWS host can use the same image. The screen size comes from one environment variable, `AGENTS_DESKTOP`.

### Computer tools (`daemon/computer-mcp.ts`, `daemon/screen.ts`, `daemon/actions.ts`, `daemon/rfb.ts`, `daemon/png.ts`, `daemon/page-secrets.ts`)

- **Solves now.** Every session in a box except a judge's gets a `computer` MCP server. Its `computer` tool takes Claude's computer-use actions (click, type, key, scroll, drag, screenshot) on the box's screen, `save_screenshot` saves proof into the task folder, and Playwright's browser tools drive the box's Chromium. The daemon's screen service runs every session's actions one at a time over its own VNC connection and encodes screenshots as PNG, so the image needs no xdotool or ImageMagick. Acting on the box's own screen runs without a prompt, while file uploads, page scripts and full network bodies ask a person first. No screenshot is saved while a page in the box's browser shows a secret the box holds, since a saved image is never scrubbed.
- **Helps later.** The Mac helper in the design can serve the same tools through the same socket.

### Watching and taking over a screen (`server/screens.ts`, `server/rfb-filter.ts`, `daemon/screen-link.ts`, `shared/screen.ts`)

- **Solves now.** A person on the team watches a box's screen live through the people socket, as their Tailscale login, from the app's own pages only, and the screen leaves the box only through outbound connections to the machine port. The box keeps one control connection open, and the API asks it for a tunnel per viewer, pinging both and dropping either once it stops answering. Who holds the screen is a typed state machine, and the open row of `screen_takeovers` records it. Only the holder's keys and clicks pass the API's filter. While a person holds the screen the agent's screen and browser actions are refused by name, the agent's browser call under way returns with the refusal, and the record notes each takeover. A view closed without handing back returns the screen to the agent after 30 seconds. A box that ran private work in the last day can be watched only by people who can see that work, and someone already watching when such work starts is cut off.
- **Helps later.** A Mac with the computer-use helper in the design can serve the same Screen view through the same tunnel.

### The Screen view (`app/src/Screen.tsx`)

- **Solves now.** A task or session running in a box has a Screen button. It opens the box's screen beside the work, live, through noVNC, with who holds it and one action: Take over or Hand back. While a person holds it, their keys and clicks go to the box, and everyone else watching sees who has it. A refusal, such as private work on the box, shows its reason, and a stopped box says it is not connected and offers Reconnect. The view loads only when someone opens a screen, so the rest of the app stays light.
- **Helps later.** Runs and conversations can link to the same view once their pages show which box a stage ran on.

### Images as documents (`shared/documents.ts`, `server/record.ts`, `app/src/Document.tsx`)

- **Solves now.** Images an agent writes in its task's folder, such as the screenshots it saves to show what it checked, become documents with versions and comments, beside the text ones. A file is an image when its bytes say so: PNG, JPEG, WebP or GIF, up to 5 MB. The bytes live in Postgres in `blobs`, a table sync never reads, and the app fetches them through the people socket for anyone who can see the task.
- **Helps later.** A run's report or pull request can show the screenshots its agents saved, from the same table.

### Checking their own work (`daemon/computer-guide.ts`)

- **Solves now.** A session on a machine with a screen, except a judge's, is told to check every change by running its tests and looking at the result in the browser, and to save a screenshot of each thing it checked. The `verify-work` skill spells out the steps, unless the agent has its own skill of that name.
- **Helps later.** The coach pipeline can propose changes to the skill the way it does for any other.

## Seats

The design is "Seats" in `docs/design/target-architecture.md`, and Tayler's calls of 2026-10-15 and 2026-10-16 are in `docs/decisions.md`. The scheduler from step 1 gives each turn on a person's computer a seat.

### The seats table (`server/migrations/0015_seats.sql`, `shared/seats.ts`)

- **Solves now.** Each box has a row for each of its seats, numbered 1 to its seat cap, with the agent holding it and whether it is free, starting or ready. The database makes the rows whenever a box is added or its cap changes, however it was added. A box's size is in its row too. A person's computer holds 4 seats in 4 CPUs and 8 GiB, and every other box keeps 1 seat in 2 CPUs and 4 GiB. A session records the seat it last ran on, and a takeover the seat whose screen a person held. `shared/seats.ts` holds the row's type, how its status moves, and what the API and a box tell each other.
- **Helps later.** The scheduler places a turn on its agent's seat, and the app shows who works where.

### Giving out seats (`server/seats.ts`, `server/seat-routes.ts`)

- **Solves now.** The scheduler calls `takeSeat` for each turn it places on a person's computer. It gives the turn's agent the seat it holds there, else the free seat with the lowest number, else the seat the reclaim rule takes back. That is the seat whose agent has no turn there that is not over, whose screen nobody holds, and whose last turn there started or ended the longest ago, more than 15 minutes back. With none, the turn waits with the `seat` reason, and its line reads "Waiting for a seat on Bob's computer, 4 of 4 held". The runner places it once a seat comes free. A seat records its last turn as each turn starts and ends. A pool box takes no seats, so its sessions run on seat 1 as before and a pipeline's stages keep their placement. A box asks which seat a session runs on each time it starts it or hands it a message. The answer is the seat its agent holds there, or seat 1, and it is recorded on the session. A box reports a seat up for its agent, which makes it ready.
- **Helps later.** A seat cap set from the computer's page, and a computer that grows when its seats stay busy.

### Seats in a box (`daemon/seats.ts`, `daemon/desktop.ts`)

- **Solves now.** Each seat is a display, a window manager with its dock, a browser and a screen service of its own. Seat n has display :n, its browser's DevTools port 9221 + n and its own sockets, so seat 1 keeps the :1 and 9222 a box had before. Seat 1 runs whenever the box does, and its failure to come up still stops the box so it starts again. Every other seat runs while an agent holds it. The daemon follows its box's seat rows, starts and stops seats to match, closes a seat's pages and the windows its dock opened when another agent takes it, and reports each seat up for its agent. A session waits for its seat, and its `computer` server drives that seat's screen and browser. A session whose agent moves to another seat starts again there with its next message.
- **Helps later.** A job computer is a box with one seat.

### The desktop on every seat (`daemon/dock.ts`, `daemon/open-window.ts`, `daemon/whiteboard.ts`)

- **Solves now.** Each seat's window manager is JWM, which gives windows title bars to move, resize, minimize and close them, and Alt+Tab to switch between them. Its dock along the bottom has three buttons, named on hover: a new browser window, a terminal (xterm, starting in the home folder) and the whiteboard, then a list of the open windows to click between. The browser and whiteboard buttons open windows in the seat's own browser over its DevTools port, so a click never starts a second browser on the seat's profile. The whiteboard is Excalidraw 0.17.6, served by the daemon from the box on port 8400 of its loopback, so it opens with no network and no account. A drawing stays in the local storage of the seat's browser. The agent's guide and its computer tool name the dock. The terminal and everything the dock starts see only `PATH`, `HOME` and `DISPLAY`, never the daemon's tokens.
- **Helps later.** A person who takes over a seat finds the tools they know, and more apps go on the dock the same way.
- **Not done.** A drawing lives in one seat's browser, so another seat's whiteboard starts empty, and one agent's drawing stays in the seat for the next agent that takes it.

### Every person's computer (`server/migrations/0024_own_computers.sql`, `conversationSession` in `server/record.ts`)

- **Solves now.** The migration made a computer for each person on a team who had none, as joining makes one, and moved each agent whose home was a Mac to the computer of its owner, or the Mac's owner when it has none. Running it again changes nothing. A conversation whose session is on a machine that is no longer its agent's home moves home once its turn is over. The API archives the old session, and the next message starts a new one on the agent's computer. A turn still running on the Mac finishes there first.
- **Helps later.** Every agent has a desktop to work on, with no step to put it there.
- **Not done.** `admin.ts add-person` makes no computer, so someone added that way still presses "Make my box". The files an agent made on its Mac stay there, and a moved conversation starts without the old session's Claude context.

### Shared logins (`daemon/logins.ts`, `daemon/devtools.ts`)

- **Solves now.** Every 1.5 seconds the daemon reads each running seat's cookies over its browser's DevTools port and copies what one browser changed into the others, so logging in once logs in every agent on the computer, and logging out logs them all out. A browser that starts, or starts again, takes the shared cookies whole, so a seat that was stopped through a logout can't bring the login back. A seat goes to work once its browser holds them, or after 10 seconds without them, which it logs. Seat 1's profile, the one a box had before seats, keeps the logins across a restart. `daemon/devtools.ts` is the daemon's DevTools client, which `daemon/page-secrets.ts` also uses.
- **Helps later.** Logins a site keeps in a page's storage, such as localStorage or IndexedDB, could be copied the same way. Today they stay in their own seat.

### A seat's screen (`server/screens.ts`, `daemon/screen-link.ts`, `shared/screen.ts`)

- **Solves now.** Each seat has its own screen, viewers and takeover. `/v1/screens/<box>/seats/<n>` watches seat n, and a screen named without a seat is seat 1. Taking over one seat stops only that seat's agent. The box keeps one control connection, which carries each seat's control and tunnel requests. One agent's private work hides only its own seat's screen, and a box session with no seat counts for seat 1. A free seat's screen is off, so it can't be opened.
- **Helps later.** The Mac helper can serve its screen as a seat.

### Seats in the app (`app/src/Screen.tsx`, `app/src/Box.tsx`)

- **Solves now.** The Screen view names the seat it shows. A session's Screen button opens the seat the session runs on. The box page lists the box's seats, the agent holding each and whether it is ready, with a Screen for each running seat, which opens beside the page.

### The seat checks (`test/step15c.ts`, `test/step15d.ts`, `test/step15f.ts`, `test/step15g.ts`, `test/step15h.ts`, `test/seats.ts`)

- **Solves now.** step15c, step15d and step15g start a person's computer from a box image built under a tag of the run's own, and give agents seats with `takeSeat`, as the scheduler will. step15c drives both seats' browsers at once and checks each screenshot shows its own page, takes over seat 1 while seat 2 keeps working, signs in on seat 1 and finds the login in seat 2, signs out on seat 2 and finds seat 1 signed out, starts seat 3 with the login, checks the privacy rule per seat, and prints each seat's memory. step15d drives the box page's seat list and a seat's Screen view in Chromium, Firefox and WebKit at desktop and phone width. step15g adds a person through the app and finds their computer made, started and running Claude on the team's token, which is in no table and no log, until they sign in. With the computer tool it opens a terminal from the dock and types into it, switches windows with Alt+Tab, draws a rectangle on the whiteboard and saves a screenshot, then finds the windows gone when another agent takes the seat and a dock on seat 2, and prints the memory of each seat with the new desktop. step15f runs migration 0024 twice on a Postgres of its own in a throwaway container and checks the computers it makes, the agents it moves, and a moved agent's conversation going home. step15h drives the scheduler the same way, through people's messages: a seat for each agent's turn, a seat's turn time, a fifth turn waiting with its line, each guard of the reclaim rule, the longest idle seat taken back, and a pool box taking no seat. `test/seats.ts` holds what they share, including the computer tools started with the check's environment.

## Projects and GitHub

The design is in `docs/design/projects.md`.

### Projects (`server/projects.ts`, `shared/projects.ts`, `0006_projects.sql`)

- **Solves now.** A project groups a team's work on one thing: its repos, its room, and the tasks, runs, documents and rooms made in it. Making one makes its GitHub repo, with a README as the first commit, and its room with the chosen teammates and agents. A task started in a project works only in its repos, and a task or run on a project's repo joins that project. Every shape the server and the app share is a zod schema in `shared/projects.ts`, with branded ids.
- **Helps later.** Anything that belongs to one piece of work, such as a spending cap or which pipelines run where, hangs off one row.

### Repo requests (`repo_requests` table)

- **Solves now.** The app writes down each repo it will ask GitHub for before it asks, so a crash or a refusal never leaves a repo nobody knows about. A try claims the request in a transaction of its own, asks GitHub with none open, and records the answer in another, so a slow GitHub never holds a database connection or a lock. A failed request keeps GitHub's reason, and trying again adopts a repo an earlier try made. A repo that exists already joins only if whoever asked for it can push to it.
- **Helps later.** Anything else the app makes outside Postgres can follow the same steps: write the intent, act, record the result.

### GitHub as a forge (`server/github.ts`, `server/repos.ts`)

- **Solves now.** The runner, the hooks and the app reach GitHub with the same calls as this Mac's Gitea, so pipelines work on either. Each repo records its forge in `repos.forge`, every answer from GitHub is parsed before anything reads it, and every call gives up after 15 seconds. A repo's calls are made for one team's row of it, so two teams with the same GitHub repo never act with each other's sign-ins. Issue titles are cleaned and cut at the client, so no prompt gets one raw.
- **Helps later.** Another forge is one more client behind the same calls.

### Signing in to GitHub (`server/github-auth.ts`)

- **Solves now.** Each person connects their own GitHub account by typing a code on GitHub's device page, with nothing to register. Their token stays in a mode 600 file on the server, renewed before it expires, and never reaches Postgres, a log, a machine or a browser. A repo's calls use the sign-in of whoever brought it into its team's project. An admin's fine-grained personal access token is their team's stopgap until people sign in, and no other team ever uses it.
- **Helps later.** A team's own GitHub App, for agents with their own identity, plugs in as one more kind of identity where the server picks a token, and nothing that calls GitHub changes.

### The GitHub worker (`server/github-worker.ts`)

- **Solves now.** GitHub can't reach this server, so the worker asks it every minute. It reads the `agent:` labels that people with write, maintain or admin access put on issues and starts runs from them, checking each person's access with GitHub, and the runner checks it again before a pull request opens. Triage access can label issues but starts nothing, and so does a label taken off or an issue closed before the worker reads it. A poll that fails partway reads the same labels again next time. It also marks pull requests merged or closed on GitHub, and tries again repo requests that a restart left half done. A list that hasn't changed comes back 304 and costs nothing against GitHub's limit.
- **Helps later.** Webhooks through a small public receiver can feed the same functions, and the worker then only catches up after downtime.

### Text crossing to and from GitHub (`server/public-text.ts`)

- **Solves now.** An issue's text reaches an agent as a quoted report. micromark, a CommonMark parser, reads the whole body in a thread of its own before what a reader sees of it is cut at 20,000 characters. A body it takes over 2 seconds to read is left out with a line that says so, so a hostile issue can't hold the API. Code spans and fenced code stay as written, and only what parses as an HTML tag goes. The parts a reader can't see go too: invisible characters, link definitions, link destinations and titles, fence info strings, images with their alt text, fences GitHub draws such as mermaid, and raw HTML's tags, comments, hidden elements, and style and script elements, read as a browser reads them. Every prompt quotes the run's title and the other open issues' titles, each on one line and cut at 120 characters, whatever started the run. Everything sent to GitHub's API loses addresses on this tailnet, private addresses, email addresses and secrets first. Commits that machines push are not filtered.
- **Helps later.** An agent that reviews public pull requests posts through the same filter.

### The branch rule (`server/git.ts`)

- **Solves now.** Machines never push to a repo's default branch through the git proxy, so changes reach main through pull requests, even on GitHub plans that can't protect a private repo's branches. The proxy asks the forge for the default branch on each push, and refuses a whole push that names it, including one that deletes it. Tasks and runs ask the forge too before their workspace is cloned, so after a repo's owner renames the default branch, a new workspace starts from the new name and a new run's pull request goes to it.
- **Helps later.** Other rules about what machines may push go in the same place.

### Projects and repos in the app (`app/src/Projects.tsx`, `app/src/App.tsx`, `app/src/Work.tsx`)

- **Solves now.** The sidebar lists projects with their rooms, tasks and runs under them, and a Repos entry with the team's count. The Repos page says in one line what it shows, lists every repo with where it lives, its project, its open pull requests and task branches, and connects GitHub. New project makes a project and its repo. A project's page shows its repos, people, tasks, runs, documents and rooms, and starts tasks, rooms and runs in the project. A task's page names its project and its repos.
- **Helps later.** The redesign starts from one view per thing a person looks for.

### The step 13 checks (`test/step13.ts`, `test/step13b.ts`, `test/step13c.ts`, `test/fake-github.ts`)

- **Solves now.** A fake GitHub that speaks GitHub's REST calls, its device-flow sign-in and real git stands in for GitHub. `test/step13.ts` covers projects, repo requests, sign-in and the stopgap, the git proxy and its branch rule, the label and access rules, the text filters, ETags, a pipeline run from a GitHub issue to a merged pull request, and every token's absence from Postgres, logs and answers. `test/step13b.ts` drives the new pages in three browsers at desktop and phone width. `test/step13c.ts` checks the text filters with no services, each hostile text in a child process that is stopped if it runs past its time.
- **Helps later.** Checks for later GitHub features start from the same fake.

## Verification (`bin/agentsctl`, `ctl/`, `shared/cli/`, `.claude/skills/verify-agents/`)

- **Solves now.** An agent proves a change by running a private Agents and driving it the way a person does. `bin/agentsctl` starts one on its own ports and team against the test database, checks it is usable, drives the web app in Chromium, Firefox and WebKit and the desktop app by role and name, reads the record back, records video and traces, captures views for visual comparison, and stops everything it started while keeping the evidence. The feature map in `.claude/skills/verify-agents/features/` describes twelve features as runnable steps, and `map run` gives each step a verdict. `shared/cli/` is the command-line library it is built on: one output envelope, exit codes, help made from the command definitions, and a conformance check. The evidence manifest and the feature map are the framework's `shared/verification.ts`, described under the coding framework, and agentsctl imports them from there.
- **Helps later.** Pipelines can make and keep the same kind of skill for any repo (`docs/design/verification.md`), and other CLIs, such as agents-git, can share the library and pass the same conformance check.
- **Not done.** The framework's policy still names its own stand-in skill and map, `.claude/skills/verify/`, and an evidence file, `test/ui-shots/evidence.json`, that agentsctl does not write. Its gates do not read this branch's map or manifest yet.

## Live preview of the screens (`bin/agentsctl preview`, `ctl/preview.ts`, `test/step17b.ts`, `test/step17b-breaks.ts`)

- **Solves now.** A person who works on the app's screens runs `bin/agentsctl preview` and opens the address it prints. It starts the checkout's instance if none runs, as `up` does, and serves `app/` from source on Vite's dev server at 127.0.0.1, from port 8200 up. A file saved under `app/src` shows in the open page in well under a second with no build. A file that exports only components keeps the page's state, since React refreshes it in place, and a file that also exports something else, such as `App.tsx` with its `go`, reloads the page.
  - The page is signed in as the instance's owner, or as the person `--as` names. The preview passes `/v1` and a screen's WebSocket to the instance's people door, sets `Tailscale-User-Login` on each request, and drops any identity header the caller sent, as tailscale serve does.
  - Everything the preview passes is signed in, so it refuses a request from any other origin, and a WebSocket with none. It gives the API the people door's own origin for a WebSocket, which the instance accepts. Vite's CORS answers are off, and its check of the Host header stays on.
  - The page's Content-Security-Policy keeps the app's rules and adds a nonce, made for each run, which Vite puts on the inline script and styles it makes.
  - Vite runs in middleware mode on a server of the command's own. Ctrl+C or SIGTERM ends the command with exit 0 and its last result, and the instance stays for `down`. With `--json` the command prints one envelope when the preview is up and one when it stops. Vite's messages go to `preview.log` in the instance's evidence folder.
  - A team with no task gets a sample repo, if it has none, and a task for fixer, from the code `seed repo` and `seed task` use. `--no-seed` skips it, and a forge that is down stops the sample, so the command says to add `--no-seed`.
  - `shared/cli/command.ts` gives each command a `say` function, so a command that keeps running can print as it goes. No other command uses it.
- **How the page differs from the built app.** Its policy carries the nonce, and React runs in development mode. Browsers treat 127.0.0.1 as a secure page and the tailnet's plain HTTP as not, so code that needs a secure page works in the preview and fails over the tailnet. `npm run check:step4b` still catches that. A change to `app/vite.config.ts` takes effect when the preview is started again, because Vite's restart on a config change left a second proxy on the server and stopped it.
- **Helps later.** Whoever works on the screens sees a change in their own browser as they save it, without a build or a login step. `ctl/preview.ts` is the one place that sets who the page is signed in as.
- **The check.** `test/step17b.ts` runs the preview as a person does, on two instances with two previews at a time, and opens it in Chromium, Firefox and WebKit with no login of their own. It checks the page, `/v1/me`, a WebSocket that reaches the API, and a saved component and stylesheet reaching the open page. It also checks what keeps the preview private, how each flag and signal behaves, and what it seeds. It needs a checkout with no instance, since it runs preview with none named. `test/step17b-breaks.ts` breaks one thing at a time, in each of the 20 places a check guards, and watches the named check go red. `--check` confirms each anchor is still there once.
- **Not done.** `test/step17.ts`'s conformance cases leave preview out, since it does not end on its own. The preview starts no pipelines, so an instance it makes has the sample repo and task and nothing else. An instance started with `up --pipelines` is used as it is.

## Terminal sessions

The design, with what is not done and the calls waiting on Tayler, is `docs/design/local-sessions.md`.

### Connected folders (`daemon/folders.ts`, `daemon/kept.ts`, `server/folders.ts`, the `connected_folders` table)

- **Solves now.** A person connects a folder on their Mac once, from the Terminal folders page in the Agents app on the Mac or with `node daemon/folders.ts connect`, and every Claude Code session they start in it, or in a folder inside it, from their own terminal lands in the record. A folder's own choice wins over the folder it is in. Off on a folder inside a connected one keeps its sessions on the Mac, and `daemon/kept.ts` keeps that Off on the Mac, one file per folder in `~/.agents-app/kept`, so the name of a folder never connected never reaches the server. Only the Mac connects or disconnects its folders, with its machine token, so nobody in the app can make another person's sessions leave their Mac. The team sees a folder's sessions, and `--private` keeps them to the person who connected it. Only `--team` widens a private folder again. The command and the app's socket call the same `connectFolder` and `disconnectFolder`.
- **Helps later.** Codex sessions in a connected folder can land through the same rows, with a reader for Codex's transcripts.

### The transcript reader (`daemon/transcripts.ts`, `transcriptBatch` in `daemon/claude.ts`)

- **Solves now.** The daemon reads the transcripts Claude Code writes under `~/.claude/projects` for the sessions that started in a connected folder after it was connected. It posts each prompt, reply, thinking block, tool call and result, with a subagent's work under the Agent call that started it. It scrubs them as it scrubs an app session, adds the values in the folder's `.env` files, and leaves images, files and the results of tool calls on paths outside the folder on the Mac. A session started anywhere else is read only as far as the line that says where it started, and nothing of it leaves the Mac. A restart goes on where the last one stopped.
- **Helps later.** Codex keeps transcripts too, so its terminal sessions need one more reader, not a new path into the record.

### Terminal sessions in the app (`app/src/Terminal.tsx`)

- **Solves now.** The sidebar's From terminals lists recent terminal sessions by folder and whose terminal they ran in, and Running now marks a live one as terminal. Each opens on its own page, `#/l/<session id>`, with every event. Agents' `search_record` finds them like any session the team shares.
- **Helps later.** A teammate's Claude finds a fix made in a terminal, which is where most fixes are made today.

### Connecting folders from the app (`daemon/app-socket.ts`, `desktop/preload.cjs`, `app/src/Folders.tsx`, `shared/socket.ts`, `shared/body.ts`)

- **Solves now.** A person connects a folder from the Agents app on their Mac, with no command to type. The Terminal folders page, `#/folders`, lists the folders Claude Code ran in on that Mac, newest first, each with one control: Off, Team or Just me, showing the choice that decides where its sessions go. Before Team shows the team sessions in the record they can't see now, the daemon refuses it until the person says yes to their count, which the page asks about. The page reaches the Mac's daemon through `desktop/preload.cjs`, which gives it only list, connect and disconnect, only for the server's own page, and one change for each click or key press. The daemon answers on a Unix socket, `~/.agents-app/run/app.sock`, that only that macOS user can open, and connects with the folders command's own functions. It listens with `listenOnSocket` in `shared/socket.ts`, as the API's people socket does, so a second daemon leaves a running one's socket alone, and reads each ask with `shared/body.ts`, the API's body reader. The names of folders that aren't connected go to the app on the Mac and nowhere else. In a browser the page lists the person's connected folders and says to open the Agents app on the Mac to change them.
- **Helps later.** The one signed download starts the daemon from the desktop app, and this page is where its person connects folders there.

### The step 21 check (`test/step21.ts`)

- **Solves now.** It runs the real `claude` CLI with `haiku`, headless, through the real daemon, API and Electric. It connects a folder and runs sessions in it, in a folder inside it, beside it, before it was connected and after it was disconnected, and in a private folder. Then it checks what the record holds and what it doesn't, the scrubbing, the picture that stayed on the Mac, the subagent, what each person sees in the API and in Chromium, a daemon restart, and what the API refuses.
- **Helps later.** A Claude Code release that changes its transcripts fails this check instead of going quiet.

### The step 21b check (`test/step21b.ts`, `test/read-meter.ts`)

- **Solves now.** It writes Claude Code's transcript lines itself, into a temp folder the daemon reads as `CLAUDE_CONFIG_DIR`, and runs the real daemon, folders command, API and Electric on them, with no Claude. It takes about a minute and a half, on ports 8110 to 8113. It holds the review's fixes for terminal sessions, each as a line that went red under a break of what it guards. `test/read-meter.ts` is loaded into the daemon it starts and counts the bytes the daemon reads from each file, the biggest buffer a read was given and the CPU time it used, so the check can say how much a read cost and not only that it landed.
- **Helps later.** A change to how the daemon reads, scrubs, sends or withholds a transcript gets its answer in about a minute and a half, where step 21 takes about three and spends a little of the subscription.

### The step 21c check (`test/step21c.ts`)

- **Solves now.** It connects folders from the app the way a person does. It writes Claude Code's transcripts into a stand-in home folder, runs the real API, daemon and Electric, drives the Electron app's Terminal folders page, and opens the page in Chromium, Firefox and WebKit at desktop and phone width, on ports 8140 to 8144, in about 45 seconds. Its 51 lines cover the socket's modes, the list and its order, Team, Just me and Off with the sessions that land or stay on the Mac, a folder inside a connected one, the question before a private folder's sessions are shown the team and the daemon's own refusal without it, the home folder and root refusals, what the bridge refuses, one change per click, a second daemon, a crashed daemon's socket, every request the daemon and the page sent the server, and a search of every Postgres table and the API's log for the names of folders never connected.
- **Helps later.** When the signed download changes how the daemon starts, this check says whether the page still connects folders and keeps the names of the others on the Mac.

## Worktrees and landing (`daemon/agents-git/`, `test/step22.ts`, `test/fake-gh.ts`, `test/fake-docker.ts`)

- **Solves now.** `agents-git` runs the git side of an agent's work the same way every time, and each rule in `AGENTS.md` that a machine can check is a command that does it or refuses. Run it from inside the repo as `node daemon/agents-git/main.ts <command>`. `docs/design/agents-git.md` has every command, how `check` and `land` run, and which rule each one enforces.
  - `start` makes a task's branch from local `main` and a worktree beside the repo at `~/Projects/agents-worktrees/<name>`, with its own `npm ci`. `list` shows every worktree and where the ledger and git disagree. `adopt` tracks one that exists, such as those under `.claude/worktrees/`. `done` and `prune` preview unless given `--yes`, keep each final commit under `refs/agents-git/<name>/done`, and delete a branch only once main has it. Removing a worktree also deletes its ignored files, such as `.scratch/` and `research/`, with no warning, so `done` lists them in its preview, refuses until `--backup <path>` names each one, and copies them to `~/.agents-app/backups/agents-git/<name>-<time>/` before it removes anything. `prune` skips a worktree that holds one. `node_modules` and `app/dist` are left out, since `npm ci` and the build make them again.
  - `save` keeps a worktree's uncommitted files in a ref without touching them, and `done` takes a worktree with uncommitted files only when the newest save holds them. `sync` rebases the branch onto local `main`, or merges main in once the branch is submitted, since a rebase would rewrite commits GitHub has. It keeps the head it started from under `refs/agents-git/<name>/pre-sync-<time>`.
  - `check` runs named steps under `~/.agents-app/checks/run.lock`, with main's `.env` files, a time limit per step and per docker build, a log for each, and the counts in the ledger. It lets go of the lock however it ends, including a signal, which stops the step and lets the command clean up first. It reads the commit and files again once it holds the lock, refuses to tag `agents-box:latest`, and prunes images after a build.
  - `submit` runs the coding framework's static gates and main's name guard on every commit it would publish and on the pull request's text, scans each for secrets and personal details, copies the commits onto GitHub's history with the no-reply email, pushes them without force and opens the pull request. `land` runs every landing gate, scans the merge message, merges in a throwaway worktree, runs the full suite there, and only then fast-forwards `main` and mirrors it to GitHub, after scanning every commit GitHub lacks. A protected-path approval counts only for the content it covered.
  - The ledger is `~/.agents-app/worktrees.json`, read and written under a lock, parsed with zod, and replaced whole through a rename at mode 0600. Every git call is `execFile` with an argument list and a time limit, with hooks and password prompts off.
  - Files: `main.ts` reads the command line, `repo.ts` holds what the commands share, `git.ts` runs git, `ledger.ts` keeps the ledger and its lock, `worktrees.ts` has `start`, `list`, `adopt`, `done` and `prune`, `work.ts` has `save` and `sync`, `checks.ts` has `check` and the run lock, `group.ts` runs each program in a process group and stops it on a signal, `docker.ts` is the docker the steps see, `github.ts` has `submit` and the copy onto GitHub's history, and `land.ts` has `land`.
- **Helps later.** Each task gets a fresh worktree outside the repo, so lint and Node's module lookup stop reaching into agents' copies, and nothing installs through a link to main's packages. Landing stops being steps a person remembers. Once Tayler approves the hooks, raw `git push`, `git worktree` and `git merge` send agents here too.
- **The check.** `test/step22.ts` builds a repo in a temp folder with a copy of this repo's policy, name guard and suite runner, and drives every command against it. `AGENTS_GIT_LEDGER` points the ledger, the run lock and the logs into that folder. Only the check sets it, and it is the one seam, at a real boundary, the file the ledger lives in. GitHub is a bare repo there, and `test/fake-gh.ts` and `test/fake-docker.ts` stand in for `gh` and `docker`, first on the PATH, so nothing reaches GitHub or the Mac's Docker. `npm ci` is not stubbed. It installs offline from a tarball committed in the temp repo.
- **Where it lives.** In `daemon/`, the part that runs on the Mac, because the compiler and lint cover only the folders `tsconfig.json` lists, and changing that file, `eslint.config.js` or `ops/` needs Tayler's approval.
- **Not built yet.** Its own ports and test database for each worktree, env file setup, and the Claude Code hooks, which need changes under `.claude/`.

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

- **Solves now.** `AGENTS_MACHINE_HOST` lists the IP addresses the machine port listens on, checked when the API starts, so the server on AWS can answer boxes on its VPC address and teammates' daemons on the tailnet. People still arrive only on the API's socket. The machine port refuses any Tailscale identity header, not only the login.
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

- **Solves now.** A box is an agent's computer, so its browser and tools reach the public internet over any protocol, and look names up at public resolvers. Inside, it reaches only the server's machine port. The firewall drops what a box sends to the box host at any of its addresses, loopback included, the VPC, RDS, the metadata endpoint, the tailnet, other boxes, every private range, multicast and the reserved ranges, and Docker cannot start without it.
- **Helps later.** What boxes may not reach is one list, `BOX_CLOSED_RANGES`, and one update.

### Secrets on AWS (`ops/aws/secrets.ts`, `ops/aws/fetch-secrets.ts`)

- **Solves now.** Secrets go from this Mac to SSM without touching a command line or the screen, and the server writes them to files with mode 600 at every boot. The database password is generated by RDS and never leaves AWS.
- **Helps later.** A new secret is a name in `SECRET_PARAMETERS`.

### Backups, restore and health (`ops/aws/backup.ts`, `ops/aws/restore.ts`, `ops/aws/health.ts`)

- **Solves now.** Every night the database and the forge go to S3, kept 35 days, beside RDS's own 7 days, staged on disk under `/var/tmp` after a check that they fit, and uploaded in parts, so a file can pass S3's 5 GiB limit for one upload. A restore says when its backup was taken, and changes nothing while the database holds teams, unless `--replace` names it, while anything is connected or a box runs, or when the backup will not fit. It removes the restored boxes' stopped containers, whose tokens the restored database does not know, so the runner starts each box with a new one. Every minute each host reports what the alarms watch, including whether the API answers and how old the last backup is.
- **Helps later.** The restore is also how a rollback to this Mac works.
- **Not done.** The nightly backup leaves out the boxes' home folders, so losing the box host's disk loses them, and a rollback leaves what boxes did on AWS behind.

### Cutover, updates and teardown (`ops/aws/export.ts`, `ops/aws/update.ts`, `ops/aws/down.ts`)

- **Solves now.** One command moves this Mac's data, every box's home folder and the secrets to AWS at cutover, and refuses while the API or a box is running. The restore puts each box's home back on the box host, so a task resumes in its workspace with the same Claude session. One command on each host moves it to the last deployed commit. One command takes everything down, keeping a final snapshot and the backups unless told otherwise, and naming any backup object S3 will not delete.

### The AWS checks (`test/step11.ts` to `test/step11g.ts`, `test/netlab.ts`, `test/fake-aws.ts`)

- **Solves now.** They cover the machine port's address, boxes on a real `ssh://` Docker host, what a box can reach through the firewall, and through the one in colima's VM on this Mac, the synthesized template, the host scripts against a fake AWS that speaks the real protocols, and a rehearsal of the move on this Mac in which a task resumes on a box restored from the export. None of them needs an AWS account.

## One door for turns

The design is "A scheduler places every turn" in `docs/design/target-architecture.md`, step 1 of its build order.

### The scheduler (`server/scheduler.ts`, `shared/turns.ts`, `0014_door.sql`)

- **Solves now.** Every turn an agent is asked to take is a row in `turns`: a person's message in a DM or a room, a person's message to a task, a routine's firing, and a pipeline's stage, its reminder to report and a coach replay. Each says who asked and what for, and carries the session, the prompt's event and the payload the engine is handed. `requestTurn` is the one way in, and `server/scheduler.ts` is the only file that writes a message, stop or interrupt command, through `requestTurn` and `signalSession`. For a Mac it writes one at once, since a Mac's daemon takes commands whenever it comes. For a box it writes one once the box is online and its daemon has reported in, which is once its desktop is up. Until then the box's turn waits, with `computer_starting` for a box a person or a run holds, which the runner starts, and `machine_offline` for a box nobody holds. The runner's loop places waiting turns as their boxes report in, and marks a running turn stuck when its session has had no new event for `AGENTS_TURN_STUCK_MIN`, 10 minutes by default. A placed turn runs and ends with its message command, in the same statement that moves the command. A room still gives one agent its go at a time, and a turn whose deadline passes while it waits is cancelled. A box marked asleep takes no work, and the mark and the placing of a turn lock the box's row against each other, so a turn asked for while a box is going to sleep waits and wakes it. `signalSession` cancels a session's waiting turns before it writes a stop or an interrupt, for the runner, the replays, a room's deadline and the interrupt route. A person cancels a turn that waits with `POST /v1/turns/<id>/cancel`, and a room's turn is left to its deadline. Turns placed together keep the order they were asked in, a session waiting for a person's answer is not marked stuck, and one waiting turn that cannot be read fails alone, with its session told why, and does not hold up the rest. A governed stage whose machine went silent fails with its message, which ends with its turn through `moveMessages` or, for a message no machine took, `failUntakenMessage`, and with its waiting turn cancelled.
- **Helps later.** Seats, budgets, job computers and agent chains decide where and when a turn runs in one place, before any machine gets it. `whereTurnsRun` is the one choice of place, so a place on the server can be added there (decision 1). The stuck mark is what a notification to the asker will read.
- **Not done.** The design says a turn waits while its Mac is offline, and no turn does. A turn for a Mac sits in its queue, as before the door, so a conversation shows nothing while the Mac is off, and step2, step12 and step20a, which read a Mac's queue while it never reports in, pass as they were. Whether a turn for a Mac should wait is Tayler's call. What happens to a turn requested in the seconds while a box is being stopped to sleep is not checked.

### The waiting line (`app/src/TurnWaits.tsx`)

- **Solves now.** While a turn in a conversation or a task waits, the page shows the agent's name and why, such as "Starting Alice's computer" or "Waiting for box-pool-1, which is offline", with Docker's words when the box could not start, and a Cancel button for a turn that is not a room's. A running turn marked stuck shows when it was last heard from. The line goes once the turn has its machine, and the reply comes in its place. `turnLine` in `shared/turns.ts` says the words, so the app and step23 read one function. It reads a shape of only those turns, with no prompt in it, every 2 seconds, and holds no connection open.
- **Helps later.** Waiting for a seat, a budget or a plan's limit are more reasons on the same line.

### The step 23 check (`test/step23.ts`)

- **Solves now.** It builds a box image under its own tag and gives a person their own box as a real container. A DM sent while the new box first starts waits, then the box answers. A routine's firing is kept as a turn. The box goes to sleep with nothing to do, a DM wakes it while its conversation reads that the computer is starting, and the check times the start and the reply. A DM to an agent on a box nobody holds waits, and the conversation reads that the box is offline. A DM to an agent on a Mac that is offline goes to the Mac's queue at once, and the Mac answers when its daemon starts. A hung turn is marked stuck and an event clears the mark. It reads the line the app shows for each of these from the rows a page reads. It also fails if any source file but the scheduler writes a message, stop or interrupt command, or any but durability changes a message's status, which `test/commands-scan.ts` reads from the code. It uses port 7701, so it runs under the run lock, and ports 8130 and 8131, which no other check uses.
- **Helps later.** Each later step that places turns, such as seats, adds its own reasons to wait here.

### The step 23c check (`test/step23c.ts`)

- **Solves now.** It calls the scheduler, the box sleeper, the interrupt route's function and the governed stage's lost-machine check against the test database, with no machine and no port, so it needs no run lock. It marks a box asleep and asks for a turn, holds a request open across the mark and the mark open across a request, and expects the turn to wait and wake the box and the box not to be put to sleep under a turn on its way to it. It checks the order of turns placed together, that a session waiting for a person is not marked stuck, that one unreadable turn fails alone, that a stop, an interrupt and a person's cancel cancel a waiting turn and that a turn its machine has is left alone, and that a stage whose machine went silent fails with its message, its turn and its waiting turn.
- **Helps later.** The next place a turn can be held, such as a budget, gets its edges checked here without a box.

### The step 23b check (`test/step23b.ts`)

- **Solves now.** It drives the conversation and task views in Chromium, Firefox and WebKit at desktop and phone width against a real API and runner, with a person's box that cannot start because its image does not exist. It expects "Starting your computer" with Docker's words and a Cancel button, the name of a box nobody holds that is offline, a teammate's view naming whose computer is starting, the same line on a task's page, and a quiet turn saying since when. Cancelling takes the line away and cancels the turn. It scans for accessibility problems, checks the phone fit and keeps screenshots in `test/ui-shots`. It uses ports 8150 to 8151 and 8250, so it needs no run lock.
- **Not done.** WebKit logs three Content Security Policy console errors on the task page, with or without a waiting line, which agentsctl's visual shot reports and which this check does not fail on, since it records page errors only.
