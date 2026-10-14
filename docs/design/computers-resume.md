# Agent computers, where the work stands

A note for whoever picks this up, kept current with each commit. The design is `docs/design/computers.md`, and `docs/build-log.md` has what was checked and measured.

## Done, on this branch

Rebased onto main at 7197f4b on 2026-10-14, after onboarding and the work layer landed. Commit ids change with each rebase, so find them by subject.

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
| Resume note for agent computers | This file |
| Checks wait on conditions, not fixed sleeps | Keys from someone not holding the screen are ordered behind a key that must show |
| Check what the Screen view says when its box stops | Close code 4502 to viewers, then 4404, and the app's message in three engines |
| Check that a box's screen and browser come back | After an idle stop, a kill and a recreate on a volume locked elsewhere |
| Reword comments where a colon joined two halves | Comments only |
| Drop a phone rule that the panel's rule already covers | CSS |
| Step 15b measures sideways scrolling against the page's own width | Chromium's innerWidth grows with overflow under phone emulation |
| Docs say what agent computers prove, measure and leave undone | The design, the build log and the decisions entry |
| Checks for the review's findings, through the people socket | The review round's lines in step 15, and both checks on `test/people.ts` |
| A connection reset during a screen upgrade no longer stops the API | An error listener on the socket until ws takes it |
| Screen views open only from the app's origins | `AGENTS_PEOPLE_ORIGINS`, required at startup |
| Private work that starts on a box cuts off viewers who can't see it | The watch rule again every 5 s and on each session status, and hand-back without it |
| The desktop's programs see none of the daemon's tokens | `PATH`, `HOME` and `DISPLAY` only |
| Viewers and tunnels that stop answering pings are dropped | A ping every 15 s, dropped after 45 s without an answer |
| A box takes no work until its desktop is up, a regression for Tayler to decide | The daemon waits, and exits with 1 when the desktop can't come up. Tayler accepted it on 2026-10-14 |
| A takeover stops the agent's browser call under way | The `computer` server asks every 250 ms and aborts the call |
| Boxes run within memory, CPU and process limits, a regression for Tayler to decide | 4 GB with no swap, 2 CPUs and 4,096 processes. Tayler accepted them on 2026-10-14 |
| Remove dead types, name every close code, and stop the sweep with the API | Cleanup the review asked for |
| Declare a machine's id once, where main does | InstanceId from `shared/onboarding.ts`, and three ids added to main's `shared/ids.ts` |
| Say people socket, not people port | Comments and labels |
| Check boxes mount the sign-in stand-in | Main's stand-in for Claude imports `test/fake-claude-login.ts` |
| Without AGENTS_PEOPLE_ORIGINS the API stops naming it | Zod ran a refinement after `z.url()` failed, which threw |
| Boxes on a shared network each keep their own display | Xvnc listens only on its socket file, so step 12c's boxes on the VM's network don't fight over display :1 |
| Step 15 and 15b build their box image under a tag of their own | And remove it when they end, as `AGENTS.md` asks |
| Step 15b waits for the saved screenshot to load | It read the image's width before WebKit had it, in one run |
| Docs for the review round, the rebases, and two trades for Tayler | The design, the build log, decisions, data model, parts and this note |
| Say what Tayler decided for agent computers on 2026-10-14 | The design, decisions, onboarding's resume note and this note |

## Before this lands

- Every API now needs `AGENTS_PEOPLE_ORIGINS` to start, a comma-separated list of the origins the app's pages come from. The live API needs `http://agents-server.<tailnet>.ts.net` in main's `.env` before it restarts on this code. Main's checks start their APIs with what `.env` and `.env.test` hold, and none of them opens a screen, so any one origin in `.env.test` lets them run, such as `AGENTS_PEOPLE_ORIGINS=http://127.0.0.1`. Steps 15 and 15b set their own.
- Two commits trade something away, and Tayler accepted both on 2026-10-14. The box limits slow a box that needs more than 2 CPUs and hold every box to 4 GB. A box whose desktop can't come up now restarts and takes no work, where before it worked without a computer. Tayler also approved the packages this branch adds, `ws`, `@types/ws` and `@novnc/novnc`.

## Checks

- Step 15 has 45 checks and step 15b has 17 in each of Chromium, WebKit and Firefox, 51 in all. Both passed on the final code, at 01:32 and 01:33 on 2026-10-14.
- Every check was seen failing under `.scratch/breaks.ts`, a local file that git ignores. `node .scratch/breaks.ts check-all` checks every anchor, `node .scratch/breaks.ts <set>` applies one set, and `git checkout -- <files it lists>` restores. Step 15's sets are quiet, input, stuck, flow, team, noscreen, notunnel, filter and told. Step 15b's are ui-a to ui-d, run with `AGENTS_UI_ENGINES=chromium`. Before the review round's fixes, step 15's new lines failed on the old code in one run.
- `.scratch/each-commit.ts <from> <to>` typechecks and lints every commit on its own. `.scratch/clean-teams.ts` deletes the `comp-` teams and folders that failed runs keep, and refuses any database but `agents_test`.
- If the API ever aborts at start with no message, look at `ipcs -s -b`. This Mac ran out of System V semaphores once, and lmdb aborts without them.

## Running the checks

- Take the lock first with `mkdir ~/.agents-app/checks/run.lock`, and `rmdir` it after. Both checks use port 7701, the only check port the box firewall opens.
- Before a run that builds an image, check `colima ssh -- df -h /var/lib/docker`, and stop above 80%. After it, run `docker image prune -f`. On 2026-10-13 untagged copies of an earlier fixed tag, `agents-box:computers`, helped fill the disk. Each run of step 15 or 15b now builds `agents-box:comp-<id>` and removes it when it ends, so every run builds the image from the start.
- `node --env-file=.env --env-file=.env.test test/step15.ts` took about 4 minutes with the image cached, and building the image added about 3 minutes.
- `node --env-file=.env --env-file=.env.test test/step15b.ts` took under a minute in three engines.
- Teams are `comp-*`. A failed run keeps its team in `agents_test` and its folder under `~/.agents-app/checks/`.
- Main's step 12c builds `agents-box:onboard-check`, a tag other runs use. To run it from this branch, put another tag in its `IMAGE` line for that run only, then remove the tag and put the file back from git. After a failure it can wait for good on a browser's open connection, so stop it, then remove its boxes, their volumes and its team.

## Left running

- No containers or volumes. Every box a check makes is removed when it ends.
- No image. Each run removes its own tag, and `agents-box:computers`, which earlier runs kept, is removed. `agents-box:latest` is the live server's and was never touched.

## Not done

- The Mac helper is a design only.
- No x86 image, nothing tried over the tailnet, and no real Claude session at the computer in a box.
- The screenshot refusal Tayler chose on 2026-10-14. Every other call is made, as "Tayler's calls" in the design lists.
