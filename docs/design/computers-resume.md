# Agent computers, where the work stands

A note for whoever picks this up, kept current with each commit. The design is `docs/design/computers.md`, and `docs/build-log.md` has what was checked and measured.

## Done, on this branch

Rebased onto main at 6e37987 on 2026-10-13. Commit ids change with each rebase, so find them by subject.

| Commit | What |
|---|---|
| Design: agent computers, the Screen view and images as documents | `docs/design/computers.md` |
| Schema for agent computers | Migration `server/migrations/0008_computers.sql`, with its `docs/data-model.md` entry |
| Box image | Xvnc, matchbox, xclip, tini, Playwright 1.64.0 with Chromium, Firefox and WebKit, and Playwright MCP 0.0.83 |
| Agents in boxes get a computer | The box's desktop, screen service and `computer` MCP server, the standing instructions and the `verify-work` skill |
| Type text outside ASCII by pasting it | 90 of 90 strings arrived whole, against 9 of 18 typed key by key |
| Watch and take over a box's screen through the API | Control connection, tunnels, the input filter, the handoff state machine, takeover rows and notices |
| Images in a task's folder become documents | `blobs`, the image route and the document panel |
| Keep screenshots in tool results out of the record | Size and SHA-256 in place of the bytes |
| Describe agent computers in our own words | No reference to the app we studied |
| Screenshots wait for the screen to settle | 200 ms without a paint, 3 s at most |
| The Screen view | The app's view, loaded only when opened |
| Checks for agent computers | `test/step15.ts` and `test/step15b.ts`, with `test/computers.ts` and `test/box-browsers.ts` |
| Checks wait on conditions, not fixed sleeps | Keys from someone not holding the screen are ordered behind a key that must show |
| Check what the Screen view says when its box stops | Close code 4502 to viewers, then 4404, and the app's message in three engines |
| Check that a box's screen and browser come back | After an idle stop, a kill and a recreate on a volume locked elsewhere |
| Reword comments where a colon joined two halves | Comments only |
| Drop a phone rule that the panel's rule already covers | CSS |
| Step 15b measures sideways scrolling against the page's own width | Chromium's innerWidth grows with overflow under phone emulation |

## Checks

- Step 15 has 32 checks and step 15b has 18 in each of Chromium, WebKit and Firefox.
- Both passed on the last commit, rebased onto 6e37987, at 18:09 on 2026-10-13. If the API ever aborts at start with no message, look at `ipcs -s -b`. This Mac ran out of System V semaphores once that day, and lmdb aborts without them.
- Every check was seen failing under `.scratch/breaks.ts`, a local file that git ignores. `node .scratch/breaks.ts check-all` checks every anchor, `node .scratch/breaks.ts <set>` applies one set, and `git checkout -- <files it lists>` restores. Step 15's sets are quiet, input, stuck, flow, team, noscreen and notunnel. Step 15b's are ui-a to ui-d, run with `AGENTS_UI_ENGINES=chromium`.
- `.scratch/clean-teams.ts` deletes the `comp-` teams and folders that failed runs keep. It refuses any database but `agents_test`.

## Running the checks

- Take the lock first with `mkdir ~/.agents-app/checks/run.lock`, and `rmdir` it after. Both checks use port 7701, the only check port the box firewall opens.
- `node --env-file=.env --env-file=.env.test test/step15.ts` took about 2 minutes on this Mac with the image cached. Building the image added 51 to 203 seconds.
- `node --env-file=.env --env-file=.env.test test/step15b.ts` took under a minute in three engines.
- Teams are `comp-*`. A failed run keeps its team in `agents_test` and its folder under `~/.agents-app/checks/`.

## Left running

- No containers or volumes. Every box a check makes is removed when it ends.
- The image `agents-box:computers`, 3.78 GB on disk. Remove it with `docker rmi agents-box:computers` once nobody needs it. `agents-box:latest` is the live server's and was never touched.

## Not done

- The Mac helper is a design only.
- No x86 image, nothing tried over the tailnet, and no real Claude session at the computer in a box.
- Three choices for Tayler, listed at the end of the design doc.
