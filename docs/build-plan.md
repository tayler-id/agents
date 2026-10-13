# Build plan

What we build, in what order, and how each phase proves it works. The goal is in `docs/intent/multiplayer.md`. How the studied app works is in `research/teardown.md`. The behaviors phase 1 must match are rea's ledger in `docs/evidence/ledger/`.

## The shape of the system

```
 Instances (claimed)                 Server                                   People
 ───────────────────────             ───────────────────────────────          ─────────────────
 Mac daemon ─┐                       API (writes, scrubs secrets) ──► Postgres  Desktop app
 Box daemon ─┼── POST events ──────►                                   │       (Electron + React)
 Box daemon ─┘                                                         │ WAL       ▲
      │                              Electric sync engine ◄────────────┘           │
      │                                     ▲                                       │
      └── live tokens ──► Durable Streams   └──── auth proxy ◄──── shapes + streams ┘
                          server  ◄─────────────── (sets the filter per person)
```

- **Writes** go one way. A daemon posts events to the API, and the API writes them to Postgres.
- **Reads** go the other way. The app asks the auth proxy for a shape, such as the events of one session. The proxy sets the team filter and forwards to Electric, which streams the rows and every later change over plain HTTP.
- **Live tokens** skip Postgres. The daemon appends partial text to that session's durable stream, and the finished message lands in Postgres as an event.
- **Reaching the server.** The server runs on my Mac and joins a Tailscale tailnet. The API and proxy listen only on loopback, and `tailscale serve` is the one way in from other machines. For a person, serve adds `Tailscale-User-Login`, which maps to a row in `people`. A box joins the tailnet as a tagged device with no user, so its daemon sends its instance token instead.

## Data shape

The agreed model is in `docs/data-model.md`, which links the shared working doc with every table. In short: people and agents talk in conversations, a message can start a task, an agent's sessions do the work, every session's events go into the shared record, and asks wait on people. Migrations in `server/migrations/` turn it into tables.

Secrets never enter these tables. The daemon scrubs them before sending, and the API scrubs again.

## What we build and what we use

| Piece | Build or use |
|---|---|
| Postgres 17 | Use, in Docker (colima on the Mac). |
| Tailscale | Use. It connects teammates' Macs and boxes to the server and tells the API who each person is. |
| Electric sync service 1.8 | Use, in Docker. |
| Durable Streams server 0.3 | Use. |
| pg-boss | Use, for the job queue, cron and retries. |
| API | Build. TypeScript on Node 24. |
| Auth proxy | Build. A small TypeScript service in front of Electric and Durable Streams. |
| Daemon | Build. Wraps `claude -p --input-format stream-json --output-format stream-json`, runs Claude hooks for approvals, reads the session transcript for anything the stream leaves out, sends a heartbeat, and claims jobs for its instance. |
| `team-record` MCP server | Build. Gives every Claude session `search_sessions`, `get_session` and `recent_activity`, starting with Postgres full-text search. |
| Desktop app | Build. Electron, React and TanStack DB, reading Electric shapes. |
| Box image | Build. A Dockerfile with the toolchains, Chrome and the daemon, modeled on the studied app's box. |
| GitHub | Use, for PRs and review. |

## Phase 1: the shared record

Built in this order. Each step ends in a check that I first watch fail, then pass.

1. **Schema, API and daemon.** Done 2026-10-11, and redone the same day on the agreed data model. A person DMs an agent, and the agent's Claude session runs through the daemon on the agent's home machine. Check: `npm run check:step1`. It runs two turns and compares the record with Claude's own transcript. It checks that the agent's replies come back into the conversation linked to the events that wrote them, that a word from the session can be found by search, and that a secret from the daemon's environment and a GitHub-shaped token appear nowhere. I watched each check fail under a deliberate break, except the turn-order check, which can't be broken without stalling the run.
2. **Sync, proxy and Tailscale.** A client subscribes to one session's events and receives new rows live. Check: a teammate's Mac on the tailnet reads a session and starts one on my instance. The proxy refuses a person from another team, a forged `Tailscale-User-Login` header gets the sender's real login, and a reconnecting client resumes from its last offset without losing rows.
3. **Live tokens.** Assistant text streams through Durable Streams and settles into one Postgres event. Check: a second viewer sees the same tokens.
4. **Desktop app.** Shows connected instances, every session live, chat with agents, approval cards and interrupt. Check: the ledger's phase 1 obligations get owners, fixtures and passing verifiers in rea's manifest.
5. **Shared context.** The `team-record` MCP server. Check: the first part of the success test. A session on a second instance finds a fix made in the first session without being told about it.

## Phase 2: the factory

- Pipelines are TypeScript files in a `pipelines/` folder. Each stage runs a Claude session on a claimed instance. Each loop has a cap, and when it runs out a person takes over.
- A runner on pg-boss starts runs from cron and from GitHub, Linear and Slack webhooks.
- Boxes can be claimed, released, shut down when idle and recreated from the image, with a volume for the home folder and workspace.
- Every run records its pipeline version, metrics and spend. Each pipeline has a spend cap.
- First pipeline, bug-fix, following Boundary's: a report comes in, check whether it's already fixed, remove duplicates, build a trusted reproduction, classify the difficulty, fix it or plan it, then ping the shepherd.
- Check: a bug report webhook starts a bug-fix run on a box, which opens a PR. The shepherd approves it, and the whole run is visible live with its version and metrics.

## Phase 3: refinement

- Past runs become test sets. A candidate pipeline version is scored against the current one before anyone sees it.
- The system writes proposals: a diff to a pipeline file, plus its scores. Approving one merges it.
- Repeated corrections across people's sessions become proposed `CLAUDE.md` or skill edits, approved the same way.
- Check: the last part of the success test. The system proposes one bug-fix improvement with scores, and I approve it.

## Phase 4: the remaining features

Memory files, skills and plugins in the app, routines, the Mac computer-use helper, iMessage, group chats, templates, voice, meetings, preview environments for every session, and warm pools once boxes become disposable.

## Decisions

- **Whose Claude account runs unattended agents.** Mine, for now. Every box draws from the usage limit of the account it signs in with, so this gets revisited when bug-fix runs often.
- **Where the server runs.** On my Mac, reached over Tailscale. Moving it to a cloud host on the same tailnet changes no code.
