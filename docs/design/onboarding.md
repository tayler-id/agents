# Onboarding

Tayler asked for "a very easy way to invite and add and have them spin up", and for the tailnet's admin console inside the app "so I don't have to leave it". This is the design for both. It was written before the code and corrected afterwards to match what was built. Its schema is also listed in `docs/data-model.md` under "Added while building" for Tayler's review.

## What it solves

Before this work a person got in only after someone ran `server/admin.ts add-person` on the server Mac, which still works. Anyone else who opened the app saw "<login> is not on a team". Nobody can be invited from the app, nobody has a box of their own, every box runs Claude on one team-wide token, and Tayler leaves the app to manage the tailnet.

After this change:

1. An admin types an email. The app makes the Tailscale invite and shows its link. When that person first opens the app from the tailnet, they are on the team.
2. Someone whose login matches no invite, such as a GitHub identity, sees a waiting screen. Admins see them under "Wants to join" and add them with one click.
3. Each person who joins gets their own box, which starts by itself. They watch it come up.
4. Each person signs in to their own Claude account from the app. Agents on their box run on that account, and the token stays in the box's home volume.
5. Admins manage the tailnet from a Tailscale page with its users, devices and invites, and see which tailnet users are on the team. Members never see it.
6. An admin, or anyone already in a room, can add a teammate to it.

Tayler already decided that invites go through Tailscale with an API key they provide, that each invited developer gets their own box, that each signs in with their own Claude login, and that every repo is shared by the whole team. Repos already belong to the team, so the last one needs nothing new.

Inviting and adding come first. They are the gap Tayler notices most.

## Not done, and what waits

- **Inviting waits on the people socket's live steps.** Nobody should be invited until the live steps in `docs/design/people-port.md` are done. Until the live API serves people only on its socket and the tailnet policy is in place, a tailnet device can send its own login header, and joining by invite trusts that header. The code for it is on main. The API serves people only on a Unix socket, and refuses a person's change that isn't sent as JSON, so a page on another site can't post one.
- **The real Tailscale API was never called.** Every check runs against `test/fake-tailscale.ts`, a stand-in built from Tailscale's published API spec.
- **No full Claude sign-in happened.** The checks use a stand-in `claude setup-token`. The real CLI was run only to see its link and its answer to a bad code.
- **Removing a person from the team is not built.**
- **Boxes on the real server need the new image.** The daemon's sign-in support reaches boxes only after `server/boxes.ts build` and recreating them.
- **Built but not covered by a check.** The expiry date an admin types when Tailscale reports none. The Team page saying nobody was emailed, when Tailscale is off or has no key.

## Admins

`people.role` is admin or member, but nothing ever set it, so everyone is a member. Migration 0005 makes the earliest person of each team that has no admin into one. On the real server that is Tayler. `admin.ts add-team` now adds its first login as an admin, and `admin.ts set-role <team> <login> <admin|member>` changes a role from the server Mac.

Admins invite people, add them from the wants-to-join list and use the Tailscale page. Members see the team and their own box.

## Inviting and joining

### Data

`invites` has one row per invite made in the app.

| Column | What it holds |
|---|---|
| team_id | The team the person joins |
| email | Lowercased. It must equal the Tailscale login they arrive with |
| role | admin or member, their role on the team |
| tailscale_invite_id | Tailscale's id for the invite, used to resend or cancel it. Empty when Tailscale was not connected |
| invited_by | The admin who made it |
| status | open, joined or cancelled |
| person_id | Who joined with it |
| created_at, closed_at | When it was made, and when it was used or cancelled |

A unique index allows one open invite per email. The invite link is never stored. Tailscale returns it when the invite is made, and an admin can fetch it from Tailscale again.

`join_requests` has one row per login that opened the app while on no team and with no invite.

| Column | What it holds |
|---|---|
| login | The Tailscale login, unique |
| name | The name tailscale serve passes in `Tailscale-User-Name` |
| status | waiting or added |
| person_id, added_by | Who they became, and the admin who added them |
| first_seen_at, last_seen_at | Their first and latest visit |

A join request has no team, since the login is on none yet. Admins of every team on the server see it. The server serves one organization, so those are the people who could add them.

### States

- An invite is `open` until its person joins, which makes it `joined`, or an admin cancels it, which makes it `cancelled`.
- A join request is `waiting` until an admin adds the login, which makes it `added`. A login that was added and is no longer on a team goes back to `waiting` on its next visit.

### Joining

The app's first request is `GET /v1/me`, which only reads. It answers that the login is a member, that it has an open invite, matched to its email ignoring case, or that it is waiting. A page on another site can make a browser load any URL, so a read must change nothing. For a login on no team the app then sends `POST /v1/me/join`, a JSON body like every other change.

- With an open invite, a single transaction adds the person to the invite's team with the invite's role and the name from `Tailscale-User-Name`, marks the invite joined and adds their box. The API then answers as it does for any member.
- With none, the API records a join request, or moves its `last_seen_at`, and answers `{ kind: 'waiting', login, name }`. The app shows the waiting screen and reads `/v1/me` again every five seconds. It opens once an admin adds them, and joins by itself if someone invites them meanwhile.

The login must look like a Tailscale login, with an @, or the API answers 400. A display name longer than 200 characters is cut to 200.

Adding a login from the wants-to-join list, or a tailnet user from the Tailscale page, runs the same join. If the login has an open invite on the team, the person gets the invite's role and the invite closes as joined.

Making an invite calls Tailscale, which is outside Postgres. As the coding standards ask, the API commits the invite row first, then asks Tailscale, then records Tailscale's id. If Tailscale refuses, the API removes the row and the admin sees Tailscale's reason. With no Tailscale key saved, the invite is made in the app only, and the admin is told nobody was emailed, so the person must already be on the tailnet.

## The Tailscale key

The key is a user-owned API access token, `tskey-api-...`, which Tailscale issues for 1 to 90 days. Invites work only with that kind of key, not with OAuth clients.

- An admin pastes it on the Tailscale page. The API checks it with Tailscale, reads its expiry from `GET /tailnet/-/keys/{keyId}`, and writes `{ key, tailnet, expires, savedAt, savedBy }` with mode 600 to the file `AGENTS_TAILSCALE_KEY_FILE` names. The key is never written to Postgres or a log.
- The browser only ever gets the key's last four characters, its expiry, and who saved it when.
- Tailscale's base URL is `AGENTS_TAILSCALE_API`, which is `https://api.tailscale.com/api/v2` for the real one. Checks point it at a stand-in Tailscale server, `test/fake-tailscale.ts`.
- The two settings have no defaults and go together. With neither, Tailscale is off. The Tailscale page says how to turn it on, and invites are made in the app only. With only one, the API refuses to start, and its error names both.
- If Tailscale does not report the expiry, the admin types the date Tailscale showed when the key was made.
- From 14 days before it expires, admins see a warning in the sidebar and on the Team and Tailscale pages, with how to make a new key. Once it has expired, every Tailscale action fails with that same explanation instead of calling Tailscale.

## The Tailscale page

It is for admins only, at `#/tailscale`. Each list is read from Tailscale when the page opens and again after each action. None of it is stored.

| Section | Shows | Actions |
|---|---|---|
| Key | Last four characters, expiry, who saved it | Replace, disconnect |
| Users | Name, login, Tailscale role, status, and whether the login is on this team | Approve, suspend, restore, remove, change role, add to the team |
| Devices | Name, owner, OS, last seen, whether it is authorized | Authorize, remove |
| Invites | Email, when it was last sent, its link | Resend, cancel |

Removing a user or a device asks first. Tailscale allows one resend a minute, and the page shows its refusal as it comes. A member who opens `#/tailscale` reads that only admins manage the tailnet, and the API answers them 403.

The free Personal plan limits how many users a tailnet can have. It is reported as 6 since a pricing change in 2026. Check Tailscale's pricing page before inviting more.

## Each person's own box

When a person joins, the join transaction adds their box. It is an instance of kind `box`, named after their login (`box-alice`), with `owner_id` and `claimed_by` set to them and the new column `personal` set to true. After the commit the API wakes the runner. Its existing `startClaimedBoxes` starts the container from `AGENTS_BOX_IMAGE` on the box's own home volume, as it does for any box a person holds. Someone who was on the team before this change makes theirs from the Your box page.

A personal box differs from the team's pool of boxes in four ways.

- Pipeline runs never claim it, and it does not count toward `AGENTS_MAX_BOXES`.
- It goes to sleep after `AGENTS_BOX_IDLE_MIN`, 30 minutes by default, with nothing to do, and wakes when a turn waits for it, a command is queued for it, its owner starts a Claude sign-in or a person holds its screen. Tayler decided on 2026-10-14 that people's boxes stop when idle, and step 1 of `docs/design/target-architecture.md` built it.
- Its owner cannot release it back to the pool.
- Only its owner can make an agent whose home it is, because its agents run on the owner's Claude account.

`instances.start_error` holds the last error from starting the box's container, such as a missing image, and starting it clears the error. It is the last two lines Docker wrote to stderr, scrubbed of secrets and cut to 500 characters, since Docker repeats values it was given. What the person sees follows from the instance row.

| Row | They see |
|---|---|
| `start_error` set | Your box could not start, and why |
| status `offline`, no error | Your box is starting |
| status `online` | Your box is ready |

## Each person's own Claude sign-in

### How `claude setup-token` works without a browser

I read `claude --help`, `claude setup-token --help` ("Set up a long-lived authentication token (requires Claude subscription)", Claude Code 2.1.296), and the sign-in code inside the installed CLI. Then I ran `claude setup-token` once in a throwaway box container and stopped it at the prompt. Nothing was typed into it, so no sign-in happened.

1. It needs a terminal. It draws a full-screen terminal interface, so the box runs it under `script`, which gives it a pseudo-terminal. `script` is part of util-linux 2.38.1, which the box image already has.
2. With no browser to open, it prints "Browser didn't open? Use the url below to sign in" and the sign-in URL as a terminal hyperlink (OSC 8). The URL is on `https://claude.com/cai/oauth/authorize`, with `scope=user:inference`, a PKCE challenge and `redirect_uri=https://platform.claude.com/oauth/code/callback`. Then it waits at "Paste code here if prompted >".
3. After the person signs in and approves, Claude's callback page shows a code shaped `<code>#<state>`. Typed at the prompt, the code goes to Anthropic with the PKCE secret that only this process holds, and comes back as a token that starts `sk-ant-oat`.
4. It prints "Long-lived authentication token created successfully!", "Your OAuth token (valid for 1 year):", the token, and "Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>". It saves nothing itself.
5. A code that fails shows "OAuth error:" and the reason.

`claude auth login` would keep a refreshable login in `~/.claude` instead. I use `setup-token` because the CLI itself sends machines without a browser to it ("run claude setup-token and set CLAUDE_CODE_OAUTH_TOKEN"), it asks only for inference, and boxes already read `CLAUDE_CODE_OAUTH_TOKEN`.

### The relay

The sign-in runs inside the person's box, so the PKCE secret and the token never leave it. The link travels out through the API to the person, and their code travels back the same way.

1. The person presses Sign in to Claude. The API adds a `claude_logins` row for their box with status `starting`.
2. The box's daemon follows its open sign-ins through a sync shape, the way it follows its commands. It starts `claude setup-token` under `script` and reads the URL from the hyperlink.
3. The daemon posts the URL. The row becomes `waiting_for_code`, and the app shows the link to that person only.
4. The person opens it, signs in, copies the code and pastes it into the app. The API checks the code has the `<code>#<state>` form, keeps it in memory, and marks the row `checking`. The code is never written to Postgres, a command, the record or a log.
5. The daemon sees `checking` and fetches the code. The API hands it over once and forgets it, and forgets it anyway after ten minutes. The daemon types it at the prompt.
6. The daemon reads the token from the CLI's output and writes it to `~/.agents-app/claude-token` in the box's home volume, mode 600. It reports only that it signed in and how long the token lasts. The row becomes `signed_in` with `valid_until`.
7. From then on the daemon starts every Claude session with `CLAUDE_CODE_OAUTH_TOKEN` read from that file. It also stops idle sessions, so their next message starts with the new token.

`claude_logins` holds `team_id`, `instance_id`, `person_id`, `status`, `url`, `note` (why it failed, or what to do next), `valid_until`, `created_at` and `updated_at`. Check constraints tie the columns to the status: no URL while `starting`, a URL from `waiting_for_code` on, and a note on every failure. A box has at most one open sign-in, and starting another cancels the open one.

| From | To | When |
|---|---|---|
| starting | waiting_for_code | The box posted the link |
| waiting_for_code | checking | The person sent their code |
| checking | signed_in | The CLI printed a token, and the box saved it |
| checking | waiting_for_code | The API restarted before the box took the code, so the person pastes it again |
| waiting_for_code | failed | The box waited 15 minutes from printing the link and nobody sent a code |
| any open state | failed | The CLI refused the code or exited, or the box restarted during the sign-in |
| any open state | cancelled | The person cancelled, or started again |

A sign-in whose box never runs stays starting until the person cancels it or starts again. Only the box's owner sees the row, through a shape filtered by `person_id`, and only they can act on it. Only that box's daemon can fetch its code. The API takes a link only on `https://claude.com/cai/oauth/authorize`, the page `claude setup-token` 2.1.296 prints, so a box can send its owner nowhere else. The URL is not a secret. It carries a PKCE challenge and a state value, and a code made from it works only with the secret held by that box's process.

### The team-wide token

Pool boxes, which pipeline runs use, get the token in `~/.agents-app/box-claude-token` as `CLAUDE_CODE_OAUTH_TOKEN`, as before. Personal boxes never get it, so a person's agents run only on their own account, and not at all before they sign in. Falling back to the team token until the owner signs in is not built. It would be a small change in `runContainer` if Tayler wants it.

### What the box image needs

Nothing new. `claude` and `script` are already in `box/Dockerfile`'s image.

## Adding a person to a room

`POST /v1/conversations/{id}/members` takes a teammate's login. An admin or a person already in the room may call it. The room's page has a People button that lists who is in the room and adds a teammate.

- Only rooms take members this way. A DM, an archived room or another team's room answers 404.
- Someone outside a team room who is not an admin gets 403. A private room answers everyone outside it 404, admins included, since it is hidden from them. Whether admins should reach private rooms is Tayler's call.
- A login that is not on the team answers 404. Someone already in the room answers 409.
- An admin who adds someone does not join the room themselves.
- Being in the room is what the room's agents see. Each agent's turn names the people in the room, and brings what the agent remembers about each of them.

## API routes

These are on the people port. Every route except `/v1/me` needs a person on a team, and admin routes answer 403 to members.

| Route | Who | Does |
|---|---|---|
| `GET /v1/me` | anyone | The person with their role and team, or that the login is invited or waiting. Writes nothing |
| `POST /v1/me/join` | anyone | Joins by invite, or records a request to join |
| `POST /v1/invites` | admin | `{ email, role }`. Makes the invite, through Tailscale when it is connected, and returns the link once |
| `POST /v1/invites/{id}/resend` | admin | Asks Tailscale to email it again, or makes the Tailscale invite if it was never made |
| `POST /v1/invites/{id}/cancel` | admin | Cancels it here, then asks Tailscale to delete its own. Answers 502 with the reason when Tailscale can't |
| `GET /v1/invites/{id}/link` | admin | The invite link, read from Tailscale |
| `POST /v1/team/people` | admin | `{ login, name }`. Adds a login to the team from the wants-to-join list or the Tailscale page |
| `POST /v1/me/box` | person | Makes their box if they have none |
| `POST /v1/me/claude-login` | person | Starts a Claude sign-in on their box |
| `POST /v1/claude-logins/{id}/code` | its owner | `{ code }`. Passes the code to their box |
| `POST /v1/claude-logins/{id}/cancel` | its owner | Cancels the sign-in |
| `GET /v1/tailscale` | admin | The key's status: last four characters, expiry, who saved it |
| `POST /v1/tailscale/key` | admin | `{ key, expires }`. Checks the key and saves it |
| `POST /v1/tailscale/key/delete` | admin | Removes the key file |
| `GET /v1/tailscale/users` | admin | Tailnet users, each with their team membership |
| `POST /v1/tailscale/users/{id}/{approve,suspend,restore,delete}` | admin | Passed on to Tailscale |
| `POST /v1/tailscale/users/{id}/role` | admin | `{ role }`, passed on to Tailscale |
| `GET /v1/tailscale/devices` | admin | Tailnet devices |
| `POST /v1/tailscale/devices/{id}/{authorize,delete}` | admin | Passed on to Tailscale |
| `GET /v1/tailscale/invites` | admin | Tailscale's open invites, with their links |
| `POST /v1/tailscale/invites/{id}/{resend,cancel}` | admin | Passed on to Tailscale |
| `POST /v1/conversations/{id}/members` | admin or room member | `{ login }`. Adds a teammate to a room |

These are on the machine port, called with a box's own token.

| Route | Does |
|---|---|
| `POST /v1/instance/claude-logins/{id}/link` | `{ url }`. The sign-in link is ready |
| `POST /v1/instance/claude-logins/{id}/code` | Returns the person's code, once |
| `POST /v1/instance/claude-logins/{id}/done` | `{ validDays }`. Signed in. The token stayed on the box |
| `POST /v1/instance/claude-logins/{id}/failed` | `{ reason }`. The sign-in failed |

New shapes are `invites` and `join_requests` for admins and `claude_logins` for its owner. A machine gets a `claude_logins` shape holding its own sign-ins in `starting`, `waiting_for_code` or `checking`. The `instances` shape gains `personal` and `start_error`.

The routes for people and the team, Tailscale and rooms live in `server/onboarding-routes.ts`. The routes for a person's box and their sign-ins, on both ports, live in `server/box-routes.ts`. `server/api.ts` adds both lists to its own.

## What each person sees

- **Tayler and other admins.** A Team link in the sidebar that says how many people want to join, and a Tailscale link. The Team page has the invite form, the wants-to-join list with Add, open invites with their links to copy, Resend and Cancel, and everyone on the team with their box. The Tailscale page is described above. A warning shows when the key is near its expiry.
- **Members.** The Team page's list of people, and their own box. No Tailscale link and no admin forms.
- **Someone who just joined.** The app opens on their team with a short checklist in place of the welcome text. It shows that they joined, their box starting and then ready, or that it could not start, then signing in to Claude and making a first agent. Its Set up your box button opens the Your box page, which has the sign-in and a link to make an agent on their box.
- **Anyone in a room.** A People button in the room's head lists who is in it. Someone in the room, or an admin, picks a teammate there and adds them.
- **Someone on no team yet.** A waiting screen that names the login they arrived with, says an admin can add them, and says the page opens by itself when that happens. If they were invited under another email, it tells them to sign in to Tailscale with that one.

## Checks

- `test/step12.ts` covers, through the API, inviting and joining, the wants-to-join list, what only admins may do, the Tailscale key and page against the stand-in, personal boxes and their start errors, the sign-in relay with the check acting as the box, and adding someone to a room.
- `test/step12b.ts` drives the Team page, the waiting screen, the Tailscale page, a box that could not start and a room's People list in Chromium, Firefox and WebKit at desktop and phone width, with screenshots and an accessibility scan. Its boxes use an image that does not exist, so no container starts.
- `test/step12c.ts` runs real box containers from `agents-box:onboard-check`, built from the branch, in all three browsers. A newcomer watches their box start, signs in to Claude through it with the stand-in `claude setup-token`, and an agent on the box answers on their token. The containers use the host network, since the box firewall lets bridge containers reach only 7700 and 7701.

## Open questions for Tayler

1. Answered on 2026-10-14. Personal boxes stop when idle and start again when a message arrives. Step 1 of the target architecture built it.
2. Anyone on the team can message an agent whose home is someone else's box, and add it to a room, which spends that person's Claude usage. The token sits in the box's home, where the box's agents and the tools their plugins run can read it. Keep that, or let only the owner drive agents on their box?
3. Removing someone from the team is not built. Removing them from the tailnet locks them out, but their row and their box stay.
4. Should personal boxes fall back to the team token until their owner signs in? That is not built.
5. A `setup-token` token lasts a year and cannot be refreshed. The app shows when it runs out. Should it also warn ahead of time, as it does for the Tailscale key?
