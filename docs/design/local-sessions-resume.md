# Terminal sessions work, where it stands

A note for whoever picks this up, kept current with each commit on the branch. The design is [local-sessions.md](local-sessions.md).

- Branch `worktree-agent-ae6bff17618001d52`, worktree `.claude/worktrees/agent-ae6bff17618001d52`. Started from main at a98d843, and rebased onto 5556f3b, the durability merge.
- The worktree has its own `node_modules` from `npm ci`, and `.env` and `.env.test` copied from main.
- Migration 0013, applied to `agents_test`. Never edit it. The coordinator renumbers it at landing.
- The check is `test/step21.ts`, on ports 8100 to 8102, with teams named `local-<id>`.

## Done

The branch's commits, oldest first, by subject:

1. The design, from prototypes of hooks and of transcript reading against the real CLI.
2. Migration 0013 and its entry in `docs/data-model.md`.
3. The API: connected folders, terminal sessions, events from a terminal session, the shapes, and who sees what.
4. The daemon: `daemon/api.ts` taken out of `agentsd.ts`, `daemon/transcripts.ts`, `daemon/folders.ts`, and the mapping in `daemon/claude.ts`.
5. The app: the sidebar's From terminals and Running now, and a terminal session's page.
6. `test/step21.ts`. Its first run found that headless prompts are marked `sdk`, not `human`, and the fix is in the same commit.
7. The parts doc and the design doc's account of the check.
8. An interrupt for a terminal session is refused, a `.env` link to nothing is skipped, and step21's stray-words search looks only at its own team.
9. step21's phone-width line measures the page's own boxes, and the build log's entry.
10. The interactive session typed through the real daemon, in the build log and the design doc.
11. `test/step21b.ts`, a fast check that writes transcripts itself, for the review's fixes.
12. Secrets: every `.env` file under the folder, every value whatever its name, files sent as base64, the cwd and the session id, and the login shell's values, with terminal sessions held when the shell can't be read.
13. A bare `connect` keeps a folder's visibility, and `--team` widens a private one, saying how many sessions that shows.
14. What a session writes while its folder is disconnected stays on the Mac after a reconnect: the daemon keys each session to its folder's `connected_at`, and the API refuses a session older than it.
15. One bad session, line or file stops nothing else: each transcript is read in its own attempt and parked after 3 failed reads, a failed post backs off without holding up the others, and the scrubber takes out NULs and lone surrogates.
16. A transcript whose lines name another session stays on the Mac, and the API refuses one folder a session id that is another folder's.
17. No line is lost: a refused post keeps its lines and parks the session, posts are sized in encoded bytes, lines that don't parse are counted, and a field whose type changes reads as absent.
18. A transcript cut short or rewritten is read again from its start, by its inode and first uuid.
19. `connect` stores each name in its case on disk, prints the transcript folder the daemon reads, and warns when the shell sets `CLAUDE_CONFIG_DIR`.
20. A session the API closes is passed over for good after its first 409. A Mac clock ahead of the server's made the daemon take the session again on every read. step21b's sessions now start exactly at their folder's `connected_at`.
21. The Esc notice carries `subtype: 'interrupted'`, so the terminal page shows it. It had `interrupted: true`, which nothing read.
22. A transcript block is parsed with a zod union on its type, in place of `as string` casts. A block with a field of the wrong type is a notice that holds it as written. A tool call with a number for its id had made the API refuse the whole post, which parked the session.
23. A tool result for a path outside the connected folder is left on the Mac and replaced by a note, as Tayler decided. The daemon saves the ids it holds results back for with each transcript's offset.
24. Taking a session up no longer logs and carries on for any error. Only the API being out of reach or failing is tried again, and anything else counts as a failed read, which parks the transcript after 3. A line that isn't JSON is still left out and counted, and any other error from parsing it is thrown.
25. `daemon/api.ts` returns `unknown` from the API, and each caller parses what it needs. That meant a zod schema for each kind of command the daemon claims, in `shared/types.ts`, where the claim had been cast. A `daemon.json` that is damaged is an error naming it, and was once read as no file.
26. `server/folders.ts` uses `SessionId` and `PersonId`. The kinds a person writes, `user` and `answer`, are `PERSON_KINDS` in `shared/types.ts`, and both `server/folders.ts` and `server/record.ts` read them from there. `Session` in `server/record.ts` is the schema's two arms, an agent's session with an `agent_id` that is always a string and a terminal session with none, where `agent_id` had been widened to allow null.
27. The home folder and any folder above it can't be connected, and the daemon reads none that something with the machine token connected through the API.

Every one of step21's 50 lines was seen red under a break, in four rounds run by `ls/breaks.ts` in this session's scratchpad, not in the repo. Its results are `ls/breaks-result.json` and `ls/breaks-r2.json` to `ls/breaks-r4.json`.

## The rebase onto durability

- `docs/data-model.md` and `docs/what-each-part-does.md` keep both sections, durability's first.
- `daemon/agentsd.ts` keeps main's `HEARTBEAT_SEC` and `SESSIONS_DIR`, with `HOME` from `daemon/api.ts`.
- `app/src/App.tsx` lists live terminal sessions with main's `isWorking`, and `app/src/Session.tsx`'s `EventList` draws main's interrupted notices.
- What durability does to a terminal session, read from the code and not checked: recovery takes up only sessions with claimed messages, which a terminal session never has, and the fence stops only harnesses the daemon started. The watchdog marks a terminal session lost when its Mac stops answering, like an agent's, and the next batch the daemon sends sets its status again.

## How to work here

- `export PATH="$HOME/.local/node/bin:$PATH"` first.
- Run the fast check first, `node --env-file=.env --env-file=.env.test test/step21b.ts`. It takes about 10 s and needs no Claude.
- Run the check with `node --env-file=.env --env-file=.env.test test/step21.ts`. It needs the test Postgres and the test Electric on 3002, builds the app, and runs the real `claude` with `haiku` about ten times, so it spends a little of the subscription. It takes about three minutes.
- A red run keeps its teams and folders for inspection. `ls/cleanup.ts` in the scratchpad removes the `local-` teams, the `agents-step21-` temp folders and their transcript folders under `~/.claude/projects`.
- Never touch port 7701 without `mkdir ~/.agents-app/checks/run.lock` first. step21 doesn't use it. Main's step18d does.
