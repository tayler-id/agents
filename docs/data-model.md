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

The work layer, in `server/migrations/0007_workflow.sql`. The design is in `docs/design/workflow.md`.

- **`file_changes`, new.** One row per file that differs from the base branch in one of a task workspace's repos. It holds the status (added, modified or deleted), the line counts, whether the file is binary or too large to show, its content now and its diff against the base, both scrubbed on the machine. It is the workspace's current state, so a row goes once its file stops differing. The task page lists these as Changes and opens each one beside the task.
- **`unlisted_changes`, new.** One row per repo of a task workspace whose changes the machine did not list: `too_many`, past the 20,000 files it lists, or `unreadable`, when git failed on the repo, with git's reason scrubbed. A repo with too many loses its `file_changes` rows, and an unreadable one keeps its last list. The row goes once the repo is listed again.
- **`pushes`, new.** One row each time a person asks to open pull requests from a task. It holds the push command it sent, who asked, the title and description, and how it ended, as `pushing`, `done` or `failed`. One push may be in flight per task. The pull requests it opens are link artifacts on the task, as a run's are.
- **`task_blocks`, new.** One row per edge between two tasks of a team: the blocked task, the task blocking it, an optional one-line reason, who added it and when. A task is blocked while a task blocking it is neither done nor discarded. The API refuses an edge to the task itself or one that closes a cycle, and refuses to discard a task that still blocks queued or active work.
- **`task_holds`, new.** At most one hold per task: its kind (`decision`, `external`, `load`, `parked` or `future`), a one-line reason, an optional until date it lapses on, who held it and when. A held task stays out of the ready query until the hold lapses or someone lifts it.
- **`tasks.priority` and `tasks.done_at`, new.** Priority runs from 0, the most urgent, to 4, and is 2 unless set. `done_at` is when someone marked the task done. With the draft status and `archived_at` they give a task its state, queued, active, done or discarded. The ready query lists the queued tasks that nothing blocks or holds, by priority and then age.
- **Used for the first time, with no schema change.** A session with the agreed `draft` status is a task saved to start later. `comments.anchor` gains `occurrence`, which match of the quote a comment means. A push command's repos carry their `base`, and its result says how many commits each repo is `ahead`. A message command carries `permissions`, what its session may do without asking.

Durability, in `server/migrations/0010_durability.sql`. The design is `docs/design/durability.md`.

- **A `message` command stays claimed until its turn ends.** No schema change. A message is claimed when its machine hands it to the harness and done when the harness reports the end of the turn that took it in, so a machine that restarts finds every message it cut off. A turn can take in several messages, such as a person's follow-up sent while the agent works.
- **`asks.request_ended_at`.** An approval is answered through the harness request that raised it, and the request dies with its process. This is when that happened without the decision reaching it, set when the machine restarts, on an ask still open and on one whose decision was not yet delivered. A resumed session that asks again for the same tool and input takes over the ask, and a decision already given reaches it at once. When the turn ends, an ask still open, or one whose kept decision nobody took up, expires. Null while the request is alive or has its answer.
- **Recovery's events name their messages.** No schema change. An interrupted notice lists the message commands it cut off in `body.messages`, and recovery counts those notices to stop resuming a turn after three restarts. The text a resumed session is sent is a `user` event with no author and `body.resumes`, which the task page leaves out of its transcript.
- **Session status `lost`, used.** The agreed status now means a turn was in flight when its machine stopped, and nothing is working on it. The server sets it when the machine restarts or stops answering. No new value.
