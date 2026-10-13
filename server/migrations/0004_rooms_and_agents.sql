-- Phase 4. Added while building, listed in docs/data-model.md under "Added
-- while building" for review.

-- A room's turns wait in line: asked for, then started, then finished with an
-- outcome. Only one turn in a room runs at a time.
alter table turns add column started_at timestamptz;
create index turns_waiting on turns (conversation_id, requested_at) where outcome is null;
