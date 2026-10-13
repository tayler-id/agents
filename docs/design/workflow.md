# The work layer: drafts, phases, changes and pull requests

The work layer follows HumanLayer's model: tasks, sessions, versioned documents, approvals and phased workflows. Measured against their product, these parts were missing or half built. This is the design I am building to, written before the code. The tables are in `server/migrations/0007_workflow.sql` and listed in `docs/data-model.md` for review.

What happened on the live server on 2026-10-13 shaped part of it. Tayler started a task, "we need to create a readme for the repo", on `team/shop`. The agent wrote `shop/README.md` in its checkout of the repo. Nothing showed in the app, since only files in the task's `task` folder became documents. There was no diff, no way to push or open a pull request, and Tayler had to approve every Bash and Write call. That task is the acceptance test for the changes, the viewer, the diff and the pull request.

## Draft tasks

**Solves.** A person writes a task now and starts it later. The schema has always allowed a `draft` session, and nothing made one.

**Shape.** A draft is a task whose one session has the status `draft`, with no workspace and no events. The task row holds the title and the first message to the agent (`instructions`), `agent_id` names the agent, and `task_repos` holds the repos. Nothing new in the schema.

**States.**

- `draft`, made by Save draft. Editing changes the task, its repos, and the session's agent and machine.
- `draft` to `starting`, by Start. The task gets its workspace and the agent gets its first message, the same as a task started at once.
- `draft` to archived, by Discard. The task and its session get `archived_at`, so they leave every list.

Start, edit and discard lock the session row and refuse anything that is no longer a draft. Two people pressing Start at once start it once, and the second gets "this task has already started".

**Routes.**

- `POST /v1/tasks` with `draft: true` saves a draft instead of starting.
- `POST /v1/tasks/:id/draft` saves changes to a draft.
- `POST /v1/tasks/:id/start` starts it.
- `POST /v1/tasks/:id/discard` discards it.

**What each person sees.** New task has Save draft beside Start task. A draft opens as its own page with the form filled in, Start task and Discard draft, and says who wrote it. Teammates see it in the sidebar's tasks, marked draft. Anyone who can see the task can edit, start or discard it, the way anyone can answer an ask.

## Several repos in one task

**Solves.** New task picks one or more repos. The workspace already makes one clone per repo, and everything after setup now handles several.

**Shape.** One `task_repos` row per repo. The first one picked is the primary. Each repo's folder in the workspace is its name, such as `./shop`. When two repos share a name, both folders take the owner too, such as `./team-shop` and `./ops-shop`. One function names the folders, and the API, the runner and the first message all use it.

**What changes downstream.** The first message names every folder and its branch. Changes, the diff and pull requests are per repo. The runner's pipelines still start with one repo, so a pipeline's `ctx.repo` is still the primary one.

**What each person sees.** New task lists the team's repos as checkboxes. The task page groups its changes and pull requests by repo.

## Changes and the file viewer

**Solves.** Every file the agent created, changed or deleted in a repo shows on the task, and opens beside it. Before this the app showed only files in the `task` folder.

**How changes travel.** The daemon works out each repo's changes against the base branch on its own machine, scrubs them, and posts them, the way documents travel. The browser never reads paths on a machine, and the API only accepts a machine's changes for its own workspaces and the task's own repos.

- The base is the commit where the task branch left the base branch, `git merge-base HEAD origin/<base>`.
- The daemon stages the working tree into a temporary index with `git add -A`, so it sees new, changed and deleted files without touching the agent's own index. It reads statuses and blob ids with `git diff --cached --raw`, line counts with `--numstat`, and each file's unified diff with `git diff --cached -- <path>`.
- A file's hash is its old blob, its new blob and its status. The daemon only sends the content and diff of files whose hash changed since it last sent them, and a list of every changed path, so the API drops rows for files that no longer differ from the base. If the API lacks a row the daemon thinks it sent, it answers with the missing paths, and the daemon sends them again in full.
- It sends after every tool result (at most once every two seconds), at the end of every turn, after a check or a push runs in the workspace, after setup, and once for every workspace on the machine when the daemon starts. So a task from before this change, like the README task, shows its changes as soon as the new daemon runs.
- Limits. Content and diff of up to 512 KB each, and up to 300 files with content. Beyond that a file is listed with its counts and marked too large. Git's own test decides binary files, and they are listed without content.

**Shape.** `file_changes`, one row per changed file of a workspace, unique on workspace, repo and path. It holds the status (`added`, `modified` or `deleted`), the line counts, whether it is binary or too large, the content as it is now, the diff against the base, the base commit and the hash. The row is the workspace's current state, not history. Git keeps the history once the task pushes.

**Reading.** Two shapes. `file_changes?task=` is the list without contents, polled by the task page. `file_change?id=` is one row with its content and diff, read while its panel is open.

**What each person sees.** The task page has a Changes section, files grouped by repo, each with added, modified or deleted and its line counts. A run's page has the same section. Clicking a file opens a side panel beside the task with two tabs.

- File. Markdown renders. Code shows with line numbers and syntax highlighting.
- Diff. The change against the base branch, with old and new line numbers.

Files in the `task` folder open in the same panel. Their Diff tab shows the change from the previous version, worked out in the browser. Highlighting uses weight and tone, never hue. Keywords are bold, comments muted and italic, strings on a raised surface. Added lines in a diff are bold on a raised surface, removed lines are muted, and a `+` or `−` column says which is which, so it reads in greyscale. On a phone the panel takes the screen and has Close.

## Pull requests from a task

**Solves.** A person clicks Open pull request on a task. The workspace pushes the task branch of each repo, and the forge opens a pull request for each repo that has commits past its base. The pull requests then show on the task.

**Shape.** `pushes`, one row each time a person asks. It holds the push command it sent, who asked, the title and description for the pull requests, and how it ended. A partial unique index allows one push in flight per task. The pull requests themselves are link artifacts on the task, as the runner already makes them, titled with the repo, such as "Pull request #3 on team/shop".

**States.** `pushing`, then `done` or `failed` with the reason. A new push can start once the last one has ended. Pushing again after more changes updates the branch, and the open pull request picks up the new commits.

**How it runs.** The route writes the row and a `push` command in one transaction. The daemon commits anything uncommitted as the task's agent, pushes `task/<slug>` for every repo, and reports each repo's commit and how many commits it is ahead of its base. The runner's loop finishes pushes whose command has ended. It locks the row, asks the forge for each pull request through `forge.openPullRequest`, which finds an open one for the branch before making one, records the links, and marks the row done. So a retry or a second runner never opens two. The forge is called only through the existing forge interface, so the GitHub forge slots in.

**Route.** `POST /v1/tasks/:id/pull-requests`, with an optional title and description. It refuses while the agent is working, while a push is in flight, and when the workspace is not ready.

**What each person sees.** Open pull request beside Changes, with the title and description to edit if they want. While it runs, "Pushing the branch and opening the pull request". Then each pull request as a link with its repo and state, or the reason it failed and Try again.

## Writing without asking

**Solves.** Tayler had to approve every Write and every Bash call on the README task.

**The rule.** A session in a task's workspace runs Claude Code with `--permission-mode acceptEdits`. On a box it also may run commands. The server decides, from where the session runs, and sends it in the message as `permissions`. The daemon turns it into flags.

**What still asks on a Mac, and why.** I checked each of these against Claude Code 2.1.296 with a probe session before writing them down.

- Any command that runs a program, such as `node`, `npm`, `git`, `curl` or `make`. A command runs as the person on their Mac, so it can reach their other folders, their network and their credentials.
- Writes in a checkout's `.git` folder, by any tool, including a shell redirect. A hook or a config change there would run code later, when the daemon commits for a pull request or a person runs git.
- Writes in the workspace's `.claude` folder. Settings there could let the agent run commands without asking.
- Writes, reads and links that reach outside the workspace folder, such as `echo hi > ../x` or `ln -s /etc/hosts`.
- Web fetches and searches.

**What no longer asks.** Creating, editing and deleting files anywhere in the workspace, in each repo's checkout and in the `task` folder, with the file tools or with shell commands that only touch files there, such as `mkdir`, `touch`, `mv`, `rm` and `echo > file`. Reading inside the workspace never asked.

**On a box.** Commands run without asking too. A box is a container that holds only its workspaces and its own instance token. Writes to `.git`, `.claude` and outside the workspace with the file tools still ask there.

**Unchanged.** Conversations with an agent run in the agent's own folder, and ask as before. Pipeline stages keep their own `allow` lists, and gain `acceptEdits` because they run in a workspace.

## The research, plan and implement pipeline

**Solves.** HumanLayer's featured flow runs questions, research, design, structure, plan and implement, and every phase is a place to push back. Ours is a pipeline file, `pipelines/research-plan-implement.ts`, with three written phases and a person's review after each.

**Stages.**

1. `research`. The agent studies the request and the code and writes `task/research.md`: what exists, the files and lines involved, constraints, and open questions. It changes no code.
2. `research_untouched`. A check in the repo. It passes only when `git status` is clean and no commit exists that is not on the remote. The runner confirms no code changed, instead of trusting the agent.
3. `review_research`. A gate. A person reads research.md, comments on its lines, and approves it or sends it back. Sending it back returns to `research`, whose prompt then carries the person's note and every open comment on the document, with each comment's quote.
4. `plan`. The agent writes `task/plan.md`: the change, step by step, the files, the risks, and how to test it. It reports `test_command`, the command that proves the change works.
5. `plan_untouched` and `review_plan`. The same check and the same kind of gate.
6. `implement`. The agent changes the code to follow the approved plan. It may run commands.
7. `verify`. A check that runs the plan's `test_command`. Failing sends the agent back to `implement` with the output, up to three tries.
8. `open_pr`, `review_change` and `merge`. As in bug-fix. Sending the change back at `review_change` returns to `implement` with the note.

Every loop has the runner's cap of three tries, then a person decides. A gate's buttons can say what they do, so these read "Approve" and "Send back".

**Pipeline types.** Two additions, both optional for existing pipelines. `RunContext.comments` lists the open comments on the run's documents. `GateStage.labels` names a gate's buttons.

**What each person sees.** The run page shows each stage live. At a gate, the ask card asks for the review, and the run's documents are listed below it. The document opens beside the run, where the person comments on its lines, then approves or sends it back with a note. The changes the implementation made show in the run's Changes section, with their diffs, before the person approves the pull request.

**Needs.** An agent named `builder` on the team. It runs on a box.

## Comments pinned to the text

**Solves.** A comment's quote now sits where it is in the document. Before, the quote only showed above the comment.

**Shape.** `comments.anchor` already holds `{ quote }`. It gains `occurrence`, which of the quote's matches in that version the comment means, counted from zero. A quote typed by hand has none, and means the first match.

**How.** The document renders, then the app finds the quote's match in the rendered text, with runs of spaces treated as one, and marks it with the browser's highlight API. It never rewrites the rendered page. Clicking a comment's quote shows its version, scrolls the document to the quote and marks it darker. Clicking marked text in the document scrolls to its comment. Use selection fills the quote and its match from text the person selected in the document. A quote that no longer matches says so on the comment.

## The command palette

**Solves.** Going anywhere by keyboard. Cmd+K on a Mac, Ctrl+K elsewhere, opens a palette that finds agents, conversations, tasks, runs, pipelines and documents by typing, and holds the actions New task, New room and New agent.

**Keys.**

- Cmd+K or Ctrl+K opens and closes it, from anywhere, fields included. On a Mac, Ctrl+K stays the field's own "delete to the end of the line".
- In the palette, Up and Down move, Enter opens, Escape closes and puts focus back where it was.
- `c` starts a new task and `r` a new room. These single keys only work when focus is not in a field, no modifier is held, and no text is being composed with an input method. They can be turned off in the palette, as WCAG 2.1.4 asks of single-key shortcuts.

**Shape.** No tables. One new shape, `documents`, lists the documents of every task the person may see, without their contents.

**What each person sees.** A dialog over the page, results grouped by kind, the current one on a brighter surface in heavier type, and each action with its key.

## Data shape

Migration `0007_workflow.sql`:

- `file_changes`, new, as above.
- `pushes`, new, as above.

Used for the first time, with no change to the schema: the `draft` session status, `comments.anchor.occurrence`, a push command's `base` per repo and its result's `ahead`, and `permissions` in a message command's payload.

## How it is verified

- `test/step14.ts`, against the API, daemon, forge and runner with the stand-in for Claude. The research, plan and implement pipeline runs end to end against a test repo, with a send-back that carries a note and a pinned comment, and a research stage that changes code is caught by its check. It also covers drafts, a task with two repos, changes with a secret scrubbed and a file reverted, pull requests per repo, the permissions each kind of session starts with, and the documents shape.
- `test/step14b.ts`, the README acceptance check in Chromium, Firefox and WebKit, at desktop and phone width. A task asks for a README in a test repo. The person sees README.md in Changes, opens it rendered, sees its diff, clicks Open pull request, and sees the pull request on the task.
- `test/step14c.ts`, the other views in the three browsers at both widths: drafts, the palette by keyboard alone, pinned comments, and a run of the new pipeline reviewed from the run page.

Each was seen failing on main's code before it was trusted.

## Decisions to revisit

- **Anyone who can see a draft can start it.** That matches asks, which anyone on the team can answer. A draft could instead belong to its writer until they share it.
- **Changes are the workspace's current state.** Git keeps the history once the branch is pushed. Earlier states of an unpushed file are not kept.
- **Pull request state is what we recorded.** A pull request merged or closed on the forge by hand still shows open here, until a forge webhook for pull requests updates it. That belongs with the GitHub forge.
- **The pipeline needs an agent named `builder`.** I chose a new name because the job differs from fixing bugs.
- **Single-key shortcuts are on by default.** They can be turned off in the palette.
