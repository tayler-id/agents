# Multiplayer intent

Confirmed with Tayler on 2026-10-11 through an interview. This is what the rebuild is for. Specs and plans build on it.

## Intent

- **Outcome.** Agents, a multiplayer app for a team and its agents. Every agent session on every connected instance goes into one shared record, and everyone's agents draw on it, so people working together have agents that know each other's context.
- **Users.** A team. Each person claims an instance: their own Mac running a daemon, or a cloud box (a Docker container) that runs agents and pipelines unattended. The system tracks every instance that connects.
- **Local and cloud agents.** People keep using their own coding agents, Claude Code or Codex, on their own computers, and those sessions land in the shared record. Cloud agents are spun up on demand, each in its own Docker container with everything it needs: a desktop, a browser on the open web, its tools and computer use. A person can watch any of them and take over, and each checks its own work, like the app we studied. Confirmed with Tayler on 2026-10-13.
- **Pipelines.** Any agent with a job: the whole developer life cycle as one pipeline, bug fixing, and any agent built in the app. The system studies the record, proposes improvements to a pipeline, and a person approves them.
- **Success.** Two people work at once. A teammate's Claude finds and uses my fix from an hour earlier without anyone pasting it in. I open their session live from the app. A bug-fix run on a cloud box shows up in the same record and gets one proposed improvement that I approve.
- **Constraints.**
  - Postgres is the only system of record.
  - Reads sync over plain HTTP, with no WebSockets. The stack is a sync engine in the style of Electric that reads Postgres's write-ahead log like a read replica and serves shapes, an auth proxy in front of it, and a durable stream server for live tokens.
  - Everyone on the team sees everything, enforced at the proxy. Each session carries an access list from day one, so locking a session or adding a team later changes the proxy, not the schema.
  - Secrets are scrubbed before anything is written.
  - Claude runs through my subscription.
  - Pipelines are code. Each pipeline is a file in a repo, every run carries the pipeline version, and the system's proposed improvements are edits to those files.
  - The daemon wraps the harness behind one interface. It drives Claude through the headless CLI and its hooks and reads the session transcripts, so Codex can be swapped in without touching the record or the sync stack.
- **Out of scope for now.** Separate customer orgs, a phone app, and pipeline changes that apply without approval. Voice, meetings, Slack and email stay in later phases.

## Consequence for the build plan

The shared record moves to the front. Phase 1 sits on Postgres and the sync stack from day one instead of a local database that gets replaced later.

## Definition of done

Tayler set this on 2026-10-14. Agents is done when a team can do all of it from the app, first on the Mac and then on AWS, with nothing taken away.

**Team and agents**
- Every person on the team has agents, and anyone can create a new one from the app.
- Every person gets their own computer in the cloud, on a home server or AWS. Each person's agents share it, and each agent has its own seat in it: a screen, a browser and a workspace. Parallel coding jobs get computers of their own, so many agents work at once.
- Agents create new agents, message other agents directly, hand work to them, and work together in rooms.
- In a conversation, an agent works on its screen where everyone sees it, added by Tayler on 2026-10-15. It might draw a flow diagram of the software being discussed, open a whiteboard, or show the team's Jira board in its browser. Anyone in the conversation watches it live there, takes over, and hands it back.
- A teammate's agent setup can be copied, or started from a template.
- Agents run on more than one engine. Each agent picks its engine and model, such as Claude, Codex or Gemini, behind `daemon/harness.ts`, and every engine's work lands in the same record.

**Building**
- People and agents build from the app, with tasks, files, diffs, pull requests, reviews and approvals on the team's repos, both the Mac's forge and GitHub.
- Agents load skills and plugins, and run hooks.
- People keep using Claude Code in their own terminals, and those sessions land in the record.

**The record**
- Everything is saved. That covers every conversation, message, tool call, tool result and error, and everything an agent thinks, says or does.
- People search all of it from the app, and agents search it with their record tools.
- It is understandable. Each session, agent and day has a plain summary of what happened, and any step opens in full.

**Control and cost**
- A live usage meter shows what each agent and person spends, by agent, by source and by token type, and people set budgets that stop a runaway agent.
- People are told when an agent needs approval, gets stuck or finishes, on desktop and on phone.
- It is clear who can drive whose agents, and what agents may do without asking.
- An admin can remove a person and delete their data.

**Where the team already works**
- GitHub, Slack and email.

**Connectors and MCP**, added by Tayler on 2026-10-15
- Agents reach the team's knowledge and tools through connectors, starting with Jira, Confluence and Slack. A person connects one from the app by signing in, with no token pasted onto a machine, and picks which agents may use it.
- Any MCP server can be added, run on the agent's computer or hosted, including hosted ones that sign in with OAuth.
- Agents answer with visuals and interactive components in the conversation through MCP apps, and a person uses them there.
- WebMCP. Agents use the tools a web page offers through WebMCP, and the Agents app offers its own actions the same way.

**Joining**
- A new teammate goes from invite to first message in under 10 minutes: install Tailscale, download the signed Agents app, open it.

**Proof**
- Every item above has a check in `npm run check` or a case in the test plan, and has been tried on the live system with a second person.

### Where it stands on 2026-10-14

- **Live:** teams, agents, rooms, tasks with files, diffs and pull requests on the Mac's forge, pipelines with approvals, skills and plugins, personal boxes, and a record of every session the app starts, thinking and errors included.
- **Built, landing:** terminal sessions, agents' own screens and browsers, GitHub, agents testing their own work, the coding framework, and AWS (written, not switched on).
- **Not built:** a seat per agent in a box, bigger boxes and more job boxes, hooks, people's search page, summaries, spend view and budgets per agent, notifications, Slack and email, copying agents and templates, removing a person, and the one-download signed app.

## Sources

- Electric's auth guide, `electric.ax/docs/guides/auth`: shapes are plain HTTP, and a proxy sets the table and `where` filter server side.
