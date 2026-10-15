# Terminal sessions in the record

The first goal in `AGENTS.md` is that people keep using their own coding agents on their own computers, and those sessions land in the shared record. Today only the sessions the app starts land there. A Claude Code session a person opens in their own terminal doesn't. This doc covers the first slice of closing that gap. It calls those sessions terminal sessions.

I wrote it before the code, from prototypes run against the real `claude` CLI on this Mac (version 2.1.299), and I update it as the slice lands. "Not done" at the end lists what is missing.

## The slice

A person connects a folder on their Mac once, such as a repo, from the Terminal folders page in the Agents app on the Mac, or with:

```
node daemon/folders.ts connect ~/Projects/agents
```

From then on, every Claude Code session they start in that folder, or in a folder inside it, from their own terminal lands in the record. That covers each message both ways, each tool call and each result. The daemon scrubs it the way it scrubs app sessions before anything leaves the Mac, and the API scrubs it again. The session shows in the app beside the app's own sessions, marked as from their terminal.

**What it solves now.** Work people do in their own terminals stops being invisible to the team. A teammate can open it in the app, and every agent's `search_record` finds it, the same as an app session's.

**What it helps later.**

- The success test in `docs/intent/multiplayer.md`, "a teammate's Claude finds and uses my fix from an hour earlier", works for fixes made in a terminal, which is where most fixes are made today.
- The improve and coach pipelines can study terminal sessions, which are most of the evidence of how people actually work with Claude.
- Codex sessions can follow the same path with one more reader, since Codex also writes transcripts on disk.
- A terminal session can get the team-record tools later, by adding one MCP server to the person's Claude Code, so their own Claude reads teammates' work too.

## How a session gets from the terminal to the record

There were two candidates: Claude Code hooks, and the daemon reading the transcripts Claude Code writes. I ran a prototype of each with the real CLI and `haiku`, in folders under this session's scratchpad. The prototype scripts aren't in the repo.

### What the transcripts showed

- Claude Code writes every session, headless or interactive, to `~/.claude/projects/<folder name>/<session id>.jsonl`. The folder name is the path the session started in, with every character other than a letter or a digit made a dash. `/Users/example/.no-mistakes` becomes `-Users-example--no-mistakes`.
- Every conversation line carries `cwd`, `sessionId`, `timestamp` and its own `uuid`, so the reader can check where a session started and the record can skip a line it already has.
- A headless `claude -p` run with one Read call wrote 33 lines in 6.2 s. Only 4 were the conversation: the prompt, the tool call, the tool result and the reply. The rest were Claude Code's bookkeeping: 17 `attachment` lines, `queue-operation`, `last-prompt`, `atis-latch`, `cost-state` and a `stop_hook_summary` from a plugin's Stop hook.
- Headless mode writes its transcript when the process ends. All 33 lines appeared at once, 0.6 to 5.7 s after their own timestamps.
- Interactive mode writes as it goes. In a two-turn session driven through a pseudo-terminal with `expect`, every line of the conversation, the prompts, the Read call and its result, the thinking and both replies, reached the reader 0.1 to 0.9 s after its own timestamp.
- A prompt typed while Claude was busy waited in Claude Code's queue and was written as an ordinary prompt line once the turn ended, 0.15 s before its reply.
- An interactive session asks before some tool calls. In one run it asked before reading `notes.txt`, the answer typed in the terminal, and the transcript went on with the call and its result.
- `claude -p --resume <id>` appended to the same file, under the same session id, with no line repeated.
- Every line of one assistant message carries the message's `stop_reason`, its thinking line included. In the coordinator's own interactive transcript of 5,694 assistant lines, the 221 lines that hold a text block and `end_turn` match its 221 `turn_duration` lines one for one. Headless transcripts have no `turn_duration` line.
- A subagent writes to `<session id>/subagents/agent-<id>.jsonl`, beside `agent-<id>.meta.json`, whose `toolUseId` names the Agent call that started it.
- A person's own prompts are `user` lines with `turnOrigin` `human` when typed in the terminal, and `sdk` when given to `claude -p`, which Claude Code also marks with `entrypoint` `sdk-cli`. Background task notices, another session's messages (`turnOrigin` `peer`), compaction summaries and Claude Code's caveats are `user` lines too, told apart by `origin`, `turnOrigin`, `isCompactSummary` and `isMeta`.
- `~/.claude/sessions/<pid>.json` lists each running interactive session with its `cwd`, session id and `busy` or `idle`.

### What the hooks showed

- With hooks in `<folder>/.claude/settings.local.json`, a headless run fired SessionStart, UserPromptSubmit with the prompt, PreToolUse and PostToolUse with the tool's input and output, Stop with `last_assistant_message`, and SessionEnd. An interactive run fired the same, after the folder's trust dialog was accepted.
- No hook carries Claude's thinking, or the text it writes between tool calls. A hook gets `transcript_path`, so a full record from hooks still means reading the transcript.
- A session started in a subfolder of a plain folder fired no hooks at all. In a git repo, hooks at the repo's root fired for a session started in a subfolder.
- A hook is a process Claude Code waits for. A Node hook took 40 ms (median of 10 runs), and each tool call runs two, so about 80 ms per tool call. A hook that fails shows its error in the person's session.
- `git status` stayed clean with the hooks file in a repo, but only because this Mac's global gitignore covers `.claude/settings.local.json`.

### The choice: the daemon reads the transcripts

- **Nothing changes for the person.** They start Claude Code as they always have. Nothing is written into their folder or their Claude Code settings, and nothing runs inside their session, so the record can't slow it or break it.
- **The transcript is the whole session.** It has the prompts, the thinking, every block of text, every tool call and result, and the subagents. Hooks would give part of that and the transcript's path for the rest.
- **It works from any subfolder,** in a git repo or not.

What reading transcripts costs:

- **The format is Claude Code's own.** It isn't documented and it changes between versions. 2.1.299 writes more than 20 kinds of line. The daemon parses each line with a schema in which every field but the type is optional, and a field whose type changes in an update reads as absent rather than losing the line, maps the few kinds that make the conversation, and ignores the rest. `test/step21.ts` runs the real CLI, so a change in the format fails a check rather than going quiet.
- **A headless session lands when it ends,** since `claude -p` writes its transcript at exit. An interactive session lands within about a second of each line.
- **No live typing.** The record gets whole messages, never the tokens as Claude writes them.
- **A closed terminal looks like a running session** when it closes mid-turn, since the transcript doesn't say the process ended. `~/.claude/sessions/<pid>.json` could tell, and isn't used yet.
- **A read every second.** Each read lists the transcript folders named like a connected folder.

What hooks would have cost: a settings file written into each connected folder or into the person's own settings, sessions in subfolders of plain folders missed, about 80 ms of waiting per tool call, hook errors shown in the person's session, and the transcript read anyway for the rest of the session.

## Connecting a folder

- `node daemon/folders.ts connect [folder] [--private | --team]` connects the folder, by default the current one. `disconnect [folder]` disconnects it, and no arguments lists what is connected. `--json` prints the answer as JSON. It follows our CLI conventions: an `ok:` line first, `already: true` when nothing changed, and exit codes 0 done, 1 failed and safe to retry, 2 usage, 3 refused.
- It runs on the Mac and calls the API with the daemon's machine token, read from `AGENTS_TOKEN` or `~/.agents-app/daemon.json`. A `daemon.json` that can't be read or isn't a config is an error that names it, not a missing file. No API route lets a person connect a folder, so nobody can make another person's sessions leave their Mac. The app on the Mac connects one through the Mac's own daemon, as "Connecting from the app" says.
- Only a Mac with an owner connects a folder, since the owner is the person whose terminal it is. Boxes are refused.
- The folder is stored as the system gives it back, with links resolved and each name in the case it has on disk, since that is the path Claude Code records. On macOS's case-insensitive volume, a folder typed in the wrong case would otherwise match no transcript, and connect would say ok while nothing landed.
- `connect` prints the transcript folder the daemon reads, `~/.claude/projects/<name>`. When the shell running it sets `CLAUDE_CONFIG_DIR`, it warns that Claude Code started from that shell writes its transcripts elsewhere, and that the daemon under launchd reads `~/.claude/projects` unless its own environment sets `CLAUDE_CONFIG_DIR` to the same folder. Those sessions don't land until it does. It also warns when the transcript folder's name passes 200 characters.
- **The home folder, and any folder above it, can't be connected.** A person's home holds every project they have, so connecting it would send every session they start under it. `connect` refuses it with exit 3. The API can't tell where a Mac's home is, so something that holds the machine token can still connect one through it. The daemon reads no session in such a folder, and says so in its log, whoever connected it. A project inside the home folder connects as usual.
- A folder connected again keeps its row, and only sessions started after the new connection land.
- **Who sees a folder's sessions changes only when the person says so.** A folder is the team's when first connected, and `--private` keeps its sessions to the person. Connecting it again keeps whichever it is, unless `--private` or `--team` says otherwise, so a bare `connect` never shows the team a private folder's sessions. `--team` on a private folder prints how many of its sessions already in the record the team now sees. Both flags together are a usage error.

## Connecting from the app

Tayler asked for a way to connect a folder from the app, with no script to paste into a terminal. On a Mac, a person does it in the Agents desktop app.

- **The page.** The sidebar's Terminal folders link opens `#/folders`. In the desktop app it lists the folders Claude Code ran in on this Mac, newest first by when each folder's newest transcript changed, and any folder connected on this Mac that Claude Code hasn't run in since. Each folder has one control with three choices: Off, Team and Just me. Choosing one connects, changes or disconnects the folder, and the row then says what happened, with how many sessions a change to Team showed the team and any warning that will keep the folder's sessions from landing.
- **Folders set apart.** Folders inside the system's temporary folders, `/tmp`, `/var/folders` and the daemon's `TMPDIR`, sit in a collapsed group, since tools and checks start Claude Code there by the hundred. On the Mac this was built on, 361 of the 393 folders Claude Code ran in that still exist are there. A folder inside a connected one says its sessions land through that folder. The home folder, and a folder above it, say why they can't be connected, and their Team and Just me can't be chosen. Folders connected on the person's other machines are listed apart, read only.
- **In a browser** the page lists the person's connected folders, each with who sees its sessions and its machine, and says to open the Agents app on the Mac it is on to change them.
- **How the page reaches the daemon.** `desktop/preload.cjs` gives the page `window.agentsMac`, with three calls: list, connect and disconnect. `desktop/main.cjs` passes each to the daemon's socket, `$AGENTS_HOME/run/app.sock`, as HTTP, and `daemon/app-socket.ts` answers it.
- **Only that macOS user can open the socket.** It sits in a folder of its own with mode 0700, and is 0600 itself. macOS refuses a connect without search permission on the folder or without write permission on the socket, and the check shows each by taking it away from the owner. root can still open it.
- **The page's code comes from the team's server,** so the bridge refuses two things. `main.cjs` answers only the server's own page, by its frame's origin, so a page the window was sent to on another site gets a refusal. A connect or disconnect goes through only while `navigator.userActivation` says the person clicked or pressed a key on the page in the last 5 seconds, so the page's code can't connect a folder on its own.
- **One copy of the rules.** The socket calls `connectFolder` and `disconnectFolder` in `daemon/folders.ts`, the functions the folders command calls, so the home folder refusal and the API's rules hold the same either way. The app always names who sees a folder's sessions, so a folder connected from the app is the team's only when its person chose Team. No API route connects a folder for a person.
- **What stays on the Mac.** The daemon reads the list on the Mac, from each transcript folder's newest transcript, as far as the line that says where its session started, and gives it to the app on the Mac and nowhere else. A folder's name reaches the API only when its person connects it. The daemon asks the API only for this Mac's connected folders, and `GET /v1/instance/folders` also returns the Mac's own id, so the page can tell this Mac's folders from those on other machines.
- **Failures.** With the daemon down, the page says it can't reach the daemon and names the socket. A daemon that crashed leaves its socket's file behind, and the next one removes it before it listens. A socket path longer than the 103 bytes macOS keeps is reported in the daemon's log and not served, since macOS would cut it short and the app would never find it. An ask larger than 64 KB is refused.

## What leaves the Mac

The daemon follows the `connected_folders` shape for its machine. Every second it lists the transcript folders whose names start like a connected folder's name. For each transcript there it reads only as far as the first line that gives `cwd`, `timestamp` and `sessionId`, and decides:

- **A session's subagents are found in its own folder.** Each read lists `<session id>/subagents` beside a tracked transcript, and reads those transcripts with it. It never goes through the other sessions the daemon keeps, nor visits an entry whose file Claude Code's cleanup has removed.
- **A start is looked for in steps.** A transcript Claude Code has not yet written that line to, or whose line is longer than the first read, is searched on from where the last read ended, in memory, and not from its first byte on every read. A start that has not turned up in the first 1 MiB is passed over for good. Measured on 2026-10-14 over the 9,408 transcripts on the Mac this was built on, the line ends within the first 64 KB for 82%, within 206 KB for 99%, and the latest ends at 569 KB.
- **The session belongs to the deepest connected folder its `cwd` is inside.** A sibling such as `/a/repo-old`, whose transcript folder name starts like `/a/repo`'s, is not inside `/a/repo`, and its transcript is passed over for good.
- **It must have started after the folder was connected.** A session started earlier stays on the Mac, even if it is resumed later. A time that doesn't parse never counts as after.
- **The daemon's own sessions never count.** Anything whose `cwd` is inside `~/.agents-app` is an app session, which reaches the record as an agent's.
- **A transcript is named after its session.** One whose lines name another session, as a copied file's can, stays on the Mac, and the daemon's log says so. Otherwise its lines would write into that session, which can be another folder's.

A session that passes all three gets its record session from the API, which checks again that `cwd` is inside the folder. From then on the daemon sends each new line, in posts of at most 200 lines whose encoded size stays under the API's 20 MiB limit, reading the transcript 64 KB at a time and handing each line over as soon as it is whole, so a long backlog is never held in memory, and keeps how far it got in `~/.agents-app/terminal-sessions.json`. A restart goes on from there, and losing that file only costs a reread, since the record skips any line it already has.

**A tool result for a path outside the connected folder stays on the Mac.** A tool call's input names a path in `file_path`, `path` or `notebook_path`. When that path is not inside the connected folder, the call's result becomes the note "A result for a path outside the connected folder stays on the Mac.", in the event and in the raw line. The call stays, so the record shows what Claude tried to read. The path is judged where it points. `~` is the home folder, a relative path starts at the session's own folder, `..` is followed, and so is a link inside the connected folder that leads out. The daemon saves the ids of the calls it holds results back for with the transcript's offset, so a result that arrives after a restart is held back too. A call's id leaves the list when its result arrives. Not covered: what a Bash command prints from a file outside the folder, a tool that names its path in another field, and the input of a call that writes a file outside the folder.

**One bad session, line or file stops nothing else.**

- Each transcript, and each folder of transcripts, is read on its own. One that fails 3 reads in a row, such as a file the daemon may not open, is parked until the daemon starts again, and the daemon's log says why. Taking a session up counts the same, whatever fails there, except the API being out of reach or failing, which is tried again on the next read. A file removed between listing and reading it, as Claude Code's cleanup does, is skipped without a word.
- A post the API fails, or that never reaches it, is tried again on a later read, after 1 s, then 2, 4 and so on up to a minute, while every other session goes on. After 10 failures in a row that the API answered, about four minutes of them, the session is parked too. A post that never reached the API doesn't count, since an API that is down holds every session alike.
- **A transcript cut short or rewritten is read again from its start.** The daemon saves the file's inode and its first uuid with the offset. The first uuid is looked for as far in as the start line is, since Claude Code's first lines run past 64 KB in 18% of the transcripts on the Mac this was built on. When the inode changes, the file is shorter than the offset, or its first uuid differs, the session is taken again from line one, and the record skips the lines it already has.
- **No line is lost.** The offset moves past a post's lines only once the record has them. A post the API refuses keeps its lines and parks the session, with the API's answer in the daemon's log, so a daemon started again sends them. A 409 is the one exception: the session's folder was disconnected since it started, so the daemon stops sending it. A line too big for one post parks its session too. Lines that don't parse are counted in the log.
- The scrubber takes NULs out and makes a lone surrogate U+FFFD, in keys as well as values. Postgres refuses either, and the whole post would fail.

Disconnecting a folder stops its sessions at once. The daemon forgets them, and the API refuses their events from then on. A folder connected again starts over, so this holds after the reconnect too. The daemon saves the folder's `connected_at` with each session it takes, and drops one whose folder's `connected_at` has changed since, which catches a disconnect it missed while it was stopped. The API refuses the events of a session made before its folder's `connected_at`, as it does a disconnected folder's.

The daemon starts a session only when its first line is no earlier than its folder's `connected_at`, by the Mac's clock, while the API judges it by the server's. A Mac whose clock runs ahead can show the daemon a session that started before a reconnect as newer than it. The API then answers its first post with 409, and the daemon passes that transcript over for good, so it is refused once and not again on every read.

Durability leaves terminal sessions alone where it resumes turns, since a terminal session has no claimed messages, and its fence stops only the harnesses the daemon started. Its watchdog marks a terminal session lost when the Mac stops answering, as it does an agent's, and the next batch the daemon sends sets the status again. That is read from the code, and no check covers it.

## Mapping a transcript to events

The mapping is `transcriptBatch` in `daemon/claude.ts`, beside the mapping for the app's sessions, and both make their blocks into events with the same function. A block is parsed with one schema, a union on its `type`. A text, thinking, tool call or tool result block names the fields the mapping reads and their types. Any other block, and one of those with a field of the wrong type after an update, is a `notice` that keeps the block as written, so it can't make the API refuse the post it is in.

| Transcript line | Event |
|---|---|
| A person's prompt | `user`, authored by the folder's person, and the session is running |
| Text, thinking and tool calls in an assistant line | `assistant`, `thinking` and `tool_call`, as in an app session |
| The last line of a message that ends the turn | also `usage`, which the app shows as the turn's end, and the session is idle |
| Tool results in a user line | `tool_result`, linked to its call by `tool_use_id`, or a note when the call named a path outside the connected folder |
| `[Request interrupted by user]` | `notice` with `body.subtype` `interrupted`, which the terminal page draws as Interrupted, and the session is idle |
| Other user text, such as a task notice or a subagent's orders | `notice`, as the app's sessions record them |
| A `system` line other than `stop_hook_summary` and `turn_duration` | `notice` |
| A subagent's lines | the same, with `parent_tool_use_id` set to its Agent call |
| Anything else, including `attachment` lines and Claude Code's bookkeeping | nothing, and it doesn't leave the Mac |

Each line that makes an event also goes to `raw_events` under its `uuid`, without `toolUseResult`, which is Claude Code's second copy of a tool's result.

## Secrets

- The daemon scrubs a terminal session with the same scrubber and the same secrets as an app session: its environment's secret values, `secrets.json`, the owner's Claude token and the known key shapes. The API scrubs again.
- **The login shell's values.** At start the daemon runs the person's login shell once, `$SHELL -l -i -c`, and reads what it exports. Every value the shell adds to the daemon's environment or changes in it, 8 characters or longer, is scrubbed from everything the daemon sends, app sessions included. The values stay in the daemon's memory and never leave the Mac. The daemon runs under launchd, which never runs `~/.zshrc`, so without this a token exported there would reach the record. If the shell can't be read within 20 s, the daemon says so in its log and sends no terminal session until it starts again.
- **`.env` files.** It scrubs every value of 8 characters or longer in every `.env` file under the connected folder, whatever the value's name, since a name filter misses `REDIS_URL` with a password in it, `MONGODB_URI` and `SMTP_PASS`. Claude reads `.env` like any file, so without this, connecting this repo would send its database password the first time Claude read `apps/api/.env` from the repo's root. The walk skips `node_modules` and `.git`, lists a folder again only when its mtime changed, and reads the files again on every read, so a value added later is scrubbed too.
- **What is left alone.** A path that exists on the Mac, or a list of paths such as `PATH`, says where things are, and scrubbing it would hide every path under it. A value that is part of the connected folder's own path, such as a project's name, is in the record already as the folder's path. Scrubbing either would also put a session's `cwd` outside its folder, and the API would refuse the session.
- **What scrubbing every value costs.** An ordinary word set in a `.env` file or exported by the shell, such as `localhost` or `production`, shows as `[secret:NAME]` wherever it appears.
- The session's `cwd` and Claude's session id are scrubbed too, by the daemon and again by the API, since a folder's or a file's name can hold a secret.
- Images and files never leave the Mac. Every image block becomes `{ "type": "image", "omitted": "Images stay on the Mac." }`, and every block with a base64 `source`, such as a PDF Claude read, becomes `{ "type": "document", "omitted": "Files stay on the Mac." }`, before it is parsed. A screenshot can show a secret no scrubber can read, and nothing can scrub base64.
- Not covered: a secret in a `.env` file inside `node_modules` or `.git`, or in a file with another name, such as `.envrc`. A `.env` file written and read by Claude within the same second, before the daemon's next read finds it, can go out before its values are known.

## The schema

Migration `0013_local_sessions.sql` adds one table and changes `sessions`. `docs/data-model.md` describes both.

- `connected_folders` holds the team, the Mac, the path, who sees its sessions (`team` or `private`), the person who connected it, and when it was connected and disconnected. One row per Mac and path.
- `sessions.folder_id` and `sessions.cwd` are new. `sessions.agent_id` may now be null. One check replaces the old one: a session serves a conversation or a task and has an agent, or it serves a folder and has no agent, task, conversation or workspace, but has a `cwd` and Claude's session id.
- A unique index on the Mac and Claude's session id keeps one record session per terminal session, so a daemon that reads a transcript twice gets the same session back.

## The API

- `GET /v1/instance/folders`, `POST /v1/instance/folders` and `POST /v1/instance/folders/disconnect` list, connect and disconnect the calling Mac's folders.
- `POST /v1/instance/terminal-sessions` gives the record's session for a Claude Code session, the same one each time. It answers 409 when that Claude Code session id is another folder's session on the Mac.
- `POST /v1/sessions/:id/events` takes `user` events from a machine only into a terminal session, and authors them as the folder's person. It refuses `ask` and `answer` events there, since the person answers Claude in their terminal. It refuses with 409 the events of a session whose folder was disconnected since the session started, whether or not the folder is connected again, and the daemon stops sending that session.
- `POST /v1/sessions/:id/interrupt` refuses a terminal session with 409. The daemon reads that session and doesn't run it, so it couldn't stop it.
- A person sees a terminal session when its folder is the team's, or when they connected it. The `sessions` shape takes `of=folders`, there is a `connected_folders` shape, and the events shape and `search_record` follow the same rule.

## The app

- The sidebar lists recent terminal sessions under "From terminals", each named by its folder and marked with whose terminal it ran in. A live one also shows in "Running now", marked "terminal".
- A terminal session opens as its own page, at `#/l/<session id>`. It says "From Tayler's terminal", the folder, the machine and the state, and lists every event the way the session panel does.
- The Terminal folders page, at `#/folders`, lists the person's folders and connects them, as "Connecting from the app" says.

## The check

`test/step21.ts` runs on ports 8100 to 8102, and names its teams `local-<id>`. It drives the real `claude` CLI with `haiku` through the real daemon, API and Electric. Its 50 lines cover:

- The folders command: connect by a path with a link in it, connect again, `--private`, a folder that doesn't exist, a box, the list, disconnect and disconnect again.
- Two turns in the connected folder, the second reading a PNG, and a third after the daemon restarts. The record must match Claude Code's own transcript: every tool call, every reply, both prompts as the owner's `user` events, nothing else authored, no gap in the numbering, and the session idle after its turns.
- A session in a folder inside the connected one, whose agent starts a subagent. The subagent's Read must sit under the Agent call, and its orders must not count as the person's prompt.
- Secrets: the daemon's own, a GitHub-shaped token and a value only the folder's `.env` holds, all in a file Claude reads. None may reach an event or a raw line, and each must show as its `[secret:NAME]`. A `.env.local` link to a file that is gone must not stop the folder's sessions. The picture must arrive only as the note that it stayed on the Mac.
- What stays on the Mac: a session started before connecting, one in `shop-old` beside `shop`, and one started after disconnecting. The private folder's next session shows the daemon read after the disconnect.
- Who sees what: the teammate, the owner and someone on another team, through the sessions and events shapes and `search_record`, and in Chromium on a plain-HTTP name, at desktop and phone width, with an accessibility scan.
- What the API refuses: a session that started beside the folder, an ask in a terminal session, an interrupt from the app, and events after the disconnect.

It runs headless sessions only. macOS `script` can't drive Claude Code's terminal interface from a pipe, and the checks are TypeScript, so an interactive session was typed through `expect` by hand, through the real API and daemon. Its two prompts, the Read call and its result, both replies and both turn ends landed, the first turn while the session was still open.

Every one of the 50 lines went red under a break of what it guards, with each file put back byte for byte after. The build log has the rounds.

### The fast check

`test/step21b.ts` writes Claude Code's transcript lines itself, into a temp folder the daemon reads as `CLAUDE_CONFIG_DIR`, so it needs no Claude. It runs in about a minute and a half, on ports 8110 to 8113, with teams named `local-b-<id>`. The transcript file is where Claude Code hands its sessions over, and everything past it is real: the daemon, the folders command, the API and Electric. It covers:

- A session that lands, with the person's prompt, the tool call, its result, the reply and the turn's end. A result for a path outside the connected folder is a note, whether the path is absolute, climbs out with `..`, starts with `~`, is relative to the session's own folder or runs through a link inside the folder, and one that arrives after the daemon restarted is a note too. A result for a path inside lands. A turn stopped with Esc is a notice with the subtype the terminal page draws as Interrupted, and the session is idle.
- What a machine may write into a terminal session: its `user` event is authored as the person and its `notice` is not, and an `ask` or an `answer` is refused with 400.
- Who sees a folder: a private folder connected again with no flag stays private, `--team` widens it and says how many sessions that shows, and both flags together are a usage error.
- What a session writes while its folder is disconnected, with the daemon stopped through the disconnect and the connect after it: it stays on the Mac, the API refuses it, and the daemon's log shows it never tried. A session from a Mac clock a minute ahead of the server's, closed by a reconnect, is refused once and then passed over. Every session in the check starts exactly at its folder's `connected_at`, so a folder connected again a moment later is newer than all of them.
- One bad session, line or file: a session the API answers with 500, from an event the check puts at its next number, holds up no other folder's session and lands whole once the API takes it. A line with NULs and a lone surrogate lands. A transcript the daemon can't read is parked, with a message, and so is one in a folder that holds a socket named like a `.env` file, whose values the daemon can't read. The check doesn't wait the four minutes it takes to park a session the API keeps failing.
- A transcript replaced by a new file, one cut short in place, and one rewritten in place with a different first line are each read again from the start, and the record takes only the lines it didn't have.
- No line is lost: a post the API refuses with 404 parks its session and a restart sends its lines, three 4.2 MB prompts in three-byte characters land in posts under 20 MiB, lines that don't parse are counted in the log, and a prompt whose fields changed type lands with its raw line as written, and so do a text block, a tool call and a tool result whose fields changed type, each as a notice holding the block.
- The home folder: `connect` refuses it and the folder above it with exit 3 and takes a project inside it, and a home folder connected straight through the API is never read, while a project inside it still is.
- How much of a transcript the daemon reads, seen through `test/read-meter.ts`, which the check loads into the daemon and which counts the bytes read from each file and the biggest buffer a read was given. A backlog of 24 MB is read in chunks, with no buffer over 1 MiB, and an old transcript of 3 MB is read as far as its first 64 KB, where the start line is. A transcript rewritten in place after a first line of 100 KB is read again from its start. A transcript with no start line yet, 300 KB of lines that name no folder, is read through once over four reads, not four times. A daemon whose state holds 40,000 entries for subagent transcripts that are gone, with nothing to read, uses under 1.5 s of CPU in eight seconds, where each of those entries cost a failed look at its file on every read.
- The folders command: a folder typed in the wrong case is stored in its case on disk and gets its sessions, connect prints the transcript folder the daemon reads, and it warns when the shell sets `CLAUDE_CONFIG_DIR`.
- A transcript whose lines name another folder's session writes nothing into it, and the daemon says why. The API refuses that session id for another folder.
- Secrets: a value only `apps/api/.env` holds, read from the folder's root, `REDIS_URL`, `MONGODB_URI` and `SMTP_PASS`, a PDF, a value only the login shell exports, and a folder and a session id named with a secret, from the daemon and from the API. A path and the folder's own name are left alone. A daemon that can't read the login shell sends no terminal session.

### Connecting from the app

`test/step21c.ts` writes Claude Code's transcripts into a stand-in home folder, in the checkout's ignored `.scratch/`, since the page sets apart folders in the system's temporary folders. It runs the real API, daemon and Electric, drives the Electron app, and opens the page in Chromium, Firefox and WebKit at desktop and phone width. It runs in about 35 seconds, on ports 8120 to 8123, with teams named `mac-connect-<id>`. Its 34 lines cover:

- The socket: its modes and owner, another process of the same user reaching it, and macOS refusing a connect once the owner loses search permission on its folder or write permission on it.
- The page in the desktop app: the sidebar link, the folders newest first, a temporary folder set apart, a folder that is gone and the daemon's own sessions left out, an axe scan, the three choices, and the home folder that can't be chosen.
- Team, Just me and Off, each with what the page says and the row in Postgres. A session started after connecting lands, and the one from before stays on the Mac. A teammate who could open the session's events can't once the folder is Just me. A folder inside a connected one says it lands through it. A session started after Off stays on the Mac while a connected folder's lands.
- What is refused: the home folder and a folder above it, by the daemon, before the API hears of them. A connect from the page's code with no click behind it. A person's request to the folders route. Every call from a page on another site. An ask larger than 64 KB.
- The browser's read-only list in all three engines at both widths, with nothing sideways at phone width and no serious accessibility finding, and the desktop app's page in a window as narrow as a phone.
- A daemon that crashed: the page says it can't reach it, and the next daemon replaces the socket file left behind. A socket path past 103 bytes is reported and not served. With the team's server down, the page keeps its list and says the server did not answer.
- Last, every table in Postgres and the API's log are searched for the names of three folders never connected, and none holds them.

Playwright counts each of its own queries of a page as a click for 5 seconds, so the line about a connect with no click behind it asks from Electron's main process, once the page shows no recent click. No check can play another macOS user without root, so the socket lines show the modes, and that macOS enforces them, with the owner.

## Tayler's calls

Tayler made these on 2026-10-14. `docs/decisions.md` has them.

1. **The team sees a connected folder's sessions by default,** and `connect --private` keeps them to the person who connected it, with agents' search leaving them out. As built.
2. **Tool results for files outside the connected folder stay on the Mac.** As built, for the tools that name a path in `file_path`, `path` or `notebook_path`.
3. **Sessions started before a folder was connected stay on the Mac,** and so do the ones started while it was disconnected, even when resumed later. As built.
4. **Images stay on the Mac,** with a note in the record that one was there. As built, and files sent as base64 stay too.
5. **The daemon learns the secret values in the person's login shell at start,** and they never leave the Mac. Built, as Secrets says.

## Not done

- No check sees a terminal session in "Running now". A headless session lands only when it ends, idle by then, and no check drives an interactive one.
- Sessions started in a connected folder through Codex.
- Telling a closed terminal from a running session.
- The cost of a terminal session. Claude Code writes it in `cost-state` lines, which aren't read.
- The page in the desktop app runs code the team's server sends, so a server that sent other code could read the list of this Mac's folders, and could connect one in the 5 seconds after any click on the page. The bridge refuses pages from other sites and changes with no click behind them, and nothing more.
- Choosing Team for a folder that was Just me shows the team the sessions already in the record from it, as `--team` does, and the page says how many after. It doesn't ask first.
- No check plays another macOS user. root can open the socket.
- The list reads each transcript folder's newest transcript every 10 seconds while the page is open, on the daemon's one thread. On the Mac this was built on, 507 transcript folders, 387 of them listed, took 840 ms the first time and about 60 ms once the files were cached.
- Two folders whose transcript folder names come out the same, such as `/a/b-c` and `/a/b/c`, list as the one whose transcript is newest.
- agentsctl's desktop app runs with a home folder of its own, so its Terminal folders page finds no daemon socket.
- A daemon from this change needs an API from it too, since the page reads the Mac's id from `GET /v1/instance/folders`.
- A Bash command's output from a file outside the connected folder, a tool that names its path in a field other than `file_path`, `path` or `notebook_path`, and the input of a call that writes a file outside the folder aren't held back.
- The API takes the home folder, or one above it, from anything holding the machine token, since it can't tell where a Mac's home is. `connect` and the daemon refuse it.
- The daemon's state file keeps an entry for every transcript it has taken, including ones Claude Code has since removed, and writes all of them whenever one changes.
- A connected folder whose transcript folder name would pass 200 characters. Claude Code shortens such names, and the reader would miss them. `connect` warns, and no check covers the warning.
