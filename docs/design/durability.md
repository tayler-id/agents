# Turns that survive a machine dying

Designed, and being built on the durability branch. The resume note in `docs/design/durability-resume.md` says what is built and proven so far.

When a person messages an agent, the API queues a `message` command, and the agent's machine runs the turn in a Claude session. The machine is this Mac's daemon or a box running the same daemon. This design makes a turn survive that machine dying. The work resumes, or the app shows it as interrupted, and nothing waits forever.

## What breaks today

- `daemon/agentsd.ts` `apply` hands the message to Claude and `handle` marks the command done at once, before the turn has done anything.
- After a restart, `POST /v1/instance/commands/requeue` in `server/api.ts` puts back only commands still marked claimed. A message's command is already done, so a turn cut off midway is never retried.
- Nothing marks a session lost. A session cut off mid-turn keeps the status its last event gave it, so the app shows the agent working forever.
- An approval that was waiting when the machine restarted can't be answered. The answer becomes an `answer` command, and the new daemon fails it with "session is not running on this machine".

## What Claude does when it is killed

I killed `claude -p` 2.1.296 with SIGKILL at three points, then resumed each session with `--resume`. The design rests on these results.

1. Killed while the model streams text, Claude's transcript holds the user message and nothing of the reply. The streamed text exists only in our live stream.
2. Resumed and sent a new message, Claude adds a reply "No response requested." after the cut-off message, then answers the new message. The turn finishes.
3. Killed while an allowed Bash command runs, the transcript holds the tool call and no result.
4. The Bash command keeps running after Claude dies. Its shell runs in its own process group, so it outlives Claude, and in my run it wrote its second line 40 seconds later.
5. On resume, Claude writes an error result "Tool call interrupted: the session ended before this call's result was recorded" for that call. It never prints it on stdout, so our record never sees it.
6. Killed while waiting for an approval, the transcript holds only the user message. The tool call the approval was for is missing, though Claude had already printed it and the daemon had recorded it.
7. Resuming a conversation that does not exist on the machine prints "No conversation found with session ID" and exits with code 1.

So Claude's transcript can lag what Claude printed. After a crash, our record is the only full account of the turn, and whatever the resumed session is told must come from the record.

## The model

### A turn

A turn is one `message` command, such as a person's post, a pipeline stage's prompt, a reminder, a room turn or a routine. Its state is the command's status read together with its session's status, so nothing new has to be kept in step with it.

| Turn state | Command status | Session status |
|---|---|---|
| queued | queued | any |
| running | claimed | starting, running, needs_approval, needs_input |
| interrupted | claimed | lost |
| done | done | any |
| failed | failed | any |

| Move | Who makes it | When |
|---|---|---|
| queued to running | the daemon, through the claim endpoint | its session has no turn in flight |
| running to done | the server, inside the transaction that records the turn's end event | the harness reports the turn's result |
| running to failed | the server, on the daemon's report | the harness exits mid-turn, or the machine could not start it |
| running to interrupted | the server | the machine reports the turn cut off when it restarts, or the machine stops answering |
| interrupted to running | the daemon, then the harness's next status | the restarted machine resumes the turn |
| interrupted to done | the server | the machine restarts and a person's interrupt or a run's stop was waiting for it |

`shared/lifecycle.ts` holds this table as code. The server checks every move it makes against it and throws on any other.

Two rules make the table hold.

- **One turn at a time per session.** The daemon claims a session's next message only when the session has no turn in flight, and keeps the rest waiting in the queue. A unique index on `commands (session_id) where kind = 'message' and status = 'claimed'` makes a second claimed turn impossible, and the claim endpoint answers 423 when a turn is already running. Today the daemon hands a second message to a busy Claude at once, and Claude queues it, so a person sees the same order of replies either way.
- **The server ends the turn.** The transaction that records a turn's `usage` event also marks its command done, and one that records a `failed` status marks it failed. A daemon that dies between the two writes can't leave a finished turn looking unfinished, because there is only one write.

### A session

The session statuses are the agreed ones. Only `lost` gets a meaning it didn't have, and it gets no new value.

| Status | Means | Set by |
|---|---|---|
| starting | a new session that hasn't run a turn | the row's default |
| running | the harness is working on a turn | the harness's lines |
| needs_approval | the harness waits for a person's answer | the harness's permission request |
| idle | no turn in flight, and the session can resume | the harness's result |
| lost | a turn was in flight when its machine stopped, and nothing is working on it now | the server, at the machine's restart or when the machine stops answering |
| failed | the harness could not start, or exited with an error | the daemon's report |

A `lost` session leaves `lost` the way any session changes status. The resumed harness's first line sets `running`, its result sets `idle`, and a failure sets `failed`.

## Who records what, and when

### The server, in Postgres

- The turn's command, claimed when the daemon hands the turn to the harness and finished when the turn's end event is recorded.
- Every event the harness prints, as today, keyed by client id so a retried post adds nothing.
- At a restart, for each interrupted turn, a `notice` event with `body.subtype = 'interrupted'` that names the reason, the turn's command, and the tool calls and approvals left open. Then a `user` event with no author, holding the exact text the resumed session is sent.
- When a machine stops answering, the same notice with the reason "the machine stopped answering", and the session's status `lost`.
- For each approval, which harness request it is waiting on. `asks.request_ended_at` is set when the process that raised the request is gone, and cleared when a resumed session asks again.

### The daemon, on the machine's disk

- `AGENTS_HOME/sessions/<session>.pid` holds the process id of each harness it starts, removed when the harness exits. AGENTS_HOME is on the box's home volume, so a replaced container finds the file too.

The daemon keeps nothing else between runs. Its turn state lives in Postgres.

## How a restart finds and resumes work

The daemon does three things before it reads its queue.

1. **Stops what the last run left.** For each `.pid` file it reads the process's command line with `ps -ww`, and stops the process and its children only when the command line names that session's MCP config file, which holds the session id. A process id from another container, or one reused since, never matches. This matters when only the daemon died. Its Claude keeps working the turn, and resuming beside it would put two processes on one transcript.
2. **Reports.** It calls `POST /v1/instance/recover`. In one transaction the server:
   - puts back claimed commands that are not turns (`setup_workspace`, `exec`, `push`), as requeue did;
   - fails each `answer` command still queued or claimed, since the request it answers died with the process, and leaves the decision on the ask;
   - for each claimed turn, reads the record since the turn's user event and sorts each tool call that has no result. A call with an approval that never reached the harness is waiting for approval. Any other call without a result is in flight, which means it may or may not have taken effect;
   - ends the turn as done, with a notice saying why, when an `interrupt` or `stop` for that session was waiting. Otherwise it records the interrupted notice and the continuation, sets the session `lost`, and returns the turn.
3. **Resumes.** For each returned turn it starts the harness with the session's Claude id, or a fresh one when the crash came before Claude reported its id, and sends the continuation. The turn's command stays claimed until that turn ends.

The continuation names the cut-off message and every open thread, because the resumed session may not know them (facts 1 and 6). For example:

```
This session was resumed after its machine stopped in the middle of your turn. What you did
before the stop is in this conversation, but the last part of it may be missing.

These tool calls were still running when the machine stopped. Their results were never
recorded, so each may or may not have taken effect. Check before you run any of them again.
- Bash (toolu_ledger): echo entry-1 >> ledger.txt

These requests for approval ended when the machine stopped. Call the tool again with exactly
the same input, and the answer reaches you then.
- Bash: echo approved >> asked.txt. A person allowed it.

Finish the turn. The message you were answering:

Do the LEDGER task.
```

The daemon never runs a tool call again by itself, and never sends the original message to a fresh session. Either would repeat an action without saying so. The resumed session decides, told what may have happened.

## How an approval survives a restart

An ask is answered through the harness request that raised it, and that request dies with its process. So the ask outlives the request.

- The card stays open across the restart, and a person can answer it at any time. The answer is recorded on the ask at once, whether or not a machine is running.
- While the request is alive, an answer becomes an `answer` command for it, as today.
- Recovery sets `request_ended_at` on every ask whose decision never reached its process, open or answered.
- The continuation tells the resumed session to call the tool again with the same input. When its new permission request arrives, the server looks for an ask of the session with an ended request, the same tool and the same input, ignoring Bash's free-text `description`. A match takes the new request instead of opening a second card. If the ask is already answered, the server records an `answer` event by the same person and queues the decision for the new request at once.
- A decision that already reached a process is not carried. The call may have run, so asking again needs a person again.
- A denial that never reached its process goes into the continuation as denied, and the ask is closed.
- When a turn ends, the session's asks that are still open expire. Today an interrupted turn leaves its card open forever.

## Machines that stop answering

A daemon posts a heartbeat every 15 seconds. The runner's tick marks a machine `stale` when it has not been heard from for `AGENTS_MACHINE_LOST_SEC` seconds, 45 by default, which is three missed heartbeats. In the same pass it marks `lost` each working session on a machine not heard from in that time, if the session has had no event in that time either, and records the interrupted notice. The second condition keeps a box that is still starting from flapping its sessions to `lost`. The tick skips this until the API has been up for the same span, so an API restart doesn't mark every machine lost before it has had a chance to call in. The value must be at least two heartbeats, and the API refuses to start otherwise.

A machine that comes back without restarting, such as after a network outage, sets its sessions' statuses again with its next lines.

## What the app shows

- A `lost` session shows an "Interrupted" line in its conversation with the reason from its last interrupted notice, and that it picks up again when its machine is back. The Interrupt button stays, and an interrupt sent while the machine is down ends the turn when it returns.
- The session panel lists interrupted notices beside the other events.
- An ask card stays until it is answered or its turn ends.

## Failures considered

| Failure | How it ends |
|---|---|
| Machine dies while the model writes | The restart reports the turn, resumes it with the continuation, and the reply lands. Check 1. |
| Machine dies after a tool acts, before its result is saved | The continuation names the call as possibly done, and the resumed session checks before repeating it. Check 2. |
| Machine dies while an approval waits | The card stays answerable, and the decision reaches the resumed session's new request. Check 3. |
| A box's container is replaced on the same home volume | The new container's daemon finds the turn through the API, and Claude's transcript and the workspace are on the volume. Check 4. |
| Machine dies and never comes back | The watchdog marks its sessions `lost`, and the app says so. A person can still post, and it waits for the machine. |
| Only the daemon dies | Its Claude keeps going, without anyone recording what it prints. The restarted daemon stops it before resuming. |
| Only Claude dies | The daemon sees it exit, and the turn fails with Claude's error, as today. The person's next message resumes the session. |
| The daemon dies after reading a line and before posting it | That line is lost from the record. The continuation lists every call without a recorded result, so the session is told. |
| The daemon dies during recovery | The next start runs recovery again. Each run adds a notice, so the record shows every restart. |
| A tool command outlives a killed Claude | On a box, removing the container ends it. On the Mac it runs to its end, unseen, and the continuation says the call may still be running. Not solved, see below. |
| A person interrupts while the machine is down | The interrupt waits in the queue, and the restart ends the turn instead of resuming it. |
| A person answers while the machine is down | The decision is kept on the ask and delivered to the resumed session's new request. |
| The resumed session asks for something different | No ask matches, so a new card opens, and the old one expires when the turn ends. |
| The conversation to resume is missing from the machine | Claude exits with "No conversation found", and the session shows failed with that reason. Not solved, see below. |
| The API restarts mid-turn | The daemon retries its posts until the API answers, so nothing is lost. The watchdog waits out its grace period. |
| Postgres restarts mid-turn | As the API restarting. |
| A session's machine is offline when a message arrives | The command waits in the queue. A new session's status stays `starting`, which the app shows as working. Not solved. |

## The engine boundary

The daemon keeps every Claude detail in `daemon/claude.ts` behind `daemon/harness.ts`. For the five checks to pass, an engine has to do what Claude does here:

- resume a conversation by its id, given as `resume`, and report its id with its first lines;
- print one result per message and take one message at a time;
- raise a permission request with an id, and refuse an answer to a request it isn't waiting on;
- report the process id the daemon should stop before resuming it elsewhere, or none when it runs no process here.

An engine whose sessions are durable on their own, so that a turn's loop runs on a server and a machine only runs its tools, would make most of recovery its own job. It would plug in behind the same interface and run against the same five checks. The app we studied works this way. Each turn runs on its server as a durable workflow, and the box only runs tools and keeps files and browser state. Moving our loop off the machine would mean running Claude's loop ourselves, so we keep Claude Code as the engine for now.

## The checks

Each check starts its own API, daemon and team, prefixed `dur-`, on ports 8040 to 8059, kills only the processes it started, and removes what it made when it passes.

1. `test/step18a.ts`, real Claude. A person asks for a forty-line poem. Once the live stream has text, the check kills the daemon, then Claude and its children. It restarts the daemon. The poem lands in the conversation, from the same Claude conversation, with the interrupted notice in the record.
2. `test/step18b.ts`, the fake Claude. The agent appends a line to a ledger and is killed before the result. On restart the ledger still has one line, the record names the call as interrupted, the resumed session was told about it and checked, and the turn ends. A second turn kills only the daemon, and the old Claude is stopped before the turn resumes.
3. `test/step18c.ts`, the fake Claude. The agent asks to run a command and is killed while the ask waits. Once a person answers during the outage, and once after the restart. Each time the same card takes the answer, no second card opens, and the command runs once.
4. `test/step18d.ts`, the fake Claude in a box. The box writes a file and is killed mid-turn by removing its container. While it is gone the session shows `lost`. A new container on the same home volume brings back the file and the session, and the turn finishes.
5. `test/step18e.ts`, the fake Claude. A client that stays connected and one that reconnects both read the session, its events, its posts and its asks during the outage and after the restart, and both match the record. Checks 1 to 4 run the same comparison when they finish.

On main, checks 1 to 4 time out waiting for the turn to finish, and check 5 sees the session working through the outage instead of `lost`.

## Schema change

Migration `0010_durability.sql`, described in `docs/data-model.md`:

- `commands_one_turn`, a unique index on `commands (session_id) where kind = 'message' and status = 'claimed'`;
- `asks.request_ended_at`, null while the harness request the ask answers is alive or has its answer.

Both work with main's code, which other checks run against the same `agents_test`.

## Not covered

- **Tool commands outliving a killed Claude on the Mac.** They keep running after a restart. Finding them would mean marking every process a harness starts and searching for the mark on restart.
- **Lines lost between Claude and the record.** A journal of the harness's lines on the machine's disk, written before each post and replayed on restart, would close that gap.
- **A missing conversation.** The harness could start a fresh conversation and say so, instead of failing.
- **A session whose machine is gone for good.** Nothing moves a session to another machine.
- **Box images.** A box runs the daemon its image was built with. Boxes need their image rebuilt with `server/boxes.ts build` when this lands, or their daemon calls the old requeue endpoint and waits forever.
