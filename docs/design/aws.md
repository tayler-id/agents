# Moving the cloud half to AWS

Written 2026-10-13, before the code, and kept in step with it. Tayler decided to move the cloud half to AWS. This file is the model the code follows. The plan Tayler reads, with costs and the cutover, is `docs/aws.md`.

## What moves and what stays

- **Moves to AWS.** The API with its runner and stream server, Postgres, Electric, the Gitea forge, and every box.
- **Stays.** Laptops keep the desktop app and optional daemons. This Mac keeps colima, the checks and `agents_test`, and stays the place to develop.

## The shape

| Part | Where | Why |
|---|---|---|
| Postgres 17 | RDS `db.t4g.small`, single AZ, isolated subnets | Backups, patching and point-in-time restore without running them ourselves |
| API, Electric, forge | One `t4g.large`, `agents-server` on the tailnet | The API needs Electric and the forge on loopback, as on the Mac |
| Boxes | One `m7g.xlarge`, `agents-boxes` on the tailnet | Boxes run code agents write, so they get their own machine and a firewall that keeps them on the public internet |
| Backups | An S3 bucket, nightly `pg_dump` and forge archive, plus RDS automated backups | RDS keeps 7 days. The bucket keeps 35 and survives deleting the stack |
| Secrets | SSM Parameter Store (SecureString), RDS's generated secret in Secrets Manager, files with mode 600 on the server | Nothing secret in user data, templates, logs or the record |
| Alarms | 14 CloudWatch alarms to an SNS email topic | Instance status, disk, memory, the API answering, backup age, RDS storage and CPU, Electric's replication lag |

Both machines run Amazon Linux 2023 on Graviton (arm64). It ships the AWS CLI, which first-boot user data needs to fetch the code, and its `dnf` has Docker, git and iptables.

## Network

- One VPC, `10.40.0.0/16`, in two zones, with no NAT gateway. Two public subnets hold the two instances, which get public IPv4 addresses for outbound traffic only. Two isolated subnets hold RDS, which needs two zones even for one instance.
- Fixed private addresses, so nothing has to discover them. The server is `10.40.0.10` and the box host `10.40.0.20`.
- **Security groups.** No group has a rule open to the internet. The box host's group has no inbound rules. The server's group has one, TCP 7700 from the box host's group, so boxes reach the machine port inside the VPC. The database group has one, TCP 5432 from the server's group.
- **Refined from the brief.** The brief said security groups with no inbound rules, and `docs/decisions.md` says everything goes through the tailnet. Boxes reach the machine port at the server's private address, which needs that one group-to-group rule. Sending box traffic over the tailnet instead would put every box request on Tailscale on both hosts, through the tailnet's smaller MTU, at a tailnet address that changes when the server is replaced and that boxes would have to be told, since their public resolvers know no tailnet names. The rule names a group, never an address range, so only the box host can use it. Switching is one setting, `AGENTS_BOX_API`, plus dropping the rule and allowing the server's tailnet address in the box firewall.
- **SSH only through Tailscale.** No port 22 rule exists. Both hosts run Tailscale SSH. The server's Docker CLI reaches the box host as `ssh://agents@agents-boxes`, which a tailnet policy rule allows from `tag:agents-server` only.
- **People.** `tailscale serve` on the server publishes the API's people socket, `~/.agents-app/people.sock`, on port 80, as `docs/design/people-port.md` does on the Mac. No tailnet peer can reach a socket file. The server runs Tailscale in kernel mode, so services bound to loopback are not reachable from the tailnet either.
- **Teammates' daemons.** They reach the machine port over the tailnet at `http://agents-server:7700` with their instance tokens.

## Code changes

### The machine port's bind address (`server/api.ts`)

- `AGENTS_MACHINE_HOST` holds one IP address or a comma-separated list, parsed with zod when the API starts, with the machine port. The default is `127.0.0.1`, so the Mac behaves as today. An entry that is not an IP stops the API with a message naming the variable.
- On AWS it is `0.0.0.0`. The machine port must answer on the VPC address (boxes), the tailnet (teammates' daemons) and the Docker bridge (the forge's webhooks). The security group and the tailnet policy decide who can connect. Listing the addresses one by one would expose the same port, since Linux accepts a connection to any local address on any interface.
- People arrive only on the API's Unix socket, `AGENTS_PEOPLE_SOCKET`, as on main. `fetch-secrets.ts` writes its path into the server's `.env`, and `install-systemd.ts` points serve at it.
- The machine port refuses any request with a header whose name starts with `tailscale-`, not only `Tailscale-User-Login`. Serve adds several identity headers, and the machine port now faces the network, so it refuses all of them before any code reads one.

### Boxes on a remote Docker host (`server/boxes.ts`)

- `AGENTS_BOX_DOCKER_HOST`, such as `ssh://agents@agents-boxes`, is the Docker host for box commands only. It falls back to `DOCKER_HOST`. Putting `DOCKER_HOST` in the server's `.env` would also send `docker compose exec forge` in `ops/forge-setup.ts` to the box host.
- When box commands go to a Docker host that is not a local socket, `AGENTS_BOX_API` is required, and the server refuses to start without it. The default, `host.docker.internal`, would point boxes at the box host itself, and they would sit offline with nothing saying why.
- **One `docker ps` per runner pass** reads every box container's state by its `agents.instance` label. Before, each claimed box cost one `docker inspect` every two seconds, which over SSH is one round trip each.
- **An unreachable Docker host never looks like a missing container.** Before, `docker inspect` failing for any reason meant "no container", so the runner gave the box a new token and tried to create a container. Over SSH a dropped connection did that to a box that was still running. Its old token stopped working, and the next pass saw it running and left it, offline for good. Now a failed `docker ps` stops the pass with the error logged, and a box's token is replaced only after its old container is removed.
- **Secrets reach `docker run` through the CLI's environment** (`-e AGENTS_TOKEN` with no value). Before, they were arguments, and a failed command's error message repeats its arguments, so the box token and the Claude token reached the API's log.
- `server/boxes.ts build` uses the same Docker host, so the image is built on the box host for arm64. Its build steps use the host's network, outside the box firewall, since the Dockerfile is ours, not an agent's.
- The box image, labels and volumes need no change. Volumes are created on whichever host runs the container.

## Boxes' way out

A box is an agent's computer, with a browser and computer use, so it reaches the public internet over any protocol, as boxes on this Mac do. Its browser, git, npm, pip, Claude and each person's Claude sign-in need that. Tayler set this rule on 2026-10-13, in place of an allowlist that let boxes reach only the Claude API, npm and PyPI. A box also holds a Claude token and runs code agents write, so it reaches nothing private except the server's machine port, which also carries the git proxy.

The box firewall (`ops/aws/box-firewall.ts`) enforces the rule, and there is no proxy. A proxy carries only TCP from tools that use proxy settings, so a browser's QUIC, git over SSH and any tool without those settings would need their own way out, and the firewall would still have to drop everything else.

- It runs at boot before Docker starts (`Before=docker.service`, and Docker requires it, so a failed firewall means no boxes).
- Its rules go in the `raw` table's `PREROUTING` chain for packets entering from `docker0` and `br-*`. That chain runs before routing, so one set of rules covers traffic to other hosts and to the box host itself. Docker and Tailscale both insert their own rules at the top of the filter table's `FORWARD` chain, where a rule of ours could end up behind Tailscale's accept for the tailnet. Neither touches the raw table.
- In order: the machine port at the server's address is let through. Every address the box host has is dropped, public ones included. Then each range in `BOX_CLOSED_RANGES` (`ops/aws/config.ts`) is dropped: the private ranges, where `10.0.0.0/8` holds the VPC, its resolver and RDS and `172.16.0.0/12` holds Docker's networks and so the other boxes, then `100.64.0.0/10`, which holds the tailnet, link-local `169.254.0.0/16`, which holds the metadata endpoint, and loopback, multicast and reserved ranges. Everything else goes out through the box host's public address.
- Boxes look names up at two public resolvers, `1.1.1.1` and `8.8.8.8` (`BOX_DNS`), set as `dns` in Docker's settings on the box host. They never need the VPC's resolver, and public resolvers know no VPC or tailnet names.
- IPv6 from boxes is dropped, the metadata endpoint's `fd00:ec2::254` with it. Boxes have no IPv6 address on Docker's bridge, and the VPC has no IPv6 route.
- `iptables-restore --noflush` replaces the chain in one transaction, so a rerun never leaves boxes unfiltered.
- The metadata endpoint is closed twice. The instances require IMDSv2 with a hop limit of 1, so a token request from a container never gets its answer back, and the firewall drops the packets first.
- Docker runs with `icc` off, so Docker's own rules also drop traffic between boxes on its bridge, and with log rotation, so container logs cannot fill the disk.
- **Not built.** No record of which hosts each box contacts. The firewall keeps no log of what it lets through.

## Provisioning (`ops/aws/`)

TypeScript throughout, per the coding standards. Shell appears only in first-boot user data, a few lines that install Node and hand over to TypeScript.

- **The stack (`stack.ts`, `app.ts`, `config.ts`).** One AWS CDK stack holds the VPC, the three security groups, RDS with its parameter group, the two instances, their roles, the bucket, the SNS topic and the alarms. CloudFormation makes it idempotent. `cd ops/aws && npx cdk synth` is the dry run that needs no AWS call once `cdk.context.json` holds the zone and image lookups, and `npx cdk diff` shows changes against a live stack. Every resource carries the tag `app=agents`. The settings (account and region from the CDK CLI, the alarm email, the box host's size, an optional zone) are parsed with zod. What the CDK writes goes in the ignored `.scratch/`.
- **Facts the hosts need** go in an SSM String parameter, `/agents/config`, written by the stack: the region, the bucket, the server's and box host's addresses, the ports, the resolver, and the database secret's ARN. Both hosts parse it with zod. It holds no secrets.
- **The code** reaches the hosts as a git bundle of the deployed commit, uploaded as a CDK asset. Its S3 URL goes in `/agents/code`. User data reads the parameter, so a new commit changes the parameter and never the instances' user data, which would stop and start them. Each host's role reads that one object and nothing else in the assets bucket.
- **First boot.** User data installs Node 24 at `/opt/node` with its SHA-256 checked, clones the bundle to `/home/agents/agents`, runs `npm ci` and hands over to `ops/aws/bootstrap.ts server|boxes`. That installs Docker, the Compose and Buildx plugins (pinned, SHA-256 checked) and Tailscale, joins the tailnet with the auth key from SSM, writes the secrets, grants Electric's user RDS's replication role, and installs and starts the services. On the box host the firewall is installed before Docker first starts. Each step checks before it acts, so a rerun converges.
- **Updates (`update.ts`).** Run on the server after `cdk deploy`. It refuses if the checkout has changes of its own, then fetches the bundle, checks its commit out, runs `npm ci` and the app build, builds the box image on the box host and restarts the API.
- **Cutover (`export.ts`).** Run on this Mac with the API and every box stopped. It dumps the database, archives the forge's volume and every box's home volume to `s3://<bucket>/cutover/<time>/`, puts the forge's config, the webhook secret and the Claude token for boxes in SSM, and prints the restore command for the server.
- **Boxes' home folders move too.** A box's home volume, `agents-box-<instance>-home`, holds its task workspaces, Claude's session files and, once boxes have a browser, its profiles. Without it a box on AWS would start empty, its tasks could not resume, and unsaved work would be lost. The export takes the box instances from the database, all of them unless `AGENTS_RUNNER_TEAMS` names some, as it does for the runner, and archives each one that has a volume to `boxes/<instance>.tar.gz`. It refuses while any of those boxes runs, so nothing changes mid-archive. The restore puts every archive in the export back into its volume, on the box host's Docker (`AGENTS_BOX_DOCKER_HOST`), refusing while a container uses one. Instance ids survive the move with the database, so when the runner starts a box on AWS it finds its home where it left it.
- **Not done.** The nightly backup still covers the database and the forge, not the boxes' homes. Losing the box host's disk would lose them.
- **Teardown (`down.ts`).** It asks for the stack's name, deploys once with deletion and termination protection off, then runs `cdk destroy`. RDS leaves a final snapshot. The bucket and the SecureString parameters stay unless `--delete-backups` and `--delete-secrets` are given.
- Every script has `--dry-run`, which says each step and does none.

## Secrets

| Secret | Where on AWS | Put there by | Read by |
|---|---|---|---|
| Database password | Secrets Manager, generated through CDK | The stack | `fetch-secrets.ts`, into `.env` |
| Tailscale auth keys, one per host | SSM `/agents/tailscale/server` and `/agents/tailscale/boxes` | `secrets.ts` on the Mac, from a file or stdin | `bootstrap.ts`, on first boot only |
| `AGENTS_HOOK_SECRET` | SSM `/agents/server/hook-secret` | `export.ts`, from the Mac's `.env` | `fetch-secrets.ts`, into `.env` |
| Claude token for boxes | SSM `/agents/server/box-claude-token` | `secrets.ts`, or `export.ts` from `~/.agents-app/box-claude-token` | `fetch-secrets.ts`, into a mode 600 file |
| Forge tokens and webhook secret | SSM `/agents/server/forge-json` | `export.ts`, from `~/.agents-app/forge.json` | `fetch-secrets.ts`, into a mode 600 file |
| `ELECTRIC_SECRET` | Only the server's `.env` | `fetch-secrets.ts` makes it once and keeps it | The API and Electric |

- SecureString values are written with the SDK, never on a command line, and never printed. CloudFormation cannot create SecureString parameters, which is why `secrets.ts` exists.
- `fetch-secrets.ts` runs as the `agents` user at every boot, before Compose and the API. It writes each file whole, with mode 600, and removes one whose parameter is gone.
- The instance roles can read only their own parameter names.
- A secret a later feature needs on the server follows the same path: a name in `SECRET_PARAMETERS`, stored with `secrets.ts`, written by `fetch-secrets.ts`.

## Backups and restore

- RDS keeps automated backups for 7 days, with point-in-time restore.
- `backup.ts` runs nightly from a systemd timer on the server. It dumps `agents` with `pg_dump -Fc` from the `postgres:17` image, stops the forge for a few seconds to archive its volume whole, and uploads both to `s3://<bucket>/backups/<time>/`. Connection settings reach `pg_dump` as libpq's environment variables, so the password is never on a command line. It records the time of its last success, which the health timer reports.
- The bucket blocks public access, encrypts at rest, refuses plain HTTP, keeps versions, and expires backups after 35 days and cutover exports after 14.
- `restore.ts` restores a backup or a cutover export into the database named in `DATABASE_URL`. It refuses while any session is connected to that database, or any container uses the forge's or Electric's volume or the home of a box in the export, and names them. It drops only that database's replication slots, recreates and restores the database, restores the forge volume, and puts each box's home back on the box host's Docker, `AGENTS_BOX_DOCKER_HOST`. It empties Electric's volume, so Electric rebuilds its shapes.

## Monitoring

- `health.ts` runs every minute on both hosts and sends metrics to CloudWatch in the `Agents` namespace. Both send disk and memory use. The server also sends whether the API answers (a junk token on the machine port must get 401, which needs the API and Postgres, and `GET /v1/me` without a login must get 401 on the people socket), whether Electric and the forge answer, and the age of the last backup.
- **Alarms.** Status checks on both instances (recover on a system failure, reboot on an instance failure), disk over 80%, the box host's memory over 85% for 15 minutes, the API, Electric or the forge not answering for 3 minutes or not reporting at all, a backup older than 30 hours, RDS free storage under 4 GiB, RDS CPU over 80% for 15 minutes, and Electric's replication slot more than 1 GiB behind.

## Linux services (`ops/install-systemd.ts`)

The Linux counterpart of `ops/install-launch-agents.sh`, in TypeScript. Units are typed values rendered to unit files.

- `server`. `agents-compose` (Electric and the forge, and on a non-AWS server also Postgres), `agents-api`, and `agents-daemon` when `~/.agents-app/daemon.json` exists. It points `tailscale serve` at the people socket, `unix:<socket>`, when Tailscale is installed. Serving a socket needs root, which the installer has.
- `boxes`. The firewall, which Docker requires, with its settings in `/etc/agents/box-firewall.env`.
- `--aws` adds `agents-secrets`, the backup timer and a sudo rule for the service user's restarts (server), and the health timer (both).
- `--dry-run` prints every file and command.

## How each part is checked

Every check fails on main's code, for the reason it guards.

- `test/step11.ts`. An API with a non-loopback machine address answers machines there and refuses Tailscale identity headers there, and still serves people only on its socket. Without the setting it listens only on loopback, and a bad address stops it. A box whose Docker host cannot be reached keeps its token. A box whose `docker run` fails never logs a token. A server whose boxes run on a remote Docker host refuses to start without `AGENTS_BOX_API`.
- `test/step11b.ts`. A real `ssh://` Docker host, colima's VM reached over SSH, while the server's own `DOCKER_HOST` points at a socket that does not exist. The box image builds there, a box starts there with its label, home volume, `AGENTS_API` and both tokens, and the runner starts it again after it stops and replaces it after it is removed. Containers in colima cannot reach this Mac's LAN address or any port but 7700 and 7701, so this check never needs a box to come online. `test/step7.ts` already covers a box's daemon working end to end.
- `test/step11c.ts`. The firewall, by what a box can reach, in containers. A stand-in box host with `NET_ADMIN` in its own network namespace runs it, and a stand-in box routes through it to the real internet and to stand-ins for the server, the VPC resolver, the database, the metadata endpoint, a tailnet peer, a private network and another box. The box looks names up at the resolvers in `BOX_DNS`. Before the firewall, the box reaches everything. After, it still opens example.com and npm over HTTPS, gets answers from both public resolvers, and reaches GitHub's SSH port and the machine port. It no longer reaches the metadata endpoint, the VPC's resolver, another port on the server, the database, the tailnet, the private network, another box, or the box host at its bridge, VPC or public address. The box host itself still reaches every other stand-in, and the box reaches the other box once it skips the host, so each "cannot reach" is the firewall.
- `test/step11d.ts`. The stack synthesizes with the CDK CLI's two lookups filled in, and its template has what this design says: nothing open to the internet, the one rule to 7700 and the one to 5432, IMDSv2 with hop limit 1, the logical-replication parameter, backups, the tag on every resource that takes one, roles limited to their own parameters and prefixes and the one code object, and the 14 alarms.
- `test/step11e.ts`. The host scripts against a fake AWS that speaks the real protocols (SSM and Secrets Manager's JSON 1.1, CloudWatch's JSON 1.0, S3's REST API) and refuses unsigned requests, with a real Postgres and real Docker. Secrets land in mode 600 files and never in output. A backup and a restore round-trip a real database and volume, with both refusals. The health report notices a stopped API, and an API whose people socket does not answer. Every script's dry run makes no AWS call. The systemd units and the Compose override say what this design says. The fake AWS is `test/fake-aws.ts`, shared with `step11f.ts`.
- `test/step11f.ts`. A rehearsal of the move on this Mac. A task runs on a box with the fake Claude and writes a file. `export.ts` refuses while the API's machine port answers, while its people socket answers, each on its own, and while the box runs, before it uploads anything or stops the forge. With both stopped, it and `restore.ts` run for real against the fake AWS, and in between the box's container and home volume are removed, as if the box had moved to a new host. The restore refuses while a container holds the box's home, then puts it back over SSH, with colima's VM as the box host. When the API starts again, the runner starts the box on its restored home, every file in it matches byte for byte, and a new message to the task resumes the same Claude session in the same workspace, with the file still there. With the export and the restore as the review found them, the export holds no box home and the task's session fails, because its workspace is gone.

## Not covered by checks, and why

- Nothing calls AWS. `cdk deploy`, first boot on Amazon Linux and Tailscale joining are tried for the first time when Tayler signs in. `bootstrap.ts` dry runs and type checks are the evidence until then.
- The Docker transport is checked over Lima's SSH into colima's VM, not Tailscale SSH, which needs the tailnet policy rule from `docs/aws.md`.
- The box image build is not checked under the box firewall. It uses the host's network, so the firewall never sees it, by construction.
- Boxes have no IPv6 in the lab, so the IPv6 drop is not exercised.
- Traffic between two boxes on Docker's own bridge. In the lab one box sends its packets for the other through the stand-in host, which routes them, and the firewall drops them there. On the box host they cross Docker's bridge, where `icc` off and the firewall both apply only when the bridge passes them to iptables. That was not tried here.
- `dns` in Docker's settings on the box host. The lab writes the same resolvers into the box's `/etc/resolv.conf`, and `test/step11e.ts` checks that first boot writes them into Docker's settings.
- A privileged Docker-in-Docker box host would let one check cover a second Docker daemon, the firewall and the SSH transport together. Privileged containers were refused here, so the checks split that work across colima's VM over SSH and `NET_ADMIN` containers.
