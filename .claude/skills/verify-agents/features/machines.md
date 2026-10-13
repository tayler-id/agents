# Machines and boxes

The sidebar's Machines list shows each machine on the team: the Macs that run agents and the boxes, Docker containers that run the daemon for unattended work. A person claims a free box to keep it, and releases it to give it back. A box a run holds says so, and one a teammate holds names them.

```json
{
  "id": "machines",
  "name": "Machines and boxes",
  "paths": [
    "server/boxes.ts",
    "app/src/App.tsx"
  ],
  "checks": [
    "test/step2b.ts",
    "test/step7.ts"
  ]
}
```

## Sub-features

- `machine-list`: each machine with a status dot and whether it is online.
- `box-claim`: Claim on a free box makes it yours, and Release shows.
- `box-release`: Release gives it back, and Claim shows again.
- `box-holder`: a teammate sees who holds a box, with no Claim button.
- `box-on-run`: a box a run holds says "on a run".

## How to get to it (user POV)

- Look at the Machines list at the bottom of the sidebar, or behind Menu on a phone.
- Choose Claim or Release beside a box.

## Driving it with agentsctl

Preconditions:

- An instance from `bin/agentsctl up`, passing `bin/agentsctl doctor`. Its machine is named mac. A box is added with `bin/agentsctl seed box <name>`.

- **The machine is online.** Run `bin/agentsctl browser goto /` and `bin/agentsctl browser text --role listitem --text mac --within list:Machines --expect online`. The machine that runs the instance's agents shows online, since its daemon reports in: `bin/agentsctl db "select status from instances where id = {machine}" --expect status=online`.
- **A box shows as free.** Run `bin/agentsctl seed box box1` and `bin/agentsctl browser wait --role listitem --text "box1 (box)" --within list:Machines --timeout 15`. The box is listed with a Claim button.
- **Claim it.** Run `bin/agentsctl browser click --role button --name Claim --within listitem --within-text "box1 (box)"` and `bin/agentsctl browser wait --role button --name Release --within listitem --within-text "box1 (box)" --timeout 15`. The box is yours: `bin/agentsctl db "select (claimed_by = {owner}) as mine from instances where team_id = {team} and name = 'box1'" --expect mine=true`.
- **A teammate sees who holds it.** Run `bin/agentsctl browser goto / --as ben` and `bin/agentsctl browser text --role listitem --text "box1 (box)" --within list:Machines --as ben --expect ada-`. ben sees ada's login in place of a button: `bin/agentsctl browser count --role button --name Claim --within listitem --within-text "box1 (box)" --as ben --expect 0`.
- **Release it.** Run `bin/agentsctl browser click --role button --name Release --within listitem --within-text "box1 (box)"` and `bin/agentsctl browser wait --role button --name Claim --within listitem --within-text "box1 (box)" --timeout 15`. It is free again: `bin/agentsctl db "select claimed_by is null as free from instances where team_id = {team} and name = 'box1'" --expect free=true`.
- **A box someone else holds cannot be claimed.** Claim it as ben through the API, then try as ada. Run `bin/agentsctl api POST "/v1/instances/$(bin/agentsctl db "select id from instances where team_id = {team} and name = 'box1'" --value)/claim" --login ben` and `bin/agentsctl api POST "/v1/instances/$(bin/agentsctl db "select id from instances where team_id = {team} and name = 'box1'" --value)/claim" --expect 409 --expect-text "taken"`. Then give it back: `bin/agentsctl api POST "/v1/instances/$(bin/agentsctl db "select id from instances where team_id = {team} and name = 'box1'" --value)/release" --login ben`.

## Gotchas

- Claiming a box makes the instance's runner start its container from the agents-box image. The container cannot reach an instance's port, since the box firewall lets containers reach only the live API's port, so the box stays offline. `bin/agentsctl down` removes the container and its home volume by their exact names.
- A box held by a run says "on a run". Pipelines that run on boxes need that reach, so an instance runs bug-fix on its home machine and this state stays unreachable here.
- The Machines list refreshes every 5 seconds, so a new box or a change of holder takes that long to show.
- The machine shows online for as long as its daemon heartbeats, every 15 seconds. A daemon that stops leaves the machine stale and then offline.
