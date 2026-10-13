# Secrets

An agent's plugins name the secrets they need, and the values stay on the machine that runs the agent, in its environment or `~/.agents-app/secrets.json`. The record keeps names, never values. An agent whose machine lacks a value stops and says which secret to set and where. Anything an agent says that contains a known secret reaches the record and every viewer as `[secret:NAME]`.

```json
{
  "id": "secrets",
  "name": "Secrets",
  "paths": [
    "daemon/agentsd.ts",
    "shared/scrub.ts",
    "server/agents.ts"
  ],
  "checks": [
    "test/step10.ts",
    "test/step10b.ts"
  ]
}
```

## Sub-features

- `secret-named`: a plugin's environment or headers name secrets; the team's list of secret names grows, and no value is stored.
- `secret-missing`: an agent whose plugin needs a secret its machine lacks stops, naming the secret and where to set it.
- `secret-set`: once the value is on the machine, the agent answers on the next message.
- `secret-scrubbed`: a secret's value in an agent's reply reaches the record and the conversation as `[secret:NAME]`.

## How to get to it (user POV)

- On an agent's page, open Add a plugin and write `VARIABLE=SECRET_NAME` lines under Environment from secrets (or Headers from secrets for an HTTP server).
- On the machine that runs the agent, set the value in the daemon's environment or in `~/.agents-app/secrets.json`.
- The stopped notice in the conversation says which secret is missing.

## Driving it with agentsctl

Preconditions:

- An instance from `bin/agentsctl up`, passing `bin/agentsctl doctor`, on the fake Claude harness. Its agents repeat the value `verify-secret-0451` when asked "What is the token?".

- **A plugin names its secret.** Add an agent for this, give it a plugin, and look at the record. Run `bin/agentsctl seed agent keeper`, `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --name keeper --within list:Agents --timeout 15`, `bin/agentsctl browser click --role button --name "Agent setup"`, `bin/agentsctl browser click --role group --text "Add a plugin"`, `bin/agentsctl browser fill --role textbox --name Name --within "form:Add a plugin" --value github`, `bin/agentsctl browser fill --role textbox --name Command --value "npx -y @modelcontextprotocol/server-github"`, `bin/agentsctl browser fill --role textbox --name "Environment from secrets, one per line" --value GITHUB_TOKEN=GITHUB_TOKEN`, `bin/agentsctl browser click --role button --name "Save plugin"` and `bin/agentsctl browser wait --role listitem --text "needs GITHUB_TOKEN on its machine"`. The plugin keeps a reference to the secret, and the team's secrets list has its name, stored on the machine: `bin/agentsctl db "select p.config->'env'->'GITHUB_TOKEN'->>'secret' as ref from plugins p join agents a on a.id = p.agent_id where a.team_id = {team} and a.name = 'keeper'" --expect ref=GITHUB_TOKEN` and `bin/agentsctl db "select s.name, s.stored_in from secrets s join agents a on a.id = s.agent_id where a.team_id = {team} and a.name = 'keeper'" --expect name=GITHUB_TOKEN --expect stored_in=machine`.
- **A value in the form is refused.** A plugin's secret must be a name. Run `bin/agentsctl api POST "/v1/agents/$(bin/agentsctl db "select id from agents where team_id = {team} and name = 'keeper'" --value)/plugins" --body "{\"name\":\"leaky\",\"kind\":\"stdio\",\"config\":{\"command\":\"npx\",\"env\":{\"GITHUB_TOKEN\":\"ghp_not_a_name\"}}}" --expect 400 --expect-text "must name a secret"`.
- **A missing secret stops the agent.** Make sure the machine lacks the value, then message keeper. Run `bin/agentsctl secret unset GITHUB_TOKEN`, `bin/agentsctl browser click --role button --name Message --within region:Agent`, `bin/agentsctl browser fill --role textbox --name Message --value "Are you there?"`, `bin/agentsctl browser press Enter --role textbox --name Message` and `bin/agentsctl browser wait --role listitem --text "no value for GITHUB_TOKEN" --within list:Messages --timeout 30`. The notice says where to set it: `bin/agentsctl browser text --role listitem --text "no value for GITHUB_TOKEN" --within list:Messages --expect secrets.json`.
- **Set it on the machine, and the agent answers.** Run `bin/agentsctl secret set GITHUB_TOKEN --value verify-secret-0451`, `bin/agentsctl browser fill --role textbox --name Message --value "Try again."`, `bin/agentsctl browser press Enter --role textbox --name Message`, `bin/agentsctl browser wait --role listitem --text "fake reply" --within list:Messages --timeout 30` and `bin/agentsctl browser wait --role listitem --text "no value for GITHUB_TOKEN" --within list:Messages --gone`. keeper answers and the notice is gone.
- **The value never reaches the record.** Ask keeper to say it. Run `bin/agentsctl browser fill --role textbox --name Message --value "What is the token?"`, `bin/agentsctl browser press Enter --role textbox --name Message` and `bin/agentsctl browser wait --role listitem --text "[secret:GITHUB_TOKEN]" --within list:Messages --timeout 30`. The reply shows the secret's name in place of its value, and no message, event or raw line holds the value: `bin/agentsctl db "select (select count(*) from messages where team_id = {team} and body like '%verify-secret-0451%') + (select count(*) from events where team_id = {team} and text like '%verify-secret-0451%') + (select count(*) from raw_events r join sessions s on s.id = r.session_id where s.team_id = {team} and r.line::text like '%verify-secret-0451%') as found" --expect found=0` and `bin/agentsctl db "select count(*)::int as n from messages where team_id = {team} and body like '%[secret:GITHUB_TOKEN]%'" --expect n=1`.

## Gotchas

- `bin/agentsctl secret set` writes the instance's own machine's secrets.json, as a person would on their Mac. It never touches `~/.agents-app/secrets.json`.
- A value is scrubbed only once the machine holds it, and only when it is 8 characters or longer. Values in the daemon's environment are scrubbed when their variable's name looks secret, such as one ending in TOKEN or KEY.
- The daemon scrubs, then the API scrubs again, so live text, events, raw lines and posts all carry `[secret:NAME]`.
- A plugin's command never runs under the fake harness, which ignores the MCP config. The secret check happens before the harness starts, so the notice is real either way.
- Remove a plugin that needs a secret once a step is done with it, or every later message to that agent stops.
