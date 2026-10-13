// Turns corrections people keep making into a change to an agent: its
// instructions, or a skill when the corrections are about one kind of task. It
// reads the team's recent conversations with the agent, and when the same
// correction comes up in more than one session it proposes the smallest change
// that would have made it unnecessary. The shepherd decides.

import type { Pipeline } from '../shared/pipeline.ts'

export default {
  description: 'Finds corrections people keep making to an agent and proposes a change to its instructions or skills for the shepherd to approve.',
  agent: 'improver',
  runsOn: 'home',
  spendCapUsd: 3,
  triggers: [{ kind: 'manual' }],
  start: 'study',
  stages: {
    study: {
      kind: 'agent',
      prompt: (ctx) => `${ctx.report.title}
${ctx.report.body}

Use the team-record tools recent_activity, search_record and read_session to read the team's recent conversations with the agent named above. Look for corrections people made more than once, in more than one session: the same "no, do it this way", the same preference stated again.

If one repeats, get the agent's current instructions and skills with agent_profile and make the smallest change that would have made those corrections unnecessary. Report changed with data.agent set to the agent's name, a summary that names the sessions, and one of:
- data.instructions, the agent's full new instructions, for a preference that holds for everything it does.
- data.skill, an object with name and content, for how to do one kind of task. The name is lowercase letters, digits and dashes, and an existing skill's name changes that skill. The content is the skill's full text.

Report nothing if no correction repeats.`,
      next: { changed: 'propose', nothing: { done: 'succeeded', note: 'No correction came up more than once.' } },
    },

    propose: {
      kind: 'action',
      action: 'propose_instructions',
      next: { done: 'shepherd', failed: { handoff: 'The proposal could not be written.' } },
    },

    shepherd: {
      kind: 'gate',
      question: (ctx) => `People keep correcting an agent the same way. ${ctx.results.study?.summary ?? ''} Make the proposed change?`,
      next: { approved: 'apply', rejected: { done: 'failed', note: 'The shepherd kept the instructions as they are.' } },
    },

    apply: {
      kind: 'action',
      action: 'apply_proposal',
      next: { done: { done: 'succeeded', note: 'The change to the agent is applied.' }, failed: { handoff: 'The change could not be applied.' } },
    },
  },
} satisfies Pipeline
