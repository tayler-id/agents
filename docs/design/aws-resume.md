# Resume note: the AWS workstream

For a fresh agent picking this up. Branch `worktree-agent-a28035877f2a5a41d`, in the worktree `.claude/worktrees/agent-a28035877f2a5a41d`. Kept current with each commit.

## State

Rebased onto main at 7197f4b, and not rebased since. The second review, on another model, sent eleven items back. All are fixed and committed, and the commit messages name the break that failed each check. Tayler's calls of 2026-10-14 are done in code. Boxes run without `NET_RAW`, and colima's firewall script keeps boxes off the box host's private ranges. The colima script is not applied to the live VM. Its live steps, which Tayler runs, are in `docs/aws.md`. Nothing is deployed, and no `cdk deploy` has run.

What is left is the coordinator's three gates, Tayler running the live steps, and Tayler's call on `icc: false` for colima.

## At the head

- step11 17, step11b 10, step11c 45, step11d 43, step11e 46, step11f 18 and step11g 33 pass. Main's `test/step7.ts`, a real box that clones and pushes, also passes with `--cap-drop NET_RAW`, 14 checks. Typecheck, lint and the name guard pass.
- With main's old `ops/box-firewall.sh` put back, step11g fails 5 lines. With `--cap-drop NET_RAW` taken out of `server/boxes.ts`, step11b fails the one line that reads the box's capabilities.
- The colima script and live steps were tried in a throwaway colima profile, deleted afterwards. `docs/design/aws.md` lists what that showed.

## Commits, oldest first

- 5132907 The machine port on chosen addresses, and boxes on a remote Docker host. Checked by step11 and step11b.
- 2d86436 The AWS stack, in the CDK. Checked by step11d.
- aa925ff The box host's firewall. Checked by step11c.
- 50c91f5 Scripts for the AWS hosts, and the fake AWS. Checked by step11e.
- 3ac423e Check 11f, the move rehearsed with box homes.
- dcf37ff Docs: the plan, the design and the build log.
- 6eb0dd9 People reach the AWS server only on the API's socket (review item 1, and items 6 and 10 for the export).
- 3672923 Check 11d pins every alarm (item 8).
- c604956 Check 11c probes every closed range (item 8).
- a949846 Settings that are not secrets get a file fetch-secrets never writes (item 5).
- 43228c5 Restores refuse newer work and running boxes, and stage on disk (items 2, 3, 4 and 10 for teardown).
- c75c486 One definition each for the machine port and the RDS certificate's name (item 11).
- 995e89e Comments: a colon only introduces a list.
- 3fe656e Check 11e reads the steps the export prints for the server.
- 425fdc3 Check 11f restores twice, the second time over a stopped box.
- dab60f3 Boxes run without NET_RAW. Checked by step11b.
- ba1dc3e Colima's firewall keeps boxes off the private ranges. Checked by step11g.
- The docs commit, which holds this note, is the head.

## How to run things here

- `export PATH="$HOME/.local/node/bin:$PATH"` first. `node_modules` is a real install in the worktree.
- A check runs as `node --env-file=.env --env-file=.env.test test/step11X.ts`. Never `npm run check`.
- Ports: step11 7900 to 7902 and 7908, step11f 7903 to 7906 and 7701, step11b 7909 and 7911, step11e 7913 to 7917. step11c and step11g use no host port, but fixed lab subnets, so they cannot run together. Test teams start with `aws-`. After failed runs, `.scratch/cleanup.ts` removes them, and the `aws_step11*` scratch databases, from `agents_test` only. A failed step11b or step11f also keeps a folder, in the system temp folder or `~/.agents-app/checks/aws-step11f-*`. Delete it.
- `step11f.ts` uses port 7701, the one port besides the live API's that colima's box firewall leaves open. Its caller takes the shared lock `~/.agents-app/checks/run.lock` first, as AGENTS.md says. `.scratch/locked.ts <checks and breaks>` waits for the lock, runs them through `.scratch/run-seq.ts`, and releases it. Other agents hold the lock for long stretches, an hour and twenty minutes on 2026-10-13, and it came free within a few minutes on 2026-10-14.
- To run a long wait for the lock without freezing this tree, `.scratch/snapshot.ts <name>` clones the tree into `.scratch/snap-<name>` with `cp -Rc`, and the locked run starts from there.
- `step11b.ts` and `step11f.ts` need colima running, since they reach colima's VM over Lima's SSH config. `step11c.ts` and `step11g.ts` share the lab image from `test/netlab.ts`, which builds once and stays. They and `step11e.ts` need the internet.
- After a run that builds an image (step11b, step11f), run `docker image prune -f`, and never while another build runs. `run-seq.ts` prunes after each run unless its first argument is `--no-prune`. Never build or tag `agents-box:latest`.
- `.scratch/breaks.ts <name>` applies one named break, runs its check, restores the file and compares its hash. The names for the colima script all start with `colima-`, and `box-keeps-net-raw` drops the capability flag. `.scratch/breaks.ts rev:<rev>:<file>,<file> <check>` puts files back as they were at a revision. `.scratch/run-main.ts <checks>` runs checks in `.scratch/main-tree`, main's code with this branch's check files. Stage the files under test first with `git add`, and `git diff` is empty after a break if it was restored byte for byte.
- A throwaway colima VM for trying a change to the VM. `colima start --profile fwcopy --cpus 2 --memory 2 --disk 10 --activate=false --ssh-config=false --port-forwarder none` takes about 20 seconds. Reach it with `colima ssh -p fwcopy` and `docker --context colima-fwcopy`. End it with `colima delete --profile fwcopy --force`, and never run `colima delete` without the profile, since the default is the live VM. While it exists, `~/.colima/ssh_config` gains a `Host colima-fwcopy` block, which deleting it removes. Compare the live VM's `colima.yaml`, `~/.docker/config.json`, `~/.ssh/config` and `iptables-save` before and after.

## Not done

- The nightly backup leaves the boxes' homes out. Losing the box host's disk loses them, and a rollback after people worked on AWS leaves what boxes did there behind.
- Colima's script is not applied to the live VM, so `npm run check:step7` has not run behind it. Two boxes on `docker0` still reach each other there until colima's config gets `icc: false`. Both are in the live steps for Tayler.
- A rerun of the colima script leaves a moment when a chain is empty. The box host's firewall replaces its chain in one transaction.
- No record of which hosts each box contacts.
- Not tried: traffic between two boxes on the box host's own bridge on Amazon Linux, IPv6 on the box host, and the export's timeout branch, since the check's silent address fails at once.
- Nothing has called AWS: the stack, first boot, the tailnet policy, Tailscale SSH, the break-glass steps, multipart uploads against real S3, and `tailscale serve` to a socket on Linux.

## Things learned the hard way

- Privileged containers are refused here. Containers with `NET_ADMIN` in their own namespace are allowed, which is how `step11c.ts` and `step11g.ts` stand in for a host and for the VM.
- In that lab, a box reaches the host's loopback addresses only with `route_localnet` on both, a /32 route and the box's `local 127.0.0.0/8` route removed. Multicast works on colima's bridges, and 198.18.0.0/24, 240.0.0.0/24 and 0.1.0.0/24 work as Docker subnets.
- In the lab VM of `step11g.ts`, attaching the boxes', private and Compose networks moved its default route onto the boxes' network. Renaming that link to `docker0` dropped the route, and nothing reached the web until the check set it again.
- Containers in colima cannot reach this Mac's LAN address, or any port on it but 7700 and 7701. From a container, `host.docker.internal` is 192.168.5.2, found through the VM's resolver.
- Colima's resolver, dnsmasq, answers on the VM's own address. It was 192.168.5.1 in the live VM and 192.168.5.3 in a new one. The VM has no `br_netfilter` until Docker loads it, which it did when `icc` was turned off.
- Busybox's `nc -z` prints nothing for a refused or a timed out connection, and Alpine's busybox has no `httpd`. A loop of `nc -l` answers a probe.
- Node reads `--env-file` anywhere on its command line, even after the script, so `fetch-secrets.ts` takes `--to`. A later `--env-file` wins over an earlier one, and `--env-file-if-exists` skips a missing file with a notice.
- A check that serves the fake AWS in its own process must run scripts with `spawn`, never `spawnSync`, or they deadlock.
- The S3 SDK sends a CRC32 with each part even when not asked.
- `docker image prune` while another build runs breaks that build, with "lease does not exist".
- A pg client that never connected holds its queries forever, so a check's cleanup must skip them.
- A child killed by a signal keeps a null `exitCode` and has already sent `exit`. Make the promise of a child's end when it starts.
- `192.0.2.1` sometimes answers with a reset here. `100::1`, IPv6's discard prefix, fails at once with EHOSTUNREACH.

## Settled by Tayler on 2026-10-14

- The `ops/` files are approved. Nothing is deployed until the Mac version settles, and it costs about $217 a month once it runs.
- Box traffic stays on the VPC, not the tailnet.
- Boxes drop `NET_RAW`. That takes away packet capture and raw-socket scans, and not ping. The box image has no ping binary, and `net.ipv4.ping_group_range` is `0 2147483647`, so a ping an agent installs uses ICMP sockets. Done in `dab60f3`.
- Colima on this Mac drops the same private ranges as the box host. The script and its check are in `ba1dc3e`. The live steps are in `docs/aws.md`, and Tayler runs them.
