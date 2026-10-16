-- The History page. Described in docs/data-model.md.

-- The steps that went wrong in a session: its error events, and the tool results
-- that report an error. A list counts them and a replay jumps to the next one by
-- reading only these entries. Queries must spell the condition exactly as it is
-- written here for Postgres to use the index (ERROR_STEP in server/history.ts).
create index events_errors on events (session_id, seq)
  where kind = 'error' or (kind = 'tool_result' and body->>'isError' = 'true');
