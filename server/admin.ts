// Run on the server host. Adds teams, people, instances and agents.
//   node --env-file=.env server/admin.ts add-team <team> <first login>
//   node --env-file=.env server/admin.ts add-person <team> <login>
//   node --env-file=.env server/admin.ts add-instance <team> <name> <mac|box> <owner login>
//   node --env-file=.env server/admin.ts add-agent <team> <name> <home instance> [model] [instructions]

import { randomBytes } from 'node:crypto'
import { maybe, pool } from './db.ts'
import { sha256 } from './auth.ts'

async function addPerson(team: string, login: string) {
  const { rowCount } = await pool.query(
    'insert into people (team_id, login) select id, $2 from teams where name = $1', [team, login])
  if (!rowCount) throw new Error(`no team ${team}`)
}

const USAGE = [
  'add-team <team> <login>',
  'add-person <team> <login>',
  'add-instance <team> <name> <mac|box> <owner login>',
  'add-agent <team> <name> <home instance> [model] [instructions]',
].join(' | ')

const [command, ...args] = process.argv.slice(2)
const [first = '', second = ''] = args
try {
  if (command === 'add-team' && args.length === 2) {
    await pool.query('insert into teams (name) values ($1)', [first])
    await addPerson(first, second)
    console.log(`team ${first} with ${second}`)
  } else if (command === 'add-person' && args.length === 2) {
    await addPerson(first, second)
    console.log(`${second} joined ${first}`)
  } else if (command === 'add-instance' && args.length === 4) {
    const [team, name, kind, owner] = args
    const token = `machine_${randomBytes(24).toString('base64url')}`
    const instance = await maybe<{ id: string }>(pool,
      `insert into instances (team_id, name, kind, owner_id, token_sha256)
       select t.id, $2, $3, p.id, $5 from teams t join people p on p.team_id = t.id and p.login = $4
       where t.name = $1 returning id`,
      [team, name, kind, owner, sha256(token)])
    if (!instance) throw new Error(`no team ${team} with person ${owner}`)
    console.log(JSON.stringify({ instance: name, token }))
  } else if (command === 'add-agent' && args.length >= 3 && args.length <= 5) {
    const [team, name, home, model, instructions] = args
    const agent = await maybe<{ id: string }>(pool,
      `insert into agents (team_id, name, home_instance_id, model, instructions, visibility)
       select t.id, $2, i.id, $4, coalesce($5, ''), 'team'
       from teams t join instances i on i.team_id = t.id and i.name = $3
       where t.name = $1 returning id`,
      [team, name, home, model || null, instructions ?? null])
    if (!agent) throw new Error(`no team ${team} with instance ${home}`)
    console.log(JSON.stringify({ agent: name, agentId: agent.id }))
  } else {
    console.error(`usage: ${USAGE}`)
    process.exitCode = 2
  }
} finally {
  await pool.end()
}
