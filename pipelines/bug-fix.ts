// Takes a bug report to a reviewed pull request. It
// checks whether the bug is known or already fixed, proves it with a failing
// test, then fixes it or writes a plan, and the shepherd decides.

import type { Pipeline, RunContext } from '../shared/pipeline.ts'

const report = ({ report }: RunContext) =>
  `Bug report${report.issue ? ` (issue #${report.issue})` : ''}: ${report.title}\n\n${report.body || '(no description)'}`

const TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit']

// What an agent reported can be anything, so only text becomes part of a command.
const textOf = (value: unknown) => (typeof value === 'string' ? value : '')
const testCommand = (ctx: RunContext) => textOf(ctx.results.reproduce?.data.test_command)

export default {
  description: 'From a bug report to a reviewed pull request: dedupe, reproduce with a failing test, fix or plan, then the shepherd decides.',
  agent: 'fixer',
  runsOn: 'box',
  spendCapUsd: 5,
  triggers: [{ kind: 'forge', event: 'issues', action: 'opened', label: 'bug' }, { kind: 'webhook' }, { kind: 'manual' }],
  start: 'triage',
  stages: {
    triage: {
      kind: 'agent',
      allow: TOOLS,
      prompt: (ctx) => `${report(ctx)}

Other open issues on the repo:
${ctx.openIssues.map((i) => `#${i.number} ${i.title}`).join('\n') || '(none)'}

The repo is checked out in ./${ctx.repo} at the main branch. Decide what this report is, without changing any code:
- duplicate: it reports the same problem as one of the open issues above. Put that issue's number in data.duplicate_of.
- already_fixed: the code on main no longer behaves as reported. Try it to be sure.
- not_a_bug: the code works as intended.
- new: none of these.
Your summary is posted on the issue, so write it for the person who reported it.`,
      next: { new: 'reproduce', duplicate: 'close', already_fixed: 'close', not_a_bug: 'close' },
    },

    reproduce: {
      kind: 'agent',
      allow: TOOLS,
      prompt: (ctx) => `${report(ctx)}

Write an automated test in ./${ctx.repo}, in the style of the repo's existing tests, that fails because of this bug. Run it and confirm it fails for that reason. Do not fix the bug.

Then judge the fix:
- easy: a small, contained change you are confident about.
- hard: it needs design decisions or touches many places.
- cannot_reproduce: you could not make a test fail because of the bug.

Put in data.test_command the shell command, run from ./${ctx.repo}, that runs only your new test. Put in data.suite_command the command that runs the repo's whole test suite.`,
      next: { easy: 'confirm', hard: 'plan', cannot_reproduce: { handoff: 'The agent could not reproduce the bug.' } },
    },

    // The reproduction is only trusted once the runner has seen it fail.
    confirm: {
      kind: 'check',
      command: (ctx) => testCommand(ctx) || 'false',
      next: { fails: 'fix', passes: { handoff: 'The reproduction test passes before any fix, so it does not show the bug.' } },
    },

    fix: {
      kind: 'agent',
      allow: TOOLS,
      maxAttempts: 3,
      prompt: (ctx) => (ctx.attempts.fix
        ? `The fix did not pass. The runner ran the tests and got:\n\n${ctx.results.verify?.summary ?? ''}\n\nFix it.`
        : `Fix the bug in ./${ctx.repo} so your reproduction test passes and the whole suite still passes. Keep the change small and do not commit, the runner does that.`)
        + '\n\nReport fixed with a short summary of the cause and the change, for the pull request. Report stuck if you cannot fix it.',
      next: { fixed: 'verify', stuck: { handoff: 'The agent got stuck on the fix.' } },
    },

    verify: {
      kind: 'check',
      command: (ctx) => [textOf(ctx.results.reproduce?.data.suite_command), testCommand(ctx)].filter(Boolean).join(' && ') || 'false',
      next: { passes: 'open_pr', fails: 'fix' },
    },

    open_pr: {
      kind: 'action',
      action: 'open_pull_request',
      title: (ctx) => `Fix: ${ctx.report.title}`,
      text: (ctx) => `${ctx.results.fix?.summary ?? ''}\n\nReproduced by \`${testCommand(ctx)}\`, which failed before the fix and passes now.${ctx.report.issue ? `\n\nFixes #${ctx.report.issue}` : ''}`,
      next: { done: 'shepherd', failed: { handoff: 'The pull request could not be opened.' } },
    },

    shepherd: {
      kind: 'gate',
      question: (ctx) => `A fix for "${ctx.report.title}" is ready for review. Merge it?`,
      next: { approved: 'merge', rejected: { done: 'failed', note: 'The shepherd rejected the fix.' } },
    },

    merge: {
      kind: 'action',
      action: 'merge_pull_request',
      next: { done: { done: 'succeeded', note: 'Fixed and merged.' }, failed: { handoff: 'The pull request could not be merged.' } },
    },

    plan: {
      kind: 'agent',
      allow: ['Bash', 'Write'],
      prompt: (ctx) => `${report(ctx)}

This bug needs a plan before anyone changes code. Write the plan to ${ctx.taskFolder}/plan.md: the cause, the change you would make, the risks, and how to test it. Do not change the code in ./${ctx.repo}.`,
      next: { planned: 'review_plan' },
    },

    review_plan: {
      kind: 'gate',
      question: (ctx) => `The bug "${ctx.report.title}" needs a bigger change. Is the plan right?`,
      next: {
        approved: { done: 'succeeded', note: 'Plan approved. A person picks up the work.' },
        rejected: { done: 'failed', note: 'The shepherd rejected the plan.' },
      },
    },

    close: {
      kind: 'action',
      action: 'close_issue',
      text: (ctx) => ctx.results.triage?.summary ?? '',
      next: { done: { done: 'succeeded', note: 'Closed without a code change.' }, failed: { handoff: 'The issue could not be closed.' } },
    },
  },
} satisfies Pipeline
