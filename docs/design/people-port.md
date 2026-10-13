# The people port

How a person's identity reaches the API, why a tailnet peer could forge it on 2026-10-13, and the fix. The resume note for this work is `people-port-resume.md`.

## The hole

The live API listens on two loopback ports. People use 7710, which `tailscale serve` publishes on the tailnet as port 80, and the API takes the person's login from the `Tailscale-User-Login` header that serve adds. Machines use 7700 with instance tokens.

On 2026-10-13 a request sent through this Mac's own tailnet path, `curl -x http://127.0.0.1:1055 http://agents-server.<tailnet>.ts.net:7710/v1/me` with a made-up login, got 403 from the API. The 403 says the API looked that login up. A real person's login would have been accepted as that person. Nobody but Tayler is on the tailnet yet.

## How userspace Tailscale reaches loopback

These facts come from the source of Tailscale 1.104.1 at commit `9a522a9`, the build installed here, and were confirmed on this Mac where noted.

- **Every port goes to loopback.** In userspace mode tailscaled terminates tailnet connections in its own network stack. For a TCP connection to the node's own Tailscale address, IPv4 or IPv6, it first offers the port to serve, Tailscale SSH, the web client and the peer API. Any port none of them claims is dialed at `127.0.0.1` on the same port, and the bytes are copied both ways (`wgengine/netstack/netstack.go`, `acceptTCP` and `forwardTCP`). UDP does the same (`forwardUDP`). So every service on this Mac that listens on loopback is a tailnet service.
- **The tailnet policy is the only gate in front of that.** The policy compiles into a packet filter that tailscaled applies to packets from WireGuard before its network stack sees them (`net/tstun/wrap.go`, `filterPacketInboundFromWireGuard`). The peer API is let through and checks access itself. The filter this node holds today lets every tailnet address reach every port over TCP, UDP and ICMP. That is the default allow-all policy.
- **The node's own traffic skips the filter.** A connection tailscaled makes to its own address, such as one through the outbound proxy on 127.0.0.1:1055, is handed back inside its network stack and never passes the packet filter (`outboundQueueForPacket`, `injectLoopback`).
- **What answered on 2026-10-13.** A connect through the proxy on 1055 to the node's own name reached ports 80, 7710, 7700, 4437, 5433, 3000, 3001, 3002, 1055, 5432 and several unrelated development servers. A port with nothing listening did not answer.

What a tailnet peer can reach today because of this. Each port answered a connect. What a peer gets on 1055, 4437 and 5432 comes from the code and config, and was not tried with a request.

| Port | What | What a peer gets |
|---|---|---|
| 7710 | the API's people port | any person, by sending their login |
| 1055 | tailscaled's outbound proxy | a connection from the server node itself. Serve sets the login from a whois lookup of the source, and whois of the node's own address answers with Tayler's login, so this is Tayler's identity on port 80. Also a proxy to the internet. |
| 4437 | the live stream server | read and append to any session's live stream. Its package checks tokens only on subscription callbacks, never on streams. |
| 5433 | Postgres in colima | a login prompt, behind the database password |
| 3000, 3002 | Electric and the checks' Electric | shapes, behind `ELECTRIC_SECRET` |
| 3001 | the forge | its web login. Sign-up is off. |
| 5432 | Postgres from Homebrew, not part of Agents | every database without a password, since its `pg_hba.conf` trusts connections from 127.0.0.1, where tailnet connections arrive |
| others | development servers, a browser-control bridge, a coding agent's app server, another project's Postgres | whatever each serves to loopback |
| 7700 | the API's machine port | the machine API, behind instance tokens. This one should stay reachable. |

## What Tailscale offers

- **Serve** proxies HTTP to a backend and deletes any `Tailscale-User-Login`, `Tailscale-User-Name` or `Tailscale-User-Profile-Pic` header the client sent before setting its own from a whois lookup of the source address (`ipn/ipnlocal/serve.go`, `addTailscaleIdentityHeaders`). A tagged source gets no identity headers. The backend can be a TCP address or, in this version, a Unix socket written `unix:/path`. Serve can also forward raw TCP, with no identity and an optional PROXY protocol header.
- **Local whois** (`/localapi/v0/whois`) maps a tailnet address to its node and owner. For a loopback port that netstack forwarded, it maps the port back to the peer. Serve's own backend connections are not registered (a TODO in `tcpHandlerForServeTCP`), so whois cannot tell the API that a connection came from serve.
- **The tailnet policy** limits which sources reach which ports, enforced on this node as above.
- **Other serve targets.** Files, folders and fixed text, none of which apply here.

## The choice

Two parts, because the people port and the rest of loopback fail for one reason but can be closed in different places.

1. **The API serves people only on a Unix socket, and serve proxies to it.** Netstack forwards tailnet connections only to TCP and UDP ports on `127.0.0.1`, never to a socket file, so no tailnet peer can reach the people listener whatever the policy says. The socket sits in `~/.agents-app`, which only Tayler's user can open, and tailscaled runs as that user. Nothing in the API trusts the header on any other listener. This is the code on this branch.
2. **The tailnet policy lets peers reach the server node only on TCP 80, where serve answers, and TCP 7700, the machine port.** That closes the outbound proxy, the stream server, Postgres, Electric, the forge and every unrelated loopback service in one rule, which this node enforces before any of them sees a packet. Machines on teammates' computers keep reaching 7700. Tayler applies this in the admin console.

Part 1 holds even if part 2 is widened later, so the identity boundary does not rest on the policy. Part 2 is still needed for every service that cannot move off TCP, and for the proxy on 1055, which turns a peer into the server node itself.

### Rejected

- **The policy alone.** One rule closes every port, but the identity boundary would rest on a setting that lives outside the repo, starts as allow-all, and silently reopens 7710 the day anyone widens a grant. The socket costs one listener change and makes that impossible.
- **The API asks local whois about each connection.** Whois resolves only connections that netstack forwarded. A serve connection resolves to nothing, so the API would have to read "unknown" as "came from serve". That fails open the day a Tailscale release changes what it registers, and it adds a LocalAPI client to every people request.
- **A secret in serve's proxy path, or the PROXY protocol.** A path secret is a bearer token that sits in the serve config and in access logs. A PROXY protocol header can be written by any peer that connects directly. Neither is checked by the operating system the way a socket file is.
- **Running Tailscale in TUN mode.** Loopback-only services would stop being reachable, but services bound to all interfaces, seven of them on this Mac on 2026-10-13, would become reachable instead, so the policy would still be needed. tailscaled would also have to run as root from a launch daemon.
- **Sandboxing tailscaled with `sandbox-exec` so it cannot dial loopback except 7700.** It would hold without the policy, but it depends on a deprecated tool with an undocumented profile language, and every loopback connection tailscaled itself needs would have to be found and allowed.
- **Running tailscaled in a container or the colima VM.** Its loopback would be empty, but serve would then need to reach the API across the VM boundary, which the box firewall exists to stop, and the node's state and launchd service would move.
- **Tagging the server node as part of this fix.** A tagged node gets no identity headers for its own requests, which would close the 1055 route even without the policy. It also stops Tayler's desktop app on this Mac, which reaches serve through that same proxy, from knowing who Tayler is. That trade is Tayler's to make, listed below.

## The fix

### Code on this branch

- `server/api.ts` reads `AGENTS_PEOPLE_SOCKET`, an absolute path, and refuses to start without it. The people listener binds that socket and nothing else, before the machine port opens. A socket file left by an API that stopped is replaced. One that still accepts connections belongs to a running API, so a second API refuses to start rather than take people's traffic. The socket is mode 600, and its folder is made owner-only if it does not exist yet.
- `test/people.ts` stands in for serve in checks. It forwards a loopback port to the API's socket, so fetch and browsers in checks reach the people listener as they reached 7710 before. The check still picks each request's login, as it did.
- Every check that starts an API gives it a socket in its own folder.

### Checks

- `test/step19.ts` runs this branch's API on ports 8060 to 8065 with a socket in a temporary folder. On main's API all four of its lines fail: there is no socket, a TCP port takes the login it is sent, a second API starts anyway, and no socket comes back after a restart. On this branch all four pass. Breaking this branch's refusal of a second API and its replacement of a stale socket, to watch those two lines fail against this code, was blocked by the permission classifier as weakening security. Those two were seen failing only against main's API.
- `test/step19b.ts` reads the live server and its tailnet node, and sends only GET requests, naming a login that matches no person. On 2026-10-13 four of its lines failed on the live system: the filter on each address lets peers reach every port, port 7710 looked the made-up login up, and serve proxies to TCP 7710. The app through serve and the machine port's answer passed. Its policy lines were also fed the proposed filter through a stand-in for tailscaled's local API, and passed. They failed on filters that added UDP, left out IPv6, opened a port range, or left out 7700. The rest of it can only pass once the live steps are applied.

### Live steps

For the coordinator to run once Tayler approves. Nothing here was applied by this branch. The policy and the code are independent, and the policy closes the most, so it goes first.

1. **The tailnet policy.** In the admin console's access controls, remove the rule that lets everyone reach everything, a grant of `"ip": ["*"]` from `"*"` to `"*"` or an ACL of `"dst": ["*:*"]`, and add the grant below. `tailscale --socket="$HOME/.agents-app/tailscale/tailscaled.sock" ip` prints the two addresses. Keep anything else the policy holds.

   ```json
   "hosts": {
     "agents-server": "<the server's Tailscale IPv4 address>",
     "agents-server-v6": "<the server's Tailscale IPv6 address>"
   },
   "grants": [
     { "src": ["autogroup:member"], "dst": ["agents-server", "agents-server-v6"], "ip": ["tcp:80", "tcp:7700"] }
   ]
   ```

   If the editor refuses an IPv6 address under `hosts`, put both addresses in the grant's `dst` directly. Then run `node --env-file=.env --env-file=.env.test test/step19b.ts` in `~/Projects/agents`. Its two policy lines pass once the server has the new filter.
2. **Settings, before the code lands.** Add `AGENTS_PEOPLE_SOCKET=/Users/<you>/.agents-app/people.sock` to `~/Projects/agents/.env`, so an API restarted at any point after landing finds it. The API on main ignores it. Add an empty `AGENTS_PEOPLE_SOCKET=` to `~/Projects/agents/.env.test` and to each worktree's `.env.test`, so a check that starts an API without its own socket stops instead of taking the live one.
3. **Land the branch.** Branches that land after it need the change under "Other branches".
4. **Restart the API** with `launchctl kickstart -k gui/$(id -u)/com.agents.api`. `~/.agents-app/api.log` then shows `people on /Users/<you>/.agents-app/people.sock` and `machines on 127.0.0.1:7700`. Until step 5, the app over the tailnet answers 502.
5. **Point serve at the socket.** One command replaces the handler on port 80:

   ```sh
   tailscale --socket="$HOME/.agents-app/tailscale/tailscaled.sock" serve --bg --http=80 "unix:$HOME/.agents-app/people.sock"
   ```

6. **Check.** `node --env-file=.env --env-file=.env.test test/step19b.ts` passes all its lines, and the desktop app on this Mac still opens as Tayler.

To undo: restore the previous policy from the admin console's history, revert the merge, restart the API, and point serve back at `http://127.0.0.1:7710`.

### Other branches

Every branch has its own copy of the checks that start an API with `AGENTS_PEOPLE_PORT`, and most add new ones. After this lands, each such check needs the same three lines as here: import `servePeople`, set `AGENTS_PEOPLE_SOCKET` to a path in the check's own folder, and call `servePeople` on the port it used before. An API started without the setting stops at once and names it, so a missed check fails loudly. The AWS branch also listens for people on `127.0.0.1` itself, points serve at the people port, and checks that port in `health.ts` and `test/step11.ts`. Those move to the socket too. Its servers run Tailscale in kernel mode, where loopback is out of the tailnet's reach, but the socket keeps one design for both.

## Decisions for Tayler

- **The policy.** Members' devices reach the server only on TCP 80 and 7700, Tayler's own devices included. Nothing that works today stops working, since no other device is on the tailnet and this Mac's own requests skip the filter. If Tayler wants his devices to reach more, such as Screen Sharing, that is another grant, and `test/step19b.ts` changes with it.
- **The live steps** above: a policy change, an API restart, a serve change and two settings files.
- **Whether to tag the server node.** With a tag such as `tag:agents-server`, requests the server makes to itself through the proxy on 1055 carry no person, so that route stays closed even if the policy is widened later. Tagged nodes also skip key expiry, and this node's key expires on 2027-04-09 otherwise. The cost is that the desktop app on this Mac, which reaches serve through that proxy, would no longer be signed in as Tayler.
- **Agents whose home is this Mac.** They run as Tayler's user, so they can open the people socket, as they could reach 7710 before.
- **The coding standards.** The rule "A person's identity comes only from Tailscale on the people port" names the step 2 and step 2b checks. It should also name `test/step19.ts` and `test/step19b.ts`. The skill is a protected path.

## What this does not cover

- Real serve has not proxied to the socket yet, since that needs the serve change in the live steps. In checks, `test/people.ts` plays serve's part. Serve's proxy differs from its TCP one only in how it dials (`reverseProxy.getTransport`), and `test/step19b.ts` and the desktop app on this Mac try the real path in live step 6.
- Any process running as Tayler's user on the server Mac can open the people socket and name any login, as it could reach 7710 before. That includes agents whose home is this Mac, since the daemon runs their sessions as Tayler. Running them as another user, or only in boxes, closes that.
- The stream server on 4437 has no access checks of its own. The policy keeps peers off it and the box firewall keeps containers off it, but any local process can still read or append to a session's stream.
- The peer API stays reachable from every peer, as Tailscale designs it.
