#!/bin/bash
set -e

# Compile agent-runner TypeScript
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Symlink git credentials if mounted via additionalMounts
if [ -f /workspace/extra/gitconfig ]; then
  ln -sf /workspace/extra/gitconfig /home/node/.gitconfig
fi
if [ -f /workspace/extra/gitcredentials ]; then
  ln -sf /workspace/extra/gitcredentials /home/node/.git-credentials
  # Also authenticate gh CLI using the PAT from git-credentials
  TOKEN=$(grep 'github.com' /workspace/extra/gitcredentials 2>/dev/null | sed 's|.*://[^:]*:\([^@]*\)@.*|\1|' | head -1)
  if [ -n "$TOKEN" ]; then
    echo "$TOKEN" | gh auth login --with-token 2>&1 >&2 || true
  fi
fi

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
