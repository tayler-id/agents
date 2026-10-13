// Projects: a team's work on one thing. Making one writes the project, its room
// and a request for its GitHub repo in one transaction, then asks GitHub, then
// records the repo. Each try at a request looks the repo up first, so trying
// again adopts a repo an earlier try made instead of making a second one.

import type pg from 'pg'
import { maybe, one, pool, tx } from './db.ts'
import { ForgeError, repoPath } from './forge.ts'
import { explainGithub, github, githubRemoteUrl, type GithubRepo } from './github.ts'
import { defaultOwner, type Who } from './github-auth.ts'
import { HttpError, scrub, type Person } from './record.ts'
import { createRoom } from './rooms.ts'
import {
  RepoName, repoNameFor,
  type AddRepoBody, type NewProjectBody, type ProjectId, type REPO_REQUEST_MOVES, type RepoId, type RepoRequestId, type RepoRequestStatus,
} from '../shared/projects.ts'

// A call to GitHub made while a person waits. Its failure reaches them with
// GitHub's reason: 503 when GitHub is off or no sign-in reaches it, 502 otherwise.
export async function askGithub<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw new HttpError(error instanceof ForgeError && error.status === 503 ? 503 : 502, explainGithub(error))
  }
}

// Unique names, told to the person who picked one already taken.
function refuseDuplicate(error: unknown): never {
  const constraint = error instanceof Error && 'constraint' in error ? error.constraint : null
  if (constraint === 'projects_name') throw new HttpError(409, 'There is already a project with that name.')
  if (constraint === 'repo_requests_name') throw new HttpError(409, 'That repo was asked for already. Its project page shows how it went.')
  throw error
}

// The moves a repo request makes, each with what its new state needs.
type Move = { to: 'done'; repoId: RepoId } | { to: 'failed'; error: string } | { to: 'creating' }
// The state each move starts from. The type checks each against REPO_REQUEST_MOVES.
type FromOf<T extends RepoRequestStatus> = {
  [F in RepoRequestStatus]: T extends (typeof REPO_REQUEST_MOVES)[F][number] ? F : never
}[RepoRequestStatus]
const FROM = { done: 'creating', failed: 'creating', creating: 'failed' } as const satisfies { [T in Move['to']]: FromOf<T> }

// Moves a request on, if it is still in the state the move starts from.
async function move(client: pg.PoolClient, id: RepoRequestId, next: Move): Promise<boolean> {
  const { rowCount } = await client.query(
    `update repo_requests set status = $3, repo_id = $4, error = $5, updated_at = now() where id = $1 and status = $2`,
    [id, FROM[next.to], next.to, next.to === 'done' ? next.repoId : null, next.to === 'failed' ? next.error : null])
  return rowCount === 1
}

async function requestRepo(client: pg.PoolClient, person: Person, projectId: ProjectId, owner: string, name: RepoName, description: string) {
  const request = await one<{ id: RepoRequestId }>(client, 'the new repo request',
    `insert into repo_requests (team_id, project_id, owner, name, description, requested_by)
     values ($1, $2, $3, $4, $5, $6) returning id`, [person.team_id, projectId, owner, name, description, person.id])
  return request.id
}

// A project of the person's team, not archived.
async function projectOf(person: Person, projectId: ProjectId) {
  const project = await maybe<{ id: ProjectId; description: string }>(pool,
    'select id, description from projects where id = $1 and team_id = $2 and archived_at is null', [projectId, person.team_id])
  if (!project) throw new HttpError(404, 'no such project')
  return project
}

export async function createProject(person: Person, body: NewProjectBody) {
  const name = RepoName.safeParse(repoNameFor(body.name))
  if (!name.success) throw new HttpError(400, 'A project name needs a letter or a digit, which its repo is named after.')
  const owner = body.owner ?? await askGithub(() => defaultOwner(person.id))
  const taken = await askGithub(() => github.repo({ person: person.id }, owner, name.data))
  if (taken) {
    throw new HttpError(409, `${taken.full_name} already exists on GitHub. Name the project differently, or add that repo to a project from the project's page.`)
  }
  const made = await tx(async (client) => {
    const project = await one<{ id: ProjectId }>(client, 'the new project',
      'insert into projects (team_id, name, description, created_by) values ($1, $2, $3, $4) returning id',
      [person.team_id, body.name, body.description, person.id])
    const conversationId = await createRoom(client, person, body.name, body.people, body.agents, project.id)
    await client.query('update projects set conversation_id = $2 where id = $1', [project.id, conversationId])
    const requestId = await requestRepo(client, person, project.id, owner, name.data, body.description)
    return { projectId: project.id, conversationId, requestId }
  }).catch(refuseDuplicate)
  await fulfillRepoRequest(made.requestId)
  return made
}

// Asks GitHub for a requested repo, made if missing, and records it. GitHub is
// asked as the person who asked for the repo, whose sign-in the repo's calls use
// from then on. The request stays locked while GitHub is asked, so two servers
// never ask for one repo at once, and a try that finds it taken or settled does nothing.
export async function fulfillRepoRequest(requestId: RepoRequestId): Promise<void> {
  await tx(async (client) => {
    const request = await maybe<{ team_id: string; project_id: ProjectId; owner: string; name: RepoName; description: string; requested_by: string | null }>(client,
      `select team_id, project_id, owner, name, description, requested_by from repo_requests
       where id = $1 and status = 'creating' for update skip locked`, [requestId])
    if (!request) return
    if (!request.requested_by) {
      await move(client, requestId, { to: 'failed', error: 'The person who asked for this repo has left the team. Try again to ask for it yourself.' })
      return
    }
    const who: Who = { person: request.requested_by }
    let repo: GithubRepo
    try {
      repo = await github.repo(who, request.owner, request.name) ?? await github.createRepo(who, request.owner, request.name, request.description)
    } catch (error) {
      // GitHub said no or could not be reached. The request keeps the reason, and
      // Try again starts over. Failures after this point are Postgres's, and leave
      // the request creating for the GitHub worker to try again.
      await move(client, requestId, { to: 'failed', error: scrub(explainGithub(error)) })
      return
    }
    const row = await one<{ id: RepoId; project_id: ProjectId | null }>(client, 'the registered repo',
      `insert into repos (team_id, forge, remote_url, default_branch, project_id) values ($1, 'github', $2, $3, $4)
       on conflict (team_id, remote_url) do update set project_id = coalesce(repos.project_id, excluded.project_id)
       returning id, project_id`,
      [request.team_id, githubRemoteUrl(repo.full_name), repo.default_branch, request.project_id])
    await move(client, requestId, row.project_id === request.project_id
      ? { to: 'done', repoId: row.id }
      : { to: 'failed', error: `${repo.full_name} already belongs to another project.` })
  })
}

// Whoever tries a failed request again asks for the repo as themselves from then on.
export async function retryRepoRequest(person: Person, requestId: RepoRequestId) {
  const moved = await tx(async (client) => {
    const owned = await maybe(client, 'select 1 from repo_requests where id = $1 and team_id = $2', [requestId, person.team_id])
    if (!owned) throw new HttpError(404, 'no such repo request')
    const retried = await move(client, requestId, { to: 'creating' })
    if (retried) await client.query('update repo_requests set requested_by = $2 where id = $1', [requestId, person.id])
    return retried
  })
  if (!moved) throw new HttpError(409, 'Only a request that failed can be tried again.')
  await fulfillRepoRequest(requestId)
}

// A GitHub repo by name, made when it does not exist, or a team repo that
// belongs to no project yet.
export async function addRepoToProject(person: Person, projectId: ProjectId, body: AddRepoBody): Promise<{ requestId: RepoRequestId } | { repoId: RepoId }> {
  const project = await projectOf(person, projectId)
  if ('repoId' in body) {
    const { rowCount } = await pool.query(
      'update repos set project_id = $1 where id = $2 and team_id = $3 and project_id is null', [project.id, body.repoId, person.team_id])
    if (!rowCount) throw new HttpError(409, "That repo isn't one of the team's repos without a project.")
    return { repoId: body.repoId }
  }
  const owner = body.owner ?? await askGithub(() => defaultOwner(person.id))
  const requestId = await tx((client) => requestRepo(client, person, project.id, owner, body.name, project.description)).catch(refuseDuplicate)
  await fulfillRepoRequest(requestId)
  return { requestId }
}

// Puts a task in its project: the one it was started in, or else the project
// of its first repo. A task in a project works only in that project's repos.
export async function placeTask(client: pg.PoolClient, taskId: string, projectId?: ProjectId) {
  if (!projectId) {
    await client.query(
      `update tasks set project_id = (select r.project_id from task_repos tr join repos r on r.id = tr.repo_id
         where tr.task_id = $1 order by tr.is_primary desc, r.created_at, r.id limit 1)
       where id = $1`, [taskId])
    return
  }
  const project = await maybe(client,
    'select 1 from projects p join tasks t on t.team_id = p.team_id where p.id = $1 and t.id = $2 and p.archived_at is null', [projectId, taskId])
  if (!project) throw new HttpError(404, 'no such project')
  const outside = await maybe<{ remote_url: string }>(client,
    `select r.remote_url from task_repos tr join repos r on r.id = tr.repo_id
     where tr.task_id = $1 and r.project_id is distinct from $2 order by r.created_at, r.id limit 1`, [taskId, projectId])
  if (outside) throw new HttpError(400, `${repoPath(outside.remote_url)} is not one of this project's repos. Add it to the project first.`)
  await client.query('update tasks set project_id = $2 where id = $1', [taskId, projectId])
}
