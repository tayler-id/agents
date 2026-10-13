# People port: resume note

Where the security workstream stands, so the next session can pick it up. The design, the live steps and the decisions for Tayler are in `people-port.md`.

## State on 2026-10-13

- Branch `worktree-agent-a80c536acc0b70cd7`, worktree `.claude/worktrees/agent-a80c536acc0b70cd7`.
- Setup done: `.env` and `.env.test` copied from main, `npm ci` run, Node from `~/.local/node/bin`. Checks that start a real Claude session need `~/.local/bin` on the PATH too, where `claude` lives.
- Tailscale 1.104.1 source read at commit `9a522a9`, the commit `tailscale version` reports. A clone sits in the session scratchpad under `security-src/`, outside the repo.

## Built

- `server/api.ts` serves people only on the Unix socket `AGENTS_PEOPLE_SOCKET`, required at startup.
- `test/people.ts` stands in for serve in checks. All 16 checks that start an API use it.
- `test/step19.ts`, hermetic, on ports 8060 to 8069. All four lines failed on main's API and pass here.
- `test/step19b.ts`, read-only against the live server. Four lines fail on today's live system, as they should until the live steps.
- README and `docs/what-each-part-does.md` say what changes.

## Checks run on this branch

- Pass: step19, step2, step1, step3, step4a, step4b, step4c.
- step4d failed once because another branch's `step11f.ts` held port 7905, step4d's people port. Rerun when the port is free.
- Not run yet: step5, step6, step6b, step9, step9b, step10, step10b (a run is in progress), and step7 and step8, which need the lock on 7701.

## Not done

- The deliberate breaks of the second-API refusal and the stale-socket replacement were blocked by the permission classifier as weakening security, so those two lines were seen failing only against main's API.
- Nothing live is applied. See the live steps in `people-port.md`.
- Test teams kept by failed runs, to delete by exact name: `sec-f02c9e10`, `sec-28466246`, `step1-665a9398`, `step3-ffafd763`, `step3x-ffafd763`, `step4d-0017af35`, and the step4a team from the first run, which was stopped.

## Next step

Finish the suite, rerun step4d, take the lock and run step7 and step8, then delete the kept teams.
