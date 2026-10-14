// What a pipeline file exports. A pipeline is a set of named stages and, for each
// way a stage can end, where the run goes next. The runner keeps every run's
// state in Postgres, so a pipeline file holds no state of its own.
//
// Pipeline files import this module for types only (`import type`), because a
// version is loaded from its stored source, outside this repo.
//
// A pipeline may name its stages as a union, `Pipeline<'triage' | 'fix'>`, so the
// compiler checks every stage it starts at or leads to exists.

// Where a run starts from.
export type Trigger =
  | { kind: 'forge'; event: 'issues'; action: 'opened'; label?: string }
  | { kind: 'webhook' }
  // `repo` is the forge path of the repo the run works in, such as team/shop.
  | { kind: 'cron'; schedule: string; title: string; body?: string; repo: string }
  | { kind: 'manual' }

// What a run is about: an issue on the forge, a webhook's report, or a person's request.
export type Report = { title: string; body: string; issue?: number; url?: string; author?: string }

export type StageResult = { outcome: string; summary: string; data: Record<string, unknown> }

// An open comment on one of the run's documents, with the text it quotes.
export type RunComment = { path: string; version: number; quote: string | null; text: string; by: string }

// What a stage's prompt or command can draw on.
export type RunContext = {
  report: Report
  // Other open issues on the repo when the run started, for spotting duplicates.
  openIssues: { number: number; title: string }[]
  // The latest result of each stage that has finished, and how often each ran.
  results: Record<string, StageResult>
  attempts: Record<string, number>
  // The workspace's first repo, as a folder name, and the task's folder for documents.
  repo: string
  taskFolder: string
  // People's open comments on the documents in the task's folder, oldest first.
  comments: RunComment[]
  // Set when this run replays a past one to score a pipeline version.
  replay: boolean
  // The playbook a route stage picked, with its guide for the agent, on a repo with a policy.
  playbook: { name: string; guide: string } | null
}

// Where a run goes after a stage: another stage, the end, or a person.
export type Next<S extends string = string> = S | { done: 'succeeded' | 'failed'; note: string } | { handoff: string }

type Common<S extends string> = {
  // How the stage can end, and where each ending leads.
  next: Record<string, Next<S>>
}

// A turn of an agent's Claude session in the task's workspace. The agent ends it
// by calling report_result with one of `outcomes`. A stage that runs again keeps
// its session, so the agent remembers its earlier tries.
export type AgentStage<S extends string = string> = Common<S> & {
  kind: 'agent'
  agent?: string
  // The Claude model for this stage, such as haiku for cheap reading. The agent's own when unset.
  model?: string
  prompt: (ctx: RunContext) => string
  // Tools the stage may use without asking a person, in Claude's --allowedTools form.
  allow?: string[]
  // How many tries before a person takes over. Defaults to 3.
  maxAttempts?: number
  // A document the agent must leave in the task folder, with these headings,
  // before the stage counts as done. A plan is also linted, and the plan gate
  // pins the version a person approves.
  document?: { path: string; headings: string[]; plan: boolean }
}

// The coding framework's stages, for a repo with a policy. The runner, not an
// agent, decides how each ends. docs/design/self-improve.md describes them.

// An agent picks the playbook. Its outcomes are the playbooks named in `next`
// that the repo's policy allows.
export type RouteStage<S extends string = string> = Common<S> & { kind: 'route'; agent?: string; prompt: (ctx: RunContext) => string; allow?: string[] }

// The runner pushes the change, runs the static gates on it from its own copy
// of the repo, then has the box run the policy's commands and the changed
// checks. Ends as `passes`, `fails`, or `stopped` when the run must end at once.
export type VerifyStage<S extends string = string> = Common<S> & { kind: 'verify' }

// Reviewers, each on a model other than the author's and each other's, judge
// the change in sessions of their own, without the author's. Ends as `clean`,
// `fix` while rounds remain, or `overruled` when the repo's owner overrules
// the findings left at the last round.
export type ReviewStage<S extends string = string> = Common<S> & {
  kind: 'review'
  reviewers: string[]
  // The agent that wrote the change.
  author: string
  prompt: (ctx: RunContext) => string
  allow: string[]
}

// A fresh agent that did not write the change checks the plan's Done means and
// Keep items with the repo's verification skill, and gives a verdict from the
// ladder in shared/verification.ts. The runner reads what it ran from the record.
// Ends as `verified` when the verdict meets the policy's floor, `fix` when the
// verifier failed the change, or `overruled` when the owner accepts a weaker one.
export type ConfirmStage<S extends string = string> = Common<S> & {
  kind: 'confirm'
  verifier: string
  author: string
  prompt: (ctx: RunContext) => string
  allow: string[]
}

// The check host runs the policy's suite on the change merged into the current
// main, after a person approved running it. Ends as `passes` or `fails`.
export type SuiteStage<S extends string = string> = Common<S> & { kind: 'suite' }

// A command run in the repo's folder on the run's machine. Ends as `passes`
// (exit code 0) or `fails`.
export type CheckStage<S extends string = string> = Common<S> & { kind: 'check'; command: (ctx: RunContext) => string; maxAttempts?: number }

// Something the runner does, and the outcomes each can end with. Every action can
// fail. docs/design/evidence.md has the design of the ones coach uses.
// - open_pull_request: pushes the task branch and opens a pull request.
// - merge_pull_request: merges it, and marks the run's proposal approved.
// - close_issue: comments on the report's issue and closes it.
// - score_change: pushes the task branch, takes the one pipeline file it changed
//   as a candidate version, and splits the change into hunks citing the findings
//   the run recorded. Refused when it cites none, or repeats a hunk the team
//   turned down on the same evidence. Otherwise replays past runs of that
//   pipeline with the candidate and with the current version, and writes a
//   proposal with both scores.
// - pick_sessions: picks the sessions of the agent named in the report that have
//   events nobody has read, and writes them out for the next stage.
// - record_findings: keeps the findings the last agent stage reported whose
//   quotes are in the events they cite. Ready when a change has enough evidence.
// - propose_hunks: turns the hunks the last agent stage reported into a proposal,
//   refusing any that break the rules for changes.
// - replay_sessions: replays the turns behind the proposal, and a few unrelated
//   ones, with and without the change. Unscored when it changes no text.
// - decide_replays: scores both versions from the verdicts the last agent stage
//   reported. Better only when the change wins.
// - settle_hunks: records the decision on every hunk, and applies the kept ones.
// - merge_change: on a repo with a policy, merges the pull request at the
//   commit every gate judged, once the owner approved it. Ends as `done`,
//   `stale` when main moved since the suite ran, or `failed`.
// - deploy: asks the deployer to release what the run merged. Ends as `done`,
//   `rolled_back` when the health check failed and the release was undone, or `failed`.
// - ask_reporter: comments `text`, one question, on the report's issue and
//   leaves it open for the reporter to answer.
export const ACTION_OUTCOMES = {
  open_pull_request: ['done', 'failed'],
  merge_pull_request: ['done', 'failed'],
  close_issue: ['done', 'failed'],
  score_change: ['better', 'not_better', 'refused', 'failed'],
  pick_sessions: ['picked', 'none', 'failed'],
  record_findings: ['ready', 'waiting', 'failed'],
  propose_hunks: ['proposed', 'refused', 'failed'],
  replay_sessions: ['replayed', 'unscored', 'failed'],
  decide_replays: ['better', 'not_better', 'failed'],
  settle_hunks: ['applied', 'declined', 'failed'],
  merge_change: ['done', 'stale', 'failed'],
  deploy: ['done', 'rolled_back', 'failed'],
  ask_reporter: ['done', 'failed'],
} as const satisfies Record<string, readonly string[]>
export type Action = keyof typeof ACTION_OUTCOMES

export type ActionStage<S extends string = string> = Common<S> & {
  kind: 'action'
  action: Action
  // A pull request's title (the report's title by default), and its description
  // or the comment left when closing an issue.
  title?: (ctx: RunContext) => string
  text?: (ctx: RunContext) => string
}

// What a gate approves, on a repo with a policy. Only the repo's owner answers
// `protected`, `suite`, `merge` and `deploy`. A `protected` gate passes by
// itself when the change touched no protected path or dependency.
export const GATE_ROLES = ['plan', 'protected', 'suite', 'merge', 'deploy'] as const
export type GateRole = (typeof GATE_ROLES)[number]

// Waits for a person. Ends as `approved` or `rejected`. `labels` name its two
// buttons when Approve and Reject would not say what happens.
export type GateStage<S extends string = string> = Common<S> & {
  kind: 'gate'
  question: (ctx: RunContext) => string
  labels?: { approve: string; reject: string }
  role?: GateRole
}

export type Stage<S extends string = string> = AgentStage<S> | CheckStage<S> | ActionStage<S> | GateStage<S>
  | RouteStage<S> | VerifyStage<S> | ReviewStage<S> | ConfirmStage<S> | SuiteStage<S>

// A pipeline is named after its file: pipelines/bug-fix.ts is bug-fix.
export type Pipeline<S extends string = string> = {
  description: string
  // The agent whose sessions run the agent stages, unless a stage names another.
  agent: string
  // `box` claims a box for each run. `home` uses the agent's home machine.
  runsOn: 'box' | 'home'
  // A run stops once its sessions have cost this much.
  spendCapUsd: number
  triggers: Trigger[]
  start: S
  stages: Record<S, Stage<S>>
}
