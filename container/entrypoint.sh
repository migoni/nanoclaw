#!/bin/bash
set -e

# Compile agent-runner TypeScript
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Install plugins if plugins.txt exists in .claude directory
PLUGINS_FILE="/home/node/.claude/plugins.txt"
if [ -f "$PLUGINS_FILE" ]; then
  while IFS= read -r plugin; do
    # Skip empty lines and comments
    [ -z "$plugin" ] && continue
    [[ "$plugin" =~ ^# ]] && continue
    echo "[entrypoint] Installing plugin: $plugin" >&2
    claude plugin install "$plugin" --scope user 2>&1 >&2 || echo "[entrypoint] Warning: failed to install plugin $plugin" >&2
  done < "$PLUGINS_FILE"
fi

# Read input and run agent
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
