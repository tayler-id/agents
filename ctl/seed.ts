// What an instance starts with, and the fixtures `agentsctl seed` adds. People,
// machines and agents go in through server/admin.ts, the path an admin uses.
// Repos go on the shared forge, in an org of the instance's own named like its
// team, with the same repo names a real team has (shop and pipelines), and are
// removed by `down`. The fake Claude harness follows the scenario written here.

import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { call, type Reply } from './api.ts'
import { childEnv, ROOT } from './config.ts'
import { withClient } from './db.ts'
import { Refused } from '../shared/cli/output.ts'
import { ForgeError, forgeAdmin, forgeConfig } from '../server/forge.ts'
import { AgentId, InstanceId, PersonId, readState, RepoId, saveState, TeamId, type ForgeRepo, type InstanceName, type ReadyState, type Seed } from './state.ts'
import { messageOf } from '../shared/errors.ts'

const run = promisify(execFile)

// The agents every instance has. fixer and improver are the agents the team's
// pipelines name. Their model is the cheapest, for runs on real Claude.
export const AGENTS: Record<string, string> = {
  fixer: 'You fix bugs.',
  writer: 'You write docs.',
  improver: 'You improve pipelines.',
}
export const AGENT_MODEL = 'haiku'
export const MACHINE = 'mac'
// A person an instance drives, by a short name: lowercase letters and digits, no dash.
export const PERSON_RULE = 'Use lowercase letters and digits, such as cy, or a full login with an @'
export const PersonName = z.string().regex(/^[a-z][a-z0-9]*$/, PERSON_RULE).brand<'PersonName'>()
export type PersonName = z.infer<typeof PersonName>
// Every login an instance makes is <who>-<instance>@verify.local. who holds no
// dash, so another instance's login can end the same way without being ours:
// stranger-y-x is instance y-x's stranger, and x does not own it.
export const LOGIN_DOMAIN = '@verify.local'
export const loginOf = (who: PersonName, name: InstanceName) => `${who}-${name}${LOGIN_DOMAIN}`
// Whether loginOf makes this login for this instance.
export function isLoginOf(login: string, name: InstanceName): boolean {
  const ending = `-${name}${LOGIN_DOMAIN}`
  return login.endsWith(ending) && PersonName.safeParse(login.slice(0, -ending.length)).success
}
const [ADA, BEN] = [PersonName.parse('ada'), PersonName.parse('ben')]
export const orgOf = (name: InstanceName) => `verify-${name}`

// A secret value the scenario's agent repeats, so a run can show it never
// reaches the record. Only meaningful on an instance's own machine.
export const SECRET_VALUE = 'verify-secret-0451'

export async function admin(...args: string[]): Promise<string> {
  try {
    return (await run(process.execPath, [join(ROOT, 'server', 'admin.ts'), ...args], { cwd: ROOT, env: childEnv('admin', {}) })).stdout
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : ''
    throw new Error(`server/admin.ts ${args.join(' ')} failed: ${stderr || (messageOf(error))}`)
  }
}

const NewInstance = z.object({ instance: z.string(), token: z.string().startsWith('machine_') })
const NewAgent = z.object({ agent: z.string(), agentId: AgentId })

const Found = z.object({ team: z.string(), id: z.uuid() })

// What a seed finds already there: on the instance's team, or, for a login, on another team.
async function existing(sql: string, values: string[]): Promise<z.infer<typeof Found> | null> {
  const [row] = await withClient(async (client) => z.array(Found).parse((await client.query(sql, values)).rows))
  return row ?? null
}

// Each seed is safe to run again: one that finds its row already there adds nothing.
export async function addPerson(team: string, login: string): Promise<{ already: boolean }> {
  const found = await existing('select t.name as team, p.id from people p join teams t on t.id = p.team_id where p.login = $1', [login])
  if (found && found.team !== team) throw new Refused(`${login} is already on another team, ${found.team}`, ['Logins are unique across teams. Pick another name for the person'])
  if (found) return { already: true }
  await admin('add-person', team, login)
  return { already: false }
}

export async function addAgent(team: string, name: string, instructions: string): Promise<{ agentId: z.infer<typeof AgentId>; already: boolean }> {
  const found = await existing('select t.name as team, a.id from agents a join teams t on t.id = a.team_id where t.name = $1 and a.name = $2 and a.archived_at is null', [team, name])
  if (found) return { agentId: AgentId.parse(found.id), already: true }
  return { agentId: NewAgent.parse(JSON.parse(await admin('add-agent', team, name, MACHINE, AGENT_MODEL, instructions))).agentId, already: false }
}

export async function addBox(team: string, name: string, owner: string): Promise<{ already: boolean }> {
  const found = await existing('select t.name as team, i.id from instances i join teams t on t.id = i.team_id where t.name = $1 and i.name = $2', [team, name])
  if (found) return { already: true }
  NewInstance.parse(JSON.parse(await admin('add-instance', team, name, 'box', owner)))
  return { already: false }
}

// The team, its two people, its machine and its agents.
// Whether the test database holds a team of that name, and the forge an org.
export const teamTaken = (team: string) => withClient(async (client) => (await client.query('select 1 from teams where name = $1', [team])).rowCount === 1)
export const orgTaken = (org: string) => forgeAdmin.call('GET', `/orgs/${org}`).then(() => true, (error: unknown) => {
  if (error instanceof ForgeError && error.status === 404) return false
  throw error
})

// Makes the instance's team, failing if anyone made it first. Gitea and Postgres
// each let only one maker win, so a team or org this made is this instance's.
export async function makeTeam(name: InstanceName, team: string): Promise<void> {
  try {
    await admin('add-team', team, loginOf(ADA, name))
  } catch (error) {
    if (await teamTaken(team) && error instanceof Error && error.message.includes('duplicate key')) {
      throw new Refused(`the team ${team} was made by someone else while this up ran`, ['Pick another name with --instance'])
    }
    throw error
  }
}

export async function makeOrg(name: InstanceName): Promise<void> {
  const org = orgOf(name)
  try {
    await forgeAdmin.call('POST', '/orgs', { username: org, visibility: 'private' })
  } catch (error) {
    // Gitea answers 422 for a name that is taken.
    if (error instanceof ForgeError && error.status === 422) throw new Refused(`the forge org ${org} is already there, so it is not this instance's`, ['Pick another name with --instance'])
    throw error
  }
}

// The team's second person, its machine and its agents, on a team makeTeam made.
export async function seedTeam(name: InstanceName, team: string): Promise<Seed> {
  const [owner, teammate] = [loginOf(ADA, name), loginOf(BEN, name)]
  await addPerson(team, teammate)
  const { token } = NewInstance.parse(JSON.parse(await admin('add-instance', team, MACHINE, 'mac', owner)))
  const agents: Record<string, z.infer<typeof AgentId>> = {}
  for (const [agent, instructions] of Object.entries(AGENTS)) agents[agent] = (await addAgent(team, agent, instructions)).agentId
  return withClient(async (client) => {
    const teamRow = z.object({ id: TeamId }).parse((await client.query('select id from teams where name = $1', [team])).rows[0])
    const people = z.array(z.object({ id: PersonId, login: z.string() }))
      .parse((await client.query('select id, login from people where team_id = $1', [teamRow.id])).rows)
    const machine = z.object({ id: InstanceId }).parse((await client.query('select id from instances where team_id = $1 and name = $2', [teamRow.id, MACHINE])).rows[0])
    const person = (login: string) => {
      const found = people.find((p) => p.login === login)
      if (!found) throw new Error(`the seeded person ${login} is not on ${team}`)
      return found
    }
    return { teamId: teamRow.id, owner: person(owner), teammate: person(teammate), machine: { id: machine.id, name: MACHINE, token }, agents }
  })
}

const shopFiles = () => Object.fromEntries(['checkout.js', 'package.json', 'test/checkout.test.js']
  .map((f) => [f, readFileSync(join(ROOT, 'ops', 'seed', 'shop', f), 'utf8')]))

async function addRepo(name: InstanceName, teamId: string, repo: string, files: Record<string, string>, role: ForgeRepo['role']): Promise<ForgeRepo> {
  const org = orgOf(name)
  // No webhook: the forge can reach only the live API's port, never an instance's.
  const path = await forgeAdmin.ensureRepo(repo, files, `verification instance ${name}`, false, org)
  const remote = `${forgeConfig().url}/${path}.git`
  const repoId = await withClient(async (client) => z.object({ id: RepoId }).parse((await client.query(
    'insert into repos (team_id, remote_url) values ($1, $2) returning id', [teamId, remote])).rows[0]).id)
  return { path, repoId, role }
}

// Another copy of the shop, for a task or a run on a repo of its own.
export async function seedExtraRepo(state: ReadyState, repo: string): Promise<{ repo: ForgeRepo; already: boolean }> {
  const had = state.forgeRepos.find((r) => r.path === `${orgOf(state.name)}/${repo}`)
  if (had) return { repo: had, already: true }
  // An instance started without --pipelines has no org yet. It makes one, strictly, and records it.
  if (!state.made.org) {
    await makeOrg(state.name)
    const latest = readState(state.name)
    if (latest?.phase !== 'ready') throw new Error(`instance ${state.name} stopped while its org was made`)
    saveState({ ...latest, made: { ...latest.made, org: true } })
  }
  const made = await addRepo(state.name, state.seed.teamId, repo, shopFiles(), 'extra')
  const latest = readState(state.name)
  if (latest?.phase !== 'ready') throw new Error(`instance ${state.name} stopped while the repo was made`)
  saveState({ ...latest, forgeRepos: [...latest.forgeRepos, made] })
  return { repo: made, already: false }
}

const TaskRow = z.object({ id: z.string() })
const taskTitled = (teamId: string, title: string) => withClient(async (client) => z.array(TaskRow).parse((await client.query(
  'select id from tasks where team_id = $1 and title = $2 order by created_at desc limit 1', [teamId, title])).rows)[0] ?? null)

export type TaskStart = { kind: 'started'; taskId: string; already: boolean } | { kind: 'refused'; reply: Reply } | { kind: 'missing' }

// Starts a task for an agent, as a person does with New task, unless a task with the title is already there.
export async function startTask(state: ReadyState, task: { title: string; instructions: string; agentId: string }): Promise<TaskStart> {
  const had = await taskTitled(state.seed.teamId, task.title)
  if (!had) {
    const reply = await call(state, { method: 'POST', path: '/v1/tasks', as: 'person', body: task })
    if (reply.status < 200 || reply.status >= 300) return { kind: 'refused', reply }
  }
  const started = await taskTitled(state.seed.teamId, task.title)
  return started ? { kind: 'started', taskId: started.id, already: had !== null } : { kind: 'missing' }
}

// What a team with no task has to look at in the app: the sample repo, when it has no repo, and a task for fixer.
// `up` has already given the team a teammate and agents. Each step finds what a run cut short left, and adds
// only what is missing. Says what it added.
const SAMPLE_REPO = 'shop'
const SAMPLE_TASK = { title: 'Fix the checkout discount', instructions: 'TENOFF should never take an order below zero.' }
const Held = z.object({ repos: z.number(), tasks: z.number() })

export async function seedSample(state: ReadyState): Promise<string[]> {
  const held = await withClient(async (client) => Held.parse((await client.query(
    'select (select count(*)::int from repos where team_id = $1) as repos, (select count(*)::int from tasks where team_id = $1) as tasks', [state.seed.teamId])).rows[0]))
  if (held.tasks > 0) return []
  const fixer = state.seed.agents.fixer
  if (!fixer) throw new Error('the instance has no agent named fixer to give the sample task to')
  const added: string[] = []
  if (held.repos === 0) added.push(`the repo ${(await seedExtraRepo(state, SAMPLE_REPO)).repo.path}`)
  const started = await startTask(state, { ...SAMPLE_TASK, agentId: fixer })
  if (started.kind === 'refused') throw new Error(`POST /v1/tasks answered ${String(started.reply.status)} for the sample task`)
  if (started.kind === 'missing') throw new Error(`no task titled "${SAMPLE_TASK.title}" after starting it`)
  if (!started.already) added.push(`the task "${SAMPLE_TASK.title}" for fixer`)
  return added
}

// The team's repos on the forge: shop, a small app with a known bug, and
// pipelines, the team's pipeline files, run on the agents' home machine.
export async function seedForge(name: InstanceName, teamId: string): Promise<ForgeRepo[]> {
  const shop = shopFiles()
  const bugFix = readFileSync(join(ROOT, 'pipelines', 'bug-fix.ts'), 'utf8')
  // The team's bug-fix runs on boxes. An instance has no boxes that can reach it, so its runs stay home.
  if (bugFix.split("runsOn: 'box'").length !== 2) throw new Error("pipelines/bug-fix.ts no longer says runsOn: 'box' exactly once")
  const pipelines = {
    'shared/pipeline.ts': readFileSync(join(ROOT, 'shared', 'pipeline.ts'), 'utf8'),
    'pipelines/bug-fix.ts': bugFix.replace("runsOn: 'box'", "runsOn: 'home'"),
    'pipelines/improve.ts': readFileSync(join(ROOT, 'pipelines', 'improve.ts'), 'utf8'),
    'pipelines/coach.ts': readFileSync(join(ROOT, 'pipelines', 'coach.ts'), 'utf8'),
  }
  return [await addRepo(name, teamId, 'shop', shop, 'shop'), await addRepo(name, teamId, 'pipelines', pipelines, 'pipelines')]
}

// Removes the instance's org and every repo in it. Called only for an org this
// instance made (`made.org`), so every repo in it is the instance's own, including
// one made by an `up` that failed before it could record it.
export async function removeForge(name: InstanceName): Promise<string[]> {
  const org = orgOf(name)
  const repos = await forgeAdmin.call<unknown>('GET', `/orgs/${org}/repos?limit=50`).catch((error: unknown) => {
    if (error instanceof ForgeError && error.status === 404) return null
    throw error
  })
  if (repos === null) return []
  const removed: string[] = []
  for (const { full_name: path } of z.array(z.object({ full_name: z.string() })).parse(repos)) {
    await forgeAdmin.call('DELETE', `/repos/${path}`)
    removed.push(path)
  }
  await forgeAdmin.call('DELETE', `/orgs/${org}`)
  return removed
}

const TEST_FILE = `const test = require('node:test')
const assert = require('node:assert')
const { discount } = require('../checkout.js')

test('TENOFF never goes below zero', () => assert.strictEqual(discount(5, 'TENOFF'), 0))
`
const PLAN = '# Plan\n\nMove tax rates into **one table** per country.\n\n- Add `rates.js`\n- Read it in `total()`\n'
// The improve pipeline's change: a clearer triage prompt, which the replays score.
export const CLEARER = 'Always call report_result when you finish.'
const TRIAGE_LINE = 'Decide what this report is, without changing any code:'
// Long enough to watch a stage run on the run page, which is live.
const STAGE_MS = 3000
// Running now refreshes every 3 seconds, so a stage there must last several of those.
const SLOW_STAGE_MS = 15_000

// A bug-fix run on the TENOFF bug in one copy of the shop: the reproduction
// test it writes, and the fix it makes.
const tenoff = (repo: string) => ({
  'new,duplicate,already_fixed,not_a_bug': [{ outcome: 'new', reportOnlyIf: CLEARER, summary: 'A new bug in discount().', sleepMs: STAGE_MS }],
  'easy,hard,cannot_reproduce': [{ outcome: 'easy', sleepMs: STAGE_MS, write: { [`${repo}/test/tenoff.test.js`]: TEST_FILE }, data: { test_command: 'node --test test/tenoff.test.js', suite_command: 'npm test' } }],
  'fixed,stuck': [{ outcome: 'fixed', summary: 'TENOFF now stops at **zero**.', sleepMs: STAGE_MS, replace: { [`${repo}/checkout.js`]: ['amount - 10', 'Math.max(0, amount - 10)'] } }],
})

// What the fake Claude harness does: replies in conversations by rule, and
// steps through pipeline stages by the group a run's title names.
export function scenario() {
  return {
    turns: [
      { match: 'You are fixer', reply: 'I will take the **checkout** bug.' },
      { match: 'You are writer', reply: 'PASS' },
      { match: 'You are improver', reply: 'PASS' },
      { match: 'Write the release notes', write: { 'task/notes.md': '# Release notes\n\n- TENOFF stops at zero.\n' }, reply: 'Wrote task/notes.md.' },
      { match: 'commented on ./task/notes.md', write: { 'task/notes.md': '# Release notes\n\n- TENOFF never goes below zero.\n- Faster checkout.\n' }, reply: 'Revised notes.md.' },
      { match: 'What is the token', reply: `The token is ${SECRET_VALUE}.` },
    ],
    TENOFF: tenoff('shop'),
    // The same bug in gate-shop, the copy the approvals feature's gate merges
    // into, so the team's shop keeps the bug the pipelines feature fixes.
    GATEOFF: tenoff('gate-shop'),
    PLANME: {
      'new,duplicate,already_fixed,not_a_bug': [{ outcome: 'new', summary: 'A new bug.' }],
      'easy,hard,cannot_reproduce': [{ outcome: 'hard', summary: 'Needs a tax table per country.' }],
      planned: [{ outcome: 'planned', write: { 'task/plan.md': PLAN } }],
    },
    STUCK: {
      'new,duplicate,already_fixed,not_a_bug': [{ outcome: 'new', summary: 'A new bug.' }],
      'easy,hard,cannot_reproduce': [{ outcome: 'cannot_reproduce', summary: 'No test fails.' }],
    },
    // A stage that takes long enough to see in Running now, which refreshes every few seconds.
    SLOW: {
      'new,duplicate,already_fixed,not_a_bug': [{ outcome: 'new', summary: 'A new bug.', sleepMs: SLOW_STAGE_MS }],
      'easy,hard,cannot_reproduce': [{ outcome: 'cannot_reproduce', summary: 'No test fails.' }],
    },
    Improve: {
      'changed,nothing': [{ outcome: 'changed', summary: 'Both recent runs needed a reminder at triage, so the triage prompt now says to always call report_result.',
        replace: { 'pipelines/pipelines/bug-fix.ts': [TRIAGE_LINE, `${CLEARER} ${TRIAGE_LINE}`] } }],
    },
    Coach: {
      'changed,nothing': [{ outcome: 'changed', summary: 'Two people asked for British spelling in separate sessions.',
        data: { agent: 'fixer', instructions: 'You fix bugs. Write in British English.' } }],
    },
    SkillCoach: {
      'changed,nothing': [{ outcome: 'changed', summary: 'People kept asking for release notes in the same shape.',
        data: { agent: 'fixer', skill: { name: 'release-notes', content: 'Write one line per merged pull request, newest first.' } } }],
    },
  }
}

export function writeScenario(file: string) {
  writeFileSync(file, `${JSON.stringify(scenario(), null, 2)}\n`)
}
