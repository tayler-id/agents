# Agent setup

Anyone on the team sets up an agent from its page: its title, model and instructions, the skills it knows, the plugins (MCP servers) it may use, routines it runs on a schedule, and what it remembers. A template saves an agent's whole setup, and a new agent can start from it.

```json
{
  "id": "agent-setup",
  "name": "Agent setup",
  "paths": [
    "app/src/AgentPage.tsx",
    "server/agents.ts",
    "server/routines.ts",
    "daemon/agentfiles.ts"
  ],
  "checks": [
    "test/step10.ts",
    "test/step10b.ts"
  ]
}
```

## Sub-features

- `agent-new`: New agent from the sidebar, blank, with a name, its machine, a title and instructions.
- `agent-from-template`: New agent starting from a template, which copies the setup.
- `agent-profile`: title, model and instructions, saved from the agent's page.
- `agent-skills`: add a skill, and remove one.
- `agent-plugins`: add a plugin that names the secrets it needs (see secrets.md for what that does on the machine).
- `agent-routines`: add a routine, run it now, and it fires on its schedule.
- `agent-memory`: what the agent remembers about people and the team, written by its update_memory tool.
- `agent-template`: Save as template, which says the version it saved.

## How to get to it (user POV)

- Choose Agent setup in a DM's header to open the agent's page.
- Choose New agent in the sidebar.
- On an agent's page, edit the Profile form and choose Save. Open Add a skill, Add a plugin or Add a routine to add one, and choose Remove beside one to drop it.
- Choose Run now beside a routine. Choose Save as template in the page's header.

## Driving it with agentsctl

Preconditions:

- An instance from `bin/agentsctl up`, passing `bin/agentsctl doctor`.

- **Open an agent's page.** Run `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --name writer --within list:Agents`, `bin/agentsctl browser click --role button --name "Agent setup"` and `bin/agentsctl browser wait --role heading --name writer --within region:Agent`. writer's page opens on its profile.
- **Change the title, model and instructions.** Run `bin/agentsctl browser fill --role textbox --name Title --value "Docs writer"`, `bin/agentsctl browser fill --role textbox --name Model --value sonnet`, `bin/agentsctl browser fill --role textbox --name Instructions --value "You write docs. Keep them short."`, `bin/agentsctl browser click --role button --name Save --within form:Profile` and `bin/agentsctl browser wait --role status --text Saved`. The page says Saved, its header reads "Docs writer · sonnet", and the record has all three: `bin/agentsctl browser text --role region --name Agent --expect "Docs writer · sonnet"` and `bin/agentsctl db "select title, model, instructions from agents where team_id = {team} and name = 'writer'" --expect "title=Docs writer" --expect model=sonnet --expect "instructions=You write docs. Keep them short."`. The sidebar shows the title under writer's name: `bin/agentsctl browser wait --role button --name "writer Docs writer" --within list:Agents --timeout 15`.
- **Open fixer's page.** Run `bin/agentsctl browser click --role button --name fixer --within list:Agents` and `bin/agentsctl browser click --role button --name "Agent setup"`. The rest of this file sets fixer up.
- **Add a skill.** Run `bin/agentsctl browser click --role group --text "Add a skill"`, `bin/agentsctl browser fill --role textbox --name Name --within "form:Add a skill" --value release-notes`, `bin/agentsctl browser fill --role textbox --name "When to use it" --value "Writing release notes"`, `bin/agentsctl browser fill --role textbox --name "How to do it" --value "One line per merged pull request."`, `bin/agentsctl browser click --role button --name "Save skill"` and `bin/agentsctl browser wait --role listitem --text release-notes`. The skill is listed, and saved for fixer: `bin/agentsctl db "select s.description from skills s join agents a on a.id = s.agent_id where a.team_id = {team} and a.name = 'fixer' and s.name = 'release-notes'" --expect "description=Writing release notes"`.
- **Remove a skill.** Add a skill named scratch, then remove it. Run `bin/agentsctl browser fill --role textbox --name Name --within "form:Add a skill" --value scratch`, `bin/agentsctl browser fill --role textbox --name "When to use it" --value "Nothing"`, `bin/agentsctl browser fill --role textbox --name "How to do it" --value "Nothing."`, `bin/agentsctl browser click --role button --name "Save skill"`, `bin/agentsctl browser click --role button --name Remove --within listitem --within-text scratch` and `bin/agentsctl browser wait --role listitem --text scratch --gone`. scratch leaves the list and the record, and release-notes stays: `bin/agentsctl db "select string_agg(s.name, ',') as names from skills s join agents a on a.id = s.agent_id where a.team_id = {team} and a.name = 'fixer'" --expect names=release-notes`.
- **Add a plugin that names its secret.** Run `bin/agentsctl browser click --role group --text "Add a plugin"`, `bin/agentsctl browser fill --role textbox --name Name --within "form:Add a plugin" --value github`, `bin/agentsctl browser fill --role textbox --name Command --value "npx -y @modelcontextprotocol/server-github"`, `bin/agentsctl browser fill --role textbox --name "Environment from secrets, one per line" --value GITHUB_TOKEN=GITHUB_TOKEN`, `bin/agentsctl browser click --role button --name "Save plugin"` and `bin/agentsctl browser wait --role listitem --text "needs GITHUB_TOKEN on its machine"`. The plugin is listed with the secret its machine must hold. Remove it again so fixer keeps answering: `bin/agentsctl browser click --role button --name Remove --within listitem --within-text github` and `bin/agentsctl browser wait --role listitem --text "needs GITHUB_TOKEN" --gone`.
- **Add a routine and run it now.** Run `bin/agentsctl browser click --role group --text "Add a routine"`, `bin/agentsctl browser fill --role textbox --name Name --within "form:Add a routine" --value standup`, `bin/agentsctl browser fill --role textbox --name "What to do" --value "Say what is blocked."`, `bin/agentsctl browser click --role button --name "Save routine"`, `bin/agentsctl browser wait --role listitem --text "0 9 * * 1-5"` and `bin/agentsctl browser click --role button --name "Run now" --within listitem --within-text standup`. The agent's main conversation opens with the routine's prompt, from Routine, and the agent's reply: `bin/agentsctl browser wait --role listitem --text "Routine \"standup\": Say what is blocked." --within list:Messages` and `bin/agentsctl browser wait --role listitem --text "fake reply" --within list:Messages --timeout 30`. Capture the agent's page with `bin/agentsctl browser goto "#/a/$(bin/agentsctl db "select id from agents where team_id = {team} and name = 'fixer'" --value)"` and `bin/agentsctl visual shot agent-setup --ready-role listitem --ready-text standup`.
- **A routine fires on its schedule.** Add a routine that comes due every minute, wait for it, then remove it. Run `bin/agentsctl browser click --role group --text "Add a routine"`, `bin/agentsctl browser fill --role textbox --name Name --within "form:Add a routine" --value every-minute`, `bin/agentsctl browser fill --role textbox --name "Schedule (cron: minute hour day month weekday)" --value "* * * * *"`, `bin/agentsctl browser fill --role textbox --name "What to do" --value "Say the time."` and `bin/agentsctl browser click --role button --name "Save routine"`. Within two minutes the runner sends it: `bin/agentsctl db "select count(*)::int as n from messages m join conversations c on c.id = m.conversation_id where c.team_id = {team} and m.body = 'Routine \"every-minute\": Say the time.'" --wait 150 --expect n=1`. Then `bin/agentsctl browser click --role button --name Remove --within listitem --within-text every-minute` and `bin/agentsctl browser wait --role listitem --text every-minute --gone`.
- **The agent's memory shows on its page.** The agent writes memory with its update_memory tool, which calls the API as its machine. Run `bin/agentsctl api POST "/v1/record/memory?session=$(bin/agentsctl db "select s.id from sessions s join agents a on a.id = s.agent_id where a.team_id = {team} and a.name = 'fixer' order by s.created_at desc limit 1" --value)" --as machine --body "{\"kind\":\"profile\",\"about\":\"team\",\"content\":\"The team ships on Fridays.\"}"`, `bin/agentsctl browser goto "#/a/$(bin/agentsctl db "select id from agents where team_id = {team} and name = 'fixer'" --value)"` and `bin/agentsctl browser wait --role listitem --text "The team ships on Fridays." --within list:Memory --timeout 20`. What it remembers about the team shows under What it remembers.
- **Save the setup as a template.** Run `bin/agentsctl browser click --role button --name "Save as template"` and `bin/agentsctl browser wait --role status --text "Saved as the template \"fixer\", version 1."`. The record has the template with fixer's skill and routine: `bin/agentsctl db "select version, jsonb_array_length(recipe->'skills') as skills, jsonb_array_length(recipe->'routines') as routines from templates where team_id = {team} and name = 'fixer'" --expect version=1 --expect skills=1 --expect routines=1`.
- **Make a new agent from the template.** Run `bin/agentsctl browser click --role button --name "New agent"`, `bin/agentsctl browser fill --role textbox --name Name --within "form:New agent" --value fixer-two`, `bin/agentsctl browser select --role combobox --name "Start from" --option "The template \"fixer\", version 1"`, `bin/agentsctl browser click --role button --name "Create agent"`, `bin/agentsctl browser wait --role heading --name fixer-two --within region:Agent` and `bin/agentsctl browser wait --role listitem --text release-notes`. The new agent has the template's skill and instructions: `bin/agentsctl db "select instructions from agents where team_id = {team} and name = 'fixer-two'" --expect "instructions=You fix bugs."`.
- **Make a blank agent.** Run `bin/agentsctl browser click --role button --name "New agent"`, `bin/agentsctl browser wait --role form --name "New agent"`, `bin/agentsctl visual shot agent-new --ready-role form --ready-name "New agent"`, `bin/agentsctl browser fill --role textbox --name Name --within "form:New agent" --value reviewer`, `bin/agentsctl browser fill --role textbox --name Title --within "form:New agent" --value "Reviews pull requests"`, `bin/agentsctl browser fill --role textbox --name Instructions --within "form:New agent" --value "You review pull requests."`, `bin/agentsctl browser click --role button --name "Create agent"` and `bin/agentsctl browser wait --role button --name "reviewer Reviews pull requests" --within list:Agents --timeout 20`. reviewer opens on its page and joins the sidebar, its title under its name, living on the machine the form picked: `bin/agentsctl db "select i.name as machine from agents a join instances i on i.id = a.home_instance_id where a.team_id = {team} and a.name = 'reviewer'" --expect machine=mac`.
- **Check the agent page.** Run `bin/agentsctl browser a11y`, `bin/agentsctl browser console` and `bin/agentsctl browser tab-to --role button --name "Save as template"`. No accessibility violation, no console error, and the keyboard reaches the page's actions.

## Gotchas

- Add a skill, Add a plugin and Add a routine are disclosure sections, so each form opens with a click on its summary text: `--role group --text "Add a skill"`. Each form has a Name box, so scope it with `--within "form:<form name>"`.
- The skill, plugin and routine lists have no names. Find an item by its text, and its Remove button with `--within listitem --within-text <name>`.
- A plugin whose secret the machine lacks stops the agent on its next message. Remove the plugin after the step, or later features that message fixer see a stopped notice.
- A change to an agent reaches a running session on its next message, which restarts the session with the new setup. The fake harness shows no difference in its reply.
- A routine fires at most once a minute, when the runner looks. It sends to the agent's main conversation, made on first use, not to anyone's DM.
- Memory reaches a new session as part of its instructions. The fake harness ignores it, so proving the agent uses it needs real Claude.
- Agent names are lowercase letters, digits and dashes, unique on the team.
- An agent's sidebar row reads its name and then its title, so once writer has a title its button's name is "writer Docs writer". Find it by that full name, or with `--text writer` while no other agent's name holds "writer". This is why the profile change happens on writer: later files find fixer by its bare name.
