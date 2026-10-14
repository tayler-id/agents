# Projects and repos

Tayler asked where the repos live, how many there are, how to start a new one, and how to keep them apart, and then said that everyone has to share repos. The answers, as built:

- **Where repos live.** Until now both repos were in the Gitea forge on this Mac, at `http://127.0.0.1:3001` in the organization `team`. A new project's repo lives on GitHub, under the organization or account its maker picks. Pipeline code stays on this Mac's forge, in `team/pipelines`.
- **How many there are.** Two today. `team/shop` is the small demo app with the planted bug that the bug-fix pipeline fixes, and `team/pipelines` holds the pipeline files. Each new project adds one GitHub repo, and a project can take more. The Repos page counts and lists them all.
- **How to start one.** Start a project. New project in the sidebar asks for a name, a line about it, and the teammates and agents who work on it. The app makes the GitHub repo with a README as its first commit, adds it to the team, opens the project's room and shows the project's page. The first time, the person connects GitHub by signing in, which takes a code typed on GitHub's site and nothing to set up.
- **How they stay apart.** A project owns its repos, its room, and the tasks, runs, documents and rooms made in it, and the sidebar shows each project's work under its name. Each task works in its own folder with its own clone on its own branch, so two tasks never share a checkout.
- **Who sees what.** Every repo belongs to the whole team. Everyone on the team sees and works in every project and every repo, and nobody has a repo of their own.
- **How to see them.** Repos in the sidebar opens a page with every repo, where it lives, its project, its open task branches and pull requests, and a link to it on its forge.

## What it solves

Nothing grouped a repo with the work done in it. A repo was a row with a URL, rooms and tasks sat in one long list each, and a new repo meant someone making it by hand on the forge. A project is the group. Making one makes its repo and its room, and everything started inside it carries the project's id, so the app shows one project's work together and apart from the next.

## The data

Everything below is in `server/migrations/0006_projects.sql`, and listed in `docs/data-model.md` for review. No GitHub token is in Postgres.

| Table or column | What it holds |
|---|---|
| `projects`, new | id, team, name, description, its room (`conversation_id`), who made it, when, and `archived_at`. A name is unique in a team among projects not archived. |
| `repo_requests`, new | A repo the app was asked to make on GitHub for a project: the project, the organization or account it goes under, the repo's name and description, `creating`, `done` or `failed`, the error, the repo row once made, and who asked. A repo is asked for once per team. |
| `repos.forge`, new | The forge that holds the repo, `gitea` for this Mac's or `github`. Existing rows are `gitea`. |
| `repos.project_id`, new | The project the repo belongs to. A repo belongs to one project or none. |
| `repos.polled_at`, new | When the GitHub worker last read the repo's issue events, so after a restart it carries on from there. |
| `tasks.project_id`, new | The project a task belongs to, and with it the task's runs and documents. |
| `conversations.project_id`, new | The project a room belongs to. Only a room can have one. |

Runs and documents get no column. A run belongs to its task and a document to its task, so both follow the task's project.

A task belongs to the project it was started in, and works only in that project's repos. A task started outside any project, and every pipeline run, takes the project of its first repo. Rows from before projects have no project and work as they did.

## States

A repo request is `creating`, `done` or `failed`.

- **creating.** The app is asking GitHub. Each try holds the request for 90 seconds, `CLAIM_SEC` in `server/projects.ts`. That covers the most calls a try makes, five, each given up after 15 seconds, and 15 seconds more for the Postgres and file work around them, so the GitHub worker never takes over a try that is still asking GitHub. A request still `creating` after that, for instance after an API restart in the middle of a try, is tried again on the worker's next round.
- **done.** The repo is on GitHub and in the team's `repos`, and the request points at it.
- **failed.** GitHub said no, did not answer within 15 seconds, or could not be reached, or the repo exists and the person who asked for it can't push to it. The request keeps GitHub's reason, such as a sign-in that may not create repos, and Try again on the project page sets it back to `creating`, now asked as the person who tried.

Only a failed request has a reason, and only a done one a repo. The database refuses any other mix, and `shared/projects.ts` types each state with only its own fields. Each try looks the repo up first and only creates it when it is missing, so a second try after a crash adopts the repo the first try made instead of making another.

## New project, step by step

1. A person fills in the form, naming the organization or account for the repo, or leaving it as their own account. The API checks the name, that the person's GitHub sign-in works, and that no repo of that name exists there yet. A taken name is refused with a hint to add that repo to a project instead.
2. One transaction writes the project, its room with the person, the chosen teammates and the chosen agents as members, and the repo request.
3. After the commit, the API claims the request in a transaction of its own, then asks GitHub for the repo as that person, with no transaction open and at most 15 seconds to answer. GitHub writes the first commit, a README with the repo's name and the project's description.
4. Another transaction adds the repo to the team's `repos` with the project's id and marks the request `done`, if no other try claimed the request in between.
5. The project's page opens. If step 3 failed, the project and its room exist, and the page says why the repo is missing and offers Try again.

A project can take more repos later. Add a repo on its page takes a name. A repo that already exists on GitHub is added as it is, if the person who adds it can push to it, and a missing one is made the way step 3 makes one. The same form can also move a team repo that belongs to no project, such as `team/shop`, into the project.

## Connecting GitHub

Tayler doesn't want everyone to set up a GitHub App to use Agents. The connection comes in three layers.

### Layer 1, Connect GitHub, built

Each person connects their own GitHub account with Connect GitHub on the Repos page or the New project page. The API asks GitHub for a code, the page shows it with a link to GitHub's device page, the person types it there and approves, and the API keeps the token GitHub then hands it. Nothing to register, nothing to paste.

- **Where the token lives.** In a file of the person's own under `AGENTS_GITHUB_DIR/people`, mode 600, in a folder made with mode 700. Never in Postgres, a log, a command, a box or a browser. The browser learns whether the person is signed in and as which GitHub account.
- **Whose token a call uses.** What a person does themselves, such as making a project, uses their own sign-in. What agents and the server do in a repo, such as cloning, pushing, opening and merging pull requests and polling issues, uses the sign-in of the person who brought that repo into its team's project, which `repo_requests.requested_by` records for that team's row of the repo. Two teams with the same GitHub repo each use their own person's sign-in, and their polls and Repos pages keep apart. Agents never hold it. They act through the API's git proxy and the API's own calls to GitHub.
- **Expiry.** The token lasts eight hours. The API renews it five minutes before it runs out with the refresh token, which lasts six months, one renewal at a time per person since a refresh token works once. When the refresh token runs out, the person is signed out and connects again.

**The client is a GitHub App, registered once by the Agents project, with the device flow on.** I compared it with an OAuth App.

| | GitHub App | OAuth App |
|---|---|---|
| Client secret on each server | None. The device flow sends only the public client id, and a token from the device flow renews without the secret. | None, for the same reasons. |
| What a token may do | Only what both the app and the person may do, on repos the app is installed on. | Everything the person can reach, through broad scopes such as `repo`. |
| Expiry | Eight hours, renewed for six months. | Long-lived unless the app opts in to expiring tokens. |
| Organizations | Not subject to an organization's policy on OAuth Apps. An owner installs the app on the organization once. | Subject to that policy, so an owner often approves it anyway. |
| GitHub's advice | Preferred. | For the few cases an app can't cover. |

The GitHub App wins on what a stolen token could do and for how long. Its cost is one install by each organization's owner, a few clicks on the app's page on GitHub, choosing all repositories so that repos the app makes later are covered. Until then GitHub answers that the sign-in can't see the repo, and the Repos page shows that answer. Sources: [user access tokens for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [refreshing them](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens), [authorizing OAuth Apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [GitHub Apps and OAuth Apps compared](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps).

When Tayler registers the app, it asks for these repository permissions and no others: Contents, Issues and Pull requests, each read and write, Metadata read, and Repository creation write so a project can make its repo. It asks for no workflows, actions, administration or members permissions. The device flow is turned on, and expiring user tokens stay on. Its client id goes in `AGENTS_GITHUB_CLIENT_ID`. Until it is set, sign-in is off and the pages say so.

### The stopgap token

Before anyone can sign in, an admin can give their team one fine-grained personal access token, from the Repos page or the server's command line:

```sh
pbpaste | node --env-file=.env server/admin.ts github-token <team> <organization or account>
```

The command reads the token from standard input, so it never shows in the process list or the shell history. The server takes only a fine-grained token, one that starts with `github_pat_`, since a classic token reaches every repo its account can. It checks the token with GitHub and keeps it in `AGENTS_GITHUB_DIR/stopgaps/<team id>.json`, mode 600. A call falls back to it only when the person or repo it is for has no sign-in, and only in that team. The server can't see a token's permissions, so the admin gives it the app's, for the organization's repositories only. It is a stopgap. Once people sign in, an admin deletes the file and revokes the token on GitHub.

### Layer 2, the team's own app, designed

A team that wants agents to have their own GitHub identity, for example on a repo that requires approvals from someone other than the author, installs an app of its own. Setup on a self-hosted server makes that app through GitHub's app manifest flow.

1. An admin clicks Create the team's GitHub App. The page posts a manifest naming the app's permissions and the server's address to GitHub's new-app page, for the admin's account or the organization, with an unguessable `state`.
2. The admin approves on GitHub, and GitHub sends them back with a code.
3. The server trades the code for the app's id, private key and webhook secret through `POST /app-manifests/{code}/conversions`, within the hour the code lasts, and keeps them in `AGENTS_GITHUB_DIR/app.json`, mode 600. The key never leaves the server.
4. The admin installs the app on the organization's repos.

For each job the server signs a short-lived token with the private key and trades it for an installation token scoped to the one repo and the permissions that job needs. The bug-fix agent gets contents, pull requests and issues write, and a reviewer gets contents read and pull requests write. The token lasts an hour at most and is dropped when the job ends. The app never gets workflows, actions, administration or members permissions. Pull requests and comments then show the app as their author, so a person's approval counts as someone else's. Making repos stays with a person's sign-in, since that needs a permission the app does not get. In code, `tokenFor` in `server/github-auth.ts` gains a third kind of who, an installation, and nothing else changes. Source: [registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).

### Layer 3, public repos, built

Anyone can open an issue or a pull request on a public repo, so on GitHub:

- **Who can ask for work.** A run starts only from a label that starts with `agent:`, such as `agent:fix`, put on an issue by someone with write, maintain or admin access, while the issue is open and still has the label. Taking the label off, or closing the issue, before the worker reads the label starts nothing. Triage access lets a person label issues, and it is not enough, as Tayler decided on 2026-10-13. The GitHub worker reads each label's sender from the repo's issue events and asks GitHub's collaborator permission call for their role, and the runner asks again before the run's pull request opens, so someone who drops to triage or less while a run works gets no pull request. Opening an issue starts nothing, and neither does `bug`, since an issue form puts its labels on for whoever opens the issue. A custom role never counts, since its name says nothing of what it allows.
- **Issue text is data.** The title reaches the agent quoted, on one line and cut at 120 characters, and the text quoted under a line that says it is a report from outside the team and not instructions. Other open issues' titles, which bug-fix lists to find duplicates, are cleaned and cut the same way. The text is cut at 20,000 characters and read in one pass, so no issue can hold the API. Fenced code and code spans stay as written, since GitHub shows them as written, and only what parses as an HTML tag goes. What a reader can't see goes too: HTML comments, invisible characters such as zero-width spaces and the tag block, image alt text, elements marked hidden or aria-hidden or hidden by their style, style, script, template and noscript elements, and link definitions. Comments on the issue are not passed at all. Nothing in an issue sets configuration, a command, a tool's arguments, a URL or a path.
- **Rules come from main.** Pipelines are read from the default branch of `team/pipelines`, and every workspace starts from the repo's default branch. Nothing is read from a pull request's branch.
- **Nothing internal reaches GitHub's API.** Every string the app sends GitHub's API, in pull requests, comments and repo descriptions, first loses links and names on this tailnet, private and loopback addresses, email addresses and secrets. Commits that machines push through the git proxy are not filtered, so what an agent writes into a commit reaches GitHub as written.
- **Polls cost little and lose nothing.** Each poll sends the ETag of the last answer it finished with, and an unchanged list comes back 304, which doesn't count against GitHub's hourly limit. A poll that fails partway, for instance when GitHub can't say who put a label on, keeps the old ETag, so the next poll reads the same labels again.

## GitHub as a forge

`server/github.ts` talks to GitHub's REST API, next to `server/forge.ts` for this Mac's Gitea. Both answer the same calls: open issues, one issue, comment, close an issue, open a pull request or find the open one for a branch, read one, merge one, list open pull requests and list branches. Each repo records its forge in `repos.forge`, and the runner asks `forgeFor(repo)` in `server/repos.ts` for the right one, so pipelines need no change. Every GitHub answer is parsed with a zod schema before any other code sees it.

- **Clone and push.** Machines clone and push GitHub repos through the API's git proxy, `/v1/git/<repo id>.git` on the machine port, as they do for this Mac's forge. The proxy checks that the repo is the machine's team's, then forwards to GitHub with the repo's sign-in as the password. The address it forwards to is built from the server's settings and the repo's owner and name, never taken from the URL in Postgres, so a token only ever goes to GitHub.
- **Branch rule.** Machines never push to a repo's default branch. For each push the proxy asks the forge which branch is the default now, since a repo's owner can change it, and keeps `repos.default_branch` up to date. It reads which branches the push updates before it forwards the push, and refuses the whole push if any of them is the default branch, including one that deletes it. GitHub protects branches of private repos only on paid plans, so on GitHub this rule is what keeps changes reaching main through pull requests. This Mac's forge also protects main itself. A task or run asks the forge the same way before its workspace is cloned, so after the default branch is renamed, a new workspace starts from the new name instead of failing to clone the old one, and a new run's pull request goes to the new name.
- **Pull requests.** Opening one first looks for an open pull request from the same branch, so a retried stage never opens two. Merging deletes the task branch afterwards, as this Mac's forge does.
- **Time limits.** Every call to GitHub's API and sign-in gives up after 15 seconds, `GITHUB_TIMEOUT_MS` in `server/github-auth.ts`, so a GitHub that hangs never holds a person, a repo request or the worker. Clones and pushes through the git proxy have no limit. The runner's own stages still call the forge inside the run's transaction, as they did for this Mac's forge, so a slow GitHub holds a run for at most those 15 seconds a call.
- **Issues.** GitHub can't send webhooks to this server, since only the tailnet reaches it. The GitHub worker polls instead, every minute (`AGENTS_GITHUB_POLL_SEC`), and only for repos whose team has a pipeline with a forge trigger. It reads the repo's issue events since `repos.polled_at`, under the rules of layer 3, and starts a run through the same `startIssueRuns` as the Gitea webhook, with the same once key, so reading a label twice starts one run.
- **Pull request changes.** Each poll also reads the pull requests the app opened on GitHub that it still has as open. One merged or closed on GitHub gets its new state on the task, so the run's page and the Repos page show it.
- **Later, webhooks.** If a minute of delay ever matters, GitHub can deliver webhooks to a small receiver on a public address, such as one Tailscale Funnel publishes, that accepts only signed POSTs and queues them for the API. The API itself and the people port must never be public.

### Settings

`AGENTS_GITHUB_DIR`, `AGENTS_GITHUB_API` and `AGENTS_GITHUB_GIT` go in the server's `.env` together. On this Mac they are the folder for tokens, `~/.agents-app/github` written out as a full path, then `https://api.github.com` and `https://github.com`. None has a default, so a process started without them, such as another check, never reaches GitHub or a token. Without them GitHub stays off and the pages name the settings to add, and setting only some stops the API at start with a message naming the rest. `AGENTS_GITHUB_CLIENT_ID` turns sign-in on. The checks point all of them at a fake GitHub and a folder of their own, and GitHub Enterprise would point them at its own host.

## API

On the people port:

- `GET /v1/github` says whether GitHub is set up, whether sign-in is on, the person's own sign-in with any code they are waiting on, and their team's stopgap account. Never a token.
- `POST /v1/github/sign-in` starts the person's sign-in and answers with the code to enter on GitHub.
- `POST /v1/github/sign-out` forgets the person's sign-in on this server.
- `POST /v1/github/token` with `{owner, token}` sets the admin's team's stopgap token, which must be fine-grained. Admins only.
- `GET /v1/repos` lists every repo of the team with where it lives, its link, its project's id and name, and its open pull requests and task branches as its forge reports them. Each forge's answer is kept for 30 seconds (`AGENTS_REPOS_CACHE_SEC`), however many people have the page open.
- `POST /v1/projects` with `{name, description, people, agents, owner?}` makes a project, its room and its repo.
- `POST /v1/projects/<id>/repos` with `{name, owner?}` adds a GitHub repo, made if missing, and with `{repoId}` moves a team repo with no project into the project.
- `POST /v1/repo-requests/<id>/retry` tries a failed request again, as the person who tries.
- `POST /v1/tasks`, and `POST /v1/conversations` for a room, take an optional `projectId`.

New shapes: `projects`, `repo_requests`, `task_repos` and `project_artifacts`. Everyone on the team reads all of them, under the task visibility rules that were already there.

## What each person sees

- **Sidebar.** New project sits with New task, New room and New agent. Projects lists each project, with its rooms, tasks and runs under it. Repos shows how many repos the team has and opens the Repos page. Conversations, Tasks and Runs keep only what belongs to no project.
- **New project.** A name, a line about it, the organization or account for the repo, and teammates and agents to add. It says where the repo will go, such as `acme/billing` on GitHub. Without a GitHub sign-in it offers Connect GitHub first.
- **A project's page.** What it is for, and its repos with their open pull requests and task branches. A repo still being made or one that failed shows with the reason and Try again. Then the people and agents in its room, its tasks with their repos, its runs, documents and rooms. Buttons open its room and start a task or a room in it, and a form starts a pipeline run on one of its repos.
- **New task in a project.** It offers only that project's repos.
- **A task's page.** Its project and its repos.
- **Repos.** One line on what the page is, the person's GitHub sign-in with Connect GitHub or the code to enter, and every repo. An admin also sees the stopgap form.

## Checks

- `test/step13.ts` runs the server against a fake GitHub, `test/fake-github.ts`, which answers the REST calls above, signs people in with the device flow, issues tokens that expire in minutes so the server renews them, lists issue events and roles, answers 304 to a repeated ETag, and serves git with `git http-backend` from bare repos on disk.
- `test/step13b.ts` drives the pages in Chromium, Firefox and WebKit, at desktop and phone width.
- `test/step13c.ts` runs the text filters with no services: hostile issues as long as GitHub allows, filtered in under a second each in a child that is stopped if it runs on, and every kind of hidden text, code and title.

## Follow-ups, in order

1. Register the Agents GitHub App as above and set its client id, so people can sign in on the real server.
2. Build layer 2, the team's own app through the manifest flow, with installation tokens per job.
3. Delete the stopgap token and its file once people sign in.
4. Webhooks through a small public receiver, if polling's minute ever matters.
5. Archiving a project, and moving a repo out of one.
