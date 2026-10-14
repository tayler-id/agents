---
name: verify
description: How to check that a feature of Agents works the way a person uses it. Use when verifying a change, a Done means item or a Keep item, and when confirming a fix against the report it came from. Lists each feature, the checks that cover it, and what to look at.
---

# Verify Agents

The feature map beside this file, `features.json`, lists each feature with its id, the paths it lives in, and the checks that cover it. A plan's Keep items name these ids. When a change touches a feature's paths, that feature's checks are its regression.

## Launch

Every check starts what it needs: its own API on test ports, a daemon with a temporary home, and the test database and Electric from `.env.test`. Nothing here starts or touches the live server.

- In a box, run checks marked `// runs-in: box` with `node test/<file>.ts`. They need no database, forge or Docker.
- On the check host, run the others with `node --env-file=.env --env-file=.env.test test/<file>.ts`.

## Doctor

Before trusting a result, confirm the check can run here: `node --version` is 24 or later, `node_modules` resolves, and for host checks the test database answers. A check that cannot start is verifier-blocked, not failed.

## Drive

For each Done means item, run the check it names and read its output, not only its exit code. For each Keep item, run its feature's checks from the map. For a bug, read the original report again and confirm the change fixes what it describes, with the reproducing check failing on main and passing on the change.

Views are driven in chromium, firefox and webkit at desktop and phone width. Until `agentsctl` lands, that happens only on the check host through the existing Playwright checks, so a verifier in a box reports a UI change as verifier-blocked.

## Evidence

List every command you ran. The runner reads them from the record, and a verdict whose commands do not show it is not trusted. Report one verdict from the ladder: live-ui-verified, unit-test-verified, type-check-only, verifier-blocked or verifier-failed.

## Cleanup

Checks remove their test teams, forge repos and containers when they pass, and keep them when they fail so a person can look. Never edit the change you are verifying.
