// Learns from corrections people keep making to an agent, named in the title, such
// as "Coach fixer". A cheap model reads each new session once and reports
// findings, each quoting one step. Code keeps only the quotes it finds in their
// steps, counts each correction across sessions and people, and routes it before
// any text is written. The change comes as hunks citing those findings, is
// replayed on the turns behind it, and reaches the shepherd only when it wins.
// The shepherd keeps or turns down each hunk. docs/design/evidence.md.

import type { Pipeline, RunContext } from '../shared/pipeline.ts'

// What an earlier stage wrote out for this one. The runner only reaches a stage
// through the one before it, so a missing text is a broken pipeline.
const given = (ctx: RunContext, stage: string): string => {
  const text = ctx.results[stage]?.data.prompt
  if (typeof text !== 'string') throw new Error(`the ${stage} stage left nothing for the next one`)
  return text
}

export default {
  description: 'Learns from corrections people keep making to an agent, and proposes hunks backed by checked quotes, scored on replays before the shepherd sees them.',
  agent: 'improver',
  runsOn: 'home',
  spendCapUsd: 5,
  triggers: [{ kind: 'manual' }],
  start: 'pick',
  stages: {
    pick: {
      kind: 'action',
      action: 'pick_sessions',
      next: { picked: 'read', none: { done: 'succeeded', note: 'Nothing new to read.' }, failed: { handoff: 'The sessions to read could not be picked.' } },
    },

    read: {
      kind: 'agent',
      model: 'haiku',
      prompt: (ctx) => `${ctx.report.title}
${ctx.report.body}

${given(ctx, 'pick')}

Read each session above once, and report what it shows about the agent's rules. Report read, with data.findings, a list. Each finding quotes the exact words of one step, copied character for character, at least 12 characters and at most 300 characters; for a longer one quote its key sentence. Each names its session and step:
- {"kind": "followed" | "ignored" | "harm", "session": "<id>", "step": <n>, "quote": "...", "rule": "<rule hash>"}: the agent followed a rule, ignored it, or did the wrong thing because of it.
- {"kind": "gap", "session": "<id>", "step": <n>, "quote": "...", "correction": "<the rule, in one sentence, that would have prevented it>", "fix": "check" | "text"}: a person corrected the agent and no rule covers it. Quote the person's correction. Say "check" when a lint rule, type or check could catch the mistake, and "text" when only an instruction can. When an open candidate above is the same correction, add "candidate": "<its id>". Otherwise add "same": "<a short label>", with one label for gaps that are the same correction. When it applies only to one kind of task, add "when": "<that kind of task>".
Add data.merges, pairs of open candidate ids that are the same correction. Report empty lists when the sessions show nothing.`,
      next: { read: 'record' },
    },

    record: {
      kind: 'action',
      action: 'record_findings',
      next: {
        ready: 'write',
        waiting: { done: 'succeeded', note: 'No change has enough evidence yet: a correction needs two sessions, and deleting a rule two harm findings.' },
        failed: { handoff: 'The findings could not be recorded.' },
      },
    },

    write: {
      kind: 'agent',
      prompt: (ctx) => `${ctx.report.title}
${ctx.report.body}

${given(ctx, 'record')}

Propose the smallest change the evidence above supports. Report changed with data.hunks, a list of at most five of these:
- {"op": "add", "after": "<rule hash>", "text": "<the new rule>", "findings": [...]}: a new rule after that one, or at the end without after.
- {"op": "change", "rule": "<rule hash>", "text": "<its new wording>", "findings": [...]}: a rule people keep ignoring, worded so it is followed.
- {"op": "delete", "rule": "<rule hash>", "findings": [...]}: a rule that caused harm.
- {"op": "skill", "name": "<lowercase-name>", "description": "<when it applies>", "text": "<the skill>", "findings": [...]}
- {"op": "profile", "person": "<login>", "text": "<a line on what they prefer>", "findings": [...]}
- {"op": "check", "text": "<what a lint rule, type or check should catch>", "findings": [...]}
Each hunk lists the ids of the findings it rests on, and each candidate goes where it is routed. Say why in your summary. Report nothing when no change is worth making.`,
      next: { changed: 'propose', nothing: { done: 'succeeded', note: 'The writer found no change worth making.' } },
    },

    propose: {
      kind: 'action',
      action: 'propose_hunks',
      next: {
        proposed: 'replay',
        refused: { done: 'failed', note: 'Every hunk broke a rule for changes, so nobody was asked.' },
        failed: { handoff: 'The proposal could not be written.' },
      },
    },

    // Replays the turns behind the change, and a few unrelated ones, with and without it.
    replay: {
      kind: 'action',
      action: 'replay_sessions',
      next: { replayed: 'judge', unscored: 'shepherd', failed: { handoff: 'The change could not be replayed.' } },
    },

    judge: {
      kind: 'agent',
      model: 'haiku',
      prompt: (ctx) => `${given(ctx, 'replay')}

Each replay above is one reply to the message shown, by the agent as it is now or with a proposed change. Judge each on its own:
- Marked "a correction": fixed when the person would not have needed to correct it the way they did before, or still when they would.
- Marked "went fine before": worse when the person would have had to correct it where they accepted the old reply, or ok.
Report judged with data.verdicts, an object from each replay's label to its verdict, such as {"R1": "fixed", "R2": "ok"}.`,
      next: { judged: 'decide' },
    },

    decide: {
      kind: 'action',
      action: 'decide_replays',
      next: {
        better: 'shepherd',
        not_better: { done: 'failed', note: 'The change did not win on replays, so nobody was asked.' },
        failed: { handoff: 'The replays could not be scored.' },
      },
    },

    shepherd: {
      kind: 'gate',
      question: (ctx) => `Coach has a change for an agent. ${ctx.results.decide?.summary ?? ctx.results.replay?.summary ?? ''} `
        + 'Keep or turn down each hunk on the run page, then approve to apply the hunks you kept, or reject to turn them all down.',
      next: { approved: 'settle', rejected: 'settle' },
    },

    settle: {
      kind: 'action',
      action: 'settle_hunks',
      next: {
        applied: { done: 'succeeded', note: 'The kept hunks are applied.' },
        declined: { done: 'failed', note: 'The shepherd kept the agent as it is.' },
        failed: { handoff: 'The kept hunks could not be applied.' },
      },
    },
  },
} satisfies Pipeline
