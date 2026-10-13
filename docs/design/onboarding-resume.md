# Onboarding work, where it stands

A note for whoever picks this up, kept current with each commit on the branch.
The design is in [onboarding.md](onboarding.md).

- Branch `worktree-agent-a1cdcf7d718680aab`, worktree `.claude/worktrees/agent-a1cdcf7d718680aab`.
- Last updated 2026-10-13, after commit b1ae8d9.
- Nothing here is merged into main. Main was merged into the branch twice, last at 7c6ed02.

## Done

Each commit passed `tsc`, `tsc -p app` and eslint on its own, checked by exporting it with `git archive`.

| Commit | What it adds |
| --- | --- |
| 62e516d | The design doc and its data-model entry |
| 34eb9ce | Request helpers moved from `server/api.ts` to `server/http.ts`, so new routes live in their own files |
| db7ac8c | Migration `0005_onboarding.sql`, `shared/onboarding.ts` (zod schemas, branded ids, state machines), `admin.ts add-team` making the first login an admin, and `admin.ts set-role` |
| d27dd2d | Invites and joining: `server/tailscale.ts`, `server/onboarding.ts`, `server/onboarding-routes.ts`, a box for each person who joins, `test/step12.ts` |
| 3270538 | step12's race and admin-gate checks made able to fail |
| bc667b2 | Team page, waiting screen, sidebar Team link, `test/step12b.ts` |
| 2cde630 | Tailscale page: users, devices, invites, replacing or disconnecting the key, expiry warning |
| e5e908e | Box lifecycle: `start_error` from Docker's stderr only, personal boxes never get the team's Claude token, `POST /v1/me/box`, only the owner makes agents on their box |
| a7684e5 | Claude sign-in relay: `server/claudelogin.ts`, `server/box-routes.ts`, `daemon/claude-login.ts`, agentsd follows sign-ins |
| b1ae8d9 | Your box page and the welcome steps (`app/src/Box.tsx`), `test/step12c.ts` with real containers |

Migration 0005 is applied to `agents_test`. Never edit it. A schema change needs a new migration number agreed with the coordinator.

## In progress

- `test/step12c.ts` passed 51 of 51 in Chromium, WebKit and Firefox after commit b1ae8d9. Before the door, WebKit and Firefox failed "sees their box starting" because their boxes came online before the page loaded. Now the check relays the boxes' connections to the API through port 7935 and refuses them until the newcomer has seen "is starting".
- step12c read only the box's stdout when it looked for the token in the box's log. The daemon writes errors to stderr. Being fixed now, to read both.
- Screenshots from step12c still need a look: `test/ui-shots/{chromium,webkit,firefox}-{getting-started-light,getting-started-phone,box-signin-light,box-dark,box-phone}.png`.

## Next steps, in order

1. Commit the step12c log fix, and review step12c's screenshots.
2. Add a person to an existing room. Nothing is written yet. The plan:
   - `addRoomMember(client, person, roomId, login)` in `server/rooms.ts`. The room must be a team room of kind `room`, not archived. The caller must be an admin or already a member. The login must be on the same team. A second add of the same person answers 409, from the unique index `conversation_members_person` via `isUniqueViolation`.
   - Route `POST /v1/conversations/{id}/members` with body `{ login }`, in `server/onboarding-routes.ts` or a new routes file, not `server/api.ts`, which other branches edit.
   - Membership puts the person in the agents' turn prompt ("You are X in the room #name, with ...") and in `agentKit`'s people, so their memory reaches the room's agents.
   - UI in the room head (`app/src/Conversation.tsx`): who is in the room, and a way to add a teammate who is not.
   - API checks in step12, a UI check in step12b at desktop and phone width in all three browsers.
3. step12b: also check that a newcomer whose box could not start reads that in the welcome steps and sees Docker's reason on the Your box page. step12b uses an image that does not exist, so its boxes always fail.
4. Breaks. Every check must be seen red under a deliberate break, then restored byte for byte and green. step12 had 31 breaks, 29 red on the first run; the join lock and admin gate checks were fixed to go red. Rerun those against the final step12, then write and run breaks for step12b and step12c. Ideas: drop `requireAdmin` on invites, drop `.fitted` on the long select, skip `GettingStarted`, give a personal box the team token, save the token 0644, stop the daemon passing `oauthToken`, keep the code after `codeForBox`, stop posting the login link.
5. Docs. `docs/what-each-part-does.md` entries in its "Solves now / Helps later" format for inviting and joining, the Tailscale key and page, a box per person, the sign-in relay, admins, and adding to a room. A `docs/build-log.md` section on what was built and how it was checked. In `onboarding.md`, say "a full-screen terminal interface" where it names the library, say the two Tailscale settings must be set as a pair with no defaults, drop the `AGENTS_PERSONAL_BOX_TEAM_TOKEN` switch (not built), and describe the box-routes split and the `claude_logins` shape. README: the two `.env` lines and inviting from the Team page.
6. Final pass: typecheck, lint, the names guard, step12, step12b, step12c. Then the report to the coordinator.

## How to work here

- `export PATH=/Users/taylerramsay/.local/node/bin:$PATH` first.
- Run a check by file: `node --env-file=.env --env-file=.env.test test/step12.ts`. Add `AGENTS_UI_ENGINES=chromium` to run one browser.
- Never run `npm run check`. Before running any check that is not step12, step12b or step12c, take the lock with `mkdir ~/.agents-app/checks/run.lock`, and `rmdir` it after.
- The names guard crashes on the `node_modules` symlink. Move the link aside, run `node test/names.ts`, move it back.
- Never `npm install` here. `node_modules` is a symlink to the main checkout's.
- Ports 7920 to 7939 only. step12 uses 7920 to 7926, step12b 7927 to 7930, step12c 7932 to 7935. Team names start with `onboard-`.
- step12c builds and runs `agents-box:onboard-check`. Never build or overwrite `agents-box:latest`.
- Checks use the `agents_test` database. Never the real `agents` database, launchd services, or Tailscale settings.
- A failing check keeps its team for a look. Delete `onboard-*` teams from `agents_test` and `~/.agents-app/checks/onboard-12c-*` folders once done with them.
- Protected files, never edited: `eslint.config.js`, `tsconfig*.json`, `test/names.ts`, `test/step0.ts`, `test/all.ts`, `CLAUDE.md`, `.claude/`, `.gitignore`. No new `check:*` scripts in `package.json`.

## Facts found along the way

- `claude setup-token` (Claude Code 2.1.296) needs a TTY and draws a full-screen interface. It prints the sign-in link as an OSC 8 hyperlink, then "Paste code here if prompted >". The code is `<code>#<state>`. Success prints a token starting `sk-ant-oat01-`, valid one year. A bad code prints "OAuth error: ...". The box image already has `script` from util-linux 2.38.1, which the driver uses to give it a TTY, so the image needed no change.
- The sign-in exchanges the code at `platform.claude.com`, which any box egress allowlist must include.
- In Tailscale's API, an invite has no `inviteUrl` for an email on the tailnet's own domain. A device omits `lastSeen` while connected. `GET /tailnet/-/keys/{keyId}` works for API access tokens. Errors are `{ message }`. A user-owned token cannot act on its own user. Resending an invite is limited to once a minute.
- From the colima VM, the Mac is 192.168.5.2. Containers on Docker's bridge reach only ports 7700 and 7701. Containers on the host network bypass that firewall, which is why step12c uses `--network host`.
- Read Electric shapes with the Electric client, not one `offset=-1` fetch.
- WebKit flake in step12b, root cause unknown. In about 2 runs of 20, the Invite button stays disabled after `fill` and the field reads empty while focused. The check's `invite()` helper prints the field, the button and the focus when it happens.

## Open questions for Tayler

- Add `AGENTS_TAILSCALE_API=https://api.tailscale.com/api/v2` and `AGENTS_TAILSCALE_KEY_FILE` (an absolute path) to the real `.env`, then save a user-owned API access token from the Tailscale page. Without both settings, invites are made in the app only.
- Migration 0005 makes the earliest person of each team with no admin an admin. On the real server that is Tayler.
- Personal boxes run all the time.
- Teammates can message agents on someone's box, which spends that person's Claude usage.
- Removing a person from the team is not built.
- Should a personal box fall back to the team's Claude token before its owner signs in? Not built.
- The sign-in lasts a year and cannot be refreshed. Should the app warn ahead of expiry?
- Tailscale's free plan user limit, reported as 6, needs confirming on its pricing page.
- Boxes pick up the daemon changes only after `server/boxes.ts build` and recreating them.
