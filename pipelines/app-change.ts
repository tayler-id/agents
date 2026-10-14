// Changes a repo that has a policy, the Agents codebase first, under the coding
// framework. The router picks a playbook. A bug is triaged, with read-only tools,
// and reproduced by a check. Every change is understood, planned and approved
// before code, implemented in a box, judged by the runner's gates, reviewed on
// another model, verified by a fresh agent against the original request, run
// through the full suite on the check host, and merged and deployed only by the
// repo's owner. docs/design/self-improve.md describes each step.

import type { Pipeline, RunContext } from '../shared/pipeline.ts'

const READ = ['Read', 'Grep', 'Glob']
const WRITE_TASK = ['Read', 'Grep', 'Glob', 'Write']
const CODE = ['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit']
const RUN = ['Bash', 'Read', 'Grep', 'Glob']

const request = ({ report }: RunContext) =>
  `The request${report.issue ? ` (issue #${report.issue})` : ''}${report.author ? ` from ${report.author}` : ''}: ${report.title}\n\n${report.body || '(no description)'}`

const repoRules = (ctx: RunContext) =>
  `The repo is checked out in ./${ctx.repo}. Read ./${ctx.repo}/CLAUDE.md first and follow it, with the coding standards it names.`

// What sent the change back to the agent, from the latest result of each stage that can.
function sentBack(ctx: RunContext): string {
  const r = ctx.results
  const notes = [
    r.verify?.outcome === 'fails' ? `The runner's gates failed:\n${r.verify.summary}` : '',
    r.review?.outcome === 'fix' ? `The reviewers want changes:\n${r.review.summary}` : '',
    r.confirm?.outcome === 'fix' ? `The verifier found that it does not hold:\n${r.confirm.summary}` : '',
    r.suite?.outcome === 'fails' ? `The full suite failed on the check host:\n${r.suite.summary}` : '',
    r.approve_merge?.outcome === 'rejected' ? `The owner sent it back: ${r.approve_merge.summary}` : '',
  ].filter(Boolean)
  return notes.length ? notes.join('\n\n') : 'Nothing was named. Read the run\'s latest results.'
}

export default {
  description: 'Changes a repo under its policy: route, understand, plan, implement in a box, the runner\'s gates, review on another model, a fresh verifier, the full suite, then the owner merges and deploys.',
  agent: 'builder',
  runsOn: 'box',
  spendCapUsd: 20,
  triggers: [{ kind: 'manual' }, { kind: 'webhook' }],
  start: 'route',
  stages: {
    route: {
      kind: 'route',
      allow: READ,
      prompt: (ctx) => `${request(ctx)}

${repoRules(ctx)} Read only. Pick the playbook for this request:
- change: a new feature, or a change to how something works.
- bug: something that should work does not.
- docs: only documents change.
- dependency: a dependency is added, removed or moved to another version.
Report the playbook as the outcome, and say why in one or two sentences.`,
      next: { change: 'understand', bug: 'triage', docs: 'understand', dependency: 'understand' },
    },

    triage: {
      kind: 'agent',
      allow: READ,
      prompt: (ctx) => `${request(ctx)}

Other open issues on the repo:
${ctx.openIssues.map((i) => `#${i.number} ${i.title}`).join('\n') || '(none)'}

${repoRules(ctx)} You have read-only tools. Decide what this report is, and change nothing:
- duplicate: it reports the same problem as an open issue above. Put that issue's number in data.duplicate_of.
- already_fixed: main no longer behaves as reported.
- not_a_bug: the code works as intended.
- existing_fix: an open pull request or a merged commit plausibly fixes it. Name it in data.fix. Nobody writes a competing patch.
- needs_info: you cannot tell without one answer from the reporter. Put that one question, and nothing else, in the summary.
- new: none of these.
Your summary is posted on the issue for the reporter.`,
      next: {
        new: 'reproduce', duplicate: 'close', already_fixed: 'close', not_a_bug: 'close', needs_info: 'ask_reporter',
        existing_fix: { handoff: 'An open pull request or a merged commit may already fix this. A person verifies it, the baseline twice and the fix twice, and no agent writes a competing patch.' },
      },
    },

    ask_reporter: {
      kind: 'action',
      action: 'ask_reporter',
      text: (ctx) => ctx.results.triage?.summary ?? '',
      next: { done: { done: 'succeeded', note: 'Asked the reporter one question.' }, failed: { handoff: 'The question could not be posted.' } },
    },

    close: {
      kind: 'action',
      action: 'close_issue',
      text: (ctx) => ctx.results.triage?.summary ?? '',
      next: { done: { done: 'succeeded', note: 'Closed without a code change.' }, failed: { handoff: 'The issue could not be closed.' } },
    },

    reproduce: {
      kind: 'agent',
      allow: CODE,
      prompt: (ctx) => `${request(ctx)}

${repoRules(ctx)} Write a check in ./${ctx.repo}/test, in the style of the repo's checks, that fails because of this bug, and run it to see it fail for that reason. Do not fix the bug. When the check needs no database, forge or Docker, put the line \`// runs-in: box\` at its top, so the runner can watch it fail on main before any fix. For a bug in the UI, the broken state must be seen twice through the real UI, with screenshots, before any fix.

Report reproduced with the check's path in data.check, or cannot_reproduce.`,
      next: { reproduced: 'understand', cannot_reproduce: { handoff: 'The agent could not reproduce the bug.' } },
    },

    understand: {
      kind: 'agent',
      allow: WRITE_TASK,
      document: { path: 'understanding.md', headings: ['What the code does now', 'What this change touches', 'What could break'], plan: false },
      prompt: (ctx) => `${request(ctx)}

${repoRules(ctx)} Before anyone plans, understand the code this touches. Read, search and trace it. Change nothing in ./${ctx.repo}. Write ${ctx.taskFolder}/understanding.md with three sections: "## What the code does now", "## What this change touches", and "## What could break", naming files, functions and the checks that cover them.

Report understood, or ask with your question when the work cannot go on without a person.`,
      next: { understood: 'plan', ask: { handoff: 'The agent has a question for a person before it plans. Its report says what.' } },
    },

    plan: {
      kind: 'agent',
      allow: WRITE_TASK,
      document: { path: 'plan.md', headings: ['Concern', 'Done means', 'Keep', 'Files', 'Size'], plan: true },
      prompt: (ctx) => `${request(ctx)}

${repoRules(ctx)} Using ${ctx.taskFolder}/understanding.md, write the plan to ${ctx.taskFolder}/plan.md, for a person to approve before any code exists. It has these sections:
- "## Concern": the one concern of this change.
- "## Done means": each item a statement a check proves, naming that check as (check: test/stepNN.ts). The checks are ones this change adds or edits, and the runner watches each fail on main and pass on the change.
- "## Keep": each item what must keep working, starting with its feature id from the repo's feature map in backticks.
- "## Files": the files you will touch.
- "## Size": the lines you expect to change. Over 400 means plan only the first part.
${ctx.results.approve_plan?.outcome === 'rejected' ? `\nA person sent the last plan back: ${ctx.results.approve_plan.summary}\n` : ''}
Report planned, or ask with your question when no plan can work within what people decided.`,
      next: { planned: 'approve_plan', ask: { handoff: 'The agent has a question for a person before it plans further. Its report says what.' } },
    },

    approve_plan: {
      kind: 'gate',
      role: 'plan',
      question: (ctx) => `The plan for "${ctx.report.title}" is in plan.md. Approve it before any code is written?`,
      next: { approved: 'implement', rejected: 'plan' },
    },

    implement: {
      kind: 'agent',
      allow: CODE,
      maxAttempts: 6,
      prompt: (ctx) => (ctx.attempts.implement
        ? `The change went back to you.\n\n${sentBack(ctx)}\n\nFix each point, or say in your report why one is wrong. For a review finding, fix it, dismiss it with the reason, or report ask to put it to a person.`
        : `${request(ctx)}\n\n${repoRules(ctx)} Implement the plan a person approved, in ${ctx.taskFolder}/plan.md, in ./${ctx.repo}.${ctx.playbook ? ` This is the ${ctx.playbook.name} playbook: ${ctx.playbook.guide}` : ''}`)
        + '\n\nDo not commit or push. The runner commits and pushes your work, and runs every gate itself. Report done with a summary for the pull request, or ask with your question for a person.',
      next: { done: 'verify', ask: { handoff: 'The agent has a question for a person. Its report says what.' } },
    },

    verify: {
      kind: 'verify',
      next: { passes: 'review', fails: 'implement', stopped: { done: 'failed', note: 'Stopped: the run tried to get past the gates.' } },
    },

    review: {
      kind: 'review',
      reviewers: ['reviewer'],
      author: 'builder',
      allow: READ,
      prompt: (ctx) => request(ctx),
      next: { clean: 'confirm', overruled: 'confirm', fix: 'implement' },
    },

    confirm: {
      kind: 'confirm',
      verifier: 'verifier',
      author: 'builder',
      allow: RUN,
      prompt: (ctx) => `Read the original request again, then the diff, and confirm the change does what was asked${ctx.playbook?.name === 'bug' ? ' and fixes what was reported' : ''}. ${request(ctx)}`,
      next: { verified: 'open_pr', overruled: 'open_pr', fix: 'implement' },
    },

    open_pr: {
      kind: 'action',
      action: 'open_pull_request',
      title: (ctx) => ctx.report.title,
      text: (ctx) => ctx.results.implement?.summary ?? '',
      next: { done: 'protected', failed: { handoff: 'The pull request could not be opened.' } },
    },

    protected: {
      kind: 'gate',
      role: 'protected',
      question: (ctx) => `"${ctx.report.title}" changes what only the repo's owner may approve.`,
      next: { approved: 'approve_suite', rejected: { done: 'failed', note: 'The owner turned down the change to protected files.' } },
    },

    approve_suite: {
      kind: 'gate',
      role: 'suite',
      question: (ctx) => `"${ctx.report.title}" passed the gates, the review and the verifier. Run the full suite on it?`,
      next: { approved: 'suite', rejected: { done: 'failed', note: 'A person chose not to run the suite.' } },
    },

    suite: {
      kind: 'suite',
      next: { passes: 'approve_merge', fails: 'implement' },
    },

    approve_merge: {
      kind: 'gate',
      role: 'merge',
      question: (ctx) => `"${ctx.report.title}" is ready, with the evidence in its pull request. Merge it?`,
      next: { approved: 'merge', rejected: 'implement' },
    },

    merge: {
      kind: 'action',
      action: 'merge_change',
      next: { done: 'approve_deploy', stale: 'suite', failed: { handoff: 'The pull request could not be merged.' } },
    },

    approve_deploy: {
      kind: 'gate',
      role: 'deploy',
      question: (ctx) => `"${ctx.report.title}" is merged. Deploy it to the server now?`,
      next: { approved: 'deploy', rejected: { done: 'succeeded', note: 'Merged. The owner chose not to deploy it now.' } },
    },

    deploy: {
      kind: 'action',
      action: 'deploy',
      next: {
        done: { done: 'succeeded', note: 'Merged and deployed, and the server answered its health check.' },
        rolled_back: { done: 'failed', note: 'Deployed, failed its health check, and rolled back by itself.' },
        failed: { handoff: 'The deploy failed and did not roll back. A person must look now.' },
      },
    },
  },
} satisfies Pipeline
