-- Onboarding. Inviting people, letting them in, a box for each person, and each
-- person's own Claude sign-in. Added while building, listed in
-- docs/data-model.md under "Added while building" for review. The design is in
-- docs/design/onboarding.md, and shared/onboarding.ts has each row's states.

-- An invite to join a team, made in the app. The person joins when they first
-- open the app with a Tailscale login equal to the email. The invite link is
-- never stored. Tailscale returns it when asked.
create table invites (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  email text not null check (email = lower(email) and email like '%_@_%'),
  role text not null default 'member' check (role in ('admin', 'member')),
  tailscale_invite_id text,
  invited_by uuid references people on delete set null,
  status text not null default 'open' check (status in ('open', 'joined', 'cancelled')),
  person_id uuid references people on delete set null,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  check ((status = 'open') = (closed_at is null)),
  check (status = 'joined' or person_id is null)
);
create unique index invites_open_email on invites (email) where status = 'open';

-- A login that opened the app while on no team and with no invite. Admins see
-- it and add it. It has no team, since the login is on none yet.
create table join_requests (
  id uuid primary key default gen_random_uuid(),
  login text not null unique,
  name text,
  status text not null default 'waiting' check (status in ('waiting', 'added')),
  person_id uuid references people on delete set null,
  added_by uuid references people on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  check (status = 'added' or (person_id is null and added_by is null))
);

-- A personal box belongs to one person for good. Runs never claim it, the box
-- limit does not count it, and it is never stopped for being idle. start_error
-- says why its container last failed to start.
alter table instances
  add column personal boolean not null default false,
  add column start_error text;
alter table instances add constraint instances_personal_box check (not personal or kind = 'box');
create unique index instances_one_personal on instances (owner_id) where personal;

-- One sign-in to Claude on a person's box. The person's code and the token
-- never come here. The code passes through the API's memory to the box, and the
-- token stays in the box's home volume.
create table claude_logins (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  instance_id uuid not null references instances on delete cascade,
  person_id uuid not null references people on delete cascade,
  status text not null default 'starting' check (status in (
    'starting', 'waiting_for_code', 'checking', 'signed_in', 'failed', 'cancelled'
  )),
  url text,
  note text,
  valid_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'starting' or url is null),
  check (status not in ('waiting_for_code', 'checking', 'signed_in') or url is not null),
  check (status <> 'failed' or note is not null),
  check (status not in ('starting', 'checking', 'signed_in', 'cancelled') or note is null),
  check ((status = 'signed_in') = (valid_until is not null))
);
create unique index claude_logins_open on claude_logins (instance_id)
  where status in ('starting', 'waiting_for_code', 'checking');

-- Nothing set people.role before, so no team had an admin. The person who made
-- each team, its earliest person, becomes one.
update people set role = 'admin'
where id in (
  select distinct on (team_id) id from people
  where team_id not in (select team_id from people where role = 'admin')
  order by team_id, created_at, id);
