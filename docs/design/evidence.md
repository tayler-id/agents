# Coach and improve learn from checked evidence

The decision is in `docs/decisions.md`, under "Coach and improve learn only from checked evidence". This is how it is built. Instructions and pipelines change only on evidence from real sessions that code has checked, and a change reaches the shepherd only after replays show it helps.

Today coach hands an agent's whole new instructions to the shepherd on one model's say-so, and "more than once, in more than one session" lives only in its prompt. Improve's study can give any reason it likes. After this work, every claim a change rests on is a quote that code found in the event it cites, and code does the counting.

## The coach run

Coach learns about one agent, named in the run's title, such as "Coach fixer". Its stages:

1. `pick`, code. Picks up to 8 of the agent's sessions with events nobody has read yet, and writes each as a short transcript with step numbers.
2. `read`, a cheap model (`haiku`). Reads the transcripts once and reports findings: a rule followed, a rule ignored, a rule that caused harm, or a correction no rule covers. Each finding quotes one step.
3. `record`, code. Drops every finding whose quote is not in the stored text of the event it cites, keeps the rest, marks the sessions read, groups corrections into candidates, and counts them.
4. `write`, the pipeline's agent. Sees the candidates that are ready, with their counts, the route code chose for each, and every finding's id. Reports changes as hunks, each citing finding ids.
5. `propose`, code. Applies each hunk to compute its text and diff, refuses any hunk that breaks a rule below, and writes a proposal with the hunks that pass.
6. `replay`, code. Replays the sessions behind the change, and a few unrelated ones, with and without it.
7. `judge`, a cheap model. Reads each replayed reply without knowing which version wrote it, and says whether the original correction would still be needed, or whether the reply is worse than what the person accepted.
8. `decide`, code. Scores both versions from the verdicts. Only a change that wins goes on.
9. `shepherd`, a gate. The shepherd keeps or turns down each hunk, with a reason, then approves or rejects.
10. `settle`, code. Applies the kept hunks and records every decision.

A run ends early, and asks nobody, when there is nothing new to read, when no candidate has two sessions behind it, when the writer finds nothing to change, when every hunk is refused, or when the change loses its replay.

## The improve run

Improve keeps its shape: study, score, pull request, shepherd, merge. Three things change.

- The study reports findings too: the session and step of each problem it bases the change on, the exact words, and what went wrong. A new `record` stage checks them the same way.
- `score` splits the change into hunks. Each hunk cites the study's checked findings, and a change with none is refused before any replay.
- A `settle` stage after the gate records the shepherd's decision on every hunk. A later change that repeats a hunk the shepherd turned down, on the same evidence, is refused before any replay.

The pull request and the gate list the cited quotes, so the reasons a person reads are ones code checked.

## Where the code is

- `shared/evidence.ts` and `shared/ids.ts`, the shapes below.
- `server/evidence.ts`, picking and reading sessions, checking and recording findings, and candidates with their counts and routes.
- `server/hunks.ts`, applying the writer's operations, the rules for changes, the memory, deciding one hunk and settling a proposal.
- `server/refine.ts`, the actions the runner calls, and the replays of both pipelines.
- `pipelines/coach.ts` and `pipelines/improve.ts`, the stages and their prompts.

## Typed shapes

The zod schemas live once in `shared/evidence.ts`, and the types are `z.infer` of them. Ids are branded, so a finding's id cannot go where a candidate's belongs. The tables store findings and hunks as flat rows, and their check constraints hold the same rules the unions below spell out.

### Findings

```ts
type Source = 'person' | 'pipeline' | 'box'           // where the session came from, counted apart
type FindingKind = 'followed' | 'ignored' | 'harm' | 'gap'
type Rule = { hash: RuleHash; text: string }          // one of an agent's instructions

type FindingBase = {
  id: FindingId
  sessionId: SessionId
  event: { id: EventId; seq: number }                 // the step the quote comes from
  quote: string                                       // found in that event's stored text
  source: Source
  personId: PersonId | null                           // who made the correction, when a person did
  occasion: string                                    // the session, or the run a stage session belongs to
  seenAt: string                                      // the event's time; it counts for 90 days
  runId: RunId                                        // the run that recorded it
}

type AgentFinding = FindingBase & { subject: 'agent'; agentId: AgentId } & (
  | { kind: 'followed' | 'ignored' | 'harm'; rule: Rule }
  | { kind: 'gap'; candidateId: CandidateId; correction: string; fix: 'check' | 'text'; trigger: string | null }
)
type PipelineFinding = FindingBase & { subject: 'pipeline'; pipelineId: PipelineId; kind: FindingKind; note: string }
type Finding = AgentFinding | PipelineFinding
```

What a model reports is outside data, parsed one finding at a time so one bad finding drops alone:

```ts
type ReadFinding =                                    // coach's reader
  | { kind: 'followed' | 'ignored' | 'harm'; session: string; step: number; quote: string; rule: string }
  | { kind: 'gap'; session: string; step: number; quote: string; correction: string
      candidate?: string                              // an open candidate this repeats
      same?: string                                   // new gaps with the same label are one correction
      fix: 'check' | 'text'                           // could a lint rule, type or check catch it
      when?: string }                                 // when it applies, if it is narrow
type ReadReport = { findings: unknown[]; merges?: [string, string][] }   // pairs of candidates that are one correction

type StudyFinding = { kind: FindingKind; session: string; step: number; quote: string; note: string }  // improve's study
```

### Candidates

A candidate is a correction no rule covers, with the gap findings that carry it. It persists across runs. Code computes its counts and its route from its live findings.

```ts
type Counts = { sessions: number; people: number; bySource: Record<Source, number> }
type Route =
  | { kind: 'profile'; personId: PersonId; login: string }   // one person's preference
  | { kind: 'check' }                                        // a lint rule, type or check could catch it
  | { kind: 'skill'; trigger: string }                       // narrow, with a clear trigger
  | { kind: 'instructions' }                                 // what is left
type Candidate = {
  id: CandidateId; agentId: AgentId; correction: string
  status: 'open' | 'merged' | 'closed'; mergedInto: CandidateId | null
  counts: Counts; route: Route; ready: boolean               // ready once counts.sessions >= 2
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

A hunk as stored. The server computed `before`, `after` and `diff`. The decision on it is the team's memory.

```ts
type HunkChange =
  | { target: 'instructions'; op: 'add'; after: RuleHash | null }
  | { target: 'instructions'; op: 'change' | 'delete'; rule: RuleHash }
  | { target: 'skill'; op: 'add' | 'change'; skillName: string; description: string }
  | { target: 'profile'; op: 'add'; personId: PersonId }
  | { target: 'check'; op: 'add' }
  | { target: 'pipeline'; op: 'add' | 'change' | 'delete' }
type Hunk = HunkChange & {
  id: HunkId; proposalId: ProposalId; n: number
  before: string; after: string; diff: string
  contentHash: string                     // sha256 of `before`; empty text for an addition
  findingIds: FindingId[]; occasions: number; counts: Counts
  evidence: Quote[]                       // the cited findings as they read when proposed
  decision: null | { decision: 'accepted' | 'rejected'; reason: string; by: PersonId | null; at: string }
}
```

### Replays and scores

```ts
type ReplayCase =
  | { kind: 'behind'; findingId: FindingId; sessionId: SessionId; uptoSeq: number }
  | { kind: 'unrelated'; sessionId: SessionId; uptoSeq: number }
type Verdict = 'fixed' | 'still' | 'ok' | 'worse'
type SessionScore = { behind: number; still: number; unrelated: number; worse: number }
type Scores =
  | { candidate: RunScore; current: RunScore }                    // improve, as today
  | { change: SessionScore; current: SessionScore; cases: CaseResult[] }   // coach
```

## Tables

Migration `0012_evidence.sql` adds five tables. `docs/data-model.md` has their columns. The shared test database already has `findings`, `decisions` and `evidence` tables from another branch, so these names say what they hold.

- `session_reads`, how far each session has been read, so each event is read once.
- `candidates`, corrections no rule covers, with the run that first saw them.
- `session_findings`, every finding code kept.
- `proposal_hunks`, each proposal's hunks, the findings they cite, and the decision on each. Decided hunks are the memory.
- `session_replays`, the replays that score a coach proposal.

`proposals` gains the target `agent`, for a coach proposal whose hunks touch an agent's instructions, skills, profiles or checks. The old targets `instructions` and `skill` stay readable for proposals already made.

## Rules code enforces

Each rule has a named constant in the code, with its reason, and a check that was seen failing.

1. **A quote must be in its event.** The cited event's stored text must contain the quote, after collapsing runs of whitespace on both sides. A quote under 12 characters is dropped, since it matches too easily to tie a finding to what was said.
2. **Each event is read once.** `session_reads` holds how far each session was read, so a long DM is read in parts, and a re-run reads only what is new. The transcript shows two steps read before, marked as context, and a finding citing a step outside the ones this run read is dropped.
3. **Two occasions make a candidate.** A candidate is ready once its live findings come from two occasions. An occasion is a session, or for a pipeline's stage sessions, the run, since one run's stages are one occasion. People are counted apart, and both counts show wherever a candidate does.
4. **Candidates expire.** A finding counts for 90 days from the event it quotes. A candidate with no live findings is gone from every prompt and count.
5. **The model judges sameness, code merges.** A reader may say a gap repeats an open candidate, or that two candidates are one. Code checks each id is an open candidate of this agent, then moves the findings. An id that names no open candidate drops its finding.
6. **Routing before text.** Code routes each ready candidate. One person behind every live finding sends it to that person's profile. Otherwise, when most of its findings say a lint rule, type or check could catch it, it goes to a check. Otherwise, when most say it applies narrowly and give a trigger, it becomes a skill. What is left changes the shared instructions. A hunk whose target differs from the route of a candidate it cites is refused.
7. **A hunk cites findings.** A hunk with no finding ids is refused, as is one citing a finding that is not this subject's live evidence.
8. **Floors.** An added or changed rule, skill, profile line or check needs findings from two occasions. Deleting a rule needs two harm findings about that rule, from two occasions.
9. **At most five hunks.** A writer that sends more has its whole report refused.
10. **A size budget.** The always-loaded text, the instructions plus every skill description at 4 characters a token, stays under 5,000 tokens, or shrinks when it is already over. Checked for the whole proposal and again for the hunks kept.
11. **The server computes the hunks.** The writer names operations on rules by their hashes. The server applies them, so the text and diff of each hunk are measured by code, and a change cannot touch text the writer did not name.
12. **A rejected hunk stays rejected.** A hunk is held back when the team turned down one with the same scope and content hash that shares a finding with it, unless more occasions back the new one.
13. **Only a winner reaches the shepherd.** With the change, fewer replays still need the correction than without it, and no more unrelated replays get worse.
14. **Clean evidence.** Coach never reads a session of a run whose pipeline learns, meaning it has a `pick_sessions`, `record_findings`, `propose_hunks` or `score_change` stage, or does not load. Nor does it read a replay or a private session. Improve's study may cite any run of the pipeline it studies except replays and its own run, so improve can still improve coach.

Improve gets rules 1, 7, 11 and 12. Its hunks are not held to the floors, the cap or the size budget, since the brief asks for citations and rejection memory there, and holding improve to two runs would take away a change it can make today. That one is Tayler's call.

## Replays

Coach reuses improve's way of scoring: the proposal waits in `scoring` while replays run, both versions are compared, and only a win reaches the shepherd, with both scores. What it replays differs. Improve replays pipeline runs. Coach replays one turn of a session.

- **Cases behind the change.** For each session behind a hunk, the replay ends at the turn before the correction. If the finding quotes a person's correction, the replay answers the message before it. If it quotes the agent, the replay answers the message that turn answered. At most 4 cases.
- **Unrelated cases.** Up to 2 recent sessions with nothing behind the change, replayed at their last message from a person.
- **Each case twice.** Once with the current instructions, skills and profile, once with every text hunk applied. Check hunks change no text, so they are not replayed.
- **How a replay runs.** A replay is a task with `source = 'replay'`, its own empty workspace on the agent's home machine and a fresh session. Its one message is the conversation before the replay point, then the message to answer. It runs with no plugins, a $0.50 budget and 15 minutes. It reads nothing from the team record, since the record holds the correction it is meant to do without, and any tool it asks to use is denied, since a replay never waits on a person.
- **The judge.** It sees each reply under a shuffled label. For a case behind the change it answers `fixed` or `still`. For an unrelated case it answers `ok` or `worse`, against the reply the person accepted. A reply that never came counts as `still` or `worse`.

## Decisions

The shepherd decides each hunk on the run page: keep it, or turn it down with a reason. The gate then settles the rest. Approving keeps every hunk not turned down. Rejecting turns down every hunk not yet decided, with the gate's message as the reason.

Each decision lives on its hunk, with who, when and why. That row is the memory: it holds for the whole team, keyed by the hunk's scope, content hash and finding ids. A pipeline proposal is kept or rejected whole, since it was scored whole, and each of its hunks records that decision.

Settling a coach proposal checks each kept hunk still applies: the rule it changes or deletes is still there, and a changed skill still has the content it had. It then writes the instructions, skills and profiles, and closes the candidates behind kept hunks. A kept check hunk changes no text. Its candidate closes, and the run's note lists the check to add, since Agents has no lint job yet to send it to.

## Clean evidence

- Sessions of a run whose pipeline learns never count. The runner loads each version, so code reads this from the pipeline's stages, not its name.
- Replays never count: tasks with `source = 'replay'`, from improve or coach.
- Private conversations and tasks are never read, since a proposal shows its quotes to the whole team.
- A session's source is `pipeline` when it belongs to a run, `box` when it ran on a box, and `person` otherwise. Each count shows the three apart.
- Only sessions quiet for 30 minutes are read, since a session still in use may get its correction later and is read once.

## Choices I made

- **Hunks are operations on rules, not an edited copy.** One model turn instead of two, every hunk applies on its own, and code knows exactly which rule each one touches.
- **The person count routes first.** One person's correction never becomes shared text, even when a check could catch it, since a check is shared too.
- **The agent comes from the title.** Code needs the agent before any model runs, so `pick` takes the one team agent whose name is a whole word in the title, then the body.
- **Each event is read once, not each session.** A DM is one session that lasts weeks.
- **Improve's findings back its whole change.** Improve changes its file once, so every hunk of that change cites the study's checked findings.

## Questions for Tayler

- Should improve's hunks meet the two-run floor, the five-hunk cap and a size budget, as coach's do?
- Improve's replays still read the team record and still wait on a person for a tool approval. Coach's replays do neither. Should improve's match?

## Checks

| Check | What it covers | Runs against |
|---|---|---|
| `test/step20.ts` | findings, reading once, clean evidence, candidates, counts, expiry, merges, routes | the test database, calling the server's code |
| `test/step20a.ts` | hunks, floors, the cap, the budget, server diffs, the memory, the replay rule, settling | the test database, calling the server's code |
| `test/step20b.ts` | a coach run end to end, from people's DMs to an applied change | the API, the daemon and the stand-in for Claude |
| `test/step20c.ts` | an improve run citing findings, and a turned-down change held back | the API, the daemon, the forge and the stand-in |
| `test/step20d.ts` | the proposal page: hunks, quotes, counts, scores and per-hunk decisions | a browser on the app |

How each check was seen failing goes in `docs/design/evidence-resume.md` as it happens.
