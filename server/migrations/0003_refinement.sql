-- Phase 3, refinement. Added while building, listed in docs/data-model.md under
-- "Added while building" for review.

-- A proposal changes a pipeline file, an agent's instructions, or a skill. A
-- pipeline change carries the candidate version and its scores against the
-- current version. Proposals start as `scoring` and only reach people when the
-- candidate scored better.
alter table proposals
  alter column pipeline_id drop not null,
  alter column base_version_id drop not null,
  alter column diff set default '',
  add column target text not null default 'pipeline' check (target in ('pipeline', 'instructions', 'skill')),
  add column agent_id uuid references agents on delete cascade,
  add column skill_name text,
  add column summary text not null default '',
  add column content text,
  add column candidate_version_id uuid references pipeline_versions on delete set null,
  add column run_id uuid references runs on delete set null,
  add column pull_request text;
alter table proposals drop constraint proposals_status_check;
alter table proposals add constraint proposals_status_check
  check (status in ('scoring', 'open', 'approved', 'rejected', 'failed'));
alter table proposals add constraint proposals_target_fits check (
  (target = 'pipeline') = (pipeline_id is not null)
  and (target = 'skill') = (skill_name is not null)
  and (target = 'pipeline' or agent_id is not null));

-- A replay runs a past run's report again, at the commit it started from, with
-- one pipeline version, to score that version. Replays never touch the forge and
-- never wait on a person.
alter table runs
  add column replay_of uuid references runs on delete set null,
  add column proposal_id uuid references proposals on delete cascade;
create index runs_proposal on runs (proposal_id) where proposal_id is not null;
