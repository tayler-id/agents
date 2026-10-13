# Journeys

Flows that cross several features and surfaces. They prove the multiplayer promise: what one person or agent does reaches everyone else as it happens, on the web and on the desktop. Read the linked files for each surface's handles first.

## Sub-features

- `watch-teammate`: a teammate opens a conversation someone else started, sees the agent's work arrive live, and opens its session.
- `desktop-and-web`: a post from the desktop app shows in the web app without a reload, and the reply shows in both.

## How to get to it (user POV)

- A teammate chooses someone else's conversation in the sidebar's Conversations list, then Session details.
- One person uses the desktop app while another, or the same person, has the web app open.

## Driving it with agentsctl

Preconditions:

- An instance from `bin/agentsctl up`, passing `bin/agentsctl doctor`, on the fake Claude harness.

- **A teammate watches an agent work.** ada messages improver in a DM while ben has it open. Run `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --name improver --within list:Agents`, `bin/agentsctl browser fill --role textbox --name Message --value "What changed in the last run?"`, `bin/agentsctl browser press Enter --role textbox --name Message`, `bin/agentsctl browser wait --role listitem --text "fake reply" --within list:Messages --timeout 30`, `bin/agentsctl browser goto / --as ben` and `bin/agentsctl browser click --role button --text "improver · ada" --within list:Conversations --as ben --timeout 15`. ben sees ada's DM with improver, labelled with ada's login, and ada's post. When ada posts again, ben's open view updates: `bin/agentsctl browser fill --role textbox --name Message --value "Anything else?"`, `bin/agentsctl browser press Enter --role textbox --name Message` and `bin/agentsctl browser wait --role listitem --text "Anything else?" --within list:Messages --as ben --timeout 30`. ben opens the session too: `bin/agentsctl browser click --role button --name "Session details" --as ben` and `bin/agentsctl browser wait --role listitem --text "Anything else?" --within list:Events --as ben --timeout 30`.
- **The desktop and web apps show one conversation.** With ada's web view on the DM, post from the desktop app. Run `bin/agentsctl browser goto /`, `bin/agentsctl browser click --role button --name improver --within list:Agents`, `bin/agentsctl desktop goto /`, `bin/agentsctl desktop click --role button --name improver --within list:Agents`, `bin/agentsctl desktop fill --role textbox --name Message --value "Sent from the desktop app"`, `bin/agentsctl desktop press Enter --role textbox --name Message` and `bin/agentsctl browser wait --role listitem --text "Sent from the desktop app" --within list:Messages --timeout 30`. The post reaches the web view without a reload, and the reply shows in both: `bin/agentsctl desktop count --role listitem --text "fake reply" --within list:Messages --expect 3 --timeout 30` and `bin/agentsctl browser count --role listitem --text "fake reply" --within list:Messages --expect 3 --timeout 30`.

## Gotchas

- A DM is shared with the team unless it is private, so a teammate sees it in Conversations, labelled with the agent and the people in it.
- Live views update through Electric. A view that opened before a row existed still receives it, which is what these steps prove. Lists the app polls, such as the sidebar's, take a few seconds.
- The desktop app and the browser are separate sessions with the same login. Each keeps its own page, so each command says which one it drives.
