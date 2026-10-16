-- Attachments, reactions and message actions. The design is in docs/data-model.md,
-- "Attachments, reactions and message actions". The file bytes live outside
-- Postgres, in AGENTS_ATTACHMENTS_DIR, one file per row named by the row's id.

create table attachments (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  conversation_id uuid references conversations on delete cascade,
  session_id uuid references sessions on delete cascade,
  message_id uuid references messages on delete cascade,
  event_id bigint references events on delete cascade,
  kind text not null check (kind in ('image', 'file')),
  name text not null,
  media_type text not null,
  size bigint not null check (size between 1 and 26214400),
  width integer,
  height integer,
  added_by_person uuid references people on delete set null,
  added_by_agent uuid references agents on delete set null,
  created_at timestamptz not null default now(),
  check (conversation_id is null or session_id is null),
  check (message_id is null or conversation_id is not null),
  check (event_id is null or session_id is not null),
  check (message_id is null or event_id is null),
  check ((width is null) = (height is null))
);
create index attachments_conversation on attachments (conversation_id) where conversation_id is not null;
create index attachments_session on attachments (session_id) where session_id is not null;
create index attachments_message on attachments (message_id) where message_id is not null;
create index attachments_pending on attachments (created_at) where message_id is null and event_id is null;

create table reactions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  conversation_id uuid references conversations on delete cascade,
  session_id uuid references sessions on delete cascade,
  message_id uuid references messages on delete cascade,
  event_id bigint references events on delete cascade,
  emoji text not null check (octet_length(emoji) between 1 and 32),
  person_id uuid references people on delete cascade,
  agent_id uuid references agents on delete cascade,
  created_at timestamptz not null default now(),
  told_agent_at timestamptz,
  check ((message_id is not null) <> (event_id is not null)),
  check ((message_id is null) or (conversation_id is not null and session_id is null)),
  check ((event_id is null) or (session_id is not null and conversation_id is null)),
  check ((person_id is not null) <> (agent_id is not null))
);
create unique index reactions_message_person on reactions (message_id, emoji, person_id) where message_id is not null and person_id is not null;
create unique index reactions_message_agent on reactions (message_id, emoji, agent_id) where message_id is not null and agent_id is not null;
create unique index reactions_event_person on reactions (event_id, emoji, person_id) where event_id is not null and person_id is not null;
create unique index reactions_event_agent on reactions (event_id, emoji, agent_id) where event_id is not null and agent_id is not null;
create index reactions_conversation on reactions (conversation_id) where conversation_id is not null;
create index reactions_session on reactions (session_id) where session_id is not null;

create table message_versions (
  id bigserial primary key,
  message_id uuid not null references messages on delete cascade,
  body text not null,
  edited_by uuid references people on delete set null,
  replaced_at timestamptz not null default now()
);
create index message_versions_message on message_versions (message_id);

create table pins (
  conversation_id uuid not null references conversations on delete cascade,
  message_id uuid not null references messages on delete cascade,
  team_id uuid not null references teams on delete cascade,
  pinned_by uuid references people on delete set null,
  created_at timestamptz not null default now(),
  primary key (conversation_id, message_id)
);

alter table messages alter column body drop not null;
alter table messages add column deleted_by uuid references people on delete set null;
alter table messages add constraint messages_deleted_has_no_body check ((deleted_at is null) = (body is not null));
