# Sessions and the record

Everything an agent does is a session in the team's shared record. A person opens Session details beside a conversation, task or run to see every step in order, live, and the sidebar's Running now lists the sessions at work. Agents read the same record through their team-record tools: they search what teammates' agents did and read their sessions.

```json
{
  "id": "sessions",
  "name": "Sessions and the record",
  "paths": [
    "app/src/Session.tsx",
    "app/src/App.tsx",
    "server/teamrecord.ts",
    "daemon/record-mcp.ts"
  ],
  "checks": [
    "test/step1.ts",
    "test/step5.ts",
    "test/step10.ts"
  ]
}
```

## Sub-features

- `session-details`: Session details beside a conversation or a task lists every event, newest arriving live.
- `session-hide`: Hide session closes it again.
- `running-now`: Running now lists sessions at work, and choosing one opens it beside its conversation, task or run.
- `record-search`: an agent searches the team's record (search_record).
- `record-read`: an agent reads a teammate agent's session (read_session) and recent activity (recent_activity).

## How to get to it (user POV)

- Choose Session details in a conversation's or task's header. On a run, choose Open session beside a stage.
- Choose a session in the sidebar's Running now.
- Agents reach the record with their team-record tools. A person never calls them, but sees an agent cite a teammate's work.

## Driving it with agentsctl

Preconditions:

- An instance from `bin/agentsctl up --pipelines`, passing `bin/agentsctl doctor`, on the fake Claude harness.
- Run after conversations.md, whose launch room the record search finds.

- **Session details beside a DM.** Run `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --name fixer --within list:Agents`, `bin/agentsctl browser fill --role textbox --name Message --value "Show me your session."`, `bin/agentsctl browser press Enter --role textbox --name Message`, `bin/agentsctl browser wait --role listitem --text "fake reply" --within list:Messages --timeout 30`, `bin/agentsctl browser click --role button --name "Session details"` and `bin/agentsctl browser wait --role listitem --text "Turn ended" --within list:Events`. The session opens beside the conversation with each event: the message, the reply and the end of the turn. Its header names the session's state, the model it runs on, which is the agent's current model, and its machine: `bin/agentsctl browser text --role complementary --name "Session details" --expect "· $(bin/agentsctl db "select model from agents where team_id = {team} and name = 'fixer'" --value) · mac ·"`. Capture it with `bin/agentsctl visual shot session-details --ready-role list --ready-name Events`.
- **The panel follows new events live.** With the panel open, send another message. Run `bin/agentsctl browser fill --role textbox --name Message --value "One more thing."`, `bin/agentsctl browser press Enter --role textbox --name Message` and `bin/agentsctl browser wait --role listitem --text "One more thing." --within list:Events --timeout 30`. The new message shows in the panel without a reload. The record holds every event in order: `bin/agentsctl db "select count(*)::int as n from events e join sessions s on s.id = e.session_id join conversations c on c.id = s.conversation_id join agents a on a.id = c.agent_id where c.team_id = {team} and a.name = 'fixer' and c.kind = 'dm' and e.kind = 'user' and e.text = 'One more thing.'" --expect n=1`.
- **Hide it.** Run `bin/agentsctl browser click --role button --name "Hide session"` and `bin/agentsctl browser wait --role complementary --name "Session details" --gone`. The panel closes and the conversation stays.
- **The panel names the model after it changes.** Change fixer's model, then message it, which restarts its session on the new model. Run `bin/agentsctl browser click --role button --name "Agent setup"`, `bin/agentsctl browser fill --role textbox --name Model --value sonnet`, `bin/agentsctl browser click --role button --name Save --within form:Profile`, `bin/agentsctl browser wait --role status --text Saved`, `bin/agentsctl browser click --role button --name Message --within region:Agent`, `bin/agentsctl browser fill --role textbox --name Message --value "Which model now?"` and `bin/agentsctl browser press Enter --role textbox --name Message`. The machine is told to run the session on sonnet: `bin/agentsctl db "select c.payload->>'model' as model from commands c join sessions s on s.id = c.session_id join conversations v on v.id = s.conversation_id join agents a on a.id = s.agent_id where v.team_id = {team} and v.kind = 'dm' and a.name = 'fixer' and c.kind = 'message' order by c.created_at desc limit 1" --wait 15 --expect model=sonnet`. Session details says so too: `bin/agentsctl browser click --role button --name "Session details"` and `bin/agentsctl browser text --role complementary --name "Session details" --expect "· sonnet · mac ·"`.
- **Put fixer back on haiku.** Run `bin/agentsctl api POST "/v1/agents/$(bin/agentsctl db "select id from agents where team_id = {team} and name = 'fixer'" --value)" --body "{\"model\":\"haiku\"}"`. The files after this one expect fixer as the instance started it.
- **Session details beside a task.** Run `bin/agentsctl seed task --title "Check the session panel on a task" --agent fixer`, `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --name "Check the session panel on a task" --within list:Tasks --timeout 15`, `bin/agentsctl browser click --role button --name "Session details" --timeout 30` and `bin/agentsctl browser wait --role listitem --text "Turn ended" --within list:Events --timeout 30`. The task's session opens beside the task.
- **Running now shows a stage at work (pipelines).** Start a run whose first stage takes a while, then open it from Running now. Run `bin/agentsctl api POST "/v1/pipelines/$(bin/agentsctl db "select id from pipelines where team_id = {team} and name = 'bug-fix'" --value)/runs" --body "{\"title\":\"SLOW stage for Running now\",\"body\":\"discount(5, 'TENOFF') is -5.\",\"repoId\":\"$(bin/agentsctl db "select id from repos where team_id = {team} and remote_url like '%/shop.git'" --value)\"}"`, `bin/agentsctl browser goto /`, `bin/agentsctl browser wait --role button --text "fixer · triage" --within "list:Running now" --timeout 30`, `bin/agentsctl browser wait --role button --text "SLOW stage for Running now" --within list:Runs --timeout 15` and `bin/agentsctl browser click --role button --text "fixer · triage" --within "list:Running now"`. The stage's session opens beside its run: `bin/agentsctl browser wait --role complementary --name "Session details"` and `bin/agentsctl browser wait --role heading --name "SLOW stage for Running now"`. Then cancel the run so it leaves nothing working: `bin/agentsctl browser click --role button --name "Cancel run"` and `bin/agentsctl db "select status from runs r join tasks t on t.id = r.task_id where t.team_id = {team} and t.title = 'SLOW stage for Running now'" --wait 15 --expect status=cancelled`.
- **An agent searches the team record.** Search as fixer's DM session, the way its search_record tool does. Run `bin/agentsctl api GET "/v1/record/search?q=checkout&session=$(bin/agentsctl db "select s.id from sessions s join conversations c on c.id = s.conversation_id join agents a on a.id = s.agent_id where c.team_id = {team} and c.kind = 'dm' and a.name = 'fixer' order by s.created_at desc limit 1" --value)" --as machine --expect-text "I will take the"`. Search leaves out the asking session itself and the posts of its own conversation, so the answer holds what fixer said in the launch room, not ada's DM.
- **An agent reads a teammate's session and recent work.** Run `bin/agentsctl api GET "/v1/record/sessions/$(bin/agentsctl db "select s.id from sessions s join tasks t on t.id = s.task_id where t.team_id = {team} and t.title = 'Check the session panel on a task' limit 1" --value)?session=$(bin/agentsctl db "select s.id from sessions s join conversations c on c.id = s.conversation_id join agents a on a.id = s.agent_id where c.team_id = {team} and c.kind = 'dm' and a.name = 'fixer' order by s.created_at desc limit 1" --value)" --as machine --expect-text "Check the session panel on a task"` and `bin/agentsctl api GET "/v1/record/recent?session=$(bin/agentsctl db "select s.id from sessions s join conversations c on c.id = s.conversation_id join agents a on a.id = s.agent_id where c.team_id = {team} and c.kind = 'dm' and a.name = 'fixer' order by s.created_at desc limit 1" --value)" --as machine --expect-text "Check the session panel on a task"`. The task's session reads in full, and it is among the team's recent work.
- **The record refuses a session on another machine.** Run `bin/agentsctl api GET "/v1/record/search?q=checkout&session=00000000-0000-0000-0000-000000000000" --as machine --expect 403`. A record read must come from a session running on the calling machine.

## Gotchas

- A known bug, seen 2026-10-13. Session details names the model the session started on. `sessions.model` is written once, when the session is made, while each message tells the machine the agent's current model. So "The panel names the model after it changes" fails until that is fixed, and the step stays as the proof of the fix.
- Choosing a stage's session in Running now opens its run only once the sidebar has loaded the run. A click in the first moment after the page loads opens the run's task instead, which has no Cancel run button.
- Running now lists sessions that are starting, running or waiting on a person. The fake harness finishes a DM turn at once, so only a stage that sleeps, such as the SLOW scenario's triage, stays long enough to see. The list refreshes every 3 seconds.
- Session details shows init notices but hides the rest of the harness's notices. It labels events by kind: Message, Reply, Tool, Result, Asked, Answer, Error and Turn ended.
- The team-record tools act as one session on one machine, and see what a teammate would: the team's shared work plus that session's own conversation. Private conversations a person is not in stay out.
- The fake harness never calls the team-record tools itself. Calling the API as the machine is what the tool does, and real Claude is needed to see an agent choose to use it.
