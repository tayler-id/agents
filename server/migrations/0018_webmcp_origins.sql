-- The sites whose WebMCP tools a team's agents may use. Described in
-- docs/data-model.md. A team with no rows gives its agents' browsers no page tools.
create table webmcp_origins (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams on delete cascade,
  -- A scheme and a host, with a port or * for any port, in the form shared/webmcp.ts normalizes to.
  origin text not null check (origin ~ '^https?://[^/[:space:]]+$'),
  added_by uuid references people on delete set null,
  created_at timestamptz not null default now(),
  unique (team_id, origin)
);
