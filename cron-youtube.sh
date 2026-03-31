#!/bin/bash
# AI Feed — check YouTube channels for new videos, download audio, publish
# Runs daily via LaunchAgent

set -euo pipefail

LOG="/Users/donna/donna-podcasts/logs/youtube.log"
mkdir -p "$(dirname "$LOG")"

exec >> "$LOG" 2>&1
echo "=== YouTube sync $(date '+%Y-%m-%d %H:%M') ==="

cd /Users/donna/donna-podcasts
/opt/homebrew/bin/node curator.js --all 2>&1

echo "=== Done ==="
