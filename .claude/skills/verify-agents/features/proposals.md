# Proposals

Pipelines propose changes rather than make them. The coach reads conversations for corrections people keep making and proposes new instructions or a skill for an agent. The improve pipeline changes another pipeline's file once and scores the change by replaying past runs with it and without it, and only a change that scores better reaches the shepherd, as a pull request with both scores. A proposal shows its summary, scores and diff, beside the gate that approves it.

```json
{
  "id": "proposals",
  "name": "Proposals",
  "paths": [
    "app/src/Proposal.tsx",
    "server/refine.ts",
    "pipelines/improve.ts",
    "pipelines/coach.ts"
  ],
  "checks": [
    "test/step9.ts",
    "test/step9b.ts"
  ]
}
```

## Sub-features

- `proposal-instructions`: the coach proposes an agent's new instructions, with a diff; approving applies them.
- `proposal-skill`: the coach proposes a skill for one kind of task; approving gives the agent that skill.
- `proposal-pipeline`: improve proposes a pipeline change scored on replays, with both versions' scores and the diff; approving merges it and the change becomes the current version.
- `proposal-on-pages`: a proposal shows on the run that proposed it and on its pipeline's page, linking the two.

## How to get to it (user POV)

- Start the coach or improve pipeline from its page, then open the run.
- A proposal waiting for the shepherd shows on its run's page and under Proposed changes on its pipeline's page. Approve or Reject it on the run's gate.

## Driving it with agentsctl

Preconditions:

- An instance from `bin/agentsctl up --pipelines`, passing `bin/agentsctl doctor`, on the fake Claude harness. Its coach proposes British spelling for fixer when the run is titled Coach, and a release-notes skill when it is titled SkillCoach. Its improver adds "Always call report_result when you finish." to bug-fix's triage when the run is titled Improve.
- improve replays bug-fix's last two finished runs, so at least one of them must be a TENOFF run, whose triage needs a reminder. pipelines.md leaves one.

- **The coach proposes new instructions.** Run `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --name coach --within list:Pipelines`, `bin/agentsctl browser fill --role textbox --name "What should it work on?" --value "Coach fixer"`, `bin/agentsctl browser fill --role textbox --name Details --value "Look for corrections people keep making to fixer."`, `bin/agentsctl browser click --role button --name Start --within "form:Start a run"` and `bin/agentsctl browser wait --role region --name "Proposed change" --timeout 120`. The run shows the proposed instructions with their diff, waiting for the shepherd: `bin/agentsctl browser text --role region --name "Proposed change" --expect "PROPOSED INSTRUCTIONS CHANGE · WAITING FOR THE SHEPHERD"` and `bin/agentsctl browser wait --role region --name "Needs a decision" --timeout 30`. Capture it with `bin/agentsctl visual shot proposal-instructions --ready-role region --ready-name "Needs a decision"`.
- **Approve, and fixer's instructions change.** Run `bin/agentsctl browser click --role button --name Approve` and `bin/agentsctl browser wait --role paragraph --text "The change to the agent is applied." --timeout 60`. fixer now has the proposed instructions, and the proposal records who approved it: `bin/agentsctl db "select instructions from agents where team_id = {team} and name = 'fixer'" --expect "instructions=You fix bugs. Write in British English."` and `bin/agentsctl db "select p.status, (p.decided_by = {owner}) as by_ada from proposals p where p.team_id = {team} and p.target = 'instructions' order by p.created_at desc limit 1" --expect status=approved --expect by_ada=true`.
- **The coach proposes a skill.** Run `bin/agentsctl browser click --role button --name coach --within list:Pipelines`, `bin/agentsctl browser fill --role textbox --name "What should it work on?" --value "SkillCoach fixer"`, `bin/agentsctl browser click --role button --name Start --within "form:Start a run"`, `bin/agentsctl browser wait --role region --name "Needs a decision" --timeout 120`, `bin/agentsctl browser text --role region --name "Proposed change" --expect "PROPOSED SKILL RELEASE-NOTES"`, `bin/agentsctl browser click --role button --name Approve` and `bin/agentsctl browser wait --role paragraph --text "The change to the agent is applied." --timeout 60`. fixer has the skill with the proposed text: `bin/agentsctl db "select s.content from skills s join agents a on a.id = s.agent_id where a.team_id = {team} and a.name = 'fixer' and s.name = 'release-notes'" --expect "content=Write one line per merged pull request, newest first."`.
- **improve proposes a scored pipeline change.** Start improve on the pipelines repo through the API, then open its run. Run `bin/agentsctl api POST "/v1/pipelines/$(bin/agentsctl db "select id from pipelines where team_id = {team} and name = 'improve'" --value)/runs" --body "{\"title\":\"Improve bug-fix\",\"body\":\"Make bug-fix runs need fewer reminders.\",\"repoId\":\"$(bin/agentsctl db "select id from repos where team_id = {team} and remote_url like '%/pipelines.git'" --value)\"}"`, `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --text "Improve bug-fix" --within list:Runs --timeout 20` and `bin/agentsctl browser wait --role region --name "Needs a decision" --timeout 600`. The run replayed past runs with the change and without it, and shows both scores, the diff and the pull request: `bin/agentsctl browser wait --role rowheader --name "With the change" --within "region:Proposed change"`, `bin/agentsctl browser text --role region --name "Proposed change" --expect "Always call report_result when you finish."` and `bin/agentsctl browser wait --role link --name "Pull request" --within "region:Proposed change"`. The change needs no reminders where the current version needed some: `bin/agentsctl db "select (scores->'candidate'->>'problems')::int < (scores->'current'->>'problems')::int as better, status from proposals where team_id = {team} and target = 'pipeline' order by created_at desc limit 1" --expect better=true --expect status=open`. Capture it with `bin/agentsctl visual shot proposal-pipeline --ready-role rowheader --ready-name "With the change"`.
- **The proposal shows on its pipeline's page.** Run `bin/agentsctl browser click --role button --name bug-fix --within list:Pipelines` and `bin/agentsctl browser wait --role heading --name "Proposed changes"`. bug-fix's page lists the open proposal and links the run that proposed it: `bin/agentsctl browser click --role button --name "The run that proposed it"` and `bin/agentsctl browser wait --role heading --name "Improve bug-fix"`.
- **Approve, and the change becomes current.** Run `bin/agentsctl browser click --role button --name Approve` and `bin/agentsctl browser wait --role paragraph --text "Merged. The change is now the current version." --timeout 120`. bug-fix's current version is the proposal's: `bin/agentsctl db "select (pl.current_version_id = p.candidate_version_id) as current, p.status from proposals p join pipelines pl on pl.id = p.pipeline_id where p.team_id = {team} and p.target = 'pipeline' order by p.created_at desc limit 1" --expect current=true --expect status=approved` and `bin/agentsctl db "select count(*)::int as n from pipeline_versions v join pipelines p on p.id = v.pipeline_id where p.team_id = {team} and p.name = 'bug-fix'" --expect n=2`. bug-fix's page shows the proposal approved: `bin/agentsctl browser click --role button --name bug-fix --within list:Pipelines` and `bin/agentsctl browser text --role region --name "Proposed change" --expect "PROPOSED PIPELINE CHANGE · APPROVED"`.

## Gotchas

- improve needs its run on the pipelines repo, since it edits the files there. Start it from the API here; pipelines.md's last step shows what the app's form offers.
- Replays run each past run's report again from the commit it started at, once per version. They never open pull requests or wait on people, and they show only on the proposing run.
- A change that scores no better is turned down without asking anyone, and the run says so. A change whose file does not load fails before any replay.
- A skill proposal names its skill, and approving one with the name of an existing skill replaces that skill's text.
- A proposal's kicker is set in capitals by the stylesheet, and `browser text` reads the page as shown, so expect it in capitals.
- The coach's proposals depend on what people said in the record. The fake harness proposes the same change every time; real Claude reads the conversations.
