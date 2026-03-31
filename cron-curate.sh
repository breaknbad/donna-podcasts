#!/bin/bash
# Donna's Picks — auto-curate top podcast episodes using Claude
# Runs 3x/week (Mon/Wed/Fri) via LaunchAgent
# Uses claude -p to intelligently pick the best episodes

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

LOG="/Users/donna/donna-podcasts/logs/curate.log"
mkdir -p "$(dirname "$LOG")"

exec >> "$LOG" 2>&1
echo "=== Curating $(date '+%Y-%m-%d %H:%M') ==="

cd /Users/donna/donna-podcasts

# Fetch latest 3 episodes from each source (last 72h only)
EPISODES=$(/opt/homebrew/bin/node -e "
const fs = require('fs');
const { execSync } = require('child_process');
const config = JSON.parse(fs.readFileSync('config.json'));
const results = [];
for (const s of config.feeds.curated.sources) {
  try {
    const xml = execSync('curl -sL \"' + s.rss + '\"', {encoding:'utf-8', maxBuffer:50*1024*1024, timeout:15000});
    const items = [...xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>[\s\S]*?(?:<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>[\s\S]*?)?<pubDate>([\s\S]*?)<\/pubDate>[\s\S]*?<\/item>/g)].slice(0,3);
    items.forEach(m => {
      const title = m[1].trim().slice(0,200);
      const desc = (m[2] || '').replace(/<[^>]+>/g, '').trim().slice(0,300);
      const pubDate = m[3].trim();
      const age = (Date.now() - new Date(pubDate).getTime()) / (1000*60*60);
      if (age < 72) {
        results.push({source: s.name, title, description: desc, pubDate});
      }
    });
  } catch(e) {}
}
console.log(JSON.stringify(results));
" 2>/dev/null)

COUNT=$(echo "$EPISODES" | /opt/homebrew/bin/node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
console.log(d.length);
")

echo "Found $COUNT new episodes in last 72h"

if [ "$COUNT" -eq 0 ]; then
  echo "No new episodes to curate"
  exit 0
fi

# Build the episode list for Claude
EPISODE_LIST=$(echo "$EPISODES" | /opt/homebrew/bin/node -e "
const eps = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
eps.forEach((e,i) => {
  console.log((i+1) + '. [' + e.source + '] ' + e.title);
  if (e.description) console.log('   ' + e.description.slice(0,200));
});
")

# Use Claude to pick the best 2 episodes
PROMPT="You are curating a podcast feed for Matthew Harfmann, CEO of Break'n Bad (a \$19M sports card breaking company scaling to \$100M). He runs a fleet of AI bots using Claude Code and is deeply into AI automation, business scaling, and e-commerce.

His interests: AI agents, AI automation, Claude/Anthropic, business scaling from 8 figures to 9 figures, e-commerce operations, entrepreneurship, leadership at scale, sports cards/hobby industry.

NOT interested in: politics, self-help fluff, salary negotiation, generic personal finance, celebrity gossip, entertainment industry news, anything not actionable for a CEO scaling a business.

Here are the new podcast episodes from the last 3 days:

$EPISODE_LIST

Pick the 2 BEST episodes that Matthew would actually want to listen to. Only pick episodes that are directly relevant to his interests. If fewer than 2 are genuinely relevant, pick fewer. If none are relevant, say NONE.

Respond with ONLY the episode numbers, one per line. Nothing else. Example:
3
7"

PICKS=$(echo "$PROMPT" | /opt/homebrew/bin/claude -p --max-turns 1 2>/dev/null)

echo "Claude picked: $PICKS"

if [ -z "$PICKS" ] || echo "$PICKS" | grep -qi "none"; then
  echo "No relevant episodes found"
  exit 0
fi

# Extract episode titles from Claude's picks and add them
ADDED=0
while IFS= read -r num; do
  # Strip any non-numeric characters
  num=$(echo "$num" | tr -cd '0-9')
  [ -z "$num" ] && continue

  TITLE=$(echo "$EPISODES" | /opt/homebrew/bin/node -e "
    const eps = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    const idx = $num - 1;
    if (idx >= 0 && idx < eps.length) console.log(eps[idx].title);
  ")

  [ -z "$TITLE" ] && continue
  echo "  Adding: $TITLE"
  RESULT=$(/opt/homebrew/bin/node curator.js --add-episode "$TITLE" 2>&1)
  echo "  $RESULT"
  if echo "$RESULT" | grep -q "^Added:"; then
    ADDED=$((ADDED + 1))
  fi
done <<< "$PICKS"

# Publish if we added anything
if [ "$ADDED" -gt 0 ]; then
  echo "Publishing $ADDED new episodes..."
  /opt/homebrew/bin/node curator.js --publish 2>&1
  echo "Published!"
else
  echo "No new episodes added (all duplicates or not found)"
fi

echo "=== Done ==="
