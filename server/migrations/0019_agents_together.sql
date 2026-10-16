-- Agents working together: one agent messages another, hands it a task, or asks
-- its owner to let it make a new agent. Each message between agents is a turn
-- through the scheduler like any other. Described in docs/data-model.md, and the
-- design is "Agents creating, messaging and delegating to agents" in
-- docs/design/target-architecture.md.

-- Other migrations extend the same check constraints, so this adds its values to
-- the list already there rather than restating it, as 0009 does.
create function pg_temp.allow_values(tbl text, con text, col text, extra text[]) returns void
language plpgsql as $$
declare
  present text[];
begin
  select array_agg(m[1]) into present
  from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') as m
  where c.conname = con and c.conrelid = tbl::regclass;
  if present is null then
    raise exception 'no check constraint % on %', con, tbl;
  end if;
  execute format('alter table %I drop constraint %I', tbl, con);
  execute format('alter table %I add constraint %I check (%I in (%s))', tbl, con, col,
    (select string_agg(quote_literal(v), ', ' order by v) from (select distinct unnest(present || extra) as v) as vs));
end $$;

-- A thread between two agents, which the team reads.
select pg_temp.allow_values('conversations', 'conversations_kind_check', 'kind', array['agents']);
-- One agent's message to another, its answer, and a task one agent hands another.
select pg_temp.allow_values('turns', 'turns_source_check', 'source', array['agent', 'delegation']);
drop function pg_temp.allow_values(text, text, text, text[]);

-- The defaults leave every turn written before this, and every turn the release
-- before writes, a turn no agent asked for.
alter table turns
  add column asked_by_session uuid references sessions on delete set null,
  add column answer_to_turn uuid references turns on delete set null,
  add column answer_sent_at timestamptz,
  add column hops int not null default 0;
alter table turns add constraint turns_hops check ((source in ('agent', 'delegation')) = (hops > 0));
-- The runner finds the turns whose answer is still to go back to an agent.
create index turns_answer_due on turns (finished_at) where answer_to_turn is not null and answer_sent_at is null;

alter table tasks add column asked_by_turn uuid references turns on delete set null;

-- Only a user event carries another agent's message, and then no person wrote it.
alter table events add column author_agent uuid references agents on delete set null;
alter table events add constraint events_author_agent check (author_agent is null or (author is null and kind = 'user'));

alter table agents
  add column accepts_agents text not null default 'owner' check (accepts_agents in ('owner', 'team')),
  add column made_by_session uuid references sessions on delete set null,
  add column made_by_ask uuid unique references asks on delete set null;
