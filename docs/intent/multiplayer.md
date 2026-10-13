# Multiplayer intent

Confirmed with Tayler on 2026-10-11 through an interview. This is what the rebuild is for. Specs and plans build on it.

## Intent

- **Outcome.** Agents, a multiplayer app for a team and its agents. Every agent session on every connected instance goes into one shared record, and everyone's agents draw on it, so people working together have agents that know each other's context.
- **Users.** A team. Each person claims an instance: their own Mac running a daemon, or a cloud box (a Docker container) that runs agents and pipelines unattended. The system tracks every instance that connects.
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

## Sources

- Electric's auth guide, `electric.ax/docs/guides/auth`: shapes are plain HTTP, and a proxy sets the table and `where` filter server side.
