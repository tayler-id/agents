-- Projects. Added while building, listed in docs/data-model.md under "Added
-- while building" for review. The design is in docs/design/projects.md.

-- A team's work on one thing: its repos, its room, and the tasks, runs,
-- documents and rooms made in it. Everyone on the team sees every project. Rows
-- from before projects have none and work as they did.
create table projects (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  description text not null default '',
  conversation_id uuid references conversations on delete set null,
  created_by uuid references people on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index projects_name on projects (team_id, lower(name)) where archived_at is null;

alter table repos
  -- The forge that holds the repo: this Mac's Gitea, or GitHub for project repos.
  add column forge text not null default 'gitea' check (forge in ('gitea', 'github')),
  add column project_id uuid references projects on delete set null,
  -- When the runner last asked GitHub about the repo's issues. GitHub can't reach
  -- this server, so new issues are found by polling, and a restart carries on here.
  add column polled_at timestamptz;

alter table tasks add column project_id uuid references projects on delete set null;
create index tasks_project on tasks (project_id) where project_id is not null;

alter table conversations
  add column project_id uuid references projects on delete set null,
  add constraint conversations_project_room check (project_id is null or kind = 'room');

-- A repo the app was asked to make on GitHub for a project. It is written before
-- GitHub is asked, so a crash or a refusal never leaves a repo nobody knows about:
-- each try looks the repo up first, and adopts one an earlier try made.
create table repo_requests (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  project_id uuid not null references projects on delete cascade,
  -- The GitHub organization or account the repo goes under, as connected when it was asked for.
  owner text not null,
  -- The characters GitHub allows in a repo name.
  name text not null check (name ~ '^[A-Za-z0-9._-]{1,100}$'),
  description text not null default '',
  status text not null default 'creating' check (status in ('creating', 'done', 'failed')),
  error text,
  repo_id uuid references repos on delete set null,
  requested_by uuid references people on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Only a failed request has an error, and only a done one a repo. A done
  -- request's repo is null again if that repo is removed later.
  check ((status = 'failed') = (error is not null)),
  check (status = 'done' or repo_id is null)
);
-- GitHub's names ignore case. A repo is asked for once per team.
create unique index repo_requests_name on repo_requests (team_id, lower(owner), lower(name));
