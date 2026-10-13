-- The agreed data model. See docs/data-model.md and the shared doc it links.
-- The API is the only writer. Our own ids are the keys.

-- People and machines

create table teams (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

-- login is the Tailscale login that tailscale serve passes on.
create table people (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  login text not null unique,
  name text,
  role text not null default 'member' check (role in ('admin', 'member')),
  created_at timestamptz not null default now()
);

create table instances (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  name text not null,
  kind text not null check (kind in ('mac', 'box')),
  owner_id uuid references people on delete set null,
  token_sha256 text not null unique,
  harnesses text[] not null default '{claude}',
  status text not null default 'offline' check (status in ('online', 'stale', 'offline')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (team_id, name)
);

create table repos (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  remote_url text not null,
  default_branch text not null default 'main',
  setup_command text,
  created_at timestamptz not null default now(),
  unique (team_id, remote_url)
);

-- Agents

create table agents (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  name text not null,
  title text,
  role text,
  avatar jsonb,
  voice jsonb,
  instructions text not null default '',
  harness text not null default 'claude' check (harness in ('claude', 'codex')),
  model text,
  effort text,
  home_instance_id uuid references instances on delete set null,
  owner_id uuid references people on delete set null,
  visibility text not null default 'owner' check (visibility in ('owner', 'team')),
  published_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index agents_name on agents (team_id, name) where archived_at is null;

create table agent_managers (
  agent_id uuid not null references agents on delete cascade,
  person_id uuid not null references people on delete cascade,
  primary key (agent_id, person_id)
);

create table memories (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  agent_id uuid not null references agents on delete cascade,
  scope text not null check (scope in ('person', 'team')),
  person_id uuid references people on delete cascade,
  kind text not null check (kind in ('profile', 'log')),
  log_date date,
  content text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope = 'person') = (person_id is not null)),
  check ((kind = 'log') = (log_date is not null))
);
create unique index memories_one_profile on memories (agent_id, scope, person_id) nulls not distinct
  where kind = 'profile';

create table skills (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  agent_id uuid references agents on delete cascade,
  name text not null,
  description text not null default '',
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table plugins (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents on delete cascade,
  name text not null,
  kind text not null check (kind in ('stdio', 'http')),
  config jsonb not null,
  created_at timestamptz not null default now(),
  unique (agent_id, name)
);

-- Secret names only. Values never enter Postgres.
create table secrets (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  scope text not null check (scope in ('person', 'team', 'agent')),
  person_id uuid references people on delete cascade,
  agent_id uuid references agents on delete cascade,
  name text not null check (name ~ '^[A-Z][A-Z0-9_]*$'),
  description text,
  stored_in text not null,
  created_at timestamptz not null default now(),
  check ((scope = 'person') = (person_id is not null)),
  check ((scope = 'agent') = (agent_id is not null))
);

create table routines (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents on delete cascade,
  name text not null,
  prompt text not null,
  trigger text not null check (trigger in ('cron', 'webhook', 'github', 'linear', 'slack', 'email')),
  trigger_config jsonb not null default '{}',
  enabled boolean not null default true,
  last_fired_at timestamptz,
  created_at timestamptz not null default now()
);

create table templates (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  name text not null,
  version int not null default 1,
  recipe jsonb not null,
  share_slug text not null unique,
  visibility text not null default 'team' check (visibility in ('public', 'team')),
  created_at timestamptz not null default now()
);

-- Conversations

create table conversations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  kind text not null check (kind in ('main', 'dm', 'room', 'pr', 'slack_thread')),
  name text,
  avatar jsonb,
  agent_id uuid references agents on delete cascade,
  source text,
  visibility text not null default 'team' check (visibility in ('team', 'private')),
  last_seq bigint not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  check (kind not in ('main', 'dm') or agent_id is not null)
);

create table conversation_members (
  id bigserial primary key,
  team_id uuid not null references teams on delete cascade,
  conversation_id uuid not null references conversations on delete cascade,
  person_id uuid references people on delete cascade,
  agent_id uuid references agents on delete cascade,
  last_read_seq bigint not null default 0,
  joined_at timestamptz not null default now(),
  check ((person_id is null) <> (agent_id is null))
);
create unique index conversation_members_person on conversation_members (conversation_id, person_id)
  where person_id is not null;
create unique index conversation_members_agent on conversation_members (conversation_id, agent_id)
  where agent_id is not null;

-- Work

create table tasks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  slug text not null,
  title text not null,
  instructions text not null default '',
  owner_id uuid references people on delete set null,
  agent_id uuid references agents on delete set null,
  conversation_id uuid references conversations on delete set null,
  source_message_id uuid,
  phase text,
  source text,
  visibility text not null default 'team' check (visibility in ('team', 'private')),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (team_id, slug)
);

create table task_members (
  task_id uuid not null references tasks on delete cascade,
  person_id uuid not null references people on delete cascade,
  role text not null check (role in ('edit', 'comment')),
  primary key (task_id, person_id)
);

create table task_repos (
  task_id uuid not null references tasks on delete cascade,
  repo_id uuid not null references repos on delete cascade,
  is_primary boolean not null default false,
  primary key (task_id, repo_id)
);

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  task_id uuid not null references tasks on delete cascade,
  instance_id uuid not null references instances on delete cascade,
  path text not null,
  status text not null default 'creating' check (status in ('creating', 'ready', 'removed')),
  created_at timestamptz not null default now()
);

create table worktrees (
  workspace_id uuid not null references workspaces on delete cascade,
  repo_id uuid not null references repos on delete cascade,
  branch text not null,
  base_commit text,
  primary key (workspace_id, repo_id)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  task_id uuid references tasks on delete cascade,
  conversation_id uuid references conversations on delete cascade,
  workspace_id uuid references workspaces on delete set null,
  instance_id uuid not null references instances on delete cascade,
  agent_id uuid not null references agents on delete cascade,
  stage text,
  started_by uuid references people on delete set null,
  started_by_session uuid references sessions on delete set null,
  harness text not null default 'claude',
  harness_session_id text,
  model text,
  status text not null default 'starting' check (status in (
    'draft', 'starting', 'running', 'idle', 'needs_input', 'needs_approval', 'limited', 'lost', 'failed'
  )),
  last_seq bigint not null default 0,
  cost_usd numeric(12, 4),
  turns int not null default 0,
  last_active_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  -- A session serves a task or a conversation, never both.
  check ((task_id is null) <> (conversation_id is null))
);
create index sessions_conversation on sessions (conversation_id, agent_id) where archived_at is null;

-- The record

create table events (
  id bigserial primary key,
  team_id uuid not null references teams on delete cascade,
  session_id uuid not null references sessions on delete cascade,
  seq bigint not null,
  updated_seq bigint not null,
  kind text not null check (kind in (
    'user', 'assistant', 'thinking', 'tool_call', 'tool_result', 'ask', 'answer', 'notice', 'error', 'usage'
  )),
  author uuid references people on delete set null,
  parent_tool_use_id text,
  tool_use_id text,
  tool_name text,
  text text,
  body jsonb not null,
  client_id text not null,
  created_at timestamptz not null default now(),
  unique (session_id, seq),
  unique (session_id, client_id)
);
-- Search is an index rather than a column, so sync never carries it.
create index events_search on events using gin (to_tsvector('english', coalesce(text, '')));
create index events_tool_use on events (session_id, tool_use_id) where tool_use_id is not null;

-- Claude's raw output lines, keyed by Claude's own line id so a resumed session never collides.
create table raw_events (
  id bigserial primary key,
  session_id uuid not null references sessions on delete cascade,
  client_id text not null,
  line jsonb not null,
  created_at timestamptz not null default now(),
  unique (session_id, client_id)
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  conversation_id uuid not null references conversations on delete cascade,
  seq bigint not null,
  speaker text not null check (speaker in ('person', 'agent')),
  person_id uuid references people on delete set null,
  agent_id uuid references agents on delete set null,
  body text not null,
  quoted_message_id uuid references messages on delete set null,
  session_id uuid references sessions on delete set null,
  event_id bigint references events on delete set null,
  task_id uuid references tasks on delete set null,
  client_id text not null,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (conversation_id, seq),
  unique (conversation_id, client_id)
);
create index messages_search on messages using gin (to_tsvector('english', body));

alter table tasks add constraint tasks_source_message
  foreign key (source_message_id) references messages on delete set null;

create table turns (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  conversation_id uuid not null references conversations on delete cascade,
  agent_id uuid not null references agents on delete cascade,
  requested_at timestamptz not null default now(),
  deadline timestamptz not null,
  winding_down boolean not null default false,
  outcome text check (outcome in ('sent', 'pass', 'skipped', 'timeout', 'cancelled', 'error')),
  finished_at timestamptz
);

-- Work for a machine. Its daemon claims these and reports back.
create table commands (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  instance_id uuid not null references instances on delete cascade,
  session_id uuid references sessions on delete cascade,
  kind text not null check (kind in (
    'start', 'message', 'interrupt', 'stop', 'answer', 'exec', 'setup_workspace', 'remove_workspace'
  )),
  payload jsonb not null default '{}',
  event_id bigint references events on delete set null,
  status text not null default 'queued' check (status in ('queued', 'claimed', 'done', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  done_at timestamptz
);
create index commands_open on commands (instance_id, created_at) where status in ('queued', 'claimed');

-- Artifacts and comments

create table artifacts (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  task_id uuid not null references tasks on delete cascade,
  kind text not null check (kind in ('document', 'link')),
  path text,
  title text not null,
  made_by_session uuid references sessions on delete set null,
  made_by_person uuid references people on delete set null,
  url text,
  state text,
  current_version int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'document' or path is not null),
  check (kind <> 'link' or url is not null)
);

create table artifact_versions (
  artifact_id uuid not null references artifacts on delete cascade,
  version int not null,
  content text not null,
  author_session uuid references sessions on delete set null,
  author_person uuid references people on delete set null,
  created_at timestamptz not null default now(),
  primary key (artifact_id, version)
);
create index artifact_versions_search on artifact_versions using gin (to_tsvector('english', content));

create table comments (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  artifact_id uuid not null references artifacts on delete cascade,
  version int not null,
  anchor jsonb,
  parent_id uuid references comments on delete cascade,
  author_person uuid references people on delete set null,
  author_session uuid references sessions on delete set null,
  body text not null,
  status text not null default 'open' check (status in ('open', 'resolved', 'outdated')),
  sent_to_session uuid references sessions on delete set null,
  created_at timestamptz not null default now()
);

-- Pipelines

create table pipelines (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  repo_id uuid references repos on delete set null,
  name text not null,
  path text not null,
  created_at timestamptz not null default now(),
  unique (team_id, name)
);

create table pipeline_versions (
  id uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references pipelines on delete cascade,
  git_sha text not null,
  created_at timestamptz not null default now(),
  unique (pipeline_id, git_sha)
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  pipeline_version_id uuid not null references pipeline_versions on delete cascade,
  task_id uuid not null references tasks on delete cascade,
  trigger text not null,
  trigger_payload jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled')),
  stage text,
  metrics jsonb not null default '{}',
  cost_usd numeric(12, 4),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create table proposals (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  pipeline_id uuid not null references pipelines on delete cascade,
  base_version_id uuid not null references pipeline_versions on delete cascade,
  diff text not null,
  scores jsonb not null default '{}',
  status text not null default 'open' check (status in ('open', 'approved', 'rejected')),
  decided_by uuid references people on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

-- Asks: anything that waits on a person

create table asks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  kind text not null check (kind in (
    'tool_approval', 'gate', 'question', 'form', 'draft', 'secret_request', 'connector_grant', 'credential_request'
  )),
  session_id uuid references sessions on delete cascade,
  run_id uuid references runs on delete cascade,
  conversation_id uuid references conversations on delete set null,
  message_id uuid references messages on delete set null,
  tool_use_id text,
  payload jsonb not null default '{}',
  status text not null default 'open' check (status in ('open', 'answered', 'expired')),
  answer jsonb,
  answered_by uuid references people on delete set null,
  answered_at timestamptz,
  created_at timestamptz not null default now()
);

create table approval_rules (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  instance_id uuid references instances on delete cascade,
  agent_id uuid references agents on delete cascade,
  tool_name text not null,
  pattern text,
  decision text not null check (decision in ('allow', 'deny')),
  created_by uuid references people on delete set null,
  created_at timestamptz not null default now()
);
