// A team's list of sites whose WebMCP tools its agents' browsers may use. An
// admin adds and removes origins, and every teammate's agents follow the list on
// their next message. The design is docs/design/target-architecture.md, under
// "WebMCP, both ways". api.ts adds the routes to its own list.

import type pg from 'pg'
import { adminFrom, personFrom } from './auth.ts'
import { many, maybe, one, pool, tx } from './db.ts'
import { parseBody, pathId, type Route } from './http.ts'
import { HttpError, type Person } from './record.ts'
import { AddWebmcpOriginBody, WEBMCP_ORIGINS_MAX, WebmcpOriginId, WebmcpOriginList } from '../shared/webmcp.ts'

const UUID = '([0-9a-f-]{36})'

async function listOf(db: pg.Pool | pg.PoolClient, teamId: string): Promise<WebmcpOriginList> {
  const rows = await many(db,
    `select o.id, o.origin, p.login as "addedBy", o.created_at::text as "createdAt"
     from webmcp_origins o left join people p on p.id = o.added_by
     where o.team_id = $1 order by o.origin`, [teamId])
  return WebmcpOriginList.parse({ origins: rows })
}

// Lists an origin for the person's team. Listing one that is already there changes nothing.
export async function addOrigin(admin: Person, origin: string): Promise<WebmcpOriginList> {
  return tx(async (client) => {
    // Two admins adding at once would each see room for one more.
    await client.query(`select pg_advisory_xact_lock(hashtext('webmcp:' || $1))`, [admin.team_id])
    const held = await one<{ count: string }>(client, "the team's origin count", 'select count(*) from webmcp_origins where team_id = $1', [admin.team_id])
    const taken = await maybe(client, 'select 1 from webmcp_origins where team_id = $1 and origin = $2', [admin.team_id, origin])
    if (!taken && Number(held.count) >= WEBMCP_ORIGINS_MAX) {
      throw new HttpError(409, `A team can list ${WEBMCP_ORIGINS_MAX} sites at most. Remove one first.`)
    }
    await client.query(
      'insert into webmcp_origins (team_id, origin, added_by) values ($1, $2, $3) on conflict (team_id, origin) do nothing',
      [admin.team_id, origin, admin.id])
    return listOf(client, admin.team_id)
  })
}

export async function removeOrigin(admin: Person, id: WebmcpOriginId): Promise<WebmcpOriginList> {
  return tx(async (client) => {
    const removed = await client.query('delete from webmcp_origins where id = $1 and team_id = $2', [id, admin.team_id])
    if (removed.rowCount === 0) throw new HttpError(404, 'That site is not on the list.')
    return listOf(client, admin.team_id)
  })
}

export const webmcpRoutes: Route[] = [
  // Every teammate can read the list, since it decides what their agents' browsers do.
  ['people', 'GET', /^\/v1\/team\/webmcp-origins$/, async (req): Promise<WebmcpOriginList> => {
    const person = await personFrom(req)
    return listOf(pool, person.team_id)
  }],

  ['people', 'POST', /^\/v1\/team\/webmcp-origins$/, async (req): Promise<WebmcpOriginList> => {
    const admin = await adminFrom(req)
    return addOrigin(admin, (await parseBody(req, AddWebmcpOriginBody)).origin)
  }],

  ['people', 'POST', new RegExp(`^/v1/team/webmcp-origins/${UUID}/delete$`), async (req, [originId]): Promise<WebmcpOriginList> => {
    const admin = await adminFrom(req)
    return removeOrigin(admin, pathId(WebmcpOriginId, originId))
  }],
]
