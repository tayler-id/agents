// Makes another pipeline better. It studies that pipeline's recent runs, changes
// its file once, and reports the steps of those runs the change rests on. Code
// keeps only the quotes it finds in their steps, refuses a change with none or
// one repeating a hunk the shepherd turned down, and scores the rest by replaying
// past runs with the change and without it. Only a change that scores better
// reaches the shepherd, as a pull request on this repo with both scores and the
// checked quotes. Merging it makes it the current version.

import type { Pipeline } from '../shared/pipeline.ts'

export default {
  description: "Studies a pipeline's recent runs, changes its file once on evidence code has checked, and proves the change on past runs before the shepherd sees it.",
  agent: 'improver',
  runsOn: 'home',
  spendCapUsd: 10,
  triggers: [{ kind: 'manual' }],
  start: 'study',
  stages: {
    study: {
      kind: 'agent',
      allow: ['Bash', 'Edit', 'Write'],
      prompt: (ctx) => `${ctx.report.title}
${ctx.report.body}

The team's pipelines are in ./${ctx.repo}/pipelines, one file per pipeline, named after the pipeline. Use the team-record tool pipeline_history to see how the pipeline named above has run lately: each run's stages with their outcomes and summaries, reminders, hand-offs, what people said at its gates, and what it cost. Read the sessions behind the stages that went badly with read_session.

Find the one change to that pipeline's file most likely to make its runs go better, such as a clearer prompt for a stage that keeps needing a reminder or a second try. Make that one change in ./${ctx.repo}/pipelines. Keep it small, keep the file loading (it may import types only), and do not commit.

Report changed with a summary of what you changed, and data.findings, the evidence it rests on. Each finding quotes the exact words of one step of a run's session, as read_session shows them, at least 12 characters long: {"kind": "followed" | "ignored" | "harm" | "gap", "session": "<session id>", "step": <n>, "quote": "...", "note": "<what went wrong>"}. Code keeps only quotes it finds in their steps, and a change resting on none never reaches anyone. Report nothing if the runs give no reason to change anything.`,
      next: { changed: 'record', nothing: { done: 'succeeded', note: 'The runs gave no reason to change anything.' } },
    },

    // Keeps the study's findings whose quotes are in the steps they cite.
    record: {
      kind: 'action',
      action: 'record_findings',
      next: {
        ready: 'score',
        waiting: { done: 'failed', note: 'The study cited no evidence code could find in the runs, so nobody was asked.' },
        failed: { handoff: 'The findings could not be recorded.' },
      },
    },

    // Replays past runs with the change and without it. Only a better score goes on.
    score: {
      kind: 'action',
      action: 'score_change',
      next: {
        better: 'open_pr',
        not_better: { done: 'failed', note: 'The change did not score better than the current version, so nobody was asked.' },
        refused: { done: 'failed', note: 'The change broke a rule for changes, so nobody was asked.' },
        failed: { handoff: 'The change could not be scored.' },
      },
    },

    open_pr: {
      kind: 'action',
      action: 'open_pull_request',
      title: (ctx) => ctx.report.title,
      text: (ctx) => `${ctx.results.study?.summary ?? ''}\n\nThe evidence, checked in code:\n${ctx.results.record?.summary ?? ''}\n\n${ctx.results.score?.summary ?? ''}`,
      next: { done: 'shepherd', failed: { handoff: 'The pull request could not be opened.' } },
    },

    shepherd: {
      kind: 'gate',
      question: (ctx) => `A pipeline change scored better than the current version on past runs. ${ctx.results.score?.summary ?? ''} `
        + `It rests on: ${ctx.results.record?.summary ?? ''} Merge it?`,
      next: { approved: 'merge', rejected: 'settle' },
    },

    merge: {
      kind: 'action',
      action: 'merge_pull_request',
      next: { done: 'settle', failed: { handoff: 'The pull request could not be merged.' } },
    },

    // Records the shepherd's decision on every hunk, so a turned-down change is not proposed again on the same evidence.
    settle: {
      kind: 'action',
      action: 'settle_hunks',
      next: {
        applied: { done: 'succeeded', note: 'Merged. The change is now the current version.' },
        declined: { done: 'failed', note: 'The shepherd turned the change down.' },
        failed: { handoff: "The shepherd's decision could not be recorded." },
      },
    },
  },
} satisfies Pipeline
