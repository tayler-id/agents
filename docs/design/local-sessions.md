# Terminal sessions in the record

The first goal in `AGENTS.md` is that people keep using their own coding agents on their own computers, and those sessions land in the shared record. Today only the sessions the app starts land there. A Claude Code session a person opens in their own terminal doesn't. This doc covers the first slice of closing that gap. It calls those sessions terminal sessions.

I wrote it before the code, from prototypes run against the real `claude` CLI on this Mac (version 2.1.299), and I update it as the slice lands. "Not done" at the end lists what is missing.

## The slice

A person connects a folder on their Mac once, such as a repo:

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

- Claude Code writes every session, headless or interactive, to `~/.claude/projects/<folder name>/<session id>.jsonl`. The folder name is the path the session started in, with every character other than a letter or a digit made a dash. `~/.no-mistakes` became `-Users-taylerramsay--no-mistakes`.
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

- **The format is Claude Code's own.** It isn't documented and it changes between versions. 2.1.299 writes more than 20 kinds of line. The daemon parses each line with a schema in which every field is optional, maps the few kinds that make the conversation, and ignores the rest. `test/step21.ts` runs the real CLI, so a change in the format fails a check rather than going quiet.
- **A headless session lands when it ends,** since `claude -p` writes its transcript at exit. An interactive session lands within about a second of each line.
- **No live typing.** The record gets whole messages, never the tokens as Claude writes them.
- **A closed terminal looks like a running session** when it closes mid-turn, since the transcript doesn't say the process ended. `~/.claude/sessions/<pid>.json` could tell, and isn't used yet.
- **A read every second.** Each read lists the transcript folders named like a connected folder.

What hooks would have cost: a settings file written into each connected folder or into the person's own settings, sessions in subfolders of plain folders missed, about 80 ms of waiting per tool call, hook errors shown in the person's session, and the transcript read anyway for the rest of the session.

## Connecting a folder

- `node daemon/folders.ts connect [folder] [--private]` connects the folder, by default the current one. `disconnect [folder]` disconnects it, and no arguments lists what is connected. `--json` prints the answer as JSON. It follows our CLI conventions: an `ok:` line first, `already: true` when nothing changed, and exit codes 0 done, 1 failed and safe to retry, 2 usage, 3 refused.
- It runs on the Mac and calls the API with the daemon's machine token, read from `AGENTS_TOKEN` or `~/.agents-app/daemon.json`. No route lets a person connect a folder from the app, so nobody can make another person's sessions leave their Mac.
- Only a Mac with an owner connects a folder, since the owner is the person whose terminal it is. Boxes are refused.
- The folder is stored with links resolved, since Claude Code records the real path.
- A folder connected again keeps its row, and only sessions started after the new connection land.

## What leaves the Mac

The daemon follows the `connected_folders` shape for its machine. Every second it lists the transcript folders whose names start like a connected folder's name. For each transcript there it reads only as far as the first line that gives `cwd`, `timestamp` and `sessionId`, and decides:

- **The session belongs to the deepest connected folder its `cwd` is inside.** A sibling such as `/a/repo-old`, whose transcript folder name starts like `/a/repo`'s, is not inside `/a/repo`, and its transcript is passed over for good.
- **It must have started after the folder was connected.** A session started earlier stays on the Mac, even if it is resumed later. A time that doesn't parse never counts as after.
- **The daemon's own sessions never count.** Anything whose `cwd` is inside `~/.agents-app` is an app session, which reaches the record as an agent's.

A session that passes all three gets its record session from the API, which checks again that `cwd` is inside the folder. From then on the daemon sends each new line, in posts of at most 200 lines and 4 MB, and keeps how far it got in `~/.agents-app/terminal-sessions.json`. A restart goes on from there, and losing that file only costs a reread, since the record skips any line it already has.

Disconnecting a folder stops its sessions at once. The daemon forgets them, and the API refuses their events from then on.

Durability leaves terminal sessions alone where it resumes turns, since a terminal session has no claimed messages, and its fence stops only the harnesses the daemon started. Its watchdog marks a terminal session lost when the Mac stops answering, as it does an agent's, and the next batch the daemon sends sets the status again. That is read from the code, and no check covers it.

## Mapping a transcript to events

The mapping is `transcriptBatch` in `daemon/claude.ts`, beside the mapping for the app's sessions, and both make their blocks into events with the same function.

| Transcript line | Event |
|---|---|
| A person's prompt | `user`, authored by the folder's person, and the session is running |
| Text, thinking and tool calls in an assistant line | `assistant`, `thinking` and `tool_call`, as in an app session |
| The last line of a message that ends the turn | also `usage`, which the app shows as the turn's end, and the session is idle |
| Tool results in a user line | `tool_result`, linked to its call by `tool_use_id` |
| `[Request interrupted by user]` | `notice`, and the session is idle |
| Other user text, such as a task notice or a subagent's orders | `notice`, as the app's sessions record them |
| A `system` line other than `stop_hook_summary` and `turn_duration` | `notice` |
| A subagent's lines | the same, with `parent_tool_use_id` set to its Agent call |
| Anything else, including `attachment` lines and Claude Code's bookkeeping | nothing, and it doesn't leave the Mac |

Each line that makes an event also goes to `raw_events` under its `uuid`, without `toolUseResult`, which is Claude Code's second copy of a tool's result.

## Secrets

- The daemon scrubs a terminal session with the same scrubber and the same secrets as an app session: its environment's secret values, `secrets.json`, the owner's Claude token and the known key shapes. The API scrubs again.
- It also scrubs the values in the `.env` files of the connected folder and of each folder down to where the session started, read again for every post. People keep keys there, and Claude reads `.env` like any file. Without this, connecting this repo would send its database password the first time Claude read `.env`.
- Images never leave the Mac. Every image block becomes `{ "type": "image", "omitted": "Images stay on the Mac." }` before it is parsed, since a screenshot can show a secret no scrubber can read.
- Not covered: a secret that only the person's shell holds, such as a token exported in `~/.zshrc`, and that matches no known key shape. The daemon runs under launchd and never sees that shell's environment.

## The schema

Migration `0013_local_sessions.sql` adds one table and changes `sessions`. `docs/data-model.md` describes both.

- `connected_folders` holds the team, the Mac, the path, who sees its sessions (`team` or `private`), the person who connected it, and when it was connected and disconnected. One row per Mac and path.
- `sessions.folder_id` and `sessions.cwd` are new. `sessions.agent_id` may now be null. One check replaces the old one: a session serves a conversation or a task and has an agent, or it serves a folder and has no agent, task, conversation or workspace, but has a `cwd` and Claude's session id.
- A unique index on the Mac and Claude's session id keeps one record session per terminal session, so a daemon that reads a transcript twice gets the same session back.

## The API

- `GET /v1/instance/folders`, `POST /v1/instance/folders` and `POST /v1/instance/folders/disconnect` list, connect and disconnect the calling Mac's folders.
- `POST /v1/instance/terminal-sessions` gives the record's session for a Claude Code session, the same one each time.
- `POST /v1/sessions/:id/events` takes `user` events from a machine only into a terminal session, and authors them as the folder's person. It refuses `ask` and `answer` events there, since the person answers Claude in their terminal. It refuses a disconnected folder's events with 409.
- `POST /v1/sessions/:id/interrupt` refuses a terminal session with 409. The daemon reads that session and doesn't run it, so it couldn't stop it.
- A person sees a terminal session when its folder is the team's, or when they connected it. The `sessions` shape takes `of=folders`, there is a `connected_folders` shape, and the events shape and `search_record` follow the same rule.

## The app

- The sidebar lists recent terminal sessions under "From terminals", each named by its folder and marked with whose terminal it ran in. A live one also shows in "Running now", marked "terminal".
- A terminal session opens as its own page, at `#/l/<session id>`. It says "From Tayler's terminal", the folder, the machine and the state, and lists every event the way the session panel does.

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

## Calls for Tayler

1. **Who sees a connected folder's sessions.** The default is the whole team, since connecting the folder is the opt-in. `connect --private` keeps a folder's sessions to the person who connected it, and agents' search leaves them out. Should private be the default instead?
2. **Everything a connected session does is sent, including files outside the folder.** If Claude reads `~/.ssh/config` from a session started in a connected repo, the scrubbed contents land in the record. The rule "nothing from outside a connected folder leaves the Mac" is held at the level of sessions. Should the daemon also drop tool results for paths outside the folder?
3. **Sessions started before connecting stay on the Mac,** and so do the ones started while a folder was disconnected, even when resumed later. Should connecting a folder send its earlier sessions too?
4. **Images stay on the Mac.** The record says an image was there. Should screenshots be sent once the screen privacy rule for boxes covers them?
5. **Secrets only the person's shell holds aren't scrubbed** unless they match a known key shape. The daemon could read the login shell's environment once at start. Is that worth doing?

## Not done

- No check sees a terminal session in "Running now". A headless session lands only when it ends, idle by then, and no check drives an interactive one.
- Sessions started in a connected folder through Codex.
- Telling a closed terminal from a running session.
- The cost of a terminal session. Claude Code writes it in `cost-state` lines, which aren't read.
- Connected folders aren't listed in the app. The command lists them on the Mac.
- A connected folder whose transcript folder name would pass 200 characters. Claude Code shortens such names, and the reader would miss them.
