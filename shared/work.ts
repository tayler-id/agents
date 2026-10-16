// The work layer's shapes, defined once for the server, the daemon and the app:
// draft tasks, the changes in a task's workspace, and pushes that open pull
// requests. The design is docs/design/workflow.md.

import { z } from 'zod'
import { AgentId, ArtifactId, ConversationId, FileChangeId, MessageId, PersonId, PushId, RepoId, TaskId, WorkspaceId } from './ids.ts'
import { ProjectId } from './projects.ts'

// A pull request's title is the task's title, so both share the forge's limit.
const TITLE_MAX = 255
// A first message long enough for a pasted spec, short enough to read in a prompt.
export const TEXT_MAX = 50_000
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
  // The project it starts in. Without one it joins its first repo's project.
  projectId: ProjectId.optional(),
  draft: z.boolean().default(false),
})
export type NewTask = z.infer<typeof NewTask>

// POST /v1/tasks/:id/edit. `loaded` is the draft as the person's form loaded it,
// so a save over a teammate's newer edit is refused instead of undoing it. A
// draft whose agent was removed loads with none.
export const DraftEdit = TaskFields.extend({ loaded: TaskFields.extend({ agentId: AgentId.nullable() }) })
export type DraftEdit = z.infer<typeof DraftEdit>

// A task's state, from what is stored. A draft is queued: written, not started.
// A started task is active until someone marks it done. A discarded draft is
// archived.
export const TASK_STATES = ['queued', 'active', 'done', 'discarded'] as const
export type TaskState = (typeof TASK_STATES)[number]

// A queued task carries its draft, the session that starts when it does.
export type StateOf<D> = { state: 'queued'; draft: D } | { state: Exclude<TaskState, 'queued'>; draft: null }

export function taskState<D>(task: { archived: boolean; done: boolean; draft: D | null }): StateOf<D> {
  if (task.archived) return { state: 'discarded', draft: null }
  if (task.done) return { state: 'done', draft: null }
  return task.draft === null ? { state: 'active', draft: null } : { state: 'queued', draft: task.draft }
}

export const TaskAction = z.enum(['edit', 'start', 'discard', 'done', 'reopen', 'prioritize', 'block', 'unblock', 'hold', 'unhold'])
export type TaskAction = z.infer<typeof TaskAction>

// Each action, the states it may start from and the state it leaves the task in.
// Marking a done task done, or reopening one that is not done, changes nothing,
// and the command says so. Reopening a task returns it to where it was, queued
// if it never started, so its `to` is `reopened`.
export const TASK_ACTIONS: Record<TaskAction, { from: readonly TaskState[]; to: TaskState | 'same' | 'reopened' }> = {
  edit: { from: ['queued'], to: 'queued' },
  start: { from: ['queued'], to: 'active' },
  discard: { from: ['queued'], to: 'discarded' },
  done: { from: ['queued', 'active', 'done'], to: 'done' },
  reopen: { from: ['queued', 'active', 'done'], to: 'reopened' },
  prioritize: { from: ['queued', 'active'], to: 'same' },
  block: { from: ['queued', 'active'], to: 'same' },
  unblock: { from: ['queued', 'active', 'done'], to: 'same' },
  hold: { from: ['queued', 'active'], to: 'same' },
  unhold: { from: ['queued', 'active', 'done'], to: 'same' },
}

// A row of the task_repos shape: one of a task's repos, for editing a draft.
export const TaskRepoRow = z.object({ task_id: TaskId, repo_id: RepoId, is_primary: z.boolean() })
export type TaskRepoRow = z.infer<typeof TaskRepoRow>

// The order of work: what blocks a task, what holds it, and what is ready.

// What every command that changes the order of work answers. `already` is true
// when there was nothing to change, so running a command twice is safe.
export const Outcome = z.object({ already: z.boolean() })
export type Outcome = z.infer<typeof Outcome>

// A reason a person reads in a list, so one line.
const LINE_MAX = 200
const Line = z.string().trim().min(1).max(LINE_MAX).regex(/^[^\r\n]*$/, 'a reason is one line')

export const PRIORITIES = [0, 1, 2, 3, 4] as const
// 0 is the most urgent. A new task is in the middle.
export const DEFAULT_PRIORITY = 2
export const Priority = z.number().int().min(0).max(4)

// What a held task waits on: a person's decision, something outside the team,
// load on people or machines, a choice to park it, or a later date.
export const HOLD_KINDS = ['decision', 'external', 'load', 'parked', 'future'] as const
export const HoldKind = z.enum(HOLD_KINDS)
export type HoldKind = z.infer<typeof HoldKind>

// POST /v1/tasks/:id/blockers: the task that blocks this one, and why.
export const BlockAsk = z.object({ blockerId: TaskId, reason: Line.nullable() })
export type BlockAsk = z.infer<typeof BlockAsk>
// POST /v1/tasks/:id/hold. The hold lapses on its until date, a YYYY-MM-DD.
export const HoldAsk = z.object({ kind: HoldKind, reason: Line, until: z.iso.date().nullable() })
export type HoldAsk = z.infer<typeof HoldAsk>
// POST /v1/tasks/:id/priority.
export const PriorityAsk = z.object({ priority: Priority })

// A row of the task_blocks shape: one edge touching a task.
export const TaskBlockRow = z.object({ blocked_id: TaskId, blocker_id: TaskId, reason: z.string().nullable(), created_at: z.string() })
export type TaskBlockRow = z.infer<typeof TaskBlockRow>
// A row of the task_holds shape: a task's hold, current or lapsed.
export const TaskHoldRow = z.object({
  task_id: TaskId, kind: HoldKind, reason: z.string(), until: z.string().nullable(), held_by: PersonId.nullable(), created_at: z.string(),
})
export type TaskHoldRow = z.infer<typeof TaskHoldRow>

// The ready query's answer: queued tasks nothing blocks or holds, most urgent
// and then oldest first, and beside them the held tasks with why.
export const ReadyTask = z.object({ id: TaskId, title: z.string(), priority: Priority, agent: z.string().nullable(), created_at: z.string() })
export type ReadyTask = z.infer<typeof ReadyTask>
export const HeldTask = z.object({
  id: TaskId, title: z.string(), state: z.enum(['queued', 'active']), kind: HoldKind, reason: z.string(),
  until: z.iso.date().nullable(), held_by: z.string().nullable(),
})
export type HeldTask = z.infer<typeof HeldTask>
export const ReadyAnswer = z.object({ ready: z.array(ReadyTask), held: z.array(HeldTask) })
export type ReadyAnswer = z.infer<typeof ReadyAnswer>

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
  // Files listed for one repo. Past this the machine stops counting and the app
  // says there are too many, since staging that many on every turn takes minutes.
  files: 20_000,
  // Repos in one workspace.
  repos: REPOS_MAX,
  path: 4096,
  // Characters of why git could not read a repo, enough for its error lines.
  reason: 2000,
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

// One repo of a machine's post: its changed files, or why they are not listed.
// A repo with too many is never staged, and one git cannot read keeps its last list.
export const RepoChanges = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('listed'),
    repoId: RepoId,
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/, 'baseCommit must be a full commit id'),
    files: z.array(ChangedFile).max(CHANGE_LIMITS.files),
  }),
  z.object({ state: z.literal('too_many'), repoId: RepoId }),
  z.object({ state: z.literal('unreadable'), repoId: RepoId, reason: z.string().min(1).max(CHANGE_LIMITS.reason) }),
])
export type RepoChanges = z.infer<typeof RepoChanges>

// POST /v1/workspaces/:id/changes, from the workspace's machine.
export const ChangesPost = z.object({ repos: z.array(RepoChanges).max(CHANGE_LIMITS.repos) })
export type ChangesPost = z.infer<typeof ChangesPost>
export const ChangesReply = z.object({ missing: z.array(z.object({ repoId: RepoId, path: z.string() })) })
export type ChangesReply = z.infer<typeof ChangesReply>

// GET /v1/instance/workspaces/:id/setup, for the workspace's machine: whether its
// setup command is still queued or running.
export const WorkspaceSetup = z.object({ settingUp: z.boolean() })
export type WorkspaceSetup = z.infer<typeof WorkspaceSetup>

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

const UnlistedFields = { task_id: TaskId, workspace_id: WorkspaceId, repo_id: RepoId, updated_at: z.string() }

// A row of the unlisted_changes shape: a repo of the task whose changes are not listed, and why.
export const UnlistedChangeRow = z.discriminatedUnion('kind', [
  z.object({ ...UnlistedFields, kind: z.literal('too_many'), reason: z.null() }),
  z.object({ ...UnlistedFields, kind: z.literal('unreadable'), reason: z.string() }),
])
export type UnlistedChangeRow = z.infer<typeof UnlistedChangeRow>
export const UNLISTED_CHANGE_COLUMNS = [...Object.keys(UnlistedFields), 'kind', 'reason']

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
