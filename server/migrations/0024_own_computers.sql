-- Every person has their own computer, and agents whose home is a Mac move to
-- their person's computer. Tayler's call of 2026-10-16 is "Every agent has its
-- own desktop, with no setup" in docs/decisions.md, and docs/data-model.md says
-- what changes. It changes rows only, and running it again changes nothing.

-- A computer for each person who has none, made as addPersonalBox in
-- server/boxes.ts makes one when a person joins: named box- and the part of
-- their login before the @, then with -2 to -9, then with a random suffix, with
-- 4 seats in 4 CPUs and 8 GiB, and held by its owner. Its token is a
-- placeholder until the runner starts its container with a real one.
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
      insert into instances (team_id, name, kind, owner_id, token_sha256, claimed_by, claimed_at, personal, seat_cap, cpus, memory_gib)
      values (person.team_id, candidate, 'box', person.id, encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), person.id, now(), true, 4, 4, 8)
      on conflict (team_id, name) do nothing;
      exit when found;
      if attempt = 10 then
        raise exception 'no free name for the computer of %', person.login;
      end if;
    end loop;
  end loop;
end $$;

-- An agent whose home is a Mac moves to the computer of its owner, or of the
-- Mac's owner when the agent has none. An agent with neither stays.
update agents a set home_instance_id = computer.id
from instances mac, instances computer
where mac.id = a.home_instance_id and mac.kind = 'mac'
  and computer.personal and computer.team_id = a.team_id
  and computer.owner_id = coalesce(a.owner_id, mac.owner_id);
