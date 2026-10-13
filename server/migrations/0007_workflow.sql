-- The work layer: what changed in a task's workspace, and the pull requests a
-- person asks for. Added while building, listed in docs/data-model.md under
-- "Added while building" for review. The design is docs/design/workflow.md, and
-- the row shapes are in shared/work.ts.

-- Each file that differs from the base branch in one of a workspace's repos, as
-- the workspace's machine last saw it. The machine scrubs the content and the
-- diff before they leave it. A row goes once its file no longer differs, so the
-- table is the workspace's current state, not its history.
create table file_changes (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  task_id uuid not null references tasks on delete cascade,
  workspace_id uuid not null references workspaces on delete cascade,
  repo_id uuid not null references repos on delete cascade,
  path text not null,
  status text not null check (status in ('added', 'modified', 'deleted')),
  additions int not null default 0 check (additions >= 0),
  deletions int not null default 0 check (deletions >= 0),
  -- What the app can show: the text and its diff, or neither for a binary file
  -- or one too large to read in a panel.
  preview text not null check (preview in ('text', 'binary', 'too_large')),
  -- The file as it is now, and git's unified diff of it against base_commit.
  content text,
  diff text,
  base_commit text not null,
  -- The old blob, the new blob and the status, so the machine resends a file
  -- only when it changed.
  hash text not null,
  updated_at timestamptz not null default now(),
  unique (workspace_id, repo_id, path),
  check ((preview = 'text') = (diff is not null)),
  check ((preview = 'text' and status <> 'deleted') = (content is not null))
);
create index file_changes_task on file_changes (task_id);

-- A person asked for a task's branches to be pushed and its pull requests
-- opened. The push command does the pushing, the runner opens the pull requests
-- once it ends, and they become link artifacts on the task.
create table pushes (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  task_id uuid not null references tasks on delete cascade,
  workspace_id uuid not null references workspaces on delete cascade,
  command_id uuid references commands on delete set null,
  requested_by uuid references people on delete set null,
  title text not null,
  body text not null,
  status text not null default 'pushing' check (status in ('pushing', 'done', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  check ((status = 'failed') = (error is not null)),
  check ((status = 'pushing') = (finished_at is null))
);
-- One push in flight per task.
create unique index pushes_in_flight on pushes (task_id) where status = 'pushing';
