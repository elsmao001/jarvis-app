#!/bin/zsh
# Installe le worker Jarvis en tâche de fond permanente (redémarre tout seul, se lance à l'ouverture de session).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/fr.jarvis.worker.plist"
mkdir -p "$DIR/logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>fr.jarvis.worker</string>
  <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>$NODE</string><string>$DIR/worker.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DIR/logs/worker.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/worker.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/fr.jarvis.worker" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Worker Jarvis installé. Journal : $DIR/logs/worker.log"
