# The work layer: drafts, order of work, changes and pull requests

The work layer is tasks, sessions, versioned documents, approvals and workflows in phases. This doc covers the parts I added on the branch `worktree-agent-a2fc50836aafd8b34`: draft tasks, the order of work, tasks over several repos, the Changes list and file viewer, pull requests from a task, writing without asking, the research, plan and implement pipeline, comments pinned to their text, and the command palette. I wrote the design before the code and rewrote this doc after building, so it describes what the code does. "Not done" at the end lists what is missing or unchecked.

The tables are in `server/migrations/0007_workflow.sql`, described in `docs/data-model.md`. Every row shape and request body is a zod schema in `shared/work.ts`, which the server, the daemon and the app import.

What happened on the live server on 2026-10-13 shaped part of it. Tayler started a task, "we need to create a readme for the repo", on `team/shop`. The agent wrote `shop/README.md` in its checkout of the repo. Nothing showed in the app, since only files in the task's `task` folder became documents. There was no diff, no way to push or open a pull request, and Tayler had to approve every Bash and Write call. That task is the scenario of the acceptance check, `test/step14b.ts`.

## Draft tasks

**Solves.** A person writes a task now and starts it later. The schema has always allowed a `draft` session, and nothing made one.

**Shape.** A draft is a queued task whose one session has the status `draft`, with no workspace and no events. The task row holds the title and the first message to the agent (`instructions`), `agent_id` names the agent, and `task_repos` holds the repos. The draft needs no new table or column.

**Actions.**

- Save draft makes the task and its draft session, on the agent's home machine.
- Edit changes the task, its repos, and the session's agent and machine. It carries the draft as the person's form loaded it, and the API refuses it with "this draft changed since you opened it" when a teammate saved since.
- Start saves the form first only if the person changed it, so an untouched form starts the draft as it stands, with any teammate's edit. Then the task gets its workspace and the agent its first message, the same as a task started at once.
- Discard sets `archived_at` on the task and its session, so they leave every list.

Edit, start and discard lock the task row and check its state against the lifecycle table in `shared/work.ts`. Starting a draft a second time gets "this task has already started". The lock is what keeps two people pressing Start at the same moment from starting it twice, and no check presses them at the same moment.

**Routes.**

- `POST /v1/tasks` with `draft: true` saves a draft instead of starting.
- `POST /v1/tasks/:id/edit` saves changes to a draft.
- `POST /v1/tasks/:id/start` starts it.
- `POST /v1/tasks/:id/discard` discards it.

**What each person sees.** New task has Save draft beside Start task. A draft opens as its own page with the form filled in, Start task, Save draft and Discard draft, and says who wrote it. Teammates see it in the sidebar's tasks, marked draft. Anyone who can see the task can edit, start or discard it, the way anyone can answer an ask.

## Order of work

**Solves.** Tayler approved this addition. A task can wait on other tasks, a person can pause one on purpose and say why, and anyone, or any agent, can ask what is ready to start next. The framework agent asked for the edges, for stacked pull requests, and the holds, for "waiting on Tayler", so the shapes live in `shared/work.ts` where its code can import them.

**A task's state.** The ready query needs to know which tasks wait to start. A task's state is derived from what is already stored, plus one new column.

- `queued`, a draft, written and not started. The queue is the drafts.
- `active`, started and not done.
- `done`, once someone marks it done. `tasks.done_at` holds when.
- `discarded`, a draft someone threw away, archived.

One transition table in `shared/work.ts` holds every action and the states it may start from. The draft actions above are rows in it.

| Action | From | To |
|---|---|---|
| edit | queued | queued |
| start | queued | active |
| discard | queued | discarded |
| done | queued, active or done | done, and nothing changes if it was done |
| reopen | queued, active or done | queued or active, as before it was done, and nothing changes if it wasn't done |
| prioritize, block, hold | queued or active | unchanged |
| unblock, unhold | queued, active or done | unchanged |

**Blocking edges.** `task_blocks` holds one row per edge: the blocked task, the task blocking it, an optional one-line reason, who added it and when. A task is blocked while any task blocking it is neither done nor discarded.

- Adding an edge needs both tasks to be the team's and visible to the person. It refuses an edge from a task to itself, and one that would close a cycle. A recursive query finds the cycle under a per-team advisory lock, which keeps two people from closing one between them. No check adds two edges at the same moment.
- Discarding a task that still blocks a queued or active task is refused, and the refusal names what it blocks.

**Holds.** `task_holds` holds at most one hold per task: its kind, a one-line reason, an optional until date, who held it and when.

- The kinds are `decision`, for a person's decision, and `external`, `load`, `parked` and `future`.
- A hold with an until date lapses on that date, by the database's date, and the task can be ready again. A lapsed hold stays recorded until someone lifts it or holds the task again.
- A hold can pause queued or active work. A done or discarded task takes none.

**Priority.** `tasks.priority`, 0 the most urgent and 4 the least, 2 by default.

**The ready query.** Queued tasks that nothing blocks and no current hold pauses, ordered by priority, then by age, oldest first, then by id. Beside it, the held tasks with their kind, reason and until date. One server function, `readyAnswer` in `server/order.ts`, answers both, for the app at `GET /v1/tasks/ready` and for agents at `GET /v1/record/ready` through the team-record tool `ready_tasks`.

**Commands.** Each answers `{ already }`, true when there was nothing to change, so running one twice is safe and says so.

- `POST /v1/tasks/:id/blockers` adds an edge, or changes its reason. `POST /v1/tasks/:id/blockers/:blocker/remove` removes it.
- `POST /v1/tasks/:id/hold` holds the task, or changes its hold. `POST /v1/tasks/:id/unhold` lifts it.
- `POST /v1/tasks/:id/priority` sets the priority.
- `POST /v1/tasks/:id/done` and `POST /v1/tasks/:id/reopen`.

An action from a state it can't start from, such as holding a done task, is a 409 that names the state.

**What each person sees.** The sidebar lists Ready, the next tasks to start in order, and Held, each with its kind and reason. Both read the ready query every 4 seconds. A task's page and a draft's page show its priority, the tasks it waits on and why, the tasks waiting on it, its hold or a form to hold it, and Mark done or Reopen. Each command says "Saved." or "Nothing to change."

## Several repos in one task

**Solves.** New task picks one or more repos. The workspace already made one clone per repo, and everything after setup now handles several.

**Shape.** One `task_repos` row per repo. The first one picked is the primary. Each repo's folder in the workspace is its name, such as `./shop`. When two repos share a name, both folders take the owner too, such as `./team-shop` and `./ops-shop`. `withFolders` in `server/checkout.ts` names the folders, and the API, the runner and the first message all use it.

**What changes downstream.** The first message names every folder and its branch. A daemon can claim a workspace's first message before its setup, so a message for a workspace the machine has not set up waits, but only while the server says the workspace is still being set up: not yet ready, with its setup queued, running, or not yet ended. Otherwise the message fails with "workspace … is not set up on this machine", as it did before this branch, and an interrupt behind it is not held up. Changes and pull requests are per repo. The runner's pipelines still start with one repo, so a pipeline's `ctx.repo` is the primary one.

**What each person sees.** New task and a draft list the team's repos as checkboxes. The task page groups its changes by repo, and each pull request's title names its repo.

## Changes and the file viewer

**Solves.** Every file the agent created, changed or deleted in a repo shows on the task, and opens beside it. Before this the app showed only files in the `task` folder.

**How changes travel.** The daemon works out each repo's changes against the base on its own machine (`daemon/changes.ts`), scrubs them, and posts them to `POST /v1/workspaces/:id/changes`. The browser never reads paths on a machine, and the API only takes a machine's changes for its own workspaces and the task's own repos.

- The base is where the task branch left the branch it tracks, or the remote's default branch: `git merge-base HEAD <that branch>`.
- The daemon copies the agent's index and stages the working tree into the copy with `git add --all`, so it sees new, changed and deleted files without touching the agent's own index. It reads statuses and blob ids with `git diff --cached --raw`, line counts with `--numstat`, and each file's unified diff with `git diff --cached -- <path>`. Content comes from git's blobs, so a symlink is never followed out of the repo.
- Only repos cloned through the API's git proxy count. A repo the agent cloned itself is not one of the task's.
- A file's hash is its old blob, its new blob and its status. The daemon sends content and diff only for files whose hash changed since it last sent them, and the facts of every changed file, so the API drops rows for files that no longer differ. If the API lacks content for a file, its answer names the file, and the daemon sends it again.
- It sends after a tool result or a turn's end (at most once every 2 seconds), after a setup, check or push in the workspace, and for every workspace on the machine when the daemon starts. Two scans run at once, and the rest wait their turn. That last one is meant to show the changes of a task from before this change, like the README task, once the new daemon runs. No check restarts a daemon, and the live server has not been tried.

**Limits.** `CHANGE_LIMITS` in `shared/work.ts`:

- A file whose content or diff is over 512 K characters is listed with its line counts and marked too large.
- One post carries at most 4,000,000 characters of content and diffs. Files past that go as facts, and the API asks for them in the next post.
- Before it stages anything, the daemon counts the repo's changed and new files, and stops counting past 20,000. A repo with more is sent as too many, its rows go, and the app says "More than 20,000 files changed, too many to list."
- A file git counts no lines in, which is how `--numstat` marks a binary file, is listed without content or diff. So is a submodule, and so is a file with a NUL byte, which git misses after its first 8,000 bytes and Postgres cannot store as text.
- A repo git fails to read, such as one with a file it cannot open, is sent as unreadable with git's own error lines. Its last list stays, the app shows the error above it, and the other repos are read as usual.

**Shape.** `file_changes`, one row per changed file of a workspace, unique on workspace, repo and path. It holds the status (`added`, `modified` or `deleted`), the line counts, `preview` (`text`, `binary` or `too_large`), the content as it is now, the diff against the base, the base commit and the hash. Checks in the table tie content and diff to `preview`. The row is the workspace's current state, not history. Git keeps the history once the task pushes. `unlisted_changes` holds one row per repo whose changes are not listed, with its kind, `too_many` or `unreadable`, and for an unreadable one the scrubbed reason.

**Reading.** Three shapes. `file_changes?task=` is the list without contents, which the task page reads. `file_change?id=` is one row with its content and diff, read while its panel is open. `unlisted_changes?task=` names the repos whose changes are not listed.

**What each person sees.** The task page has a Changes section, files grouped by repo, each with added, modified or deleted and its line counts. A run's page has the same section. Clicking a file opens a side panel beside the task with two tabs.

- File. Markdown renders. Code shows with line numbers and syntax highlighting.
- Diff. The change against the base, with old and new line numbers.

Documents in the `task` folder open in the same kind of panel. Their Diff tab shows the change from the previous version, which the server works out at `GET /v1/artifacts/:id/versions/:n/diff`. Highlighting uses weight and tone, never hue. Keywords are bold, comments muted and italic, strings on a raised surface. Added lines in a diff are bold on a raised surface, removed lines are muted, and a `+` or `−` column says which is which, so it reads in greyscale. On a phone the panel takes the screen and has Close.

## Pull requests from a task

**Solves.** A person clicks Open pull request on a task. The workspace pushes the task branch of each repo, and the forge opens a pull request for each repo that has commits past its base. The pull requests then show on the task.

**Shape.** `pushes`, one row each time a person asks. It holds the push command it sent, who asked, the title and description for the pull requests, and how it ended. A partial unique index allows one push in flight per task. The pull requests are link artifacts on the task, as the runner already makes them, titled with the repo, such as "Pull request #3 on team/shop".

**States.** `pushing`, then `done`, or `failed` with the reason. A new push can start once the last one has ended. A push still running after 15 minutes, because its machine went away, is marked failed when someone asks again, so it never blocks the next one.

**How it runs.** The route writes the row and a `push` command in one transaction. The daemon commits anything uncommitted as the task's agent, pushes `task/<slug>` for every task repo, and reports each repo's commit and how many commits it is ahead of its base. It pushes with `--force-with-lease` against the commit this workspace last pushed, from the last finished push command, so the agent may rewrite its branch but a commit someone added on the forge since is never pushed over. The first push expects the branch not to exist. The title and description are scrubbed before they reach the record, the commit or the forge, and so is a failed push's reason. The runner's loop finishes pushes whose command has ended (`server/pulls.ts`). It locks the row, asks the forge for each pull request through `forge.openPullRequest`, which finds an open one for the branch before making one, records the links, and marks the row done. Asking again opens no second pull request, which step14 checks. The row lock is what keeps two runners from opening two, and no check runs two. The forge is called only through the forge interface in `server/forge.ts`.

**Route.** `POST /v1/tasks/:id/pull-requests`, with an optional title and description. It refuses while the agent is working, while a push is in flight, when the workspace is not ready, and when the task has no repo.

**What each person sees.** Open pull request below Changes, with the title and description to edit if they want. The description starts empty. While it runs, "Pushing the branch and opening the pull request". Then each pull request as a link with its state, or the reason it failed. The button reads Update pull request once one is open, and then the form drops the title and description, which an open pull request keeps. It reads Try again after a failure. The pull requests stay on the task once nothing differs from the base, and the form only shows while something does.

## Writing without asking

**Solves.** Tayler had to approve every Write and every Bash call on the README task.

**The rule.** A session in a task's workspace runs Claude Code with `--permission-mode acceptEdits`. The server decides from whether the session has a workspace (`server/permissions.ts`) and sends it in the message command as `permissions`. The daemon turns it into flags.

**What still asks on a Mac, and why.** I ran a probe session against Claude Code 2.1.296 on 2026-10-13, with the same flags, and saw each of these ask:

- Any command that runs a program, such as `node`, `git` or `curl`. A command runs as the person on their Mac, so it can reach their other folders, their network and their credentials.
- Writes in a checkout's `.git` folder, by any tool, including a shell redirect. A hook or a config change there would run code later, when the daemon commits for a pull request or a person runs git.
- Writes in the workspace's `.claude` folder. Settings there could let the agent run commands without asking.
- Writes, reads and links that reach outside the workspace folder, such as `echo hi > ../x`, `cat /etc/hosts` or `ln -s /etc/hosts`.

The probe didn't try web fetches or searches, so this doc says nothing about them.

**What no longer asks.** Creating, editing and deleting files anywhere in the workspace, in each repo's checkout and in the `task` folder, with the file tools or with shell commands that only touch files there. The probe ran `mkdir`, `touch`, `mv`, `rm -f` and `echo x > out.txt` without asking. Reading inside the workspace never asked.

**On a box.** The same rule, so commands ask there too. A box holds its workspaces, its machine token and the Claude token. An earlier version of this branch let a box's sessions run commands without asking, which took away a person's approval of each command. That waits on Tayler's decision, and until then a box asks as a Mac does.

**Unchanged.** Conversations with an agent run in the agent's own folder, and ask as before. Pipeline stages keep their own `allow` lists, and get the same workspace permissions as a task's session.

## The research, plan and implement pipeline

**Solves.** A hard change goes better when the agent researches and plans before it writes any code, and a person can push back after each phase. `pipelines/research-plan-implement.ts` has three written phases and a person's review after each.

**Stages.**

1. `research`. The agent studies the request and the code and writes `task/research.md`: what exists, the files and lines involved, constraints, and open questions. It changes no code.
2. `research_untouched`. A check in the repo. It passes only when `git status` is clean and no commit exists that isn't on the remote. The runner confirms no code changed, instead of trusting the agent.
3. `review_research`. A gate. A person reads research.md, comments on its lines, and approves it or sends it back. Sending it back returns to `research`, whose prompt then carries the person's note and every open comment on the document, with each comment's quote.
4. `plan`. The agent writes `task/plan.md`: the change, step by step, the files, the risks, and how to test it. It reports `test_command`, the command that proves the change works.
5. `plan_untouched` and `review_plan`. The same check and the same kind of gate.
6. `implement`. The agent changes the code to follow the approved plan. It may run commands.
7. `verify`. A check that runs the plan's `test_command`. Failing sends the agent back to `implement` with the output.
8. `open_pr`, `review_change` and `merge`. As in bug-fix. Sending the change back at `review_change` returns to `implement` with the note.

Every loop has the runner's cap of three tries, then a person decides. The gates' buttons say what they do: Approve research, Approve plan and Merge, each beside Send back.

**Pipeline types.** Three additions to `shared/pipeline.ts`, all optional for existing pipelines. `RunContext.comments` lists the open comments on the run's documents. `GateStage.labels` names a gate's buttons. `Pipeline` takes the names of its stages as a type parameter, so the compiler checks that every stage a pipeline starts at or leads to exists.

**What each person sees.** The run page shows each stage live. At a gate, the ask card shows the gate's own button labels, and the run's documents are listed under "Made by this run". A document opens beside the run, where the person comments on its lines, then approves or sends it back with a note. The run's Changes section shows what the implementation changed, with diffs, before the person approves the merge.

**Needs.** An agent named `builder` on the team. The pipeline runs it on a box.

## Comments pinned to the text

**Solves.** A comment's quote now sits where it is in the document. Before, the quote only showed above the comment.

**Shape.** `comments.anchor` already held `{ quote }`. It gains `occurrence`, which of the quote's matches in that version the comment means, counted from zero. A quote typed by hand has none and means the first match. The API refuses an occurrence without a quote. It doesn't check that the quote is in the version.

**How.** The document renders, then the app finds the quote's match in the rendered text (`app/src/quotes.ts`), with runs of spaces treated as one, and marks it with the browser's highlight API. It never rewrites the rendered page. Clicking a comment's quote shows its version, scrolls the document to the quote and marks it darker. Clicking marked text in the document marks its comment as the current one and scrolls to it. Use selection fills the quote and its match from text the person selected in the document. Clicking a quote that isn't in the version shown says so above the comments.

## The command palette

**Solves.** Going anywhere by keyboard. Cmd+K on a Mac, Ctrl+K elsewhere, opens a palette that finds agents, conversations, tasks, runs, pipelines and documents by typing, and holds the actions New task, New room and New agent.

**Keys.**

- Cmd+K or Ctrl+K opens and closes it, from anywhere, fields included. On a Mac, Ctrl+K stays the field's own "delete to the end of the line".
- In the palette, Up and Down move, Enter opens, Escape closes and puts focus back where it was.
- `c` starts a new task and `r` a new room. These single keys only work when focus is not in a field, no modifier is held, no dialog is open, and no text is being composed with an input method. They can be turned off in the palette, as WCAG 2.1.4 asks of single-key shortcuts, and the browser remembers the choice.

**Shape.** No tables. One new shape, `documents`, lists the documents of every task the person may see, without their contents.

**What each person sees.** A dialog over the page, results grouped by kind, the current one on a brighter surface in heavier type, and each action with its key. The sidebar's Go to button opens it too, which is how a phone reaches it.

## Data shape

Migration `0007_workflow.sql`:

- `file_changes` and `unlisted_changes`, new, as above.
- `pushes`, new, as above.
- `task_blocks` and `task_holds`, new, as above.
- `tasks.priority` and `tasks.done_at`, new columns.

Used for the first time, with no change to the schema: the `draft` session status, `comments.anchor.occurrence`, a push command's `base` per repo and its result's `ahead`, and `permissions` in a message command's payload.

## How it is verified

Run each with `node --env-file=.env --env-file=.env.test test/<file>`.

- `test/step14.ts`, ports 7962 to 7964, against the API, daemon, forge and runner, with the stand-in for Claude in `test/fake-claude.ts`. It covers drafts, a task with two repos and twin folder names, a message claimed before its workspace's setup, changes (scrubbed on the machine, modified, deleted, binary, taken back out, not resent when unchanged, refused from another team's machine), pull requests per repo, the order of work and the agents' `ready_tasks` tool, the flags each kind of session starts with, the research, plan and implement pipeline end to end against a test repo, the version diff, and the documents shape.
- `test/step14b.ts`, ports 7965 to 7967, the README scenario in Chromium, Firefox and WebKit, at desktop and phone width, with an accessibility scan. A task asks for a README in a test repo. The person sees README.md in Changes, opens it rendered, sees its diff, clicks Open pull request, and sees the pull request on the task.
- `test/step14c.ts`, ports 7973 to 7975, the other views in the three browsers at both widths: a draft saved, edited by a teammate and started, the order of work, the palette by keyboard alone, pinned comments, a pull request that stays once nothing differs, and a run's Changes and labeled gate.

Nearly every check was seen failing with the thing it guards broken, then passing after a byte-for-byte restore. The commit messages that add step14 and step14b list their breaks, and `docs/build-log.md` describes step14c's and the later step14 breaks, and names the 16 step14 checks never broken.

## Not done

- **The pipeline has not run for real.** step14 runs it with the stand-in for Claude and on this Mac. It needs an agent named `builder` on a box, boxes need a Claude token, and Tayler publishes it.
- **The probe of what still asks** used Claude Code 2.1.296 on this Mac. No box has run a session with real Claude. The checks only see the flags the daemon passes, so a new Claude Code version that changes what `acceptEdits` covers would pass them.
- **A pull request's state** is what we recorded when it opened. One merged or closed on the forge by hand still shows open here. That needs the forge to report back, which belongs with the GitHub forge.
- **Only the Gitea forge was exercised.** The GitHub forge is on another branch. Pull requests go through the same `forge.openPullRequest` interface, untested there.
- **Built but not checked by any test:**
  - Try again after a failed push, a second push after more changes, and the pull request route's refusals while a push is in flight, before the workspace is ready and for a task with no repo.
  - The flags a pipeline stage's session starts with, and the research, plan and implement pipeline driven from the app. step14c drives a simpler pipeline's gate there.
  - Changes sent when a daemon starts, two scans at a time, a file too large to show, a post past its budget with the API asking for the rest, a submodule, and an unreadable repo's error in the app.
  - In the palette, the arrow keys, finding anything but a task, Cmd+K from inside a field, Ctrl+K left to a field on a Mac, single keys with a modifier held or during composition, and the single-key choice surviving a reload.
  - Holding a task until a date from the app.
- **Changes are current state only.** Earlier states of an unpushed file are not kept.
- **A draft can show as a started task for a moment,** with "Starting…" and a message box, until its session reaches the page. A screenshot caught it on a phone opened right after the draft was made.

## Decisions to revisit

- **Anyone who can see a draft can start it.** That matches asks, which anyone on the team can answer. A draft could instead belong to its writer until they share it.
- **The pipeline needs an agent named `builder`.** I chose a new name because the job differs from fixing bugs.
- **Single-key shortcuts are on by default.** They can be turned off in the palette.
- **A hold's until date uses the database's date.** `agents_test` reports its time zone as `Etc/UTC`, so a hold until Friday lapses at midnight UTC.
