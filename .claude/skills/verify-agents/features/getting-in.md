# Getting in

A teammate opens the app over Tailscale and is already signed in: the server knows them by the login Tailscale passes. A login that is on no team sees why it cannot open the app. Machines use a door of their own that refuses any person's identity. The desktop app opens the same team.

## Sub-features

- `in-identity`: the people door knows a person by the login Tailscale sets, and the app opens on their team.
- `in-blocked`: a login on no team sees "Can't open the app" and the reason.
- `in-teammate`: a teammate an admin adds with `server/admin.ts add-person` can open the app.
- `in-machine-door`: the machine door refuses a request that carries a person's login.
- `in-desktop`: the desktop app opens the team's server and knows the person.

## How to get to it (user POV)

- Open the server's tailnet address in a browser, such as http://agents-server.tailcce7c3.ts.net.
- Open the desktop app with `npm run desktop`, which reads the server's address from `~/.agents-app/app.json`.
- An admin adds a teammate on the server with `node --env-file=.env server/admin.ts add-person <team> <login>`.

## Driving it with agentsctl

Preconditions:

- An instance from `bin/agentsctl up`, passing `bin/agentsctl doctor`.

- **Open the app as yourself.** Open the home page as ada. Run `bin/agentsctl browser goto /` and `bin/agentsctl browser text --role navigation --name Workspace --expect "$(bin/agentsctl db "select name from teams where id = {team}" --value)"`. The sidebar names the team, and the main area asks you to pick an agent. Capture it with `bin/agentsctl visual shot home --ready-role heading --ready-name "Pick an agent to talk to"`.
- **Check the first view.** Run `bin/agentsctl browser a11y`, `bin/agentsctl browser console`, `bin/agentsctl browser goto / --viewport phone` and `bin/agentsctl browser overflow --viewport phone`. No accessibility violation, no console error, and no sideways scrolling at phone width.
- **A login on no team is turned away.** Open the app as someone the server has never seen. Run `bin/agentsctl browser goto / --as stranger`, `bin/agentsctl browser wait --role heading --name "Can't open the app" --as stranger` and `bin/agentsctl browser text --role main --as stranger --expect "is not on a team"`. The page says the login is not on a team and to ask a teammate. Capture it with `bin/agentsctl visual shot getting-in-blocked --as stranger --ready-role heading --ready-name "Can't open the app"`.
- **A teammate the admin adds gets in.** Add cy the way an admin does, then open the app as cy. Run `bin/agentsctl seed person cy`, `bin/agentsctl browser goto / --as cy` and `bin/agentsctl browser text --role navigation --name Workspace --as cy --expect "cy-"`. The sidebar shows cy's login under the team. Then `bin/agentsctl db "select count(*)::int as n from people where team_id = {team} and login like 'cy-%'" --expect n=1`.
- **The machine door refuses a person.** Send a person's login to the machine port. Run `bin/agentsctl api GET /v1/me --as person --door machines --expect 400 --expect-text "people connect through Tailscale"`. The API answers 400 and says people come through Tailscale.
- **The desktop app knows you.** Open the Electron app against the instance. Run `bin/agentsctl desktop goto /` and `bin/agentsctl desktop text --role navigation --name Workspace --expect "$(bin/agentsctl db "select name from teams where id = {team}" --value)"`, then `bin/agentsctl desktop screenshot --label desktop-home`. The desktop window shows the same team and agents.

## Gotchas

- Identity is the `tailscale-user-login` header that agentsctl's browser sends. A page opened outside agentsctl has no identity and shows "Can't open the app".
- On the live server, tailscale serve replaces that header with the caller's real login. An instance trusts the header because nothing sits in front of it, which is why it never listens beyond 127.0.0.1.
- The blocked page logs a 403 for /v1/me to the console. That error is the page working, so the console check runs on the signed-in view only.
- Logins are unique across every team, so seeded logins carry the instance's name: `ada-<instance>@verify.local`.
- Chromium and Firefox reach the instance as http://agents.test:<port>, a plain-HTTP name like the tailnet's, so an API that needs a secure page fails here as it would for a teammate. WebKit uses 127.0.0.1, which browsers treat as secure.
- The desktop app under test has its own home folder and profile, so it never reads `~/.agents-app/app.json` or touches the profile of a desktop app Tayler has open.
