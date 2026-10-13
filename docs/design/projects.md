# Projects and repos

Tayler asked where the repos live, how many there are, how to start a new one, and how to keep them apart, and then said that everyone has to share repos. The answers, as built:

- **Where repos live.** Until now both repos were in the Gitea forge on this Mac, at `http://127.0.0.1:3001` in the organization `team`. A new project's repo lives on GitHub, under the organization or account Tayler connects. Pipeline code stays on this Mac's forge, in `team/pipelines`.
- **How many there are.** Two today. `team/shop` is the small demo app with the planted bug that the bug-fix pipeline fixes, and `team/pipelines` holds the pipeline files. Each new project adds one GitHub repo, and a project can take more. The Repos page counts and lists them all.
- **How to start one.** Start a project. New project in the sidebar asks for a name, a line about it, and the teammates and agents who work on it. The app makes the GitHub repo with a README as its first commit, adds it to the team, opens the project's room and shows the project's page.
- **How they stay apart.** A project owns its repos, its room, and the tasks, runs, documents and rooms made in it, and the sidebar shows each project's work under its name. Each task works in its own folder with its own clone on its own branch, so two tasks never share a checkout.
- **Who sees what.** Every repo belongs to the whole team. Everyone on the team sees and works in every project and every repo, and nobody has a repo of their own.
- **How to see them.** Repos in the sidebar opens a page with every repo, where it lives, its project, its open task branches and pull requests, and a link to it on its forge.

## What it solves

Nothing grouped a repo with the work done in it. A repo was a row with a URL, rooms and tasks sat in one long list each, and a new repo meant someone making it by hand on the forge. A project is the group. Making one makes its repo and its room, and everything started inside it carries the project's id, so the app shows one project's work together and apart from the next.

## The data

Everything below is in `server/migrations/0006_projects.sql`, and listed in `docs/data-model.md` for review.

| Table or column | What it holds |
|---|---|
| `projects`, new | id, team, name, description, its room (`conversation_id`), who made it, when, and `archived_at`. A name is unique in a team among projects not archived. |
| `repo_requests`, new | A repo the app was asked to make on GitHub for a project: the project, the organization or account it goes under, the repo's name and description, `creating`, `done` or `failed`, the error, the repo row once made, and who asked. A repo is asked for once per team. |
| `repos.forge`, new | The forge that holds the repo, `gitea` for this Mac's or `github`. Existing rows are `gitea`. |
| `repos.project_id`, new | The project the repo belongs to. A repo belongs to one project or none. |
| `repos.polled_at`, new | When the runner last asked GitHub about the repo's issues, so after a restart it carries on from there. |
| `tasks.project_id`, new | The project a task belongs to, and with it the task's runs and documents. |
| `conversations.project_id`, new | The project a room belongs to. Only a room can have one. |

Runs and documents get no column. A run belongs to its task and a document to its task, so both follow the task's project.

A task belongs to the project it was started in, and works only in that project's repos. A task started outside any project, and every pipeline run, takes the project of its first repo. Rows from before projects have no project and work as they did.

## States

A repo request is `creating`, `done` or `failed`.

- **creating.** The app is asking GitHub. A request left in `creating`, for instance by an API restart in the middle of one, is picked up again by the GitHub worker after 30 seconds.
- **done.** The repo is on GitHub and in the team's `repos`, and the request points at it.
- **failed.** GitHub said no, or could not be reached. The request keeps GitHub's reason, such as an expired token or a token that may not create repos, and Try again on the project page sets it back to `creating`.

Only a failed request has a reason, and only a done one a repo. The database refuses any other mix, and `shared/projects.ts` types each state with only its own fields.

Each try looks the repo up first and only creates it when it is missing. A second try after a crash adopts the repo the first try made instead of making another.

## New project, step by step

1. A person fills in the form. The API checks the name, that GitHub is connected, and that no repo of that name exists yet under the connected organization. A taken name is refused with a hint to add that repo to a project instead.
2. One transaction writes the project, its room with the person, the chosen teammates and the chosen agents as members, and the repo request.
3. After the commit, the API asks GitHub for the repo. GitHub writes the first commit, a README with the repo's name and the project's description.
4. A second transaction adds the repo to the team's `repos` with the project's id and marks the request `done`.
5. The project's page opens. If step 3 failed, the project and its room exist, and the page says why the repo is missing and offers Try again.

A project can take more repos later. Add a repo on its page takes a name under the connected organization. A repo that already exists on GitHub is added as it is, and a missing one is made the way step 3 makes one. The same form can also move a team repo that belongs to no project, such as `team/shop`, into the project.

## GitHub as a forge

`server/github.ts` talks to GitHub's REST API, next to `server/forge.ts` for this Mac's Gitea. Both answer the same calls: open issues, one issue, comment, close an issue, open a pull request or find the open one for a branch, read one, merge one, list open pull requests and list branches. Each repo records its forge in `repos.forge`, and the runner asks `forgeFor(repo)` in `server/repos.ts` for the right one, so pipelines need no change. Every GitHub answer is parsed with a zod schema before any other code sees it.

- **Clone and push.** Machines clone and push GitHub repos through the API's git proxy, `/v1/git/<repo id>.git` on the machine port, as they do for this Mac's forge. The proxy checks that the repo is the machine's team's, then forwards to GitHub with the token as the password. The address it forwards to is built from the server's settings and the repo's owner and name, never taken from the URL in Postgres, so the token only ever goes to GitHub. A machine holds only its own instance token.
- **Branch rule.** Machines never push to a repo's default branch. The proxy reads which branches a push updates before it forwards the push, and refuses one that names the default branch. GitHub protects branches of private repos only on paid plans, so on GitHub this rule is what keeps changes reaching main through pull requests. This Mac's forge also protects main itself.
- **Pull requests.** Opening one first looks for an open pull request from the same branch, so a retried stage never opens two. Merging deletes the task branch afterwards, as this Mac's forge does.
- **Issues.** GitHub can't send webhooks to this server, since only the tailnet reaches it. The GitHub worker polls instead, every minute (`AGENTS_GITHUB_POLL_SEC`), and only for repos whose team has a pipeline with a forge trigger. It asks for open issues updated since `repos.polled_at`, and looks only at issues opened after the repo joined the team. Such an issue starts a run of each pipeline whose trigger it matches, with the same once key as the Gitea webhook, so polling it twice starts one run.
- **Pull request changes.** Each poll also reads the pull requests the app opened on GitHub that it still has as open. One merged or closed on GitHub gets its new state on the task, so the run's page and the Repos page show it.
- **Later, webhooks through Tailscale Funnel.** Funnel can publish one path of this Mac to the internet. Serving only `/v1/hooks/github` there, checked against a webhook secret, would let GitHub send issue and pull request events as they happen, and polling would only catch up after downtime. The people port must never be on Funnel.

## The GitHub credential

An admin connects GitHub once, from the Repos page or from the server's command line:

```sh
pbpaste | node --env-file=.env server/admin.ts github <organization or account>
```

The command reads the token from standard input, so it never shows in the process list or the shell history.

- The API checks the token with GitHub, by asking who it belongs to and then for the organization, and writes `~/.agents-app/github.json` with mode 600, making its folder with mode 700 if it is missing. The file holds the token, the account it belongs to, the organization or account that repos go under, and when it was saved.
- The token goes nowhere else. It never enters Postgres, a log, a command payload or a browser. The browser learns whether GitHub is connected, the account and the organization. The API reads the file each time it needs the token, so a new token works without a restart.
- Only an admin may set it. `people.role` already has `admin` and `member`. `admin.ts add-team` now makes the team's first person its admin, and `admin.ts make-admin <login>` makes another.
- Three settings in the server's `.env` say where GitHub is and where its token is kept, and they are set together. On this Mac they are `AGENTS_GITHUB_FILE=~/.agents-app/github.json` written out in full, `AGENTS_GITHUB_API=https://api.github.com` and `AGENTS_GITHUB_GIT=https://github.com`. None has a default, so a process started without them, such as another check, never reaches GitHub or the token. Without them GitHub stays off, and the Repos page and New project name the settings to add. Setting only some of them stops the API at start with a message naming the rest. The checks point them at a fake GitHub server and a file of their own, and GitHub Enterprise would point them at its own host.

### A fine-grained personal access token

Tayler makes it on GitHub under Settings, Developer settings, Fine-grained tokens.

- Set the resource owner to the organization the project repos go under, or to Tayler's own account.
- Give it all repositories, so the repos the app makes later are covered.
- Give it these repository permissions, each read and write. Administration, to create repos. Contents, to clone, push and merge. Issues. Pull requests. GitHub adds Metadata as read only.
- An organization may have to approve the token before it works.
- It expires. After that GitHub refuses every call, the Repos page and any failed request say so, and an admin sets a new one.

Everything the app does on GitHub shows as Tayler's account.

### What a GitHub App would change

- No person's token. The app is installed on the organization with the permissions it asks for. The server keeps the app's private key in the same kind of file and trades it for an installation token that lasts an hour.
- Commits, comments and pull requests show the app as their author instead of Tayler.
- Nothing expires a year later, and the organization sees exactly what the app may do.
- Git over HTTPS uses the user name `x-access-token` with the installation token.
- An installation token can make repos in an organization, but not under a person's own account.
- An app has one webhook address for all its installations. It still needs a public path such as Funnel to reach this server.

In code, only the function that hands `github.ts` its token would change. The proxy, the client and the worker stay as they are.

## API

On the people port:

- `GET /v1/github` says whether GitHub is connected, with the account and the organization.
- `POST /v1/github` with `{owner, token}` connects it. Admins only.
- `GET /v1/repos` lists every repo of the team with where it lives, its link, its project, and its open pull requests and task branches as its forge reports them. Each forge's answer is kept for 30 seconds (`AGENTS_REPOS_CACHE_SEC`), however many people have the page open.
- `POST /v1/projects` with `{name, description, people, agents}` makes a project, its room and its repo.
- `POST /v1/projects/<id>/repos` with `{name}` adds a GitHub repo, made if missing, and with `{repoId}` moves a team repo with no project into the project.
- `POST /v1/repo-requests/<id>/retry` tries a failed request again.
- `POST /v1/tasks`, and `POST /v1/conversations` for a room, take an optional `projectId`.

New shapes: `projects`, `repo_requests`, `task_repos` and `project_artifacts`. Everyone on the team reads all of them, under the task visibility rules that were already there.

## What each person sees

- **Sidebar.** New project sits with New task, New room and New agent. Projects lists each project, with its rooms, tasks and runs under it. Repos shows how many repos the team has and opens the Repos page. Conversations, Tasks and Runs keep only what belongs to no project.
- **New project.** A name, a line about it, and teammates and agents to add. It says where the repo will go, such as `acme/billing` on GitHub. Without a GitHub connection it says that an admin connects GitHub on the Repos page, and it can't be sent.
- **A project's page.** What it is for, and its repos with their open pull requests and task branches. A repo still being made or one that failed shows with the reason and Try again. Then the people and agents in its room, its tasks with their repos, its runs, documents and rooms. Buttons open its room and start a task or a room in it, and a form starts a pipeline run on one of its repos.
- **New task in a project.** It offers only that project's repos.
- **A task's page.** Its project and its repos.
- **Repos.** One line on what the page is, the GitHub connection, and every repo. An admin also sees the form that connects GitHub.

## Checks

- `test/step13.ts` runs the server against a fake GitHub, `test/fake-github.ts`, which answers the REST calls above and serves git with `git http-backend` from bare repos on disk.
- `test/step13b.ts` drives the pages in Chromium, Firefox and WebKit, at desktop and phone width.

## Later

- Archiving a project, and moving a repo out of one.
- Webhooks through Funnel, as above.
- Conditional requests with `If-None-Match`, so polls that find nothing don't count against GitHub's limit of 5,000 calls an hour.
