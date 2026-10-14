# Pipelines

A pipeline is a file in the team's pipelines repo that takes work from a report to a result through stages: an agent's turn, a check, an action on the forge, or a gate where a person decides. Its page shows each version with how its runs went, its runs, and a form to start one. A run's page shows each stage live, what the run made, and anything waiting on a person. bug-fix takes a bug report to a merged fix, or to a plan when the fix is big.

```json
{
  "id": "pipelines",
  "name": "Pipelines",
  "paths": [
    "app/src/Pipeline.tsx",
    "app/src/Run.tsx",
    "server/pipelines.ts",
    "server/runner.ts",
    "server/hooks.ts",
    "pipelines/bug-fix.ts"
  ],
  "checks": [
    "test/step6.ts",
    "test/step6b.ts",
    "test/step8.ts"
  ]
}
```

## Sub-features

- `pipeline-page`: description, versions with their runs, done and stopped counts, recent runs, and the pipeline file.
- `run-start-app`: start a run from the pipeline's page with a title, details and a repo.
- `run-live`: the run's stages arrive while the page is open, each with its kind, outcome and summary.
- `run-merge`: approving bug-fix's gate merges the pull request, and the run finishes with its note, time and cost.
- `run-session`: open a stage's session beside the run.
- `run-plan`: a hard bug ends in a plan document, which the shepherd approves or rejects with a note.
- `run-cancel`: Cancel run stops a run.
- `run-room`: the pipeline's room carries the runs' progress, and takes no posts from people.
- `run-teammate`: a teammate sees a new run in their Runs list without a reload.
- `run-webhook`: another system starts a run through the pipeline's own signed webhook, and a repeated delivery starts one run.
- `run-forge-issue`: an issue filed with the bug label on the forge starts a bug-fix run.
- `improve-from-app`: start the improve pipeline from its page on the team's pipelines repo.

## How to get to it (user POV)

- Choose a pipeline in the sidebar's Pipelines list, fill in Start a run, and choose Start.
- Choose a run in the sidebar's Runs list or on its pipeline's page.
- On a run's page, choose Open session beside a stage, a document under Made by this run, Pipeline, or Cancel run.
- Choose the pipeline's room in Conversations, or Room on its page.
- File an issue with the bug label on the team's forge repo, or post to the pipeline's webhook from another system.

## Driving it with agentsctl

Preconditions:

- An instance from `bin/agentsctl up --pipelines`, passing `bin/agentsctl doctor`, on the fake Claude harness. Its bug-fix fixes reports titled TENOFF, plans ones titled PLANME, and cannot reproduce ones titled STUCK.

- **The pipeline page.** Run `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --name bug-fix --within list:Pipelines` and `bin/agentsctl browser wait --role rowheader --text current`. The page shows bug-fix's description, its current version and Start a run. Its file opens in place: `bin/agentsctl browser click --role group --text "The pipeline file"` and `bin/agentsctl browser wait --role group --text "start: 'triage'"`. Capture it with `bin/agentsctl visual shot pipeline --ready-role rowheader --ready-text current`. Then `bin/agentsctl browser a11y` and `bin/agentsctl browser console`.
- **Start a run from the app.** Run `bin/agentsctl browser fill --role textbox --name "What should it work on?" --value "TENOFF goes negative"`, `bin/agentsctl browser fill --role textbox --name Details --value "A \$5 order with TENOFF comes to -\$5.00."`, `bin/agentsctl browser select --role combobox --name Repo --option "$(bin/agentsctl db "select name from teams where id = {team}" --value)/shop"`, `bin/agentsctl browser click --role button --name Start --within "form:Start a run"` and `bin/agentsctl browser wait --role heading --name "TENOFF goes negative"`. The run's page opens and its first stage arrives: `bin/agentsctl browser wait --role listitem --text triage --within list:Stages --timeout 30`.
- **A teammate sees the run.** Run `bin/agentsctl browser goto / --as ben` and `bin/agentsctl browser wait --role button --text "TENOFF goes negative" --within list:Runs --as ben --timeout 30`. ben's Runs list shows it without a reload.
- **Stages arrive live up to the gate.** Run `bin/agentsctl browser wait --role listitem --text confirm --within list:Stages --timeout 120` and `bin/agentsctl browser wait --role region --name "Needs a decision" --timeout 240`. The reproduction test was seen failing before the fix, and the suite passing after: `bin/agentsctl browser wait --role listitem --text fails --within list:Stages` and `bin/agentsctl db "select string_agg(rs.stage || '=' || coalesce(rs.outcome, rs.status), ',' order by rs.n) as path from run_stages rs join runs r on r.id = rs.run_id join tasks t on t.id = r.task_id where t.team_id = {team} and t.title = 'TENOFF goes negative'" --expect "path=triage=new,reproduce=easy,confirm=fails,fix=fixed,verify=passes,open_pr=done,shepherd=waiting"`.
- **Approve, and the fix merges.** Run `bin/agentsctl browser click --role button --name Approve` and `bin/agentsctl browser wait --role paragraph --text "Fixed and merged." --timeout 120`. The run is done with its time and cost, and lists the merged pull request: `bin/agentsctl browser wait --role definition --text "$"` and `bin/agentsctl browser wait --role listitem --text merged --within "list:Made by this run"`. The record agrees: `bin/agentsctl db "select r.status, a.state from runs r join tasks t on t.id = r.task_id join artifacts a on a.task_id = t.id where t.team_id = {team} and t.title = 'TENOFF goes negative' and a.kind = 'link'" --expect status=done --expect state=merged`. Capture it with `bin/agentsctl visual shot run-done --ready-role paragraph --ready-text "Fixed and merged."`, then `bin/agentsctl browser a11y`.
- **Open a stage's session.** Run `bin/agentsctl browser click --role button --name "Open session" --within listitem --within-text fixed` and `bin/agentsctl browser wait --role listitem --text "Tool · Edit" --within list:Events --timeout 15`. The fix stage's session opens beside the run, showing the agent's edit.
- **Check the run page at phone width.** Run `bin/agentsctl browser goto "#/r/$(bin/agentsctl db "select r.id from runs r join tasks t on t.id = r.task_id where t.team_id = {team} and t.title = 'TENOFF goes negative'" --value)" --width phone` and `bin/agentsctl browser overflow --width phone`. The run fits a phone without sideways scrolling.
- **The pipeline's room has the run's progress.** Run `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --name "# bug-fix" --within list:Conversations` and `bin/agentsctl browser wait --role listitem --text "Finished: Fixed and merged." --within list:Messages --timeout 15`. The room shows the run's start, its gate question and its end. People cannot post there: `bin/agentsctl api POST "/v1/conversations/$(bin/agentsctl db "select id from conversations where team_id = {team} and kind = 'room' and name = 'bug-fix'" --value)/messages" --body "{\"text\":\"hello\"}" --expect 400 --expect-text "pipeline's room"`.
- **A hard bug ends in a plan.** Run `bin/agentsctl browser click --role button --name bug-fix --within list:Pipelines`, `bin/agentsctl browser fill --role textbox --name "What should it work on?" --value "PLANME taxes are wrong"`, `bin/agentsctl browser fill --role textbox --name Details --value "Tax is off for every country but one."`, `bin/agentsctl browser click --role button --name Start --within "form:Start a run"`, `bin/agentsctl browser wait --role button --name plan.md --within "list:Made by this run" --timeout 120` and `bin/agentsctl browser click --role button --name plan.md`. The plan opens beside the run, rendered: `bin/agentsctl browser wait --role heading --name Plan --within complementary:Document`.
- **Reject the plan with a note.** Run `bin/agentsctl browser wait --role region --name "Needs a decision" --timeout 60`, `bin/agentsctl browser fill --role textbox --name Note --value "Needs a design review first."`, `bin/agentsctl browser click --role button --name Reject` and `bin/agentsctl browser wait --role paragraph --text "rejected the plan" --timeout 60`. The run stops, and the note stays with the answer: `bin/agentsctl db "select a.answer->>'message' as note, r.status from asks a join runs r on r.id = a.run_id join tasks t on t.id = r.task_id where t.team_id = {team} and t.title = 'PLANME taxes are wrong' and a.kind = 'gate'" --expect "note=Needs a design review first." --expect status=failed`.
- **Cancel a run.** Run `bin/agentsctl browser click --role button --name bug-fix --within list:Pipelines`, `bin/agentsctl browser fill --role textbox --name "What should it work on?" --value "TENOFF to cancel"`, `bin/agentsctl browser click --role button --name Start --within "form:Start a run"`, `bin/agentsctl browser wait --role listitem --text triage --within list:Stages --timeout 30`, `bin/agentsctl browser click --role button --name "Cancel run"` and `bin/agentsctl browser wait --role paragraph --text "Cancelled by" --timeout 30`. The run stops and says who cancelled it: `bin/agentsctl db "select r.status from runs r join tasks t on t.id = r.task_id where t.team_id = {team} and t.title = 'TENOFF to cancel'" --expect status=cancelled`.
- **Another system starts a run through the webhook.** Post a signed report to bug-fix's webhook twice with the same id. Run `bin/agentsctl api POST "/v1/hooks/pipelines/$(bin/agentsctl db "select id from pipelines where team_id = {team} and name = 'bug-fix'" --value)" --as webhook --body "{\"title\":\"PLANME from a webhook\",\"body\":\"Sent by another system.\",\"repo\":\"$(bin/agentsctl db "select name from teams where id = {team}" --value)/shop\",\"id\":\"hook-1\"}" --expect-text runs` twice: `bin/agentsctl api POST "/v1/hooks/pipelines/$(bin/agentsctl db "select id from pipelines where team_id = {team} and name = 'bug-fix'" --value)" --as webhook --body "{\"title\":\"PLANME from a webhook\",\"body\":\"Sent by another system.\",\"repo\":\"$(bin/agentsctl db "select name from teams where id = {team}" --value)/shop\",\"id\":\"hook-1\"}" --expect-text runs`. One run starts, from the webhook: `bin/agentsctl db "select count(*)::int as n, min(r.trigger) as trigger from runs r join tasks t on t.id = r.task_id where t.team_id = {team} and t.title = 'PLANME from a webhook'" --expect n=1 --expect trigger=webhook`. A delivery without the right signature is refused: `bin/agentsctl api POST "/v1/hooks/pipelines/$(bin/agentsctl db "select id from pipelines where team_id = {team} and name = 'bug-fix'" --value)" --as machine --body "{\"title\":\"unsigned\"}" --expect 401`. Then cancel the webhook's run: `bin/agentsctl api POST "/v1/runs/$(bin/agentsctl db "select r.id from runs r join tasks t on t.id = r.task_id where t.team_id = {team} and t.title = 'PLANME from a webhook'" --value)/cancel"`.
- **Start improve from the app on the pipelines repo.** improve changes a pipeline's file, so it runs on the team's pipelines repo. Run `bin/agentsctl browser click --role button --name improve --within list:Pipelines`, `bin/agentsctl browser wait --role heading --name improve` and `bin/agentsctl browser select --role combobox --name Repo --within "form:Start a run" --option "$(bin/agentsctl db "select name from teams where id = {team}" --value)/pipelines" --timeout 5`. The Repo list offers the pipelines repo.

## Gotchas

- The instance's pipelines come from its own forge org, named like its team, with bug-fix changed to run on the agents' home machine, since a box cannot reach an instance's port.
- A run started from a forge issue needs the forge's webhook, which can reach only the live API's port. On an instance that entry point is unreachable, so drive the pipeline's own webhook instead, which goes through the same start.
- The fake harness's bug-fix triage reports only after a reminder, as a model that forgets would. The run page shows that stage's session getting the reminder. improve's change fixes exactly that, which is what the proposals feature scores.
- Run pages and the Runs list leave replays out. Replays show on their proposal's run.
- Each stage row reads stage, kind, outcome and time, so match a stage by `--text` with its name or outcome.
- A $ in a value needs a backslash inside double quotes, as in the Details of the first run.
- A known bug, seen 2026-10-13. The Start a run form leaves out the pipelines repo for every pipeline, so improve cannot be started from the app on the repo it changes. "Start improve from the app on the pipelines repo" fails until that is fixed.
- A known accessibility bug, seen 2026-10-13. The pipeline file's box scrolls but cannot take keyboard focus (axe rule scrollable-region-focusable, serious), so "The pipeline page" fails its a11y check until that is fixed.
