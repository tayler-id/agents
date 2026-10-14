-- Durability. Listed in docs/data-model.md under "Added while building" for
-- review, and explained in docs/design/durability.md.

-- An approval is answered through the harness request that raised it, and the
-- request dies with its process. This is when that happened without the answer
-- reaching it, set when the machine restarts. A resumed session that asks again
-- for the same tool and input takes over the ask, and an answer already given
-- reaches it at once. Null while the request is alive or has its answer.
alter table asks add column request_ended_at timestamptz;
