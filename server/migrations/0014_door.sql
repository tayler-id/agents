-- One door for turns. Every turn an agent is asked to take is a row in turns,
-- and server/scheduler.ts hands it to a machine or says why it waits. Described
-- in docs/data-model.md, and the design is "A scheduler places every turn" in
-- docs/design/target-architecture.md.

-- The defaults on source and status let the release before this one keep
-- queueing room turns, which is all it ever puts here, if a deploy goes back to it.
alter table turns
  alter column conversation_id drop not null,
  alter column deadline drop not null,
  add column source text not null default 'room' check (source in ('person', 'room', 'routine', 'pipeline')),
  add column task_id uuid references tasks on delete cascade,
  add column run_id uuid references runs on delete cascade,
  add column routine_id uuid references routines on delete set null,
  add column asked_by_person uuid references people on delete set null,
  add column session_id uuid references sessions on delete cascade,
  add column event_id bigint references events on delete set null,
  add column payload jsonb,
  add column status text not null default 'queued'
    check (status in ('queued', 'waiting', 'placed', 'running', 'done', 'failed', 'cancelled')),
  add column wait text check (wait in ('computer_starting', 'machine_offline')),
  add column instance_id uuid references instances on delete set null,
  add column command_id uuid references commands on delete set null,
  add column placed_at timestamptz,
  add column stuck_since timestamptz;

-- A room's turn that started before this migration wrote its message command
-- with the turn's id in its prompt event's body, which links the two.
update turns t set command_id = c.id, session_id = c.session_id, event_id = c.event_id, payload = c.payload,
  instance_id = c.instance_id, placed_at = t.started_at,
  status = case c.status when 'queued' then 'placed' when 'claimed' then 'running' when 'done' then 'done' else 'failed' end
from commands c join events e on e.id = c.event_id
where c.kind = 'message' and e.body->>'turnId' = t.id::text;
-- A room's turn with no command ended without reaching a machine, or never started.
update turns set status = case when outcome = 'skipped' then 'cancelled' when outcome = 'error' then 'failed' else 'done' end
where command_id is null and outcome is not null;
update turns set status = 'cancelled', outcome = 'cancelled', finished_at = now()
where command_id is null and outcome is null and started_at is not null;

alter table turns
  add constraint turns_for_one check (num_nonnulls(conversation_id, task_id, run_id) = 1),
  add constraint turns_room_deadline check ((source = 'room') = (deadline is not null)),
  add constraint turns_routine check (routine_id is null or source = 'routine'),
  add constraint turns_wait check ((status = 'waiting') = (wait is not null));
-- Rows from before this migration may have ended with no command to read their
-- prompt from, so this holds for rows written from now on.
alter table turns add constraint turns_prompt
  check (status in ('queued', 'cancelled') or (session_id is not null and event_id is not null and payload is not null)) not valid;

-- The scheduler finds a session's unplaced turns, the turns waiting on a
-- machine, and the running ones. moveMessages finds a command's turn, and the
-- idle rule reads when a box's last turn ended.
create index turns_unplaced on turns (session_id, requested_at) where status in ('queued', 'waiting');
create index turns_waiting_on on turns (instance_id) where status = 'waiting';
create index turns_running on turns (session_id) where status = 'running';
create index turns_command on turns (command_id);
create index turns_ended_on on turns (instance_id, finished_at);

-- A daemon reports in once its machine takes work. Machines online now already have.
alter table instances add column ready boolean not null default false;
update instances set ready = true where status = 'online';

-- A person's own box stops when it has nothing to do, and starts again when
-- something needs it.
alter table instances add column stopped_at timestamptz check (stopped_at is null or personal);
update instances set idle_since = now() where personal and idle_since is null;
