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
# process, JWM is the window manager, with title bars, Alt+Tab and a dock along
# the bottom, xterm is the dock's terminal, xclip puts text the agent types
# outside ASCII on the clipboard to paste, and tini reaps the browser's child
# processes, which the daemon as process 1 would leave behind.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini tigervnc-standalone-server jwm xterm xclip \
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

# The dock's whiteboard: Excalidraw 0.17.6's browser build with its fonts, and
# React 18.3.1, which it runs on, all three under the MIT licence. The daemon
# serves them on the box's loopback (daemon/whiteboard.ts). Each download must
# match its hash.
ENV AGENTS_WHITEBOARD=/opt/whiteboard
RUN mkdir -p /opt/whiteboard && cd /opt/whiteboard \
 && npm pack --silent @excalidraw/excalidraw@0.17.6 react@18.3.1 react-dom@18.3.1 \
 && printf '%s\n' \
   '480dd1ea12156d84acd8af0605fcec894326c07f152f7ed2212145b9864ed4e7  excalidraw-excalidraw-0.17.6.tgz' \
   '8d9bed01a672e7eaf387942d781ad47c6a43089a30a0306060f9fd5ac7870347  react-18.3.1.tgz' \
   '031d4427a99f2f3f6cac18bbbf308594a67e4f47d10f4896fdec446505b040e0  react-dom-18.3.1.tgz' | sha256sum -c - \
 && tar -xzf excalidraw-excalidraw-0.17.6.tgz --strip-components=2 \
   package/dist/excalidraw.production.min.js package/dist/excalidraw.production.min.js.LICENSE.txt package/dist/excalidraw-assets \
 && tar -xzf react-18.3.1.tgz --strip-components=2 package/umd/react.production.min.js \
 && tar -xzf react-dom-18.3.1.tgz --strip-components=2 package/umd/react-dom.production.min.js \
 && tar -xzf react-18.3.1.tgz --strip-components=1 package/LICENSE && mv LICENSE react.LICENSE \
 && rm ./*.tgz && npm cache clean --force

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
