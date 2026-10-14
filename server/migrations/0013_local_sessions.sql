-- Claude Code sessions a person starts in their own terminal, in a folder they
-- connected on their Mac. Described in docs/data-model.md, and the design is
-- docs/design/local-sessions.md.

-- A folder on a person's Mac whose terminal sessions land in the record. Only
-- the Mac connects or disconnects it, with its machine token. Reconnecting a
-- folder reuses its row, so its earlier sessions keep their folder.
create table connected_folders (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  instance_id uuid not null references instances on delete cascade,
  -- Where the folder is on that Mac, absolute.
  path text not null check (path like '/%'),
  -- Who sees its sessions: the team, or only the person who connected it.
  visibility text not null default 'team' check (visibility in ('team', 'private')),
  connected_by uuid references people on delete set null,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  unique (instance_id, path)
);

-- A terminal session belongs to its folder and to no agent, task or
-- conversation. cwd is the folder, or a folder inside it, it started in.
alter table sessions add column folder_id uuid references connected_folders on delete cascade;
alter table sessions add column cwd text;
alter table sessions alter column agent_id drop not null;
alter table sessions drop constraint sessions_check;
alter table sessions add constraint sessions_serves_one check (case
  when folder_id is null then agent_id is not null and cwd is null and (task_id is null) <> (conversation_id is null)
  else agent_id is null and task_id is null and conversation_id is null and workspace_id is null
    and cwd is not null and harness_session_id is not null
end);
-- One record session per Claude Code session on a machine, so a daemon that
-- reads a transcript twice finds the session it made the first time.
create unique index sessions_terminal on sessions (instance_id, harness_session_id) where folder_id is not null;
create index sessions_folder on sessions (folder_id) where folder_id is not null;
