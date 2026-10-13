# Data model

The working copy is the shared doc "Multiplayer agents data model": https://claude.ai/code/artifact/7f0197fc-d2d9-4f0b-b528-993c059787f5. It has every table, the states, and the diagram.

Tayler agrees each part there before any table is built. Agreed parts are copied here, and they become migrations in `server/`.

We copy the product we studied, not its name, and everything it runs is an **agent**.

## Agreed

### The shape

Everything lives in one app. Conversations are where the team and its agents talk. Work happens inside it, using HumanLayer's model: tasks, sessions, workspaces and artifacts, usually started from a conversation. Every session's events go into the shared record, which every agent can search. Pipelines run on top.

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

One entry in a session's record. Events are only added, never rewritten, except to redact a leaked secret. Every event is kept whole in Postgres, as HumanLayer does.

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
