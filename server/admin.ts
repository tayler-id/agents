// Run on the server host. Adds teams, people, instances and agents, puts a repo
// under the coding framework with a policy and its owner, and connects GitHub. A
// team's first login is its admin, who can then invite everyone else from the app.
//   node --env-file=.env server/admin.ts add-team <team> <first login>
//   node --env-file=.env server/admin.ts add-person <team> <login>
//   node --env-file=.env server/admin.ts set-role <team> <login> <admin|member>
//   node --env-file=.env server/admin.ts add-instance <team> <name> <mac|box|check> <owner login>
//   node --env-file=.env server/admin.ts add-agent <team> <name> <home instance> [model] [instructions]
//   node --env-file=.env server/admin.ts forge-login <login> <forge user>
//   node --env-file=.env server/admin.ts set-policy <team> <repo clone url> <policy.json> <owner login>
//   node --env-file=.env server/admin.ts add-lesson <team> <rule> <incident>
//   pbpaste | node --env-file=.env server/admin.ts github <organization or account>
// github reads the token from standard input, so it never shows in the process
// list or the shell history, and saves it in ~/.agents-app/github.json.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { maybe, one, pool, tx } from './db.ts'
import { sha256 } from './auth.ts'
import { forgeAdmin, forgeConfig, repoPath } from './forge.ts'
import { STATUS } from '../shared/framework.ts'
import { POLICY } from '../shared/policy.ts'
import { connectGithub } from './github.ts'

// Records a new version of the policy, points the repo at it with its owner,
// and protects the repo's default branch on the forge to match.
async function setPolicy(team: string, remote: string, file: string, ownerLogin: string) {
  const rules = POLICY.parse(JSON.parse(readFileSync(file, 'utf8')))
  const name = basename(file, '.json')
  const set = await tx(async (client) => {
    const owner = await maybe<{ id: string; team_id: string; forge_login: string | null }>(client,
      'select p.id, p.team_id, p.forge_login from people p join teams t on t.id = p.team_id where t.name = $1 and p.login = $2', [team, ownerLogin])
    if (!owner) throw new Error(`no person ${ownerLogin} on ${team}`)
    const repo = await maybe<{ id: string; default_branch: string }>(client,
      'select id, default_branch from repos where team_id = $1 and remote_url = $2', [owner.team_id, remote])
    if (!repo) throw new Error(`no repo ${remote} on ${team}`)
    const policy = await one<{ id: string; version: number }>(client, 'the new policy version',
      `insert into policies (team_id, name, version, rules, created_by)
       values ($1, $2, (select coalesce(max(version), 0) + 1 from policies where team_id = $1 and name = $2), $3, $4) returning id, version`,
      [owner.team_id, name, JSON.stringify(rules), owner.id])
    await client.query('update repos set policy_id = $2, owner_id = $3 where id = $1', [repo.id, policy.id, owner.id])
    return { owner, repo, policy }
  })
  if (remote.startsWith(forgeConfig().url)) {
    if (!set.owner.forge_login) throw new Error(`${ownerLogin} has no forge user. Set one with forge-login, then run this again.`)
    await forgeAdmin.protect(repoPath(remote), set.repo.default_branch, {
      owner: set.owner.forge_login, contexts: Object.values(STATUS), protectedFiles: rules.protectedPaths,
    })
  }
  return { policy: name, version: set.policy.version, repo: remote, owner: ownerLogin }
}

async function addPerson(team: string, login: string, role: 'admin' | 'member') {
  const { rowCount } = await pool.query(
    'insert into people (team_id, login, role) select id, $2, $3 from teams where name = $1', [team, login, role])
  if (!rowCount) throw new Error(`no team ${team}`)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').trim()
}

const USAGE = [
  'add-team <team> <login>',
  'add-person <team> <login>',
  'set-role <team> <login> <admin|member>',
  'add-instance <team> <name> <mac|box|check> <owner login>',
  'add-agent <team> <name> <home instance> [model] [instructions]',
  'forge-login <login> <forge user>',
  'set-policy <team> <repo clone url> <policy.json> <owner login>',
  'add-lesson <team> <rule> <incident>',
  'github <organization or account> (the token on standard input)',
].join(' | ')

const [command, ...args] = process.argv.slice(2)
const [first = '', second = '', third = ''] = args
try {
  if (command === 'add-team' && args.length === 2) {
    await pool.query('insert into teams (name) values ($1)', [first])
    await addPerson(first, second, 'admin')
    console.log(`team ${first} with ${second} as its admin`)
  } else if (command === 'add-person' && args.length === 2) {
    await addPerson(first, second, 'member')
    console.log(`${second} joined ${first}`)
  } else if (command === 'set-role' && args.length === 3 && (third === 'admin' || third === 'member')) {
    const { rowCount } = await pool.query(
      'update people set role = $3 where login = $2 and team_id = (select id from teams where name = $1)', [first, second, third])
    if (!rowCount) throw new Error(`no person ${second} in ${first}`)
    console.log(`${second} is now ${third === 'admin' ? 'an admin' : 'a member'} of ${first}`)
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
  } else if (command === 'forge-login' && args.length === 2) {
    const { rowCount } = await pool.query('update people set forge_login = $2 where login = $1', [first, second])
    if (!rowCount) throw new Error(`no person ${first}`)
    console.log(`${first} is ${second} on the forge`)
  } else if (command === 'set-policy' && args.length === 4) {
    // The length check above means each of the four is there.
    const [team = '', remote = '', file = '', owner = ''] = args
    console.log(JSON.stringify(await setPolicy(team, remote, file, owner)))
  } else if (command === 'add-lesson' && args.length === 3) {
    const [team, rule, incident] = args
    const { rowCount } = await pool.query('insert into lessons (team_id, rule, incident) select id, $2, $3 from teams where name = $1', [team, rule, incident])
    if (!rowCount) throw new Error(`no team ${team ?? ''}`)
    console.log(`added a written lesson to ${team}. It becomes enforced once it names what holds it.`)
  } else if (command === 'github' && args.length === 1) {
    console.log(JSON.stringify(await connectGithub(await readStdin(), first)))
  } else {
    console.error(`usage: ${USAGE}`)
    process.exitCode = 2
  }
} finally {
  await pool.end()
}
