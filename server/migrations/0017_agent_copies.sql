-- Agent hooks and copies. Described in docs/data-model.md, and the design is
-- "Templates, sharing and cloning" in docs/design/target-architecture.md.

-- The Claude Code hooks an agent's setup names. The daemon writes them to the
-- session folder's .claude/settings.local.json. The events and the pattern of a
-- name match HOOK_EVENTS and NAME in shared/types.ts.
create table agent_hooks (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents on delete cascade,
  name text not null check (name ~ '^[a-z][a-z0-9-]{0,39}$'),
  event text not null check (event in ('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop')),
  -- Which tools a hook applies to, for the two events that run around a tool.
  matcher text check (matcher is null or (event in ('PreToolUse', 'PostToolUse') and matcher <> '' and length(matcher) <= 200)),
  command text not null check (command <> '' and length(command) <= 2000),
  timeout_sec int check (timeout_sec is null or timeout_sec between 1 and 600),
  created_at timestamptz not null default now(),
  unique (agent_id, name)
);

-- The agent a copy was made from. It is none for an agent made any other way.
alter table agents add column copied_from_agent_id uuid references agents on delete set null;
