# Agent computers

Every box gets a computer: a Linux desktop, a browser, and tools to see and drive both. The agents' sessions on a box share it, one action at a time, so an agent has a computer to itself only when it has a box to itself. A person can watch that screen live from the app and take over the keyboard and mouse. Agents use the computer to check their own work, and the screenshots they save land on the task.

Tayler asked for this on 2026-10-13: each agent should have its own computer, with computer use, a browser and a way for people to control it, and agents need to be able to verify their own work, always. This is the design, and everything in it is built on the agent computers branch except what "Not done" at the end lists. `docs/build-log.md` records how it was checked.

## What it solves

- **Today an agent can't see what it built.** A box has Node, git and Claude Code. An agent can run tests, but it can't open the page it changed, click through it or notice that it renders blank. With a screen and a browser it can.
- **Nobody can see what an agent in a box is doing.** The session panel shows tool calls as text. The Screen view shows the desktop itself, live.
- **A person can't step in.** Some steps need a person: a login with a code from a phone, a captcha, a judgment call on a page. Taking over the screen lets a person do that step in the agent's own browser, then hand it back.
- **Proof of work is text only.** Documents are text. Screenshots of what the agent checked now become image documents on the task, under "Made by this task".

## How the pieces fit

```
 Box (one container)                                   Server Mac                     A person
 ─────────────────────────────────────────            ─────────────────────────       ──────────────────
 Xvnc :1  (X display + VNC server, Unix socket only)   API, machine port 7700         Browser or desktop app
   ├─ matchbox  (window manager)                         /v1/instance/screen   ◄──┐    Screen view (noVNC)
   └─ Chromium  (the box's browser, CDP on loopback)     /v1/instance/screen/      │       │
 daemon (agentsd)                                          tunnels/<id>        ◄──┤       │ WebSocket
   ├─ starts and restarts the three above                                         │       ▼
   ├─ screen service: one RFB client for the agent's  ── outbound WebSockets ─────┘    API, people socket
   │  actions, the control state, and a tunnel per                                      /v1/screens/<box>
   │  viewer to Xvnc                                     relay: pairs each viewer      (Tailscale identity)
   └─ per session: Claude Code with the `computer`       with a box tunnel and drops
      MCP server, which proxies Playwright's browser     input from anyone who does
      tools and gates every action on the control state  not hold the screen
```

### The computer in the box

- **Display and VNC server in one process.** TigerVNC's `Xvnc` is an X server whose framebuffer is served over RFB, the VNC protocol. One process replaces Xvfb plus x11vnc, keeps one copy of the framebuffer, and pushes changes as X damages them instead of polling. It listens only on a Unix socket (`-rfbunixpath`, `-rfbport -1`), never on TCP, accepts connections as shared (`-AlwaysShared`, `-DisconnectClients=0`), and refuses resize requests, so the screen stays at the size the agent's coordinates assume.
- **Screen size 1280 x 800.** That is the size Claude's computer-use guidance recommends, so a screenshot reaches the model without scaling and the coordinates it answers with need no mapping.
- **Window manager.** matchbox gives every window the whole screen, with no title bars or taskbar. An agent sees one app at a time, which is what it works with, and screenshots carry no chrome. matchbox and its own library take 0.4 MB installed, and the other libraries it uses are small or ones the browsers need too. In a probe, openbox pulled in 151 MB and fluxbox 167 MB, mostly image loaders.
- **The browser.** Playwright's Chromium build, started by the daemon with its DevTools port on the box's loopback. Its profile is in the box's home volume, which outlives the container the way workspaces do. No check yet shows a login surviving a rebuild. It stays open on the screen, so a person watching sees the page the agent works on.
- **Playwright's browsers for checks.** The image carries Playwright 1.64.0, the version `package-lock.json` pins, with its Chromium, Chromium headless shell, Firefox and WebKit builds and the system libraries each needs on Debian 12 arm64. Agents and `agentsctl` run checks in all three engines without a download.
- **Who starts what.** The daemon is the box's main process (under `tini`, which reaps the browser's child processes). It starts Xvnc, matchbox and Chromium, restarts any that exit, and first clears the locks that would stop them. A killed box keeps Xvnc's lock, and Xvnc refuses to start while the process the lock names is alive, which in a probe was the new Xvnc itself. A home volume whose browser was killed on another host keeps Chromium's profile lock, and Chromium refuses a profile locked by another host. `test/step15.ts` brings a box back after an idle stop, after a kill, and on a volume locked elsewhere.
- **What the desktop sees.** Xvnc, matchbox, Chromium and xclip get only `PATH`, `HOME` and `DISPLAY`. The daemon's own environment holds the machine's token and the team's Claude token, and the browser can show any file it can read, such as `file:///proc/self/environ`, in a screenshot no scrubber reads. On a person's own box, onboarding keeps their Claude token in a file in the home volume. Everything in a box runs as one user, so the browser can open that file too, as the box's agents can.
- **No work without the computer.** The daemon takes no commands until its desktop is up, so a session never starts without its tools. A part of the desktop that doesn't come up within 30 seconds stops the daemon, and the container's restart policy starts the box again.

### Agent tools

Every session on a machine with a screen, except a judge's, gets one MCP server, `computer` (`daemon/computer-mcp.ts`), with these tools:

| Tool | What it does |
|---|---|
| `computer` | One action on the screen, named as in Claude's computer-use tool: `screenshot`, `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `mouse_move`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `scroll`, `type`, `key`, `hold_key`, `wait`, `cursor_position`. Every action returns a fresh screenshot. |
| `save_screenshot` | Saves the screen as `checks/<name>.png` in the task's `task` folder, where it becomes an image document on the task. Saves nothing while a page in the browser shows a secret the box holds. |
| `screen_status` | Who holds the screen, the agent or a person, and its size. |
| `browser_*` | Playwright MCP 0.0.83's browser tools, proxied with their own schemas, driving the box's Chromium over its DevTools port. `browser_take_screenshot` given a file name refuses as `save_screenshot` does. |

- **Why one server.** A person taking over must stop the agent's use of the screen, through the mouse and keyboard and through the browser's DevTools protocol alike. The `computer` server checks the control state before every action, its own and Playwright's, so one gate covers both. Playwright's tools run in a child process the server starts and talks to over MCP.
- **Not for judges.** A session the coding framework marks isolated, such as a reviewer's or a verifier's, gets no `computer` server, no standing instructions and no `verify-work` skill. The runner names the only tools a judge may use, a reviewer's being read-only, and the computer would add a browser and a screen to them. No check runs a judge in a box yet, so nothing fails if a judge gets the computer.
- **How actions reach the screen.** The daemon's screen service keeps one RFB connection to Xvnc for agents. Clicks and keys go out as RFB pointer and key events, and screenshots come back as raw framebuffer updates that the service encodes as PNG, once the screen has been still for 200 ms or after 3 s at most. No xdotool, ImageMagick or ffmpeg is needed. Printable ASCII is typed key by key. Other text is put on the X clipboard with xclip and pasted with ctrl+v, because Xvnc adds a key to its keymap for each such character and the browser often reads the press before the new keymap. Typed key by key, 9 of 18 strings of accented, Greek, Cyrillic, CJK and emoji text arrived whole. Pasted, 90 of 90 did. Pasting needs an app where ctrl+v pastes, which the browser is. Actions from several sessions on one box run one at a time.
- **Inputs and outputs are zod schemas.** Each tool's input and structured output is a zod schema in `shared/screen.ts`. The proxied browser tools keep Playwright's own schemas.

**Which actions run without asking.** The box's computer belongs to the agents that run there, the way a workspace belongs to its session. Watching and driving its own screen and browser are allowed without a prompt, because verification needs dozens of them per change and a prompt for each would make the tools useless. These ask a person first, through the usual approval card, because each one can carry data or code out of the box or read a logged-in site's secrets:

- `browser_file_upload` and `browser_drop`, which send files from the box to a page.
- `browser_evaluate`, which runs JavaScript with the page's own access, including a logged-in site's cookies and storage.
- `browser_run_code_unsafe`, which runs code in Playwright's own process.
- `browser_network_request`, which returns full request and response headers and bodies, where session cookies and tokens live.

The standing instructions also tell agents never to type passwords, payment details or one-time codes, never to submit forms that act on real accounts (purchases, messages to people, deletions, settings changes), and to ask a person to take over for those. Prompts can't enforce that. The box's browser reaches the open web, as Tayler decided on 2026-10-13, so nothing limits which sites it opens.

### Watching and taking over

- **The stream leaves the box only outbound.** When a box's desktop is up, its daemon keeps one WebSocket open to the API's machine port, `/v1/instance/screen`, authenticated by the box's instance token. When a person opens the Screen view, the API asks the box over that socket to open a tunnel. The box dials a second WebSocket, `/v1/instance/screen/tunnels/<id>`, and joins it to Xvnc's Unix socket. Nothing listens in the box for the API to call.
- **The person comes in only through tailscale serve.** The browser opens `/v1/screens/<box>` on the app's own address. Serve sends it to the API's people socket, `AGENTS_PEOPLE_SOCKET`, with the person's Tailscale login. The API pairs the person's WebSocket with the box's tunnel and passes RFB bytes both ways.
- **Only the app's pages may open a screen.** A browser sends its page's origin with every WebSocket it opens. The API refuses, with 403, an upgrade whose origin isn't in `AGENTS_PEOPLE_ORIGINS`, a setting it requires at startup, such as `http://agents-server.<tailnet>.ts.net`. Otherwise a page on another site, open in a teammate's browser, could watch and take over as them. Host isn't compared, since the page picks the host it connects to. The take and hand-back posts are covered by main's rule that a person's change must be sent as JSON.
- **Who may watch.** Anyone on the box's team, unless the box ran work they can't see. If a session on the box that is working now, or was active in the last 24 hours, belongs to a private task or conversation the person is not in, the API refuses with "This screen has shown work you can't see." The screen shows whatever the box shows, so the rule is about the box, not one session. The rule runs again for everyone watching on each sweep, every 5 seconds, and whenever a session on the box reports its status. A viewer who may no longer watch is closed with 4403, and a screen they held goes back to the agent. Handing back runs no watch rule, only a check that the screen is the person's team's, so a person cut off can still hand it back.
- **Taking over is a typed state machine** (`shared/screen.ts`). The control is either `{ holder: 'agent' }` or `{ holder: 'person', personId, login, since }`. Three events move it. `take` gives a free screen to a person and is a no-op for the person who already holds it. `hand_back` returns it from its holder. `left` returns it when the holder has had no Screen view open for 30 seconds, so a closed tab never strands an agent, or may no longer watch it. Every other combination is refused with a reason a person can read. The server, the box and the app all use the one transition function.
- **What enforces it.**
  - **The API filters each viewer's input.** It parses the RFB messages a viewer's browser sends and forwards key and pointer events only from the person who holds the screen. Clipboard pastes, desktop resizes and power requests from any viewer are dropped, so nothing enters the box from a viewer except typed and clicked input. When control moves away from a person, the API releases any key or mouse button they still hold, so the agent never inherits a stuck modifier.
  - **The box refuses the agent's actions while a person holds the screen.** The API sends every change of control to the box over the control socket. The screen service aborts an action in progress, releases what it held, and answers each `computer` or `browser_*` call with "alice has taken over the screen. Wait until they hand it back (screen_status tells you), then take a screenshot before you act." When a person takes over during a browser call, the agent's call returns then with the refusal, since the `computer` server asks the screen service who holds the screen every 250 ms while a call runs. Whether Playwright stops the action it was taking is not shown. After the hand-back, the agent's next action reports that a person used the screen and includes a fresh screenshot.
  - **The record shows it.** Each takeover is a row in `screen_takeovers`, and a notice goes into the active sessions on that box: "alice took over the screen", then "alice handed the screen back", "The screen went back to the agent after alice closed the Screen view" or "The screen went back to the agent because alice may no longer watch it".
  - **Dead connections are dropped.** The API pings each viewer and each tunnel every 15 seconds and drops one that hasn't answered in 45. A laptop that sleeps or a box that hangs leaves its connection open with nobody behind it, and a holder's dead view would otherwise keep the screen from going back to the agent.
- **Latency.** Measured on this Mac by `test/step15.ts` and `test/step15b.ts`, from a key press in the viewer to the changed pixels arriving, through the people socket, the API relay, the box tunnel, Xvnc and the box's browser. The first frame arrives 27 to 111 ms after a viewer connects. Through the API to a Node viewer, the median is 15 to 30 ms and the 95th percentile 29 to 42 ms. In the Screen view, the median is 32 to 46 ms in Chromium, 16 to 48 ms in WebKit and 15 to 24 ms in Firefox. Over the tailnet it is not measured, and adds the round trip to the server Mac.

### Verifying their own work

- **Standing instructions** go into every session on a machine with a screen, except a judge's. They say what the computer is, that every change is checked before the agent calls it done (run its tests, then look at the result in the browser), that each thing checked is saved with `save_screenshot`, and how to behave when a person holds the screen.
- **A skill, `verify-work`,** written into each such session's `.claude/skills` beside the agent's own skills, spells out the loop: run the tests, start the app, open it in the box's browser, exercise the change, read the console, save a screenshot named for what it shows, and say in the reply which screenshots prove what. An agent's own skill of the same name replaces it.
- **Screenshots become documents.** Files the agent writes in the task folder already become document versions at the end of each turn. Images now do too.

### Images as documents

- **Where the bytes live: Postgres.** Postgres is the only system of record (`docs/intent/multiplayer.md`). Keeping images there means one backup, one access check, one store to move to AWS, and the version row and its bytes commit together. A 1280 x 800 screenshot of the check page is 20 KB as PNG, a busier page is larger, and each image may be up to 5 MB. A few per task is a size Postgres holds without trouble. A file store on the server would add a second thing to back up, keep in step and move, for a size that doesn't need it yet.
- **In their own table.** Bytes live in `blobs`, not in `artifact_versions`. Electric follows every column of every table a shape reads, so image bytes in the version row would stream through logical replication and into every open document list. `blobs` is never a shape. A version points at its blob, and the app fetches the bytes from `GET /v1/artifacts/<id>/versions/<n>/image`, which checks the person can see the task.
- **Limits.** PNG, JPEG, WebP and GIF only, recognised by their first bytes rather than the file name, up to 5 MB each. SVG is refused because it can carry script. Blobs are kept per team and keyed by their SHA-256, so the same screenshot saved twice is stored once.
- **Secrets in pixels.** The scrubber works on text. A screenshot of a page or terminal that shows a secret keeps it, and a saved image can't be scrubbed. So no screenshot is saved while a page in the box's browser shows a value the box holds as a secret: one in the daemon's environment or `secrets.json`, or its owner's Claude token. `save_screenshot` checks once its shot is taken, and Playwright's `browser_take_screenshot` checks before it saves under a file name the agent gives. The `computer` server asks the daemon's screen service, which alone holds the values. The service reads every tab, and each frame the browser runs apart, through the browser's DevTools DOM (`daemon/page-secrets.ts`), which goes into every frame the page's process runs, whatever its origin, and every shadow root, closed ones too. It takes each document's address, title and rendered text, each shadow root's rendered text, and every field's value. Rendered text joins a value's lines with spaces, so both sides collapse each run of whitespace before they compare. It answers with the names of the secrets it finds, and the refusal names them, never their values.
- **A page that can't be read refuses too.** A page that gives no text within 5 s, a failed list of pages, a reply the daemon can't read and a screen service that doesn't answer all save no file, since nobody can tell what the page shows. So a page an alert holds refuses every screenshot, and an agent can't save proof of a dialog, which it could before the refusal. That takes something away, and Tayler accepted it on 2026-10-14.
- **What the refusal can't cover.** It can't see a secret outside the page's text: one drawn in an image, on a canvas, in a video or by a plugin such as the PDF viewer, shown in another window such as a terminal, or shown only in the moment between the shot and the check. A screenshot the agent's own script writes into the task folder isn't checked either. Frames from another site, which the browser runs apart, were found in one probe on this Mac, and no check in a box shows them. The standing instructions still tell agents never to screenshot secrets, and the live stream is never stored.
- **Screenshots in tool results.** Claude Code's output includes every image an MCP tool returns, as base64. Kept whole, each `computer` action would add a few hundred KB to the record. The daemon replaces image data in events and raw lines with its size, media type and SHA-256 before posting. The record shows that the agent looked, and the saved screenshots keep what it chose to prove.

## Data shape

Migration `server/migrations/0008_computers.sql`. Row types are declared once in `shared/screen.ts` and `shared/documents.ts` until the schema generator lands.

- **`instances.screen_width`, `instances.screen_height`.** The size of the screen a machine reports on its heartbeat, or null when it has none. Both set or both null.
- **`screen_takeovers`, new.** One row per time a person held a machine's screen: `id`, `team_id`, `instance_id`, `person_id`, `session_id` (the session the person was looking at, if any), `started_at`, `ended_at`, and `ended_by` (`handed_back` or `left`). At most one open row per machine, enforced by a unique index. The open row is the record of who holds a screen. The API keeps a copy per screen and the box keeps the one the API sends it, and every change goes through the API, which writes the row before it updates either copy.
- **`blobs`, new.** `id`, `team_id`, `sha256`, `media_type`, `size_bytes`, `data` (bytea), `created_at`. Unique on `(team_id, sha256)`.
- **`artifact_versions.blob_id`.** Set on an image version, whose `content` is empty. A version is text or an image, never both.

## API routes

| Listener | Route | Who | What |
|---|---|---|---|
| machines | `GET /v1/instance/screen` (WebSocket) | a box | The box's control connection. Carries control changes and tunnel requests to the box, and keep-alives both ways. |
| machines | `GET /v1/instance/screen/tunnels/<id>` (WebSocket) | a box | One viewer's RFB stream, from the box's Xvnc. |
| machines | `POST /v1/instance/heartbeat` | a machine | Now also reports `screen: { width, height }` or `null`. |
| machines | `POST /v1/sessions/<id>/documents` | a machine | Now also takes images: `{ path, image: { mediaType, base64 } }`. |
| people socket | `GET /v1/screens/<box>` (WebSocket) | a person | Watch the screen, from an origin in `AGENTS_PEOPLE_ORIGINS`. Binary frames carry RFB, and text frames carry the control state whenever it changes. |
| people socket | `POST /v1/screens/<box>/take` | a person | Take over the keyboard and mouse. Body `{ sessionId? }`, the session the person is looking at. |
| people socket | `POST /v1/screens/<box>/hand-back` | a person | Give the screen back to the agent. |
| people socket | `GET /v1/artifacts/<id>/versions/<n>/image` | a person | An image version's bytes. |

## What each person sees

- **A task or session running in a box** shows a Screen button in its header and in its session panel. It opens the Screen view beside the task, or in its place at phone width.
- **The Screen view** shows the box's name and size, who has the screen ("The agent has the screen", "You have the screen", "alice has the screen"), the live display scaled to fit, and one action: Take over, or Hand back. While a person holds it, their keyboard and mouse go to the box and everyone else watching sees who has it. When the box is stopped or hasn't connected, the status line says so, with a Reconnect link.
- **Made by this task** lists screenshots with the other documents. Opening one shows the image, its versions and comments.
- **The session panel** shows takeovers as notices, in order with the agent's steps.

## The Mac computer-use helper (design only, not built)

Agents could also drive a teammate's Mac, for apps that only run there. This is how it would work.

- **A separate signed helper app, not the daemon.** macOS grants Screen Recording and Accessibility to a code-signed app identity. Granting them to `node` would give them to every Node program on the Mac. A small Swift app, "Agents Computer Helper", with its own bundle id, holds both permissions. The daemon starts it and talks to it over a Unix socket in `~/.agents-app` with a token minted for each launch.
- **What it uses.** ScreenCaptureKit (`SCScreenshotManager`) for screenshots, scaled to 1280 pixels wide like a box. `CGEvent` for clicks, keys and scrolls. The Accessibility API (`AXUIElement`) to read the focused app's element tree, so the agent can target "the Save button" rather than guess coordinates.
- **How a person grants it.** Turning it on for a Mac in the app opens the helper, which asks macOS for Screen Recording and Accessibility. macOS shows its own prompts and lists the helper in System Settings > Privacy & Security, where the person can revoke either at any time. Without both, the helper reports which one is missing and the agent's tools say so.
- **How a person limits it.**
  - Off by default on every Mac. Turned on per Mac, for the agents the owner names.
  - Every session that wants the Mac's screen asks the owner first, with an ask card, allowed for that session only. There is no "always".
  - An app list. The helper captures only the windows of apps the owner allowed (`SCContentFilter` with those apps), and posts input only while one of them is frontmost. Terminal, System Settings, Keychain Access and password managers are never on it.
  - It refuses to type into secure text fields (`AXSecureTextField`).
  - While an agent drives, a menu bar item shows it, and any physical mouse movement or key press by the person takes the screen back at once, the same way Take over does on a box.
- **Watching.** The owner sees their own screen. Teammates would use the same Screen view, with the helper speaking RFB over the same outbound tunnel, so the API relay and the app need no changes.

## Sizing for the AWS box host

Measured with `docker stats` during `test/step15.ts` on this Mac's colima VM (arm64, 4 CPUs, 8 GB). Claude Code is not in these numbers, since the checks run the stand-in for it.

- **Image.** 1.05 GB compressed and 3.78 GB on disk, against 251 MB and 974 MB before. What each layer costs is in the build log.
- **Limits.** `server/boxes.ts` runs each box with 4 GB of memory and no swap, 2 CPUs and 4,096 processes, threads included, so a runaway browser or agent can't take the host. Step 15 runs three engines at once in a box within them, and passes.
- **Idle box.** The desktop with Chromium open on a blank page takes 323 to 496 MiB, at 0 to 4% of a CPU.
- **Busy box.** An agent driving the screen takes 564 to 651 MiB at most, up to 24% of a CPU. With Chromium, Firefox and WebKit open at once beside it, as an agent's checks would have them, it took 1136 to 1160 MiB at most and up to 249% of a CPU before the limits, and 1149 to 1720 MiB and up to 204% under them, as `docker stats` samples it.
- **What to plan per box,** before adding Claude Code: about 0.6 GB while it works on the screen, and about 1.7 GB with 2 CPUs while its checks run three engines, which used 2.5 CPUs when nothing held them back.

## x86 (not built)

Only arm64 is built and tried. Debian ships TigerVNC, matchbox and xclip for amd64, Playwright publishes x64 builds of all three browsers, and the daemon finds the browser by looking for the one installed Chromium, so the same Dockerfile should build there. Building for x86 means building on an x86 host, or `docker buildx build --platform linux/amd64` from this Mac, which emulates and is slow. Graviton (arm64) hosts on AWS match this Mac's architecture, and no box has run on one yet.

## What other agents need from this

- **Onboarding (each person's own box and their Claude login),** which landed first. A person's own box is built from the same image, so it gets the desktop once `server/boxes.ts build` runs and the box is recreated. Their Claude login needs nothing new. The Screen view works for any box whose daemon reports a screen. No check has opened the screen of a person's own box.
- **The AWS move.** Boxes need 512 MB of `/dev/shm` (`--shm-size`), outbound WebSockets from the box to the API's machine port (an ALB or the tailnet must allow WebSocket upgrades), and the sizes above. Each box needs a network of its own, as Docker's bridge gives it. The desktop and the browser tools find the box's browser at 127.0.0.1:9222. In a probe, a second browser on a shared network listened on [::1] because another held 127.0.0.1, so on the host's network one box's browser tools would reach another box's browser. Step 12c runs boxes that way, and nothing in it drives a browser. The export must carry the boxes' home volumes, which now hold the browser's profile too. Whether `tailscale serve` passes the Screen view's WebSocket through to the people socket with the person's identity is not tried, since the checks stand in for serve with `test/people.ts`.
- **Verification (`agentsctl`).** The image carries Playwright 1.64.0 with Chromium 156.0.8078.4 (revision 1248) and its headless shell, Firefox 157.0 (1555), WebKit 27.2 (2370) and ffmpeg (1013), in `/opt/ms-playwright`, which `PLAYWRIGHT_BROWSERS_PATH` names. It is read-only to the agent. Another Playwright version's browsers go in the home volume with `PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright npx playwright install`.

## Tayler's calls

Tayler made these calls on 2026-10-14.

- **Screenshots can hold secrets.** Saved images aren't scrubbed, so no screenshot is saved while the browser's page text contains a known secret value, as "Secrets in pixels" above describes. It can't cover a secret shown outside the page.
- **A page that can't be read** within 5 seconds, such as one an open alert holds, refuses every screenshot until it can, as "A page that can't be read refuses too" above says. An agent can't save proof of a dialog meanwhile, which it could before the refusal.
- **The 24-hour privacy window** for watching a box that ran private work stays.
- **Limits on the browser** stay. The standing instructions tell agents never to type passwords, payment details or one-time codes, and never to submit a form that acts on a real account, but to ask a person to take over for that step. Five browser tools ask a person before each use. Both trade some of what a browser on the open web can do for safety.
- **The box limits**, 4 GB of memory, 2 CPUs and 4,096 processes set in `server/boxes.ts`, are accepted. Without them a box running three browser engines at once peaked at 2.5 CPUs, so the CPU limit slows a box's busiest moments, and a box can't have more than 4 GB however much its work needs. Real Claude Code's use in a box is not measured. Before this, boxes had no limits, so this takes something away.
- **A box without its desktop takes no work**, accepted too. A box whose desktop can't come up stops and starts again until it can, and takes no work meanwhile. Before, it worked without a computer, so agents could still do work that needs no screen. The review that asked for this wanted a session never to start without its tools.
- **The packages** this branch adds are approved: `ws` and its types, `@types/ws`, for the screen's WebSockets, and `@novnc/novnc` for the Screen view.

## Not done

- **The Mac helper** is a design only. Nothing of it is built.
- **x86.** No amd64 image has been built.
- **The tailnet.** Latency over the tailnet, and the Screen view through `tailscale serve`, are not tried. The checks reach the people socket through `test/people.ts`, which stands in for serve, and set the identity header themselves.
- **A real agent at the computer.** The checks drive the computer tools themselves and run the stand-in for Claude. Real Claude Code's image results were checked once, outside a box, to get their format right. No real Claude session has used the computer in a box yet, so whether agents follow the verify-work loop unprompted is not shown.
- **Logins surviving a rebuild.** The browser's profile is in the home volume, and no check signs in, rebuilds the box and looks.
- **Boxes on a shared network** share the browser's DevTools port, as "The AWS move" above says. Only step 12c runs boxes that way.
- **Built, with no check yet.** The API letting go of a viewer's held keys and buttons when control moves, dropping clipboard, resize and power messages from viewers, and actions from several sessions on one box running one at a time. A person taking over between the screen service's check and its action is closed off by checking again with nothing awaited in between, which no check can time. Of the ways a page read fails, step 15 shows only a page an alert holds. A failed list of pages, a reply the daemon can't read, a screen service answering other than 200 and a dead service socket save no file by the same code, with no check of their own.
- **Secrets outside the page's text** can still reach a saved screenshot, as "What the refusal can't cover" lists.
