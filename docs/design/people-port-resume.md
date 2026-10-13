# People port: resume note

Where the security workstream stands, so the next session can pick it up. The design and its reasons are in `people-port.md`.

## State on 2026-10-13

- Branch `worktree-agent-a80c536acc0b70cd7`, worktree `.claude/worktrees/agent-a80c536acc0b70cd7`.
- Setup done: `.env` and `.env.test` copied from main, `npm ci` run, Node from `~/.local/node/bin`.
- Tailscale 1.104.1 source read at commit `9a522a9`, the commit `tailscale version` reports. A clone sits in the session scratchpad under `security-src/`, outside the repo.

## Findings so far

- Userspace tailscaled hands any TCP or UDP connection to the node's own Tailscale address to `127.0.0.1:<same port>` (`wgengine/netstack/netstack.go`, `acceptTCP` and `forwardUDP`). Only serve, SSH, the web client and the peer API take a port first.
- The tailnet policy is allow-all today. The packet filter tailscaled enforces lets every tailnet address reach every port, TCP, UDP and ICMP.
- Through the tailnet path, these ports answered a connect on 2026-10-13: 80, 7710, 7700, 4437, 5433, 3000, 3001, 3002, 1055, 5432, 8765, 63759, 9769. A port with no listener did not.
- Serve strips `Tailscale-User-*` headers a client sends and sets them from its own whois lookup. It can proxy to `unix:/path`.
- The server node is untagged and owned by Tayler's login. A request that reaches serve from the node itself, through the outbound proxy on 1055, gets Tayler's login.
- Homebrew Postgres 18 on 127.0.0.1:5432 trusts every connection from 127.0.0.1, which is where tailnet connections arrive.

## Plan

1. Design doc. Done when `people-port.md` names the choice and the rejected options.
2. API serves people only on a Unix socket, `AGENTS_PEOPLE_SOCKET`.
3. `test/people.ts` stands in for serve in checks. Every check that starts an API uses it.
4. `test/step19.ts`, hermetic. Fails on main, passes on the branch.
5. `test/step19b.ts`, read-only against the live server and its tailnet node.
6. README, `what-each-part-does.md` and the live steps for the coordinator.

## Next step

Step 1.
