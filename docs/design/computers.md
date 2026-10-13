# Agent computers

Every agent that runs in a box gets its own computer: a Linux desktop, a browser, and tools to see and drive both. A person can watch that screen live from the app and take over the keyboard and mouse. Agents use the computer to check their own work, and the screenshots they save land on the task.

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
   ├─ screen service: one RFB client for the agent's  ── outbound WebSockets ─────┘    API, people port 7710
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

### Agent tools

Every session on a machine with a screen gets one MCP server, `computer` (`daemon/computer-mcp.ts`), with these tools:

| Tool | What it does |
|---|---|
| `computer` | One action on the screen, named as in Claude's computer-use tool: `screenshot`, `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `mouse_move`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `scroll`, `type`, `key`, `hold_key`, `wait`, `cursor_position`. Every action returns a fresh screenshot. |
| `save_screenshot` | Saves the screen as `checks/<name>.png` in the task's `task` folder, where it becomes an image document on the task. |
| `screen_status` | Who holds the screen, the agent or a person, and its size. |
| `browser_*` | Playwright MCP 0.0.83's browser tools, proxied unchanged, driving the box's Chromium over its DevTools port. |

- **Why one server.** A person taking over must stop the agent's use of the screen, through the mouse and keyboard and through the browser's DevTools protocol alike. The `computer` server checks the control state before every action, its own and Playwright's, so one gate covers both. Playwright's tools run in a child process the server starts and talks to over MCP.
- **How actions reach the screen.** The daemon's screen service keeps one RFB connection to Xvnc for agents. Clicks and keys go out as RFB pointer and key events, and screenshots come back as raw framebuffer updates that the service encodes as PNG, once the screen has been still for 200 ms or after 3 s at most. No xdotool, ImageMagick or ffmpeg is needed. Printable ASCII is typed key by key. Other text is put on the X clipboard with xclip and pasted with ctrl+v, because Xvnc adds a key to its keymap for each such character and the browser often reads the press before the new keymap. Typed key by key, 9 of 18 strings of accented, Greek, Cyrillic, CJK and emoji text arrived whole. Pasted, 90 of 90 did. Pasting needs an app where ctrl+v pastes, which the browser is. Actions from several sessions on one box run one at a time.
- **Inputs and outputs are zod schemas.** Each tool's input and structured output is a zod schema in `shared/screen.ts`. The proxied browser tools keep Playwright's own schemas.

**Which actions run without asking.** The box is the agent's own computer, the way its workspace is its own folder. Watching and driving its own screen and browser are allowed without a prompt, because verification needs dozens of them per change and a prompt for each would make the tools useless. These ask a person first, through the usual approval card, because each one can carry data or code out of the box or read a logged-in site's secrets:

- `browser_file_upload` and `browser_drop`, which send files from the box to a page.
- `browser_evaluate`, which runs JavaScript with the page's own access, including a logged-in site's cookies and storage.
- `browser_run_code_unsafe`, which runs code in Playwright's own process.
- `browser_network_request`, which returns full request and response headers and bodies, where session cookies and tokens live.

The standing instructions also tell agents never to type passwords, payment details or one-time codes, never to submit forms that act on real accounts (purchases, messages to people, deletions, settings changes), and to ask a person to take over for those. Prompts can't enforce that. The box's browser reaches the open web, as Tayler decided on 2026-10-13, so nothing limits which sites it opens.

### Watching and taking over

- **The stream leaves the box only outbound.** When a box's desktop is up, its daemon keeps one WebSocket open to the API's machine port, `/v1/instance/screen`, authenticated by the box's instance token. When a person opens the Screen view, the API asks the box over that socket to open a tunnel. The box dials a second WebSocket, `/v1/instance/screen/tunnels/<id>`, and joins it to Xvnc's Unix socket. Nothing listens in the box for the API to call.
- **The person comes in only through the people port.** The browser opens `/v1/screens/<box>` on the people port, which only `tailscale serve` reaches, so the person's identity is their Tailscale login. The API pairs the person's WebSocket with the box's tunnel and passes RFB bytes both ways.
- **Who may watch.** Anyone on the box's team, unless the box ran work they can't see. If a session on the box that is working now, or was active in the last 24 hours, belongs to a private task or conversation the person is not in, the API refuses with "This screen has shown work you can't see." The screen shows whatever the box shows, so the rule is about the box, not one session.
- **Taking over is a typed state machine** (`shared/screen.ts`). The control is either `{ holder: 'agent' }` or `{ holder: 'person', personId, login, since }`. Three events move it. `take` gives a free screen to a person and is a no-op for the person who already holds it. `hand_back` returns it from its holder. `left` returns it when the holder has had no Screen view open for 30 seconds, so a closed tab never strands an agent. Every other combination is refused with a reason a person can read. The server, the box and the app all use the one transition function.
- **What enforces it.**
  - **The API filters each viewer's input.** It parses the RFB messages a viewer's browser sends and forwards key and pointer events only from the person who holds the screen. Clipboard pastes, desktop resizes and power requests from any viewer are dropped, so nothing enters the box from a viewer except typed and clicked input. When control moves away from a person, the API releases any key or mouse button they still hold, so the agent never inherits a stuck modifier.
  - **The box refuses the agent's actions while a person holds the screen.** The API sends every change of control to the box over the control socket. The screen service aborts an action in progress, releases what it held, and answers each `computer` or `browser_*` call with "alice has taken over the screen. Wait until they hand it back (screen_status tells you), then take a screenshot before you act." After the hand-back, the agent's next action reports that a person used the screen and includes a fresh screenshot.
  - **The record shows it.** Each takeover is a row in `screen_takeovers`, and a notice goes into the active sessions on that box: "alice took over the screen", then "alice handed the screen back" or "The screen went back to the agent after alice closed the Screen view".
- **Latency.** Measured on this Mac by `test/step15.ts` and `test/step15b.ts`, from a key press in the viewer to the changed pixels arriving, through the people port, the API relay, the box tunnel, Xvnc and the box's browser. The first frame arrives 27 to 111 ms after a viewer connects. Through the API to a Node viewer, the median is 15 to 25 ms and the 95th percentile 29 to 36 ms. In the Screen view, the median is 32 ms in Chromium, 16 to 32 ms in WebKit and 15 to 23 ms in Firefox. Over the tailnet it is not measured, and adds the round trip to the server Mac.

### Verifying their own work

- **Standing instructions** go into every session on a machine with a screen. They say what the computer is, that every change is checked before the agent calls it done (run its tests, then look at the result in the browser), that each thing checked is saved with `save_screenshot`, and how to behave when a person holds the screen.
- **A skill, `verify-work`,** written into each such session's `.claude/skills` beside the agent's own skills, spells out the loop: run the tests, start the app, open it in the box's browser, exercise the change, read the console, save a screenshot named for what it shows, and say in the reply which screenshots prove what. An agent's own skill of the same name replaces it.
- **Screenshots become documents.** Files the agent writes in the task folder already become document versions at the end of each turn. Images now do too.

### Images as documents

- **Where the bytes live: Postgres.** Postgres is the only system of record (`docs/intent/multiplayer.md`). Keeping images there means one backup, one access check, one store to move to AWS, and the version row and its bytes commit together. A 1280 x 800 screenshot of the check page is 20 KB as PNG, a busier page is larger, and each image may be up to 5 MB. A few per task is a size Postgres holds without trouble. A file store on the server would add a second thing to back up, keep in step and move, for a size that doesn't need it yet.
- **In their own table.** Bytes live in `blobs`, not in `artifact_versions`. Electric follows every column of every table a shape reads, so image bytes in the version row would stream through logical replication and into every open document list. `blobs` is never a shape. A version points at its blob, and the app fetches the bytes from `GET /v1/artifacts/<id>/versions/<n>/image`, which checks the person can see the task.
- **Limits.** PNG, JPEG, WebP and GIF only, recognised by their first bytes rather than the file name, up to 5 MB each. SVG is refused because it can carry script. Blobs are kept per team and keyed by their SHA-256, so the same screenshot saved twice is stored once.
- **Secrets in pixels.** The scrubber works on text. A screenshot of a page or terminal that shows a secret keeps it. The standing instructions tell agents never to screenshot secrets, and the live stream is never stored, but a saved image can't be scrubbed. This is a decision for Tayler (see the end).
- **Screenshots in tool results.** Claude Code's output includes every image an MCP tool returns, as base64. Kept whole, each `computer` action would add a few hundred KB to the record. The daemon replaces image data in events and raw lines with its size, media type and SHA-256 before posting. The record shows that the agent looked, and the saved screenshots keep what it chose to prove.

## Data shape

Migration `server/migrations/0008_computers.sql`. Row types are declared once in `shared/screen.ts` and `shared/documents.ts` until the schema generator lands.

- **`instances.screen_width`, `instances.screen_height`.** The size of the screen a machine reports on its heartbeat, or null when it has none. Both set or both null.
- **`screen_takeovers`, new.** One row per time a person held a machine's screen: `id`, `team_id`, `instance_id`, `person_id`, `session_id` (the session the person was looking at, if any), `started_at`, `ended_at`, and `ended_by` (`handed_back` or `left`). At most one open row per machine, enforced by a unique index. The open row is the control state, so there is no second copy of who holds a screen to drift.
- **`blobs`, new.** `id`, `team_id`, `sha256`, `media_type`, `size_bytes`, `data` (bytea), `created_at`. Unique on `(team_id, sha256)`.
- **`artifact_versions.blob_id`.** Set on an image version, whose `content` is empty. A version is text or an image, never both.

## API routes

| Port | Route | Who | What |
|---|---|---|---|
| machines | `GET /v1/instance/screen` (WebSocket) | a box | The box's control connection. Carries control changes and tunnel requests to the box, and keep-alives both ways. |
| machines | `GET /v1/instance/screen/tunnels/<id>` (WebSocket) | a box | One viewer's RFB stream, from the box's Xvnc. |
| machines | `POST /v1/instance/heartbeat` | a machine | Now also reports `screen: { width, height }` or `null`. |
| machines | `POST /v1/sessions/<id>/documents` | a machine | Now also takes images: `{ path, image: { mediaType, base64 } }`. |
| people | `GET /v1/screens/<box>` (WebSocket) | a person | Watch the screen. Binary frames carry RFB, and text frames carry the control state whenever it changes. |
| people | `POST /v1/screens/<box>/take` | a person | Take over the keyboard and mouse. Body `{ sessionId? }`, the session the person is looking at. |
| people | `POST /v1/screens/<box>/hand-back` | a person | Give the screen back to the agent. |
| people | `GET /v1/artifacts/<id>/versions/<n>/image` | a person | An image version's bytes. |

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
- **Idle box.** The desktop with Chromium open on a blank page takes 323 to 328 MiB, at 0 to 4% of a CPU.
- **Busy box.** An agent driving the screen takes 564 to 587 MiB at most, up to 24% of a CPU. With Chromium, Firefox and WebKit open at once beside it, as an agent's checks would have them, it takes 1136 to 1160 MiB at most, up to 249% of a CPU.
- **What to plan per box,** before adding Claude Code: about 0.6 GB while it works on the screen, and about 1.2 GB with a peak of 2.5 CPUs while its checks run three engines.

## x86 (not built)

Only arm64 is built and tried. Debian ships TigerVNC, matchbox and xclip for amd64, Playwright publishes x64 builds of all three browsers, and the daemon finds the browser by looking for the one installed Chromium, so the same Dockerfile should build there. Building for x86 means building on an x86 host, or `docker buildx build --platform linux/amd64` from this Mac, which emulates and is slow. Graviton (arm64) hosts on AWS match this Mac's architecture, and no box has run on one yet.

## What other agents need from this

- **Onboarding (each developer's own box and their Claude login).** A developer's box should be created from this image so it has the desktop. Their Claude login needs nothing new. The Screen view works for any box whose daemon reports a screen.
- **The AWS move.** Boxes need 512 MB of `/dev/shm` (`--shm-size`), outbound WebSockets from the box to the API's machine port (an ALB or the tailnet must allow WebSocket upgrades), and the sizes above. The export must carry the boxes' home volumes, which now hold the browser's profile too. Whether `tailscale serve` passes the Screen view's WebSocket through with the person's identity is not tried, since the checks reach the people port directly.
- **Verification (`agentsctl`).** The image carries Playwright 1.64.0 with Chromium 156.0.8078.4 (revision 1248) and its headless shell, Firefox 157.0 (1555), WebKit 27.2 (2370) and ffmpeg (1013), in `/opt/ms-playwright`, which `PLAYWRIGHT_BROWSERS_PATH` names. It is read-only to the agent. Another Playwright version's browsers go in the home volume with `PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright npx playwright install`.

## Decisions for Tayler

- **Screenshots can hold secrets.** Saved images aren't scrubbed. The options are to keep the instruction only, or to have the daemon refuse to save a screenshot while the browser's page text contains a known secret value, which can't cover anything outside the page.
- **The 24-hour privacy window** for watching a box that ran private work.
- **Limits on the browser.** The standing instructions tell agents never to type passwords, payment details or one-time codes, and never to submit a form that acts on a real account, but to ask a person to take over for that step. Five browser tools ask a person before each use. Both trade some of what a browser on the open web can do for safety, which `AGENTS.md` leaves to Tayler, so they stay only if Tayler keeps them.

## Not done

- **The Mac helper** is a design only. Nothing of it is built.
- **x86.** No amd64 image has been built.
- **The tailnet.** Latency over the tailnet, and the Screen view through `tailscale serve`, are not tried. The checks reach the people port directly with the identity header.
- **A real agent at the computer.** The checks drive the computer tools themselves and run the stand-in for Claude. Real Claude Code's image results were checked once, outside a box, to get their format right. No real Claude session has used the computer in a box yet, so whether agents follow the verify-work loop unprompted is not shown.
- **Logins surviving a rebuild.** The browser's profile is in the home volume, and no check signs in, rebuilds the box and looks.
- **Built, with no check yet.** The API letting go of a viewer's held keys and buttons when control moves, dropping clipboard, resize and power messages from viewers, and actions from several sessions on one box running one at a time.
- **Screenshot scrubbing** waits on the decision above.
