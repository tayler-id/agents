# The people port

How a person's identity reaches the API, why a tailnet peer could forge it on 2026-10-13, and the fix. The resume note for this work is `people-port-resume.md`.

## The hole

The API listens on two loopback ports. People use 7710, which `tailscale serve` publishes on the tailnet as port 80, and the API takes the person's login from the `Tailscale-User-Login` header that serve adds. Machines use 7700 with instance tokens.

On 2026-10-13 a request sent through this Mac's own tailnet path, `curl -x http://127.0.0.1:1055 http://agents-server.<tailnet>.ts.net:7710/v1/me` with a made-up login, got 403 from the API. The 403 says the API looked that login up. A real person's login would have been accepted as that person. Nobody but Tayler is on the tailnet yet.

## How userspace Tailscale reaches loopback

These facts come from the source of Tailscale 1.104.1 at commit `9a522a9`, the build installed here, and were confirmed on this Mac where noted.

- **Every port goes to loopback.** In userspace mode tailscaled terminates tailnet connections in its own network stack. For a TCP connection to the node's own Tailscale address, IPv4 or IPv6, it first offers the port to serve, Tailscale SSH, the web client and the peer API. Any port none of them claims is dialed at `127.0.0.1` on the same port, and the bytes are copied both ways (`wgengine/netstack/netstack.go`, `acceptTCP` and `forwardTCP`). UDP does the same (`forwardUDP`). So every service on this Mac that listens on loopback is a tailnet service.
- **The tailnet policy is the only gate in front of that.** The policy compiles into a packet filter that tailscaled applies to packets from WireGuard before its network stack sees them (`net/tstun/wrap.go`, `filterPacketInboundFromWireGuard`). The peer API is let through and checks access itself. The filter this node holds today lets every tailnet address reach every port over TCP, UDP and ICMP. That is the default allow-all policy.
- **The node's own traffic skips the filter.** A connection tailscaled makes to its own address, such as one through the outbound proxy on 127.0.0.1:1055, is handed back inside its network stack and never passes the packet filter (`outboundQueueForPacket`, `injectLoopback`).
- **What answered on 2026-10-13.** A connect through the proxy on 1055 to the node's own name reached ports 80, 7710, 7700, 4437, 5433, 3000, 3001, 3002, 1055, 5432 and several unrelated development servers. A port with nothing listening did not answer.

What a tailnet peer can reach today because of this:

| Port | What | What a peer gets |
|---|---|---|
| 7710 | the API's people port | any person, by sending their login |
| 1055 | tailscaled's outbound proxy | a connection from the server node itself, which serve labels as Tayler, so Tayler's identity on port 80. Also a proxy to the internet. |
| 4437 | the live stream server | read and append to any session's live stream. It has no access checks of its own. |
| 5433 | Postgres in colima | a login prompt, behind the database password |
| 3000, 3002 | Electric and the checks' Electric | shapes, behind `ELECTRIC_SECRET` |
| 3001 | the forge | its web login. Sign-up is off. |
| 5432 | Postgres from Homebrew, not part of Agents | every database without a password, since it trusts connections from 127.0.0.1, where tailnet connections arrive |
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

Part 1 holds even if part 2 is widened later, so the identity boundary does not rest on the policy. Part 2 is still needed for everything that is not ours to move off TCP, and for the proxy on 1055, which turns a peer into the server node itself.

### Rejected

- **The policy alone.** One rule closes every port, but the identity boundary would rest on a setting that lives outside the repo, starts as allow-all, and silently reopens 7710 the day anyone widens a grant. The socket costs one listener change and makes that impossible.
- **The API asks local whois about each connection.** Whois resolves only connections that netstack forwarded. A serve connection resolves to nothing, so the API would have to read "unknown" as "came from serve". That fails open the day a Tailscale release changes what it registers, and it adds a LocalAPI client to every people request.
- **A secret in serve's proxy path, or the PROXY protocol.** A path secret is a bearer token that sits in the serve config and in access logs. A PROXY protocol header can be written by any peer that connects directly. Neither is checked by the operating system the way a socket file is.
- **Running Tailscale in TUN mode.** Loopback-only services would stop being reachable, but services bound to all interfaces, seven of them on this Mac on 2026-10-13, would become reachable instead, so the policy would still be needed. tailscaled would also have to run as root from a launch daemon, and the Mac could no longer join a second tailnet.
- **Sandboxing tailscaled with `sandbox-exec` so it cannot dial loopback except 7700.** It would hold without the policy, but it depends on a deprecated tool with an undocumented profile language, and every loopback connection tailscaled itself needs would have to be found and allowed.
- **Running tailscaled in a container or the colima VM.** Its loopback would be empty, but serve would then need to reach the API across the VM boundary, which the box firewall exists to stop, and the node's state and launchd service would move.
- **Tagging the server node as part of this fix.** A tagged node gets no identity headers for its own requests, which would close the 1055 route even without the policy. It also stops Tayler's desktop app on this Mac, which reaches serve through that same proxy, from knowing who Tayler is. That trade is Tayler's to make, listed below.

## The fix

### Code on this branch

- `server/api.ts` reads `AGENTS_PEOPLE_SOCKET`, an absolute path, and refuses to start without it. The people listener binds that socket and nothing else. A socket file left by an API that stopped is replaced. One that still accepts connections belongs to a running API, so a second API refuses to start rather than take people's traffic.
- `test/people.ts` stands in for serve in checks. It forwards a loopback port to the API's socket, so fetch and browsers in checks reach the people listener as they reached 7710 before. The check still picks each request's login, as it did.
- Every check that starts an API gives it a socket in its own folder.

### Checks

- `test/step19.ts` runs this branch's API on ports 8060 to 8065 with a socket in a temporary folder. It fails on main and passes here.
- `test/step19b.ts` reads the live server and its tailnet node and sends only GET requests with made-up logins. It fails until the live steps below are applied.

### Live steps

For the coordinator to run once Tayler approves. Nothing here was applied by this branch.

## What this does not cover

- Any process running as Tayler's user on the server Mac can open the people socket and name any login, as it could reach 7710 before. That includes agents whose home is this Mac, since the daemon runs their sessions as Tayler. Running them as another user, or only in boxes, closes that.
- The stream server on 4437 has no access checks of its own. The policy keeps peers off it and the box firewall keeps containers off it, but any local process can still read or append to a session's stream.
- The peer API stays reachable from every peer, as Tailscale designs it.
