-- Agent computers. Added while building, listed in docs/data-model.md under
-- "Added while building" for review. The design is docs/design/computers.md.

-- The size of the screen a machine reports on its heartbeat, or null when it
-- has none.
alter table instances
  add column screen_width int check (screen_width > 0),
  add column screen_height int check (screen_height > 0),
  add constraint instances_screen_size check ((screen_width is null) = (screen_height is null));

-- Each time a person held a machine's screen. The open row is who holds it now.
-- With no open row, the agents on the machine hold it.
create table screen_takeovers (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  instance_id uuid not null references instances on delete cascade,
  person_id uuid not null references people on delete cascade,
  -- The session the person was looking at when they took over, if any.
  session_id uuid references sessions on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by text check (ended_by in ('handed_back', 'left')),
  check ((ended_at is null) = (ended_by is null))
);
create unique index screen_takeovers_open on screen_takeovers (instance_id) where ended_at is null;

-- The bytes of image documents, once per team and content. They live apart from
-- artifact_versions because Electric follows every column of a table a shape
-- reads, and this table is never a shape. The size limit matches
-- MAX_IMAGE_BYTES in shared/documents.ts.
create table blobs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  media_type text not null check (media_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  size_bytes int not null check (size_bytes between 1 and 5242880),
  data bytea not null,
  created_at timestamptz not null default now(),
  check (octet_length(data) = size_bytes),
  unique (team_id, sha256)
);

-- An image version points at its bytes and has no text. A version is text or
-- an image, never both.
alter table artifact_versions
  add column blob_id uuid references blobs,
  add constraint artifact_versions_text_or_image check (blob_id is null or content = '');
