-- The coding framework: policies, the runner's evidence, reviewers' findings,
-- the decision log, lessons, refused pushes and deploys. Added while building,
-- listed in docs/data-model.md under "Added while building" for review. The
-- design is docs/design/self-improve.md.

-- Other migrations written at the same time extend the same check constraints.
-- Restating a fixed list would drop whatever another one added, depending on
-- which runs last, so this adds its values to the list already there.
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
  -- An in list is stored as one quoted literal per value, the shape read above.
  execute format('alter table %I add constraint %I check (%I in (%s))', tbl, con, col,
    (select string_agg(quote_literal(v), ', ' order by v) from (select distinct unnest(present || extra) as v) as vs));
end $$;

select pg_temp.allow_values('instances', 'instances_kind_check', 'kind', array['check']);
select pg_temp.allow_values('run_stages', 'run_stages_kind_check', 'kind', array['route', 'verify', 'review', 'confirm', 'suite']);
select pg_temp.allow_values('commands', 'commands_kind_check', 'kind', array['verify', 'suite']);
select pg_temp.allow_values('runs', 'runs_status_check', 'status', array['paused']);
drop function pg_temp.allow_values(text, text, text, text[]);

-- The rules every change to a repo must pass. Each edit is a new version, and
-- each piece of evidence records the version that judged it.
create table policies (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  name text not null,
  version int not null check (version > 0),
  rules jsonb not null,
  created_by uuid references people on delete set null,
  created_at timestamptz not null default now(),
  unique (team_id, name, version)
);

-- A repo with a policy runs every change through the framework. Its owner is
-- the one person who passes the gates for protected changes, merges and deploys.
alter table repos
  add column policy_id uuid references policies on delete restrict,
  add column owner_id uuid references people on delete restrict,
  add constraint repos_policy_has_owner check (policy_id is null or owner_id is not null);

-- A person's user name on the forge, so an approval they give in Agents is
-- recorded as theirs on the forge, where branch protection counts it.
alter table people add column forge_login text unique;

-- The playbook the router picked, and a pause a person asked for.
alter table runs
  add column playbook text,
  add column paused_at timestamptz,
  add column paused_by uuid references people on delete set null,
  add column pause_note text,
  add constraint runs_pause_fits check ((status = 'paused') = (paused_at is not null));

-- What the runner saw: one row per gate per commit. Only server code writes these.
create table evidence (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  run_id uuid not null references runs on delete cascade,
  run_stage_id uuid references run_stages on delete set null,
  policy_id uuid not null references policies on delete restrict,
  commit text not null,
  base text not null,
  gate text not null,
  status text not null check (status in ('pass', 'fail', 'needs_owner')),
  summary text not null,
  detail jsonb not null default '{}',
  -- The builds that produced the result: the runner's, the machine's that ran
  -- the gate when one did, and hashes of the inputs read from main.
  build jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index evidence_run on evidence (run_id, commit);

-- What a reviewer or a verifier found, and what became of it. A finding is open
-- until the same reviewer's next round. Then it is fixed, or repeated by a new
-- row. Only the repo's owner overrules one.
create table findings (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  run_id uuid not null references runs on delete cascade,
  run_stage_id uuid references run_stages on delete set null,
  stage text not null,
  round int not null check (round > 0),
  commit text not null,
  agent_id uuid references agents on delete set null,
  model text not null,
  rule text not null,
  path text,
  line int,
  body text not null,
  blocking boolean not null,
  -- Findings about these always go to a person, whatever the author does.
  topic text check (topic in ('security', 'auth', 'billing', 'data', 'migrations', 'concurrency')),
  status text not null default 'open' check (status in ('open', 'fixed', 'repeated', 'overruled')),
  decided_by uuid references people on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check ((status = 'overruled') = (decided_at is not null))
);
create index findings_run on findings (run_id, stage, status);

-- A verifier's verdict on a change, from an agent that did not write it, kept
-- by pull request and head commit. Green gates are an input to a verdict, not
-- one. A new head voids a verdict unless the change's patch-id is the same.
create table verdicts (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  run_id uuid not null references runs on delete cascade,
  run_stage_id uuid references run_stages on delete set null,
  repo_id uuid not null references repos on delete cascade,
  pull_request int,
  head text not null,
  base text not null,
  patch_id text not null,
  verdict text not null check (verdict in ('live-ui-verified', 'unit-test-verified', 'type-check-only', 'verifier-blocked', 'verifier-failed')),
  agent_id uuid references agents on delete set null,
  model text not null,
  -- The commands the verifier ran, read from its session in the record, not from its report.
  ran jsonb not null default '[]',
  summary text not null,
  -- The runner's build and hashes of main's rubric, skill and feature map the verifier was given.
  build jsonb not null,
  -- The owner who accepted a verdict below the policy's floor, by name, and when.
  accepted_by uuid references people,
  accepted_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create index verdicts_head on verdicts (run_id, head);

-- The decision log: what an agent or a person decided, why, and what else they weighed.
create table decisions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  task_id uuid not null references tasks on delete cascade,
  run_id uuid references runs on delete cascade,
  stage text,
  who text not null check (who in ('agent', 'person')),
  session_id uuid references sessions on delete set null,
  event_id bigint references events on delete set null,
  person_id uuid references people on delete set null,
  what text not null,
  why text not null,
  alternatives jsonb not null default '[]',
  created_at timestamptz not null default clock_timestamp()
);
create unique index decisions_event on decisions (event_id) where event_id is not null;
create index decisions_task on decisions (task_id, created_at);

-- Lessons the team learned. A lesson starts written, held only by the people
-- and agents who read it, and becomes enforced once it names the gate, lint
-- rule or check that holds it.
create table lessons (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  repo_id uuid references repos on delete cascade,
  rule text not null,
  incident text not null,
  evidence text not null default '',
  enforced_by text,
  -- What kind of structure holds it, best first: the architecture makes the
  -- mistake impossible, then a type, a lint whose error names the fix, a check,
  -- and last a document.
  enforcement text check (enforcement in ('architecture', 'type', 'lint', 'test', 'doc')),
  -- The real past mistake the enforcing check was seen failing on.
  proof text,
  status text not null default 'written' check (status in ('written', 'enforced', 'retired')),
  review_by date,
  created_by uuid references people on delete set null,
  created_at timestamptz not null default now(),
  check (status <> 'enforced' or (enforced_by is not null and enforcement is not null and proof is not null))
);

-- A promise made outside Agents, such as "the outcome will be posted here" on
-- an issue. It closes only with proof of delivery or a person's waiver by
-- name. The generation moves on each change, so a stale event is refused, and
-- an event already applied is a no-op.
create table obligations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  task_id uuid references tasks on delete cascade,
  run_id uuid references runs on delete set null,
  repo_id uuid not null references repos on delete cascade,
  promise text not null,
  channel text not null check (channel in ('forge_issue', 'forge_pull_request')),
  number int not null,
  target text not null,
  proof text not null check (proof in ('comment', 'pull_request', 'commit')),
  due_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'done', 'waived')),
  generation int not null default 1,
  delivery jsonb,
  delivery_event text unique,
  -- Failed tries at delivering, and the earliest time of the next.
  attempts int not null default 0,
  retry_at timestamptz,
  waived_by uuid references people on delete set null,
  waive_reason text,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((status = 'done') = (delivery is not null)),
  check ((status = 'waived') = (waive_reason is not null))
);
create unique index obligations_run_target on obligations (run_id, target) where run_id is not null;
create index obligations_open on obligations (team_id, due_at) where status = 'open';

-- Pushes the git proxy refused: a machine pushing anything but a task branch.
create table refused_pushes (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  instance_id uuid not null references instances on delete cascade,
  repo_id uuid not null references repos on delete cascade,
  refs text[] not null,
  created_at timestamptz not null default clock_timestamp()
);
create index refused_pushes_machine on refused_pushes (instance_id, repo_id, created_at);

-- A deploy of a repo's commit. The deployer carries it out, restarts the API,
-- and rolls back by itself when the health check fails.
create table deploys (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  repo_id uuid not null references repos on delete cascade,
  run_id uuid references runs on delete set null,
  commit text not null,
  previous_commit text,
  status text not null default 'requested' check (status in (
    'requested', 'preparing', 'switching', 'checking', 'rolling_back', 'healthy', 'rolled_back', 'failed'
  )),
  approved_by uuid not null references people on delete restrict,
  log text not null default '',
  note text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz
);
create index deploys_requested on deploys (created_at) where status = 'requested';
