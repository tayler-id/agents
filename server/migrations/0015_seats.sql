-- Seats: each agent's own display, browser and screen on a computer. Listed in
-- docs/data-model.md under "Added while building" for review. The design is
-- "Seats" in docs/design/target-architecture.md.

-- A box's size. Every box keeps the 1 seat, 2 CPUs and 4 GiB a box had before
-- seats, and a person's computer gets more below. A Mac or a check host runs no
-- container, so nothing reads its size.
alter table instances
  add column seat_cap int not null default 1 check (seat_cap between 1 and 16),
  add column cpus int not null default 2 check (cpus > 0),
  add column memory_gib int not null default 4 check (memory_gib > 0);

-- One row for each seat a computer has. Inside the computer seat n has display
-- :n and its browser's DevTools port 9221 + n, so seat 1 keeps the display :1
-- and port 9222 a box had before seats, and 16 seats end below port 9238.
create table seats (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  instance_id uuid not null references instances on delete cascade,
  n int not null check (n between 1 and 16),
  -- The agent holding the seat. A free seat holds none.
  agent_id uuid references agents,
  status text not null default 'free' check (status in ('free', 'starting', 'ready')),
  held_since timestamptz,
  -- When the seat's agent last started a turn on it, which the reclaim rule reads.
  last_turn_at timestamptz,
  unique (instance_id, n),
  check ((status = 'free') = (agent_id is null)),
  check ((agent_id is null) = (held_since is null))
);
-- An agent holds at most one seat on a computer.
create unique index seats_agent on seats (instance_id, agent_id) where agent_id is not null;

-- Every box has seats 1 to its seat cap, however it was added: by a person
-- joining, a run claiming a box, the admin script or a check's own insert. A
-- smaller cap takes the seats past it away.
create function instance_seats() returns trigger language plpgsql as $$
begin
  if new.kind = 'box' then
    insert into seats (team_id, instance_id, n)
    select new.team_id, new.id, n from generate_series(1, new.seat_cap) as n
    on conflict (instance_id, n) do nothing;
    delete from seats where instance_id = new.id and n > new.seat_cap;
  end if;
  return null;
end $$;
create trigger instance_seats after insert or update of seat_cap on instances
  for each row execute function instance_seats();

insert into seats (team_id, instance_id, n)
select i.team_id, i.id, n from instances i, generate_series(1, i.seat_cap) as n where i.kind = 'box';

-- A person's computer holds 4 seats in 4 CPUs and 8 GiB, as Tayler decided on
-- 2026-10-15. The trigger adds the seats.
update instances set seat_cap = 4, cpus = 4, memory_gib = 8 where kind = 'box' and personal;

-- The seat a session last ran on. A box session with none ran on seat 1, as every
-- session on a box did before seats.
alter table sessions add column seat_id uuid references seats on delete set null;
create index sessions_seat on sessions (seat_id) where seat_id is not null;

-- A person takes over one seat's screen. Takeovers from before seats were of a
-- box's one screen, which is seat 1's. Code with seats always sets the seat.
-- The column stays nullable while branches from before seats run their checks
-- on the shared test database, and their takeovers keep one open per machine.
alter table screen_takeovers add column seat_id uuid references seats on delete cascade;
update screen_takeovers t set seat_id = s.id from seats s where s.instance_id = t.instance_id and s.n = 1;
drop index screen_takeovers_open;
create unique index screen_takeovers_open on screen_takeovers (seat_id) where ended_at is null;
create unique index screen_takeovers_open_unseated on screen_takeovers (instance_id) where ended_at is null and seat_id is null;
