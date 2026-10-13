---
name: coding-standards
description: The coding standards for Agents, the multiplayer agents app. Use whenever writing, editing or reviewing its TypeScript, React, SQL or checks, and before calling any change done. Lists the bugs to avoid, each with where we know it from and what enforces it.
---

# Coding standards

Rules for this codebase that keep known bugs out. Each rule names the bug it prevents, where we know it from, and what enforces it. Follow them when writing, editing or reviewing any code here, and add a rule when a new kind of bug turns up, with its source and what enforces it.

- **Sources.** "Hit here" means it happened in this project, with the date. "Known" means the people who make the language or tool document it as a common source of bugs.
- **Enforcement.** A compiler flag or lint rule fails `npm run check` before any check runs. A check is a test in `test/`. "Review" means nothing automatic catches it yet, so a person or agent has to.
- **The enforcement is checked too.** `test/step0.ts` writes code that breaks each enforced rule on purpose and fails if lint or the compiler lets any of it through. Weakening the lint config or a compiler flag turns it red. When you add a lint or compiler rule here, add its violation there.

## Before calling anything done

1. `npm run typecheck` and `npm run lint` are clean. Never silence a rule to get there. Fix the code, or add the rule to "Lint rules left off" with the reason.
2. The checks for what you changed pass: `npm run check -- <steps>`, or `npm run check` for everything. Checks use `.env.test`, never the real database.
3. Any check you added or changed has been seen failing: break the thing, watch it go red, restore it byte for byte, watch it go green.
4. Anything that touches the running system has been tried on it: the launchd API, the real daemon, the app over Tailscale.

## TypeScript

- **Never assume an array or record has the element you index.** `rows[0]`, `match[1]` and `map[key]` can be undefined. Code that reads `x.field` from a missing row fails far from the cause with a confusing error. Hit here (2026-10-11): 279 places read a query's first row without checking it. Enforced by `noUncheckedIndexedAccess`.
- **Read database rows with `one`, `maybe` or `many` from `server/db.ts`.** `one` throws with the name of the row it expected when none comes back, `maybe` returns undefined for the caller to handle, `many` returns them all. The choice says whether a missing row is a bug or a normal case. Hit here, as above. Enforced by `noUncheckedIndexedAccess` and review.
- **No `any`.** It switches off type checking for everything it touches, and it leaks from `JSON.parse`, `res.json()` and untyped SQL rows. Parse outside data at the boundary into a declared type. Known (typescript-eslint). Enforced by `no-explicit-any` and the `no-unsafe-*` rules. Checks may read rows loosely, since their asserts catch a wrong shape.
- **No `!` non-null assertions.** They tell the compiler to trust you and hide the missing case. Check and throw instead. Known (typescript-eslint). Enforced by `no-non-null-assertion`.
- **Only numbers, booleans and strings go in template strings.** An object prints `[object Object]`, and a stray undefined prints `undefined` into SQL, prompts and logs. Known (typescript-eslint). Enforced by `restrict-template-expressions`, `restrict-plus-operands` and `no-base-to-string`.
- **A `switch` on a union handles every member.** A new command kind or stage kind must not fall through silently. Known. Enforced by `switch-exhaustiveness-check` and `noFallthroughCasesInSwitch`.
- **A caught error is `unknown`.** Read its message with `error instanceof Error ? error.message : String(error)`. Known. Enforced by `strict` and `use-unknown-in-catch-callback-variable`.
- **No conditions that cannot change.** A null check on a value that is never null means the type or the logic is wrong. Known (typescript-eslint). Enforced by `no-unnecessary-condition`.
- **Erasable syntax only.** No enums, namespaces or parameter properties, since Node runs these files by stripping types. Hit here (2026-10-11), as the reason the flag is on. Enforced by `erasableSyntaxOnly`.
- **Use `===` and `!==`.** Known. Enforced by `eqeqeq`.
- **A flag that another async call changes is read through a function, or kept in a ref.** The compiler assumes a value it has just set cannot change across an `await`, so `while (again)` after `again = false` looks dead to it, and a stale copy looks current. Known (TypeScript issue 9998). Hit here (2026-10-12): the runner's re-run flag. Enforced by `no-unnecessary-condition`, which flags the dead-looking check.

## Types are the spec

The type system describes the whole system, defined once, in code. Code that compiles should be code that can't hold an impossible state.

- **TypeScript for everything we write.** That covers the server, daemon, app, CLIs, scripts and infrastructure, with AWS written in TypeScript through the AWS CDK or SDK. Shell appears only where a platform requires it, such as cloud-init or the colima provision block, kept to a few lines that call TypeScript. No Python or plain JavaScript files. Untyped glue is where shapes drift. Known. Enforced by review until the standards retrofit adds a check that fails on any new non-TypeScript file outside an allowlist.
- **One definition per shape.** A domain type lives once in `shared/`, and the server, daemon and app import it. A second hand-written copy drifts from the first. Seen here (2026-10-13): `app/src/data.ts` and `shared/types.ts` describe the same rows separately. Enforced by review until the retrofit.
- **Parse at every boundary, never cast.** HTTP bodies, query strings, env vars, `JSON.parse`, files, JSON columns, external APIs (Tailscale, GitHub, AWS, Claude) and anything an agent or a stage reports all go through a zod 4 schema. The type is `z.infer` of that schema, with no interface written beside it. Known. Enforced by the `no-unsafe-*` lint rules for `any`, and by review until the retrofit bans assertions on outside data.
- **No type assertions except `as const`.** `x as T` tells the compiler to trust you, and `as unknown as T` is never allowed. Known (typescript-eslint). Enforced by review until the retrofit turns on `consistent-type-assertions`.
- **Branded IDs.** `TeamId`, `PersonId`, `AgentId`, `SessionId`, `TaskId` and the rest are distinct types, so passing a task's id where a session's is expected fails to compile. Known. New tables use them now, and existing ones move in the retrofit.
- **Make illegal states unrepresentable.** A status or kind is a string-literal union. Data that exists in only one state lives in that state's branch of a discriminated union, and a lifecycle is a typed transition table. No two booleans that can both be true when that combination means nothing. Known. Enforced by `switch-exhaustiveness-check` and review.
- **Database row types come from the schema.** A generator reads the migrated test database and writes the table types, and a check fails when they are stale. Queries use those types instead of declaring their own. Seen here (2026-10-13): 135 queries declare their row types by hand, so renaming a column fails nothing. Until the retrofit lands, a new table's row type is declared once in `shared/`.
- **Required config is checked at startup.** One schema parses env vars and config files when the process starts, and a missing required value stops it with a message naming the value. No default quietly points somewhere real. Known. Enforced by review.

## Promises and async

- **Every promise is awaited, returned, or marked `void` with its errors handled.** A promise nobody waits for loses its error, or crashes the process later as an unhandled rejection. Known (typescript-eslint, Node). Enforced by `no-floating-promises`.
- **No async function where a plain callback is expected.** `onClick={async () => ...}`, `setInterval(async ...)` and `emitter.on('x', async ...)` drop the promise, so a thrown error reaches no one. Wrap the call and show or log its error. Known. Hit here: 32 places. Enforced by `no-misused-promises`.
- **No empty `catch`.** Say what is ignored and why in a comment, or handle it. Known. Enforced by `no-empty`.
- **Reject and throw `Error` objects only.** A thrown string has no stack. Known. Enforced by `only-throw-error` and `prefer-promise-reject-errors`.

## Postgres and SQL

- **Parameters, never string building, for values.** Every value goes in `$1`, `$2` and so on. Column names built from code are fine only from a fixed list. Known (OWASP). Enforced by review.
- **Order by something unique.** Rows that tie on `created_at` come back in any order. Rows written in one transaction share `now()`, so use `clock_timestamp()` or a serial id when order matters. Hit here (2026-10-11): two room turns queued in one transaction ran in random order. Enforced by review and the step 10 check.
- **Check-then-insert needs a lock or a unique constraint.** Two servers can both see "none yet" and both insert. Hit here (2026-10-11): two runners each made a box past the limit. Use a unique index, `on conflict`, `for update skip locked`, or `pg_advisory_xact_lock`. Enforced by review and the step 7 check.
- **A schema change is a new migration.** Never edit one that has run. Known. Enforced by review.

## Concurrency, retries and side effects

- **Nothing outside Postgres happens inside a transaction that can still roll back.** A container started, a pull request opened or a message sent survives the rollback. Write the intent as a row, commit, then act and record the result. Where an action must happen inside, make it safe to repeat: look up before creating, as `openPullRequest` does. Hit here (2026-10-11): a box container could outlive its rolled-back claim. Enforced by review and the step 7 check.
- **Every command and webhook is safe to run twice.** Daemons retry, webhooks repeat, and a crash replays work. Use client ids, `once` keys and "converge to this state" steps. Known. Hit here: duplicate webhook deliveries. Enforced by the step 6 and step 1 checks.
- **A background worker only touches the teams it serves.** Two servers on one database must not do each other's work. `AGENTS_RUNNER_TEAMS` scopes a runner, and checks set it. Hit here (2026-10-11): one check's runner created boxes for another check's runs. Enforced by the checks setting it.
- **Every timer, subscription, stream and child process has an owner that stops it.** Hit here (2026-10-11): the agent processes of finished runs. Enforced by the step 6 check.
- **A stream producer's id belongs to one process.** The durable stream server keeps each producer's last sequence number for a week and silently drops writes at or below it, so a restarted process that reuses an id loses what it writes. Add a random part to the id. Hit here (2026-10-12): live text after a daemon restart. Enforced by the step 3 check.
- **Every long-lived connection has an `error` listener, and so does the pool.** Node stops the process on an `error` event nobody listens for, and Postgres drops every connection when it restarts. Log it, replace the connection, carry on. Hit here (2026-10-12): the API crashed on each colima restart through the runner's LISTEN connection. Enforced by the step 2 check, which drops the API's connections.

## React and the app

- **Hooks run in the same order on every render.** No hook inside a condition, loop or early return. Known (React). Enforced by `react-hooks/rules-of-hooks`.
- **An effect lists everything it reads.** A missing dependency leaves the effect using stale values. Known (React). Enforced by `react-hooks/exhaustive-deps`.
- **An effect that subscribes, polls or opens a stream cleans up when the view goes.** Hit here (2026-10-11): Electric's `useShape` caches every live stream for the life of the page. After a few views the browser's six HTTP/1.1 connections were used up and the app stopped updating. `useRows` in `app/src/data.ts` shares one stream per shape and closes it when no view uses it. Enforced by the step 6b check, which counts open live connections.
- **No setting state in an effect when it can be derived during render.** It renders twice, and can loop. Known (React). Enforced by `react-hooks/set-state-in-effect`.
- **Lists have stable keys.** Known (React). Enforced by `react/jsx-key`.
- **No raw HTML.** Render agent text with `Markdown`, which builds elements and only follows http and https links. Known (OWASP, React). Enforced by `react/no-danger`.
- **Links that open a new tab carry `rel="noreferrer"`.** Known. Enforced by `react/jsx-no-target-blank`.
- **Every button has a `type`.** A button in a form without one submits the form. Known. Enforced by `react/button-has-type`.
- **No browser APIs that need a secure page.** The tailnet serves the app over plain HTTP, where `crypto.randomUUID` and others do not exist. Use `newId()`. Hit here (2026-10-11). Enforced by the step 4b check on an insecure origin.
- **At most five live shapes per page.** Browsers keep six HTTP/1.1 connections per server. Lists that change rarely use `useSnapshot`. Hit here (2026-10-11). Enforced by the step 4b and 6b checks.
- **A shape's filter never ORs two subqueries.** Electric 1.8.1 sends no row that moves into such a filter, so a row created after a view opened never arrives, or arrives as a partial update. Make one shape per subquery. Hit here (2026-10-12): a new task's session never reached the task page. Enforced by the step 2 check.
- **A page's grid has one `minmax(0, 1fr)` column and `max-content` rows.** An auto column grows to its widest child's minimum width, so one long select option or table pushes the page past a phone screen. And in a grid that overflows, a child that scrolls shrinks to zero height. Hit here (2026-10-12): the pipeline page on a phone. Enforced by the step 6b and 10b phone-width checks.

## Secrets and input

- **Secret values never enter Postgres, the record or a command payload.** Store names, and resolve values on the machine. Scrub everything written. Known. Enforced by the step 1, step 3 and step 10 checks.
- **Check every request body at the API's edge.** Turn outside data into typed values before any other code sees it. Known. Enforced by review and `no-unsafe-*`.
- **A person's identity comes only from Tailscale on the people port.** The machine port refuses it. Hit here (2026-10-11): a container could pose as a person. Enforced by the step 2 and step 2b checks.

## Node, scripts and the environment

- **Run with `~/.local/node/bin` first on the PATH.** `/usr/local/bin/node` on this Mac is another app's launcher, which cannot load native modules. Hit here (2026-10-11). Enforced by the launch agents and review.
- **`--env-file` files apply in order, later over earlier, and the real environment wins over both.** Checks load `.env` then `.env.test`. Hit here (2026-10-11). Enforced by `npm run check`.
- **A scripted edit asserts its anchor matches exactly once before it writes, and checks what it is about to change.** Config files repeat keys inside commented examples. A range a tool reports may include delimiters you did not expect, such as the braces of a JSX attribute, so check the first and last characters, not only that brackets balance. Hit here: the colima config (2026-10-11), and JSX handlers wrapped outside their braces (2026-10-12). Enforced by review.
- **Read full process command lines with `ps -ww`.** Without it, `ps` cuts long lines short. Hit here (2026-10-11). Enforced by review.
- **The product is Agents.** Code, paths, env vars, docs and UI text never use the name of the app we studied or an abbreviation of it, and the teammates the app runs are always called agents. They also never name a project, product, company or person we learned from, and describe the idea in our own words instead. A tool we install and run may be named where someone sets it up. The teardown in `research/` and rea's evidence in `docs/evidence/` may name the studied app. Hit here (2026-10-13): the old folder name leaked into the user guide. Enforced by `test/names.ts`, first in `npm run check`.

## No shortcuts

"It works now" isn't done. Each rule here blocks a way to get green without making the code right, and the framework's reviewers use this section as their rubric.

- **Fix the cause, not the symptom.** No retry, sleep, longer timeout, try/catch or fallback that makes a failure disappear before its mechanism is understood and shown with runtime evidence. A change that "might help" is a hypothesis, and it doesn't ship. Known. Enforced by review.
- **Never change a check to match broken behavior.** No weakened assertion, deleted or skipped check, or raised tolerance to get green. A check that is wrong gets fixed in its own change that says why. Known. Enforced by review, and by the framework's gate on edited checks.
- **No swallowed errors.** A catch handles a failure it names, or rethrows. No `.catch(() => {})`, and no logging and carrying on unless the code says which failure is expected and why carrying on is right. Known. Enforced by `no-empty` and review.
- **No silent fallbacks.** `?? ''`, `|| 0` and default branches don't paper over a value that should always exist. Missing required data throws with a message naming it. A display fallback for optional data is fine, and the code says so. Known. Enforced by review.
- **No test-only paths in product code.** No `if (process.env.TEST)` branches, and no hooks that only checks call. The one seam is a real boundary the design names, such as `AGENTS_CLAUDE_BIN` for the fake Claude harness. Known. Enforced by review.
- **Fakes only at real boundaries.** Claude, Tailscale, GitHub and AWS get fakes that speak their real protocol. The code under test is never mocked. Known. Enforced by review.
- **No special cases to pass a check.** Product code never matches a check's ids, strings or team names. Known. Enforced by review.
- **No second copy of logic.** Reuse or extract the first one, because two implementations of one idea drift apart. Known. Enforced by review.
- **No dead code, commented-out code or TODO in a merged change.** Delete it, or open it as tracked work. Known. Enforced by review until the retrofit turns on `no-warning-comments`.
- **No magic values.** Timeouts, limits, sizes and ports are named once, with the reason for the number. Known. Enforced by review.
- **No speculative generality.** No option, flag, layer or abstraction without a caller today. Known. Enforced by review.
- **No widening a type to silence an error.** An optional field that is always present, a union member nobody produces, or an `unknown` passed around is design friction, so redesign the shape. Known. Enforced by review.
- **No string-built commands, SQL or HTML.** Commands use `execFile` with an argument array, never a shell string. SQL uses parameters, and markup goes through React. Known. Enforced by review until the retrofit bans `exec` and `shell: true` in lint.
- **One concern per change, no drive-by edits.** A fix doesn't carry an unrelated refactor, and a refactor changes no behavior. Known. Enforced by review and the framework's diff-size gate.

## Checks

- **A check is trusted only after it has been seen failing.** Break the thing, watch the check go red, restore it byte for byte, watch it go green. Hit here: several checks passed with their feature broken until a break showed it. Enforced by review, and by `.scratch/breaks.py` for repeatable breaks.
- **A check uses its own team, its own database and its own runner scope,** and removes them when it passes. Enforced by `npm run check`, `.env.test` and `AGENTS_RUNNER_TEAMS`.
- **A check waits for a condition, never a fixed sleep.** Fixed sleeps are slow when things work and flaky when they do not. Known. Enforced by review.
- **A check asserts what a person or the next system sees, not only an internal row.** Hit here (2026-10-12): the missing-secret check looked at the failed command and passed while the app showed the agent thinking forever. Enforced by review.

## Lint settings

- `no-unused-vars` ignores fields named in a destructure only to leave them out of `...rest`, the usual way to drop fields from an object.
- No line may switch a rule off with an `eslint-disable` comment. Change the code, or change the rule here with the reason.

## Lint rules left off

These are in typescript-eslint's strict set but are about style, not bugs. Leaving them on would bury the findings that matter.

- `no-confusing-void-expression` flags `() => doThing()` shorthand.
- `require-await` flags async functions that happen not to await.
- `no-dynamic-delete` flags `delete env[name]`, which is how this code removes environment variables.
- `no-unnecessary-type-parameters` flags generics used once.
