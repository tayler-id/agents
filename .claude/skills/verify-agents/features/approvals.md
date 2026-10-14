# Approvals and asks

Anything that waits on a person is an ask, shown as a card where the work is, and anyone on the team can answer it. An agent's gated tool waits for Allow once, Always allow, Deny or Never, and Always and Never become standing rules. A pipeline's gate asks for a decision, with links and an optional note. A stage that runs out of tries or gets stuck hands off to a person, who lets it try again or takes over.

```json
{
  "id": "approvals",
  "name": "Approvals and asks",
  "paths": [
    "app/src/Asks.tsx",
    "server/record.ts",
    "server/runner.ts",
    "daemon/claude.ts"
  ],
  "checks": [
    "test/step4a.ts",
    "test/step4b.ts",
    "test/step6.ts",
    "test/step6b.ts"
  ]
}
```

## Sub-features

- `tool-ask`: an agent's gated tool waits as a Needs approval card in the conversation, naming the tool and the command.
- `tool-allow`: Allow once runs it, this time only.
- `tool-deny`: Deny blocks it, and the turn still finishes.
- `tool-always`: Always allow runs it and makes a rule, which answers the next matching ask by itself.
- `tool-never`: Never blocks it and makes a rule that blocks the next one.
- `gate`: a pipeline's gate is a Needs a decision card on the run, with its links, answered Approve or Reject with an optional note.
- `handoff`: a hand-off is a Needs a person card: Try again lets the stage run once more, and Stop, I will take over ends the run.

## How to get to it (user POV)

- A tool approval appears in the conversation where the agent asked. A gate or hand-off appears on the run's page, and its question is posted in the pipeline's room.
- Choose an answer on the card. On a gate or hand-off, write a note first if you want.

## Driving it with agentsctl

Preconditions:

- An instance from `bin/agentsctl up`, passing `bin/agentsctl doctor`. The gate and hand-off steps, marked (pipelines), need it started with `--pipelines` on the fake Claude harness. The tool approval steps, marked (real Claude), need it started with `--claude real`, since the fake harness never asks to use a tool.

- **A gate asks for a decision (pipelines).** Start a bug-fix run on a bug the fake harness fixes, on a copy of the shop of its own, so the fix it merges leaves the team's shop as the pipelines feature needs it, and open the run when it waits. Run `bin/agentsctl seed repo gate-shop`, `bin/agentsctl api POST "/v1/pipelines/$(bin/agentsctl db "select id from pipelines where team_id = {team} and name = 'bug-fix'" --value)/runs" --body "{\"title\":\"GATEOFF at the gate\",\"body\":\"discount(5, 'TENOFF') is -5.\",\"repoId\":\"$(bin/agentsctl db "select id from repos where team_id = {team} and remote_url like '%/gate-shop.git'" --value)\"}"`, `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --text "GATEOFF at the gate" --within list:Runs --timeout 20` and `bin/agentsctl browser wait --role region --name "Needs a decision" --timeout 240`. The card asks whether to merge and links the pull request: `bin/agentsctl browser wait --role link --name "Pull request #1" --within "region:Needs a decision"`. Capture it with `bin/agentsctl visual shot gate --ready-role region --ready-name "Needs a decision"`.
- **Approve with a note (pipelines).** Run `bin/agentsctl browser fill --role textbox --name Note --value "Ship it."`, `bin/agentsctl browser click --role button --name Approve` and `bin/agentsctl browser wait --role paragraph --text "Fixed and merged." --timeout 120`. The run finishes and keeps who answered and the note: `bin/agentsctl db "select a.answer->>'decision' as decision, a.answer->>'message' as note, (a.answered_by = {owner}) as by_ada from asks a join runs r on r.id = a.run_id join tasks t on t.id = r.task_id where t.team_id = {team} and t.title = 'GATEOFF at the gate' and a.kind = 'gate'" --expect decision=approve --expect "note=Ship it." --expect by_ada=true`.
- **A hand-off asks a person (pipelines).** Start a run the fake agent cannot reproduce. Run `bin/agentsctl api POST "/v1/pipelines/$(bin/agentsctl db "select id from pipelines where team_id = {team} and name = 'bug-fix'" --value)/runs" --body "{\"title\":\"STUCK on a bug nobody can reproduce\",\"body\":\"It happens sometimes.\",\"repoId\":\"$(bin/agentsctl db "select id from repos where team_id = {team} and remote_url like '%/shop.git'" --value)\"}"`, `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --text "STUCK on a bug" --within list:Runs --timeout 20` and `bin/agentsctl browser wait --role region --name "Needs a person" --timeout 120`. The card says the agent could not reproduce the bug and offers Try again and Stop, I will take over. Capture it with `bin/agentsctl visual shot handoff --ready-role region --ready-name "Needs a person"`.
- **Try again, then take over (pipelines).** Run `bin/agentsctl browser click --role button --name "Try again"`, `bin/agentsctl browser wait --role listitem --text "try 2" --within list:Stages --timeout 60` and `bin/agentsctl browser wait --role region --name "Needs a person" --timeout 120`. The stage runs a second time and hands off again. Then `bin/agentsctl browser click --role button --name "Stop, I will take over"` and `bin/agentsctl browser wait --role paragraph --text "Handed off to" --timeout 60`. The run stops and says who took over: `bin/agentsctl db "select r.status, r.note like 'Handed off to ada-%' as to_ada from runs r join tasks t on t.id = r.task_id where t.team_id = {team} and t.title = 'STUCK on a bug nobody can reproduce'" --expect status=failed --expect to_ada=true`.
- **Allow once (real Claude).** Ask fixer to run a command. Run `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --name fixer --within list:Agents`, `bin/agentsctl browser fill --role textbox --name Message --value "Run exactly this command with the Bash tool, once, and nothing else: echo approved > first.txt"`, `bin/agentsctl browser press Enter --role textbox --name Message` and `bin/agentsctl browser wait --role region --name "Needs approval" --timeout 120`. The card names Bash and the command, and the session waits: `bin/agentsctl browser text --role region --name "Needs approval" --expect "echo approved > first.txt"` and `bin/agentsctl db "select s.status from sessions s join conversations c on c.id = s.conversation_id join agents a on a.id = s.agent_id where c.team_id = {team} and c.kind = 'dm' and a.name = 'fixer' order by s.created_at desc limit 1" --expect status=needs_approval`. Then `bin/agentsctl browser click --role button --name "Allow once"` and `bin/agentsctl browser wait --role region --name "Needs approval" --gone --timeout 60`. The answer is recorded, and the command ran on the agent's machine, in its folder: `bin/agentsctl db "select a.answer->>'decision' as decision from asks a join sessions s on s.id = a.session_id join conversations c on c.id = s.conversation_id where c.team_id = {team} order by a.created_at desc limit 1" --expect decision=allow` and `bin/agentsctl machine read "agents/$(bin/agentsctl db "select id from agents where team_id = {team} and name = 'fixer'" --value)/first.txt" --expect-text approved --timeout 60`.
- **Deny (real Claude).** Run `bin/agentsctl browser fill --role textbox --name Message --value "Run exactly this command with the Bash tool, once, and nothing else: echo denied > second.txt"`, `bin/agentsctl browser press Enter --role textbox --name Message`, `bin/agentsctl browser wait --role region --name "Needs approval" --timeout 120`, `bin/agentsctl browser click --role button --name Deny` and `bin/agentsctl browser wait --role region --name "Needs approval" --gone --timeout 60`. The command is blocked and the turn still ends: `bin/agentsctl db "select a.answer->>'decision' as decision from asks a join sessions s on s.id = a.session_id join conversations c on c.id = s.conversation_id where c.team_id = {team} order by a.created_at desc limit 1" --expect decision=deny` and `bin/agentsctl machine read "agents/$(bin/agentsctl db "select id from agents where team_id = {team} and name = 'fixer'" --value)/second.txt" --missing`.
- **Always allow, then the rule answers (real Claude).** Run `bin/agentsctl browser fill --role textbox --name Message --value "Run exactly this command with the Bash tool, once, and nothing else: echo always > third.txt"`, `bin/agentsctl browser press Enter --role textbox --name Message`, `bin/agentsctl browser wait --role region --name "Needs approval" --timeout 120` and `bin/agentsctl browser click --role button --name "Always allow"`. A rule now allows commands that start with echo: `bin/agentsctl db "select pattern, decision from approval_rules where team_id = {team} order by created_at desc limit 1" --expect "pattern=echo " --expect decision=allow`. The next echo runs with nobody asked: `bin/agentsctl browser fill --role textbox --name Message --value "Run exactly this command with the Bash tool, once, and nothing else: echo again > fourth.txt"`, `bin/agentsctl browser press Enter --role textbox --name Message` and `bin/agentsctl db "select a.answer->>'message' as by from asks a join sessions s on s.id = a.session_id join conversations c on c.id = s.conversation_id where c.team_id = {team} order by a.created_at desc limit 1" --wait 120 --expect "by=answered by a standing rule"`.
- **Never (real Claude).** Run `bin/agentsctl browser fill --role textbox --name Message --value "Run exactly this command with the Bash tool, once, and nothing else: rm -f fourth.txt"`, `bin/agentsctl browser press Enter --role textbox --name Message`, `bin/agentsctl browser wait --role region --name "Needs approval" --timeout 120`, `bin/agentsctl browser click --role button --name Never` and `bin/agentsctl browser wait --role region --name "Needs approval" --gone --timeout 60`. A rule now blocks commands that start with rm: `bin/agentsctl db "select pattern, decision from approval_rules where team_id = {team} order by created_at desc limit 1" --expect "pattern=rm " --expect decision=deny`.

## Gotchas

- The fake harness answers permission prompts itself, so only a real Claude session raises a tool approval. Ask for one exact command, once, or the agent may try several and ask several times.
- An ask card is a region named for its kind: Needs approval, Needs a decision or Needs a person. A run can hold one open gate or hand-off at a time.
- A standing rule for Bash matches commands that start with the same first word, with a trailing space: "echo " covers every echo. For other tools it covers the tool.
- The gate's question is posted in the pipeline's room, mentioning the shepherd when the pipeline has one.
- A replay never waits on a person: its gates approve themselves and its hand-offs stop the replay.
- `map run all` runs this file before pipelines and proposals on the same instance. The gate's run merges its fix, so it works on a copy of the shop, gate-shop, which the fake harness's GATEOFF group edits: on the team's shop, pipelines' TENOFF run would find the bug already fixed and hand off at confirm instead of reaching its gate, and improve, in proposals, would replay a different pair of bug-fix's latest finished runs.
