# Resume note: the AWS workstream

For a fresh agent picking this up. Branch `worktree-agent-a28035877f2a5a41d`, in the worktree `.claude/worktrees/agent-a28035877f2a5a41d`. Kept current with each commit.

## State

Rebased onto main at 1715371. Two pieces of work came after the code review, and both are committed and verified.

- **Boxes' home volumes move at cutover.** The export and the restore move every box's home, and `test/step11f.ts` rehearses the move on this Mac.
- **Boxes reach the open web.** Tayler rejected the allowlist, since each agent needs its own browser. The box firewall lets boxes reach any public address and, inside, only the machine port. The egress proxy is gone.

What is left is the report to the coordinator, and whatever the review sends back.

## The final round, on 4c2b686

- typecheck and lint exit 0, and the name guard says "no old names in 139 files".
- The checks pass with 17 (step11), 9 (step11b), 35 (step11c), 30 (step11d), 34 (step11e) and 12 (step11f) sub-checks.
- On main's code each fails, in `.scratch/main-tree`, main at deec329, whose server and ops code 1715371 leaves as it was. step11 has 7 failures, step11b fails building on the unreachable Docker, step11c, step11d and step11e cannot find `ops/aws/config.ts`, and step11f fails 8 of 12 since the scripts do not exist.
- `.scratch/cleanup.ts` removed 17 leftover `aws-` teams and one scratch database from failed and broken runs. No container, volume or image of this workstream is left but the lab image `agents-aws-netlab:0ee3b8c188a4`, kept as `step11c.ts`'s cache. `agents-box:latest` was rebuilt by another agent at 18:11, not by these checks, which build and remove their own tags.

## Done, with commits

- **Design and plan.** `docs/design/aws.md` (b6be8c5, kept current), `docs/aws.md` (f64946f).
- **The machine port's address.** `server/api.ts`, `AGENTS_MACHINE_HOST` (baaea69).
- **Boxes on a remote Docker host.** `server/boxes.ts`: `AGENTS_BOX_DOCKER_HOST`, `AGENTS_BOX_API` required when remote, one `docker ps` per pass, token kept while the host is unreachable, tokens through the CLI's environment (bfd64db), builds on the host's network (fa54db5).
- **The CDK stack.** `ops/aws/stack.ts`, `app.ts`, `config.ts`, `cdk.json`, with the CDK and SDK as exact dev dependencies (f90407d, 388aea6).
- **Host scripts.** `aws.ts`, `archive.ts`, `steps.ts`, `backup.ts`, `restore.ts`, `health.ts` (ee8fb23), `fetch-secrets.ts`, `secrets.ts`, `export.ts`, `update.ts`, `down.ts` (303250a, 0c1211f), `bootstrap.ts`, `compose.server.yaml`, and `ops/install-systemd.ts` (0fac3b5, f82ea94, faee2f8).
- **Checks.** `test/step11.ts` (ec9ee13), `step11b.ts` (15c3239), `step11d.ts` (388aea6), `step11e.ts` (58fd680). Each was seen failing under its own breaks, listed in `docs/build-log.md`.
- **Rules followed.** `.gitignore` and the `package.json` scripts are as on main (bf50847).
- **Box names in one place.** `shared/boxes.ts` names a box's container, home volume and label (c68ec1b).
- **Box homes at cutover.** `export.ts` and `restore.ts` move every box's home volume (353e36c). The fake AWS is `test/fake-aws.ts`, with S3's object listing (342cd61). `test/step11f.ts` (0b2578b) and its docs (7fc52b6).
- **Boxes on the open web.** `ops/aws/box-firewall.ts` with `BOX_CLOSED_RANGES` and `BOX_DNS` in `config.ts`, `ops/aws/egress.ts` removed with `AGENTS_BOX_PROXY`, and `test/step11c.ts` rewritten to prove the rule (a6a5d27). Docs (85d12a0).

## Not done

- The nightly backup leaves the boxes' homes out. Losing the box host's disk loses them, and a rollback after people worked on AWS leaves what boxes did there behind.
- Colima's firewall on this Mac fences off only this Mac's ports, not the other private ranges the box host's firewall drops. Colima's configuration runs the live system.
- No record of which hosts each box contacts.
- Not tried, since the lab cannot: traffic between two boxes on Docker's real bridge, and IPv6.

## How to run things here

- `export PATH="$HOME/.local/node/bin:$PATH"` first. `node_modules` is a real install in the worktree.
- A check runs as `node --env-file=.env --env-file=.env.test test/step11X.ts`. Never `npm run check`.
- Ports 7900 to 7919 are this workstream's: step11 7900 to 7902 and 7908, step11f 7903 to 7905, step11b 7909 to 7911, step11e 7913 to 7918. Test teams start with `aws-`. After failed runs, `.scratch/cleanup.ts` removes them, and the `aws_step11*` scratch databases, from `agents_test` only.
- `step11f.ts` uses port 7701, the one port besides the live API's that colima's box firewall leaves open, so it takes the shared lock `~/.agents-app/checks/run.lock` itself and waits up to 30 minutes for it. With `AGENTS_CHECK_LOCK_HELD=1` it trusts its caller to hold the lock. Other agents hold it for long stretches, an hour and twenty minutes on 2026-10-13.
- `step11b.ts` and `step11f.ts` need colima running, since they reach colima's VM over Lima's SSH config. `step11c.ts` builds a small lab image once and keeps it, uses fixed lab subnets, so two runs at once collide, and needs the internet, as does `step11e.ts`.
- The scratch tools, not committed: `.scratch/breaks.ts <name>` applies one break, runs its check, restores the file and compares its hash. `.scratch/breaks.ts rev:<rev>:<file>,<file> <check>` puts files back as they were at a revision. `.scratch/run-seq.ts` runs checks and breaks one at a time. `.scratch/series-11f.ts` takes the lock once and runs step11f green, under its breaks, before the fix and in main's copy. `.scratch/run-main.ts <checks>` runs checks in `.scratch/main-tree`, main's code with this branch's check files.

## Things learned the hard way

- Privileged containers are refused here. Containers with `NET_ADMIN` in their own namespace are allowed, which is how `step11c.ts` stands in for the box host.
- Containers in colima cannot reach this Mac's LAN address, or any port on it but 7700 and 7701.
- Node reads `--env-file` anywhere on its command line, even after the script, so `fetch-secrets.ts` takes `--to`.
- A check that serves the fake AWS in its own process must run scripts with `spawn`, never `spawnSync`, or they deadlock.
- The CDK's `asset.grantRead` grants the whole assets bucket. The stack grants the one object.
- A symlinked `node_modules` breaks `.scratch/main-tree`, since `step11c.ts` mounts the tree into containers. Clone it with `cp -Rc`.
- `docker run -i` streams stdin to a Docker host over `ssh://`, through `docker system dial-stdio`.
- The box firewall's chain sees every packet from the bridge, answers included, so the box host cannot open a connection to a box. `step11c.ts` checks the other box from the box instead, with the host left out of the path.
- In the lab, a box's packets for another box go through the host only with a /32 route, and the host must not send ICMP redirects, or the box learns to skip it.
- A pg client that never connected holds its queries forever, so a check's cleanup must skip them, or Node exits 13 on an unsettled top-level await.
- A child killed by a signal keeps a null `exitCode` and has already sent `exit`. Make the promise of a child's end when it starts, never after stopping it.
- From about 17:35 to 17:50 on 2026-10-13, APIs started by checks hung in the stream store's LMDB open, before listening, and node processes on this Mac aborted at exit in a native addon (`node.napi.node`), with reports in `~/Library/Logs/DiagnosticReports`. Reruns after 17:55 started normally. Nothing in this branch touches that code.

## Open questions for Tayler

- `docs/decisions.md` says everything goes through the tailnet. Boxes reach the server inside the VPC through one group-to-group rule, for the reasons in `docs/design/aws.md`. Keep that, or move box traffic onto the tailnet?
- Should colima's firewall on this Mac drop the same private ranges as the box host's?
- Approve the cost, about $217 a month, and the first steps in `docs/aws.md`.
