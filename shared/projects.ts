// Projects and repos as the server, the app and the checks see them. Each shape
// is defined once, here, as a zod schema, and its type is inferred from it. The
// design is in docs/design/projects.md.

import { z } from 'zod'

export const ProjectId = z.uuid().brand<'ProjectId'>()
export type ProjectId = z.infer<typeof ProjectId>
export const RepoRequestId = z.uuid().brand<'RepoRequestId'>()
export type RepoRequestId = z.infer<typeof RepoRequestId>
export const RepoId = z.uuid().brand<'RepoId'>()
export type RepoId = z.infer<typeof RepoId>

// The characters GitHub allows in a repo name. The migration checks the same.
export const RepoName = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, 'A repo name is letters, digits, dots, dashes and underscores.')
export type RepoName = z.infer<typeof RepoName>
// A GitHub organization or account name.
export const GithubOwner = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, 'An organization or account name is letters, digits and dashes.')
// A fine-grained personal access token, github_pat_ and 82 characters. The
// stopgap takes no classic token, which reaches every repo its account can.
export const FineGrainedToken = z.string().regex(/^github_pat_[A-Za-z0-9_]{20,255}$/,
  'The stopgap takes a fine-grained personal access token, which starts with github_pat_. A classic token reaches every repo its account can.')

export const PROJECT_NAME_MAX = 80
// The repo a project's name makes: lowercase, with anything GitHub would refuse
// turned into dashes.
export function repoNameFor(projectName: string): string {
  return projectName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100)
}

// Rows as Electric sends them, with times as Postgres writes them.
export const ProjectRow = z.object({
  id: ProjectId, team_id: z.uuid(), name: z.string(), description: z.string(), conversation_id: z.uuid().nullable(),
  created_by: z.uuid().nullable(), archived_at: z.string().nullable(), created_at: z.string(),
})
export type ProjectRow = z.infer<typeof ProjectRow>

// A repo request moves creating → done or failed, and failed → creating when
// someone tries again. Only failed has an error, and only done a repo, which
// is null again if that repo is removed later.
export const REPO_REQUEST_MOVES = { creating: ['done', 'failed'], failed: ['creating'], done: [] } as const
export type RepoRequestStatus = keyof typeof REPO_REQUEST_MOVES
const requestRow = {
  id: RepoRequestId, team_id: z.uuid(), project_id: ProjectId, owner: z.string(), name: RepoName, description: z.string(),
  requested_by: z.uuid().nullable(), created_at: z.string(), updated_at: z.string(),
}
export const RepoRequestRow = z.discriminatedUnion('status', [
  z.object({ ...requestRow, status: z.literal('creating'), error: z.null(), repo_id: z.null() }),
  z.object({ ...requestRow, status: z.literal('done'), error: z.null(), repo_id: RepoId.nullable() }),
  z.object({ ...requestRow, status: z.literal('failed'), error: z.string(), repo_id: z.null() }),
])
export type RepoRequestRow = z.infer<typeof RepoRequestRow>

// A person's own GitHub sign-in on this server. Never the token.
export const YourGithub = z.discriminatedUnion('state', [
  z.object({ state: z.literal('none') }),
  // Waiting for the person to enter the code on GitHub's device page.
  z.object({ state: z.literal('waiting'), userCode: z.string(), verificationUri: z.string(), expiresAt: z.string() }),
  // The last sign-in ended without a token, for this reason.
  z.object({ state: z.literal('stopped'), reason: z.string() }),
  z.object({ state: z.literal('connected'), login: z.string(), savedAt: z.string() }),
])
export type YourGithub = z.infer<typeof YourGithub>

// GitHub on this server, as one person sees it: off until the server's settings
// name it, then whether people can sign in, the person's own sign-in, and the
// stopgap token's account if an admin set one.
export const GithubStatus = z.discriminatedUnion('state', [
  // `missing` names the settings to add.
  z.object({ state: z.literal('off'), missing: z.array(z.string()) }),
  z.object({
    state: z.literal('on'), signIn: z.boolean(), you: YourGithub, stopgap: z.object({ login: z.string(), owner: z.string() }).nullable(),
  }),
])
export type GithubStatus = z.infer<typeof GithubStatus>

// The forge that holds a repo, as repos.forge says: this Mac's Gitea, or GitHub.
export const RepoForge = z.enum(['gitea', 'github'])
export type RepoForge = z.infer<typeof RepoForge>

export const OpenPullRequest = z.object({ number: z.number().int(), title: z.string(), url: z.string(), branch: z.string() })
export type OpenPullRequest = z.infer<typeof OpenPullRequest>

// The project a repo belongs to, as much as a list of repos shows of it.
export const ProjectRef = z.object({ id: ProjectId, name: z.string() })
export type ProjectRef = z.infer<typeof ProjectRef>

// One repo on the Repos page. What is open on it comes from its forge, which
// may not answer, and then the page says why.
export const RepoView = z.object({
  id: RepoId, name: z.string(), forge: RepoForge, webUrl: z.string(), defaultBranch: z.string(), project: ProjectRef.nullable(),
  open: z.discriminatedUnion('read', [
    z.object({ read: z.literal(true), pullRequests: z.array(OpenPullRequest), taskBranches: z.array(z.string()) }),
    z.object({ read: z.literal(false), problem: z.string() }),
  ]),
})
export type RepoView = z.infer<typeof RepoView>

export const ReposOverview = z.object({ github: GithubStatus, repos: z.array(RepoView) })
export type ReposOverview = z.infer<typeof ReposOverview>

// Request bodies.
// `owner` is the GitHub organization or account the repo goes under. Left out,
// it is the person's own account, or the stopgap's organization.
export const NewProjectBody = z.object({
  name: z.string().trim().min(1, 'A project needs a name.').max(PROJECT_NAME_MAX),
  description: z.string().trim().max(300),
  people: z.array(z.string()),
  agents: z.array(z.string()),
  owner: GithubOwner.optional(),
})
export type NewProjectBody = z.infer<typeof NewProjectBody>
// A GitHub repo by name, made if it does not exist, or a team repo that belongs to no project.
export const AddRepoBody = z.union([z.object({ name: RepoName, owner: GithubOwner.optional() }), z.object({ repoId: RepoId })])
export type AddRepoBody = z.infer<typeof AddRepoBody>
// The stopgap: an admin's personal access token for the whole team.
export const StopgapBody = z.object({ owner: GithubOwner, token: FineGrainedToken })

// Responses.
export const NewProjectResult = z.object({ projectId: ProjectId, conversationId: z.uuid(), requestId: RepoRequestId })
export const AddRepoResult = z.union([z.object({ requestId: RepoRequestId }), z.object({ repoId: RepoId })])
