# People port: resume note

Where the security workstream stands, so the next session can pick it up. The design, the live steps and the decisions for Tayler are in `people-port.md`.

## State on 2026-10-13

- Branch `worktree-agent-a80c536acc0b70cd7`, worktree `.claude/worktrees/agent-a80c536acc0b70cd7`.
- Setup done: `.env` and `.env.test` copied from main, `npm ci` run, Node from `~/.local/node/bin`. Checks that start a real Claude session also need `~/.local/bin` on the PATH, where `claude` lives. This worktree's `.env.test` has the empty `AGENTS_PEOPLE_SOCKET=` the README now asks for.
- Tailscale 1.104.1 source read at commit `9a522a9`, the commit `tailscale version` reports. A clone sits in the session scratchpad under `security-src/`, outside the repo.

## Built

- `server/api.ts` serves people only on the Unix socket `AGENTS_PEOPLE_SOCKET`, required at startup.
- `test/people.ts` stands in for serve in checks. All 16 checks that start an API use it.
- `test/step19.ts`, hermetic, on ports 8060 to 8065. All four lines failed on main's API and pass here.
- `test/step19b.ts`, read-only against the live server. Four lines fail on today's live system, as they should until the live steps.
- README and `docs/what-each-part-does.md` say what changes.

## Checks run on this branch

- Pass: step19, step2, step1, step3, step4a, step4b, step4c, step4d, step5, step6, step6b, step9, step9b, step10, step10b.
- step4d, step6 and step10b first failed only because other branches' checks held their people ports, 7905, 7921 and 7971. Each passed when rerun on free ports.
- Not run: step7 and step8. They need the lock on 7701, which other agents held from 16:03 to at least 17:17 while running their own checks on that port.
- Typecheck, lint and the names check pass.
- Every test team the failed runs kept, and step6's two forge repos, were deleted by exact name.

## Not done

- Breaking this branch's refusal of a second API and its replacement of a stale socket was blocked by the permission classifier as weakening security, so those two lines were seen failing only against main's API.
- Nothing live is applied. See the live steps in `people-port.md`.
- Every other branch must move its API-starting checks to the socket when it lands after this one.

## Next step

Take the lock on 7701 and run step7 and step8. Then the coordinator's landing gates.
