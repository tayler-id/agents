# Data model

The working copy is the shared doc "Multiplayer agents data model": https://claude.ai/code/artifact/7f0197fc-d2d9-4f0b-b528-993c059787f5. It has every table, the states, and the diagram.

Tayler agrees each part there before any table is built. Agreed parts are copied here, and they become migrations in `server/`.

We copy the product we studied, not its name, and everything it runs is an **agent**.

## Agreed

### The shape

Everything lives in one app. Conversations are where the team and its agents talk. Work happens inside it, in tasks, sessions, workspaces and artifacts, usually started from a conversation. Every session's events go into the shared record, which every agent can search. Pipelines run on top.

### Task

The unit of work a person or a pipeline asks for, such as "fix bug 123" or "add the billing page". It holds the work's configuration: the repos, which agent, the instructions.

- A task has many sessions over time. Retries, pipeline stages and a teammate picking the work up are each a session.
- Artifacts belong to the task. Each records the session that made it.

### Conversations

Main, DM, room and PR conversations, with messages and room turns, as recorded in rea's evidence on the studied app's teams and plugins, under `docs/evidence/app/`. People and agents talk there, and work starts from them. A message can start a task, and the task posts its progress and asks back into that conversation.

### Session

Every session serves a task or a conversation. Our own session id is the key. Claude's id is a column used to resume. (First agreed as "every session belongs to a task", changed when conversations were added.)

### Agents

Named teammates with memory, skills, plugins, secrets, routines and a home machine. Claude or Codex is the harness an agent runs on.

### Event

One entry in a session's record. Events are only added, never rewritten, except to redact a leaked secret. Every event is kept whole in Postgres.

| Column | Type | What it holds |
|---|---|---|
| id | bigint, key | A global number, in write order |
| session_id | uuid | The session |
| seq | bigint | Its number in the session, unique with session_id |
| updated_seq | bigint | Equal to seq, or the session's next number after an edit |
| team_id | uuid | Copied from the session, so the sync proxy can filter by team |
| kind | text | user, assistant, thinking, tool_call, tool_result, ask, answer, notice, error, usage |
| author | uuid, optional | The person, on events a person wrote |
| parent_tool_use_id | text, optional | Set on a subagent's events: the Agent call that launched it |
| tool_use_id | text, optional | Links a tool call to its result and its ask |
| tool_name | text, optional | The tool called |
| text | text, optional | The readable part, for search |
| body | jsonb | The full content, scrubbed |
| client_id | text | Claude's id for the line, so a retried write is never added twice |
| created_at | time | |

Search is a full-text index over `text`, not a column, so sync never carries it. Claude's raw output lines go in a `raw_events` table, keyed by Claude's own line id. Live tokens go to the stream server and land here as one finished event. The kinds `ask` and `answer` replaced `approval_request` and `approval_answer` when asks were agreed.

### Artifact kinds

Documents (content we hold, versioned) and links (PRs, commits, previews), in one table.

### Also agreed

- **Memory.** Each agent keeps a profile and dated logs for each person and for the team.
- **Asks.** Every card that waits on a person, such as approvals, questions, forms and drafts, is an ask. It shows in the conversation, so any member can answer.
- **Making documents.** Files the agent writes in the task's folder become versions automatically. The folder stays out of git.
- **Access.** Rules live on the task and the conversation, shared with the team by default.
- **Workspaces.** One folder per task attempt, with a worktree per repo.
- **Session states.** draft, starting, running, idle, needs_input, needs_approval, limited, lost, failed, as in the doc.
- **Code style.** Plain TypeScript for phase 1.

All agreed 2026-10-11.

## Added while building (not yet agreed)

These came up while building phase 2. Each is a small addition to an agreed table, or one new table. They are in `server/migrations/0002_factory.sql`. Tayler reviews them here.

- **`run_stages`, new.** One row per try at a stage of a pipeline run: an agent's turn, a check run in the workspace, an action on the forge, a gate, or a hand-off to a person. It holds the outcome, the summary, the details the stage reported, and links to the session, command or ask behind it. Runs alone could not show a run's history or tell a loop's second try from its first.
- **`pipeline_versions.source` and `.error`.** A version is the pipeline file's content. `git_sha` is git's own blob id for that content. A version that does not load keeps its error and never becomes current.
- **`pipelines.description`, `.current_version_id`, `.conversation_id`, `.shepherd_id`, `.cron_checked_at`.** The current version is the newest one that loads. Each pipeline has a room, a `room` conversation, where its runs post progress and gates ping the shepherd.
- **`runs.note`.** Why a run ended, in a sentence, such as "Stopped at the spend cap".
- **`runs` unique on `trigger_payload->>'once'`.** One run per source event, so a webhook delivered twice starts one run.
- **`commands.result` and the `push` kind.** What a machine reports back, such as a check's exit code and output.
- **`instances.claimed_by`, `.claimed_by_run`, `.claimed_at`, `.idle_since`.** Who holds a box, a person or a run, and since when it has been idle.
- **`artifacts` unique on `(task_id, path)` for documents.** Each file in a task's folder is one document with numbered versions.

Phase 3, in `server/migrations/0003_refinement.sql`:

- **`proposals` can target a pipeline file, an agent's instructions, or a skill.** New columns `target`, `agent_id`, `skill_name`, `summary`, `content`, `candidate_version_id`, `run_id` (the run that wrote it) and `pull_request`. `pipeline_id` and `base_version_id` are now optional, since an instructions change has neither. New statuses `scoring` and `failed` join `open`, `approved` and `rejected`.
- **`runs.replay_of` and `runs.proposal_id`.** A replay runs a past run's report again, at the commit it started from, with one pipeline version, to score a proposal. Replays never touch the forge and never wait on a person.

Phase 4, in `server/migrations/0004_rooms_and_agents.sql`:

- **`turns.started_at`.** A room's turns wait in line, asked for, then started, then finished with an outcome. Only one turn in a room runs at a time, so this tells a waiting turn from a running one.

Onboarding, in `server/migrations/0005_onboarding.sql`. The design is in `docs/design/onboarding.md`.

- **`invites`, new.** An invite to join a team, made in the app. It holds the email the person must arrive with, their role on the team, Tailscale's id for the matching tailnet invite, the admin who made it, and whether it is open, joined or cancelled. One open invite per email. The invite link is never stored.
- **`join_requests`, new.** A login that opened the app while on no team and with no invite, with the name Tailscale passed and when it first and last came. An admin adds it with one click. It has no team, since the login is on none yet.
- **`claude_logins`, new.** One sign-in to Claude on a person's box. It goes from starting, to waiting for the person's code, to checking it, and ends signed in, failed or cancelled. It keeps the sign-in link and when the token runs out. One open sign-in per box. The code and the token are never stored.
- **`instances.personal` and `instances.start_error`.** A personal box belongs to one person for good. Runs never claim it, the box limit does not count it, and it is never stopped for being idle. Each person has at most one. `start_error` says why its container did not start.
- **Every team has an admin.** `people.role` existed but nothing set it. The migration makes the earliest person of each team that has no admin into one.

Projects, in `server/migrations/0006_projects.sql`. The design is in `docs/design/projects.md`.

- **`projects`, new.** A team's work on one thing: a name, a description, its room (`conversation_id`), who made it and when, and `archived_at`. A name is unique in a team among projects not archived. Everyone on the team sees every project.
- **`repo_requests`, new.** A repo the app was asked to make on GitHub for a project: the organization or account it goes under, its name and description, `creating`, `done` or `failed`, GitHub's reason when it failed, and the `repos` row once made. Only a failed request has a reason and only a done one a repo. The app writes it before asking GitHub, so a crash or a refusal never leaves a repo nobody knows about, and trying again adopts a repo an earlier try made. A repo is asked for once per team.
- **`repos.forge`.** The forge that holds the repo, `gitea` for this Mac's or `github`. Existing rows are `gitea`. The runner, the git proxy and the Repos page go by it.
- **`repos.project_id`.** The project a repo belongs to, or none. A repo belongs to at most one project.
- **`repos.polled_at`.** When the GitHub worker last read the repo's issue events. GitHub can't reach this server with webhooks, so the labels that ask for work are found by polling, and a restart carries on from here. No GitHub token is in Postgres: they live in mode 600 files on the server.
- **`tasks.project_id`.** The project a task belongs to. Its runs and documents follow it, so they need no column of their own.
- **`conversations.project_id`.** The project a room belongs to. Only a room can have one.

The work layer, in `server/migrations/0007_workflow.sql`. The design is in `docs/design/workflow.md`.

- **`file_changes`, new.** One row per file that differs from the base branch in one of a task workspace's repos. It holds the status (added, modified or deleted), the line counts, whether the file is binary or too large to show, its content now and its diff against the base, both scrubbed on the machine. It is the workspace's current state, so a row goes once its file stops differing. The task page lists these as Changes and opens each one beside the task.
- **`unlisted_changes`, new.** One row per repo of a task workspace whose changes the machine did not list: `too_many`, past the 20,000 files it lists, or `unreadable`, when git failed on the repo, with git's reason scrubbed. A repo with too many loses its `file_changes` rows, and an unreadable one keeps its last list. The row goes once the repo is listed again.
- **`pushes`, new.** One row each time a person asks to open pull requests from a task. It holds the push command it sent, who asked, the title and description, and how it ended, as `pushing`, `done` or `failed`. One push may be in flight per task. The pull requests it opens are link artifacts on the task, as a run's are.
- **`task_blocks`, new.** One row per edge between two tasks of a team: the blocked task, the task blocking it, an optional one-line reason, who added it and when. A task is blocked while a task blocking it is neither done nor discarded. The API refuses an edge to the task itself or one that closes a cycle, and refuses to discard a task that still blocks queued or active work.
- **`task_holds`, new.** At most one hold per task: its kind (`decision`, `external`, `load`, `parked` or `future`), a one-line reason, an optional until date it lapses on, who held it and when. A held task stays out of the ready query until the hold lapses or someone lifts it.
- **`tasks.priority` and `tasks.done_at`, new.** Priority runs from 0, the most urgent, to 4, and is 2 unless set. `done_at` is when someone marked the task done. With the draft status and `archived_at` they give a task its state, queued, active, done or discarded. The ready query lists the queued tasks that nothing blocks or holds, by priority and then age.
- **Used for the first time, with no schema change.** A session with the agreed `draft` status is a task saved to start later. `comments.anchor` gains `occurrence`, which match of the quote a comment means. A push command's repos carry their `base`, and its result says how many commits each repo is `ahead`. A message command carries `permissions`, what its session may do without asking.

Agent computers, in `server/migrations/0008_computers.sql`. The design is in `docs/design/computers.md`.

- **`instances.screen_width` and `.screen_height`.** The size of the screen a machine reports on its heartbeat, or null when it has none. Both are set or both are null. The app offers a Screen button only for machines with a screen.
- **`screen_takeovers`, new.** One row for each time a person held a machine's screen: the machine, the person, the session they were looking at, when it started, when it ended, and how (`handed_back`, or `left` when their last Screen view closed). A unique index allows one open row per machine, and the open row is the record of who holds the screen. The API and the box keep copies, which the API updates after it writes the row.
- **`blobs`, new.** The bytes of image documents, one row per team and SHA-256, with the media type (PNG, JPEG, WebP or GIF) and size (5 MB at most). Kept apart from `artifact_versions` so Electric never streams image bytes. Never a shape.
- **`artifact_versions.blob_id`.** Set on an image version, whose `content` is then empty. A version is text or an image, never both.

The coding framework, in `server/migrations/0009_self_improve.sql`. Every agent doing coding work runs inside it, on any repo with a policy. The design is `docs/design/self-improve.md`.

- **`policies`, new.** The rules every change to a repo must pass, as versioned JSON. Editing a policy adds a version, so each piece of evidence names the version that judged it.
- **`repos.policy_id` and `.owner_id`.** A repo with a policy runs every change through the framework. Its owner is the one person who passes the gates for protected changes, merges and deploys. A policy without an owner is refused.
- **`people.forge_login`.** The person's user on the forge. When the owner approves a merge in Agents, the approval is posted on the forge as theirs, because branch protection counts only the owner's approval.
- **`evidence`, new.** One row per gate per commit: pass, fail or needs the owner, a summary, and details such as exit codes and output. Its `build` names the runner's build, the build of the machine that ran the gate when one did, and the sha256 of each input read from main. Only server code writes it, never an agent.
- **`findings`, new.** What a reviewer or a verifier found, with the rule it breaks, the file and line, whether it blocks, and its topic when it is about security, auth, billing, data, migrations or concurrency, which a person always sees. A finding is open until the same reviewer's next round, then fixed or repeated. Only the owner overrules one, and the row keeps who did. A finding raised again after the owner overruled it is stored overruled, with the same person.
- **`verdicts`, new.** A verdict from the ladder in `shared/verification.ts`, by an agent that did not write the change, kept by pull request and head commit with the change's patch-id. It holds the commands the record shows the verifier ran, its model, and a `build` like evidence's. A new head voids it unless the patch-id is the same. `accepted_by` and `accepted_at` record the owner who accepted a verdict below the policy's floor, by name, which is what lets such a change merge.
- **`decisions`, new.** The decision log. What an agent or a person decided, why, and the alternatives they weighed, tied to the task and the run.
- **`lessons`, new.** A lesson the team learned, the incident behind it, and what enforces it. It stays "written" until it names the gate, lint rule or check that holds it.
- **`obligations`, new.** A promise made outside Agents, such as the outcome owed to an issue's reporter: what is owed, where, by when, and the kind of proof that closes it. It closes only with that proof, or when a person waives it by name with a reason. A stale or conflicting delivery changes nothing. `attempts` counts failed tries at delivering it, and `retry_at` holds off the next try, twice as long after each failure, up to an hour.
- **`refused_pushes`, new.** Every push the git proxy refused on a repo with a policy, such as a machine pushing to main. Verify stops the run whose machine did it. A push to the default branch of a repo without a policy is refused and not recorded.
- **`deploys`, new.** A deploy of a repo's commit, who approved it, its steps' log, and how it ended: healthy, rolled back, or failed.
- **`runs.playbook`, `.paused_at`, `.paused_by`, `.pause_note` and the status `paused`.** The playbook the router picked, and a pause a person asked for.
- **New kinds.** Instances of kind `check` (the check host), stage kinds `route`, `verify`, `review` and `suite`, and command kinds `verify` and `suite`. The migration adds these to the lists already in the database, so other migrations that extend the same lists keep their values whichever runs first.

Durability, in `server/migrations/0010_durability.sql`. The design is `docs/design/durability.md`.

- **A `message` command stays claimed until its turn ends.** No schema change. A message is claimed when its machine hands it to the harness and done when the harness reports the end of the turn that took it in, so a machine that restarts finds every message it cut off. A turn can take in several messages, such as a person's follow-up sent while the agent works.
- **`asks.request_ended_at`.** An approval is answered through the harness request that raised it, and the request dies with its process. This is when that happened without the decision reaching it, set when the machine restarts, on an ask still open and on one whose decision was not yet delivered. A resumed session that asks again for the same tool and input takes over the ask, and a decision already given reaches it at once. When the turn ends, an ask still open, or one whose kept decision nobody took up, expires. Null while the request is alive or has its answer.
- **Recovery's events name their messages.** No schema change. An interrupted notice lists the message commands it cut off in `body.messages`, and recovery counts those notices to stop resuming a turn after three restarts. The text a resumed session is sent is a `user` event with no author and `body.resumes`, which the task page leaves out of its transcript.
- **Session status `lost`, used.** The agreed status now means a turn was in flight when its machine stopped, and nothing is working on it. The server sets it when the machine restarts or stops answering. No new value.

Coach and improve learn from checked evidence, in `server/migrations/0012_evidence.sql`. The design is `docs/design/evidence.md`.

- **`session_reads`, new.** How far each session has been read for evidence, so each event is read once.

  | Column | Type | What it holds |
  |---|---|---|
  | session_id | uuid, key | The session |
  | team_id | uuid | |
  | read_to_seq | bigint | The last step read |
  | run_id | uuid, optional | The run that read it |
  | read_at | time | |

- **`candidates`, new.** A correction no rule covers, with the gap findings that carry it. It persists across runs, and code counts it from its live findings each time.

  | Column | Type | What it holds |
  |---|---|---|
  | id | uuid, key | |
  | team_id | uuid | |
  | agent_id | uuid | The agent it is about |
  | correction | text | The rule that would have prevented it, as the reader first put it |
  | status | text | open, merged into another, or closed once a hunk for it was kept |
  | merged_into | uuid, optional | Set when merged |
  | run_id | uuid, optional | The run that first saw it |
  | created_at | time | |

- **`session_findings`, new.** A finding code kept: an exact quote, the event it came from, and what it shows. About an agent, or about a pipeline.

  | Column | Type | What it holds |
  |---|---|---|
  | id | uuid, key | |
  | team_id | uuid | |
  | agent_id, pipeline_id | uuid, one of them | What the evidence is about |
  | session_id | uuid | The session read |
  | event_id | bigint | The event quoted |
  | seq | bigint | Its step in the session |
  | kind | text | followed, ignored, harm or gap |
  | quote | text | Found in the event's stored text |
  | rule_hash, rule_text | text, optional | The agent's rule a followed, ignored or harm finding is about |
  | candidate_id | uuid, optional | The candidate an agent's gap belongs to |
  | note | text, optional | The correction for a gap, or what went wrong in a pipeline run |
  | fix | text, optional | For a gap: check when a lint rule, type or check could catch it, else text |
  | trigger | text, optional | For a narrow gap: when it applies |
  | source | text | person, pipeline or box, counted apart |
  | person_id | uuid, optional | Who made the correction, when a person did |
  | occasion | uuid | The session, or the run a stage session belongs to |
  | seen_at | time | The event's time. A finding counts for 90 days from it. |
  | run_id | uuid, optional | The run that recorded it |

  One row per subject, event, kind, rule and candidate, so a finding read twice is one finding.

- **`proposal_hunks`, new.** The hunks of a proposal. The server computed each one's text and diff. Each cites finding ids, and holds the decision on it, which is the team's memory.

  | Column | Type | What it holds |
  |---|---|---|
  | id | uuid, key | |
  | team_id | uuid | |
  | proposal_id | uuid | |
  | n | int | Its place in the proposal |
  | target | text | instructions, skill, profile, check or pipeline |
  | op | text | add, change or delete |
  | rule_hash | text, optional | The rule an instructions change or delete touches, or the one an add follows |
  | skill_name, skill_description | text, optional | For a skill hunk |
  | person_id | uuid, optional | For a profile hunk |
  | before, after, diff | text | The text it replaces, the text it writes, and the diff |
  | content_hash | text | sha256 of before. Settling refuses a skill hunk whose skill no longer has this content. |
  | after_hash | text | sha256 of after, so the memory knows the same change when it comes back on other findings |
  | finding_ids | uuid[] | The findings it cites |
  | occasions | int | Distinct occasions behind them |
  | counts | jsonb | Sessions by source, and people |
  | evidence | jsonb | The cited findings as they read when proposed |
  | decision | text, optional | accepted or rejected |
  | reason | text, optional | Why |
  | decided_by | uuid, optional | Who, or none when nobody did |
  | decided_at | time, optional | |

- **`session_replays`, new.** One replay of one turn, scoring a coach proposal.

  | Column | Type | What it holds |
  |---|---|---|
  | id | uuid, key | |
  | team_id | uuid | |
  | proposal_id | uuid | |
  | kind | text | behind, a case behind the change, or unrelated |
  | variant | text | change or current |
  | source_session_id | uuid | The session replayed |
  | upto_seq | bigint | The step the replay answers |
  | finding_id | uuid, optional | The finding a case behind the change checks |
  | label | text | What the judge sees instead of the variant. Unique among a proposal's replays that are not superseded. |
  | task_id, session_id | uuid | The replay's task and session |
  | status | text | running, replied or failed |
  | reply | text, optional | The replayed reply |
  | verdict | text, optional | fixed, still, ok or worse |
  | superseded_at | time, optional | Set when a retried replay stage started over. The row stays, so its session still counts toward the run's spend and is still treated as a replay. |
  | created_at, replied_at | time | |

- **`proposals.target` gains `agent`.** A coach proposal's hunks touch one agent's instructions, skills, profiles and checks. The targets `instructions` and `skill` stay for proposals already made.

Terminal sessions, in `server/migrations/0013_local_sessions.sql`. The design is in `docs/design/local-sessions.md`.

- **`connected_folders`, new.** A folder on a person's Mac whose Claude Code sessions land in the record: the team, the Mac, the folder's absolute path, who sees its sessions (`team` or `private`), the person who connected it, and when it was connected and disconnected. One row per Mac and path, reused when the folder is connected again. Only the Mac connects or disconnects a folder, with its machine token.
- **`sessions.folder_id` and `sessions.cwd`, new, and `sessions.agent_id` may be null.** A terminal session serves a connected folder, not a conversation or a task, and has no agent. `cwd` is the folder, or a folder inside it, that the session started in. One check replaces the old "a task or a conversation, never both": a session serves a conversation or a task and has an agent, or it serves a folder and has no agent, task, conversation or workspace, but has a `cwd` and Claude's session id.
- **`sessions` unique on `(instance_id, harness_session_id)` for terminal sessions.** One record session per Claude Code session on a Mac, so a daemon that reads a transcript twice gets the same session back.
- **Used for the first time, with no schema change.** A `user` event can come from a machine, in a terminal session only. Its author is the folder's person.

One door for turns, in `server/migrations/0014_door.sql`. The design is "A scheduler places every turn" in `docs/design/target-architecture.md`, step 1 of its build order.

- **`turns` holds every turn an agent is asked to take, not only a room's.** Each row says who asked and what for, carries what any place needs to run the turn, and moves through one lifecycle, the transition table in `shared/turns.ts`. `server/scheduler.ts` is the only writer of message commands.
  - `source`: `person`, `room`, `routine` or `pipeline`. Rows from before are rooms'.
  - `conversation_id`, `task_id` or `run_id`, exactly one. A person's message in a DM and a routine's firing are for a conversation, and so is a room's turn. A person's message to a task's session is for the task. A pipeline's stage, its reminder to report and a coach replay are for the run. `conversation_id` may now be null.
  - `routine_id`, the routine a firing came from, so each firing is a row. Null once the routine is deleted.
  - `asked_by_person`, whose message or click asked for the turn. Null for a pipeline's turns and for a routine that came due.
  - `session_id`, `event_id` and `payload`: the session the turn's record goes to, the user event that holds its prompt, and what the engine is handed, the payload its message command gets. A room's turn gets them when the room gives it its go.
  - `status`: `queued`, `waiting`, `placed`, `running`, `done`, `failed` or `cancelled`. A turn is queued until it has a prompt, waits while its machine can't take it, is placed when its message command is written, runs once its machine takes the command, and ends as the command ends. A room's turn whose deadline passes while it waits is cancelled, and so is one whose agent has no machine.
  - `wait`, set only while a turn waits: `computer_starting` for a box the server starts, which is a person's own box or a box a person or a run holds, and `machine_offline` for a Mac, or any other machine, that is not taking work.
  - `instance_id`, the machine the scheduler picked, and `command_id`, the message command it wrote there.
  - `placed_at`, when the command was written. `started_at` now means when the machine took the command, and `finished_at` when the command ended. A room's turn used to be started when the room gave it its go, and the room now reads its status for that.
  - `stuck_since`, set on a running turn whose session has had no new event for 10 minutes, to the time of the last one, and cleared when an event comes. Nothing is stopped.
  - `deadline` may now be null. Only a room's turns have one.
  - Rows from before keep their outcome. A started one gets its command, session, prompt event and payload from the message command whose event names it, and its status from that command's.
- **`instances.ready`.** The machine's daemon has reported in, with `POST /v1/instance/recover`, since it last said it was going offline, so it takes commands now. A turn is placed only on a machine that is online and ready. A daemon calls recover once its desktop is up, so a box that is starting is not ready. Machines online at the migration start ready.
- **`instances.stopped_at`.** When the runner stopped a person's own box for having nothing to do. Null while the box should run. An asleep box starts again when a turn waits for it, a command is queued for it, its owner starts a Claude sign-in, or a person holds its screen. Only a person's own box has one.
- **`instances.idle_since` for a person's own box.** When it was made or last woken. It stops once that and the end of its last turn are both more than `AGENTS_BOX_IDLE_MIN` ago, 30 minutes by default, and nothing above wants it. Boxes made before the migration get the time it ran.
