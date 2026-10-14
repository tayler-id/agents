# Coach and improve learn from checked evidence

The decision is in `docs/decisions.md`, under "Coach and improve learn only from checked evidence". This is how it is built. Instructions and pipelines change only on evidence from real sessions that code has checked, and a change reaches the shepherd only after replays show it helps.

Before this work coach handed an agent's whole new instructions to the shepherd on one model's say-so, and "more than once, in more than one session" lived only in its prompt. Improve's study could give any reason it liked. Now every claim a change rests on is a quote that code found in the event it cites, and code does the counting.

## The coach run

Coach learns about one agent, named in the run's title, such as "Coach fixer". Its stages:

1. `pick`, code. Picks up to 8 of the agent's sessions with events nobody has read yet, and writes each as a short transcript with step numbers, until the prompt reaches 100,000 characters.
2. `read`, a cheap model (`haiku`). Reads the transcripts once and reports findings: a rule followed, a rule ignored, a rule that caused harm, or a correction no rule covers. Each finding quotes one step.
3. `record`, code. Drops every finding whose quote is not in the stored text of the event it cites, keeps the rest, marks the sessions read, groups corrections into candidates, and counts them.
4. `write`, the pipeline's agent. Sees the candidates that are ready, with their counts, the route code chose for each, every finding's id, and the hunks the team turned down. Reports changes as hunks, each citing finding ids.
5. `propose`, code. Applies each hunk to compute its text and diff, refuses any hunk that breaks a rule below, and writes a proposal with the hunks that pass.
6. `replay`, code. Replays the sessions behind the change, and a few unrelated ones, with and without it, as many as fit in what the run has left of its cap.
7. `judge`, a cheap model. Reads each replayed reply without knowing which version wrote it, and says whether the original correction would still be needed, or whether the reply is worse than what the person accepted.
8. `decide`, code. Scores both versions from the verdicts. Only a change that wins goes on.
9. `shepherd`, a gate. The shepherd keeps or turns down each hunk, with a reason, then approves or rejects.
10. `settle`, code. Applies the kept hunks and records every decision.

A run ends early, and asks nobody, when there is nothing new to read, when no candidate has two sessions behind it, when the writer finds nothing to change, when every hunk is refused, or when the change loses its replay.

## The improve run

Improve keeps its shape: study, score, pull request, shepherd, merge. Three things change, and two stages join it.

- The study reports findings too: the session and step of each problem it bases the change on, the exact words, and what went wrong. A new `record` stage checks them the same way, and drops any from a replay, from the study's own run, or from a private run.
- `score` splits the change into hunks. Each hunk cites the study's checked findings, and a change with none is refused before any replay.
- A `settle` stage after the gate records the shepherd's decision on every hunk. A later change that repeats a hunk the shepherd turned down is refused before any replay.

The pull request and the gate list the cited quotes, so the reasons a person reads are ones code checked.

## Where the code is

- `shared/evidence.ts` and `shared/ids.ts`, the shapes below.
- `server/evidence.ts`, picking and reading sessions, checking and recording findings, and candidates with their counts and routes.
- `server/hunks.ts`, applying the writer's operations, the rules for changes, the memory, deciding one hunk and settling a proposal.
- `server/refine.ts`, the actions the runner calls, and the replays of both pipelines.
- `pipelines/coach.ts` and `pipelines/improve.ts`, the stages and their prompts.

## Typed shapes

Everything that crosses a boundary is a zod schema in `shared/evidence.ts`, and its type is `z.infer` of it: what a model reports, a row of each of the five tables, a JSON column, an API body. Ids are branded, so a finding's id cannot go where a candidate's belongs. Where a row's columns depend on each other, its schema is a union, as the tables' check constraints are. A stored hunk with `target: 'check', op: 'delete'` neither parses nor compiles.

### Findings

A row of `session_findings`, as `SessionFinding`:

```ts
type FindingRow = {
  id: FindingId; team_id: TeamId; session_id: SessionId
  event_id: EventId; seq: number                      // the step the quote comes from
  quote: string                                       // found in that event's stored text
  source: 'person' | 'pipeline' | 'box'               // counted apart
  person_id: PersonId | null                          // who made the correction, when a person did
  occasion: string                                    // the session, or the run a stage session belongs to
  seen_at: string                                     // the event's time; it counts for 90 days
  run_id: RunId | null; created_at: string
}
type SessionFinding =
  | FindingRow & { agent_id: AgentId; pipeline_id: null; kind: 'followed' | 'ignored' | 'harm'
      rule_hash: RuleHash; rule_text: string; candidate_id: null; note: null; fix: null; trigger: null }
  | FindingRow & { agent_id: AgentId; pipeline_id: null; kind: 'gap'; rule_hash: null; rule_text: null
      candidate_id: CandidateId; note: string; fix: 'check' | 'text'; trigger: string | null }
  | FindingRow & { agent_id: null; pipeline_id: PipelineId; kind: FindingKind; rule_hash: null; rule_text: null
      candidate_id: null; note: string; fix: null; trigger: null }
```

What a model reports is outside data, parsed one entry at a time, so one bad finding, merge pair, hunk or verdict drops alone:

```ts
type ReadFinding =                                    // coach's reader
  | { kind: 'followed' | 'ignored' | 'harm'; session: string; step: number; quote: string; rule: string }
  | { kind: 'gap'; session: string; step: number; quote: string; correction: string
      candidate?: string                              // an open candidate this repeats
      same?: string                                   // new gaps with the same label are one correction
      fix: 'check' | 'text'                           // could a lint rule, type or check catch it
      when?: string }                                 // when it applies, if it is narrow
type ReadReport = { findings: unknown[]; merges?: unknown[] }   // each merge a pair of candidates that are one correction

type StudyFinding = { kind: FindingKind; session: string; step: number; quote: string; note: string }  // improve's study
```

### Candidates

A candidate is a correction no rule covers, with the gap findings that carry it. It persists across runs as a row of `candidates` that is open, merged into another, or closed once a hunk for it was kept. Code computes an open candidate's counts and route from its live findings each time.

```ts
type Counts = { sessions: number; people: number; bySource: Record<Source, number> }
type Route =
  | { kind: 'profile'; personId: PersonId; login: string }   // one person's preference
  | { kind: 'check' }                                        // a lint rule, type or check could catch it
  | { kind: 'skill'; trigger: string }                       // narrow, with a clear trigger
  | { kind: 'instructions' }                                 // what is left
type Candidate = {                                           // an open candidate, as code counts it
  id: CandidateId; agentId: AgentId; correction: string
  findings: FindingId[]; counts: Counts; route: Route
  ready: boolean                                             // once counts.sessions >= 2
}
```

### Hunks and decisions

What the writer reports, one entry per hunk:

```ts
type WrittenHunk =
  | { op: 'add'; after?: string; text: string; findings: string[] }        // a new rule, after the rule with this hash
  | { op: 'change'; rule: string; text: string; findings: string[] }
  | { op: 'delete'; rule: string; findings: string[] }
  | { op: 'skill'; name: string; description: string; text: string; findings: string[] }
  | { op: 'profile'; person: string; text: string; findings: string[] }   // a line in one person's profile
  | { op: 'check'; text: string; findings: string[] }                      // what a check should catch
```

A row of `proposal_hunks`, as `ProposalHunk`. The server computed `before`, `after` and `diff`. The decision on it is the team's memory. Each variant of `HunkChange` also has the other three of `rule_hash`, `skill_name`, `skill_description` and `person_id`, set to null.

```ts
type HunkChange =
  | { target: 'instructions'; op: 'add'; rule_hash: RuleHash | null }      // the rule it follows, or none for the end
  | { target: 'instructions'; op: 'change' | 'delete'; rule_hash: RuleHash }
  | { target: 'skill'; op: 'add' | 'change'; skill_name: string; skill_description: string }
  | { target: 'profile'; op: 'add'; person_id: PersonId }
  | { target: 'check'; op: 'add' }
  | { target: 'pipeline'; op: 'add' | 'change' | 'delete' }
type ProposalHunk = HunkChange & {
  id: HunkId; team_id: TeamId; proposal_id: ProposalId; n: number
  before: string; after: string; diff: string
  content_hash: string                    // sha256 of before; empty text for an addition
  after_hash: string                      // sha256 of after
  finding_ids: FindingId[]; occasions: number; counts: Counts
  evidence: Quote[]                       // the cited findings as they read when proposed
  decision: 'accepted' | 'rejected' | null; reason: string | null
  decided_by: PersonId | null; decided_at: string | null; created_at: string
}
```

### Replays and scores

A row of `session_replays`, as `SessionReplay`, and the scores a proposal keeps:

```ts
type SessionReplay = {
  id: string; team_id: TeamId; proposal_id: ProposalId
  kind: 'behind' | 'unrelated'; variant: 'change' | 'current'
  source_session_id: SessionId; upto_seq: number; finding_id: FindingId | null
  label: string                           // all the judge sees of it
  task_id: TaskId; session_id: SessionId
  status: 'running' | 'replied' | 'failed'; reply: string | null; verdict: Verdict | null
  superseded_at: string | null            // set when a retried replay stage started over
  created_at: string; replied_at: string | null
}
type Verdict = 'fixed' | 'still' | 'ok' | 'worse'
type SessionScore = { behind: number; still: number; unrelated: number; worse: number }
type Scores =
  | { candidate: RunScore; current: RunScore }                    // improve, as before
  | { change: SessionScore; current: SessionScore; cases: CaseResult[] }   // coach
```

## Tables

Migration `0012_evidence.sql` adds five tables. `docs/data-model.md` has their columns. The shared test database already has `findings`, `decisions` and `evidence` tables from another branch, so these names say what they hold.

- `session_reads`, how far each session has been read, so each event is read once.
- `candidates`, corrections no rule covers, with the run that first saw them.
- `session_findings`, every finding code kept.
- `proposal_hunks`, each proposal's hunks, the findings they cite, and the decision on each. Decided hunks are the memory.
- `session_replays`, the replays that score a coach proposal, superseded ones among them.

`proposals` gains the target `agent`, for a coach proposal whose hunks touch an agent's instructions, skills, profiles or checks. The old targets `instructions` and `skill` stay readable for proposals already made.

## Rules code enforces

Each rule has a check that was seen failing, and each number in them is a named constant with its reason.

1. **A quote must be in its event.** The cited event's stored text must contain the quote, after collapsing runs of whitespace on both sides. A quote under 12 characters is dropped, since it matches too easily to tie a finding to what was said, and so is one over 300, since it carries more of a session than a finding needs into every prompt and page. The event must be one the reader was shown: a prompt, the agent's own words, a tool call or result, or an error, never its thinking, a notice or a subagent's words.
2. **Each event is read once.** `session_reads` holds how far each session was read, so a long DM is read in parts, and a re-run reads only what is new. The transcript shows two steps read before, marked as context, and a finding citing a step outside the ones this run read is dropped. The reader's whole prompt stays under 100,000 characters. A session cut short is read to its last step shown, and the rest waits for the next run.
3. **Two occasions make a candidate.** A candidate is ready once its live findings come from two occasions. An occasion is a session, or for a pipeline's stage sessions, the run, since one run's stages are one occasion. People are counted apart, and both counts show wherever a candidate does. A gap is a person's words, from the event's author, or in a room from the person who posted the words a prompt carries. A gap quoting the agent, even when it repeats a person, or quoting a tool or a pipeline's own prompt, is dropped, so an echo never counts as an occasion.
4. **Findings expire.** A finding counts for 90 days from the event it quotes, a candidate's and a pipeline's alike. A candidate with no live findings is gone from every prompt and count, and a pipeline change whose cited findings are all older is refused.
5. **The model judges sameness, code merges.** A reader may say a gap repeats an open candidate, or that two candidates are one. Code checks each id is an open candidate of this agent, then moves the findings. An id that names no open candidate drops its finding, and a merge entry that is not a pair of ids drops alone.
6. **Routing before text.** Code routes each ready candidate. One person behind every live finding sends it to that person's profile. Otherwise, when most of its findings say a lint rule, type or check could catch it, it goes to a check. Otherwise, when most say it applies narrowly and give a trigger, it becomes a skill. What is left changes the shared instructions. A hunk whose target differs from the route of the candidate it cites is refused, and a profile hunk carries only that person's own corrections.
7. **A hunk cites findings about one correction.** A hunk with no finding ids is refused, as is one citing a finding that is not this subject's live evidence, and one whose gaps come from more than one candidate, so a decision on a hunk is a decision on one correction.
8. **Floors.** An added or changed rule, skill, profile line or check needs findings from two occasions. Deleting a rule needs two harm findings about that rule, from two occasions.
9. **At most five hunks.** A writer that sends more has its whole report refused.
10. **A size budget.** The always-loaded text, the instructions plus the description of every skill that loads for the agent, its own and the team's, at 4 characters a token, stays under 5,000 tokens, or shrinks when it is already over. Checked for the whole proposal and again for the hunks kept.
11. **The server computes the hunks.** The writer names operations on rules by their hashes. The server applies them, so the text and diff of each hunk are measured by code, and a change cannot touch text the writer did not name. Applying checks the result: every rule written stands as its own rule, every rule deleted is gone, and every rule no hunk names is still there. A hunk that fails this, alone or with the hunks before it, is refused.
12. **A rejected hunk stays rejected.** A hunk is held back when the team turned down one with the same scope, target, skill or person, and `before`, that either makes the same change, by `after_hash`, or cites a finding it cites, unless more occasions back the new one. The writer sees the latest 10 hunks the team turned down in the last 90 days, with who and why.
13. **Only a winner reaches the shepherd.** With the change, fewer replays still need the correction than without it, and no more unrelated replays get worse.
14. **Clean evidence.** Coach never reads a session of a run whose pipeline learns, meaning it has a `pick_sessions`, `record_findings`, `propose_hunks` or `score_change` stage, or does not load. Nor does it read a replay or a private session. Improve's study may cite any team run of the pipeline it studies except replays and its own run, so improve can still improve coach.

Improve gets rules 1, 4, 7, 11 and 12. Rule 1 holds without its shown steps, since the study reads runs through the team record's tools rather than a transcript code wrote, and rule 7 without its one correction, since a pipeline's findings belong to no candidate. Its hunks are not held to the floors, the cap or the size budget, since the brief asks for citations and rejection memory there, and holding improve to two runs would take away a change it can make today. That one is Tayler's call.

## Replays

Coach reuses improve's way of scoring: the proposal waits in `scoring` while replays run, both versions are compared, and only a win reaches the shepherd, with both scores. What it replays differs. Improve replays pipeline runs. Coach replays one turn of a session.

- **Cases behind the change.** For each session behind a hunk, the replay ends at the turn before the correction. If the finding quotes a person's correction, the replay answers the message before it. If it quotes the agent, the replay answers the message that turn answered. At most 4 cases.
- **Unrelated cases.** Up to 2 recent sessions with nothing behind the change, replayed at their last message from a person.
- **Each case twice.** Once with the current instructions, skills and profiles, once with every text hunk applied. Check hunks change no text, so they are not replayed.
- **They fit the cap.** A replay may spend $0.50, so a case costs up to $1.00, and $0.50 of the run's cap is kept for the judge and for a replay that runs past its budget before it stops. As many cases start as fit in what the run has left. When not all fit, one unrelated case stays whenever two fit. When not even one fits, the stage fails and says why.
- **How a replay runs.** A replay is a task with `source = 'replay'`, its own empty workspace on the agent's home machine and a fresh session. Its one message is the conversation before the replay point, then the message to answer. It runs with no plugins, a $0.50 budget and 15 minutes. It reads nothing from the team record, since the record holds the correction it is meant to do without, and any tool it asks to use is denied, since a replay never waits on a person.
- **What a replay remembers.** Only the profiles of the people in the conversation it replays, and in the change's replays, the lines a profile hunk adds to them. No logs and no team profile, since either may hold the correction.
- **The judge.** It sees each reply under a shuffled label, and session text indented under each heading, so a reply cannot pass for another replay. The prompt says that text is data. For a case behind the change it answers `fixed` or `still`. For an unrelated case it answers `ok` or `worse`, against the reply the person accepted. A reply that never came counts as `still` or `worse`. A reply the judge leaves out, or gives any other verdict, means the change was not shown to win.
- **A retry starts over.** When a person retries the replay stage after a hand-off, the proposal's earlier replays stop and are marked superseded. They stay, so their spend still counts toward the cap and they are still treated as replays.
- **They count.** A replay's cost counts toward the coach run's spend cap.

## Decisions

The shepherd decides each hunk on the run page: keep it, or turn it down with a reason. The gate then settles the rest. Approving keeps every hunk not turned down. Rejecting turns down every hunk not yet decided, with the gate's message as the reason.

Each decision lives on its hunk, with who, when and why. That row is the memory: it holds for the whole team, keyed by the hunk's scope, content hashes and finding ids. A pipeline proposal is kept or rejected whole, since it was scored whole, and each of its hunks records that decision.

Settling a coach proposal checks each kept hunk still applies: the rule it changes or deletes is still there, and a changed skill still has the content it had. It then writes the instructions, skills and profiles, and closes the candidates behind kept hunks. A kept check hunk changes no text. Its candidate closes, and the run's note lists the check to add, since Agents has no lint job yet to send it to. The runner records a failed step and goes on, so a learning step that fails partway takes back everything it wrote.

## Clean evidence

- Sessions of a run whose pipeline learns never count. The runner loads each version, so code reads this from the pipeline's stages, not its name.
- Replays never count: tasks with `source = 'replay'`, from improve or coach.
- Coach reads only team sessions. Improve's study reads runs through the team record's tools, and code drops any finding it cites from a private run, since the whole team reads a proposal's quotes.
- A session's source is `pipeline` when it belongs to a run, `box` when it ran on a box, and `person` otherwise. Each count shows the three apart.
- Only sessions quiet for 30 minutes are read, since a session still in use may get its correction later and is read once.

## Deploying

This branch removes the actions `propose_instructions` and `apply_proposal`. That is a regression, since a pipeline can no longer propose a whole new set of instructions or a skill and apply it on approval. `score_change` gains the outcome `refused`. The coach and improve files on the live forge use the old actions and have no `refused` handler, so under this code neither loads. A run of either that is in flight when the API restarts is stranded. Its version no longer loads, and the runner fails it after five tries. In order:

1. Drain or cancel every coach and improve run. Let running ones finish, or cancel them from their run page. An old coach proposal still waiting at its gate cannot be applied after the restart.
2. Update the daemon on this Mac and rebuild the box image, before any coach run. A replay carries its $0.50 budget only where this branch's daemon reads it, so an older daemon runs it uncapped. Stage budgets go in both places, so older daemons still cap stages.
3. Restart the API on this code. Migration 0012 applies when it starts.
4. Publish the new pipeline files: `node --env-file=.env ops/publish-pipelines.ts --merge`.
5. Confirm both are current. On each pipeline's page the newest version is current, or `select p.name, v.git_sha, v.error from pipelines p join pipeline_versions v on v.id = p.current_version_id where p.name in ('coach', 'improve')` shows the new sha and no error.

## Choices I made

- **Hunks are operations on rules, not an edited copy.** One model turn instead of two, every hunk applies on its own, and code knows exactly which rule each one touches.
- **The person count routes first.** One person's correction never becomes shared text, even when a check could catch it, since a check is shared too.
- **The agent comes from the title.** Code needs the agent before any model runs, so `pick` takes the one team agent whose name is a whole word in the title, then the body.
- **Each event is read once, not each session.** A DM is one session that lasts weeks.
- **Improve's findings back its whole change.** Improve changes its file once, so every hunk of that change cites the study's checked findings.
- **The memory matches the change or the evidence.** A hunk with the same `before` and `after` is held back on any findings, and a reworded one on findings the turned-down one cited, until more occasions back it.
- **Behind cases come first in the cap.** A case behind the change is what the score is about, so when the cap is short they fill it, keeping one unrelated case whenever two fit.
- **Superseded replays stay.** Deleting them lost their spend from the cap and their protection as replays while their sessions were still stopping.

## Questions for Tayler

- Should improve's hunks meet the two-run floor, the five-hunk cap and a size budget, as coach's do?
- Improve's replays still read the team record and still wait on a person for a tool approval. Coach's replays do neither. Should improve's match?

## Checks

| Check | What it covers | Runs against |
|---|---|---|
| `test/step20.ts` | findings, reading once, shown steps, people's words, the quote cap, the reader's prompt cap, clean evidence, candidates, counts, expiry, merges, routes, private runs in a study | the test database, calling the server's code |
| `test/step20a.ts` | applying edits, hunks, one correction per hunk, profiles, floors, routes, the cap, the budget, server diffs, the memory, the writer's view, deciding and settling, replays: fitting the cap, superseded on a retry, memory, blinding, fencing and scoring, a step that fails partway, git failing | the test database, calling the server's code |
| `test/step20b.ts` | a coach run end to end, from people's DMs through replays and the judge to an applied change, a change that loses its replays, budgets on every session, and who may decide a hunk | the API, the daemon and the stand-in for Claude |
| `test/step20c.ts` | an improve run citing findings, a turned-down change held back, and a pipeline hunk never decided alone | the API, the daemon, the forge and the stand-in |
| `test/step20d.ts` | the proposal page: hunks, quotes, counts, scores and per-hunk decisions, at phone width too, and one read of the hunks for a page of proposals | three browsers on the app |

`test/step9.ts` and `test/step9b.ts` also check that improve's change cites the reminder from each past run. How each check was seen failing is in `docs/build-log.md`, under "Coach and improve learn from checked evidence".
