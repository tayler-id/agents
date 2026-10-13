// The work layer's shapes, defined once for the server, the daemon and the app:
// draft tasks, the changes in a task's workspace, and pushes that open pull
// requests. The design is docs/design/workflow.md.

import { z } from 'zod'
import { AgentId, ArtifactId, ConversationId, FileChangeId, MessageId, PersonId, PushId, RepoId, TaskId, WorkspaceId } from './ids.ts'
import type { SessionStatus } from './types.ts'

// A pull request's title is the task's title, so both share the forge's limit.
const TITLE_MAX = 255
// A first message long enough for a pasted spec, short enough to read in a prompt.
const TEXT_MAX = 50_000
// The repos one workspace clones. More would make one task's setup take minutes.
const REPOS_MAX = 10

// A task's title, its first message to the agent, its agent and its repos, the
// first repo primary.
export const TaskFields = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  instructions: z.string().max(TEXT_MAX),
  agentId: AgentId,
  repoIds: z.array(RepoId).max(REPOS_MAX),
})
export type TaskFields = z.infer<typeof TaskFields>

// POST /v1/tasks. `repoId` is the one repo the app sent before tasks took
// several, and branches made before this one still send it.
export const NewTask = TaskFields.extend({
  instructions: z.string().max(TEXT_MAX).default(''),
  repoIds: z.array(RepoId).max(REPOS_MAX).default([]),
  repoId: RepoId.optional(),
  conversationId: ConversationId.optional(),
  messageId: MessageId.optional(),
  draft: z.boolean().default(false),
})
export type NewTask = z.infer<typeof NewTask>

// A draft task is written now and started later. Its state follows from its
// one session: the draft status until it starts, and archived once discarded.
export const DRAFT_STATES = ['draft', 'started', 'discarded'] as const
export type DraftState = (typeof DRAFT_STATES)[number]

export const DraftAction = z.enum(['edit', 'start', 'discard'])
export type DraftAction = z.infer<typeof DraftAction>

// What a person can do to a draft, the state each needs, and the state it leaves.
export const DRAFT_ACTIONS: Record<DraftAction, { from: DraftState; to: DraftState }> = {
  edit: { from: 'draft', to: 'draft' },
  start: { from: 'draft', to: 'started' },
  discard: { from: 'draft', to: 'discarded' },
}

// A row of the task_repos shape: one of a task's repos, for editing a draft.
export const TaskRepoRow = z.object({ task_id: TaskId, repo_id: RepoId, is_primary: z.boolean() })
export type TaskRepoRow = z.infer<typeof TaskRepoRow>

export function draftState(session: { status: SessionStatus; archived: boolean }): DraftState {
  if (session.status !== 'draft') return 'started'
  return session.archived ? 'discarded' : 'draft'
}

// Changes. A machine reports each file that differs from the base branch in a
// workspace's repos, and the app shows them.

export const CHANGE_STATUSES = ['added', 'modified', 'deleted'] as const
export type ChangeStatus = (typeof CHANGE_STATUSES)[number]

// What the app can show of a changed file: its text and its diff, or neither.
export const PREVIEWS = ['text', 'binary', 'too_large'] as const
export type Preview = (typeof PREVIEWS)[number]

export const CHANGE_LIMITS = {
  // Characters of one file's content, or of its diff. A file bigger than this is
  // generated or data, and no one reads it in a side panel.
  text: 512 * 1024,
  // Characters of content and diffs in one post, well under the API's 20 MB body
  // limit. Files past it go in a later post, which the API asks for.
  post: 4_000_000,
  // Files listed for one repo, and repos for one workspace.
  files: 20_000,
  repos: REPOS_MAX,
  path: 4096,
}

const ChangeFacts = z.object({
  path: z.string().min(1).max(CHANGE_LIMITS.path),
  status: z.enum(CHANGE_STATUSES),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  // The old blob, the new blob and the status, so the same hash means the same change.
  hash: z.string().min(1).max(200),
})

// One changed file in a machine's post. `facts` carries no content, because the
// API already has it or because it did not fit this post. The API names any it
// lacks, and the machine sends those in full.
export const ChangedFile = z.discriminatedUnion('sent', [
  ChangeFacts.extend({ sent: z.literal('facts') }),
  ChangeFacts.extend({ sent: z.literal('text'), content: z.string().max(CHANGE_LIMITS.text).nullable(), diff: z.string().max(CHANGE_LIMITS.text) }),
  ChangeFacts.extend({ sent: z.literal('binary') }),
  ChangeFacts.extend({ sent: z.literal('too_large') }),
]).refine((file) => file.sent !== 'text' || (file.status === 'deleted') === (file.content === null),
  'a text file has its content, unless it was deleted')
export type ChangedFile = z.infer<typeof ChangedFile>

export const RepoChanges = z.object({
  repoId: RepoId,
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/, 'baseCommit must be a full commit id'),
  files: z.array(ChangedFile).max(CHANGE_LIMITS.files),
})
export type RepoChanges = z.infer<typeof RepoChanges>

// POST /v1/workspaces/:id/changes, from the workspace's machine.
export const ChangesPost = z.object({ repos: z.array(RepoChanges).max(CHANGE_LIMITS.repos) })
export type ChangesPost = z.infer<typeof ChangesPost>
export const ChangesReply = z.object({ missing: z.array(z.object({ repoId: RepoId, path: z.string() })) })
export type ChangesReply = z.infer<typeof ChangesReply>

const FileChangeFields = {
  id: FileChangeId,
  task_id: TaskId,
  workspace_id: WorkspaceId,
  repo_id: RepoId,
  path: z.string(),
  status: z.enum(CHANGE_STATUSES),
  additions: z.number().int(),
  deletions: z.number().int(),
  preview: z.enum(PREVIEWS),
  base_commit: z.string(),
  updated_at: z.string(),
}

// A row of the file_changes shape: the task's changed files, without contents.
export const FileChangeRow = z.object(FileChangeFields)
export type FileChangeRow = z.infer<typeof FileChangeRow>
export const FILE_CHANGE_COLUMNS = Object.keys(FileChangeFields)

// A row of the file_change shape: one file with what the app can show of it.
export const FileChangeDetail = z.discriminatedUnion('preview', [
  z.object({ ...FileChangeFields, preview: z.literal('text'), content: z.string().nullable(), diff: z.string() }),
  z.object({ ...FileChangeFields, preview: z.literal('binary'), content: z.null(), diff: z.null() }),
  z.object({ ...FileChangeFields, preview: z.literal('too_large'), content: z.null(), diff: z.null() }),
]).refine((file) => file.preview !== 'text' || (file.status === 'deleted') === (file.content === null),
  'a text file has its content, unless it was deleted')
export type FileChangeDetail = z.infer<typeof FileChangeDetail>
export const FILE_CHANGE_DETAIL_COLUMNS = [...FILE_CHANGE_COLUMNS, 'content', 'diff']

// Pushes. A person asks for a task's branches to be pushed and pull requests
// opened. Only a push in flight moves, and it moves once.

export const PUSH_STATUSES = ['pushing', 'done', 'failed'] as const
export type PushStatus = (typeof PUSH_STATUSES)[number]
export const PUSH_TRANSITIONS = {
  pushing: ['done', 'failed'],
  done: [],
  failed: [],
} as const satisfies Record<PushStatus, readonly PushStatus[]>

export function canMove(from: PushStatus, to: PushStatus): boolean {
  const next: readonly PushStatus[] = PUSH_TRANSITIONS[from]
  return next.includes(to)
}

// POST /v1/tasks/:id/pull-requests: the title and description of each pull request.
export const PullRequestAsk = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  body: z.string().max(TEXT_MAX),
})
export type PullRequestAsk = z.infer<typeof PullRequestAsk>

const PushFields = {
  id: PushId,
  task_id: TaskId,
  requested_by: PersonId.nullable(),
  title: z.string(),
  created_at: z.string(),
}

// A row of the pushes shape.
export const PushRow = z.discriminatedUnion('status', [
  z.object({ ...PushFields, status: z.literal('pushing'), error: z.null(), finished_at: z.null() }),
  z.object({ ...PushFields, status: z.literal('done'), error: z.null(), finished_at: z.string() }),
  z.object({ ...PushFields, status: z.literal('failed'), error: z.string(), finished_at: z.string() }),
])
export type PushRow = z.infer<typeof PushRow>
export const PUSH_COLUMNS = [...Object.keys(PushFields), 'status', 'error', 'finished_at']

// A row of the documents shape: every document of every task the person may
// see, without contents, for the command palette.
export const DocumentRow = z.object({ id: ArtifactId, task_id: TaskId, title: z.string(), path: z.string(), updated_at: z.string() })
export type DocumentRow = z.infer<typeof DocumentRow>
export const DOCUMENT_COLUMNS = Object.keys(DocumentRow.shape)

// A quote names a passage, not a document's worth of text.
const QUOTE_MAX = 2000
// More matches than this in one version means the quote is too short to place.
const OCCURRENCE_MAX = 10_000

// Where a comment sits in its version: the quoted text and which of its
// matches, counted from zero. A quote typed by hand means the first match.
export const CommentAnchor = z.object({
  quote: z.string().trim().min(1).max(QUOTE_MAX),
  occurrence: z.number().int().min(0).max(OCCURRENCE_MAX).default(0),
})
export type CommentAnchor = z.infer<typeof CommentAnchor>

// POST /v1/artifacts/:id/comments. Sent to the agent, the comment reaches the
// session that wrote the document.
export const NewComment = z.object({
  version: z.number().int().min(1),
  text: z.string().trim().min(1).max(TEXT_MAX),
  quote: z.string().trim().min(1).max(QUOTE_MAX).optional(),
  occurrence: z.number().int().min(0).max(OCCURRENCE_MAX).optional(),
  send: z.boolean().default(false),
}).refine((comment) => comment.occurrence === undefined || comment.quote !== undefined, 'occurrence places a quote, so it needs one')
export type NewComment = z.infer<typeof NewComment>
