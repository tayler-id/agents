-- Coach and improve learn from checked evidence. The design is
-- docs/design/evidence.md, and docs/data-model.md lists the columns.

-- How far each session has been read for evidence, so each event is read once.
create table session_reads (
  session_id uuid primary key references sessions on delete cascade,
  team_id uuid not null references teams on delete cascade,
  read_to_seq bigint not null,
  run_id uuid references runs on delete set null,
  read_at timestamptz not null default now()
);

-- A correction no rule covers, with the gap findings that carry it. Code counts
-- it from its live findings each time, so no count is stored.
create table candidates (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  agent_id uuid not null references agents on delete cascade,
  correction text not null,
  status text not null default 'open' check (status in ('open', 'merged', 'closed')),
  merged_into uuid references candidates on delete cascade,
  run_id uuid references runs on delete set null,
  created_at timestamptz not null default now(),
  check ((status = 'merged') = (merged_into is not null))
);
create index candidates_open on candidates (agent_id) where status = 'open';

-- A finding code kept: an exact quote from one event, and what it shows about an
-- agent or a pipeline.
create table session_findings (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  agent_id uuid references agents on delete cascade,
  pipeline_id uuid references pipelines on delete cascade,
  session_id uuid not null references sessions on delete cascade,
  event_id bigint not null references events on delete cascade,
  seq bigint not null,
  kind text not null check (kind in ('followed', 'ignored', 'harm', 'gap')),
  quote text not null,
  rule_hash text,
  rule_text text,
  candidate_id uuid references candidates on delete cascade,
  note text,
  fix text check (fix in ('check', 'text')),
  trigger text,
  source text not null check (source in ('person', 'pipeline', 'box')),
  person_id uuid references people on delete set null,
  occasion uuid not null,
  seen_at timestamptz not null,
  run_id uuid references runs on delete set null,
  created_at timestamptz not null default now(),
  check ((agent_id is null) <> (pipeline_id is null)),
  check ((rule_hash is null) = (rule_text is null)),
  -- An agent's gap belongs to a candidate, names its correction and how it could
  -- be fixed. An agent's other findings name the rule they are about.
  check (agent_id is null or (kind = 'gap') = (candidate_id is not null)),
  check (agent_id is null or (kind = 'gap') = (fix is not null)),
  check (agent_id is null or (kind = 'gap') <> (rule_hash is not null)),
  check (agent_id is null or kind <> 'gap' or note is not null),
  -- A pipeline's findings say what went wrong, and have no rules or candidates.
  check (pipeline_id is null or (note is not null and rule_hash is null and candidate_id is null and fix is null and trigger is null))
);
-- A finding read twice is one finding.
create unique index session_findings_once on session_findings (
  coalesce(agent_id, pipeline_id), event_id, kind, coalesce(rule_hash, ''),
  coalesce(candidate_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index session_findings_candidate on session_findings (candidate_id) where candidate_id is not null;
create index session_findings_agent on session_findings (agent_id, seen_at) where agent_id is not null;

-- The hunks of a proposal. The server computed each one's text and diff, each
-- cites findings, and each holds the decision on it, which the team remembers.
create table proposal_hunks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  proposal_id uuid not null references proposals on delete cascade,
  n int not null,
  target text not null check (target in ('instructions', 'skill', 'profile', 'check', 'pipeline')),
  op text not null check (op in ('add', 'change', 'delete')),
  rule_hash text,
  skill_name text,
  skill_description text,
  person_id uuid references people on delete cascade,
  before text not null,
  after text not null,
  diff text not null,
  content_hash text not null,
  after_hash text not null,
  finding_ids uuid[] not null,
  occasions int not null,
  counts jsonb not null,
  evidence jsonb not null,
  decision text check (decision in ('accepted', 'rejected')),
  reason text,
  decided_by uuid references people on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (proposal_id, n),
  check (cardinality(finding_ids) > 0),
  check ((decision is null) = (decided_at is null)),
  check ((decision is null) = (reason is null)),
  check ((target = 'skill') = (skill_name is not null)),
  check ((target = 'skill') = (skill_description is not null)),
  check ((target = 'profile') = (person_id is not null)),
  check (target = 'instructions' or rule_hash is null),
  check (target <> 'instructions' or op = 'add' or rule_hash is not null),
  check (target in ('instructions', 'pipeline') or op <> 'delete')
);
create index proposal_hunks_rejected on proposal_hunks (content_hash) where decision = 'rejected';

-- One replay of one turn, scoring a coach proposal. The judge sees the label,
-- never the variant.
create table session_replays (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  proposal_id uuid not null references proposals on delete cascade,
  kind text not null check (kind in ('behind', 'unrelated')),
  variant text not null check (variant in ('change', 'current')),
  source_session_id uuid not null references sessions on delete cascade,
  upto_seq bigint not null,
  finding_id uuid references session_findings on delete cascade,
  label text not null,
  task_id uuid not null references tasks on delete cascade,
  session_id uuid not null references sessions on delete cascade,
  status text not null default 'running' check (status in ('running', 'replied', 'failed')),
  reply text,
  verdict text,
  -- A retried replay stage starts over. The earlier rows stay, so their sessions
  -- still count toward the run's spend and are still treated as replays.
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  replied_at timestamptz,
  unique (session_id),
  check ((kind = 'behind') = (finding_id is not null)),
  check ((status = 'replied') = (reply is not null)),
  check (verdict is null
    or (kind = 'behind' and verdict in ('fixed', 'still'))
    or (kind = 'unrelated' and verdict in ('ok', 'worse')))
);
create unique index session_replays_label on session_replays (proposal_id, label) where superseded_at is null;
create index session_replays_running on session_replays (proposal_id) where status = 'running' and superseded_at is null;

-- A coach proposal's hunks touch one agent's instructions, skills, profiles and
-- checks. The targets instructions and skill stay for proposals already made.
alter table proposals drop constraint proposals_target_check;
alter table proposals add constraint proposals_target_check
  check (target in ('pipeline', 'instructions', 'skill', 'agent'));
