// Moves agents whose home is a Mac to their person's computer, once that
// computer can run them. Migration 0024 makes every person's computer asleep and
// moves nothing, since a computer with no Claude login or no built image would
// leave the agent unable to answer. This is the explicit step that moves them:
//   node --env-file=.env server/admin.ts move-agents <team>
// An agent goes to the computer of its owner, or of its Mac's owner when it has
// none. The computer can run it when the image is built and either the team's
// token is saved on the server or the computer's person has signed in to Claude.
// An agent left behind stays on its Mac, where it works as it did. Running it
// again moves only what could not move before.

import type pg from 'pg'
import { many } from './db.ts'

export type Ready = { imageBuilt: boolean; teamToken: boolean }

export type Rehomed = {
  moved: string[]
  // Agents left on a Mac, with the reason each could not move.
  stayed: { agent: string; why: string }[]
}

export async function moveMacAgents(db: pg.Pool | pg.PoolClient, teamId: string, ready: Ready): Promise<Rehomed> {
  const candidates = await many<{ id: string; name: string; computer: string | null; signed_in: boolean }>(db,
    `select a.id, a.name, c.id as computer,
       exists (select 1 from claude_logins l where l.instance_id = c.id and l.status = 'signed_in' and l.valid_until > now()) as signed_in
     from agents a
     join instances mac on mac.id = a.home_instance_id and mac.kind = 'mac'
     left join instances c on c.personal and c.team_id = a.team_id and c.owner_id = coalesce(a.owner_id, mac.owner_id)
     where a.team_id = $1 order by a.name, a.id`, [teamId])
  const result: Rehomed = { moved: [], stayed: [] }
  for (const agent of candidates) {
    const why = agent.computer === null ? 'it and its Mac have no owner with a computer'
      : !ready.imageBuilt ? 'the box image is not built'
      : !ready.teamToken && !agent.signed_in ? "the team's Claude token is not saved and its person has not signed in"
      : null
    if (why !== null || agent.computer === null) {
      result.stayed.push({ agent: agent.name, why: why ?? '' })
      continue
    }
    await db.query('update agents set home_instance_id = $2 where id = $1', [agent.id, agent.computer])
    result.moved.push(agent.name)
  }
  return result
}
