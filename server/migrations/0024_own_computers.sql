-- Every person has their own computer, and a turn can wait for a seat. Tayler's
-- call of 2026-10-16 is "Every agent has its own desktop, with no setup" in
-- docs/decisions.md, and docs/data-model.md says what changes. Running it
-- again changes nothing. Agents whose home is a Mac do not move here. A computer
-- with no Claude login or no built image cannot run them, so `move-agents` in
-- server/admin.ts moves them once it can (server/rehome.ts).

-- A turn on a person's computer waits for a seat while every seat is busy.
alter table turns drop constraint if exists turns_wait_check;
alter table turns add constraint turns_wait_check check (wait in ('computer_starting', 'machine_offline', 'seat'));

-- A computer for each person who has none, made as addPersonalBox in
-- server/boxes.ts makes one when a person joins: named box- and the part of
-- their login before the @, then with -2 to -9, then with a random suffix, with
-- 4 seats in 4 CPUs and 8 GiB, and held by its owner. It starts asleep, so the
-- runner starts it only once something needs it, such as a turn for an agent
-- that moved to it, not every computer at once. Its token is a placeholder
-- until the runner starts its container with a real one.
do $$
declare
  person record;
  base text;
  candidate text;
begin
  for person in
    select p.id, p.team_id, p.login from people p
    where not exists (select 1 from instances i where i.owner_id = p.id and i.personal)
    order by p.created_at, p.id
  loop
    base := 'box-' || coalesce(nullif(left(trim(both '-' from regexp_replace(lower(split_part(person.login, '@', 1)), '[^a-z0-9]+', '-', 'g')), 24), ''), 'person');
    for attempt in 1..10 loop
      candidate := case when attempt = 1 then base when attempt < 10 then base || '-' || attempt else base || '-' || left(md5(random()::text), 6) end;
      insert into instances (team_id, name, kind, owner_id, token_sha256, claimed_by, claimed_at, personal, seat_cap, cpus, memory_gib, idle_since, stopped_at)
      values (person.team_id, candidate, 'box', person.id, encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), person.id, now(), true, 4, 4, 8, now(), now())
      on conflict (team_id, name) do nothing;
      exit when found;
      if attempt = 10 then
        raise exception 'no free name for the computer of %', person.login;
      end if;
    end loop;
  end loop;
end $$;
