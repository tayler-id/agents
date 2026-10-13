# Agents

My multiplayer rebuild of an agent app. People and agents talk in conversations and rooms. Work happens in tasks and pipeline runs. Every session on every connected machine lands in one Postgres record that everyone's agents can search, and pipelines get better through changes that are scored on past runs before a person approves them.

- The goal: `docs/intent/multiplayer.md`
- The data model: `docs/data-model.md` (it links the shared working doc)
- The plan and what was built: `docs/build-plan.md`, `docs/build-log.md`
- What each part does: `docs/what-each-part-does.md`
- The coding standards: the `coding-standards` skill in `.claude/skills/`
- The teardown of the app we studied: `research/teardown.md`

## Run the server

On the server Mac, with Node 24 at `~/.local/node/bin` first on the PATH, colima, and a signed-in `claude`:

```sh
colima start
P=$(openssl rand -hex 16); S=$(openssl rand -hex 32)
printf 'POSTGRES_PASSWORD=%s\nDATABASE_URL=postgres://agents:%s@127.0.0.1:5433/agents\nELECTRIC_SECRET=%s\nAGENTS_API_PORT=7700\nAGENTS_HOOK_SECRET=%s\n' "$P" "$P" "$(openssl rand -hex 16)" "$S" > .env
printf 'DATABASE_URL=postgres://agents:%s@127.0.0.1:5433/agents_test\nELECTRIC_URL=http://127.0.0.1:3002\n' "$P" > .env.test
docker compose up -d --wait postgres
docker compose exec -T postgres createdb -U agents agents_test
docker compose up -d --wait
npm install
npm run migrate
node --env-file=.env server/admin.ts add-team <team> <your Tailscale login>
node --env-file=.env server/admin.ts add-instance <team> <instance name> mac <your login>
node --env-file=.env server/admin.ts add-agent <team> <agent name> <instance name> [model] [instructions]
npm run api
```

`add-instance` prints the instance token once. The API applies any new migrations when it starts. To keep everything running across reboots, run `ops/install-launch-agents.sh` once. It starts colima at login, Tailscale in userspace mode, the API, and this Mac's daemon.

## Connect over Tailscale

The server Mac is `agents-server` on the tailnet. The API is published to it with:

```sh
tailscale --socket="$HOME/.agents-app/tailscale/tailscaled.sock" serve --bg --http=80 http://127.0.0.1:7710
```

The API listens on two ports. People use 7710, which only tailscale serve points at, so a person's identity always comes from Tailscale. Machines use 7700 with their tokens, and that port refuses any person's identity. Docker containers can reach this Mac only on 7700, and on 7701 where checks run: `ops/box-firewall.sh` runs in the colima VM at every start.

A teammate installs Tailscale, accepts an invite to the tailnet, and opens `http://agents-server.<your-tailnet>.ts.net`, or the desktop app (`npm run desktop`, configured by `~/.agents-app/app.json`). Each teammate needs a row in `people` (`admin.ts add-person`).

## Run a daemon

On each machine, put `{"api": "<server URL>", "token": "<instance token>"}` in `~/.agents-app/daemon.json`, then run `npm run daemon`. Each agent whose home is this machine gets a folder under `~/.agents-app/agents/`, and each task a workspace under `~/.agents-app/workspaces/`. Secrets the agents' plugins need go in the daemon's environment or `~/.agents-app/secrets.json`. Their values never reach the server.

## The forge and pipelines

A local Gitea runs in compose at `http://127.0.0.1:3001`. Set it up once for a team:

```sh
node --env-file=.env ops/forge-setup.ts <team>
```

It makes the `team/shop` repo, a small app with a known bug, and `team/pipelines`, where each file in `pipelines/` is one pipeline. Merging a change to a pipeline file makes it the current version. `bug-fix` takes a bug report to a reviewed pull request. `improve` changes another pipeline and scores the change on replays of past runs. `coach` turns corrections people keep making into new instructions for an agent. Pipelines need agents named `fixer` and `improver` on the team.

## Boxes

Boxes are Docker containers that run the daemon for unattended work, built from `box/Dockerfile`:

```sh
node --env-file=.env server/boxes.ts build
```

A run of a pipeline with `runsOn: 'box'` claims one, up to `AGENTS_MAX_BOXES` per team. For agents in boxes to run Claude on your subscription, run `claude setup-token` once and save the token in `~/.agents-app/box-claude-token` (mode 600), then recreate the boxes (`server/boxes.ts recreate <team> <box>`).

## Checks

```sh
npm run check            # typecheck, lint, then every check in test/
npm run check -- 6 9     # typecheck, lint, then only those steps
```

Checks run against their own database and Electric (`.env.test`), each with its own team, and remove what they made when they pass. Several use real Claude sessions. `test/step0.ts` checks that the coding standards are enforced.
