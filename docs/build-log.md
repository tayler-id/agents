# Build log

Tayler asked on 2026-10-11 for the whole project to be built and working, with no questions until it is done. This log records each step, the decisions I made on my own, and what verified each one. Decisions you might want to revisit are marked **Revisit**.

## Scope

From `docs/intent/multiplayer.md` and `docs/build-plan.md`. In scope:

1. Phase 1, the shared record: sync and the access proxy, live tokens, the desktop app, and the team-record tools agents use to find each other's work.
2. Phase 2, the factory: tasks, workspaces and artifacts, pipelines as code, a local git forge for issues and pull requests, boxes, and the bug-fix pipeline.
3. Phase 3, refinement: past runs as test sets, scored proposals, approval.
4. The app's remaining core: rooms, agent memory, skills, plugins, routines, templates, and comments on artifacts.

Out of scope, per the intent: separate customer orgs, a phone app, pipeline changes applied without approval, voice, meetings, Slack and email.

## Rules I am holding myself to

- Every step ends in a check that I watch fail before I trust it.
- Nothing is called done until the whole suite passes (`npm run check`, every step's check, not only the newest), and the real running system has been tried: the background API, a real daemon, and the app.
- Nothing goes to an outside service. Issues, pull requests and webhooks use a local git forge in Docker, so the factory can be proven end to end without touching your GitHub.
- No commits. Everything stays in the working tree for you to review. Tayler allowed commits and branches on 2026-10-13.
- The UI is tested every way available: Playwright headless end to end in Chromium, WebKit and Firefox with two teammates at once, the real Electron app through Playwright, screenshots in light and dark at wide and phone widths that I look at against your design rules, an accessibility scan, and the real path in Chrome against the real server.

## Steps

(Filled in as each step lands.)

### Step 1 again: the agreed data model (done)

- 34 tables from `server/migrations/0001_data_model.sql`. The API applies new migrations when it starts.
- A person DMs an agent. The post, the agent's user event and the machine's command are written in one transaction by `server/record.ts`. When the agent's turn ends, its last words become its post.
- Verified by `npm run check:step1` (17 checks, real Claude session). Four deliberate breaks turned every check red except the turn-order check.
- **Revisit.** Session cost is not totaled yet. The `usage` events hold the numbers.

### Step 2: sync and the access proxy (done)

- Electric 1.8.1 runs in Docker beside Postgres, reachable only from the server and only with its secret.
- `server/sync.ts` serves named shapes at `/v1/shape/<name>`. The server sets the table and filter from who is asking. People see their team, minus private conversations and tasks they are not part of. Token hashes are never synced.
- The daemon now hears about its commands through a shape, claims each one with an atomic call, and requeues unfinished claims when it starts.
- Verified by `npm run check:step2` (13 checks): live delivery, team isolation, a conversation leaving a teammate's view the moment it turns private, resume after a disconnect with nothing lost or repeated, and machine queues. Three breaks turned every check red. Over the tailnet, a forged identity header is replaced with the real login and a bad token is refused.

### Step 3: live tokens (done)

- `@durable-streams/server` runs inside the API process on loopback, with file-backed storage in `~/.agents-app/streams`. The API proxies `/v1/streams/sessions/<id>`: a machine may write its own sessions' streams, and a person may only read streams of sessions they can see.
- The daemon runs Claude with `--include-partial-messages` and appends each text and thinking chunk to the session's stream through an idempotent producer, so a retry never duplicates tokens. Tokens never touch Postgres.
- Secrets in live text: each block is scrubbed as a whole, and the last 160 characters (or the longest known secret plus 16) are held back until more text follows or the block ends. An unfinished private key is held back entirely.
- Verified by `npm run check:step3` (8 checks, real Claude session): a secret split across chunks never leaves the scrubber, two viewers see identical token sequences, the tokens add up to the finished message, tokens reach a viewer before the finished message reaches Postgres, a quoted secret reaches viewers only as `[secret:AGENTS_TEST_SECRET]`, and other teams and people cannot read or write the stream. Four breaks turned every check red. One check was weak at first and was tightened after a break exposed it.
- **Revisit.** The Node stream server is the protocol's reference implementation. The protocol also has a Caddy server plugin built for production. It is enough for one team on a Mac. Live text trails the agent by about 160 characters because of the hold-back.

### Step 4: approvals, interrupt, the app and the desktop app (done)

- **Asks.** The daemon runs Claude with `--permission-prompt-tool stdio`. A gated tool becomes an `ask` event and an open row in `asks`, and the session shows `needs_approval`. Allow, deny, always and never are answered through the API and reach Claude as a control response. Always and never become `approval_rules`, which answer matching asks at once (for Bash, commands that start with the same word).
- **Interrupt.** A control request stops the turn mid-stream. The session goes back to idle.
- **The app** (`app/`, React, built by Vite, served by the API at `/`). Sidebar of agents, conversations, what is running now and machines. The conversation shows posts, the agent's live typing, its current tool call, ask cards, a composer and Interrupt. A session panel shows every event live.
- **The desktop app** (`desktop/main.cjs`, Electron). It opens the server's tailnet address. On this Mac it goes through Tailscale's local proxy, configured in `~/.agents-app/app.json`.
- **Your setup.** Team "Tayler's team" with Tayler's Tailscale login, your Mac as instance `tayler-mac`, and one agent, `assistant`, whose home is your Mac and which uses Claude Code's default model. The daemon runs under launchd as `com.agents.daemon`.
- **Bugs the real path and the full suite found, all fixed and now guarded by a check:**
  1. Browsers allow six HTTP/1.1 connections per server, and the app held about ten live ones, so the token stream never connected. Only five things are live now, and rarely changing lists refresh every five seconds.
  2. Electric marks catch-up responses cacheable for a CDN, and browsers kept serving stale copies. The proxy marks every non-live response `no-store`.
  3. `crypto.randomUUID` does not exist on plain HTTP pages, which is how the tailnet serves the app, so sending failed only on the real path. The app makes its own ids, and the UI check now runs Chromium and Firefox on an insecure origin.
  4. A daemon that started before the API crashed. It now waits.
- **Verified by:**
  - `check:step4a`: 10 checks, real Claude, covering allow, deny, always and the rule, interrupt, and outsiders.
  - `check:step4b`: 15 checks in each of Chromium, WebKit and Firefox. It covers two teammates at once, live typing, ask cards, interrupt and the session panel, plus an accessibility scan, phone width and page errors. Screenshots are in `test/ui-shots/` and I reviewed them against the design rules.
  - `check:step4c`: the Electron app.
  - `check:step4d`: daemon resilience.
  - `test/real.ts`: the desktop app over Tailscale against your real agent.
  - Every check was seen failing under a break. Several checks were weak and were tightened after a break passed them.
- **Revisit:**
  - Turning on HTTPS for the tailnet (one switch in the Tailscale admin console, DNS page) gives browsers HTTP/2, which removes the connection limit and the insecure-page limits. Then `tailscale serve --https=443` instead of `--http=80`.
  - Agent replies show raw markdown.
  - The names "Tayler's team" and "assistant" were my choice. Rename them with SQL or ask me.

### Step 5: shared context, success test part 1 (done)

- **Team-record tools.** Every agent session gets an MCP server, `daemon/record-mcp.ts`, with `search_record`, `read_session` and `recent_activity`. They read through the API as the session they serve, under the same visibility rules as people. Work shared with the team is readable, plus the agent's own conversation. Private work stays out, and a machine can only search as its own sessions. A standing instruction tells every agent to search the record before starting on a problem and to credit what it uses.
- **Agents are isolated from the host's own Claude setup.** The step 5 check exposed it. On your Mac, agent sessions picked up your personal hooks, skills and MCP servers (a personal SessionStart hook pushed a team agent into a personal coding skill). Agents now run with `--setting-sources project,local --strict-mcp-config`, so they behave the same on every machine. They keep your subscription login and get only the tools they are given.
- **Verified by `npm run check:step5`.** It uses real Claude on two machines with two people. Alice's agent fixes a bug on machine A. Amir's agent, on machine B and told nothing, searches the record before changing anything, finds Alice's session, fixes its own copy and says it built on the teammate's fix. A private conversation never shows up in the search, and a machine cannot search as another machine's session. Three breaks turned every check red. Also tried on the real system: your assistant used `recent_activity` and answered.
- **Success test so far.** Part 1 (a teammate's agent finds my fix on its own) passes in `check:step5`. Part 2 (open their session live) passes in `check:step4b`, where a teammate watches the conversation update live and opens the session panel.
- **Revisit.** Isolation means agents on your Mac no longer see your personal MCP servers (Gmail, Drive and so on). Agents should get them as their own plugins, which is phase 4.

### Phase 2 groundwork: boxes cannot pose as people (done)

- **The hole.** Containers under colima can reach every port on this Mac's loopback. A container that sent `Tailscale-User-Login: <your login>` to the API got in as you. It could also have read any session's live stream on the stream server's port. I confirmed both from a container.
- **The fix, in two parts:**
  - **Two listeners.** People use port 7710, which only tailscale serve points at. Machines use port 7700 with their tokens, and that port refuses any person's identity outright.
  - **A firewall.** `ops/box-firewall.sh` runs in the colima VM. Containers may reach this Mac only on 7700. It is in colima's provision steps, so it runs at every start. I restarted colima to confirm.
- **Verified by:**
  - `check:step2` (new check: the machine port refuses a person's identity, seen failing).
  - `check:step2b`: from a real container, 7700 is reachable, while the people port, the stream server and Electric are not. It went red with the firewall rule removed. It also caught a rule-ordering bug in my own restore, which is fixed and rechecked.
- `tailscale serve` now points at 7710. Over the tailnet you are still you.

### Phase 2: the factory (done)

- **Forge.** A local Gitea (`compose.yaml`, `ops/forge-setup.ts`) holds the team's repos, issues and pull requests, so nothing goes to your GitHub. `server/forge.ts` is the only file that talks to it. Machines clone and push through the API's git proxy with their instance tokens, and the forge's tokens stay on the server.
- **Pipelines as code.** Files in the `team/pipelines` repo. A version is git's blob id for the file. A broken version is recorded with its error and never becomes current. The runner (`server/runner.ts`) keeps every run's state in Postgres, one row per try at a stage, so an API restart loses nothing. Agent stages end with a `report_result` tool call read from the record, with one reminder for an agent that forgets. Checks are commands whose exit code decides, so the runner itself confirms the reproduction fails before the fix and passes after. Loops have caps, then a person decides. Runs stop at the pipeline's spend cap. Webhooks (Gitea's, and each pipeline's own, signed) and cron start runs, and a repeated delivery starts one run.
- **The bug-fix pipeline** (`pipelines/bug-fix.ts`): triage with duplicate and already-fixed checks, a failing test, fix or plan, verify, pull request, the shepherd's gate, merge.
- **Boxes** (`box/Dockerfile`, `server/boxes.ts`): claimed per run up to a limit, released after, stopped when idle, restarted with their home volume, and recreated from the image. Containers start only after their claim commits.
- **Decisions I made, to revisit:**
  - **pg-boss is not used.** The plan named it for the job queue. The runner turned out to need only rows and a row lock per run, plus a Postgres notification to wake up, so it has no queue to manage.
  - **The forge is Gitea, not GitHub.** GitHub's API has the same shape for the calls `server/forge.ts` makes, so moving is one file.
  - **The schema additions** are listed in `docs/data-model.md` under "Added while building", for you to review.
  - **Agents in boxes need a Claude token.** Run `claude setup-token` and save the token in `~/.agents-app/box-claude-token`. Until then a run on a box stops at once and says so.
- **Verified by:**
  - `check:step6`: 28 checks, the factory with the stand-in for Claude (`test/fake-claude.ts`). It covers every stage kind, the real forge and git proxy, webhooks, cron, caps, cancelling, broken versions and an API restart mid-run. Nine break sets turned each check red.
  - `check:step6b`: 21 checks in each of three browsers, covering the pipeline and run views, the gate, documents, the room and boxes. One of them counts open live connections. That one found and now guards a real bug: Electric's React hook never closes a stream, so the app stopped updating after a few page visits.
  - `check:step7`: 13 checks with real Docker containers.
  - `check:step8`: the bug-fix pipeline with real Claude, from an issue filed on the forge through Gitea's own webhook to a merged fix that works.

### Phase 3: refinement (done)

- **Replays** run a past run's report again from the commit it started at, with a given pipeline version. They never touch the forge or wait on a person.
- **The improve pipeline** (`pipelines/improve.ts`): an agent studies a pipeline's runs with the `pipeline_history` tool and changes its file once. The change is scored on replays against the current version, compared on runs finished, then reminders and hand-offs, then stages run, then cost. Only a better change becomes a pull request with both scores and reaches the shepherd. Merging it makes it current.
- **The coach pipeline** (`pipelines/coach.ts`): corrections people keep making become proposed instructions with a diff, which approval applies.
- **Verified by `check:step9`:** 15 checks. Past runs that each needed a reminder lead to a proposal whose replays show none. A change that scores no better reaches no one, and a broken change is caught before scoring.

### Phase 4: the rest of the app (done)

- Rooms where agents take turns, PASS, @mentions and deadlines. Agents' skills (written as Claude Code skill files), plugins (MCP servers whose secrets stay on the machine), memory (`update_memory`), routines on cron or run by hand, and templates. Tasks people start from the app or a post, which report back. Comments on documents, which reach the agent that wrote them. Markdown rendering for agent replies and documents.
- **Verified by `check:step10`** (25 checks, including the team-record tools called through a real MCP client) and `check:step10b` (the views in three browsers).

### Coding standards (done)

- You asked for real standards that avoid known footguns, kept as a skill. They are in `.claude/skills/coding-standards/SKILL.md`. Each rule names the bug it prevents, whether we hit it here or the tool makers document it, and what enforces it.
- **Enforced** by strict compiler flags (`noUncheckedIndexedAccess` and three more) and type-aware lint (typescript-eslint's strict rules, React's hook rules). `npm run check` runs both before any check. `test/step0.ts` writes code that breaks each enforced rule and fails if anything gets through. Weakening the config turns it red.
- **What applying them found:** 279 places that read a query's first row without checking it, now `one`, `maybe` or `many` from `server/db.ts`. 32 async click handlers that would lose their errors, now `act()`, which shows them. 41 buttons without a type. And real bugs where an agent's reported value could become `[object Object]`, including in the bug-fix pipeline's check command.

### Driving every view end to end (done)

The room and task views had never passed in a browser. Getting them to pass against a real API and daemon found five bugs that the server-side checks missed.

- **A new task's session never reached the app.** Electric 1.8.1 never sends a row that moves into a filter ORing two subqueries, and the sessions shape was exactly that, "in a conversation I can see, or in a task I can see". A session created after the app opened arrived late as a partial update with no task, or not at all, so the task page said "Starting…" forever with Send disabled. I proved the cause with a probe against Electric before changing anything, and found that a filter with one subquery works. Sessions are now two shapes, one per kind. The sidebar polls both every 3 seconds, so it holds none of the browser's six connections.
- **An agent that could not start looked busy forever.** The machine refused the session because a plugin's secret was missing, and said why, but the session stayed "starting" and the room waited out the 3-minute turn. Now the session fails with the machine's reason, its room turn ends at once, and the conversation and task pages show the reason under the agent's name.
- **Changing an agent did nothing until the daemon restarted.** A Claude process keeps the instructions, skills and plugins it started with. The next message after a change now restarts the session with the new setup and resumes the same conversation. A session mid-turn finishes first.
- **The coach could only propose instructions, and a skill's name could be a path.** The plan says repeated corrections become instruction or skill edits. The server could already store a skill proposal, but the coach was never asked for one, and `agent_profile` gave it skill names without their text. It now proposes either. A skill's name becomes a folder on each machine, so the server refuses a proposed name that is not lowercase letters, digits and dashes, and the daemon refuses one whatever the server sends.
- **Two checks were weaker than their names.** step10's missing-secret check only looked at the command row, so it passed while a person saw an agent thinking forever. It now checks the session's status and the reason it gives. And step10b's room rules never matched the agents' names, so the room part could not have passed.
- **Verified by:**
  - `check:step2`: a session started after the view opened arrives whole, for a new room and for a new task.
  - `check:step9`: 17 checks, now with a skill proposal approved and a path for a name refused.
  - `check:step10`: 28 checks, now with a live session restarted by a change to its agent, a failed start giving up its room turn, and the daemon refusing a path for a skill name.
  - `check:step10b`: an agent stops and names the missing secret, the person sets it on the machine and the agent answers, then the room and task flows, in three browsers.
  - Each new check was seen failing under its own break before it was trusted.

### On the real server (done)

- I backed up the real database to `~/.agents-app/backups/` before the API applied migrations 0003 and 0004 to it.
- I added the agents `fixer` and `improver` on `tayler-mac`, which the pipelines need. Their instructions are mine and short. Change them on their agent pages.
- `ops/publish-pipelines.ts --merge` opened and merged pull request #1 on `team/pipelines`. Gitea's webhook made `bug-fix`, `improve` and `coach` current, each at the same blob id as this repo's file.
- `test/real.ts` passed. The desktop app knew you over Tailscale, your assistant answered through your Mac's daemon, and the pipeline, agent and machines pages loaded.
- **The API crashed whenever Postgres restarted.** Restarting colima found it. The runner's LISTEN connection and the connection pool had no error handler, so Postgres dropping them stopped the process, and launchd's restarts crashed twice more while Postgres was still starting. Now a dropped connection is logged and replaced, the runner listens again, and the API waits for Postgres when it starts. A second colima restart caused no crash, and the runner was listening again within seconds.
- The box firewall came back after both colima restarts, each a fresh boot of the VM, and `check:step2b` passed after them.
- **Verified by `check:step2`,** with two new checks: Postgres dropping the API's connections leaves it serving with its runner listening again, and an API started before Postgres waits for it. Each was seen failing with its fix taken out.

### Phone layout and leftovers (done)

- **At phone width the pipeline page was wider than the screen.** The repo picker sized itself to its longest repo name and pushed the page wide, and the versions table, a scroll box on phones, shrank to zero height. A page body now has one column no wider than the screen and rows as tall as their content. On a phone, task messages lost an extra indent, and a comment's Resolve link sits under the comment instead of centered.
- **`check:step6b` left a box container running after every run.** It now removes its box whatever happens, as `check:step7` does. I removed the four left over, along with the test teams and forge repos that failed runs had kept.
- **Live text vanished after a daemon restart.** The daemon wrote each session's live text as the producer `daemon-<session>`. The stream server remembers a producer's last sequence number for a week and silently drops anything at or below it, so a session resumed by a new daemon process showed no typing until it had written more than the old one. Restarting a session after a change to its agent made that common. Each process now writes as its own producer. `check:step3` writes as a replacement process and fails without the fix.
- Not a bug, after all. A screenshot showed Safari with a blank repo picker, and I changed three forms before testing the old code. React already selects the first option, and the blank was the list still loading, so I put the forms back.

### Renamed to Agents (done)

- **The product is Agents.** The folder is `~/Projects/agents`. The app's home is `~/.agents-app`, because `~/.agents` already belongs to another tool. The database, its role and test database, the containers and volumes, the launchd services, the tailnet node (`agents-server`), the forge's admin account, the box image and the env vars (`AGENTS_*`) all carry the new name. Machine tokens now start `machine_`, and this Mac's was reissued. The daemon is `daemon/agentsd.ts`, and the teardown of the app we studied moved to `research/teardown.md`.
- **How.** A script rewrote 53 files with 398 changes. Before writing each file it checked that no old name was left, that JSON still parsed, that TypeScript still transpiled and that shell scripts passed `bash -n`. Its syntax checker was seen failing on a broken file first.
- **The guard.** `test/names.ts` runs first in `npm run check` and fails on the studied app's name, an abbreviation of it, or an agent called anything else. It failed on 270 lines before the rename. It then missed an env var that followed a literal `\n` in the README, since a regex word boundary never falls between `n` and `G`. It now catches that case, and it was seen failing on that line before the fix.
- **The data.** Both databases were dumped to `~/.agents-app/backups/` first. Each volume was copied into a new one, with matching file counts. The role and both databases were renamed inside Postgres, which kept the password and both replication slots, and Electric picked up its 270 shapes. The old volumes stay as a fallback until Tayler says to remove them.
- **Verified.** `npm run check` passed, all 18 checks, and `test/real.ts` passed against the live server under its new tailnet name. bug-fix was republished as pull request #2 because a comment in it changed, and the first pull request was retitled.

### The code review (in progress)

An agent on another model reviewed the code on 2026-10-13. All eight of its findings held. These were fixed on main:

- **A linked `node_modules`.** `.gitignore` said `node_modules/`, which matches only a real folder. In a worktree that links main's packages, git listed the link, the name guard crashed reading it, and `git add -A` would have committed it. The ignore rule now covers the link, and the guard reads only regular files. Seen failing in a scratch clone, with EISDIR on the link and ENOENT on a tracked file moved away.
- **A bare abbreviation.** The guard missed the old name's abbreviation at the end of a path, in the `WORKDIR` of `box/Dockerfile`. It catches it now, seen failing on that line, and the box keeps the daemon in `/opt/agents`.
- **The README.** It skipped `npm run app:build`, so a fresh install answered every page with a 404, and it never said how the box firewall gets into colima. Both steps are in. On a fresh clone with a throwaway Postgres, the API gave a 404 before the build and the app after it. The firewall command prints the same block this Mac's colima runs.
- **A rules file.** `AGENTS.md`, imported by a one-line `CLAUDE.md`. Asked a question only that file answers, Claude answered NONE without it and the exact command with it.
- **Docs that overclaimed.** `docs/decisions.md` now says worktree isolation isn't built, the AWS export misses the boxes' home volumes, and the framework and verifier disagree on the evidence format. The build plan is marked as history.
- **Node on this Mac.** The `node` first on this Mac's PATH, in `/usr/local/bin`, is a launcher that can't load native packages such as lmdb, so the API fails to start under it. The README's PATH rule matters, and `AGENTS.md` repeats it.
- **Verified.** `npm run check` on main passed 17 of 18 checks. step7 failed one assertion, because I ran it on the new box image under a test tag and it expects `agents-box:latest`. With the new image tagged `agents-box:latest`, step7 passed in full. The previous image is kept as `agents-box:pre-review`.

The rest goes to the agents that own the code:
- the AWS export must move the boxes' volumes
- the verifier corrects its claims and owns one evidence format that the framework uses
- the projects branch checks for write access, as Tayler chose
- a new durability workstream makes a turn cut off by a dying machine resume or show as interrupted
- a new security workstream closes the people port to direct tailnet connections

### Shared resources and a leaked token (done)

Running ten agents at once on 2026-10-13 found three problems on main.

- **The test Electric ran out of open files.** Thousands of shapes from every agent's checks hit Docker's default limit of 1,024, and shapes stopped receiving changes. Its limit is now 65,536. `check:step2` passes against it after the restart. The live Electric had no errors and is unchanged.
- **The Mac ran out of System V semaphores.** Every new API died at start with SIGABRT and printed nothing. 87,379 of 87,381 semaphores were held by sets whose processes were gone: 4,910 sets from Postgres servers that another project's test previews started and killed, and 1,007 from our own APIs, which never closed the stream store when stopped. I removed only sets whose every process was dead, which is the test Postgres itself uses, and kept the 58 that running servers held, the Homebrew Postgres and the live API's among them. The API now closes its stream store when stopped, and a new line in `check:step2` failed on the old code.
- **A failed git command could put a machine's token in the record.** The daemon passed the token to git as an argument, and a failed command's message repeats its arguments. The daemon logged and posted that message, the API saved it unscrubbed, and no pattern knew our own token's shape. Git now gets the token through its environment, the scrubber knows machine tokens, and both the daemon and the API scrub a command's error. Two new lines in `check:step2` failed on the old code. The live record had no failed commands, so nothing leaked. The workflow branch's review found it.

### Only serve can name a person (merged, live steps waiting)

- **The hole.** In Tailscale's userspace mode a tailnet device reached every loopback port on this Mac. It could post its own `Tailscale-User-Login` to the people port, read any live stream on 4437, or open the Homebrew Postgres on 5432, which trusts local connections. Only this Mac was on the tailnet, so nobody could use it.
- **The fix,** from the security branch, merged as 564f5da. The API serves people only on a Unix socket, and a tailnet policy allows only ports 80 and 7700. `test/step19.ts` failed on all eight lines against main's code, and the full suite passed after the merge, all 19 checks. Two reviews on a different model came first, and the second found no blocker.
- **Cross-site posts.** Two other reviews found that a page on another site could make a person's browser post a form to the app, signed as that person. A person's change must now be sent as JSON, and the app always says so. The new line in `check:step2` failed on the old code.

### Onboarding, on its own branch (built, not merged)

Tayler asked for "a very easy way to invite and add and have them spin up", and for the tailnet's admin console inside the app. The design, with what is not done, is in `docs/design/onboarding.md`.

- **What works.**
  - An admin invites an email from the Team page, through Tailscale's API when it is connected. The person is on the team from their first visit, with a box of their own.
  - A login nobody invited waits on a screen that names it, and an admin adds it with one click.
  - A Tailscale page lists the tailnet's users, devices and invites, with the actions Tayler uses in Tailscale's console. The API key stays in a file on the server, mode 600.
  - Each person signs in to their own Claude account from the app, through their box, and agents on their box run on that sign-in.
  - Someone in a room, or an admin, adds a teammate to it.
- **Not done.** Inviting waits on the people socket's live steps in `docs/design/people-port.md`, since joining by invite trusts the login header. The real Tailscale API and a full Claude sign-in were never exercised. Removing a person from the team isn't built. Boxes on the real server get the new daemon only after the image is rebuilt and the boxes recreated.
- **Verified.** After rebasing onto main at 47a2d31, with the people socket and the JSON gate, typecheck, lint and the name guard pass. step12 passed 76 checks through the API, step12b 117 in Chromium, WebKit and Firefox at desktop and phone width, and step12c 51 with real box containers in the three browsers. Every commit passed typecheck, lint and the name guard on its own.
- **Seen failing.** 139 breaks, each taking out one thing a check guards. A runner applied each one, ran the check, then put the file back and compared its hash.
  - step12: all 89 went red, two of them by stopping the check early. Four of them, the ones about who is calling, ran again after the move to the people socket and went red again. When step12 was first written, 2 of its first 31 breaks stayed green. With the join lock gone, the three joins it sent still finished one after another, and with the admin gate gone, the check crashed before reaching the line it guards. Both checks were rewritten and went red.
  - step12b, in Chromium: 39 of 43 failed their own check and 2 stopped the run. The last 2 each took out one of the two rules that keep a room's teammate picker on a phone screen. Either rule alone holds, and taking out both went red. Taking out the app's request to join first stayed green, since the waiting screen joined a few seconds later by itself. The check now fails if the invited person ever sees the waiting screen, and went red.
  - step12c, in Chromium: all 7 went red. The token written to a box's stderr was also tried against the check as it was, which read only stdout, and that stayed green.
- **Found on the way.**
  - The API log held a box's machine token, and any team Claude token, whenever `docker run` failed, because the error's message repeats the whole command line. This was on main. A box's start error now keeps only what Docker wrote to stderr, and a break that puts the message back turns step12 red.
  - step12c looked for the token in a box's stdout only, and the daemon writes errors to stderr. It reads both now. A break that logs the token to stderr turns it red.
  - In WebKit and Firefox a box came online before the page loaded, so "is starting" never showed. step12c now relays the boxes' connections to the API through a door it holds shut until the newcomer has seen their box starting.
  - step12 checked only the status of a tailnet invite resend, which a route that never called Tailscale would also pass. It now looks for the call, and goes red with the call taken out.
  - A review on another model found the rest of this list, and each fix has a line that went red first. Reading `/v1/me` joined a login with an invite, and a page on another site can make a browser load it, so joining is now a JSON post. Cancelling an invite waited on Tailscale, so with Tailscale down the invite stayed open. The invite now closes first. An admin could add themselves to a private room. A box could post any https link as the sign-in link. Docker's reason was kept unscrubbed and whole. A second code lost the first. Any login header was taken, and any length of name. An added person got the member role whatever their invite said. The box could read a token from output cut partway through it.
  - step12b's phone check went red on data a failed run left behind: a waiting login with a 200-character name pushed the Team page wider than a phone. List rows now wrap, and step12b makes such a login itself.
  - Main's step6 forwards its people port on 7921, which step12 used too, so step12's moved to 7936.
- **Open.** In about 2 runs of 20, WebKit leaves step12b's Invite button disabled after the email is typed, and the field reads empty while focused. The cause is not known. The check prints the field, the button and the focus when it happens.

### The work layer (on its branch, not merged)

Built on `worktree-agent-a2fc50836aafd8b34`, from Tayler's README task on 2026-10-13, which showed no changes, no diff, no way to open a pull request, and an approval for every write. The design and its "Not done" list are in `docs/design/workflow.md`.

- **What is built.** Draft tasks. The order of work: tasks that wait on others, holds with a kind, reason and end date, priority, done, and the Ready and Held lists that agents also read through `ready_tasks`. Tasks over several repos. Changes against the base for every repo, worked out and scrubbed on the machine. A side panel for files and documents with rendered markdown, highlighted code and a Diff tab. Pull requests from a task. Task sessions that write in their workspace without asking. The research, plan and implement pipeline. Comments pinned to their quote. The command palette.
- **Schema.** Migration 0007 adds `file_changes`, `pushes`, `task_blocks`, `task_holds`, `tasks.priority` and `tasks.done_at`. The order-of-work part was added to it after the file had run on `agents_test`, so I checked the whole file applies in a transaction I rolled back, then applied the new part there by hand. The coordinator renumbers it at merge.
- **Verified.** `test/step14.ts` drives the API, daemon, forge and runner with the stand-in for Claude, including the new pipeline end to end. `test/step14b.ts` is the README task in Chromium, Firefox and WebKit at desktop and phone width. `test/step14c.ts` covers the other views the same way. I broke each thing a check guards, watched the check fail, restored the file from git, and watched it pass. step14 and step14b were seen failing 27 ways, listed in their commit messages. step14c was seen failing in ten Chromium runs with 44 breaks between them. Two of those breaks changed nothing a person could see, so I replaced them with ones that did.
- **Bugs found.**
  - The daemon could claim a task's first message before its workspace's setup and fail it. A message now waits for the setup, whichever command is claimed first.
  - A task's pull request vanished from its page once nothing differed from the base, because the pull requests sat inside Changes. They now always show, and step14c failed before the fix.
  - Two step14c checks passed with their feature broken. The priority check saw an earlier "Saved." from the hold, and the palette's action check passed through the r shortcut when keys reached the page before the palette had focus. Both now check what a person sees.
  - step14c pressed Cmd+K before the app had seen the palette's close event, so the palette closed again instead of opening. The check now waits for the palette to leave the page. The app was not changed, since a person can't press keys that fast.
  - A screenshot showed step14c's draft phone test measuring the task page before the draft's session had loaded. The test now waits for the draft's form. The glitch itself, a draft showing for a moment as a started task, is not fixed.
  - With that wait in place, a WebKit phone page opened at / and then sent to a draft's hash stayed on the home view. `useRoute` in `app/src/App.tsx` reads the hash when the app first draws and starts listening for changes in an effect that runs after, so a change in between is likely lost. That is a reading of the code, not proven, and the code is main's, so I left it. step14c now opens each page at its own address.
- **Not tried.** The live system. Agents on branches stay off it, so the README task has not been rerun on the real server, and the pipeline has not run with real Claude or on a box. The full suite runs when the coordinator merges.
- **Revisit.** Anyone who can see a draft can start it. A pull request's state is not read back from the forge. Changes are the current state only. Single-key shortcuts are on by default. A hold's end date lapses by the database's date, which is UTC.

### The review's fixes (on its branch, not merged)

An agent on a different model reviewed the work layer on 2026-10-13 and asked for these before it merges. I first rebased onto main's aad82a8, which keeps the machine token out of failed commands' errors. Each fix has a check that failed before it.

- **The machine token stays out of the record.** step14 fails a clone and a push, then looks for `machine_` in the task's commands, transcript and pushes. With aad82a8 undone and this branch's push error scrub removed, the token showed in all three. With both in place it shows in none. A pull request's title, description and failure reason are scrubbed too.
- **Box sessions ask before commands.** This branch had let a box's task sessions run commands without asking, which takes away a person's approval of each command. They ask as on a Mac again, and whether boxes may skip that is Tayler's call.
- **A message waits for its workspace only while the server says it is being set up.** It had waited forever for a workspace gone from disk, with an interrupt stuck behind it. step14 restarts its daemon, deletes the folder and sends both. Before the fix the message stayed claimed.
- **Pushes take a lease.** `--force` would have overwritten a commit someone added on the forge. `--force-with-lease`, against the commit this workspace last pushed, refuses instead. A push stuck for 15 minutes expires when someone asks again.
- **The pull request form** drops the title and description once a pull request is open, since an open one keeps its own, and the description no longer starts as the task's first message.
- **Drafts.** Starting from an untouched form keeps a teammate's edit, and a save from a form loaded before that edit is refused.
- **The changes scan.** The daemon counts a repo's changed files before staging and stops past 20,000. A file with a NUL byte is listed as binary. One repo git cannot read keeps its last list and no longer drops the others. Scans run two at a time, which no check covers. Migration 0007 grew `unlisted_changes`, applied by hand to `agents_test` after a rolled-back trial of its checks.
- **Found in screenshots.** The sidebar cut "draft" to "dr" beside a long title, and a new hold showed as lapsed for a few seconds. Each fix has a step14c check that failed in Chromium first.
- **Checks.** Main's step 10 checks put their people port at 7961 and 7971, inside this branch's range, and a teammate's run of one stopped a step14 run, so step14 now starts at 7962 and step14c at 7973. A step14 lookup could pick a stage row with no session, and once failed with the run behaving as it should. After the rebase onto main's 564f5da, each step 14 check serves its API's people socket with `servePeople`.
- **Breaking the rest of step14.** Five break runs covered what no recorded break did, 24 breaks in all, and each turned its own check red:
  - a draft edit that kept the session's agent, a discard that kept the task, a second start told something else, and an edit without an agent let through
  - a changed file listed as added, a deleted file's diff without its header, a binary file stored as too large, a file taken back out that kept its row, a new file's diff without its header, and the list carrying contents
  - another team's machine let in, and another team reading a draft's repos
  - the first message naming one repo, and twin repos in one folder
  - commits in someone else's name, and a teammate shown no pushes
  - held work left out, every team's tasks in everyone's answer, lifting a hold and removing an edge always saying they changed something, and reopening that left the task done
  - no count before staging, a repo listed again keeping its unlisted row, and one repo's failure failing the scan
- **Never seen failing.** These step14 checks have had no break: the pipeline file exists, a draft has a session in the draft status and nothing else, a teammate sees the draft, another team cannot edit it, starting gives the session a workspace and sends the first message, the two-repo workspace is set up, the Changes list has each file the agent wrote, a pull request opens for each repo with changes, a task with no changes opens none, a hold is set once with a one-line reason, marking the blocker done frees its dependent, and five of the pipeline's checks: it loads, the plan reaches its gate, the implementation reaches its review, the run goes through each phase, and the change is merged.
- **Main's checks on this branch.** step3, 4a to 4d, 6 and 6b passed on a frozen copy of the branch. step7 was cut short when this session hit its usage limit, and left the shared check lock held from 18:41 for about two hours. I removed the lock, then the run's box container and volume, its team and its two forge repos. After the rebase onto 47a2d31, a fresh frozen copy passed step3, 4a to 4d, 6, 6b, 9 and 9b. step7 failed at its first box stage, whose session exited at once. The frozen copy sat in the scratch folder under /private/tmp, and step7 mounts the stand-in for Claude into the box from the folder it runs in, which colima can see only under the home folder, so the box had no stand-in to start. That is my reading, not yet proven. Both step7 runs also built agents-box:latest from this branch, the tag the live server starts boxes from. The coordinator restored it, and step7 now runs only under the branch's own tag. A rerun under the branch's own tag, to read the box's log, could not reach the database. By 21:45 Docker's VM had no space left, and its Postgres kept failing to start. Once the coordinator had freed the disk, step7 ran from this branch's worktree, which sits under home, under the tag agents-box:flow-check, and passed 12 of its 13 checks. The one that failed compares the box's image with agents-box:latest, which a run under another tag cannot pass. The checks after it show the box came online and the first run held it. I removed the tag, then the run's team step7-12c287dd, its forge repos and its check folder. The pass from under home fits my reading of the failure from /private/tmp, but Docker's disk changed between the two runs as well.
- **Rebased onto the onboarding merge, then onto 94cd4b1.** Main took onboarding as 360c16e after the rebase above, and eight files had changed on both sides. Each kept both: main's Team, Your box and Tailscale pages beside this branch's file panel in the app's routes, both sets of imports, and both sections of each doc. Main had moved the request helpers into `server/http.ts`, so this branch's copies went. Onboarding had built the same sidebar column rule and the same parsed-snapshot helper as this branch, so the branch now uses main's of each. On that rebase main's step2, 3, 4a to 4d, 6, 6b, 9, 9b, 10, 10b, 12, 12b, 12c and 19 passed. step9b failed first because another check held its people port, 7981, and passed when run again. step12c names its image tag in its source, so it ran under agents-box:flow-onboard-check and the file went back byte for byte afterwards. step7 as it stood at 360c16e failed 7 of its checks here. Main then fixed step7 to build its own image and mount the stand-in's sign-in helper, and changed nothing else but `docs/decisions.md` up to 94cd4b1, the base now. On 94cd4b1 typecheck, lint and the name guard pass, step7 passed all 14 checks, step14 all 69, step14c all 132 in three browsers and step14b all 42.
- **Not done.** Forge calls still have no timeout. `server/forge.ts` belongs to the projects branch, so that is left to it.

### The second review's fixes (on its branch, not merged)

A second review on another model found no blockers, and asked for four fixes first.

- **The push lease had no way out.** It expected the last finished push's commit, so a commit added on the forge, a branch deleted after a merge, or a push that landed unreported blocked every later push for good. The server keeps no lease now. The daemon reads the forge's branch before each push, fetches it for the agent to merge, and refuses only commits it never had, with "someone added commits on the forge, ask the agent to merge them". A local ref of what the workspace last pushed lets the agent still rewrite its own branch, as `--force` allows on main.
- **A stuck push could not be failed from the page,** whose button is disabled while a push runs. The runner's loop now fails a push still running after 15 minutes.
- **The count before staging rewrote the agent's index** when a file's time changed and its content did not. It runs with `diff.autoRefreshIndex` off.
- **Research and plan ask before commands.** They keep no `allow` list, and the design doc says why a read-only one was left out.
- **Seen failing.** Against the code before these fixes, step14 failed 6 of its new and changed checks: the index rewrite, the refusal's message, the push after merging, after a rewrite and after the branch was deleted, and the stuck push. The check that a second commit goes up passed there, and went red with the lease set to HEAD instead of the forge's tip. The rewrite check went red alone with the local ref no longer written. Both breaks went back byte for byte.
- **Verified.** On the branch's head, typecheck, lint and the name guard pass, step14 passed all 74 checks, step14c all 132 in three browsers and step14b all 42.

### Coach and improve learn from checked evidence (built, not merged)

Tayler approved seven items from the evaluation in `research/evaluations/instruction-training.md`. The design, with the rules code enforces and the deploy steps, is in `docs/design/evidence.md`.

- **What works.**
  - Coach picks an agent's unread team sessions, a cheap model reports findings, and code keeps only quotes it finds in the steps they cite, in a person's words for a correction.
  - Corrections become candidates counted in code across sessions and people, which expire after 90 days and are routed to a profile, a check, a skill or the instructions before any text is written.
  - The writer's change comes as hunks the server computes, each citing findings about one correction, with floors, at most five hunks and a size budget.
  - Replays of the turns behind a change and of unrelated turns score it, blind to which version wrote each reply, and only a winner reaches the shepherd, who keeps or turns down each hunk. Decisions are the team's memory.
  - Improve's study cites findings checked the same way, and a pipeline change gets the same memory.
  - The proposal page shows hunks, quotes, counts, scores and decisions.
- **Regressions, for Tayler.** The actions `propose_instructions` and `apply_proposal` are gone, so a pipeline can no longer propose a whole new set of instructions or a skill and apply it on approval. Improve can no longer propose a change without a checked finding, as the brief asked. The live coach and improve files stop loading under this code until the new ones are published, in the order the design gives.
- **Not done.** Agents has no lint job, so a kept check hunk is only listed in the run's note. A change that loses its replays is not remembered, so a later run may replay it again. Two coach runs at once for one agent can make duplicate candidates, which a later read can merge. No page lists candidates. The real-Claude checks and step7 were not run.
- **Verified.** After rebasing onto main at 7197f4b, typecheck, lint and the name guard pass. Migration 0012 was edited in place while unmerged, adding `proposal_hunks.after_hash` and `session_replays.superseded_at`, and proven from the file alone: with its five tables and its `schema_migrations` row dropped from `agents_test`, migrate applied it again, and then step20 passed 44 checks, step20a 68, step20b 30, step20c 10 and step20d 22. step0, step2, step6, step6b, step9, step9b, step10 and step10b passed at 94cd4b1 and were not rerun at 7197f4b. Every changed check fails on main's code, run at 360c16e with this branch's checks and stand-in: step20 and step20a stop on the missing `server/evidence.ts`, step20b and step20c fail 4 lines each, and step20d fails 6. step9 and step9b each failed their new line on main in the first round.
- **Seen failing.** A runner applied each break, ran the check, then put each file back and compared its hash.
  - The first round: 71 breaks across step20 to step20d, step9 and step9b, each taking out one rule, all red. A few first stayed green, and their checks were tightened until they went red: where a replay ends, the phone layout, a gate's controls, a deletion citing the wrong kind of finding, and a different correction held back by the memory.
  - The second review round: each new assertion failed before its fix, 3 lines of step20, 7 of step20a, and one each in step20b and step20c. A session a hunk cites is never replayed as unrelated, and taking that out turned step20a red.
  - The review round: each fix's assertion was written first and failed on the code before it, 10 lines of step20, 19 of step20a, and step20d's count of reads on the old page. Then 32 breaks, all red. The judge's blinding, a replay that never replied, a skipped verdict, the decision endpoint's team and visibility checks, and its refusal of a pipeline hunk were already right, and each went red when broken. Some guards have more than one layer. Refusing overlapping edits is also caught by checking the result, a profile hunk's person check also by the one-correction rule, and the endpoint's team check also by its visibility check and `decideHunk`, so those went red only with every layer out.
- **Found on the way.**
  - Deleting an agent's last rule and adding one after the rule before it spliced at one place, and in one order gave "- Keep replies short.sk before deleting files." The review found it, and settling the two hunks in step20a reproduced it before the fix.
  - A profile hunk could carry another person's correction, an agent repeating a person's words counted as that person's correction, the memory missed the very change on new findings, a retried replay stage lost its replays' spend, and a replay remembered logs and other people's profiles. The review found these, and each now has a check.
  - Main's API serves people only on a socket, so step20b, step20c and step20d failed until they moved to `servePeople`.
- **Open.** On 2026-10-13 no API could start on this Mac for about 13 minutes, since the stream store's System V semaphores ran out. Main's API now closes its stream store when stopped.

### Two review fixes to the evidence branch (not merged)

- **A large document diff failed.** `server/diff.ts` ran git under Node's default 1 MiB cap on a child's output. The daemon takes documents up to 1 MiB, so rewriting a 600 KB one makes a diff of about 1.2 MB, and the Diff tab showed "internal error". The cap is now a named 4 MiB. A step20a check diffs a 700 KB rewrite, which makes 1.42 MB. With the cap back at Node's default it failed with `spawnSync git ENOBUFS` and the other 68 checks passed. With the fix all 69 passed.
- **A teammate could message a replay.** `messageTaskSession` checked only that the person could see the session, and a replay's task is visible to the team. A message would restart the replay with workspace permissions, the agent's plugins and memory, and no budget. It now refuses with a 409 that says why. The command palette also leaves replay tasks out, as the sidebar already did. A step20b check has a teammate message a replay and expects the 409 with no new command or event. With the refusal removed it failed, since the message got a 200 and the replay gained a second command and a second user event, and the other 30 checks passed. With the refusal all 31 passed. The palette filter has no check of its own.

### The evidence branch on top of durability (not merged)

Rebased onto main at 5556f3b, the durability merge. Four files conflicted, in four of the 21 commits, and each kept both sides.

- **`shared/types.ts`.** Durability made `MessagePayload` and `StageSpec` zod schemas, and the daemon reads every claimed message and every resumed turn through them. Zod drops keys a schema doesn't name, so the budget had to go into the schema. `MessagePayload` has an optional `maxBudgetUsd`, and `StageSpec.maxBudgetUsd` stays optional as evidence had it. On a hand-written type alone the daemon would drop the budget, and a replay, which has no stage, would run with none. Each shape is defined once, and the types come from `z.infer`.
- **`daemon/agentsd.ts`.** `acceptEdits` reads `payload.permissions`, as durability has it, since the claim already parsed them. The budget is `payload.maxBudgetUsd ?? stage?.maxBudgetUsd`, evidence's line.
- **`test/fake-claude.ts`.** The start log records `pid` and the `--max-budget-usd` it was given. A reply is `note ?? told ?? rule.reply`. Durability's ledger note comes first because it replaces the rule's reply, and evidence's `replyIf` answer stands where the rule's reply stood.
- **`docs/data-model.md`.** Both sections stay, durability's first, in migration order.
- **Replays still carry `permissions`.** `server/refine.ts` did not conflict. The daemon now fails a payload without them at the claim, so a replay missing them would fail there.
- **Seen failing.** Each break was put back byte for byte before the next one. Reading only the stage's budget in the daemon turned step20b red, with six replays started on no budget. Taking `maxBudgetUsd` out of the schema turned typecheck red, and step20b red as well when run past the type errors, since the daemon's parse dropped the budget. Taking `permissions` off the replay payload turned typecheck red, step20a red on "a replay may not write files without asking", and step20b red on six checks. Making `permissions` optional in the schema turned typecheck and step18l red. In the fake Claude, dropping `note` turned step18b red, dropping `told` turned step20b red, dropping `maxBudgetUsd` from the start log turned step20b red, and dropping `pid` turned step18b red.
- **Verified.** On the rebased head, typecheck, lint and the name guard pass. step20 passed 44 checks, step20a 69, step20b 31, step20c 10, step20d 22, step18b 33, step18e 21 and step18l 11. None of them uses port 7701. step18a and step18g use real Claude and were not run.
- **Not covered.** Nothing fails when `?? stage?.maxBudgetUsd` is removed from the daemon, because this server sends the budget in both places. A payload from an older server, with the budget only in its stage, keeps it through the schema's parse.

### A stage's budget is required again (not merged)

- **What changed.** `StageSpec.maxBudgetUsd` in `shared/types.ts` is `z.number()` again. The rebase onto durability had left it optional, so a stage payload with no budget parsed clean, and `daemon/claude.ts` adds `--max-budget-usd` only when it has a number, which would start Claude with no cap. The claim now refuses such a payload with `at stage.maxBudgetUsd`. A stage whose budget is only in the message is refused too, since the stage carries its own. `MessagePayload.maxBudgetUsd` stays optional, because a replay and a plain message carry none, and the daemon still reads `payload.maxBudgetUsd ?? stage?.maxBudgetUsd`. `server/runner.ts` already sends the budget in both places, so no server code changed.
- **The check.** step18l copies the looping turn's message with a stage that has no budget and no budget of its own. It expects the command to fail with a reason naming `stage.maxBudgetUsd`, the same reason in the record, and no new Claude start.
- **Seen failing.** First at the schema. Six payloads were read through the real `MessagePayload`. With the field optional again, a stage with no budget parsed clean. With the file restored, identical by sha256, it was refused with `at stage.maxBudgetUsd`. The server's own stage payload, a stage with its budget only in the stage, a replay and a plain message parsed in both states. Then in step18l, run under `run.lock`. With the field optional again, 10 of 12 checks passed. The new check failed, and so did "the person's next message gets an answer". With the file restored, identical by sha256, all 12 passed.
- **Verified.** Typecheck, lint and the name guard pass. step18l passed 12 checks, up from 11, and step20b passed 31.

### step18d no longer takes the lock itself (not merged)

- **What changed.** `test/step18d.ts` made `~/.agents-app/checks/run.lock` itself with mkdir, waited up to 20 minutes for it, and removed it when it ended. It no longer touches the lock. The caller takes it before any check on port 7701, as `AGENTS.md` asks, and step7 and step8 already work that way. `docs/design/durability-resume.md` said step18d takes the lock itself, and now says to take it around the check.
- **Why.** A full suite whose runner already holds the lock reached step18d, which waited on that same lock and fails after 20 minutes. The coordinator hit this in a suite run on 2026-10-14 and had to stop it. The wait was the first thing the check did, before it made a team, a container or a database connection, so the failure said nothing about durability.
- **Seen failing.** step18d as it was, with its 20-minute wait cut to 3 seconds, failed on the lock the run held, with "run.lock was held for 0.05 minutes". It stopped before it made a team or a container. The file was put back, identical by sha256.
- **Verified.** Typecheck, lint and the name guard pass. step18d as committed passed all 14 checks while the lock was held. Its first run failed instead, with "timed out after 90s waiting for the session to show as lost", and the next run passed. I did not find the cause. In the failed run the box wrote its note and lost its container, and 90 seconds later its instance still showed online and its session running, so the lost-machine pass had not marked either. The test Postgres log shows 19 Electric replication timeouts between 11:46 and 13:07 that day. The change removes only code that ran before the check's first query.
- **Not covered.** Run without the lock held, step18d now collides with another agent's check on port 7701, as step7 and step8 do. Nothing in the check enforces the lock. `AGENTS.md` and the durability resume note are what tell the caller to take it.

### The coding framework (in progress)

On the branch `worktree-agent-a1b7e5f238509c562`, not on main. The design is `docs/design/self-improve.md`, and the rules are in `AGENTS.md`.

- **What it is.** On a repo with a policy, the runner judges every coding agent's change: static gates on the diff, the box's gates on a clean checkout, a review and a verdict from agents on other models, the full suite on the merge result, and gates only the owner passes for protected paths, the merge and the deploy. It merges only at the head every gate judged. Evidence names the builds that produced it, and the pull request carries an attestation a CI job can check.
- **Verified.** `test/step16b.ts` (each static gate, the policy floors and the attestation, on fixtures), `test/step16c.ts` (a deploy to a stand-in server, and the rollback of a release that cannot start), `test/step16d.ts` (obligations) and `test/step16e.ts` (the lease on every push) pass. `test/step16.ts`, end to end with a stand-in for Claude, passes all 73 of its checks, including every run the gates must stop. The existing checks the runner and daemon changes touch, steps 0, 6, 7, 8 and 9, pass on the branch.
- **Seen failing.** 24 guards, each broken by a scripted edit and restored byte for byte, are listed in the design. The guards only the end-to-end check exercises have not been run broken.
- **What the checks found.**
  - A change that only added a check skipped both seen failing and the owner. step16's SEEN run caught it, and a change to checks alone now goes to the owner.
  - The runner's row types said timestamps were strings, and Postgres returns Date objects, so its time comparisons were wrong. The types now say Date.
  - The workspace's linked `node_modules` was committed into the task branch by the push's `git add --all`. Each clone now excludes it in `.git/info/exclude`.
  - A refused push is tied to the machine that made it, so it stops every governed run on that machine. step16 runs that case alone. The limit stays, and fails closed, until a push carries its run.
  - Rebasing onto main replayed an old revert over main's `.gitignore` fix. I restored main's file.
  - I ran the cleanup script for leftover test teams while step16 was running, which deleted the running check's team. I clean up only between runs now.
- **Not done.** The framework does not hold changes to this repo until the repo is registered with its policy. The design's "Not enforced yet" lists the rest.

### The coding framework: the review round (in progress)

A review on another model found the framework not ready to land. On its branch, each finding was fixed with a check or fixture, and each check was seen failing.

- **Fixed.**
  - A script with one NUL byte, or any file over 2 MiB, hid from every gate. The new `opaque` gate fails it, and the size cap charges it by bytes.
  - An owner's acceptance of a verdict below the floor could never merge. The merge's proof now carries it.
  - The deployer could stop with a deploy unfinished. Any error after the switch now rolls back and fails the deploy. Health answers are read with a time limit, half-installed releases are removed, old requests expire, and every subprocess has a time limit.
  - `AGENTS.md` claimed more than the code did. Each claim now says what holds it, and review and verdict are called advisory until judges run on their own machine.
  - Results from the box and the check host must answer what they were asked. Only the owner approves running the suite.
  - The git proxy read whole pushes and refused other branches on every repo. It streams now, and its rule applies only on repos with a policy.
  - Overrules key on the body too. Inline eslint config is caught. Decisions and gate output are scrubbed, and the agent's text sits in its own fence in the pull request.
  - One undeliverable promise no longer blocks the rest, and `pipelines/bug-fix.ts` is main's again.
- **What the checks found.**
  - Importing `node:crypto` into `shared/framework.ts` broke the app's typecheck, which reads that file. Only the box's `tsc -p app` caught it, on every HAPPY pass.
  - The record cannot store a NUL byte in an event, so an agent that writes one stalls its stage. step16 writes its NUL with a command instead. Fixing the record is main's.
  - A break that left the copied repo failing its own lint went red for the wrong reason, so those breaks were redone to keep the code lint-clean.
- **My mistakes.** My step7 run on 2026-10-13, before main's fix, built `agents-box:latest` from this worktree. The coordinator restored it. step7 now builds its own tag.
- **Not done.** Judges on a machine of their own. Until then review and verdict are advisory, and the repo must not be registered.

### The coding framework: the re-review round (in progress)

- **Rebased onto 7197f4b as one commit.** Main's workflow merge rewrote thirteen files the branch changes, so its 46 commits were folded into one and rebased. The commits as they were are on the local branch `self-improve-pre-7197f4b`.
- **One push lease, main's.** The runner's lease, `expect` in the push payload and `lastPushed`, is gone, and so is `test/step16e.ts`. The push sends main's payload, defined once with zod in `shared/types.ts`, and main's `forgeTip` in `daemon/workspace.ts` is the only lease. LEASE in step16 expects main's refusal. The head checks, `refused_pushes` and the proxy rule stay.
- **Judges ask before they edit.** Main gave stage prompts `WORKSPACE_PERMISSIONS`. The review and confirm judges get `JUDGE_PERMISSIONS`, which leaves an edit asking a person, as every session did before main's change.
- **Added lines cannot be forged.** The runner reads each changed file's diff alone, through a `:(literal)` pathspec, and each hunk by the counts in its `@@` header, so an added line reading `+++ b/ok.ts` stays its file's line. A path git quotes, or a file whose hunks add another number of lines than git's numstat counts, fails the `opaque` gate. Findings from the TypeScript parser sit on git's lines, counted by LF alone, so a comment after a lone CR, U+2028 or U+2029 is judged on the line git added.
- **The opaque gate fails any hidden file.** A file git calls binary, or one over the read limit, fails whatever its name, except lockfiles and images whose first bytes show PNG, JPEG, GIF, WebP or ICO.
- **The pull request fences what agents and people wrote.** The risks, what was sent back, the verdict, the review findings and the decisions each sit in a fence, and the opening sentence says so instead of claiming the runner wrote everything after the summary.
- **Review and verdict are marked advisory.** The pull request marks them in its evidence table, its "What was checked" line and its verdict and findings sections, and the attestation records them as `advisory`. AGENTS.md and the design now say the owner can accept a weaker verdict, that the judges' reports are taken as reported, and that the box's check configuration comes from the merge base. AGENTS.md's list of what needs Tayler to land is main's again.
- **Stuck deploys fail.** A deployer, on starting, fails every deploy of its repo left preparing, switching, checking or rolling back. The runner fails a deploy a deployer started and did not finish within `DEPLOY_RUN_LIMIT_MIN`, 60 minutes.
- **Smaller fixes.** The policy names `AGENTS.md`, `CLAUDE.md` and `tsconfig*.json` at the root beside their `**/` forms, since the forge reads `**/` as at least one folder. A failing obligation waits twice as long after each try, up to an hour, counted in `attempts` and `retry_at`. A request error reaches the proxy's unzipping. step16 checks every scenario's replace text before it starts, after main's change to App.tsx turned the view case into a no-op. Main's palette backdrop color became the `--scrim` token with its value unchanged, so `test/style.ts` passes.
- **Verified.** step16 passed every section, with HAPPY run again after two of its checks were corrected, and step16b, step16c, step16d, step16f, the typecheck of both projects, lint, names and style passed. Main's step0, 1, 4d, 5, 6, 7, 8, 9, 10, 10b, 12, 12b, 12c, 14, 14b, 14c and 19 passed under the 7701 lock. Each new guard was seen failing, as the design's table lists.
- **Schema.** Migration 0009 gained `obligations.attempts` and `obligations.retry_at`, added to agents_test by hand.
- **Not done.** Judges on a machine of their own. Until then review and verdict are advisory, and the repo must not be registered.

### The coding framework: the third review round (in progress)

A third review found five blocking holes and three smaller ones. Each fix has a fixture or a check, seen failing with the fix broken and green with it restored byte for byte.

- **An image needs the extension of its format.** A new `server/helper.ts` that opens with `GIF89a:`, a valid JavaScript label, and holds one NUL byte in a comment was binary to git and a GIF to the opaque gate, so no gate read it and the size cap charged it nothing. The opaque gate and the size cap now pass a binary file unread only when its extension names the format its first bytes show. step16b has the fixture for `server/x.ts`, and reads `server/helper.ts` from a real git repo.
- **Two files cannot share one path.** The runner reads git's output as UTF-8, so a file named with the byte 0xff, which is not UTF-8, came out as the same path as a file named with U+FFFD, and the gates read the second file twice and the first never. A path holding U+FFFD, or one git lists for two changes, now marks its file untrusted, which fails the opaque gate. step16b puts the pair in a real git index by hand, since the file system may refuse a name that is not UTF-8.
- **A judge's session takes no messages.** `messageTaskSession` sent a person's message to any session they could see, and `sendToSession` built it with a workspace's permissions, no stage, every plugin tool allowed and no budget, so a message to a reviewer or a verifier lifted every limit the runner set. `startJudges` reuses the session, so the lift lasted. `startJudges` records each judge's session among its row's reviewers, in the transaction that creates the session, and that record is the mark. `sendToSession` now refuses a message to any session a review or confirm row lists, with a 409 that says why, which also covers a comment sent to a document a judge wrote. A `sessions.judge` column would have said the same thing twice, and needed a schema change to the shared `agents_test`. step16's HAPPY run posts a message to the reviewer's and the verifier's sessions and expects the 409 and no new command.
- **Judges start with no permission mode, and a check says so.** Swapping `JUDGE_PERMISSIONS` for `WORKSPACE_PERMISSIONS` in `startJudges` kept every check green. The fake harness now logs `--permission-mode` in `starts.jsonl`, and step16's HAPPY run checks that the reviewer and the verifier started with none, so an edit asks a person, and every author stage with `acceptEdits`.
- **The obligation backoff no longer overflows.** `power(2, attempts)::int` cast before `least(60, ...)` took the hour, so at 31 tries Postgres raised "integer out of range", and the error undid every delivery in that pass and in every pass after it. The exponent now stops at 6, already past the hour. step16d seeds a promise that failed 40 times, due before the others, and checks it waits an hour and holds none of them up. Its fixed six second sleep became a wait for a promise made after the first pass to be tried, which shows a later pass ran.
- **Migration 0009 alone.** step16d cannot run on a database other than `agents_test`, since the daemon hears of commands only through the test Electric, which replicates `agents_test` alone, and the permission system refused a schema change to `agents_test`. So step16d passed on `agents_test`, and a scratch database built from this branch's migrations alone, then dropped, showed the same 223 facts about 0009's objects as `agents_test`: every column with its type, nullability and default, every constraint and every index. Only the order of `obligations.attempts` and `obligations.retry_at`, which were added to `agents_test` by hand, differs. `agents_test` was not changed.
- **The deploy lifecycle matches what fails a deploy.** A deployer starting up and the runner's hour limit fail a deploy from any working status, and the lifecycle table did not let `checking` end `failed`. It does now, and step16b checks every status in `DEPLOY_WORKING` may end `failed`. In `ops/deploy.ts`, which is protected and which Tayler approved for the framework, `move()` updates a deploy only while it holds the status the deployer last gave it, and the deployer stops when no row changes, so a deploy the runner failed is never brought back. A deployer also takes an advisory lock keyed by its repo, on a connection of its own, before `failStuck`, so a second deployer for the repo stops at once instead of failing the first one's deploy. step16c checks both.
- **The pull request fences the changed paths.** An agent chooses each path, and the list in "What changed" printed them in inline code, which a backtick in a path could end. The list now sits in a fence, scrubbed like the other text agents wrote. A gate's name can hold a check's path, so the gate column now goes through `tableCell`, as the summary column's escaping already did, and a pipe or a newline ends neither its cell nor its row.
- **Named from the fold.** Folding the branch onto main rewrote the refusal in `server/launch.ts` that keeps a task off a Mac when its repo's policy keeps work in boxes. Main's tasks now hold several repos, so it reads every repo's policy and refuses when any says `sandbox: box`. step16 covered one repo, and its BOXED run now also starts a task on the app repo and the boxed one together and expects the 409. The fold also turned the palette backdrop's color in `app/src/styles.css` into a `--scrim` token in each theme, with the same value, since the design lint allows a raw color only where `:root` defines tokens.
- **Verified.** At `66680c4`, the last code change of the round, the typecheck of both projects, lint and the name guard pass. step16 passed every section in one run, 95 checks, step16b all 144, step16c all 17, step16d all 16 and step16f all 6, on `agents_test`, whose schema ended the same as it began. Each new check went red with its fix broken, and each broken file came back byte for byte by sha256. The design's table lists each break and the line that failed.
- **Not done.** step16d has not run on a database built from migration 0009 alone, for the reason above. The "Needs the owner" section still names each protected file's path in a heading, outside any fence. Judges on a machine of their own. Until then review and verdict are advisory, and the repo must not be registered.

### The coding framework: rebased onto f643a30 (in progress)

Main now holds durability (5556f3b), evidence (9ee5b17) and the stage budget fix (f643a30). I replayed the branch's 11 commits on it one at a time. The first stopped on conflicts in ten files and the sixth in `test/fake-claude.ts`. Every conflict kept both sides.

- **`shared/evidence.ts` was two files.** Main's holds coach's findings, hunks and replay scores. The branch's held the verification manifest, the feature map and the verdict ladder, and both export a `Verdict`. Main's stays at its path. The branch's is now `shared/verification.ts`, and its four importers, `AGENTS.md`, the policy's `protectedPaths` and the docs name the new path. The protected list names `shared/verification.ts` and leaves main's `shared/evidence.ts` out, since that file is coach's and not the framework's.
- **The stage payload.** `StageSpec` is main's zod schema with `isolated: z.boolean()` added, required like `maxBudgetUsd`. A stage payload without it fails the daemon's parse and names `stage.isolated`. The daemon reads permissions and `payload.maxBudgetUsd ?? stage?.maxBudgetUsd` from main's parsed payload, and still gives an isolated session no team-record server or tool.
- **`server/runner.ts`.** Agent stages still go through `stageSession` and `sendPrompt`. Main's `stage.model ?? agent.model` goes in the agent row they take, and `sendPrompt` sends the budget in the payload as well as in the stage, as main's runner did. Actions are main's exhaustive switch with `merge_change`, a governed `merge_pull_request` and `ask_reporter` added, and `deploy` and `replay_sessions` start before it. A finished action keeps its row's data and adds the result's. `withClient` is `tx`.
- **Actions, routes and docs.** `ACTION_OUTCOMES` is main's table with `merge_change`, `deploy` and `ask_reporter` added, and the branch's copy in `server/pipelines.ts` is gone. `propose_instructions` and `apply_proposal` stay gone, as main's regression note has it. `server/api.ts` keeps main's hunk decision route and the branch's obligation and pause routes. `docs/data-model.md` lists the framework's migration before durability's and evidence's, in migration order. The fake Claude logs `pid`, `--max-budget-usd`, `--model`, the allowed tools, the MCP servers and `--permission-mode`.
- **Two refusals.** Neither file conflicted in text. `sendToSession` has main's `said` and the 409 for a judge's session, and `messageTaskSession` has main's 409 for a replay's session. Each has its own message.
- **Migration order.** 0009 now sorts before 0010 and 0012. It extends the check constraints it touches by adding values and shares no object with them. `agents_test` applied them as 0009, 0010, 0012. I did not apply them to a fresh database or in the other order.
- **The deploy gap.** In `ops/deploy.ts`, the backup and the migrations ran before the first move that checks the row, so a deploy the runner had failed during its install or backup still migrated the live database, and the deployer noticed at the switch. `move()` now shares its status-checked update with `save()`, which runs before `migrate`. It writes the log so far only while the row is `preparing`, and throws when it is not, so the deployer stops.
- **The check.** step16c's moved deployer now has a migrate step that writes a marker file, and a new line expects the deploy the runner failed during its backup to leave no marker.
- **Seen failing.** With the `save()` before migrate taken out, step16c failed one line, "a deploy the runner failed while it was preparing never migrates the database: it migrated, failed", and its other 17 passed. The file went back identical by sha256 and all 18 passed.
- **Removed.** `docs/design/self-improve-resume.md`, which said it was dropped before landing.
- **Verified.** At `84549f4`, the last change before this entry, the typecheck of both projects, lint, the name guard and `test/style.ts` pass. step16 passed 95 checks, step16b 144, step16c 18, step16d 16 and step16f 6, and main's step14 passed 74, step18l 12 and step20b 31. None of them binds port 7701, so the run lock was not taken.
- **Not covered.** A deploy the runner fails while `migrate` itself runs has still migrated, since no write can be atomic with the command. The daemon enforces `isolated`, so a daemon from before this change gives a judge the team-record tools, and the server and daemon have to ship together. The full suite did not run on this head. Neither did main's other checks, such as step9, step20 and step20a, or the checks on port 7701.

### agents-git v1 (not merged)

- **What changed.** `daemon/agents-git/` is a TypeScript CLI that starts, lists, adopts and finishes the git worktrees agents work in, and keeps a ledger of them in `~/.agents-app/worktrees.json`. `docs/what-each-part-does.md` says what each command does. `test/step22.ts` runs every command against a repo it builds in a temp folder.
- **Decisions I made.**
  - It lives in `daemon/`. The compiler and lint cover only the folders `tsconfig.json` lists, and that file, `eslint.config.js` and `ops/` all need Tayler's approval to change. **Revisit** if it should get a top-level folder, which is one line in each of the two files.
  - Worktrees go in `<main checkout>-worktrees/<name>`, named once in `worktrees.ts`, which is `~/Projects/agents-worktrees/<name>` for this repo. Deriving it from the main checkout keeps a home folder out of the code, and keeps the check's worktrees inside its temp folder without a second env var.
  - `done` keeps the last commit at `refs/agents-git/<name>/done`, not at `refs/agents-git/<name>`. Git can't hold a ref and a folder of refs under the same name, and saves go under `refs/agents-git/<name>/`. In a scratch repo git refused with "'refs/agents-git/alpha' exists; cannot create 'refs/agents-git/alpha/save-1'".
  - A name is used once. start refuses a name the ledger has, finished or not, and a name with refs kept under it, so a kept commit is never overwritten.
  - start takes its worktree and branch back when `npm ci` fails, so it leaves either a ready worktree or nothing.
  - prune leaves out worktrees with no new commits. Main has all their commits, but an agent may have just started in one.
  - A lock whose holder process has exited is cleared. Clearing takes a second lock, so two waiters can't both clear it and both take the first.
- **Seen failing.** 36 breaks, run one at a time by a script that asserted each anchor matched once, ran step22, and put the file back identical by sha256 before the next. Each guard's own line went red:
  - start: a plain name, the owner note, a dirty main checkout, a name in the ledger, an existing branch, kept refs, an existing folder, branching from local main, running `npm ci`, taking back a failed install, and running no hooks.
  - list and the ledger: optional locks off, mode 0600, the rename, the zod parse, flagging worktrees git has and the ledger lacks, and flagging a folder that is gone.
  - adopt: refusing the main checkout, a folder that is not a worktree, and one already tracked, plus a break that locked the worktree, which the unchanged-worktree line caught.
  - done: the preview, uncommitted files, commits main lacks, the saved ref, marking the ledger, a locked worktree, a worktree on another branch, and a start still running.
  - prune: leaving out worktrees with no new commits, and skipping what done would refuse.
  - the lock: holding it, clearing a stale one, and releasing it. Without the release, start waited on the lock it held itself until the check's 60-second limit stopped it.
  - Deleting the branch only when main has it is a second layer behind the refusal of commits main lacks. Broken alone, no line went red. With both out, "a clean worktree whose branch main lacks is still refused, and its branch kept" went red.
- **Verified.** Typecheck, lint and the name guard pass. step22 passes 59 checks in about 8 seconds, with no ports and no database, and confirms the real ledger was not touched.
- **Not covered.**
  - Three guards have no line that breaks them: adopt refusing a worktree on main, done refusing a folder git has no worktree at, and done refusing a kept ref that holds a commit outside the worktree.
  - A commit made on a detached HEAD in the moment between done's last check and git's removal would be lost. Started worktrees are always on a branch, so only adopted detached ones are exposed.
  - A process killed while clearing a stale lock leaves `worktrees.json.lock.clearing`, which a person has to remove.
  - It has not been run against the real repo.
