# Tasks

A person asks an agent for a piece of work outside any pipeline. The task gets a workspace on the agent's machine, with a clone of a repo when one is picked, and a session the person talks to from the task's page. A post in a DM can become a task, which reports back to that DM after each turn.

```json
{
  "id": "tasks",
  "name": "Tasks",
  "paths": [
    "app/src/Work.tsx",
    "server/tasks.ts",
    "daemon/workspace.ts"
  ],
  "checks": [
    "test/step10.ts",
    "test/step10b.ts"
  ]
}
```

## Sub-features

- `task-new`: New task from the sidebar: what needs doing, details, the agent, and a repo or none.
- `task-page`: the task's page shows the request and the agent's replies as they arrive, and what the task made.
- `task-more`: tell the agent more from the task's page.
- `task-from-post`: Make it a task under a DM post; the DM gets the task's report after each turn, and the post links to its task.
- `task-repo`: a task with a repo gets a clone on a branch of its own.
- `task-interrupt`: Interrupt stops the agent mid-turn.

## How to get to it (user POV)

- Choose New task in the sidebar, fill in the form, and choose Start task.
- Under one of your posts in a DM, choose Make it a task. Later, Open its task.
- Choose a task in the sidebar's Tasks list.
- On a task's page, write in the Message box (Tell the agent more) and choose Send, or choose Interrupt while the agent works.

## Driving it with agentsctl

Preconditions:

- An instance from `bin/agentsctl up`, passing `bin/agentsctl doctor`, on the fake Claude harness. Its fixer writes `task/notes.md` when asked to write the release notes.

- **Start a task from the sidebar.** Run `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --name "New task"`, `bin/agentsctl browser wait --role form --name "New task"`, `bin/agentsctl visual shot task-new --ready-role form --ready-name "New task"`, `bin/agentsctl browser fill --role textbox --name "What needs doing?" --value "Write the release notes"`, `bin/agentsctl browser fill --role textbox --name Details --value "For version 1.4."`, `bin/agentsctl browser select --role combobox --name Agent --option fixer`, `bin/agentsctl browser click --role button --name "Start task"` and `bin/agentsctl browser wait --role heading --name "Write the release notes"`. The task's page opens, then fixer's reply and the document it wrote arrive: `bin/agentsctl browser wait --role listitem --text "Wrote task/notes.md." --within list:Messages --timeout 60` and `bin/agentsctl browser wait --role button --name notes.md --within "list:Made by this task" --timeout 30`. The task came from the app and lists in the sidebar: `bin/agentsctl db "select source from tasks where team_id = {team} and title = 'Write the release notes' order by created_at desc limit 1" --expect source=app` and `bin/agentsctl browser wait --role button --name "Write the release notes" --within list:Tasks --timeout 15`. Capture it with `bin/agentsctl visual shot task --ready-role button --ready-name notes.md`.
- **Tell the agent more.** Run `bin/agentsctl browser fill --role textbox --name Message --value "Add a line about speed."`, `bin/agentsctl browser click --role button --name Send`, `bin/agentsctl browser wait --role listitem --text "Add a line about speed." --within list:Messages` and `bin/agentsctl browser wait --role listitem --text "fake reply" --within list:Messages --timeout 30`. The message and fixer's answer show on the task. Both are in the task's session: `bin/agentsctl db "select count(*)::int as n from events e join sessions s on s.id = e.session_id join tasks t on t.id = s.task_id where t.team_id = {team} and t.title = 'Write the release notes' and e.kind = 'user' and e.text = 'Add a line about speed.'" --expect n=1`.
- **Check the task page.** Run `bin/agentsctl browser a11y`, `bin/agentsctl browser console`, `bin/agentsctl browser goto "#/t/$(bin/agentsctl db "select id from tasks where team_id = {team} and title = 'Write the release notes' order by created_at desc limit 1" --value)" --width phone` and `bin/agentsctl browser overflow --width phone`. No accessibility violation, no console error, and no sideways scrolling at phone width.
- **Make a DM post a task.** Run `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --name fixer --within list:Agents`, `bin/agentsctl browser fill --role textbox --name Message --value "Write the release notes for 1.5"`, `bin/agentsctl browser press Enter --role textbox --name Message`, `bin/agentsctl browser wait --role listitem --text "fake reply" --within list:Messages --timeout 30`, `bin/agentsctl browser click --role button --name "Make it a task" --within listitem --within-text "Write the release notes for 1.5"` and `bin/agentsctl browser wait --role heading --name "Write the release notes for 1.5"`. The task opens and fixer works on it: `bin/agentsctl browser wait --role listitem --text "Wrote task/notes.md." --within list:Messages --timeout 60`. The task came from the post: `bin/agentsctl db "select source from tasks where team_id = {team} and title = 'Write the release notes for 1.5'" --expect source=message`.
- **The task reports back to the DM.** Run `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --name fixer --within list:Agents`, `bin/agentsctl browser wait --role listitem --text "Task \"Write the release notes for 1.5\": Wrote task/notes.md." --within list:Messages --timeout 30` and `bin/agentsctl browser click --role button --name "Open its task" --within listitem --within-text "Write the release notes for 1.5"`. The DM shows the task's report, the post now links to its task, and the link opens it: `bin/agentsctl browser wait --role heading --name "Write the release notes for 1.5"`.
- **A task on a repo gets a clone (pipelines).** Run `bin/agentsctl browser click --role button --name "New task"`, `bin/agentsctl browser fill --role textbox --name "What needs doing?" --value "Read the checkout code"`, `bin/agentsctl browser select --role combobox --name Repo --option "$(bin/agentsctl db "select name from teams where id = {team}" --value)/shop"`, `bin/agentsctl browser click --role button --name "Start task"` and `bin/agentsctl browser wait --role heading --name "Read the checkout code"`. The machine cloned shop on a branch of the task's own: `bin/agentsctl db "select w.branch like 'task/read-the-checkout-code-%' as own, w.base_commit is not null as cloned from worktrees w join workspaces ws on ws.id = w.workspace_id join tasks t on t.id = ws.task_id where t.team_id = {team} and t.title = 'Read the checkout code'" --wait 60 --expect own=true --expect cloned=true`.
- **Interrupt a task's agent (real Claude).** Run `bin/agentsctl browser click --role button --name "New task"`, `bin/agentsctl browser fill --role textbox --name "What needs doing?" --value "Write a 2000-word story about a lighthouse keeper. Do not use any tools."`, `bin/agentsctl browser click --role button --name "Start task"`, `bin/agentsctl browser click --role button --name Interrupt --timeout 120` and `bin/agentsctl browser wait --role paragraph --text "· idle" --within region:Task --timeout 60`. The agent stops within seconds and the task shows idle. Its last turn ended aborted: `bin/agentsctl db "select e.body->>'terminal_reason' as reason from events e join sessions s on s.id = e.session_id join tasks t on t.id = s.task_id where t.team_id = {team} and t.title like 'Write a 2000-word story%' and e.kind = 'usage' order by e.seq desc limit 1" --wait 60 --expect reason=aborted_streaming`.

## Gotchas

- The task page shows the session's request events as "Request". The first one is the task's own prompt, which adds a paragraph about the workspace.
- A new task's page says "Starting…" until its session arrives. Wait on the heading and then the reply, not on Send being enabled.
- Tasks started by pipelines are runs. They list under Runs, not Tasks.
- Make it a task copies the post's first line as the title. The post's button turns into Open its task once the task exists.
- The fake harness writes files the scenario names, under the task's workspace on the instance's machine. Only files in `task/` become documents.
- A repo task needs the forge, so it needs `bin/agentsctl up --pipelines`. The Repo list shows `<team>/shop` and `<team>/pipelines`, named after the instance's forge org.
