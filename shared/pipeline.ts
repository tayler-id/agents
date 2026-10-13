// What a pipeline file exports. A pipeline is a set of named stages and, for each
// way a stage can end, where the run goes next. The runner keeps every run's
// state in Postgres, so a pipeline file holds no state of its own.
//
// Pipeline files import this module for types only (`import type`), because a
// version is loaded from its stored source, outside this repo.

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
  // Set when this run replays a past one to score a pipeline version.
  replay: boolean
}

// Where a run goes after a stage: another stage, the end, or a person.
export type Next = string | { done: 'succeeded' | 'failed'; note: string } | { handoff: string }

type Common = {
  // How the stage can end, and where each ending leads.
  next: Record<string, Next>
}

// A turn of an agent's Claude session in the task's workspace. The agent ends it
// by calling report_result with one of `outcomes`. A stage that runs again keeps
// its session, so the agent remembers its earlier tries.
export type AgentStage = Common & {
  kind: 'agent'
  agent?: string
  prompt: (ctx: RunContext) => string
  // Tools the stage may use without asking a person, in Claude's --allowedTools form.
  allow?: string[]
  // How many tries before a person takes over. Defaults to 3.
  maxAttempts?: number
}

// A command run in the repo's folder on the run's machine. Ends as `passes`
// (exit code 0) or `fails`.
export type CheckStage = Common & { kind: 'check'; command: (ctx: RunContext) => string; maxAttempts?: number }

// Something the runner does. Ends as `done` or `failed`, except score_change.
// - open_pull_request: pushes the task branch and opens a pull request.
// - merge_pull_request: merges it, and marks the run's proposal approved.
// - close_issue: comments on the report's issue and closes it.
// - score_change: pushes the task branch, takes the one pipeline file it changed
//   as a candidate version, replays past runs of that pipeline with the candidate
//   and with the current version, and writes a proposal with both scores. Ends as
//   `better`, `not_better` or `failed`.
// - propose_instructions: writes a proposal from the last agent stage's data:
//   `agent` and new `instructions`, or a `skill` with `name` and `content`.
// - apply_proposal: applies the run's proposal to the agent or skill.
export type ActionStage = Common & {
  kind: 'action'
  action: 'open_pull_request' | 'merge_pull_request' | 'close_issue' | 'score_change' | 'propose_instructions' | 'apply_proposal'
  // A pull request's title (the report's title by default), and its description
  // or the comment left when closing an issue.
  title?: (ctx: RunContext) => string
  text?: (ctx: RunContext) => string
}

// Waits for a person. Ends as `approved` or `rejected`.
export type GateStage = Common & { kind: 'gate'; question: (ctx: RunContext) => string }

export type Stage = AgentStage | CheckStage | ActionStage | GateStage

// A pipeline is named after its file: pipelines/bug-fix.ts is bug-fix.
export type Pipeline = {
  description: string
  // The agent whose sessions run the agent stages, unless a stage names another.
  agent: string
  // `box` claims a box for each run. `home` uses the agent's home machine.
  runsOn: 'box' | 'home'
  // A run stops once its sessions have cost this much.
  spendCapUsd: number
  triggers: Trigger[]
  start: string
  stages: Record<string, Stage>
}
