# A box: a Linux machine for unattended agent work. It runs the daemon, which
# claims this box's commands from the API's machine port, sets up workspaces and
# runs Claude sessions. The home folder is a volume, so workspaces outlive the
# container. Built by: node --env-file=.env server/boxes.ts build
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep procps openssh-client \
 && rm -rf /var/lib/apt/lists/*
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
CMD ["node", "daemon/agentsd.ts"]
