# Agents

My multiplayer rebuild of an agent app. People and agents talk in conversations and rooms. Work happens in tasks and pipeline runs. Every session on every connected machine lands in one Postgres record that everyone's agents can search, and pipelines get better through changes that are scored on past runs before a person approves them.

- The goal: `docs/intent/multiplayer.md`
- The data model: `docs/data-model.md` (it links the shared working doc)
- The plan and what was built: `docs/build-plan.md`, `docs/build-log.md`
- What each part does: `docs/what-each-part-does.md`
- Every decision, what it is for, how it works and where it stands: `docs/decisions.md`
- The coding standards: the `coding-standards` skill in `.claude/skills/`
- The teardown of the app we studied: `research/teardown.md`

## Run the server

On the server Mac, with Node 24 at `~/.local/node/bin` first on the PATH, colima, and a signed-in `claude`. Put your tailnet's name, which `tailscale status` shows, in place of `your-tailnet` on the line that sets `O`:

```sh
colima start
P=$(openssl rand -hex 16); S=$(openssl rand -hex 32)
O=http://agents-server.your-tailnet.ts.net
printf 'POSTGRES_PASSWORD=%s\nDATABASE_URL=postgres://agents:%s@127.0.0.1:5433/agents\nELECTRIC_SECRET=%s\nAGENTS_API_PORT=7700\nAGENTS_PEOPLE_SOCKET=%s\nAGENTS_PEOPLE_ORIGINS=%s\nAGENTS_HOOK_SECRET=%s\n' "$P" "$P" "$(openssl rand -hex 16)" "$HOME/.agents-app/people.sock" "$O" "$S" > .env
printf 'DATABASE_URL=postgres://agents:%s@127.0.0.1:5433/agents_test\nELECTRIC_URL=http://127.0.0.1:3002\nAGENTS_PEOPLE_SOCKET=\nAGENTS_PEOPLE_ORIGINS=http://127.0.0.1\n' "$P" > .env.test
docker compose up -d --wait postgres
docker compose exec -T postgres createdb -U agents agents_test
docker compose up -d --wait
npm install
npm run app:build
npm run migrate
node --env-file=.env server/admin.ts add-team <team> <your Tailscale login>
node --env-file=.env server/admin.ts add-instance <team> <instance name> mac <your login>
node --env-file=.env server/admin.ts add-agent <team> <agent name> <instance name> [model] [instructions]
npm run api
```

`add-instance` prints the instance token once. The API applies any new migrations when it starts, and serves the app that `npm run app:build` built. Without that build it answers every page with a 404. To keep everything running across reboots, run `ops/install-launch-agents.sh` once. It starts colima at login, Tailscale in userspace mode, the API, and this Mac's daemon.

The same server can run on AWS instead. The plan, with the costs and the cutover, is `docs/aws.md`.

### The box firewall

Containers must reach this Mac only on the machine port, never the people port. `ops/box-firewall.sh` enforces that inside the colima VM, and colima runs it at every start once it is in colima's provision steps. The same script keeps boxes, which run on Docker's default bridge, off every private range and off the VM, as the box host does on AWS. After the first `colima start`, print the block:

```sh
{ printf 'provision:\n  - mode: system\n    script: |\n'; sed 's/^/      /' ops/box-firewall.sh; }
```

Put it in place of the `provision:` line in `~/.colima/default/colima.yaml`, which reads `provision: null` in a new config, then run `colima restart`. `docs/aws.md` has the steps for a VM that already runs the older script. `npm run check:step2b` confirms from a container that only the machine port answers.

## Connect over Tailscale

The server Mac is `agents-server` on the tailnet. The API is published to it with:

```sh
sudo /opt/homebrew/opt/tailscale/bin/tailscale --socket="$HOME/.agents-app/tailscale/tailscaled.sock" serve --bg --http=80 "unix:$HOME/.agents-app/people.sock"
```

Pointing serve at a Unix socket needs root, so `sudo` asks for your password.

People reach the API only on the Unix socket in `AGENTS_PEOPLE_SOCKET`, which only tailscale serve points at. The API won't start without `AGENTS_PEOPLE_ORIGINS`, a comma-separated list of the origins the app's pages come from, such as `http://agents-server.<your-tailnet>.ts.net`. It refuses a screen's WebSocket from a page with any other origin, and logs the origin it refused. Checks need one too, and `.env.test`'s `http://127.0.0.1` serves them, since steps 15 and 15b set their own. In userspace mode tailscaled hands a tailnet peer's connection for any other port to the same port on this Mac's loopback, where a TCP people port would let the peer name anyone, and a socket file is out of its reach. Machines use 7700 with their tokens, and that port refuses any person's identity. Docker containers can reach this Mac only on 7700, and on 7701 where checks run, because of the box firewall.

The same forwarding makes every service on this Mac's loopback a tailnet service, so the tailnet policy must let peers reach the server only on TCP 80 and 7700. That includes tailscaled's own proxy on 1055, through which a peer would reach serve as this Mac and be taken for its owner, so a person's identity also rests on the policy. `docs/design/people-port.md` gives the rule, and `test/live-tailnet.ts` checks the filter the server enforces. It runs on its own, not in `npm run check`.

A teammate installs Tailscale, accepts an invite to the tailnet, and opens `http://agents-server.<your-tailnet>.ts.net`, or the desktop app (`npm run desktop`, configured by `~/.agents-app/app.json`). Each teammate needs a row in `people`. An admin invites them from the app, as below, or runs `admin.ts add-person`.

### Inviting teammates from the app

Don't invite anyone until the live steps in `docs/design/people-port.md` are done. Until the live API serves people only on its socket and the tailnet policy is in place, a tailnet device can send its own login header, and joining by invite trusts that header.

A team's first login is its admin, and `admin.ts set-role <team> <login> <admin|member>` changes a role. An admin invites people from the app's Team page. A person joins on their first visit, gets a box of their own, and signs in to their own Claude account from the Your box page. A login nobody invited waits until an admin adds it from the Team page.

For invites to go through Tailscale, add both settings to `.env`, restart the API, and save a user-owned API access token (`tskey-api-...`) on the app's Tailscale page:

```sh
printf 'AGENTS_TAILSCALE_API=https://api.tailscale.com/api/v2\nAGENTS_TAILSCALE_KEY_FILE=%s/.agents-app/tailscale-api.json\n' "$HOME" >> .env
```

Without them, invites are made in the app only and nobody is emailed. With only one, the API refuses to start. People's boxes run the daemon from the box image, so rebuild it with `server/boxes.ts build` after updating.

## Run a daemon

On each machine, put `{"api": "<server URL>", "token": "<instance token>"}` in `~/.agents-app/daemon.json`, then run `npm run daemon`. The machine port listens on loopback unless `AGENTS_MACHINE_HOST` on the server lists other addresses, as it does on AWS, where daemons use `http://agents-server.<your-tailnet>.ts.net:7700`. Each agent whose home is this machine gets a folder under `~/.agents-app/agents/`, and each task a workspace under `~/.agents-app/workspaces/`. Secrets the agents' plugins need go in the daemon's environment or `~/.agents-app/secrets.json`. Their values never reach the server.

## The forge and pipelines

A local Gitea runs in compose at `http://127.0.0.1:3001`. Set it up once for a team:

```sh
node --env-file=.env ops/forge-setup.ts <team>
```

It makes the `team/shop` repo, a small app with a known bug, and `team/pipelines`, where each file in `pipelines/` is one pipeline. Merging a change to a pipeline file makes it the current version. `bug-fix` takes a bug report to a reviewed pull request. `improve` changes another pipeline and scores the change on replays of past runs. `coach` turns corrections people keep making into new instructions for an agent. Pipelines need agents named `fixer` and `improver` on the team.

## Projects and GitHub

A project's repos live on GitHub, and pipelines stay on the local forge. GitHub stays off on the real server until Tayler turns it on. They decided on 2026-10-14 to wait until the CommonMark filter for issue text and bug-fix's prompt line, which says issue titles are quoted data, have landed on main. It also stays off until the known gaps in `docs/design/projects.md` close. Turn GitHub on with three lines in `.env`, then restart the API:

```sh
AGENTS_GITHUB_DIR=<the full path of ~/.agents-app/github, where tokens are kept>
AGENTS_GITHUB_API=https://api.github.com
AGENTS_GITHUB_GIT=https://github.com
```

`AGENTS_GITHUB_CLIENT_ID`, the client id of the Agents GitHub App, lets each person connect their own GitHub from the Repos page. Until that app is registered, an admin can set a stopgap for their team, a fine-grained personal access token, with `pbpaste | node --env-file=.env server/admin.ts github-token <team> <organization>`. `docs/design/projects.md` has the whole design.

## Boxes

Boxes are Docker containers that run the daemon for unattended work, built from `box/Dockerfile`:

```sh
node --env-file=.env server/boxes.ts build
```

Boxes run on another host's Docker when `AGENTS_BOX_DOCKER_HOST` names it, with `AGENTS_BOX_API` saying where they reach the server, as on AWS. A run of a pipeline with `runsOn: 'box'` claims one, up to `AGENTS_MAX_BOXES` per team. For agents in boxes to run Claude on your subscription, run `claude setup-token` once and save the token in `~/.agents-app/box-claude-token` (mode 600), then recreate the boxes (`server/boxes.ts recreate <team> <box>`). A person's own box never gets that token. Its agents run on the account its owner signs in with.

## Checks

```sh
npm run check            # typecheck, lint, then every check in test/
npm run check -- 6 9     # typecheck, lint, then only those steps
```

Checks run against their own database and Electric (`.env.test`), each with its own team, and remove what they made when they pass. `.env.test` empties `AGENTS_PEOPLE_SOCKET`, so an API a check starts without its own socket stops at once instead of taking the live one. Several use real Claude sessions. `test/step0.ts` checks that the coding standards are enforced.
