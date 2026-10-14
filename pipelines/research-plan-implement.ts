// From a request to a reviewed pull request in phases, where every phase is a
// place to push back.
// The agent researches and writes research.md, then plans and writes plan.md,
// and a person reviews each at a gate: they comment on its lines, then approve
// it or send it back with a note. No code changes before the plan is approved,
// and the runner checks the repo is untouched after each written phase rather
// than trusting the agent. Then the agent implements the plan, the runner runs
// the plan's test command, and a person reviews the pull request.
// Research and plan have no allow list, so a command there waits on a person.
// docs/design/workflow.md says why no read-only list.

import type { Pipeline, RunContext } from '../shared/pipeline.ts'

type StageName = 'research' | 'research_untouched' | 'review_research' | 'plan' | 'plan_untouched' | 'review_plan'
  | 'implement' | 'verify' | 'open_pr' | 'review_change' | 'merge'

const request = ({ report }: RunContext) => `The request: ${report.title}\n\n${report.body || '(no details given)'}`

// What an agent reported can be anything, so only text becomes part of a command.
const textOf = (value: unknown) => (typeof value === 'string' ? value : '')
const testCommand = (ctx: RunContext) => textOf(ctx.results.plan?.data.test_command)

// Passes when git sees no change in the repo and no commit its remote lacks, and
// prints what changed when it fails.
const UNTOUCHED = 'changed="$(git status --porcelain)$(git log --oneline HEAD --not --remotes)"; if [ -n "$changed" ]; then echo "$changed"; exit 1; fi'

// The latest result of a stage the run must have passed through to get here.
function resultOf(ctx: RunContext, stage: StageName) {
  const result = ctx.results[stage]
  if (!result) throw new Error(`${stage} has no result yet, and this prompt needs it`)
  return result
}

// What a person said sending a document back: their note at the gate, and the
// open comments on the document, each with the text it quotes.
function feedback(ctx: RunContext, gate: StageName, document: string): string {
  const comments = ctx.comments.filter((c) => c.path === document)
    .map((c) => `- ${c.quote ? `On "${c.quote}": ` : ''}${c.text} (${c.by}, on version ${c.version})`)
  return `A person sent ${document} back. ${resultOf(ctx, gate).summary}\n\n`
    + (comments.length ? `Their comments on ${document}:\n${comments.join('\n')}` : `They left no comments on ${document}.`)
}

// A written phase runs again after its check found code changed, or after a person
// sent its document back. The check runs right after the phase, so a failed check
// is the latest reason.
function again(ctx: RunContext, check: StageName, gate: StageName, document: string): string {
  const untouched = resultOf(ctx, check)
  if (untouched.outcome === 'fails') {
    return `The runner found changes in ./${ctx.repo} after you wrote ${document}, and this phase changes no code:\n\n${untouched.summary}\n\n`
      + `Put the code back as it was and keep ${document}.`
  }
  return `${feedback(ctx, gate, document)}\n\nRevise ${ctx.taskFolder}/${document} to answer them. Do not change any code.`
}

export default {
  description: 'From a request to a reviewed pull request in phases: research, then a plan, each reviewed by a person who can send it back, then the implementation, which the runner verifies.',
  agent: 'builder',
  runsOn: 'box',
  spendCapUsd: 10,
  triggers: [{ kind: 'manual' }, { kind: 'webhook' }],
  start: 'research',
  stages: {
    research: {
      kind: 'agent',
      prompt: (ctx) => (ctx.attempts.research ? again(ctx, 'research_untouched', 'review_research', 'research.md')
        : `${request(ctx)}\n\nResearch what this request touches before anyone plans or changes code. The repo is checked out in ./${ctx.repo}. Read the code and do not change it.\n\n`
          + `Write ${ctx.taskFolder}/research.md for the person who will review it: what exists today, the files and lines involved with their paths, what constrains the change, and the questions the code could not answer.`)
        + '\n\nReport researched when research.md says what it should.',
      next: { researched: 'research_untouched' },
    },

    research_untouched: { kind: 'check', command: () => UNTOUCHED, next: { passes: 'review_research', fails: 'research' } },

    review_research: {
      kind: 'gate',
      question: (ctx) => `The research for "${ctx.report.title}" is in research.md. Comment on its lines, then approve it, or send it back with a note and the agent revises it.`,
      labels: { approve: 'Approve research', reject: 'Send back' },
      next: { approved: 'plan', rejected: 'research' },
    },

    plan: {
      kind: 'agent',
      prompt: (ctx) => (ctx.attempts.plan ? again(ctx, 'plan_untouched', 'review_plan', 'plan.md')
        : `${request(ctx)}\n\nA person approved the research in ${ctx.taskFolder}/research.md. Read it, then write ${ctx.taskFolder}/plan.md: the change step by step, the files each step touches, the risks, and how to prove it works. Do not change any code yet.`)
        + `\n\nPut in data.test_command the shell command, run from ./${ctx.repo}, whose passing proves the change works. Report planned when plan.md says what it should.`,
      next: { planned: 'plan_untouched' },
    },

    plan_untouched: { kind: 'check', command: () => UNTOUCHED, next: { passes: 'review_plan', fails: 'plan' } },

    review_plan: {
      kind: 'gate',
      question: (ctx) => `The plan for "${ctx.report.title}" is in plan.md. Comment on its lines, then approve it and the agent starts on the code, or send it back with a note.`,
      labels: { approve: 'Approve plan', reject: 'Send back' },
      next: { approved: 'implement', rejected: 'plan' },
    },

    implement: {
      kind: 'agent',
      allow: ['Bash'],
      prompt: (ctx) => {
        if (!ctx.attempts.implement) {
          return `${request(ctx)}\n\nA person approved the plan in ${ctx.taskFolder}/plan.md. Change the code in ./${ctx.repo} to carry it out, and run its tests. Do not commit, the runner does that.`
            + '\n\nReport implemented with a summary of the change for the pull request, or stuck if you cannot finish it.'
        }
        // verify runs after every implementation, so a failed one is the latest reason.
        const verify = resultOf(ctx, 'verify')
        return (verify.outcome === 'fails'
          ? `The runner ran the plan's test command and it failed:\n\n${verify.summary}\n\nFix it.`
          : `A person sent the change back. ${resultOf(ctx, 'review_change').summary}\n\nChange the code to answer them, and run the tests.`)
          + ' Report implemented or stuck.'
      },
      next: { implemented: 'verify', stuck: { handoff: 'The agent got stuck carrying out the plan.' } },
    },

    verify: {
      kind: 'check',
      command: (ctx) => testCommand(ctx) || 'echo "The plan named no test command, so nothing can show the change works." && false',
      next: { passes: 'open_pr', fails: 'implement' },
    },

    open_pr: {
      kind: 'action',
      action: 'open_pull_request',
      title: (ctx) => ctx.report.title,
      text: (ctx) => `${resultOf(ctx, 'implement').summary}\n\nResearched, planned and reviewed in phases. Verified by \`${testCommand(ctx)}\`.`,
      next: { done: 'review_change', failed: { handoff: 'The pull request could not be opened.' } },
    },

    review_change: {
      kind: 'gate',
      question: (ctx) => `The change for "${ctx.report.title}" is ready for review. Merge it, or send it back with a note.`,
      labels: { approve: 'Merge', reject: 'Send back' },
      next: { approved: 'merge', rejected: 'implement' },
    },

    merge: {
      kind: 'action',
      action: 'merge_pull_request',
      next: { done: { done: 'succeeded', note: 'Researched, planned, built and merged.' }, failed: { handoff: 'The pull request could not be merged.' } },
    },
  },
} satisfies Pipeline<StageName>
