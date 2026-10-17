-- Where a secret's value was put from the app, never the value. The value goes
-- to the computer over its control connection and is stored nowhere else.
-- Described in docs/data-model.md, and the design is "Secrets set from the app"
-- in docs/design/target-architecture.md.

-- One row for each secret name a computer holds because someone set it from the
-- app. It is keyed by computer and name, since a computer keeps its values in
-- one file by name, shared by every agent on it.
create table secret_sets (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  instance_id uuid not null references instances on delete cascade,
  name text not null check (name ~ '^[A-Z][A-Z0-9_]*$' and length(name) <= 128),
  set_by uuid references people on delete set null,
  set_at timestamptz not null default now(),
  unique (instance_id, name)
);
