# Turns that survive a machine dying

Built on the durability branch. The resume note in `docs/design/durability-resume.md` says what is proven and what is left.

When a person messages an agent, the API queues a `message` command, and the agent's machine runs the turn in a Claude session. The machine is this Mac's daemon or a box running the same daemon. This design makes a turn survive that machine dying. When the machine comes back, the turn resumes. While it is gone, the app shows the turn as interrupted, with the reason. A machine that never comes back leaves its turns interrupted, since nothing moves a session to another machine, as "Not covered" says.

## A regression for Tayler to decide

This branch removes `POST /v1/instance/commands/requeue` and refuses a daemon's report that a message is done. A daemon built before it breaks against the new API, and every box image on the server holds one until it is rebuilt.

- **An old daemon that starts** calls the requeue route, gets 404, and retries it forever, logging "waiting for the API". Its heartbeat keeps its machine `online`, but it never reads its queue, so messages for its agents wait with nothing to say why.
- **An old daemon already running** claims a message and reports it done at once, as main's daemon does. The new API answers 400, the daemon reports the message failed instead, and the API records that error in the session and marks it `failed`. A pipeline stage waiting on the message fails with it, since `pollAgent` in `server/runner.ts` reads the failed command. The old Claude keeps working the turn meanwhile, and its lines still reach the record and set the session's status again.

The reverse breaks too. A new daemon calls `POST /v1/instance/recover`, which an old API answers with 404, and retries it forever in the same way.

I ran main's daemon at `360c16e` against this branch's API, both as a fresh start and across an API restart, and this branch's daemon against main's API, with the fake Claude. Each did what is described here, apart from the pipeline stage, which follows from the code and was not run.

Rolled out in this order, no old daemon ever reaches the new API.

1. Rebuild the box image with `server/boxes.ts build`.
2. Recreate the container of every box `server/boxes.ts list` shows with `server/boxes.ts recreate <team> <name>`, stopped boxes included. The runner starts a stopped box's container again as it was, on its old image. Each box keeps its home volume.
3. Check that each box container runs the new image. `docker inspect -f '{{.Image}}' <container>` must print what `docker image inspect -f '{{.Id}}' agents-box:latest` prints.
4. Restart the Mac's daemon.
5. Restart the API.

Do steps 2 and 3 when no box has a turn in flight. A teammate's personal box runs until it has been idle for `AGENTS_BOX_IDLE_MIN`, so check that none of their sessions is working, and tell their owners first. A turn cut off by recreating its box is not resumed, since the old API marked its message done when the box took it.

Between steps 2 and 5 the new daemons get 404 from the old API and retry, waiting up to 15 seconds between tries, while messages wait in the queue. Each daemon reads its queue once the new API answers.

The branch lands without a transition and relies on this order. Tayler can overrule that, and have the old route kept answering, with an old daemon's done report taken, until every box runs the new image. That is not built.

## What breaks today

- `daemon/agentsd.ts` `apply` hands the message to Claude and `handle` marks the command done at once, before the turn has done anything.
- After a restart, `POST /v1/instance/commands/requeue` in `server/api.ts` puts back only commands still marked claimed. A message's command is already done, so a turn cut off midway is never retried.
- Nothing marks a session lost. A session cut off mid-turn keeps the status its last event gave it, so the app shows the agent working forever.
- An approval that was waiting when the machine restarted can't be answered. The answer becomes an `answer` command, and the new daemon fails it with "session is not running on this machine".

## What Claude does when it is killed

I killed `claude -p` 2.1.296 with SIGKILL at three points, resumed each session with `--resume`, and sent messages into running turns. The design rests on these results.

1. Killed while the model streams text, Claude's transcript holds the user message and nothing of the reply. The streamed text exists only in our live stream.
2. Resumed and sent a new message, Claude adds a reply "No response requested." after the cut-off message, then answers the new message. The turn finishes.
3. Killed while an allowed Bash command runs, the transcript holds the tool call and no result.
4. The Bash command keeps running after Claude dies. Its shell runs in its own process group, so it outlives Claude, and in my run it wrote its second line 40 seconds later.
5. On resume, Claude writes an error result "Tool call interrupted: the session ended before this call's result was recorded" for that call. It never prints it on stdout, so our record never sees it.
6. Killed while waiting for an approval, the transcript holds only the user message. The tool call the approval was for is missing, though Claude had already printed it and the daemon had recorded it.
7. Resuming a conversation that does not exist on the machine prints "No conversation found with session ID" and exits with code 1.
8. A message sent while Claude is mid-turn joins that turn. Sent during a tool call, it reached the model with the tool's result, and one result answered both messages. Sent after the turn's result, it started a turn of its own.
9. With `--replay-user-messages`, Claude prints each message back, marked `isReplay`, at the moment it takes the message into a turn. The follow-up in fact 8 came back after the tool's result, not when it was sent.
10. The printed-back message keeps the `uuid` it was sent with.

So Claude's transcript can lag what Claude printed. After a crash, our record is the only full account of the turn, and whatever the resumed session is told must come from the record. And a turn can answer several messages, so a person can steer an agent while it works. Holding a follow-up back until the turn ends would take that away.

## The model

### A message and its turn

A message is one `message` command, such as a person's post, a pipeline stage's prompt, a reminder, a room turn or a routine. A turn is the harness's work from taking in a message to printing a result, and it answers every message it took in on the way. A message's state is its command's status read together with its session's status, so nothing new has to be kept in step with it.

| Message state | Command status | Session status |
|---|---|---|
| queued | queued | any |
| handed over | claimed | starting, running, needs_approval, needs_input, idle |
| interrupted | claimed | lost |
| done | done | any |
| failed | failed | any |

| Move | Who makes it | When |
|---|---|---|
| queued to handed over | the daemon, through the claim endpoint | it writes the message to the session's harness, as soon as it arrives |
| handed over to done | the server, inside the transaction that records the turn's end event | the harness reports the result of the turn that took the message in |
| handed over to failed | the server, on the daemon's report | the harness exits before that turn ends, or the machine could not start it |
| handed over to interrupted | the server | the machine restarts with the message unfinished, or the machine stops answering |
| interrupted to handed over | the daemon | the restarted machine resumes the session with every unfinished message |
| interrupted to done | the server | the machine restarts and a person's interrupt or a run's stop was waiting for it |
| interrupted to failed | the server | the machine restarts in a turn it has already resumed three times |

`shared/lifecycle.ts` holds this table as code, and `moveMessages` in `server/durability.ts` is the only writer of a message command's status. The claim endpoint, the end of a turn, a daemon's failure report and a machine's recovery all go through it. Its update matches only commands in a status the table allows the move from, and when any command it was given doesn't match, it moves none of them and throws. A move between handed over and interrupted changes only the session's status. Check 10 makes illegal moves and sees each one throw and change nothing.

Two rules make the table hold.

- **The harness says which messages a turn answered.** The harness sends each message to Claude under a fresh `uuid` that it maps to the message's command ids, and starts Claude with `--replay-user-messages`. When Claude prints a message back, that message has joined the running turn. The turn's result batch carries the command ids it took in, as `ended`, marked answered. A message Claude has not taken in yet stays handed over, and joins the next turn. A continuation is one message that answers several commands, which is why the uuid is the harness's own and not a command id.
- **The server ends the message.** The transaction that records a turn's `usage` event marks the commands in `ended` done. When the harness exits, the daemon's last batch lists every message the process still had, marked exited with the harness's error, and the server marks them failed with it. A daemon that dies between the two writes can't leave a finished message looking unfinished, because there is only one write.

The daemon's `busy` flag comes from the same ids. A harness is busy while it holds a message no result has ended. On main it counts one result per message, so after Claude answers two messages with one result it stays busy forever, and the agent's new setup never reaches it.

### A session

The session statuses are the agreed ones. Only `lost` gets a meaning it didn't have, and it gets no new value.

| Status | Means | Set by |
|---|---|---|
| starting | a new session that hasn't run a turn | the row's default |
| running | the harness is working on a turn | the harness's lines |
| needs_approval | the harness waits for a person's answer | the harness's permission request |
| idle | no turn in flight, and the session can resume | the harness's result |
| lost | a turn was in flight when its machine stopped, and nothing is working on it now | the server, at the machine's restart or when the machine stops answering |
| failed | the harness could not start, or exited with an error | the daemon's report, or the server when it stops resuming a turn |

A `lost` session leaves `lost` the way any session changes status. The resumed harness's first line sets `running`, its result sets `idle`, and a failure sets `failed`.

Only a session's current process sets its status. The daemon stops a session's process to start one with a new setup, when the agent's instructions, skills, plugins or model change. From the moment it starts the new one, the old one is no longer the session's. Its lines are still recorded, but its status is dropped. So when the new start fails, the session stays `failed` with the machine's reason, and the old process's clean exit can't report it `idle`. Before this rule the daemon kept the old process as current until the new one started, and a failed start left the session showing `idle` with no notice. Check 6 covers it.

## Who records what, and when

### The server, in Postgres

- Each message's command, claimed when the daemon hands the message to the harness and finished when the end of the turn that took it in is recorded.
- Every event the harness prints, as today, keyed by client id so a retried post adds nothing.
- At a restart, for each session with unfinished messages, a `notice` event with `body.subtype = 'interrupted'` that names the reason, the messages, and the tool calls and approvals left open. Then a `user` event with no author and `body.resumes` naming the messages, holding the exact text the resumed session is sent. When the turn has been resumed three times already, the notice and an `error` event say it was not resumed again.
- When a machine stops answering, the same notice with the reason "the machine stopped answering", and the session's status `lost`.
- For each approval, which harness request it is waiting on. `asks.request_ended_at` is set when the process that raised the request is gone without its decision, and cleared when a resumed session asks again.

### The daemon, on the machine's disk

- `AGENTS_HOME/sessions/<session>.pid` holds the process id of each harness it starts. It is removed when the harness exits, or by the next start once that harness and every process under it are gone. AGENTS_HOME is on the box's home volume, so a replaced container finds the file too.

The daemon keeps nothing else between runs. Which messages each harness holds it keeps in memory, and a crash loses nothing by that, since recovery takes every unfinished message from Postgres.

## How a restart finds and resumes work

The daemon does three things before it reads its queue.

1. **Stops what the last run left.** For each `.pid` file it reads the process's command line with `ps -ww`, and stops the process and its children only when the command line names that session's MCP config file, which holds the session id. A process id from another container, or one reused since, never matches. This matters when only the daemon died. Its Claude keeps working the turn, and resuming beside it would put two processes on one transcript. When a process is still there 5 seconds after SIGKILL, the daemon keeps its `.pid` file and exits, so its next start tries again.
2. **Reports.** It calls `POST /v1/instance/recover`. In one transaction the server:
   - puts back claimed commands that are not messages (`setup_workspace`, `exec`, `push`), as requeue did;
   - fails each `answer` command still queued or claimed, since the request it answers died with the process, and leaves the decision on the ask;
   - for each session with claimed messages, reads the record since the first of their user events and sorts each tool call that has no result. Asks from earlier turns are over and play no part. A call whose approval is still open, or whose allow never reached the harness, has to be asked for again. One whose denial never reached it is reported as denied. A decision reached the harness once its daemon claimed the answer command, and a call whose decision did is in flight, which means it may or may not have taken effect;
   - ends those messages as done, with a notice saying why, when an `interrupt` or `stop` for that session was waiting;
   - fails them, with a notice and an error event saying why, when earlier restarts have resumed the turn three times (`MAX_RESUMES`). A turn that takes its machine down every time would otherwise keep it restarting forever;
   - otherwise records the interrupted notice and one continuation for all of them, sets the session `lost`, and returns the session with its messages.
3. **Resumes.** The daemon parses the answer with the zod schemas in `shared/types.ts`, each session on its own, so a session it can't read fails with the reason and holds up no other. For each one it starts the harness with the session's Claude id, or a fresh one when the crash came before Claude reported its id, and sends the continuation. The resumed turn's result ends every message the continuation covers. Their commands stay claimed until then.

The continuation names every unfinished message and every open thread, because the resumed session may not know them (facts 1 and 6). For example:

```
This session was resumed after its machine stopped in the middle of your turn. What you did
before the stop is in this conversation, but the last part of it may be missing.

These tool calls were still running when the machine stopped. Their results were never
recorded, so each may or may not have taken effect. Check before you run any of them again.
- Bash echo entry-1 >> ledger.txt (call toolu_ledger)

These requests for approval ended when the machine stopped, before they ran. Call the tool
again with exactly the same input, and the answer reaches you then.
- Bash with input {"command":"echo approved >> asked.txt","description":"..."}. A person allowed it.

Finish the turn. The message you were answering:

Do the LEDGER task.
```

With more than one unfinished message, it lists each in the order people sent them.

The daemon never runs a tool call again by itself, and never sends the original message to a fresh session. Either would repeat an action without saying so. The resumed session decides, told what may have happened.

A daemon stopped with SIGTERM, as launchd stops it, leaves a session in the middle of a turn as a crash would. Its Claude keeps running and its messages stay claimed. The next start stops that Claude and resumes the turn. Sessions with no turn in flight end cleanly. Check 2 covers it.

## Pushes, checks and workspace setup

- A `push`, `exec` or `setup_workspace` command a machine held when it stopped goes back in the queue at its restart, as requeue did, and runs again. A push run again pushes with a lease at a tip its workspace pushed or HEAD holds, so one that landed before the stop pushes nothing new. The work layer's design has the lease. No check holds one of these commands across a restart.
- No pull request opens while any session of the task is in flight, which includes `lost`, since a cut-off turn resumes and may still change files. The route, the task page's form and the Interrupt buttons read `IN_FLIGHT` in `shared/lifecycle.ts`. Check 5.
- A resumed task session starts at once, in whatever its workspace folder holds. A daemon killed during a task's first clone can resume the turn in a half-cloned tree while the requeued setup runs beside it. Not solved.
- A push the runner fails after 15 minutes keeps its command queued or claimed, so a machine that comes back later runs it, and the branch reaches the forge with no pull request. Main's requeue did the same. Not solved.

## How an approval survives a restart

An ask is answered through the harness request that raised it, and that request dies with its process. So the ask outlives the request.

- The card stays open across the restart, and a person can answer it at any time. The answer is recorded on the ask at once, whether or not a machine is running.
- While the request is alive, an answer becomes an `answer` command for it, as today.
- Recovery sets `request_ended_at` on each ask of the cut-off turn whose decision never reached its process, whether it is still open, allowed or denied. It reads only asks raised since the turn's first message. An allow given while the machine was down, in a turn a person then interrupted, stays answered and undelivered, and only that limit keeps a later turn's recovery from offering it. Check 8.
- The continuation tells the resumed session to call the tool again with the same input. When its new permission request arrives, the server looks for an ask of the session with an ended request, the same tool and the same input, ignoring Bash's free-text `description`. A match takes the new request instead of opening a second card. If the ask is already answered, the server records an `answer` event by the same person and queues the decision for the new request at once. Check 3.
- A decision that may have reached a process is not carried. The call may have run, so the continuation names it as possibly run, and asking again needs a person again. This holds however many times the machine restarts in the turn. Check 9.
- A denial that never reached its process goes into the continuation as denied, with the person's reason, and is not asked for again. A request for the same call in that turn gets the same denial. Check 9.
- When a turn ends, its asks still open expire, and so does a decision kept for a resumed session that never asked for it. Neither recovery nor a later request can take them up, and an answer to an expired card gets 409. On main an interrupted turn leaves its card open forever. Check 8.
- A turn's asks close only when the batch that ends it finishes its messages. The same batch sent again finishes nothing, so it leaves alone a card a newer process has raised since. Check 10.
- A person's answer locks the session before the ask, the order recovery and a harness's batches take them in, so an answer that arrives while a machine recovers waits for it instead of deadlocking with it. Check 11.

## Machines that stop answering

A daemon posts a heartbeat every 15 seconds. The runner's tick marks a machine `stale` when it has not been heard from for `AGENTS_MACHINE_LOST_SEC` seconds, 45 by default, which is three missed heartbeats. In the same pass it marks `lost` each working session on a machine not heard from in that time, if the session has had no event in that time either, and records the interrupted notice. The second condition keeps a box that is still starting from flapping its sessions to `lost`. The tick skips this until the API has been up for the same span, so an API restart doesn't mark every machine lost before it has had a chance to call in. The value must be at least two heartbeats, and the API refuses to start otherwise. Check 10 starts one with 10 seconds and sees it stop.

A machine that comes back without restarting, such as after a network outage, sets its sessions' statuses again with its next lines.

## What the app shows

- A `lost` session shows an "Interrupted" line in its conversation, or on its task's page, with the reason from its last interrupted notice, and that it picks up again when its machine is back. The Interrupt button stays, and an interrupt sent while the machine is down ends the turn when it returns. Check 5.
- A task's transcript leaves out the text a resumed session is sent, which the server wrote and no person asked. Check 5.
- Every page reads which statuses mean working from `isWorking` in `shared/lifecycle.ts`.
- The session panel lists interrupted notices beside the other events.
- An ask card stays until it is answered or its turn ends.

## Failures considered

A row that names a check is proven by it. The other rows follow from the code, and no check covers them yet.

| Failure | How it ends |
|---|---|
| Machine dies while the model writes | The restart reports the turn, resumes it with the continuation, and the reply lands. Check 1. |
| Machine dies after a tool acts, before its result is saved | The continuation names the call as possibly done, and the resumed session checks before repeating it. Check 2. |
| Machine dies while an approval waits | The card stays answerable, and the decision reaches the resumed session's new request. Check 3. |
| A box's container is replaced on the same home volume | The new container's daemon finds the turn through the API, and Claude's transcript and the workspace are on the volume. Check 4. |
| Machine dies and never comes back | The watchdog marks its sessions `lost`, and the app says so. A person can still post, and it waits for the machine. Check 5. |
| Only the daemon dies | Its Claude keeps going, without anyone recording what it prints. The restarted daemon stops it before resuming. Check 2. |
| The daemon is stopped with SIGTERM mid-turn | It leaves the turn as a crash would, and the next start stops the old Claude and resumes the turn. Check 2. |
| Only Claude dies | The daemon sees it exit, and the turn fails with Claude's error, as today. The person's next message resumes the session. |
| The daemon dies after reading a line and before posting it | That line is lost from the record. The continuation lists every call without a recorded result, so the session is told. |
| The daemon dies during recovery | The next start runs recovery again. Each run adds a notice, so the record shows every restart. |
| A turn takes its machine down every time | Recovery resumes it after three restarts, and fails it with the reason at the fourth. The person's next message starts a turn as usual. Check 12. |
| The fence can't stop the last run's Claude | The daemon keeps the `.pid` file and exits, and its next start tries again. No check covers this case, since no process can be made to outlive SIGKILL from outside. |
| The daemon can't read a turn recover returns | That session fails with the reason, and the others resume. No check covers this case. |
| A restart for a new setup fails to start | The session shows `failed` with the machine's reason, such as a plugin's missing secret, and stays that way. Check 6. |
| A follow-up arrives mid-turn | It goes to the harness at once and joins the running turn, as today. Check 7. If the machine dies before Claude takes it in, the continuation includes it. |
| Claude answers two messages with one result | The result's batch ends both commands, and the harness is no longer busy, so the agent's next setup reaches the session. Check 7. |
| A tool command outlives a killed Claude | On a box, removing the container ends it. On the Mac it runs to its end, unseen, and the continuation says the call may still be running. Not solved, see below. |
| A person interrupts while the machine is down | The interrupt waits in the queue, and the restart ends the turn instead of resuming it. Check 2. |
| A person allows while the machine is down | The decision is kept on the ask and delivered to the resumed session's new request. Check 3. |
| A person denies while the machine is down | The continuation says the call was denied, with the reason, and never that it was allowed. Check 9. |
| The machine dies twice in a turn after an answer reached Claude | The second recovery still names the call as possibly run, and offers no approval to run it again. Check 9. |
| The resumed session never asks again | The kept decision expires when the turn ends, and no later turn or recovery takes it up. Check 8. |
| The resumed session asks for something different | No ask matches, so a new card opens, and the old one expires when the turn ends. |
| A person answers while a machine recovers | The answer waits for recovery's lock on the session, then goes through. Check 11. |
| A person allows and then interrupts while the machine is down | The restart ends the turn, and the allow never reaches a process. A later turn's recovery doesn't offer it. Check 8. |
| A harness's exit batch is sent again | It finishes nothing and closes no asks, so a newer process's card stays open. Check 10. |
| A harness's exit batch arrives late, after a newer process for the session raised a card | The batch finishes its messages and closes the session's asks, that card included. Not solved, see below. |
| The conversation to resume is missing from the machine | Claude exits with "No conversation found", and the session shows failed with that reason. Not solved, see below. |
| The API restarts mid-turn | The daemon retries its posts until the API answers, so nothing is lost. The watchdog waits out its grace period. |
| Postgres restarts mid-turn | As the API restarting. A transaction whose connection Postgres drops fails, and the process keeps running. Check 10 covers the transaction. |
| A session's machine is offline when a message arrives | The command waits in the queue. Once the machine and the session have both been quiet past the threshold, the watchdog marks the session `lost`, by the same rule as above. No check covers this case. |

## The engine boundary

The daemon keeps every Claude detail in `daemon/claude.ts` behind `daemon/harness.ts`. For the checks to pass, an engine has to do what Claude does here:

- resume a conversation by its id, given as `resume`, and report its id with its first lines;
- take messages while it works, say which messages each turn took in, and print one result per turn;
- raise a permission request with an id, and refuse an answer to a request it isn't waiting on;
- report the process id the daemon should stop before resuming it elsewhere, or none when it runs no process here.

An engine whose sessions are durable on their own, so that a turn's loop runs on a server and a machine only runs its tools, would make most of recovery its own job. It would plug in behind the same interface and run against the same checks. The app we studied works this way. Each turn runs on its server as a durable workflow, and the box only runs tools and keeps files and browser state. Moving our loop off the machine would mean running Claude's loop ourselves, so we keep Claude Code as the engine for now.

## The checks

Each check starts its own API, daemon and team, prefixed `dur-`, on port 8040 or ports 8046 to 8059, kills only the processes it started, and removes what it made when it passes. Ports 8041 to 8045 are taken by another workstream's leftover processes, so the checks avoid them. Checks that share ports never run one right after another in `test/all.ts`, since a stopped API can take 5 seconds to let go of its port.

1. `test/step18a.ts`, real Claude. A person asks for a forty-line poem. Once the live stream has text, the check kills the daemon, then Claude and its children. It restarts the daemon. The poem lands in the conversation, from the same Claude conversation, with the interrupted notice in the record.
2. `test/step18b.ts`, the fake Claude. The agent appends a line to a ledger and is killed before the result. On restart the ledger still has one line, the record names the call as interrupted, the resumed session was told about it and checked, and the turn ends. A second turn kills only the daemon, and the old Claude is stopped before the turn resumes. A third turn is killed, a person interrupts while the machine is down, and the restart ends that turn without resuming it. A fourth turn sends the daemon SIGTERM mid-call. The message stays claimed and the old Claude running, and the next start stops it and resumes the turn.
3. `test/step18c.ts`, the fake Claude. The agent asks to run a command and is killed while the ask waits. Once a person answers during the outage, and once after the restart. Each time the same card takes the answer, no second card opens, and the command runs once.
4. `test/step18d.ts`, the fake Claude in a box. The box writes a file and is killed mid-turn by removing its container. While it is gone the session shows `lost`. A new container on the same home volume brings back the file and the session, and the turn finishes.
5. `test/step18e.ts`, the fake Claude and the app in a browser. During the outage the app shows the interrupted line with its reason and the open card. After the restart the person answers that card in the app, and the app shows the reply with no card and no line. A client that stays connected and one that reconnects both read the session, its events, its posts and its asks at each point, and both match the record. A task of the same agent, mid-call when the machine dies, shows on its page as interrupted with the reason and an Interrupt button, then shows the reply, and its transcript never shows the continuation as a request. While that turn waits to resume, a pull request for the task gets 409. Checks 1 to 4, 6, 8, 9 and 12 run the same comparison of clients and record.
6. `test/step18f.ts`, the fake Claude. A person adds a plugin whose secret the machine lacks to an agent with a running session, then messages it. The restart fails, and the session shows `failed` with the reason after the old process has exited and the daemon has stopped. It shares ports with check 2.
7. `test/step18g.ts`, real Claude. A person's follow-up, sent while the agent runs a command, joins that turn, and one result answers both messages. Both commands end with that turn, and when the agent's instructions change, the next message gets a new Claude process. It shares ports with check 1.
8. `test/step18h.ts`, the fake Claude. Claude dies while an approval waits, and the card expires with the turn, so a late allow gets 409 and runs nothing. Then a person answers an approval the resumed session never asks for again, and the decision expires when the turn ends. Last, a person allows an approval and then interrupts while the machine is down, so the restart ends that turn with the allow never delivered. Each time a later turn is cut off, and its recovery offers no old approval. It shares ports with check 3.
9. `test/step18j.ts`, the fake Claude. A person allows a command, it runs, and the machine dies after its daemon handed Claude the answer. Two restarts later the command has run once, and the continuation names the call as possibly run with no approval to run it again. Then a person denies an approval while the machine is down, and the continuation says denied, with the reason. It shares ports with check 5.
10. `test/step18i.ts`, the server's code with no daemon. The lifecycle table allows a message command only from queued to claimed and from claimed to done or failed. `moveMessages` refuses a finished message, a failed one, a queued one marked done, a batch with one message in the wrong state, and a message on another machine, and changes nothing each time. A claim hands a queued message over once. A harness's exit batch fails its messages and expires the card its turn left open, and the same batch sent again leaves open a card raised since. A transaction whose connection Postgres drops fails to its caller and the process keeps running. An API given a watchdog threshold of 10 seconds stops at once and names the setting. Its API would use port 8040.
11. `test/step18k.ts`, the server's code with no daemon. A transaction holds a session as recovery does, an answer waits on it, and the transaction then takes the ask. Both finish, with no deadlock. It uses no ports.
12. `test/step18l.ts`, the fake Claude. A turn that hangs every time it runs is resumed after each of three restarts, and fails with the reason at the fourth, with no fifth Claude. A message queued with no `permissions`, as an older API did, fails with the reason the daemon could not read it, and starts no Claude. The person's next message gets an answer. It shares ports with check 3.

On main, checks 1 to 4 time out waiting for the turn to finish, check 5 sees the session working through the outage instead of `lost`, check 6 sees the session `idle`, and check 7 sees the same Claude process answer after the setup changed, since the session still looks busy. Check 8 sees the card still open after Claude died, and a late allow taken with 200. Checks 9 and 12 wait in vain for a resumed session. Check 10 can't load, since main has no `shared/lifecycle.ts`, and in check 11 Postgres aborts the answer with "deadlock detected".

Claude 2.1.296 keeps a conversation's first system prompt and reuses it on every resume, unless started with `--system-prompt-snapshot off`. So a new process for a changed setup picks up new skills, plugins and model, but not new instructions. Check 7 tests that the process is replaced, not what it was told. This is outside durability and not changed here.

## Schema change

Migration `0010_durability.sql`, described in `docs/data-model.md`, adds one column, `asks.request_ended_at`. It is null while the harness request the ask answers is alive or has its answer. Main's code never reads it, so main's checks run unchanged against the same `agents_test`.

## Not covered

- **Old daemons.** See "A regression for Tayler to decide" above.
- **Tool commands outliving a killed Claude on the Mac.** They keep running after a restart. Finding them would mean marking every process a harness starts and searching for the mark on restart.
- **Lines lost between Claude and the record.** A journal of the harness's lines on the machine's disk, written before each post and replayed on restart, would close that gap.
- **A missing conversation.** The harness could start a fresh conversation and say so, instead of failing.
- **A session whose machine is gone for good.** Nothing moves a session to another machine.
- **A late exit batch.** A harness's exit batch that arrives after a newer process for the same session has raised a card expires that card too. Closing only the asks raised before the session's next unfinished message would fix it.
- **A push failed by the runner still runs.** Failing its command with the push would stop a machine that comes back from running it.
- **A resume during a task's first clone.** When a daemon is killed while it clones a task's repos, its restart requeues the setup and resumes the turn at once. The turn can start in the half-cloned tree while the setup runs beside it. A wait before the resume would not catch this. `ready` in `daemon/workspace.ts` waits only for a setup its own process started, or when the workspace folder is missing. A restarted daemon has started no setup yet, and the interrupted one made the folder before it cloned. Catching it would take asking the server whether the setup is still queued or running even when the folder exists.
- **Commands held across a restart.** A `setup_workspace`, `exec` or `push` command a machine held goes back in the queue in `recoverMachine`, and no check holds one across a restart. So nothing shows that each runs again after the restart, or that a push that landed before the stop pushes nothing new.
- **Messages from before the work layer.** A message queued or claimed under an older API has no `permissions`, so the new daemon fails it with the reason instead of running or resuming it. Check 12 covers a queued message the daemon claims. No check covers a claimed one the daemon would resume.
- **Statuses from the server and the harness are not ordered.** The watchdog can mark a session `lost` while a machine on the far side of a network outage is still working it. The machine's next line sets the status again, but a session waiting on an approval shows `lost` until the answer arrives.
