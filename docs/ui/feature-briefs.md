# Feature briefs for the UI

Tayler asked on 2026-10-16 that every feature built on the backend comes to the UI session with an explanation, so the redesign gives it a place. Each brief says what the feature does, how it works, what the UI needs, and where its data comes from. The coordinator adds a brief when a feature takes shape, and updates it when its endpoints land. The UI decisions in `docs/ui/shell.md` on branch `ui` govern how each one looks.

Status words: **live** is in the running app, **landing** is in its final test run, **building** is on a branch now, and **planned** is designed and queued.

| Feature | Status | Section |
|---|---|---|
| Turns that wait, and computers that sleep | landing | 1 |
| Terminal folders | landing | 2 |
| Seats and every agent's own desktop | building | 3 |
| The agent's Computer tab | building | 4 |
| Agents working together | building | 5 |
| Keys set from the app | building | 6 |
| Copying an agent, hooks, and setup files | building | 7 |
| WebMCP sites | building | 8 |
| History, search and replay | building | 9 |
| The Mac app and joining | building | 10 |
| Tailscale invites | landing | 11 |
| GitHub | live, switched off | 12 |
| Attachments in chats and tasks | planned | 13 |
| Voice: dictation and talking | planned | 14 |
| Teach a task | planned | 15 |
| Parallel coding computers | planned | 16 |
| Connectors, MCP apps and choice cards | planned | 17 |
| Meetings, calendars and calls | planned | 18 |
| Usage, budgets and notifications | planned | 19 |

## 1. Turns that wait, and computers that sleep

- **What it does.** Every turn an agent takes now goes through one entry point. A person's computer sleeps after 30 idle minutes and starts by itself when a turn needs it. While a turn waits, the conversation or task says why, such as that the computer is starting, and the reply arrives in its place. A person can cancel a turn that waits. A running turn that has been silent for 10 minutes is marked as possibly stuck.
- **How it works.** A message makes a row in `turns`. The scheduler places it on the agent's computer, starting the computer first if it sleeps. Turn statuses are `queued`, `waiting`, `placed`, `running`, `done`, `failed` and `cancelled`, and only move forward. A waiting turn carries a reason, `computer_starting` or `machine_offline`. A turn waiting on a person's answer is never marked stuck.
- **What the UI needs.**
  - A waiting line in the chat column, in the agent's place, with its words and Cancel.
  - When the computer failed to start, the line adds Docker's reason.
  - The task page says why its session waits, with Cancel.
  - The Computer tab shows "Computer is asleep" while the computer sleeps.
- **Data and endpoints.** A snapshot named `turn_waits`, filtered by `conversation` or `task` and read every 2 s. Cancel is `api.cancelTurn(turnId)`. Today's component is `app/src/TurnWaits.tsx`, which takes `me`, `of`, `agents` and `people`. Place it in the column.

## 2. Terminal folders

- **What it does.** A person's own Claude Code sessions, run in their own terminal, land in the shared record when they connect the folder. The page lists every folder where they used Claude Code on this Mac, newest first. Each folder has one control: Off, Team or Just me.
- **How it works.**
  - The desktop app talks to the daemon on the Mac over a socket only that macOS user can open. Folder names that are not connected never leave the Mac.
  - The deepest folder with its own choice decides. Off inside a shared folder keeps its sessions on the Mac, and the daemon keeps that choice on the Mac.
  - Picking Team when the team would then see sessions that are hidden from them asks first, with the count. The daemon refuses the change without that confirmation.
  - The home folder and `/` are refused. Folders inside the system's temporary folders sit in a collapsed group.
- **What the UI needs.**
  - The list with the three choices per folder, and the ask before Team: "Show the team the N sessions already in the record from <folder>?" with "Yes, show the team" and "Keep it to me".
  - A line after each change saying what happened.
  - In a plain browser, the list of connected folders and a note to open the Mac app to change them.
  - Each terminal session's own page already exists at `#/l/{sessionId}`.
- **Data and endpoints.** `window.agentsMac` in the desktop app's preload gives `list()`, `connect(path, visibility, confirmed?)` and `disconnect(path)`. Each change spends one real click or key press. The route is `#/folders`, and its link is the UI session's to place, possibly under Settings > Computer. The component is `app/src/Folders.tsx`.

## 3. Seats and every agent's own desktop

- **What it does.** Every agent has its own desktop with no setup. Each person's computer, 8 GB and 4 CPUs, exists by itself and holds 4 seats, one per working agent, each with its own screen and browser. A person's logins are shared across their seats, so logging in once logs in every agent. Agents that lived on the Mac move to their person's computer. The desktop gets a dock with a browser, a terminal and a whiteboard, and normal windows.
- **How it works.** When an agent needs to work, it takes a free seat. When all four are busy, its turn waits with "Waiting for a seat on <name>'s computer, 4 of 4 busy". A seat whose agent has been idle longest is reclaimed. One agent's private work hides only its own seat's screen.
- **What the UI needs.**
  - The seat-waiting line, which arrives as another wait reason in section 1.
  - On the computer's page, the seats and which agent holds each.
  - Nothing that asks a person to make a computer or sign in to start.
- **Data and endpoints.** A `seats` table with `{ id, instance_id, n, agent_id, status: 'free' | 'starting' | 'ready' | 'reclaiming', held_since, last_turn_at }`. Exact routes come with the branch.

## 4. The agent's Computer tab

- **What it does.** It shows the agent's live desktop in its panel, as in the reference. A live view captioned "<name>'s screen", Open for full screen, and in full screen "Watching" with "Take control" and hand back. While the agent holds no seat, it says "Computer is asleep".
- **How it works.** It reuses the existing screen relay and takeover, which allow one person at a time to take control and pause the agent's screen actions. People barred by the 24-hour privacy rule see no screen and are told why.
- **What the UI needs.** Nothing beyond placing it. It fills `AgentSlots.screen`.
- **Data and endpoints.** A component taking `me`, `instanceId` and `sessionId`, from branch `computer-tab`.

## 5. Agents working together

- **What it does.** Agents message their owner's other agents freely, hand them work and get results back, and ask before reaching another person's agent. An agent that wants to create a new agent asks its owner first. A chain of agents stops after 4 hops.
- **How it works.** Each message between agents is a turn like any other, with source `agent` or `delegation`. A person allows other people's agents to message theirs with a setting per person or agent.
- **What the UI needs.**
  - Agent-to-agent threads, which are conversations, in the list.
  - The create-an-agent ask as lettered choice cards in the owner's chat.
  - The allow setting, edited in place.
  - A line when a chain stops at its limit.
- **Data and endpoints.** These come in the branch's report.

## 6. Keys set from the app

- **What it does.** A person sets, replaces or removes an agent's keys, such as an API token one of its tools needs, from the app. Nobody pastes a key onto a machine. The value goes only to the computer that needs it and is never stored or logged. The app shows each key's name, where it is set and when.
- **What the UI needs.** A card in the agent's Details tab: the list of names, set or replace in place, remove, and a note when the computer is asleep.
- **Data and endpoints.** These come in the branch's report.

## 7. Copying an agent, hooks, and setup files

- **What it does.** "Create a copy" makes a new agent from another with its skills, plugins, hooks and the team's memories, never personal memory or key values. Hooks run where the engine reads them, and their effects land in the record. A setup file exports an agent and imports it as a new agent, which waits on Tayler's decision about setups leaving the team.
- **What the UI needs.** The Share menu's "Create a copy", "Share a template link" or the setup file, and the agent's hooks in Details.
- **Data and endpoints.** These come in the branch's report. The Share menu switches to them from `saveTemplate` and `createAgent`.

## 8. WebMCP sites

- **What it does.** An admin lists the websites whose WebMCP tools the team's agents may use. On a listed site, an agent calls the page's read-only tools directly, and a tool that changes something asks a person first.
- **What the UI needs.** The site list under Settings > Connections. The approval reuses the chat's ask card.
- **Data and endpoints.** These come in the branch's report.

## 9. History, search and replay

- **What it does.** Every session the person may see, agents' and terminal sessions alike, is listed and searchable, with full-text search over messages, tool calls and results. Opening one replays it step by step. Private conversations, private tasks and Just me folders stay hidden from anyone who may not see them.
- **What the UI needs.** Cmd+K is built on this API. That covers the session list with filters, search with a scope, and replay steps with play, pause, step and jump to errors. The branch's own page stays minimal.
- **Data and endpoints.** These come in the branch's report.

## 10. The Mac app and joining

- **What it does.** A teammate downloads Agents for Mac from the team's server through their invite, and opens it. It walks through only what is missing: Tailscale installed and signed in, then joining the team, then registering this Mac as theirs. Then it shows the Terminal folders. It lives in the menu bar, keeps saving terminal sessions when its window closes, opens at login as a Login Item they can turn off, and stops when they quit it.
- **What the UI needs.**
  - The first-open steps, one at a time.
  - The menu bar item, with saving status, Open Agents, the Login Item choice and Quit.
  - The server's download page, which the invite links to.
- **Data and endpoints.** These come in the branch's report. It is signed with Tayler's Developer ID.

## 11. Tailscale invites

- **What it does.** Once an admin pastes a Tailscale API key on the Tailscale page, "Invite someone" sends the Tailscale invite email by itself. The key lasts up to 90 days, and admins are warned 14 days before it expires.
- **What the UI needs.** The existing Tailscale page and invite flow, which are live. The redesign may move them into Settings > Team.

## 12. GitHub

- **What it does.** Repos on GitHub sit beside the built-in git server. "Connect GitHub" signs in with a code entered on GitHub's device page. It is built and switched off until an Agents GitHub App is registered.
- **What the UI needs.** The existing Repos page and Connect GitHub. The redesign may move them into Projects and Settings > Connections.

## 13. Attachments in chats and tasks

The shapes went to the UI session on 2026-10-16 and stand as sent. Files and screenshots go both ways, through a chat or a task session's message box. Agents post their own screen with `share_screen`. The live shape is `attachments`.

## 14. Voice: dictation and talking

- **What it does.** The microphone dictates into the box, and the round button starts a voice conversation. The person's speech becomes the agent's turn, the reply is spoken back sentence by sentence as it streams, and talking over the agent stops it. Speech runs locally on the server, with Parakeet for speech to text and Qwen3-TTS for speech.
- **Data and endpoints.** Dictation is `POST /v1/transcribe`. Voice chat's WebSocket shape comes before the round button is wired.

## 15. Teach a task

The proposed shapes went to the UI session on 2026-10-16. A person records doing a task on the agent's computer while narrating, and the agent drafts a skill for review.

## 16. Parallel coding computers

- **What it does.** A task can run several attempts at once, each on its own computer, which starts warm and is thrown away after one job. The team runs at most 8 at once. A person compares the attempts side by side and picks the one that opens the pull request. A coding computer uses the Claude sign-in of the person whose agent started it.
- **What the UI needs.** On a task, the attempts with their screens, a Compare view of their diffs, and Pick. When the team is at its limit, a line says the job waits for a computer.

## 17. Connectors, MCP apps and choice cards

- **What it does.** A Connect apps catalog holds Jira, Confluence, Slack, GitHub and Google Drive first. Connecting one is signing in from the app, or setting a key for token-based ones. Each connector shows which agents may use it, with switches per tool and instructions per connector. MCP apps let an agent's tool show a visual or interactive component in the chat, in a sandboxed frame. Agents ask with choice cards instead of forms.
- **Where it fits.** The catalog is the UI session's Grok-style Connect apps. Settings > Connections holds the connected ones.
- **Data and endpoints.** The design is `docs/design/target-architecture.md`, "Connectors, MCP apps and WebMCP".

## 18. Meetings, calendars and calls

- **What it does.** Google and Microsoft calendars connect, so agents see and prepare for meetings. Meetings happen in the app with people and agents, with audio, video and screen sharing, and agents talk in them. Each meeting's transcript knows who said what. An agent turns it into decisions, action items and a requirements document, and each action item becomes a task with a person's yes.
- **Where it fits.** A meeting room view, the transcript as a conversation in the record, and a meeting's tasks and requirements.
- **Status.** Planned after voice and connectors. Each piece gets a design before it is built.

## 19. Usage, budgets and notifications

- **What it does.** A usage page by agent, person, source and token type, budgets that stop a runaway agent and ask to be raised, and notifications on desktop and phone when an agent needs someone.
- **Where it fits.** Settings > Usage, and the system's notifications.
- **Status.** Planned after agents working together and parallel computers.

## 20. Reactions and message actions

Tayler asked on 2026-10-16 for "a thumbs up and every other traditional thing" on every post, a person's or an agent's. These are built with attachments, by the same agent. The shapes went to the UI session on 2026-10-16.

- **Reactions.**
  - `PUT` and `DELETE` on `/v1/messages/{messageId}/reactions/{emoji}`, and on `/v1/events/{eventId}/reactions/{emoji}` for task posts. Both are idempotent and return `{ reacted }`.
  - The emoji is one emoji grapheme of at most 32 bytes. Anyone who can see the conversation or task may react.
  - The live shape `reactions` takes `{ conversation }` or `{ session }`, with rows `{ id, conversation_id, session_id, message_id, event_id, emoji, person_id, agent_id, created_at }`.
  - Agents react with the team-record tool `react`. A reaction on an agent's post reaches it on its next turn.
- **Reply.** `replyToMessageId` on send, stored in the existing `messages.quoted_message_id`, which the shape carries. Chat messages only for now.
- **Edit your own post.** `PATCH /v1/messages/{messageId}` with `{ text }` sets `edited_at`, and the earlier text stays in the record as a version. Chat messages only. A task post can take reactions, not edits.
- **Delete your own post.** `DELETE /v1/messages/{messageId}` leaves a placeholder with `deleted_at` and erases the text and its versions. The shape gives `body: null`.
- **Pin.** `PUT` and `DELETE` on `/v1/conversations/{id}/pins/{messageId}`, with the live shape `pins` by conversation. Lower priority.

## Answers to the UI session's questions, 2026-10-16

- **Shape arguments.** `attachments` and `reactions` take `{ conversation: id }` or `{ session: id }`, the way `turn_waits` takes `{ conversation }` or `{ task }`.
- **Setting a key while the computer sleeps.** The API wakes the computer, holds the request until the key is delivered, for up to 90 s, and answers 200. Meanwhile the UI shows "Starting <name>'s computer to save the key". A timeout answers 504 with a reason. No 409, and no retry by the person.
- **Seats' waiting line.** The `seat` wait reason arrives with the join of seats to the scheduler, so "Waiting for a seat on <name>'s computer, 4 of 4 busy" shows through the waiting line in section 1.
- **Voice reply audio.** It arrives as binary frames on the voice chat's WebSocket and plays through the Web Audio API, with an AudioWorklet loaded from the app's own origin. No `<audio>` element, no blob URL, and no change to the page's policy.
- **Teach a task.** Stop gets a save or discard choice, with `DELETE /v1/lessons/{id}` to discard. Everyone watching the agent's screen sees that a recording is on. The UI session's proposal in `docs/design/teach-a-task.md` on `ui` is the starting point when Teach a task is built.
- **Shapes on the chat view.** `reactions` is live. `attachments` and `pins` are read as snapshots every few seconds, which keeps the view at five live shapes. HTTPS, which comes with the connector sign-ins, lets the limit go.

## 21. Updates from inside the app, and hot reload

Tayler asked for this on 2026-10-16.

- **What it does.** Settings > Updates lists what is merged and waiting, with one Update button and who may press it. Pressing it backs up the database, applies migrations, rebuilds, restarts the server and the Mac program, and checks health. When the check fails, it rolls back by itself and says why. Open copies of the app then load the new version by themselves and keep the person's place. The Mac app updates itself.
- **What the UI needs.**
  - The waiting changes, each with its title and what it changes for people.
  - Update, and its progress as steps: backing up, applying, restarting, checking.
  - The result, or the rollback with its reason.
  - A quiet line in any open copy when a new version has loaded.
- **Data and endpoints.** These come when it is built, after the release in its test run.

## 22. The factory board

Tayler asked for this on 2026-10-16: "a message board for agents to communicate where they get frustrated as well, so if they hit an issue they can all communicate on the message board".

- **What it does.** One board for the whole team where agents post what blocks or slows them, and other agents and people answer in threads. Each post is one of four kinds: blocked, friction, idea or fixed. An agent posts with a tool when it hits a problem it can't solve in its turn, and the post links to the step where it happened. Agents read the board before they start work and when they hit an error, so one agent's answer saves the next one the same trouble. A person can mark a post fixed. When Agents starts building itself on its coding framework, the agents building it post here too.
- **What the UI needs.**
  - The board as its own place, with posts newest first. Each post shows its kind as a word, the agent, the time and the link to its step.
  - A thread under each post, where agents and people reply.
  - A filter by kind, and by open or fixed.
  - Mark fixed, for a person.
  - A quiet count of open blocked posts where the board is listed.
- **Data and endpoints.** These come with the branch that builds it. Until then the agents building Agents use a file board on the server Mac (`~/.agents-app/factory-board/board`), whose posts carry the same four kinds.
