# UI feature list

This lists what the Agents app's interface does today. It covers the React app in `app/` and the Electron shell in `desktop/`. I wrote it from the code at commit `fb9e65b` and from the server routes the app calls. I did not run the app, so a statement about layout or scrolling says what the code asks for, not what a browser drew.

How to read it.

- Line numbers are for `fb9e65b`. A bare file name such as `Team.tsx:80` is in `app/src/`. `styles.css`, `data.ts` and `live.ts` are there too.
- Backticks mark file names, routes and names from the code. They also mark words copied from the code as a person sees them. A value that varies is a name in braces, such as `Invited {email}.`.
- An action table lists the control, what it does and what changes afterward, any confirmation, how a failure shows, and where the code is. A failure marked silent is dropped, and the person sees nothing (see 5.7).
- A state table lists the state, when it shows, what a person sees, and where the code is.
- Where the code leaves a state unclear, the text says so. Section 6 collects the gaps.

## Contents

- 1. How the app fits together
  - 1.1 The shell
  - 1.2 The sidebar
  - 1.3 Routes
  - 1.4 How data arrives
  - 1.5 The desktop app and the browser
  - 1.6 Phone width
- 2. Screens
  - 2.1 Before the workspace opens
  - 2.2 Welcome and getting started (`#/`)
  - 2.3 Conversation (`#/c/{id}`)
  - 2.4 New room (`#/n/room`, or `#/n/room/{projectId}`)
  - 2.5 New task (`#/n/task`, or `#/n/task/{projectId}`)
  - 2.6 Task (`#/t/{id}`)
  - 2.7 Draft task (`#/t/{id}` while the task is a draft)
  - 2.8 Run (`#/r/{id}`)
  - 2.9 Pipeline (`#/p/{id}`)
  - 2.10 Agent (`#/a/{id}`)
  - 2.11 New agent (`#/n/agent`)
  - 2.12 Project (`#/project/{id}`)
  - 2.13 New project (`#/n/project`)
  - 2.14 Repos (`#/repos`)
  - 2.15 Terminal session (`#/l/{sessionId}`)
  - 2.16 Team (`#/team`)
  - 2.17 Tailscale (`#/tailscale`)
  - 2.18 Your box (`#/box`)
  - 2.19 Session panel (`/s/{sessionId}` after a conversation, task or run)
  - 2.20 Document panel (`/d/{artifactId}` after a task or run)
  - 2.21 File panel (`/f/{changeId}` after a task or run)
  - 2.22 Screen panel (`/screen/{instanceId}` or `/screen/{instanceId}/{sessionId}`)
  - 2.23 History and replay (`#/history`)
- 3. Shared components and their states
  - 3.1 Markdown
  - 3.2 Code view
  - 3.3 Diff view
  - 3.4 Tabs
  - 3.5 File panel
  - 3.6 Link field
  - 3.7 Repo picker
  - 3.8 Approval cards
  - 3.9 Command palette
  - 3.10 Changes and pull requests
  - 3.11 Order of work
  - 3.12 Proposals
  - 3.13 Event list
  - 3.14 Status dots and words
  - 3.15 Confirm in place
  - 3.16 Tailscale key notice
  - 3.17 Project and place lines
- 4. Messages a person can see
  - 4.1 Waiting
  - 4.2 Empty states
  - 4.3 Errors and blocked states written by the app
  - 4.4 Words the server writes that the app shows as written
  - 4.5 Words the machines write into the record
- 5. Behavior across the app
  - 5.1 Navigation
  - 5.2 Focus and keyboard
  - 5.3 Accessibility roles and labels
  - 5.4 Themes and visual rules
  - 5.5 Live updates and refresh
  - 5.6 Time and number formats
  - 5.7 How errors show
  - 5.8 What the browser keeps
- 6. Gaps
  - 6.1 What the server does that the app cannot do or show
  - 6.2 Parts of the app that do nothing yet, or wait for a producer
  - 6.3 Readings that look like defects
  - 6.4 Issues recorded in the verification work
- Appendix. Where the verification map's features appear here

## 1. How the app fits together

### 1.1 The shell

The window has these parts. `Workspace` (`App.tsx:113`) lays them out in a CSS grid.

| Part | What it is | When it shows | Code |
|---|---|---|---|
| Topbar | A bar with a `Menu` button, the team name and a `Go to` button | Phone width only. CSS hides it above 760 px | `App.tsx:132-136`, `styles.css:102`, `styles.css:326` |
| Sidebar | A `nav` named `Workspace`. It holds the team block, page links, create links and the lists in 1.2 | Always at desktop width. On a phone only while Menu is open | `App.tsx:137`, `App.tsx:188-468` |
| Main area | One `main` element that holds the screen for the route. It is named `Team`, `Tailscale`, `Your box`, `Repos`, `Run`, `Task`, `Pipeline`, `Agent`, `Project` or `Terminal session` for those routes, and `Conversation` for every other route, forms and the welcome screen included | Always | `App.tsx:139-159` |
| Side panel | The Session, Document, File or Screen panel, beside the main area | The hash ends in `/s/`, `/d/`, `/f/` or `/screen/` plus an id. One panel at a time | `App.tsx:160-171` |
| Command palette | A modal dialog for finding things and starting new ones | After `⌘K` or `Ctrl+K`, the topbar `Go to`, or the sidebar `Go to` | `App.tsx:138`, `Palette.tsx` (see 3.9) |
| Keyboard shortcuts | `⌘K` or `Ctrl+K` toggles the palette. `c` opens New task and `r` opens New room outside a field | Any time. The two single keys can be turned off | `Palette.tsx:50-73` |

The app renders under React's strict mode (`main.tsx:9`). The code has no global toast, banner, spinner or connection indicator. Errors and confirmations appear inside the view that caused them (5.7). The page title is `Agents` on every route (`index.html:7`), and nothing changes it.

### 1.2 The sidebar

`Sidebar` (`App.tsx:188`) stays mounted while the workspace is open, so its lists keep their rows as the main area changes. It reads with snapshots, not live shapes, so it holds none of the browser's six HTTP connections (`App.tsx:198`).

| Section | Rows | Refresh | Empty text | Code |
|---|---|---|---|---|
| Team block | The team name in bold and your login | none | | `App.tsx:276-279` |
| Page links | `Team`, `Your box`, `History`, and for admins `Tailscale` | waiting logins every 10 s for admins | | `App.tsx:280-286` |
| Key notice | Admins only, from 14 days before the Tailscale key expires | 60 s | | `App.tsx:287-291` |
| Create links | `New project`, `New task`, `New room`, `New agent`, and `Go to` with the shortcut | none | | `App.tsx:292-298` |
| Projects | One row per project. Under it, its rooms, up to 5 tasks people started and up to 5 runs, newest first | projects 10 s | `No projects yet` | `App.tsx:300-338` |
| Repos | One row, `All repos`, with the number of repos | 30 s | | `App.tsx:340-350` |
| Agents | Every agent, with its title beside the name | 5 s | `No agents yet` | `App.tsx:352-364` |
| Conversations | Every conversation outside a project, newest first | 5 s | `Nothing yet` | `App.tsx:366-376` |
| Tasks | The 6 newest tasks that people started, outside projects and pipelines | 4 s | `No tasks yet` | `App.tsx:378-389` |
| From terminals | The 6 terminal sessions active most recently | 3 s | `None yet` | `App.tsx:391-402` |
| Ready | Draft tasks nothing blocks or holds, most urgent first, then oldest. A `P{n}` mark shows when the priority is not 2 | 4 s | `Nothing ready` | `Order.tsx:56-69` |
| Held | Tasks under a hold, with the kind, the reason and the end date. The section shows only when one exists | 4 s | | `Order.tsx:70-84` |
| Pipelines | Every pipeline | 10 s | `No pipelines yet` | `App.tsx:406-416` |
| Runs | The 8 newest runs outside projects. Replays are left out | 4 s | `No runs yet` | `App.tsx:418-429` |
| Running now | Sessions starting, running or waiting on a person, then terminal sessions that are working, whose right-hand text reads `terminal · {status}` | 3 s | `Nothing running` | `App.tsx:431-455` |
| Machines | Every machine, with a status dot | 5 s | none | `App.tsx:457-465` |

A conversation row reads `# {room name}` for a room. A DM reads `{agent} · {people}`, where you appear as `you` and anyone not loaded yet as `someone`. A conversation that has its own name and is not a room shows that name (`data.ts:209-215`).

Sidebar actions.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Team` link | Opens `#/team`. For admins the label gains the count of logins waiting to join | none | none | `App.tsx:281-283` |
| `Your box` link | Opens `#/box` | none | none | `App.tsx:284` |
| `Tailscale` link (admins) | Opens `#/tailscale` | none | none | `App.tsx:285` |
| Key notice button (admins) | Opens `#/tailscale` | none | none | `App.tsx:289` |
| `New project`, `New task`, `New room`, `New agent` | Open `#/n/project`, `#/n/task`, `#/n/room`, `#/n/agent` | none | none | `App.tsx:293-296` |
| `Go to` | Opens the palette | none | none | `App.tsx:297` |
| Project row | Opens `#/project/{id}` | none | none | `App.tsx:308` |
| Row for a project's room, task or run | Opens `#/c/{id}`, `#/t/{id}` or `#/r/{id}` | none | none | `App.tsx:314`, `App.tsx:319`, `App.tsx:327` |
| `All repos` | Opens `#/repos` | none | none | `App.tsx:345` |
| Agent row | Finds your DM with the agent, or makes it, then opens `#/c/{id}`. The row is disabled until it opens | none | Silent | `App.tsx:219-226`, `App.tsx:356-358` |
| Conversation, task, terminal, pipeline and run rows | Open `#/c/{id}`, `#/t/{id}`, `#/l/{id}`, `#/p/{id}` and `#/r/{id}` | none | none | `App.tsx:370`, `App.tsx:382`, `App.tsx:395`, `App.tsx:410`, `App.tsx:422` |
| Ready and Held rows | Open `#/t/{id}` | none | none | `Order.tsx:61`, `Order.tsx:76` |
| Running now row | Opens the session panel on its conversation, on its run if the task has one, or on its task. A terminal session opens its own page | none | none | `App.tsx:435-440`, `App.tsx:448` |
| `Claim` on a free box | Keeps the box for you. The row shows `Release` at the next read, up to 5 s later | none | Red text under the list, `role="alert"` | `App.tsx:253`, `App.tsx:228-235`, `App.tsx:466` |
| `Release` on your box | Gives it back. The row shows `Claim` at the next read | none | Same text under the list | `App.tsx:251` |

Sidebar states.

| State | When | What shows | Code |
|---|---|---|---|
| Before the first read | A list has not been read yet | The list's empty text. No list has a loading text, and Machines shows nothing | `App.tsx:337-454` |
| Selected | The row's id equals the open route's id. An agent row is selected when the open conversation is a DM with that agent, whoever's DM it is | Brighter surface and heavier type. There is no `aria-current` | `App.tsx:308`, `App.tsx:356`, `styles.css:127` |
| Current page | The route is `Team`, `Your box` or `Tailscale` | The link is bold without underline | `App.tsx:281-285`, `styles.css:270` |
| Draft task | A listed task has a draft session | A muted `draft` after the title | `App.tsx:321`, `App.tsx:384` |
| Logins waiting | An admin, and at least one login waits | The link gains ` · {n} {verb} to join`, where the verb is `wants` for one login and `want` for more | `App.tsx:282` |
| Key close to expiry | An admin, the key connected, 14 days or fewer left | `The Tailscale key expires in {days}`, where the count reads `day` or `days` | `Tailscale.tsx:45-46` |
| Key expired | An admin and the key's date has passed | `The Tailscale key has expired` | `Tailscale.tsx:39-43` |
| Opening a DM | After a click on an agent | The agent row is disabled until the DM opens | `App.tsx:357` |
| Box action failed | Claim or release was refused | The server's words in red under Machines | `App.tsx:466` |

What each machine row shows on the right.

| Machine | Dot | Right-hand text | Code |
|---|---|---|---|
| A person's own box | By status | `yours`, the owner's name or the login before the `@`, `no owner`, or `someone` | `App.tsx:238-243`, `App.tsx:248` |
| A machine that is not a box | By status | The status word, `online`, `stale` or `offline` | `App.tsx:249`, `data.ts:26` |
| A box a run holds | By status | `on a run` | `App.tsx:250` |
| A box you hold | By status | `Release` button | `App.tsx:251` |
| A box a teammate holds | By status | Their login, or `taken` when it is not loaded | `App.tsx:252` |
| A free box | By status | `Claim` button | `App.tsx:253` |

The dot is green for `online`, amber for `stale` and grey for `offline` (`styles.css:131-133`). A box adds ` (box)` after its name (`App.tsx:461`).

### 1.3 Routes

The app has no router library. The URL hash holds the whole location. `readRoute` (`App.tsx:53-68`) splits it on `/`, and `go` (`App.tsx:70-78`) builds it. A hash the parser does not know shows the welcome screen. A hash with a missing id, such as `#/c/`, does too.

| Hash | Screen | Opened by | Code |
|---|---|---|---|
| `#/` | Welcome or getting started (2.2) | The first load, and the end of Discard draft | `App.tsx:158`, `Draft.tsx:88` |
| `#/c/{conversationId}` | Conversation (2.3) | An agent row, a conversation row, the palette, `Message` on an agent's page, `Run now` on a routine, `Room` on a pipeline or project, the room link on a run, and the end of New room | `App.tsx:222`, `App.tsx:370`, `AgentPage.tsx:36`, `AgentPage.tsx:61`, `Pipeline.tsx:55`, `Projects.tsx:418`, `Run.tsx:133`, `Work.tsx:30` |
| `#/t/{taskId}` | Task (2.6), or Draft task (2.7) when the task has a draft session | Task rows, the palette, `Make it a task`, `Open its task`, the end of New task, blocker links | `App.tsx:382`, `Conversation.tsx:95-98`, `Work.tsx:81`, `Order.tsx:161` |
| `#/r/{runId}` | Run (2.8) | Run rows, the palette, a pipeline's run list, the end of Start a run, links from a replay and from a proposal | `App.tsx:422`, `Pipeline.tsx:95`, `Pipeline.tsx:131`, `Run.tsx:130`, `Proposal.tsx:68` |
| `#/p/{pipelineId}` | Pipeline (2.9) | Pipeline rows, the palette, `Pipeline` on a run | `App.tsx:410` |
| `#/a/{agentId}` | Agent (2.10) | `Agent setup` in a DM, the end of New agent | `Conversation.tsx:79` |
| `#/project/{projectId}` | Project (2.12) | Project rows, project links on tasks and repos, the end of New project | `App.tsx:308` |
| `#/l/{sessionId}` | Terminal session (2.15) | From terminals rows, terminal rows in Running now | `App.tsx:395`, `App.tsx:448` |
| `#/history`, `#/history?q={words}&scope={scope}&agent={id}&person={id}&kind={kind}&project={id}&repo={id}&day={YYYY-MM-DD}` | History (2.23), with the search and filters in the address | The `History` link | `App.tsx`, `History.tsx` |
| `#/history/{sessionId}` or `#/history/{sessionId}/{step}` | The replay of a session (2.23), at its first step or at the one named | A row or a result on History | `History.tsx`, `Replay.tsx` |
| `#/team` | Team (2.16) | The `Team` link | `App.tsx:281` |
| `#/tailscale` | Tailscale (2.17) | The `Tailscale` link, the key notice, `Connect Tailscale` | `App.tsx:285`, `Team.tsx:105` |
| `#/box` | Your box (2.18) | The `Your box` link, `Set up your box` | `App.tsx:284`, `Box.tsx:44` |
| `#/repos` | Repos (2.14) | `All repos` | `App.tsx:345` |
| `#/n/agent` | New agent (2.11) | `New agent`, the palette, `Make an agent on your box` | `App.tsx:296`, `Box.tsx:82` |
| `#/n/room` or `#/n/room/{projectId}` | New room (2.4) | `New room`, the palette, the `r` key, `New room` on a project | `App.tsx:295`, `Projects.tsx:420` |
| `#/n/task` or `#/n/task/{projectId}` | New task (2.5) | `New task`, the palette, the `c` key, `New task` on a project | `App.tsx:294`, `Projects.tsx:419` |
| `#/n/project` | New project (2.13) | `New project` | `App.tsx:293` |

A conversation, run or task can carry a side panel after its id.

| Hash tail | Panel | Allowed on | Code |
|---|---|---|---|
| `/s/{sessionId}` | Session (2.19) | Conversation, run, task | `App.tsx:160-162` |
| `/d/{artifactId}` | Document (2.20) | Run, task | `App.tsx:168-170` |
| `/f/{changeId}` | File (2.21) | Run, task | `App.tsx:171` |
| `/screen/{instanceId}` or `/screen/{instanceId}/{sessionId}` | Screen (2.22) | Conversation, run, task | `App.tsx:163-167` |

`go` writes at most one tail, in the order session, document, file, screen (`App.tsx:72-73`). Opening a panel therefore closes any other. Closing a panel goes back to the bare conversation, run or task route (`App.tsx:128`). The browser's back and forward buttons work, since each `go` sets `location.hash`. The app draws no back or forward control of its own.

### 1.4 How data arrives

Reads come from the server's shape proxy at `/v1/shape/{name}`, and writes are JSON calls. A request carries no identity of its own. Tailscale's header, added in front of the server, names the person (`data.ts:1-3`).

| Mechanism | What it does | Used for | Code |
|---|---|---|---|
| Live shape | A long-lived stream of rows for one named shape. Views that ask for the same URL share one stream, and it closes 1.5 s after the last view leaves | A conversation's `messages`, `sessions`, `asks` and the working session's `events`. The `events` of an event list, in the Session panel and on a terminal session's page, and the Session panel's `sessions`. A task's `sessions`, `asks` and transcript `events`. A run's `run_stages` and `asks` | `data.ts:123-170` |
| Snapshot | Reads a shape once, then again every few seconds (5 s unless a view says otherwise). Holds no connection. A failed read keeps the old rows | Every other list in the app | `data.ts:172-191` |
| Checked snapshot | A snapshot whose rows must match a schema. Rows that do not fit are dropped, and the view gets an error string | Projects, join requests, invites, Claude sign-ins, file changes, pushes, task blocks, holds and repos, repo requests, terminal sessions, folders, documents | `data.ts:193-205` |
| Polled call | An API call repeated on a timer. The last good value stays when a call fails. Some views show the error (5.7) | Repos, GitHub status, the ready list, the Tailscale key | `data.ts:217-235`, `Order.tsx:30-51`, `Tailscale.tsx:15-31` |
| Token stream | The words an agent is typing, read from `/v1/streams/sessions/{id}` | The typing line in a conversation | `live.ts` |
| WebSocket | The box's screen, from `/v1/screens/{instanceId}` | The Screen panel | `Screen.tsx:79` |
| Plain call | Every write, and a few one-off reads such as a document's diff | Buttons and forms | `data.ts:250-357` |

Why most lists poll. A browser keeps at most six HTTP/1.1 connections to a server, and each live shape holds one, so the app makes live only what must change at once (`data.ts:123-128`).

What happens when a read fails or the network drops.

- A snapshot ignores the failure and keeps the rows it has. The view shows nothing about it (`data.ts:183-184`).
- A live shape has no error handler or retry setting in the app. The Electric client retries with delays that grow from 1 s to 32 s and never gives up (`BackoffDefaults` in `@electric-sql/client` 1.5.28). It also pauses a stream while the tab is hidden. The view shows no sign of either.
- A write that fails shows its error where the form says (5.7), or nowhere for the silent ones.
- The app has no offline or reconnecting banner. Only the Screen panel shows a connection state (2.22).

A view starts with no rows and fills at its first read, so a screen opened from the sidebar can show its empty state for a moment. No live view uses the `loading` flag `useRows` returns.

Writes. A request is sent with `content-type: application/json` on every method but GET, since the server refuses a change that does not say it is JSON (`data.ts:250-256`). A failed answer shows the server's `error` text, or `request failed with {status}` when the body has none (`data.ts:257-261`). A call whose answer does not match its schema fails with `The server's answer to {path} did not fit this app: {details}` (`data.ts:273`).

### 1.5 The desktop app and the browser

Both load the same bundle from the same server. The routes, shortcuts, panels and states in this list are the same in both. The differences are all in `desktop/main.cjs`.

| Topic | Browser | Desktop app | Code |
|---|---|---|---|
| How it opens | The server's tailnet address in a tab | `npm run desktop` runs Electron on `desktop/main.cjs`, which opens one window on the server's address | `package.json`, `main.cjs:37-47` |
| Server address | The one typed | `AGENTS_SERVER`, else `server` in `~/.agents-app/app.json`, else `http://127.0.0.1:7700` | `main.cjs:20` |
| Proxy | The browser's own | `AGENTS_PROXY` or `proxy` in `app.json` sets the window's proxy. It is for a Mac that runs Tailscale in userspace mode | `main.cjs:21`, `main.cjs:32` |
| Identity | The header Tailscale adds | The same. `AGENTS_DEV_LOGIN` adds a `tailscale-user-login` header to every request, for checks against a local server | `main.cjs:24`, `main.cjs:33-36` |
| Window | A tab | 1280 by 820 pixels, titled `Agents` | `main.cjs:37-42` |
| Links that open a new window | Open in a new tab | Open in the system browser. The window opens no other window | `main.cjs:43-46` |
| Closing | | Closing the last window quits the app | `main.cjs:50` |
| Page isolation | | `contextIsolation` and `sandbox` are on, with no preload script | `main.cjs:41` |

The shell defines no menu, preload script or message channel of its own. The app code never tests for Electron. Its only environment test is the Mac check that picks `⌘K` or `Ctrl+K` (`Palette.tsx:23`).

### 1.6 Phone width

One rule applies at 760 px and below (`styles.css:324-338`, `styles.css:417-420`). There are no other breakpoints, and the viewport tag is `width=device-width, initial-scale=1` (`index.html:5`).

| What | At phone width | Code |
|---|---|---|
| Layout | One column with the topbar above it | `styles.css:325-326` |
| Sidebar | Hidden. `Menu` shows it as a full-height overlay below the topbar, which scrolls on its own. Any hash change closes it. A row for the page you are already on changes no hash, so the menu stays open | `App.tsx:114-119`, `styles.css:328-329` |
| Side panels | A panel replaces the main area while open. `Close` or any navigation brings the main area back | `styles.css:330-331` |
| Wide panels | Document and File also take one column | `styles.css:418` |
| Padding | Messages, headers, composer and page bodies use 16 px | `styles.css:332-335` |
| Page headers | Wrap onto more lines | `styles.css:336` |
| Rows with several parts | Stage lines, repo lines, list rows with actions, order lines and invite rows wrap onto more lines. They have no rule of their own for phones | `styles.css:184`, `styles.css:277`, `styles.css:406`, `styles.css:426` |
| Tables | The versions and score tables become blocks that scroll sideways inside themselves | `styles.css:337` |
| Palette | The top margin drops from 12 vh to 8 vh. The width rule, 640 px or the viewport minus 32 px, is the same at every width | `styles.css:386`, `styles.css:419` |
| Unchanged | Type sizes, the composer's two columns and every control. Apart from the sidebar, only the main area is hidden, and only while a panel is open | `styles.css:330` |

## 2. Screens

Each screen below says who sees it and what it shows, then lists its actions and states. Panels and the palette follow the routed screens. Parts shared by several screens (Markdown, ask cards, order of work, changes and the rest) are in section 3 and are linked, not repeated.

### 2.1 Before the workspace opens

Anyone who loads the app passes through `App` (`App.tsx:90-111`) first. It asks `/v1/me` who the login is. A login with an open invite, or with none, then calls the join route. An invited login joins its team. A login with no invite is recorded as wanting to join, and admins see it under Wants to join (2.16).

| State | When | What shows | Code |
|---|---|---|---|
| Connecting | The first answer has not arrived | `Connecting…` in a centered block marked `aria-busy` | `App.tsx:108` |
| Cannot open | `/v1/me` or the join call failed, for example when the page is opened outside the tailnet and no login header arrives | A heading, `Can't open the app`, then the server's error text, then `The app knows people by their Tailscale login. Open it from a device on the tailnet.` No retry control exists. A reload tries again | `App.tsx:95-107` |
| Waiting to join | The login is on no team | The waiting page below | `App.tsx:109`, `Team.tsx:13-34` |

The waiting page is a `main` named `Waiting to join`. It shows a kicker, `Waiting to join`, then a heading, `You are not on a team yet`, and these lines.

- `You opened Agents as {login}. An admin sees you under Wants to join and can add you with one click.`
- `This page opens the app by itself once they do.`
- `If someone invited you at a different email, sign in to Tailscale with that account and open the app again.`

It has no buttons. It asks the server again every 5 s. A login that now has an invite joins, and a login that is now a member opens the workspace without a reload (`Team.tsx:9`, `Team.tsx:15-23`). A failed poll shows its error in red under the text, with `role="alert"`, and polling goes on (`Team.tsx:31`).

### 2.2 Welcome and getting started (`#/`)

Everyone on the team sees this at `#/`. `GettingStarted` (`Box.tsx:24-47`) shows either the first-steps list or the welcome text.

| State | When | What shows | Code |
|---|---|---|---|
| Welcome | The person has no box row, or their box is online and they are signed in to Claude. Also the first paint, before the box and sign-in rows are read | A heading, `Pick an agent to talk to`, and `Every conversation, every pipeline run and everything their agents do is shared with your team as it happens.` | `App.tsx:177-186`, `Box.tsx:26` |
| First steps | The person has a box that is not online, or is online without a signed-in Claude | A kicker, `Welcome to {team name}`, a heading, `A few steps and you are working`, and four steps | `Box.tsx:27-46` |

The four steps. A done step has a check glyph and heavier type. The others have a dot glyph. Both glyphs are hidden from screen readers.

| Step | Done when | Text | Code |
|---|---|---|---|
| 1 | Always | `You joined the team.` | `Box.tsx:33` |
| 2 | The box is ready | `Your box, {name}, is ready.` Otherwise `Your box, {name}, is starting.` or `Your box, {name}, could not start.` | `Box.tsx:34-37` |
| 3 | The newest Claude sign-in is signed in | `You signed in to Claude.` Otherwise `Sign in to your Claude account, so agents on your box run on it.` | `Box.tsx:38-41` |
| 4 | Never | `Make your first agent on your box.` | `Box.tsx:42` |

A box could not start when `start_error` is set. Otherwise it is ready when its status is online, and starting when it is not (`Team.tsx:37-40`).

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Set up your box` button | Opens `#/box` (2.18) | none | none | `Box.tsx:44` |

The block is centered, at most 520 px wide, with 16 px side padding (`styles.css:136`, `styles.css:302`). The box and sign-in rows poll every 3 s and 2 s (`Box.tsx:8-9`).

### 2.3 Conversation (`#/c/{id}`)

A conversation is a DM with one agent, a room with teammates and agents, or an agent's main conversation, which routines post to. Everyone on the team sees team conversations. Private ones are listed only for the people in them (`server/sync.ts:69-73`). The view is `ConversationView` (`Conversation.tsx:17-118`). Messages, sessions and asks update live. The conversation row, agents and people poll every 5 s (`Conversation.tsx:18-23`).

The screen holds, top to bottom, a header, the People panel when open (rooms), the message list, ask cards for open asks, and the composer. Posts are ordered by their sequence number (`Conversation.tsx:42`).

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Session details` button in the header line. It reads `Hide session` while a panel is open | Opens or closes the Session panel (2.19) on the working agent's session, or the newest session. It shows only when the conversation has a session | none | none | `Conversation.tsx:69-71` |
| `People` button (rooms only) | Opens or closes the People panel. It has `aria-expanded` | none | none | `Conversation.tsx:74-78` |
| `Agent setup` button (DMs with an agent) | Opens that agent's page (2.10) | none | none | `Conversation.tsx:79` |
| `Interrupt` button. It shows while the shown session is starting, running, waiting on a person, or lost | Asks the machine to stop the turn. The button does not change by itself. The status changes through the live session row | none | Silent | `Conversation.tsx:80` |
| `Message` box and `Send` button. `Send` is disabled with no text | Sends the post. Enter sends and Shift+Enter adds a line. The box clears at once and the post shows greyed as pending until it syncs | none | Red text under the box with `role="alert"`. The text returns to the box and the pending line goes away | `Conversation.tsx:51-60`, `Conversation.tsx:232-255` |
| `Make it a task` button under a person's post, in a DM | Starts a task at once from the post. The title is the post's first line cut to 120 characters, the details are the whole post, the agent is the DM's agent. Opens the task | none | Silent. The button also shows under a teammate's post in their DM, where the server answers `no such conversation of yours` (`server/tasks.ts:31`) and the answer is dropped | `Conversation.tsx:93-98` |
| `Open its task` button, once the post has a task | Opens the task | none | none | `Conversation.tsx:95` |
| Ask card buttons | Answer an ask (3.8) | none | In the card | `Conversation.tsx:113` |

People panel (rooms). `RoomPeople` (`Conversation.tsx:123-181`) polls members every 3 s.

| Control or state | What happens or shows | Code |
|---|---|---|
| In the room | A heading, `In the room`, then you as `You`, then others by name or login, then each agent as `{name}, an agent` in muted type | `Conversation.tsx:157-163` |
| `Teammate` select and `Add` button | Shown to admins and people already in the room, while someone is left to add. Adds the chosen person. Options read `{name}, {login}` or the login. On success `Added {name} to the room.` shows as a status line | `Conversation.tsx:164-173`, `Conversation.tsx:148`, `Conversation.tsx:177` |
| Everyone is in | `Everyone on the team is in the room.` | `Conversation.tsx:175` |
| Not allowed | `People in the room, and admins, can add a teammate.` | `Conversation.tsx:176` |
| Add failed | The server's words in red, `role="alert"`, for example `Only people in the room, or an admin, can add someone to it.` | `Conversation.tsx:178`, `server/rooms.ts:59` |

Conversation states.

| State | When | What shows | Code |
|---|---|---|---|
| Unknown or hidden | The id is not in the visible conversation list | The heading `Conversation`, the line `Shared with your team`, an empty list and a disabled composer. No not-found text exists | `Conversation.tsx:66-68`, `Conversation.tsx:115` |
| Header | Always | A heading that reads `# {room name}` for a room, with `room` in place of a missing name, and the agent's name for a DM. Under it `Shared with your team` | `Conversation.tsx:66-68` |
| Private | The conversation's visibility is private | `Private` in place of `Shared with your team` | `Conversation.tsx:68` |
| Empty | No messages yet | An empty list with no text | `Conversation.tsx:85-111` |
| A person's post | `speaker` is person | The author (`You`, their login, `Someone`, or `Routine` when no person wrote it), the time, and the text as written with line breaks kept | `Conversation.tsx:46`, `Conversation.tsx:89-92` |
| An agent's post | `speaker` is agent | The agent's name (`Agent` when unknown), the time, and the text rendered as Markdown (3.1) | `Conversation.tsx:89-92` |
| Pending | A post was sent and has not arrived in the shape | A line from `You` with the muted word `sending`, drawn at 60 percent opacity | `Conversation.tsx:102-107`, `styles.css:143` |
| Agent working | The shown session is starting, running, waiting for approval or waiting for input | The agent's name, a green dot and one word or phrase, then any live text under it | `Conversation.tsx:110`, `Conversation.tsx:184-202` |
| Stopped | An agent's newest session failed | The agent's name, the muted word `stopped`, and the reason from its last error event, read every 10 s. Until it arrives, and without one, `Its session failed.` It stays until that agent's next session starts | `Conversation.tsx:35`, `Conversation.tsx:206-215` |
| Interrupted | An agent's newest session is lost because its machine stopped | The agent's name, the muted word `interrupted`, and the notice the record holds, or `Its machine stopped in the middle of this turn.` Then ` It picks up again when its machine is back.` | `Conversation.tsx:37`, `Conversation.tsx:220-230` |
| Composer disabled | A DM whose agent is not found, or a room started by a pipeline | The box and `Send` are disabled. The placeholder stays | `Conversation.tsx:39`, `Conversation.tsx:249-251` |
| Composer placeholder | Always | `Post to the room. @name asks one agent.` in a room, `Message the agent` otherwise | `Conversation.tsx:115` |

The word on an agent that is working.

| Word | When | Code |
|---|---|---|
| `waiting for approval` | An ask is open in this conversation, or the session's status is waiting for approval | `Conversation.tsx:192` |
| The text of the agent's latest top-level tool call | That call came after the person's latest message | `Conversation.tsx:189-192` |
| `writing` | No tool call yet this turn, and live text is arriving | `Conversation.tsx:192` |
| `thinking` | Anything else | `Conversation.tsx:192` |

Live text. While an agent works, the view asks for the session's token stream every 400 ms until it exists, then reads it. It shows the newest message's text, and drops it once the finished reply is in the record. It skips thinking text and text from sub-agents (`live.ts:15-38`, `Conversation.tsx:186-191`). The text sits under the typing line in a paragraph with `data-testid="live-text"`.

A room shows at most one typing line, for the agent whose session is working.

Keyboard. The Message box takes Enter to send and Shift+Enter for a new line. The message list takes focus with Tab (it has `tabIndex` 0) and shows a brighter surface when focused (`styles.css:95`). Nothing takes focus when the conversation opens. Enter during text composition (an input method) sends, since the box does not test for it.

Phone width. The header, list, People panel and composer use 16 px side padding (`styles.css:332-333`). The Session panel replaces the conversation.

Links out. Agent setup, tasks (`Make it a task`, `Open its task`), the Session panel, and through it the Screen panel.

### 2.4 New room (`#/n/room`, or `#/n/room/{projectId}`)

Everyone on the team sees it. It makes a room, which is a group conversation where agents take turns after a post. From a project it makes the room inside that project. `NewRoom` is `Work.tsx:18-62`.

The page has the kicker `New`, the heading `A room`, the line `Teammates and agents talk together. Each agent takes a turn after a post, or only the ones a post mentions with @name.`, and in a project the line `In {project}, with its repos.` (`Projects.tsx:257-261`). Below it is a form named `New room`.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Name` box (placeholder `launch`) | Names the room | none | none | `Work.tsx:40-41` |
| `Teammates` checkboxes, one per teammate by login (you are not listed) | Add that person. You are always in the room | none | none | `Work.tsx:42-47` |
| `Agents` checkboxes, one per agent by name | Add that agent. Turns go in the order the list shows, not the order ticked | none | none | `Work.tsx:48-53`, `Work.tsx:29`, `server/rooms.ts:30-31` |
| `Create room` button. Disabled while the name is blank | Makes the room and opens it (`#/c/{id}`) | none | Red text beside the button with `role="alert"`. It is not cleared when you submit again | `Work.tsx:25-34`, `Work.tsx:55-56` |

| State | When | What shows | Code |
|---|---|---|---|
| Lists not read yet | Before the first read of people and agents | Two empty groups with their legends. No text says they are loading | `Work.tsx:19-20`, `Work.tsx:42-53` |
| Creating | After `Create room` | Nothing changes. The button stays enabled and no busy state exists, so a second click sends a second request | `Work.tsx:25-34` |
| Refused | The server said no | Its words, for example `every agent must be on your team`, `no such project` | `server/rooms.ts:23`, `server/rooms.ts:29` |

Phone width. The form is at most 620 px wide and uses the page padding (`styles.css:245`, `styles.css:335`).

### 2.5 New task (`#/n/task`, or `#/n/task/{projectId}`)

Everyone on the team sees it. It asks one agent to do a piece of work outside any pipeline. In a project it offers only that project's repos. `NewTask` is `Work.tsx:67-114`.

The page has the kicker `New`, the heading `A task`, and in a project the line `In {project}, with its repos.` The form is named `New task`.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `What needs doing?` box (placeholder `Write the release notes for 1.4`) | The task's title | none | none | `Work.tsx:96-97` |
| `Details` box, 4 lines | The first message to the agent | none | none | `Work.tsx:98-99` |
| `Agent` select, one option per agent | Picks the agent. It starts on the first one | none | none | `Work.tsx:100-103` |
| `Repos` checkboxes (3.7) | Pick the repos the task works in. The first ticked is the primary repo | none | none | `Work.tsx:104`, `RepoPicker.tsx:14` |
| `Start task` button. Disabled while busy, with no title, or with no agents | Starts the task at once and opens it (`#/t/{id}`), where `Starting…` shows until its session arrives | none | Red text beside the buttons. It is not cleared on a second try | `Work.tsx:75-90`, `Work.tsx:106`, `Work.tsx:108` |
| `Save draft` button. Same disabling | Saves the task as a draft and opens it (2.7) | none | Same | `Work.tsx:107` |

| State | When | What shows | Code |
|---|---|---|---|
| No agents | The agent list is empty or not read yet | Both buttons are disabled and no text says why | `Work.tsx:106-107` |
| Refused before sending | No agent could be picked | `Pick an agent first.` | `Work.tsx:79` |
| Refused by the server | The agent has no home machine, the agent is gone, a repo is unknown, or the repo's policy keeps coding work in boxes | Its words, for example `this agent has no home machine`, `no such repo`, or `This repo's policy keeps coding work in boxes, and the task's agent lives on a {kind}. Start an app-change run on the repo instead.` | `server/tasks.ts:28`, `server/checkout.ts:39`, `server/launch.ts:30` |
| Creating | After either button | Both buttons stay disabled until the server answers. A success changes the route. A failure enables them again and shows the error | `Work.tsx:75-86` |

### 2.6 Task (`#/t/{id}`)

A task is work a person started: a conversation with the agent, the files it changed, the documents it made and its place in the order of work. Everyone sees a team task. A private task is seen by its owner and members only. `TaskView` is `Work.tsx:118-193`. Sessions, asks and the transcript update live. The task row polls every 4 s and artifacts every 4 s.

A task with a draft session shows the draft page (2.7) in this slot, and switches to this page when it starts, without a route change.

The header has the kicker `Task`, the title, and a line `{agent} · {status}` with ` · done` when marked done. The status is the session's status with its first `_` turned into a space, for example `running`, `needs approval` or `idle`. Under it a line names the project and repos (`TaskPlace`, `Projects.tsx:264-276`): `In {project}. ` and `Works in {repo names}.` or `No repo.`

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Screen` button, or `Hide screen` while it is open. It shows only when the session's machine has a screen | Opens or closes the Screen panel (2.22) | none | none | `Work.tsx:157-159` |
| `Session details` button, or `Hide session` | Opens or closes the Session panel (2.19) on the task's newest session | none | none | `Work.tsx:160` |
| `Interrupt` button. It shows while the session is starting, running, waiting on a person, or lost | Asks the machine to stop the turn | none | Silent | `Work.tsx:161` |
| `Tell the agent more` box and `Send` button. `Send` is disabled with no text or no session | Sends the text to the task's session. The box clears when the server accepts it. Enter adds a line and does not send | none | Red text under the box. It stays until the page is left, even after a later send works | `Work.tsx:137-146`, `Work.tsx:184-189` |
| A document button under `Made by this task` | Opens that document in the Document panel (2.20) | none | none | `Work.tsx:177` |
| A file row under `Changes` | Opens the File panel (2.21) | none | none | `Work.tsx:168` |
| The project name in the header line | Opens that project | none | none | `Projects.tsx:272` |
| Order of work, changes and pull requests, ask cards | See 3.11, 3.10 and 3.8 | | | `Work.tsx:166-170` |

| State | When | What shows | Code |
|---|---|---|---|
| Loading | The task row is not read yet. It also never ends for a task you cannot see | `Loading the task…` | `Work.tsx:132` |
| Starting | The task has no session yet | `Starting…` in place of the transcript | `Work.tsx:165` |
| Transcript | Always, once there is a session | A list named `Messages` with a `Request` entry for each user message, the agent's replies rendered as Markdown (3.1) under the agent's name, and an entry in the stopped style for each error. Tool calls and sub-agent text are left out | `Work.tsx:197-216` |
| Request | A user event that is not the server's resume text | The author `Request`, the time, the text as Markdown | `Work.tsx:199-209` |
| Error event | The session wrote an error | The agent's name, `stopped {time}`, the error text | `Work.tsx:207`, `Work.tsx:209` |
| Working | The session is starting, running, waiting for approval or waiting for input | A green dot and the word `working`. No live typing text shows on a task | `Work.tsx:212` |
| Lost | The session is lost because its machine stopped | The interrupted block of 2.3 | `Work.tsx:213` |
| Waiting on a person | An ask of this session is open | The ask card under the transcript | `Work.tsx:166` |
| Done | The task was marked done | ` · done` in the header line, `Reopen` in the order of work (3.11) | `Work.tsx:153`, `Order.tsx:149` |
| Documents | The task made documents | A heading `Made by this task` and a row for each, with `version {n}` | `Work.tsx:171-183` |

The first `Request` entry is the task's own first prompt, which carries a paragraph about the workspace. That comes from the verification map, not from the app's code (`.claude/skills/verify-agents/features/tasks.md:53`). The transcript list has no `aria-live`.

Phone width. The page body uses 16 px padding. Panels replace the page.

### 2.7 Draft task (`#/t/{id}` while the task is a draft)

A draft is written now and started later. Anyone who can see it can change it, start it or discard it. The page is `DraftView` (`Draft.tsx:14-36`) with the form `DraftForm` (`Draft.tsx:41-110`) and the order-of-work block (3.11).

The header has the kicker `Draft task`, the title, the line `Written by {login}. It starts when someone starts it.` (the author part is left out until people are read), and the project line.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `What needs doing?`, `Details` (6 lines), `Agent` select, `Repos` checkboxes (3.7) | Edit the draft in the form. Nothing is saved until a button is used | none | none | `Draft.tsx:92-100`, `RepoPicker.tsx:14` |
| `Start task` button. Disabled while busy, with no title, or with no agent | Saves the form first when it changed, then starts the task. The page then shows the running task (2.6) without a route change | none | Red text with `role="alert"` | `Draft.tsx:82-85`, `Draft.tsx:102` |
| `Save draft` button. Same disabling | Saves the fields. `Saved.` shows beside the buttons | none | Red text. A teammate's edit since you loaded the form is refused with `this draft changed since you opened it. Reload it to see the changes, then make yours again.` | `Draft.tsx:72-80`, `Draft.tsx:103`, `server/drafts.ts:60` |
| `Discard draft` button. Disabled while busy | Discards the draft and opens the welcome screen | none | Red text. A draft that still blocks other tasks is refused with `this task still blocks {titles}` | `Draft.tsx:86-89`, `Draft.tsx:104`, `server/order.ts:126` |

| State | When | What shows | Code |
|---|---|---|---|
| Loading | The draft's repos are not read yet | `Loading the draft…` | `Draft.tsx:30` |
| Repos unreadable | The repo rows did not fit their schema | The error in red | `Draft.tsx:29` |
| Saved | After `Save draft` | The muted line `Saved.` with `role="status"`. It clears on the next button press | `Draft.tsx:78`, `Draft.tsx:105` |
| No agent saved | The draft has no agent | The select shows the first agent, and a save uses it | `Draft.tsx:49`, `Draft.tsx:54` |
| Stale form | A teammate changed the draft after the form loaded | The form keeps its old values until the page is reloaded. A save is refused with the text above | `Draft.tsx:45-50`, `server/drafts.ts:56-61` |

An untouched form starts the draft as it is now, which can include a teammate's newer edit (`Draft.tsx:81`).

### 2.8 Run (`#/r/{id}`)

A run is one pass of a pipeline over a report. Everyone who can see the run's task sees it. `RunView` is `Run.tsx:20-138`. Stages and asks update live. The run row polls every 3 s, proposals and artifacts every 4 s, and pipelines and versions every 15 s.

The header has a kicker, `{pipeline name} run` (`replay` for a replay), the run's title (the task title, else the report title, else `Run`), and a line `{dot}{status} · from {trigger} · version {sha} · started {time}`. The line adds ` (issue #{n})` after the trigger when the report came from an issue.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Pipeline` button. It shows once the run's pipeline is read | Opens the pipeline (2.9) | none | none | `Run.tsx:57` |
| `Cancel run` button. It shows while the run is queued, running or waiting. It is disabled while the request runs | Cancels the run. The status becomes `cancelled`, open asks expire, and the note reads `Cancelled by {login}.` | none | Silent. For example `this run is already done` is dropped | `Run.tsx:58-60`, `server/runner.ts:232-240` |
| `Open session` button on a stage that has a session. It reads `Hide session` while that session is open | Opens or closes the Session panel (2.19) for that stage's session | none | none | `Run.tsx:91-95` |
| A file row under `Changes` | Opens the File panel (2.21) | none | none | `Run.tsx:101` |
| A document button under `Made by this run` | Opens the Document panel (2.20) | none | none | `Run.tsx:105`, `Run.tsx:111` |
| A link artifact under `Made by this run`, such as a pull request | Opens it in a new tab | none | none | `Run.tsx:105`, `Run.tsx:110` |
| `Open on the forge` link in the report | Opens the issue in a new tab | none | none | `Run.tsx:125` |
| `an earlier run` link on a replay | Opens the run it replays | none | none | `Run.tsx:130` |
| `{pipeline} room` link | Opens the pipeline's room | none | none | `Run.tsx:133` |
| Ask cards and proposals | See 3.8 and 3.12 | | | `Run.tsx:75-76` |

| State | When | What shows | Code |
|---|---|---|---|
| Loading | The run row is not read yet. It also never ends for a run you cannot see | `Loading the run…` | `Run.tsx:41` |
| Status | Always | `queued`, `running`, `waiting on a person`, `done`, `stopped` (for a failed run), `cancelled`, or the raw status for any other, such as `paused`. The dot is green for running and amber for waiting. Done, stopped, cancelled and queued share the grey dot | `Run.tsx:14`, `styles.css:132`, `styles.css:164-165`, `server/migrations/0009_self_improve.sql:29` |
| Note | The run has one | A line in bold, for example `Fixed and merged.` or `Cancelled by {login}.` | `Run.tsx:65`, `pipelines/bug-fix.ts:98`, `server/runner.ts:239` |
| Facts | The run ended, or its cost is known | Four facts, `Took`, `Cost`, `Stages run` and `Hand-offs` | `Run.tsx:66-73` |
| No stages yet | The run has no stage row | `Waiting for a machine…` | `Run.tsx:98` |
| A stage | Each stage row | A dot for its status, the stage name in bold, `try {n}` after the first try, its kind, its outcome (or its status when it has none), and the time. Pending and cancelled stages show the outcome in muted type | `Run.tsx:80-90`, `styles.css:186` |
| Stage kinds | Always | `Agent`, `Check`, `Forge`, `Gate`, `Hand-off`. Any other kind shows its raw name, which covers `route`, `verify`, `review`, `confirm` and `suite` | `Run.tsx:12`, `Run.tsx:86`, `server/migrations/0009_self_improve.sql:27` |
| Stage summary | A stage has one | Up to 4 lines and under 400 characters render as Markdown. A longer one folds into a disclosure whose summary is its first line, cut at 160 characters, with the full text inside in a preformatted box | `Run.tsx:90`, `Run.tsx:141-151` |
| Replay | The run replays another | The kicker says `replay`, and a line reads `A replay of`, then a link `an earlier run`, then `, to score a proposed change. Replays never touch the forge or wait on a person.` | `Run.tsx:47`, `Run.tsx:129-131` |
| Pipeline room | The pipeline has a room and the run is not a replay | `Progress posts go to the`, then a link `{pipeline} room`, then a full stop | `Run.tsx:132-134` |
| Report | The run came from a report | A heading `The report`, the title in bold with ` · from {author}`, the body with line breaks kept, and `Open on the forge` | `Run.tsx:119-128` |
| Made by this run | The task has artifacts | A heading `Made by this run`, sorted by title. A pull request shows its state, such as open or merged. A document shows `version {n}` | `Run.tsx:103-117` |
| Changes | The task has changed files | The list in 3.10, without pull request controls | `Run.tsx:101` |

A failed stage and a finished one share the grey dot. The outcome text tells them apart.

### 2.9 Pipeline (`#/p/{id}`)

A pipeline is a file in the team's pipelines repo. Everyone on the team sees it. `PipelineView` is `Pipeline.tsx:13-113`. Everything polls: pipelines and versions every 10 s, runs, tasks and proposals every 4 s.

The header has the kicker `Pipeline`, the name, the description, and a `Room` button when the pipeline has a room. The body holds the Start a run form, any proposed changes, the Versions table, the runs and the pipeline file.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Room` button | Opens the pipeline's room | none | none | `Pipeline.tsx:55` |
| `What should it work on?` box (placeholder `A one-line description`), `Details` box, 3 lines (placeholder `Steps, what you expected, what happened`), `Repo` select | Describe the run and pick a repo. The select lists every repo except the pipelines repo | none | none | `Pipeline.tsx:141-148`, `Pipeline.tsx:117` |
| `Start` button. Disabled while busy, with no title, with no repo choices, or with no working version of the pipeline | Starts a run and opens it (`#/r/{id}`) | none | Red text beside the button, for example `Pick a repo first.`, `this pipeline has no working version`, or `the current version of {name} does not load: {reason}` | `Pipeline.tsx:123-137`, `Pipeline.tsx:150-151`, `server/runner.ts:150-160` |
| A run row | Opens the run | none | none | `Pipeline.tsx:95` |
| The disclosure `The pipeline file, {path} at {sha}` | Shows the current version's source | none | none | `Pipeline.tsx:104-109` |
| Proposed changes | See 3.12. Each has a link, `The run that proposed it` | | | `Pipeline.tsx:60-65` |

| State | When | What shows | Code |
|---|---|---|---|
| Loading | The pipeline row is not read yet | `Loading the pipeline…` | `Pipeline.tsx:45` |
| Proposed changes | An open or decided proposal exists for this pipeline, failed ones left out | A heading `Proposed changes` and up to 5 proposals, newest first. Nothing shows without any | `Pipeline.tsx:24`, `Pipeline.tsx:60-65` |
| Versions | Always | A table with the columns `Version`, `Added`, `Runs`, `Done`, `Stopped`, `Avg cost` and `Avg time`. Each row is a version, newest first, with its short id. The current one is bold with the word `current`. A version that does not load gets `broken` in red | `Pipeline.tsx:67-88` |
| Averages | Some runs of a version finished | `Avg cost` and `Avg time` are totals over finished runs divided by their count. They are blank when none finished | `Pipeline.tsx:70`, `Pipeline.tsx:82-83` |
| Broken version | The newest version with an error | `Version {sha} does not load: {error}` in red | `Pipeline.tsx:89` |
| Runs | Always | Up to 30 runs, newest first, as a dot, the title, and `{status} · {stage} · {time}`. Replays are left out | `Pipeline.tsx:91-102`, `Pipeline.tsx:23` |
| No runs | The pipeline has none | `No runs yet` | `Pipeline.tsx:101` |
| Start disabled | The pipeline has no current version | The button is disabled and nothing says why | `Pipeline.tsx:58`, `Pipeline.tsx:150` |

The Repo select starts blank and uses the first repo. The pipelines repo is filtered out of it for every pipeline (`Pipeline.tsx:117`). At phone width the Versions table becomes a block that scrolls sideways inside itself (`styles.css:337`).

### 2.10 Agent (`#/a/{id}`)

An agent's page sets it up: who it is, its skills, plugins and routines, and what it remembers. Anyone on the team can change it. `AgentPage` is `AgentPage.tsx:10-78`. Everything polls: agents, skills, plugins and routines every 4 s, memories every 6 s, people every 30 s.

The header has the kicker `Agent`, the name, the line `{title} · {model}` (`No title yet` and no model when unset), and two buttons.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Message` button | Opens your DM with the agent, making it if it does not exist | none | Silent | `AgentPage.tsx:36` |
| `Save as template` button | Saves the agent's title, role, instructions, model, skills, plugins and routines as a template named after the agent. A second save under the same name raises its version. A status line follows | none | Silent | `AgentPage.tsx:23-26`, `AgentPage.tsx:37` |
| Profile form: `Title` (placeholder `What it does, in a few words`), `Model` (placeholder `Claude Code's default`), `Instructions` (5 lines), `Save` button | Saves the three fields. An empty title or model clears it. `Saved` shows until the next edit | none | Red text beside the button | `AgentPage.tsx:114-137` |
| `Remove` button on a skill, plugin or routine | Deletes it | none | Silent | `AgentPage.tsx:80-92` |
| `Run now` button on a routine | Sends the routine's prompt to the agent's main conversation now, and opens that conversation | none | Silent | `AgentPage.tsx:61` |

Add forms. Each sits in a collapsed disclosure with a muted summary, and clears its fields after a save.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Add a skill`: `Name` (placeholder `release-notes`), `When to use it` (placeholder `Writing release notes from merged pull requests`), `How to do it` (5 lines), `Save skill` button. Disabled until all three are filled | Saves the skill under that name, replacing one of the same name. The skill is the agent's own | none | Red text beside the button, for example `a skill name is lowercase letters, digits and dashes` | `AgentPage.tsx:140-163` |
| `Add a plugin`: `Name` (placeholder `github`), `Kind` select (`A command the machine runs` or `An HTTP server`), `Command` (placeholder `npx -y @modelcontextprotocol/server-github`) or `URL` (placeholder `https://`), a box for secrets (placeholder `GITHUB_TOKEN=GITHUB_TOKEN`), `Save plugin` button. Disabled until a name and a command or URL are given | Saves the plugin. The first word of the command is the program and the rest are its arguments. The box takes one `VARIABLE=SECRET_NAME` per line, and a bare name stands for both sides. It takes names of secrets and never values, and a note says the value stays on the machine | none | Red text, for example `config.env.GITHUB_TOKEN must name a secret, such as {"secret": "GITHUB_TOKEN"}, never hold a value` or `config.url must be an http or https URL` | `AgentPage.tsx:165-202`, `server/agents.ts:96-118` |
| `Add a routine`: `Name` (placeholder `morning summary`), `Schedule (cron: minute hour day month weekday)` (starts as `0 9 * * 1-5`), `What to do` (3 lines, placeholder `Summarize what the team's agents did yesterday.`), `Save routine` button. Disabled until a name and a prompt are given | Saves the routine. The schedule stays in the box after a save | none | Red text, for example `schedule: {reason}` | `AgentPage.tsx:204-227`, `server/agents.ts:147` |

The secrets box is labelled `Environment from secrets, one per line` for a command and `Headers from secrets, one per line` for an HTTP server (`AgentPage.tsx:192`). Its note reads `Each names a secret. Its value stays on the machine, in its environment or ~/.agents-app/secrets.json.`

| State | When | What shows | Code |
|---|---|---|---|
| Loading | The agent row is not read yet. It also never ends for an unknown id | `Loading the agent…` | `AgentPage.tsx:19` |
| Template saved | After `Save as template` | A bold status line, `Saved as the template "{name}", version {n}.` | `AgentPage.tsx:25`, `AgentPage.tsx:41` |
| Skills | Always | A heading `Skills` and a row for each skill the agent owns, with its description. A team-wide skill, with no agent, shows nowhere | `AgentPage.tsx:21`, `AgentPage.tsx:44-47` |
| Plugins | Always | A heading `Plugins` and a row for each, with its command and arguments or its URL. A plugin that names secrets adds ` · needs {names} on its machine` | `AgentPage.tsx:49-56` |
| Routines | Always | A heading `Routines` and a row for each, with its schedule, ` · paused` when it is off, and ` · last ran {time}` | `AgentPage.tsx:58-63` |
| Empty lists | A list has no rows | `No skills yet`, `No plugins yet`, `No routines yet` | `AgentPage.tsx:45`, `AgentPage.tsx:50`, `AgentPage.tsx:59` |
| Memory | Always | A heading `What it remembers`. Profiles come first, then logs by date, newest first. Each entry starts with `About` or `Notes from {date} on`, then names `the team` or a person's login, then gives the text as Markdown | `AgentPage.tsx:65-74` |
| Memory empty | The agent remembers nothing | `Nothing yet. The agent writes here with its update_memory tool.` | `AgentPage.tsx:73` |

The page has no control that turns a routine off, edits an agent's role, or edits its memory. Saving a routine again under the same name turns it on, since the form never sends the setting (`AgentPage.tsx:208`, `server/agents.ts:150`).

### 2.11 New agent (`#/n/agent`)

Everyone on the team sees it. It makes an agent on a machine, blank or from a template. `NewAgent` is `AgentPage.tsx:232-278`. Instances and templates poll every 15 s.

The page has the kicker `New`, the heading `A new agent`, and a form named `New agent`.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Name` box (placeholder `reviewer`) | The agent's name | none | none | `AgentPage.tsx:253-254` |
| `Its machine` select | Lists the Macs, boxes someone holds, and your own box. Another person's own box is left out. It starts on your own box, else the first machine | none | none | `AgentPage.tsx:240-241`, `AgentPage.tsx:255-258` |
| `Start from` select | `Nothing, a blank agent`, or `The template "{name}", version {n}` for each template. Choosing a template hides the two boxes below | none | none | `AgentPage.tsx:259-263` |
| `Title` box (placeholder `Reviews pull requests`) and `Instructions` box, 4 lines | Shown for a blank agent only | none | none | `AgentPage.tsx:264-269` |
| `Create agent` button. Disabled while busy, with no name, or with no machine | Makes the agent and opens its page (`#/a/{id}`) | none | Red text beside the button | `AgentPage.tsx:242-247`, `AgentPage.tsx:271-272` |

Server refusals show as written, for example `name must be lowercase letters, digits and dashes, starting with a letter`, `there is already an agent named {name}`, `That box is a teammate's own. Only they can make agents on it.` and `no such machine` (`server/agents.ts:51-59`).

With no machine in the list the button is disabled and no text says why.

### 2.12 Project (`#/project/{id}`)

A project groups a team's work on one thing: its repos, its room, and the tasks, runs, documents and rooms made in it. Everyone on the team sees every project. `ProjectPage` is `Projects.tsx:380-471`. Every list on it polls, between 3 s and 30 s, and the repo list reads the forges through `/v1/repos` every 15 s.

The header has the kicker `Project`, the name, and the line `{description} · started {time}`, where an empty description reads `No description yet`. The time has no date.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Room` button. It shows when the project has a room | Opens the project's room | none | none | `Projects.tsx:418` |
| `New task` and `New room` buttons | Open the New task and New room forms (2.5, 2.4) with the project filled in | none | none | `Projects.tsx:419-420` |
| The project name on a repo line | Opens that project | none | none | `Projects.tsx:128` |
| `Open on {forge}` link, where the forge is `GitHub` or `this Mac's forge` | Opens the repo on its forge in a new tab | none | none | `Projects.tsx:16`, `Projects.tsx:130` |
| A pull request link, `#{number} {title}` | Opens it in a new tab | none | none | `Projects.tsx:137` |
| A task branch, named `task/{slug}` | A button when the branch belongs to a known task, which opens its run, or its task when it has none. Plain code otherwise | none | none | `Projects.tsx:108`, `Projects.tsx:113-117`, `Projects.tsx:143-145` |
| `Try again` on a repo that was not made | Asks for the repo again | none | Silent | `Projects.tsx:289` |
| `Add a repo` disclosure, with the form `Add a GitHub repo`. The box reads `A repo on GitHub, made if it doesn't exist` (placeholder `billing-api`). The `Add it` button is disabled with no name | Asks the server to add that GitHub repo to the project, and make it if it does not exist. The progress shows under Repos | none | Red text under both forms | `Projects.tsx:296-333` |
| The form `Add a team repo`, with the select `Or one of the team's repos with no project` (first option `Pick a repo`) and the `Move it here` button. It shows only when such a repo exists | Moves that repo into the project. The pipelines repo is never offered | none | Same red text | `Projects.tsx:320-329` |
| A row under `Tasks and runs` | Opens the run when the task has one, else the task | none | none | `Projects.tsx:432`, `Projects.tsx:438` |
| The form `Start a run in this project`: `Pipeline` select, `Repo` select, `What should it work on?` box (placeholder `A one-line description`), `Details` box, 2 lines, `Start` button | Starts a run and opens it. The pipeline select lists pipelines that have a current version. The repo select lists the project's repos | none | Red text beside the button, for example `Pick a pipeline and a repo first.` | `Projects.tsx:335-377` |
| A document button under `Documents` | Opens the document beside the task that made it. A link artifact opens in a new tab | none | none | `Projects.tsx:451-458` |
| A room row under `Rooms` | Opens the room | none | none | `Projects.tsx:465` |

| State | When | What shows | Code |
|---|---|---|---|
| Loading | The project row is not read yet | `Loading the project…`, or the schema error in red when the project rows did not fit | `Projects.tsx:393-395` |
| Reading the forges | The repo overview has not answered. A failed read shows nothing more here, since this page does not show the overview's error | `Reading each forge…` in place of the repo list | `Projects.tsx:425` |
| No repo | The project has none | `No repo yet.` | `Projects.tsx:425` |
| Repo being made | A repo request is creating | `Making {owner}/{name} on GitHub…` under a list named `Repos being made` | `Projects.tsx:278-293` |
| Repo not made | A repo request failed | `{owner}/{name} was not made. {reason}` and `Try again` | `Projects.tsx:289` |
| People | The room has members | Their logins, then the agents' names, joined by commas | `Projects.tsx:405-408`, `Projects.tsx:430` |
| No people | Nobody is in the room | `Nobody yet` | `Projects.tsx:430` |
| Tasks and runs | Always | Each task of the project, newest first, as a dot when it has a run, the title, and `{repos} · {status} · {time}`. A task with no run reads `task`, and one with no repo reads `no repo` | `Projects.tsx:434-446` |
| Nothing yet | No task or run | `No tasks or runs yet` | `Projects.tsx:445` |
| No documents | No artifacts | `No documents yet` | `Projects.tsx:459` |

Rooms has no empty text.

### 2.13 New project (`#/n/project`)

Everyone on the team sees it. It makes a project, its GitHub repo with a README as the first commit, and a room. `NewProject` is `Projects.tsx:186-254`.

The page has the kicker `New`, the heading `A project`, and the line `A project gets its own GitHub repo, with a README as its first commit, and a room for the people and agents on it. The whole team sees it.` When the person has no GitHub sign-in and the team has no stopgap token, the GitHub block of 2.14 shows above the form.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Name` box (placeholder `Billing`) | The project's name. The repo is named after it | none | none | `Projects.tsx:225-226` |
| `What it is for` box (placeholder `Invoices and payments for the shop`) | The description | none | none | `Projects.tsx:227-228` |
| `GitHub organization or account` box. Its placeholder is the default owner | Where the repo goes. Empty means your own account, or the stopgap's organization | none | none | `Projects.tsx:229-230`, `Projects.tsx:198-200` |
| `Teammates` and `Agents` checkboxes | Add people and agents to the project's room. You are always in | none | none | `Projects.tsx:234-245` |
| `Create project` button. Disabled while busy, with no name, or with no way to reach GitHub | Makes the project and opens it (`#/project/{id}`). The repo can still read `Making … on GitHub…` there | none | Red text beside the button | `Projects.tsx:204-218`, `Projects.tsx:247-248` |

Under the owner box a line with `aria-live="polite"` reads `The repo: {owner}/{repo} on GitHub.` once a name and an owner are known, and `The repo is named after the project.` before that (`Projects.tsx:231-233`).

Server refusals show as written (`server/projects.ts:33-34`, `server/projects.ts:71-75`).

- `There is already a project with that name.`
- `A project name needs a letter or a digit, which its repo is named after.`
- `{owner}/{name} already exists on GitHub. Name the project differently, or add that repo to a project from the project's page.`
- GitHub's own reasons, such as `GitHub refused the sign-in. Whoever it belongs to connects GitHub again on the Repos page.` (`server/github.ts:83`).

### 2.14 Repos (`#/repos`)

Everyone on the team sees every repo, where it lives, its project and what is open on it. It also holds the GitHub sign-in. `ReposView` is `Projects.tsx:159-183`. Both reads poll every 15 s. GitHub's status polls every 2 s while a sign-in code is waiting (`Projects.tsx:10-13`, `Projects.tsx:100`).

The header has the kicker `Repos`, a heading `{n} repo` or `{n} repos` (`Repos` until read), and the line `Every repo your team shares is listed here, with where it lives, its project and what is open on it. Repos in the sidebar always brings you back.` The body has a heading `GitHub` with the GitHub block under it, then a heading `The team's repos` above the list.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Connect GitHub` button | Starts GitHub's device sign-in. A code shows and the page waits | none | Red text | `Projects.tsx:25-33`, `Projects.tsx:57` |
| `Open GitHub's device page` link | Opens GitHub's page in a new tab, where the code is typed | none | none | `Projects.tsx:49` |
| `Sign out` button, beside `Signed in to GitHub as {login}.` | Signs this person out of GitHub on the server | none | Silent | `Projects.tsx:38-41` |
| `Set the stopgap token` disclosure, shown to admins when GitHub is set up, with `Organization or account`, `Token` and `Save the token`. The button is disabled until both are filled | Saves one fine-grained token for the whole team, which stands in until people sign in. The form is named `Stopgap token` and opens with `One fine-grained personal access token for the whole team, kept on the server only, until people connect their own GitHub.` The token box clears | none | Red text, for example `The stopgap takes a fine-grained personal access token, which starts with github_pat_. A classic token reaches every repo its account can.` | `Projects.tsx:66-97`, `Projects.tsx:176`, `shared/projects.ts:21-22` |
| The links and buttons on each repo line | Same as the project page (2.12) | none | none | `Projects.tsx:111-156` |

GitHub states (`GithubConnect`, `Projects.tsx:19-63`). The block also shows on New project.

| State | When | What shows | Code |
|---|---|---|---|
| Asking | The status has not arrived | `Asking the server about GitHub…` | `Projects.tsx:21` |
| Off | The server has no GitHub settings | `GitHub is not set up on this server yet. An admin adds {settings} to its .env and restarts the API.` | `Projects.tsx:22-24` |
| Waiting for the code | A device sign-in is under way | `Enter this code on GitHub's device page to connect.`, the code in large type, and `Open GitHub's device page` followed by `. This page changes when you are done there.` The block has `role="status"` | `Projects.tsx:44-52` |
| Connected | This person signed in | `Signed in to GitHub as {login}.` and `Sign out` | `Projects.tsx:36-43` |
| Not connected | No sign-in | `Connect GitHub`. When the server has no client id the button is replaced by `Signing in with GitHub needs the Agents GitHub App's client id on the server, in AGENTS_GITHUB_CLIENT_ID.` | `Projects.tsx:53-62` |
| Last sign-in stopped | The last try ended without a token | The reason, above the button | `Projects.tsx:55` |
| Stopgap in use | A team token is saved and this person is not connected | `Until everyone signs in, the team's stopgap token for {owner} acts as {login}.` It does not show to a connected person | `Projects.tsx:35`, `Projects.tsx:59` |

Repo states.

| State | When | What shows | Code |
|---|---|---|---|
| Reading | The first read has not answered | `Reading each forge…` | `Projects.tsx:179` |
| Read failed | A read failed | The error in red above the list. After a first failure the list area still reads `Reading each forge…`. After a later failure the last good list stays | `Projects.tsx:178-179` |
| A repo | Always | Its name in bold, `GitHub` or `this Mac's forge`, its project as a link or `no project`, and an `Open on {forge}` link | `Projects.tsx:16`, `Projects.tsx:124-131` |
| Open work | The forge answered | `Open pull requests` with each as a link, or `none`. `Task branches` with each, or `none` | `Projects.tsx:132-148` |
| Forge silent | The forge did not answer for that repo | The reason in place of the two lines, for example `This Mac's forge did not answer: {reason}` | `Projects.tsx:149`, `server/repos.ts:118` |
| No repos | The team has none | `No repos yet. New project makes one.` | `Projects.tsx:179` |

### 2.15 Terminal session (`#/l/{sessionId}`)

A terminal session is a Claude Code session a person ran in their own terminal, in a folder they connected on their Mac. The team sees the sessions of team folders. A private folder's sessions are seen by the person who connected it. The page is read only. `TerminalSessionView` is `Terminal.tsx:21-47`.

The header has a kicker, `From your terminal`, `From {name}'s terminal` or `From someone's terminal`, a heading with the folder's name and the path inside it, and the line `{status} · {machine} · {n} turns · started {time}`. One turn reads `1 turn`. The body is the event list of 3.13.

| State | When | What shows | Code |
|---|---|---|---|
| Loading | The session list has not been read | `Loading the session…` | `Terminal.tsx:28` |
| Not visible | The list loaded and does not hold the id | `This terminal session is not one you can see.` | `Terminal.tsx:28` |
| Folder unknown | The folder row is not read, or the folder was disconnected from view | The heading shows the session's full working path | `Terminal.tsx:14-18` |

The page has no buttons. The app cannot stop a terminal session, and the server refuses an interrupt for one with `A terminal session is stopped from its terminal, not from the app.` (`server/record.ts:216`). The sessions list polls every 3 s and the events are live. The sidebar links here from `From terminals` and `Running now`.

### 2.16 Team (`#/team`)

Everyone on the team sees the page and the list of people. Admins also see the key notice, the invite form, the logins waiting to join and the open invites. Members do not get those sections at all. `TeamPage` is `Team.tsx:42-78`. People and boxes poll every 5 s, the other two lists every 4 s.

The header has the kicker `Team`, the team's name, and a count, `{n} person` or `{n} people`.

The people list is named `People` and sorted by login. Each row shows the name in bold, or the login when there is no name, then in muted type the login (when a name is shown) and ` · admin` for admins. On the right it shows the person's box as `{box name} · {state}`, where the state is `ready`, `starting` or `could not start`, or `no box` (`Team.tsx:64-73`).

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Email` box (placeholder `sam@example.com`) and `Role on the team` select (`Member`, `Admin`) | Describe the invite. A hint under the select reads `Admins invite people, add those waiting to join, and manage the tailnet.` | none | none | `Team.tsx:109-116` |
| `Invite` button. Disabled while busy or with no email | Makes the invite. With Tailscale connected it emails the person. The box clears and the result block shows | none | Red text beside the button | `Team.tsx:86-98`, `Team.tsx:118-119` |
| `Connect Tailscale` link. It shows when Tailscale has no key | Opens `#/tailscale` | none | none | `Team.tsx:105` |
| `Add` button on a waiting login (spoken as `Add {login}`) | Adds the login to the team. It leaves the list at once and its box starts | none | Red text under the list | `Team.tsx:146-154`, `Team.tsx:163` |
| `Link` button on an invite (spoken as `Link for {email}`). It shows for invites sent through Tailscale | Fetches the invite's link and shows it in a field under the row | none | Red text under the list | `Team.tsx:204-210` |
| `Resend` button (spoken as `Resend to {email}`) | Sends the invite again. A status line follows, and a link shows when Tailscale gave one | none | Red text under the list | `Team.tsx:211-215` |
| `Cancel` button (spoken as `Cancel the invite for {email}`) | Cancels the invite here and asks Tailscale to delete its own. The row leaves at the next read, up to 4 s later | none | Red text under the list. When only Tailscale's side fails, it starts `Cancelled the invite for {email} here, but its invite in Tailscale stays until someone removes it there.` and the invite is cancelled here anyway | `Team.tsx:216-220`, `server/onboarding.ts:205` |

| State | When | What shows | Code |
|---|---|---|---|
| Key notice | An admin and the Tailscale key is due | A raised box with the kicker `Tailscale key`, the full warning, and how to make a new key. See 3.16 | `Team.tsx:59`, `Tailscale.tsx:49-59` |
| Tailscale off or without a key | An admin | `Tailscale is not connected, so invites are made here without an email, for people already on the tailnet.` | `Team.tsx:102-107` |
| Invite made | After `Invite` | A status block with `Invited {email}.` and one of three lines below it | `Team.tsx:128-140` |
| Invite sent | Tailscale emailed it | `Tailscale emailed them an invite to the tailnet. They join this team the first time they open the app.` | `Team.tsx:135` |
| Invite not sent | Tailscale is not connected | `Tailscale is not connected, so nobody was emailed. They join when they open the app from a device on the tailnet.` | `Team.tsx:134` |
| Invite without a link | The email is in the tailnet's own domain | `Their email is in the tailnet's own domain, so they join by signing in to Tailscale. There is no link to send.` | `Team.tsx:136` |
| Invite link | Tailscale gave one | A read-only field labelled `Invite link, to send yourself` (3.6) | `Team.tsx:137` |
| Wants to join | Always, for admins | A heading `Wants to join` and rows with the name or login in bold, and muted `{login} · ` when a name is shown, then `since {date}` | `Team.tsx:158-165` |
| Nobody waiting | No login waits | `Nobody is waiting. Someone who opens the app without an invite shows up here.` | `Team.tsx:166` |
| Added | After `Add` | A status line, `Added {logins}. Their box is starting.`, which lists every login added in this visit | `Team.tsx:168` |
| Invited | Always, for admins | A heading `Invited` and one row per open invite, newest first. A row reads the email in bold, then muted `as an admin · `, `invited {date}` and ` · not sent through Tailscale` as they apply | `Team.tsx:191-221` |
| No invites | None are open | `No open invites.` | `Team.tsx:225` |
| Invite action done | After `Resend` or `Cancel` | A status line, `Sent {email} their invite again.` or `Cancelled the invite for {email}.` | `Team.tsx:214`, `Team.tsx:218` |
| Rows did not fit | The invite or join rows failed their schema | The error in red under the list | `Team.tsx:169`, `Team.tsx:228` |

Server refusals show as written, for example `{email} is already on a team.`, `{email} already has an open invite. Resend it from the list.`, `That invite is no longer open.` and `Tailscale is not connected, so the app cannot email invites. Connect it on the Tailscale page.` (`server/onboarding.ts:152`, `:157`, `:145`, `:174`).

### 2.17 Tailscale (`#/tailscale`)

The page manages the tailnet. Only admins get its content. A member who opens the URL sees `Only team admins manage the tailnet.` (`Tailscale.tsx:72`). The sidebar shows the link to admins only. The page reads the tailnet when it opens and after each change. It does not poll.

The header has the kicker `Tailscale`, the heading `The tailnet`, and the line `Its users, devices and invites, as Tailscale has them now.`

Key section.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `API access token` box (a password box, placeholder `tskey-api-…`), `Expires on, if Tailscale does not say` date box, `Save key` button. The button is disabled with no token | Saves the key on the server. The boxes clear and the page reads again. A note reads `The key is kept in a file on the server only. This page shows its last four characters.` | none | Red text beside the button | `Tailscale.tsx:262-295` |
| `Replace the key` disclosure | Opens the same form | none | Same | `Tailscale.tsx:253-256` |
| `Disconnect Tailscale` button | Asks `Remove the key from the server? Invites stop going through Tailscale.` with `Yes, disconnect` and `Keep it` | Yes | Red text beside the question | `Tailscale.tsx:297-316` |

Key states.

| State | When | What shows | Code |
|---|---|---|---|
| Asking | The first read has not answered | `Asking Tailscale…`. If the first read fails, the error shows in its place in muted type | `Tailscale.tsx:112` |
| Off | The server has no Tailscale settings | `Tailscale is off on this server. To turn it on, set AGENTS_TAILSCALE_API and AGENTS_TAILSCALE_KEY_FILE for the API and restart it.` | `Tailscale.tsx:227-233` |
| No key | Settings exist and no key is saved | `Connect the tailnet with an API access token.` followed by how to make one, and the key form | `Tailscale.tsx:235-242` |
| Connected | A key is saved | Three facts, `Key` as `ends in {last four}`, `Expires` as a date with `, in {n} days` while it is not past (or `not known`), and `Saved by` as `{who}, {date}`. Then the notice of 3.16 when due | `Tailscale.tsx:244-259` |
| Done | After a change | A status line naming what happened | `Tailscale.tsx:117` |
| Failed | A change or a later read failed | The error in red, with `role="alert"` | `Tailscale.tsx:118` |

Users, devices and invites show only while the key is connected.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Add to the team` on a user not on the team | Adds the login to the team. `Added {login} to the team. Their box is starting.` | none | Red text above the lists | `Tailscale.tsx:188-191` |
| Role select on a user other than the owner (spoken as `Tailscale role for {login}`) | Changes the role at once. `{login} is now {role}.` | none | Same | `Tailscale.tsx:194-198` |
| `Approve` on a user that needs approval | Approves. `Approved {login}.` | none | Same | `Tailscale.tsx:199-200` |
| `Suspend` on an active or idle user | Suspends. `Suspended {login}.` | none | Same | `Tailscale.tsx:201-202` |
| `Restore` on a suspended user | Restores. `Restored {login}.` | none | Same | `Tailscale.tsx:203-204` |
| `Remove` on a user or a device | Asks `Remove {name} from the tailnet?` with `Yes, remove` and `Keep`. Then removes it. `Removed {name} from the tailnet.` | Yes | Same | `Tailscale.tsx:213-224` |
| `Authorize` on a device that is not authorized | Authorizes. `Authorized {name}.` | none | Same | `Tailscale.tsx:139-140` |
| `Resend` on an invite that has an email (spoken as `Resend the invite to {email}`) | Sends it again. `Sent {email} their invite again.` | none | Same | `Tailscale.tsx:156-157` |
| `Cancel` on an invite (spoken as `Cancel the invite for {email}`, with `this link` for an invite that has no email) | Cancels it. `Cancelled the invite for {email}.`, with `that link` for an invite that has no email | none | Same | `Tailscale.tsx:158-159` |

| List state | What shows | Code |
|---|---|---|
| Users | A heading `Users`. Each row has the name in bold, then muted `{login} · {status} · {standing}`. The status has its dashes turned to spaces, so `needs-approval` reads as needs approval. The standing is `on the team`, with ` as an admin` added for admins, `on another team` or `not on the team`. The owner row shows the word `owner` in place of controls | `Tailscale.tsx:121-125`, `Tailscale.tsx:176-211` |
| Devices | A heading `Devices`. Each row has a green dot when online, the name in bold, then muted `{owner} · {os} · {when}` with `online now`, `never online` or `last seen {date}`, and ` · not authorized` when it applies | `Tailscale.tsx:126-146` |
| Invites | A heading `Invites`. Each row has the email in bold (`An invite link` when it has none), then muted `{role} · `, then `not emailed` or `sent {date}`. A link field shows when Tailscale gave a link, labelled `Invite link for {email}` or `this invite` | `Tailscale.tsx:147-165` |
| Empty | `No users.`, `No devices.`, `No open invites.` | `Tailscale.tsx:124`, `:145`, `:164` |

Tailscale's own refusals show as written, for example `Tailscale refused the key ({message}). {how to make a new key}`, `Tailscale could not be reached: {reason}` and `The Tailscale key expired on {date}. {how to make a new key}` (`server/tailscale.ts:128`, `:184`, `:190`).

### 2.18 Your box (`#/box`)

Each person has a box of their own, a machine where their agents run on their own Claude account. The page shows only the viewer's box. `BoxPage` is `Box.tsx:49-89`. Instances poll every 3 s and sign-ins every 2 s.

The header has the kicker `Your box`, the box's name (`No box yet` without one), and the line `A machine of your own where your agents run, on your own Claude account.`

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Make my box` button. It shows when the person has no box | Makes the box. The runner starts its container | none | Red text at the foot of the page | `Box.tsx:52-59`, `Box.tsx:73` |
| `Sign in to Claude` button | Starts a Claude sign-in on the box | none | Red text | `Box.tsx:147` |
| `Open Claude's sign-in page` link | Opens the box's sign-in page in a new tab | none | none | `Box.tsx:161` |
| `Code from Claude's page` box and `Send code` button. The button is disabled with no code or while busy | Sends the pasted code to the box, once. The box clears | none | Red text, for example `code: Paste the whole code, including the part after #.` | `Box.tsx:126-133`, `Box.tsx:165-172`, `shared/onboarding.ts:118` |
| `Cancel` button, in the starting, waiting and checking states | Cancels the sign-in | none | Red text | `Box.tsx:153`, `Box.tsx:170`, `Box.tsx:178` |
| `Sign in again` button, once signed in | Starts a new sign-in | none | Red text | `Box.tsx:186` |
| `Try again` button, after a failed sign-in | Starts a new sign-in | none | Red text | `Box.tsx:192` |
| `Make an agent on your box` link | Opens New agent (2.11) | none | none | `Box.tsx:82` |

Box states.

| State | When | What shows | Code |
|---|---|---|---|
| No box | The person has no personal box. Also the first paint, before the box row is read | The heading `No box yet`, `You joined before boxes were made for everyone who joins.` and `Make my box` | `Box.tsx:65`, `Box.tsx:70-75` |
| Ready | The box is online | A green dot and `Ready.` | `Box.tsx:96-99` |
| Starting | The box is not online and has no start error | A green dot and `Starting. This takes under a minute.` | `Box.tsx:98` |
| Could not start | The box has a start error | A grey dot and `It could not start.`, then `Docker said: {reason}` and `The server keeps trying to start it. An admin can look at the server.` | `Box.tsx:98-104` |

Claude sign-in states, by the newest sign-in of this box (`Box.tsx:110-199`).

| State | What shows | Code |
|---|---|---|
| None, or cancelled, and the box could not start | `Agents on your box run on your own Claude account. You can sign in once your box is running.` | `Box.tsx:141-143` |
| None, or cancelled | `Agents on your box run on your own Claude account. Sign in once, and the sign-in lasts a year.` and `Sign in to Claude` | `Box.tsx:144-149` |
| Starting | `Getting a sign-in link from your box`, then `, once it starts` or `, which is still starting` when the box is not online, then a full stop, and `Cancel` | `Box.tsx:150-155` |
| Waiting for the code | The sign-in's note in bold if it has one, such as `The server restarted before your box got your code. Paste it again.`, three numbered steps, the code form and `Cancel`. The steps read a link `Open Claude's sign-in page` followed by ` in a new tab.`, then `Sign in with your Claude account and approve.` and `Copy the code the page shows, and paste it here.` | `Box.tsx:156-174`, `server/claudelogin.ts:126` |
| Checking | `Your box is checking the code with Claude.` and `Cancel` | `Box.tsx:175-180` |
| Signed in | `Signed in to Claude. Agents on your box run on your account.` with a check glyph, `The sign-in lasts until {date}. The token stays on your box, where agents on it and the tools they run can read it.`, `Teammates can message agents on your box and add them to rooms. Those turns use your Claude account.` and `Sign in again` | `Box.tsx:181-188` |
| Failed | `The sign-in did not finish. {reason}` and `Try again` | `Box.tsx:189-194` |
| Sign-in rows did not fit | The error in red at the foot of the page | `Box.tsx:85` |

Below the Claude section a heading `Agents` and the line `Agents you make with your box as their machine run here, on your Claude account.` link to New agent (`Box.tsx:78-84`). The Team page shows each person's box state to everyone (2.16), and the sidebar's Machines list shows the box with the owner's name (1.2).

### 2.19 Session panel (`/s/{sessionId}` after a conversation, task or run)

The panel shows every step one session took, in order, and keeps adding new ones. Anyone who can see the conversation, task or run sees it. `SessionPanel` is `Session.tsx:32-59`, an `aside` named `Session details`. Its events and the session list update live. Instances poll every 5 s.

It opens from `Session details` in a conversation or task, from `Open session` on a run's stage, and from a `Running now` row. It replaces any other panel.

The header has the heading `Session` and, once the session row is read, a line `{status} · {model} · {machine} · {n} turns`. The status has its first `_` turned into a space. The model reads `default model` when none is set, and the machine reads `machine` until its row is read. The word is `turns` for every count, one included (`Session.tsx:46-48`).

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Screen` button. It shows when the session's machine has a screen | Closes this panel and opens the Screen panel (2.22) for that machine, remembering this session | none | none | `Session.tsx:52` |
| `Close` button | Closes the panel and shows the bare conversation, task or run | none | none | `Session.tsx:53` |

The body is the event list of 3.13. At phone width the panel replaces the main area.

### 2.20 Document panel (`/d/{artifactId}` after a task or run)

A document is a file an agent wrote in its task's `task` folder. Each saved change is a version. A person reads any version, sees what changed from the one before, and comments on it. Images the agent saved are documents too. `DocumentPanel` is `Document.tsx:31-78`, an `aside` named `Document`, wider than the other panels (46 percent of the window, at least 380 px). Artifacts, versions and comments poll every 3 s to 4 s.

The header has the document's title (`Document` until read) and a line `{path} · {n} version` or `versions`, then a `Close` button. When the document has two or more versions, a `Version` select lists them as `{n} · {time}`, newest first, and starts on the newest.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Version` select | Shows that version. The comment form below follows it | none | none | `Document.tsx:49-56` |
| `File` and `Diff` tabs. Left and Right move between them. They show for text versions only | `File` shows the version, as Markdown for a `.md` path and as numbered, highlighted code for any other. `Diff` shows what changed from the version before | none | The diff's error shows in its place | `Document.tsx:61-68` |
| `Close` button | Closes the panel | none | none | `Document.tsx:47` |
| A comment's quote, a button that reads the quoted words (spoken as `Show in the document: {quote}`) | Shows the version the comment is on, marks the quote, and scrolls the document to it | none | A note if the words are gone | `Document.tsx:208-212`, `Document.tsx:159-169` |
| Clicking marked words in the document | Selects the comment that quotes them and scrolls the comments to it | none | none | `Document.tsx:144-150` |
| `Use selection` button, beside the quote box. It shows on the `File` tab of a text version | Copies the words selected in the document into the quote box | none | A note, `Select the words you mean in the document first.` | `Document.tsx:61`, `Document.tsx:171-182`, `Document.tsx:224` |
| `Quote (optional)` box (placeholder `The part you mean`), `Comment on version {n}` box, 3 lines | The comment. A quote typed by hand means its first match | none | none | `Document.tsx:221-227` |
| `Send it to the agent to revise` checkbox. It shows only when a session wrote the document. It usually starts ticked (see the note under this table) | Sends the comment to the session that wrote the document, which can revise it into a new version | none | none | `Document.tsx:228` |
| `Comment` button. Disabled with no text | Adds the comment. The boxes clear | none | Red text beside the button | `Document.tsx:184-195`, `Document.tsx:230-231` |
| `Resolve` button on an open comment | Marks it resolved. It stays in the list, in muted type | none | Silent | `Document.tsx:214` |

| State | When | What shows | Code |
|---|---|---|---|
| Loading | No version has been read | `Loading…` | `Document.tsx:58` |
| An image | The version is an image | The image, with the alt text `{title}, version {n}`. No tabs, and no quote controls | `Document.tsx:59`, `Document.tsx:72` |
| First version | `Diff` on version 1 | `This is the first version, so there is nothing before it to compare.` | `Document.tsx:92` |
| Diff loading | The diff is being fetched | `Loading…` | `Document.tsx:93` |
| Diff failed | The server refused | The error in red | `Document.tsx:94` |
| Nothing changed | The diff has no changed lines | `Nothing changed in the text.` | `Code.tsx:59` |
| Comments | Always | A heading `Comments`. Each comment shows `{login} on version {n} · {time}`, ` · sent to the agent` when it was, ` · {status}` when it is not open, its quote, and its text | `Document.tsx:197-217` |
| No comments | None yet | `No comments yet` | `Document.tsx:218` |
| Quote gone | A comment's quote is not in its version any more | `"{quote}" is not in version {n} any more.` | `Document.tsx:164-166` |
| Quotes not marked | The browser has no highlight API | Quotes show in the comment list only. Nothing is marked in the text | `Document.tsx:128` |

Marked quotes use the browser's highlight API, with a lighter tone for every quote and a darker one for the active comment (`styles.css:382-383`). A quote matches loosely on white space, since the document and the quote can break lines differently, and a comment keeps which match of its words it means when they appear more than once (`quotes.ts:1-5`, `quotes.ts:42-68`). The send checkbox starts ticked only if the document's row had been read when the comments first drew (`Document.tsx:111`).

### 2.21 File panel (`/f/{changeId}` after a task or run)

The panel shows one file an agent added, changed or deleted, as it is now and as a diff against the base branch. `FilePanel` is `FilePanel.tsx:15-53`, an `aside` named `File`, as wide as the Document panel. The file and the task's file list poll every 3 s.

The header has the file's path (`File` until read) and a line `{repo} · {status}` with ` · +{added} −{removed}` for a text file. The repo reads `its repo` until repos are read. A `Close` button closes the panel.

| State | When | What shows | Code |
|---|---|---|---|
| Loading | The file row has not been read | `Loading…` | `FilePanel.tsx:40` |
| Failed | A read did not fit its schema | The error in red | `FilePanel.tsx:38` |
| Gone | The file is no longer in the task's changed list, and others remain | `This file no longer differs from the base branch.` | `FilePanel.tsx:23`, `FilePanel.tsx:39` |
| A text file | The file has text | Two tabs, `File` and `Diff`. `File` shows Markdown for a `.md` path and numbered, highlighted code for any other. `Diff` shows the diff (3.3) | `FilePanel.tsx:42-48` |
| Deleted | The file was deleted, on the `File` tab | `Deleted. The Diff tab shows what it held.` | `FilePanel.tsx:45` |
| Binary | The file is not text | `A binary file, so there is no text to show.` | `FilePanel.tsx:10-13`, `FilePanel.tsx:43` |
| Too large | The file is over the size limit | `Too large to show here.` | `FilePanel.tsx:12` |

A file counts as too large when its text or its diff is over 524,288 characters (`daemon/changes.ts:143`, `shared/work.ts:150`). The tab resets to `File` when another file opens, since the panel is keyed by the file. When the last differing file stops differing, the list is empty, `Gone` does not show, and the panel stays on `Loading…`.

### 2.22 Screen panel (`/screen/{instanceId}` or `/screen/{instanceId}/{sessionId}`)

The panel shows a box's screen live, beside the work it runs. Anyone on the team who may watch sees it. One person at a time can take over its keyboard and mouse, which pauses the agent's use of the screen, and hand it back. The panel code loads only when someone opens a screen. `ScreenPanel` is `Screen.tsx:57-61` and `LiveScreen` is `Screen.tsx:63-148`. It is an `aside` named `Screen`.

It opens from `Screen` in a task's header or in the Session panel, and only when the machine reports a screen. A conversation, run or task route can carry it. The server refuses a watcher when the box has shown private work in the last day that the person cannot see.

The header has the heading `Screen` and a line `{machine name} · {width} × {height}`. The name reads `Box` until the machine row is read, and the size is left out without one.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Take over` button. It shows once the screen is live and the agent holds it | Takes the keyboard and mouse. The agent's screen and browser actions are refused while you hold it | none | Red text under the header, for example `The box is not connected, so nobody can take over its screen.` or `{login} has the screen.` | `Screen.tsx:103-113`, `Screen.tsx:126`, `server/screens.ts:189`, `shared/screen.ts:186-189` |
| `Hand back` button. It shows when you hold the screen | Gives the screen back to the agent | none | Red text | `Screen.tsx:105`, `Screen.tsx:127` |
| `Close` button | Closes the panel. If you still hold the screen, the server gives it back after 30 s with no Screen view open | none | none | `Screen.tsx:128`, `shared/screen.ts:47` |
| `Reconnect` button, after the connection closed | Opens a fresh connection | none | none | `Screen.tsx:135` |
| Keys and clicks on the screen, while you hold it | Go to the box. Without the hold the view is look-only | none | none | `Screen.tsx:95-100` |

| State | When | What shows | Code |
|---|---|---|---|
| Loading the code | The panel's code is being fetched | An empty panel named `Screen` with `Loading the screen…` | `App.tsx:164` |
| Connecting | The WebSocket is opening | A grey dot and `Connecting…` | `Screen.tsx:139-142` |
| Live, holder unknown | The connection is live and no control message has arrived | A green dot and `Connecting…` | `Screen.tsx:115`, `Screen.tsx:140-141` |
| The agent holds it | Live, control is the agent's | A green dot and `The agent has the screen.` | `Screen.tsx:116` |
| You hold it | Live, control is yours | A green dot and `You have the screen. Your keys and clicks go to the box.` in heavier type | `Screen.tsx:117`, `Screen.tsx:139` |
| A teammate holds it | Live, control is theirs | `{login} has the screen.` | `Screen.tsx:117` |
| Closed | The connection ended | The reason in a status block with `Reconnect`. The reason is the server's sentence, or `The connection to the screen dropped.` when there is none | `Screen.tsx:45`, `Screen.tsx:131-137` |

Reasons the server gives when it closes a screen (`server/screens.ts`):

- `The box is not connected. It may be stopped.`
- `The box did not answer. Try again in a moment.`
- `The box closed the screen.`
- `This screen has shown work you can't see.`
- `The screen takes binary frames only.`

The app itself closes with `the app could not read who holds the screen` when a control message does not match its schema (`Screen.tsx:41`). A refusal before the connection opens, such as `Only the app may open a screen.`, reaches the browser as a failed connection with no reason, so the panel shows `The connection to the screen dropped.`

The screen area is a region named `The screen of {machine name}` (`the box` until read), scaled to fit, with no resizing of the box's desktop. The panel does not show who else is watching. At phone width the panel replaces the main area.

### 2.23 History and replay (`#/history`)

Everyone on the team sees the page, and each person sees only the sessions they may see. A session is shown when its conversation, its task or its connected folder is shown to them, the rule the sync proxy's `events` shape uses. A private conversation, a private task and a private folder are left out of the list, the search and the replay for anyone they are private from. `HistoryPage` is `History.tsx`, and the replay is `Replay.tsx`. The page reads through four routes (`server/history-routes.ts`) and holds no live shape. The four lists a filter chooses from are read again every 60 s.

The list shows every session, newest active first, thirty at a time. A row has a kicker with the kind of session, `Conversation`, `Task`, `Run` or `Terminal`, and ` · Private` when the session is private, then the time it was last active. Under it, in heavier type, what it was for, such as `# launch`, `Direct message with {people}`, a task's title, `{pipeline} run: {title}` or a terminal's folder and the folder inside it. A terminal session and a direct message also quote what was first said. The last line says who did the work (`{agent} for {person}`, `Your terminal` or `{name}'s terminal`), the machine, how long it ran, how many steps it has, how it ended (`Working`, `Waiting for an answer`, `Waiting for approval`, `Finished`, `Interrupted`, `Stopped at a limit` or `Failed`), what a pipeline stage reported, and how many steps went wrong. A session that is working or waiting has a dot, which is the only color on the row.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| Search box | Enter searches the text of every step for the words. Any of the words matches. The words are in the address. An empty box and Enter ends the search | none | Red text in the list | `History.tsx` |
| `Search in` select | Reads every step (`Everything`), only `Messages`, only `Tool calls and results`, or only `Steps that went wrong` | none | Same | `History.tsx` |
| `Agent`, `Person`, `Kind`, `Project`, `Repo` selects | Keep the sessions of that choice. A person is the one who started the session, or whose terminal it was. Terminal sessions belong to no project or repo | none | Same | `History.tsx` |
| `Day` select | The last 14 days, `Today` and `Yesterday` first. Keeps the sessions that ran, or waited, on that day on the person's own clock. A search keeps the steps taken that day | none | Same | `History.tsx` |
| `Clear filters` | Takes every choice off and keeps the search | none | none | `History.tsx` |
| `Clear search` | Ends the search and its scope | none | none | `History.tsx` |
| A row | Opens the replay at the first step | none | none | `History.tsx` |
| A result | Opens the replay at the step that matched, with the words that matched in heavier type in its snippet | none | none | `History.tsx` |
| `Show more` | Reads the next thirty | none | Red text | `History.tsx` |

The replay has a header with a kicker (`Replay · {kind}`), what the session was for, the same facts as a row, `Open the conversation`, `Open the task`, `Open the run` or `Open the terminal session`, and `All history`. Under it are the controls and the position, then the steps.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Play` and `Pause` | Plays on from the current step. Each step stays as long as the real time before the next, between 0.4 and 2.5 seconds, divided by the speed. Playing from the last step starts over. It stops at the last step | none | Red text with `Try again` | `Replay.tsx`, `shared/replay.ts` |
| `Previous step` and `Next step` | Move one step | none | Same | `Replay.tsx` |
| `Previous error` and `Next error` | Jump to the step that went wrong before or after the current one. Disabled when there is none | none | Same | `Replay.tsx` |
| `Speed` select | 1x, 2x, 4x or 8x | none | none | `Replay.tsx` |
| The slider, `Position in the session` | Goes to a step number. Arrow keys move a step, and Home and End go to the first and the last. A mark under it is each step that went wrong, and clicking one jumps to it | none | Same | `Replay.tsx` |
| A step's number | Makes it the current step | none | none | `Replay.tsx` |
| `Show earlier steps`, `Show later steps` | Move to the edge of the steps loaded and load the next page there | none | Same | `Replay.tsx` |

A step has its number, its kind (`Message`, `Reply`, `Thinking`, `Tool`, `Result`, `Asked`, `Answer`, `Notice`, `Error` or `Turn ended`) and tool, `Went wrong` when it did, and its time, with the day when a new day begins. A message, a tool call with each field of its input, and a result show in full, read from the event's body. A reply is Markdown. The current step is on a brighter surface with its whole text, and a long part of any other step folds to its first line. The steps after the current one are in muted type. Bookkeeping notices are not steps, so the numbers skip them.

| State | When | What shows |
|---|---|---|
| Loading | The first page has not arrived | `Loading…` on the list, `Loading the steps…` on a replay |
| Nothing recorded | No session is shown | `Nothing has been recorded yet.`, or `No session matches these filters.` |
| No result | A search finds nothing | `No step matches those words.` |
| Not visible | The replay's session is private from the person, or is not there | `This session is not one you can see.` and a link to `All history` |
| No steps | The session has none | `This session has no steps yet.` |
| Working | The session is working or waiting | The replay reads the session again every 5 s, so later steps can be loaded |

A replay holds at most 200 steps, those nearest the current one, and asks for at most 100 step numbers at a time. Nothing loads the whole session. The address names the step a replay is paused on, as `#/history/{session id}/{step}`, without adding to the browser's history. At phone width the controls wrap, the filters wrap, and nothing scrolls sideways.

## 3. Shared components and their states

These parts appear on more than one screen. Each screen's section links here rather than repeating them.

### 3.1 Markdown

`Markdown` (`Markdown.tsx:30-99`) renders what agents write. It builds React elements and never inserts raw HTML, and it follows only `http` and `https` links, so nothing an agent writes can run in the page (`Markdown.tsx:1-4`). It is used for agents' replies in conversations and tasks, stage summaries up to four lines, the `.md` files in the File and Document panels, and agents' memories.

| Syntax | What shows | Code |
|---|---|---|
| `#` to `######` at the start of a line | A heading, two levels down from the page's own: `#` is an `h3`, and `####` and deeper are `h6` | `Markdown.tsx:56-64` |
| A paragraph | A paragraph. Line breaks inside it are kept | `Markdown.tsx:91-97`, `styles.css:216` |
| Lines starting with `-`, `*`, `+`, `1.` or `1)` | A bulleted or numbered list, by its first line. Lists do not nest. An indented line joins the item above it | `Markdown.tsx:79-90` |
| A fenced block of three backticks | A preformatted block on a raised surface, with no highlighting. An unclosed fence runs to the end | `Markdown.tsx:49-55` |
| Lines starting with `>` | A quote with a hairline on its left, in muted type | `Markdown.tsx:70-74` |
| Three or more `-` or `*` alone on a line | A horizontal rule | `Markdown.tsx:65-69` |
| Lines that start with a vertical bar | The lines as preformatted text. They are not drawn as a table | `Markdown.tsx:75-78` |
| `**bold**`, `*italic*` and backticks | Bold, italic and inline code | `Markdown.tsx:17-19` |
| `[text](https://…)` and a bare `https://…` | A link that opens in a new tab with no referrer. Any other scheme stays as text | `Markdown.tsx:20-21` |

Images, raw HTML, nested lists, tables and footnotes are not supported. An image written as `![alt](https://…)` shows a `!` followed by a link.

### 3.2 Code view

`CodeView` (`Code.tsx:7-19`) shows a file with line numbers. It is a focusable region named `{path}, {n} lines`. Long lines wrap. The numbers are hidden from screen readers. A trailing newline adds no empty line (`highlight.ts:95-97`).

Highlighting (`highlight.ts`) marks keywords, strings, comments and numbers by weight and tone, never by hue. Keywords are bold, numbers semi-bold, comments muted italic, and strings sit on a raised surface (`styles.css:368-371`). The language comes from the file's extension, and an unknown one is plain text.

| Family | Extensions | Code |
|---|---|---|
| Scripts | `js` `jsx` `mjs` `cjs` `ts` `tsx` `mts` `cts` `go` | `highlight.ts:41` |
| C-like | `java` `kt` `kts` `scala` `swift` `rs` `c` `h` `cc` `cpp` `hpp` `cs` `dart` `php` | `highlight.ts:42-43` |
| Style | `css` `scss` `less` | `highlight.ts:44` |
| Data | `json` `jsonc` | `highlight.ts:45` |
| Hash comments | `py` `rb` `sh` `bash` `zsh` `yaml` `yml` `toml` `ini` `r` `pl` `ex` `exs` `conf` `cfg` `dockerfile` `makefile` `gitignore` `env` | `highlight.ts:46-47` |
| SQL | `sql` | `highlight.ts:48` |
| Markup | `html` `htm` `xml` `svg` `vue` | `highlight.ts:49` |

### 3.3 Diff view

`DiffView` (`Code.tsx:57-75`) shows a unified diff as rows with old and new line numbers. It is a focusable region whose name the caller gives, such as `The change to {path}` or `What changed in {path} in version {n}`. `parseDiff` (`Code.tsx:30-55`) turns git's text into rows.

| Row | What shows | Code |
|---|---|---|
| Hunk header | The line that starts with `@@`, in muted type | `Code.tsx:36-41` |
| Note | Lines that start with `new file`, `deleted file` or `Binary files`, and git's backslash lines, such as the one about a missing newline at the end of a file, in muted type. Other lines before the first hunk are left out | `Code.tsx:42-43`, `Code.tsx:50-51` |
| Added | A `+` sign, the new line number, the text in heavier type on a raised surface | `Code.tsx:44-45`, `styles.css:365` |
| Removed | A `−` sign, the old line number, the text in muted type | `Code.tsx:46-47`, `styles.css:366` |
| Unchanged | Both line numbers | `Code.tsx:48-49` |
| Nothing | When the diff has only notes or no rows, the line `Nothing changed in the text.` shows in place of the region | `Code.tsx:59` |

Screen readers hear ` added: ` or ` removed: ` before a changed line (`Code.tsx:68`). Proposals draw their diffs with a smaller component, which marks only lines that start with `+` or `-` (3.12).

### 3.4 Tabs

`Tabs` (`Code.tsx:78-105`) draws the `File` and `Diff` tabs. It follows the ARIA tabs pattern. The selected tab sits on a raised surface in heavier type. Left and Right move to the previous and next tab, wrapping, and move focus with them. Home and End do nothing. Only the selected tab is in the tab order. The panel is a `tabpanel` labelled by its tab.

### 3.5 File panel

See 2.21.

### 3.6 Link field

`LinkField` (`LinkField.tsx:5-13`) shows a link to copy by hand, such as a Tailscale invite link. A muted label sits above a read-only box in monospace type. Focusing the box selects all of it. There is no copy button, because the clipboard API needs a secure page and the tailnet serves plain HTTP. It appears for new invites (`Invite link, to send yourself`), for an open invite's `Link` and `Resend` (`Invite link for {email}`), and for Tailscale's own invites (`Invite link for {email}`).

### 3.7 Repo picker

`RepoPicker` (`RepoPicker.tsx:7-24`) is a set of checkboxes in a group whose legend is `Repos`. It appears on New task and on a draft.

| Part | What shows | Code |
|---|---|---|
| A repo | A checkbox labelled with the repo's owner and name, sorted by name | `RepoPicker.tsx:11`, `RepoPicker.tsx:15-18` |
| Primary | The first repo ticked gets a muted `primary` beside it once more than one is ticked. The order of ticking is the order sent | `RepoPicker.tsx:10`, `RepoPicker.tsx:18` |
| In a project | Only the project's repos show, plus any repo the draft already has | `RepoPicker.tsx:9` |
| Empty | `The project has no repos yet.` in a project, `The team has no repos yet.` otherwise. Before the first read the same text shows | `RepoPicker.tsx:21` |

The list polls every 30 s.

### 3.8 Approval cards

An ask is anything waiting on a person. It shows as a card where the work is, and anyone who can see the work can answer it. `AskCard` is `Asks.tsx:12-74`. It shows in a conversation (open asks of that conversation), on a task (open asks of the shown session) and on a run (open asks of the run).

| Kind | The card | Buttons | Code |
|---|---|---|---|
| A tool approval | A section named `Needs approval`. A kicker with a pause glyph and `Needs approval`. The tool's name in bold, then ` · {description}` when there is one. A preformatted box with the command, file path or path, the first of those present | `Allow once` (primary style), `Always allow`, `Deny`, `Never` (transparent). There is no note box | `Asks.tsx:28-45` |
| A gate | A section named `Needs a decision`. A kicker with a pause glyph. The question, any links, and the note box `Add a note (optional)` | One button for each option, in the gate's order, the first in the primary style. `approve` reads `Approve` and `reject` reads `Reject`, unless the gate names its own words, such as `Approve research`, `Merge` or `Send back` | `Asks.tsx:6-8`, `Asks.tsx:47-73`, `pipelines/research-plan-implement.ts:77`, `pipelines/research-plan-implement.ts:133` |
| Any other kind, such as a stage's hand-off | A section named `Needs a person`, laid out as a gate | `retry` reads `Try again` and `stop` reads `Stop, I will take over`. Any other option shows its own name, such as `fix` or `overrule` | `Asks.tsx:6-8`, `Asks.tsx:50`, `Asks.tsx:53`, `server/framework.ts:702`, `server/framework.ts:811` |

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| A tool button | Answers `allow`, `always`, `deny` or `never`. `Always allow` and `Never` also make a standing rule on the server, which the app cannot list or remove | none | Red text under the buttons with `role="alert"` | `Asks.tsx:16-26`, `Asks.tsx:37-40`, `server/record.ts:197-203` |
| A gate or hand-off button | Answers with that option and the note, trimmed, when one is written | none | Same | `Asks.tsx:64-70` |
| A link in a gate | Opens in a new tab | none | none | `Asks.tsx:57-59` |

| State | When | What shows | Code |
|---|---|---|---|
| Answering | A request is under way | Every button is disabled | `Asks.tsx:37-40`, `Asks.tsx:66` |
| Answered | The server recorded the answer | The card leaves when the live asks shape drops the row. The buttons enable again as soon as the request returns, which can be before then | `Asks.tsx:16-26` |
| Refused | The server said no | Its words, such as `this ask is already answered`, `this ask is no longer open, since the turn that raised it ended`, `only {login} can answer this`, or `decision must be one of {options}` | `server/record.ts:192-193`, `server/runner.ts:190-196` |
| A question with line breaks | The question holds several lines, as the framework's findings do | They show as one run-on paragraph, since the question's paragraph keeps no line breaks | `Asks.tsx:54`, `styles.css:67` |
| An unknown kind with no options | A kind other than the three above, with no `options` | The question and no buttons | `Asks.tsx:47`, `Asks.tsx:65` |

### 3.9 Command palette

The palette finds agents, conversations, tasks, runs, pipelines and documents, and starts new tasks, rooms and agents. `Palette` is `Palette.tsx:139-213`. It is a native modal `dialog` named `Go to`, so the page behind it is inert, focus stays inside, `Esc` closes it, and focus returns to what had it before. Its lists load when it opens and refresh every 5 s while it is open. Everyone on the team has it.

| Key or control | What happens | Code |
|---|---|---|
| `⌘K` on a Mac, `Ctrl+K` elsewhere | Opens the palette, or closes it when open. It works inside text fields. On a Mac `Ctrl+K` is left to the field, where it deletes to the end of the line | `Palette.tsx:23-24`, `Palette.tsx:50-59` |
| The topbar `Go to` and the sidebar `Go to` | Open the palette | `App.tsx:135`, `App.tsx:297` |
| Typing | Narrows the results. Every word typed must appear in an item's label, hint or group name. Results keep the group order below. Within a group, a label that starts with the first word comes first, then one that has it as a later word, then the rest, each sorted by label | `Palette.tsx:125-137` |
| `↓` and `↑` | Move through the results and wrap at the ends | `Palette.tsx:167-170` |
| Mouse over a result | Highlights it | `Palette.tsx:193` |
| `Enter`, or a click on a result | Opens it, closes the palette and moves focus to the main area | `Palette.tsx:157-165`, `Palette.tsx:171-175` |
| `Esc` | Closes the palette | native dialog |
| Click outside the box | Nothing. The backdrop has no handler | `Palette.tsx:180` |
| `Single-key shortcuts` checkbox | Turns `c` and `r` on or off, and shows or hides the `C` and `R` hints. The choice is kept in this browser under `agents.single-key-shortcuts` | `Palette.tsx:206-209`, `Palette.tsx:21-42` |
| `c` and `r` outside the palette | `c` opens New task and `r` opens New room. They do nothing in a field, with Ctrl, Cmd or Alt held, while a dialog is open, or while text is being composed. Shift+C does nothing | `Palette.tsx:60-68` |

| Group | Items | Opens | Hint shown | Code |
|---|---|---|---|---|
| Actions | `New task`, `New room`, `New agent` | The forms 2.5, 2.4 and 2.11 | `C` and `R` on the first two, when single keys are on | `Palette.tsx:93-95` |
| Agents | Every agent | Your DM with the agent | The agent's title | `Palette.tsx:96-99` |
| Conversations | Every visible conversation | The conversation | `room` for rooms | `Palette.tsx:100-103` |
| Tasks | Tasks that are not pipeline runs and not replays | The task | `draft` for drafts | `Palette.tsx:105-107` |
| Runs | Runs that are not replays. A label is the task's title, else the report's title, else `A run` | The run | The run's short status | `Palette.tsx:108-111` |
| Pipelines | Every pipeline | The pipeline | none | `Palette.tsx:112` |
| Documents | Every document of every task the person can see | The document beside its run or task | The task's title | `Palette.tsx:113-119` |

Each group shows at most 6 items, and Actions shows all 3 (`Palette.tsx:20`, `Palette.tsx:136`). With nothing typed, each group shows the first six by name, not the six newest.

| State | When | What shows | Code |
|---|---|---|---|
| Open | Always | A search box (a combobox) with the placeholder `Find an agent, conversation, task, run, pipeline or document`, the grouped results, and a footer | `Palette.tsx:181-183` |
| Footer | Always | `↑` `↓` to move, `Enter` to open, `Esc` to close, `⌘K` from anywhere, with `Ctrl+K` off a Mac | `Palette.tsx:24`, `Palette.tsx:205` |
| No match | Nothing fits what was typed | `Nothing matches.` | `Palette.tsx:201` |
| Failed to open | An agent's DM could not be opened | The error in red inside the results, with `role="alert"`. The palette stays open | `Palette.tsx:157-165`, `Palette.tsx:202` |
| Highlighted | One result is active | A brighter surface and heavier type, `aria-selected` | `Palette.tsx:192`, `styles.css:399` |

The results are a listbox named `Results`, in groups named for their headings, and the search box points at the active option with `aria-activedescendant`. The palette is `min(640px, calc(100vw - 32px))` wide (`styles.css:386`).

### 3.10 Changes and pull requests

`Changes` (`Changes.tsx:14-74`) lists what a task's agent added, changed or deleted in each repo, against the base branch. It shows on tasks and runs. The files poll every 3 s and the pushes every 2 s. `PullRequests` (`Changes.tsx:79-130`) follows it on tasks only.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| A file row | Opens the File panel (2.21). The open file's row has `aria-current` and the selected surface | none | none | `Changes.tsx:52-54` |
| The `Title and description` disclosure, with `Title` (starts as the task's title) and `Description` (4 lines). It shows until a pull request exists | Sets the pull request's words | none | none | `Changes.tsx:111-119` |
| `Open pull request` button. It reads `Update pull request` once pull requests exist and `Try again` after a failed push. It is disabled while the agent is working, while a push is under way, while busy, or with no title | Pushes every repo's task branch and opens a pull request for each repo with commits past its base. Asking again pushes new work to the same pull requests and keeps their title and description | none | Red text beside the button | `Changes.tsx:88-99`, `Changes.tsx:121-123` |
| A pull request link | Opens it in a new tab | none | none | `Changes.tsx:104` |

| State | When | What shows | Code |
|---|---|---|---|
| Nothing | The task has no changed files and no unlisted repos | No section at all | `Changes.tsx:34` |
| Failed | Either read did not fit its schema | The error in red, and the pull request block | `Changes.tsx:33` |
| Listed | Files differ | A heading `Changes` followed by a muted `· {n} file` or `files`, with ` listed` after it when some repo could not be listed. Then a heading for each repo, `a repo` until repos are read, and its files sorted by path | `Changes.tsx:38-41`, `Changes.tsx:22-31` |
| A file | Each row | The path in monospace type, then `added`, `changed` or `deleted`, and for text files `+{added} −{removed}` | `Changes.tsx:8`, `Changes.tsx:54-62` |
| Too many | A repo has more than 20,000 changed files | `More than {n} files changed, too many to list.`, where `{n}` reads 20,000 | `Changes.tsx:42-44` |
| Unreadable | Git could not read a repo | `Couldn't read the changes: {reason}`, with ` The list is the last one read.` when a list is shown. The repo still counts as changed | `Changes.tsx:45-47` |
| Pushing | A push is under way | `Pushing the branch and opening the pull request…` as a status | `Changes.tsx:107` |
| Push failed | The latest push failed | The server's reason in red, for example `The push failed: {reason}`, `There is nothing to open a pull request for. No branch has commits past its base.` or `The machine did not finish the push within {n} minutes.` | `Changes.tsx:108`, `server/pulls.ts:79`, `:85`, `:111` |
| Agent working | A session is in flight | `The agent is working. Open the pull request when its turn ends.` | `Changes.tsx:124` |
| Refused | The server said no | Its words, for example `the agent is still working. Open the pull request when its turn ends.`, `a push for this task is already under way`, `the task's workspace is not set up yet`, `this task has no repo to open a pull request on` or `the task's agent is gone, and its commits are made in its name` | `Changes.tsx:125`, `server/pulls.ts:28-51` |
| No form | Nothing differs and no pull request exists | Neither the form nor the block shows. Links stay once nothing differs | `Changes.tsx:87`, `Changes.tsx:110` |

### 3.11 Order of work

`TaskOrder` (`Order.tsx:92-209`) puts a task in the order of work: its priority, what it waits on, its hold, and done or not. It sits on the task and draft pages, in a section named `Order of work`. The sidebar's Ready and Held lists read the same data (1.2). Every command says when it changed nothing. The task, blocker and hold rows poll every 2 s to 4 s, and the ready query every 4 s.

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| `Priority` select: `0, most urgent`, `1`, `2`, `3`, `4, least urgent`. Disabled once the task is done | Sets the priority now | none | Red text under the line | `Order.tsx:24-26`, `Order.tsx:143-147` |
| `Mark done` button, or `Reopen` once done | Marks the task done, or reopens it | none | Same | `Order.tsx:148-150` |
| A task's title under `Waits on` | Opens that task | none | none | `Order.tsx:155`, `Order.tsx:161` |
| `Remove` beside a task under `Waits on` | Stops waiting on it | none | Same | `Order.tsx:155`, `Order.tsx:163` |
| The form `Wait on another task`: a select starting at `Wait on…` (spoken as `Task to wait on`), a box `Why (optional)`, and `Add`. Disabled until a task is picked. It shows while the task is open | Makes this task wait on the one picked, with the reason. The choices leave out this task, done tasks and those already waited on | none | Same, for example `that task already waits on this one, so this would make them wait on each other` | `Order.tsx:169-180`, `server/order.ts:84` |
| The form `Hold this task`: a select of five kinds, a box (placeholder `Why, in one line`), a date `Until (optional)`, and `Hold`. Disabled with no reason. It shows while the task is open and has no current hold | Holds the task, with the kind, reason and end date | none | Same | `Order.tsx:193-205` |
| `Lift hold` | Removes the hold | none | Same | `Order.tsx:190` |

| State | When | What shows | Code |
|---|---|---|---|
| Saved | A command changed something | `Saved.` beside the priority line, as a status | `Order.tsx:89`, `Order.tsx:151` |
| No change | The command found nothing to change | `Nothing to change.` | `Order.tsx:89` |
| Reads failed | A read did not fit its schema | The error in red at the top of the section | `Order.tsx:141` |
| Waits on | Always | A list named `Waits on`. Each row has the task's title (`a task you cannot see` for a private one), `done` or `not done`, and ` · {reason}` when there is one | `Order.tsx:155-168`, `Order.tsx:106` |
| Nothing | The task waits on nothing | `Nothing` | `Order.tsx:167` |
| Waiting on this | Other tasks wait on this one | `Waiting on this: {titles}` | `Order.tsx:181-183` |
| A hold | The task is held | `{kind}: {reason}`, then `, until {date}` when it has an end date, with the date as written (year-month-day) | `Order.tsx:186-188` |
| Lapsed | The hold's end date has passed by the server's date | The muted word `lapsed`, and the hold form shows again | `Order.tsx:111`, `Order.tsx:189`, `Order.tsx:193` |
| No hold | The task is not open and has no hold | `No hold.` | `Order.tsx:206` |
| Done | The task is done | The priority select is disabled, and the wait and hold forms are hidden | `Order.tsx:112`, `Order.tsx:144` |

The hold kinds read `Waiting on a decision`, `Waiting on someone outside the team`, `Waiting for room to work on it`, `Parked` and `Later` (`Order.tsx:16-22`). Server refusals include `this task is done`, `this draft was discarded`, `a task cannot block itself`, `that task was discarded` and `no such task to wait on` (`server/order.ts:14-19`, `:63-70`).

### 3.12 Proposals

A proposal is a change a pipeline suggests to a pipeline's file, an agent's instructions or an agent's skills. It shows on the run that proposed it and, for pipeline changes, on the pipeline's page. `ProposalView` is `Proposal.tsx:40-72`, a section named `Proposed change`. The hunks and the names of people and agents load only while a proposal is on the page (`Proposal.tsx:8-19`).

The section opens with a kicker, `Proposed {what} · {status} · {time}`. The `what` reads `pipeline change`, `skill {name}`, `change to {agent}` or `instructions change`. The status reads `being scored`, `waiting for the shepherd`, `approved`, `turned down` or `could not be scored` (`Proposal.tsx:21-23`, `Proposal.tsx:44-50`). Then come the summary, the scores, the hunks and a line with links.

| Part | What shows | Code |
|---|---|---|
| Run scores | A table with the columns `Version`, `Finished`, `Reminders and hand-offs`, `Stages run`, `Cost` and `Time`, and the rows `With the change` and `Current`. `Finished` reads `{n} of {replays}` | `Proposal.tsx:74-94` |
| Session scores | A table with the columns `Version`, `Corrections still needed` and `Other turns worse`, with the same two rows. The cells read `{still} of {behind}` and `{worse} of {unrelated}`, or `none replayed` | `Proposal.tsx:96-113` |
| Hunks | An ordered list named `Hunks`. Each hunk has `{n}. {title}` in bold, and muted counts of its sessions, split as `people's`, `pipeline` and `box`, with the number of people | `Proposal.tsx:26-27`, `Proposal.tsx:54-57`, `Proposal.tsx:139` |
| A hunk's change | A disclosure `The change`, open, holding the diff. A hunk that suggests a lint rule, type or check shows its text as a paragraph | `Proposal.tsx:140-142` |
| The diff | One line per row. A line that starts with `+` is bold on a raised surface, and one that starts with `-` is muted and struck through | `Proposal.tsx:29-35`, `styles.css:230-231` |
| Quotes | A list named `What hunk {n} rests on`. Each quote is a block quote, with muted text that gives who said it (the login, or `a {source} session`), `step {seq}`, and the kind of finding, then `: {about}` | `Proposal.tsx:143-150` |
| Without hunks | A disclosure `The diff`, open while the proposal is open | `Proposal.tsx:58-63` |
| Links | `Pull request` in a new tab, and on a pipeline page `The run that proposed it` | `Proposal.tsx:65-69` |

Hunk titles read `Add a rule`, `Reword a rule`, `Delete a rule`, `Add the skill {name}`, `Change the skill {name}`, `Add to {login}'s profile`, `Make this a lint rule, type or check`, `Add lines`, `Change lines` and `Remove lines` (`Proposal.tsx:115-123`). A quote's kind reads `a correction no rule covers`, `a rule ignored`, `a rule that caused harm` or `a rule followed` (`Proposal.tsx:24`).

| Control | What happens | Confirm | On failure | Code |
|---|---|---|---|---|
| The reason box on a hunk (spoken as `Why, for hunk {n}`, placeholder `Why, needed to turn it down`) | The reason for a decision | none | none | `Proposal.tsx:159` |
| `Keep` button on a hunk | Records that the hunk stays | none | Silent | `Proposal.tsx:128-136`, `Proposal.tsx:160` |
| `Turn down` button on a hunk. Disabled until a reason is written | Records that the hunk goes, with the reason | none | Silent | `Proposal.tsx:161` |

These three show only on a proposal to change an agent that is still open (`Proposal.tsx:47`). Above them a line reads `Keep or turn down each hunk, then answer the gate. Approving keeps every hunk you have not turned down.` A decided hunk shows `Kept` or `Turned down` with a glyph, then `by {login}: {reason}` (`Proposal.tsx:151-156`).

### 3.13 Event list

`EventList` (`Session.tsx:10-28`) shows everything one session did, in order, and keeps adding. It is a focusable list named `Events` and fills the Session panel and the terminal session page. Events are live.

| Part | What shows | Code |
|---|---|---|
| An event | A kicker with its kind, the time, and its text in a preformatted block. The kind reads `Message`, `Reply`, `Thinking`, `Tool`, `Result`, `Asked`, `Answer`, `Notice`, `Error` or `Turn ended`, followed by ` · {tool name}` for tool events | `Session.tsx:4-7`, `Session.tsx:18` |
| An interrupt | A notice about a stop shows as `Interrupted` | `Session.tsx:18` |
| Sub-agent work | Indented, under the call that started it | `Session.tsx:16`, `styles.css:160` |
| Long text | Over 280 characters, it folds into a disclosure whose summary is the first 200 characters and `…` | `Session.tsx:21-23` |
| Notices | Only the start (`init`), interrupt and screen notices show. Other notices are left out | `Session.tsx:15` |
| Empty | A session with no events shows an empty list with no text | `Session.tsx:13-27` |

### 3.14 Status dots and words

A dot is 8 px, round, and its color means live state only. Everything else is grey, so a dot never tells done from failed.

| Dot | Values | Code |
|---|---|---|
| Green | `online`, `running`, `starting` | `styles.css:132` |
| Amber | `needs_approval`, `needs_input`, `stale`, `waiting` | `styles.css:133`, `styles.css:164` |
| Grey | Any other value, among them `offline`, `idle`, `lost`, `failed`, `done`, `cancelled`, `queued`, `pending` and `paused` | `styles.css:131`, `styles.css:165` |

Where words show.

| Thing | Words | Code |
|---|---|---|
| A session's status | Its raw status with the first `_` turned into a space: `starting`, `running`, `idle`, `needs input`, `needs approval`, `limited`, `lost`, `failed` | `Session.tsx:47`, `Work.tsx:153`, `App.tsx:442` |
| A run's status | `queued`, `running`, `waiting on a person` (`waiting` in the sidebar), `done`, `stopped`, `cancelled`, or the raw status | `Run.tsx:14-16` |
| A stage | Its raw status (`pending`, `running`, `waiting`, `done`, `failed`, `cancelled`) until it has an outcome | `Run.tsx:87` |
| A machine | `online`, `stale`, `offline` | `App.tsx:249` |
| A person's box | `ready`, `starting`, `could not start` | `Team.tsx:37-40` |

### 3.15 Confirm in place

Two actions ask before they run, and both are on the Tailscale page. `Remove` on a user or a device is replaced by `Remove {name} from the tailnet?` with `Yes, remove` and `Keep`. `Disconnect Tailscale` is replaced by `Remove the key from the server? Invites stop going through Tailscale.` with `Yes, disconnect` and `Keep it` (`Tailscale.tsx:213-224`, `Tailscale.tsx:297-316`). The question appears where the button was and nothing else moves. No other action in the app asks first, including `Discard draft`, `Cancel run`, `Cancel` on an invite, and every `Remove` on an agent's page.

### 3.16 Tailscale key notice

`KeyWarning` (`Tailscale.tsx:49-59`) is a raised box named `Tailscale key`, with the kicker `Tailscale key`, the warning in bold, and how to make a new key. It shows to admins on the Team page and the Tailscale page, and a one-line version in the sidebar, from 14 days before the key expires.

| Warning | Text | Code |
|---|---|---|
| Close to expiry | `The Tailscale key expires in {days}, on {date}.` The count reads `day` for one and `days` for more | `Tailscale.tsx:45-46` |
| Expired | `The Tailscale key expired on {date}. Invites and the Tailscale page stop working until it is replaced.` | `Tailscale.tsx:39-43` |
| How to renew | `In the Tailscale admin console, open Settings, then Keys, and generate an API access token. Tailscale lets it last 1 to 90 days. Paste it on the Tailscale page here.` | `shared/onboarding.ts:195-196` |

It shows nothing when Tailscale has no key, the key's date is unknown, or more than 14 days remain. The status is read every 60 s, and a failed read is logged to the browser console only, as `the Tailscale key status:` and the reason (`Tailscale.tsx:11`, `Tailscale.tsx:21-24`).

### 3.17 Project and place lines

`InProject` (`Projects.tsx:257-261`) shows `In {project}, with its repos.` with the project's name as a link, or `In a project.` until projects are read. It appears on New room, New task and a draft. `TaskPlace` (`Projects.tsx:264-276`) shows `In {project}. ` with the name as a link, then `Works in {repo names}.` or `No repo.`

## 4. Messages a person can see

This section quotes the words the app shows while it waits, when it fails, and when a list is empty. A value that varies is a name in braces. The first three tables are the app's own words. The last two are words the server and the machine write, which the app shows as written.

### 4.1 Waiting

| Text | Where it shows | Code |
|---|---|---|
| `Connecting…` | The first screen, before the app knows who you are | `App.tsx:108` |
| `Connecting…` | The Screen panel while it opens or while control is unknown | `Screen.tsx:115`, `Screen.tsx:141` |
| `Loading the screen…` | The Screen panel while its code loads | `App.tsx:164` |
| `Loading the task…` | A task whose row is not read | `Work.tsx:132` |
| `Loading the run…` | A run whose row is not read | `Run.tsx:41` |
| `Loading the pipeline…` | A pipeline whose row is not read | `Pipeline.tsx:45` |
| `Loading the agent…` | An agent whose row is not read | `AgentPage.tsx:19` |
| `Loading the project…` | A project whose row is not read | `Projects.tsx:394` |
| `Loading the session…` | A terminal session before the list is read | `Terminal.tsx:28` |
| `Loading the draft…` | A draft before its repos are read | `Draft.tsx:30` |
| `Loading…` | A document before a version is read, a diff being fetched, a file before its row is read | `Document.tsx:58`, `Document.tsx:93`, `FilePanel.tsx:40` |
| `Starting…` | A task that has no session yet | `Work.tsx:165` |
| `Waiting for a machine…` | A run with no stage rows yet | `Run.tsx:98` |
| `Asking Tailscale…` | The Tailscale page before its first read | `Tailscale.tsx:112` |
| `Asking the server about GitHub…` | The GitHub block before the status arrives | `Projects.tsx:21` |
| `Reading each forge…` | The repo lists before the overview arrives | `Projects.tsx:179`, `Projects.tsx:425` |
| `Making {owner}/{name} on GitHub…` | A repo request that is creating | `Projects.tsx:288` |
| `Pushing the branch and opening the pull request…` | A task whose push is under way | `Changes.tsx:107` |
| `Starting. This takes under a minute.` | Your box while it starts | `Box.tsx:98` |
| `Your box, {name}, is starting.` | The first-steps list while the box starts | `Box.tsx:36` |
| `Getting a sign-in link from your box` | A Claude sign-in that has started. It ends with a full stop after one of the next two | `Box.tsx:152` |
| `, once it starts` | The box could not start yet | `Box.tsx:152` |
| `, which is still starting` | The box is starting | `Box.tsx:152` |
| `Your box is checking the code with Claude.` | A Claude sign-in that has the code | `Box.tsx:177` |
| `Enter this code on GitHub's device page to connect.` | A GitHub sign-in waiting for its code | `Projects.tsx:47` |
| `. This page changes when you are done there.` | After the link in the same block | `Projects.tsx:49` |
| `This page opens the app by itself once they do.` | The waiting-to-join page | `Team.tsx:29` |
| `sending` | A post not yet in the conversation | `Conversation.tsx:104` |
| `waiting for approval`, `writing`, `thinking` | An agent working in a conversation | `Conversation.tsx:192` |
| `working` | An agent working on a task | `Work.tsx:212` |
| `The agent is working. Open the pull request when its turn ends.` | The pull request form while the agent works | `Changes.tsx:124` |

### 4.2 Empty states

| Text | Where it shows | Code |
|---|---|---|
| `No projects yet` | Sidebar, Projects | `App.tsx:337` |
| `No agents yet` | Sidebar, Agents | `App.tsx:363` |
| `Nothing yet` | Sidebar, Conversations | `App.tsx:375` |
| `No tasks yet` | Sidebar, Tasks | `App.tsx:388` |
| `None yet` | Sidebar, From terminals | `App.tsx:401` |
| `Nothing ready` | Sidebar, Ready | `Order.tsx:67` |
| `No pipelines yet` | Sidebar, Pipelines | `App.tsx:415` |
| `No runs yet` | Sidebar, Runs. A pipeline's run list | `App.tsx:428`, `Pipeline.tsx:101` |
| `Nothing running` | Sidebar, Running now | `App.tsx:454` |
| `Nothing matches.` | The palette | `Palette.tsx:201` |
| `Nobody is waiting. Someone who opens the app without an invite shows up here.` | Team, Wants to join | `Team.tsx:166` |
| `No open invites.` | Team, Invited. Tailscale, Invites | `Team.tsx:225`, `Tailscale.tsx:164` |
| `No users.` | Tailscale, Users | `Tailscale.tsx:124` |
| `No devices.` | Tailscale, Devices | `Tailscale.tsx:145` |
| `no box` | Team, a person with no box | `Team.tsx:70` |
| `No skills yet` | An agent's page | `AgentPage.tsx:45` |
| `No plugins yet` | An agent's page | `AgentPage.tsx:50` |
| `No routines yet` | An agent's page | `AgentPage.tsx:59` |
| `Nothing yet. The agent writes here with its update_memory tool.` | An agent's page, memory | `AgentPage.tsx:73` |
| `No title yet` | An agent with no title | `AgentPage.tsx:33` |
| `No comments yet` | The Document panel | `Document.tsx:218` |
| `Nothing changed in the text.` | A diff with no changed lines | `Code.tsx:59` |
| `Nothing` | Order of work, a task that waits on nothing | `Order.tsx:167` |
| `No hold.` | Order of work, a closed task with no hold | `Order.tsx:206` |
| `Everyone on the team is in the room.` | A room's People panel | `Conversation.tsx:175` |
| `No repos yet. New project makes one.` | The Repos page | `Projects.tsx:179` |
| `No repo yet.` | A project's repo list | `Projects.tsx:425` |
| `No repo.` | A task that works in no repo | `Projects.tsx:273` |
| `no project` | A repo that belongs to no project | `Projects.tsx:128` |
| `none` | A repo with no open pull requests, or no task branches | `Projects.tsx:138`, `Projects.tsx:146` |
| `Nobody yet` | A project with nobody in its room | `Projects.tsx:430` |
| `No tasks or runs yet` | A project | `Projects.tsx:445` |
| `No documents yet` | A project | `Projects.tsx:459` |
| `No description yet` | A project with no description | `Projects.tsx:415` |
| `The team has no repos yet.` | The repo picker, outside a project | `RepoPicker.tsx:21` |
| `The project has no repos yet.` | The repo picker, in a project | `RepoPicker.tsx:21` |
| `No box yet` | Your box, for a person with no box | `Box.tsx:65` |

### 4.3 Errors and blocked states written by the app

| Text | Where it shows | Code |
|---|---|---|
| `Can't open the app` | The error screen, as its heading | `App.tsx:102` |
| `The app knows people by their Tailscale login. Open it from a device on the tailnet.` | Under the error text on that screen | `App.tsx:104` |
| `You are not on a team yet` | The waiting page, as its heading | `Team.tsx:27` |
| `Pick an agent first.` | New task, a draft | `Work.tsx:79`, `Draft.tsx:56` |
| `Pick a repo first.` | A pipeline's Start a run form | `Pipeline.tsx:129` |
| `Pick a pipeline and a repo first.` | A project's Start a run form | `Projects.tsx:349` |
| `request failed with {status}` | Any write whose failed answer has no `error` text | `data.ts:260` |
| `The server's answer to {path} did not fit this app: {details}` | Any checked call whose answer does not match | `data.ts:273` |
| `The {name} the server sent did not fit this page: {details}` | A checked list whose rows do not match | `data.ts:203` |
| `Only team admins manage the tailnet.` | The Tailscale page for a member | `Tailscale.tsx:72` |
| `People in the room, and admins, can add a teammate.` | A room's People panel for someone who may not add | `Conversation.tsx:176` |
| `This terminal session is not one you can see.` | A terminal session page for an id not in the list | `Terminal.tsx:28` |
| `Its session failed.` | An agent's stopped line with no reason in the record | `Conversation.tsx:212` |
| `Its machine stopped in the middle of this turn.` | An agent's interrupted line with no notice in the record | `Conversation.tsx:227` |
| ` It picks up again when its machine is back.` | After either interrupted text | `Conversation.tsx:227` |
| `This file no longer differs from the base branch.` | The File panel for a file that left the changed list | `FilePanel.tsx:39` |
| `A binary file, so there is no text to show.` | The File panel | `FilePanel.tsx:11` |
| `Too large to show here.` | The File panel | `FilePanel.tsx:12` |
| `Deleted. The Diff tab shows what it held.` | The File panel, File tab, for a deleted file | `FilePanel.tsx:45` |
| `This is the first version, so there is nothing before it to compare.` | The Document panel, Diff tab, version 1 | `Document.tsx:92` |
| `Select the words you mean in the document first.` | The Document panel, `Use selection` with nothing selected | `Document.tsx:176` |
| `"{quote}" is not in version {n} any more.` | The Document panel, a comment whose quote is gone | `Document.tsx:165` |
| `More than {n} files changed, too many to list.` | Changes, a repo with over 20,000 changed files. The number reads `20,000` | `Changes.tsx:43` |
| `Couldn't read the changes: {reason}` | Changes, a repo git could not read | `Changes.tsx:46` |
| ` The list is the last one read.` | After it, when a list is shown | `Changes.tsx:46` |
| `Version {sha} does not load: {error}` | A pipeline's newest broken version | `Pipeline.tsx:89` |
| `The sign-in did not finish. {reason}` | Your box, a failed Claude sign-in | `Box.tsx:191` |
| `Agents on your box run on your own Claude account. You can sign in once your box is running.` | Your box, when the box could not start | `Box.tsx:142` |
| `It could not start.` | Your box, state | `Box.tsx:98` |
| `Your box, {name}, could not start.` | The first-steps list | `Box.tsx:36` |
| `Docker said: {reason}` | Your box, under it | `Box.tsx:102` |
| `The server keeps trying to start it. An admin can look at the server.` | Your box, under it | `Box.tsx:103` |
| `Tailscale is off on this server. To turn it on, set AGENTS_TAILSCALE_API and AGENTS_TAILSCALE_KEY_FILE for the API and restart it.` | The Tailscale page | `Tailscale.tsx:231` |
| `GitHub is not set up on this server yet. An admin adds {settings} to its .env and restarts the API.` | The GitHub block | `Projects.tsx:23` |
| `Signing in with GitHub needs the Agents GitHub App's client id on the server, in AGENTS_GITHUB_CLIENT_ID.` | The GitHub block, with no client id | `Projects.tsx:58` |
| `{owner}/{name} was not made. {reason}` | A project, a repo request that failed | `Projects.tsx:289` |
| `The connection to the screen dropped.` | The Screen panel, a close with no reason | `Screen.tsx:45` |
| `the app could not read who holds the screen` | The Screen panel, a control message the app could not read | `Screen.tsx:41` |
| `Tailscale is not connected, so invites are made here without an email, for people already on the tailnet.` | Team, above the invite form | `Team.tsx:104` |
| `The Tailscale key expires in {days}, on {date}.` | The key notice | `Tailscale.tsx:46` |
| `The Tailscale key expired on {date}. Invites and the Tailscale page stop working until it is replaced.` | The key notice | `Tailscale.tsx:42` |

### 4.4 Words the server writes that the app shows as written

A refusal reaches the person as the `error` text of the answer, in red where the form says, or nowhere for a silent action (5.7). These are the refusals a control in the app can reach.

| Text | Reached from | Code |
|---|---|---|
| `no such conversation of yours` | Sending in a conversation that is not yours. `Make it a task` under a teammate's post | `server/record.ts:333`, `server/tasks.ts:31` |
| `this agent has no home machine` | Sending in a DM, starting a task, starting a draft | `server/record.ts:356`, `server/tasks.ts:28`, `server/drafts.ts:26`, `server/launch.ts:23` |
| `the agent has no home machine` | `Run now` on a routine | `server/routines.ts:20` |
| `no such routine` | `Run now` | `server/routines.ts:19` |
| `no agent named {name}` | Opening a DM from the palette or an agent row | `server/record.ts:307` |
| `a room needs a name` | New room with a name over 80 characters | `server/rooms.ts:21` |
| `no such project` | New room, a project page action | `server/rooms.ts:23`, `server/projects.ts:65` |
| `every agent must be on your team` | New room | `server/rooms.ts:29` |
| `no such room` | The People panel for a private room | `server/rooms.ts:57` |
| `Only people in the room, or an admin, can add someone to it.` | The People panel | `server/rooms.ts:59` |
| `{login} is not on your team.` | The People panel | `server/rooms.ts:61` |
| `{login} is already in the room.` | The People panel | `server/rooms.ts:66` |
| `no such agent` | New task, a draft, an agent's page | `server/tasks.ts:27`, `server/drafts.ts:24`, `server/agents.ts:43` |
| `the task's agent is gone` | Starting a task or a draft | `server/launch.ts:22` |
| `This repo's policy keeps coding work in boxes, and the task's agent lives on a {kind}. Start an app-change run on the repo instead.` | Starting a task | `server/launch.ts:30` |
| `no such repo` | New task, a draft | `server/checkout.ts:39` |
| `this draft changed since you opened it. Reload it to see the changes, then make yours again.` | `Save draft`, `Start task` on a draft | `server/drafts.ts:60` |
| `this task still blocks {titles}` | `Discard draft` | `server/order.ts:126` |
| `this task is still a draft` | An order command the state forbids | `server/order.ts:15` |
| `this task has already started` | An order command the state forbids | `server/order.ts:16` |
| `this task is done` | An order command on a done task | `server/order.ts:17` |
| `this draft was discarded` | An order command on a discarded draft | `server/order.ts:18` |
| `no such task` | Any order command on a task you cannot see | `server/order.ts:24` |
| `a task cannot block itself` | `Add` under `Wait on another task` | `server/order.ts:63` |
| `no such task to wait on` | Same | `server/order.ts:65` |
| `that task was discarded` | Same | `server/order.ts:70` |
| `that task already waits on this one, so this would make them wait on each other` | Same | `server/order.ts:84` |
| `no such session` | `Interrupt`, `Send` on a task | `server/api.ts:597`, `server/record.ts:214`, `server/tasks.ts:49` |
| `A terminal session is stopped from its terminal, not from the app.` | `Interrupt` on a terminal session | `server/record.ts:216` |
| `no such task session` | `Send` on a task | `server/session-messages.ts:18` |
| `A judge's session takes no messages. A message would start the reviewer or verifier with a workspace's permissions, the team-record tools and no budget, and a judge works on its own and never edits the change it judges.` | `Send` on a review stage's session | `server/session-messages.ts:28` |
| `a replay scores a proposed change and takes no messages, since a message would restart it with workspace permissions, the agent's plugins and memory, and no budget` | `Send` on a replay's session | `server/tasks.ts:52` |
| `the agent is still working. Open the pull request when its turn ends.` | `Open pull request` while the agent works | `server/pulls.ts:34` |
| `a push for this task is already under way` | `Open pull request` twice | `server/pulls.ts:51` |
| `the task's workspace is not set up yet` | `Open pull request` | `server/pulls.ts:31` |
| `this task has no repo to open a pull request on` | `Open pull request` | `server/pulls.ts:37` |
| `the task's agent is gone, and its commits are made in its name` | `Open pull request` | `server/pulls.ts:28` |
| `The push failed: {reason}` | A failed push, shown in the pull request block | `server/pulls.ts:79` |
| `There is nothing to open a pull request for. No branch has commits past its base.` | A push that found no commits | `server/pulls.ts:85` |
| `The machine did not finish the push within {n} minutes.` | A push that never reported | `server/pulls.ts:111` |
| `no such document` | `Comment`, the diff | `server/tasks.ts:78`, `server/versions.ts:14` |
| `no such version` | `Comment` | `server/tasks.ts:80` |
| `no version {n} and {n} to compare` | The Diff tab | `server/versions.ts:19` |
| `no such open comment` | `Resolve` | `server/tasks.ts:97` |
| `no such ask` | An ask card's buttons | `server/api.ts:581`, `server/api.ts:588` |
| `this ask is already answered` | An ask card's buttons, a second click | `server/record.ts:192`, `server/runner.ts:190` |
| `this ask is no longer open, since the turn that raised it ended` | A tool approval's buttons | `server/record.ts:193` |
| `decision must be one of {options}` | A gate or hand-off's buttons | `server/runner.ts:196` |
| `only {login} can answer this` | A gate only its owner may pass | `server/runner.ts:193` |
| `this pipeline has no working version` | `Start` on a pipeline | `server/runner.ts:150` |
| `the current version of {name} does not load: {reason}` | `Start` on a pipeline | `server/runner.ts:155` |
| `this team has no agent named {name}, which {pipeline} needs` | `Start` on a pipeline | `server/runner.ts:158` |
| `no such repo on this team` | `Start` on a pipeline | `server/runner.ts:160` |
| `no such pipeline` | `Start` on a pipeline | `server/api.ts:609` |
| `no such run` | `Cancel run` | `server/api.ts:660` |
| `this run is already {status}` | `Cancel run` | `server/runner.ts:235` |
| `no such hunk` | `Keep`, `Turn down` | `server/hunks.ts:434` |
| `a pipeline change is kept or turned down whole, at its gate` | `Keep`, `Turn down` | `server/hunks.ts:435` |
| `this proposal is not waiting at its gate` | `Keep`, `Turn down` | `server/hunks.ts:437` |
| `decision must be accept, or reject with a reason` | `Turn down` with no reason | `server/api.ts:623` |
| `name must be lowercase letters, digits and dashes, starting with a letter` | New agent | `server/agents.ts:51` |
| `there is already an agent named {name}` | New agent | `server/agents.ts:59` |
| `That box is a teammate's own. Only they can make agents on it.` | New agent | `server/agents.ts:57` |
| `no such machine` | New agent | `server/agents.ts:54` |
| `no such template` | New agent from a template | `server/agents.ts:236` |
| `{field} must be non-empty text` | An agent's forms | `server/agents.ts:31` |
| `{field} is too long` | An agent's forms | `server/agents.ts:32` |
| `a skill name is lowercase letters, digits and dashes` | `Save skill` | `server/agents.ts:84` |
| `a plugin name is lowercase letters, digits and dashes` | `Save plugin` | `server/agents.ts:124` |
| `{name} is taken by the tools every session has` | `Save plugin` named `team-record` or `stage` | `server/agents.ts:125` |
| `{field}.{key} must name a secret, such as {"secret": "GITHUB_TOKEN"}, never hold a value` | `Save plugin` | `server/agents.ts:103` |
| `config.url must be an http or https URL` | `Save plugin` | `server/agents.ts:115` |
| `schedule: {reason}` | `Save routine` | `server/agents.ts:147` |
| `that box is taken or is not a box` | `Claim` | `server/api.ts:687` |
| `you do not hold that box, or it is your own box, which stays yours` | `Release` | `server/api.ts:687` |
| `You already have a box.` | `Make my box` | `server/boxes.ts:178` |
| `You have no box yet. Make one on the Your box page first.` | `Sign in to Claude` | `server/claudelogin.ts:77` |
| `That sign-in cannot be {state} now.` | A Claude sign-in button used out of turn | `server/claudelogin.ts:65` |
| `The server restarted before your box got your code. Paste it again.` | The note on a waiting sign-in | `server/claudelogin.ts:126` |
| `missing Tailscale-User-Login` | The `Can't open the app` screen, when no login header arrives | `server/auth.ts:40` |
| `Tailscale-User-Login is not a Tailscale login` | The `Can't open the app` screen, when the header is not a login | `server/auth.ts:42` |
| `Only team admins can do that.` | An admin action by a member | `server/auth.ts:63` |
| `{login} is not on a team` | Any action by a login that left the team | `server/auth.ts:57` |
| `{email} is already on a team.` | `Invite` | `server/onboarding.ts:152` |
| `{email} already has an open invite. Resend it from the list.` | `Invite` | `server/onboarding.ts:157` |
| `That invite is no longer open.` | `Link`, `Resend`, `Cancel` | `server/onboarding.ts:145` |
| `Tailscale is not connected, so the app cannot email invites. Connect it on the Tailscale page.` | `Resend` | `server/onboarding.ts:174` |
| `This invite was made without Tailscale, so it has no link.` | `Link` | `server/onboarding.ts:248` |
| `Tailscale gives no link for {email}, which is in the tailnet's own domain. They join by signing in to Tailscale.` | `Link` | `server/onboarding.ts:251` |
| `Cancelled the invite for {email} here, but its invite in Tailscale stays until someone removes it there. {reason}` | `Cancel` on an invite | `server/onboarding.ts:205` |
| `{login} is already on a team.` | `Add` and `Add to the team` | `server/onboarding.ts:126` |
| `Tailscale refused the key ({message}). {how to make a new key}` | Any Tailscale action | `server/tailscale.ts:190` |
| `Tailscale had a problem ({message}). Try again in a minute.` | Any Tailscale action | `server/tailscale.ts:191` |
| `Tailscale could not be reached: {reason}` | Any Tailscale action | `server/tailscale.ts:184` |
| `Tailscale is not connected yet. {how to make a new key}` | Any Tailscale action with no key | `server/tailscale.ts:136` |
| `The Tailscale key expired on {date}. {how to make a new key}` | Any Tailscale action with an expired key | `server/tailscale.ts:128` |
| `Tailscale says this key was revoked or has expired. {how to make a new key}` | `Save key` | `server/tailscale.ts:211` |
| `an API access token starts with tskey-api-` | `Save key` | `server/tailscale.ts:94` |
| `There is already a project with that name.` | `Create project` | `server/projects.ts:33` |
| `That repo was asked for already. Its project page shows how it went.` | `Add it`, `Create project` | `server/projects.ts:34` |
| `A project name needs a letter or a digit, which its repo is named after.` | `Create project` | `server/projects.ts:71` |
| `{repo} already exists on GitHub. Name the project differently, or add that repo to a project from the project's page.` | `Create project` | `server/projects.ts:75` |
| `Only a request that failed can be tried again.` | `Try again` on a repo request | `server/projects.ts:170` |
| `That repo isn't one of the team's repos without a project.` | `Move it here` | `server/projects.ts:181` |
| `Could not reach GitHub: {reason}` | Any GitHub action | `server/github.ts:82` |
| `GitHub refused the sign-in. Whoever it belongs to connects GitHub again on the Repos page.` | Any GitHub action | `server/github.ts:83` |
| `GitHub would not let this sign-in do that. Making a repo needs Repository creation, and work in it needs Contents, Issues and Pull requests.` | Any GitHub action | `server/github.ts:85` |
| `This Mac's forge did not answer: {reason}` | A repo line on the Repos page | `server/repos.ts:118` |
| `The box is not connected, so nobody can take over its screen.` | `Take over` | `server/screens.ts:189` |
| `This screen has shown work you can't see.` | Opening or taking over a screen | `server/screens.ts:122` |
| `The agent already has the screen.` | `Hand back` when the agent holds it | `shared/screen.ts:58` |
| `{login} has the screen.` | `Take over` while a teammate holds it | `shared/screen.ts:71` |
| `{login} has the screen, not you.` | `Hand back` while a teammate holds it | `shared/screen.ts:74` |
| `The box is not connected. It may be stopped.` | The Screen panel's close reason | `server/screens.ts:293` |
| `The box did not answer. Try again in a moment.` | The Screen panel's close reason | `server/screens.ts:300` |
| `The box closed the screen.` | The Screen panel's close reason | `server/screens.ts:335` |
| `The screen takes binary frames only.` | The Screen panel's close reason | `server/screens.ts:306` |
| `internal error` | Any request the server could not finish | `server/api.ts:784` |

### 4.5 Words the machines write into the record

These reach the app inside a session's events and show in a conversation's stopped and interrupted lines, a task's transcript and the Session panel.

| Text | Where it shows | Code |
|---|---|---|
| `this machine has no value for {names}, which the agent's plugins need. Set it in the daemon's environment or in {path}.` | An agent whose plugin names a secret its machine lacks. The stopped line shows it | `daemon/agentsd.ts:300-301` |
| `The machine running this session stopped answering.` | The interrupted line when the machine went silent | `server/durability.ts:134` |
| `The machine restarted in the middle of this turn, and a person had asked to stop it, so it was not resumed.` | The interrupted line after a restart that followed an interrupt | `server/durability.ts:168` |

## 5. Behavior across the app

### 5.1 Navigation

- Every location is a URL hash (1.3). Pasting a hash opens that screen, and the browser's back and forward buttons move between screens and panels.
- People move by the sidebar, the command palette (3.9), and links inside screens. There are no breadcrumbs and no tabs between screens.
- A new view mounts per id (`key` on the route's id), so switching conversations, tasks, runs, pipelines, agents or projects starts the view fresh, with its form state and its tab choice reset (`App.tsx:146-157`). Opening a panel does not remount the screen beside it.
- The sidebar stays mounted and keeps its scroll position. A screen's scroll position is not kept. Each screen scrolls inside its own region, and the page itself does not scroll (`styles.css:58`, `styles.css:140`, `styles.css:173`).
- Creating something ends on the new thing: a room opens its conversation, a task opens its page, an agent opens its page, a project opens its page, a run opens its run page (`Work.tsx:30`, `Work.tsx:81`, `AgentPage.tsx:246`, `Projects.tsx:213`, `Pipeline.tsx:131`).
- The welcome screen is where discarding a draft ends (`Draft.tsx:88`).

Links between screens. The sidebar and the palette reach every screen, so this table lists the links inside screens.

| From | To | Control | Code |
|---|---|---|---|
| Conversation | Agent | `Agent setup` | `Conversation.tsx:79` |
| Conversation | Task | `Make it a task`, `Open its task` | `Conversation.tsx:95-98` |
| Conversation, task, run | Session panel | `Session details`, `Open session` | `Conversation.tsx:69`, `Work.tsx:160`, `Run.tsx:92` |
| Session panel, task | Screen panel | `Screen` | `Session.tsx:52`, `Work.tsx:157-159` |
| Task, run | Document panel | A document button | `Work.tsx:177`, `Run.tsx:111` |
| Task, run | File panel | A file row | `Work.tsx:168`, `Run.tsx:101` |
| Task, draft | Project | The project name | `Projects.tsx:260`, `Projects.tsx:272` |
| Task, draft | Another task | A title under `Waits on` | `Order.tsx:155`, `Order.tsx:161` |
| Run | Pipeline | `Pipeline` | `Run.tsx:57` |
| Run | Pipeline room | The `{pipeline} room` link | `Run.tsx:133` |
| Run | Earlier run | `an earlier run` | `Run.tsx:130` |
| Pipeline | Pipeline room | `Room` | `Pipeline.tsx:55` |
| Pipeline | Run | A run row, `The run that proposed it` | `Pipeline.tsx:95`, `Proposal.tsx:68` |
| Agent | Conversation | `Message`, `Run now` | `AgentPage.tsx:36`, `AgentPage.tsx:61` |
| Project | Conversation | `Room`, a room row | `Projects.tsx:418`, `Projects.tsx:465` |
| Project | New task, New room | `New task`, `New room` | `Projects.tsx:419-420` |
| Project, Repos | Run or task | A task row, a task branch | `Projects.tsx:113-117`, `Projects.tsx:438` |
| Project | Task with a document | A document button | `Projects.tsx:455` |
| Repos | Project | The project name on a repo line | `Projects.tsx:128` |
| Team | Tailscale | `Connect Tailscale` | `Team.tsx:105` |
| Your box | New agent | `Make an agent on your box` | `Box.tsx:82` |
| Welcome | Your box | `Set up your box` | `Box.tsx:44` |
| Any create form | The new thing | The button that creates it | `Work.tsx:30`, `Work.tsx:81`, `AgentPage.tsx:246`, `Projects.tsx:213`, `Pipeline.tsx:131` |
| Draft | Welcome | `Discard draft` | `Draft.tsx:88`, `Draft.tsx:104` |

### 5.2 Focus and keyboard

The app moves focus in four places only.

| Where | What moves |
|---|---|
| Opening a result in the palette | Focus goes to the main area (`Palette.tsx:161`) |
| Left and Right on a tab | Focus goes to the other tab (`Code.tsx:90`) |
| Holding a box's screen | Focus goes to the screen (`Screen.tsx:99`) |
| Focusing a link field | The whole link is selected (`LinkField.tsx:10`) |

The palette is a native modal dialog, so it traps focus and gives it back on close. Nothing else sets focus. After a route change focus stays on the control that was used if it is still there, and drops to the page when it is gone, as when `Close` removes a panel. No field takes focus when a screen opens, the composer included. There is no skip link.

Keys.

| Key | Where | What it does |
|---|---|---|
| `⌘K`, `Ctrl+K` | Anywhere | Toggles the palette (3.9) |
| `c`, `r` | Anywhere outside a field | New task, New room. Off when single keys are turned off |
| `↑`, `↓`, `Enter`, `Esc` | In the palette | Move, open, close |
| `Enter` | The conversation's Message box | Sends. `Shift+Enter` adds a line |
| `Enter` | Every other multi-line box, including `Tell the agent more` | Adds a line. The form is submitted with its button |
| `Enter` | A single-line box in a form | Submits the form, unless its submit button is disabled |
| `←`, `→` | On a tab | Moves to the other tab (3.4) |
| `Tab` | Everywhere | Reaches every button, link, field, and these scroll regions, which take focus so they can scroll by keyboard: the message list, the event list, the document body, code and diff regions |

Every control is a native button, link, field or select, so Tab reaches it and Enter or Space works it. Clicking marked words in a document is the one action that has only a mouse form, and the quote buttons in the comment list do the same by keyboard (`Document.tsx:144-150`, `Document.tsx:208-212`).

Focus is shown by changing the focused control's own hairline, never by an outline (`styles.css:90-95`).

| Control | Focus look | Code |
|---|---|---|
| Buttons and text areas | The hairline turns to the text color | `styles.css:92` |
| Sidebar rows, ghost buttons, tabs | A brighter surface | `styles.css:93`, `styles.css:352` |
| Link-style buttons | A thicker underline | `styles.css:94` |
| Text boxes, selects and the palette's box | The hairline turns to the text color. The palette's box shows nothing | `styles.css:208`, `styles.css:252`, `styles.css:393` |
| Scroll regions | A brighter surface | `styles.css:95`, `styles.css:214`, `styles.css:359` |

### 5.3 Accessibility roles and labels

Landmarks and containers.

| Element | Role or name | Code |
|---|---|---|
| The page | `lang="en"`. The title is `Agents` on every route | `index.html:2`, `index.html:7` |
| Sidebar | A `nav` named `Workspace` | `App.tsx:275` |
| Main area | A `main` named for the route (1.1), focusable by script only | `App.tsx:139` |
| Panels | An `aside` named `Session details`, `Document`, `File` or `Screen` | `Session.tsx:41`, `Document.tsx:41`, `FilePanel.tsx:25`, `Screen.tsx:119` |
| Screens | A `section` named `Team`, `Tailscale`, `Your box`, `Repos`, `Run`, `Task`, `Pipeline`, `Agent`, `Project`, `Terminal session`, `New room`, `New task`, `New agent`, `New project`, `Draft task`, `Getting started` | the screen's own file |
| Waiting page | A `main` named `Waiting to join` | `Team.tsx:25` |
| Ask card | A `section` named `Needs approval`, `Needs a decision` or `Needs a person` | `Asks.tsx:32`, `Asks.tsx:52` |
| Palette | A `dialog` named `Go to`, holding a combobox, a listbox named `Results`, groups and options | `Palette.tsx:180-198` |
| Code and diffs | A region named `{path}, {n} lines` or the caller's label, focusable | `Code.tsx:10`, `Code.tsx:61` |
| Screen view | A region named `The screen of {machine}` | `Screen.tsx:145` |

Lists carry names. The sidebar's are `Projects`, `In {project}`, `Agents`, `Conversations`, `Tasks`, `From terminals`, `Ready`, `Held`, `Pipelines`, `Runs`, `Running now` and `Machines`. The Repos list has no name on purpose, since a page's `Repo` picker is found by that label (`App.tsx:341-343`). Screens name theirs too, for example `People`, `Messages`, `Events`, `Stages`, `Waits on`, `Hunks`, `Changes in {repo}`, `Made by this run`, `Runs of this pipeline`, `Tailnet users`, `Tailnet devices`, `Tailnet invites`, `Tasks and runs of this project`, `Documents of this project`, `Rooms of this project`, `Repos being made`, `The team's repos` and `The project's repos`. Each hunk's decision controls form a group named `Decide hunk {n}` (`Proposal.tsx:158`).

Forms carry names, for example `Invite someone`, `Tailscale key`, `Claude code`, `New room`, `Edit the draft`, `Open a pull request`, `Wait on another task`, `Hold this task`, `Start a run`, `Add a comment`, `Profile`, `Add a skill`, `Add a plugin`, `Add a routine` and `Add a teammate`.

State is announced in these ways.

| Mechanism | Where |
|---|---|
| `role="alert"` | Every error that shows beside a form or list |
| `role="status"` | Confirmations and progress, such as `Saved.`, `Added {logins}. Their box is starting.`, the invite result, `Pushing the branch and opening the pull request…`, the Screen status and the Claude sign-in steps |
| `aria-live="polite"` | The conversation's message list, and the project repo line on New project (`Conversation.tsx:85`, `Projects.tsx:231`) |
| `aria-busy="true"` | The `Connecting…` screen (`App.tsx:108`) |
| `aria-expanded` | `Menu`, and `People` in a room (`App.tsx:133`, `Conversation.tsx:75`) |
| `aria-selected`, `aria-activedescendant` | Palette options and tabs |
| `aria-current="true"` | The open file's row under Changes. Sidebar rows have none (`Changes.tsx:52`) |
| `aria-pressed` | A comment's quote button while its comment is active (`Document.tsx:209`) |
| Screen-reader-only text | `priority ` before a priority, line counts under a file row, `added: ` and `removed: ` in diffs, `Show in the document: ` before a quote, and labels for fields that show only a placeholder (`Order.tsx:63`, `Changes.tsx:60`, `Code.tsx:68`, `Document.tsx:210`) |
| Hidden glyphs | The check, dot and pause glyphs, line numbers and status dots carry `aria-hidden="true"` |
| Image text | A document image has the alt text `{title}, version {n}` (`Document.tsx:59`) |

Buttons repeated down a list say whom they act on, for example `Add {login}`, `Link for {email}`, `Resend to {email}`, `Cancel the invite for {email}`, `Authorize {name}`, `Remove {name}` and `Approve {login}`.

### 5.4 Themes and visual rules

The stylesheet defines its colors once, as tokens on the root element (`styles.css:4-55`).

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--bg` | `#f5f5f2` | `#131312` | The page and the sidebar |
| `--surface` | `#ffffff` | `#1b1b1a` | Panels, buttons, cards, fields |
| `--raised` | `#ebebe6` | `#2a2a28` | Selected and hovered rows, code, ask subjects |
| `--line` | `#d9d9d3` | `#34342f` | Every border, one hairline |
| `--text` | `#1c1c1a` | `#ecece8` | Text and the fill of primary buttons |
| `--muted` | `#66665f` | `#a3a39b` | Secondary text |
| `--live` | `#23804b` | `#5cc68c` | Green dots |
| `--waiting` | `#9a5b0f` | `#e3a650` | Amber dots |
| `--off` | `#9a9a93` | `#6f6f69` | Grey dots, struck-through diff text |
| `--danger` | `#a3261d` | `#f08177` | Error text |
| `--mark` | `#e2e1d8` | `#3b3b36` | A comment's quote in the document |
| `--mark-strong` | `#cbcabe` | `#55554e` | The active comment's quote |
| `--scrim` | `rgba(20, 20, 18, 0.35)` | the same | Behind the palette |

- The theme follows the operating system's light or dark setting. The stylesheet also reads `data-theme="light"` or `data-theme="dark"` on the root element, but nothing in the app sets it, so there is no toggle (`styles.css:22`, `styles.css:40`).
- Color marks live state only. Selection is a brighter surface and heavier type, and a decision is a glyph and a word. The one red in the app is error text.
- Type is the system font at 15 px. Headings are 18 px (`h1`) and 15 px (`h2`). Small text is 12.5 px, kickers are 11 px in capitals, and code is monospace at 12.5 px (`styles.css:59-72`).
- A button has four looks. The default has a surface fill and a hairline. `primary` fills with the text color. `ghost` has no fill. `link` is underlined text. A disabled button is drawn at 55 percent opacity (`styles.css:75-89`).
- The stylesheet has no transitions, animations, reduced-motion rule, contrast rule or print rule. A button changes its fill on hover (`styles.css:84`, `styles.css:87`).
- Content Security Policy. The page allows scripts and styles from its own origin only, images from its origin and `data:`, and connections to its own origin (`index.html:6`). The app therefore uses no inline style attributes, and `zod-config.ts` tells zod not to probe for `new Function`, which the policy blocks (`zod-config.ts:1-6`).

### 5.5 Live updates and refresh

What updates the moment the record changes, and what waits for a timer.

| Screen | Live | Polled |
|---|---|---|
| Sidebar | Nothing | Sessions 3 s. Tasks, runs and ready list 4 s. Agents, conversations, people, machines 5 s. Pipelines, projects, folders, waiting logins 10 s. Repos 30 s. Tailscale key 60 s |
| Conversation | Messages, sessions, asks, the working agent's events and tokens | Conversations, agents, people 5 s. Members 3 s while People is open. Stopped and interrupted reasons 10 s |
| Task | Sessions, asks, the transcript | Task and artifacts 4 s. Changes 3 s. Pushes 2 s. Order of work 2 s to 4 s. Agents 15 s. Machines 5 s |
| Run | Stages, asks | Run 3 s. Proposals and artifacts 4 s. Changes 3 s. Pipelines and versions 15 s. Tasks 5 s |
| Pipeline | Nothing | Runs, tasks, proposals 4 s. Pipelines and versions 10 s. Repos 30 s |
| Agent | Nothing | Agents, skills, plugins, routines 4 s. Memory 6 s. People 30 s |
| Project | Nothing | Repo requests 3 s. Tasks, runs 4 s. Repos, conversations, documents 6 s. Overview 15 s. Members 10 s. People and agents 30 s |
| Repos | Nothing | Overview 15 s. GitHub status 15 s, or 2 s while a code is waiting |
| Team | Nothing | People, machines 5 s. Waiting logins, invites 4 s |
| Tailscale | Nothing | On open and after each change only |
| Your box | Nothing | Machines 3 s. Sign-ins 2 s |
| Terminal session | Events | Sessions 3 s. Folders 10 s |
| Session panel | Events, sessions | Machines 5 s |
| Document panel | Nothing | Versions and artifacts 4 s. Comments 3 s |
| File panel | Nothing | The file and the file list 3 s |
| Palette | Nothing | Every list 5 s while open |
| Screen panel | The screen and who holds it, over a WebSocket | Machines 5 s |

The Electric client pauses a live stream while the browser tab is hidden. The app's own polling code does not check whether the tab is visible.

### 5.6 Time and number formats

Times use the browser's locale and time zone. A timestamp from the database is read with its offset fixed first (`data.ts:374-380`).

| Format | Result | Where | Code |
|---|---|---|---|
| Time of day | The locale's hour and two-digit minute, such as `3:41 PM`. It has no date, no seconds and no zone | Message times, event times, a run's `started`, stage times, version times, a project's `started`, a routine's `last ran` | `data.ts:382-384` |
| Short date | Month and day, such as `Oct 15`. No year | Invites, `since` for waiting logins, devices last seen, Tailscale invites | `data.ts:386-388` |
| Long date | Month, day and year, such as `October 15, 2026` | The Tailscale key's dates, a Claude sign-in's end date | `Tailscale.tsx:33`, `Box.tsx:11` |
| ISO date | The date as stored, such as `2026-10-20` | A hold's `until`, in Held and in the order of work | `Order.tsx:78`, `Order.tsx:188` |
| Duration | `42s` under a minute, `3 min`, then `1 h 5 min` | Run facts, version averages, score tables | `data.ts:360-365` |
| Money | A dollar sign and two decimals, such as `$0.42` | Run cost, version averages, scores | `data.ts:367` |
| Thousands | `20,000`, in English style whatever the locale | The changed-files limit | `Changes.tsx:43` |
| Short id | The first 8 characters of a commit or version | Pipeline versions, run header | `Pipeline.tsx:77`, `Run.tsx:52` |
| Counts | `1 person` or `2 people`, `1 repo` or `2 repos`, `1 file` or `2 files`, `1 day` or `n days`, `{n} of {m}` | Team, Repos, Changes, the key notice, scores | the screen's own file |
| Turns | `{n} turns`, even for one, in the Session panel. `1 turn` in the terminal page | Session panel, terminal session | `Session.tsx:47`, `Terminal.tsx:38` |
| Priority | `P{n}`, left out for 2 | The Ready list | `Order.tsx:63` |
| Size | `{width} × {height}` | The Screen header | `Screen.tsx:123` |

Because times carry no date, a post from yesterday and one from today look alike, and a run's `started` time cannot be told from last week's.

### 5.7 How errors show

An error shows in one of four ways. Nearly all use red text from the `--danger` token with `role="alert"`.

- Beside the button that caused it, in a form (most forms).
- Under a list that several buttons act on (Team, Tailscale, the order of work).
- In the place the data would have been (a schema error where a list should be).
- Nowhere. The failure is dropped.

Success shows as a muted or bold line with `role="status"` beside the control, or as the screen changing.

The helper `act` (`data.ts:240-248`) wraps a click. When the wrapped action throws, `act` raises an `app-error` event on the window and says in its comment that the app's alert banner shows it. Nothing in the app listens for that event (`docs/build-log.md:180`), so these failures show nothing. These controls do not catch their own errors.

| Control | Where | Code |
|---|---|---|
| An agent row in the sidebar | Opening the DM | `App.tsx:219-226`, `App.tsx:357` |
| `Interrupt` | A conversation | `Conversation.tsx:80` |
| `Make it a task` | A conversation | `Conversation.tsx:96-98` |
| `Interrupt` | A task | `Work.tsx:161` |
| `Cancel run` | A run | `Run.tsx:59` |
| `Keep` and `Turn down` | A proposal's hunk | `Proposal.tsx:128-136`, `Proposal.tsx:160-161` |
| `Message` | An agent's page | `AgentPage.tsx:36` |
| `Save as template` | An agent's page | `AgentPage.tsx:37` |
| `Remove` on a skill, plugin or routine | An agent's page | `AgentPage.tsx:86` |
| `Run now` | An agent's page | `AgentPage.tsx:61` |
| `Resolve` | The Document panel | `Document.tsx:214` |
| `Sign out` | GitHub on the Repos page | `Projects.tsx:40` |
| `Try again` | A repo request on a project | `Projects.tsx:289` |

Errors that stay after they are first shown.

| Where | How it clears | Code |
|---|---|---|
| `Tell the agent more` on a task | Never. A later send that works leaves the old error in place until the page is left | `Work.tsx:137-146` |
| New room, New task | Never. A second try that fails replaces it. A success leaves the page | `Work.tsx:25-34`, `Work.tsx:75-86` |
| The invite result on Team | A later invite replaces it. A failed one leaves the old result beside the new error | `Team.tsx:91` |
| Every other form | The next try clears it first | the form's own file |

A failed read of a list is dropped, and the list keeps what it had. A checked list shows one thing, a schema mismatch, where its view reads the error (`Team.tsx:169`, `Order.tsx:141`, `Changes.tsx:33`, `FilePanel.tsx:38`, `Draft.tsx:29`, `Box.tsx:85`, `Projects.tsx:281`, `Projects.tsx:394`). Four API reads do show a failure. They are the ready list (`Order.tsx:68`), the repo overview on the Repos page (`Projects.tsx:178`), the waiting page's poll (`Team.tsx:31`) and the Tailscale page (`Tailscale.tsx:112`, `Tailscale.tsx:118`). A failed read of the GitHub status shows nothing, and the GitHub block keeps reading `Asking the server about GitHub…`.

### 5.8 What the browser keeps

The app stores one thing in the browser, the single-key shortcuts setting, under `agents.single-key-shortcuts` in local storage. It reads and writes inside `try` blocks, so a private window with no storage still works and the setting lasts until reload (`Palette.tsx:28-42`). The app sets no cookies, uses no session storage or database, and asks for no permission such as notifications or the clipboard.

## 6. Gaps

### 6.1 What the server does that the app cannot do or show

| What | Where in the server | What the app shows instead |
|---|---|---|
| Pause and resume a run | `server/api.ts:646`, `server/runner.ts:206-230` | A paused run shows the raw word `paused`. `Cancel run` is hidden for it, since the app counts only queued, running and waiting runs as active (`Run.tsx:11`), although the server cancels a paused run (`server/runner.ts:235`) |
| List open obligations and waive one | `server/api.ts:633`, `server/api.ts:639` | Nothing |
| List or remove standing approval rules | `server/record.ts:197-203` | `Always allow` and `Never` make a rule, and no screen lists, shows or removes one |
| Turn a routine on or off | `server/agents.ts:150` | `paused` shows beside a routine that is off (`AgentPage.tsx:60`). The app has no control that sets it, and saving the routine again turns it on |
| Change a member's team role | `server/admin.ts` `set-role` | The invite form picks a role once. No screen changes it later |
| Remove a member from the team | No route or command | Nothing |
| Make a conversation or task private | No route sets it | A `Private` label shows for one. Only a direct database change can make one |
| Archive or rename an agent, project, room or conversation | No route | Nothing. Discarding a draft is the only archive |
| Edit or delete a message, rename a room, leave a room or remove someone from it | No route | Nothing |
| List, rename or delete templates | `server/agents.ts:211-230` | `Save as template` and the `Start from` select only |
| Team-wide skills, which have no agent | `server/record.ts:295-300` | Shown on no agent's page |
| Edit or delete what an agent remembers | `server/agents.ts:168-189` | The memory list on the agent's page is read only |
| Names of the secrets each agent needs (`secrets` shape) | `server/sync.ts:131` | Not read. A plugin row shows `needs {names} on its machine` |
| The queue of turns in a room (`turns` shape) | `server/sync.ts:132` | Not read. Only the working agent's typing line shows whose turn it is |
| Per-session cost and token use | `usage` events | A `Turn ended` row with no numbers. A run shows its cost as a fact |
| Review findings from the coding framework | `server/framework.ts:646` | Only the text in a stage's summary or an owner's question |
| Coach and improve evidence beyond a hunk's quotes (findings, candidates, session reads, replay results) | `shared/evidence.ts` | Hunks, their quotes, and the scores |
| Starting runs from a forge issue, a signed webhook, a GitHub label or a cron schedule | `server/hooks.ts`, `server/github-worker.ts`, `shared/pipeline.ts:16` | The runs appear in lists. No screen sets up, shows or tests a trigger |
| Searching what agents said | `server/api.ts:148` (agents' tools only) | The palette matches names and titles, not message or document text |
| Connecting and disconnecting a folder | `server/api.ts:323-333` (the Mac only, by design) | Terminal sessions appear. No screen lists folders |

### 6.2 Parts of the app that do nothing yet, or wait for a producer

| What | Where | Detail |
|---|---|---|
| The `Turn` type | `data.ts:99` | Defined and used nowhere |
| Fields the views never show | `data.ts:21-100` | An agent's `role`, a machine's `last_seen_at` and `claimed_at`, a session's `harness_session_id`, a run's `proposal_id` and its `metrics.attempts` |
| Session status `needs_input` | `shared/lifecycle.ts:8`, `styles.css:133` | Counted as working and drawn amber. A search of `server/`, `daemon/`, `shared/` and `app/` finds no code that sets it |
| Session status `limited` | `shared/types.ts:12` | Listed. No code sets it and the app has no state for it |
| Comment status `outdated` | `styles.css:262` | Drawn muted. No code sets it |
| Conversation kinds `pr` and `slack_thread` | `server/migrations/0001_data_model.sql:156` | No app path makes one. Opened by id, one would read `Conversation` with a disabled composer |
| Ask kinds `form`, `draft`, `secret_request`, `connector_grant`, `credential_request` | `server/migrations/0001_data_model.sql:456` | No code makes one. The card would draw any of them as `Needs a person`, with no buttons unless the ask carries options |
| Stage kinds `route`, `verify`, `review`, `confirm`, `suite` | `server/migrations/0009_self_improve.sql:27`, `Run.tsx:12` | Shown by their raw names |
| Ask options `fix` and `overrule` | `server/framework.ts:702`, `server/framework.ts:811`, `Asks.tsx:6-8` | Shown by their raw lowercase names |
| The `app-error` event | `data.ts:245` | Raised by `act` and heard by nothing (5.7) |
| `data-theme` | `styles.css:22`, `styles.css:40` | Read by the stylesheet and set by nothing |
| Lists that cap what they show | `App.tsx:258-259`, `App.tsx:265`, `App.tsx:271`, `Pipeline.tsx:93` | The sidebar shows the newest 6 tasks, 8 runs and 6 terminal sessions, 5 tasks and 5 runs per project, and a pipeline shows 30 runs. Older tasks and runs are found through the palette or a project page. A terminal session older than the newest six has no link anywhere, since the palette does not list them |
| Replay runs | `App.tsx:264`, `Pipeline.tsx:23`, `Palette.tsx:108` | The sidebar, a pipeline's page and the palette leave replays out. A replay run page opens by its URL, and a replay links back to its original (2.8) |

### 6.3 Readings that look like defects

These come from reading the code. I did not run any of them, so each needs a run before it is called a defect.

| Reading | Where | What the code shows |
|---|---|---|
| The conversation may not follow new messages | `Conversation.tsx:48-49`, `Conversation.tsx:114` | The effect scrolls an empty `div` that sits after the message list, not inside it. The list scrolls on its own (`styles.css:140`), so this call does not move it. No check covers scrolling |
| `Make it a task` fails without a word on a teammate's post | `Conversation.tsx:93-98`, `server/tasks.ts:29-31` | The button shows under any person's post in a DM, and the server refuses a person who is not in the conversation |
| The File panel can stay on `Loading…` | `FilePanel.tsx:23`, `FilePanel.tsx:40` | The panel decides a file is gone only while the list still holds other files. When the last differing file leaves, the list is empty and the panel keeps its loading line |
| Several controls show no focus | `styles.css:91`, `styles.css:92-95` | The stylesheet turns the outline off for everything and gives a replacement to buttons, text boxes, rows, tabs, scroll regions and link-style buttons. Links, checkboxes, disclosure summaries and the Document panel's `Version` select get none |
| Enter during text composition sends a post | `Conversation.tsx:243-245` | The Message box tests for Shift and not for an input method |
| A multi-line question runs together | `Asks.tsx:54`, `styles.css:67` | The framework's owner question lists findings on separate lines, and the card's paragraph has no rule that keeps line breaks |
| The send checkbox's start state depends on read order | `Document.tsx:111` | It takes its value from whether the document row had loaded when the comments first drew |
| A failed GitHub status read never reports | `Projects.tsx:21`, `Projects.tsx:100-102` | The block keeps `Asking the server about GitHub…` |
| A project's repo list can wait forever | `Projects.tsx:391`, `Projects.tsx:425` | The page does not show the overview's error |
| New room can send twice | `Work.tsx:25-34` | No busy state disables the button |
| The typing line asks for a stream every 400 ms | `live.ts:22-27` | It repeats while no stream exists, for as long as the agent works, including a turn that only uses tools |
| A document of a pipeline run opens on the task page | `Projects.tsx:455` | The project page opens documents on the task route, not the run |
| The Agents list has no order of its own | `App.tsx:354` | Rows come out in the order the server sends them |

### 6.4 Issues recorded in the verification work

These are in `docs/design/verification-resume.md:73-80` and the feature files under `.claude/skills/verify-agents/features/`. They were seen on 2026-10-13. I checked each against the code and none contradicts it.

| Issue | Where recorded |
|---|---|
| A working agent that cannot restart does not say why. A session that cannot start shows `idle` over the failure | `.claude/skills/verify-agents/features/conversations.md:79`, `docs/design/verification-resume.md:75` |
| The Start a run form leaves out the pipelines repo for every pipeline, so improve cannot be started from the app on the repo it changes | `.claude/skills/verify-agents/features/pipelines.md:76`, `docs/design/verification-resume.md:76`, `Pipeline.tsx:117` |
| Session details names the model a session started on, not the agent's current model | `.claude/skills/verify-agents/features/sessions.md:57`, `docs/design/verification-resume.md:77` |
| A pipeline's file box scrolls and cannot take keyboard focus | `.claude/skills/verify-agents/features/pipelines.md:77`, `docs/design/verification-resume.md:78`, `Pipeline.tsx:104-109` |
| `act` raises an event nothing listens for | `docs/design/verification-resume.md:79`, `docs/build-log.md:180` |
| The `main` landmark reads `Conversation` on other views, and choosing a stage in Running now right after a page load opens the task, not the run | `docs/design/verification-resume.md:80`, `App.tsx:139-141`, `App.tsx:435-440` |

## Appendix. Where the verification map's features appear here

The map in `.claude/skills/verify-agents/features/` has twelve feature files. This table points each at the sections that describe the same screens.

| Map file | Sections |
|---|---|
| `getting-in.md` | 1.1, 1.5, 2.1, 2.16 |
| `conversations.md` | 2.3, 2.4, 3.1 |
| `agent-setup.md` | 2.10, 2.11 |
| `tasks.md` | 2.5, 2.6, 2.7 |
| `documents.md` | 2.20, 3.1 |
| `sessions.md` | 1.2, 2.19, 3.13 |
| `approvals.md` | 3.8 |
| `pipelines.md` | 2.8, 2.9 |
| `proposals.md` | 3.12 |
| `secrets.md` | 2.10, 4.5 |
| `machines.md` | 1.2 |
| `journeys.md` | 1.4, 1.5, 2.3, 2.19 |

A text search of the twelve files finds no mention of the command palette, draft tasks, projects, the Repos page, New project, Your box, the Ready and Held lists, the changes list and File panel, the Screen panel, the `Use selection` button, or a room's People panel. Sections 1.2, 2.2, 2.3 (the People panel), 2.7, 2.12 to 2.14, 2.18, 2.20 (`Use selection`), 2.21, 2.22, 3.9, 3.10 and 3.11 describe them from the code alone.
