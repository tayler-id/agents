-- Phase 2, the factory. Added while building, listed in docs/data-model.md under
-- "Added while building" for review.

-- A pipeline version is the pipeline file's content. git_sha is git's blob id for
-- that content, so the same file always gets the same version.
alter table pipeline_versions
  add column source text not null default '',
  add column error text;

-- Each pipeline posts its runs' progress and gates into one room, where the
-- shepherd and the rest of the team see them.
alter table pipelines
  add column description text not null default '',
  add column current_version_id uuid references pipeline_versions on delete set null,
  add column conversation_id uuid references conversations on delete set null,
  add column shepherd_id uuid references people on delete set null,
  add column cron_checked_at timestamptz;

alter table runs add column note text;
create index runs_active on runs (status) where status in ('queued', 'running', 'waiting');
-- One run per source event, such as one issue on one repo for one pipeline, even
-- when the same webhook arrives twice.
create unique index runs_once on runs (team_id, (trigger_payload->>'once')) where trigger_payload ? 'once';

-- One row per try at a stage: an agent's turn, a check run in the workspace, an
-- action on the forge, or a gate that waits on a person. An agent stage that
-- loops back keeps its session, so every try of it shares one session_id.
create table run_stages (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  run_id uuid not null references runs on delete cascade,
  n int not null,
  stage text not null,
  attempt int not null,
  kind text not null check (kind in ('agent', 'check', 'action', 'gate', 'handoff')),
  status text not null default 'pending' check (status in ('pending', 'running', 'waiting', 'done', 'failed', 'cancelled')),
  session_id uuid references sessions on delete set null,
  from_seq bigint,
  command_id uuid references commands on delete set null,
  ask_id uuid references asks on delete set null,
  outcome text,
  summary text,
  data jsonb not null default '{}',
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, n)
);

-- A document is one file in a task's folder, kept as numbered versions.
create unique index artifacts_document on artifacts (task_id, path) where kind = 'document';

-- What a machine reports back when it finishes a command, such as a check's
-- exit code or the commit a push sent.
alter table commands add column result jsonb;
alter table commands drop constraint commands_kind_check;
alter table commands add constraint commands_kind_check check (kind in (
  'start', 'message', 'interrupt', 'stop', 'answer', 'exec', 'push', 'setup_workspace', 'remove_workspace'
));

-- A box is claimed by a person or by a run, and released when the work ends.
alter table instances
  add column claimed_by uuid references people on delete set null,
  add column claimed_by_run uuid references runs on delete set null,
  add column claimed_at timestamptz,
  add column idle_since timestamptz;
