#!/bin/sh
# Keeps the server running across logins and reboots: colima (Postgres and
# Electric), Tailscale in userspace mode, the API behind tailscale serve, and this
# Mac's daemon when ~/.agents-app/daemon.json exists. Run once on the server Mac; safe to rerun.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TS="$HOME/.agents-app/tailscale"
AGENTS="$HOME/Library/LaunchAgents"
NODE="$HOME/.local/node/bin/node"
mkdir -p "$TS/state" "$AGENTS"

agent() { # label, log file, then program arguments
  label=$1 log=$2; shift 2
  path="$HOME/.local/bin:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  args=""
  for a in "$@"; do args="$args    <string>$a</string>
"; done
  cat > "$AGENTS/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$path</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
PLIST
  plutil -lint "$AGENTS/$label.plist" >/dev/null
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist"
}

# brew's colima service starts its own VM, so stop one started by hand first.
if ! brew services list | grep -q '^colima.*started'; then colima stop || true; brew services start colima; fi
pkill -f 'tailscaled --tun=userspace-networking' || true
agent com.agents.tailscaled "$TS/tailscaled.log" /opt/homebrew/opt/tailscale/bin/tailscaled \
  --tun=userspace-networking "--socket=$TS/tailscaled.sock" "--statedir=$TS/state" \
  --outbound-http-proxy-listen=127.0.0.1:1055
pkill -f 'node --env-file=.env server/api.ts' || true
agent com.agents.api "$HOME/.agents-app/api.log" "$NODE" --env-file=.env server/api.ts
if [ -f "$HOME/.agents-app/daemon.json" ]; then
  agent com.agents.daemon "$HOME/.agents-app/daemon.log" "$NODE" daemon/agentsd.ts
fi
echo "installed. check with: launchctl list | grep agents"
