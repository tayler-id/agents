# Onboarding work, where it stands

A note for whoever picks this up, kept current with each commit on the branch.
The design, with what is not done, is in [onboarding.md](onboarding.md).

- Branch `worktree-agent-a1cdcf7d718680aab`, worktree `.claude/worktrees/agent-a1cdcf7d718680aab`.
- Rebased onto main at deec329 on 2026-10-13. Nothing is merged into main.
- The worktree has its own `node_modules` from `npm ci`.

## Done

Commits since main, oldest first. Each passed `tsc`, `tsc -p app` and eslint on its own before the rebase, checked by exporting it with `git archive`.

| Commit | What it adds |
| --- | --- |
| 719c270 | The design doc and its data-model entry |
| cc92f5d | Request helpers moved from `server/api.ts` to `server/http.ts`, so new routes live in their own files |
| 5ebfc32 | Migration `0005_onboarding.sql`, `shared/onboarding.ts` (zod schemas, branded ids, state machines), `admin.ts add-team` making the first login an admin, and `admin.ts set-role` |
| 341f15a | Invites and joining: `server/tailscale.ts`, `server/onboarding.ts`, `server/onboarding-routes.ts`, a box for each person who joins, `test/step12.ts` |
| e192ba5 | step12's race and admin-gate checks made able to fail |
| efaf085 | Team page, waiting screen, sidebar Team link, `test/step12b.ts` |
| e9f650b | Removes the check scripts an earlier commit added to `package.json` |
| 5cb99a7 | Tailscale page: users, devices, invites, replacing or disconnecting the key, expiry warning |
| d13d640 | Box lifecycle: `start_error` from Docker's stderr only, personal boxes never get the team's Claude token, `POST /v1/me/box`, only the owner makes agents on their box |
| 4d8f619 | Claude sign-in relay: `server/claudelogin.ts`, `server/box-routes.ts`, `daemon/claude-login.ts`, agentsd follows sign-ins |
| 64f4f5e | Your box page and the welcome steps (`app/src/Box.tsx`), `test/step12c.ts` with real containers and the door that holds a box at starting |
| be049bd | This note |
| ccaa231 | step12c looks for the token in the box's stderr as well as its stdout |
| b6805e6 | step12b checks that a box that could not start says so, with Docker's reason |
| 37c42c0 | Adding a teammate to a room: `addRoomMember` in `server/rooms.ts`, its route, the room's People list in `app/src/Conversation.tsx`, checks in step12 and step12b |

After the rebase, on main's rules:

- `npm run typecheck`, `npm run lint` and `node test/names.ts` pass.
- step12 passed 61 of 61.
- step12b passed 111 of 111 in Chromium, WebKit and Firefox.
- step12c passed 51 of 51 in the three browsers.

Migration 0005 is applied to `agents_test`. Never edit it. Its number may change at landing. The coordinator renumbers.

## In progress

- Docs for this work, uncommitted when this was written: `docs/design/onboarding.md` corrected to what was built, with a "Not done, and what waits" section; `README.md` gains "Inviting teammates from the app"; `docs/what-each-part-does.md` gains an Onboarding section. Still to write: a `docs/build-log.md` section.
- Breaks for the new checks are not run yet.

## Next steps, in order

1. Breaks. Every check must be seen red under a deliberate break, then restored byte for byte and green.
   - step12 had 31 breaks, 29 red on the first run. The join lock and admin gate checks were fixed to go red. Rerun them against the final step12.
   - New ones for the room checks in step12: drop the 403 gate, drop the private 404, return without inserting, drop `c.kind = 'room'`, drop `c.archived_at is null`, drop the team filter on the room or on the teammate, and add the admin as well.
   - step12b: let anyone add, give `.add-line` an auto column, skip the "Added" line, drop `start_error` from `boxState`, drop the "Docker said" line.
   - step12c, with `AGENTS_UI_ENGINES=chromium` to save time: give personal boxes the team token, save the token 0644, stop passing `oauthToken`, never post the link, show no "is starting" text, log the token to stderr, skip `GettingStarted`.
2. Write the build-log section with the break results, and commit the docs.
3. Final pass, then the report to the coordinator.

## How to work here

Read `AGENTS.md` first. In short:

- `export PATH="$HOME/.local/node/bin:$PATH"` first. The `node` in `/usr/local/bin` can't load native packages.
- Run a check by file: `node --env-file=.env --env-file=.env.test test/step12.ts`. Add `AGENTS_UI_ENGINES=chromium` to run one browser.
- These checks use ports 7920 to 7935, never 7701, so they need no lock. step12 uses 7920 to 7926, step12b 7927 to 7930, step12c 7932 to 7935. Take `mkdir ~/.agents-app/checks/run.lock` before any check on 7701, and `rmdir` it after.
- step12b and step12c both build `app/dist`, so run them one after the other, and don't edit `app/` while either runs.
- Team names start with `onboard-`. A failing check keeps its team. Delete `onboard-*` teams from `agents_test` and `~/.agents-app/checks/onboard-12c-*` folders once done with them.
- step12c builds and runs `agents-box:onboard-check`. Never build or overwrite `agents-box:latest`.
- Never touch the real `agents` database, the launchd services or Tailscale settings. Don't send real invites.
- Protected files need Tayler's approval: `AGENTS.md`, `CLAUDE.md`, `.claude/`, `eslint.config.js`, `tsconfig*.json`, `test/names.ts`, `test/step0.ts`, `test/all.ts`, `pipelines/app-change.ts`, `ops/`. Never edit `.gitignore` or add check scripts to `package.json`.

## Facts found along the way

- `claude setup-token` (Claude Code 2.1.296) needs a TTY and draws a full-screen interface. It prints the sign-in link as an OSC 8 hyperlink, then "Paste code here if prompted >". The code is `<code>#<state>`. Success prints a token starting `sk-ant-oat01-`, valid one year. A bad code prints "OAuth error: ...". The box image already has `script` from util-linux 2.38.1, which the driver uses to give it a TTY.
- The sign-in exchanges the code at `platform.claude.com`, which any box egress allowlist must include.
- In Tailscale's API, an invite has no `inviteUrl` for an email on the tailnet's own domain. A device omits `lastSeen` while connected. `GET /tailnet/-/keys/{keyId}` works for API access tokens. Errors are `{ message }`. A user-owned token can't act on its own user. Resending an invite is limited to once a minute.
- From the colima VM, the Mac is 192.168.5.2. Containers on Docker's bridge reach only ports 7700 and 7701. Containers on the host network bypass that firewall, which is why step12c uses `--network host`.
- Read Electric shapes with the Electric client, not one `offset=-1` fetch.
- WebKit flake in step12b, root cause unknown. In about 2 runs of 20, the Invite button stays disabled after `fill` and the field reads empty while focused. The check's `invite()` helper prints the field, the button and the focus when it happens.
- The people port trusts the `Tailscale-User-Login` header, and a tailnet peer in Tailscale's userspace mode can reach it directly. A security workstream is fixing that. Invites wait on it.

## Open questions for Tayler

- Add `AGENTS_TAILSCALE_API` and `AGENTS_TAILSCALE_KEY_FILE` to the real `.env`, then save a user-owned API access token from the Tailscale page. The README shows the line. Without both settings, invites are made in the app only.
- Migration 0005 makes the earliest person of each team with no admin an admin. On the real server that is Tayler.
- Personal boxes run all the time. Should they stop when idle?
- Teammates can message agents on someone's box, which spends that person's Claude usage. Keep that?
- Removing a person from the team is not built.
- Should a personal box use the team's Claude token until its owner signs in? Not built.
- The sign-in lasts a year and can't be refreshed. Should the app warn ahead of expiry?
- Tailscale's free plan user limit, reported as 6, needs confirming on its pricing page.
- Boxes pick up the daemon changes only after `server/boxes.ts build` and recreating them.
