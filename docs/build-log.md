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
- **Not done.** Inviting waits on the people-port fix, since joining by invite trusts the login header. The real Tailscale API and a full Claude sign-in were never exercised. Removing a person from the team isn't built. Boxes on the real server get the new daemon only after the image is rebuilt and the boxes recreated.
- **Verified.** After rebasing onto main at deec329, typecheck, lint and the name guard pass. step12 passed 61 checks through the API, step12b 111 in Chromium, WebKit and Firefox at desktop and phone width, and step12c 51 with real box containers in the three browsers.
- **Seen failing.** 113 breaks, each taking out one thing a check guards. A runner applied each one, ran the check, then put the file back and compared its hash.
  - step12: all 67 went red, two of them by stopping the check early. When step12 was first written, 2 of its first 31 breaks stayed green. With the join lock gone, the three joins it sent still finished one after another, and with the admin gate gone, the check crashed before reaching the line it guards. Both checks were rewritten and went red.
  - step12b, in Chromium: 35 of 39 failed their own check and 2 stopped the run. The last 2 each took out one of the two rules that keep a room's teammate picker on a phone screen. Either rule alone holds, and taking out both went red.
  - step12c, in Chromium: all 7 went red. The token written to a box's stderr was also tried against the check as it was, which read only stdout, and that stayed green.
- **Found on the way.**
  - The API log held a box's machine token, and any team Claude token, whenever `docker run` failed, because the error's message repeats the whole command line. This was on main. A box's start error now keeps only what Docker wrote to stderr, and a break that puts the message back turns step12 red.
  - step12c looked for the token in a box's stdout only, and the daemon writes errors to stderr. It reads both now. A break that logs the token to stderr turns it red.
  - In WebKit and Firefox a box came online before the page loaded, so "is starting" never showed. step12c now relays the boxes' connections to the API through a door it holds shut until the newcomer has seen their box starting.
  - step12 checked only the status of a tailnet invite resend, which a route that never called Tailscale would also pass. It now looks for the call, and goes red with the call taken out.
- **Open.** In about 2 runs of 20, WebKit leaves step12b's Invite button disabled after the email is typed, and the field reads empty while focused. The cause is not known. The check prints the field, the button and the focus when it happens.
