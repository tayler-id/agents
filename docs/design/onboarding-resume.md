# Onboarding work, where it stands

A note for whoever picks this up, kept current with each commit on the branch.
The design, with what is not done, is in [onboarding.md](onboarding.md).

- Branch `worktree-agent-a1cdcf7d718680aab`, worktree `.claude/worktrees/agent-a1cdcf7d718680aab`.
- Rebased onto main at 47a2d31 on 2026-10-13, after the people socket and the JSON gate landed. Nothing is merged into main.
- The worktree has its own `node_modules` from `npm ci`.

## Done

The branch's commits, oldest first, by subject. `git log --oneline main..HEAD` gives their ids, which change with each rebase.

- **Onboarding as first built.** Design doc; request helpers moved to `server/http.ts`; migration 0005, `shared/onboarding.ts` and team admins; invites and joining; the Team page and waiting screen; the Tailscale page; each person's box and its lifecycle; the Claude sign-in relay; the Your box page and welcome steps; adding a teammate to a room; the checks step12, step12b and step12c; docs.
- **After the first review.** The checks moved to main's people socket and declare JSON on every change; step12's people port moved from 7921, main's step6 port, to 7936.
- **The review's blocking items.** `GET /v1/me` only reads, and the app joins with `POST /v1/me/join`. step12 shows a `text/plain` post to `/v1/invites` is refused by main's JSON gate and makes no invite.
- **The review's other items, one commit each.** An added person takes their open invite's role. Cancelling closes the invite first, then asks Tailscale and reports a failure. Private rooms take no one from outside, admins included. The sign-in link must be `https://claude.com/cai/oauth/authorize`. Docker's reason is scrubbed and cut to 500 characters. A second code can't lose the first. The login header is parsed as a Tailscale login, and display names are cut to 200 characters. Every admin route is checked against a member and another team's admin. The box never reads a token cut partway through. A sign-in can be cancelled while checking. The box page and docs say who can use a box's token. Long names wrap on a phone.

The final pass, on the last code commit:

- `npm run typecheck`, `npm run lint` and `node test/names.ts` exit 0.
- step12 passed 76 of 76.
- step12b passed 117 of 117 in Chromium, WebKit and Firefox at desktop and phone width.
- step12c passed 51 of 51 in the three browsers, with real box containers.
- Every commit on the branch was exported with `git archive` and passed `tsc`, `tsc -p app`, eslint and the name guard on its own.

Migration 0005 is applied to `agents_test`. Never edit it. Its number may change at landing. The coordinator renumbers.

## Breaks

Every check was seen red under a deliberate break, with the file put back and its hash compared afterwards. The break lists and the runner live in the session's scratchpad, not the repo. The build log's Onboarding section has the counts and what they showed. Each line added for the review went red. A line for a fix went red against the code before the fix, then again with the fix taken out by a break. The admin-route lines went red with each route's gate taken out.

## Not done from the review's notes

- **The guessed expiry.** When the CLI doesn't say how long a token lasts, the box reports a year. Reporting "not known" needs `claude_logins.valid_until` to allow null for a signed-in row, which migration 0005's check forbids, so it needs a new migration and its number from the coordinator.
- **The box start loop.** A box that can't start runs `docker rm` and `docker run` on every runner tick. Spacing the tries out is easy, but no check can see how often Docker is called without a stand-in for Docker, so it is left as is.
- **Container limits on always-on boxes.** Memory and CPU limits for personal boxes are Tayler's call, since the agent computers branch gives boxes a desktop and browsers.

## How to work here

Read `AGENTS.md` first. In short:

- `export PATH="$HOME/.local/node/bin:$PATH"` first. The `node` in `/usr/local/bin` can't load native packages.
- Run a check by file: `node --env-file=.env --env-file=.env.test test/step12.ts`. Add `AGENTS_UI_ENGINES=chromium` to run one browser.
- Each check's API serves people on a socket in the check's own folder, and `servePeople` from `test/people.ts` forwards the check's people port to it. `.env.test` sets `AGENTS_PEOPLE_SOCKET` empty, so an API started without its own socket stops.
- These checks use ports 7920 to 7936, never 7701, so they need no lock. step12 uses 7920, 7922 to 7926 and 7936, step12b 7927 to 7930, step12c 7932 to 7935. Main's step6 uses 7921 and step6b 7931. Take `mkdir ~/.agents-app/checks/run.lock` before any check on 7701, and `rmdir` it after.
- step12b and step12c both build `app/dist`, so run them one after the other, and don't edit `app/` while either runs. To run breaks for different checks at once, run each in its own copy of the tree. A copy that runs step12c must sit under the home folder, since the colima VM mounts only that.
- Other agents write to the same session scratchpad. Keep scratch files in a folder of your own there.
- Team names start with `onboard-`. A failing check keeps its team and any join requests it made, and join requests show on every team's Wants to join list. Delete them, the `onboard-*` teams in `agents_test` and the `~/.agents-app/checks/onboard-12c-*` folders once done.
- step12c builds and runs `agents-box:onboard-check`. Never build or overwrite `agents-box:latest`.
- Never touch the real `agents` database, the launchd services or Tailscale settings. Don't send real invites.
- Protected files need Tayler's approval: `AGENTS.md`, `CLAUDE.md`, `.claude/`, `eslint.config.js`, `tsconfig*.json`, `test/names.ts`, `test/step0.ts`, `test/all.ts`, `pipelines/app-change.ts`, `ops/`. Never edit `.gitignore` or add check scripts to `package.json`.

## Facts found along the way

- `claude setup-token` (Claude Code 2.1.296) needs a TTY and draws a full-screen interface. It prints the sign-in link as an OSC 8 hyperlink to `https://claude.com/cai/oauth/authorize`, then "Paste code here if prompted >". The code is `<code>#<state>`. Success prints a token starting `sk-ant-oat01-`, valid one year. A bad code prints "OAuth error: ...". The box image already has `script` from util-linux 2.38.1, which the driver uses to give it a TTY.
- The sign-in exchanges the code at `platform.claude.com`.
- In Tailscale's API, an invite has no `inviteUrl` for an email on the tailnet's own domain. A device omits `lastSeen` while connected. `GET /tailnet/-/keys/{keyId}` works for API access tokens. Errors are `{ message }`. A user-owned token can't act on its own user. Resending an invite is limited to once a minute.
- From the colima VM, the Mac is 192.168.5.2. Containers on Docker's bridge reach only ports 7700 and 7701. Containers on the host network bypass that firewall, which is why step12c uses `--network host`.
- Docker repeats a bad flag's value in its error, which step12 uses to put a token-shaped string into a box's start error.
- Read Electric shapes with the Electric client, not one `offset=-1` fetch.
- WebKit flake in step12b, root cause unknown. In about 2 runs of 20, the Invite button stays disabled after `fill` and the field reads empty while focused. The check's `invite()` helper prints the field, the button and the focus when it happens.
- Inviting waits on the people socket's live steps in `docs/design/people-port.md`. Until then the live API still trusts the login header on a TCP port that tailnet devices can reach.

## Open questions for Tayler

- Add `AGENTS_TAILSCALE_API` and `AGENTS_TAILSCALE_KEY_FILE` to the real `.env`, then save a user-owned API access token from the Tailscale page. The README shows the line. Without both settings, invites are made in the app only.
- Migration 0005 makes the earliest person of each team with no admin an admin. On the real server that is Tayler.
- Personal boxes run all the time. Should they stop when idle, and should they have memory and CPU limits?
- Teammates can message agents on someone's box and add them to rooms, which spends that person's Claude usage, and the box's agents and their plugins' tools can read its token. Keep that, or let only the owner drive agents on their box?
- Admins can't reach private rooms they aren't in. Should they?
- Removing a person from the team is not built.
- Should a personal box use the team's Claude token until its owner signs in? Not built.
- The sign-in lasts a year and can't be refreshed. Should the app warn ahead of expiry?
- Tailscale's free plan user limit, reported as 6, needs confirming on its pricing page.
- Boxes pick up the daemon changes only after `server/boxes.ts build` and recreating them.
