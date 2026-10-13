# Agent computers: where the work stands

A note for whoever picks this up, kept current with each commit. The design is `docs/design/computers.md`.

## Done, on this branch

| Commit | What |
|---|---|
| 0e16c31 | Design doc, `docs/design/computers.md` |
| 0608199 | Migration `server/migrations/0008_computers.sql`, with its `docs/data-model.md` entry |
| 5b09db5 | Box image: Xvnc, matchbox, tini, Playwright 1.64.0 with Chromium, Firefox and WebKit, Playwright MCP 0.0.83 |
| 1672e93 | The box's desktop, screen service and `computer` MCP server, standing instructions and the `verify-work` skill |
| 4d90169 | Typing outside ASCII pastes through the clipboard (xclip), 90 of 90 strings whole |
| 321997f | Watching and taking over through the API: control connection, tunnels, input filter, the handoff state machine, takeover rows and notices |
| c0fea7f | Images in a task's folder become documents (`blobs`, the image route, the document panel) |
| e7c8ee1 | Screenshots in tool results are kept out of the record (size and SHA-256 instead) |
| 7685dee | The design doc and code no longer refer to the studied app |
| cf38bcb | Screenshots wait for the screen to settle |
| b563f97 | The Screen view in the app, loaded only when opened |
| bcbdf42 | `test/step15.ts` and `test/step15b.ts`, with `test/computers.ts` and `test/box-browsers.ts` |

Both checks pass: step15 has 30 checks, step15b has 17 per engine in Chromium, WebKit and Firefox.

## Measured (this Mac, colima arm64, 4 CPUs, 8 GB)

- Image `agents-box:computers`: 1.05 GB compressed, 3.78 GB on disk, against 251 MB and 974 MB before. Layers: desktop 236 MB, Playwright package 22 MB, Chromium libraries 82 MB, Firefox libraries 158 MB, WebKit libraries 192 MB, Chromium and its headless shell 713 MB, Firefox 300 MB, WebKit 290 MB, Playwright MCP 19 MB.
- Box memory: idle with its desktop and open browser 328 MiB at 0 to 1% CPU. An agent driving the screen 586 MiB, up to 16% CPU. Chromium, Firefox and WebKit open at once beside it 1146 MiB, up to 249% CPU. Claude Code itself is not in these numbers, since the checks use the stand-in.
- Screen: first frame 37 to 51 ms after a viewer connects. Key press to pixels through the API, Node viewer: median 20 ms, p95 29 to 33 ms. In the browser through the Screen view: Chromium median 32 ms, WebKit 31 ms, Firefox 23 ms.

## Still to do

1. Seen failing: break each guarded behavior, run the check, watch it fail, restore byte for byte, watch it pass. Planned breaks: drop the input filter's holder test (bob's keys reach the page), skip the image stripping reviver, make `watchable` skip the private-work count, return the agent's control from `move` without the takeover row, remove the paste path, remove the settle step.
2. Check each commit passes typecheck and lint alone, in a temporary worktree.
3. Add the build-log section in `docs/build-log.md` and update the design doc's sizing section with the numbers above.
4. Report to the coordinator.

## Running the checks

- Take the lock first: `mkdir ~/.agents-app/checks/run.lock`, and `rmdir` it after. Both checks use port 7701, the only check port the box firewall opens.
- `node --env-file=.env --env-file=.env.test test/step15.ts` takes about 4 minutes when the image is cached, 7 when it builds.
- `node --env-file=.env --env-file=.env.test test/step15b.ts` takes about 5 minutes. `AGENTS_UI_ENGINES=chromium` runs one engine.
- Teams are `comp-*`. A failed run keeps its team in `agents_test` and its folder under `~/.agents-app/checks/comp-*`. Both are safe to delete.

## Left running

- No containers. Every box a check makes is removed when it ends.
- The image `agents-box:computers` (3.78 GB). Remove it with `docker rmi agents-box:computers` once nobody needs it. `agents-box:latest` is the live server's and was never touched.

## Open questions for Tayler

- Should agents' browsers reach only named origins, such as localhost and preview domains?
- Saved screenshots can't be scrubbed of secrets on screen. Keep the instruction only, or more?
- The 24-hour privacy window for watching a box that ran private work.
- The image carries three browser engines (about 1.4 GB of the 2.8 GB added). Keep all three?
