# A box: a Linux machine for unattended agent work, with its own computer. It
# runs the daemon, which claims this box's commands from the API's machine port,
# sets up workspaces and runs Claude sessions. The daemon also runs the box's
# desktop: a screen people can watch and take over, and a browser agents check
# their work in (docs/design/computers.md). The home folder is a volume, so
# workspaces and the browser's profile outlive the container. What each layer
# costs is in docs/build-log.md. Built by: node --env-file=.env server/boxes.ts build
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep procps openssh-client \
 && rm -rf /var/lib/apt/lists/*

# The desktop. TigerVNC's Xvnc is the X display and the VNC server in one
# process, matchbox gives each window the whole screen, and tini reaps the
# browser's child processes, which the daemon as process 1 would leave behind.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini tigervnc-standalone-server matchbox-window-manager \
 && rm -rf /var/lib/apt/lists/*
# Playwright 1.64.0, the version package-lock.json pins, then each engine's
# system libraries and browser, one layer each so each engine's cost shows:
# Chromium and its headless shell, Firefox and WebKit. Agents check their work
# in all three. The screen's browser is that Chromium.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g playwright@1.64.0 && npm cache clean --force
RUN playwright install-deps chromium && rm -rf /var/lib/apt/lists/*
RUN playwright install-deps firefox && rm -rf /var/lib/apt/lists/*
RUN playwright install-deps webkit && rm -rf /var/lib/apt/lists/*
RUN playwright install chromium
RUN playwright install firefox
RUN playwright install webkit
# The browser tools agents use, driving the screen's Chromium over its DevTools port.
RUN npm install -g @playwright/mcp@0.0.83 && npm cache clean --force
ENV AGENTS_BROWSER_MCP=/usr/local/lib/node_modules/@playwright/mcp/cli.js
# Claude's computer-use guidance keeps screenshots at or under 1280x800, so the
# model sees them unscaled and its coordinates need no mapping.
ENV AGENTS_DESKTOP=1280x800

RUN npm install -g @anthropic-ai/claude-code@2.1.296 && npm cache clean --force

RUN useradd --create-home --shell /bin/bash agent
WORKDIR /opt/agents
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY shared ./shared
COPY daemon ./daemon

USER agent
ENV AGENTS_HOME=/home/agent/.agents-app
RUN mkdir -p /home/agent/.agents-app && git config --global init.defaultBranch main
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "daemon/agentsd.ts"]
