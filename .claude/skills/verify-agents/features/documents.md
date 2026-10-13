# Documents and comments

Files an agent writes in its task's `task` folder become documents the team reads beside the task or run, rendered as markdown, with every version kept. A person comments on a version, quoting the part they mean. A comment sent to the agent reaches the session that wrote the document, which revises it into a new version.

```json
{
  "id": "documents",
  "name": "Documents and comments",
  "paths": [
    "app/src/Document.tsx",
    "server/tasks.ts",
    "daemon/agentsd.ts"
  ],
  "checks": [
    "test/step10.ts",
    "test/step10b.ts"
  ]
}
```

## Sub-features

- `doc-list`: a task's or run's documents, each with its current version, under Made by this task (or run).
- `doc-open`: a document opens beside its task or run, rendered.
- `doc-versions`: each change the agent makes is a new version, and any version can be read.
- `doc-comment`: comment on a version, with an optional quote.
- `doc-send`: a comment sent to the agent makes it revise the document.
- `doc-keep`: a comment not sent stays with the document only.
- `doc-resolve`: resolve a comment.

## How to get to it (user POV)

- On a task's page, choose a document under Made by this task.
- On a run's page, choose a document under Made by this run (pipelines.md drives a run's plan).
- In the document beside the page, pick a version, write a comment with an optional quote, keep Send it to the agent to revise ticked or untick it, and choose Comment. Choose Resolve under a comment.

## Driving it with agentsctl

Preconditions:

- An instance from `bin/agentsctl up`, passing `bin/agentsctl doctor`, on the fake Claude harness. Its fixer writes `task/notes.md` when asked to write the release notes, and revises it when a comment on it arrives.

- **A task writes a document.** Start a task the quick way and open it. Run `bin/agentsctl seed task --title "Write the release notes for the docs check" --agent fixer`, `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --name "Write the release notes for the docs check" --within list:Tasks --timeout 15` and `bin/agentsctl browser wait --role listitem --text "version 1" --within "list:Made by this task" --timeout 60`. notes.md is listed at version 1.
- **Open it beside the task.** Run `bin/agentsctl browser click --role button --name notes.md --within "list:Made by this task"`, `bin/agentsctl browser wait --role complementary --name Document` and `bin/agentsctl browser wait --role heading --name "Release notes" --within complementary:Document`. The document opens beside the task, rendered: its heading is a heading and its lines a list.
- **Comment with a quote, sent to the agent.** Run `bin/agentsctl browser fill --role textbox --name "Quote (optional)" --value "TENOFF stops at zero."`, `bin/agentsctl browser fill --role textbox --name "Comment on version 1" --value "Say it never goes below zero."`, `bin/agentsctl browser click --role button --name Comment --within "form:Add a comment"` and `bin/agentsctl browser wait --role listitem --text "sent to the agent" --within region:Comments`. The comment shows with its quote and says it went to the agent. It went to the session that wrote the document: `bin/agentsctl db "select (c.sent_to_session = a.made_by_session) as same from comments c join artifacts a on a.id = c.artifact_id join tasks t on t.id = a.task_id where t.team_id = {team} and t.title = 'Write the release notes for the docs check' order by c.created_at desc limit 1" --expect same=true`.
- **The agent revises it into version 2.** Run `bin/agentsctl browser wait --role combobox --name Version --within complementary:Document --timeout 60` and `bin/agentsctl browser wait --role listitem --text "TENOFF never goes below zero." --within complementary:Document --timeout 15`. A version picker appears and the document shows the revision. The record has two versions: `bin/agentsctl db "select a.current_version from artifacts a join tasks t on t.id = a.task_id where t.team_id = {team} and t.title = 'Write the release notes for the docs check'" --expect current_version=2`. Capture it with `bin/agentsctl visual shot document --ready-role combobox --ready-name Version`.
- **Read the first version again.** Run `bin/agentsctl browser select --role combobox --name Version --value 1` and `bin/agentsctl browser wait --role listitem --text "TENOFF stops at zero." --within complementary:Document`. Version 1 shows as it was, and the comment form now comments on version 1.
- **Resolve a comment.** Run `bin/agentsctl browser click --role button --name Resolve --within listitem --within-text "Say it never goes below zero."` and `bin/agentsctl browser wait --role listitem --text "resolved" --within region:Comments`. The comment says resolved: `bin/agentsctl db "select c.status from comments c join artifacts a on a.id = c.artifact_id join tasks t on t.id = a.task_id where t.team_id = {team} and t.title = 'Write the release notes for the docs check' order by c.created_at limit 1" --expect status=resolved`.
- **A comment kept to yourself.** Run `bin/agentsctl browser uncheck --role checkbox --name "Send it to the agent to revise"`, `bin/agentsctl browser fill --role textbox --name "Comment on version 1" --value "Looks fine to me."`, `bin/agentsctl browser click --role button --name Comment --within "form:Add a comment"` and `bin/agentsctl browser wait --role listitem --text "Looks fine to me." --within region:Comments`. The comment shows, was sent to no session, and the document stays at version 2: `bin/agentsctl db "select c.sent_to_session is null as kept, a.current_version from comments c join artifacts a on a.id = c.artifact_id join tasks t on t.id = a.task_id where t.team_id = {team} and t.title = 'Write the release notes for the docs check' order by c.created_at desc limit 1" --expect kept=true --expect current_version=2`.
- **Check the document view.** Run `bin/agentsctl browser a11y` and `bin/agentsctl browser console`. No accessibility violation and no console error.

## Gotchas

- The version picker appears only once there are two versions, and it names each by number and time. Pick one with `--value <number>`, since the time changes every run.
- The comment form follows the version on screen, so its box is named "Comment on version N" for whichever N is picked.
- An agent revises only when the comment is sent, and only the session that wrote the document receives it. A document whose session is gone takes comments that cannot be sent: the tick box is not shown.
- A document is one file in `task/`. Files elsewhere in the workspace, such as the repo's clone, never become documents.
- The record keeps a version only when the content changed, so an agent that rewrites a file unchanged adds no version.
