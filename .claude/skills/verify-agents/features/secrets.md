# Secrets

An agent's plugins name the secrets they need, and the values stay on the machine that runs the agent, in its environment or `~/.agents-app/secrets.json`. The record keeps names, never values. An agent whose machine lacks a value stops and says which secret to set and where. Anything an agent says that contains a known secret reaches the record and every viewer as `[secret:NAME]`. A person can also set a value from the agent's page. The API sends it to the agent's machine over the machine's own connection and keeps only the name, where it is set and when.

```json
{
  "id": "secrets",
  "name": "Secrets",
  "paths": [
    "daemon/agentsd.ts",
    "daemon/agentfiles.ts",
    "daemon/control-link.ts",
    "shared/scrub.ts",
    "shared/secrets.ts",
    "server/agents.ts",
    "server/secrets.ts",
    "server/control.ts",
    "app/src/Secrets.tsx"
  ],
  "checks": [
    "test/step10.ts",
    "test/step10b.ts",
    "test/step25.ts",
    "test/step25b.ts"
  ]
}
```

## Sub-features

- `secret-named`: a plugin's environment or headers name secrets; the team's list of secret names grows, and no value is stored.
- `secret-missing`: an agent whose plugin needs a secret its machine lacks stops, naming the secret and where to set it.
- `secret-set`: once the value is on the machine, the agent answers on the next message.
- `secret-scrubbed`: a secret's value in an agent's reply reaches the record and the conversation as `[secret:NAME]`.
- `secret-listed`: an agent's page lists each secret its plugins name, and says where the app set it or that it did not.
- `secret-set-from-app`: a value set from the page goes to the agent's machine, and the record keeps only the name, the machine, who and when.
- `secret-teammate`: a teammate sees whose machine it is and gets no field, and the API refuses their value.
- `secret-remove`: Remove, after asking, takes the value off the machine.
- `secret-stopped`: a stopped machine says so and takes no value.

## How to get to it (user POV)

- On an agent's page, open Add a plugin and write `VARIABLE=SECRET_NAME` lines under Environment from secrets (or Headers from secrets for an HTTP server).
- On the machine that runs the agent, set the value in the daemon's environment or in `~/.agents-app/secrets.json`.
- The stopped notice in the conversation says which secret is missing.
- On an agent's page, under its profile, the Secrets list has a masked field for each secret its plugins name. Choose Set value, or Replace value and Remove once one is set.

## Driving it with agentsctl

Preconditions:

- An instance from `bin/agentsctl up`, passing `bin/agentsctl doctor`, on the fake Claude harness. Its agents repeat the value `verify-secret-0451` when asked "What is the token?".

- **A plugin names its secret.** Add an agent for this, give it a plugin, and look at the record. Run `bin/agentsctl seed agent keeper`, `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --name keeper --within list:Agents --timeout 15`, `bin/agentsctl browser click --role button --name "Agent setup"`, `bin/agentsctl browser click --role group --text "Add a plugin"`, `bin/agentsctl browser fill --role textbox --name Name --within "form:Add a plugin" --value github`, `bin/agentsctl browser fill --role textbox --name Command --value "npx -y @modelcontextprotocol/server-github"`, `bin/agentsctl browser fill --role textbox --name "Environment from secrets, one per line" --value GITHUB_TOKEN=GITHUB_TOKEN`, `bin/agentsctl browser click --role button --name "Save plugin"` and `bin/agentsctl browser wait --role listitem --text "needs GITHUB_TOKEN on its machine"`. The plugin keeps a reference to the secret, and the team's secrets list has its name, stored on the machine: `bin/agentsctl db "select p.config->'env'->'GITHUB_TOKEN'->>'secret' as ref from plugins p join agents a on a.id = p.agent_id where a.team_id = {team} and a.name = 'keeper'" --expect ref=GITHUB_TOKEN` and `bin/agentsctl db "select s.name, s.stored_in from secrets s join agents a on a.id = s.agent_id where a.team_id = {team} and a.name = 'keeper'" --expect name=GITHUB_TOKEN --expect stored_in=machine`.
- **A value in the form is refused.** A plugin's secret must be a name. Run `bin/agentsctl api POST "/v1/agents/$(bin/agentsctl db "select id from agents where team_id = {team} and name = 'keeper'" --value)/plugins" --body "{\"name\":\"leaky\",\"kind\":\"stdio\",\"config\":{\"command\":\"npx\",\"env\":{\"GITHUB_TOKEN\":\"ghp_not_a_name\"}}}" --expect 400 --expect-text "must name a secret"`.
- **A missing secret stops the agent.** Make sure the machine lacks the value, then message keeper. Run `bin/agentsctl secret unset GITHUB_TOKEN`, `bin/agentsctl browser click --role button --name Message --within region:Agent`, `bin/agentsctl browser fill --role textbox --name Message --value "Are you there?"`, `bin/agentsctl browser press Enter --role textbox --name Message` and `bin/agentsctl browser wait --role listitem --text "no value for GITHUB_TOKEN" --within list:Messages --timeout 30`. The notice says where to set it: `bin/agentsctl browser text --role listitem --text "no value for GITHUB_TOKEN" --within list:Messages --expect secrets.json`.
- **Set it on the machine, and the agent answers.** Run `bin/agentsctl secret set GITHUB_TOKEN --value verify-secret-0451`, `bin/agentsctl browser fill --role textbox --name Message --value "Try again."`, `bin/agentsctl browser press Enter --role textbox --name Message`, `bin/agentsctl browser wait --role listitem --text "fake reply" --within list:Messages --timeout 30` and `bin/agentsctl browser wait --role listitem --text "no value for GITHUB_TOKEN" --within list:Messages --gone`. keeper answers and the notice is gone.
- **The value never reaches the record.** Ask keeper to say it. Run `bin/agentsctl browser fill --role textbox --name Message --value "What is the token?"`, `bin/agentsctl browser press Enter --role textbox --name Message` and `bin/agentsctl browser wait --role listitem --text "[secret:GITHUB_TOKEN]" --within list:Messages --timeout 30`. The reply shows the secret's name in place of its value, and no message, event or raw line holds the value: `bin/agentsctl db "select (select count(*) from messages where team_id = {team} and body like '%verify-secret-0451%') + (select count(*) from events where team_id = {team} and text like '%verify-secret-0451%') + (select count(*) from raw_events r join sessions s on s.id = r.session_id where s.team_id = {team} and r.line::text like '%verify-secret-0451%') as found" --expect found=0` and `bin/agentsctl db "select count(*)::int as n from messages where team_id = {team} and body like '%[secret:GITHUB_TOKEN]%'" --expect n=1`.

- **The page lists the secret, not set from the app.** Open keeper's page. Run `bin/agentsctl browser goto "#/a/$(bin/agentsctl db "select id from agents where team_id = {team} and name = 'keeper'" --value)"`, `bin/agentsctl browser wait --role listitem --text "Not set from the app on mac" --timeout 30` and `bin/agentsctl visual shot agent-secrets-not-set --ready-role listitem --ready-text "Not set from the app on"`. The machine holds the value from the step before, and it works, but the app has no record of putting it there: `bin/agentsctl db "select count(*)::int as n from secret_sets where team_id = {team}" --expect n=0`.
- **Set it from the app.** The masked field has no ARIA role, since Playwright gives a password field none, so agentsctl cannot fill it. This step posts to the route the page's form posts to, and `test/step25b.ts` types into the field in three browsers. Run `bin/agentsctl api POST "/v1/secrets/$(bin/agentsctl db "select s.id from secrets s join agents a on a.id = s.agent_id where a.team_id = {team} and a.name = 'keeper' and s.name = 'GITHUB_TOKEN'" --value)/value" --body '{"value":"verify-secret-from-app-0451"}' --expect-text GITHUB_TOKEN`, `bin/agentsctl browser wait --role listitem --text "Set on mac" --timeout 30`, `bin/agentsctl browser text --role listitem --text "Set on mac" --expect "Replace value"`, `bin/agentsctl machine read secrets.json --expect-text GITHUB_TOKEN` and `bin/agentsctl visual shot agent-secrets-set --ready-role listitem --ready-text "Set on mac"`. The row says where, when and by whom, and the record names ada: `bin/agentsctl db "select count(*)::int as n from secret_sets where team_id = {team} and name = 'GITHUB_TOKEN' and set_by = {owner}" --expect n=1`.
- **The value set from the app is in no table.** The machine holds it, and the record holds no copy in a message, event, command or raw line. Run `bin/agentsctl db "select (select count(*) from messages where team_id = {team} and body like '%verify-secret-from-app-0451%') + (select count(*) from events where team_id = {team} and (text like '%verify-secret-from-app-0451%' or body::text like '%verify-secret-from-app-0451%')) + (select count(*) from commands where team_id = {team} and payload::text like '%verify-secret-from-app-0451%') + (select count(*) from raw_events r join sessions s on s.id = r.session_id where s.team_id = {team} and r.line::text like '%verify-secret-from-app-0451%') as found" --expect found=0`.
- **A teammate sees whose machine it is.** Run `bin/agentsctl browser goto "#/a/$(bin/agentsctl db "select id from agents where team_id = {team} and name = 'keeper'" --value)" --as ben`, `bin/agentsctl browser wait --role paragraph --text "so only they can set a value on it" --as ben --timeout 30`, `bin/agentsctl browser count --role form --name "Replace GITHUB_TOKEN" --expect 0 --as ben` and `bin/agentsctl visual shot agent-secrets-teammate --as ben --ready-role paragraph --ready-text "so only they can set a value on it"`. The API refuses ben too: `bin/agentsctl api POST "/v1/secrets/$(bin/agentsctl db "select s.id from secrets s join agents a on a.id = s.agent_id where a.team_id = {team} and a.name = 'keeper' and s.name = 'GITHUB_TOKEN'" --value)/value" --login ben --body '{"value":"verify-secret-by-ben-0451"}' --expect 403 --expect-text "teammate's own computer"`.
- **Remove it from the page.** Run `bin/agentsctl browser goto "#/a/$(bin/agentsctl db "select id from agents where team_id = {team} and name = 'keeper'" --value)"`, `bin/agentsctl browser click --role button --name Remove --within listitem --within-text "For the github plugin"`, `bin/agentsctl browser click --role button --name "Yes, remove"` and `bin/agentsctl browser wait --role listitem --text "Not set from the app on mac" --timeout 30`. The machine no longer holds it, and the record forgets where it was: `bin/agentsctl machine read secrets.json --expect-text "{}"` and `bin/agentsctl db "select count(*)::int as n from secret_sets where team_id = {team}" --expect n=0`.
- **A stopped machine says so and takes no value.** Make an agent on a box nobody has started, with a plugin that needs a secret. Run `bin/agentsctl seed box idle-box`, `bin/agentsctl api POST /v1/agents --body "{\"name\":\"sleeper\",\"homeInstanceId\":\"$(bin/agentsctl db "select id from instances where team_id = {team} and name = 'idle-box'" --value)\"}"` and `bin/agentsctl api POST "/v1/agents/$(bin/agentsctl db "select id from agents where team_id = {team} and name = 'sleeper'" --value)/plugins" --body "{\"name\":\"jira\",\"kind\":\"stdio\",\"config\":{\"command\":\"npx\",\"args\":[\"-y\",\"jira-mcp\"],\"env\":{\"JIRA_TOKEN\":{\"secret\":\"JIRA_TOKEN\"}}}}"`. Then run `bin/agentsctl browser goto "#/a/$(bin/agentsctl db "select id from agents where team_id = {team} and name = 'sleeper'" --value)"`, `bin/agentsctl browser text --role listitem --text "idle-box is stopped" --expect "Set it once the computer is running"` and `bin/agentsctl visual shot agent-secrets-stopped --ready-role paragraph --ready-text "idle-box is stopped"`. The API refuses a value for it, and keeps nothing for when it starts: `bin/agentsctl api POST "/v1/secrets/$(bin/agentsctl db "select s.id from secrets s join agents a on a.id = s.agent_id where a.team_id = {team} and a.name = 'sleeper' and s.name = 'JIRA_TOKEN'" --value)/value" --body '{"value":"verify-secret-stopped-0451"}' --expect 409 --expect-text "is stopped"` and `bin/agentsctl db "select count(*)::int as n from secret_sets where team_id = {team}" --expect n=0`.

## Gotchas

- `bin/agentsctl secret set` writes the instance's own machine's secrets.json, as a person would on their Mac. It never touches `~/.agents-app/secrets.json`.
- A value is scrubbed only once the machine holds it, and only when it is 8 characters or longer. Values in the daemon's environment are scrubbed when their variable's name looks secret, such as one ending in TOKEN or KEY.
- The daemon scrubs, then the API scrubs again, so live text, events, raw lines and posts all carry `[secret:NAME]`.
- A plugin's command never runs under the fake harness, which ignores the MCP config. The secret check happens before the harness starts, so the notice is real either way.
- Remove a plugin that needs a secret once a step is done with it, or every later message to that agent stops.
- agentsctl cannot fill the masked field. Playwright gives an input of type password no ARIA role, so `--role textbox` never finds it. The set step posts to the route the page posts to, and `test/step25b.ts` types into the field by its label in Chromium, Firefox and WebKit.
- `visual shot` of any agent page logs one console error in WebKit, "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive", so `map run --visual` reports those captures as having a problem. It was seen on main on 2026-10-16, on a page with no secrets. A `<select>` under the page's `style-src 'self'` causes it, and the plugin form on every agent page has one. Chromium and Firefox pass, and every capture is still taken. The steps turn green when it is fixed.
- A capture is one screen, and an agent's page scrolls inside its body, so the Secrets list sits under the profile where a capture shows it.
- `machine read` prints a value the machine holds as `[secret:NAME]`, so it shows that the file holds a value and never which one.
- The steps after "Set it from the app" use the value it sets. Run them in order on one instance, and remove sleeper and idle-box with `bin/agentsctl down`.
